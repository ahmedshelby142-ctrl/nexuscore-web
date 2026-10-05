/** Shared Desktop/Mobile receipt command. The server resolves the supplier and
 * commits its invoice and financial effects in one transaction. The shared
 * financial command owns the stable retry identity, including response loss. */

import { commitReceipt } from "./commitReceipt";
import type { Supplier, WalletType } from "@/types";

export interface QuickRestockLineInput {
  productId: string;
  productName: string;
  sku: string;
  quantity: number;
  unitCost: number;
  variantName?: string;
}

export interface QuickRestockSupplierInput {
  /** Existing supplier ID, or "__new__" to register inline */
  supplierId: string;
  /** Required when supplierId === "__new__" */
  newSupplierName?: string;
  newSupplierPhone?: string;
}

export interface QuickRestockInput {
  /** Lines to receive. At least one required with quantity > 0. */
  lines: QuickRestockLineInput[];
  /** Supplier selection (existing or new) */
  supplier: QuickRestockSupplierInput;
  /** Wallet the cash comes from. Only consulted for the part paid now. */
  wallet: WalletType;
  /**
   * Cash handed over now, EGP. Omit for "paid in full".
   *
   * Forwarded verbatim to `commitReceipt`, which clamps it to
   * `[0, total]` and uses the existing purchase line semantics:
   *
   *     paid > 0  →  wallet −paid
   *     owed > 0  →  payable_supplier +owed
   *
   * So cash, partial and credit are one code path with three inputs, not
   * three implementations. Nothing about that split is decided here or on
   * mobile — this field only carries the operator's number to the one place
   * that already knew what to do with it.
   */
  paidAmount?: number;
  /** Optional note for the invoice document */
  notes?: string;

}

export interface QuickRestockResult {
  /** The ledger event ID */
  eventId: string;
  /** The purchase invoice number (FM-XXXX) */
  invoiceNumber: string;
  /** The supplier the receipt was recorded against */
  supplier: Supplier;
  /** Total amount of the receipt */
  total: number;
  /** Number of lines received */
  itemCount: number;
}

/** Sentinel for "this supplier is not registered yet". */
export const NEW_SUPPLIER = "__new__";

/**
 * Execute a quick restock (توريد سريع).
 *
 * @throws {Error} If validation fails, supplier not found/created, ledger write fails, or invoice write fails.
 *   The error message is user-facing in Arabic.
 */
export async function executeQuickRestock(input: QuickRestockInput): Promise<QuickRestockResult> {
  // ── Validation ─────────────────────────────────────────────────────────
  if (!input.lines || input.lines.length === 0) {
    throw new Error("لا توجد أصناف للتوريد");
  }

  const validLines = input.lines.filter((l) => l.quantity > 0);
  if (validLines.length === 0) {
    throw new Error("يجب إدخال كمية أكبر من صفر لصنف واحد على الأقل");
  }

  // Validate each line
  for (const line of validLines) {
    if (line.quantity <= 0) {
      throw new Error(`الكمية لـ "${line.productName}" يجب أن تكون أكبر من صفر`);
    }
    if (line.unitCost < 0) {
      throw new Error(`تكلفة الوحدة لـ "${line.productName}" لا يمكن أن تكون سالبة`);
    }
  }

  // Supplier lookup/creation belongs to the same transaction as the receipt.
  const result = await commitReceipt({
    supplierId: input.supplier.supplierId,
    newSupplierName: input.supplier.newSupplierName?.trim(),
    newSupplierPhone: input.supplier.newSupplierPhone?.trim(),
    supplierName: "",
    items: validLines.map((l) => ({
      productId: l.productId,
      productName: l.productName,
      sku: l.sku,
      quantity: l.quantity,
      unitCost: l.unitCost,
      variantName: l.variantName,
    })),
    wallet: input.wallet,
    // `Infinity` still means "paid in full" — `commitReceipt` clamps it to the
    // total. What changed is that a caller may now say otherwise: quick
    // restock used to hardcode this, which made the آجل half of
    // `buildPurchaseLines` unreachable from mobile even though the ledger had
    // supported it all along.
    paidAmount: input.paidAmount ?? Number.POSITIVE_INFINITY,
    notes: input.notes ?? "توريد سريع من شاشة المنتجات",
    actor: "توريد",
    via: "quick_restock",
  });

  return {
    eventId: result.eventId,
    invoiceNumber: result.invoiceNumber,
    supplier: result.supplier,
    total: result.total,
    itemCount: result.itemCount,
  };
}

/**
 * Format a user-facing success message for a quick restock result.
 */
export function formatQuickRestockSuccess(result: QuickRestockResult): string {
  return result.itemCount > 1
    ? `اتسجّل توريد ${result.itemCount} أصناف باسم ${result.supplier.companyName}`
    : `اتسجّل التوريد باسم ${result.supplier.companyName}`;
}