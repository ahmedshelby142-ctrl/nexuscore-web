/**
 * استبدال — the shared rules, and the money an exchange really moves.
 *
 *     node --test scripts/check_exchange.mjs
 *
 * Two things are asserted here.
 *
 * The first is the eligibility and valuation shared by both surfaces, which
 * used to be three disagreeing copies.
 *
 * The second is the one that matters: that an exchange, booked the way the
 * architecture books it — a full-value replacement order plus a full-value
 * return of the original — nets to exactly the price difference, in the right
 * direction, without anything anywhere computing a difference and moving money
 * by it. That property is what stops a swap inventing revenue.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canExchange,
  exchangeBlock,
  discountFactor,
  returnedValue,
  priceDifference,
  remainingQuantities,
  movementFor,
  exchangedItems,
  exchangedItemsLabel,
  returnableUnits,
  remainingUnits,
  returnTypeLabel,
} from "../src/lib/exchange.ts";
import {
  buildOrderPlacedLines,
  buildReturnConfirmedLines,
  buildOrderDeliveredLines,
  buildOrderCancelledLines,
  buildOrderRTOLines,
} from "../src/lib/ledger/orders.ts";
import { buildSaleLines } from "../src/lib/ledger/sales.ts";
import {
  countsAsWastedTrip,
  shippingFeeFor,
  shippingBorneBy,
  toReturnCause,
  RETURN_CAUSES,
  RETURN_CAUSE_LABELS,
} from "../src/lib/shippingRates.ts";

const on = (l, a) => l.filter((x) => x.account === a).reduce((s, x) => s + (x.amount ?? 0), 0);
const qtyOn = (l, a, id) =>
  l.filter((x) => x.account === a && (id === undefined || x.subjectId === id))
    .reduce((s, x) => s + (x.qty ?? 0), 0);

/** A delivered order: one item, list 500, no discount. */
const delivered = {
  id: "o1",
  status: "delivered",
  stockItems: [{ productId: "A", quantity: 1, unitPrice: 500, unitCost: 300 }],
  totalAmount: 500,
};

// ── eligibility ─────────────────────────────────────────────────────────────

test("only a delivered order can be exchanged", () => {
  assert.equal(canExchange(delivered), true);
  for (const status of ["pending", "shipped", "returned", "cancelled"]) {
    assert.equal(
      exchangeBlock({ ...delivered, status }),
      "not_delivered",
      `${status} must not offer an exchange`,
    );
  }
});

test("an order whose goods already came back cannot be exchanged", () => {
  assert.equal(
    exchangeBlock({ ...delivered, returnConfirmedAt: new Date() }),
    "already_returned",
  );
});

test("one replacement per order — a second is refused", () => {
  const replacement = { id: "o2", status: "pending", original_order_id: "o1" };
  assert.equal(exchangeBlock(delivered, [], [delivered, replacement]), "already_replaced");
});

test("an order does not count as its own replacement", () => {
  // A replacement order carries `original_order_id`; if the check forgot to
  // skip the order itself, a self-referencing row would lock it forever.
  const self = { ...delivered, original_order_id: "o1" };
  assert.equal(exchangeBlock(self, [], [self]), null);
});

test("an order whose every line is already back has nothing left to swap", () => {
  const priors = [{ original_order_id: "o1", returned_items: [{ product_id: "A", quantity: 1 }] }];
  assert.equal(exchangeBlock(delivered, priors), "nothing_left");
});

// ── what is left, per line ──────────────────────────────────────────────────

test("a partial return lowers the ceiling for the next one", () => {
  const order = {
    ...delivered,
    stockItems: [{ productId: "A", quantity: 3, unitPrice: 500, unitCost: 300 }],
    totalAmount: 1500,
  };
  const priors = [{ original_order_id: "o1", returned_items: [{ product_id: "A", quantity: 2 }] }];
  assert.equal(remainingQuantities(order, priors).get("A"), 1, "2 of 3 are already back");
  assert.equal(canExchange(order, priors), true, "the third can still be swapped");
});

test("returns recorded against a DIFFERENT order do not lower this one", () => {
  const priors = [{ original_order_id: "other", returned_items: [{ product_id: "A", quantity: 1 }] }];
  assert.equal(remainingQuantities(delivered, priors).get("A"), 1);
});

test("a corrupt record claiming more than went out cannot go negative", () => {
  const priors = [{ original_order_id: "o1", returned_items: [{ product_id: "A", quantity: 9 }] }];
  assert.equal(remainingQuantities(delivered, priors).get("A"), 0);
});

// ── valuation ───────────────────────────────────────────────────────────────

test("with no discount a returned line is worth its list price", () => {
  assert.equal(discountFactor(delivered), 1);
  assert.equal(returnedValue(delivered, [{ productId: "A", quantity: 1, unitPrice: 500 }]), 500);
});

test("CASE D — a discounted order refunds what was PAID, not what was listed", () => {
  // Two at 500 = 1000 list, bought for 900. Returning one is worth 450.
  const discounted = {
    ...delivered,
    stockItems: [{ productId: "A", quantity: 2, unitPrice: 500, unitCost: 300 }],
    totalAmount: 900,
  };
  assert.equal(discountFactor(discounted), 0.9);
  assert.equal(
    returnedValue(discounted, [{ productId: "A", quantity: 1, unitPrice: 500 }]),
    450,
    "refunding 500 would pay the promotion a second time",
  );
});

