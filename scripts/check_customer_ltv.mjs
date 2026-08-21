/**
 * Customer LTV, end to end: selected customer → `customer_ltv` line → the SUM
 * the CRM screen reads. The §1.3 scenario for the reported gap.
 *
 * The bug was NOT on the write side — `buildSaleLines` has always written the
 * line, and `pos_scenario.rs` asserts it against the real database. The CRM
 * screen read a STORED `lifetimeValue` that only the e-commerce order path
 * ever added to, so a POS sale to a named customer moved nothing on screen.
 * These tests pin the number the screen now derives.
 *
 *     node --test scripts/check_customer_ltv.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildSaleLines } from "../src/lib/ledger/sales.ts";

const CUSTOMER = "cust-mohamed";
const OTHER = "cust-other";
const WALLET = "inStoreSafe";

/** One POS sale of `total` EGP, optionally attached to a customer. */
const sale = (total, customerId) =>
  buildSaleLines({
    items: [{ productId: "p-1", quantity: 1, unitPrice: total, unitCost: 0 }],
    wallet: WALLET,
    customerId,
  });

/**
 * What `useBalances("customer_ltv").amountOf(id)` hands the CRM screen: the
 * SUM of that account's lines, keyed by subject. Same aggregation as the
 * driver — nothing here reads a stored total, because there no longer is one.
 */
function ltvOf(events, customerId) {
  return events
    .flat()
    .filter((l) => l.account === "customer_ltv" && l.subjectId === customerId)
    .reduce((sum, l) => sum + (l.amount ?? 0), 0);
}

test("a sale of 300 to a named customer reads 300", () => {
  const first = sale(300, CUSTOMER);

  const ltvLines = first.filter((l) => l.account === "customer_ltv");
  assert.equal(ltvLines.length, 1, "ONE ltv line on the ONE sale event");
  assert.equal(ltvLines[0].subjectId, CUSTOMER, "keyed to the SELECTED customer, not the channel");

  assert.equal(ltvOf([first], CUSTOMER), 300);
});

test("a second sale of 200 takes them to 500", () => {
  const events = [sale(300, CUSTOMER), sale(200, CUSTOMER)];
  assert.equal(ltvOf(events, CUSTOMER), 500, "SUM over both sales, not the latest one");
});

test("a walk-in sale moves nobody's LTV", () => {
  const walkIn = sale(999, undefined);
  assert.equal(
    walkIn.filter((l) => l.account === "customer_ltv").length,
    0,
    "no customer attached, no line — an unkeyed line would belong to nobody",
  );

  const events = [sale(300, CUSTOMER), walkIn];
  assert.equal(ltvOf(events, CUSTOMER), 300, "the walk-in did not land on the named customer");
  assert.equal(ltvOf(events, OTHER), 0);
});

test("one customer's sales never leak into another's total", () => {
  const events = [sale(300, CUSTOMER), sale(200, CUSTOMER), sale(50, OTHER)];
  assert.equal(ltvOf(events, CUSTOMER), 500);
  assert.equal(ltvOf(events, OTHER), 50);
});

test("a customer with no sales at all reads zero, not undefined", () => {
  assert.equal(ltvOf([sale(300, CUSTOMER)], "cust-never-bought"), 0);
});
