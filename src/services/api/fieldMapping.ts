/**
 * Local record shape ↔ Supabase columns.
 *
 * Both directions read the same definition (`cloudSchema.ts`), so the desktop
 * and the web client cannot drift into sending different shapes for the same
 * table — which is what let one runtime's writes be accepted while the other's
 * were silently refused.
 *
 * See `cloudSchema.ts` for why this is a column whitelist rather than a
 * camelCase → snake_case converter, and why blanket conversion would break
 * `"companyName"` and every other quoted camelCase column in the schema.
 */

import {
  CLOUD_SCHEMA,
  inverseRename,
  isSyncedTable,
  reportDropped,
} from "./cloudSchema.ts";

export { resetDroppedReport } from "./cloudSchema.ts";

/**
 * Columns the server turned out not to have, learned at runtime.
 *
 * PostgREST rejects a whole upsert when it names one unknown column. The
 * whitelist means this should now be rare, but a project whose migration is a
 * version behind still needs to sync everything else, so the first rejection
 * naming a column records it here and the push retries without it.
 */
const missingColumns = new Map<string, Set<string>>();

export function noteMissingColumn(table: string, column: string): void {
  const set = missingColumns.get(table) ?? new Set<string>();
  set.add(column);
  missingColumns.set(table, set);
}

export function knownMissingColumns(table: string): ReadonlySet<string> {
  return missingColumns.get(table) ?? new Set<string>();
}

export function resetMissingColumns(): void {
  missingColumns.clear();
}

/**
 * The column name out of a PostgREST "schema cache" rejection, if that is what
 * this error is. Matching the message is unavoidable: the code (`PGRST204`) is
 * shared by other shape complaints, and the column name is only in the text.
 */
export function unknownColumnFrom(error: unknown): string | null {
  const message = (error as any)?.message;
  if (typeof message !== "string") return null;
  const hit = /Could not find the '([^']+)' column/.exec(message);
  return hit ? hit[1] : null;
}

/** Same rule as storeContext: these columns are UUIDs or they are rejected. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ToRemoteOptions {
  /** Written onto the row. Without it RLS refuses the write — see storeContext. */
  storeId?: string | null;
  /** `device_id` is NOT NULL on the deployed reference tables. */
  deviceId?: string | null;
  /** Overrides the row's own `updated_at`. Defaults to now. */
  stamp?: number;
}

/**
 * The row as the database should receive it.
 *
 * Keys that are not columns are dropped and reported. That is what strips a
 * nested `supplier` object, a stray `Date`, and every local-only field, without
 * needing a rule per case.
 */
export function toRemoteRow(table: string, row: any, opts: ToRemoteOptions = {}): any {
  if (!row || typeof row !== "object") return row;

  // A table with no definition is passed through rather than emptied: emptying
  // it would turn "we have not described this table yet" into data loss.
  if (!isSyncedTable(table)) return row;

  const schema = CLOUD_SCHEMA[table];
  const allowed = new Set(schema.columns);
  const rename = schema.rename ?? {};
  const localOnly = new Set(schema.localOnly ?? []);
  const absent = knownMissingColumns(table);

  const out: Record<string, unknown> = {};
  const dropped: string[] = [];

  // TWO passes, and the order is load-bearing.
  //
  // A renamed field and its target column can both be present on the same
  // record: every product carries the legacy `quantity: 0` placeholder that
  // `addProduct` sets and nothing maintains, alongside the real `totalQuantity`
  // the stock mirror writes. In one pass the winner is whichever key happens to
  // come later in the object — and when the placeholder wins, the push zeroes
  // the shelf count on the server for every device.
  //
  // So passthrough first, renames second: an explicit mapping always beats a
  // same-named field that merely happens to exist.
  for (const [key, value] of Object.entries(row)) {
    if (localOnly.has(key) || key in rename) continue;
    if (!allowed.has(key)) {
      dropped.push(key);
      continue;
    }
    if (absent.has(key)) continue;
    out[key] = value;
  }

  for (const [key, value] of Object.entries(row)) {
    if (localOnly.has(key) || !(key in rename)) continue;
    const column = rename[key];
    if (!allowed.has(column)) {
      dropped.push(key);
      continue;
    }
    if (absent.has(column)) continue;
    out[column] = value;
  }

  reportDropped(table, dropped);

  // RLS reads this off the row. Never overwritten by a row's own stale value:
  // a record pulled from another store must not be pushed back under this one.
  if (opts.storeId) out.store_id = opts.storeId;

  // `device_id` is NOT NULL on the deployed tables, so a payload without one is
  // refused outright:
  //
  //     null value in column "device_id" of relation "products"
  //         violates not-null constraint
  //
  // An existing value is KEPT rather than overwritten. A row that arrived from
  // another device and is being pushed back should still say which device
  // actually wrote it; stamping ours would erase that and make every row look
  // locally authored.
  if (opts.deviceId && allowed.has("device_id") && !absent.has("device_id")) {
    // `== null` was not enough. A row can carry the STRING "undefined" (from a
    // `String(row.device_id)` coercion elsewhere), and that is truthy and
    // non-null, so it was preserved and sent — producing
    // `22P02 invalid input syntax for type uuid: "undefined"`.
    // Anything that is not a real UUID is replaced, not kept.
    if (!UUID_RE.test(String(out.device_id ?? ""))) out.device_id = opts.deviceId;
  }

  // The pull watermark. A row without it is invisible to every other device's
  // next pull, however successfully it landed.
  if (allowed.has("updated_at") && !absent.has("updated_at")) {
    out.updated_at = opts.stamp ?? Date.now();
  }

  return out;
}

/**
 * The row as the local stores want it.
 *
 * `totalQuantity` is filled from `quantity` — the column IS the shelf count on
 * the server side, so a pull has to put it back where `getActualStock` reads.
 */
export function fromRemoteRow(table: string, row: any): any {
  if (!row || typeof row !== "object") return row;
  if (!isSyncedTable(table)) return row;

  const back = inverseRename(table);
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    out[back[key] ?? key] = value;
  }

  // Keep the remote name alongside the local one where both are read: existing
  // records carry both, and dropping a field on the way IN is how a pull
  // quietly deletes data.
  if (table === "products" && "quantity" in row) out.quantity = row.quantity;

  return out;
}
