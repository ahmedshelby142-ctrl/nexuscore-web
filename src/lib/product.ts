/**
 * Reading a product's price, in one place.
 *
 * ## Why this file exists
 *
 * `Product` used to declare BOTH `retail_price` and `unitPrice` as required
 * numbers. Nothing ever wrote `retail_price` — not the product form, not the
 * bulk importer, not sync. Every product in the store had it `undefined` while
 * the type swore it was a number, so `p.retail_price` type-checked and then
 * produced `undefined` at runtime.
 *
 * That is where the order form's "NaN" came from: `quantity * undefined`.
 * It also silently emptied the returns/exchange picker, whose filter read
 * `p.stock_qty > 0` — `undefined > 0` is `false`, so every product was hidden
 * and the screen looked "empty" rather than broken.
 *
 * The fix is the field's deletion (see `src/types/index.ts`), not a `??`
 * fallback at each call site. A fallback chain spreads the ambiguity: it makes
 * every reader responsible for knowing which of two names holds the truth, and
 * the one reader that forgets — line 181 of the order form — is the bug again.
 *
 * ## Why there is no `productStock`
 *
 * There deliberately isn't one. Stock is not a product field; it is
 * `SUM(qty)` over the ledger (rule §1.1). Every stock read goes through
 * `qtyOf` from `useStock`. An accessor here would have re-legitimised the
 * stored `stock_qty` column that the ledger conversion exists to delete —
 * the same shape of bug, one indirection further away.
 */

import type { Product } from "@/types";

/**
 * The retail (قطاعي) selling price. `unitPrice` is the field every writer
 * actually writes; the guard is here because the store is persisted, so old
 * localStorage rows written before this cleanup may still be missing it.
 */
export function productPrice(product: Pick<Product, "unitPrice"> | null | undefined): number {
  const value = product?.unitPrice;
  return Number.isFinite(value) ? (value as number) : 0;
}

/**
 * The stock level at which this product needs reordering.
 *
 * There used to be two spellings — `minStockLevel` (written by the product
 * form) and `reorder_point` (written by nothing) — and three separate
 * `p.minStockLevel ?? p.reorder_point ?? 0` chains reading them. Every one of
 * those chains fell through the second term on every product, so the chain was
 * pure noise that looked like careful defensiveness.
 */
export function productMinLevel(
  product: Pick<Product, "minStockLevel"> | null | undefined,
): number {
  const value = product?.minStockLevel;
  return Number.isFinite(value) ? (value as number) : 0;
}

/**
 * The wholesale (جملة) price, falling back to retail when a product has no
 * separate wholesale price — which is the honest default: selling at retail is
 * a real price, whereas 0 would silently give the goods away.
 *
 * This accessor itself carried the bug it now fixes: it read `wholesale_price`,
 * a field no writer ever wrote, so it fell through to retail on EVERY product
 * and no wholesale price was ever used. `wholesalePrice` is the field the
 * product form and the bulk importer actually write.
 */
export function productWholesalePrice(
  product: Pick<Product, "unitPrice" | "wholesalePrice"> | null | undefined,
): number {
  const value = product?.wholesalePrice;
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : productPrice(product);
}

// ── Archiving vs deleting ───────────────────────────────────────────────────

/**
 * Archived (تم أرشفته): hidden from the active lists, record still there.
 *
 * `deleted_at` is a tombstone, not an erasure. The row survives so that every
 * ledger event that names this product still resolves to a real product —
 * which is the whole reason an archived product cannot simply be dropped.
 */
export function isProductArchived(product: Pick<Product, "deleted_at">): boolean {
  return product.deleted_at != null;
}

/** The products a screen should offer: everything not archived. */
export function activeProducts<T extends Pick<Product, "deleted_at">>(products: T[]): T[] {
  return products.filter((p) => !isProductArchived(p));
}

/**
 * May this product be really deleted, or only archived?
 *
 * The ledger is append-only: hard-deleting a product the ledger has already
 * mentioned would leave sale, purchase and opening-balance lines pointing at
 * a product that no longer exists, and every report reading them would show a
 * blank where a name should be.
 *
 * The test is whether the ledger has ANY line for it — never whether the
 * balance is non-zero. A product received and then sold out sums to exactly 0
 * and still has a full history behind it; `balances()` returns a row whenever
 * lines exist, and no row when they do not, so the row COUNT is the honest
 * question and the sum is the trap.
 */
export function removalMode(ledgerRows: unknown[]): "delete" | "archive" {
  return ledgerRows.length > 0 ? "archive" : "delete";
}
