/**
 * Receiving Module Barrel Export
 *
 * Shared receiving logic. `commitReceipt` is the ONE way a supplier receipt
 * reaches the database — desktop quick restock, mobile quick restock and the
 * full invoice form all go through it, so the numbering and the
 * document-before-ledger ordering exist in a single place.
 */

export { commitReceipt, nextFreePurchaseInvoiceNumber, type ReceiptItem, type ReceiptCommitInput, type ReceiptCommitResult } from "./commitReceipt";
export { readSuppliers, readSupplierById, type SupplierOption } from "./suppliers";

export {
  executeQuickRestock,
  formatQuickRestockSuccess,
  type QuickRestockLineInput,
  type QuickRestockSupplierInput,
  type QuickRestockInput,
  type QuickRestockResult,
  NEW_SUPPLIER,
} from "./command";