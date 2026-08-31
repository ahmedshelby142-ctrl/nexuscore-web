/**
 * الطلبات الإلكترونية — where the money goes, and when.
 *
 *     node --test scripts/check_order_money.mjs
 *
 * The split this pins, for 500 goods + 50 shipping = 550 COD:
 *
 *   at delivery      revenue            +500   the goods, and only the goods
 *                    receivable_courier +550   ALL the cash — it is in their van
 *                    payable_courier     +50   the fee we owe them for carrying
 *                    cogs               +cost
 *                    wallet                0   the shop has NOTHING yet
 *
 *   at settlement    wallet             +500   what actually reaches the till
 *                    receivable_courier −550
 *                    payable_courier     −50
 *
 * The delivery fee is a PASS-THROUGH: it arrives inside the COD and leaves as
 * `payable_courier`, netting to zero. Booking it as revenue would inflate profit
 * by every fee ever charged.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOrderPlacedLines,
  buildOrderDeliveredLines,
  buildOrderCancelledLines,
  buildCourierSettlementLines,
  buildOrderPaymentLines,
} from "../src/lib/ledger/orders.ts";

const on = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((s, l) => s + (l.amount ?? 0), 0);
const qtyOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((s, l) => s + (l.qty ?? 0), 0);

/** 2 × 250 goods = 500, cost 150 each. */
const items = [{ productId: "p1", quantity: 2, unitPrice: 250, unitCost: 150 }];

// ── the blueprint's case, end to end ────────────────────────────────────────

test("delivery: the shop books 500, the courier holds 550, we owe them 50", () => {
  const lines = buildOrderDeliveredLines({
    items,
    goodsTotal: 500,
    shippingFee: 50,
    codAmount: 550,
    courierId: "courier-1",
    customerId: "cust-1",
  });

  assert.equal(on(lines, "revenue"), 500, "goods only — the fee is not ours");
  assert.equal(on(lines, "receivable_courier"), 550, "all the cash, in their pocket");
  assert.equal(on(lines, "payable_courier"), 50, "what we owe for carrying it");
  assert.equal(on(lines, "cogs"), 300);
  assert.equal(on(lines, "customer_ltv"), 500, "LTV mirrors revenue, not the fee");
  assert.equal(on(lines, "wallet"), 0, "the till sees nothing until settlement");
});

test("settlement is where the treasury finally sees the 500", () => {
  const settle = buildCourierSettlementLines({
    courierId: "courier-1",
    wallet: "inStoreSafe",
    amount: 550,
    commission: 50, // the fee they withhold
  });

  assert.equal(on(settle, "wallet"), 500, "550 collected − 50 kept");
  assert.equal(on(settle, "receivable_courier"), -550, "their debt clears in full");
  assert.equal(on(settle, "payable_courier"), -50, "our debt to them clears too");
});

test("delivery + settlement leaves both courier accounts at zero", () => {
  const all = [
    ...buildOrderDeliveredLines({
      items,
      goodsTotal: 500,
      shippingFee: 50,
      codAmount: 550,
      courierId: "courier-1",
    }),
    ...buildCourierSettlementLines({
      courierId: "courier-1",
      wallet: "inStoreSafe",
      amount: 550,
      commission: 50,
    }),
  ];

  assert.equal(on(all, "receivable_courier"), 0);
  assert.equal(on(all, "payable_courier"), 0, "the fee was a pass-through");
  assert.equal(on(all, "wallet"), 500);
  assert.equal(on(all, "revenue"), 500);
});

// ── the fee is never revenue and never an expense ───────────────────────────

test("shipping never lands in revenue or expense", () => {
  const lines = buildOrderDeliveredLines({
    items,
    goodsTotal: 500,
    shippingFee: 50,
    codAmount: 550,
    courierId: "courier-1",
  });
  assert.equal(on(lines, "revenue"), 500, "not 550");
  assert.equal(on(lines, "expense"), 0, "delivery is not our cost — the customer paid it");
});

test("a free-delivery order owes the courier nothing", () => {
  const lines = buildOrderDeliveredLines({
    items,
    goodsTotal: 500,
    shippingFee: 0,
    codAmount: 500,
    courierId: "courier-1",
  });
  assert.equal(on(lines, "payable_courier"), 0);
  assert.equal(on(lines, "receivable_courier"), 500);
});

// ── deposits: booked at placement, never twice ──────────────────────────────

