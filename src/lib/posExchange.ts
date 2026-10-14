import { runFinancialCommand } from "@/lib/financialCommand";
import { refreshFeatureStock } from "@/services/featureStockMirror";
import { buildSaleLines } from "./ledger/sales";
import { returnStockFields } from "./posReturn";
import { buildableFromRecipe, sellableStock } from "./product";

/** A return and a replacement of the same shade remain separate cart lines. */
export const posCartLineKey = (item: { productId: string; variantName?: string; returnOfEventId?: string }) =>
  JSON.stringify([item.productId, item.variantName ?? "", item.returnOfEventId ?? ""]);

export function posStockAfterReturns(product: any, products: any[], cart: readonly any[], variantName?: string): number {
  const credit = (id: string, variant?: string) => cart.filter(i => i.quantity < 0).reduce((sum, i) => {
    const parts = i.historicalCost?.isBundle ? i.historicalCost.bundleItems ?? [] : [{ productId: i.productId, variantName: i.variantName, quantity: 1 }];
    return sum + parts.filter((p: any) => p.productId === id && (variant == null || (p.variantName ?? "") === variant))
      .reduce((n: number, p: any) => n - i.quantity * p.quantity, 0);
  }, 0);
  if (product?.isBundle) return buildableFromRecipe(product.bundleItems, (id, variant) =>
    sellableStock(products.find(p => p.id === id), products, variant) + credit(id, variant));
  return sellableStock(product, products, variantName) + credit(product?.id, variantName);
}

export interface PosExchangeResult {
  eventId: string; sourceEventId: string; returnEventId: string; replacementEventId: string;
  returnRecordId: string; refundPiastres: number; replacementPiastres: number; netPiastres: number;
  sourceDocumentNumber?: string; replacementDocumentNumber?: string;
  affectedProductIds: string[]; replayed: boolean;
}

/** The SQL command owns both linked legs, document, variants and retry receipt. */
export async function commitPosExchange(input: {
  cart: readonly any[]; wallet: string; customerId?: string; customerName?: string; customerPhone?: string;
  discountCodeId?: string; discountAmount?: number;
}): Promise<PosExchangeResult> {
  const returned = input.cart.filter(i => i.quantity < 0), replacement = input.cart.filter(i => i.quantity > 0);
  const sources = new Set(returned.map(i => i.returnOfEventId));
  if (!returned.length || !replacement.length || sources.size !== 1 || !returned[0].returnOfEventId)
    throw Object.assign(new Error("اختر مرتجعًا موثقًا وبديلًا من فاتورة أصلية واحدة."), { definite: true });
  const base = { kind: "sale", refType: "pos_sale", actor: "POS" };
  const payload = { channel: "pos", walletId: input.wallet, customerId: input.customerId, customerName: input.customerName, customerPhone: input.customerPhone };
  const items = returned.map(i => ({ productId: i.productId, productName: i.productName, variantName: i.variantName,
    quantity: i.quantity, unitPrice: i.unitPrice, ...returnStockFields(i.historicalCost ?? {}) }));
  const positive = replacement.map(i => ({ productId: i.productId, productName: i.productName, variantName: i.variantName,
    quantity: i.quantity, unitPrice: i.unitPrice, unitCost: 0 }));
  const result = await runFinancialCommand<PosExchangeResult>("pos_exchange", {
    return: { ...base, payload: { ...payload, items, returnOfEventId: returned[0].returnOfEventId, discountAmount: 0 },
      lines: buildSaleLines({ items, wallet: input.wallet, customerId: input.customerId }) },
    // The server derives actual replacement costs and saved recipes under locks.
    replacement: { ...base, payload: { ...payload, items: positive, discountCodeId: input.discountCodeId, discountAmount: input.discountAmount ?? 0 } },
  }, "ledger:sale");
  try { await refreshFeatureStock(result.affectedProductIds); }
  catch { console.warn("تم تسجيل الاستبدال؛ تعذّر تحديث عرض المخزون. حدّث الصفحة دون إعادة العملية."); }
  return result;
}
