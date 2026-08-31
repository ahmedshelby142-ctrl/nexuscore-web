/**
 * Product search matching + the money formatter's non-finite guard.
 *
 *     node --test scripts/check_product_search.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { matchesProductQuery, searchProducts } from "../src/lib/productSearch.ts";
import {
  productPrice,
  productWholesalePrice,
  productMinLevel,
} from "../src/lib/product.ts";
import { formatMoney, formatQty } from "../src/lib/math.ts";

const CATALOGUE = [
  { id: "1", name: "تيشيرت قطن أبيض", sku: "TSH-100", barcode: "6221031" },
  { id: "2", name: "شنطة جلد بني", sku: "BAG-250" },
  { id: "3", name: "تيشيرت قطن أسود", sku: "TSH-101" },
];

test("finds by part of the name", () => {
  assert.equal(searchProducts(CATALOGUE, "تيشيرت").length, 2);
  assert.equal(searchProducts(CATALOGUE, "شنطة")[0].id, "2");
});

test("finds by SKU and by barcode", () => {
  assert.equal(searchProducts(CATALOGUE, "BAG-250")[0].id, "2");
  assert.equal(searchProducts(CATALOGUE, "6221031")[0].id, "1");
});

test("every word must match, so two words narrow instead of widening", () => {
  // The failure this prevents: "تيشيرت أسود" returning both shirts because
  // each word matched something somewhere.
  const hits = searchProducts(CATALOGUE, "تيشيرت أسود");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "3");
});

test("Arabic-Indic digits match Latin ones", () => {
  // A code copied off an Arabic keyboard must still find the product.
  assert.ok(matchesProductQuery({ name: "تيشيرت", sku: "TSH-100" }, "١٠٠"));
});

test("an empty query shows everything rather than hiding the list", () => {
  assert.equal(searchProducts(CATALOGUE, "").length, 3);
  assert.equal(searchProducts(CATALOGUE, "   ").length, 3);
});

test("no match is no match — not a silent everything", () => {
  assert.equal(searchProducts(CATALOGUE, "حاجة مش موجودة").length, 0);
});

// ── The accessor that replaced the ghost field ──────────────────────────────

test("productPrice reads the field that is actually written", () => {
  assert.equal(productPrice({ unitPrice: 250 }), 250);
});

test("productPrice never returns undefined or NaN", () => {
  // Old persisted rows, and the `retail_price` ghost, both land here.
  assert.equal(productPrice({}), 0);
  assert.equal(productPrice(undefined), 0);
  assert.equal(productPrice(null), 0);
  assert.equal(productPrice({ unitPrice: NaN }), 0);
});

// ── The wholesale accessor, which carried the same bug ──────────────────────

test("productWholesalePrice reads the field writers actually write", () => {
  assert.equal(productWholesalePrice({ unitPrice: 250, wholesalePrice: 180 }), 180);
});

test("no wholesale price falls back to retail, never to zero", () => {
  // Zero would silently give the goods away on a جملة invoice. Retail is the
  // honest default: it is a real price the owner has already set.
  assert.equal(productWholesalePrice({ unitPrice: 250 }), 250);
  assert.equal(productWholesalePrice({ unitPrice: 250, wholesalePrice: 0 }), 250);
  assert.equal(productWholesalePrice({ unitPrice: 250, wholesalePrice: NaN }), 250);
  assert.equal(productWholesalePrice(undefined), 0);
});

test("the old ghost spelling is NOT consulted", () => {
  // This is the regression that matters: the accessor used to read
  // `wholesale_price`, which nothing writes, so it fell through on every
  // product and no wholesale price was ever used anywhere in the app.
  assert.equal(productWholesalePrice({ unitPrice: 250, wholesale_price: 180 }), 250);
});

// ── The reorder level, which had three fallback chains reading it ───────────

test("productMinLevel reads minStockLevel and nothing else", () => {
  assert.equal(productMinLevel({ minStockLevel: 5 }), 5);
  assert.equal(productMinLevel({ minStockLevel: 0 }), 0);
  assert.equal(productMinLevel({}), 0);
  assert.equal(productMinLevel(undefined), 0);
  // `reorder_point` was the ghost half of every `?? reorder_point ?? 0` chain.
  assert.equal(productMinLevel({ reorder_point: 9 }), 0);
});

// ── Nothing non-finite reaches the screen ───────────────────────────────────

test("formatMoney shows a dash, never the string NaN", () => {
  // The literal user-visible bug: "NaN ج.م" on the order summary.
  assert.equal(formatMoney(NaN), "— ج.م");
  assert.equal(formatMoney(undefined), "— ج.م");
  assert.equal(formatMoney(null), "— ج.م");
  assert.equal(formatMoney(Infinity), "— ج.م");
  assert.ok(!formatMoney(NaN).includes("NaN"));
});

test("formatMoney formats real amounts in Arabic with ج.م", () => {
  assert.ok(formatMoney(1500).includes("ج.م"));
  assert.equal(formatMoney(0), "٠ ج.م");
});

test("formatQty falls back to zero, since a count is still a count", () => {
  assert.equal(formatQty(NaN), "0");
  assert.equal(formatQty(undefined), "0");
  assert.ok(!formatQty(NaN).includes("NaN"));
});
