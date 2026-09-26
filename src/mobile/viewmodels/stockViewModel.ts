/**
 * Mobile Stock View Model
 *
 * Stock QUANTITY is not derived here. On mobile it is the ledger sum that
 * `readMobileProducts` attaches as `mobileStock`; this file only turns a
 * quantity the caller already trusts into a status.
 *
 * `toMobileStockRow` / `toMobileStockQueue` / `lowStockRows` used to live here
 * and read `getActualStock()`, whose ledger snapshot is filled only by
 * desktop's `useStock` — so on mobile they answered from `products.quantity`.
 * Their one caller was the dead `homeComposer`; both are gone.
 */

import type { StockStatusKey } from "./types";

/**
 * Derives the stock status key from quantity and min level.
 * Threshold logic is display-only; the backend ledger remains authoritative.
 */
export function deriveStockStatusKey(qty: number, minLevel: number): StockStatusKey {
  if (qty <= 0) return "out_of_stock";
  if (minLevel > 0 && qty <= minLevel) return "low_stock";
  return "in_stock";
}
