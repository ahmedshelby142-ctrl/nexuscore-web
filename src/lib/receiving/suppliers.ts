/**
 * Reading suppliers from the server, for screens that do not hydrate.
 *
 * ## Why this exists
 *
 * Every receipt screen used to resolve its supplier out of
 * `useBusinessStore.suppliers`, which is filled by `hydrateAll`. Desktop calls
 * that on boot; **mobile deliberately never does** — it pages everything from
 * the server instead. So on mobile the array was permanently `[]`: the picker
 * showed no suppliers, every existing supplier looked missing, and the operator
 * had no option but "register a new one". Each mobile receipt therefore minted
 * a duplicate supplier, splintering that supplier's `payable_supplier` across
 * however many copies had accumulated.
 *
 * These readers go to Supabase directly. RLS scopes them to the caller's store,
 * exactly as it does for every other read — there is no client-side store
 * filter here to get wrong, and no `hydrateAll` pulled in to fix a picker.
 */

import { getSupabaseClient } from "@/lib/supabase";
import { fromRemoteRow } from "@/services/api/fieldMapping";

export interface SupplierOption {
  id: string;
  companyName: string;
  phone?: string;
  contactPerson?: string;
}

function clientOrThrow() {
  const client = getSupabaseClient();
  if (!client) throw new Error("لا يوجد اتصال بالسحابة");
  return client;
}

/** Strip the characters PostgREST's `or=` filter treats as syntax. */
function escapeLike(value: string): string {
  return value.replace(/[%,()]/g, " ").trim();
}

/**
 * Suppliers for a picker, newest-updated first, optionally filtered.
 *
 * Paged rather than "all of them": a shop with hundreds of suppliers should not
 * ship the whole table to a phone to fill a dropdown.
 */
export async function readSuppliers(
  options: { search?: string; limit?: number } = {},
): Promise<SupplierOption[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const search = escapeLike(options.search ?? "");

  let query = clientOrThrow()
    .from("suppliers")
    .select("*")
    .is("deleted_at", null)
    .order("companyName", { ascending: true })
    .limit(limit);

  if (search) {
    query = query.or(`companyName.ilike.%${search}%,phone.ilike.%${search}%`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`[suppliers] ${error.message}`);
  return (data ?? []).map((row: any) => fromRemoteRow("suppliers", row) as SupplierOption);
}

/**
 * One supplier by id, or `null`.
 *
 * Used to verify the selection at commit time against the database rather than
 * against whatever the caller's local list happened to contain.
 */
export async function readSupplierById(id: string): Promise<SupplierOption | null> {
  if (!id) return null;
  const { data, error } = await clientOrThrow()
    .from("suppliers")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`[suppliers] ${error.message}`);
  return data ? (fromRemoteRow("suppliers", data) as SupplierOption) : null;
}
