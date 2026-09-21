import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One record, and the ability to ask for it again.
 *
 * ## What was missing
 *
 * This hook had no `reload`, so the three detail screens built on it —
 * تفاصيل الطلب, تفاصيل المنتج, تفاصيل العميل — rendered `<ErrorState />` with
 * no `onRetry`. A failed read was terminal: the screen said "تعذّر تحميل" and
 * the only way out was to navigate away and back, on a phone, with the
 * connection possibly already restored.
 *
 * `reload` re-runs the SAME reader the screen already passed in. There is no
 * second fetch path and no cache to invalidate — the retry is the original
 * read, asked again.
 *
 * ## Why the guards
 *
 * `inFlight` collapses a tapped-twice retry into one request. `generation`
 * makes a late answer for a superseded read unable to repaint — which matters
 * here because the reader identity changes with the route param, so a retry
 * fired just before navigating must not overwrite the next record's screen.
 */
export function useMobileEntity<T>(reader: () => Promise<T | null>) {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({
    data: null,
    loading: true,
    error: null,
  });

  const generation = useRef(0);
  const inFlight = useRef(false);

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const mine = ++generation.current;
    setState({ data: null, loading: true, error: null });
    try {
      const data = await reader();
      if (mine === generation.current) setState({ data, loading: false, error: null });
    } catch (error) {
      if (mine === generation.current) {
        setState({
          data: null,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      inFlight.current = false;
    }
  }, [reader]);

  useEffect(() => { void run(); }, [run]);

  return { ...state, reload: run };
}
