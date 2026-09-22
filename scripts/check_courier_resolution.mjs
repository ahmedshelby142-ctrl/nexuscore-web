/**
 * Courier-caused return → claim, replacement, and the deposit exception.
 *
 * The workflow these cover has days in the middle of it:
 *
 *   the courier causes the return
 *     → the shop claims compensation from them
 *       → the customer says whether they still want the goods
 *         → ONLY THEN is the deposit resolved
 *
 * So the confirmation must NOT resolve the deposit — and for a long time it
 * did, automatically, in the customer's favour, with nobody deciding and
 * nothing recording that a decision had been made. That is a blanket refund
 * rule, and it is the mirror of the blanket forfeit these tests also refuse.
 *
 * Reference: docs/RETURN_EXCHANGE_POLICY.md,
 *            docs/migrations/038_courier_return_deposit_resolution.sql
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildReturnConfirmedLines } from "../src/lib/ledger/orders.ts";
import {
  shippingBorneBy,
  depositDispositionOn,
  depositRefundEligible,
  countsAsWastedTrip,
  compensationExpectedFrom,
} from "../src/lib/shippingRates.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const MIGRATION = read("../docs/migrations/038_courier_return_deposit_resolution.sql");
const ORDERS = strip(read("../src/components/ecommerce/OrdersPage.tsx"));
const SERVICE = strip(read("../src/services/depositResolution.ts"));

/** Net amount on an account, in EGP — the builders convert to piastres later. */
const on = (lines, account, subject) =>
  lines
    .filter((l) => l.account === account && (subject === undefined || l.subjectId === subject))
    .reduce((sum, l) => sum + (l.amount ?? 0), 0);

const ITEM = { productId: "A", quantity: 1, unitPrice: 500, unitCost: 300 };

