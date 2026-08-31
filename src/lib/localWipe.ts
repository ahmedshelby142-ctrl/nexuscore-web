/**
 * Drop this browser's cached state.
 *
 * This used to be a three-part operation — wipe SQLite or IndexedDB, wipe
 * localStorage, wipe the stored identity — because the device held its own copy
 * of the ledger and its own idea of which store it belonged to. Neither exists
 * any more: the ledger lives in Supabase and tenancy comes from the session, so
 * there is nothing here that is the only copy of anything.
 *
 * What is left is genuinely small: forget the localStorage caches and reload.
 * It is still worth a named function rather than `localStorage.clear()` because
 * a few keys must SURVIVE:
 *
 *   auth-storage-v2        so you stay signed in and the re-read can run
 *   theme-storage          a reset is not a reason to flip to light mode
 *   machine-fingerprint    identifies the hardware, not the data
 *   nexuscore-device-id    names this browser; churning it would make its own
 *                          rows look like another client's to Realtime
 */

/**
 * Zustand `persist` keys holding server-derived data. Everything here is
 * re-fetchable from Supabase; nothing here is authoritative.
 */
const CACHE_KEYS = [
  "business-storage",
  "customer-storage",
  "order-storage",
  "branch-storage",
  "shipping-rates-storage",
  "nexuscore-settings-storage",
  "courier-storage",
  "financial-storage",
  "audit-storage",
  // Written by the old inbound-sync watermark. Harmless, but no longer read.
  "inbound-sync-watermark",
] as const;

export interface WipeReport {
  status: "wiped";
  localStorageKeysRemoved: string[];
}

/**
 * Local changes that have not reached Supabase.
 *
 * Always 0. Every mutation is awaited against Supabase now, so a change either
 * landed or the user was told it did not — there is no queue that could be
 * holding work. Kept because callers still ask before doing something
 * destructive, and the honest answer is "nothing is pending".
 */
export function countUnsent(): number {
  return 0;
}

/** Forget the cached tables and reload. */
export async function wipeLocalData(
  opts: { force?: boolean; reload?: boolean } = {},
): Promise<WipeReport> {
  const { reload = true } = opts;

  // A cached store id would outlive the session it came from and tag new rows
  // with the store that was just left behind.
  const { clearStoreIdCache } = await import("@/services/api/storeContext");
  clearStoreIdCache();

  const localStorageKeysRemoved: string[] = [];
  for (const key of CACHE_KEYS) {
    try {
      if (localStorage.getItem(key) !== null) {
        localStorage.removeItem(key);
        localStorageKeysRemoved.push(key);
      }
    } catch {
      /* blocked storage — nothing cached means nothing to clear */
    }
  }

  // A reload is the honest way to drop the Zustand stores already in memory;
  // clearing their localStorage alone leaves the old arrays live in the running
  // tab, which is exactly the "it still shows 131 products" report.
  if (reload) window.location.reload();

  return { status: "wiped", localStorageKeysRemoved };
}

/**
 * Exposed on `window` so it can be run from devtools without shipping a
 * destructive button into a client's build.
 *
 *   await __nexusWipe()                 → clear caches and reload
 *   await __nexusWipe({ reload: false })  → clear caches, stay on the page
 */
export function registerWipeCommand(): void {
  (window as unknown as Record<string, unknown>).__nexusWipe = (
    opts?: { force?: boolean; reload?: boolean },
  ) => wipeLocalData(opts);
  (window as unknown as Record<string, unknown>).__nexusPending = countUnsent;
}
