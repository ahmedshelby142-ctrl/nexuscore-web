/** Supplier payment and server-derived allocations commit together. */
import { runFinancialCommand } from "@/lib/financialCommand";
import { useBusinessStore } from "@/store/useBusinessStore";
import type { WalletType } from "@/types";
import type { PaymentAllocation, SettleableInvoice } from "./supplierSettlement";

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
  replayed: boolean;
}

export async function commitSupplierPayment(input: SupplierPaymentInput): Promise<SupplierPaymentResult> {
  const { invoices: _previewOnly, supplierName: _displayOnly, ...request } = input;
  const result = await runFinancialCommand<SupplierPaymentResult>("supplier_payment", request);
  try {
    const { cloudList } = await import("@/services/cloudData");
    const purchaseInvoices = await cloudList("purchase_invoices");
    useBusinessStore.setState({ purchaseInvoices });
  } catch { console.warn("تم تسجيل الدفعة؛ أعد تحميل الفواتير لتحديث العرض."); }
  try { window.dispatchEvent(new CustomEvent("ledger-sync-pulled", { detail: { table: "purchase_invoices" } })); } catch { /* committed */ }
  return result;
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
  return parts.join(" — ");
}