test("a deposit is not re-booked at delivery", () => {
  const lines = buildOrderDeliveredLines({
    items,
    goodsTotal: 500,
    shippingFee: 50,
    depositAmount: 200,
    codAmount: 350,
    wallet: "inStoreSafe",
    courierId: "courier-1",
  });
  // The 200 already hit the till at order_placed. A wallet line here would
  // count the same money twice.
  assert.equal(on(lines, "wallet"), 0);
  assert.equal(on(lines, "receivable_courier"), 350, "only what is still owed");
  assert.equal(on(lines, "revenue"), 500, "revenue is the goods, however they were paid");
});

test("the money collected must add up, or the event is refused", () => {
  assert.throws(
    () =>
      buildOrderDeliveredLines({
        items,
        goodsTotal: 500,
        shippingFee: 50,
        depositAmount: 100,
        codAmount: 100, // should be 450
        courierId: "courier-1",
      }),
    /must equal net goods/,
  );
});

test("a part-paid order is not refused over float dust", () => {
  // `expectedCod` is stored as total + shipping − deposit; adding the deposit
  // back does not always land on the same float. This combination threw before
  // the comparison moved to piastres, blocking a real delivery.
  assert.doesNotThrow(() =>
    buildOrderDeliveredLines({
      items: [{ productId: "p1", quantity: 1, unitPrice: 0.1, unitCost: 0 }],
      goodsTotal: 0.1,
      shippingFee: 7.7,
      depositAmount: 1.1,
      codAmount: Math.max(0, 0.1 + 7.7 - 1.1), // 6.699999999999999
      courierId: "courier-1",
    }),
  );
});

test("a genuine one-piastre shortfall still throws", () => {
  // The tolerance is the ledger's own resolution, not a licence to be wrong.
  assert.throws(
    () =>
      buildOrderDeliveredLines({
        items,
        goodsTotal: 500,
        shippingFee: 50,
        codAmount: 549.99,
        courierId: "courier-1",
      }),
    /must equal net goods/,
  );
});

// ── discounts reach delivery correctly ──────────────────────────────────────

test("a discounted order books the discounted revenue", () => {
  const lines = buildOrderDeliveredLines({
    items,
    goodsTotal: 500,
    discountAmount: 50,
    shippingFee: 50,
    codAmount: 500, // 450 goods + 50 shipping
    courierId: "courier-1",
    customerId: "cust-1",
  });
  assert.equal(on(lines, "revenue"), 450);
  assert.equal(on(lines, "customer_ltv"), 450);
  assert.equal(on(lines, "receivable_courier"), 500);
  assert.equal(on(lines, "payable_courier"), 50, "the fee is not discounted");
});

// ── cancellation: stock back, no money invented ─────────────────────────────

test("cancelling releases exactly what was reserved", () => {
  const placed = buildOrderPlacedLines({ items });
  const cancelled = buildOrderCancelledLines({ items });

  assert.equal(qtyOn(placed, "stock"), -2, "reserved at placement");
  assert.equal(qtyOn(cancelled, "stock"), 2, "released on cancellation");
  assert.equal(qtyOn([...placed, ...cancelled], "stock"), 0, "net zero — nothing lost");
});

test("cancelling invents no revenue, no COD, no courier debt", () => {
  const lines = buildOrderCancelledLines({ items });
  for (const ghost of ["revenue", "receivable_courier", "payable_courier", "cogs", "customer_ltv"]) {
    assert.equal(on(lines, ghost), 0, `${ghost} must stay untouched`);
  }
});

test("cancelling refunds a deposit that was actually taken", () => {
  const lines = buildOrderCancelledLines({
    items,
    depositAmount: 200,
    wallet: "inStoreSafe",
  });
  assert.equal(on(lines, "wallet"), -200, "the money goes back out");
});

test("a legacy order with no deposit wallet reverses nothing", () => {
  // Placed before `depositWallet` existed, so the deposit never hit a till.
  const lines = buildOrderCancelledLines({ items, depositAmount: 200 });
  assert.equal(on(lines, "wallet"), 0);
});

test("cancelling a bundle order releases the components", () => {
  const lines = buildOrderCancelledLines({
    items: [
      {
        productId: "box",
        quantity: 2,
        unitPrice: 350,
        unitCost: 0,
        isBundle: true,
        bundleItems: [
          { productId: "shirt", quantity: 2, unitCost: 100 },
          { productId: "pants", quantity: 1, unitCost: 150 },
        ],
      },
    ],
  });
  const qtyFor = (id) =>
    lines.filter((l) => l.account === "stock" && l.subjectId === id).reduce((s, l) => s + l.qty, 0);
  assert.equal(qtyFor("shirt"), 4, "2 per box × 2 boxes");
  assert.equal(qtyFor("pants"), 2);
  assert.equal(qtyFor("box"), 0, "the virtual product has no shelf");
});

