/** Fee principal comes only from positive payable lines, never refund/COD receivables. */
export function courierFeeTotals(
  rows: readonly {
    subject_id: string;
    amount_delta: number | string;
    ledger_events: {
      kind: string;
      ref_id: string | null;
      payload: string | Record<string, unknown>;
    };
  }[],
  orders: readonly {
    id: string;
    orderNumber: string;
    original_order_id?: string | null;
    isExchange?: boolean;
  }[],
) {
  const result: Record<string, { delivery: number; returns: number; exchange: number }> = {};
  const byNumber = new Map(orders.map((o) => [o.orderNumber, o]));
  const exchanged = new Set(orders.filter((o) => o.isExchange).map((o) => o.original_order_id));
  for (const row of rows) {
    const amount = Number(row.amount_delta) / 100;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const e = row.ledger_events;
    if (!["order_delivered", "return_confirmed"].includes(e.kind)) continue;
    const payload = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
    const original = e.ref_id ? byNumber.get(e.ref_id) : undefined;
    const swap =
      payload.movement === "exchange" ||
      (!payload.movement && original && exchanged.has(original.id));
    const type = e.kind === "order_delivered" ? "delivery" : swap ? "exchange" : "returns";
    const totals = (result[row.subject_id] ??= { delivery: 0, returns: 0, exchange: 0 });
    totals[type] += amount;
  }
  return result;
}
