import { getSupabaseClient } from "@/lib/supabase";
import { getSyncIdentity } from "@/services/api/storeContext";
import { fromRemoteRow } from "@/services/api/fieldMapping";
import {
  captureReadAuthority,
  assertReadAuthority,
  operationalSource,
} from "@/services/operationalSource";
import { runFinancialCommand } from "./financialCommand";
import { useAuthStore } from "@/store/useAuthStore";
import type { Product } from "@/types";

export type ArchiveStatus = {
  productId: string;
  storeId: string;
  revision: number;
  archived: boolean;
  canArchive: boolean;
  canDelete: boolean;
  hasHistory: boolean;
  pendingOrders: number;
  pendingReplacements: number;
  bundleDependencies: number;
};
export function productSaveError(error: unknown): string {
  const message = error instanceof Error ? error.message : String((error as any)?.message ?? error);
  if (/NEXUS_PRODUCT_HAS_PENDING_COMMITMENTS/.test(message))
    return "لا يمكن أرشفة المنتج: توجد طلبات أو بدائل معلّقة تعتمد عليه. أكملها أو ألغِها أولًا.";
  if (/NEXUS_PRODUCT_USED_IN_ACTIVE_BUNDLE/.test(message))
    return "لا يمكن أرشفة المنتج: يوجد بوكس نشط يستخدمه. راجع تعريف البوكس أولًا.";
  if (/NEXUS_PRODUCT_HISTORY_REQUIRES_ARCHIVE/.test(message))
    return "للمنتج سجل أو ارتباطات محفوظة؛ استخدم الأرشفة بدل المسح النهائي.";
  if (/NEXUS_PRODUCT_RESTORE_CODE_CONFLICT|NEXUS_PRODUCT_IMPORT_CODE_CONFLICT/.test(message))
    return "يوجد تعارض بين SKU والباركود وهوية منتج آخر؛ راجع الأكواد دون تعديل السجل القديم.";
  if (/NEXUS_PRODUCT_STALE|NEXUS_CATALOG_STALE/.test(message))
    return "تغيّرت بيانات المنتج. أعد فتحه من القائمة قبل المحاولة؛ لم نفرض تعديلًا فوق النسخة الأحدث.";
  if (/42501|FORBIDDEN|صلاحية/.test(message))
    return "ليس لديك صلاحية تنفيذ هذا التعديل؛ تحقّق من جلسة مدير المخزون.";
  if (/NEXUS_STORE_NOT_LICENSED/.test(message))
    return "تعذّر تنفيذ التعديل: راجع صلاحية ترخيص المتجر مع المدير.";
  if (/NEXUS_PRODUCT_NOT_FOUND/.test(message))
    return "المنتج غير متاح في المتجر الحالي. حدّث القائمة.";
  if (/NEXUS_PRODUCT_ARCHIVE_COMMAND_REQUIRED|PGRST202|function.*not.*found/i.test(message))
    return "نسخة التطبيق والخادم غير متوافقتين مع إجراء الأرشفة. تواصل مع المدير؛ لم نستخدم حفظًا محليًا بديلًا.";
  if (/تم التأكد من تسجيل العملية السابقة/.test(message))
    return "تم تأكيد المحاولة السابقة. أعد فتح المنتج وراجع حالته قبل طلب تعديل جديد.";
  return "تعذّر تأكيد حالة الحفظ. تحقّق من الاتصال وأعد التحقق من نفس المحاولة؛ لا تفترض أن التعديل لم يُحفظ.";
}
function inventoryRole() {
  const s = useAuthStore.getState();
  if (!s.permissionsVerified || !["ADMIN", "ACCOUNTANT"].includes(s.userRole ?? ""))
    throw new Error("NEXUS_PRODUCT_ARCHIVE_FORBIDDEN");
}
export async function readProductArchiveStatus(productId: string): Promise<ArchiveStatus> {
  inventoryRole();
  const proof = captureReadAuthority(),
    identity = await getSyncIdentity(),
    sb = getSupabaseClient();
  if (!identity || !sb) throw new Error("لا يوجد اتصال بمتجر مسجل");
  const { data, error } = await sb.rpc("read_product_archive_status", {
    p_store: identity.storeId,
    p_product_id: productId,
  });
  if (error) throw error;
  assertReadAuthority(proof);
  if (data?.productId !== productId || data?.storeId !== identity.storeId)
    throw new Error("NEXUS_PRODUCT_NOT_FOUND");
  return data as ArchiveStatus;
}
export async function changeProductArchive(
  product: Product,
  action: "archive" | "restore",
): Promise<Product> {
  inventoryRole();
  const proof = captureReadAuthority(),
    identity = await getSyncIdentity(),
    sb = getSupabaseClient();
  if (!identity || !sb) throw new Error("لا يوجد اتصال بمتجر مسجل");
  const result = await runFinancialCommand<{ product: any }>(
    "product_archive",
    { productId: product.id, action, expectedUpdatedAt: product.updated_at },
    "product_archive:" + product.id,
    identity.storeId,
  );
  assertReadAuthority(proof);
  if (result?.product?.id !== product.id || result.product.store_id !== identity.storeId)
    throw new Error("لم يصل تأكيد صالح لحالة المنتج");
  // A durable replay is an acknowledgement of the original action, not a
  // licence to publish its old snapshot over a subsequent restore/edit.
  const { data, error } = await sb
    .from(operationalSource("products"))
    .select("*")
    .eq("store_id", identity.storeId)
    .eq("id", product.id)
    .single();
  if (error) throw error;
  assertReadAuthority(proof);
  if (!data || Number(data.updated_at) < Number(result.product.updated_at))
    throw new Error("لم يصل تأكيد حديث لحالة المنتج");
  return fromRemoteRow("products", data) as Product;
}
