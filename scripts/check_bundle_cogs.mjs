/**
 * البوكسات — what a box COSTS, and where that cost lands.
 *
 *     node --test scripts/check_bundle_cogs.mjs
 *
 * The companion to `check_bundle_stock`, which covers the other half: that a
 * box moves its components rather than itself. This file covers the half that
 * was broken everywhere.
 *
 * ## The bug
 *
 * Four builders each carried their own copy of the bundle expansion, and every
 * copy expanded the STOCK lines and not the COGS line:
 *
 *     if (item.isBundle) { for each component → stock − at component cost }
 *     else               { stock − at item cost }
 *     if (lineCost !== 0) { cogs += item.unitCost × item.quantity }   ← blind
 *
 * A بوكس is virtual — no purchases, no stock of its own — so `costOf(bundleId)`
 * is 0, which is exactly what the screens pass as `unitCost`. `lineCost` was
 * therefore 0, the `!== 0` guard skipped the COGS line altogether, and a box
 * sale booked FULL REVENUE AGAINST ZERO COST while 250 of inventory value left
 * the `stock` account with nothing on the other side.
 *
 * `lib/ledger/bundles.ts` is now the single authority all four share.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { lineCostOf, stockLinesFor, cogsLinesFor, bundleRecipeOf } from "../src/lib/ledger/bundles.ts";
import { buildSaleLines } from "../src/lib/ledger/sales.ts";
import {
  buildOrderPlacedLines,
  buildOrderDeliveredLines,
  buildOrderCancelledLines,
  buildReturnConfirmedLines,
} from "../src/lib/ledger/orders.ts";
import {
  buildWholesaleInvoiceLines,
  buildWholesaleReturnLines,
  resolveWholesaleReturn,
} from "../src/lib/ledger/wholesale.ts";

const on = (l, a) => l.filter((x) => x.account === a).reduce((s, x) => s + (x.amount ?? 0), 0);
const onSubject = (l, a, id) =>
  l.filter((x) => x.account === a && x.subjectId === id).reduce((s, x) => s + (x.amount ?? 0), 0);
const qtyOn = (l, a, id) =>
  l.filter((x) => x.account === a && x.subjectId === id).reduce((s, x) => s + (x.qty ?? 0), 0);

/**
 * A بوكس as the screens really build it: `unitCost: 0`, because `costOf` of a
 * virtual product with no ledger lines is zero. Components worth 2×100 + 1×50.
 */
const box = (quantity = 1, unitPrice = 500) => ({
  productId: "BOX",
  quantity,
  unitPrice,
  unitCost: 0,
  isBundle: true,
  bundleItems: [
    { productId: "X", quantity: 2, unitCost: 100 },
    { productId: "Y", quantity: 1, unitCost: 50 },
  ],
});

const COST_PER_BOX = 250;

// ── the cost itself ─────────────────────────────────────────────────────────

test("a box costs its components, not its own (zero) unit cost", () => {
  assert.equal(lineCostOf(box(1)), COST_PER_BOX);
  assert.equal(
    lineCostOf({ productId: "P", quantity: 3, unitCost: 20 }),
    60,
    "a plain product is unchanged",
  );
});

test("cost scales linearly with the number of boxes — no drift, no fixed quantity", () => {
  for (const n of [1, 2, 5, 10, 37]) {
    assert.equal(lineCostOf(box(n)), COST_PER_BOX * n, `${n} boxes`);
  }
});

test("an isBundle with an empty recipe is not a bundle", () => {
  // A box nobody filled in must not move nothing and cost nothing while still
  // being sold. It falls back to the plain-product path.
  assert.equal(bundleRecipeOf({ productId: "B", quantity: 1, unitCost: 7, isBundle: true }), null);
  assert.equal(
    bundleRecipeOf({ productId: "B", quantity: 1, unitCost: 7, isBundle: true, bundleItems: [] }),
    null,
  );
  assert.equal(lineCostOf({ productId: "B", quantity: 2, unitCost: 7, isBundle: true }), 14);
});

// ── where the lines land ────────────────────────────────────────────────────

