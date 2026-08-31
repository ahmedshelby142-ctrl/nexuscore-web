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
