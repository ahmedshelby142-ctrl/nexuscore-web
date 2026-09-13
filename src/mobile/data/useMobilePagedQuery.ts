import { useCallback, useEffect, useState } from "react";
import type { MobilePage, MobileListQuery } from "./mobileReaders";
import { MOBILE_PAGE_SIZE } from "./mobileReaders";

export function useMobilePagedQuery<T>(
  reader: (query: MobileListQuery) => Promise<MobilePage<T>>,
  query: MobileListQuery,
) {
  const [state, setState] = useState<{ rows: T[]; total: number | null; hasMore: boolean; loading: boolean; loadingMore: boolean; error: string | null }>({ rows: [], total: null, hasMore: false, loading: true, loadingMore: false, error: null });
  const key = JSON.stringify({ ...query, page: undefined, pageSize: undefined });

  const load = useCallback(async (append: boolean) => {
    setState((current) => ({ ...current, loading: !append, loadingMore: append, error: null }));
    try {
      const page = await reader({ ...query, page: append ? Math.floor(state.rows.length / (query.pageSize ?? MOBILE_PAGE_SIZE)) : 0, pageSize: query.pageSize ?? MOBILE_PAGE_SIZE });
      setState((current) => ({ rows: append ? [...current.rows, ...page.rows.filter((next) => !current.rows.some((existing: any) => String(existing.id) === String((next as any).id)))] : page.rows, total: page.total, hasMore: page.hasMore, loading: false, loadingMore: false, error: null }));
    } catch (error) {
      setState((current) => ({ ...current, loading: false, loadingMore: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }, [query, reader, state.rows.length]);

  useEffect(() => { void load(false); }, [key]);

  return { ...state, reload: () => load(false), loadMore: () => state.hasMore && !state.loadingMore ? load(true) : undefined };
}