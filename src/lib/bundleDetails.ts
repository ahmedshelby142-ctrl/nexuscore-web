/** Current catalog details only. Historical receipt recipes never call this. */
export interface BundleComponentDetail {
  productId: string;
  productName: string;
  variantName?: string;
  sku?: string;
  quantity: number | null;
  unavailable: boolean;
  variantUnavailable: boolean;
}

/** Historical order components come from its saved reservation, never today's recipe. */
export function savedOrderBundleComponents(item: {bundleId?:string;productId?:string},stockItems: readonly any[]):BundleComponentDetail[] {
 const id=item.bundleId||item.productId;
 if(!id)return [];
 return stockItems.filter(c=>c.bundleId===id).map(c=>({
  productId:String(c.productId??""),productName:c.productName||"مكون غير مسمى",sku:c.sku||undefined,variantName:c.variantName||undefined,
  quantity:Number.isFinite(Number(c.quantity))&&Number(c.quantity)>0?Number(c.quantity):null,unavailable:!c.productName,variantUnavailable:false,
 }));
}

export function bundleComponentDetails(
  recipe: readonly any[],
  products: ReadonlyMap<string, any>,
  storeId: string,
): BundleComponentDetail[] {
  return recipe.map((item) => {
    const productId = String(item.productId ?? "");
    const candidate = products.get(productId);
    // A cache, fixture or stale response must never resolve another tenant's
    // product. The reader also scopes its query and keeps no tab-lifetime cache.
    const product = storeId && candidate?.store_id === storeId ? candidate : null;
    const variantName = typeof item.variantName === "string" ? item.variantName : undefined;
    const variants = product?.metadata?.variants ?? product?.variants ?? [];
    const quantity = Number(item.quantity);
    return {
      productId,
      productName: product?.name || item.productName || "منتج غير متاح",
      variantName,
      sku: product?.sku || undefined,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
      unavailable: !product,
      variantUnavailable: Boolean(product && variantName &&
        !variants.some((variant: any) => variant.name === variantName)),
    };
  });
}
