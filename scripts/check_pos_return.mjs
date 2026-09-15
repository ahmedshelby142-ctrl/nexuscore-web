/**
 * استرجاع بفاتورة — the sold line is the RECEIPT's, not the catalog's.
 *
 * The defect these pin: the picker rebuilt lines from `revenue` ledger rows,
 * whose subject is the CHANNEL (`"pos"`), not a product. One row per sale, no
 * matching stock row, so every receipt resolved to «منتج غير معروف» × 1 priced
 * at the whole sale total. See the header of `src/lib/posReturn.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  historicalSaleLines,
  priorReturnsFrom,
  remainingSaleLines,
  resolvePosReturnLine,
  saleLineKey,
} from "../src/lib/posReturn.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/** A receipt as the checkout actually writes it. */
const receipt = (id, items, extra = {}) => ({
  id,
  payload: { channel: "pos", items, ...extra },
});

const shirt = { productId: "P1", productName: "قميص", unitPrice: 250, quantity: 2 };
const shoe = { productId: "P2", productName: "حذاء", variantName: "أسود", unitPrice: 400, quantity: 1 };

test("a receipt's lines come from its own document", () => {
  const lines = historicalSaleLines(receipt("e1", [shirt, shoe]));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].productName, "قميص");
  assert.equal(lines[0].quantity, 2);
  assert.equal(lines[0].unitPrice, 250);
  assert.equal(lines[1].variantName, "أسود");
});

test("the name and price are the RECEIPT's, never today's catalog", () => {
  // This is the whole point: renaming or repricing a product must not rewrite
  // what a past customer was charged.
  const lines = historicalSaleLines(receipt("e1", [shirt]));
  assert.equal(lines[0].productName, "قميص");
  assert.equal(lines[0].unitPrice, 250);
});

test("a receipt with no line detail resolves to nothing, not to a guess", () => {
  assert.deepEqual(historicalSaleLines({ id: "e1", payload: { channel: "pos" } }), []);
  assert.deepEqual(historicalSaleLines({ id: "e1" }), []);
  assert.deepEqual(historicalSaleLines({ id: "e1", payload: { items: "nope" } }), []);
});

test("a refund receipt is not itself returnable", () => {
  // A return is a `pos_sale` with negative quantities. Reading it as a sale
  // would let a refund be refunded.
  const lines = historicalSaleLines(
    receipt("e2", [{ ...shirt, quantity: -1 }], { returnOfEventId: "e1" }),
  );
  assert.deepEqual(lines, []);
});

test("two shades of one product are two independent lines", () => {
  const red = { productId: "P2", productName: "حذاء", variantName: "أحمر", unitPrice: 400, quantity: 1 };
  assert.notEqual(saleLineKey(shoe), saleLineKey(red));

  const rows = remainingSaleLines(receipt("e1", [shoe, red]), [
    { sourceEventId: "e1", productId: "P2", variantName: "أسود", quantity: 1 },
  ]);
  const black = rows.find((r) => r.variantName === "أسود");
  const crimson = rows.find((r) => r.variantName === "أحمر");
  assert.equal(black.remaining, 0, "the black one came back");
  assert.equal(crimson.remaining, 1, "the red one must not be consumed by it");
});

test("what already came back cannot come back again", () => {
  const prior = [{ sourceEventId: "e1", productId: "P1", quantity: 1 }];
  const rows = remainingSaleLines(receipt("e1", [shirt]), prior);
  assert.equal(rows[0].sold, 2);
  assert.equal(rows[0].returned, 1);
  assert.equal(rows[0].remaining, 1);
});

test("a fully returned line stays visible with nothing left", () => {
  const rows = remainingSaleLines(receipt("e1", [shirt]), [
    { sourceEventId: "e1", productId: "P1", quantity: 2 },
  ]);
  assert.equal(rows.length, 1, "the row must not silently vanish");
  assert.equal(rows[0].remaining, 0);
});

test("a return against ANOTHER receipt does not reduce this one", () => {
  const rows = remainingSaleLines(receipt("e1", [shirt]), [
    { sourceEventId: "OTHER", productId: "P1", quantity: 2 },
  ]);
  assert.equal(rows[0].remaining, 2);
});

test("past returns are read off the return events themselves", () => {
  const rows = priorReturnsFrom([
    receipt("e1", [shirt]),
    receipt("e2", [{ ...shirt, quantity: -1 }], { returnOfEventId: "e1" }),
    receipt("e3", [{ ...shoe, quantity: -1 }], { returnOfEventId: "e1" }),
  ]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.sourceEventId === "e1"));
  assert.ok(rows.every((r) => r.quantity > 0), "recorded as a positive count");
});

