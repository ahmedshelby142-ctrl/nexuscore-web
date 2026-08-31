/**
 * POS sale → ledger lines check.
 *
 * Uses Node's built-in test runner and native TypeScript stripping, so it adds
 * no dependency and no config. Run:
 *
 *     node --test scripts/check_sale_lines.mjs
 *
 * Lives outside src/ so tsc doesn't typecheck it, matching
 * scripts/check_ledger_schema.py.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildSaleLines, saleTotal } from "../src/lib/ledger/sales.ts";

/** Sum the amounts of every line hitting one account. */
const amountOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((sum, l) => sum + (l.amount ?? 0), 0);

/** Sum the quantities of every line hitting one account. */
const qtyOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((sum, l) => sum + (l.qty ?? 0), 0);

// Two products, deliberately different margins, so a per-unit COGS bug shows.
const CART = [
  { productId: "p-shoe", quantity: 2, unitPrice: 1000, unitCost: 600 },
  { productId: "p-shirt", quantity: 3, unitPrice: 200, unitCost: 50 },
];
// revenue = 2*1000 + 3*200 = 2600
// cogs    = 2*600  + 3*50  = 1350

test("a sale books revenue, cash and stock consistently", () => {
  const lines = buildSaleLines({ items: CART, wallet: "inStoreSafe" });

  assert.equal(saleTotal(CART), 2600);
  assert.equal(amountOn(lines, "revenue"), 2600);
  assert.equal(amountOn(lines, "wallet"), 2600, "cash in must equal revenue booked");
  assert.equal(qtyOn(lines, "stock"), -5, "5 units left the shelf");

  // Stock moves per product, not as one lump.
  const stockLines = lines.filter((l) => l.account === "stock");
  assert.equal(stockLines.length, 2);
  assert.equal(stockLines.find((l) => l.subjectId === "p-shoe").qty, -2);
  assert.equal(stockLines.find((l) => l.subjectId === "p-shirt").qty, -3);
});

test("COGS is real cost per unit, not a percentage of the cart", () => {
  const lines = buildSaleLines({ items: CART, wallet: "inStoreSafe" });

  assert.equal(amountOn(lines, "cogs"), 1350);

  // The rule this replaces was `unitCost = totalAmount * 0.7`, applied to every
  // line — 2600*0.7 = 1820 per item, so a two-line cart booked 3640 of cost
  // against 2600 of revenue. Guard the specific wrong answers.
  assert.notEqual(amountOn(lines, "cogs"), 2600 * 0.7);
  assert.notEqual(amountOn(lines, "cogs"), 2600 * 0.7 * 2);

  // Margin is positive and equals the real figure.
  assert.equal(amountOn(lines, "revenue") - amountOn(lines, "cogs"), 1250);

  // Cost is attributed per product, carrying its own unit cost.
  const shoe = lines.find((l) => l.account === "cogs" && l.subjectId === "p-shoe");
  assert.equal(shoe.amount, 1200);
  assert.equal(shoe.unitCost, 600);
});

test("LTV is written only when the sale has a customer", () => {
  const walkIn = buildSaleLines({ items: CART, wallet: "inStoreSafe" });
  assert.equal(
    walkIn.filter((l) => l.account === "customer_ltv").length,
    0,
    "a walk-in sale must not invent a customer",
  );

  const named = buildSaleLines({ items: CART, wallet: "inStoreSafe", customerId: "cust-9" });
  assert.equal(amountOn(named, "customer_ltv"), 2600, "LTV must move by what they actually paid");
  assert.equal(named.filter((l) => l.account === "customer_ltv")[0].subjectId, "cust-9");
});

test("cash lands in the till the cashier chose", () => {
  const lines = buildSaleLines({ items: CART, wallet: "mainVault" });
  const wallet = lines.filter((l) => l.account === "wallet");
  assert.equal(wallet.length, 1);
  assert.equal(wallet[0].subjectId, "mainVault");
  assert.equal(wallet[0].amount, 2600);
});

test("a zero-cost product still sells, and books no COGS line", () => {
  // Cost price genuinely unknown / zero — must not silently book a fake cost.
  const lines = buildSaleLines({
    items: [{ productId: "p-gift", quantity: 1, unitPrice: 100, unitCost: 0 }],
    wallet: "inStoreSafe",
  });
  assert.equal(amountOn(lines, "revenue"), 100);
  assert.equal(amountOn(lines, "cogs"), 0);
  assert.equal(lines.filter((l) => l.account === "cogs").length, 0);
  assert.equal(qtyOn(lines, "stock"), -1);
});
