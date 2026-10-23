import {
  importCatalogProduct,
  resolvePendingCatalog,
  resolvePendingImport,
  type ImportStockContext,
} from "./catalogStockCommand";
import { getSyncIdentity } from "@/services/api/storeContext";
import { cloudList } from "@/services/cloudData";
import { captureReadAuthority, assertReadAuthority } from "@/services/operationalSource";
import { useAuthStore } from "@/store/useAuthStore";
import { useBusinessStore } from "@/store/useBusinessStore";
import { cloudErrorMessage } from "./cloudError";
import {
  importProductId,
  checkImportDuplicates,
  summarizeImport,
  type ImportPlan,
} from "./productImportWorkflow";

export type ImportResult = {
  created: number;
  recovered: number;
  skipped: number;
  units: number;
  failedRow?: number;
  error?: string;
};
export async function executeProductImport(
  plan: ImportPlan,
  progress: (done: number, total: number) => void,
  expectedStoreId?: string,
  stockContext: ImportStockContext = "catalog",
): Promise<ImportResult> {
  const result: ImportResult = { created: 0, recovered: 0, skipped: 0, units: 0 };
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
    await resolvePendingImport();
    // One authoritative tenant-scoped read, before ANY row is written. Never
    // trust the list captured when this component first rendered.
    const existing = await cloudList("products");
    assertReadAuthority(proof);
    const candidates = await Promise.all(
      plan.rows.map(async (row) => ({ row, id: await importProductId(identity.storeId, row) })),
    );
    const current = checkImportDuplicates(
      plan,
      existing,
      new Map(candidates.map(({ row, id }) => [row.excelRow, id])),
    );
    if (current.errors.length)
      return {
        ...result,
        failedRow: current.errors[0].row,
        error: `الصف ${current.errors[0].row}: ${current.errors[0].message} لم يبدأ الحفظ؛ صحّح الملف كاملًا.`,
      };
    if (summarizeImport(current).units > 0 && stockContext === "catalog")
      return {
        ...result,
        error:
          "اختر نوع المخزون المملوك وأكّد أنه ليس شراءً جديدًا. المشتريات الجديدة تُسجل بفاتورة توريد؛ لم يبدأ الحفظ.",
      };
    const byId = new Map(existing.map((p) => [p.id, p]));
    const ids = new Map(candidates.map((x) => [x.row.excelRow, x.id]));
    for (const row of current.rows) {
      const id = ids.get(row.excelRow)!;
      result.failedRow = row.excelRow;
      assertReadAuthority(proof);
      if ((await getSyncIdentity())?.storeId !== identity.storeId)
        throw { code: "STALE_AUTHORITY" };
      if (row.disposition === "existing" || row.disposition === "recovered") {
        const confirmed = byId.get(row.matchedProductId ?? id);
        // A prior request can commit while its response is lost. Publish the
        // fresh server reader's row too, not just the newly created products.
        useBusinessStore.setState((state) => {
          if (!confirmed) return state;
          const newer = state.products.find((p) => p.id === confirmed.id);
          if (newer && Number(newer.updated_at ?? 0) > Number(confirmed.updated_at ?? 0))
            return state;
          return { products: [...state.products.filter((p) => p.id !== confirmed.id), confirmed] };
        });
        if (row.disposition === "recovered") result.recovered++;
        else result.skipped++;
        progress(result.created + result.recovered + result.skipped, candidates.length);
        continue;
      }
      const sku = row.sku || row.barcode || `NX-${id}`;
      const acknowledged = await importCatalogProduct(
        {
          name: row.name,
          sku,
          barcode: row.barcode || sku,
          category: row.category || "عام",
          unitPrice: row.retail_price,
          wholesalePrice: row.wholesale_price,
          minStockLevel: row.min_stock_level ?? 5,
          maxStockLevel: 1000,
          isActive: true,
          isBundle: false,
          metadata: { variants: row.variants },
        },
        {
          createId: id,
          quantity: row.stock_qty,
          unitCost: row.purchase_price,
          stockContext,
          separateIdentifiers: row.separateIdentifiers,
        },
      );
      if (acknowledged.skipped) result.skipped++;
      else {
        result.created++;
        result.units += row.stock_qty;
      }
      progress(result.created + result.recovered + result.skipped, candidates.length);
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
