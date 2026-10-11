import type { EcommerceOrderItem } from "@/types";
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
