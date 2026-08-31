/**
 * Moving stock on the product record — the pure half.
 *
 * ## Why this exists at all
 *
 * `getActualStock` reads the product record, so the record has to be right.
 * It used to be maintained by five near-identical loops (POS, الشراء، الجرد،
 * المرتجعات and two in الطلبات), and all five opened with the same line:
 *
 *     if (line.variantName) { ...move the variant... }
 *
 * A product WITHOUT variants therefore moved nothing, ever. `totalQuantity`
 * was written once at creation or import and then frozen for the life of the
 * product, while every selling screen read it. A shop selling plain products
 * watched the number on screen never change.
 *
 * So: a screen describes what moved, this decides how the record changes. The
 * variant branch and the plain branch live side by side in ONE function,
 * which is the only arrangement in which they cannot drift apart again.
 *
 * ## Two invariants
 *
 *   - `totalQuantity` on a variant product is ALWAYS the sum of its variants.
 *     It is recomputed here, never adjusted, so the two cannot disagree by an
 *     accumulated rounding of history.
 *   - Stock floors at 0. A shelf cannot hold −3 shirts. Selling short is a
 *     real thing the نواقص flow allows, and what is owed then lives in the
 *     open orders (`lib/shortages.ts`) — never as a negative quantity that
 *     would quietly swallow the first units of the next توريد.
 */

/**
 * One line of stock movement, as any transaction screen describes it.
 *
 * `delta` is SIGNED and says which way the goods went, so the caller never
 * has to know whether this adds or subtracts: a sale sends `-qty`, a توريد
 * sends `+qty`, a مرتجع sends `+qty`. There is no `direction` flag, because a
 * flag is a second thing to get wrong.
 */
export interface StockMove {
  productId: string;
  /** Negative leaves the shelf, positive comes back to it. */
  delta: number;
  /** Which درجة/لون moved. Omitted for a product without variants. */
  variantName?: string;
}

/**
 * A بوكس is not a shelf — it is a recipe. Turn lines into what really moves.
 *
 * A bundle product has no stock of its own: `getActualStock` on one reads a
 * `totalQuantity` nothing ever writes. So a line naming a bundle must become
 * one line per component before it reaches `applyMovesToProducts`, or the
 * move lands on the virtual record, floors at 0, and the components that
 * physically left the shelf are never decremented.
 *
 * `delta` carries through multiplied by the recipe quantity and keeps its
 * sign, so selling a box of 3 sends −3 and returning it sends +3 — the same
 * rule in both directions, with no flag to get backwards.
 *
 * A bundle whose component list is missing or empty passes through untouched
 * rather than silently moving nothing: a box with no recipe is a data problem
 * to see, not a sale to swallow.
 */
export function expandBundleMoves<
  P extends {
    id: string;
    isBundle?: boolean;
    bundleItems?: { productId: string; quantity: number; variantName?: string }[];
  },
>(moves: StockMove[], products: P[]): StockMove[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  const out: StockMove[] = [];

  for (const move of moves) {
    const product = byId.get(move.productId);
    const recipe = product?.isBundle ? product.bundleItems : undefined;
    if (!recipe?.length) {
      out.push(move);
      continue;
    }
    for (const component of recipe) {
      const per = Number(component.quantity);
      if (!component.productId || !Number.isFinite(per) || per <= 0) continue;
      out.push({
        productId: component.productId,
        delta: move.delta * per,
        variantName: component.variantName,
      });
    }
  }

  return out;
}

/**
 * Apply every move to a product list, returning a new list.
 *
 * Products no move names are returned by reference, so a transaction touching
 * two products does not invalidate the other four hundred.
 */
export function applyMovesToProducts<T extends { id: string }>(
  products: T[],
  moves: StockMove[],
): { products: T[]; touched: string[] } {
  // Group first: ten lines of the same product are ONE recompute, and the
  // intermediate values never round-trip through the store.
  const byProduct = new Map<string, StockMove[]>();
  for (const move of moves) {
    if (!move?.productId || !Number.isFinite(move.delta) || move.delta === 0) continue;
    const list = byProduct.get(move.productId);
    if (list) list.push(move);
    else byProduct.set(move.productId, [move]);
  }
  if (byProduct.size === 0) return { products, touched: [] };

  const touched: string[] = [];
  const next = products.map((product) => {
    const productMoves = byProduct.get(product.id);
    if (!productMoves) return product;
    touched.push(product.id);
    return applyToOne(product, productMoves);
  });

  return { products: next, touched };
}

function applyToOne<T extends { id: string }>(product: T, moves: StockMove[]): T {
  const p = product as any;
  const variants = p.metadata?.variants;
  const hasVariants = Array.isArray(variants) && variants.length > 0;

  if (hasVariants) {
    // A move that names no variant on a variant product cannot be placed —
    // there is no honest guess at WHICH درجة moved — so it is left alone
    // rather than charged to the first one in the list.
    const nextVariants = variants.map((variant: any) => {
      const delta = moves
        .filter((m) => m.variantName === variant.name)
        .reduce((sum, m) => sum + m.delta, 0);
      if (delta === 0) return variant;
      return { ...variant, stock: Math.max(0, (Number(variant.stock) || 0) + delta) };
    });
    return {
      ...p,
      metadata: { ...p.metadata, variants: nextVariants },
      totalQuantity: nextVariants.reduce((sum: number, v: any) => sum + (Number(v.stock) || 0), 0),
      updated_at: Date.now(),
    };
  }

  const delta = moves.reduce((sum, m) => sum + m.delta, 0);
  const current = Number(p.totalQuantity ?? p.quantity) || 0;
  return {
    ...p,
    totalQuantity: Math.max(0, current + delta),
    updated_at: Date.now(),
  };
}
