/**
 * نظرة عامة — the §1.3 scenario for the summary screen.
 *
 * Feeds the REAL sale/return builders into the REAL `summarise()` the screen
 * renders, so a POS sale has to move "عدد العمليات", the revenue behind the
 * trend, and net profit. The screen it replaced read a `transactions` store
 * and a hardcoded "+12.5%", neither of which moved when the shop traded.
 *
 *     node --test scripts/check_dashboard.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { summarise, windowFor, trendDays, TREND_DAYS } from "../src/lib/dashboard.ts";
import { buildSaleLines } from "../src/lib/ledger/sales.ts";

const WALLET = "inStoreSafe";
const SHOE = "p-shoe";

/** Roll lines up the way `balances({ account })` does, per subject. */
function rows(lines, account) {
  const totals = new Map();
  for (const l of lines.filter((x) => x.account === account)) {
    totals.set(l.subjectId, (totals.get(l.subjectId) ?? 0) + (l.amount ?? 0));
  }
  return [...totals].map(([subjectId, amount]) => ({ account, subjectId, amount, qty: 0 }));
}

const summaryOf = (lines, events) =>
  summarise({
    revenueRows: rows(lines, "revenue"),
    cogsRows: rows(lines, "cogs"),
    expenseRows: rows(lines, "expense"),
    events,
  });

const sale = (total, cost) =>
  buildSaleLines({
    items: [{ productId: SHOE, quantity: 1, unitPrice: total, unitCost: cost }],
    wallet: WALLET,
  });

test("an empty day reads zeros, not blanks", () => {
  const s = summaryOf([], []);
  assert.deepEqual(
    [s.revenue, s.netProfit, s.orders, s.returns, s.avgOrderValue, s.topProductId],
    [0, 0, 0, 0, 0, null],
  );
});

test("a POS sale of 300 moves orders, revenue and net profit", () => {
  const s = summaryOf(sale(300, 120), [{ kind: "sale" }]);

  assert.equal(s.orders, 1, "the sale counts as one operation");
  assert.equal(s.revenue, 300, "the trend's total for the period");
  assert.equal(s.netProfit, 180, "300 revenue − 120 cost");
  assert.equal(s.avgOrderValue, 300);
  assert.equal(s.topProductId, SHOE, "the goods that left came from this product");
});

test("a second sale takes orders to 2 and averages the two", () => {
  const lines = [...sale(300, 120), ...sale(100, 40)];
  const s = summaryOf(lines, [{ kind: "sale" }, { kind: "sale" }]);

  assert.equal(s.orders, 2);
  assert.equal(s.revenue, 400);
  assert.equal(s.netProfit, 240, "400 − 160");
  assert.equal(s.avgOrderValue, 200);
});

test("an online order placed counts as an operation; a return counts as a return", () => {
  const s = summaryOf(sale(300, 120), [
    { kind: "sale" },
    { kind: "order_placed" },
    { kind: "return_confirmed" },
  ]);
  assert.equal(s.orders, 2, "sale + order_placed");
  assert.equal(s.returns, 1);
});

test("a return is not subtracted twice — revenue already carries it", () => {
  // `return_confirmed` writes `revenue −`; the screen must not deduct again.
  const returned = [{ account: "revenue", subjectId: "pos", amount: -300 }];
  const s = summaryOf([...sale(300, 120), ...returned], [
    { kind: "sale" },
    { kind: "return_confirmed" },
  ]);
  assert.equal(s.revenue, 0, "sold 300, returned 300");
  assert.equal(s.netProfit, -120, "the cost stays booked until the return reverses cogs too");
});

test("the period windows are honest: today starts at midnight", () => {
  const now = new Date("2026-08-18T15:30:00");
  const today = windowFor("today", now);
  assert.equal(today.from.getHours(), 0);
  assert.equal(today.from.getDate(), 18);
  assert.equal(today.to.getTime(), now.getTime(), "up to this moment, exclusive");

  const month = windowFor("month", now);
  assert.equal(month.from.getDate(), 20, "30 days back from 18 Aug is 20 Jul");
  assert.equal(month.from.getMonth(), 6);
});

test("the trend asks for contiguous, non-overlapping days ending today", () => {
  const now = new Date("2026-08-18T15:30:00");
  const days = trendDays("week", now);

  assert.equal(days.length, TREND_DAYS.week);
  assert.equal(days[days.length - 1].from.getDate(), 18, "last bucket is today");
  for (let i = 1; i < days.length; i++) {
    assert.equal(
      days[i].from.getTime(),
      days[i - 1].to.getTime(),
      "each day starts exactly where the previous ended — no gap, no double count",
    );
  }
});
