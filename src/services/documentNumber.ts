import { getSupabaseClient } from "@/lib/supabase";
import { getActiveStoreId } from "./api/storeContext";

/**
 * The next document number for this store, allocated by Postgres.
 *
 * The client used to compute `"FJ-" + (wholesaleInvoices.length + 1)` — the
 * length of whatever array THIS browser happened to have loaded. Two tills
 * billing at the same moment both reached FJ-0007, and a browser that had not
 * hydrated reached FJ-0001 again. `OrdersPage` avoided the collision by using
 * an entirely different scheme (`FJ-` + the last four digits of `Date.now()`),
 * so the same store issued numbers from two incompatible sequences.
 *
 * `next_document_number` (migration 016) increments a per-store counter row
 * inside a single INSERT … ON CONFLICT DO UPDATE … RETURNING, which holds a
 * row lock for its duration. Concurrent callers are serialised by Postgres and
 * cannot receive the same number. It is SECURITY DEFINER and checks
 * `is_store_member`, so a caller cannot draw numbers for another shop.
 *
 * Throws rather than falling back to a local guess. A number that two invoices
 * might share is worse than a refused invoice — and the unique index on
 * (store_id, "invoiceNumber") would refuse the second one anyway, after the
 * ledger event had already been written.
 */
export async function nextDocumentNumber(counter: string, prefix: string): Promise<string> {
  const sb = getSupabaseClient();
  if (!sb) throw new Error("لا يوجد اتصال بالسحابة — لم يتم إصدار رقم فاتورة");

  const storeId = await getActiveStoreId();
  if (!storeId) throw new Error("لم يتم ربط هذا الجهاز بمتجر بعد");

  const { data, error } = await sb.rpc("next_document_number", {
    p_store: storeId,
    p_name: counter,
    p_prefix: prefix,
  });
  if (error) throw new Error(`[next_document_number] ${error.message}`);
  if (typeof data !== "string" || !data) throw new Error("رقم فاتورة غير صالح من الخادم");
  return data;
}
