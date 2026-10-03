import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * A list screen's filters, kept in the URL query string.
 *
 * Held in component state they vanished whenever the list unmounted: filter
 * Orders by «الكل» + a date, open an order, press back — and the screen came
 * back on «تحتاج إجراء» / «كل التواريخ», usually empty, reading as "no
 * orders". In the URL they survive back/forward and refresh.
 *
 * The URL is typed by anyone, so it is PARSED, once, by `readUrlFilters`:
 * `allowed` lists the accepted values for enumerated keys, and `canonicalize`
 * rejects combinations that are each valid alone but mean nothing together (a
 * custom date range that does not resolve). The result is the only state the
 * screen sees — its labels and its query read the same values — and a URL
 * that differs from it is rewritten to it, so what the address bar says is
 * what the screen shows. Defaults are left out of the URL, so a clean list
 * keeps a clean link. Each `update` is ONE replace-navigation, so a multi-key
 * change (a date range) never reads a stale half-written URL, and typing does
 * not flood history.
 */
export function readUrlFilters<T extends Record<string, string>>(
  params: URLSearchParams,
  defaults: T,
  allowed: Partial<Record<keyof T, readonly string[]>> = {},
  canonicalize: (values: T) => T = (values) => values,
): { values: T; canonicalSearch: string | null } {
  const parsed = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    const raw = params.get(key);
    if (raw === null) continue;
    const ok = allowed[key];
    if (ok && !ok.includes(raw)) continue;
    parsed[key] = raw as T[typeof key];
  }
  const values = canonicalize(parsed);

  const canonical = new URLSearchParams(params);
  for (const key of Object.keys(defaults)) {
    const value = values[key];
    if (value === "" || value === defaults[key]) canonical.delete(key);
    else canonical.set(key, value);
  }
  const canonicalSearch = canonical.toString();
  return {
    values,
    canonicalSearch: canonicalSearch === params.toString() ? null : canonicalSearch,
  };
}

export function useUrlFilters<T extends Record<string, string>>(
  defaults: T,
  allowed: Partial<Record<keyof T, readonly string[]>> = {},
  canonicalize?: (values: T) => T,
): [T, (patch: Partial<T>) => void] {
  const [params, setParams] = useSearchParams();

  const { values, canonicalSearch } = useMemo(
    () => readUrlFilters(params, defaults, allowed, canonicalize),
    // `defaults`/`allowed`/`canonicalize` are fixed per screen; the URL is the only input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params],
  );

  // A hand-edited or stale link is corrected in place (replace, not push), so
  // refresh and back read the same state the screen is showing.
  useEffect(() => {
    if (canonicalSearch === null) return;
    setParams(new URLSearchParams(canonicalSearch), { replace: true });
  }, [canonicalSearch, setParams]);

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
