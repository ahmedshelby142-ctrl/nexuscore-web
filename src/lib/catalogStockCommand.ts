import { runFinancialCommand, resolvePendingFinancialCommand, resolvePendingOpeningBalance } from "@/lib/financialCommand";
import { toRemoteRow, fromRemoteRow } from "@/services/api/fieldMapping";
import { getSyncIdentity } from "@/services/api/storeContext";
import { useBusinessStore } from "@/store/useBusinessStore";
import type { Product } from "@/types";

const SCOPE = "product_catalog";
type Result = { product: any; eventId: string | null; replayed: boolean };
async function publish(result: Result, storeId: string): Promise<Product> {
  const saved = fromRemoteRow("products", result.product) as Product;
  if ((await getSyncIdentity())?.storeId === storeId) {
    useBusinessStore.setState(state => {
      const current = state.products.find(p => p.id === saved.id);
      if (current && Number(current.updated_at ?? 0) > Number(saved.updated_at ?? 0)) return state;
      return { products: [...state.products.filter(p => p.id !== saved.id), saved] };
    });
  }
  return saved;
}

/** Recover the original operation before minting a new product identity. */
export async function resolvePendingCatalog(): Promise<void> {
  const identity = await getSyncIdentity();
  if (!identity) throw new Error("لا يوجد متجر مسجل");
  const result = await resolvePendingFinancialCommand<Result>(SCOPE);
  if (result) {
    await publish(result, identity.storeId);
    throw new Error("تم تأكيد حفظ المنتج السابق. راجع القائمة قبل حفظ بيانات جديدة.");
  }
  // Older saved opening requests retain their original financial identity.
  await resolvePendingOpeningBalance();
}

export async function saveCatalogProduct(fields: Partial<Product>, options: {
  existing?: Product; quantity: number; unitCost?: number;
}): Promise<Product> {
  await resolvePendingCatalog();
  const identity = await getSyncIdentity();
  if (!identity) throw new Error("لا يوجد متجر مسجل");
  const id = options.existing?.id ?? crypto.randomUUID();
  const result = await runFinancialCommand<Result>("product_catalog", {
    action: options.existing ? "update" : "create",
    product: toRemoteRow("products", { ...fields, id, totalQuantity: options.quantity }),
    expectedUpdatedAt: options.existing?.updated_at,
    unitCost: options.unitCost ?? 0,
  }, SCOPE, identity.storeId);
  return publish(result, identity.storeId);
}
