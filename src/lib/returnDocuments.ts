import { getSupabaseClient } from "@/lib/supabase";
import { getSyncIdentity } from "@/services/api/storeContext";
import { fromRemoteRow } from "@/services/api/fieldMapping";
import { useBusinessStore } from "@/store/useBusinessStore";

/** Optional read after the server has committed the document with its ledger. */
export async function refreshReturnDocuments() {
  try {
    const sb = getSupabaseClient(), identity = await getSyncIdentity();
    if (!sb || !identity) return;
    const { data, error } = await sb.from("return_records").select("*")
      .eq("store_id", identity.storeId).is("deleted_at", null).order("created_at", { ascending: false });
    if (error) throw error;
    if ((await getSyncIdentity())?.storeId !== identity.storeId) return;
    const incoming = (data ?? []).map(row => fromRemoteRow("return_records", row));
    useBusinessStore.setState(state => {
      const rows = new Map(state.returnRecords.map(row => [row.id, row]));
      for (const row of incoming) {
        const old = rows.get(row.id);
        if (!old || Number(old.updated_at ?? 0) <= Number(row.updated_at ?? 0)) rows.set(row.id, row);
      }
      return { returnRecords: [...rows.values()] };
    });
  } catch {
    // A cache read cannot convert success into another financial submission.
    console.warn("تم حفظ مستند المرتجع؛ حدّث الصفحة لإعادة قراءة السجل.");
  }
}
