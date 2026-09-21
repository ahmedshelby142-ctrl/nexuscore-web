/**
 * The advance deposit (العربون) lifecycle — ledger lines.
 *
 *     node --test scripts/check_deposit_lifecycle.mjs
 *
 * A deposit is REAL MONEY the customer sends before delivery (InstaPay,
 * Vodafone Cash, bank transfer). It must be recorded in the wallet the moment
 * it arrives — at order_placed — not deferred to delivery.
 *
 * If the order is cancelled, the deposit must be refunded from the same wallet.
 * If the order is delivered, the deposit must NOT be re-booked (it's already in
 * the till).
 *
 * The full round-trip (place → cancel) must net to zero on every account:
 * stock, wallet, everything. A non-zero net means money or inventory was
 * created or destroyed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOrderPlacedLines,
  buildOrderDeliveredLines,
  buildOrderCancelledLines,
} from "../src/lib/ledger/orders.ts";

const ITEMS = [{ productId: "p-shirt", quantity: 2, unitPrice: 500, unitCost: 300 }];
const WALLET = "instaPay";
const COURIER = "courier-1";
const CUSTOMER = "cust-1";

const amountOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((s, l) => s + (l.amount ?? 0), 0);
const qtyOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((s, l) => s + (l.qty ?? 0), 0);
const countOn = (lines, account) => lines.filter((l) => l.account === account).length;

// ── 1. Placing an order WITH a deposit ────────────────────────────────────

test("placing an order with a deposit books wallet +deposit AND stock −", () => {
  const lines = buildOrderPlacedLines({
    items: ITEMS,
    depositAmount: 400,
    wallet: WALLET,
  });

  // stock line per product + 1 wallet line
  assert.equal(lines.length, 2, "one stock line + one wallet line");
  assert.equal(qtyOn(lines, "stock"), -2, "2 units reserved");
  assert.equal(amountOn(lines, "stock"), -600, "value leaves with the units (2 × 300)");
  assert.equal(amountOn(lines, "wallet"), 400, "deposit lands in the wallet NOW");

  // The wallet line must target the specific wallet
  const walletLine = lines.find((l) => l.account === "wallet");
  assert.equal(walletLine.subjectId, WALLET, "deposit goes to the chosen wallet");
});

test("placing an order WITHOUT a deposit books only stock lines", () => {
  const lines = buildOrderPlacedLines({ items: ITEMS });

  assert.equal(lines.length, 1, "one stock line, no wallet line");
  assert.equal(countOn(lines, "wallet"), 0, "no wallet movement without a deposit");
  assert.equal(qtyOn(lines, "stock"), -2);
});

test("a zero deposit is the same as no deposit", () => {
  const lines = buildOrderPlacedLines({
    items: ITEMS,
    depositAmount: 0,
  });

  assert.equal(countOn(lines, "wallet"), 0, "zero deposit → no wallet line");
});

test("a negative deposit is refused", () => {
  assert.throws(
    () => buildOrderPlacedLines({ items: ITEMS, depositAmount: -100 }),
    /negative/,
    "negative deposit must throw",
  );
});

test("a deposit without a wallet is refused", () => {
  assert.throws(
    () => buildOrderPlacedLines({ items: ITEMS, depositAmount: 500 }),
    /wallet/,
    "deposit without wallet must throw",
  );
});

// ── 2. Cancelling an order WITH a deposit ─────────────────────────────────

test("a customer cancellation returns the STOCK and keeps the deposit", () => {
  // Was "…refunds wallet −deposit AND stock +". The refund half was the bug:
  // a deposit is what made the order real and the trip was committed on the
  // strength of it, so the customer walking away does not get it back.
  const lines = buildOrderCancelledLines({
    items: ITEMS,
    forfeitedDeposit: 400,
    wallet: WALLET,
    customerId: "c1",
  });

  assert.equal(qtyOn(lines, "stock"), 2, "units return to the shelf");
  assert.equal(amountOn(lines, "stock"), 600, "value comes back with the units");
  assert.equal(countOn(lines, "wallet"), 0, "NO wallet line — the cash never moves");
  assert.equal(
    amountOn(lines, "revenue"),
    400,
    "the retained deposit is recognised as income under its own subject",
  );
  const rev = lines.find((l) => l.account === "revenue");
  assert.equal(rev.subjectId, "forfeited_deposit", "never netted into sales");
});

test("the refused-document rollback is the one cancellation that refunds", () => {
  const lines = buildOrderCancelledLines({
    items: ITEMS,
    refundedDeposit: 400,
    wallet: WALLET,
  });
  assert.equal(amountOn(lines, "wallet"), -400, "the money goes back out");
  const walletLine = lines.find((l) => l.account === "wallet");
  assert.equal(walletLine.subjectId, WALLET, "from the original wallet");
  assert.equal(countOn(lines, "revenue"), 0, "and nothing is earned");
});

test("cancelling an order WITHOUT a deposit returns stock only", () => {
  const lines = buildOrderCancelledLines({ items: ITEMS });

  assert.equal(lines.length, 1, "one stock line, no wallet line");
  assert.equal(countOn(lines, "wallet"), 0, "no wallet movement when there's no deposit");
});

test("cancelling a legacy order (deposit but no wallet) moves no money", () => {
  // Orders placed before the depositWallet field was introduced have a
  // depositAmount but no wallet. Those orders never booked the deposit at
  // placement, so there is nothing to refund AND nothing to forfeit — the call
  // site passes neither field. Forfeiting one would recognise income against
  // cash the ledger never saw, which is inventing revenue, not retaining it.
  const lines = buildOrderCancelledLines({ items: ITEMS });

  assert.equal(lines.length, 1, "stock restored, nothing else (legacy order)");
  assert.equal(countOn(lines, "wallet"), 0);
  assert.equal(countOn(lines, "revenue"), 0);
});

test("a refunded deposit with no wallet is refused, not silently dropped", () => {
  assert.throws(
    () => buildOrderCancelledLines({ items: ITEMS, refundedDeposit: 400 }),
    /needs a wallet/,
    "cash cannot leave a till nobody named",
  );
});

// ── 3. Full round-trip: place → cancel ────────────────────────────────────

test("place then cancel: stock nets to ZERO, and the deposit stays earned", () => {
  // Retitled from "nets to ZERO on every account". Stock still must — inventory
  // is neither created nor destroyed — but the WALLET deliberately does not:
  // the customer's deposit stays in the till and is recognised as income. A
  // round trip that netted the wallet to zero was the refund this policy
  // removed.
  const placed = buildOrderPlacedLines({
    items: ITEMS,
    depositAmount: 400,
    wallet: WALLET,
  });

  const cancelled = buildOrderCancelledLines({
    items: ITEMS,
    forfeitedDeposit: 400,
    wallet: WALLET,
  });

  const all = [...placed, ...cancelled];
  assert.equal(qtyOn(all, "stock"), 0, "no inventory created or destroyed");
  assert.equal(amountOn(all, "stock"), 0, "no stock value created or destroyed");
  assert.equal(amountOn(all, "wallet"), 400, "the deposit STAYS — it is not refunded");
  assert.equal(amountOn(all, "revenue"), 400, "and the till balance is explained by income");
});

test("place without deposit then cancel also nets to zero", () => {
  const placed = buildOrderPlacedLines({ items: ITEMS });
  const cancelled = buildOrderCancelledLines({ items: ITEMS });
  const all = [...placed, ...cancelled];

  assert.equal(qtyOn(all, "stock"), 0);
  assert.equal(amountOn(all, "stock"), 0);
  assert.equal(countOn(all, "wallet"), 0, "no wallet movement at all");
});

// ── 4. Delivery after deposit: no double-counting ─────────────────────────

test("delivery does NOT book the deposit in the wallet again", () => {
  // Goods total = 1000, shipping = 100, deposit = 400, COD = 700
  // deposit + COD = 400 + 700 = 1100 = 1000 + 100 ✓
  const lines = buildOrderDeliveredLines({
    items: ITEMS,
    goodsTotal: 1000,
    shippingFee: 100,
    depositAmount: 400,
    wallet: WALLET,
    codAmount: 700,
    courierId: COURIER,
    customerId: CUSTOMER,
  });

  // The wallet should NOT appear — the deposit was booked at order_placed
  assert.equal(countOn(lines, "wallet"), 0, "no wallet line at delivery — deposit already booked");

  // But COD should still go to receivable_courier
  assert.equal(
    amountOn(lines, "receivable_courier"),
    700,
    "COD goes to receivable_courier as before",
  );

  // Revenue is still the goods total
  assert.equal(amountOn(lines, "revenue"), 1000, "revenue is the goods, not the fee");

  // COGS is still booked
  assert.equal(amountOn(lines, "cogs"), 600, "COGS = 2 × 300");
});

test("delivery with NO deposit still books COD correctly", () => {
  // Goods total = 1000, shipping = 100, deposit = 0, COD = 1100
  const lines = buildOrderDeliveredLines({
    items: ITEMS,
    goodsTotal: 1000,
    shippingFee: 100,
    depositAmount: 0,
    codAmount: 1100,
    courierId: COURIER,
    customerId: CUSTOMER,
  });

  assert.equal(countOn(lines, "wallet"), 0, "no wallet line for a zero deposit");
  assert.equal(amountOn(lines, "receivable_courier"), 1100, "full amount is COD");
});

// ── 5. Full prepaid (deposit = total) ─────────────────────────────────────

test("full prepaid: deposit covers everything, COD is zero", () => {
  // Goods = 1000, shipping = 100, deposit = 1100, COD = 0
  const placed = buildOrderPlacedLines({
    items: ITEMS,
    depositAmount: 1100,
    wallet: WALLET,
  });

  assert.equal(amountOn(placed, "wallet"), 1100, "full amount in the wallet at placement");

  const delivered = buildOrderDeliveredLines({
    items: ITEMS,
    goodsTotal: 1000,
    shippingFee: 100,
    depositAmount: 1100,
    wallet: WALLET,
    codAmount: 0,
    courierId: COURIER,
    customerId: CUSTOMER,
  });

  assert.equal(countOn(delivered, "wallet"), 0, "no wallet line at delivery");
  assert.equal(
    countOn(delivered, "receivable_courier"),
    0,
    "no courier receivable — nothing to collect",
  );
});

test("full prepaid cancelled: the shop keeps it, and says it is income", () => {
  const placed = buildOrderPlacedLines({
    items: ITEMS,
    depositAmount: 1100,
    wallet: WALLET,
  });

  const cancelled = buildOrderCancelledLines({
    items: ITEMS,
    forfeitedDeposit: 1100,
    wallet: WALLET,
  });

  const all = [...placed, ...cancelled];
  assert.equal(amountOn(all, "wallet"), 1100, "the money stays in the till");
  assert.equal(amountOn(all, "revenue"), 1100, "…and is recognised, not left as a ghost");
  assert.equal(qtyOn(all, "stock"), 0, "stock net zero");
});

// ── 6. Edge cases ─────────────────────────────────────────────────────────

test("multi-product order with deposit: one wallet line, not one per product", () => {
  const items = [
    { productId: "p-shirt", quantity: 2, unitPrice: 500, unitCost: 300 },
    { productId: "p-pants", quantity: 1, unitPrice: 800, unitCost: 500 },
  ];

  const lines = buildOrderPlacedLines({
    items,
    depositAmount: 500,
    wallet: WALLET,
  });

  // 2 stock lines (one per product) + 1 wallet line
  assert.equal(countOn(lines, "stock"), 2, "one stock line per product");
  assert.equal(countOn(lines, "wallet"), 1, "exactly ONE wallet line for the deposit");
  assert.equal(amountOn(lines, "wallet"), 500);
});
