import { useEffect } from 'react';
import { useBusinessStore } from '../store/useBusinessStore';
import { useOrderStore } from '../store/useOrderStore';
import { useFinancialStore } from '../store/useFinancialStore';
import { getSupabaseClient, isCloudSyncMode } from '../lib/supabase';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';

/**
 * Unique client fingerprint — used to skip echoed changes that
 * this very browser tab just pushed to Supabase.
 */
const LOCAL_CLIENT_ID = crypto.randomUUID();

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
 *
 * Responsibilities:
 *   1. Flush offline syncQueues when the browser comes back online
 *   2. Subscribe to Supabase Realtime channels and dispatch
 *      incoming changes into local Zustand stores (Last Write Wins)
 */
export const useRealtimeSync = () => {
  useEffect(() => {
    // ── 1. Network listener — flush offline queues on reconnect ──
    const handleOnline = async () => {

      try {
        await Promise.all([
          useBusinessStore.getState().flushSyncQueue?.(),
          useOrderStore.getState().flushSyncQueue?.(),
          useFinancialStore.getState().flushSyncQueue?.(),
        ]);
      } catch (error) {
        console.error('[RealtimeSync] Failed to flush queues on reconnect:', error);
      }
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
          .subscribe((status) => {
          });

        channelCleanup = () => {
          supabase.removeChannel(channel);
        };
      }
    } else {
    }

    // ── Ledger Sync Pull Listener ────────────────────────────────
    const handleLedgerSyncPulled = (e: any) => {
      const { table, row } = e.detail;
      handleChange(table, { eventType: 'INSERT', new: row } as any);
    };
    window.addEventListener('ledger-sync-pulled', handleLedgerSyncPulled);

    // ── Cleanup ──────────────────────────────────────────────────
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('ledger-sync-pulled', handleLedgerSyncPulled);
      channelCleanup?.();
    };
  }, []);
};

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

  // Skip echoed changes that originated from this client
  const incoming = (payload as any).new ?? (payload as any).old;
  if (incoming?._client_id === LOCAL_CLIENT_ID) {
    return;
  }

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
