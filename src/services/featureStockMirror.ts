import { getSupabaseClient } from "@/lib/supabase";
import { getSyncIdentity } from "@/services/api/storeContext";
import { fromRemoteRow } from "@/services/api/fieldMapping";
import { useBusinessStore } from "@/store/useBusinessStore";
/** New financial commands own their mirrors transactionally. Re-read only. */
export async function refreshFeatureStock(ids: readonly string[]) {
  const sb = getSupabaseClient(),
    identity = await getSyncIdentity();
  if (!sb || !identity || !ids.length) return;
  const { data, error } = await sb
    .from("products")
    .select("*")
    .eq("store_id", identity.storeId)
    .in("id", [...new Set(ids)]);
  if (error)
    throw new Error("تم تسجيل العملية؛ تعذّر تحديث عرض المخزون. حدّث الصفحة قبل عملية جديدة.");
  const saved = new Map((data ?? []).map((row) => [row.id, fromRemoteRow("products", row)]));
  useBusinessStore.setState((state) => ({
    products: state.products.map((p) => saved.get(p.id) ?? p),
  }));
  window.dispatchEvent(new Event("ledger-sync-pulled"));
}
