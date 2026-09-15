/**
 * How a refund actually reaches the customer, and who ends up paying.
 *
 * Three rules meet on the return confirmation, and each was being applied with
 * one axis missing:
 *
 *   §3  a delivery that failed through the COURIER's fault was billed to the
 *       shop or to the customer, because `courier` was not a cause;
 *   §4  the deposit was kept on EVERY return, though the rule is about a
 *       customer who walked away;
 *   §5  the refund always debited a till, though a returned COD order's cash
 *       was never in that till — the courier is still holding it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildReturnConfirmedLines,
  buildOrderRTOLines,
} from "../src/lib/ledger/orders.ts";
import { shippingBorneBy, depositForfeitedOn } from "../src/lib/shippingRates.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const base = {
  items: [{ productId: "A", quantity: 1, unitPrice: 300, unitCost: 100 }],
  refundAmount: 300,
  wallet: "inStoreSafe",
  revenueAmount: 300,
  courierId: "cr1",
  customerId: "c1",
  channel: "ecommerce",
};

const amountOn = (lines, account, subjectId) =>
  lines
    .filter((l) => l.account === account && (subjectId === undefined || l.subjectId === subjectId))
    .reduce((s, l) => s + (l.amount ?? 0), 0);

// ── §5 the refund route ─────────────────────────────────────────────────────

test("a cash refund leaves the till, as it always did", () => {
  const lines = buildReturnConfirmedLines({ ...base });
  assert.equal(amountOn(lines, "wallet", "inStoreSafe"), -300);
  assert.equal(amountOn(lines, "receivable_courier"), 0, "no courier effect");
});

test("a courier-settled refund does NOT touch the till", () => {
  // The COD case: that money never reached us, so paying it out of the till
  // would refund the customer from cash we never received.
  const lines = buildReturnConfirmedLines({ ...base, refundVia: "courier" });
  assert.equal(amountOn(lines, "wallet"), 0, "no treasury debit");
  assert.equal(
    amountOn(lines, "receivable_courier", "cr1"),
    -300,
    "what the courier owes us falls by the refund they are handling",
  );
});

test("a courier-settled refund needs a courier to settle against", () => {
  assert.throws(
    () => buildReturnConfirmedLines({ ...base, courierId: undefined, refundVia: "courier" }),
    /needs a courier/,
  );
});

test("a retained deposit is never refunded, whichever route is used", () => {
  for (const refundVia of ["wallet", "courier"]) {
    const lines = buildReturnConfirmedLines({ ...base, refundVia, forfeitedDeposit: 100 });
    const out = refundVia === "wallet"
      ? amountOn(lines, "wallet", "inStoreSafe")
      : amountOn(lines, "receivable_courier", "cr1");
    assert.equal(out, -200, `${refundVia}: only 300 − 100 goes back`);
    assert.equal(
      amountOn(lines, "revenue", "forfeited_deposit"),
      100,
      "and the kept part is named as income, not left unexplained",
    );
  }
});

test("a partial refund moves exactly what was asked for", () => {
  const lines = buildReturnConfirmedLines({ ...base, refundAmount: 120, revenueAmount: 120 });
  assert.equal(amountOn(lines, "wallet", "inStoreSafe"), -120);
});

// ── §3 who bears the courier's fee ──────────────────────────────────────────

const feeLines = (cause) =>
  buildReturnConfirmedLines({
    ...base,
    returnFee: 40,
    movement: "return",
    feeBorneBy: shippingBorneBy(cause, "return"),
  });

test("a shop-caused return is the shop's cost", () => {
  const lines = feeLines("shop");
  assert.equal(amountOn(lines, "expense", "shipping_return"), 40);
  assert.equal(amountOn(lines, "payable_courier", "cr1"), 40, "we still owe them the trip");
});

test("a courier-caused return costs the shop nothing", () => {
  const lines = feeLines("courier");
  assert.equal(
    amountOn(lines, "expense", "shipping_return"),
    0,
    "their failure must never land as our expense",
  );
  assert.equal(amountOn(lines, "payable_courier", "cr1"), 40, "the trip was still made");
  assert.equal(
    amountOn(lines, "receivable_courier", "cr1"),
    40,
    "and they compensate us for it — net zero to the shop",
  );
});

test("a customer-caused return is recovered from the customer, not absorbed", () => {
  const lines = feeLines("customer");
  assert.equal(amountOn(lines, "expense", "shipping_return"), 0);
  assert.equal(amountOn(lines, "receivable_courier", "cr1"), 40);
});

test("an unclassified return keeps the pre-026 accounting exactly", () => {
  const lines = feeLines("unknown");
  assert.equal(amountOn(lines, "expense", "shipping_return"), 40, "the shop bore it before");
});

// ── §4 the deposit, by cause ────────────────────────────────────────────────

test("an RTO the customer caused keeps the deposit and books it as income", () => {
  assert.equal(depositForfeitedOn("customer", "return"), true);
  const lines = buildOrderRTOLines({
    items: base.items,
    forfeitedDeposit: 50,
    customerId: "c1",
  });
  assert.equal(amountOn(lines, "revenue", "forfeited_deposit"), 50);
  assert.equal(amountOn(lines, "wallet"), 0, "the money never moved — it was already ours");
});

test("an RTO the courier caused gives the deposit back", () => {
  assert.equal(depositForfeitedOn("courier", "return"), false);
  const lines = buildOrderRTOLines({
    items: base.items,
    refundedDeposit: 50,
    wallet: "inStoreSafe",
    customerId: "c1",
  });
  assert.equal(amountOn(lines, "wallet", "inStoreSafe"), -50);
  assert.equal(amountOn(lines, "revenue", "forfeited_deposit"), 0);
});

test("an RTO the shop caused gives the deposit back too", () => {
  assert.equal(depositForfeitedOn("shop", "return"), false);
});

// ── the screens must actually ask ───────────────────────────────────────────

test("the confirm dialog asks how the refund is settled", () => {
  const src = read("../src/components/ecommerce/OrdersPage.tsx");
  assert.match(src, /المسترد هيترد إزاي؟/, "the operator must choose, not the code guess");
  assert.match(src, /refundVia,/, "and the choice must reach the ledger");
  // The treasury picker only makes sense for a cash refund.
  assert.match(src, /refundVia === "wallet" && \(/);
});

test("the cause picker offers the courier, with its own consequence line", () => {
  const src = read("../src/lib/shippingRates.ts");
  assert.match(src, /courier: "المندوب \/ شركة الشحن"/);
  // The consequence text is keyed by cause, so it changes as the choice changes.
  assert.match(src, /RETURN_CAUSE_HINTS: Record<ReturnCause, string>/);
});
