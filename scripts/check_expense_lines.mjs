/**
 * Paying an expense or a salary → ledger lines.
 *
 *     node --test scripts/check_expense_lines.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildExpenseLines } from "../src/lib/ledger/expenses.ts";

const amountOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((sum, l) => sum + (l.amount ?? 0), 0);

test("paying rent books the cost AND takes the cash out of the wallet", () => {
  const lines = buildExpenseLines({ category: "rent", amount: 8000, wallet: "inStoreSafe" });

  assert.equal(lines.length, 2, "the cost, and the money that left");
  assert.equal(amountOn(lines, "expense"), 8000);
  assert.equal(amountOn(lines, "wallet"), -8000, "the till is 8000 lighter — this was the bug");
  assert.equal(lines[0].subjectId, "rent", "booked by category, so a P&L can group it");
});

test("a salary is the same shape — the event kind is what differs", () => {
  const lines = buildExpenseLines({ category: "salaries", amount: 5000, wallet: "vodafoneCash" });
  assert.equal(amountOn(lines, "expense"), 5000);
  assert.equal(amountOn(lines, "wallet"), -5000);
  assert.equal(lines[1].subjectId, "vodafoneCash", "it left the wallet that actually paid");
});

test("net profit falls by exactly what was spent", () => {
  // revenue − cogs − expense, the formula the finance screen reads.
  const revenue = 10000;
  const cogs = 6000;
  const expenses = [
    ...buildExpenseLines({ category: "rent", amount: 800, wallet: "inStoreSafe" }),
    ...buildExpenseLines({ category: "salaries", amount: 1200, wallet: "inStoreSafe" }),
  ];
  assert.equal(revenue - cogs - amountOn(expenses, "expense"), 2000);
  assert.equal(amountOn(expenses, "wallet"), -2000, "and the till carries the same 2000 out");
});

test("nonsense is refused, not booked", () => {
  assert.throws(() => buildExpenseLines({ category: "rent", amount: 0, wallet: "inStoreSafe" }), /positive/);
  assert.throws(() => buildExpenseLines({ category: "rent", amount: -50, wallet: "inStoreSafe" }), /positive/);
  assert.throws(() => buildExpenseLines({ category: "", amount: 50, wallet: "inStoreSafe" }), /category/);
  assert.throws(() => buildExpenseLines({ category: "rent", amount: 50, wallet: "" }), /wallet/);
});
