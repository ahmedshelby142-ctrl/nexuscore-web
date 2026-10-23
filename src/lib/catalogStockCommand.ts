import {
  runFinancialCommand,
  resolvePendingFinancialCommand,
  resolvePendingOpeningBalance,
} from "@/lib/financialCommand";
import { toRemoteRow, fromRemoteRow } from "@/services/api/fieldMapping";
import { getSyncIdentity } from "@/services/api/storeContext";
import { useBusinessStore } from "@/store/useBusinessStore";
import type { Product } from "@/types";

const SCOPE = "product_catalog";
type Result = { product: any; eventId: string | null; replayed: boolean };
export type ImportStockContext = "catalog" | "opening" | "owned";
async function publish(result: Result, storeId: string): Promise<Product> {
  const saved = fromRemoteRow("products", result.product) as Product;
  if ((await getSyncIdentity())?.storeId === storeId) {
    useBusinessStore.setState((state) => {
      const current = state.products.find((p) => p.id === saved.id);
      if (current && Number(current.updated_at ?? 0) > Number(saved.updated_at ?? 0)) return state;
      return { products: [...state.products.filter((p) => p.id !== saved.id), saved] };
    });
  }
  return saved;
}

/** Recover the original operation before minting a new product identity. */
export async function resolvePendingCatalog(
  options: { continueAfterRecovery?: boolean } = {},
): Promise<void> {
  const identity = await getSyncIdentity();
  if (!identity) throw new Error("لا يوجد متجر مسجل");
  const result = await resolvePendingFinancialCommand<Result>(SCOPE);
  if (result) {
    await publish(result, identity.storeId);
    if (!options.continueAfterRecovery)
      throw new Error("تم تأكيد حفظ المنتج السابق. راجع القائمة قبل حفظ بيانات جديدة.");
  }
  // Older saved opening requests retain their original financial identity.
  await resolvePendingOpeningBalance();
}

export async function saveCatalogProduct(
  fields: Partial<Product>,
  options: {
    existing?: Product;
    quantity: number;
    unitCost?: number;
    createId?: string;
  },
): Promise<Product> {
  await resolvePendingCatalog();
  const identity = await getSyncIdentity();
  if (!identity) throw new Error("لا يوجد متجر مسجل");
  const id = options.existing?.id ?? options.createId ?? crypto.randomUUID();
  const result = await runFinancialCommand<Result>(
    "product_catalog",
    {
      action: options.existing ? "update" : "create",
      product: toRemoteRow("products", { ...fields, id, totalQuantity: options.quantity }),
      expectedUpdatedAt: options.existing?.updated_at,
      unitCost: options.unitCost ?? 0,
    },
    SCOPE,
    identity.storeId,
  );
  return publish(result, identity.storeId);
}

/** Create-only import receipt. Existing identifiers are never an update. */
export async function resolvePendingImport(): Promise<void> {
  const identity = await getSyncIdentity();
  if (!identity) throw new Error("لا يوجد متجر مسجل");
  const result = await resolvePendingFinancialCommand<Result>("product_import");
  if (result) await publish(result, identity.storeId);
}
export async function importCatalogProduct(
  fields: Partial<Product>,
  options: {
    createId: string;
    quantity: number;
    unitCost: number;
    stockContext: ImportStockContext;
    separateIdentifiers?: boolean;
  },
): Promise<{ product: Product; skipped: boolean }> {
  const identity = await getSyncIdentity();
  if (!identity) throw new Error("لا يوجد متجر مسجل");
  const result = await runFinancialCommand<Result & { skipped: boolean }>(
    "product_import",
    {
      product: toRemoteRow("products", {
        ...fields,
        id: options.createId,
        totalQuantity: options.quantity,
      }),
      unitCost: options.unitCost,
      stockContext: options.stockContext,
      separateIdentifiers: options.separateIdentifiers ?? false,
    },
    "product_import",
    identity.storeId,
  );
  if (!result?.product || result.product.store_id !== identity.storeId)
    throw new Error("لم يصل تأكيد صالح لاستيراد المنتج");
  return { product: await publish(result, identity.storeId), skipped: result.skipped === true };
}
