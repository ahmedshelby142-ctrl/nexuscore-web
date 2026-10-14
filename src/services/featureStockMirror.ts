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
  // A delayed read from a previous store or an earlier receipt must not
  // replace a newer row already delivered by realtime/current navigation.
  if ((await getSyncIdentity())?.storeId !== identity.storeId) return;
  const saved = new Map((data ?? []).map((row) => [row.id, fromRemoteRow("products", row)]));
  useBusinessStore.setState((state) => ({
    products: state.products.map((p) => {
      const next = saved.get(p.id);
      return next && Number(next.updated_at ?? 0) >= Number(p.updated_at ?? 0) ? next : p;
    }),
  }));
  window.dispatchEvent(new Event("ledger-sync-pulled"));
}

/** Supplier-return document allocations are committed by the stock command. */
export async function refreshFeatureInvoices(ids: readonly string[]) {
  const sb = getSupabaseClient(), identity = await getSyncIdentity();
  if (!sb || !identity || !ids.length) return;
  const { data, error } = await sb.from("purchase_invoices").select("*")
    .eq("store_id", identity.storeId).in("id", [...new Set(ids)]);
  if (error) throw new Error("تم تسجيل المرتجع؛ حدّث الصفحة لإعادة قراءة فواتير المورد.");
  if ((await getSyncIdentity())?.storeId !== identity.storeId) return;
  const saved = new Map((data ?? []).map(row => [row.id, fromRemoteRow("purchase_invoices", row)]));
  useBusinessStore.setState(state => ({ purchaseInvoices: state.purchaseInvoices.map(invoice => {
    const next = saved.get(invoice.id);
    return next && Number(next.updated_at ?? 0) >= Number(invoice.updated_at ?? 0) ? next : invoice;
  }) }));
}
