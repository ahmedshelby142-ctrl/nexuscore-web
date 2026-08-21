/**
 * التقارير المالية — the §1.3 scenario for 7.4.
 *
 *     node --test scripts/check_financial_report.mjs
 *
 * The scenario the brief asks for: a sale, a purchase, an expense and a return
 * in ONE period, and the P&L has to net correctly and agree with what each
 * individual screen already shows.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildSaleLines } from "../src/lib/ledger/sales.ts";
import { buildPurchaseLines } from "../src/lib/ledger/purchases.ts";
import { buildExpenseLines } from "../src/lib/ledger/expenses.ts";
import { buildReturnConfirmedLines } from "../src/lib/ledger/orders.ts";
import {
  pnl,
  buckets,
  periodWindow,
  customWindow,
  defaultGranularity,
  SHIPPING_SUBJECTS,
} from "../src/lib/ledger/reports.ts";

const WALLET = "inStoreSafe";

/** What `balances({ account, from, to })` returns: one row per subject. */
function rowsOf(lines, account) {
  const totals = new Map();
  for (const l of lines) {
    if (l.account !== account) continue;
    totals.set(l.subjectId, (totals.get(l.subjectId) ?? 0) + (l.amount ?? 0));
  }
  return [...totals].map(([subjectId, amount]) => ({ subjectId, amount }));
}

const totalOf = (lines, account) => rowsOf(lines, account).reduce((s, r) => s + r.amount, 0);

// ── §1.3: one period, four events ───────────────────────────────────────────

/**
 * Bought 10 units at 60 (600 out of the till), sold 4 at 100 (400 in),
 * paid 150 rent, then the customer sent 1 unit back (100 refunded, 25 courier
 * return fee that the SHOP pays).
 */
function scenario() {
  const purchase = buildPurchaseLines({
    supplierId: "sup-1",
    wallet: WALLET,
    items: [{ productId: "p1", quantity: 10, unitCost: 60 }],
    paidAmount: 600,
  });

  const sale = buildSaleLines({
    wallet: WALLET,
    items: [{ productId: "p1", quantity: 4, unitPrice: 100, unitCost: 60 }],
  });

  const expense = buildExpenseLines({
    category: "store_rent",
    amount: 150,
    wallet: WALLET,
  });

  const ret = buildReturnConfirmedLines({
    wallet: WALLET,
    items: [{ productId: "p1", quantity: 1, unitCost: 60 }],
    refundAmount: 100,
    revenueAmount: 100,
    returnFee: 25,
    courierId: "cour-1",
    movement: "return",
    channel: "pos",
  });

  return { purchase, sale, expense, ret, all: [...purchase, ...sale, ...expense, ...ret] };
}

test("§1.3: sale + purchase + expense + return in one period nets correctly", () => {
  const { all, purchase } = scenario();

  const report = pnl({
    revenueRows: rowsOf(all, "revenue"),
    expenseRows: rowsOf(all, "expense"),
    cogs: totalOf(all, "cogs"),
    returnsRevenue: totalOf([...scenario().ret], "revenue"),
    purchases: totalOf(purchase, "stock"),
  });

  // Sales: 400 sold, 100 came back. SUM(revenue) is already the net.
  assert.equal(report.netSales, 300, "revenue is net of the return, not gross");
  assert.equal(report.returns, 100, "the return is SHOWN as a positive figure");

  // COGS: 4 × 60 out, 1 × 60 back.
  assert.equal(report.cogs, 180, "the returned unit stops being a cost of goods SOLD");

  // Expenses: 150 rent + 25 courier return fee.
  assert.equal(report.opex, 150, "rent only — shipping is split out of it");
  assert.equal(report.shipping, 25, "the return fee is the shop's only shipping cost");
  assert.equal(report.expenses, 175, "opex + shipping is exactly SUM(expense)");

  // The whole point: 300 − 180 − 175.
  assert.equal(report.netProfit, -55);
});

