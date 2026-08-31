import { useEffect } from 'react';
import { useBusinessStore } from '../store/useBusinessStore';
import { useOrderStore } from '../store/useOrderStore';
import { useFinancialStore } from '../store/useFinancialStore';
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
};

/**
 * Global Real-Time Sync Hook
 * Mount this once in the root App.tsx
 */
export const useRealtimeSync = () => {
  // ── 0. Boot hydration ─────────────────────────────────────────────────────
  // The stores start empty and are filled from Supabase, so what a screen shows
  // is what the database holds. This is the ONE unconditional hydrate.
  useEffect(() => {
    if (!isCloudSyncMode()) return;
    void (async () => {
      const { drainLegacyQueue, hydrateAll } = await import("../services/cloudHydrate");
      // Anything the previous offline-first build left unsent goes out BEFORE
      // we read, or hydration would overwrite it with the server's older copy.
      await drainLegacyQueue().catch(() => 0);
      const { loaded, failed } = await hydrateAll();
      const total = Object.values(loaded).reduce((a, b) => a + b, 0);
      console.info(`[Hydrate] ${total} row(s) from the cloud`, loaded);
      if (Object.keys(failed).length > 0) {
        const { toast } = await import("sonner");
        toast.error("تعذّر تحميل بعض البيانات من السحابة. تحقّق من الاتصال.");
      }
    })();
  }, []);

  useEffect(() => {
    // ── 1. Reconnect ────────────────────────────────────────────────────────
    // Realtime only delivers while the socket is up. Anything changed elsewhere
    // while this tab was offline is caught up by re-reading once, here.
    //
    // There is nothing to flush first: every write was awaited when it was made.
    const handleOnline = () => {
      if (!isCloudSyncMode()) return;
      void import("../services/cloudHydrate")
        .then((m) => m.hydrateAll())
        .catch((e) => console.error('[RealtimeSync] catch-up hydrate failed:', e));
    };

    window.addEventListener('online', handleOnline);

    // ── 2. Supabase Realtime subscription ────────────────────────
    let channelCleanup: (() => void) | undefined;

    if (isCloudSyncMode()) {
      const supabase = getSupabaseClient();
      if (supabase) {

        const channel = supabase
          .channel('global-sync')
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'products' },
            (payload: RealtimePostgresChangesPayload<any>) => handleChange('products', payload),
          )
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'orders' },
            (payload: RealtimePostgresChangesPayload<any>) => handleChange('orders', payload),
          )
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'transactions' },
            (payload: RealtimePostgresChangesPayload<any>) => handleChange('transactions', payload),
          )
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'expenses' },
            (payload: RealtimePostgresChangesPayload<any>) => handleChange('expenses', payload),
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
  }, []);
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
