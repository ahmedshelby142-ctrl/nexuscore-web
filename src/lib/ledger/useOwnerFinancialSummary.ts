/**
 * The Owner's money on Desktop, read through the one reader that checks who
 * is asking.
 *
 * ## What this is NOT
 *
 * It is not a second accounting implementation. Every figure below is the one
 * `owner_financial_summary` returned; nothing is summed, netted or derived
 * here. `grossProfit` and `netProfit` in particular come back already computed
 * in SQL, and the screen must not recompute either — two screens that each
 * subtract their own idea of cost disagree the first time one forgets that
 * `cogs` is already net of returns. This hook is the Desktop twin of
 * `src/mobile/data/useOwnerFinancials.ts`; the interface is kept identical so
 * the two platforms cannot drift into different outcomes for the same owner.
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
 * must never tell.
 *
 * `denied` separates the refusal from a network failure, because they need
 * different words: one is "you are not the owner of this store", the other is
 * "try again".
 *
 * ## One retry in flight, not a stampede
 *
 * A retry button that gets double-clicked must not fire the RPC twice.
 * `reload()` is a no-op while a read for the same window is already running —
 * the answer that read is waiting for IS the answer this retry wants — and two
 * effect runs over the same window share one promise. Only a genuine window
 * change (a different period) issues a second read while the first is in
 * flight, and then the newest run's state is the one that lands.
 *
 * The window is passed in, not derived here, because the caller decides when
 * "now" is re-resolved: a window ending at `now` must NOT be recomputed on
 * every render (the effect keyed on its milliseconds would loop), only on a
 * period change or a deliberate retry. نظرة عامة keeps that in a memo with a
 * retry stamp. This hook deliberately does NOT listen for
 * `ledger-sync-pulled` — a pulled event means the caller should re-resolve
 * its window first, which is the caller's decision, not the reader's.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  readOwnerFinancialSummary,
  type OwnerFinancialSummary,
} from "./ownerFinancials";

export interface OwnerFinancialsView {
  data: OwnerFinancialSummary | null;
  loading: boolean;
  /** Arabic message. Non-null means NO figure may be rendered. */
  error: string | null;
  /** The raw technical message behind `error`, for a debug parenthetical. */
  detail: string | null;
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

const DENIED_MESSAGE = "الشاشة دي لصاحب المحل بس. حسابك مش مسجّل كمدير للمتجر ده.";
const FAILED_MESSAGE = "تعذّر تحميل البيانات المالية. تحقّق من الاتصال وجرّب تاني.";

/**
 * The read currently in flight, keyed by window. Absent when idle — which is
 * also what makes `reload()` a no-op mid-flight.
 */
interface InFlight {
  key: string;
  promise: Promise<OwnerFinancialSummary>;
}

export function useOwnerFinancialSummary(
  window: { from?: Date; to?: Date },
): OwnerFinancialsView {
  const [data, setData] = useState<OwnerFinancialSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [tick, setTick] = useState(0);

  // The window is two Dates, so a new object every render would re-fire the
  // effect forever. Key on the instants instead — the same millisecond is the
  // same window, whatever object carries it.
  const fromKey = window.from ? window.from.getTime() : 0;
  const toKey = window.to ? window.to.getTime() : 0;
  const inFlight = useRef<InFlight | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const key = `${fromKey}:${toKey}`;
    let promise: Promise<OwnerFinancialSummary>;
    const existing = inFlight.current;
    if (existing && existing.key === key) {
      // Same window already being read — attach to it rather than ask again.
      promise = existing.promise;
    } else {
      promise = readOwnerFinancialSummary({
        from: fromKey ? new Date(fromKey) : undefined,
        to: toKey ? new Date(toKey) : undefined,
      });
      inFlight.current = { key, promise };
      // Only the latest read may clear the slot; an orphaned older promise
      // must not mark the hook idle while its replacement is still running.
      //
      // `then(clear, clear)`, not `.finally(clear)`: `finally` returns a NEW
      // promise that re-rejects with the read's error, and nothing handled it —
      // every failed read surfaced as an "Uncaught (in promise)" in the console.
      const clear = () => {
        if (inFlight.current?.promise === promise) inFlight.current = null;
      };
      promise.then(clear, clear);
    }

    void promise.then(
      (summary) => {
        if (cancelled) return;
        setData(summary);
        setError(null);
        setDetail(null);
        setDenied(false);
      },
      (e) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        const refused = isDenial(message);
        setDenied(refused);
        // Never keep stale figures beside a failure: a number from the last
        // successful window, sitting under a new window's heading, is worse
        // than no number at all.
        setData(null);
        setDetail(message);
        setError(refused ? DENIED_MESSAGE : FAILED_MESSAGE);
      },
    ).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [fromKey, toKey, tick]);

  // A retry while the same window is still being read is a no-op: that read's
  // answer is this retry's answer. This is what keeps a double-clicked
  // "إعادة المحاولة" from stampeding the RPC.
  const reload = useCallback(() => {
    if (inFlight.current) return;
    setTick((t) => t + 1);
  }, []);

  return { data, loading, error, detail, denied, reload };
}
