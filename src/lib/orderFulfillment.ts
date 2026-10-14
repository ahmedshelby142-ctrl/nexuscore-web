/** Cost-free forward reservation projection. Legacy rows keep their old rules. */
export interface FulfillmentDemand {
  id: string;
  productId: string;
  productName?: string;
  variantName?: string;
  bundleId?: string;
  quantity: number;
  allocated: number;
  missing: number;
}
export interface OrderFulfillment {
  version: 1;
  allowBackorder: true;
  /** Omitted only on an unsubmitted confirmation; server resolves the recipe. */
  demands?: FulfillmentDemand[];
}
export function fulfillmentSummary(value: OrderFulfillment | null | undefined) {
  if (!value || value.version !== 1) return null;
  const demands = Array.isArray(value.demands) ? value.demands : [];
  let requested = 0, allocated = 0, missing = 0;
  let valid = demands.length > 0;
  for (const demand of demands) {
    const q = Number(demand.quantity), a = Number(demand.allocated), m = Number(demand.missing);
    if (![q, a, m].every(Number.isFinite) || q <= 0 || a < 0 || m < 0 || a + m !== q) {
      valid = false;
      continue;
    }
    requested += q; allocated += a; missing += m;
  }
  return { requested, allocated, missing, valid, ready: valid && missing === 0 };
}

export const SHORTAGE_FOLLOWUP_LABELS={waiting:"انتظار التوريد",contacted:"تم التواصل",awaiting_customer:"انتظار قرار العميل",procurement:"قيد التوريد"} as const;
