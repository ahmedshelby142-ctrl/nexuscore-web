/**
 * المرتجعات والاستبدال — the same business event, from four screens.
 *
 *     node --test scripts/check_returns.mjs
 *
 * A return is an octopus: POS, الجملة, الطلبات and the standalone screen can
 * all start one, and every arm has to reach the same six places —
 *
 *     stock +        the units are physically back
 *     cogs  −        their cost stops being a cost of goods SOLD
 *     wallet −       the refund actually handed over
 *     revenue −      the sale reversed
 *     expense +      the courier's fee, but ONLY for a return
 *     customer_ltv − what they spent, un-spent
 *
 * An exchange is a return AND a sale. Both legs must be booked, or the till
 * ends up richer than the drawer.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildReturnConfirmedLines, buildOrderRTOLines } from "../src/lib/ledger/orders.ts";
import { buildSaleLines } from "../src/lib/ledger/sales.ts";
import {
  buildWholesaleReturnLines,
  reconcileWholesaleReturn,
} from "../src/lib/ledger/wholesale.ts";
import { round } from "../src/lib/math.ts";
import {
  shippingFeeFor,
  isRepeatReturner,
  clearsShippingDebt,
} from "../src/lib/shippingRates.ts";

const on = (l, a) => l.filter((x) => x.account === a).reduce((s, x) => s + (x.amount ?? 0), 0);
const qtyOn = (l, a, id) =>
  l.filter((x) => x.account === a && (id === undefined || x.subjectId === id))
    .reduce((s, x) => s + (x.qty ?? 0), 0);

const oldItem = { productId: "old", quantity: 1, unitPrice: 500, unitCost: 300 };

// ── a plain refund reverses the whole footprint ─────────────────────────────

test("a refund reverses stock, cogs, cash, revenue and LTV together", () => {
  const l = buildReturnConfirmedLines({
    items: [oldItem],
    refundAmount: 500,
    wallet: "inStoreSafe",
    revenueAmount: 500,
    customerId: "c1",
  });
  assert.equal(qtyOn(l, "stock", "old"), 1, "the unit is back on the shelf");
  assert.equal(on(l, "cogs"), -300, "its cost is no longer a cost of goods sold");
  assert.equal(on(l, "wallet"), -500, "the money left the till");
  assert.equal(on(l, "revenue"), -500);
  assert.equal(on(l, "customer_ltv"), -500, "the CRM must not think they still spent it");
});

test("a refund with no customer writes no LTV line", () => {
  const l = buildReturnConfirmedLines({
    items: [oldItem],
    refundAmount: 500,
    wallet: "inStoreSafe",
    revenueAmount: 500,
  });
  assert.equal(on(l, "customer_ltv"), 0);
});

// ── the exchange, from both origins, must agree ─────────────────────────────

/** Swap a 500 for a 600: the customer hands over 100. */
const swapLegs = (refundAmount) => [
  ...buildReturnConfirmedLines({
    items: [oldItem],
    refundAmount,
    wallet: "inStoreSafe",
    revenueAmount: 500,
    customerId: "c1",
  }),
  ...buildSaleLines({
    items: [{ productId: "new", quantity: 1, unitPrice: 600, unitCost: 350 }],
    wallet: "inStoreSafe",
    customerId: "c1",
    channel: "exchange",
  }),
];

test("an exchange takes only the DIFFERENCE into the till", () => {
  // Suppressing the refund leg (refundAmount 0) booked +600 for 100 of cash.
  const l = swapLegs(500);
  assert.equal(on(l, "wallet"), 100, "exactly what the customer handed over");
  assert.equal(on(l, "revenue"), 100);
  assert.equal(on(l, "customer_ltv"), 100);
});

