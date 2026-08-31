/**
 * Direct cloud CRUD for reference data.
 *
 * The cloud is the truth. Products, customers, suppliers, discounts, return
 * records, branches and orders are not cached in localStorage and are not
 * queued — a mutation goes straight to Supabase, and local state is filled from
 * Supabase on boot.
 *
 * ## The write pattern
 *
 *   1. send the row and AWAIT it,
 *   2. read back what the database actually stored,
 *   3. commit THAT row to the store,
 *   4. on failure, commit nothing and tell the user.
 *
 * ## Why it is no longer "update locally, push in the background"
 *
 * The previous version updated the store first and pushed with `void`. When the
 * push lost — a 403 from RLS, an offline tab, a column the deployed schema does
 * not have — the handler re-read the whole table to "undo" the local change.
 * That is the disappearing-product bug in three lines: the row appeared, the
 * user carried on, and some seconds later a refetch quietly removed it. Worse,
 * the refetch also raced writes that were still perfectly healthy.
 *
 * Waiting for the insert costs a spinner. Not waiting costs rows.
 *
 * ## Why step 2 matters as much as step 1
 *
 * Committing the SERVER's copy rather than the local draft is what keeps the
 * two shapes from drifting. Defaults, triggers and generated columns are
 * applied by Postgres; a store holding the draft would disagree with every
 * other device until the next reload.
 */

import { getSupabaseClient } from "@/lib/supabase";
import { toRemoteRow, fromRemoteRow } from "./api/fieldMapping";
import { getSyncIdentity } from "./api/storeContext";
import { isSyncedTable } from "./api/cloudSchema";

export class CloudUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudUnavailable";
  }
}

/** Tables whose deployed shape has no `deleted_at`, learned at runtime. */
const noTombstone = new Set<string>();

/**
 * Read every row of a table this store can see. RLS does the filtering.
 *
 * The `deleted_at` filter is optional at runtime because the deployed schema
 * and `000_master_schema.sql` have drifted: the script declares `deleted_at` on
 * `orders`, the live table does not have it, and Postgres answers
 *
 *     column orders.deleted_at does not exist
 *
 * with a 400 that would otherwise leave the orders screen permanently empty.
 * Asking once and remembering is better than hard-coding either shape — add the
 * column and the tombstone filter starts working with no code change.
 */
export async function cloudList(table: string): Promise<any[]> {
  const sb = getSupabaseClient();
  if (!sb) throw new CloudUnavailable("لا يوجد اتصال بالسحابة");

  for (const withTombstone of noTombstone.has(table) ? [false] : [true, false]) {
    const query = sb.from(table).select("*");
    const { data, error } = await (withTombstone ? query.is("deleted_at", null) : query);

    if (!error) {
      return (data ?? []).map((row) => fromRemoteRow(table, row));
    }
    if (withTombstone && /deleted_at/.test(error.message)) {
      console.warn(`[CloudData] [${table}] has no deleted_at column — reading without it.`);
      noTombstone.add(table);
      continue;
    }
    throw new Error(`[${table}] ${error.message}`);
  }

  return [];
}

/**
 * Insert or update one row and return what the database stored.
 *
 * Throws rather than queueing. There is no local durability to fall back on,
 * by design — the caller shows the error and commits nothing.
 */
export async function cloudUpsert(table: string, row: any): Promise<any> {
  const sb = getSupabaseClient();
  if (!sb) throw new CloudUnavailable("لا يوجد اتصال بالسحابة");

  const identity = await getSyncIdentity();
  if (!identity) {
    throw new CloudUnavailable("لم يتم ربط هذا الجهاز بمتجر بعد — سجّل الدخول أولاً");
  }

  const payload = toRemoteRow(table, row, {
    storeId: identity.storeId,
    deviceId: identity.deviceId,
    stamp: Date.now(),
  });

  const { data, error } = await sb
    .from(table)
    .upsert(payload, { onConflict: "id" })
    .select()
    .single();

  if (error) throw new Error(`[${table}] ${error.message}`);

  // `data` is null only if the upsert matched nothing and returned nothing,
  // which upsert cannot do. Falling back to the draft keeps a odd deployment
  // from losing the row the user just typed.
  return data ? fromRemoteRow(table, data) : row;
}

export async function cloudDelete(table: string, id: string): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) throw new CloudUnavailable("لا يوجد اتصال بالسحابة");

  const { error } = await sb.from(table).delete().eq("id", id);
  if (error) throw new Error(`[${table}] ${error.message}`);
}

/**
 * Write one row, tell the user if it fails, and hand back what was stored.
 *
 * The single entry point every store mutation uses, so the failure behaviour is
 * identical everywhere instead of being re-invented per store. Rethrows: the
 * caller must not commit anything when this loses.
 */
export async function writeThrough(table: string, row: any): Promise<any> {
  try {
    return await cloudUpsert(table, row);
  } catch (e) {
    await announce(e, table);
    throw e;
  }
}

export async function deleteThrough(table: string, id: string): Promise<void> {
  try {
    await cloudDelete(table, id);
  } catch (e) {
    await announce(e, table);
    throw e;
  }
}

async function announce(e: unknown, table: string): Promise<void> {
  const detail = e instanceof Error ? e.message : String(e);
  console.error(`[CloudData] write failed on ${table}:`, detail);
  try {
    const { toast } = await import("sonner");
    toast.error(
      e instanceof CloudUnavailable
        ? detail
        : "تعذّر حفظ التعديل على السحابة. لم يتم حفظ أي شيء — حاول مرة أخرى.",
    );
  } catch {
    /* toast unavailable in tests */
  }
}

/** The tables hydrated on boot, and where each one lands. */
export const HYDRATION_ORDER = [
  "products",
  "customers",
  "suppliers",
  "discount_codes",
  "return_records",
  "purchase_invoices",
  "branches",
  "orders",
] as const;

export function assertKnownTable(table: string): void {
  if (!isSyncedTable(table)) {
    throw new Error(`[CloudData] ${table} has no schema description`);
  }
}