test("a totalAmount above list never refunds more than list", () => {
  // Shipping accidentally folded into totalAmount must not inflate a refund.
  const odd = { ...delivered, totalAmount: 560 };
  assert.equal(discountFactor(odd), 1);
});

// ── the price difference, as shown ──────────────────────────────────────────

test("CASE A — same price swaps to zero", () => {
  assert.equal(priceDifference(500, 500), 0);
});

test("CASE B — a dearer replacement is owed BY the customer", () => {
  assert.ok(priceDifference(600, 500) > 0);
  assert.equal(priceDifference(600, 500), 100);
});

test("CASE C — a cheaper replacement is owed TO the customer", () => {
  assert.ok(priceDifference(400, 500) < 0);
  assert.equal(priceDifference(400, 500), -100);
});

// ── the money the LEDGER actually moves ─────────────────────────────────────

/**
 * Book a whole exchange the way the architecture books it and add up what the
 * shop ends with. Nothing here passes a "difference" to anything.
 */
function bookExchange({ oldPrice, oldCost, newPrice, newCost }) {
  const oldItem = { productId: "A", quantity: 1, unitPrice: oldPrice, unitCost: oldCost };
  const newItem = { productId: "B", quantity: 1, unitPrice: newPrice, unitCost: newCost };

  // 1. the replacement order is placed — its goods are reserved
  const placed = buildOrderPlacedLines({ items: [newItem] });

  // 2/3. the original comes back, as an EXCHANGE (fee is the customer's)
  const returned = buildReturnConfirmedLines({
    items: [oldItem],
    refundAmount: oldPrice,
    wallet: "inStoreSafe",
    revenueAmount: oldPrice,
    returnFee: 40,
    movement: "exchange",
    courierId: "cr1",
    customerId: "c1",
    channel: "ecommerce",
  });

  // 4. the replacement is delivered — full price, like any other order
  const dlv = buildOrderDeliveredLines({
    items: [newItem],
    goodsTotal: newPrice,
    codAmount: newPrice,
    courierId: "cr1",
    customerId: "c1",
    channel: "ecommerce",
  });

  const all = [...placed, ...returned, ...dlv];
  return { placed, returned, dlv, all };
}

test("CASE A — an even swap books no net revenue and no net profit", () => {
  const { all } = bookExchange({ oldPrice: 500, oldCost: 300, newPrice: 500, newCost: 300 });
  assert.equal(on(all, "revenue"), 0, "an even swap is not a sale");
  assert.equal(on(all, "cogs"), 0, "nor a cost");
  assert.equal(on(all, "customer_ltv"), 0, "the customer spent nothing new");
});

test("CASE B — a dearer replacement books exactly the difference as revenue", () => {
  const { all } = bookExchange({ oldPrice: 500, oldCost: 300, newPrice: 600, newCost: 350 });
  assert.equal(on(all, "revenue"), 100, "600 booked minus 500 reversed");
  assert.equal(on(all, "cogs"), 50, "350 out minus 300 back");
  assert.equal(on(all, "customer_ltv"), 100);
});

test("CASE C — a cheaper replacement books a NEGATIVE difference", () => {
  const { all } = bookExchange({ oldPrice: 500, oldCost: 300, newPrice: 400, newCost: 250 });
  assert.equal(on(all, "revenue"), -100, "the shop is 100 down, not 400 up");
  assert.equal(on(all, "customer_ltv"), -100);
});

test("the goods physically swap: the old one back, the new one out", () => {
  const { all } = bookExchange({ oldPrice: 500, oldCost: 300, newPrice: 600, newCost: 350 });
  assert.equal(qtyOn(all, "stock", "A"), 1, "the returned item is on the shelf");
  assert.equal(qtyOn(all, "stock", "B"), -1, "the replacement left it");
});

test("an exchange trip is NEVER the shop's expense", () => {
  const { returned } = bookExchange({ oldPrice: 500, oldCost: 300, newPrice: 600, newCost: 350 });
  assert.equal(on(returned, "expense"), 0, "the customer pays an exchange trip");
  // We still owe the courier, and still collect it from the customer — the two
  // cancel, which is what a pass-through must do.
  assert.equal(
    on(returned, "payable_courier") - on(returned, "receivable_courier"),
    0,
    "the fee nets to nothing for the shop",
  );
});

test("a plain RETURN's trip still IS the shop's expense", () => {
  // The other half of the same branch — proof the exchange case did not just
  // delete the expense for everyone.
  const l = buildReturnConfirmedLines({
    items: [{ productId: "A", quantity: 1, unitPrice: 500, unitCost: 300 }],
    refundAmount: 500,
    wallet: "inStoreSafe",
    revenueAmount: 500,
    returnFee: 40,
    movement: "return",
    courierId: "cr1",
  });
  assert.equal(on(l, "expense"), 40);
});

// ── the regression that started this ────────────────────────────────────────

test("a replacement order never carries a negative line", () => {
  // The e-commerce screen used to push the RETURNED item into the same cart as
  // the replacement, at quantity −1. This is what it hit, every single time.
  assert.throws(
    () =>
      buildOrderPlacedLines({
        items: [
          { productId: "A", quantity: -1, unitPrice: 500, unitCost: 300 },
          { productId: "B", quantity: 1, unitPrice: 600, unitCost: 350 },
        ],
      }),
    /must be positive/,
    "the builder refuses it — so the screen must never build one",
  );
});

