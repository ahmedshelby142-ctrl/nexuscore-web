/**
 * The Owner's money on a phone, read through the one reader that checks who
 * is asking.
 *
 * ## What this is NOT
 *
 * It is not a second accounting implementation. Every figure below is the one
 * `owner_financial_summary` returned; nothing is summed, netted or derived
 * here. `grossProfit` and `netProfit` in particular come back already computed
 * from the same two subtractions `pnl()` performs in `reports.ts`, and the
 * screen must not recompute either — two screens that each subtract their own
 * idea of cost disagree the first time one forgets that `cogs` is already net
 * of returns.
 *
 * ## Three outcomes, and none of them is zero
 *
 * `loading`  — the read is in flight. The screen shows skeletons.
 * `error`    — the read FAILED, or was refused. The screen says so.
 * `data`     — the ledger answered. A `0` here is a real zero: asked, and
 *              there was nothing.
 *
 * The distinction is the whole point. A failed read rendered as «٠ ج.م.» tells
 * an owner the shop took nothing today, which is the one lie a money screen
 * must never tell. `alertModel` already refuses it for counts; this refuses it
 * for money.
 *
 * `denied` separates the refusal from a network failure, because they need
 * different words: one is "you are not the owner of this store", the other is
 * "try again".
 */

import { useCallback, useEffect, useState } from "react";

import {
  readOwnerFinancialSummary,
  type OwnerFinancialSummary,
} from "@/lib/ledger/ownerFinancials";

export interface OwnerFinancialsView {
  data: OwnerFinancialSummary | null;
  loading: boolean;
  /** Arabic message. Non-null means NO figure may be rendered. */
  error: string | null;
  /** True when Postgres refused the caller (42501), not when the read broke. */
  denied: boolean;
  reload: () => void;
}

/** Postgres' authorization failure, however PostgREST chose to word it. */
function isDenial(message: string): boolean {
  return /42501|permission denied|ADMIN only|not a member of this store|not authenticated/i.test(
    message,
  );
}

export function useOwnerFinancials(window: { from?: Date; to?: Date }): OwnerFinancialsView {
  const [data, setData] = useState<OwnerFinancialSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [tick, setTick] = useState(0);

  // The window is two Dates, so a new object every render would re-fire the
  // effect forever. Key on the instants instead — the same millisecond is the
  // same window, whatever object carries it.
  const fromKey = window.from ? window.from.getTime() : 0;
  const toKey = window.to ? window.to.getTime() : 0;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const summary = await readOwnerFinancialSummary({
          from: fromKey ? new Date(fromKey) : undefined,
          to: toKey ? new Date(toKey) : undefined,
        });
        if (cancelled) return;
        setData(summary);
        setError(null);
        setDenied(false);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        const refused = isDenial(message);
        setDenied(refused);
        // Never keep stale figures beside a failure: a number from the last
        // successful window, sitting under a new window's heading, is worse
        // than no number at all.
        setData(null);
        setError(
          refused
            ? "الشاشة دي لصاحب المحل بس. حسابك مش مسجّل كمدير للمتجر ده."
            : "تعذّر تحميل البيانات المالية. تحقّق من الاتصال وجرّب تاني.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fromKey, toKey, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  return { data, loading, error, denied, reload };
}
