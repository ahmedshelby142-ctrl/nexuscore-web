/**
 * Mobile Stock View Model
 *
 * Transforms raw product domain data into mobile-friendly stock row structures.
 * Pure function — no DB calls, no React state.
 *
 * Stock quantity authority: `getActualStock()` from lib/product.ts, which reads
 * from the ledger stock snapshot. Products.quantity is NOT used directly.
 */

import type { MobileStockRow, StockStatusKey } from "./types";
import { resolveStockStatus } from "./statusTaxonomies";
import { formatArabicQuantity } from "./formatters";
import { getActualStock, productMinLevel } from "@/lib/product";

/**
 * Derives the stock status key from quantity and min level.
 * Threshold logic is display-only; the backend ledger remains authoritative.
 */
export function deriveStockStatusKey(qty: number, minLevel: number): StockStatusKey {
  if (qty <= 0) return "out_of_stock";
  if (minLevel > 0 && qty <= minLevel) return "low_stock";
  return "in_stock";
}

/**
 * Transforms a raw product into a `MobileStockRow`.
 * Reads stock from `getActualStock()` — the ledger snapshot authority.
 */
export function toMobileStockRow(product: any): MobileStockRow {
  const id = String(product?.id ?? "");
  const qty = getActualStock(product);
  const minLevel = productMinLevel(product);
  const statusKey = deriveStockStatusKey(qty, minLevel);
  const statusEntry = resolveStockStatus(statusKey);

  return {
    id,
    name: String(product?.name ?? "—"),
    sku: String(product?.sku ?? "—"),
    quantity: qty,
    quantityFormatted: formatArabicQuantity(qty),
    statusKey,
    statusLabelAr: statusEntry.labelAr,
    statusTone: statusEntry.tone,
    href: `/inventory/${id}`,
  };
}

/**
 * Transforms a list of raw products into mobile stock rows.
 * Sorted by stock status priority (out-of-stock first), then by name.
 */
export function toMobileStockQueue(products: any[]): MobileStockRow[] {
  if (!Array.isArray(products)) return [];
  return products
    .map((p) => {
      try {
        return toMobileStockRow(p);
      } catch {
        return null;
      }
    })
    .filter((row): row is MobileStockRow => row !== null)
    .sort((a, b) => {
      const priority = { out_of_stock: 0, low_stock: 1, in_stock: 2 } as const;
      const pa = priority[a.statusKey] ?? 3;
      const pb = priority[b.statusKey] ?? 3;
      if (pa !== pb) return pa - pb;
      return a.name.localeCompare(b.name, "ar");
    });
}

/**
 * Returns only products that are at or below min stock level.
 */
export function lowStockRows(products: any[]): MobileStockRow[] {
  return toMobileStockQueue(products).filter(
    (r) => r.statusKey === "low_stock" || r.statusKey === "out_of_stock",
  );
}
