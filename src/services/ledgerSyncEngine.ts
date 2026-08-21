import { safeInvoke, isDesktop } from "../lib/tauri";
import { getSupabaseClient } from "@/lib/supabase";
import { create } from "zustand";
import { useSettingsStore } from "@/store/useSettingsStore";

const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;

interface SyncState {
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  setOnline: (status: boolean) => void;
  setSyncing: (status: boolean) => void;
  setPendingCount: (count: number) => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  isOnline: navigator.onLine,
  isSyncing: false,
  pendingCount: 0,
  setOnline: (status) => set({ isOnline: status }),
  setSyncing: (status) => set({ isSyncing: status }),
  setPendingCount: (count) => set({ pendingCount: count }),
}));

// We only push events and lines (reference tables like products should also be synced eventually)
const SYNC_TABLES = [
  "products",
  "branches",
  "customers",
  "suppliers",
  "discount_codes",
  "return_records",
  "ledger_events",
  "ledger_lines",
];

export async function checkPendingCount() {
  try {
    const sb = getSupabaseClient();
    if (!sb) return;

    // Get count via Tauri if available
    let identity: any = { store_provisional: true };
    if (isDesktop) {
      identity = await safeInvoke("ledger_identity", {
        candidateStoreId: "dummy",
        candidateDeviceId: "dummy",
      });
    }

    if (identity.store_provisional) {
      useSyncStore.getState().setPendingCount(0); // Sync blocked
      return;
    }

    // A hacky way since pendingCount on driver only counts ledger_events
    // We should ideally count all tables, but let's just query via a direct invoke if we had one
    // We will just use the driver pendingCount for now or let the push function update it
    
  } catch (e) {
    console.error("Failed to check pending count", e);
  }
}

function adaptToSupabase(row: any): any {
  const adapted = { ...row };
  if ('costPrice' in adapted) { adapted.cost_price = adapted.costPrice; delete adapted.costPrice; }
  if ('retailPrice' in adapted) { adapted.retail_price = adapted.retailPrice; delete adapted.retailPrice; }
  if ('wholesalePrice' in adapted) { adapted.wholesale_price = adapted.wholesalePrice; delete adapted.wholesalePrice; }
  if ('categoryId' in adapted) { adapted.category_id = adapted.categoryId; delete adapted.categoryId; }
  // DB has both barcode and sku, but if frontend sends barcode and sku is missing, we can map it or leave it.
  return adapted;
}

function adaptFromSupabase(row: any): any {
  const adapted = { ...row };
  if ('cost_price' in adapted) { adapted.costPrice = adapted.cost_price; delete adapted.cost_price; }
  if ('retail_price' in adapted) { adapted.retailPrice = adapted.retail_price; delete adapted.retail_price; }
  if ('wholesale_price' in adapted) { adapted.wholesalePrice = adapted.wholesale_price; delete adapted.wholesale_price; }
  if ('category_id' in adapted) { adapted.categoryId = adapted.category_id; delete adapted.category_id; }
  return adapted;
}

export async function pushPendingChanges() {
  const sb = getSupabaseClient();
  if (!sb) return;

  let identity: any = { store_provisional: true };
  if (isDesktop) {
    identity = await safeInvoke("ledger_identity", {
      candidateStoreId: "dummy",
      candidateDeviceId: "dummy",
    });
  }

  if (identity && identity.store_provisional && isDesktop) {
    return;
  }

  useSyncStore.getState().setSyncing(true);

  try {
    let db: any = null;
    if (isDesktop) {
      const Database = (await import("@tauri-apps/plugin-sql")).default;
      const dbPath: string | null = await safeInvoke("ledger_db_path");
      if (dbPath) db = await Database.load(`sqlite:${dbPath}`);
    }

    let totalPending = 0;

    for (const table of SYNC_TABLES) {
      let pendingRows: any[] = [];
      if (db) {
        pendingRows = await db.select(
          `SELECT * FROM ${table} WHERE sync_status = 'pending'`
        );
      }

      if (pendingRows.length > 0) {
        // Prepare rows (ensure sync_status is synced before sending, or just let DB default)
        const payload = pendingRows.map(r => {
          const adapted = adaptToSupabase(r);
          return { ...adapted, sync_status: 'synced' };
        });
        
        const { error } = await sb.from(table).upsert(payload, { onConflict: "id" });
        if (!error) {
          // Mark as synced locally
          if (db) {
            const ids = pendingRows.map(r => `'${r.id}'`).join(",");
            await db.execute(`UPDATE ${table} SET sync_status = 'synced' WHERE id IN (${ids})`);
          }
        } else {
          console.error(`Supabase Push Failed [${table}]:`, error);
        }
      }
      totalPending += pendingRows.length;
    }

    useSyncStore.getState().setPendingCount(totalPending === 0 ? 0 : totalPending);

  } catch (err) {
    console.error("Push failed:", err);
  } finally {
    useSyncStore.getState().setSyncing(false);
  }
}

