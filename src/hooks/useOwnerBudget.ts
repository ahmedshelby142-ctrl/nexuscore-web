import { useCallback, useEffect, useState } from "react";
import { readOwnerBudget, saveOwnerBudget, clearOwnerBudget } from "@/lib/ownerBudget";
import type { OwnerBudget } from "@/lib/ledger/ownerDraw";

/** Both surfaces re-read the same setting on focus and while visible. */
export function useOwnerBudget() {
  const [ownerBudget, setBudget] = useState<OwnerBudget | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  useEffect(() => {
    let alive = true;
    void readOwnerBudget()
      .then(
        (data) => {
          if (alive) {
            setBudget(data);
            setError(null);
          }
        },
        (e) => {
          if (alive) {
            setBudget(null);
            setError(String(e.message ?? e));
          }
        },
      )
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tick]);
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) reload();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("owner-budget-changed", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 30000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("owner-budget-changed", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload]);
  return { ownerBudget, loading, error, reload, setOwnerBudget: saveOwnerBudget, clearOwnerBudget };
}
