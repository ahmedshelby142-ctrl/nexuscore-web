/**
 * مرتجع مورد — what may go back, and at what cost.
 *
 * `check_purchasing.mjs` proves the MONEY of a supplier return: what the debt
 * absorbs, which way the cash moves. This file proves the two things that were
 * actually broken — the ELIGIBILITY that has to come first, and the COST.
 *
 * ## The reported bug, as a test
 *
 * "Returning goods to a supplier calculates an inflated unit cost." The screen
 * priced each return line at `costOf(productId)`: the weighted average of
 * everything on the shelf. Buy 10 at 100 from one supplier and 10 at 200 from
 * another and the shelf averages 150 — so sending the FIRST supplier's ten back
 * credited them 1500 against an invoice of 1000. `theInflationBug` below is
 * exactly that arrangement, and it now credits 1000.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPurchaseLines,
  buildSupplierReturnLines,
  purchaseLineKey,
  remainingPurchaseLines,
  resolveSupplierReturn,
  averageCost,
} from "../src/lib/ledger/purchases.ts";

const on = (lines, account, subjectId) =>
  lines
    .filter((l) => l.account === account && (!subjectId || l.subjectId === subjectId))
    .reduce((sum, l) => sum + (l.amount ?? 0), 0);

const qtyOn = (lines, account, subjectId) =>
  lines
    .filter((l) => l.account === account && l.subjectId === subjectId)
    .reduce((sum, l) => sum + (l.qty ?? 0), 0);

/** Supplier A sold X ten times at 100. */
const INV_A = {
  id: "a",
  invoiceNumber: "FM-A",
  supplierId: "sup-a",
  totalAmount: 1000,
  items: [
    { id: "a1", productId: "X", productName: "منتج X", sku: "SKU-X", quantity: 10, unitCost: 100 },
  ],
};

/** The SAME supplier sold X again, later, at 150. */
const INV_A2 = {
  id: "a2",
  invoiceNumber: "FM-A2",
  supplierId: "sup-a",
  totalAmount: 1500,
  items: [
    { id: "a21", productId: "X", productName: "منتج X", sku: "SKU-X", quantity: 10, unitCost: 150 },
  ],
};

/** A different supplier entirely. */
const INV_B = {
  id: "b",
  invoiceNumber: "FM-B",
  supplierId: "sup-b",
  totalAmount: 2000,
  items: [
    { id: "b1", productId: "X", productName: "منتج X", quantity: 10, unitCost: 200 },
  ],
};

const ALL = [INV_A, INV_A2, INV_B];

const resolve = (requests, invoices = ALL, priorReturns = [], supplierId = "sup-a", onHand) =>
  resolveSupplierReturn({ supplierId, requests, invoices, priorReturns, onHand });

/** How the ledger records a past return: `stock −qty` against the invoice. */
const priorReturn = (invoiceNumber, productId, quantity) => ({
  refId: invoiceNumber,
  subjectId: productId,
  qty: -quantity,
});

// ── the reported bug ────────────────────────────────────────────────────────

test("THE BUG: the shelf average never reaches a supplier return", () => {
  // Buy 10 at 100 and 10 at 200. The shelf now averages 150 a unit…
  const shelf = [
    ...buildPurchaseLines({ items: [{ productId: "X", quantity: 10, unitCost: 100 }], supplierId: "sup-a", paidAmount: 0 }),
    ...buildPurchaseLines({ items: [{ productId: "X", quantity: 10, unitCost: 200 }], supplierId: "sup-b", paidAmount: 0 }),
  ];
  assert.equal(
    averageCost({ qty: qtyOn(shelf, "stock", "X"), amount: on(shelf, "stock", "X") }),
    150,
    "the weighted average really is 150 — that is what made the old code look plausible",
  );

  // …but sending supplier A's ten back credits what A actually charged.
  const resolved = resolve([{ invoiceId: "a", lineKey: "a1", quantity: 10 }]);
  assert.equal(resolved.lines[0].unitCost, 100, "the RECEIPT's cost, not the shelf's");
  assert.equal(resolved.returnValue, 1000, "never 1500");

  const back = buildSupplierReturnLines({ resolved, wallet: "safe", currentDebt: 1000 });
  assert.equal(on(back, "payable_supplier"), -1000, "exactly what we owed A");
  assert.equal(on(back, "stock"), -1000, "and exactly the value those units brought in");
  assert.equal(qtyOn(back, "stock", "X"), -10);
});