test("an empty order cannot be cancelled", () => {
  assert.throws(() => buildOrderCancelledLines({ items: [] }), /no items/);
});


// ── دفعة إضافية: money that arrives before the courier does ─────────────────
//
// A retail order goes out with a deposit and the rest as COD. The customer then
// transfers the balance. Until this existed there was nowhere to put it: the
// order kept its original COD, the courier demanded money already sent, and the
// cash sat in a till the books knew nothing about.

test("a payment lands in the till that actually received it", () => {
  const l = buildOrderPaymentLines({ wallet: "vodafoneCash", amount: 350 });
  assert.equal(on(l, "wallet"), 350);
  assert.equal(l[0].subjectId, "vodafoneCash", "not a default till — the one chosen");
  assert.equal(l.length, 1, "one line: cash arrived, nothing else is true yet");
});

test("a payment books NO revenue — the goods have not moved", () => {
  const l = buildOrderPaymentLines({ wallet: "instapay", amount: 500 });
  for (const account of ["revenue", "cogs", "receivable_courier", "customer_ltv"]) {
    assert.equal(on(l, account), 0, `${account} must wait for delivery`);
  }
});

test("each payment can land in a different account", () => {
  // Two transfers on one order, one by Vodafone Cash and one by InstaPay.
  const all = [
    ...buildOrderPaymentLines({ wallet: "vodafoneCash", amount: 200 }),
    ...buildOrderPaymentLines({ wallet: "instapay", amount: 300 }),
  ];
  const byWallet = (w) =>
    all.filter((x) => x.account === "wallet" && x.subjectId === w).reduce((s, x) => s + x.amount, 0);
  assert.equal(byWallet("vodafoneCash"), 200);
  assert.equal(byWallet("instapay"), 300);
  assert.equal(on(all, "wallet"), 500, "and the treasury total is still right");
});

test("nothing, negative or non-finite is refused", () => {
  for (const bad of [0, -100, NaN, undefined, null]) {
    assert.throws(
      () => buildOrderPaymentLines({ wallet: "inStoreSafe", amount: bad }),
      /must be positive/,
      `amount ${String(bad)}`,
    );
  }
  assert.throws(
    () => buildOrderPaymentLines({ wallet: "", amount: 100 }),
    /needs a wallet/,
  );
});

test("topping up keeps the delivery guard balanced", () => {
  // The whole point. 500 goods + 50 shipping, 200 deposit, 350 COD.
  // The customer then transfers 350, so deposit becomes 550 and COD becomes 0.
  // `deposit + cod` must STILL equal `net goods + shipping`, or delivery throws.
  const deposit = 200 + 350;
  const cod = 350 - 350;
  assert.equal(deposit + cod, 500 + 50, "the arithmetic the ledger checks");

  const l = buildOrderDeliveredLines({
    items,
    goodsTotal: 500,
    shippingFee: 50,
    depositAmount: deposit,
    codAmount: cod,
    courierId: "courier-1",
  });
  assert.equal(on(l, "receivable_courier"), 0, "the courier collects nothing");
  assert.equal(on(l, "payable_courier"), 50, "but is still owed the delivery fee");
  assert.equal(on(l, "revenue"), 500, "revenue is booked in full at delivery");
  assert.equal(on(l, "wallet"), 0, "the money was banked earlier, not now");
});

test("a partial top-up leaves the rest as COD", () => {
  // 200 deposit + 150 transferred = 350; 200 still to collect at the door.
  const l = buildOrderDeliveredLines({
    items,
    goodsTotal: 500,
    shippingFee: 50,
    depositAmount: 350,
    codAmount: 200,
    courierId: "courier-1",
  });
  assert.equal(on(l, "receivable_courier"), 200);
  assert.equal(on(l, "revenue"), 500);
});

test("the till total is the same however the money arrived", () => {
  // Paid up front vs topped up later: the Treasury must not care.
  const upFront = buildOrderPaymentLines({ wallet: "inStoreSafe", amount: 550 });
  const inTwo = [
    ...buildOrderPaymentLines({ wallet: "inStoreSafe", amount: 200 }),
    ...buildOrderPaymentLines({ wallet: "inStoreSafe", amount: 350 }),
  ];
  assert.equal(on(upFront, "wallet"), on(inTwo, "wallet"));
});