test("a cheaper swap hands money BACK", () => {
  const l = [
    ...buildReturnConfirmedLines({
      items: [oldItem],
      refundAmount: 500,
      wallet: "inStoreSafe",
      revenueAmount: 500,
      customerId: "c1",
    }),
    ...buildSaleLines({
      items: [{ productId: "new", quantity: 1, unitPrice: 400, unitCost: 200 }],
      wallet: "inStoreSafe",
      customerId: "c1",
      channel: "exchange",
    }),
  ];
  assert.equal(on(l, "wallet"), -100, "the shop owes the customer the difference");
});

test("an even swap moves no money at all", () => {
  const l = [
    ...buildReturnConfirmedLines({
      items: [oldItem],
      refundAmount: 500,
      wallet: "inStoreSafe",
      revenueAmount: 500,
    }),
    ...buildSaleLines({
      items: [{ productId: "new", quantity: 1, unitPrice: 500, unitCost: 250 }],
      wallet: "inStoreSafe",
      channel: "exchange",
    }),
  ];
  assert.equal(on(l, "wallet"), 0);
  assert.equal(on(l, "revenue"), 0);
});

test("an exchange swaps the stock both ways", () => {
  const l = swapLegs(500);
  assert.equal(qtyOn(l, "stock", "old"), 1, "old comes back");
  assert.equal(qtyOn(l, "stock", "new"), -1, "new goes out");
});

test("POS reaches the same answer through one signed cart", () => {
  // POS puts the return on the SAME cart as a negative quantity. Different
  // route, identical books — that is what makes it one business event.
  const pos = buildSaleLines({
    items: [
      { productId: "old", quantity: -1, unitPrice: 500, unitCost: 300 },
      { productId: "new", quantity: 1, unitPrice: 600, unitCost: 350 },
    ],
    wallet: "inStoreSafe",
    customerId: "c1",
    channel: "pos",
  });
  const standalone = swapLegs(500);
  for (const account of ["wallet", "revenue", "customer_ltv", "cogs"]) {
    assert.equal(on(pos, account), on(standalone, account), `${account} must match`);
  }
  assert.equal(qtyOn(pos, "stock", "old"), qtyOn(standalone, "stock", "old"));
  assert.equal(qtyOn(pos, "stock", "new"), qtyOn(standalone, "stock", "new"));
});

// ── discount integrity ──────────────────────────────────────────────────────

/** The screen's rule: scale list prices by what the order actually cost. */
const factor = (listTotal, paidTotal) =>
  !listTotal || !Number.isFinite(paidTotal) || paidTotal >= listTotal ? 1 : paidTotal / listTotal;

test("a partial return refunds what was PAID, not the list price", () => {
  // 2 × 500 = 1000 list, bought for 900 after 10% off. One item back = 450.
  const f = factor(1000, 900);
  assert.equal(round(1 * 500 * f), 450, "not 500 — the shop would pay the promo twice");
});

test("returning everything adds back up to exactly what was paid", () => {
  const f = factor(1000, 900);
  assert.equal(round(2 * 500 * f), 900);
});

test("an undiscounted order refunds the list price unchanged", () => {
  assert.equal(factor(1000, 1000), 1);
  assert.equal(round(1 * 500 * factor(1000, 1000)), 500);
});

test("a missing or nonsense total never inflates a refund", () => {
  for (const paid of [undefined, null, NaN, 1200]) {
    assert.equal(factor(1000, paid), 1, `paid ${String(paid)} must not scale UP`);
  }
  assert.equal(factor(0, 900), 1, "no list total to scale against");
});

// ── bundles come back as components ─────────────────────────────────────────

test("returning a bundle restocks its components, not the virtual product", () => {
  const l = buildReturnConfirmedLines({
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
    refundAmount: 700,
    wallet: "inStoreSafe",
    revenueAmount: 700,
  });
  assert.equal(qtyOn(l, "stock", "shirt"), 4, "2 per box × 2 boxes");
  assert.equal(qtyOn(l, "stock", "pants"), 2);
  assert.equal(qtyOn(l, "stock", "box"), 0, "a بوكس has no shelf of its own");
});

// ── the courier fee: ours only on a return ──────────────────────────────────

