/**
 * التكامل — one loop, one set of numbers, every screen.
 *
 *     node --test scripts/check_integration.mjs
 *
 * The other check files each guard one module. This one guards the SEAMS: that
 * a sale, a receipt, a return and a جرد all land in the same accounts, that
 * every screen reads those accounts rather than a private tally, and that the
 * totals still reconcile after a full day's trading.
 *
 * Every bug this codebase has had at a seam was the same shape — two places
 * computing one number and drifting:
 *
 *   the exchange that booked +600 for 100 of cash      (POS vs المرتجعات)
 *   the treasury that summed four wallets, not all     (الخزنة vs رأس المال)
 *   the جرد that reconciled against the shelf record   (mirror vs ledger)
 *   the sidebar that hid links the router still opened (nav vs guard)
 *
 * So this file asserts agreement, not features.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildSaleLines } from "../src/lib/ledger/sales.ts";
import {
  buildPurchaseLines,
  buildSupplierReturnLines,
  averageCost,
} from "../src/lib/ledger/purchases.ts";
import {
  buildOrderPlacedLines,
  buildOrderDeliveredLines,
  buildCourierSettlementLines,
  buildOrderPaymentLines,
  buildReturnConfirmedLines,
} from "../src/lib/ledger/orders.ts";
import { buildWholesaleInvoiceLines } from "../src/lib/ledger/wholesale.ts";
import { buildStockAdjustmentLines } from "../src/lib/ledger/audit.ts";
import { summarise, totalAssetsOf, netWorthOf } from "../src/lib/dashboard.ts";
import { canAccess, APP_ROLES } from "../src/lib/roles.ts";

/** The aggregation every screen ultimately performs. */
const agg = (lines, account) => {
  const by = new Map();
  for (const l of lines.filter((x) => x.account === account)) {
    const prev = by.get(l.subjectId) ?? { subjectId: l.subjectId, amount: 0, qty: 0 };
    by.set(l.subjectId, {
      subjectId: l.subjectId,
      amount: prev.amount + (l.amount ?? 0),
      qty: prev.qty + (l.qty ?? 0),
    });
  }
  return [...by.values()];
};
const sum = (lines, account) => agg(lines, account).reduce((s, r) => s + r.amount, 0);
const qty = (lines, account, id) =>
  agg(lines, account).filter((r) => id === undefined || r.subjectId === id)
    .reduce((s, r) => s + r.qty, 0);

// ════════════════════════════════════════════════════════════════════════════
// A full trading day, built from the REAL builders every screen calls.
// ════════════════════════════════════════════════════════════════════════════

/** المشتريات: 20 units at 150, half paid, half owed. */
const purchase = buildPurchaseLines({
  items: [{ productId: "p1", quantity: 20, unitCost: 150 }],
  wallet: "inStoreSafe",
  supplierId: "s1",
  paidAmount: 1500,
});

/** نقطة البيع: 4 units at 500. */
const posSale = buildSaleLines({
  items: [{ productId: "p1", quantity: 4, unitPrice: 500, unitCost: 150 }],
  wallet: "inStoreSafe",
  customerId: "c1",
  channel: "pos",
});

/** الجملة: 5 units at 400, part paid. */
const wholesale = buildWholesaleInvoiceLines({
  items: [{ productId: "p1", quantity: 5, unitPrice: 400, unitCost: 150 }],
  clientId: "wc1",
  wallet: "inStoreSafe",
  paidAmount: 800,
});

/** أونلاين: placed with a deposit, topped up, then delivered and settled. */
const orderItems = [{ productId: "p1", quantity: 2, unitPrice: 250, unitCost: 150 }];
const orderPlaced = buildOrderPlacedLines({
  items: orderItems,
  depositAmount: 200,
  wallet: "inStoreSafe",
});
const orderTopUp = buildOrderPaymentLines({ wallet: "instapay", amount: 350 });
const orderDelivered = buildOrderDeliveredLines({
  items: orderItems,
  goodsTotal: 500,
  shippingFee: 50,
  depositAmount: 550, // 200 deposit + 350 transferred
  codAmount: 0,
  courierId: "nile",
  customerId: "c2",
});

