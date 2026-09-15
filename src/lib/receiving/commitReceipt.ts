/**
 * The one way a supplier receipt reaches the database.
 *
 * ## Why this exists
 *
 * There were THREE copies of "write a receipt": شاشة المشتريات's full invoice
 * form, `QuickRestockDialog` on desktop, and `executeQuickRestock` for mobile.
 * Only the first was corrected when the numbering and ordering defects were
 * fixed; the other two still carried both of them. A rule that lives in three
 * places is a rule that is wrong in two of them.
 *
 * Everything dangerous about writing a receipt now happens here, once:
 *
 *   1. draw an invoice number that is not already taken
 *   2. write the DOCUMENT
 *   3. append the ledger event
 *   4. if the ledger refuses, delete the document again
 *   5. mirror the stock
 *
 * ## Why the document goes first
 *
 * `purchase_invoices_number_per_store` is UNIQUE, and it is the only thing that
 * can still refuse a receipt. It refuses the DOCUMENT. Writing the document
 * first means a refusal costs nothing; writing the ledger first — which both
 * quick-restock paths did — meant a refusal left stock and a payable on the
 * books with no receipt behind them. Accounting with no document.
 *
 * ## Why the numbering loop
 *
 * Every store that has already received goods holds `FM-0001…` written by the
 * old `purchaseInvoices.length + 1` scheme, while `store_counters` may have no
 * `purchase_invoice` row yet — so the first allocation would hand back FM-0001
 * and collide on day one. Skipping numbers already taken costs a few wasted
 * draws ONCE per store and needs no migration. Numbering has never been
 * gap-free: a refused invoice burns a number by design.
 *
 * On mobile the old scheme was not merely risky but certain to fail: mobile
 * never hydrates, so `purchaseInvoices.length` is always 0 and the number was
 * always FM-0001.
 */

import { appendEvent } from "@/lib/ledger";
import { buildPurchaseLines, purchaseTotal } from "@/lib/ledger/purchases";
import { nextDocumentNumber } from "@/services/documentNumber";
import { useBusinessStore } from "@/store/useBusinessStore";
import type { WalletType } from "@/types";

/** One line of goods arriving, already costed by the caller. */
export interface ReceiptItem {
  productId: string;
  productName: string;
  sku?: string;
  quantity: number;
  /** What we actually paid per unit. Frozen onto both the event and the document. */
  unitCost: number;
  /** The shade. Carried onto the invoice line so a later return can name it. */
  variantName?: string;
  /** A بوكس charges its components — the caller supplies the recipe. */
  isBundle?: boolean;
  bundleItems?: { productId: string; quantity: number; unitCost: number }[];
}

export interface ReceiptCommitInput {
  supplierId: string;
  supplierName: string;
  items: ReceiptItem[];
  /** The till the cash comes from. Required whenever anything is paid now. */
  wallet?: WalletType;
  /** Cash handed over now. The rest becomes `payable_supplier`. */
  paidAmount: number;
  dueDate?: string;
  notes?: string;
  /** Who is recorded as having done this — "الكاشير", "توريد", … */
  actor: string;
  /** Which screen it came from, for the event payload. */
  via: string;
  payloadExtra?: Record<string, unknown>;
}

export interface ReceiptCommitResult {
  eventId: string;
  invoiceNumber: string;
  invoiceId: string;
  total: number;
  itemCount: number;
}

/**
 * An invoice number this store is not already using.
 *
 * Bounded: a store that somehow burned fifty consecutive numbers has a problem
 * a loop cannot fix, and spinning forever would hide it.
 */
export async function nextFreePurchaseInvoiceNumber(): Promise<string> {
  const taken = new Set(
    (useBusinessStore.getState().purchaseInvoices ?? []).map((i: any) => i.invoiceNumber),
  );
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = await nextDocumentNumber("purchase_invoice", "FM-");
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("تعذّر إصدار رقم فاتورة جديد — جرّب تاني");
}

