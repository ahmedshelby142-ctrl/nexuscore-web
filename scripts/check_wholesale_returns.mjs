/**
 * مرتجع الجملة — the rules that say what may come back at all.
 *
 * `check_returns.mjs` proves the MONEY of a wholesale return: what the debt
 * absorbs, what crosses the counter. This file proves the ELIGIBILITY that has
 * to come first — the part that was missing entirely, so a trader could be
 * credited for a product they never bought, at a price from no invoice, as
 * many times as the button was pressed.
 *
 * Every rule below was a way to invent money before `resolveWholesaleReturn`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWholesaleReturnLines,
  remainingWholesaleLines,
  resolveWholesaleReturn,
  wholesaleDiscountFactor,
  wholesaleLineKey,
  WHOLESALE_RETURN_TYPE,
} from "../src/lib/ledger/wholesale.ts";

const on = (lines, account, subjectId) =>
  lines
    .filter((l) => l.account === account && (!subjectId || l.subjectId === subjectId))
    .reduce((sum, l) => sum + (l.amount ?? 0), 0);

const qtyOn = (lines, account, subjectId) =>
  lines
    .filter((l) => l.account === account && l.subjectId === subjectId)
    .reduce((sum, l) => sum + (l.qty ?? 0), 0);

/** The §5 scenario: the same product, two invoices, two prices. */
const INV_A = {
  id: "a",
  invoiceNumber: "FJ-A",
  clientId: "trader",
  goodsTotal: 1000,
  discountAmount: 0,
  items: [
    { id: "a1", productId: "X", productName: "منتج X", quantity: 10, wholesalePrice: 100, unitCost: 60 },
  ],
};

const INV_B = {
  id: "b",
  invoiceNumber: "FJ-B",
  clientId: "trader",
  goodsTotal: 1400,
  discountAmount: 0,
  items: [
    { id: "b1", productId: "X", productName: "منتج X", quantity: 10, wholesalePrice: 140, unitCost: 90 },
  ],
};

/** Another trader's invoice, for the forged-id tests. */
const INV_OTHER = {
  id: "z",
  invoiceNumber: "FJ-Z",
  clientId: "someone-else",
  goodsTotal: 500,
  discountAmount: 0,
  items: [
    { id: "z1", productId: "X", productName: "منتج X", quantity: 5, wholesalePrice: 100, unitCost: 60 },
  ],
};

const resolve = (requests, invoices = [INV_A, INV_B], priorReturns = [], clientId = "trader") =>
  resolveWholesaleReturn({ clientId, requests, invoices, priorReturns, costOf: () => 999 });

const priorReturn = (invoiceId, lineId, quantity) => ({
  type: WHOLESALE_RETURN_TYPE,
  original_order_id: invoiceId,
  returned_items: [{ line_id: lineId, product_id: "X", quantity }],
});

// ── what may be returned at all ─────────────────────────────────────────────

test("a product the trader never bought cannot be returned", () => {
  // The whole point. There is no invoice line for "Y", so there is nothing to
  // address the request to.
  assert.throws(
    () => resolve([{ invoiceId: "a", lineKey: "not-a-line", quantity: 1 }]),
    /is not a line on invoice/,
  );
});

test("another trader's invoice cannot be returned against this account", () => {
  assert.throws(
    () => resolve([{ invoiceId: "z", lineKey: "z1", quantity: 1 }], [INV_A, INV_B, INV_OTHER]),
    /belongs to another client/,
  );
});

test("an invoice from another store is simply not there", () => {
  // `invoices` comes from a store-scoped query, so a forged id fails the first
  // rule rather than needing a tenancy check of its own.
  assert.throws(
    () => resolve([{ invoiceId: "forged", lineKey: "a1", quantity: 1 }]),
    /is not this store's/,
  );
});

test("zero, negative and nonsense quantities are refused", () => {
  for (const quantity of [0, -3, NaN, Infinity, "abc"]) {
    assert.throws(
      () => resolve([{ invoiceId: "a", lineKey: "a1", quantity }]),
      /must be positive/,
      `quantity ${String(quantity)}`,
    );
  }
});