// ── the two surfaces must agree ─────────────────────────────────────────────

/**
 * The POS books a swap as ONE signed `sale`: the returned lines go into the
 * cart at a negative quantity, the replacement at a positive one. A different
 * event shape from the e-commerce path, because the physical process is
 * different — a counter swap is instant, an e-commerce swap is two courier
 * trips days apart.
 *
 * Different shape is allowed. A different ANSWER is not. This is the assertion
 * that keeps the two surfaces honest about that.
 */
function bookPosExchange({ oldPrice, oldCost, newPrice, newCost }) {
  return buildSaleLines({
    items: [
      { productId: "A", quantity: -1, unitPrice: oldPrice, unitCost: oldCost },
      { productId: "B", quantity: 1, unitPrice: newPrice, unitCost: newCost },
    ],
    wallet: "inStoreSafe",
    customerId: "c1",
    channel: "pos",
  });
}

for (const [name, prices] of [
  ["same price", { oldPrice: 500, oldCost: 300, newPrice: 500, newCost: 300 }],
  ["dearer", { oldPrice: 500, oldCost: 300, newPrice: 600, newCost: 350 }],
  ["cheaper", { oldPrice: 500, oldCost: 300, newPrice: 400, newCost: 250 }],
]) {
  test(`POS and e-commerce book the same net for a ${name} swap`, () => {
    const pos = bookPosExchange(prices);
    const eco = bookExchange(prices).all;

    assert.equal(on(pos, "revenue"), on(eco, "revenue"), "revenue must match");
    assert.equal(on(pos, "cogs"), on(eco, "cogs"), "cogs must match");
    assert.equal(on(pos, "customer_ltv"), on(eco, "customer_ltv"), "LTV must match");
    assert.equal(qtyOn(pos, "stock", "A"), qtyOn(eco, "stock", "A"), "the old unit comes back");
    assert.equal(qtyOn(pos, "stock", "B"), qtyOn(eco, "stock", "B"), "the new unit goes out");

    // And the net revenue IS the difference the operator was shown.
    assert.equal(
      on(pos, "revenue"),
      priceDifference(prices.newPrice, prices.oldPrice),
      "what the screen promised is what the books did",
    );
  });
}

test("a POS swap moves only the difference through the till", () => {
  // The till is the one place the two surfaces legitimately differ: the POS
  // collects (or refunds) on the spot, e-commerce collects at delivery. The
  // AMOUNT is still the difference and nothing more.
  assert.equal(on(bookPosExchange({ oldPrice: 500, oldCost: 300, newPrice: 600, newCost: 350 }), "wallet"), 100);
  assert.equal(on(bookPosExchange({ oldPrice: 500, oldCost: 300, newPrice: 400, newCost: 250 }), "wallet"), -100);
  assert.equal(on(bookPosExchange({ oldPrice: 500, oldCost: 300, newPrice: 500, newCost: 300 }), "wallet"), 0);
});

test("movementFor finds the replacement pointing back at the original", () => {
  const replacement = { id: "o2", status: "pending", original_order_id: "o1" };
  assert.equal(movementFor(delivered, [delivered]), "return", "no replacement — a plain return");
  assert.equal(movementFor(delivered, [delivered, replacement]), "exchange");
});

// ── partial QUANTITY exchange ───────────────────────────────────────────────
//
// The counter screen has always had a per-line quantity box, so partial
// quantities are part of this ERP's return model. The e-commerce screen used to
// take the whole remaining quantity whenever a line was marked — these are the
// assertions that keep it honest now that it does not.

const threeOf = {
  id: "o1",
  status: "delivered",
  stockItems: [{ productId: "A", quantity: 3, unitPrice: 500, unitCost: 300 }],
  totalAmount: 1500,
};

test("returning ONE of three values one, not three", () => {
  assert.equal(returnedValue(threeOf, [{ productId: "A", quantity: 1, unitPrice: 500 }]), 500);
  assert.equal(returnedValue(threeOf, [{ productId: "A", quantity: 3, unitPrice: 500 }]), 1500);
});

test("a one-of-three swap reverses only that one, everywhere", () => {
  const l = buildReturnConfirmedLines({
    items: [{ productId: "A", quantity: 1, unitPrice: 500, unitCost: 300 }],
    refundAmount: 500,
    wallet: "inStoreSafe",
    revenueAmount: 500,
    movement: "exchange",
    customerId: "c1",
  });
  assert.equal(qtyOn(l, "stock", "A"), 1, "one unit back, not three");
  assert.equal(on(l, "cogs"), -300, "one unit's cost, not three");
  assert.equal(on(l, "revenue"), -500, "one unit's revenue, not 1500");
  assert.equal(on(l, "customer_ltv"), -500);
});

test("partial quantities chain: 1 then 1 leaves 1", () => {
  const after1 = [{ original_order_id: "o1", returned_items: [{ product_id: "A", quantity: 1 }] }];
  assert.equal(remainingQuantities(threeOf, after1).get("A"), 2);
  const after2 = [...after1, { original_order_id: "o1", returned_items: [{ product_id: "A", quantity: 1 }] }];
  assert.equal(remainingQuantities(threeOf, after2).get("A"), 1);
  assert.equal(canExchange(threeOf, after2), true, "the last one is still swappable");
  const after3 = [...after2, { original_order_id: "o1", returned_items: [{ product_id: "A", quantity: 1 }] }];
  assert.equal(remainingQuantities(threeOf, after3).get("A"), 0);
  assert.equal(exchangeBlock(threeOf, after3), "nothing_left", "and then it is not");
});

