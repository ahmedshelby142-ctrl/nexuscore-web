import { useSessionReconciliation } from "@/lib/auth/useSessionReconciliation";
import type { SessionReconciliationState } from "@/lib/auth/useSessionReconciliation";
import { useSyncStatus } from "@/store/useSyncStatus";
import { useEffect } from 'react';
import { useBusinessStore } from '../store/useBusinessStore';
import { useOrderStore } from '../store/useOrderStore';
import { useFinancialStore } from '../store/useFinancialStore';
import { useCustomerStore } from '../store/useCustomerStore';
import { useShippingRatesStore } from '../store/useShippingRatesStore';
import { getSupabaseClient, isCloudSyncMode } from '../lib/supabase';
import { getDeviceId } from '../services/api/storeContext';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';

/**
 * Realtime, and the one hydration that is allowed to happen.
 *
 * ## What was removed, and why it was causing rows to vanish
 *
 * `hydrateAll()` starts by EMPTYING every cloud-owned collection and then
 * re-reads them. That is correct exactly once — on boot, where the alternative
 * is showing a stale localStorage cache. It is destructive anywhere else: run
 * it while a write is in flight and the new row is cleared locally and is not
 * yet in the answer coming back, so it disappears from the screen and does not
 * come back until the next reload.
 *
 * So hydration now happens in exactly three places, none of them a mutation:
 * boot (here), login, and the manual refresh button. Mutations update the store
 * from the row Supabase confirmed — see `cloudData.writeThrough`.
 */

/**
 * Table-to-store dispatcher map.
 * Each entry describes how to merge incoming Postgres changes
 * into the corresponding Zustand store using "Last Write Wins"
 * semantics based on `updated_at`.
 */
