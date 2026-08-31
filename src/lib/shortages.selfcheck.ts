/**
 * One runnable check for the two pieces of arithmetic this feature turns on:
 * `getActualStock` (the 0-stock regression) and `computeShortages` (the
 * deficit). Both are pure, so no store, no renderer, no framework.
 *
 *   npx tsx src/lib/shortages.selfcheck.ts
 */

import assert from "node:assert/strict";
import { getActualStock } from "@/lib/product";
import { computeShortages } from "@/lib/shortages";

// ── getActualStock ──────────────────────────────────────────────────────────

// Variants win, and they are summed.
assert.equal(
  getActualStock({ metadata: { variants: [{ stock: 4 }, { stock: 6 }] }, totalQuantity: 999 }),
  10,
);
// No variants → the product's own count. This is the "0 stock" regression:
// the ledger says nothing, the record says 12, the screen must say 12.
assert.equal(getActualStock({ totalQuantity: 12 }), 12);
// Legacy field still honoured.
assert.equal(getActualStock({ quantity: 7 }), 7);
// An empty variants array is not "has variants".
assert.equal(getActualStock({ metadata: { variants: [] }, totalQuantity: 5 }), 5);
// Nothing at all is 0, not NaN.
assert.equal(getActualStock(undefined), 0);
assert.equal(getActualStock({ totalQuantity: "abc" }), 0);

// ── computeShortages ────────────────────────────────────────────────────────

const products = [
  // Sold 5 against a shelf of 3: the shelf floored to 0 at placement.
  { id: "a", name: "قميص", sku: "SH-1", totalQuantity: 0 },
  { id: "b", name: "بنطلون", sku: "PT-1", totalQuantity: 100 },
  { id: "c", name: "جاكيت", sku: "JK-1", metadata: { variants: [{ stock: 2 }, { stock: 3 }] } },
];

// ── THE FIX ─────────────────────────────────────────────────────────────────
// Shelf 3, order for 5, confirmed as نواقص. Placement deducted all 5, so the
// shelf reads 0 and the order still says it wants 5. The owner has to make
// TWO, not five — and two is what was measured when they confirmed it.
{
  const orders = [
    { id: "o1", status: "pending", stockItems: [
      { productId: "a", quantity: 5, backorder: true, shortfall: 2 },
    ] },
  ];
  const [row] = computeShortages(orders, products);
  assert.equal(row.deficit, 2, "the deficit is the measured shortfall, not quantity − stock");
  assert.equal(row.required, 5, "the full promise is still shown for context");
  assert.equal(row.stock, 0);
}

// A covered line creates no shortage at all: its units were on the shelf when
// the order was taken, so nothing has to be made.
{
  const orders = [
    { id: "o1", status: "pending", stockItems: [{ productId: "b", quantity: 5 }] },
  ];
  assert.deepEqual(computeShortages(orders, products), [], "no shortfall, no row");
}

// Restocking clears the row — that is what the subtraction is for.
{
  const orders = [
    { id: "o1", status: "pending", stockItems: [
      { productId: "a", quantity: 5, backorder: true, shortfall: 2 },
    ] },
  ];
  const restocked = [{ ...products[0], totalQuantity: 10 }, products[1], products[2]];
  assert.deepEqual(computeShortages(orders, restocked), [], "owe 2, receive 10 → covered");

  const partial = [{ ...products[0], totalQuantity: 1 }, products[1], products[2]];
  assert.equal(computeShortages(orders, partial)[0].deficit, 1, "owe 2, receive 1 → 1 left");
}

// Shortfalls aggregate across orders, and closed states contribute nothing.
{
  const orders = [
    { id: "o1", status: "pending", stockItems: [{ productId: "a", quantity: 5, shortfall: 2 }] },
    { id: "o2", status: "processing", stockItems: [{ productId: "a", quantity: 4, shortfall: 4 }] },
    { id: "o3", status: "shipped", stockItems: [{ productId: "a", quantity: 9, shortfall: 9 }] },
    { id: "o4", status: "cancelled", stockItems: [{ productId: "a", quantity: 9, shortfall: 9 }] },
    { id: "o5", status: "delivered", stockItems: [{ productId: "a", quantity: 9, shortfall: 9 }] },
    { id: "o6", status: "returned", stockItems: [{ productId: "a", quantity: 9, shortfall: 9 }] },
  ];
  const [row] = computeShortages(orders, products);
  assert.equal(row.deficit, 6, "2 + 4, and closed orders owe nothing");
  assert.equal(row.required, 9);
  assert.equal(row.orderCount, 2, "two open orders waiting");
}

// Legacy flagged lines with no measurement fall back to the conservative
// number — a line known to be short by an unknown amount.
{
  const orders = [
    { id: "o1", status: "pending", stockItems: [{ productId: "a", quantity: 5, backorder: true }] },
  ];
  assert.equal(computeShortages(orders, products)[0].deficit, 5, "unmeasured backorder");
}

// Variant stock is summed on the other side of the subtraction, `items` is the
// fallback when a legacy document has no `stockItems`, and a negative (return)
// line neither creates demand nor a shortfall.
{
  const orders = [
    { id: "o1", status: "pending", items: [{ productId: "c", quantity: 9, shortfall: 9 }] },
    { id: "o2", status: "pending", stockItems: [{ productId: "c", quantity: -4, shortfall: 4 }] },
  ];
  const [row] = computeShortages(orders, products);
  assert.equal(row.stock, 5, "2 + 3 across the variants");
  assert.equal(row.deficit, 4, "9 owed − 5 on the shelf");
  assert.equal(row.orderCount, 1, "the negative-only order waits on nothing");
}

// Worst first, and no open orders means no rows rather than a row per product.
{
  const orders = [
    { id: "o1", status: "pending", stockItems: [
      { productId: "a", quantity: 3, shortfall: 3 },
      { productId: "c", quantity: 40, shortfall: 40 },
    ] },
  ];
  assert.deepEqual(computeShortages(orders, products).map((r) => r.productId), ["c", "a"]);
}
assert.deepEqual(computeShortages([], products), []);

console.log("shortages self-check: ok");
