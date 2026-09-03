/**
 * One source of truth for stock.
 *
 *     node --test scripts/check_stock_source.mjs
 *
 * The app used to hold two answers to "how much is on the shelf": the ledger's
 * SUM(qty_delta) behind `useStock().qtyOf`, and the `products.quantity` mirror
 * behind `getActualStock`. They disagreed, and on /bundles the contradiction
 * was visible inside a single screen — the product search offered a product as
 * "المخزون: ٥٠" and the component row added from it said "نفد المخزون".
 *
 * The ledger is authoritative: `addProduct` refuses a `quantity` argument
 * because "stock is the ledger's SUM (§1.1)". These assertions pin that down.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getActualStock, getVariantStock, sellableStock } from "../src/lib/product.ts";
import { setStockSnapshot, clearStockSnapshot, ledgerQty } from "../src/lib/ledger/stockSnapshot.ts";

const plain = { id: "p1", quantity: 9 };
const variant = {
  id: "p2",
  quantity: 50,
  metadata: { variants: [{ name: "احمر", stock: 30 }, { name: "ازرق", stock: 20 }] },
};

test("with no aggregation loaded, the mirror answers", () => {
  // null is not zero. A cold start must not paint a sold-out shop.
  clearStockSnapshot();
  assert.equal(ledgerQty("p1"), null);
  assert.equal(getActualStock(plain), 9);
  assert.equal(getActualStock(variant), 50);
});

test("once the ledger has spoken, it overrides the mirror", () => {
  // The exact live divergence: mirror says 9 and 50, ledger says 0.
  setStockSnapshot(new Map([["p3", 58]]));
  assert.equal(getActualStock(plain), 0, "mirror 9 must lose to ledger 0");
  assert.equal(getActualStock(variant), 0, "mirror 50 must lose to ledger 0");
  assert.equal(getActualStock({ id: "p3", quantity: 1 }), 58, "ledger 58 beats mirror 1");
  clearStockSnapshot();
});

test("a درجة can never offer units the product does not have", () => {
  // The ledger keeps one quantity per product, so the split between درجات can
  // only come from the mirror — but it is clamped to the authoritative total.
  setStockSnapshot(new Map([["p2", 0]]));
  assert.equal(getVariantStock(variant, "احمر"), 0, "30 in the mirror, 0 in the ledger");
  setStockSnapshot(new Map([["p2", 12]]));
  assert.equal(getVariantStock(variant, "احمر"), 12, "clamped to the product total");
  assert.equal(getVariantStock(variant, "ازرق"), 12, "same ceiling for every درجة");
  clearStockSnapshot();
});

test("a bundle keeps its recipe-derived answer", () => {
  // A بوكس owns no stock and has no ledger lines of its own, so reading the
  // snapshot for one would report a hard zero for every box in the shop.
  const box = { id: "b1", isBundle: true, bundleItems: [{ productId: "p3", quantity: 2 }] };
  setStockSnapshot(new Map([["p3", 7]]));
  assert.equal(sellableStock(box, [box, { id: "p3", quantity: 0 }]), 3, "floor(7 / 2)");
  clearStockSnapshot();
});

test("getActualStock reads the snapshot, not the record", () => {
  // Source-level, so deleting the lookup and leaving the tests passing on the
  // mirror fallback is not possible.
  const src = readFileSync(new URL("../src/lib/product.ts", import.meta.url), "utf8");
  assert.match(src, /ledgerQty\(product\.id\)/, "getActualStock must consult the ledger");
  assert.match(src, /Math\.min\(fromMirror, getActualStock\(product\)\)/, "variants must be clamped");
});
