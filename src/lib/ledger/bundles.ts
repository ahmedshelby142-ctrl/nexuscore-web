/**
 * بوكس / بندل — what a composed product costs, and what it moves.
 *
 * ## The bug this exists to kill
 *
 * Four builders — `buildSaleLines`, `buildWholesaleInvoiceLines`,
 * `buildWholesaleReturnLines` and `buildReturnConfirmedLines` — each carried
 * their own copy of the bundle expansion, and every copy had the same hole:
 * the STOCK lines were bundle-aware and the COGS line was not.
 *
 *     if (item.isBundle) { for each component → stock −qty at component cost }
 *     else               { stock −qty at item cost }
 *     if (lineCost !== 0) { cogs += item.unitCost × item.quantity }   ← blind
 *
 * A بوكس is virtual: it has no purchases and no stock lines of its own, so
 * `costOf(bundleId)` is 0. `lineCost` was therefore 0, the `!== 0` guard
 * skipped the COGS line entirely, and a bundle sale booked **full revenue
 * against zero cost**. Measured: a 500 box of components worth 250 reported 500
 * of profit instead of 250, and 250 of inventory value left the `stock` account
 * with nothing on the other side of it.
 *
 * The same blindness reversed a bundle RETURN: stock came back at component
 * value while COGS stayed where it was.
 *
 * ## The rule
 *
 * A bundle's cost is its components' cost — nothing else:
 *
 *     bundle cost = Σ (component quantity × bundle quantity × component WAC)
 *
 * and it is DERIVED at the moment of the movement, never stored. `BundlesPage`
 * shows the same sum while the box is being built, from the same `costOf`, but
 * saves only the recipe. A stored cost would be a second truth that goes stale
 * the next time a component is purchased at a different price — which is
 * exactly what the weighted average exists to track.
 *
 * COGS is attributed to the COMPONENTS, matching the stock lines, so a margin
 * report reads the same product on both sides of the entry. Booking it against
 * the bundle id would leave every component looking like it had been given away.
 */

import type { NewLine } from "./types";

/** One component of a بوكس, costed at the moment of the movement. */
export interface BundleComponent {
  productId: string;
  quantity: number;
  /** The component's authoritative unit cost — `costOf`, never a stored field. */
  unitCost: number;
}

/** The little of a sale/return line these helpers need. */
export interface CostedItem {
  productId: string;
  /** Signed in `buildSaleLines` (a POS return is negative); positive elsewhere. */
  quantity: number;
  unitCost: number;
  isBundle?: boolean;
  bundleItems?: BundleComponent[];
}

/**
 * The recipe to charge this line against, or `null` for a plain product.
 *
 * `isBundle` with an EMPTY recipe returns null on purpose: a box nobody has
 * filled in yet is not a box, and treating it as one would move no stock and
 * book no cost while still selling it.
 */
export function bundleRecipeOf(item: CostedItem): BundleComponent[] | null {
  if (!item.isBundle) return null;
  const recipe = item.bundleItems;
  if (!recipe?.length) return null;
  return recipe;
}

/**
 * What the goods on this line actually COST — the number COGS must use.
 *
 * For a plain product that is `unitCost × quantity`, exactly as before. For a
 * بوكس it is the components, which is the whole point.
 */
export function lineCostOf(item: CostedItem): number {
  const recipe = bundleRecipeOf(item);
  if (!recipe) return item.unitCost * item.quantity;
  return recipe.reduce(
    (total, component) => total + component.unitCost * component.quantity * item.quantity,
    0,
  );
}

/**
 * The stock movement for this line.
 *
 * `direction` is −1 when goods LEAVE (a sale) and +1 when they come back (a
 * return, a cancellation, an RTO). The line's own `quantity` sign is respected
 * on top of it, which is what lets `buildSaleLines` carry a POS return as a
 * negative quantity through the same path.
 *
 * Quantity and value always move together: moving one without the other is
 * what silently rewrites the weighted-average cost of everything still on the
 * shelf.
 */
export function stockLinesFor(item: CostedItem, direction: 1 | -1): NewLine[] {
  const recipe = bundleRecipeOf(item);
  if (!recipe) {
    return [
      {
        account: "stock",
        subjectId: item.productId,
        qty: direction * item.quantity,
        amount: direction * item.unitCost * item.quantity,
      },
    ];
  }
  return recipe.map((component) => ({
    account: "stock" as const,
    subjectId: component.productId,
    qty: direction * component.quantity * item.quantity,
    amount: direction * component.unitCost * component.quantity * item.quantity,
  }));
}

/**
 * The COGS lines for this line, attributed to whatever really moved.
 *
 * `sign` is +1 when the cost becomes a cost of goods SOLD and −1 when a return
 * takes it back off. Zero-cost lines write nothing — a product whose cost is
 * genuinely zero has no cost to book — but a bundle is now costed from its
 * components first, so a real box can no longer fall through that guard.
 */
export function cogsLinesFor(item: CostedItem, sign: 1 | -1): NewLine[] {
  const recipe = bundleRecipeOf(item);
  if (!recipe) {
    const lineCost = item.unitCost * item.quantity;
    if (lineCost === 0) return [];
    return [
      {
        account: "cogs",
        subjectId: item.productId,
        amount: sign * lineCost,
        unitCost: item.unitCost,
      },
    ];
  }
  const lines: NewLine[] = [];
  for (const component of recipe) {
    const componentCost = component.unitCost * component.quantity * item.quantity;
    if (componentCost === 0) continue;
    lines.push({
      account: "cogs",
      subjectId: component.productId,
      amount: sign * componentCost,
      unitCost: component.unitCost,
    });
  }
  return lines;
}
