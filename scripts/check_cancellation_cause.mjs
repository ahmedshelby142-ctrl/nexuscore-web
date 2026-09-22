/**
 * Courier-falsified cancellation, the claim lifecycle, and what must not couple.
 *
 * The scenario these exist for: the customer did NOT cancel. The courier
 * failed the delivery and reported "customer cancelled". Until migration 039
 * the app could not contradict that — `cancelOrder` recorded no cause, so the
 * falsified cancellation and the real one were the same row, and both
 * forfeited the customer's deposit.
 *
 * Reference: docs/migrations/039_cancellation_cause_and_courier_claims.sql
 *            docs/RETURN_EXCHANGE_POLICY.md
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOrderCancelledLines } from "../src/lib/ledger/orders.ts";
import {
  depositDispositionOn,
  depositRefundEligible,
  RETURN_CAUSE_HINTS,
} from "../src/lib/shippingRates.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
/** SQL with `--` comments removed, so prose is never mistaken for code. */
const sql = (src) => src.replace(/--[^\n]*/g, "");

const M039 = read("../docs/migrations/039_cancellation_cause_and_courier_claims.sql");
const M039C = sql(M039);
const M038 = read("../docs/migrations/038_courier_return_deposit_resolution.sql");
const ORDERS = strip(read("../src/components/ecommerce/OrdersPage.tsx"));
const CLAIMS = strip(read("../src/services/courierClaims.ts"));
const DEPOSIT = strip(read("../src/services/depositResolution.ts"));

const on = (lines, account, subject) =>
  lines
    .filter((l) => l.account === account && (subject === undefined || l.subjectId === subject))
    .reduce((sum, l) => sum + (l.amount ?? 0), 0);

const ITEM = { productId: "A", quantity: 1, unitPrice: 500, unitCost: 300 };

