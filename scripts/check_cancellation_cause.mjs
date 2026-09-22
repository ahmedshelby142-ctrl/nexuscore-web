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
  assert.match(M039C, /WHEN 'pending'\s*THEN NEW\.status IN \('submitted', 'rejected'\)/);
  assert.match(M039C, /WHEN 'submitted' THEN NEW\.status IN \('approved', 'rejected'\)/);
  assert.match(M039C, /WHEN 'approved'\s*THEN NEW\.status = 'settled'/);
  assert.match(M039C, /ELSE false/, "settled and rejected are terminal");
  assert.match(M039C, /NEXUS_CLAIM_MUST_START_PENDING/);
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