test("a partial quantity on a DISCOUNTED order is still proportional", () => {
  // 3 at 500 = 1500 list, paid 1200 (20% off). One back is worth 400.
  const discounted = { ...threeOf, totalAmount: 1200 };
  assert.equal(returnedValue(discounted, [{ productId: "A", quantity: 1, unitPrice: 500 }]), 400);
  assert.equal(returnedValue(discounted, [{ productId: "A", quantity: 3, unitPrice: 500 }]), 1200,
    "and all three add back up to exactly what was paid");
});

// ── multi-item exchange records ─────────────────────────────────────────────

test("every replacement item survives the record, not just the first", () => {
  const rec = {
    exchanged_item: [
      { product_id: "B", product_name: "قميص", quantity: 1, price: 300 },
      { product_id: "C", product_name: "بنطلون", quantity: 2, price: 250 },
    ],
  };
  assert.equal(exchangedItems(rec).length, 2, "a swap for two products keeps two");
  assert.match(exchangedItemsLabel(rec), /قميص/);
  assert.match(exchangedItemsLabel(rec), /بنطلون/);
});

test("rows already stored as a single object still read", () => {
  // Every row in the database today is one object. Normalising must not lose it.
  const legacy = { exchanged_item: { product_id: "B", product_name: "قميص", quantity: 1, price: 300 } };
  assert.equal(exchangedItems(legacy).length, 1);
  assert.equal(exchangedItems(legacy)[0].product_name, "قميص");
  assert.match(exchangedItemsLabel(legacy), /قميص/);
});

test("a plain return has no replacement items and says so", () => {
  assert.deepEqual(exchangedItems({}), []);
  assert.deepEqual(exchangedItems({ exchanged_item: null }), []);
  assert.equal(exchangedItemsLabel({}), "—");
});

test("a multi-item POS swap books every replacement line in the ledger", () => {
  // The ledger was always right; this guards the property the record now matches.
  const l = buildSaleLines({
    items: [
      { productId: "A", quantity: -1, unitPrice: 500, unitCost: 300 },
      { productId: "B", quantity: 1, unitPrice: 300, unitCost: 180 },
      { productId: "C", quantity: 2, unitPrice: 250, unitCost: 150 },
    ],
    wallet: "inStoreSafe",
    channel: "pos",
  });
  assert.equal(qtyOn(l, "stock", "A"), 1, "the returned unit comes back");
  assert.equal(qtyOn(l, "stock", "B"), -1);
  assert.equal(qtyOn(l, "stock", "C"), -2, "BOTH replacement products leave");
  // 300 + 500 − 500 = 300 collected.
  assert.equal(on(l, "revenue"), 300);
  assert.equal(on(l, "wallet"), 300);
});

// ── the original document is never mutated ──────────────────────────────────

test("a replacement order is a NEW document that points at the original", () => {
  const original = { id: "o1", status: "delivered", stockItems: threeOf.stockItems, totalAmount: 1500 };
  const replacement = { id: "o2", status: "pending", isExchange: true, original_order_id: "o1" };

  // The link runs child → parent, so the original is untouched by construction.
  assert.equal(replacement.original_order_id, original.id);
  assert.equal(original.status, "delivered", "the original keeps its own status");
  assert.equal(original.id !== replacement.id, true, "two documents, not one rewritten");
  assert.equal(movementFor(original, [original, replacement]), "exchange");
  // And the original is now locked against a second swap.
  assert.equal(exchangeBlock(original, [], [original, replacement]), "already_replaced");
});

// ── the deposit must NOT be forfeited on a swap ─────────────────────────────
//
// Found live on QA-STORE, not by any unit test: `confirmReturn` forfeited the
// whole deposit regardless of movement. On a fully-prepaid order that made the
// `revenue −` reversal cancel itself out against `forfeited_deposit +`, left
// `customer_ltv` untouched, and then let the replacement book its own full
// revenue — so an EVEN swap recognised revenue and LTV out of nothing.

test("a forfeited deposit cancels the reversal — which is why a swap must not forfeit", () => {
  const forfeiting = buildReturnConfirmedLines({
    items: [{ productId: "A", quantity: 1, unitPrice: 300, unitCost: 100 }],
    refundAmount: 300,
    forfeitedDeposit: 300,
    wallet: "inStoreSafe",
    revenueAmount: 300,
    movement: "exchange",
    customerId: "c1",
  });
  // This is the shape the bug produced. Asserted so the reason is legible.
  assert.equal(on(forfeiting, "revenue"), 0, "reversal and forfeit cancel");
  assert.equal(on(forfeiting, "customer_ltv"), 0, "the customer still 'spent' it");
  assert.equal(on(forfeiting, "wallet"), 0, "and no money went back");
});

