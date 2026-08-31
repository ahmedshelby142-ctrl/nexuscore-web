/**
 * Which deliveries a courier still owes us money for, and what a batch adds up
 * to (§3.9).
 *
 * Pure and free of React, like `orderLifecycle` and `orderSearch`, so the two
 * things that decide real money — "is this order still outstanding" and "what
 * is the difference between what they owed and what arrived" — are pinned by
 * tests instead of living inside a component.
 *
 * The ledger aggregates `receivable_courier` by COURIER, not by order, which is
 * correct (a compound `courier:order` subject would make every balance query
 * unreadable). So "which orders is that total made of" is a question for the
 * order documents, and this is where it is answered — once.
 */

import type { EcommerceOrder } from "@/types";

/**
 * The courier an order's money belongs to.
 *
 * `order.courierId` is optional, and every ledger line already falls back to
 * `"default"`. This existed inline in four places, and the courier STORE used a
 * different fallback (`"default-courier"`) — so an order with no courier booked
 * its COD to subject `default` while the screen looked up `default-courier` and
 * showed zero. One function, one fallback, no drift.
 */
export function courierIdOf(order: Pick<EcommerceOrder, "courierId">): string {
  return order.courierId || "default";
}

/** Has this order's COD already been handed over and reconciled? */
export function isCodSettled(order: Pick<EcommerceOrder, "codSettledAt">): boolean {
  return Boolean(order.codSettledAt);
}

/**
 * Delivered orders whose COD is still sitting with this courier.
 *
 * Delivered, because `receivable_courier` is written by `order_delivered` and
 * nothing before it — an order still in the shop or still with the courier
 * undelivered has no money to settle. COD above zero, because a fully-prepaid
 * order was paid into a till at delivery and the courier never held a piastre
 * of it. Not already settled, because a batch must never clear the same order
 * twice.
 */
export function unsettledDeliveries(
  orders: EcommerceOrder[],
  courierId?: string,
): EcommerceOrder[] {
  return orders.filter(
    (order) =>
      order.status === "delivered" &&
      order.expectedCod > 0 &&
      !isCodSettled(order) &&
      (courierId === undefined || courierIdOf(order) === courierId),
  );
}

export interface BatchSummary {
  /** What the ticked orders were carrying in COD, EGP. */
  codTotal: number;
  /** What fees were already booked for these orders, EGP. */
  expectedFees: number;
  /** Expected net amount to be received = codTotal - expectedFees, EGP. */
  expectedNet: number;
  /** What actually arrived, EGP. */
  netReceived: number;
  /** Expected Net - Actual Received: positive when there is a shortfall/deficit. */
  shortfall: number;
  /** codTotal − netReceived: what the courier kept. */
  difference: number;
  orderCount: number;
}

/**
 * The numbers the screen must show BEFORE anything is written.
 *
 * Real-time comparison:
 * - codTotal: total COD collected by the courier on the selected orders.
 * - expectedFees: courier commissions and fees attached to these movements.
 * - expectedNet: codTotal - expectedFees (what the owner expects to receive).
 * - netReceived: actual amount transferred by the courier into the wallet.
 * - shortfall: expectedNet - netReceived (highlighted in red if > 0).
 */
export function batchSummary(
  ticked: (Pick<EcommerceOrder, "expectedCod"> & { courierFee?: number; shippingFee?: number })[],
  netReceived: number,
): BatchSummary {
  const codTotal = ticked.reduce((sum, order) => sum + (order.expectedCod || 0), 0);
  const expectedFees = ticked.reduce(
    (sum, order) => sum + (order.courierFee ?? order.shippingFee ?? 0),
    0,
  );
  const expectedNet = codTotal - expectedFees;
  const shortfall = expectedNet - netReceived;
  return {
    codTotal,
    expectedFees,
    expectedNet,
    netReceived,
    shortfall,
    difference: codTotal - netReceived,
    orderCount: ticked.length,
  };
}
