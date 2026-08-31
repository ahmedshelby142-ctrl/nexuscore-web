/**
 * The e-commerce order lifecycle: which action is legal in which status.
 *
 * ## Why this is a table and not a pile of conditions
 *
 * Order Management used to render every row action unconditionally and merely
 * `disabled` a couple of them per status. That is not a state machine, and it
 * produced actions that made no physical sense:
 *
 *   - "مرتجع" was live on a PENDING order — offering to take back goods that had
 *     never left the shop. Going through with it would have put stock back that
 *     was still sitting on the shelf, inventing units from nothing.
 *   - "تسليم", with its wallet picker, was live on a PENDING order — booking
 *     revenue, COGS and COD for a delivery that had not happened.
 *   - "للمندوب" was live on delivered, returned and cancelled orders, because it
 *     was only disabled for `shipped`.
 *
 * Kept pure and free of React so the lifecycle can be asserted directly, and so
 * there is exactly one answer to "may this order be X'd right now" — the dialog,
 * the button and the save all ask this rather than re-deriving it.
 *
 * ## The lifecycle
 *
 *   pending    ──ship──▶ shipped          goods physically leave the shop
 *              ──edit──▶ pending          ONE `order_edited` event, stock delta only
 *              ──cancel─▶ cancelled       the reservation goes back
 *
 *   shipped    ──settle──▶ delivered      delivered AND the COD is in our hands
 *              ──deliver─▶ delivered      delivered, COD still with the courier
 *              ──return──▶ returned       the courier's claim, nothing moved yet
 *
 *   delivered  ──return──▶ returned       a return inside the allowed window
 *
 *   returned   ──confirmReturn──▶         §3.9: a human confirms arrival, stock +
 *
 *   cancelled  terminal.
 *
 * `returned` means "the courier says it is coming back", NOT "it is back" — which
 * is why confirmation is a separate action, and why stock moves only there.
 */

import type { EcommerceOrderStatus } from "@/types";

export type OrderAction =
  /** Hand the goods to the courier. */
  | "ship"
  /** Delivered; the COD stays with the courier as a receivable. */
  | "deliver"
  /** Delivered AND the courier handed the money over, into a chosen wallet. */
  | "settle"
  /** Record that the goods are coming back. Moves no stock. */
  | "return"
  /** A human confirms the goods physically arrived. THIS moves stock. */
  | "confirmReturn"
  /** Change what is in the order, while it is still in the shop. */
  | "edit"
  /** Call the order off before it ever ships. */
  | "cancel"
  /**
   * The customer sends more money before delivery — a transfer that pays down
   * what the courier was going to collect.
   *
   * Legal while the goods are still in the shop OR already with the courier:
   * both are moments where money can still arrive ahead of the COD. Not after
   * `delivered`, because by then the courier has collected and any further
   * movement is a settlement or a refund, which have their own actions.
   */
  | "pay";

const ACTIONS_BY_STATUS: Record<EcommerceOrderStatus, readonly OrderAction[]> = {
  // Still in the shop: hand it over, change it, or call it off.
  pending: ["ship", "edit", "cancel", "pay"],
  // With the courier: it either reaches the customer or comes back.
  shipped: ["settle", "deliver", "return", "pay"],
  // Sold. The only way out is a return, which reverses the money too.
  delivered: ["return"],
  // The courier says it is coming back. Nothing has arrived yet.
  returned: ["confirmReturn"],
  // Terminal — stock is already back and no money ever moved.
  cancelled: [],
};

/** The actions legal for this status. Empty for a terminal status. */
export function actionsFor(status: EcommerceOrderStatus): readonly OrderAction[] {
  return ACTIONS_BY_STATUS[status] ?? [];
}

/**
 * May this order be acted on this way right now?
 *
 * Used by the handlers as well as the buttons: a dialog can sit open while the
 * order moves on in another tab, so the click has to re-ask rather than trust
 * what was rendered.
 */
export function canDo(status: EcommerceOrderStatus, action: OrderAction): boolean {
  return actionsFor(status).includes(action);
}

/**
 * ## Why `canDo` alone was not enough (2026-08-19)
 *
 * `ECO-1786978185609` carries THREE `order_delivered` events, 6 and 13 seconds
 * apart, each a complete event, and three `return_confirmed` after them. The
 * numbers happened to net out. They did not have to.
 *
 * Both handlers already re-checked `canDo`. The gap is that a status check is
 * only as fresh as the value it reads, and the value it read was a React
 * render snapshot: the status only becomes `delivered` AFTER the append
 * resolves, so every click that lands while the first append is in flight sees
 * `shipped` and passes. `disabled={isWorking}` does not close it either — a
 * second click can be dispatched before React commits the re-render.
 *
 * So the guard needs a claim that is taken SYNCHRONOUSLY, before the first
 * `await`, and held until the action finishes. One order, one action in flight.
 *
 * ponytail: a module-level `Set`, not a queue or a lock library. The app is one
 * window over one local ledger; the thing being prevented is two clicks on one
 * row, not distributed contention.
 */
const inFlight = new Set<string>();

/** Why a claim was refused — the caller words it for the operator. */
export type ClaimResult =
  /** Claimed. The caller MUST `releaseOrder` when it finishes. */
  | "ok"
  /** This order already has an action in flight (the double-click). */
  | "busy"
  /** The status has moved on and no longer allows this action. */
  | "illegal";

/**
 * Claim an order for ONE action. Call it before the first `await`, pass the
 * status read from the STORE (`useOrderStore.getState()`), not from a render.
 */
export function claimOrder(
  orderId: string,
  status: EcommerceOrderStatus,
  action: OrderAction,
): ClaimResult {
  if (!canDo(status, action)) return "illegal";
  if (inFlight.has(orderId)) return "busy";
  inFlight.add(orderId);
  return "ok";
}

/** Release a claim. Always from a `finally`, or the row stays stuck. */
export function releaseOrder(orderId: string): void {
  inFlight.delete(orderId);
}
