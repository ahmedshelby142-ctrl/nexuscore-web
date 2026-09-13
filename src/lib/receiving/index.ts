/**
 * Receiving Module Barrel Export
 *
 * Shared receiving logic for Quick Restock / توريد سريع
 * Used by both Desktop and Mobile.
 */

export {
  executeQuickRestock,
  formatQuickRestockSuccess,
  type QuickRestockLineInput,
  type QuickRestockSupplierInput,
  type QuickRestockInput,
  type QuickRestockResult,
  NEW_SUPPLIER,
} from "./command";