test("the same product from two receipts keeps two costs", () => {
  // §5: the two lots must not be collapsed into one average.
  assert.equal(resolve([{ invoiceId: "a", lineKey: "a1", quantity: 3 }]).returnValue, 300);
  assert.equal(resolve([{ invoiceId: "a2", lineKey: "a21", quantity: 3 }]).returnValue, 450);
});

test("a receipt line with no recorded cost values at zero, not at the shelf average", () => {
  // Refusing to guess. A silent fallback to WAC is the bug this file exists for.
  const noCost = {
    id: "nc",
    invoiceNumber: "FM-NC",
    supplierId: "sup-a",
    items: [{ id: "nc1", productId: "X", productName: "X", quantity: 5 }],
  };
  assert.equal(resolve([{ invoiceId: "nc", lineKey: "nc1", quantity: 5 }], [noCost]).returnValue, 0);
});

// ── what may be returned at all ─────────────────────────────────────────────

test("a product this supplier never supplied cannot be returned", () => {
  assert.throws(
    () => resolve([{ invoiceId: "a", lineKey: "not-a-line", quantity: 1 }]),
    /is not a line on invoice/,
  );
});

test("another supplier's invoice cannot be returned against this account", () => {
  assert.throws(
    () => resolve([{ invoiceId: "b", lineKey: "b1", quantity: 1 }]),
    /belongs to another supplier/,
  );
});