const TABLE_HANDLERS: Record<string, {
  getAll: () => any[];
  merge: (incoming: any) => void;
  remove: (id: string) => void;
}> = {
  products: {
    getAll: () => useBusinessStore.getState().products,
    merge: (incoming: any) => {
      const existing = useBusinessStore.getState().products.find((p: any) => p.id === incoming.id);
      // Last Write Wins: only apply if incoming is newer
      if (existing && existing.updated_at && incoming.updated_at && existing.updated_at >= incoming.updated_at) {
        return;
      }
      useBusinessStore.setState((state) => {
        const exists = state.products.some((p: any) => p.id === incoming.id);
        return {
          products: exists
            ? state.products.map((p: any) => (p.id === incoming.id ? { ...p, ...incoming } : p))
            : [...state.products, incoming],
        };
      });
    },
    remove: (id: string) => {
      useBusinessStore.setState((state) => ({
        products: state.products.filter((p: any) => p.id !== id),
      }));
    },
  },
  orders: {
    getAll: () => useOrderStore.getState().orders,
    merge: (incoming: any) => {
      const existing = useOrderStore.getState().orders.find((o: any) => o.id === incoming.id);
      if (existing && existing.updatedAt && incoming.updatedAt && new Date(existing.updatedAt).getTime() >= new Date(incoming.updatedAt).getTime()) {
        return;
      }
      useOrderStore.setState((state) => {
        const exists = state.orders.some((o: any) => o.id === incoming.id);
        return {
          orders: exists
            ? state.orders.map((o: any) => (o.id === incoming.id ? { ...o, ...incoming } : o))
            : [incoming, ...state.orders],
        };
      });
    },
    remove: (id: string) => {
      useOrderStore.setState((state) => ({
        orders: state.orders.filter((o: any) => o.id !== id),
      }));
    },
  },
  transactions: {
    getAll: () => useBusinessStore.getState().transactions,
    merge: (incoming: any) => {
      const existing = useBusinessStore.getState().transactions.find((t: any) => t.id === incoming.id);
      if (existing && existing.updated_at && incoming.updated_at && existing.updated_at >= incoming.updated_at) {
        return;
      }
      useBusinessStore.setState((state) => {
        const exists = state.transactions.some((t: any) => t.id === incoming.id);
        return {
          transactions: exists
            ? state.transactions.map((t: any) => (t.id === incoming.id ? { ...t, ...incoming } : t))
            : [...state.transactions, incoming],
        };
      });
    },
    remove: (id: string) => {
      useBusinessStore.setState((state) => ({
        transactions: state.transactions.filter((t: any) => t.id !== id),
      }));
    },
  },
  expenses: {
    getAll: () => useFinancialStore.getState().expenses,
    merge: (incoming: any) => {
      useFinancialStore.setState((state) => {
        const exists = state.expenses.some((e: any) => e.id === incoming.id);
        return {
          expenses: exists
            ? state.expenses.map((e: any) => (e.id === incoming.id ? { ...e, ...incoming } : e))
            : [...state.expenses, incoming],
        };
      });
    },
    remove: (id: string) => {
      useFinancialStore.setState((state) => ({
        expenses: state.expenses.filter((e: any) => e.id !== id),
      }));
    },
  },
  ...reference({
    // ── The reference tables ────────────────────────────────────────────────
    //
    // Sixteen tables are in `supabase_realtime`; five were listened to. The
    // other eleven were published and then ignored, which is the worst of the
    // two states: the write is broadcast to every tab and every tab drops it,
    // so a second device shows yesterday's data with no indication that it is
    // stale and no error to notice. The desktop is a multi-device product —
    // till, office, phone — and «افتح تاني» is not a sync strategy.
    //
    // Each of these is subscribed because a REAL desktop screen reads it and a
    // second device can change it while that screen is open. The four below
    // are deliberately NOT subscribed, and the reasons belong here rather than
    // in a commit message:
    //
    //   ledger_lines  every line arrives with its event, and the
    //                 `ledger_events` INSERT above already pulses the screens
    //                 that read a balance. Subscribing would fire the same
    //                 pulse once per line of every sale.
    //   stores        licence and identity. A change here is re-authentication
    //                 territory — `useSessionReconciliation` owns it, and a
    //                 silent merge into a store would be the app deciding on
    //                 its own that the licence changed.
    //   branches      structural. Created once and then left alone; a screen
    //                 open across a branch being added is not a case worth
    //                 code.
    //   couriers      not in the publication at all. Nothing to subscribe to.
    customers: [useCustomerStore, "customers"],
    suppliers: [useBusinessStore, "suppliers"],
    purchase_invoices: [useBusinessStore, "purchaseInvoices"],
    return_records: [useBusinessStore, "returnRecords"],
    // The local field is `promoDiscounts`; the table is `discount_codes`.
    // Usage counts move under `claimDiscountUse` from any till, so a stale
    // copy is a code that looks spendable and is not.
    discount_codes: [useBusinessStore, "promoDiscounts"],
    wholesale_clients: [useBusinessStore, "wholesaleClients"],
    wholesale_invoices: [useBusinessStore, "wholesaleInvoices"],
    // Priced shipping. An admin editing a governorate's rate while a till has
    // the order form open is the case migration 016 published these for.
    shipping_rates: [useShippingRatesStore, "rows"],
  }),
};

/**
 * One handler per reference table, because they all merge the same way.
 *
 * Eight copies of the products handler with the field name changed is eight
 * chances to get the Last-Write-Wins comparison subtly different, which is
 * exactly what `orders` (camelCase `updatedAt`, parsed as a Date) and
 * `products` (snake_case `updated_at`, compared as strings) already are. The
 * four handlers above are left exactly as they were — they are load-bearing
 * and this is not the change to rewrite them in — but nothing new joins them
 * by hand.
 *
 * `updated_at` is the epoch-ms sync clock every cloud table carries (BIGINT,
 * NOT NULL DEFAULT 0), not the human `updatedAt`. Numbers, so `>=` means what
 * it looks like.
 */
