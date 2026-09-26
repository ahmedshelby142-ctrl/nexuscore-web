/**
 * When the cloud was last read, and whether a read is in flight.
 *
 * ## Why this is three fields and not four
 *
 * PLAN item «Sidebar status = real (online/offline + pending count +
 * last-sync + "sync now" button)» was written for the offline-first build,
 * where writes queued locally and a count of unsent ones was a real number.
 * That queue is gone: every write awaits the server before the store is
 * updated, and `useRealtimeSync` says so in as many words — "There is nothing
 * to flush first: every write was awaited when it was made." `drainLegacyQueue`
 * survives only to push what the OLD build left behind on an upgraded device.
 *
 * So a "pending count" would be a hardcoded zero wearing a badge. This file
 * refuses to publish one, for the same reason `alertModel` refuses to render a
 * missing count as `0`: a number nobody can source is worse than no number.
 * The other three are real and live here — alongside the per-table status
 * below, which is how a list screen tells "empty" from "not loaded" from
 * "failed" (P1-D).
 */

import { create } from "zustand";

/**
 * Where one cloud table stands in THIS session.
 *
 * A screen listing products cannot tell, from `products: []` alone, whether the
 * shop has no products, whether they are still on their way, or whether the
 * read failed — and it used to answer all three with «لا توجد منتجات». An
 * absent key means the table has not been asked for yet, which is "loading":
 * the boot hydrate is waiting on the session, not finished with nothing.
 */
export type TableStatus = "loading" | "ready" | "failed";

interface SyncStatusState {
  /** Epoch ms of the last successful cloud read, or null if none yet. */
  lastSyncAt: number | null;
  /** True while a hydration is in flight, so the button can say so. */
  syncing: boolean;
  /** Per cloud table, this session. Absent = not asked for yet = loading. */
  tables: Record<string, TableStatus>;
  /** Why a `failed` table failed. Cleared when it next loads. */
  tableErrors: Record<string, string>;
  markSyncing: (syncing: boolean) => void;
  markSynced: (at?: number) => void;
  markTable: (table: string, status: TableStatus, error?: string) => void;
}

export const useSyncStatus = create<SyncStatusState>()((set) => ({
  lastSyncAt: null,
  syncing: false,
  tables: {},
  tableErrors: {},
  markSyncing: (syncing) => set({ syncing }),
  markTable: (table, status, error) =>
    set((s) => {
      const tableErrors = { ...s.tableErrors };
      if (status === "failed") tableErrors[table] = error ?? "unknown error";
      else delete tableErrors[table];
      return { tables: { ...s.tables, [table]: status }, tableErrors };
    }),
  // Deliberately NOT persisted: a "last synced" time restored from
  // localStorage would claim a read that never happened this session.
  markSynced: (at = Date.now()) => set({ lastSyncAt: at, syncing: false }),
}));

/** «منذ ٣ دقائق» — how long ago, in Arabic, or null when nothing has synced. */
export function lastSyncLabel(lastSyncAt: number | null, now = Date.now()): string | null {
  if (!lastSyncAt) return null;
  const seconds = Math.max(0, Math.round((now - lastSyncAt) / 1000));
  if (seconds < 60) return "المزامنة الآن";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `آخر مزامنة منذ ${minutes} دقيقة`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `آخر مزامنة منذ ${hours} ساعة`;
  return `آخر مزامنة منذ ${Math.round(hours / 24)} يوم`;
}