test("an invoice from another store is simply not there", () => {
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

test("more than the receipt brought in is refused", () => {
  assert.throws(
    () => resolve([{ invoiceId: "a", lineKey: "a1", quantity: 11 }]),
    /only 10 left to return/,
  );
});

test("the same line twice in one return cannot slip past the ceiling", () => {
  assert.throws(
    () =>
      resolve([
        { invoiceId: "a", lineKey: "a1", quantity: 6 },
        { invoiceId: "a", lineKey: "a1", quantity: 6 },
      ]),
    /appears twice/,
  );
});

test("one return covers one receipt", () => {
  // The ledger event carries a single ref_id, and that ref_id IS the ceiling.
  assert.throws(
    () =>
      resolve([
        { invoiceId: "a", lineKey: "a1", quantity: 1 },
        { invoiceId: "a2", lineKey: "a21", quantity: 1 },
      ]),
    /one return covers one purchase invoice/,
  );
});

test("goods that are not on the shelf cannot be sent back", () => {
  // Unlike a customer return nothing arrives — units LEAVE. Returning 10 of a
  // receipt of 10 after 8 were sold would drive stock negative.
  assert.throws(
    () => resolve([{ invoiceId: "a", lineKey: "a1", quantity: 10 }], ALL, [], "sup-a", () => 2),
    /only 2 on the shelf/,
  );
  assert.doesNotThrow(() =>
    resolve([{ invoiceId: "a", lineKey: "a1", quantity: 2 }], ALL, [], "sup-a", () => 2),
  );
});

// ── the ceiling, derived from the ledger ────────────────────────────────────

test("a partial return leaves the rest returnable", () => {
  const after = remainingPurchaseLines(INV_A, [priorReturn("FM-A", "X", 3)]);
  assert.equal(after[0].received, 10);
  assert.equal(after[0].returned, 3);
  assert.equal(after[0].remaining, 7);
  assert.equal(after[0].unitCost, 100, "the cost never moves with the ceiling");
});

test("the second return cannot exceed what the first left", () => {
  const prior = [priorReturn("FM-A", "X", 3)];
  assert.doesNotThrow(() => resolve([{ invoiceId: "a", lineKey: "a1", quantity: 7 }], ALL, prior));
  assert.throws(
    () => resolve([{ invoiceId: "a", lineKey: "a1", quantity: 8 }], ALL, prior),
    /only 7 left to return/,
  );
});

test("a fully returned line is refused, not silently allowed again", () => {
  assert.throws(
    () => resolve([{ invoiceId: "a", lineKey: "a1", quantity: 1 }], ALL, [priorReturn("FM-A", "X", 10)]),
    /only 0 left to return/,
  );
});

test("returns against ANOTHER receipt do not eat this one's ceiling", () => {
  // The same product, the same supplier, a different invoice. This is the case
  // a supplier-keyed ref_id could not tell apart — which is why the event now
  // points at the invoice.
  assert.equal(remainingPurchaseLines(INV_A, [priorReturn("FM-A2", "X", 10)])[0].remaining, 10);
});

test("a corrupt row claiming more than arrived cannot enlarge the ceiling", () => {
  assert.equal(remainingPurchaseLines(INV_A, [priorReturn("FM-A", "X", 99)])[0].remaining, 0);
});

test("two lines of one product share one returnable pool", () => {
  // The ledger only knows products, so the cap has to read the same way.
  const twoLines = {
    id: "t",
    invoiceNumber: "FM-T",
    supplierId: "sup-a",
    items: [
      { id: "t1", productId: "X", productName: "X أحمر", variantName: "أحمر", quantity: 4, unitCost: 100 },
      { id: "t2", productId: "X", productName: "X أزرق", variantName: "أزرق", quantity: 6, unitCost: 100 },
    ],
  };
  const after = remainingPurchaseLines(twoLines, [priorReturn("FM-T", "X", 5)]);
  assert.equal(after[0].returned, 4, "the first line is consumed first");
  assert.equal(after[0].remaining, 0);
  assert.equal(after[1].returned, 1, "the remainder spills to the second");
  assert.equal(after[1].remaining, 5);
  assert.equal(after[0].remaining + after[1].remaining, 5, "10 in, 5 back, 5 left");
});

// ── the document relationship ───────────────────────────────────────────────

test("every resolved line names its source receipt", () => {
  const resolved = resolve([{ invoiceId: "a2", lineKey: "a21", quantity: 2 }]);
  assert.equal(resolved.lines[0].invoiceId, "a2");
  assert.equal(resolved.lines[0].invoiceNumber, "FM-A2", "the ref_id the event will carry");
  assert.equal(resolved.lines[0].lineKey, "a21");
  assert.equal(resolved.lines[0].productId, "X");
});

test("a line with no id is still addressable", () => {
  const noId = {
    id: "n",
    invoiceNumber: "FM-N",
    supplierId: "sup-a",
    items: [{ productId: "X", productName: "X", quantity: 3, unitCost: 70 }],
  };
  const key = purchaseLineKey(noId.items[0]);
  assert.equal(key, "X");
  assert.equal(resolve([{ invoiceId: "n", lineKey: key, quantity: 3 }], [noId]).returnValue, 210);
});

test("a return with no supplier or no lines is refused before anything is read", () => {
  assert.throws(() => resolve([{ invoiceId: "a", lineKey: "a1", quantity: 1 }], ALL, [], ""), /no supplier/);
  assert.throws(() => resolve([]), /nothing selected/);
  assert.throws(
    () => buildSupplierReturnLines({ resolved: { supplierId: "sup-a", lines: [], returnValue: 0 }, currentDebt: 0 }),
    /nothing resolved/,
  );
});

// ── the whole round trip ────────────────────────────────────────────────────

test("buy at two prices, send one lot back, and the shelf stays honest", () => {
  const bought = [
    ...buildPurchaseLines({ items: [{ productId: "X", quantity: 10, unitCost: 100 }], supplierId: "sup-a", paidAmount: 0 }),
    ...buildPurchaseLines({ items: [{ productId: "X", quantity: 10, unitCost: 150 }], supplierId: "sup-a", paidAmount: 0 }),
  ];
  const back = buildSupplierReturnLines({
    resolved: resolve([{ invoiceId: "a", lineKey: "a1", quantity: 10 }]),
    wallet: "safe",
    currentDebt: 2500,
  });
  const all = [...bought, ...back];

  assert.equal(qtyOn(all, "stock", "X"), 10, "the 150 lot is what is left");
  assert.equal(on(all, "stock", "X"), 1500, "worth exactly what it cost");
  assert.equal(averageCost({ qty: 10, amount: 1500 }), 150, "no drift — the right lot left");
  assert.equal(on(all, "payable_supplier"), 1500, "2500 owed − 1000 sent back");
  assert.equal(on(all, "wallet"), 0, "nothing crossed the counter");
  assert.equal(on(all, "revenue"), 0, "goods never sold are never revenue");
  assert.equal(on(all, "cogs"), 0, "and never a cost of goods SOLD");
});
