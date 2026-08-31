/**
 * The e-commerce order lifecycle → ledger lines.
 *
 * Two things here are easy to get wrong and easy to test wrong:
 *
 *   1. `order_returned_pending` must write ZERO lines. A test that simply finds
 *      no lines passes for a *broken* event too, so the assertions below check
 *      that the function returns an empty array on purpose AND that the
 *      lifecycle still moves nothing at that step.
 *   2. `return_confirmed` must write all SIX lines, including customer_ltv −.
 *
 *     node --test scripts/check_order_lines.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOrderPlacedLines,
  buildOrderDeliveredLines,
  buildReturnPendingLines,
  buildReturnConfirmedLines,
  buildOrderCancelledLines,
  buildCourierSettlementLines,
  buildOrderEditLines,
  orderItemsTotal,
} from "../src/lib/ledger/orders.ts";

const amountOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((sum, l) => sum + (l.amount ?? 0), 0);
const qtyOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((sum, l) => sum + (l.qty ?? 0), 0);
const countOn = (lines, account) => lines.filter((l) => l.account === account).length;

const ITEMS = [{ productId: "p-shoe", quantity: 2, unitPrice: 1000, unitCost: 700 }];
const CUSTOMER = "cust-9";
const COURIER = "courier-1";

// ── 1. Placed: stock reserved, nothing sold ────────────────────────────────

test("placing an order reserves stock and books nothing else", () => {
  const lines = buildOrderPlacedLines({ items: ITEMS });

  assert.equal(lines.length, 1, "one stock line per product, nothing more");
  assert.equal(qtyOn(lines, "stock"), -2);
  assert.equal(amountOn(lines, "stock"), -1400, "value leaves with the units");

  // A placed order is not a sale.
  for (const account of ["revenue", "cogs", "wallet", "customer_ltv", "receivable_courier"]) {
    assert.equal(countOn(lines, account), 0, `${account} must not move at placement`);
  }
});

test("an order with no items is refused rather than booked empty", () => {
  assert.throws(() => buildOrderPlacedLines({ items: [] }), /no items/);
});

// ── 2. Delivered: the sale actually happens ────────────────────────────────

test("delivery books revenue, cost, LTV, and splits the money by who holds it", () => {
  const lines = buildOrderDeliveredLines({
    items: ITEMS,
    goodsTotal: 2000,
    shippingFee: 100,
    depositAmount: 500,
    wallet: "inStoreSafe",
    codAmount: 1600,
    courierId: COURIER,
    customerId: CUSTOMER,
  });

  // cogs, receivable_courier, revenue, payable_courier, customer_ltv
  // The deposit wallet line moved to order_placed — it is NOT here.
  assert.equal(lines.length, 5);
  assert.equal(amountOn(lines, "cogs"), 1400, "2 units at the real 700 cost");
  assert.equal(amountOn(lines, "revenue"), 2000, "the GOODS — the delivery fee is not our revenue");
  assert.equal(amountOn(lines, "customer_ltv"), 2000, "LTV mirrors revenue, not the courier's fee");
  assert.equal(countOn(lines, "wallet"), 0, "deposit is already in the wallet from order_placed");
  assert.equal(
    amountOn(lines, "receivable_courier"),
    1600,
    "COD is real money in someone else's pocket, not till money",
  );

  // Stock already moved at placement — delivery must not move it again.
  assert.equal(countOn(lines, "stock"), 0, "double-deducting stock is the classic bug here");
});

test("a fully-prepaid delivery puts nothing in the wallet — it is already there from placement", () => {
  const lines = buildOrderDeliveredLines({
    items: ITEMS,
    goodsTotal: 2000,
    depositAmount: 2000,
    wallet: "inStoreSafe",
    customerId: CUSTOMER,
  });

  assert.equal(countOn(lines, "wallet"), 0, "deposit was booked at order_placed, not here");
  assert.equal(countOn(lines, "receivable_courier"), 0);
});

test("a guest order writes no LTV line", () => {
  const lines = buildOrderDeliveredLines({
    items: ITEMS,
    goodsTotal: 2000,
    codAmount: 2000,
    courierId: COURIER,
  });
  assert.equal(countOn(lines, "customer_ltv"), 0);
});

test("money that does not add up to the total is refused, not booked", () => {
  assert.throws(
    () =>
      buildOrderDeliveredLines({
        items: ITEMS,
        goodsTotal: 2000,
        shippingFee: 100,
        depositAmount: 500,
        wallet: "w",
        codAmount: 1000, // 500 + 1000 ≠ 2100
        courierId: COURIER,
      }),
    /must equal net goods/,
  );
});

// ── 2b. Cancelled: the reserved stock has to come back ────────────────────

test("cancelling a pending order puts the reserved stock back, and nothing else", () => {
  const lines = buildOrderCancelledLines({ items: ITEMS });

  assert.equal(lines.length, 1, "one stock line per product");
  assert.equal(qtyOn(lines, "stock"), 2, "the units return to the shelf");
  assert.equal(amountOn(lines, "stock"), 1400, "with the value that left with them");

  // A cancelled order was never a sale, so nothing else may move.
  for (const account of ["revenue", "cogs", "wallet", "customer_ltv", "receivable_courier"]) {
    assert.equal(countOn(lines, account), 0, `${account} must not move on a cancel`);
  }
});

test("place then cancel leaves stock exactly where it started", () => {
  // Without this event, the reservation would be permanent: the units leave at
  // order_placed and nothing ever puts them back.
  const placed = buildOrderPlacedLines({ items: ITEMS });
  const cancelled = buildOrderCancelledLines({ items: ITEMS });
  const both = [...placed, ...cancelled];

  assert.equal(qtyOn(both, "stock"), 0, "no inventory swallowed by a cancel");
  assert.equal(amountOn(both, "stock"), 0, "and no value swallowed either");
});

// ── 3. Returned-pending: the zero-lines step, asserted on purpose ──────────

test("a courier's return claim writes ZERO lines — confirmed, not assumed", () => {
  const lines = buildReturnPendingLines();

  // Assert the shape explicitly. "No lines found" is also what a missing or
  // broken event looks like, so this checks the function really returns an
  // empty array rather than a test simply failing to find anything.
  assert.ok(Array.isArray(lines), "must return an array, not undefined");
  assert.equal(lines.length, 0, "stock must not move on a courier's word");

  // And spell out the specific accounts that must stay untouched, so a future
  // change that starts writing one of them fails loudly here.
  for (const account of ["stock", "wallet", "revenue", "cogs", "customer_ltv", "expense"]) {
    assert.equal(countOn(lines, account), 0, `${account} must not move before confirmation`);
  }
});

test("the goods are still out of stock while the return is only claimed", () => {
  // Place → deliver → courier claims a return. Net stock must still be −2:
  // the units are in a van, not on the shelf.
  const placed = buildOrderPlacedLines({ items: ITEMS });
  const delivered = buildOrderDeliveredLines({
    items: ITEMS,
    goodsTotal: 2000,
    codAmount: 2000,
    courierId: COURIER,
    customerId: CUSTOMER,
  });
  const pending = buildReturnPendingLines();

  const stockQty = qtyOn(placed, "stock") + qtyOn(delivered, "stock") + qtyOn(pending, "stock");
  assert.equal(stockQty, -2, "a claimed return must not put stock back");
});

// ── 4. Return confirmed: all six lines, LTV included ───────────────────────

test("a confirmed return writes all SEVEN lines, including customer_ltv −", () => {
  // Was six. The seventh is `payable_courier`: the return fee is money we owe
  // a specific courier, and booking the expense without naming who is owed it
  // left the entry with no counterparty. The original six are all still here —
  // the checklist in LEDGER_SCHEMA.md was about never DROPPING one.
  const lines = buildReturnConfirmedLines({
    items: ITEMS,
    refundAmount: 2000,
    wallet: "inStoreSafe",
    revenueAmount: 2000,
    returnFee: 50,
    movement: "return",
    courierId: COURIER,
    customerId: CUSTOMER,
  });

  assert.equal(
    lines.length,
    7,
    "stock, cogs, wallet, revenue, expense, customer_ltv, payable_courier",
  );
  assert.equal(countOn(lines, "payable_courier"), 1, "the courier we owe the return fee to");
  assert.equal(countOn(lines, "stock"), 1);
  assert.equal(countOn(lines, "cogs"), 1);
  assert.equal(countOn(lines, "wallet"), 1);
  assert.equal(countOn(lines, "revenue"), 1);
  assert.equal(countOn(lines, "expense"), 1);
  assert.equal(
    countOn(lines, "customer_ltv"),
    1,
    "the line the smoke test caught missing — never drop it",
  );

  assert.equal(qtyOn(lines, "stock"), 2, "the units are physically back");
  assert.equal(amountOn(lines, "stock"), 1400, "and their value with them");
  assert.equal(amountOn(lines, "cogs"), -1400, "no longer a cost of goods SOLD");
  assert.equal(amountOn(lines, "wallet"), -2000, "the refund");
  assert.equal(amountOn(lines, "revenue"), -2000);
  assert.equal(amountOn(lines, "expense"), 50, "the courier's return fee — the shop's cost");
  assert.equal(amountOn(lines, "customer_ltv"), -2000, "they did not really spend this");
});

test("deliver then confirm a return nets stock, revenue, cogs and LTV back to zero", () => {
  const placed = buildOrderPlacedLines({ items: ITEMS });
  const delivered = buildOrderDeliveredLines({
    items: ITEMS,
    goodsTotal: 2000,
    codAmount: 2000,
    courierId: COURIER,
    customerId: CUSTOMER,
  });
  const confirmed = buildReturnConfirmedLines({
    items: ITEMS,
    refundAmount: 2000,
    wallet: "inStoreSafe",
    revenueAmount: 2000,
    returnFee: 50,
    movement: "return",
    courierId: COURIER,
    customerId: CUSTOMER,
  });

  const all = [...placed, ...delivered, ...confirmed];
  assert.equal(qtyOn(all, "stock"), 0, "every unit is back on the shelf");
  assert.equal(amountOn(all, "stock"), 0, "and inventory value is whole again");
  assert.equal(amountOn(all, "revenue"), 0, "the sale is fully reversed");
  assert.equal(amountOn(all, "cogs"), 0, "and so is its cost");
  assert.equal(amountOn(all, "customer_ltv"), 0, "the customer's LTV is back where it started");

  // What is left over is real: the courier still owes the COD they collected,
  // the refund left the till, and the return fee was a genuine expense.
  assert.equal(amountOn(all, "receivable_courier"), 2000);
  assert.equal(amountOn(all, "wallet"), -2000);
  assert.equal(amountOn(all, "expense"), 50);
});

test("a return with no customer still reverses the money, just not an LTV", () => {
  const lines = buildReturnConfirmedLines({
    items: ITEMS,
    refundAmount: 2000,
    wallet: "inStoreSafe",
    revenueAmount: 2000,
  });
  assert.equal(countOn(lines, "customer_ltv"), 0);
  assert.equal(amountOn(lines, "revenue"), -2000);
});

// ── 5. Courier settlement: the receivable's other direction ────────────────

test("settling with a courier takes cash in and the receivable down", () => {
  const lines = buildCourierSettlementLines({
    courierId: COURIER,
    wallet: "inStoreSafe",
    amount: 1600,
    commission: 100,
  });

  assert.equal(lines.length, 3, "wallet, receivable_courier, payable_courier");
  assert.equal(amountOn(lines, "wallet"), 1500, "what they hand over, less their cut");
  assert.equal(amountOn(lines, "receivable_courier"), -1600, "the whole debt clears");
  assert.equal(amountOn(lines, "payable_courier"), -100, "withheld fees clear what we owed");
  assert.equal(countOn(lines, "expense"), 0, "no expense here — it was booked at the movement");
});

test("delivery then settlement nets the courier receivable to zero", () => {
  const delivered = buildOrderDeliveredLines({
    items: ITEMS,
    goodsTotal: 2000,
    codAmount: 2000,
    courierId: COURIER,
    customerId: CUSTOMER,
  });
  const settled = buildCourierSettlementLines({
    courierId: COURIER,
    wallet: "inStoreSafe",
    amount: 2000,
    commission: 120,
  });

  const owed =
    amountOn(delivered, "receivable_courier") + amountOn(settled, "receivable_courier");
  assert.equal(owed, 0, "without settlement this account could only ever grow");
  assert.equal(amountOn(settled, "wallet"), 1880);
});

test("nonsense settlements are refused, not booked", () => {
  const base = { courierId: COURIER, wallet: "inStoreSafe" };
  assert.throws(() => buildCourierSettlementLines({ ...base, amount: 0 }), /positive/);
  assert.throws(
    () => buildCourierSettlementLines({ ...base, amount: 100, commission: 200 }),
    /more than the amount collected/,
  );
});

// ── Editing a pending order: one event, both directions ───────────────────

const MUG = { productId: "p-mug", quantity: 3, unitPrice: 60, unitCost: 25 };

test("adding a product reserves it, and touches nothing else", () => {
  const lines = buildOrderEditLines({ items: [], before: ITEMS, after: [...ITEMS, MUG] });

  assert.equal(lines.length, 1, "only the added product moves");
  assert.equal(qtyOn(lines, "stock"), -3, "the new units are reserved");
  assert.equal(amountOn(lines, "stock"), -75, "3 at 25");
});

test("removing a product returns its reserved stock", () => {
  const lines = buildOrderEditLines({ before: [...ITEMS, MUG], after: ITEMS });

  assert.equal(lines.length, 1);
  assert.equal(qtyOn(lines, "stock"), 3, "the units go back on the shelf");
  assert.equal(amountOn(lines, "stock"), 75, "at the cost they were reserved at");
});

test("swapping one product for another is TWO lines, not four", () => {
  // A goes back, B goes out. The old reservation is not re-written in full and
  // then re-taken — only what actually changed moves.
  const lines = buildOrderEditLines({ before: ITEMS, after: [MUG] });

  assert.equal(lines.length, 2);
  assert.equal(countOn(lines, "stock"), 2);

  const shoe = lines.find((l) => l.subjectId === "p-shoe");
  const mug = lines.find((l) => l.subjectId === "p-mug");
  assert.equal(shoe.qty, 2, "the 2 shoes come back");
  assert.equal(mug.qty, -3, "the 3 mugs go out");
});

test("changing only the quantity moves only the difference", () => {
  const more = buildOrderEditLines({
    before: ITEMS,
    after: [{ ...ITEMS[0], quantity: 5 }],
  });
  assert.equal(more.length, 1);
  assert.equal(qtyOn(more, "stock"), -3, "2 → 5 reserves 3 more, not 5");

  const fewer = buildOrderEditLines({
    before: ITEMS,
    after: [{ ...ITEMS[0], quantity: 1 }],
  });
  assert.equal(qtyOn(fewer, "stock"), 1, "2 → 1 returns exactly 1");
});

test("an edit that changes nothing writes nothing", () => {
  const lines = buildOrderEditLines({ before: ITEMS, after: ITEMS });
  assert.equal(lines.length, 0, "no movement, no event to append");
});

test("place then edit nets to exactly the new contents", () => {
  // The whole correctness claim: after the edit the ledger holds the same
  // reservation a fresh order of the new contents would have taken.
  const placed = buildOrderPlacedLines({ items: ITEMS });
  const edited = buildOrderEditLines({ before: ITEMS, after: [MUG] });
  const both = [...placed, ...edited];

  const asIfFresh = buildOrderPlacedLines({ items: [MUG] });

  const netShoe = both
    .filter((l) => l.subjectId === "p-shoe")
    .reduce((s, l) => s + (l.qty ?? 0), 0);
  const netMug = both
    .filter((l) => l.subjectId === "p-mug")
    .reduce((s, l) => s + (l.qty ?? 0), 0);

  assert.equal(netShoe, 0, "the swapped-out product holds no reservation at all");
  assert.equal(netMug, qtyOn(asIfFresh, "stock"), "and the new one holds exactly a fresh one");
});

test("edit then cancel returns everything, leaving no stock swallowed", () => {
  const placed = buildOrderPlacedLines({ items: ITEMS });
  const edited = buildOrderEditLines({ before: ITEMS, after: [MUG] });
  const cancelled = buildOrderCancelledLines({ items: [MUG] });
  const all = [...placed, ...edited, ...cancelled];

  assert.equal(qtyOn(all, "stock"), 0, "every reserved unit came back");
  assert.equal(amountOn(all, "stock"), 0, "and every piastre of value with it");
});

test("a zero or negative quantity in the new contents is refused", () => {
  assert.throws(
    () => buildOrderEditLines({ before: ITEMS, after: [{ ...MUG, quantity: 0 }] }),
    /positive/,
  );
});

test("the order total recomputes from the new contents", () => {
  assert.equal(orderItemsTotal(ITEMS), 2000, "2 @ 1000");
  assert.equal(orderItemsTotal([MUG]), 180, "3 @ 60");
  assert.equal(orderItemsTotal([...ITEMS, MUG]), 2180);
  assert.equal(orderItemsTotal([]), 0);
});

// ── Who bears each shipping fee ───────────────────────────────────────────
// The rule that keeps profit honest: a RETURN is the shop's cost. Delivery and
// exchange are the customer's and pass straight through to the courier.

test("a delivery fee is pass-through: no expense, and not revenue either", () => {
  const lines = buildOrderDeliveredLines({
    items: ITEMS,
    goodsTotal: 2000,
    shippingFee: 100,
    codAmount: 2100,
    courierId: COURIER,
    customerId: CUSTOMER,
  });

  assert.equal(countOn(lines, "expense"), 0, "delivery is NEVER the shop's expense");
  assert.equal(amountOn(lines, "revenue"), 2000, "and never the shop's revenue");
  assert.equal(amountOn(lines, "payable_courier"), 100, "we owe the courier what we collected");
  assert.equal(amountOn(lines, "receivable_courier"), 2100, "they hold goods + fee");

  // The fee nets out on that courier: collected 100 for them, owe them 100.
  const feeIn = 100;
  assert.equal(
    amountOn(lines, "receivable_courier") - amountOn(lines, "payable_courier"),
    2100 - feeIn,
    "only the goods money is really owed to us",
  );
});

test("booking a delivery fee as revenue would inflate profit — it does not", () => {
  const withFee = buildOrderDeliveredLines({
    items: ITEMS,
    goodsTotal: 2000,
    shippingFee: 500,
    codAmount: 2500,
    courierId: COURIER,
  });
  const withoutFee = buildOrderDeliveredLines({
    items: ITEMS,
    goodsTotal: 2000,
    codAmount: 2000,
    courierId: COURIER,
  });

  // A bigger delivery fee must not change profit by one piastre.
  const profit = (ls) => amountOn(ls, "revenue") - amountOn(ls, "cogs") - amountOn(ls, "expense");
  assert.equal(profit(withFee), profit(withoutFee), "shipping price cannot move profit");
});

test("a RETURN fee is the shop's expense, and owed to the courier", () => {
  const lines = buildReturnConfirmedLines({
    items: ITEMS,
    refundAmount: 2000,
    wallet: "inStoreSafe",
    revenueAmount: 2000,
    returnFee: 80,
    movement: "return",
    courierId: COURIER,
    customerId: CUSTOMER,
  });

  assert.equal(amountOn(lines, "expense"), 80, "bringing goods back is what the shop pays for");
  assert.equal(
    lines.find((l) => l.account === "expense").subjectId,
    "shipping_return",
    "booked under its own subject so fees-by-type is a SUM",
  );
  assert.equal(amountOn(lines, "payable_courier"), 80, "and we owe the courier for it");
  assert.equal(countOn(lines, "receivable_courier"), 0, "the customer pays nothing on a return");
});

test("an EXCHANGE fee is the customer's — no expense, it nets on the courier", () => {
  const lines = buildReturnConfirmedLines({
    items: ITEMS,
    refundAmount: 0,
    wallet: "inStoreSafe",
    revenueAmount: 2000,
    returnFee: 60,
    movement: "exchange",
    courierId: COURIER,
    customerId: CUSTOMER,
  });

  assert.equal(countOn(lines, "expense"), 0, "an exchange fee is NEVER the shop's cost");
  assert.equal(amountOn(lines, "payable_courier"), 60, "we owe the courier");
  assert.equal(amountOn(lines, "receivable_courier"), 60, "they collected it from the customer");
  assert.equal(
    amountOn(lines, "receivable_courier") - amountOn(lines, "payable_courier"),
    0,
    "so it nets to nothing — pass-through",
  );
});

test("the same fee costs the shop on a return and nothing on an exchange", () => {
  const base = {
    items: ITEMS,
    refundAmount: 0,
    wallet: "inStoreSafe",
    revenueAmount: 2000,
    returnFee: 75,
    courierId: COURIER,
  };
  const asReturn = buildReturnConfirmedLines({ ...base, movement: "return" });
  const asExchange = buildReturnConfirmedLines({ ...base, movement: "exchange" });

  assert.equal(amountOn(asReturn, "expense"), 75);
  assert.equal(amountOn(asExchange, "expense"), 0);
  assert.notEqual(amountOn(asReturn, "expense"), amountOn(asExchange, "expense"));
});

test("settlement clears the debt without booking the fee a second time", () => {
  const delivered = buildOrderDeliveredLines({
    items: ITEMS,
    goodsTotal: 2000,
    shippingFee: 100,
    codAmount: 2100,
    courierId: COURIER,
  });
  const settled = buildCourierSettlementLines({
    courierId: COURIER,
    wallet: "inStoreSafe",
    amount: 2100,
    commission: 100,
  });

  assert.equal(countOn(settled, "expense"), 0, "the fee was booked at the movement, not here");
  assert.equal(amountOn(settled, "payable_courier"), -100, "it clears what we owed instead");

  const all = [...delivered, ...settled];
  assert.equal(amountOn(all, "receivable_courier"), 0, "COD fully handed over");
  assert.equal(amountOn(all, "payable_courier"), 0, "and the fee debt cleared");
  assert.equal(amountOn(all, "wallet"), 2000, "the till keeps the goods money only");
});


// ── the direction that actually invented stock ──────────────────────────────
//
// The guards used to test `quantity === 0`. Zero was refused; NEGATIVE was
// waved through, and the sign flip did real damage:
//
//     order_placed     qty: -(-2) = +2   placing an order CREATED inventory
//     order_cancelled  qty:   -2         cancelling DESTROYED it
//
// Neither is reachable from the UI today, which is exactly why it survived —
// the ledger is append-only, so a line like that is permanent once written.

test("placing an order cannot create stock out of a negative quantity", () => {
  assert.throws(
    () => buildOrderPlacedLines({ items: [{ ...MUG, quantity: -2 }] }),
    /positive/,
  );
});

test("cancelling an order cannot destroy stock either", () => {
  assert.throws(
    () => buildOrderCancelledLines({ items: [{ ...MUG, quantity: -2 }] }),
    /positive/,
  );
});

test("an edit refuses a negative line as well as a zero one", () => {
  for (const q of [0, -1, -99]) {
    assert.throws(
      () => buildOrderEditLines({ before: ITEMS, after: [{ ...MUG, quantity: q }] }),
      /positive/,
      `quantity ${q}`,
    );
  }
});

test("removing a product from an edit means leaving it OUT, not passing zero", () => {
  // The legitimate way to drop a line: it releases the reservation rather than
  // being refused, which is what lets the guard above be strict about zero.
  const lines = buildOrderEditLines({ before: [...ITEMS, MUG], after: ITEMS });
  assert.equal(qtyOn(lines, "stock"), MUG.quantity, "the mug's 3 units come back");
});

test("a real positive quantity still passes everywhere", () => {
  assert.doesNotThrow(() => buildOrderPlacedLines({ items: [MUG] }));
  assert.doesNotThrow(() => buildOrderCancelledLines({ items: [MUG] }));
  assert.doesNotThrow(() => buildOrderEditLines({ before: ITEMS, after: [MUG] }));
});