test("a return fee is the shop's expense", () => {
  const l = buildReturnConfirmedLines({
    items: [oldItem],
    refundAmount: 500,
    wallet: "inStoreSafe",
    revenueAmount: 500,
    returnFee: 40,
    movement: "return",
    courierId: "default",
  });
  assert.equal(on(l, "expense"), 40, "goods coming back is the one fee we bear");
  assert.equal(on(l, "payable_courier"), 40, "and we owe the courier for it");
});

test("an exchange fee is the customer's, never our cost", () => {
  const l = buildReturnConfirmedLines({
    items: [oldItem],
    refundAmount: 0,
    wallet: "inStoreSafe",
    revenueAmount: 500,
    returnFee: 45,
    movement: "exchange",
    courierId: "default",
  });
  assert.equal(on(l, "expense"), 0, "booking this would invent a cost we never bore");
  assert.equal(on(l, "payable_courier"), 45);
  assert.equal(on(l, "receivable_courier"), 45, "they collect it for us — it nets out");
});

test("a fee with no courier is refused", () => {
  assert.throws(
    () =>
      buildReturnConfirmedLines({
        items: [oldItem],
        refundAmount: 500,
        wallet: "inStoreSafe",
        revenueAmount: 500,
        returnFee: 40,
      }),
    /needs a courier/,
  );
});

// ── RTO: never delivered, so nothing to reverse ─────────────────────────────

test("a refused delivery restocks without touching revenue or LTV", () => {
  const l = buildOrderRTOLines({ items: [oldItem], returnFee: 40, courierId: "default" });
  assert.equal(qtyOn(l, "stock", "old"), 1);
  assert.equal(on(l, "revenue"), 0, "it was never booked — there is nothing to reverse");
  assert.equal(on(l, "customer_ltv"), 0);
  assert.equal(on(l, "cogs"), 0, "COGS was never booked either");
  assert.equal(on(l, "expense"), 40, "but we still paid to get it back");
});

// ── guards ──────────────────────────────────────────────────────────────────

test("a return of nothing, or of a negative refund, is refused", () => {
  assert.throws(
    () =>
      buildReturnConfirmedLines({
        items: [{ ...oldItem, quantity: 0 }],
        refundAmount: 0,
        wallet: "inStoreSafe",
        revenueAmount: 0,
      }),
    /must be positive/,
  );
  assert.throws(
    () =>
      buildReturnConfirmedLines({
        items: [oldItem],
        refundAmount: -1,
        wallet: "inStoreSafe",
        revenueAmount: 500,
      }),
    /cannot be negative/,
  );
});


// ── التسوية الذكية: a wholesale return settled against the client's debt ────
//
//   R < D    debt absorbs the return; P is a repayment and the till RECEIVES it
//   R >= D   debt clears and the surplus is paid OUT; P is meaningless

/** 5 × 100 = 500 returned, cost 60 each. */
const wsItems = [{ productId: "p1", quantity: 5, unitPrice: 100, unitCost: 60 }];
const wsReturn = (currentDebt, paidNow) =>
  buildWholesaleReturnLines({
    items: wsItems,
    clientId: "wc1",
    wallet: "inStoreSafe",
    currentDebt,
    paidNow,
  });

test("the CTO scenario: debt 800, return 500, paid 150", () => {
  const l = wsReturn(800, 150);
  assert.equal(on(l, "receivable_client"), -650, "debt drops by R + P");
  assert.equal(on(l, "wallet"), 150, "the till RECEIVES the repayment");
  assert.equal(800 + on(l, "receivable_client"), 150, "new debt");
  // The goods reverse exactly as in a retail return.
  assert.equal(on(l, "revenue"), -500);
  assert.equal(on(l, "cogs"), -300);
  assert.equal(qtyOn(l, "stock", "p1"), 5);
});

test("R < D with no cash: the debt simply absorbs the return", () => {
  const l = wsReturn(800, 0);
  assert.equal(on(l, "receivable_client"), -500);
  assert.equal(on(l, "wallet"), 0, "no money changes hands at all");
});

