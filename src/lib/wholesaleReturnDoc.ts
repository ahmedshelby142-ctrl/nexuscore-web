/**
 * The document half of a wholesale return.
 *
 * ## Why a document at all
 *
 * A wholesale return used to write a ledger event and nothing else. The money
 * was right and the paper trail was absent: the event pointed at the CLIENT,
 * not at any invoice, so nothing in the database could answer "which sale did
 * these goods come from?" — and, decisively, nothing could answer "how many of
 * this line have already come back?". Without that second answer there is no
 * ceiling, and the same ten units can be returned once per click.
 *
 * ## Why `return_records` and not a new table
 *
 * It is already the return document for the retail side, already synced,
 * already store-scoped by RLS, and `original_order_id` is untyped text with no
 * foreign key — so it holds a wholesale INVOICE id here, with `type` saying
 * which kind of return it is. `remainingWholesaleLines` reads exactly these
 * rows back. A new table would have been a second return log to keep in step
 * with the first.
 *
 * ## One record per invoice
 *
 * A single return may span several invoices (§5 of the brief: the same product
 * bought twice at two prices stays two lines). `original_order_id` holds one
 * id, so the return is split into one record per source invoice — each with
 * its own lines and its own share of the credit. Collapsing them into one row
 * would lose the relationship the split exists to preserve.
 */

import { useBusinessStore } from "@/store/useBusinessStore";
import { deleteThrough } from "@/services/cloudData";
import { invoiceCredits, runWholesaleReturn } from "@/lib/wholesaleReturnTxn";
import { useAuthStore } from "@/store/useAuthStore";
import { canReturnWholesale } from "@/lib/roles";

/** What a role that may not complete a trader return is told — before anything moves. */
export const WHOLESALE_RETURN_FORBIDDEN =
  "تسوية مرتجع حساب تاجر لمدير المحل بس — الصلاحية دي مش متاحة لحسابك. محدش سجّل حاجة.";
import {
  WHOLESALE_RETURN_TYPE,
  type ResolvedWholesaleReturn,
  type ResolvedWholesaleReturnLine,
} from "@/lib/ledger/wholesale";

/** The little of a wholesale client the record needs. */
export interface WholesaleReturnClient {
  companyName?: string;
  phone?: string;
}

/**
 * Record the return, then move the money — and undo the record if it cannot.
 *
 * ## Why this order, and why it is not the obvious one
 *
 * Every other flow in this app appends the ledger event first: the money is the
 * truth, and the document catches up. A wholesale return is the case where that
 * is the wrong way round, because the document is not just a description — it
 * IS the ceiling that stops the same goods coming back twice.
 *
 * The two failure directions are not symmetrical:
 *
 *   ledger first, record fails   the money moved and nothing records that these
 *                                units are back. The next return measures
 *                                against a stale ceiling and credits the client
 *                                for the same goods again. Money invented.
 *
 *   record first, ledger fails   the ceiling shrank and no money moved. The
 *                                client is temporarily unable to return goods
 *                                they are entitled to return — visible,
 *                                complainable, and fixable.
 *
 * So the record goes first, then each source invoice's open balance is
 * credited, and the ledger event is LAST. If the credit or the event is
 * refused, the invoices are put back to the exact balance they held and the
 * records are deleted — deterministic compensation, not a hope — and the
 * original error is rethrown. If an undo ALSO fails, that is thrown as a
 * `WholesaleReturnUndoError` naming what was left behind.
 *
 * `appendLedger` is passed in rather than built here so this stays the only
 * place that knows the ordering, while each screen keeps its own event shape.
 */
export async function commitWholesaleReturn(
  resolved: ResolvedWholesaleReturn,
  client: WholesaleReturnClient | undefined,
  paidNow: number,
  appendLedger: () => Promise<unknown>,
  notes = "",
): Promise<void> {
  // The invoice credit is INSIDE the unit now, and before the ledger event.
  // It used to run after this function returned — in each of three screens,
  // after the money had already moved, with its failure swallowed — and on
  // committed main the store method it called did not exist, so it threw a
  // TypeError after the ledger event and the screen said nothing was
  // recorded. See `runWholesaleReturn` for the order and the undo.
  const store = () => useBusinessStore.getState();
  await runWholesaleReturn(invoiceCredits(resolved.lines), {
    // The one choke point all three screens pass through, so the permission
    // is asked once, here, before the first write — not per screen.
    authorize: () => {
      if (!canReturnWholesale(useAuthStore.getState().userRole)) {
        throw new Error(WHOLESALE_RETURN_FORBIDDEN);
      }
    },
    writeRecords: () => writeReturnRecords(resolved, client, paidNow, notes),
    deleteRecord: async (id) => {
      await deleteThrough("return_records", id);
      useBusinessStore.setState((state: any) => ({
        returnRecords: (state.returnRecords ?? []).filter((r: any) => r.id !== id),
      }));
    },
    creditInvoice: (invoiceId, amount) => store().recordWholesaleReturn(invoiceId, amount),
    restoreInvoice: (invoiceId, remaining) =>
      store().restoreWholesaleInvoiceRemaining(invoiceId, remaining),
    appendLedger,
  });
}

/**
 * Write the return records for one resolved wholesale return, and return their
 * ids so `commitWholesaleReturn` can undo them.
 *
 * Deliberately allowed to throw: a refused write means the returnable ceiling
 * was not recorded, and nothing may move afterwards.
 */
async function writeReturnRecords(
  resolved: ResolvedWholesaleReturn,
  client: WholesaleReturnClient | undefined,
  paidNow: number,
  notes = "",
): Promise<string[]> {
  const byInvoice = new Map<string, ResolvedWholesaleReturnLine[]>();
  for (const line of resolved.lines) {
    const bucket = byInvoice.get(line.invoiceId);
    if (bucket) bucket.push(line);
    else byInvoice.set(line.invoiceId, [line]);
  }

  const addReturnRecord = useBusinessStore.getState().addReturnRecord;
  const written: string[] = [];

  for (const [invoiceId, lines] of byInvoice) {
    const credit = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
    const saved = await addReturnRecord({
      // The source invoice. This is the link `remainingWholesaleLines` follows.
      original_order_id: invoiceId,
      type: WHOLESALE_RETURN_TYPE,
      customer_name: client?.companyName ?? "",
      customer_phone: client?.phone ?? "",
      governorate: "",
      returned_items: lines.map((l) => ({
        // `line_id` is what keys the ceiling. `product_id` rides along for the
        // reports that read these rows by product.
        line_id: l.lineKey,
        product_id: l.productId,
        product_name: l.productName,
        quantity: l.quantity,
        // The price the client actually PAID on that invoice, already net of
        // its discount — never today's wholesale price.
        unit_price: l.unitPrice,
        refund_amount: Math.round(l.unitPrice * l.quantity * 100) / 100,
      })),
      // Negative: money coming off what the client owes, in the same sign
      // convention the retail return records use.
      financial_difference: -(Math.round(credit * 100) / 100),
      processed_by: "wholesale",
      return_cause: "unknown",
      notes: [notes, paidNow > 0 ? `سدّد ${paidNow} ج.م مع المرتجع` : ""]
        .filter(Boolean)
        .join(" · "),
    } as never);
    written.push(saved.id);
  }

  return written;
}
