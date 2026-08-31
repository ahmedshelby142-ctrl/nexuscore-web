/**
 * Deleting a product: delete vs archive, and what "has history" means.
 *
 *     node --test scripts/check_product_removal.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { removalMode, isProductArchived, activeProducts } from "../src/lib/product.ts";

test("a product the ledger never mentioned can really be deleted", () => {
  assert.equal(removalMode([]), "delete");
});

test("a product with ledger lines is archived, never hard-deleted", () => {
  const soldSome = [{ account: "stock", subjectId: "p-1", qty: 12, amount: 7200 }];
  assert.equal(removalMode(soldSome), "archive");
});

test("THE TRAP: received then sold out sums to zero and still has history", () => {
  // `balances()` returns a row because lines exist; the totals are 0 because
  // everything that came in went out. Deleting this one would orphan a real
  // purchase and a real sale.
  const soldOut = [
    { account: "stock", subjectId: "p-1", qty: 0, amount: 0 },
    { account: "cogs", subjectId: "p-1", qty: 0, amount: 0 },
  ];
  assert.equal(removalMode(soldOut), "archive", "row count decides, not the sum");
});

test("archived products leave the active lists, and only they do", () => {
  const list = [
    { id: "p-1", name: "حذاء" },
    { id: "p-2", name: "كوباية", deleted_at: 1_755_000_000_000 },
    { id: "p-3", name: "شاحن", deleted_at: undefined },
  ];

  assert.equal(isProductArchived(list[0]), false);
  assert.equal(isProductArchived(list[1]), true);
  assert.equal(isProductArchived(list[2]), false, "an absent tombstone means active");

  assert.deepEqual(
    activeProducts(list).map((p) => p.id),
    ["p-1", "p-3"],
  );
  assert.equal(list.length, 3, "the archived record still exists — it is hidden, not erased");
});
