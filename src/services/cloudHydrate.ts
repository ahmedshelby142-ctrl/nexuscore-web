/**
 * Fill every reference store from Supabase.
 *
 * This replaces `persist` as the way reference data arrives. The stores start
 * EMPTY and are filled from the cloud, so what a screen shows is what the
 * database holds — not what this machine happened to cache last time.
 *
 * The ledger is not here. Stock and money are SUMs over `ledger_events` /
 * `ledger_lines`, and `lib/ledger/driver.ts` reads those from Supabase on
 * demand rather than caching them into a store.
 *
 * ## Call this on boot, on login, and on the refresh button. Nowhere else.
 *
 * `hydrateAll` EMPTIES every collection before it re-reads. Running it after a
 * mutation clears the row that was just written before the answer containing it
 * comes back — the row blinks out and does not return until a reload. That is
 * one of the two ways a product could disappear; `check_online_only.mjs`
 * asserts no store reaches for it.
 */

import { clearStockSnapshot } from "@/lib/ledger/stockSnapshot";
import { cloudList } from "./cloudData";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useCustomerStore } from "@/store/useCustomerStore";
import { useBranchStore } from "@/store/useBranchStore";
import { useOrderStore } from "@/store/useOrderStore";
import { useFinancialStore } from "@/store/useFinancialStore";
import { useSettingsStore } from "@/store/useSettingsStore";
import { useShippingRatesStore } from "@/store/useShippingRatesStore";

type Sink = (rows: any[]) => void;

/** Where each cloud table lands in local state. */
const SINKS: Record<string, Sink> = {
  products: (rows) => useBusinessStore.setState({ products: rows }),
  suppliers: (rows) => useBusinessStore.setState({ suppliers: rows }),
  // The local field is `promoDiscounts`; the table is `discount_codes`.
  discount_codes: (rows) => useBusinessStore.setState({ promoDiscounts: rows }),
  return_records: (rows) => useBusinessStore.setState({ returnRecords: rows }),
  purchase_invoices: (rows) => useBusinessStore.setState({ purchaseInvoices: rows }),
  shipping_rates: (rows) => useShippingRatesStore.setState({ rows, loaded: true }),
  wholesale_clients: (rows) => useBusinessStore.setState({ wholesaleClients: rows }),
  wholesale_invoices: (rows) => useBusinessStore.setState({ wholesaleInvoices: rows }),
  transactions: (rows) => useBusinessStore.setState({ transactions: rows }),
  expenses: (rows) => useFinancialStore.setState({ expenses: rows }),
  customers: (rows) => useCustomerStore.setState({ customers: rows }),
  branches: (rows) => useBranchStore.setState({ branches: rows }),
  orders: (rows) => useOrderStore.setState({ orders: rows }),
};

/**
 * Empty every cloud-owned collection.
 *
 * `partialize` controls what zustand WRITES, not what it reads back, so on the
 * first boot after upgrading, a device still holds the old blob and rehydrates
 * from it — the 131 stale products, one more time. Clearing before the fetch
 * makes the state deterministic: what you see came from the cloud in this
 * session, or you see nothing and an error, which is the online-only contract.
 */
export function clearCloudOwnedState(): void {
  // The ledger aggregation belongs to the store that was signed in. Carrying
  // it across a store switch would price and count another shop's shelf.
  clearStockSnapshot();
  for (const sink of Object.values(SINKS)) sink([]);
}

export interface HydrationResult {
  loaded: Record<string, number>;
  failed: Record<string, string>;
}

/**
 * Re-read everything.
 *
 * One table failing must not stop the others: a screen with five of seven
 * tables is usable, a blank app is not.
 */
export async function hydrateAll(): Promise<HydrationResult> {
  const loaded: Record<string, number> = {};
  const failed: Record<string, string> = {};

  // Discard whatever survived rehydration before asking the server.
  clearCloudOwnedState();

  // Store settings live in `public.stores`, not in a synced table, so they are
  // not one of the SINKS above — but they are just as cloud-owned.
  //
  // `pullSettings` existed and had NO caller, so the settings screen always
  // showed either a stale localStorage copy or the hardcoded default
  // ("محلي"). That is not merely cosmetic: pressing حفظ التغييرات writes the
  // form back, so opening Settings on a fresh browser and saving silently
  // replaced the real store name, phone, address and tax number with defaults
  // and blanks.
  //
  // Not awaited with the rest and never fatal: a settings read that fails must
  // not stop products and orders from loading.
  void useSettingsStore
    .getState()
    .pullSettings()
    .catch((e) => console.error("[Hydrate] store settings failed:", e));

  for (const table of Object.keys(SINKS)) {
    try {
      const rows = await cloudList(table);
      SINKS[table](rows);
      loaded[table] = rows.length;
    } catch (e) {
      failed[table] = e instanceof Error ? e.message : String(e);
      console.error(`[Hydrate] ${table} failed:`, failed[table]);
    }
  }

  return { loaded, failed };
}

/**
 * Send anything the PREVIOUS (offline-first) version left queued.
 *
 * Upgrading changes `partialize` so `syncQueue` is no longer persisted. On a
 * device that had unsent reference-data writes, that would discard them the
 * first time the new build starts — silently, which is exactly the class of
 * failure this whole project has been fixing.
 *
 * So the raw localStorage blob is read once, before the stores hydrate, and
 * anything in it is pushed. Runs at most once: on success the queue is emptied,
 * and on failure it is left alone to retry next boot.
 */
export async function drainLegacyQueue(): Promise<number> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem("business-storage");
  } catch {
    return 0;
  }
  if (!raw) return 0;

  let queue: any[] = [];
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
    queue = parsed?.state?.syncQueue ?? [];
  } catch {
    return 0;
  }
  if (!Array.isArray(queue) || queue.length === 0) return 0;

  const { cloudUpsert, cloudDelete } = await import("./cloudData");
  let sent = 0;
  for (const action of queue) {
    if (!action?.table || !action?.payload) continue;
    try {
      if (action.action === "DELETE") await cloudDelete(action.table, action.payload.id);
      else await cloudUpsert(action.table, action.payload);
      sent++;
    } catch (e) {
      // Leave the rest queued and stop: the next boot retries.
      console.error("[Hydrate] legacy queue drain stopped at", action.table, e);
      return sent;
    }
  }

  try {
    parsed.state.syncQueue = [];
    localStorage.setItem("business-storage", JSON.stringify(parsed));
  } catch {
    /* the writes landed; an un-cleared queue only costs a repeat upsert */
  }
  console.info(`[Hydrate] sent ${sent} row(s) left over from the offline queue`);
  return sent;
}