function bookReturn({ cause, movement = "return", deposit = 200, fee = 40 }) {
  return buildReturnConfirmedLines({
    items: [ITEM],
    refundAmount: 500,
    revenueAmount: 500,
    wallet: "inStoreSafe",
    courierId: "cr1",
    customerId: "c1",
    returnFee: fee,
    movement,
    feeBorneBy: shippingBorneBy(cause, movement),
    forfeitedDeposit: depositDispositionOn(cause, movement) === "forfeit" ? deposit : 0,
    pendingDeposit:
      depositDispositionOn(cause, movement) === "pending_resolution" ? deposit : 0,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// S2 · a courier-caused return raises a claim AND holds the deposit
// ═══════════════════════════════════════════════════════════════════════════

test("S2 · the claim is raised and the deposit is held, not refunded", () => {
  const lines = bookReturn({ cause: "courier" });

  assert.equal(compensationExpectedFrom("courier", "return"), "courier");
  assert.equal(
    lines.filter((l) => l.account === "receivable_courier" && l.amount === 40).length,
    1,
    "compensation is receivable from the provider",
  );
  assert.equal(on(lines, "expense"), 0, "and is never the shop's expense");

  assert.equal(on(lines, "revenue", "deposit_pending_resolution"), 200, "held");
  assert.equal(on(lines, "revenue", "forfeited_deposit"), 0, "not earned");
  assert.equal(on(lines, "wallet", "inStoreSafe"), -300, "and NOT handed back today");
});

test("the confirmation no longer decides the deposit for a shop-caused return either", () => {
  const lines = bookReturn({ cause: "shop" });
  assert.equal(on(lines, "revenue", "deposit_pending_resolution"), 200);
  assert.equal(on(lines, "wallet", "inStoreSafe"), -300, "no automatic refund");
});

// ═══════════════════════════════════════════════════════════════════════════
// Compensation ≠ deposit refund
// ═══════════════════════════════════════════════════════════════════════════

test("compensation and deposit refund are separate, and stay separate", () => {
  // The brief's example: claim 40 from the courier, hand 200 back to the
  // customer. Different amounts, different counterparties, different events —
  // one settles at the courier batch, the other through `refund_order_deposit`.
  const lines = bookReturn({ cause: "courier" });
  // The claim is 40, owed to us by the courier. The held deposit is 200, owed
  // by us to the customer. Different amounts, parties and settlement paths.
  assert.equal(
    lines.filter((l) => l.account === "receivable_courier" && l.amount === 40).length,
    1,
    "the claim",
  );
  assert.equal(on(lines, "revenue", "deposit_pending_resolution"), 200, "the deposit");

  // The refund must touch ONLY the deposit subject. Moving the claim here
  // would quietly forgive the courier because a customer was paid.
  const refundLines = MIGRATION.slice(MIGRATION.indexOf("v_lines := jsonb_build_array"));
  assert.ok(!/receivable_courier/.test(refundLines), "the refund must not move the claim");
  assert.ok(!/payable_courier/.test(refundLines));
});

// ═══════════════════════════════════════════════════════════════════════════
// S3 · replacement order — linked, never merged
// ═══════════════════════════════════════════════════════════════════════════

test("S3 · a replacement order is linked to the original, never merged into it", () => {
  // Order B is its own document with its own placement, delivery and shipping
  // cost. The link is `original_order_id`, derived from the documents.
  // Written by the ORDER-ENTRY screen, which is where a replacement is raised.
  const entry = strip(read("../src/routes/ecommerce-orders.tsx"));
  assert.match(
    entry,
    /original_order_id: originalOrderId/,
    "the replacement carries a real column pointing back at the original",
  );
  const exchange = strip(read("../src/lib/exchange.ts"));
  assert.match(
    exchange,
    /allOrders\.some\(\(o\) => o\.id !== order\.id && o\.original_order_id === order\.id\)/,
    "the relationship is derived, not stored on the original",
  );
  // Nothing rewrites Order A's history: the ledger cannot be updated at all.
  assert.match(MIGRATION, /append-only/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// S4 / S5 · the resolution
// ═══════════════════════════════════════════════════════════════════════════

test("S4 · the refund is a real financial event, decided server-side", () => {
  assert.match(MIGRATION, /'kind', 'deposit_refunded'/);
  assert.match(MIGRATION, /'account', 'wallet'[\s\S]{0,140}'amount_delta', -v_pending/);
  assert.match(MIGRATION, /PERFORM public\.ledger_append\(/, "through the atomic path");
  // The client sends no amount, so it cannot ask for more than was left.
  assert.match(SERVICE, /p_order_id:/);
  assert.match(SERVICE, /p_wallet:/);
  assert.ok(!/p_amount/.test(SERVICE), "the amount is the server's to decide");
  // …and it is not UI-only: the screen calls the RPC and refreshes, it does
  // not adjust a local number.
  assert.match(ORDERS, /await refundOrderDeposit\(\{/);
});

test("S4 · LTV follows the money back out", () => {
  // Revenue and LTV moved together when the deposit was held; reversing one
  // without the other would leave the CRM crediting the customer with money
  // they were handed back.
  assert.match(MIGRATION, /'account', 'customer_ltv'[\s\S]{0,140}'amount_delta', -v_pending/);
});

test("S5 · declining the refund writes nothing at all", () => {
  // There is no "keep" action, deliberately: holding is what already happened
  // at confirmation, so declining is simply not acting.
  assert.match(ORDERS, /إلغاء — نحتفظ بالعربون/, "declining is explicit and inert");
});

// ═══════════════════════════════════════════════════════════════════════════
// S11 · no duplicate refund
// ═══════════════════════════════════════════════════════════════════════════

test("S11 · a second refund is refused by the ledger itself", () => {
  assert.match(MIGRATION, /subject_id = 'deposit_pending_resolution'/, "reads the balance");
  assert.match(
    MIGRATION,
    /IF v_pending <= 0 THEN\s*RAISE EXCEPTION 'NEXUS_NOTHING_TO_REFUND'/,
    "and refuses when nothing is standing",
  );
  assert.match(
    MIGRATION,
    /'subject_id', 'deposit_pending_resolution',[\s\S]{0,80}'amount_delta', -v_pending/,
    "the reversal lands on the same subject, so a second call finds zero",
  );
  // Without the lock, two operators would both read a non-zero balance.
  assert.match(MIGRATION, /pg_advisory_xact_lock/, "the check is made atomic");
  // No parallel flag: a column on `orders` would be editable by three roles,
  // including ones that cannot perform a refund at all. The migration's prose
  // names `depositRefundedAt` to explain why it adds none, so the assertion
  // looks for the DDL that would create one rather than for the word.
  assert.ok(
    !/ALTER TABLE[\s\S]{0,160}depositRefundedAt/i.test(MIGRATION),
    "no parallel flag column — nothing to get out of step",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// S12 · authorization
// ═══════════════════════════════════════════════════════════════════════════

test("S12 · only ADMIN and ACCOUNTANT may refund, and the POLICY says so", () => {
  // SQL comments stripped first. The policy body carries a `--` note that
  // explains what the ELSE branch would otherwise do, and it sits BEFORE the
  // kind — so slicing on the raw text found the word in the prose and produced
  // an empty branch. An assertion that cannot tell a comment from code fails
  // on good documentation.
  const insertPolicy = MIGRATION.slice(
    MIGRATION.indexOf("CREATE POLICY insert_ledger_events"),
    MIGRATION.indexOf("-- ── 2."),
  ).replace(/--[^\n]*/g, "");
  assert.ok(insertPolicy.includes("'deposit_refunded'::text"), "the kind is listed");
  const moneyBranch = insertPolicy.slice(
    insertPolicy.indexOf("'deposit_refunded'::text"),
    insertPolicy.indexOf("ELSE"),
  );
  assert.match(
    moneyBranch,
    /ARRAY\['ADMIN'::text, 'ACCOUNTANT'::text\]/,
    "on the branch that admits only the money roles",
  );
  const elseBranch = insertPolicy.slice(insertPolicy.indexOf("ELSE"));
  assert.ok(
    !/deposit_refunded/.test(elseBranch),
    "and must not fall through to the four-role branch",
  );
});

test("S12 · the function is INVOKER, so the policy is the gate and not a copy", () => {
  assert.ok(
    !/SECURITY DEFINER/.test(MIGRATION),
    "a DEFINER function would re-implement every check by hand",
  );
  assert.match(MIGRATION, /FROM anon/, "and anon holds no EXECUTE");
  // Tenant isolation comes from the same policy as every other read.
  assert.match(MIGRATION, /SELECT \* INTO v_order FROM public\.orders WHERE id = p_order_id/);
  assert.match(MIGRATION, /RAISE EXCEPTION 'NEXUS_ORDER_NOT_FOUND'/);
});

test("the client never decides eligibility on its own", () => {
  assert.equal(depositRefundEligible("courier"), true);
  assert.equal(depositRefundEligible("shop"), true);
  assert.equal(depositRefundEligible("customer"), false, "Rule A is not case-by-case");
  assert.equal(depositRefundEligible("unknown"), false);
  assert.match(
    MIGRATION,
    /NOT IN \('courier', 'shop'\)[\s\S]{0,60}RAISE EXCEPTION 'NEXUS_CAUSE_NOT_ELIGIBLE'/,
    "the server re-decides it",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// The distinction itself
// ═══════════════════════════════════════════════════════════════════════════

test("a courier-caused return is NOT filed as a customer cancellation", () => {
  assert.equal(countsAsWastedTrip("courier", "return"), false, "no debt on the customer");
  assert.notEqual(depositDispositionOn("courier", "return"), "forfeit", "not Rule A");
  assert.notEqual(shippingBorneBy("courier", "return"), "customer", "not their cost");
});

test("the UI separates cause, responsibility and resolution", () => {
  assert.match(ORDERS, /سبب المرتجع|سبب الاستبدال/, "the cause");
  assert.match(ORDERS, /المسؤول المالي/, "the financial responsibility");
  assert.match(ORDERS, /تسوية العميلة/, "and the resolution, as its own step");
  // The refund does not cancel the claim, and the dialog says so out loud.
  assert.match(ORDERS, /تعويض شركة الشحن حاجة تانية مستقلة/);
});

test("the resolution is offered only where it is eligible", () => {
  assert.match(
    ORDERS,
    /depositRefundEligible\(toReturnCause\(order\.return_cause\)\)/,
    "gated on the cause",
  );
  assert.match(ORDERS, /order\.returnConfirmedAt &&/, "and only once the goods are back");
});