test("with nothing forfeited, an exchange reversal is whole", () => {
  const correct = buildReturnConfirmedLines({
    items: [{ productId: "A", quantity: 1, unitPrice: 300, unitCost: 100 }],
    refundAmount: 300,
    forfeitedDeposit: 0,
    wallet: "inStoreSafe",
    revenueAmount: 300,
    movement: "exchange",
    customerId: "c1",
  });
  assert.equal(on(correct, "revenue"), -300, "the sale really reverses");
  assert.equal(on(correct, "customer_ltv"), -300, "and so does what they spent");
  assert.equal(on(correct, "wallet"), -300, "their money goes back, ready to pay the new order");
});

test("an even PREPAID swap nets to zero revenue, LTV and cash end to end", () => {
  // The full lifecycle, with the deposit handled the fixed way.
  const ret = buildReturnConfirmedLines({
    items: [{ productId: "A", quantity: 1, unitPrice: 300, unitCost: 100 }],
    refundAmount: 300,
    forfeitedDeposit: 0,
    wallet: "instaPay",
    revenueAmount: 300,
    movement: "exchange",
    customerId: "c1",
    channel: "ecommerce",
  });
  // The replacement order: prepaid deposit in, then delivered at full value.
  const placed = buildOrderPlacedLines({
    items: [{ productId: "B", quantity: 1, unitPrice: 300, unitCost: 100 }],
    depositAmount: 300,
    wallet: "instaPay",
  });
  const dlv = buildOrderDeliveredLines({
    items: [{ productId: "B", quantity: 1, unitPrice: 300, unitCost: 100 }],
    goodsTotal: 300,
    depositAmount: 300,
    codAmount: 0,
    customerId: "c1",
    channel: "ecommerce",
  });
  const all = [...ret, ...placed, ...dlv];
  assert.equal(on(all, "revenue"), 0, "an even swap is not revenue");
  assert.equal(on(all, "customer_ltv"), 0, "nor new lifetime value");
  assert.equal(on(all, "wallet"), 0, "the customer's money just moved order");
  assert.equal(qtyOn(all, "stock", "A"), 1, "old unit back");
  assert.equal(qtyOn(all, "stock", "B"), -1, "new unit out");
});

test("a plain RETURN still forfeits — the fix must not refund walk-aways", () => {
  const l = buildReturnConfirmedLines({
    items: [{ productId: "A", quantity: 1, unitPrice: 300, unitCost: 100 }],
    refundAmount: 300,
    forfeitedDeposit: 300,
    wallet: "instaPay",
    revenueAmount: 300,
    movement: "return",
    customerId: "c1",
  });
  assert.equal(on(l, "wallet"), 0, "the deposit stays in the till");
  assert.equal(
    l.filter((x) => x.account === "revenue" && x.subjectId === "forfeited_deposit")[0]?.amount,
    300,
    "and is named as retained income",
  );
});

// ── the compensation that makes a failed placement safe ─────────────────────
//
// Found live on QA-STORE by blocking the POST to /rest/v1/orders: the
// `order_placed` event and its stock reservation stood with no order document
// pointing at them, and — because `addOrder` REJECTS rather than returning a
// result — the operator was shown nothing at all.
//
// The ledger is append-only, so the fix is a compensating `order_cancelled`.
// This asserts the property that makes that safe: it is an exact inverse.

test("a cancellation exactly inverts the placement it compensates", () => {
  const items = [
    { productId: "A", quantity: 2, unitPrice: 300, unitCost: 100 },
    { productId: "B", quantity: 1, unitPrice: 450, unitCost: 150 },
  ];
  const placed = buildOrderPlacedLines({ items });
  const released = buildOrderCancelledLines({ items });

  for (const id of ["A", "B"]) {
    assert.equal(
      qtyOn(placed, "stock", id) + qtyOn(released, "stock", id),
      0,
      `${id} must end exactly where it started`,
    );
  }
  assert.equal(on(placed, "stock") + on(released, "stock"), 0, "and so must its value");
});

test("the compensation gives back a deposit the placement took", () => {
  const items = [{ productId: "A", quantity: 1, unitPrice: 300, unitCost: 100 }];
  const placed = buildOrderPlacedLines({ items, depositAmount: 300, wallet: "instaPay" });
  const released = buildOrderCancelledLines({ items, depositAmount: 300, wallet: "instaPay" });
  assert.equal(on(placed, "wallet"), 300, "money came in with the order");
  assert.equal(on(placed, "wallet") + on(released, "wallet"), 0, "and goes back out with it");
});

test("a compensation with no deposit moves no money", () => {
  const items = [{ productId: "A", quantity: 1, unitPrice: 300, unitCost: 100 }];
  const released = buildOrderCancelledLines({ items });
  assert.equal(on(released, "wallet"), 0);
  assert.equal(qtyOn(released, "stock", "A"), 1, "only the goods come back");
});

// ── an exchange is not a wasted trip ────────────────────────────────────────
//
// `returned_orders_count` is documented as "the number of wasted trips still
// owed" — a DEBT, paid back one doubled delivery at a time. Both confirm-return
// handlers incremented it on every confirmation, exchanges included, so a swap
// billed the customer twice: the exchange fee they already paid as a
// pass-through, then doubled shipping on their next order.
//
// Measured on QA-STORE before the fix: QA-UAT-ECO-CUSTOMER carried a debt of 4
// from 4 exchanges and 0 plain returns.

test("a customer-caused plain return wastes a trip; an exchange does not", () => {
  assert.equal(countsAsWastedTrip("customer", "return"), true);
  assert.equal(countsAsWastedTrip("customer", "exchange"), false);
});

