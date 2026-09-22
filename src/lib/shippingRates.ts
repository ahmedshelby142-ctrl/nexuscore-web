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
export type ReturnCause = "customer" | "courier" | "shop" | "unknown";

export const RETURN_CAUSES: readonly ReturnCause[] = [
  "customer",
  "courier",
  "shop",
  "unknown",
] as const;

/** What the operator picks. Arabic only — this reaches the user. */
export const RETURN_CAUSE_LABELS: Record<ReturnCause, string> = {
  customer: "العميل",
  courier: "المندوب / شركة الشحن",
  shop: "المحل",
  unknown: "غير محدد",
};

/** One line of help under each choice, so the money consequence is visible. */
export const RETURN_CAUSE_HINTS: Record<ReturnCause, string> = {
  customer: "العميل هو السبب — الشحن عليه، والرحلة الضائعة تتحسب عليه، والعربون ميترجعش",
  courier: "غلطة من المندوب/شركة الشحن — الشحن يتحمّله الشحن نفسه، والعربون يرجع للعميل، ومش هيتحسب على العميل",
  shop: "غلطة من المحل — الشحن علينا، والعربون يرجع للعميل، ومش هيتحسب عليه",
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
  courier: "غلطة من المندوب/شركة الشحن — هتتسجّل عليهم، ومفيش شحن على المرتجع ده",
  shop: "غلطة من المحل — هتتسجّل علينا، ومفيش شحن على المرتجع ده",
  unknown: "مش متأكد — هيتسجّل كـ(غير محدد) ومش هيتحسب على حد",
};

/**
 * The same three causes, worded for an EXCHANGE.
 *
 * ## Cause is not requester
 *
 * The single most expensive confusion in this policy. A customer asking for a
 * swap does not make the customer responsible for it — if we shipped the wrong
 * size, or the item arrived faulty, that is the shop's fault however the
 * request reached us. `RETURN_CAUSE_LABELS` says only «العميل», which reads to
 * an operator as "the customer asked", and the operator picks it because the
 * customer did ask. The money then follows the wrong party.
 *
 * So on an exchange the choices name the CAUSE, and the customer option names
 * the only case that is genuinely theirs: changing their mind.
 */
export const EXCHANGE_CAUSE_LABELS: Record<ReturnCause, string> = {
  customer: "تغيير رغبة العميلة",
  courier: "خطأ من المندوب / شركة الشحن",
  shop: "خطأ من المحل أو عيب في المنتج",
  unknown: "غير محدد",
};

export const EXCHANGE_CAUSE_HINTS: Record<ReturnCause, string> = {
  customer:
    "العميلة غيّرت رأيها أو اختارت مقاس/لون تاني — دي الحالة الوحيدة اللي الاستبدال فيها على العميلة",
  courier: "غلطة من المندوب/شركة الشحن — الشحن يتحمّله الشحن نفسه، ومش على العميلة",
  shop: "بعتنا حاجة غلط أو المنتج فيه عيب — التكلفة علينا، ومش على العميلة",
  unknown: "لازم تحدد السبب قبل التأكيد — السبب هو اللي بيحدد التكلفة على مين",
};

/**
 * The labels and hints for a movement. One lookup so no screen picks its own.
 */
export function causeLabelsFor(movement: "return" | "exchange"): Record<ReturnCause, string> {
  return movement === "exchange" ? EXCHANGE_CAUSE_LABELS : RETURN_CAUSE_LABELS;
}

export function causeHintsFor(movement: "return" | "exchange"): Record<ReturnCause, string> {
  return movement === "exchange" ? EXCHANGE_CAUSE_HINTS : RETURN_CAUSE_HINTS;
}

/**
 * May this movement be confirmed with the cause the operator has chosen?
 *
 * `"unknown"` is refused. Every screen defaults the picker to it, and
 * `shippingBorneBy("unknown", "exchange")` resolves to `"customer"` — so an
 * operator who simply pressed تأكيد billed the customer for a swap that may
 * well have been the shop's fault. That is the blanket "exchange = customer"
 * rule, surviving as a default rather than as a line of code.
 *
 * The fallback inside `shippingBorneBy` is deliberately NOT changed: every row
 * written before the cause axis existed is `'unknown'`, and re-deciding those
 * would move historical figures. It stays as the reading of history, and this
 * stops new history being written into it.
 *
 * Applied to returns as well as exchanges. A return confirmed with no
 * responsibility is the ambiguity this whole axis exists to remove — it decides
 * the deposit, the wasted-trip debt and who carries the fee.
 */
export function causeRequiredFor(_movement: "return" | "exchange"): boolean {
  return true;
}

/** Why this movement cannot be confirmed yet, or `null` if it can. */
export function blockingCauseReason(
  cause: ReturnCause,
  movement: "return" | "exchange",
): string | null {
  if (cause !== "unknown") return null;
  return movement === "exchange"
    ? "حدّد سبب الاستبدال — هو اللي بيحدد التكلفة على المحل ولا على العميلة"
    : "حدّد سبب المرتجع — هو اللي بيحدد الشحن والعربون على مين";
}

/**
 * Who the shop expects compensation FROM, if anyone, for this movement.
 *
 * Exists so a screen or a report can state the courier-compensation case in
 * words rather than leaving the operator to infer it from a `receivable_courier`
 * line. `"customer"` is a pass-through the courier collects on our behalf;
 * `"courier"` is the provider reimbursing us for a trip their own fault wasted.
 * Both land identically in the ledger — which is exactly why the distinction
 * has to be carried by `return_cause` and said out loud here.
 */