function reference(
  tables: Record<string, [{ getState: () => any; setState: (patch: any) => void }, string]>,
) {
  const handlers: Record<string, { getAll: () => any[]; merge: (row: any) => void; remove: (id: string) => void }> = {};
  for (const [table, [store, field]] of Object.entries(tables)) {
    const rows = (): any[] => store.getState()[field] ?? [];
    handlers[table] = {
      getAll: rows,
      merge: (incoming: any) => {
        const existing = rows().find((r: any) => r.id === incoming.id);
        // Last Write Wins. An echo of a row we already hold a newer copy of is
        // dropped rather than applied — otherwise a slow broadcast overwrites
        // the edit that came after it.
        if (existing && Number(existing.updated_at) >= Number(incoming.updated_at)) return;
        const next = rows();
        store.setState({
          [field]: existing
            ? next.map((r: any) => (r.id === incoming.id ? { ...r, ...incoming } : r))
            : [...next, incoming],
        });
      },
      remove: (id: string) => {
        store.setState({ [field]: rows().filter((r: any) => r.id !== id) });
      },
    };
  }
  return handlers;
}

/**
 * Global Real-Time Sync Hook
 * Mount this once in the root App.tsx
 */
export const useRealtimeSync = (): "checking" | SessionReconciliationState => {
  // Shared with the mobile entry, and now READ rather than discarded.
  //
  // The return value used to be thrown away here, which is how the desktop
  // ended up with two answers to "is this person signed in": the reconciled
  // server session, and `useAuthStore.isAuthenticated` — a boolean in
  // localStorage that `ProtectedRoute` gated on. A stale flag painted a full
  // working app whose every read 401'd. `App` now passes this state to
  // `ProtectedRoute`, so the guard and the reconciliation are the same fact.
  //
  // This hook does not DECIDE anything about auth. It asks, and it reports.
  // The gate is a route element; realtime is a consumer, not an authority.
  const sessionState = useSessionReconciliation();
  const authenticated = sessionState === "authenticated";

  // ── 0. Boot hydration ─────────────────────────────────────────────────────
  // The stores start empty and are filled from Supabase, so what a screen shows
  // is what the database holds. This is the ONE automatic hydrate.
  //
  // Gated on the reconciled session rather than fired unconditionally: every
  // table here is behind `is_store_member(store_id)`, so 14 reads issued before
  // the session is restored come back empty and then CLEAR the stores they
  // filled — the reads succeed, so nothing is reported, and the user is shown
  // an empty shop. Waiting for the verdict costs one render and removes it.
  useEffect(() => {
    if (!isCloudSyncMode()) return;
    if (!authenticated) return;
    void (async () => {
      const { drainLegacyQueue, hydrateAll } = await import("../services/cloudHydrate");
      // Anything the previous offline-first build left unsent goes out BEFORE
      // we read, or hydration would overwrite it with the server's older copy.
      await drainLegacyQueue().catch(() => 0);
      useSyncStatus.getState().markSyncing(true);
      const { loaded, failed } = await hydrateAll();
      // Recorded only on a read that actually returned, so «آخر مزامنة» can
      // never claim a sync that failed. The sidebar reads this.
      useSyncStatus.getState().markSynced();
      const total = Object.values(loaded).reduce((a, b) => a + b, 0);
      console.info(`[Hydrate] ${total} row(s) from the cloud`, loaded);
      if (Object.keys(failed).length > 0) {
        const { toast } = await import("sonner");
        toast.error("تعذّر تحميل بعض البيانات من السحابة. تحقّق من الاتصال.");
      }
    })();
  }, [authenticated]);

  useEffect(() => {
    // ── 1. Reconnect ────────────────────────────────────────────────────────
    // Realtime only delivers while the socket is up. Anything changed elsewhere
    // while this tab was offline is caught up by re-reading once, here.
    //
    // There is nothing to flush first: every write was awaited when it was made.
    const handleOnline = () => {
      if (!isCloudSyncMode()) return;
      useSyncStatus.getState().markSyncing(true);
      void import("../services/cloudHydrate")
        .then((m) => m.hydrateAll())
        .then(() => useSyncStatus.getState().markSynced())
        .catch((e) => {
          useSyncStatus.getState().markSyncing(false);
          console.error('[RealtimeSync] catch-up hydrate failed:', e);
        });
    };

    window.addEventListener('online', handleOnline);

    // ── 2. Supabase Realtime subscription ────────────────────────
    //
    // Also gated on the reconciled session. Realtime applies RLS using the
    // token the socket JOINED with, so a channel opened before the session is
    // restored joins as `anon` and then silently delivers nothing for the rest
    // of its life — no error, no reconnect, just a tab that never updates.
    // Mobile already gates `useMobileRealtime` for this exact reason.
    //
    // This is not realtime deciding who you are. It is realtime waiting to be
    // told.
    let channelCleanup: (() => void) | undefined;

    if (isCloudSyncMode() && authenticated) {
      const supabase = getSupabaseClient();
      if (supabase) {

        // One listener per handler, driven by the map itself. Listing the
        // tables a second time by hand is how `products`/`orders`/
        // `transactions`/`expenses` stayed the whole of realtime while the
        // publication grew to sixteen: a handler that nobody subscribes to
        // looks exactly like a working one from the code.
        const channel = Object.keys(TABLE_HANDLERS)
          .reduce(
            (ch, table) =>
              ch.on(
                'postgres_changes',
                { event: '*', schema: 'public', table },
                (payload: RealtimePostgresChangesPayload<any>) => handleChange(table, payload),
              ),
            supabase.channel('global-sync') as any,
          )
          // Stock and money are SUMs over the ledger, and those sums are read
          // straight from Supabase. So an event landing from another device
          // needs no fetch here — it only needs the screens reading a balance
          // to ask again.
          .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'ledger_events' },
            (payload: RealtimePostgresChangesPayload<any>) => {
              if (isOwnEcho(payload)) return;
              window.dispatchEvent(new CustomEvent('ledger-sync-pulled', {
                detail: { table: 'ledger_events' },
              }));
            },
          )
          .subscribe();

        channelCleanup = () => {
          supabase.removeChannel(channel);
        };
      }
    }

    // ── Cleanup ──────────────────────────────────────────────────
    return () => {
      window.removeEventListener('online', handleOnline);
      channelCleanup?.();
    };
  }, [authenticated]);

  // Handed to `ProtectedRoute` by `App`. One fact, one gate.
  return sessionState;
};