test("more than the invoice sold is refused", () => {
  assert.throws(
    () => resolve([{ invoiceId: "a", lineKey: "a1", quantity: 11 }]),
    /only 10 left to return/,
  );
});

test("the same line twice in one return cannot slip past the ceiling", () => {
  // Two requests of 6 each would both check themselves against 10 and both
  // pass, returning 12 of 10.
  assert.throws(
    () =>
      resolve([
        { invoiceId: "a", lineKey: "a1", quantity: 6 },
        { invoiceId: "a", lineKey: "a1", quantity: 6 },
      ]),
    /appears twice/,
  );
});

// ── partial returns and the ceiling ─────────────────────────────────────────

test("a partial return leaves the rest returnable", () => {
  const after = remainingWholesaleLines(INV_A, [priorReturn("a", "a1", 3)]);
  assert.equal(after[0].sold, 10);
  assert.equal(after[0].returned, 3);
  assert.equal(after[0].remaining, 7, "10 sold, 3 back");
});

test("the second return cannot exceed what the first left", () => {
  const prior = [priorReturn("a", "a1", 3)];
  assert.doesNotThrow(() => resolve([{ invoiceId: "a", lineKey: "a1", quantity: 7 }], [INV_A, INV_B], prior));
  assert.throws(
    () => resolve([{ invoiceId: "a", lineKey: "a1", quantity: 8 }], [INV_A, INV_B], prior),
    /only 7 left to return/,
  );
});

test("a fully returned line is refused, not silently allowed again", () => {
  const prior = [priorReturn("a", "a1", 10)];
  assert.throws(
    () => resolve([{ invoiceId: "a", lineKey: "a1", quantity: 1 }], [INV_A, INV_B], prior),
    /only 0 left to return/,
  );
});

test("a corrupt record claiming more than went out cannot enlarge the ceiling", () => {
  const after = remainingWholesaleLines(INV_A, [priorReturn("a", "a1", 99)]);
  assert.equal(after[0].remaining, 0, "floored, never negative");
});

test("returns recorded against a DIFFERENT invoice do not eat this one's ceiling", () => {
  const after = remainingWholesaleLines(INV_A, [priorReturn("b", "b1", 10)]);
  assert.equal(after[0].remaining, 10);
});

test("a retail return record never counts against a wholesale invoice", () => {
  const retail = { type: "return", original_order_id: "a", returned_items: [{ product_id: "X", quantity: 10 }] };
  assert.equal(remainingWholesaleLines(INV_A, [retail])[0].remaining, 10);
});

// ── the price: the invoice's, never today's ─────────────────────────────────

test("the same product from two invoices keeps two prices", () => {
  const resolved = resolve([
    { invoiceId: "a", lineKey: "a1", quantity: 2 },
    { invoiceId: "b", lineKey: "b1", quantity: 2 },
  ]);
  assert.equal(resolved.lines.length, 2, "not collapsed into one line of 4");
  assert.equal(resolved.lines[0].unitPrice, 100);
  assert.equal(resolved.lines[1].unitPrice, 140);
  assert.equal(resolved.returnValue, 480, "2×100 + 2×140 — never 4×120");
  assert.equal(resolved.lines[0].invoiceNumber, "FJ-A");
  assert.equal(resolved.lines[1].invoiceNumber, "FJ-B");
});

test("an invoice discount scales the credit", () => {
  // 10 at 100 with 100 off cost 900, so each unit was really 90. Crediting
  // 100 would pay the promotion a second time on the way out.
  const discounted = { ...INV_A, id: "d", invoiceNumber: "FJ-D", goodsTotal: 1000, discountAmount: 100 };
  assert.equal(wholesaleDiscountFactor(discounted), 0.9);
  const resolved = resolve([{ invoiceId: "d", lineKey: "a1", quantity: 10 }], [discounted]);
  assert.equal(resolved.returnValue, 900);
});

test("a missing or absurd discount never credits MORE than list", () => {
  for (const invoice of [
    { ...INV_A, goodsTotal: undefined, discountAmount: undefined },
    { ...INV_A, goodsTotal: 1000, discountAmount: -50 },
    { ...INV_A, goodsTotal: 0, discountAmount: 100 },
  ]) {
    assert.equal(wholesaleDiscountFactor(invoice), 1);
  }
  // A discount that swallows the goods leaves nothing to credit.
  assert.equal(wholesaleDiscountFactor({ ...INV_A, goodsTotal: 1000, discountAmount: 1000 }), 0);
});

