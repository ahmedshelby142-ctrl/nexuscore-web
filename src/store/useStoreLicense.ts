/**
 * The store's SaaS licence: fetch it, cache it, and say whether the shop may
 * open today.
 *
 * ## This never touches sync
 *
 * Nothing in this file cancels a subscription, clears storage, or gates a push.
 * The lockout is a ROUTING decision and lives entirely in `LicenseGate`.
 * `useRealtimeSync()` is mounted in `App()` above `<BrowserRouter>`, so it keeps
 * running no matter which route renders — a locked-out shop still uploads the
 * sales it made before expiry. That was the hard requirement, and the structure,
 * not a flag, is what guarantees it.
 *
 * ## Why a query with no `where`
 *
 * `select_store_licenses` is `USING (is_store_member(store_id))`, so Postgres
 * already returns only this user's store. Re-deriving the store id in the client
 * would add a round trip and a second source of truth for the same answer.
 */

import { create } from "zustand";
import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase";
import { runClockCheck } from "@/lib/licenseClockGuard";
import {
  evaluateLicense,
  type LicenseDecision,
  type LicenseRow,
} from "@/lib/license/evaluate";

const CACHE_KEY = "store-license-cache-v1";

interface CachedLicense {
  row: LicenseRow;
  fetchedAt: number;
}

interface StoreLicenseState {
  decision: LicenseDecision | null;
  row: LicenseRow | null;
  /** Where the current verdict came from. `none` = not enforced (see below). */
  source: "server" | "cache" | "none";
  checking: boolean;
  /** True once a verdict exists, so the gate can hold the UI until then. */
  resolved: boolean;

  hydrate: () => void;
  refresh: () => Promise<void>;
}

function readCache(): CachedLicense | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedLicense;
    return parsed?.row?.valid_until ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(row: LicenseRow): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ row, fetchedAt: Date.now() }));
  } catch {
    /* private mode / quota — the next online check covers us */
  }
}

export const useStoreLicense = create<StoreLicenseState>()((set) => ({
  decision: null,
  row: null,
  source: "none",
  checking: false,
  resolved: false,

  /**
   * Show the last known verdict immediately, before the network answers, so a
   * licensed shop never sees a flash of the lockout screen on a slow morning.
   */
  hydrate: () => {
    // No Supabase means no cloud deployment to protect — a purely local build
    // has no licence to check and must not be bricked by its absence.
    if (!isSupabaseConfigured()) {
      set({ source: "none", resolved: true, decision: null });
      return;
    }

    const cached = readCache();
    if (!cached) return;

    const clock = runClockCheck();
    set({
      row: cached.row,
      source: "cache",
      resolved: true,
      decision: evaluateLicense(cached.row, Date.now(), {
        fromCache: true,
        clockRolledBack: clock.state === "rolled_back",
      }),
    });
  },

  /** Ask the server. Called after login, and on reconnect. */
  refresh: async () => {
    if (!isSupabaseConfigured()) {
      set({ source: "none", resolved: true, decision: null });
      return;
    }

    const sb = getSupabaseClient();
    if (!sb) {
      set({ source: "none", resolved: true, decision: null });
      return;
    }

    set({ checking: true });
    try {
      const { data, error } = await sb
        .from("store_licenses")
        .select("license_key, plan_type, valid_until, status")
        .limit(1)
        .maybeSingle();

      if (error) {
        // Could not reach the server, or the table is missing. Fall back to the
        // cached row and judge it against the local clock; if there is no cache
        // the gate reports "unverified" rather than opening. Failing open here
        // would make the whole licence check optional for anyone offline.
        const cached = readCache();
        const clock = runClockCheck();
        set({
          checking: false,
          resolved: true,
          source: cached ? "cache" : "none",
          row: cached?.row ?? null,
          decision: cached
            ? evaluateLicense(cached.row, Date.now(), {
                fromCache: true,
                clockRolledBack: clock.state === "rolled_back",
              })
            : {
                verdict: "unverified",
                daysLeft: null,
                messageAr: "تعذّر التحقق من الترخيص. تأكد من الاتصال بالإنترنت.",
              },
        });
        return;
      }

      const row = (data as LicenseRow | null) ?? null;
      if (row) writeCache(row);

      set({
        checking: false,
        resolved: true,
        source: "server",
        row,
        // A fresh row is judged against the local clock too, but the row itself
        // came from the server this second, so winding the clock back only ever
        // makes an expired licence look MORE expired.
        decision: evaluateLicense(row, Date.now()),
      });
    } catch {
      const cached = readCache();
      set({
        checking: false,
        resolved: true,
        source: cached ? "cache" : "none",
        row: cached?.row ?? null,
        decision: cached
          ? evaluateLicense(cached.row, Date.now(), { fromCache: true })
          : {
              verdict: "unverified",
              daysLeft: null,
              messageAr: "تعذّر التحقق من الترخيص. تأكد من الاتصال بالإنترنت.",
            },
      });
    }
  },
}));
