/**
 * The ledger refuses non-finite numbers.
 *
 *     node --test scripts/check_ledger_guard.mjs
 *
 * This is the guard that stops the bug hand-testing found on the online order
 * form: a product price read from a field no writer ever wrote produced
 * `unitPrice: undefined`, `quantity * undefined` produced `NaN`, and nothing
 * between the input box and the database looked at it.
 *
 * It matters more than a normal validation because the ledger is APPEND-ONLY.
 * An event is never updated or deleted, so a `NaN` amount is not a row you go
 * back and fix — it is permanent, and every `SUM()` over that account returns
 * `NaN` forever afterwards. Stock, wallet, debts and profit all read `NaN` on
 * every screen from that moment on. The only remedy is a reversal event, by
 * hand, by someone who noticed.
 *
 * So the assertion here is not "the form shows a nice message". It is "a bad
 * number cannot reach the database, from any screen, ever".
 */

import test from "node:test";
import assert from "node:assert/strict";

import { assertFiniteLines, toPiastres } from "../src/lib/ledger/money.ts";
import { buildOrderPlacedLines } from "../src/lib/ledger/orders.ts";

// ── The exact production shape of the reported bug ──────────────────────────

test("an order line built from a missing product price is REFUSED", () => {
  // Precisely what the screen did: the price came back `undefined` because
  // `retail_price` was a field nothing ever wrote.
  const missingPrice = undefined;
  const lines = buildOrderPlacedLines({
    items: [
      {
        productId: "p-shirt",
        quantity: 2,
        unitPrice: missingPrice,
        unitCost: missingPrice,
      },
    ],
  });

  // The builder itself produced a poisoned line — it does arithmetic, and
  // `2 * undefined` is NaN. This is what used to reach the database.
  assert.ok(Number.isNaN(lines[0].amount), "precondition: the line really is poisoned");

  assert.throws(
    () => assertFiniteLines("order_placed", lines),
    /non-finite amount/,
    "the guard must reject it",
  );
});

test("the guard names where the bad number is, so it can be fixed", () => {
  try {
    assertFiniteLines("order_placed", [
      { account: "stock", subjectId: "p-shoe", qty: -1, amount: 100 },
      { account: "stock", subjectId: "p-bag", qty: -1, amount: NaN },
    ]);
    assert.fail("should have thrown");
  } catch (err) {
    assert.match(err.message, /line 1/, "points at the offending line");
    assert.match(err.message, /p-bag/, "and the offending subject");
    assert.match(err.message, /order_placed/, "and the event kind");
  }
});

// ── Every numeric field, and every flavour of non-finite ────────────────────

test("qty, amount and unitCost are all checked", () => {
  for (const field of ["qty", "amount", "unitCost"]) {
    assert.throws(
      () => assertFiniteLines("sale", [{ account: "stock", subjectId: "p", [field]: NaN }]),
      new RegExp(`non-finite ${field}`),
      `${field} must be guarded`,
    );
  }
});

test("Infinity is refused too — a division by zero is no better than a NaN", () => {
  assert.throws(
    () => assertFiniteLines("sale", [{ account: "wallet", subjectId: "cash", amount: Infinity }]),
    /non-finite amount/,
  );
  assert.throws(
    () => assertFiniteLines("sale", [{ account: "wallet", subjectId: "cash", amount: -Infinity }]),
    /non-finite amount/,
  );
});

test("why `> 0` checks did not catch this: NaN survives every comparison", () => {
  // The line builders guard with `quantity <= 0`. This is why that was not
  // enough, and why the check has to be `Number.isFinite`.
  assert.equal(NaN <= 0, false, "NaN is not <= 0 ...");
  assert.equal(NaN > 0, false, "... and not > 0 either — it slips through both");
  assert.equal(Number.isFinite(NaN), false, "only this catches it");
});

test("NaN would have been written silently — the conversion does not stop it", () => {
  // Proof the guard is load-bearing: without it, the money boundary itself
  // passes NaN straight through to the wire shape the database receives.
  assert.ok(Number.isNaN(toPiastres(NaN)), "toPiastres(NaN) is NaN, not an error");
});

// ── Good orders still go through ────────────────────────────────────────────

test("a sound order is untouched by the guard", () => {
  const lines = buildOrderPlacedLines({
    items: [
      { productId: "p-shirt", quantity: 2, unitPrice: 250, unitCost: 120 },
      { productId: "p-bag", quantity: 1, unitPrice: 400, unitCost: 210 },
    ],
  });

  assert.doesNotThrow(() => assertFiniteLines("order_placed", lines));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].qty, -2, "stock still leaves");
  assert.equal(lines[0].amount, -240, "carrying its value with it");
});

test("zero is a real number and stays allowed", () => {
  // A free item, or a line whose cost is genuinely zero, must not be blocked.
  assert.doesNotThrow(() =>
    assertFiniteLines("order_placed", [
      { account: "stock", subjectId: "p-gift", qty: -1, amount: 0, unitCost: 0 },
    ]),
  );
});

test("an omitted optional field is not a bad field", () => {
  // `unitCost` is optional on a line; absent must stay legal, or every
  // stock-only event starts throwing.
  assert.doesNotThrow(() =>
    assertFiniteLines("order_placed", [{ account: "stock", subjectId: "p", qty: -1, amount: -10 }]),
  );
});
