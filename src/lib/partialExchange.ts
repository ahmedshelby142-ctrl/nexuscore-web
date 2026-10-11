// Exchange selections use original sold-line identities, never today's recipe.
export interface ExchangeSelection {
  lineId: string;
  quantity: number;
}
export interface ExchangeDetails {
  id: string;
  originalOrderId: string;
  originalOrderNumber: string;
  status: "pending" | "confirmed" | "cancelled";
  cause: "customer" | "shop" | "courier";
  refundPiastres: number;
  confirmationEventId?: string;
  selections: {
    lineId: string;
    productId: string;
    productName: string;
    variantName?: string;
    quantity: number;
    unitNumbers: number[];
    refundPiastres: number;
  }[];
}
export function exchangeUnits(
  order: any,
  prior: readonly any[] = [],
  replacements: readonly any[] = [],
) {
  const items: any[] = order?.items ?? [];
  const gross = items.reduce((n, i) => n + Number(i.quantity) * Number(i.unitPrice), 0);
  let prefix = 0;
  return items.map((i, index) => {
    const lineId = String(i.id || `line:${index + 1}`),
      productId = String(i.bundleId || i.productId),
      quantity = Number(i.quantity);
    const lineGross = quantity * Number(i.unitPrice),
      total = Number(order.totalAmount);
    const net = gross
      ? Math.round(((prefix + lineGross) * total * 100) / gross) -
        Math.round((prefix * total * 100) / gross)
      : 0;
    prefix += lineGross;
    const claimed = new Set<number>();
    const legacy = prior
      .filter(
        (r) => r.original_order_id === order.id && !String(r.id ?? "").startsWith("exchange:"),
      )
      .flatMap((r) => r.returned_items ?? [])
      .filter((r) =>
        r.lineId
          ? r.lineId === lineId
          : r.product_id === productId && (r.variantName ?? "") === (i.variantName ?? ""),
      )
      .reduce((n, r) => n + Number(r.quantity), 0);
    for (let n = 1; n <= legacy; n++) claimed.add(n);
    for (const replacement of replacements) {
      const details: ExchangeDetails | undefined = replacement.exchangeDetails;
      if (
        !details ||
        details.originalOrderId !== order.id ||
        details.status === "cancelled" ||
        (replacement.status === "cancelled" && details.status !== "confirmed")
      )
        continue;
      for (const s of details.selections ?? [])
        if (s.lineId === lineId) for (const n of s.unitNumbers ?? []) claimed.add(n);
    }
    const available = Array.from(
      { length: Math.max(0, Math.floor(quantity)) },
      (_, n) => n + 1,
    ).filter((n) => !claimed.has(n));
    return {
      lineId,
      productId,
      productName: String(i.productName ?? ""),
      variantName: i.variantName,
      quantity,
      unitPrice: Number(i.unitPrice),
      remaining: available.length,
      refundFor: (qty: number) =>
        available
          .slice(0, qty)
          .reduce(
            (sum, n) =>
              sum + Math.round((n * net) / quantity) - Math.round(((n - 1) * net) / quantity),
            0,
          ) / 100,
    };
  });
}
export function exchangeRefund(
  order: any,
  selections: readonly ExchangeSelection[],
  prior: readonly any[] = [],
  replacements: readonly any[] = [],
) {
  const units = exchangeUnits(order, prior, replacements);
  return (
    selections.reduce(
      (sum, s) =>
        sum +
        Math.round((units.find((u) => u.lineId === s.lineId)?.refundFor(s.quantity) ?? 0) * 100),
      0,
    ) / 100
  );
}
