import test from "node:test";
import assert from "node:assert/strict";
import { exchangeUnits, exchangeRefund } from "../src/lib/partialExchange.ts";
import { expandPendingOrderItems } from "../src/lib/pendingOrderItems.ts";
import { buildableFromRecipe } from "../src/lib/product.ts";
const order = {
  id: "o",
  totalAmount: 0.02,
  items: [{ id: "line", productId: "p", quantity: 3, unitPrice: 0.01 }],
  stockItems: [{ productId: "p", quantity: 3, unitPrice: 0.01, unitCost: 2 }],
};
test("FEATURE-RULE-01: reservation allocation, cancellation and confirmed-but-cancelled replacement preserve original unit identities and pennies", () => {
  const replacement = {
    status: "pending",
    exchangeDetails: {
      originalOrderId: "o",
      status: "pending",
      selections: [{ lineId: "line", quantity: 1, unitNumbers: [2] }],
    },
  };
  assert.equal(exchangeUnits(order, [], [replacement])[0].remaining, 2);
  assert.equal(exchangeRefund(order, [{ lineId: "line", quantity: 2 }], [], [replacement]), 0.02);
  replacement.status = "cancelled";
  replacement.exchangeDetails.status = "confirmed";
  assert.equal(exchangeUnits(order, [], [replacement])[0].remaining, 2);
  replacement.exchangeDetails.status = "cancelled";
  assert.equal(exchangeUnits(order, [], [replacement])[0].remaining, 3);
});
test("FEATURE-RULE-02: retained pending bundle recipe is independent of changed catalogue; newly added bundle snapshots current components", () => {
  const before = {
    items: [{ id: "sold", productId: "", bundleId: "box", quantity: 2, unitPrice: 80 }],
    stockItems: [
      { id: "stock", productId: "a", quantity: 4, unitPrice: 0, unitCost: 10, bundleId: "box" },
    ],
  };
  const products = [
    { id: "box", isBundle: true, bundleItems: [{ productId: "b", quantity: 3 }] },
    { id: "new", isBundle: true, bundleItems: [{ productId: "b", quantity: 1 }] },
  ];
  const result = expandPendingOrderItems(
    [
      { ...before.items[0], productId: "box", quantity: 3 },
      { id: "new-line", productId: "new", bundleId: "new", quantity: 2, unitPrice: 30 },
    ],
    before,
    products,
    () => 20,
  );
  assert.deepEqual(
    result.map((r) => [r.productId, r.quantity, r.unitCost]),
    [
      ["a", 6, 10],
      ["b", 2, 20],
    ],
  );
});
test("FEATURE-RULE-03: variants share the product total; invalid and duplicate recipe rows cannot overstate availability", () => {
  const stock = (id, variant) => (variant ? 3 : 4);
  assert.equal(
    buildableFromRecipe(
      [
        { productId: "p", quantity: 2, variantName: "red" },
        { productId: "p", quantity: 2, variantName: "blue" },
      ],
      stock,
    ),
    1,
  );
  assert.equal(
    buildableFromRecipe(
      [
        { productId: "p", quantity: 2 },
        { productId: "p", quantity: 2 },
      ],
      () => 6,
    ),
    1,
  );
  assert.equal(
    buildableFromRecipe([{ productId: "p", quantity: 0 }], () => 6),
    0,
  );
});