test("a sale with no returnOfEventId contributes no prior return", () => {
  assert.deepEqual(priorReturnsFrom([receipt("e1", [shirt])]), []);
});

test("returning more than is left is refused", () => {
  const ev = receipt("e1", [shirt]);
  const prior = [{ sourceEventId: "e1", productId: "P1", quantity: 1 }];
  assert.throws(
    () => resolvePosReturnLine(ev, { sourceEventId: "e1", key: saleLineKey(shirt), quantity: 2 }, prior),
    /فاضل 1/,
  );
  // …and exactly what is left is allowed.
  const ok = resolvePosReturnLine(ev, { sourceEventId: "e1", key: saleLineKey(shirt), quantity: 1 }, prior);
  assert.equal(ok.quantity, 1);
  assert.equal(ok.unitPrice, 250, "refunded at the price actually charged");
});

test("a line that is not on the receipt is refused", () => {
  assert.throws(
    () => resolvePosReturnLine(receipt("e1", [shirt]), { sourceEventId: "e1", key: "P9::", quantity: 1 }),
    /مش على الفاتورة/,
  );
});

test("a non-positive quantity is refused", () => {
  const ev = receipt("e1", [shirt]);
  for (const q of [0, -1, NaN, "x"]) {
    assert.throws(
      () => resolvePosReturnLine(ev, { sourceEventId: "e1", key: saleLineKey(shirt), quantity: q }),
      /أكبر من صفر/,
    );
  }
});

// ── the screen must not fall back to the old reconstruction ─────────────────

test("the picker no longer rebuilds lines out of revenue rows", () => {
  const src = read("../src/components/sales/POSReturnModal.tsx");
  assert.doesNotMatch(
    src,
    /account === "revenue"/,
    "revenue's subject is the channel, not a product — that was the whole bug",
  );
  assert.doesNotMatch(src, /منتج غير معروف/, "the fallback that told the operator nothing");
  assert.match(src, /remainingSaleLines\(/, "it must read the sale document");
});

test("the refunded price and the source receipt reach the cart", () => {
  const src = read("../src/components/sales/CheckoutForm.tsx");
  assert.match(src, /historical \? historical\.unitPrice/, "refund at the historical price");
  assert.match(src, /returnOfEventId: historical\.sourceEventId/);
  assert.match(src, /returnOfEventId:\s*\n?\s*cart\.map/, "and onto the event payload");
});

// ── a discounted sale refunds what was CHARGED, not the list price ──────────

test("a cart discount is spread across the lines it discounted", () => {
  // A POS discount applies to the CART: the payload keeps `unitPrice` at list
  // price and `discountAmount` separately, while `buildSaleLines` books revenue
  // NET. Refunding the raw `unitPrice` hands back more than was taken.
  // Measured on QA-STORE: a بوكس listed 500, sold 450 under QAUAT10, and the
  // picker offered 500 — a 50 over-refund.
  const ev = receipt("e1", [{ productId: "BOX", productName: "بوكس", unitPrice: 500, quantity: 1 }], {
    discountAmount: 50,
    totalAmount: 450,
  });
  assert.equal(historicalSaleLines(ev)[0].unitPrice, 450, "refund at what was charged");
});

test("the discount splits in proportion to line value", () => {
  // 300 + 100 = 400 gross, 40 off → each line keeps 90%.
  const ev = receipt(
    "e1",
    [
      { productId: "A", productName: "A", unitPrice: 300, quantity: 1 },
      { productId: "B", productName: "B", unitPrice: 100, quantity: 1 },
    ],
    { discountAmount: 40 },
  );
  const [a, b] = historicalSaleLines(ev);
  assert.equal(a.unitPrice, 270);
  assert.equal(b.unitPrice, 90);
  // The refundable total equals the revenue that was actually booked.
  assert.equal(a.unitPrice * a.quantity + b.unitPrice * b.quantity, 360);
});

test("quantity is taken into account when splitting", () => {
  const ev = receipt("e1", [{ productId: "A", productName: "A", unitPrice: 100, quantity: 4 }], {
    discountAmount: 40,
  });
  assert.equal(historicalSaleLines(ev)[0].unitPrice, 90, "400 gross − 40 → 90 each");
});

test("an undiscounted sale is untouched", () => {
  const ev = receipt("e1", [{ productId: "A", productName: "A", unitPrice: 250, quantity: 2 }]);
  assert.equal(historicalSaleLines(ev)[0].unitPrice, 250);
});

test("a discount at or above the goods cannot make a refund negative", () => {
  const ev = receipt("e1", [{ productId: "A", productName: "A", unitPrice: 100, quantity: 1 }], {
    discountAmount: 500,
  });
  assert.equal(historicalSaleLines(ev)[0].unitPrice, 0);
});