test("R > D: the debt clears and the surplus is paid out", () => {
  const l = wsReturn(300, 0);
  assert.equal(on(l, "receivable_client"), -300, "only what was owed");
  assert.equal(on(l, "wallet"), -200, "500 back, 300 owed → 200 across the counter");
});

test("R == D: the account squares to zero with no cash", () => {
  const l = wsReturn(500, 0);
  assert.equal(on(l, "receivable_client"), -500);
  assert.equal(on(l, "wallet"), 0);
});

test("a client with no debt gets the whole value in cash", () => {
  const l = wsReturn(0, 0);
  assert.equal(on(l, "receivable_client"), 0, "no debt line — there was no debt");
  assert.equal(on(l, "wallet"), -500);
});

test("paying when the return already clears the debt is refused", () => {
  // Nothing is left to pay down; taking cash would push them into credit
  // through a door meant for repayment.
  assert.throws(() => wsReturn(300, 50), /already clears the debt/);
  assert.throws(() => wsReturn(500, 10), /already clears the debt/);
});

test("the repayment never turns into a refund, or vice versa", () => {
  // Cash in and cash out can never both happen: a surplus means the debt is
  // already gone, and a repayment means it is not.
  for (const [debt, paid] of [[800, 150], [800, 0], [300, 0], [500, 0], [0, 0]]) {
    const wallet = on(wsReturn(debt, paid), "wallet");
    const expected = paid - Math.max(0, 500 - debt);
    assert.equal(wallet, expected, `debt ${debt}, paid ${paid}`);
  }
});

test("negative debt or negative payment is refused", () => {
  assert.throws(() => wsReturn(-1, 0), /debt cannot be negative/);
  assert.throws(() => wsReturn(800, -5), /paid cannot be negative/);
});

test("a wholesale return of nothing is refused", () => {
  assert.throws(
    () =>
      buildWholesaleReturnLines({
        items: [{ productId: "p1", quantity: 0, unitPrice: 100, unitCost: 60 }],
        clientId: "wc1",
        currentDebt: 100,
      }),
    /must be positive/,
  );
});

test("money moving with no wallet named is refused", () => {
  assert.throws(
    () =>
      buildWholesaleReturnLines({
        items: wsItems,
        clientId: "wc1",
        currentDebt: 0, // full cash refund, so a till is required
      }),
    /needs a wallet/,
  );
});

test("a debt-absorbed return needs no wallet at all", () => {
  assert.doesNotThrow(() =>
    buildWholesaleReturnLines({ items: wsItems, clientId: "wc1", currentDebt: 800 }),
  );
});

test("a returned بوكس credits the components", () => {
  const l = buildWholesaleReturnLines({
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
    clientId: "wc1",
    currentDebt: 1000,
  });
  assert.equal(qtyOn(l, "stock", "shirt"), 4);
  assert.equal(qtyOn(l, "stock", "pants"), 2);
  assert.equal(qtyOn(l, "stock", "box"), 0, "no shelf of its own");
  assert.equal(on(l, "receivable_client"), -700, "2 boxes at 350");
});

test("wholesale returns write no customer_ltv", () => {
  // Traders are a separate directory from the retail customer base; mixing
  // them would inflate retail LTV with trade returns.
  assert.equal(on(wsReturn(800, 150), "customer_ltv"), 0);
});


// ── the shared derivation the three screens draw from ───────────────────────

test("the panel and the ledger agree on the CTO numbers", () => {
  const r = reconcileWholesaleReturn(500, 800, "150");
  assert.deepEqual(r, { remainingDebt: 300, cashBack: 0, paidNow: 150, newDebt: 150 });

  // And the builder, given that same paidNow, moves exactly those amounts.
  const l = buildWholesaleReturnLines({
    items: [{ productId: "p1", quantity: 5, unitPrice: 100, unitCost: 60 }],
    clientId: "wc1",
    wallet: "inStoreSafe",
    currentDebt: 800,
    paidNow: r.paidNow,
  });
  assert.equal(800 + on(l, "receivable_client"), r.newDebt, "screen and books must land together");
  assert.equal(on(l, "wallet"), r.paidNow);
});

