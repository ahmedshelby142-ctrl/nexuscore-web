import { StockAuditPage } from "@/components/finance/StockAuditPage";

/**
 * الجرد. Wiring only — the screen and its `stock_adjustment` path were built
 * and reviewed at PLAN item #6; it simply had no route and no menu entry, so
 * nobody could open it.
 */
export function StockAudit() {
  return <StockAuditPage />;
}
