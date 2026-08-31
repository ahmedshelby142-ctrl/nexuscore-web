/**
 * البوكسات — a bundle owns no shelf, so both directions of its stock are
 * derived from its components.
 *
 *     node --test scripts/check_bundle_stock.mjs
 *
 * Two things are checked, and they are the two that were broken:
 *   1. Selling a box must decrement the COMPONENTS, never the virtual record.
 *   2. A box's availability is capped by its scarcest component.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { expandBundleMoves, applyMovesToProducts } from "../src/lib/stockMirror.ts";
import { bundleAvailableStock, getActualStock } from "../src/lib/product.ts";

/** بوكس = 2 × قميص + 1 × بنطلون. */
const shirt = () => ({ id: "shirt", name: "قميص", totalQuantity: 10 });
const pants = () => ({ id: "pants", name: "بنطلون", totalQuantity: 3 });
const box = () => ({
  id: "box",
  name: "بوكس الصيف",
  isBundle: true,
  bundleItems: [
    { productId: "shirt", quantity: 2 },
    { productId: "pants", quantity: 1 },
  ],
});

// ── 1. the ripple: components move, the bundle never does ───────────────────

test("selling a bundle decrements its components, not the bundle", () => {
  const catalogue = [shirt(), pants(), box()];
  const moves = expandBundleMoves([{ productId: "box", delta: -2 }], catalogue);
  const { products } = applyMovesToProducts(catalogue, moves);

  const by = (id) => products.find((p) => p.id === id);
  assert.equal(getActualStock(by("shirt")), 6, "10 − (2 per box × 2 boxes)");
  assert.equal(getActualStock(by("pants")), 1, "3 − (1 per box × 2 boxes)");
  // The virtual record must be untouched — it has no shelf to move.
  assert.equal(by("box").totalQuantity, undefined);
});

test("returning a bundle puts the components back", () => {
  const catalogue = [shirt(), pants(), box()];
  const moves = expandBundleMoves([{ productId: "box", delta: +1 }], catalogue);
  const { products } = applyMovesToProducts(catalogue, moves);

  assert.equal(getActualStock(products.find((p) => p.id === "shirt")), 12);
  assert.equal(getActualStock(products.find((p) => p.id === "pants")), 4);
});

test("a plain product passes through the expander untouched", () => {
  const moves = expandBundleMoves([{ productId: "shirt", delta: -3 }], [shirt(), box()]);
  assert.deepEqual(moves, [{ productId: "shirt", delta: -3 }]);
});

test("a bundle with no recipe is left alone rather than silently moving nothing", () => {
  const empty = { id: "box", isBundle: true, bundleItems: [] };
  const moves = expandBundleMoves([{ productId: "box", delta: -1 }], [empty]);
  assert.deepEqual(moves, [{ productId: "box", delta: -1 }]);
});

// ── 2. availability: the scarcest component caps the box ────────────────────

test("availability is capped by the scarcest component", () => {
  // shirt 10 → 5 boxes, pants 3 → 3 boxes. The pants decide.
  assert.equal(bundleAvailableStock(box(), [shirt(), pants()]), 3);
});

test("the blueprint's case: need 2 of X, have 4 of X → 2 boxes", () => {
  const b = { id: "b", isBundle: true, bundleItems: [{ productId: "x", quantity: 2 }] };
  assert.equal(bundleAvailableStock(b, [{ id: "x", totalQuantity: 4 }]), 2);
});

test("a partial component yields whole boxes only", () => {
  const b = { id: "b", isBundle: true, bundleItems: [{ productId: "x", quantity: 3 }] };
  assert.equal(bundleAvailableStock(b, [{ id: "x", totalQuantity: 7 }]), 2, "7/3 floors to 2");
});

test("a missing or exhausted component makes the box unavailable", () => {
  assert.equal(bundleAvailableStock(box(), [shirt()]), 0, "pants absent from the catalogue");
  assert.equal(bundleAvailableStock(box(), [shirt(), { id: "pants", totalQuantity: 0 }]), 0);
});

test("a recipe-less bundle is unbuildable, not infinitely available", () => {
  assert.equal(bundleAvailableStock({ id: "b", isBundle: true, bundleItems: [] }, []), 0);
  assert.equal(bundleAvailableStock({ id: "b", isBundle: true }, []), 0);
});

test("availability reads variant stock when the recipe names a درجة", () => {
  const b = {
    id: "b",
    isBundle: true,
    bundleItems: [{ productId: "jacket", quantity: 2, variantName: "أحمر" }],
  };
  const jacket = {
    id: "jacket",
    metadata: {
      variants: [
        { name: "أحمر", stock: 5 },
        { name: "أزرق", stock: 100 },
      ],
    },
  };
  // The أزرق pile must not prop up a box that needs أحمر.
  assert.equal(bundleAvailableStock(b, [jacket]), 2);
});

// ── 3. the floor, on read as well as write ──────────────────────────────────

test("stock never reads negative, even from a legacy record", () => {
  assert.equal(getActualStock({ id: "p", totalQuantity: -3 }), 0);
  assert.equal(
    getActualStock({ id: "v", metadata: { variants: [{ name: "أحمر", stock: -2 }] } }),
    0,
  );
});