test("stock leaves as components; the box itself never moves", () => {
  const l = stockLinesFor(box(3), -1);
  assert.equal(qtyOn(l, "stock", "X"), -6);
  assert.equal(qtyOn(l, "stock", "Y"), -3);
  assert.equal(l.filter((x) => x.subjectId === "BOX").length, 0, "a box has no shelf");
  assert.equal(on(l, "stock"), -COST_PER_BOX * 3, "value leaves with the quantity");
});

test("COGS is attributed to the components, matching the stock lines", () => {
  const l = cogsLinesFor(box(1), 1);
  assert.equal(onSubject(l, "cogs", "X"), 200);
  assert.equal(onSubject(l, "cogs", "Y"), 50);
  assert.equal(
    l.filter((x) => x.subjectId === "BOX").length,
    0,
    "COGS against a box would be an orphan subject — it has no stock lines",
  );
});

test("a zero-cost component writes no line, but does not suppress the others", () => {
  const l = cogsLinesFor(
    {
      productId: "BOX",
      quantity: 1,
      unitCost: 0,
      isBundle: true,
      bundleItems: [
        { productId: "X", quantity: 1, unitCost: 0 },
        { productId: "Y", quantity: 1, unitCost: 50 },
      ],
    },
    1,
  );
  assert.equal(l.length, 1);
  assert.equal(onSubject(l, "cogs", "Y"), 50);
});

// ── every builder that sells or takes back a box ────────────────────────────

test("POS: a box sale books component COGS, so profit is real", () => {
  const l = buildSaleLines({ items: [box(1, 500)], wallet: "safe", channel: "pos" });
  assert.equal(on(l, "revenue"), 500);
  assert.equal(on(l, "cogs"), COST_PER_BOX, "was 0 — full revenue against no cost");
  assert.equal(on(l, "revenue") - on(l, "cogs"), 250, "gross profit");
  assert.equal(qtyOn(l, "stock", "X"), -2);
  assert.equal(qtyOn(l, "stock", "Y"), -1);
});

test("POS: inventory value out equals cost of goods in — nothing vanishes", () => {
  const l = buildSaleLines({ items: [box(4)], wallet: "safe" });
  assert.equal(
    on(l, "stock") + on(l, "cogs"),
    0,
    "value left `stock` and must land in `cogs`, or the books lose it",
  );
});

test("POS: a box RETURN reverses component COGS too", () => {
  // The till carries a return as a negative quantity through the same builder.
  const l = buildSaleLines({ items: [box(-1, 500)], wallet: "safe" });
  assert.equal(on(l, "revenue"), -500);
  assert.equal(on(l, "cogs"), -COST_PER_BOX, "cost comes back off");
  assert.equal(qtyOn(l, "stock", "X"), 2, "components return to the shelf");
  assert.equal(qtyOn(l, "stock", "Y"), 1);
});

test("wholesale: a box invoice books component COGS", () => {
  const l = buildWholesaleInvoiceLines({
    items: [box(2, 400)],
    clientId: "c1",
  });
  assert.equal(on(l, "cogs"), COST_PER_BOX * 2);
  assert.equal(qtyOn(l, "stock", "X"), -4);
});

test("wholesale: a box return reverses component COGS", () => {
  // Resolved against the invoice that sold it — a return has no other source.
  // The invoice line carries the recipe, so the components come back even
  // though the box has no shelf of its own.
  const l = buildWholesaleReturnLines({
    resolved: resolveWholesaleReturn({
      clientId: "c1",
      requests: [{ invoiceId: "FJ-BOX", lineKey: "bl1", quantity: 1 }],
      invoices: [
        {
          id: "FJ-BOX",
          invoiceNumber: "FJ-BOX",
          clientId: "c1",
          items: [{ id: "bl1", ...box(2, 400), wholesalePrice: 400 }],
        },
      ],
      costOf: () => 0,
    }),
    currentDebt: 1000,
  });
  assert.equal(on(l, "cogs"), -COST_PER_BOX);
  assert.equal(qtyOn(l, "stock", "X"), 2);
});

