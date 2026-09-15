/**
 * Any money account, derived.
 *
 * The money twin of `useStock`: hands a screen the `SUM()` over one account's
 * ledger lines, keyed by subject. Supplier debt, courier receivables and
 * customer LTV are all the same query with a different account name — there
 * is no stored `totalDebt` to read, and no screen may keep its own running
 * total.
 *
 * ponytail: re-aggregates on demand, like `useStock`, and for the same
 * reason. `refresh()` after an append is enough while these numbers change
 * only on a deliberate user action.
 */

import { useCallback, useEffect, useState } from "react";
import { balances } from "./index";
import type { Account, EventKind } from "./types";
import { canonicalWallet } from "@/types";

export interface BalancesView {
  /** Signed EGP for one subject. Absent means zero — no events yet. */
  amountOf: (subjectId: string) => number;
  /** Every subject on this account, summed. */
  total: number;
  loading: boolean;
  error: string | null;
  /** Re-read after appending an event. */
  refresh: () => void;
}

/**
 * `kind` narrows the sum to the lines ONE kind of event wrote — the agreed
 * §3.9 answer to "per-courier fees by type" (delivery / return / exchange).
 * Those are not three accounts and must not become a compound subject like
 * `courier:return`: they are the same `payable_courier` account, written by
 * different events, and `BalanceQuery.kind` already expresses exactly that in
 * SQL. Still a SUM over `ledger_lines`, just fewer rows.
 */
export function useBalances(account: Account, kind?: EventKind): BalancesView {
  const [amounts, setAmounts] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const rows = await balances({ account, kind });
        if (cancelled) return;
        // Wallet subjects are folded onto their canonical key before the map is
        // built. The ledger holds two spellings of one till — `instaPay` and
        // `instapay` — from a period when `WALLET_LABELS` disagreed with every
        // writer, and a Map keyed on the raw subject turns one account into two
        // entries of which the screens can only ever see one. Folding on READ
        // fixes the display without rewriting a single append-only line.
        //
        // Only wallets: every other account is keyed by a real id (product,
        // supplier, courier, customer) where case is meaningful and unique.
        const folded = new Map<string, number>();
        for (const row of rows) {
          const key = account === "wallet" ? canonicalWallet(row.subjectId) : row.subjectId;
          folded.set(key, (folded.get(key) ?? 0) + row.amount);
        }
        setAmounts(folded);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // A failed read must not render as "0 owed". That reads as a settled
        // account and would have someone skip a payment they actually owe.
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [account, kind, tick]);

  const amountOf = useCallback((subjectId: string) => amounts.get(subjectId) ?? 0, [amounts]);
  const total = [...amounts.values()].reduce((sum, v) => sum + v, 0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Re-aggregate when the ledger gains events from another device.
  //
  // Without this the event lands in Supabase and the screen
  // keeps showing the number it computed before them — the till would look
  // stale even though the data had already arrived.
  useEffect(() => {
    const onPulled = () => setTick((t) => t + 1);
    window.addEventListener("ledger-sync-pulled", onPulled);
    return () => window.removeEventListener("ledger-sync-pulled", onPulled);
  }, []);

  return { amountOf, total, loading, error, refresh };
}
