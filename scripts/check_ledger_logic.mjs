import test from "node:test";
import assert from "node:assert/strict";

import { buildSaleLines } from "../src/lib/ledger/sales.ts";
import { buildReturnConfirmedLines } from "../src/lib/ledger/orders.ts";

const amountOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((sum, l) => sum + (l.amount ?? 0), 0);

const qtyOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((sum, l) => sum + (l.qty ?? 0), 0);

test("Sale Event correctly generates balanced double-entry lines", () => {
  const lines = buildSaleLines({
    items: [
      { productId: "p-shoe", quantity: 2, unitPrice: 1000, unitCost: 600, isBundle: false },
    ],
    cashAmount: 2000,
    wallet: "inStoreSafe",
    discountAmount: 0,
    customerId: "cust-1",
  });

  assert.equal(lines.length, 5, "Sale should generate exactly 5 lines (stock, cogs, wallet, revenue, customer_ltv)");
  assert.equal(qtyOn(lines, "stock"), -2, "Stock goes down by 2");
  assert.equal(amountOn(lines, "cogs"), 1200, "COGS increases by 1200 (2 * 600)");
  assert.equal(amountOn(lines, "wallet"), 2000, "Wallet increases by 2000");
  assert.equal(amountOn(lines, "revenue"), 2000, "Revenue increases by 2000");
  assert.equal(amountOn(lines, "customer_ltv"), 2000, "Customer LTV increases by 2000");

  const totalCredits = amountOn(lines, "revenue");
  const totalDebits = amountOn(lines, "wallet");
  assert.equal(totalCredits, totalDebits, "Double entry balance holds (excluding statistical lines)");
});

test("Return Event generates ALL 7 required lines including cogs- and customer_ltv-", () => {
  const lines = buildReturnConfirmedLines({
    items: [
      { productId: "p-shoe", quantity: 2, unitPrice: 1000, unitCost: 600, isBundle: false },
    ],
    refundAmount: 2000,
    wallet: "inStoreSafe",
    revenueAmount: 2000,
    returnFee: 50,
    movement: "return",
    courierId: "courier-1",
    customerId: "cust-1",
  });

  assert.equal(lines.length, 7, "Return with fee should generate exactly 7 lines");
  
  // Verify each required line exists
  const accounts = lines.map(l => l.account);
  assert.ok(accounts.includes("stock"), "Missing stock line");
  assert.ok(accounts.includes("cogs"), "Missing cogs line");
  assert.ok(accounts.includes("wallet"), "Missing wallet line");
  assert.ok(accounts.includes("revenue"), "Missing revenue line");
  assert.ok(accounts.includes("payable_courier"), "Missing payable_courier line");
  assert.ok(accounts.includes("expense"), "Missing expense line");
  assert.ok(accounts.includes("customer_ltv"), "Missing customer_ltv line");

  // Verify specifics
  assert.equal(qtyOn(lines, "stock"), 2, "Stock goes up by 2 (qty returned)");
  assert.equal(amountOn(lines, "cogs"), -1200, "COGS decreases by 1200");
  assert.equal(amountOn(lines, "wallet"), -2000, "Wallet decreases by 2000 (refund)");
  assert.equal(amountOn(lines, "revenue"), -2000, "Revenue decreases by 2000");
  assert.equal(amountOn(lines, "payable_courier"), 50, "Courier payable increases by 50");
  assert.equal(amountOn(lines, "expense"), 50, "Shipping expense increases by 50");
  assert.equal(amountOn(lines, "customer_ltv"), -2000, "Customer LTV decreases by 2000");
});
