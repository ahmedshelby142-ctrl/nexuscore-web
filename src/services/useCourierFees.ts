import { useCallback, useEffect, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase";
import { getActiveStoreId } from "@/services/api/storeContext";
import { pageAll } from "@/lib/pageAll";
import { courierFeeTotals } from "@/lib/courierFees";
import { useOrderStore } from "@/store/useOrderStore";
import type { BalancesView } from "@/lib/ledger/useBalances";

export function useCourierFees() {
  const orders = useOrderStore((s) => s.orders);
  const [tick, setTick] = useState(0);
  const [totals, setTotals] = useState<ReturnType<typeof courierFeeTotals>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const sb = getSupabaseClient(),
          store = await getActiveStoreId();
        if (!sb || !store) throw new Error("لا يوجد اتصال بمتجر مسجل");
        const rows = await pageAll<any>((from, to) =>
          sb
            .from("ledger_lines")
            .select("subject_id,amount_delta,ledger_events!inner(kind,ref_id,payload)")
            .eq("store_id", store)
            .eq("account", "payable_courier")
            .gt("amount_delta", 0)
            .in("ledger_events.kind", ["order_delivered", "return_confirmed"])
            .order("id", { ascending: true })
            .range(from, to),
        );
        if (!cancelled) {
          setTotals(courierFeeTotals(rows, orders));
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick, orders]);
  useEffect(() => {
    window.addEventListener("ledger-sync-pulled", refresh);
    return () => window.removeEventListener("ledger-sync-pulled", refresh);
  }, [refresh]);
  const view = (type: "delivery" | "returns" | "exchange"): BalancesView => ({
    amountOf: (id) => totals[id]?.[type] ?? 0,
    total: Object.values(totals).reduce((n, t) => n + t[type], 0),
    loading,
    error,
    refresh,
  });
  return { delivery: view("delivery"), returns: view("returns"), exchange: view("exchange") };
}