test("the movement that decides it comes from the documents", () => {
  const original = { id: "o1", status: "delivered" };
  const replacement = { id: "o2", status: "pending", original_order_id: "o1" };
  // No replacement order → a plain return → the trip was wasted.
  assert.equal(countsAsWastedTrip("customer", movementFor(original, [original])), true);
  // A replacement exists → a swap → nothing wasted.
  assert.equal(countsAsWastedTrip("customer", movementFor(original, [original, replacement])), false);
});

test("four swaps leave a customer owing nothing", () => {
  // The exact QA case: four exchanges, no plain returns.
  let debt = 0;
  for (let i = 0; i < 4; i++) if (countsAsWastedTrip("customer", "exchange")) debt++;
  assert.equal(debt, 0, "four swaps are not four wasted trips");
  assert.equal(shippingFeeFor(50, { returned_orders_count: debt }), 50, "so shipping stays normal");
});

test("the established rule is preserved: flat double, and it pays down", () => {
  // NOT (N+1)×. `check_returns` asserts "double, not ×7"; this restates it here
  // so a change to the multiplier fails the exchange suite too.
  assert.equal(shippingFeeFor(50, { returned_orders_count: 0 }), 50);
  assert.equal(shippingFeeFor(50, { returned_orders_count: 1 }), 100);
  assert.equal(shippingFeeFor(50, { returned_orders_count: 2 }), 100, "still double, not triple");
  assert.equal(shippingFeeFor(50, { returned_orders_count: 3 }), 100, "still double, not quadruple");
  // The debt is what changes, not the multiplier: each settled delivery pays one.
  let debt = 3;
  for (const settled of [true, true, true]) if (settled) debt = Math.max(0, debt - 1);
  assert.equal(debt, 0);
  assert.equal(shippingFeeFor(50, { returned_orders_count: debt }), 50, "square again");
});

test("a waived delivery stays waived however many trips are owed", () => {
  assert.equal(shippingFeeFor(0, { returned_orders_count: 4 }), 0);
});

// ── responsibility: who caused it, and therefore who pays ───────────────────
//
// Migration 026 added `return_cause`. Before it, fee ownership was keyed on the
// MOVEMENT — so a swap the shop caused still billed the customer, and a return
// the shop caused was absorbed even when the customer had walked away. Movement
// describes the journey; it cannot describe fault.

test("return_cause validation: only the three values survive", () => {
  assert.deepEqual([...RETURN_CAUSES], ["customer", "shop", "unknown"]);
  for (const good of RETURN_CAUSES) assert.equal(toReturnCause(good), good);
  // Anything else lands on "unknown" — never on blame.
  for (const bad of [null, undefined, "", "CUSTOMER", "courier", "customer ", "1", 7]) {
    assert.equal(toReturnCause(bad), "unknown", `${String(bad)} must not become a cause`);
  }
});

test("every cause has an operator-facing label", () => {
  for (const c of RETURN_CAUSES) assert.ok(RETURN_CAUSE_LABELS[c]?.length > 0);
});

test("the customer pays whatever the movement was, when they caused it", () => {
  assert.equal(shippingBorneBy("customer", "return"), "customer");
  assert.equal(shippingBorneBy("customer", "exchange"), "customer");
});

test("the shop pays whatever the movement was, when the shop caused it", () => {
  // The case that was impossible before 026: a swap WE caused, billed to us.
  assert.equal(shippingBorneBy("shop", "exchange"), "shop");
  assert.equal(shippingBorneBy("shop", "return"), "shop");
});

test("unknown reproduces the pre-026 movement-keyed default exactly", () => {
  // This is what keeps every historical row's accounting unchanged: the column
  // defaults to 'unknown', and 'unknown' must behave as the code did before.
  assert.equal(shippingBorneBy("unknown", "return"), "shop");
  assert.equal(shippingBorneBy("unknown", "exchange"), "customer");
});

// ── the fee actually booked ─────────────────────────────────────────────────

const feeLines = (cause, movement) =>
  buildReturnConfirmedLines({
    items: [{ productId: "A", quantity: 1, unitPrice: 300, unitCost: 100 }],
    refundAmount: 300,
    wallet: "inStoreSafe",
    revenueAmount: 300,
    returnFee: 40,
    movement,
    feeBorneBy: shippingBorneBy(cause, movement),
    courierId: "cr1",
  });

test("a SHOP-caused exchange is the shop's expense, not the customer's", () => {
  const l = feeLines("shop", "exchange");
  assert.equal(on(l, "expense"), 40, "we bear our own mistake");
  assert.equal(on(l, "receivable_courier"), 0, "and do not bill the customer");
  assert.equal(on(l, "payable_courier"), 40, "the courier is still owed");
});

test("a CUSTOMER-caused return is recovered from them, not absorbed", () => {
  const l = feeLines("customer", "return");
  assert.equal(on(l, "expense"), 0, "not our cost");
  assert.equal(on(l, "receivable_courier"), 40, "the courier collects it for us");
  assert.equal(
    on(l, "payable_courier") - on(l, "receivable_courier"),
    0,
    "and it nets to nothing for the shop",
  );
});

test("a CUSTOMER-caused exchange stays the customer's", () => {
  const l = feeLines("customer", "exchange");
  assert.equal(on(l, "expense"), 0);
  assert.equal(on(l, "receivable_courier"), 40);
});