test("a repayment over the remaining debt is clamped, not refused", () => {
  // A cashier typing 999 means "settle it all", not "put them in credit".
  const r = reconcileWholesaleReturn(500, 800, "999");
  assert.equal(r.paidNow, 300, "capped at what is left");
  assert.equal(r.newDebt, 0);
});

test("when the return outruns the debt there is nothing to pay", () => {
  const r = reconcileWholesaleReturn(500, 150, "100");
  assert.equal(r.remainingDebt, 0);
  assert.equal(r.cashBack, 350);
  assert.equal(r.paidNow, 0, "clamped to zero — the input is not even shown");
  assert.equal(r.newDebt, 0);
});

test("nonsense inputs never invent money", () => {
  for (const bad of ["", "abc", undefined, null, NaN, -50]) {
    assert.equal(reconcileWholesaleReturn(500, 800, bad).paidNow, 0, `input ${String(bad)}`);
  }
  assert.equal(reconcileWholesaleReturn(-5, 800, 0).remainingDebt, 800, "a negative return is nothing");
  assert.equal(reconcileWholesaleReturn(500, -5, 0).cashBack, 500, "a negative debt is no debt");
});

test("every screen reaches the same answer from the same two numbers", () => {
  // POS, الطلبات and الجملة all call this; drift is only possible if one of
  // them stops doing so.
  for (const [R, D, P] of [[500, 800, 150], [500, 800, 0], [500, 300, 0], [500, 500, 0], [500, 0, 0]]) {
    const r = reconcileWholesaleReturn(R, D, P);
    const l = buildWholesaleReturnLines({
      items: [{ productId: "p1", quantity: 1, unitPrice: R, unitCost: 0 }],
      clientId: "wc1",
      wallet: "inStoreSafe",
      currentDebt: D,
      paidNow: r.paidNow,
    });
    assert.equal(on(l, "wallet"), r.paidNow - r.cashBack, `wallet for R=${R} D=${D} P=${P}`);
    assert.equal(D + on(l, "receivable_client"), r.newDebt, `debt for R=${R} D=${D} P=${P}`);
  }
});


// ════════════════════════════════════════════════════════════════════════════
// Store policy: the deposit is never refunded, the shop eats the return trip,
// and a customer who returns pays double to be delivered to again.
// ════════════════════════════════════════════════════════════════════════════

// ── 1. the deposit is forfeited, not refunded ───────────────────────────────

test("a returned order refunds the COD but keeps the deposit", () => {
  // 500 of goods, 200 paid as deposit. Only 300 goes back across the counter.
  const l = buildReturnConfirmedLines({
    items: [{ productId: "p1", quantity: 1, unitPrice: 500, unitCost: 300 }],
    refundAmount: 500,
    forfeitedDeposit: 200,
    wallet: "inStoreSafe",
    revenueAmount: 500,
    customerId: "c1",
  });
  assert.equal(on(l, "wallet"), -300, "the deposit never leaves the till");
});

test("the retained deposit is BOOKED, not just quietly kept", () => {
  const l = buildReturnConfirmedLines({
    items: [{ productId: "p1", quantity: 1, unitPrice: 500, unitCost: 300 }],
    refundAmount: 500,
    forfeitedDeposit: 200,
    wallet: "inStoreSafe",
    revenueAmount: 500,
    channel: "ecommerce",
  });
  const forfeit = l.filter((x) => x.subjectId === "forfeited_deposit");
  assert.equal(forfeit.length, 1, "it has its own revenue subject");
  assert.equal(forfeit[0].amount, 200);
  // Full reversal of the sale, plus the retained income = net −300.
  assert.equal(on(l, "revenue"), -300, "which is exactly the cash that left");
  assert.equal(on(l, "wallet"), on(l, "revenue"), "cash and income move together");
});

