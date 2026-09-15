/**
 * Writing one supplier settlement.
 *
 * The rule — which invoices a payment settles, and in what order — is pure and
 * lives in `./supplierSettlement.ts`. This is only the write, and it is split
 * out so that rule stays testable without a ledger, a store or a browser.
 *
 * See the header of `./supplierSettlement.ts` for why the LEDGER is written
 * before the invoice documents here, which is the opposite of `commitReceipt`.
 */

import { appendEvent } from "@/lib/ledger";
import { buildSupplierPaymentLines } from "@/lib/ledger/purchases";
import { round } from "@/lib/math";
import { nextDocumentNumber } from "@/services/documentNumber";
import { useBusinessStore } from "@/store/useBusinessStore";
import type { WalletType } from "@/types";
import {
  allocateSupplierPayment,
  openInvoicesFor,
  type PaymentAllocation,
  type SettleableInvoice,
} from "./supplierSettlement";

export interface SupplierPaymentInput {
  supplierId: string;
  supplierName: string;
  /** The till the cash leaves. */
  wallet: WalletType;
  /** How much is being handed over now, EGP. */
  amount: number;
  /** This supplier's invoices — the store's own list, RLS-scoped on the way in. */
  invoices: readonly SettleableInvoice[];
  note?: string;
  actor?: string;
}

export interface SupplierPaymentResult {
  eventId: string;
  /** The auditable reference for this payment, e.g. `SP-0007`. */
  paymentRef: string;
  amount: number;
  applied: number;
  unapplied: number;
  allocations: PaymentAllocation[];
  /**
   * Invoices whose DOCUMENT could not be updated after the money moved.
   *
   * Not a failure of the payment — the ledger has it and the balance is right.
   * Surfaced so the operator is told the per-invoice breakdown is behind, which
   * is the honest thing to say and is fixed by a refresh.
   */
  staleInvoices: string[];
}

/**
 * Record one supplier settlement: cash out, debt down, invoices marked.
 *
 * Throws with a user-facing Arabic message. A throw before the ledger write
 * means nothing happened at all; the ledger write itself is the point of no
 * return, and everything after it is reported rather than rolled back — see the
 * header for why that is the safe direction here.
 */
export async function commitSupplierPayment(
  input: SupplierPaymentInput,
): Promise<SupplierPaymentResult> {
  if (!input.supplierId) throw new Error("اختر المورد الأول");
  if (!input.wallet) throw new Error("اختر الخزينة اللي الفلوس هتطلع منها");

  const open = openInvoicesFor(input.invoices, input.supplierId);
  const plan = allocateSupplierPayment(open, input.amount);
  const amount = round(Number(input.amount));

  // An auditable reference, allocated by Postgres like every other document
  // number. `payable_supplier` aggregates by supplier, so without this a
  // settlement would be a movement nobody could point at.
  const paymentRef = await nextDocumentNumber("supplier_payment", "SP-");

  // ── The MONEY. Everything below this line is bookkeeping. ────────────────
  const eventId = await appendEvent({
    kind: "supplier_payment",
    actor: input.actor ?? "الكاشير",
    refType: "supplier_payment",
    refId: paymentRef,
    payload: {
      paymentRef,
      supplierId: input.supplierId,
      supplierName: input.supplierName,
      wallet: input.wallet,
      amount,
      note: input.note ?? "",
      // The breakdown, so the settlement can be read back invoice by invoice.
      allocations: plan.allocations,
      unapplied: plan.unapplied,
    },
    lines: buildSupplierPaymentLines({
      supplierId: input.supplierId,
      wallet: input.wallet,
      amount,
    }),
  });

  // ── The invoice documents. A failure here is stale, not wrong. ────────────
  const staleInvoices: string[] = [];
  for (const allocation of plan.allocations) {
    try {
      await useBusinessStore.getState().recordSupplierPayment(allocation.invoiceId, allocation.applied);
    } catch {
      staleInvoices.push(allocation.invoiceNumber);
    }
  }

  return {
    eventId,
    paymentRef,
    amount,
    applied: plan.applied,
    unapplied: plan.unapplied,
    allocations: plan.allocations,
    staleInvoices,
  };
}

/** What to tell the operator after a settlement lands. */
export function formatSupplierPaymentSuccess(result: SupplierPaymentResult): string {
  const parts = [`تم تسجيل دفعة ${result.paymentRef} بمبلغ ${result.amount.toLocaleString("ar-EG")} ج.م`];
  if (result.allocations.length > 0) {
    parts.push(`سُدِّدت على ${result.allocations.length} فاتورة`);
  }
  if (result.unapplied > 0) {
    parts.push(`و${result.unapplied.toLocaleString("ar-EG")} ج.م رصيد مقدَّم للمورد`);
  }
  if (result.staleInvoices.length > 0) {
    parts.push(`(تحديث الفواتير ${result.staleInvoices.join("، ")} لم يكتمل — اعمل تحديث للصفحة)`);
  }
  return parts.join(" — ");
}
