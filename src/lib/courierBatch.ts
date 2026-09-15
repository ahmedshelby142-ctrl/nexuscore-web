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
 * The subject id every courier ledger line is booked against.
 *
 * `"default"` is the LEGACY bucket, not a company. Before the courier registry
 * (migration 030) an order carried a typed `courierName` and usually no id at
 * all, so its money landed here. Audited on 2026-09-14: of QA-STORE's 2,520
 * EGP sitting under this subject, **2,340 belongs to orders with no courier
 * named whatsoever** — no evidence exists that could assign it to anybody. It
 * is therefore preserved as unassigned rather than migrated; inventing an
 * identity for it would be a worse answer than admitting we do not have one.
 *
 * The fallback stays because history must stay READABLE: remove it and those
 * balances become unreachable from the screen that reconciles them. What must
 * not happen is a NEW order landing here — see `requiresCourierAssignment`.
 */
export const LEGACY_COURIER_SUBJECT = "default";

/** What to call the legacy bucket on screen. Never "the default company". */
export const LEGACY_COURIER_LABEL = "شحن غير محدد (سجلات قديمة)";

export function courierIdOf(order: Pick<EcommerceOrder, "courierId">): string {
  return order.courierId || LEGACY_COURIER_SUBJECT;
}

/** Is this the legacy bucket rather than a registered company? */
export function isLegacyCourier(courierId: string | null | undefined): boolean {
  return !courierId || courierId === LEGACY_COURIER_SUBJECT;
}

/**
 * Does this order need a courier picked before it may be saved?
 *
 * Only when shipping is actually involved: a walk-in or a collected order has
 * no courier and must not be forced to invent one. When shipping IS involved,
 * a registered courier is required — otherwise the order's COD and fees book
 * to the legacy bucket and the money becomes unattributable the moment it is
 * written, which is exactly how 2,340 EGP of it got there.
 */
export function requiresCourierAssignment(order: {
  courierId?: string | null;
  shippingFee?: number | null;
  expectedCod?: number | null;
  governorate?: string | null;
}): boolean {
  const shipping =
    Number(order.shippingFee) > 0 ||
    Number(order.expectedCod) > 0 ||
    Boolean(String(order.governorate ?? "").trim());
  return shipping && isLegacyCourier(order.courierId);
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