test("an unclassified return is still absorbed — the old behaviour, unchanged", () => {
  const l = feeLines("unknown", "return");
  assert.equal(on(l, "expense"), 40);
  assert.equal(on(l, "receivable_courier"), 0);
});

test("omitting feeBorneBy entirely keeps the original movement-keyed lines", () => {
  // Every pre-026 caller. This is the backward-compatibility guarantee.
  const ret = buildReturnConfirmedLines({
    items: [{ productId: "A", quantity: 1, unitPrice: 300, unitCost: 100 }],
    refundAmount: 300, wallet: "inStoreSafe", revenueAmount: 300,
    returnFee: 40, movement: "return", courierId: "cr1",
  });
  assert.equal(on(ret, "expense"), 40);
  const exc = buildReturnConfirmedLines({
    items: [{ productId: "A", quantity: 1, unitPrice: 300, unitCost: 100 }],
    refundAmount: 300, wallet: "inStoreSafe", revenueAmount: 300,
    returnFee: 40, movement: "exchange", courierId: "cr1",
  });
  assert.equal(on(exc, "receivable_courier"), 40);
});

test("an RTO the customer refused is recovered; one we caused is absorbed", () => {
  const theirs = buildOrderRTOLines({
    items: [{ productId: "A", quantity: 1, unitPrice: 300, unitCost: 100 }],
    returnFee: 40, courierId: "cr1", feeBorneBy: "customer",
  });
  assert.equal(on(theirs, "expense"), 0);
  assert.equal(on(theirs, "receivable_courier"), 40);

  const ours = buildOrderRTOLines({
    items: [{ productId: "A", quantity: 1, unitPrice: 300, unitCost: 100 }],
    returnFee: 40, courierId: "cr1", feeBorneBy: "shop",
  });
  assert.equal(on(ours, "expense"), 40);
  // …and omitted still means the shop, as it always did.
  const legacy = buildOrderRTOLines({
    items: [{ productId: "A", quantity: 1, unitPrice: 300, unitCost: 100 }],
    returnFee: 40, courierId: "cr1",
  });
  assert.equal(on(legacy, "expense"), 40);
});

// ── the debt, gated on responsibility ───────────────────────────────────────

test("only a CUSTOMER-caused wasted trip adds to the debt", () => {
  assert.equal(countsAsWastedTrip("customer", "return"), true, "theirs, and wasted");
  assert.equal(countsAsWastedTrip("shop", "return"), false, "our mistake is not their debt");
  assert.equal(countsAsWastedTrip("unknown", "return"), false, "not knowing is not blaming");
  for (const c of RETURN_CAUSES) {
    assert.equal(countsAsWastedTrip(c, "exchange"), false, `${c} exchange wastes no trip`);
  }
});

test("the full debt cycle: accrue, charge, clear, back to normal", () => {
  // Two customer-caused returns.
  let debt = 0;
  for (const [cause, movement] of [["customer", "return"], ["customer", "return"]]) {
    if (countsAsWastedTrip(cause, movement)) debt++;
  }
  assert.equal(debt, 2);

  // Order 1 is charged double, and clears exactly one.
  assert.equal(shippingFeeFor(40, { returned_orders_count: debt }), 80);
  debt = Math.max(0, debt - 1);
  assert.equal(debt, 1);

  // Order 2 likewise — still 80, never 120.
  assert.equal(shippingFeeFor(40, { returned_orders_count: debt }), 80, "flat double, not N+1");
  debt = Math.max(0, debt - 1);
  assert.equal(debt, 0);

  // Square. Back to base.
  assert.equal(shippingFeeFor(40, { returned_orders_count: debt }), 40);
});

test("clearing cannot go below zero however many times it is replayed", () => {
  let debt = 1;
  for (let i = 0; i < 5; i++) debt = Math.max(0, debt - 1);
  assert.equal(debt, 0);
  assert.equal(shippingFeeFor(40, { returned_orders_count: debt }), 40);
});

// ── بوكس returns: the unit a return is denominated in ───────────────────────
//
// A bundle order stores the SOLD line in `items` (one box at 500) and the
// COMPONENTS in `stockItems`, each at `unitPrice: 0`. صفحة المرتجعات built its
// returnable lines from `stockItems`, so it offered the components at zero and
// a confirmed bundle return refunded the customer NOTHING while putting the
// goods back on the shelf. Measured on QA-STORE with ECO-1789244668137.

const BOX_ORDER = {
  id: "o-box",
  status: "delivered",
  totalAmount: 500,
  items: [
    { id: "s1", bundleId: "BOX", productId: "", productName: "QA-BOX", quantity: 1, unitPrice: 500 },
  ],
  stockItems: [
    { id: "c1", bundleId: "BOX", productId: "X", productName: "X", quantity: 2, unitPrice: 0, unitCost: 100 },
    { id: "c2", bundleId: "BOX", productId: "Y", productName: "Y", quantity: 1, unitPrice: 0, unitCost: 100 },
  ],
};

test("a بوكس is ONE returnable unit, priced as it was sold", () => {
  const units = returnableUnits(BOX_ORDER);
  assert.equal(units.length, 1, "not two loose components");
  assert.equal(units[0].key, "BOX", "keyed by the bundle, not a component");
  assert.equal(units[0].unitPrice, 500, "the price the customer actually paid");
  assert.equal(units[0].quantity, 1);
  assert.equal(units[0].isBundle, true);
});