/**
 * Did this browser write the row that just came back?
 *
 * This used to compare a per-tab `_client_id` against `payload.new._client_id`,
 * a field no table has — so the check never matched and every write was echoed
 * straight back into the store it came from. Harmless when the shapes agree;
 * when they do not, the echo overwrites the local object with the server's
 * columns and the edit appears to revert. `device_id` is a real column and is
 * stamped on every row this client writes.
 */
function isOwnEcho(payload: RealtimePostgresChangesPayload<any>): boolean {
  const row = (payload as any).new ?? (payload as any).old;
  return Boolean(row?.device_id) && row.device_id === getDeviceId();
}

/**
 * Central dispatcher for incoming Postgres change events.
 * Routes INSERT / UPDATE / DELETE payloads to the correct
 * Zustand store handler using Last Write Wins logic.
 */
function handleChange(table: string, payload: RealtimePostgresChangesPayload<any>) {
  const handler = TABLE_HANDLERS[table];
  if (!handler) {
    console.warn(`[RealtimeSync] No handler for table "${table}"`);
    return;
  }

  if (isOwnEcho(payload)) return;

  const incoming = (payload as any).new ?? (payload as any).old;
  const eventType = payload.eventType;

  switch (eventType) {
    case 'INSERT':
    case 'UPDATE':
      if (incoming) handler.merge(incoming);
      break;
    case 'DELETE': {
      const deletedId = (payload as any).old?.id;
      if (deletedId) handler.remove(deletedId);
      break;
    }
  }
}
