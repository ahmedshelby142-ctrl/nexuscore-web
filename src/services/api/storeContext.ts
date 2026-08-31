/**
 * Which store is this browser writing for?
 *
 * Every table's RLS policy reads `store_id` off the row
 * (`WITH CHECK (has_role(store_id, …))`), so a payload without it is refused by
 * Postgres. That refusal is a 403, which is why rows used to "save" and never
 * appear anywhere.
 *
 * There is one source of tenancy now: the signed-in Supabase session, resolved
 * through `store_members`. The desktop's SQLite `app_state` and the browser's
 * IndexedDB `meta` copies are gone — they were two answers to one question, and
 * the disagreement between them is what stranded events under a store nobody
 * owned.
 */

import { getSupabaseClient } from "@/lib/supabase";

/**
 * `store_id` and `device_id` are UUID columns. Anything else is rejected by
 * Postgres with `22P02 invalid input syntax for type uuid`, which is how the
 * literal strings "undefined" and "dummy" used to surface — both are truthy, so
 * every `if (deviceId)` guard waved them straight through to the wire.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export interface SyncIdentity {
  storeId: string;
  /** `device_id` is NOT NULL on the deployed reference tables. */
  deviceId: string;
}

const DEVICE_KEY = "nexuscore-device-id";

/**
 * A stable id for this browser.
 *
 * This is NOT a local database coming back. It is one UUID in localStorage so
 * rows stay attributable to the tab that wrote them and Realtime can skip this
 * client's own echoes. Losing it costs nothing: the next visit mints a new one
 * and every row is still owned by the store, which is what RLS reads.
 */
export function getDeviceId(): string {
  let id: string | null = null;
  try {
    id = localStorage.getItem(DEVICE_KEY);
  } catch {
    // Private browsing / blocked storage. Fall through to a per-session id.
  }
  if (isUuid(id)) return id;

  const fresh = crypto.randomUUID();
  try {
    localStorage.setItem(DEVICE_KEY, fresh);
  } catch {
    /* ignore — a per-session device id is still a valid one */
  }
  return fresh;
}

let cached: SyncIdentity | null = null;
let inflight: Promise<SyncIdentity | null> | null = null;

/**
 * The active store id, or null if nobody is signed in.
 *
 * Null is a real answer, not an error: a visitor who has not signed in has no
 * store, and writing rows tagged with an empty one would create records
 * belonging to a store that does not exist. Callers surface the failure — there
 * is no queue to fall back on, by design.
 */
export async function getSyncIdentity(): Promise<SyncIdentity | null> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = resolve()
    .then((identity) => {
      cached = identity;
      return identity;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** Just the store id, for callers that do not need the device. */
export async function getActiveStoreId(): Promise<string | null> {
  return (await getSyncIdentity())?.storeId ?? null;
}

async function resolve(): Promise<SyncIdentity | null> {
  try {
    const sb = getSupabaseClient();
    if (!sb) return null;

    const { data: auth } = await sb.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return null;

    const { data, error } = await sb
      .from("store_members")
      .select("store_id")
      .eq("user_id", uid)
      .limit(1)
      .maybeSingle();

    if (error || !data?.store_id) {
      console.warn("[StoreContext] no store membership for this user");
      return null;
    }
    if (!isUuid(data.store_id)) {
      console.warn(`[StoreContext] store_members returned a non-UUID store id: ${data.store_id}`);
      return null;
    }

    return { storeId: String(data.store_id), deviceId: getDeviceId() };
  } catch (e) {
    console.error("[StoreContext] could not resolve the active store:", e);
    return null;
  }
}

/**
 * Drop the cached id.
 *
 * Called on login and logout — both change which store this browser belongs to,
 * and a stale cache would tag new rows with the previous one.
 */
export function clearStoreIdCache(): void {
  cached = null;
  inflight = null;
}