test("the recipe is per BOX, so two boxes do not double the components", () => {
  const units = returnableUnits(BOX_ORDER);
  assert.deepEqual(
    units[0].bundleItems.map((c) => [c.productId, c.quantity, c.unitCost]),
    [["X", 2, 100], ["Y", 1, 100]],
  );
  const two = returnableUnits({
    ...BOX_ORDER,
    items: [{ ...BOX_ORDER.items[0], quantity: 2 }],
    stockItems: [
      { ...BOX_ORDER.stockItems[0], quantity: 4 },
      { ...BOX_ORDER.stockItems[1], quantity: 2 },
    ],
  });
  assert.equal(two[0].quantity, 2, "two boxes");
  assert.deepEqual(two[0].bundleItems.map((c) => c.quantity), [2, 1], "still per box");
});

test("plain lines are untouched and still key on the product", () => {
  const plain = {
    id: "o-plain",
    items: [{ productId: "P", quantity: 2, unitPrice: 150 }],
    stockItems: [{ productId: "P", productName: "P", quantity: 2, unitPrice: 150, unitCost: 90 }],
  };
  const units = returnableUnits(plain);
  assert.equal(units.length, 1);
  assert.equal(units[0].key, "P");
  assert.equal(units[0].unitPrice, 150);
  assert.equal(units[0].isBundle, undefined);
});

test("a mixed order keeps the box whole and the plain line separate", () => {
  const mixed = {
    id: "o-mix",
    items: [
      { bundleId: "BOX", productId: "", productName: "QA-BOX", quantity: 1, unitPrice: 500 },
      { productId: "P", quantity: 1, unitPrice: 150 },
    ],
    stockItems: [
      { bundleId: "BOX", productId: "X", productName: "X", quantity: 2, unitPrice: 0, unitCost: 100 },
      { productId: "P", productName: "P", quantity: 1, unitPrice: 150, unitCost: 90 },
    ],
  };
  const units = returnableUnits(mixed);
  assert.deepEqual(units.map((u) => u.key), ["BOX", "P"]);
  assert.equal(units.find((u) => u.key === "BOX").unitPrice, 500);
  assert.equal(units.find((u) => u.key === "P").unitPrice, 150);
});

test("the ceiling counts BOXES, not components", () => {
  const none = remainingUnits(BOX_ORDER, []);
  assert.equal(none.get("BOX"), 1);
  assert.equal(none.get("X"), undefined, "a component is not separately returnable");

  const after = remainingUnits(BOX_ORDER, [
    { original_order_id: "o-box", returned_items: [{ product_id: "BOX", quantity: 1 }] },
  ]);
  assert.equal(after.get("BOX"), 0, "the box has come back");
});

test("a return recorded against another order does not eat this box's ceiling", () => {
  const after = remainingUnits(BOX_ORDER, [
    { original_order_id: "someone-else", returned_items: [{ product_id: "BOX", quantity: 1 }] },
  ]);
  assert.equal(after.get("BOX"), 1);
});

// ── the return-type label ───────────────────────────────────────────────────

test("every return kind has its own label, including the non-retail ones", () => {
  // The log and its PDF export read `type === "return" ? "إرجاع" : "استبدال"`,
  // so a wholesale or supplier return rendered as "استبدال" — the screen and
  // the exported document both called a trader's refund a swap.
  assert.equal(returnTypeLabel("return"), "إرجاع");
  assert.equal(returnTypeLabel("exchange"), "استبدال");
  assert.equal(returnTypeLabel("wholesale_return"), "مرتجع جملة");
  assert.equal(returnTypeLabel("supplier_return"), "مرتجع مورد");
  assert.notEqual(returnTypeLabel("wholesale_return"), "استبدال");
});

test("an unknown kind never silently becomes an exchange", () => {
  assert.equal(returnTypeLabel("something_new"), "something_new");
  assert.equal(returnTypeLabel(null), "مرتجع");
  assert.equal(returnTypeLabel(undefined), "مرتجع");
});

// ── the cause belongs on the ORDER, not only on the return record ───────────

test("the counter return stamps return_cause on the order", () => {
  // Only the courier path used to do this, so a counter return for a
  // shop-caused reason left `orders.return_cause = 'unknown'` while its record
  // said `shop`. Two documents disagreeing about the same fact, and every
  // "who caused our returns" report reading the order under-counted.
  // Measured on QA-STORE: QA-S1-SHOPRET, record `shop`, order `unknown`.
  const src = readFileSync(new URL("../src/routes/returns.tsx", import.meta.url), "utf8");
  const counter = src.slice(src.indexOf("const handleReturn"));
  assert.match(
    counter,
    /updateOrder\(\s*selectedOrder\.id,\s*\{\s*return_cause:\s*counterCause/,
    "handleReturn must stamp the chosen cause onto the order",
  );
});

test("the counter return does NOT mark the whole order returned", () => {
  // It returns individual LINES, so a partial return must leave the order
  // delivered. The quantity ceiling comes from the records, not from a flag.
  const src = readFileSync(new URL("../src/routes/returns.tsx", import.meta.url), "utf8");
  const counter = src.slice(src.indexOf("const handleReturn"), src.indexOf("const exchangeProduct"));
  assert.doesNotMatch(counter, /returnConfirmedAt/, "no whole-order return stamp on the line path");
});
