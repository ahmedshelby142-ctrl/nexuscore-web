import { useCallback, useEffect, useRef, useState } from "react";
import type { MobilePage, MobileListQuery } from "./mobileReaders";
import { MOBILE_PAGE_SIZE } from "./mobileReaders";
import { useRealtimeTables, type MobileRealtimeTable } from "./useMobileRealtime";

/**
 * A paged list, its refresh, and its realtime cue.
 *
 * ## `loading` and `refreshing` are not the same thing
 *
 * `loading` means "there is nothing on screen yet" — the caller draws a
 * skeleton. `refreshing` means "what is on screen is being re-checked", and the
 * caller must keep drawing the rows.
 *
 * They started as one flag, and that is what made the refresh control unusable
 * even once it was wired: re-reading flipped `loading`, the list was replaced
 * by a skeleton, and the operator lost their scroll position and their place in
 * the queue every time they asked whether anything had changed. Realtime makes
 * that worse, not better, because the re-read is no longer something they asked
 * for — a row arriving elsewhere in the shop would have blanked the screen
 * under their thumb.
 *
 * So a refresh swaps the rows in place and never unmounts them.
 *
 * ## `watch` is a cue, not a payload
 *
 * Passing `watch: ["orders"]` re-runs THIS reader when an order changes
 * anywhere in the store. The changed row itself is deliberately not applied:
 * the reader owns the filter, the ordering and the paging, and a row merged
 * past it would appear in a queue it does not belong to, or in the wrong place
 * in one it does.
 */
export function useMobilePagedQuery<T>(
  reader: (query: MobileListQuery) => Promise<MobilePage<T>>,
  query: MobileListQuery,
  options: { watch?: readonly MobileRealtimeTable[] } = {},
) {
  const [state, setState] = useState<{ rows: T[]; total: number | null; hasMore: boolean; loading: boolean; loadingMore: boolean; refreshing: boolean; error: string | null }>({ rows: [], total: null, hasMore: false, loading: true, loadingMore: false, refreshing: false, error: null });
  const key = JSON.stringify({ ...query, page: undefined, pageSize: undefined });

  // The request that is allowed to commit. A refresh that lands after the
  // filter moved on must not repaint the previous filter's rows.
  const generation = useRef(0);
  // One re-read at a time. A held finger on تحديث, or a burst of realtime
  // events from one multi-row write, must not become a burst of queries.
  //
  // Only a REFRESH yields to a read in flight. An initial read is a new
  // question (the search text or the filter changed) and must supersede the
  // old one. It used to be dropped too: typing «ab» while «a» was loading
  // skipped «ab» entirely, then committed «a»'s rows under a box reading «ab».
  // Holds the generation that owns it, so a superseded read cannot release it.
  const inFlight = useRef<number | null>(null);

  const run = useCallback(async (mode: "initial" | "append" | "refresh") => {
    if (mode === "refresh" && inFlight.current !== null) return;
    const mine = ++generation.current;
    if (mode !== "append") inFlight.current = mine;

    setState((current) => ({
      ...current,
      loading: mode === "initial",
      refreshing: mode === "refresh",
      loadingMore: mode === "append",
      error: mode === "initial" ? null : current.error,
    }));

    try {
      const pageSize = query.pageSize ?? MOBILE_PAGE_SIZE;
      const page = await reader({
        ...query,
        page: mode === "append" ? Math.floor(state.rows.length / pageSize) : 0,
        pageSize,
      });
      if (mine !== generation.current) return;
      setState((current) => ({
        rows: mode === "append"
          ? [...current.rows, ...page.rows.filter((next) => !current.rows.some((existing: any) => String(existing.id) === String((next as any).id)))]
          : page.rows,
        total: page.total,
        hasMore: page.hasMore,
        loading: false,
        loadingMore: false,
        refreshing: false,
        error: null,
      }));
    } catch (error) {
      if (mine !== generation.current) return;
      setState((current) => ({ ...current, loading: false, loadingMore: false, refreshing: false, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (inFlight.current === mine) inFlight.current = null;
    }
  }, [query, reader, state.rows.length]);

  useEffect(() => { void run("initial"); }, [key]);

  // A realtime cue refreshes rather than reloads: the rows stay on screen and
  // the operator keeps their place while the list is re-checked underneath.
  const watched = options.watch ?? [];
  useRealtimeTables(watched, () => { void run("refresh"); });

  return {
    ...state,
    /** Re-read in place. Rows and scroll survive; use for تحديث and realtime. */
    refresh: () => run("refresh"),
    /** Re-read from empty, showing a skeleton. Use for error retry. */
    reload: () => run("initial"),
    loadMore: () => state.hasMore && !state.loadingMore ? run("append") : undefined,
  };
}
