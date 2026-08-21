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