const day = [...purchase, ...posSale, ...wholesale, ...orderPlaced, ...orderTopUp, ...orderDelivered];

// ── the seam every screen sits on ───────────────────────────────────────────

test("every screen's stock number comes from ONE aggregation", () => {
  // المخازن, نقطة البيع, الجرد and قيمة المخزون all read SUM(stock).
  // 20 bought − 4 POS − 5 wholesale − 2 online = 9.
  assert.equal(qty(day, "stock", "p1"), 9);
  assert.equal(sum(day, "stock"), 9 * 150, "value tracks quantity at the same cost");
  assert.equal(averageCost(agg(day, "stock")[0]), 150, "and the average survives it all");
});

test("the treasury is SUM(wallet) across every till, not a known-names list", () => {
  // −1500 purchase +2000 POS +800 wholesale +200 deposit +350 instapay
  assert.equal(sum(day, "wallet"), 1850);
  const tills = agg(day, "wallet").map((r) => r.subjectId).sort();
  assert.deepEqual(tills, ["inStoreSafe", "instapay"], "the top-up kept its own till");
});

test("the dashboard's profit is the same three sums the treasury uses", () => {
  const f = summarise({
    revenueRows: agg(day, "revenue"),
    cogsRows: agg(day, "cogs"),
    expenseRows: agg(day, "expense"),
    events: [{ kind: "sale" }, { kind: "sale" }, { kind: "order_placed" }],
  });
  // POS 2000 + wholesale 2000 + online 500
  assert.equal(f.revenue, 4500);
  assert.equal(f.netProfit, f.revenue - sum(day, "cogs") - sum(day, "expense"));
  assert.equal(f.netProfit, 4500 - 1650 - 0);
});

test("net worth reconciles cash, stock and both sides of the debt", () => {
  const shop = {
    walletsTotal: sum(day, "wallet"),
    inventoryValue: sum(day, "stock"),
    receivableClient: sum(day, "receivable_client"),
    payableSupplier: sum(day, "payable_supplier"),
  };
  assert.equal(shop.receivableClient, 1200, "الجملة: 2000 invoiced − 800 paid");
  assert.equal(shop.payableSupplier, 1500, "المشتريات: 3000 − 1500 paid");
  assert.equal(totalAssetsOf(shop), 1850 + 1350 + 1200);
  assert.equal(netWorthOf(shop), totalAssetsOf(shop) - 1500);
});

// ── the online order loop closes on itself ──────────────────────────────────

test("a topped-up order collects nothing at the door and still books in full", () => {
  assert.equal(sum(orderDelivered, "receivable_courier"), 0, "nothing left to collect");
  assert.equal(sum(orderDelivered, "revenue"), 500, "revenue booked in full anyway");
  assert.equal(sum(orderDelivered, "payable_courier"), 50, "the fee is still owed");
  // The money arrived earlier, in the till the customer actually used.
  assert.equal(sum(orderTopUp, "wallet"), 350);
});

test("courier settlement empties both courier accounts", () => {
  const codOrder = buildOrderDeliveredLines({
    items: orderItems,
    goodsTotal: 500,
    shippingFee: 50,
    codAmount: 550,
    courierId: "nile",
  });
  const settled = [
    ...codOrder,
    ...buildCourierSettlementLines({
      courierId: "nile",
      wallet: "inStoreSafe",
      amount: 550,
      commission: 50,
    }),
  ];
  assert.equal(sum(settled, "receivable_courier"), 0);
  assert.equal(sum(settled, "payable_courier"), 0, "the fee was a pass-through");
  assert.equal(sum(settled, "wallet"), 500);
});

// ── returns unwind exactly what was booked ──────────────────────────────────

