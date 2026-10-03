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
import { isSyncedTable, CLOUD_SCHEMA } from "./api/cloudSchema";
import { pageAll } from "@/lib/pageAll";

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

  const unfiltered = noTombstone.has(table) || CLOUD_SCHEMA[table]?.keepsArchived === true;
  for (const withTombstone of unfiltered ? [false] : [true, false]) {
    try {
      // Paged: PostgREST answers at most 1000 rows, and a truncated page is
      // indistinguishable from a table that short. See `pageAll`.
      const rows = await pageAll<any>((from, to) => {
        const query = sb.from(table).select("*").range(from, to);
        return withTombstone ? query.is("deleted_at", null) : query;
      });
      return rows.map((row) => fromRemoteRow(table, row));
    } catch (e: any) {
      const message = String(e?.message ?? e);
      if (withTombstone && /deleted_at/.test(message)) {
        console.warn(`[CloudData] [${table}] has no deleted_at column — reading without it.`);
        noTombstone.add(table);
        continue;
      }
      throw new Error(`[${table}] ${message}`);
    }
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
 * What a failed write may tell the user. ONE invariant:
 *
 *   «لم يتم حفظ أي شيء»  ⇒  no business mutation was committed.
 *
 * True for a standalone write (a product edit, a customer, a discount code):
 * that one row IS the whole operation. False for a document written AFTER the
 * ledger accepted the sale/return it belongs to — the money and stock already
 * moved — and false for the stock-mirror cache, which is not a business write.
 */
export const NOTHING_SAVED_MESSAGE = "تعذّر حفظ التعديل على السحابة. لم يتم حفظ أي شيء — حاول مرة أخرى.";
export const AFTER_COMMIT_MESSAGE =
  "العملية نفسها اتسجلت (المخزون والخزنة اتحدّثوا)، لكن تعذّر حفظ المستند المرافق لها على السحابة. متعيدش العملية — بلّغ المسؤول يراجع السجل.";
export const MIRROR_FAILED_MESSAGE =
  "العملية اتسجلت بنجاح. تعذّر بس تحديث رقم المخزون المؤقت على السحابة — الرصيد الصحيح محفوظ في الدفتر، متعيدش العملية.";

export interface WriteContext {
  /**
   * The business operation this row documents is ALREADY committed (its ledger
   * event was accepted). A failure must not claim nothing was saved.
   */
  afterCommit?: boolean;
}

/**
 * Write one row, tell the user if it fails, and hand back what was stored.
 *
 * The single entry point every store mutation uses, so the failure behaviour is
 * identical everywhere instead of being re-invented per store. Rethrows: the
 * caller must not commit anything when this loses.
 */
export async function writeThrough(table: string, row: any, ctx: WriteContext = {}): Promise<any> {
  try {
    return await cloudUpsert(table, row);
  } catch (e) {
    await announce(e, table, ctx);
    throw e;
  }
}

/**
 * Push a CACHE column of an existing row — the `products.quantity` stock
 * mirror. Not a business write: stock is the ledger's SUM, and the ledger event
 * that moved it has already been accepted by the time this runs.
 *
 * An UPDATE of only the columns given, never an upsert. That is what the
 * database grants a cashier: `update_products` admits POS_ECOMMERCE and
 * ECOMMERCE_ONLY, `products_guard_definition_columns` lets them touch only the
 * non-definition columns — while `write_products` (INSERT) admits ADMIN and
 * ACCOUNTANT only, and Postgres checks the INSERT policy on an upsert even when
 * it resolves to an update. Pushing the full row as an upsert was refused with
 * 403 on every cashier sale and announced «لم يتم حفظ أي شيء» after the sale
 * had been saved. Sending only the cache columns also stops a stale till from
 * writing its old copy of a price or a name over an edit made elsewhere.
 *
 * The value is absolute, so sending it twice can never move stock twice. It is
 * not retried, never throws, and never claims nothing was saved: it reports
 * whether it landed and the caller says what is true.
 */
export async function updateMirror(table: string, id: string, patch: Record<string, unknown>): Promise<boolean> {
  const sb = getSupabaseClient();
  // No cloud configured, no cloud copy to keep in step.
  if (!sb) return true;
  try {
    const { error } = await sb.from(table).update(toRemoteRow(table, patch)).eq("id", id);
    if (error) throw new Error(error.message);
    return true;
  } catch (e) {
    console.warn(`[CloudData] stock mirror not updated on ${table}/${id}:`, e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** One truthful, non-financial warning for a mirror push that did not land. */
export async function announceMirrorFailure(): Promise<void> {
  try {
    const { toast } = await import("sonner");
    toast.warning(MIRROR_FAILED_MESSAGE);
  } catch {
    /* toast unavailable in tests */
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

async function announce(e: unknown, table: string, ctx: WriteContext = {}): Promise<void> {
  const detail = e instanceof Error ? e.message : String(e);
  console.error(`[CloudData] write failed on ${table}:`, detail);
  try {
    const { toast } = await import("sonner");
    toast.error(
      ctx.afterCommit
        ? AFTER_COMMIT_MESSAGE
        : e instanceof CloudUnavailable
          ? detail
          : NOTHING_SAVED_MESSAGE,
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
