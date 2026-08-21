/**
 * DEV ONLY. Back to a freshly-installed app, in one action.
 *
 * The app's state lives in two halves and wiping one alone is worse than
 * wiping neither: the ledger is SQLite (events, the source of truth for every
 * number) while products, customers, orders and settings are persisted stores
 * in localStorage. Clearing only the ledger leaves products whose history
 * vanished; clearing only localStorage leaves events pointing at products that
 * no longer exist. Both, or nothing.
 *
 * Gated twice: `import.meta.env.DEV` keeps the button out of a production
 * bundle, and the Rust command refuses to run under `debug_assertions = false`
 * even if it is somehow invoked.
 */

import { devResetLedger } from "./tauri";

export const DEV_RESET_AVAILABLE = import.meta.env.DEV;

/**
 * Wipes both halves, then reloads. Does not return on success — the reload
 * ends this page. Throws with an Arabic message if the ledger wipe failed, in
 * which case localStorage is left alone so the two halves stay consistent.
 */
export async function resetTestData(): Promise<void> {
  if (!DEV_RESET_AVAILABLE) {
    throw new Error("تصفير بيانات التجربة مش متاح في النسخة النهائية");
  }

  // Ledger first. If it fails, the reference data is still intact and the app
  // is exactly as it was — a half-reset is the one outcome worth avoiding.
  await devResetLedger();

  localStorage.clear();
  location.reload();
}