test("a full return leaves the books where they started", () => {
  const sale = buildSaleLines({
    items: [{ productId: "p1", quantity: 2, unitPrice: 500, unitCost: 150 }],
    wallet: "inStoreSafe",
    customerId: "c1",
    channel: "pos",
  });
  const back = buildReturnConfirmedLines({
    items: [{ productId: "p1", quantity: 2, unitPrice: 500, unitCost: 150 }],
    refundAmount: 1000,
    wallet: "inStoreSafe",
    revenueAmount: 1000,
    customerId: "c1",
    channel: "pos",
  });
  const both = [...sale, ...back];
  for (const account of ["wallet", "revenue", "cogs", "customer_ltv"]) {
    assert.equal(sum(both, account), 0, `${account} must unwind to zero`);
  }
  assert.equal(qty(both, "stock", "p1"), 0, "and the units are back on the shelf");
});

test("a supplier return unwinds the buying side without touching revenue", () => {
  const back = buildSupplierReturnLines({
    items: [{ productId: "p1", quantity: 10, unitCost: 150 }],
    supplierId: "s1",
    wallet: "inStoreSafe",
    currentDebt: 1500,
  });
  const both = [...purchase, ...back];
  assert.equal(qty(both, "stock", "p1"), 10, "half the delivery went back");
  assert.equal(sum(both, "payable_supplier"), 0, "and cleared what we owed");
  assert.equal(sum(both, "revenue"), 0, "goods never sold are never revenue");
  assert.equal(sum(both, "cogs"), 0, "and never a cost of goods SOLD");
});

// ── the جرد closes the loop on the shelf ────────────────────────────────────

test("a جرد corrects the ledger to the physical count", () => {
  const onHand = qty(day, "stock", "p1"); // 9
  const counted = 7; // two missing
  const fix = buildStockAdjustmentLines({
    items: [{ productId: "p1", systemQty: onHand, countedQty: counted, unitCost: 150 }],
  });
  const after = [...day, ...fix];
  assert.equal(qty(after, "stock", "p1"), counted, "the ledger now matches the shelf");
  assert.equal(sum(fix, "expense"), 2 * 150, "and the loss is booked as shrinkage");
});

test("shrinkage reaches the same profit figure the dashboard shows", () => {
  const fix = buildStockAdjustmentLines({
    items: [{ productId: "p1", systemQty: 9, countedQty: 7, unitCost: 150 }],
  });
  const after = [...day, ...fix];
  const f = summarise({
    revenueRows: agg(after, "revenue"),
    cogsRows: agg(after, "cogs"),
    expenseRows: agg(after, "expense"),
    events: [],
  });
  assert.equal(f.netProfit, 4500 - 1650 - 300, "the جرد moved صافي الربح, not just المخازن");
});

// ── access and sync wrap the same data ──────────────────────────────────────

test("every role can reach at least one screen, and only ADMIN reaches all", () => {
  const screens = ["/", "/pos", "/orders", "/inventory", "/purchasing", "/partners", "/settings"];
  for (const role of APP_ROLES) {
    const open = screens.filter((p) => canAccess(role, p));
    assert.ok(open.length > 0, `${role} must have somewhere to work`);
    if (role !== "ADMIN") {
      assert.ok(open.length < screens.length, `${role} must not reach everything`);
    }
  }
  assert.equal(APP_ROLES.filter((r) => canAccess(r, "/settings")).length, 1, "settings is ADMIN-only");
});

// ── the whole day, one assertion ────────────────────────────────────────────

test("cash in minus cash out equals the treasury, to the piastre", () => {
  const cashIn = 2000 + 800 + 200 + 350; // POS, wholesale deposit, order deposit, top-up
  const cashOut = 1500; // the purchase
  assert.equal(sum(day, "wallet"), cashIn - cashOut);
});

test("no account is left holding a non-finite number", () => {
  // One NaN in an append-only ledger is permanent, and every SUM over that
  // account reads NaN forever after.
  for (const line of day) {
    if (line.amount !== undefined) {
      assert.ok(Number.isFinite(line.amount), `${line.account}/${line.subjectId} amount`);
    }
    if (line.qty !== undefined) {
      assert.ok(Number.isFinite(line.qty), `${line.account}/${line.subjectId} qty`);
    }
  }
});
