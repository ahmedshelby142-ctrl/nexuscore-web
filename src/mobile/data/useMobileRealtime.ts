/**
 * Mobile realtime: one socket, many readers.
 *
 * ## Why this is not `useRealtimeSync`
 *
 * Desktop's `hooks/useRealtimeSync.ts` is the canonical realtime layer *for
 * Desktop*, and it is inseparable from Desktop's state model: every handler in
 * its `TABLE_HANDLERS` map merges the incoming row into a Zustand store
 * (`useBusinessStore.products`, `useOrderStore.orders`, …), and its first
 * effect calls `hydrateAll()`.
 *
 * Mobile reads none of those stores. It pages straight from Supabase through
 * `mobileReaders` into per-screen state, and it deliberately never hydrates —
 * see `lib/receiving/suppliers.ts` for what went wrong the last time a mobile
 * screen trusted a store that is permanently `[]` there. So mounting
 * `useRealtimeSync` on mobile would run a destructive boot hydration and then
 * merge rows into collections no mobile screen ever renders: cost, no effect.
 *
 * This file is therefore not a second realtime implementation. It is the same
 * Supabase primitive wired to the other state model, and it deliberately owns
 * **no** merge logic:
 *
 *   socket → "table X changed" → the screen re-runs its OWN canonical reader
 *
 * Nothing here parses a row, computes a total or touches money. A change
 * notification is a cue to re-read, which is the only way a phone and Postgres
 * can disagree about a balance and have Postgres win.
 *
 * ## One channel, however many listeners
 *
 * Screens come and go as routes change, and `StrictMode` mounts every effect
 * twice in development. A channel per listener would mean duplicate
 * subscriptions, duplicate deliveries and a socket left open behind every
 * navigation. So the channel is module-level and reference-counted: the first
 * mount opens it, the last unmount closes it, and every listener in between
 * hears the same `window` event.
 *
 * That `window` CustomEvent is not invented here either — `useRealtimeSync`
 * already announces ledger changes as `ledger-sync-pulled` for exactly this
 * reason: the thing that needs to know is a screen, not a store.
 */

import { useEffect, useRef } from "react";
import { getSupabaseClient, isCloudSyncMode } from "@/lib/supabase";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";

/** The window event every mobile reader listens on. */
export const MOBILE_REALTIME_EVENT = "mobile-realtime";

/**
 * The tables mobile actually reads — and only those.
 *
 * Desktop subscribes to `transactions` and `expenses`; mobile reads neither
 * table, so subscribing to them would be delivery cost for a screen that can
 * never show the row. The money screens read the LEDGER, and `ledger_events`
 * covers them: an event header is inserted for every movement, so one
 * notification per movement arrives without subscribing to `ledger_lines`,
 * which carries several rows per event and is the highest-volume table here.
 *
 * `couriers` is read by Shipments but is absent from the `supabase_realtime`
 * publication, so it cannot be subscribed to without a schema change this task
 * is not allowed to make — and it is a near-static registry, not a queue.
 */
export const MOBILE_REALTIME_TABLES = [
  "orders",
  "products",
  "customers",
  "ledger_events",
] as const;

export type MobileRealtimeTable = (typeof MOBILE_REALTIME_TABLES)[number];

export interface MobileRealtimeDetail {
  table: MobileRealtimeTable;
  /** True when this is the post-reconnect catch-up rather than a live row. */
  catchUp?: boolean;
}

// ── The single shared channel ───────────────────────────────────────────────

let channel: RealtimeChannel | null = null;
let listeners = 0;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

function announce(detail: MobileRealtimeDetail): void {
  window.dispatchEvent(new CustomEvent<MobileRealtimeDetail>(MOBILE_REALTIME_EVENT, { detail }));
}

