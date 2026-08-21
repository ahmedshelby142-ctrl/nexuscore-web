/**
 * Financial Sync Service
 *
 * Bridges Zustand stores ↔ Supabase backend.
 * Zustand remains the primary source-of-truth for the UI (offline-first).
 * When Supabase is configured, this service syncs financial state to the DB
 * for persistence and cross-device access.
 *
 * Usage:
 *   import { syncAllFinancialState, initFinancialSync } from "@/services/financialSyncService";
 *
 *   // Initialize real-time sync (call once on app boot)
 *   initFinancialSync();
 *
 *   // Manual sync after mutations (call from store actions)
 *   await syncAllFinancialState();
 */

import { isSupabaseConfigured } from "@/lib/supabase";
import { useFinancialStore } from "@/store/useFinancialStore";
import { useCourierStore } from "@/store/useCourierStore";

/** Debounce guard — prevent thundering herd on rapid mutations */
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let lastSyncAt = 0;
const SYNC_DEBOUNCE_MS = 2000;

function canSync(): boolean {
  if (!isSupabaseConfigured()) return false;
  // Debounce: don't sync more than once every SYNC_DEBOUNCE_MS
  if (Date.now() - lastSyncAt < SYNC_DEBOUNCE_MS) return false;
  return true;
}

function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncAllFinancialState().catch(console.error);
  }, SYNC_DEBOUNCE_MS);
}

// ─── Client-side sync caller (uses client-side API fetch) ────────────────────

async function syncToBackend(payload: any) {
  // Use fetch directly since createServerFn uses client-side fetch
  // The endpoint pattern for TanStack Start is /api/<function-name>
  const fns = await import("@/lib/api/financial.server");

  try {
    // @ts-ignore — createServerFn is called with a data param
    const result = await fns.syncFinancialState({ data: payload });
    return result;
  } catch (err) {
    console.warn("[FinancialSync] Backend sync failed:", err);
    return { success: false, synced: false };
  }
}

/**
 * Sync all financial Zustand state to the backend.
 * Call this after any mutation that should persist.
 */
export async function syncAllFinancialState(): Promise<{ synced: boolean; errors?: string[] }> {
  if (!canSync()) {
    return { synced: false };
  }

  lastSyncAt = Date.now();

  const finState = useFinancialStore.getState();
  const courState = useCourierStore.getState();

  const payload = {
    walletTransfers: finState.walletTransfers.map((t) => ({
      fromWallet: t.fromWallet,
      toWallet: t.toWallet,
      amount: t.amount,
      timestamp: t.timestamp instanceof Date ? t.timestamp.toISOString() : String(t.timestamp),
      notes: t.notes,
    })),
    // shareholders: deleted — part-owners are one `Partner` list now.
    stockLogs: finState.stockLogs.map((l) => ({
      productSku: l.productSku,
      productName: l.productName,
      actionType: l.actionType,
      qtyChange: l.qtyChange,
      previousQty: l.previousQty,
      newQty: l.newQty,
      operator: l.operator,
      referenceId: l.referenceId,
      notes: l.notes,
      timestamp: l.timestamp instanceof Date ? l.timestamp.toISOString() : String(l.timestamp),
    })),
    courierReceivables: finState.courierReceivables.map((r) => ({
      orderId: r.orderId,
      courierId: r.courierId,
      courierName: r.courierName,
      orderTotal: r.orderTotal,
      courierFee: r.courierFee,
      amountDue: r.amountDue,
      status: r.status,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      reconciledAt: r.reconciledAt
        ? r.reconciledAt instanceof Date
          ? r.reconciledAt.toISOString()
          : String(r.reconciledAt)
        : undefined,
      targetWallet: r.targetWallet,
    })),
  };

  const result = await syncToBackend(payload);
  return result as { synced: boolean; errors?: string[] };
}

/**
 * Hook: auto-sync when financial store changes.
 * Uses a subscription to the store's state.
 */
export function initFinancialSync(): () => void {
  if (!isSupabaseConfigured()) {
    console.info("[FinancialSync] Supabase not configured — running in offline-only mode");
    return () => {};
  }

  // Subscribe to financial store changes
  const unsubFin = useFinancialStore.subscribe(() => {
    scheduleSync();
  });

  // Subscribe to courier store changes
  const unsubCour = useCourierStore.subscribe(() => {
    scheduleSync();
  });

  // Immediate sync on init
  syncAllFinancialState().catch(console.error);

  return () => {
    unsubFin();
    unsubCour();
    if (syncTimer) clearTimeout(syncTimer);
  };
}

// ─── Individual entity helpers (for targeted syncs) ──────────────────────────

// Wallet balances are deliberately NOT synced. RULES §5: sync sends events,
// never absolute stock or balance values — two devices pushing their own idea
// of a till balance would overwrite each other's takings. The wallet lines
// ride along with the events that created them.
export async function syncWallets(): Promise<void> {
  return;
}

export async function syncStockLogs(): Promise<void> {
  if (!canSync()) return;
  const logs = useFinancialStore.getState().stockLogs;
  const { appendStockLog } = await import("@/lib/api/financial.server");
  // Only sync last 100 to avoid huge payloads
  for (const log of logs.slice(-100)) {
    await appendStockLog({ data: {
      productSku: log.productSku,
      productName: log.productName,
      actionType: log.actionType,
      qtyChange: log.qtyChange,
      previousQty: log.previousQty,
      newQty: log.newQty,
      operator: log.operator,
      referenceId: log.referenceId,
      notes: log.notes,
    } });
  }
}

export async function fetchWalletState(): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const { getWallets } = await import("@/lib/api/financial.server");
  const result = await getWallets({ data: {} });
  if (result.success && result.data?.length) {
    const store = useFinancialStore.getState();
    useFinancialStore.setState((state) => ({
      wallets: state.wallets.map((w) => {
        const remote = result.data?.find((r: any) => r.type === w.type);
        return remote ? { ...w, balance: remote.balance } : w;
      }),
    }));
  }
}