test("LTV keeps what the customer actually left behind", () => {
  const l = buildReturnConfirmedLines({
    items: [{ productId: "p1", quantity: 1, unitPrice: 500, unitCost: 300 }],
    refundAmount: 500,
    forfeitedDeposit: 200,
    wallet: "inStoreSafe",
    revenueAmount: 500,
    customerId: "c1",
  });
  assert.equal(on(l, "customer_ltv"), -300, "they really did spend the 200");
});

test("a fully prepaid order returns only what is left after the deposit", () => {
  // Paid 500 entirely as deposit: nothing is refundable at all.
  const l = buildReturnConfirmedLines({
    items: [{ productId: "p1", quantity: 1, unitPrice: 500, unitCost: 300 }],
    refundAmount: 500,
    forfeitedDeposit: 500,
    wallet: "inStoreSafe",
    revenueAmount: 500,
  });
  assert.equal(on(l, "wallet"), 0, "no wallet line at all");
  assert.equal(on(l, "revenue"), 0, "reversal and retention cancel exactly");
});

test("keeping more than the customer paid is refused", () => {
  assert.throws(
    () =>
      buildReturnConfirmedLines({
        items: [{ productId: "p1", quantity: 1, unitPrice: 500, unitCost: 300 }],
        refundAmount: 500,
        forfeitedDeposit: 900,
        wallet: "inStoreSafe",
        revenueAmount: 500,
      }),
    /more than the refund/,
    "a forfeit is not a charge",
  );
});

test("an order with no deposit behaves exactly as before", () => {
  const l = buildReturnConfirmedLines({
    items: [{ productId: "p1", quantity: 1, unitPrice: 500, unitCost: 300 }],
    refundAmount: 500,
    wallet: "inStoreSafe",
    revenueAmount: 500,
    customerId: "c1",
  });
  assert.equal(on(l, "wallet"), -500);
  assert.equal(on(l, "revenue"), -500);
  assert.equal(l.filter((x) => x.subjectId === "forfeited_deposit").length, 0);
});

test("a refused delivery explains the cash it is sitting on", () => {
  // RTO writes no wallet line — the deposit was banked at placement and stays.
  // Without the revenue line the till held money no report could account for.
  const l = buildOrderRTOLines({
    items: [{ productId: "p1", quantity: 1, unitPrice: 500, unitCost: 300 }],
    returnFee: 40,
    courierId: "nile",
    forfeitedDeposit: 200,
    customerId: "c1",
  });
  assert.equal(on(l, "wallet"), 0, "nothing moves — it never left");
  assert.equal(on(l, "revenue"), 200, "but the income is now named");
  assert.equal(on(l, "customer_ltv"), 200);
});

// ── 2. the shop bears the return trip ───────────────────────────────────────

test("a return books the courier's fee as OUR expense and OUR debt", () => {
  const l = buildReturnConfirmedLines({
    items: [{ productId: "p1", quantity: 1, unitPrice: 500, unitCost: 300 }],
    refundAmount: 500,
    forfeitedDeposit: 200,
    wallet: "inStoreSafe",
    revenueAmount: 500,
    returnFee: 40,
    movement: "return",
    courierId: "nile",
  });
  assert.equal(on(l, "expense"), 40, "the failed trip is a real cost");
  assert.equal(on(l, "payable_courier"), 40, "and the courier is owed it");
});

test("an RTO charges the trip too", () => {
  const l = buildOrderRTOLines({
    items: [{ productId: "p1", quantity: 1, unitPrice: 500, unitCost: 300 }],
    returnFee: 40,
    courierId: "nile",
  });
  assert.equal(on(l, "expense"), 40);
  assert.equal(on(l, "payable_courier"), 40);
});