/**
 * Write one supplier receipt: document, then ledger, then the stock mirror.
 *
 * Throws with a user-facing Arabic message. A throw means the receipt does not
 * exist — either nothing was written, or what was written has been taken back.
 */
export async function commitReceipt(input: ReceiptCommitInput): Promise<ReceiptCommitResult> {
  const items = input.items.filter((l) => l.quantity > 0);
  if (items.length === 0) throw new Error("لا توجد أصناف للتوريد");
  for (const line of items) {
    if (line.unitCost < 0) {
      throw new Error(`تكلفة الوحدة لـ "${line.productName}" لا يمكن أن تكون سالبة`);
    }
  }

  const total = purchaseTotal(
    items.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCost: l.unitCost })),
  );
  const paid = Math.min(Math.max(0, input.paidAmount), total);
  const owed = total - paid;

  const invoiceNumber = await nextFreePurchaseInvoiceNumber();

  // ── 1. The DOCUMENT, before anything moves ────────────────────────────────
  const invoice = await useBusinessStore.getState().addPurchaseInvoice({
    invoiceNumber,
    supplierId: input.supplierId,
    supplierName: input.supplierName,
    items: items.map((l) => ({
      id: crypto.randomUUID(),
      productId: l.productId,
      productName: l.productName,
      sku: l.sku ?? "",
      // The shade the goods arrived in. Without it a return resolved off this
      // receipt could not say which one came back.
      variantName: l.variantName,
      quantity: l.quantity,
      unitCost: l.unitCost,
      ...(l.isBundle && l.bundleItems?.length
        ? { isBundle: true, bundleItems: l.bundleItems }
        : {}),
      total: l.quantity * l.unitCost,
    })),
    totalAmount: total,
    paidAmount: paid,
    remainingAmount: owed,
    dueDate: input.dueDate ?? new Date().toISOString().slice(0, 10),
    status: owed <= 0 ? "paid" : paid > 0 ? "partial" : "unpaid",
    notes: input.notes ?? "",
  } as never);

  // ── 2. The MONEY ──────────────────────────────────────────────────────────
  let eventId: string;
  try {
    eventId = await appendEvent({
      kind: "purchase",
      actor: input.actor,
      refType: "supplier_invoice",
      refId: invoiceNumber,
      payload: {
        invoiceNumber,
        supplierName: input.supplierName,
        itemCount: items.length,
        wallet: input.wallet,
        via: input.via,
        ...(input.payloadExtra ?? {}),
      },
      lines: buildPurchaseLines({
        items: items.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          unitCost: l.unitCost,
          variantName: l.variantName,
          ...(l.isBundle && l.bundleItems?.length
            ? { isBundle: true, bundleItems: l.bundleItems }
            : {}),
        })) as never,
        wallet: input.wallet,
        supplierId: input.supplierId,
        paidAmount: paid,
      }),
    });
  } catch (e) {
    // The money never moved, so the receipt must not stand. Deterministic
    // compensation — and if the delete itself fails the user is told, because
    // an invoice with no ledger effect overstates what we owe the supplier.
    let undone = true;
    try {
      await useBusinessStore.getState().removePurchaseInvoice(invoice.id);
    } catch {
      undone = false;
    }
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      undone
        ? `لم يُسجَّل التوريد ولم يتغيّر أي رصيد. ${detail}`
        : `لم يُسجَّل التوريد، لكن الفاتورة ${invoiceNumber} لسه متسجّلة — امسحها من شاشة المشتريات. ${detail}`,
    );
  }

  // ── 3. The stock mirror. Bundles expand at the choke point. ───────────────
  useBusinessStore.getState().applyStockMoves(
    items.map((l) => ({
      productId: l.productId,
      delta: l.quantity,
      variantName: l.variantName,
    })),
  );

  return { eventId, invoiceNumber, invoiceId: invoice.id, total, itemCount: items.length };
}
