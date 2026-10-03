import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * A list screen's filters, kept in the URL query string.
 *
 * Held in component state they vanished whenever the list unmounted: filter
 * Orders by «الكل» + a date, open an order, press back — and the screen came
 * back on «تحتاج إجراء» / «كل التواريخ», usually empty, reading as "no
 * orders". In the URL they survive back/forward and refresh.
 *
 * `allowed` lists the accepted values for enumerated keys: the URL is typed by
 * anyone, so an unknown value falls back to the default rather than reaching a
 * query. Defaults are left out of the URL, so a clean list keeps a clean link.
 * Each `update` is ONE replace-navigation, so a multi-key change (a date range)
 * never reads a stale half-written URL, and typing does not flood history.
 */
export function useUrlFilters<T extends Record<string, string>>(
  defaults: T,
  allowed: Partial<Record<keyof T, readonly string[]>> = {},
): [T, (patch: Partial<T>) => void] {
  const [params, setParams] = useSearchParams();

  const values = useMemo(() => {
    const out = { ...defaults };
    for (const key of Object.keys(defaults) as (keyof T & string)[]) {
      const raw = params.get(key);
      if (raw === null) continue;
      const ok = allowed[key];
      if (ok && !ok.includes(raw)) continue;
      out[key] = raw as T[typeof key];
    }
    return out;
    // `defaults`/`allowed` are literals per screen; the URL is the only input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const update = useCallback(
    (patch: Partial<T>) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined || value === "" || value === defaults[key]) next.delete(key);
            else next.set(key, String(value));
          }
          return next;
        },
        { replace: true },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setParams],
  );

  return [values, update];
}
