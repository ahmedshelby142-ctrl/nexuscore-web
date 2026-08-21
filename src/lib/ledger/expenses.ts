/**
 * Money going out that is not stock: rent, salaries, transport, marketing.
 *
 * ## Why this exists
 *
 * Recording an expense or a salary used to write a DOCUMENT in the financial
 * store and nothing else. No ledger event, so no wallet moved: the owner paid
 * 8,000 rent from the till, the expense appeared in a list, and the till's
 * balance — `SUM(wallet)` — did not budge. Every screen that shows cash was
 * telling her she still had the rent money.
 *
 * An expense is exactly two lines: the cost, and the cash that left to pay it.
 * The same builder serves `expense` and `payroll` events; only the event kind
 * differs, because a salary IS an operating expense with a name attached.
 */

import type { NewLine } from "./types";

export interface ExpenseInput {
  /** Expense category (rent, salaries…) — the subject the cost is booked to. */
  category: string;
  /** EGP. Always positive: this builder describes money going OUT. */
  amount: number;
  /** Which wallet actually paid. Manual wallets, §3.6a. */
  wallet: string;
}

export function buildExpenseLines(expense: ExpenseInput): NewLine[] {
  if (!(expense.amount > 0)) {
    throw new Error("expense: amount must be positive");
  }
  if (!expense.category) {
    throw new Error("expense: needs a category to book the cost against");
  }
  if (!expense.wallet) {
    throw new Error("expense: needs the wallet the money left");
  }

  return [
    // The cost, by category — what a P&L reads.
    { account: "expense", subjectId: expense.category, amount: expense.amount },
    // The cash that paid it. Without this line the expense is a claim about
    // money that never left, and the till stays wrong until someone counts it.
    { account: "wallet", subjectId: expense.wallet, amount: -expense.amount },
  ];
}
