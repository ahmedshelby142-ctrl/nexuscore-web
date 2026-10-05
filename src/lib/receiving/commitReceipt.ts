/** One authoritative receipt transaction, shared by Desktop and Mobile. */
import { runFinancialCommand } from "@/lib/financialCommand";
import { useBusinessStore } from "@/store/useBusinessStore";
import { fromRemoteRow } from "@/services/api/fieldMapping";
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
  newSupplierName?: string;
  newSupplierPhone?: string;
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
  supplier: any;
  invoice: any;
  replayed: boolean;
}

export async function commitReceipt(input: ReceiptCommitInput): Promise<ReceiptCommitResult> {
  const items = input.items.filter(l => l.quantity > 0);
  if (!items.length) throw new Error("لا توجد أصناف للتوريد");
  const result = await runFinancialCommand<ReceiptCommitResult>("receipt", {
    ...input, items,
    // null represents paid-in-full; JSON must not silently turn other invalid
    // numbers into a full payment.
    paidAmount: input.paidAmount === Number.POSITIVE_INFINITY ? null : input.paidAmount,
  });
  // Post-commit cache work cannot change the authoritative outcome. On replay
  // do not increment a mirror a second time; ledger readers refresh instead.
  try {
    const invoice = fromRemoteRow("purchase_invoices", result.invoice);
    const supplier = fromRemoteRow("suppliers", result.supplier);
    if (!result.replayed) useBusinessStore.setState(state => ({
      purchaseInvoices: [...state.purchaseInvoices.filter(i => i.id !== invoice.id), invoice],
      suppliers: [...state.suppliers.filter(s => s.id !== supplier.id), supplier],
    }));
    if (!result.replayed) useBusinessStore.getState().applyStockMoves(items.map(l => ({
      productId: l.productId, delta: l.quantity, variantName: l.variantName,
    })));
    if (result.replayed) {
      const { cloudList } = await import("@/services/cloudData");
      const purchaseInvoices = await cloudList("purchase_invoices");
      useBusinessStore.setState({ purchaseInvoices });
    }
    window.dispatchEvent(new CustomEvent("ledger-sync-pulled", { detail: { table: "ledger_events" } }));
  } catch {
    // The receipt is committed. A new read restores the optional UI mirrors.
    console.warn("تم تسجيل التوريد؛ تعذّر تحديث العرض المحلي. أعد فتح القائمة لتحديثها.");
  }
  return result;
}
