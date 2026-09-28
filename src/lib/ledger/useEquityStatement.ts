import { useCallback, useEffect, useState } from "react";
import { balances } from "./index";
import { fetchEquity, type EquityStatement } from "./equity";

export interface EquityView {
  /** null while loading or after a failed read — never a statement of zeros. */
  data: EquityStatement | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * The equity statement, read from the ledger. Re-reads on every ledger change
 * (`ledger-sync-pulled`, which realtime and the owner-equity writers dispatch),
 * so a capital, contribution or draw posted anywhere is reflected here.
 */
export function useEquityStatement(): EquityView {
  const [data, setData] = useState<EquityStatement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const statement = await fetchEquity(balances);
        if (cancelled) return;
        setData(statement);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // A failed read drops the old figures: stale equity after a failure
        // would look current.
        setData(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const onPulled = () => setTick((t) => t + 1);
    window.addEventListener("ledger-sync-pulled", onPulled);
    return () => window.removeEventListener("ledger-sync-pulled", onPulled);
  }, []);

  return { data, loading, error, refresh };
}
