/**
 * Stock, derived.
 *
 * There is no `stock_qty` column to read. This hook sums the ledger's stock
 * lines and hands back a product → quantity map. Every screen that shows a
 * stock number uses this, so the POS, the products page and the warehouse
 * screen cannot disagree — they are literally the same SUM.
 *
 * ponytail: re-aggregates on demand rather than subscribing to changes.
 * `bump()` after a write is enough while a POS sale is a deliberate user
 * action. If a screen ever needs live cross-device updates, this is where
 * Supabase Realtime hooks in — nothing above it changes.
 */

import { useCallback, useEffect, useState } from "react";
import { balances } from "./index";
import { averageCost } from "./purchases";

export interface StockView {
  /** productId → quantity on hand. Absent means zero. */
  stock: Map<string, number>;
  /** Quantity for one product, 0 when it has no stock events. */
  qtyOf: (productId: string) => number;
  /**
   * Weighted-average cost per unit, EGP, derived from what was actually paid
   * on receive. This is what a sale snapshots as `unit_cost` — never a
   * `costPrice` field off the product record.
   */
  costOf: (productId: string) => number;
  loading: boolean;
  error: string | null;
  /** Re-read after appending an event. */
  refresh: () => void;
}

export function useStock(): StockView {
  const [stock, setStock] = useState<Map<string, number>>(new Map());
  const [cost, setCost] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const rows = await balances({ account: "stock" });
        if (cancelled) return;
        // Stock lines carry qty AND value, so both numbers come from the same
        // aggregation — the cost can never drift from the quantity it prices.
        setStock(new Map(rows.map((r) => [r.subjectId, r.qty])));
        setCost(new Map(rows.map((r) => [r.subjectId, averageCost(r)])));
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // A stock read that fails must not render as "0 in stock" — that
        // would look like a sold-out shop and let the cashier sell nothing,
        // or worse, look like a successful read of an empty ledger.
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tick]);

  const qtyOf = useCallback((productId: string) => stock.get(productId) ?? 0, [stock]);
  const costOf = useCallback((productId: string) => cost.get(productId) ?? 0, [cost]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  return { stock, qtyOf, costOf, loading, error, refresh };
}