test("the cost reversed is the cost the goods LEFT at", () => {
  // `costOf` here returns 999 — today's average. The invoice says 60, and
  // that is what has to come off COGS, or inventory value moves by a number
  // that never moved.
  const l = buildWholesaleReturnLines({
    resolved: resolve([{ invoiceId: "a", lineKey: "a1", quantity: 5 }]),
    currentDebt: 5000,
  });
  assert.equal(on(l, "cogs"), -300, "5 × 60, not 5 × 999");
  assert.equal(on(l, "stock"), 300, "and the same value returns to the shelf");
  assert.equal(qtyOn(l, "stock", "X"), 5);
});

test("an invoice written before unitCost existed falls back to today's WAC", () => {
  const legacy = {
    id: "old",
    invoiceNumber: "FJ-OLD",
    clientId: "trader",
    items: [{ id: "o1", productId: "X", productName: "منتج X", quantity: 4, wholesalePrice: 100 }],
  };
  const resolved = resolve([{ invoiceId: "old", lineKey: "o1", quantity: 4 }], [legacy]);
  assert.equal(resolved.lines[0].unitCost, 999, "no stored cost — today's is all there is");
});

test("the الطلبات price field is read as well as الجملة's", () => {
  // Three writers, two field names. Picking one would value half the invoices
  // in the database at zero.
  const fromOrders = {
    id: "o",
    invoiceNumber: "FJ-O",
    clientId: "trader",
    items: [{ id: "x1", productId: "X", quantity: 3, unitPrice: 250, unitCost: 100 }],
  };
  assert.equal(resolve([{ invoiceId: "o", lineKey: "x1", quantity: 3 }], [fromOrders]).returnValue, 750);
});

// ── multiple lines in one return ────────────────────────────────────────────

test("every returned line survives to the ledger", () => {
  const twoProducts = {
    id: "m",
    invoiceNumber: "FJ-M",
    clientId: "trader",
    goodsTotal: 700,
    discountAmount: 0,
    items: [
      { id: "m1", productId: "X", productName: "X", quantity: 2, wholesalePrice: 100, unitCost: 40 },
      { id: "m2", productId: "Y", productName: "Y", quantity: 5, wholesalePrice: 100, unitCost: 70 },
    ],
  };
  const resolved = resolve(
    [
      { invoiceId: "m", lineKey: "m1", quantity: 2 },
      { invoiceId: "m", lineKey: "m2", quantity: 3 },
    ],
    [twoProducts],
  );
  const l = buildWholesaleReturnLines({ resolved, currentDebt: 1000 });
  assert.equal(qtyOn(l, "stock", "X"), 2, "the first line is not the only one stored");
  assert.equal(qtyOn(l, "stock", "Y"), 3);
  assert.equal(on(l, "revenue"), -500);
  assert.equal(on(l, "cogs"), -(2 * 40 + 3 * 70));
});

// ── the document keys the ledger must agree with ────────────────────────────

test("a line with no id is still addressable, and stays unique per variant", () => {
  const noIds = {
    id: "n",
    invoiceNumber: "FJ-N",
    clientId: "trader",
    items: [
      { productId: "X", productName: "X أحمر", variantName: "أحمر", quantity: 2, wholesalePrice: 100 },
      { productId: "X", productName: "X أزرق", variantName: "أزرق", quantity: 3, wholesalePrice: 100 },
    ],
  };
  const [red, blue] = noIds.items.map(wholesaleLineKey);
  assert.notEqual(red, blue, "two shades of one product are two lines");
  assert.equal(resolve([{ invoiceId: "n", lineKey: blue, quantity: 3 }], [noIds]).returnValue, 300);
});

test("a return with no client or no lines is refused before anything is read", () => {
  assert.throws(() => resolve([{ invoiceId: "a", lineKey: "a1", quantity: 1 }], [INV_A], [], ""), /no client/);
  assert.throws(() => resolve([]), /nothing selected/);
});