/** A cancellation, disposed of the way the screen disposes of it. */
function cancel(cause, deposit = 300) {
  const d = depositDispositionOn(cause, "return");
  return buildOrderCancelledLines({
    items: [ITEM],
    wallet: "instaPay",
    customerId: "c1",
    forfeitedDeposit: d === "forfeit" ? deposit : 0,
    pendingDeposit: d === "pending_resolution" ? deposit : 0,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// A · the customer really did cancel
// ═══════════════════════════════════════════════════════════════════════════

test("A · a customer cancellation forfeits the deposit, finally", () => {
  const lines = cancel("customer");
  assert.equal(on(lines, "wallet"), 0, "no cash moves");
  assert.equal(on(lines, "revenue", "forfeited_deposit"), 300, "earned, and said so");
  assert.equal(on(lines, "revenue", "deposit_pending_resolution"), 0, "nothing left open");
  assert.equal(depositRefundEligible("customer"), false, "and no resolution is offered");
});

// ═══════════════════════════════════════════════════════════════════════════
// B · the courier reported a cancellation the customer never made
// ═══════════════════════════════════════════════════════════════════════════

test("B · a courier-caused cancellation is NOT a customer cancellation", () => {
  const lines = cancel("courier");
  assert.equal(
    on(lines, "revenue", "forfeited_deposit"),
    0,
    "it must not be booked as money we earned",
  );
  assert.equal(on(lines, "revenue", "deposit_pending_resolution"), 300, "it is held");
  assert.equal(on(lines, "wallet"), 0, "and NOT automatically refunded either");
  assert.equal(depositRefundEligible("courier"), true, "the resolution becomes available");
});

test("B · the cancel path records a cause at all — it recorded none", () => {
  // The whole gap: `cancelOrder(orderId)` took no cause, so nothing
  // distinguished the two cases.
  assert.match(
    ORDERS,
    /const cancelOrder = async \(orderId: string, cause: ReturnCause\)/,
    "the handler must take a cause",
  );
  // On the order, because the resolution reads it back days later…
  assert.match(ORDERS, /updateOrder\(orderId, \{ return_cause: cause \}/);
  // …and on the append-only event, so it cannot be rewritten afterwards.
  assert.match(ORDERS, /payload: \{ customerName: order\.customerName, return_cause: cause \}/);
});

test("B · the operator is asked, and the three causes are offered", () => {
  assert.match(ORDERS, /سبب الإلغاء/, "the dialog asks");
  assert.match(ORDERS, /العميلة لغت بنفسها/);
  assert.match(ORDERS, /المندوب \/ شركة الشحن/);
  assert.match(ORDERS, /خطأ من المحل/);
  // …and it must not describe a courier-caused return as a customer cancellation.
  assert.match(ORDERS, /مش إلغاء من العميلة/);
});

// ═══════════════════════════════════════════════════════════════════════════
// C · replacement
// ═══════════════════════════════════════════════════════════════════════════

test("C · a replacement is a new order linked to the original", () => {
  const entry = strip(read("../src/routes/ecommerce-orders.tsx"));
  assert.match(entry, /original_order_id: originalOrderId/, "linked by a real column");
  // Order A is not rewritten: the claim keys on it by foreign key, and the
  // ledger cannot be updated at all.
  assert.match(M039C, /order_id\s+text NOT NULL REFERENCES public\.orders\(id\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// D · the resolution, exactly once
// ═══════════════════════════════════════════════════════════════════════════

test("D · the deposit refund is a separate authorized event", () => {
  assert.match(M038, /'kind', 'deposit_refunded'/);
  assert.match(M038, /IF v_pending <= 0 THEN\s*RAISE EXCEPTION 'NEXUS_NOTHING_TO_REFUND'/);
  assert.match(M038, /pg_advisory_xact_lock/);
});

// ═══════════════════════════════════════════════════════════════════════════
// E · authorization on the cause itself
// ═══════════════════════════════════════════════════════════════════════════

test("E · a cashier cannot manufacture a courier cause", () => {
  // `write_orders` admits ADMIN, POS_ECOMMERCE and ECOMMERCE_ONLY, so without
  // this a cashier could assert a claim against a shipping provider.
  assert.match(
    M039C,
    /IF v_new IN \('courier', 'shop'\)[\s\S]{0,200}RAISE EXCEPTION 'NEXUS_CAUSE_NOT_AUTHORISED'/,
    "the two money-bearing causes are gated",
  );
  assert.match(M039C, /ARRAY\['ADMIN', 'ACCOUNTANT'\]/, "to the roles that may write a money kind");
  // A TRIGGER, not an RPC — it has to cover every write path, including a raw
  // PostgREST call that never goes near the app.
  assert.match(M039C, /CREATE TRIGGER orders_guard_return_cause\s*BEFORE INSERT OR UPDATE ON public\.orders/);
  // `customer` stays open: it creates nothing to claim.
  assert.ok(
    !/IF v_new IN \('customer'/.test(M039C),
    "the ordinary cause must not need extra authority",
  );
});

test("E · the cause freezes once the deposit has been resolved", () => {
  assert.match(
    M039C,
    /kind = 'deposit_refunded'[\s\S]{0,120}RAISE EXCEPTION 'NEXUS_CAUSE_FROZEN_AFTER_RESOLUTION'/,
    "re-pointing the blame after the money moved must be refused",
  );
});

test("E · the refusal reaches the operator in their own language", () => {
  assert.match(ORDERS, /NEXUS_CAUSE_NOT_AUTHORISED/);
  assert.match(ORDERS, /محتاج صلاحية مدير أو محاسب/);
});

// ═══════════════════════════════════════════════════════════════════════════
// F · duplicates
// ═══════════════════════════════════════════════════════════════════════════

test("F · a second open claim on one order is refused by the database", () => {
  assert.match(
    M039C,
    /CREATE UNIQUE INDEX IF NOT EXISTS courier_claims_one_open_per_order[\s\S]{0,200}WHERE deleted_at IS NULL AND status <> 'rejected'/,
    "one live claim per order",
  );
  // Refused by the index, not by reading first and hoping.
  assert.ok(
    !/SELECT[\s\S]{0,200}IF FOUND THEN[\s\S]{0,80}already/i.test(M039C),
    "no check-then-insert race",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// G / H · the two workflows must never couple
// ═══════════════════════════════════════════════════════════════════════════

test("G · settling a claim does not refund the customer", () => {
  // The claim table holds no money and settles nothing: it RECORDS which
  // `courier_settlement` event did.
  assert.match(M039C, /settlement_event_id text REFERENCES public\.ledger_events\(id\)/);
  assert.match(
    M039C,
    /NEW\.status = 'settled' AND NEW\.settlement_event_id IS NULL[\s\S]{0,120}NEXUS_CLAIM_SETTLEMENT_NEEDS_EVENT/,
    "a claim is closed by a settlement that happened",
  );
  // Nothing in the claim service touches a customer's money.
  for (const word of ["wallet", "deposit", "forfeited", "refund"]) {
    assert.ok(
      !new RegExp(word, "i").test(CLAIMS.replace(/CLAIM_STATUS_LABELS[\s\S]*?};/, "")),
      `courierClaims must not mention ${word}`,
    );
  }
});

test("H · refunding the customer does not settle the claim", () => {
  // The refund's lines touch no courier account — asserted at the migration,
  // because paying a customer must not quietly forgive a provider.
  const refundLines = M038.slice(M038.indexOf("v_lines := jsonb_build_array"));
  assert.ok(!/receivable_courier/.test(refundLines));
  assert.ok(!/payable_courier/.test(refundLines));
  // …and the deposit service knows nothing about claims.
  assert.ok(!/courier_claims|claim/i.test(DEPOSIT));
});

// ═══════════════════════════════════════════════════════════════════════════
// The claim lifecycle
// ═══════════════════════════════════════════════════════════════════════════

test("the claim has a real lifecycle, not a free-text status", () => {
  assert.match(
    M039C,
    /CHECK \(status = ANY \(ARRAY\['pending','submitted','approved','rejected','settled'\]\)\)/,
  );
  // A status column with no transition rule is a column where any state
  // reaches any other, which is not a lifecycle.
  //
  // Read from 041, NOT 039. The CHECK constraint above is still 039's, but 041
  // REPLACED the whole guard function — and asserting the transition table
  // against the superseded copy was a real defect in this file. A mutation run
  // proved it: breaking the live table in 041 left these green, because they
  // were reading a migration that no longer runs.
  assert.match(M041C, /WHEN 'pending'\s*THEN NEW\.status IN \('submitted', 'rejected'\)/);
  assert.match(M041C, /WHEN 'submitted' THEN NEW\.status IN \('approved', 'rejected'\)/);
  assert.match(M041C, /WHEN 'approved'\s*THEN NEW\.status = 'settled'/);
  assert.match(M041C, /ELSE false/, "settled and rejected are terminal");
  assert.match(M041C, /NEXUS_CLAIM_MUST_START_PENDING/);
  // Nothing but `approved` may reach `settled`.
  assert.ok(
    !/THEN NEW\.status IN \([^)]*'settled'/.test(M041C),
    "no multi-target transition may include settled",
  );
  assert.ok(
    !/WHEN 'approved'\s*THEN true/.test(M041C),
    "the approved arm must name its one legal target",
  );
});

test("the settlement event is checked against THIS store", () => {
  // Without the tenant term a claim could close against a settlement belonging
  // to another shop — `courier_id` values are per-store text ids and could
  // collide across tenants.
  assert.match(M041C, /AND e\.store_id = NEW\.store_id/, "the event must be ours");
});

test("the claim is traceable to everything the business needs", () => {
  for (const col of [
    "order_id",
    "courier_id",
    "return_record_id",
    "amount_piastres",
    "status",
    "settlement_event_id",
    "created_at",
    "submitted_at",
    "decided_at",
    "settled_at",
    "created_by",
    "decided_by",
  ]) {
    assert.ok(M039C.includes(col), `courier_claims must carry ${col}`);
  }
  // Canonical foreign keys, not text-only ids.
  assert.match(M039C, /courier_id\s+text NOT NULL REFERENCES public\.couriers\(id\)/);
  assert.match(M039C, /return_record_id text REFERENCES public\.return_records\(id\)/);
});

test("the claim holds workflow state, never a second balance", () => {
  // The receivable already lives in the ledger. A second summed amount is how
  // two answers to "what does this courier owe us" come to exist.
  assert.match(CLAIMS, /amount_piastres/, "the snapshot exists");
  assert.match(M039, /snapshot/i, "and is documented as one");
  // No ledger write anywhere in the claim service.
  assert.ok(!/appendEvent|ledger_append|buildOrder|buildReturn/.test(CLAIMS));
});

test("only the money roles may touch a claim", () => {
  assert.match(
    M039C,
    /CREATE POLICY write_courier_claims[\s\S]{0,240}ARRAY\['ADMIN', 'ACCOUNTANT'\]/,
    "a cashier does not get to assert a provider owes us money",
  );
  assert.match(
    M039C,
    /CREATE POLICY select_courier_claims[\s\S]{0,100}is_store_member\(store_id\)/,
    "but the shop can read it, Moderator included",
  );
  assert.match(M039C, /ALTER TABLE public\.courier_claims ENABLE ROW LEVEL SECURITY/);
});

// ═══════════════════════════════════════════════════════════════════════════
// GAP 3 · the shop case stays undecided, and the copy stops claiming otherwise
// ═══════════════════════════════════════════════════════════════════════════

test("the hints no longer promise a refund the code does not make", () => {
  // Both of these said «والعربون يرجع للعميل» — the deposit goes back — which
  // stopped being true the moment the disposition became "held". Shipped copy
  // that contradicts the ledger is worse than no copy.
  assert.ok(
    !/العربون يرجع للعميل/.test(RETURN_CAUSE_HINTS.courier),
    "courier hint must not promise a refund",
  );
  assert.ok(
    !/العربون يرجع للعميل/.test(RETURN_CAUSE_HINTS.shop),
    "shop hint must not promise a refund",
  );
  assert.match(RETURN_CAUSE_HINTS.courier, /يتحجز/, "it says held");
  assert.match(RETURN_CAUSE_HINTS.shop, /يتحجز/);
  // Rule A is unchanged and still stated plainly.
  assert.match(RETURN_CAUSE_HINTS.customer, /العربون ميترجعش/);
});

test("shop-caused is held, which is the reversible answer while it is undecided", () => {
  // NOT invented: `shop` is determinately not-forfeited (three sources say
  // so), and indeterminate between refund-now and hold. Holding moves no
  // money and leaves the refund reachable, so it is the one that can still
  // become either.
  assert.equal(depositDispositionOn("shop", "return"), "pending_resolution");
  assert.notEqual(depositDispositionOn("shop", "return"), "forfeit");
});

// ═══════════════════════════════════════════════════════════════════════════
// OWNER DECISION, 2026-09-22 — the resolution is TWO decisions
//
// Identifying the courier as the cause says nothing about whether the customer
// still wants the goods. Most of the time they do, and the deposit should
// carry straight into the replacement. Offering رد العربون on the same click
// made the refund the default answer to a question nobody had asked them yet.
// ═══════════════════════════════════════════════════════════════════════════

test("the refund is not offered on the click that identifies the cause", () => {
  // Step one names the two resolutions; the refund form is behind step two.
  assert.match(ORDERS, /useState<"choose" \| "refund">\("choose"\)/, "two steps");
  assert.match(ORDERS, /resolutionStep === "choose" &&/, "step one renders the choice");
  assert.match(ORDERS, /resolutionStep === "refund" &&/, "the refund form is gated behind it");
  // The entry button says تسوية العميلة, not رد العربون.
  const entry = ORDERS.slice(0, ORDERS.indexOf("<Dialog"));
  assert.ok(
    !/تسوية العميلة — رد العربون/.test(ORDERS),
    "the entry point must not name the refund",
  );
  // Opening the dialog always resets to the choice.
  assert.match(ORDERS, /setResolutionStep\("choose"\);\s*\n?\s*setResolutionDialog\(\{ orderId: order\.id/);
  void entry;
});

test("both resolutions are offered, in the owner's words", () => {
  assert.match(ORDERS, /إنشاء طلب بديل/, "Resolution A");
  assert.match(ORDERS, /إنهاء الطلب ورد العربون/, "Resolution B");
});

test("Resolution A · a replacement never refunds the deposit", () => {
  // The button navigates to the order-entry screen and writes nothing.
  assert.match(ORDERS, /navigateToReplacement\(resolutionDialog\.orderId\)/);
  const nav = ORDERS.slice(
    ORDERS.indexOf("const navigateToReplacement"),
    ORDERS.indexOf("const navigateToReplacement") + 400,
  );
  assert.ok(!/refundOrderDeposit|appendEvent|buildOrder/.test(nav),
    "raising a replacement must move no money at all");
  assert.match(nav, /exchangeOf=/, "it hands off to the screen that links the two orders");
  // …and it is labelled so the operator knows the deposit stays put.
  assert.match(ORDERS, /إنشاء طلب بديل — العربون يفضل محجوز/);
});

test("Resolution A · the entry screen links B to A rather than editing A", () => {
  const entry = strip(read("../src/routes/ecommerce-orders.tsx"));
  assert.match(entry, /searchParams\.get\("exchangeOf"\)/, "it accepts the original");
  assert.match(entry, /original_order_id: originalOrderId/, "and links the new document");
  // Nothing on that screen refunds a deposit.
  assert.ok(!/refundOrderDeposit/.test(entry), "the entry screen cannot refund");
});

test("Resolution B · declining step one writes nothing", () => {
  // Backing out of the refund form returns to the choice; it does not act.
  assert.match(ORDERS, /رجوع — نحتفظ بالعربون/);
  assert.match(ORDERS, /onClick=\{\(\) => setResolutionStep\("choose"\)\}/);
});

test("the claim is stated as independent on BOTH steps", () => {
  // Step one, where the operator is choosing…
  assert.match(ORDERS, /تعويض شركة الشحن حاجة تانية مستقلة — أياً كان اختيارك/);
  // …and step two, at the moment money moves.
  assert.match(ORDERS, /تعويض شركة الشحن حاجة تانية مستقلة — رد العربون مش بيلغيه/);
});

test("OWNER DECISION · shop-caused follows the same non-automatic principle", () => {
  // Settled 2026-09-22: the same rule as courier unless explicitly overridden.
  // No automatic refund was invented, and none exists.
  assert.equal(depositDispositionOn("shop", "return"), "pending_resolution");
  assert.equal(depositDispositionOn("courier", "return"), "pending_resolution");
  assert.equal(depositDispositionOn("customer", "return"), "forfeit");
  // The resolution is offered for both, and only for those two.
  assert.equal(depositRefundEligible("shop"), true);
  assert.equal(depositRefundEligible("courier"), true);
  assert.equal(depositRefundEligible("customer"), false);
  assert.equal(depositRefundEligible("unknown"), false);
});

test("there is NO code path from a courier cause to an automatic refund", () => {
  // The whole decision, asserted as an absence. `pending_resolution` is the
  // only thing a courier- or shop-caused return can produce, and the single
  // way out of it is the explicitly-authorised RPC.
  for (const cause of ["courier", "shop"]) {
    assert.notEqual(depositDispositionOn(cause, "return"), "none",
      `${cause} must never resolve to "no deposit held"`);
  }
  // The builders have no automatic refund branch keyed on a cause: the only
  // refund field is passed explicitly by a caller.
  const builders = strip(read("../src/lib/ledger/orders.ts"));
  assert.ok(!/depositDispositionOn|return_cause/.test(builders),
    "the ledger builders must not decide a disposition for themselves");
  // And the one refund path is the RPC, which requires an operator's call.
  assert.ok(!/refund_order_deposit/.test(strip(read("../src/lib/shippingRates.ts"))),
    "no policy function may invoke the refund");
});

// ═══════════════════════════════════════════════════════════════════════════
// SETTLEMENT INTEGRATION — the claim closes against the EXISTING event
// ═══════════════════════════════════════════════════════════════════════════

const M041 = read("../docs/migrations/041_settled_claim_is_frozen.sql");
const M041C = sql(M041);
const LEDGERPAGE = strip(read("../src/components/ecommerce/CourierLedgerPage.tsx"));

test("no second settlement system — the existing event is reused", () => {
  // One event kind settles a courier, and this migration adds no other. No new
  // money, no new RPC that writes a settlement.
  assert.ok(!/CREATE (OR REPLACE )?FUNCTION[\s\S]{0,200}settle_courier/i.test(M041C));
  assert.ok(!/INSERT INTO public\.ledger_/.test(M041C), "the guard writes no ledger row");
  // The screen appends the SAME `courier_settlement` it always did, and simply
  // keeps its id.
  assert.match(LEDGERPAGE, /const settlementEventId = await appendEvent\(\{/);
  assert.match(LEDGERPAGE, /kind: "courier_settlement"/);
});

test("the UI never sets the status directly — it passes the real event", () => {
  // There is no status dropdown on this screen. The only call names `settled`
  // together with the id of the event that just moved the money.
  assert.match(
    LEDGERPAGE,
    /advanceClaim\(\{ claimId: claim\.id, to: "settled", settlementEventId \}\)/,
  );
  // …and only APPROVED claims are offered, because a claim the company has not
  // agreed to is not something a transfer closes.
  assert.match(LEDGERPAGE, /c\.status === "approved"/);
});

test("`settled` requires an event that moved THIS courier's receivable", () => {
  // Checked against the ledger LINE, not a label: the batch path puts the
  // courier in the payload and the per-order path does not name it at all, so
  // neither `ref_id` nor the payload is a reliable place to ask.
  assert.match(M041C, /e\.kind = 'courier_settlement'/);
  assert.match(M041C, /l\.account = 'receivable_courier'/);
  assert.match(M041C, /l\.subject_id = NEW\.courier_id/);
  assert.match(M041C, /NEXUS_CLAIM_SETTLEMENT_EVENT_MISMATCH/);
});

test("a settled claim is frozen — found by probing 040, not by reading it", () => {
  // The unchanged-status early return left every OTHER column editable, so a
  // closed claim could be re-pointed at a `sale` and its amount rewritten. The
  // amount is the snapshot the ledger line is reconciled against; one that can
  // be edited afterwards reconciles with anything.
  assert.match(M041C, /IF OLD\.status IN \('settled', 'rejected'\) THEN/);
  // The STATUS itself is the first thing frozen, and it has to be: the
  // terminal block `RETURN NEW`s, so the transition table below never runs for
  // a closed claim. Drop this one term and a settled claim can be flipped back
  // to `approved` — the `ELSE false` that looks like it would stop that is
  // unreachable from here. A mutation run is what surfaced it.
  assert.match(
    M041C,
    /IF NEW\.status IS DISTINCT FROM OLD\.status\s*\r?\n\s*OR NEW\.settlement_event_id/,
    "a closed claim's status must be frozen by the terminal block itself",
  );
  for (const col of [
    "settlement_event_id",
    "amount_piastres",
    "order_id",
    "courier_id",
    "return_record_id",
  ]) {
    assert.ok(
      // `\\.` and `\\s`, doubled: inside a template literal JavaScript eats the
      // single backslash before the RegExp ever sees it, so `\.` became a
      // wildcard and `\s` became a literal "s" — the pattern silently stopped
      // matching anything and the freeze looked absent.
      new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`).test(M041C),
      `${col} must be frozen on a closed claim`,
    );
  }
  assert.match(M041C, /NEXUS_CLAIM_IS_CLOSED/);
  // The freeze is checked BEFORE the unchanged-status shortcut, which is
  // exactly where the gap was.
  assert.ok(
    M041C.indexOf("IF OLD.status IN ('settled', 'rejected')") <
      M041C.indexOf("IF OLD.status = NEW.status THEN"),
    "the freeze must come before the early return it was hiding behind",
  );
  // Notes stay writable: a later note distorts no figure.
  assert.ok(!/NEW\.notes\s+IS DISTINCT FROM OLD\.notes/.test(M041C));
});

test("settling a claim does not touch the deposit, on the screen too", () => {
  // The settlement screen knows nothing about deposits.
  assert.ok(
    !/refundOrderDeposit|deposit_pending_resolution|forfeitedDeposit|pendingDeposit/.test(
      LEDGERPAGE,
    ),
    "the courier settlement screen must not reach the customer's deposit",
  );
  // …and the guard reads no deposit account.
  assert.ok(!/deposit/i.test(M041C.replace(/NEXUS_CLAIM[A-Z_]*/g, "")));
});

test("the claim half fails safe — the money is recorded first", () => {
  // The settlement is the financial fact; the claim is a note about it. If the
  // claim update fails the transfer has still landed correctly and the claim
  // stays `approved`, recoverable next time. The reverse order would mark a
  // claim settled against an event that might never be written.
  const confirm = LEDGERPAGE.slice(
    LEDGERPAGE.indexOf("const confirmBatch"),
    LEDGERPAGE.indexOf("const confirmBatch") + 4000,
  );
  assert.ok(
    confirm.indexOf("await appendEvent") < confirm.indexOf("advanceClaim"),
    "the event is written before any claim is closed",
  );
  assert.match(LEDGERPAGE, /التحويلة اتسجلت والفلوس اتحركت، لكن/, "and the operator is told");
});

test("the operator is told the two are unrelated, on the settlement screen", () => {
  assert.match(LEDGERPAGE, /قفل المطالبة مالوش أي علاقة بعربون العميلة/);
  assert.match(LEDGERPAGE, /مش بيزوّد المبلغ/, "and that it adds nothing to the transfer");
});
