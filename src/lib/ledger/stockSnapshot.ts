/**
 * The authoritative stock figures, where a synchronous caller can reach them.
 *
 * ## Why this module exists
 *
 * This app had TWO answers to "how much is on the shelf":
 *
 *   `useStock().qtyOf(id)`   SUM(qty_delta) over `ledger_lines`   — async
 *   `getActualStock(product)` the `products.quantity` mirror      — sync
 *
 * and they disagreed. On /bundles that was visible within one screen: the
 * search row offered a product as "المخزون: ٥٠" and the component row added
 * from it said "نفد المخزون! لا يمكنك إضافة هذا المنتج" — because the first
 * read the mirror and the second read the ledger.
 *
 * The architecture already says which one wins. `addProduct` refuses a
 * `quantity` argument because "stock is the ledger's SUM (§1.1)", and
 * `useStock` promises "the POS, the products page and the warehouse screen
 * cannot disagree — they are literally the same SUM". The ledger is the
 * source of truth; the mirror is a cache that `applyStockMoves` keeps in step.
 *
 * The only thing standing in the way was shape: the ledger read is async and
 * `getActualStock` is a pure function called from 48 places. So `useStock`
 * publishes each successful aggregation here, and `getActualStock` reads it.
 * No call site changes, and there is one number again.
 *
 * ## null is not zero
 *
 * Before the first read lands there is no answer, and `null` says so. A stock
 * reader that turned "not loaded yet" into 0 would paint a sold-out shop on
 * every cold start and let the cashier sell nothing — the same failure
 * `useStock` already refuses for a FAILED read. Callers fall back to the
 * mirror for that one moment instead.
 */

let snapshot: Map<string, number> | null = null;

/** Publish an aggregation. Called by `useStock` on every successful read. */
export function setStockSnapshot(next: Map<string, number>): void {
  snapshot = next;
}

/**
 * Ledger quantity for one product, or `null` if no aggregation has landed yet.
 *
 * A product absent from a loaded snapshot has genuinely never moved, which is
 * 0 — that is a real answer, not a missing one.
 */
export function ledgerQty(productId: string): number | null {
  if (!snapshot) return null;
  return snapshot.get(productId) ?? 0;
}

/** Drop it. Called when the signed-in store changes — see `clearCloudOwnedState`. */
export function clearStockSnapshot(): void {
  snapshot = null;
}