test("returns are never subtracted twice", () => {
  const { all, ret } = scenario();
  const report = pnl({
    revenueRows: rowsOf(all, "revenue"),
    expenseRows: rowsOf(all, "expense"),
    cogs: totalOf(all, "cogs"),
    returnsRevenue: totalOf(ret, "revenue"),
    purchases: 0,
  });

  // The naive reading of the brief — revenue − (COGS + expenses + returns).
  const doubleCounted = report.netSales - report.cogs - report.expenses - report.returns;
  assert.equal(report.netProfit - doubleCounted, 100, "off by exactly the return value");
  assert.equal(report.netProfit, -55, "the ledger definition wins");
});

test("purchases are NOT a P&L line — cash became inventory", () => {
  const { all, purchase } = scenario();
  const report = pnl({
    revenueRows: rowsOf(all, "revenue"),
    expenseRows: rowsOf(all, "expense"),
    cogs: totalOf(all, "cogs"),
    returnsRevenue: 0,
    purchases: totalOf(purchase, "stock"),
  });

  assert.equal(report.purchases, 600, "reported, because the owner asked for it");
  // 600 left the till, but only the 180 that was actually SOLD is a cost.
  assert.equal(report.netProfit, report.netSales - report.cogs - report.expenses);
});

test("shipping is a SUBSET of expenses, never an extra term", () => {
  const rows = [
    { subjectId: "store_rent", amount: 1000 },
    { subjectId: "shipping", amount: 40 },
    { subjectId: "shipping_return", amount: 25 },
    { subjectId: "shrinkage", amount: 15 },
  ];
  const report = pnl({
    revenueRows: [],
    expenseRows: rows,
    cogs: 0,
    returnsRevenue: 0,
    purchases: 0,
  });

  assert.equal(report.shipping, 65);
  assert.equal(report.opex, 1015);
  assert.equal(report.expenses, 1080, "the two halves add back up to SUM(expense)");
  assert.equal(report.netProfit, -1080, "shipping counted once");
  assert.deepEqual([...SHIPPING_SUBJECTS], ["shipping", "shipping_return"]);
});

test("a جرد surplus reduces expenses instead of inventing revenue", () => {
  const report = pnl({
    revenueRows: [{ subjectId: "pos", amount: 500 }],
    expenseRows: [{ subjectId: "shrinkage", amount: -30 }],
    cogs: 200,
    returnsRevenue: 0,
    purchases: 0,
  });
  assert.equal(report.expenses, -30);
  assert.equal(report.netProfit, 330);
  assert.equal(report.netSales, 500, "a surplus is not a sale");
});

test("channels are listed biggest first", () => {
  const report = pnl({
    revenueRows: [
      { subjectId: "pos", amount: 100 },
      { subjectId: "wholesale", amount: 900 },
      { subjectId: "ecommerce", amount: 400 },
    ],
    expenseRows: [],
    cogs: 0,
    returnsRevenue: 0,
    purchases: 0,
  });
  assert.deepEqual(
    report.salesByChannel.map((r) => r.subjectId),
    ["wholesale", "ecommerce", "pos"],
  );
  assert.equal(report.netSales, 1400, "the channels add up to SUM(revenue)");
});

// ── The period filter ───────────────────────────────────────────────────────

test("every preset is a half-open window derived from the date", () => {
  const now = new Date(2026, 7, 18, 14, 30); // Tue 18 Aug 2026

  const day = periodWindow("day", now);
  assert.equal(day.from.getDate(), 18);
  assert.equal(day.from.getHours(), 0);
  assert.equal(day.to.getDate(), 19, "to is EXCLUSIVE — the next midnight");

  const week = periodWindow("week", now);
  assert.equal(week.from.getDay(), 6, "the Egyptian week starts Saturday");
  assert.equal((week.to - week.from) / 86_400_000, 7);

  const month = periodWindow("month", now);
  assert.equal(month.from.getMonth(), 7);
  assert.equal(month.from.getDate(), 1);
  assert.equal(month.to.getMonth(), 8);

  const quarter = periodWindow("quarter", now);
  assert.equal(quarter.from.getMonth(), 6, "Aug is in Q3, which opens in July");
  assert.equal(quarter.to.getMonth(), 9);

  const year = periodWindow("year", now);
  assert.equal(year.from.getFullYear(), 2026);
  assert.equal(year.from.getMonth(), 0);
  assert.equal(year.to.getFullYear(), 2027);
});

