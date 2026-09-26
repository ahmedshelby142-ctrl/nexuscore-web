/**
 * Session #7 — the rules that had drifted, and the screens that must not redo them.
 *
 * Two kinds of test here:
 *
 *   * arithmetic, where the defect was a FORMULA (profit direction, stock
 *     variance valuation);
 *   * source-level, where the defect was "which module does this call" — the
 *     shape `check_online_only.mjs` uses, because an inverted reading of the
 *     right number is not reachable from a pure function.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { pnl } from "../src/lib/ledger/reports.ts";
import { summarise } from "../src/lib/dashboard.ts";
import { auditNetValue, buildStockAdjustmentLines } from "../src/lib/ledger/audit.ts";
import { formatBalance } from "../src/lib/math.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ── §8 net profit ───────────────────────────────────────────────────────────
//
// Measured on QA-STORE, 2026-09-14: revenue 7,000.00 / cogs 3,194.64 /
// expense 3,447.14, all POSITIVE in the ledger. The right answer is +358.22.
// The suspected `expenses + COGS − sales` would give exactly −358.22 — the
// same magnitude with the sign flipped, which is why it has to be pinned
// rather than eyeballed.

const QA = { revenue: 7000, cogs: 3194.64, expense: 3447.14, profit: 358.22 };
const near = (a, b) => Math.abs(a - b) < 0.005;

test("net profit is revenue − COGS − expenses, in that direction", () => {
  const report = pnl({
    revenueRows: [{ subjectId: "pos", amount: QA.revenue }],
    cogs: QA.cogs,
    expenseRows: [{ subjectId: "rent", amount: QA.expense }],
    returnsRevenue: 0,
    purchases: 0,
  });
  assert.ok(near(report.netProfit, QA.profit), `expected ${QA.profit}, got ${report.netProfit}`);
  assert.ok(report.netProfit > 0, "a profitable shop must not read as a loss");
});

test("the dashboard agrees with the P&L to the piastre", () => {
  // Two formulas in two modules. They are allowed to exist; they are not
  // allowed to disagree.
  const report = pnl({
    revenueRows: [{ subjectId: "pos", amount: QA.revenue }],
    cogs: QA.cogs,
    expenseRows: [{ subjectId: "rent", amount: QA.expense }],
    returnsRevenue: 0,
    purchases: 0,
  });
  const summary = summarise({
    revenueRows: [{ subjectId: "pos", amount: QA.revenue }],
    cogsRows: [{ subjectId: "P1", amount: QA.cogs }],
    expenseRows: [{ subjectId: "rent", amount: QA.expense }],
    events: [],
  });
  assert.ok(near(summary.netProfit, report.netProfit));
});

test("returns are deducted ONCE, through revenue", () => {
  // A `return_confirmed` writes `revenue −`, so the revenue rows are already
  // net. Subtracting `returns` again would double-count every refund.
  const report = pnl({
    revenueRows: [{ subjectId: "pos", amount: 1000 }, { subjectId: "pos", amount: -300 }],
    cogs: 200,
    expenseRows: [],
    returnsRevenue: -300,
    purchases: 0,
  });
  assert.equal(report.netSales, 700);
  assert.equal(report.returns, 300, "shown as a positive figure, for display only");
  assert.equal(report.netProfit, 500, "700 − 200, with no second deduction");
});

test("shipping is a slice of expenses, never a fourth deduction", () => {
  const report = pnl({
    revenueRows: [{ subjectId: "pos", amount: 1000 }],
    cogs: 0,
    expenseRows: [
      { subjectId: "shipping_return", amount: 40 },
      { subjectId: "rent", amount: 60 },
    ],
    returnsRevenue: 0,
    purchases: 0,
  });
  assert.equal(report.shipping, 40);
  assert.equal(report.opex, 60);
  assert.equal(report.expenses, 100, "opex + shipping, and that IS all expense rows");
  assert.equal(report.netProfit, 900);
});

test("purchases are not a P&L line — cash became inventory", () => {
  const report = pnl({
    revenueRows: [{ subjectId: "pos", amount: 1000 }],
    cogs: 100,
    expenseRows: [],
    returnsRevenue: 0,
    purchases: 5000,
  });
  assert.equal(report.netProfit, 900, "a big توريد must not read as a loss");
});

// ── §7 the signed balance, said once ────────────────────────────────────────

test("a balance names its direction instead of printing a minus sign", () => {
  // «−500 متبقي» reads as the opposite of what a credit is. The magnitude plus
  // the side cannot be read backwards.
  assert.match(formatBalance(1300), /عليه/);
  assert.match(formatBalance(-500), /له/);
  assert.doesNotMatch(formatBalance(-500), /-|−/, "no bare minus under a debt heading");
  // Zero has no direction.
  assert.doesNotMatch(formatBalance(0), /عليه|له/);
  for (const bad of [NaN, null, undefined]) {
    assert.doesNotMatch(formatBalance(bad), /عليه|له/);
  }
  // The wording is caller-chosen, because "owed" points the other way for a
  // payable than for a receivable.
  assert.match(formatBalance(100, { owed: "لنا", credit: "علينا" }), /لنا/);
});

test("the trader balance comes from the ledger on every screen", () => {
  const page = read("../src/components/wholesale/WholesalePage.tsx");
  // The merchant dialog used to sum `remainingAmount` off the invoice
  // DOCUMENTS — a second balance. Measured on QA-STORE: the documents said
  // 1,300 open while `receivable_client` held −500.
  assert.doesNotMatch(
    page,
    /mOwed = mInvoices\.reduce/,
    "no screen may compute its own trader balance",
  );
  assert.match(page, /const mOwed = debtOf\(selectedMerchant\.id\)/);
  assert.match(page, /formatBalance\(/, "and it must be rendered with its direction");
});

test("a wholesale return writes the invoice documents back", () => {
  // Otherwise the per-invoice «متبقي» keeps showing an amount that has already
  // come back, which is the other half of the same reported inversion.
  //
  // Each screen reaches the credit through `commitWholesaleReturn`, which runs
  // it INSIDE the transaction and BEFORE the ledger event. It used to be
  // called by each screen after the event, failure swallowed — and on
  // committed main the method did not exist, so it threw after the money had
  // moved. See `check_wholesale_return_txn.mjs` for the order and the undo.
  for (const file of [
    "../src/components/wholesale/WholesalePage.tsx",
    "../src/components/ecommerce/OrdersPage.tsx",
    "../src/components/sales/CheckoutForm.tsx",
  ]) {
    assert.match(read(file), /await commitWholesaleReturn\(/, `${file} must return through the command that credits the invoice`);
  }
  const cmd = read("../src/lib/wholesaleReturnDoc.ts");
  assert.match(cmd, /store\(\)\.recordWholesaleReturn\(invoiceId, amount\)/, "the command must credit the invoice");
  const txn = read("../src/lib/wholesaleReturnTxn.ts");
  const credit = txn.indexOf("await steps.creditInvoice(");
  const ledger = txn.indexOf("await steps.appendLedger()");
  assert.ok(credit > -1 && credit < ledger, "the invoice is credited BEFORE the ledger event, never after");
  const store = read("../src/store/useBusinessStore.ts");
  // And it must NOT inflate `paidAmount`: a return is not a payment, and كشف
  // الحساب prints that field.
  const body = store.slice(store.indexOf("recordWholesaleReturn: async"));
  const end = body.indexOf("archiveWholesaleClient");
  assert.doesNotMatch(body.slice(0, end), /paidAmount/, "a return is not a payment");
});

// ── §10 stock count ─────────────────────────────────────────────────────────

test("the printed جرد is valued the same way the ledger event is", () => {
  const items = [
    { productId: "P1", systemQty: 10, countedQty: 7, unitCost: 120 },
    { productId: "P2", systemQty: 5, countedQty: 5, unitCost: 80 },
  ];
  // −3 × 120 = −360. The export used `Math.abs(discrepancy) * 10` — ten pounds
  // a unit for every product in the shop — so it printed 30.
  assert.equal(auditNetValue(items), -360);

  const lines = buildStockAdjustmentLines({ items });
  const stock = lines.find((l) => l.account === "stock" && l.subjectId === "P1");
  assert.equal(stock.qty, -3);
  assert.equal(stock.amount, -360, "the event and the printout must agree");

  const src = read("../src/components/finance/StockAuditPage.tsx");
  assert.doesNotMatch(src, /Math\.abs\(r\.discrepancy\) \* 10/, "the flat ten-pound guess");
  assert.match(src, /auditNetValue\(auditItems\)/);
});

test("a surplus cancels a cost rather than inventing revenue", () => {
  const lines = buildStockAdjustmentLines({
    items: [{ productId: "P1", systemQty: 10, countedQty: 13, unitCost: 100 }],
  });
  assert.equal(lines.find((l) => l.account === "stock").qty, 3);
  assert.equal(lines.find((l) => l.account === "expense").amount, -300);
  assert.ok(!lines.some((l) => l.account === "revenue"), "nothing was sold");
});

test("a زيرو-difference count writes nothing at all", () => {
  assert.deepEqual(
    buildStockAdjustmentLines({
      items: [{ productId: "P1", systemQty: 7, countedQty: 7, unitCost: 100 }],
    }),
    [],
  );
});

test("the جرد is gated, confirmed, and leaves the mirror alone when it fails", () => {
  const src = read("../src/components/finance/StockAuditPage.tsx");
  assert.match(src, /const gate = useSubmitGate\(\)/, "a triple-click must count once");
  assert.match(src, /if \(!gate\.enter\(\)\) return/);
  assert.match(src, /setIsReviewing/, "nothing is written before a summary is confirmed");

  // The failure path must return BEFORE `applyStockMoves`, or a refused ledger
  // event would still move the shelf record and the two books would diverge.
  const failAt = src.indexOf("لم يُسجَّل الجرد");
  const mirrorAt = src.indexOf("applyStockMoves");
  assert.ok(failAt > 0 && mirrorAt > 0);
  assert.ok(failAt < mirrorAt, "the ledger failure must abort before the mirror moves");
});

test("stock count is never recorded as a purchase or a sale", () => {
  const src = read("../src/components/finance/StockAuditPage.tsx");
  assert.match(src, /kind: "stock_adjustment"/);
  assert.doesNotMatch(src, /kind: "purchase"/);
  assert.doesNotMatch(src, /kind: "sale"/);
});

// ── §2 the courier is an entity ─────────────────────────────────────────────

test("the courier on an order is selected, not typed", () => {
  const form = read("../src/routes/ecommerce-orders.tsx");
  assert.match(form, /<CourierSelect/, "a dropdown over the registry");
  assert.doesNotMatch(
    form,
    /placeholder="اسم شركة الشحن"/,
    "the free-text box that made «أرامكس» three couriers",
  );
  assert.match(form, /courierId: courierId \|\| undefined/, "the id must reach the order");

  const selector = read("../src/components/shipping/ShippingSelector.tsx");
  assert.match(selector, /<CourierSelect/);
});

test("couriers are a synced entity, not a per-device list", () => {
  const store = read("../src/store/useCourierStore.ts");
  assert.doesNotMatch(store, /persist\(/, "localStorage made couriers device-local");
  assert.match(store, /writeThrough\("couriers"/);
  // Every link in the serialization chain, per §12.
  assert.match(read("../src/services/api/cloudSchema.ts"), /couriers: \{/);
  assert.match(read("../src/services/cloudHydrate.ts"), /couriers: \(rows\)/);
});

test("an order written before the registry still renders its courier", () => {
  const src = read("../src/components/shipping/CourierSelect.tsx");
  assert.match(src, /legacyName/, "a name with no id must not blank the field");
});
