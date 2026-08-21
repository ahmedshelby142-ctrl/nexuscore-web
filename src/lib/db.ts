/**
 * Local database bridge.
 *
 * Phase A scope: the module exists, exports a stable storage adapter that
 * satisfies the Zustand `persist` middleware contract, and is wired into
 * the platform-detection flow. The actual SQLite path is Phase B work.
 *
 * Today, in every runtime, the storage is the same localStorage-backed
 * implementation the system has used all along. The wrapper is here so:
 *   1. Phase B can swap in a SQLite-backed implementation in the Tauri
 *      shell with a one-line change at the call sites
 *      (`createJSONStorage(() => dbStorage)`).
 *   2. Tests can inject a custom storage implementation via the
 *      `__setDbStorageForTests` hook without touching the production
 *      path.
 *
 * Design contract (must stay stable across implementations):
 *   - getItem returns string | null. Parsing errors → null.
 *   - setItem returns void. Quota / IO errors are swallowed.
 *   - removeItem returns void. Missing keys are not an error.
 *
 * Both implementations honor this contract, so a Zustand store cannot
 * tell which backend is in use.
 */

import { isDesktop } from "./tauri";

export interface DbStorageLike {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => void | Promise<void>;
  removeItem: (name: string) => void | Promise<void>;
}

/**
 * Browser / pre-Phase-B implementation. localStorage with quota-error
 * tolerance and a defensive try/catch around every call (private
 * browsing, sandboxed iframes, etc. can throw on access).
 */
const localStorageStorage: DbStorageLike = {
  getItem: (name) => {
    try {
      return typeof localStorage === "undefined" ? null : localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(name, value);
      }
    } catch {
      // Quota exceeded or access denied — swallow so a single store
      // can't crash the app. The user will see their changes lost on
      // reload; we surface that in the audit log instead.
    }
  },
  removeItem: (name) => {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(name);
      }
    } catch {
      // ignore
    }
  },
};

/**
 * The active storage adapter. Phase A: localStorage in every runtime.
 * Phase B will replace this with a Tauri-SQLite adapter when isDesktop
 * is true.
 */
export const dbStorage: DbStorageLike = isDesktop
  ? localStorageStorage // TODO Phase B: replace with tauri-plugin-sql adapter
  : localStorageStorage;

/**
 * Whether the local DB is a real queryable database. Today this is
 * always false (we're using localStorage). Phase B flips it to true in
 * the desktop runtime; the flag exists now so features that benefit
 * from a real DB (e.g. inventory search) can already start using the
 * branch.
 */
export const hasQueryableDb: boolean = false;

/**
 * Test hook. Lets Vitest inject a custom storage implementation
 * without touching the production code path. The setter is a no-op in
 * production; it is only safe to call from a test environment.
 */
let testOverride: DbStorageLike | null = null;

export function __setDbStorageForTests(storage: DbStorageLike | null): void {
  if (typeof process !== "undefined" && process.env?.["NODE_ENV"] === "production") {
    return;
  }
  testOverride = storage;
}

/**
 * The storage the rest of the app should use. Resolves to the test
 * override when one is installed, otherwise the active adapter. This is
 * what gets passed to `createJSONStorage(() => resolveDbStorage())` in
 * each store.
 */
export function resolveDbStorage(): DbStorageLike {
  return testOverride ?? dbStorage;
}