test("the deposit does not cancel the shipping cost — both are booked", () => {
  // 200 kept, 40 paid out to the courier. Net +160, and BOTH visible.
  const l = buildOrderRTOLines({
    items: [{ productId: "p1", quantity: 1, unitPrice: 500, unitCost: 300 }],
    returnFee: 40,
    courierId: "nile",
    forfeitedDeposit: 200,
  });
  assert.equal(on(l, "revenue"), 200);
  assert.equal(on(l, "expense"), 40);
  assert.equal(on(l, "revenue") - on(l, "expense"), 160, "what the shop is left up by");
});

// ── 3. the repeat-returner penalty ──────────────────────────────────────────

test("a first-time customer pays the normal fee", () => {
  assert.equal(shippingFeeFor(50, { returned_orders_count: 0 }), 50);
  assert.equal(shippingFeeFor(50, null), 50, "and so does an unknown walk-in");
  assert.equal(shippingFeeFor(50, {}), 50);
});

test("a customer who owes a wasted trip pays double on the next order", () => {
  assert.equal(shippingFeeFor(50, { returned_orders_count: 1 }), 100);
  assert.equal(shippingFeeFor(50, { returned_orders_count: 7 }), 100, "double, not ×7");
});

test("free delivery stays free", () => {
  // Doubling zero is zero. A shop that waived the fee did not decide to
  // start charging one because of a past return.
  assert.equal(shippingFeeFor(0, { returned_orders_count: 3 }), 0);
});

test("the penalty touches shipping only, never the goods", () => {
  const goods = 1000;
  const base = 50;
  const penalised = shippingFeeFor(base, { returned_orders_count: 2 });
  assert.equal(goods + penalised, 1100, "1000 goods + 100 shipping");
  assert.equal(goods, 1000, "the shirt does not cost more");
});

test("nonsense counts never trigger the penalty", () => {
  for (const bad of [undefined, null, NaN, -1, "3"]) {
    assert.equal(isRepeatReturner({ returned_orders_count: bad }), false, `count ${String(bad)}`);
    assert.equal(shippingFeeFor(50, { returned_orders_count: bad }), 50);
  }
});


// ── cost recovery: the penalty is settled, not carried ──────────────────────
//
// Doubling recovers ONE wasted trip. The moment the recovering order lands, the
// debt is paid and the customer is back on the normal rate. A surcharge that
// never lifted would stop being recovery and start being a tax.

/**
 * What the delivery handler does, in one place, so it can be asserted.
 *
 * Decrement, never reset: three wasted trips cost the shop three trips, so they
 * take three doubled deliveries to pay back.
 */
const deliver = (customer, order) =>
  clearsShippingDebt(order)
    ? { ...customer, returned_orders_count: Math.max(0, (customer.returned_orders_count ?? 0) - 1) }
    : customer;

test("delivering the order that CHARGED the penalty clears the debt", () => {
  const before = { returned_orders_count: 1 };
  assert.equal(shippingFeeFor(50, before), 100, "they paid double on this one");

  const after = deliver(before, { shippingPenaltyApplied: true });
  assert.equal(after.returned_orders_count, 0, "debt settled");
  assert.equal(shippingFeeFor(50, after), 50, "and the next order is normal again");
});

test("delivering a NORMAL-priced order does not clear the debt", () => {
  // The trap: a customer with an order already in flight at the normal rate.
  // Resetting on any delivery would wipe the debt without recovering a thing.
  const before = { returned_orders_count: 1 };
  const after = deliver(before, { shippingPenaltyApplied: undefined });
  assert.equal(after.returned_orders_count, 1, "still owed");
  assert.equal(shippingFeeFor(50, after), 100, "so the next order still recovers it");
});

test("an order placed before the flag existed leaves the debt standing", () => {
  // The safe direction: it costs the shop nothing, and settles itself on the
  // customer's next order, which will carry the flag.
  assert.equal(clearsShippingDebt({}), false);
  assert.equal(clearsShippingDebt(null), false);
  assert.equal(clearsShippingDebt(undefined), false);
  assert.equal(clearsShippingDebt({ shippingPenaltyApplied: false }), false);
});

