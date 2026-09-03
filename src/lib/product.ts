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

// Relative and extension-bearing, because the node:test guards import this
// module directly and resolve neither the `@/` alias nor an extensionless
// specifier. `@/types` next to it survives only because it is a type-only
// import, erased before it ever runs. tsconfig sets
// `allowImportingTsExtensions`, so this is valid to the compiler too.
import { ledgerQty } from "./ledger/stockSnapshot.ts";
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

// ── Stock, as the product record has it ─────────────────────────────────────

/**
 * The stock number every selling screen shows: POS, جملة, أونلاين, الجرد.
 *
 * The doctrine above ("stock is SUM(qty) over the ledger, read it with
 * `qtyOf`") is the authority. This reads the MIRROR of it that
 * `lib/stockMirror` maintains on the product record, which exists so a list of
 * 200 products can render without 200 ledger aggregations.
 *
 * The mirror is derived, never authoritative. `useStock().qtyOf` remains the
 * number to trust when the two disagree; this one is for rendering at scale.
 *
 * One reader, so the screens cannot disagree again. Variants win when a
 * product has them, because the per-variant `stock` is what الشراء، البيع
 * and المرتجعات actually keep up to date.
 *
 * Non-variant products ARE decremented now: every screen routes its lines
 * through `applyStockMoves`, and `lib/stockMirror` maintains `totalQuantity`
 * and the variant array side by side. (The note that used to sit here said the
 * opposite; it predated the mirror.)
 *
 * Floored at zero on READ as well as on write. The mirror already refuses to
 * store a negative, but a record imported from a spreadsheet or written before
 * the mirror existed can still hold one, and "−3 على الرف" is not a thing a
 * screen may ever show. What is genuinely owed lives in تقرير النواقص.
 */
export function getActualStock(product: Product | null | undefined): number {
  // THE LEDGER WINS. `products.quantity` and the variant array are a mirror
  // that `applyStockMoves` keeps in step; the ledger's SUM is the number the
  // architecture calls stock (see `addProduct`, `useStock`, `stockSnapshot`).
  // Reading the mirror here is what let /bundles show "المخزون: ٥٠" and
  // "نفد المخزون" for one product in one screen.
  //
  // A bundle owns no stock of its own and has no ledger lines, so it keeps
  // the recipe-derived answer `bundleAvailableStock` computes for it.
  if (product?.id && !(product as any).isBundle) {
    const fromLedger = ledgerQty(product.id);
    // `null` means no aggregation has landed yet — NOT zero. Fall through to
    // the mirror for that one moment rather than painting a sold-out shop.
    if (fromLedger !== null) return Math.max(0, fromLedger);
  }

  const variants = product?.metadata?.variants ?? product?.variants;
  if (Array.isArray(variants) && variants.length > 0) {
    return Math.max(
      0,
      variants.reduce((sum: number, v: any) => sum + (Number(v?.stock) || 0), 0),
    );
  }
  return Math.max(0, Number(product?.totalQuantity) || Number(product?.quantity) || 0);
}

/**
 * How many whole بوكسات you could build right now — the recipe's binding
 * constraint.
 *
 * A bundle owns no stock; its availability is entirely a fact about its
 * components. Needing 2 of X with 4 of X on the shelf means 2 boxes, and the
 * SCARCEST component decides — hence `min` over `floor(stock / per)`.
 *
 * Returns 0 for a bundle with no recipe: a box that lists nothing is not
 * infinitely available, it is unbuildable.
 */
export function bundleAvailableStock(
  bundle: Product | null | undefined,
  products: Product[],
): number {
  const recipe = (bundle as any)?.bundleItems as
    | { productId: string; quantity: number; variantName?: string }[]
    | undefined;
  if (!recipe?.length) return 0;

  const byId = new Map(products.map((p) => [p.id, p]));
  let buildable = Infinity;

  for (const component of recipe) {
    const per = Number(component.quantity);
    if (!Number.isFinite(per) || per <= 0) continue;
    const onHand = component.variantName
      ? getVariantStock(byId.get(component.productId), component.variantName)
      : getActualStock(byId.get(component.productId));
    buildable = Math.min(buildable, Math.floor(onHand / per));
  }

  return Number.isFinite(buildable) ? Math.max(0, buildable) : 0;
}

/**
 * What a selling screen may put in a basket — the ONE reader for that question.
 *
 * Three cases, deliberately in one function so they cannot drift:
 *   - a بوكس has no shelf; its stock is `bundleAvailableStock` of the recipe
 *   - a named درجة reads that variant
 *   - anything else reads the product total
 *
 * POS blocked at `onHand <= 0` using a reader that knew nothing about bundles,
 * so every بوكس in the catalogue showed "نفد المخزون" and could not be sold at
 * all — the components were on the shelf, the box just had no way to say so.
 */
export function sellableStock(
  product: Product | null | undefined,
  products: Product[],
  variantName?: string,
): number {
  if ((product as any)?.isBundle) return bundleAvailableStock(product, products);
  return getVariantStock(product, variantName);
}

/** Stock of one variant by name, falling back to the product total. */
export function getVariantStock(
  product: Product | null | undefined,
  variantName?: string,
): number {
  if (!variantName) return getActualStock(product);
  const variants = product?.metadata?.variants ?? product?.variants;
  const hit = Array.isArray(variants)
    ? variants.find((v: any) => v?.name === variantName)
    : undefined;
  const fromMirror = Math.max(0, Number(hit?.stock) || 0);

  // The ledger keeps ONE quantity per product — there are no per-درجة lines —
  // so the split between درجات can only come from the mirror. It is still
  // clamped to the product's authoritative total: a درجة must never offer
  // units the product as a whole does not have, which is exactly how the
  // fondation showed "احمر — المتاح: 30" against a ledger holding zero.
  return Math.min(fromMirror, getActualStock(product));
}
