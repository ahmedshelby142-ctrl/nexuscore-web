/**
 * Shipping prices: governorate × movement.
 *
 * The owner sets these in Settings and they are the ONLY source of a shipping
 * fee — nothing in the app hardcodes one any more.
 *
 * A rate is read and SNAPSHOTTED into the event's lines at the moment of the
 * movement, exactly like `unit_cost` on a sale. Editing a rate afterwards
 * prices future shipments only; it never rewrites what a past shipment cost.
 * That is why these functions take a rate table and return a number, rather
 * than anything reading the table at display time.
 *
 * Who bears each fee is NOT a pricing question and lives in `MOVEMENT_PAID_BY`:
 * only a return is the shop's cost. See `buildReturnConfirmedLines`.
 */

import type { ShipmentMovement, ShippingRateRow } from "@/types";

/** Normalised governorate key — trims and ignores case so lookups are forgiving. */
function key(governorate: string): string {
  return governorate.trim().toLowerCase();
}

/**
 * The price for one movement to one governorate, EGP.
 *
 * Returns 0 when the governorate has no row. That is deliberate and visible:
 * a missing rate books nothing rather than guessing, and `hasRateFor` lets a
 * screen warn before the movement instead of after.
 */
export function rateFor(
  rows: ShippingRateRow[],
  governorate: string | undefined,
  movement: ShipmentMovement,
): number {
  if (!governorate) return 0;
  const row = rows.find((r) => key(r.governorate) === key(governorate));
  if (!row) return 0;
  const value = row[movement];
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Is this governorate priced at all? Screens use it to warn before shipping. */
export function hasRateFor(rows: ShippingRateRow[], governorate: string | undefined): boolean {
  if (!governorate) return false;
  return rows.some((r) => key(r.governorate) === key(governorate));
}

/** Every governorate the shop ships to, in the order the owner entered them. */
export function shippedGovernorates(rows: ShippingRateRow[]): string[] {
  return rows.map((r) => r.governorate);
}

// ── The repeat-returner penalty ─────────────────────────────────────────────

/**
 * Doubled shipping is COST RECOVERY, not a punishment.
 *
 * When a delivery fails — the customer ignores the courier, or cancels while
 * the order is already out — the shop still pays for the trip out and the trip
 * back. The customer pays nothing. Doubling the fee on their NEXT order
 * recovers that specific wasted trip.
 *
 * Which makes `returned_orders_count` a DEBT, not a history: it is the number
 * of wasted trips still owed. Each doubled delivery that lands pays back one,
 * so three failed trips take three successful orders to settle, and the normal
 * rate returns the moment the last one is square — see `clearsShippingDebt`.
 * A permanent surcharge would stop being recovery and start being a tax on
 * having had one bad day; a single reset would forgive trips the shop paid for.
 *
 * It is the SHIPPING that doubles, never the goods: nobody is charged more for
 * a shirt because of something they did last month.
 */
export const RETURN_PENALTY_MULTIPLIER = 2;

// ── Responsibility: who caused the movement, and therefore who pays ─────────

/**
 * Who caused a return or exchange. Migration 026; mirrors the CHECK constraint
 * on `orders.return_cause` and `return_records.return_cause`.
 *
 * This is the axis the model was missing. `movement` (return/exchange) and
 * `returnType` (rto/refund) both describe the JOURNEY — what travelled and
 * when — and neither can express whether the shop sent the wrong item or the
 * customer changed their mind.
 */
export type ReturnCause = "customer" | "shop" | "unknown";

export const RETURN_CAUSES: readonly ReturnCause[] = ["customer", "shop", "unknown"] as const;

/** What the operator picks. Arabic only — this reaches the user. */
export const RETURN_CAUSE_LABELS: Record<ReturnCause, string> = {
  customer: "العميل",
  shop: "المحل",
  unknown: "غير محدد",
};

/** One line of help under each choice, so the money consequence is visible. */
export const RETURN_CAUSE_HINTS: Record<ReturnCause, string> = {
  customer: "العميل هو السبب — الشحن عليه، والرحلة الضائعة تتحسب عليه",
  shop: "غلطة من المحل — الشحن علينا، ومش هيتحسب على العميل",
  unknown: "مش متأكد — الحسبة هتمشي بالقاعدة الافتراضية ومش هيتسجّل على العميل",
};

/**
 * The same three choices, for the WALK-IN counter return.
 *
 * `RETURN_CAUSE_HINTS` above promises "الشحن عليه، والرحلة الضائعة تتحسب عليه",
 * and on the two courier paths that is exactly what happens. On the counter
 * return it is not: that handler passes `returnFee: 0` and records no wasted
 * trip, deliberately — the delivery already SUCCEEDED, the customer has the
 * goods and walked them back in, so no courier journey was wasted and none is
 * owed for. Showing the courier wording there told the operator the customer
 * had just been charged shipping and penalised on their next order, and
 * neither had happened.
 *
 * The cause is still recorded on the document, which is why the choice stays:
 * it is the responsibility axis reports read, not a shipping charge.
 */
export const COUNTER_RETURN_CAUSE_HINTS: Record<ReturnCause, string> = {
  customer: "العميل هو السبب — هيتسجّل عليه في التقارير، ومفيش شحن على المرتجع ده",
  shop: "غلطة من المحل — هتتسجّل علينا، ومفيش شحن على المرتجع ده",
  unknown: "مش متأكد — هيتسجّل كـ(غير محدد) ومش هيتحسب على حد",
};

/** Anything stored → a safe cause. Unknown values never become blame. */
export function toReturnCause(value: string | null | undefined): ReturnCause {
  return (RETURN_CAUSES as readonly string[]).includes(value ?? "")
    ? (value as ReturnCause)
    : "unknown";
}

/**
 * Who bears the courier's fee for this movement.
 *
 * Responsibility decides it, not the movement — that was the whole defect. A
 * swap because we shipped the wrong size is our cost; a swap because the
 * customer changed their mind is theirs, and the movement looks identical in
 * both cases.
 *
 * `"unknown"` falls back to the ESTABLISHED movement-keyed default — return is
 * the shop's cost, exchange is the customer's pass-through. That is deliberate:
 * every row written before migration 026 defaults to `'unknown'`, so this
 * function reproduces exactly the accounting those rows already had and no
 * historical figure moves. It is also the safe direction — an unclassified
 * return is not silently billed to the customer.
 */
export function shippingBorneBy(
  cause: ReturnCause,
  movement: "return" | "exchange",
): "customer" | "shop" {
  if (cause === "customer") return "customer";
  if (cause === "shop") return "shop";
  return movement === "exchange" ? "customer" : "shop";
}

/**
 * Does this confirmation add a wasted trip to the customer's debt?
 *
 * TWO conditions, both required.
 *
 * **The customer must have caused it.** A shop-caused return is our mistake;
 * charging the customer double on their next order for it would be absurd.
 * `"unknown"` also does not count — not knowing who was at fault is not a
 * finding of fault, and the rule says so explicitly.
 *
 * **It must actually have wasted a trip.** An exchange does not: the courier
 * carries the replacement out and the original back on one journey, the
 * customer keeps goods, and they have already paid the exchange fee directly.
 * Counting it would bill them twice — once for the swap, again as doubled
 * shipping next time. Both confirm handlers used to increment on EVERY
 * confirmation; measured on QA-STORE, `QA-UAT-ECO-CUSTOMER` carried a debt of
 * 4 from 4 swaps and 0 plain returns.
 *
 * An RTO — refused at the door — is the clearest wasted trip there is, and
 * counts whenever the customer caused it.
 */
export function countsAsWastedTrip(
  cause: ReturnCause,
  movement: "return" | "exchange",
): boolean {
  return cause === "customer" && movement !== "exchange";
}

/** Does this customer owe the shop a wasted courier trip? */
export function isRepeatReturner(customer: { returned_orders_count?: number } | null | undefined): boolean {
  const count = customer?.returned_orders_count;
  return Number.isFinite(count) && (count as number) > 0;
}

/**
 * Has this delivery settled the customer's shipping debt?
 *
 * True only when the order being delivered is the one that actually CHARGED the
 * doubled fee. Resetting on any delivery would clear the debt without ever
 * recovering the trip — a customer with an order already in flight at normal
 * price would have it wiped for free, which is the opposite of cost recovery.
 *
 * Orders placed before this flag existed return `false` and leave the debt
 * standing. That is the safe direction: it costs the shop nothing and settles
 * itself on the customer's next order, which will carry the flag.
 */
export function clearsShippingDebt(
  order: { shippingPenaltyApplied?: boolean } | null | undefined,
): boolean {
  return order?.shippingPenaltyApplied === true;
}

/**
 * The delivery fee actually charged, after the repeat-returner penalty.
 *
 * One function so نقطة البيع, الطلبات الإلكترونية and الجملة cannot each decide
 * what "double" means — the same reason `discountAmountFor` and
 * `reconcileWholesaleReturn` have one home.
 *
 * A free delivery stays free: doubling zero is zero, and a shop that chose to
 * waive the fee did not choose to start charging one.
 */
export function shippingFeeFor(
  baseFee: number,
  customer?: { returned_orders_count?: number } | null,
): number {
  if (!Number.isFinite(baseFee) || baseFee <= 0) return 0;
  return isRepeatReturner(customer) ? baseFee * RETURN_PENALTY_MULTIPLIER : baseFee;
}