test("a custom range includes the last day the owner picked", () => {
  const w = customWindow("2026-08-01", "2026-08-18");
  assert.equal(w.from.getDate(), 1);
  assert.equal(w.to.getDate(), 19, "the 18th is included, so the bound is the 19th");

  assert.equal(customWindow("2026-08-18", "2026-08-01"), null, "backwards is refused");
  assert.equal(customWindow("", "2026-08-01"), null);

  const oneDay = customWindow("2026-08-18", "2026-08-18");
  assert.equal((oneDay.to - oneDay.from) / 86_400_000, 1, "a single day is a real window");
});

// ── P&L rows ────────────────────────────────────────────────────────────────

test("buckets tile the window exactly, with no gap and no overlap", () => {
  const w = { from: new Date(2026, 0, 1), to: new Date(2027, 0, 1) };
  const rows = buckets(w, "month");

  assert.equal(rows.length, 12);
  assert.equal(rows[0].label, "01/2026");
  assert.equal(rows[11].label, "12/2026");
  assert.equal(+rows[0].from, +w.from);
  assert.equal(+rows[11].to, +w.to);
  for (let i = 1; i < rows.length; i++) {
    assert.equal(+rows[i].from, +rows[i - 1].to, "no gap, no overlap");
  }
});

test("a partial window is clipped, so a bucket never reports days outside it", () => {
  const w = { from: new Date(2026, 7, 10), to: new Date(2026, 8, 5) };
  const rows = buckets(w, "month");

  assert.equal(rows.length, 2);
  assert.equal(+rows[0].from, +w.from, "August starts on the 10th, not the 1st");
  assert.equal(+rows[1].to, +w.to, "September stops on the 5th");
});

test("quarters and years label the way the owner reads them", () => {
  const w = { from: new Date(2026, 0, 1), to: new Date(2027, 0, 1) };
  assert.deepEqual(
    buckets(w, "quarter").map((b) => b.label),
    ["ر1 2026", "ر2 2026", "ر3 2026", "ر4 2026"],
  );
  assert.deepEqual(
    buckets(w, "year").map((b) => b.label),
    ["2026"],
  );
});

test("granularity follows the window length unless overridden", () => {
  assert.equal(defaultGranularity(periodWindow("day", new Date(2026, 7, 18))), "day");
  assert.equal(defaultGranularity(periodWindow("month", new Date(2026, 7, 18))), "day");
  assert.equal(defaultGranularity(periodWindow("year", new Date(2026, 7, 18))), "month");
  assert.equal(
    defaultGranularity({ from: new Date(2020, 0, 1), to: new Date(2026, 0, 1) }),
    "year",
  );
});

test("the row cap holds — a huge window does not fire thousands of queries", () => {
  const rows = buckets({ from: new Date(2000, 0, 1), to: new Date(2026, 0, 1) }, "day");
  assert.equal(rows.length, 60);
});

test("the P&L rows add up to the headline totals", () => {
  // Two months, each with its own numbers. The table and the cards are the
  // same query at different widths, so they must agree.
  const jan = pnl({
    revenueRows: [{ subjectId: "pos", amount: 1000 }],
    expenseRows: [{ subjectId: "store_rent", amount: 200 }],
    cogs: 400,
    returnsRevenue: 0,
    purchases: 0,
  });
  const feb = pnl({
    revenueRows: [{ subjectId: "pos", amount: 1500 }],
    expenseRows: [{ subjectId: "store_rent", amount: 200 }],
    cogs: 600,
    returnsRevenue: -100,
    purchases: 0,
  });
  const whole = pnl({
    revenueRows: [{ subjectId: "pos", amount: 2500 }],
    expenseRows: [{ subjectId: "store_rent", amount: 400 }],
    cogs: 1000,
    returnsRevenue: -100,
    purchases: 0,
  });

  assert.equal(jan.netProfit + feb.netProfit, whole.netProfit);
  assert.equal(jan.returns + feb.returns, whole.returns);
});
