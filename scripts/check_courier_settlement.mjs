/**
 * The courier pays in BATCHES (§3.9).
 *
 *     node --test scripts/check_courier_settlement.mjs
 *
 * From hand-testing: the courier does not pay per delivery. Every 3–7 days it
 * transfers ONE lump sum covering many delivered orders, already net of its
 * commissions and any return fees, and the owner reconciles that single
 * transfer against the orders it was supposed to cover.
 *
 * Two rules make this reconciliation rather than re-pricing, and both are
 * asserted below because getting either wrong invents money:
 *
 *   1. Fees are NOT recomputed here. Every one was priced by the Settings
 *      matrix and booked to `payable_courier` when the movement happened. The
 *      difference between the COD and the transfer is applied against that
 *      existing debt — never re-derived, never booked as a fresh expense.
 *   2. Partial batches are normal. An order the courier has not paid for is
 *      simply not in the batch, stays open, and turns up in the next transfer.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOrderDeliveredLines,
  buildCourierBatchSettlementLines,
} from "../src/lib/ledger/orders.ts";
import {
  batchSummary,
  courierIdOf,
  isCodSettled,
  unsettledDeliveries,
} from "../src/lib/courierBatch.ts";

const COURIER = "courier-bosta";
const WALLET = "inStoreSafe";

const amountOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((s, l) => s + (l.amount ?? 0), 0);
const countOn = (lines, account) => lines.filter((l) => l.account === account).length;

// ── The lines ──────────────────────────────────────────────────────────────

test("one transfer is ONE event: cash in, the ticked orders' COD out", () => {
  const lines = buildCourierBatchSettlementLines({
    courierId: COURIER,
    wallet: WALLET,
    orders: [
      { orderId: "o1", cod: 1000 },
      { orderId: "o2", cod: 1500 },
    ],
    netReceived: 2300,
  });

  assert.equal(amountOn(lines, "wallet"), 2300, "what actually arrived");
  assert.equal(amountOn(lines, "receivable_courier"), -2500, "both orders clear IN FULL");
  assert.equal(
    amountOn(lines, "payable_courier"),
    -200,
    "what they withheld, against what we owed",
  );
  assert.equal(
    countOn(lines, "receivable_courier"),
    1,
    "one line for the batch, not one per order",
  );
});

test("no expense line, ever — the fee was booked when the movement happened", () => {
  // Booking it again here would count every return's shipping twice, and would
  // invent an expense for delivery fees, which are the customer's money.
  const lines = buildCourierBatchSettlementLines({
    courierId: COURIER,
    wallet: WALLET,
    orders: [{ orderId: "o1", cod: 1000 }],
    netReceived: 900,
  });
  assert.equal(countOn(lines, "expense"), 0);
});

test("an exact transfer withholds nothing and writes no payable line", () => {
  const lines = buildCourierBatchSettlementLines({
    courierId: COURIER,
    wallet: WALLET,
    orders: [{ orderId: "o1", cod: 1000 }],
    netReceived: 1000,
  });
  assert.equal(amountOn(lines, "wallet"), 1000);
  assert.equal(countOn(lines, "payable_courier"), 0, "nothing was kept, so nothing clears");
});

test("a transfer that is entirely eaten by fees still clears the orders", () => {
  // Rare but real: a batch of returns where the fees equal the COD.
  const lines = buildCourierBatchSettlementLines({
    courierId: COURIER,
    wallet: WALLET,
    orders: [{ orderId: "o1", cod: 300 }],
    netReceived: 0,
  });
  assert.equal(countOn(lines, "wallet"), 0, "no wallet line for a zero deposit");
  assert.equal(amountOn(lines, "receivable_courier"), -300);
  assert.equal(amountOn(lines, "payable_courier"), -300);
});

test("more money than the orders were carrying is REFUSED, not absorbed", () => {
  // It would have to be booked as a negative fee, which is invented money.
  assert.throws(
    () =>
      buildCourierBatchSettlementLines({
        courierId: COURIER,
        wallet: WALLET,
        orders: [{ orderId: "o1", cod: 1000 }],
        netReceived: 1200,
      }),
    /more than the COD/,
  );
});

test("an empty batch, a duplicated order and a zero-COD order are all refused", () => {
  const base = { courierId: COURIER, wallet: WALLET, netReceived: 100 };
  assert.throws(() => buildCourierBatchSettlementLines({ ...base, orders: [] }), /at least one/);
  assert.throws(
    () =>
      buildCourierBatchSettlementLines({
        ...base,
        orders: [
          { orderId: "o1", cod: 500 },
          { orderId: "o1", cod: 500 },
        ],
      }),
    /twice/,
    "the same order in one batch would clear its COD twice",
  );
  assert.throws(
    () => buildCourierBatchSettlementLines({ ...base, orders: [{ orderId: "o1", cod: 0 }] }),
    /no COD/,
  );
});

// ── Which orders are still open ────────────────────────────────────────────

const order = (over) => ({
  id: "o",
  orderNumber: "ECO-1",
  status: "delivered",
  expectedCod: 1000,
  courierId: COURIER,
  ...over,
});

test("only DELIVERED orders with COD still open are settleable", () => {
  const rows = [
    order({ id: "a" }),
    order({ id: "b", status: "shipped" }),
    order({ id: "c", status: "pending" }),
    order({ id: "d", expectedCod: 0 }),
    order({ id: "e", codSettledAt: new Date() }),
  ];
  assert.deepEqual(
    unsettledDeliveries(rows).map((o) => o.id),
    ["a"],
    "shipped has no receivable yet, prepaid never had one, settled is done",
  );
});

test("a missing courierId falls back to `default` — the ledger's own subject", () => {
  // The courier STORE used `default-courier` while every ledger line used
  // `default`, so an order with no courier booked its COD to one id and the
  // screen looked up the other and showed zero.
  assert.equal(courierIdOf({ courierId: undefined }), "default");
  assert.equal(courierIdOf({ courierId: "" }), "default");
  assert.equal(courierIdOf({ courierId: COURIER }), COURIER);
  assert.equal(isCodSettled({ codSettledAt: undefined }), false);
});

test("the summary shows the shortfall and 5-point comparison rather than hiding it", () => {
  const s = batchSummary(
    [
      { expectedCod: 1000, courierFee: 50 },
      { expectedCod: 1500, courierFee: 50 },
    ],
    2300,
  );
  assert.deepEqual(s, {
    codTotal: 2500,
    expectedFees: 100,
    expectedNet: 2400,
    netReceived: 2300,
    shortfall: 100,
    difference: 200,
    orderCount: 2,
  });
});

test("shortfall: when received < expectedNet, books expense: courier_shortfall and clears fees", () => {
  const lines = buildCourierBatchSettlementLines({
    courierId: COURIER,
    wallet: WALLET,
    orders: [
      { orderId: "o1", cod: 1000, fee: 50 },
      { orderId: "o2", cod: 1500, fee: 50 },
    ],
    netReceived: 2300, // expectedNet is 2500 - 100 = 2400. Shortfall is 100.
  });

  assert.equal(amountOn(lines, "wallet"), 2300, "actual received cash in wallet");
  assert.equal(amountOn(lines, "receivable_courier"), -2500, "COD cleared in full");
  assert.equal(amountOn(lines, "payable_courier"), -100, "expected courier fees cleared");
  assert.equal(amountOn(lines, "expense"), 100, "shortfall booked to expense: courier_shortfall");
  assert.equal(
    lines.find((l) => l.account === "expense")?.subjectId,
    "courier_shortfall",
  );
});

test("exact transfer with expected fees clears debt and books zero expense", () => {
  const lines = buildCourierBatchSettlementLines({
    courierId: COURIER,
    wallet: WALLET,
    orders: [
      { orderId: "o1", cod: 1000, fee: 50 },
      { orderId: "o2", cod: 1500, fee: 50 },
    ],
    netReceived: 2400, // expectedNet = 2500 - 100 = 2400. Shortfall = 0.
  });

  assert.equal(amountOn(lines, "wallet"), 2400);
  assert.equal(amountOn(lines, "receivable_courier"), -2500);
  assert.equal(amountOn(lines, "payable_courier"), -100);
  assert.equal(countOn(lines, "expense"), 0);
});

// ── §1.3 scenario ──────────────────────────────────────────────────────────

test("§1.3: three delivered orders, batch-settle two — the third stays open", () => {
  // Three COD orders delivered by the same courier. Delivery books the COD to
  // `receivable_courier` and the delivery fee to `payable_courier`.
  const deliveries = [
    { goods: 1000, shipping: 50, cod: 1050 },
    { goods: 1500, shipping: 50, cod: 1550 },
    { goods: 800, shipping: 50, cod: 850 },
  ].flatMap((d) =>
    buildOrderDeliveredLines({
      items: [{ productId: "p1", quantity: 1, unitPrice: d.goods, unitCost: 400 }],
      goodsTotal: d.goods,
      shippingFee: d.shipping,
      depositAmount: 0,
      codAmount: d.cod,
      wallet: WALLET,
      courierId: COURIER,
      channel: "ecommerce",
    }),
  );

  assert.equal(amountOn(deliveries, "receivable_courier"), 3450, "1050 + 1550 + 850 with them");
  assert.equal(amountOn(deliveries, "payable_courier"), 150, "three delivery fees at 50");
  assert.equal(amountOn(deliveries, "wallet"), 0, "no COD reaches a till at delivery");

  // The courier transfers ONE lump sum covering the first two only, net of the
  // two delivery fees it kept: 1050 + 1550 − 100 = 2500.
  const batch = buildCourierBatchSettlementLines({
    courierId: COURIER,
    wallet: WALLET,
    orders: [
      { orderId: "o1", cod: 1050 },
      { orderId: "o2", cod: 1550 },
    ],
    netReceived: 2500,
  });

  const all = [...deliveries, ...batch];

  // The two settled orders cleared; the THIRD is still with the courier.
  assert.equal(
    amountOn(all, "receivable_courier"),
    850,
    "exactly the untouched order — a partial batch never settles the rest",
  );
  // The wallet grew by the lump sum, not by the COD it represents.
  assert.equal(amountOn(all, "wallet"), 2500, "the net amount actually received");
  // Two of the three delivery fees are now settled; one is still owed.
  assert.equal(amountOn(all, "payable_courier"), 50, "the third order's fee is still outstanding");
  // And nothing invented an expense along the way.
  assert.equal(countOn(all, "expense"), 0);
});

test("§1.3 continued: the third order settles later and closes the account", () => {
  const rest = buildCourierBatchSettlementLines({
    courierId: COURIER,
    wallet: WALLET,
    orders: [{ orderId: "o3", cod: 850 }],
    netReceived: 800,
  });
  assert.equal(amountOn(rest, "receivable_courier"), -850);
  assert.equal(amountOn(rest, "payable_courier"), -50, "the last delivery fee");
  assert.equal(amountOn(rest, "wallet"), 800);
  // 850 − 850 = 0 with the courier, and 50 − 50 = 0 owed to them.
});