export function compensationExpectedFrom(
  cause: ReturnCause,
  movement: "return" | "exchange",
): "courier" | null {
  return shippingBorneBy(cause, movement) === "courier" ? "courier" : null;
}

/** Anything stored → a safe cause. Unknown values never become blame. */
export function toReturnCause(value: string | null | undefined): ReturnCause {
  return (RETURN_CAUSES as readonly string[]).includes(value ?? "")
    ? (value as ReturnCause)
    : "unknown";
}

/**
 * Who ends up carrying the courier's fee.
 *
 * `"courier"` is the axis migration 029 added. A trip that failed through the
 * courier's own fault is not the shop's cost and is certainly not the
 * customer's — the company compensates us for it, which lands as a receivable
 * against them rather than as an expense.
 */
export type FeeBearer = "customer" | "shop" | "courier";

/**
 * Who bears the courier's fee for this movement.
 *
 * Responsibility decides it, not the movement — that was the whole defect. A
 * swap because we shipped the wrong size is our cost; a swap because the
 * customer changed their mind is theirs, and the movement looks identical in
 * both cases.
 *
 * `"unknown"` falls back to the ESTABLISHED movement-keyed default — return is
 * the shop's cost, exchange is the customer's. That fallback is now purely a
 * READING OF HISTORY: every row written before migration 026 defaults to
 * `'unknown'`, so this function reproduces exactly the accounting those rows
 * already had and no historical figure moves.
 *
 * It must not be reached by anything NEW. On an exchange it resolves to
 * `"customer"`, which is the blanket "exchange = customer pays" rule surviving
 * as a default rather than as a line of code — an operator who never touched
 * the picker billed the customer for a swap the shop may have caused.
 * `blockingCauseReason` refuses to confirm an unclassified movement, in the UI
 * and again in the handler, so the only `'unknown'` rows that exist are the
 * ones that already existed.
 */
export function shippingBorneBy(
  cause: ReturnCause,
  movement: "return" | "exchange",
): FeeBearer {
  if (cause === "customer") return "customer";
  if (cause === "courier") return "courier";
  if (cause === "shop") return "shop";
  return movement === "exchange" ? "customer" : "shop";
}

/**
 * What happens to the deposit when this movement is confirmed.
 *
 * ## Three answers, not two
 *
 * This used to be `depositForfeitedOn`, a boolean: keep it, or give it back.
 * `false` meant the refund happened **immediately and automatically**, so a
 * courier-caused return handed the customer's money back with nobody deciding
 * and nothing recording that a decision had been made.
 *
 * That is a blanket refund rule, and it is wrong for the same reason the
 * blanket forfeit was wrong: it answers a question nobody asked. The real
 * sequence has days in the middle of it —
 *
 *   the courier causes the return
 *     → the shop claims compensation from them
 *     → the customer says whether they still want the goods
 *     → ONLY THEN is the deposit resolved
 *
 * A customer who takes the replacement keeps their deposit working for them.
 * A customer who walks away after our provider failed them MAY have it back,
 * as a case-by-case resolution someone chooses and signs for.
 *
 * So the confirmation cannot resolve it, and must not pretend to:
 *
 *   "forfeit"             the customer walked away. Final — Rule A. Booked to
 *                         `revenue / forfeited_deposit`.
 *   "pending_resolution"  the shop or the courier caused it. The cash stays in
 *                         the till for now, booked to
 *                         `revenue / deposit_pending_resolution` so it is
 *                         visibly NOT final, and `refund_order_deposit`
 *                         (migration 038) is what may later hand it back.
 *   "none"                an exchange. The same money funds the replacement.
 *
 * ## Why "pending" is booked as income at all
 *
 * Because the cash IS in the till — `order_placed` banked it — and a till
 * holding money no income line explains is the "ghost in the till" the RTO
 * builder was fixed to remove. Booking it to its own subject keeps the balance
 * honest AND keeps the two reportable apart, which a single `forfeited_deposit`
 * subject could not: one is earned, the other is merely held.
 *
 * ## `"unknown"` still forfeits
 *
 * Every row written before the cause axis existed defaults to `'unknown'`, and
 * flipping it would move historical figures. Not knowing who was at fault is
 * not a finding that the shop was. New rows cannot be `'unknown'` —
 * `blockingCauseReason` refuses the confirmation.
 */
export type DepositDisposition = "forfeit" | "pending_resolution" | "none";

export function depositDispositionOn(
  cause: ReturnCause,
  movement: "return" | "exchange",
): DepositDisposition {
  if (movement === "exchange") return "none";
  return cause === "shop" || cause === "courier" ? "pending_resolution" : "forfeit";
}

/**
 * May this order's deposit be refunded as a case-by-case resolution?
 *
 * The CLIENT half of the eligibility rule in `refund_order_deposit`. It decides
 * whether to offer the button; the function decides whether the money moves,
 * and re-checks every one of these against the database — a customer-caused
 * cause, a deposit that was never banked and a second refund are each refused
 * server-side with their own error code.
 *
 * Deliberately not a mirror of the whole rule. "Has it already been refunded"
 * is a question about the ledger, and asking it here would be a second, stale
 * answer to something the server settles atomically under a lock.
 */
export function depositRefundEligible(cause: ReturnCause): boolean {
  return cause === "courier" || cause === "shop";
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