export async function pullRemoteChanges() {
  const sb = getSupabaseClient();
  if (!sb) return;

  let identity: any = { store_provisional: true };
  if (isDesktop) {
    identity = await safeInvoke("ledger_identity", {
      candidateStoreId: "dummy",
      candidateDeviceId: "dummy",
    });
  }

  if (identity && identity.store_provisional && isDesktop) return;

  useSyncStore.getState().setSyncing(true);

  // Pull settings first
  await useSettingsStore.getState().pullSettings();

  try {
    let db: any = null;
    if (isDesktop) {
      const Database = (await import("@tauri-apps/plugin-sql")).default;
      const dbPath: string | null = await safeInvoke("ledger_db_path");
      if (dbPath) db = await Database.load(`sqlite:${dbPath}`);
    }

    for (const table of SYNC_TABLES) {
      // Get last pull time
      // Get last pull time
      const pullKey = `pull:${table}`;
      let lastPull = new Date(0).toISOString();
      if (db) {
        const stateRow = await db.select(`SELECT value FROM app_state WHERE key = $1`, [pullKey]);
        if (stateRow[0]?.value) lastPull = stateRow[0].value;
      }

      const { data, error } = await sb
        .from(table)
        .select("*")
        .eq("store_id", identity.store_id)
        .gt("created_at", lastPull)
        .order("created_at", { ascending: true });

      if (error) {
        console.error(`Failed to pull ${table}:`, error);
        continue;
      }

      if (data && data.length > 0) {
        // Filter out our own echoes
        const newRows = data.filter((r: any) => r.device_id !== identity.device_id);

        for (let row of newRows) {
          row = adaptFromSupabase(row);
          const cols = Object.keys(row).join(", ");
          const placeholders = Object.keys(row).map((_, i) => `$${i + 1}`).join(", ");
          const vals = Object.values(row);
          
          try {
            if (db) {
              await db.execute(
                `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${Object.keys(row).map(k => `${k}=EXCLUDED.${k}`).join(", ")}`,
                vals
              );
            }
          } catch (insertErr) {
            console.error(`SQLite insertion failed for ${table}:`, insertErr);
          }
          
          // Reactivity: Dispatch custom event so the app can refresh Zustand stores
          window.dispatchEvent(new CustomEvent('ledger-sync-pulled', {
             detail: { table, row }
          }));
        }

        const maxCreatedAt = data[data.length - 1].created_at;
        // Update high water mark
        if (db) {
          await db.execute(`INSERT OR REPLACE INTO app_state (key, value) VALUES ($1, $2)`, [pullKey, maxCreatedAt]);
        }
      }
    }
  } catch (err) {
    console.error("Pull failed:", err);
  } finally {
    useSyncStore.getState().setSyncing(false);
  }
}

export async function forceFullSync() {
  try {
    let db: any = null;
    if (isDesktop) {
      const Database = (await import("@tauri-apps/plugin-sql")).default;
      const dbPath: string | null = await safeInvoke("ledger_db_path");
      if (dbPath) db = await Database.load(`sqlite:${dbPath}`);
    }
    
    // 1. Force Local Rows to Pending (The Push Sweep)
    if (db) {
      for (const table of SYNC_TABLES) {
        await db.execute(`UPDATE ${table} SET sync_status = 'pending'`);
      }
    }

    // 2. Blast everything to the cloud
    await pushPendingChanges();
    
    // 3. Reset high-water marks for all tables to 0
    if (db) {
      for (const table of SYNC_TABLES) {
        const pullKey = `pull:${table}`;
        await db.execute(`INSERT OR REPLACE INTO app_state (key, value) VALUES ($1, $2)`, [pullKey, new Date(0).toISOString()]);
      }
    }
    
    // 4. Fetch the merged state back
    await pullRemoteChanges();

    // 5. Force UI reload
    window.dispatchEvent(new CustomEvent('ledger-sync-pulled', {
      detail: { table: "force_sync", row: {} }
    }));
    
  } catch (e) {
    console.error("Force sync reset failed:", e);
  }
}

export function initSyncEngine() {
  window.addEventListener("online", () => {
    useSyncStore.getState().setOnline(true);
    pushPendingChanges().then(pullRemoteChanges).catch(console.error);
  });
  window.addEventListener("offline", () => useSyncStore.getState().setOnline(false));

  // Initial pull and push
  pullRemoteChanges().then(pushPendingChanges);

  // Set up periodic fallback sync (every 5 minutes)
  setInterval(() => {
    if (useSyncStore.getState().isOnline) {
      pushPendingChanges().then(pullRemoteChanges).catch(console.error);
    }
  }, 5 * 60 * 1000);

  // Setup Realtime
  const sb = getSupabaseClient();
  if (sb) {
    for (const table of SYNC_TABLES) {
      sb.channel(`public:${table}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table },
          (payload: any) => {
            // Trigger a pull when we see remote activity
            if (useSyncStore.getState().isOnline) {
              pullRemoteChanges();
            }
          }
        )
        .subscribe();
    }
  }
}
