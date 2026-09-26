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
  // The READER in flight, not a boolean. A second tap on retry for the same
  // record is dropped; a different record (the route param moved) supersedes
  // it. With a boolean, /orders/A → /orders/B while A was loading skipped B's
  // read and then painted A's order under B's URL.
  const inFlight = useRef<(() => Promise<T | null>) | null>(null);

  const run = useCallback(async () => {
    if (inFlight.current === reader) return;
    inFlight.current = reader;
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
      if (inFlight.current === reader) inFlight.current = null;
    }
  }, [reader]);

  useEffect(() => { void run(); }, [run]);

  return { ...state, reload: run };
}