function openChannel(): void {
  if (channel) return;
  const client = getSupabaseClient();
  if (!client) return;

  // A UNIQUE topic per open, not a fixed "mobile-sync".
  //
  // Leaving and rejoining the same topic in quick succession leaves the server
  // subscribed with the binding ids of the channel that was removed. The client
  // then reports exactly what a healthy socket looks like — one channel, state
  // `joined`, all four bindings present — while every message that arrives is
  // matched against binding ids belonging to the discarded instance and
  // silently dropped.
  //
  // This is not hypothetical. It was caught in runtime testing: a diagnostic
  // channel opened on its own topic received `products UPDATE` from the same
  // socket, at the same moment, while this one delivered nothing and no cue was
  // ever dispatched. A unique topic cannot collide with a subscription that is
  // on its way out, so a fresh open always gets fresh binding ids.
  let next = client.channel(`mobile-sync-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  for (const table of MOBILE_REALTIME_TABLES) {
    next = next.on(
      "postgres_changes",
      { event: "*", schema: "public", table },
      // The payload is NOT applied. RLS decides which rows are delivered at
      // all — a foreign tenant's change never reaches this socket — and the
      // reader that re-runs is scoped by RLS a second time when it asks.
      (_payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => announce({ table }),
    );
  }
  channel = next.subscribe();
}

function closeChannel(): void {
  if (!channel) return;
  const client = getSupabaseClient();
  void client?.removeChannel(channel);
  channel = null;
}

/**
 * Mount ONCE, at the app root, and only once the session is authenticated.
 *
 * ## Why the gate is the whole point
 *
 * Realtime applies RLS using the ACCESS TOKEN the socket joined with. The
 * session is restored asynchronously — `useSessionReconciliation` has to ask
 * Supabase before it knows — so a channel opened at root mount races it and
 * usually joins carrying only the anon key. It then reports a perfectly healthy
 * subscription: `state: "joined"`, every binding present, no error. It simply
 * receives nothing, because `is_store_member(store_id)` is false for a caller
 * with no user.
 *
 * That failure is invisible from the client, and it is the exact shape this
 * was found in: a diagnostic channel opened by hand *after* login received
 * `products UPDATE` and `orders UPDATE` on the same socket, in the same page,
 * while the app's own channel — opened moments earlier — delivered nothing at
 * all. Whether it worked came down to how fast the session was restored, which
 * is why it looked intermittent rather than broken.
 *
 * So the channel is not opened until the caller says the session is real, and
 * it is closed again on sign-out so a stale token never keeps a socket alive.
 *
 * Reference-counted rather than guarded by a boolean so that StrictMode's
 * mount → unmount → mount does not leave the app with a closed channel.
 */
export function useMobileRealtime(authenticated: boolean): void {
  useEffect(() => {
    if (!isCloudSyncMode() || !authenticated) return;

    // A pending close means StrictMode (or a fast remount) is mid-cycle. Cancel
    // it and keep the socket that is already joined rather than churning it.
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    listeners += 1;
    openChannel();

    // Realtime delivers nothing while the socket is down, so whatever changed
    // during the outage has to be asked for. Every mobile screen answers a
    // "table changed" cue by re-running its reader, so the catch-up is the
    // same cue for each table — no hydrateAll, no second code path.
    const onOnline = () => {
      for (const table of MOBILE_REALTIME_TABLES) announce({ table, catchUp: true });
    };
    window.addEventListener("online", onOnline);

    return () => {
      window.removeEventListener("online", onOnline);
      listeners -= 1;
      if (listeners <= 0) {
        listeners = 0;
        // Deferred, because React's StrictMode unmounts and immediately
        // remounts every effect in development. Closing synchronously there
        // tears the socket down and rebuilds it in the same tick, which is
        // precisely the churn `openChannel` documents. The app root is the only
        // caller, so a second of grace costs nothing and a real unmount still
        // closes it.
        closeTimer = setTimeout(() => {
          closeTimer = null;
          if (listeners === 0) closeChannel();
        }, 1000);
      }
    };
  }, [authenticated]);
}

/**
 * Re-run something when one of `tables` changes.
 *
 * The handler is held in a ref so a caller may pass a fresh closure every render
 * without re-subscribing — re-subscribing on every render is how a listener
 * ends up registered more than once.
 */
export function useRealtimeTables(
  tables: readonly MobileRealtimeTable[],
  onChange: (detail: MobileRealtimeDetail) => void,
): void {
  const handler = useRef(onChange);
  handler.current = onChange;

  const key = tables.join(",");
  useEffect(() => {
    const watched = new Set(key.split(",").filter(Boolean));
    if (watched.size === 0) return;
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<MobileRealtimeDetail>).detail;
      if (detail && watched.has(detail.table)) handler.current(detail);
    };
    window.addEventListener(MOBILE_REALTIME_EVENT, listener);
    return () => window.removeEventListener(MOBILE_REALTIME_EVENT, listener);
  }, [key]);
}

/** Test seam: how many roots currently hold the channel open. */
export function __realtimeListenerCount(): number {
  return listeners;
}

/** Test seam: is exactly one channel open? */
export function __realtimeChannelOpen(): boolean {
  return channel !== null;
}
