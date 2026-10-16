import type { EcommerceOrderItem } from "@/types";
import { buildableFromRecipe, variantStockFrom } from "@/lib/product";
import { exchangeCreditDraft } from "@/lib/exchangeCredit";

/** Preview the SAME credit capacity used by record_order_edit. Earned credit
 * cannot silently become a refund; the server rejects edits below it. */
export function pendingOrderCod(order: any, netGoods: number) {
  const credit = order?.exchangeDetails?.credit;
  const capacity = exchangeCreditDraft(netGoods, order?.shippingFee ?? 0,
    order?.wastedTripCompensation ?? 0, order?.depositAmount ?? 0,
    credit?.version === 1 ? (credit.status === "reserved" ? credit.eligiblePiastres : credit.allocatedPiastres) / 100 : 0);
  return {...capacity, requiresCreditRefund: credit?.version === 1 && credit.status !== "reserved"
    && capacity.allocatedPiastres < credit.allocatedPiastres};
}

/** Saved components own their recipe; catalogue edits cannot substitute it.
 * Aggregate duplicates before division, and keep exact shades separate. */
export function pendingOrderLineCeiling(line: EcommerceOrderItem, order: any,
  products: readonly any[], qtyOf: (id: string) => number): number {
  const id = line.bundleId || line.productId;
  const original = (order?.items ?? []).filter((i: EcommerceOrderItem) =>
    (i.bundleId || i.productId) === id && i.variantName === line.variantName)
    .reduce((sum: number, i: EcommerceOrderItem) => sum + i.quantity, 0);
  const product = products.find(p => p.id === id);
  if (!line.bundleId && !product?.isBundle)
    return original + variantStockFrom(product, line.variantName, qtyOf(id));
  const saved = (order?.fulfillment?.demands ?? order?.stockItems ?? []).filter((i: any) => i.bundleId === id);
  const recipe = saved.length && original > 0
    ? saved.map((i: any) => ({ ...i, quantity: i.quantity / original }))
    : product?.bundleItems ?? [];
  if (!recipe.length) return original;
  return original + buildableFromRecipe(recipe, (componentId, variant) =>
    variantStockFrom(products.find(p => p.id === componentId), variant, qtyOf(componentId)));
}
/** Preview the same saved reservation recipe the server owns. Additional units
 * of an existing box keep that recipe; newly added boxes use today's catalogue. */
export function expandPendingOrderItems(
  items: EcommerceOrderItem[],
  original: { items?: EcommerceOrderItem[]; stockItems?: EcommerceOrderItem[] },
  products: readonly any[],
  costOf: (id: string) => number,
): EcommerceOrderItem[] {
  return items.flatMap((item) => {
    const id = item.bundleId || item.productId,
      product = products.find((p) => p.id === id);
    const oldSold = original.items?.find((i) => (i.bundleId || i.productId) === id);
    const reserved = original.stockItems?.filter((i) => i.bundleId === id) ?? [];
    if (item.bundleId || product?.isBundle) {
      if (oldSold && reserved.length)
        return reserved.map((c) => ({
          ...c,
          quantity: (c.quantity / oldSold.quantity) * item.quantity,
        }));
      return (product?.bundleItems ?? []).map((c: any) => ({
        id: crypto.randomUUID(),
        productId: c.productId,
        variantName: c.variantName,
        productName: products.find((p) => p.id === c.productId)?.name ?? c.productId,
        quantity: c.quantity * item.quantity,
        unitPrice: 0,
        unitCost: costOf(c.productId),
        bundleId: id,
        bundleName: item.productName,
      }));
    }
    return [{ ...item, unitCost: item.unitCost ?? costOf(item.productId) }];
  });
}
