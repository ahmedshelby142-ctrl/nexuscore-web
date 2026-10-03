import { depositRefundEligible, toReturnCause } from "@/lib/shippingRates";

/**
 * What became of an order's عربون — for «did I get my deposit back?».
 *
 * Desktop answers it from the ledger balance on `revenue /
 * deposit_pending_resolution` (`depositResolutionState`), which a Moderator
 * cannot read since 048. This reaches the same answer from what every role
 * CAN read, using the same policy functions:
 *
 *   - the deposit's fate is booked when the return is confirmed or the order
 *     is cancelled: the customer caused it → kept, final (`forfeited_deposit`);
 *     the shop or the courier caused it → held, pending a decision
 *     (`depositDispositionOn`);
 *   - a held deposit leaves only through `refund_order_deposit` (038), which
 *     refunds the WHOLE held balance in one `deposit_refunded` event — so that
 *     event's presence in `mobile_order_timeline` IS "refunded", and its
 *     absence on an eligible order is "still held".
 *
 * `refundedEvent` is `null` when the timeline could not be read: an eligible
 * order is then "unknown", never a guessed "held". A customer-caused deposit
 * needs no ledger read — `refund_order_deposit` refuses it outright.
 */
export type DepositOutcome = "none" | "awaiting_return" | "kept" | "held" | "refunded" | "unknown";

export function depositOutcome(
  order: {
    depositAmount?: unknown;
    status?: unknown;
    returnConfirmedAt?: unknown;
    return_cause?: string | null;
    isExchange?: unknown;
  },
  refundedEvent: boolean | null,
): DepositOutcome {
  if (!(Number(order.depositAmount ?? 0) > 0)) return "none";
  if (refundedEvent === true) return "refunded";
  // An exchange: the same money funds the replacement — nothing to settle.
  if (order.isExchange) return "none";
  const status = String(order.status ?? "");
  if (status !== "cancelled" && !order.returnConfirmedAt) {
    // Returned but not yet received: the deposit is decided on confirmation.
    return status === "returned" ? "awaiting_return" : "none";
  }
  if (!depositRefundEligible(toReturnCause(order.return_cause))) return "kept";
  return refundedEvent === null ? "unknown" : "held";
}

export const DEPOSIT_OUTCOME_LABELS_AR: Record<
  Exclude<DepositOutcome, "none">,
  { labelAr: string; tone: "success" | "warning" | "muted" }
> = {
  refunded: { labelAr: "اترد للعميلة", tone: "success" },
  held: { labelAr: "محجوز لحين قرار التسوية", tone: "warning" },
  kept: { labelAr: "المحل احتفظ بيه", tone: "muted" },
  awaiting_return: { labelAr: "يتحدد بعد تأكيد استلام المرتجع", tone: "muted" },
  unknown: { labelAr: "تعذّر التحقق من حالة العربون", tone: "warning" },
};