test("e-commerce: placing and cancelling a box are exact opposites", () => {
  const placed = buildOrderPlacedLines({ items: [box(2)] });
  const cancelled = buildOrderCancelledLines({ items: [box(2)] });
  for (const id of ["X", "Y"]) {
    assert.equal(qtyOn(placed, "stock", id) + qtyOn(cancelled, "stock", id), 0);
  }
  assert.equal(on(placed, "stock") + on(cancelled, "stock"), 0);
  assert.equal(on(placed, "cogs"), 0, "placing reserves; it does not sell");
});

test("e-commerce: delivering a box books component COGS", () => {
  const l = buildOrderDeliveredLines({
    items: [box(1, 500)],
    goodsTotal: 500,
    codAmount: 500,
    courierId: "cr1",
  });
  assert.equal(on(l, "cogs"), COST_PER_BOX);
  assert.equal(on(l, "revenue"), 500);
});

test("e-commerce: confirming a box return reverses component COGS", () => {
  const l = buildReturnConfirmedLines({
    items: [box(1, 500)],
    refundAmount: 500,
    wallet: "safe",
    revenueAmount: 500,
  });
  assert.equal(on(l, "cogs"), -COST_PER_BOX, "was 0 — stock came back, cost never did");
  assert.equal(qtyOn(l, "stock", "X"), 2);
  assert.equal(qtyOn(l, "stock", "Y"), 1);
});

// ── a full box sale, end to end ─────────────────────────────────────────────

test("the whole e-commerce lifecycle of a box nets to the right profit", () => {
  const all = [
    ...buildOrderPlacedLines({ items: [box(1, 500)] }),
    ...buildOrderDeliveredLines({
      items: [box(1, 500)],
      goodsTotal: 500,
      codAmount: 500,
      courierId: "cr1",
    }),
  ];
  assert.equal(on(all, "revenue"), 500);
  assert.equal(on(all, "cogs"), COST_PER_BOX);
  assert.equal(on(all, "revenue") - on(all, "cogs"), 250, "profit");
  // Stock left once, at placement, and carried exactly the cost that became COGS.
  assert.equal(on(all, "stock"), -COST_PER_BOX);
});

test("POS and e-commerce book the same cost for the same box", () => {
  const pos = buildSaleLines({ items: [box(1, 500)], wallet: "safe" });
  const eco = [
    ...buildOrderPlacedLines({ items: [box(1, 500)] }),
    ...buildOrderDeliveredLines({
      items: [box(1, 500)],
      goodsTotal: 500,
      codAmount: 500,
      courierId: "cr1",
    }),
  ];
  assert.equal(on(pos, "cogs"), on(eco, "cogs"), "one bundle authority, two surfaces");
  assert.equal(on(pos, "revenue"), on(eco, "revenue"));
  for (const id of ["X", "Y"]) {
    assert.equal(qtyOn(pos, "stock", id), qtyOn(eco, "stock", id));
  }
});

// ── nesting is not supported, and cannot run away ───────────────────────────

test("expansion is single-level: a nested box cannot recurse", () => {
  // `BundlesPage` only offers non-bundle products as components, so this shape
  // is not reachable through the UI. If a crafted row ever carried it, the
  // expansion must still terminate — it charges the inner box's id once and
  // stops, rather than recursing forever.
  const nested = {
    productId: "OUTER",
    quantity: 1,
    unitCost: 0,
    isBundle: true,
    bundleItems: [{ productId: "INNER_BOX", quantity: 1, unitCost: 0 }],
  };
  const l = stockLinesFor(nested, -1);
  assert.equal(l.length, 1, "one level, one line");
  assert.equal(l[0].subjectId, "INNER_BOX");
  assert.deepEqual(cogsLinesFor(nested, 1), [], "a zero-cost inner box books nothing");
});

test("a component quantity of zero or less is ignored rather than inverting stock", () => {
  const odd = {
    productId: "BOX",
    quantity: 1,
    unitCost: 0,
    isBundle: true,
    bundleItems: [
      { productId: "X", quantity: 2, unitCost: 100 },
      { productId: "BAD", quantity: 0, unitCost: 100 },
    ],
  };
  // Zero contributes nothing to cost and moves no value.
  assert.equal(lineCostOf(odd), 200);
  assert.equal(qtyOn(stockLinesFor(odd, -1), "stock", "BAD"), 0);
  assert.equal(cogsLinesFor(odd, 1).filter((x) => x.subjectId === "BAD").length, 0);
});
