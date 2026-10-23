import { saveCatalogProduct, resolvePendingCatalog } from "./catalogStockCommand";
import { getSyncIdentity } from "@/services/api/storeContext";
import { cloudList } from "@/services/cloudData";
import { captureReadAuthority, assertReadAuthority } from "@/services/operationalSource";
import { useAuthStore } from "@/store/useAuthStore";
import { useBusinessStore } from "@/store/useBusinessStore";
import { cloudErrorMessage } from "./cloudError";
import { importProductId, type ImportPlan } from "./productImportWorkflow";

export type ImportResult = {
  created: number;
  recovered: number;
  units: number;
  failedRow?: number;
  error?: string;
};
export async function executeProductImport(
  plan: ImportPlan,
  progress: (done: number, total: number) => void,
  expectedStoreId?: string,
): Promise<ImportResult> {
  const result: ImportResult = { created: 0, recovered: 0, units: 0 };
  if (plan.errors.length || !plan.rows.length)
    return { ...result, error: "صحّح جميع أخطاء الملف قبل الحفظ." };
  try {
    if (
      !useAuthStore.getState().permissionsVerified ||
      useAuthStore.getState().userRole !== "ADMIN"
    )
      throw { code: "42501" };
    const proof = captureReadAuthority(),
      identity = await getSyncIdentity();
    if (!identity) throw { status: 401 };
    if (expectedStoreId && identity.storeId !== expectedStoreId) throw { code: "STALE_AUTHORITY" };
    await resolvePendingCatalog({ continueAfterRecovery: true });
    // One authoritative tenant-scoped read, before ANY row is written. Never
    // trust the list captured when this component first rendered.
    const existing = await cloudList("products");
    assertReadAuthority(proof);
    const candidates = await Promise.all(
      plan.rows.map(async (row) => ({ row, id: await importProductId(identity.storeId, row) })),
    );
    const byId = new Map(existing.map((p) => [p.id, p]));
    const byCode = new Map<string, string>();
    for (const p of existing)
      for (const code of [p.sku, p.barcode]) if (code) byCode.set(String(code).trim(), p.id);
    for (const { row, id } of candidates) {
      if (
        [row.sku, row.barcode].some((code) => code && byCode.has(code) && byCode.get(code) !== id)
      )
        return {
          ...result,
          failedRow: row.excelRow,
          error: `الصف ${row.excelRow}: باركود / SKU موجود. لم يبدأ الحفظ، ولن يتغير المنتج الموجود.`,
        };
    }
    for (const { row, id } of candidates) {
      result.failedRow = row.excelRow;
      assertReadAuthority(proof);
      if ((await getSyncIdentity())?.storeId !== identity.storeId)
        throw { code: "STALE_AUTHORITY" };
      if (byId.has(id)) {
        const confirmed = byId.get(id);
        // A prior request can commit while its response is lost. Publish the
        // fresh server reader's row too, not just the newly created products.
        useBusinessStore.setState((state) => ({
          products: [...state.products.filter((p) => p.id !== id), confirmed],
        }));
        result.recovered++;
        progress(result.created + result.recovered, candidates.length);
        continue;
      }
      const sku = row.sku || row.barcode || `NX-${id}`;
      await saveCatalogProduct(
        {
          name: row.name,
          sku,
          barcode: row.barcode || sku,
          category: row.category || "عام",
          unitPrice: row.retail_price,
          wholesalePrice: row.wholesale_price,
          minStockLevel: 5,
          maxStockLevel: 1000,
          isActive: true,
          isBundle: false,
          metadata: { variants: row.variants },
        },
        { createId: id, quantity: row.stock_qty, unitCost: row.purchase_price },
      );
      result.created++;
      result.units += row.stock_qty;
      progress(result.created + result.recovered, candidates.length);
      // Keep the main thread responsive between acknowledged commands.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    delete result.failedRow;
  } catch (e) {
    // The shared command retains uncertain request IDs. Retrying this same
    // file resolves that original request before minting any new operation.
    result.error = `${result.failedRow ? `الصف ${result.failedRow}: ` : ""}${cloudErrorMessage(e, "المنتجات")} توقف الاستيراد؛ أعد محاولة نفس الملف للتحقق دون تكرار المخزون.`;
  }
  return result;
}