test("the full cycle: return, recover, back to normal", () => {
  let customer = { returned_orders_count: 0 };
  assert.equal(shippingFeeFor(50, customer), 50, "starts clean");

  // They ignore the courier; the trip is wasted.
  customer = { ...customer, returned_orders_count: customer.returned_orders_count + 1 };
  assert.equal(shippingFeeFor(50, customer), 100, "next order recovers the trip");

  // That order is delivered and paid for: the one trip owed is settled.
  customer = deliver(customer, { shippingPenaltyApplied: true });
  assert.equal(customer.returned_orders_count, 0);
  assert.equal(shippingFeeFor(50, customer), 50, "debt paid — normal rate returns");

  // And it does not creep back on its own.
  customer = deliver(customer, { shippingPenaltyApplied: true });
  assert.equal(customer.returned_orders_count, 0);
  assert.equal(shippingFeeFor(50, customer), 50);
});

test("a second failed trip starts a new recovery", () => {
  let customer = deliver({ returned_orders_count: 1 }, { shippingPenaltyApplied: true });
  assert.equal(shippingFeeFor(50, customer), 50);

  customer = { ...customer, returned_orders_count: 1 }; // they do it again
  assert.equal(shippingFeeFor(50, customer), 100, "recovered once more, not compounded");
});

test("clearing a debt nobody owes is a no-op", () => {
  const clean = { returned_orders_count: 0 };
  assert.deepEqual(deliver(clean, { shippingPenaltyApplied: true }), clean);
});


// ── every wasted trip is recovered, not just the first ──────────────────────

test("three returns take three doubled deliveries to settle", () => {
  let c = { returned_orders_count: 3 };

  assert.equal(shippingFeeFor(50, c), 100, "1st order: still owed 3");
  c = deliver(c, { shippingPenaltyApplied: true });
  assert.equal(c.returned_orders_count, 2);

  assert.equal(shippingFeeFor(50, c), 100, "2nd order: still owed 2");
  c = deliver(c, { shippingPenaltyApplied: true });
  assert.equal(c.returned_orders_count, 1);

  assert.equal(shippingFeeFor(50, c), 100, "3rd order: still owed 1");
  c = deliver(c, { shippingPenaltyApplied: true });
  assert.equal(c.returned_orders_count, 0, "square");

  assert.equal(shippingFeeFor(50, c), 50, "4th order: back to normal");
});

test("the shop recovers exactly what it lost — no more, no less", () => {
  // Three wasted trips at 50 each = 150 lost. Three doubled deliveries recover
  // 50 extra apiece. Recovering once would have forgiven 100 of it.
  const base = 50;
  const returns = 3;
  let c = { returned_orders_count: returns };
  let recovered = 0;
  for (let i = 0; i < returns; i++) {
    recovered += shippingFeeFor(base, c) - base;
    c = deliver(c, { shippingPenaltyApplied: true });
  }
  assert.equal(recovered, returns * base, "150 lost, 150 recovered");
  assert.equal(c.returned_orders_count, 0);
  assert.equal(shippingFeeFor(base, c), base);
});

test("a return partway through recovery adds to the debt", () => {
  let c = { returned_orders_count: 2 };
  c = deliver(c, { shippingPenaltyApplied: true });   // one settled
  assert.equal(c.returned_orders_count, 1);

  c = { ...c, returned_orders_count: c.returned_orders_count + 1 }; // they return again
  assert.equal(c.returned_orders_count, 2, "the debt accumulates");
  assert.equal(shippingFeeFor(50, c), 100, "still double, never quadruple");
});

test("settling never drives the debt below zero", () => {
  // A count corrupted negative by a bad sync must not make settling INCREASE it.
  const c = deliver({ returned_orders_count: 0 }, { shippingPenaltyApplied: true });
  assert.equal(c.returned_orders_count, 0);
  const odd = deliver({ returned_orders_count: -5 }, { shippingPenaltyApplied: true });
  assert.equal(odd.returned_orders_count, 0);
  assert.equal(shippingFeeFor(50, odd), 50);
});
