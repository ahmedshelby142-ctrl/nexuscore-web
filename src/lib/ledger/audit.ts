/**
 * Stock take (جرد) → ledger lines.
 *
 * An audit compares what the ledger says is on the shelf with what a human
 * actually counted. Where they differ, the ledger is corrected by an EVENT —
 * never by editing a quantity — so the correction has a date, an actor and a
 * value, and can be read back later as "we lost this much to shrinkage".
 *
 * Both directions are real:
 *   counted FEWER than recorded → stock −, expense +   (shrinkage, theft, damage)
 *   counted MORE  than recorded → stock +, expense −   (a receipt never entered,
 *                                                       or an earlier count was wrong)
 *
 * Pure, like the other builders, so the money rules are testable without a DB.
 */

import type { NewLine } from "./types";

export interface AuditCountItem {
  productId: string;
  /** What the ledger says is on hand — SUM of its stock lines. */
  systemQty: number;
  /** What the person counting actually found. */
  countedQty: number;
  /** Weighted-average cost per unit, EGP, from the ledger. */
  unitCost: number;
}

export interface StockAdjustmentInput {
  items: AuditCountItem[];
}

/**
 * One event for the whole stock take, with two lines per discrepancy.
 *
 * Deliberately not one event per product: a جرد is a single operation, and
 * splitting it would let half an audit land — some products corrected, others
 * not, with no way to tell which pass a number belongs to.
 *
 * Products that counted correctly write NO lines. An audit where everything
 * matched writes nothing, and the caller must not append an empty event.
 *
 * Shrinkage is valued at the ledger's weighted-average cost. The code this
 * replaces used `discrepancy * 10` — ten pounds per unit, for every product in
 * the shop, regardless of what it cost. Every shrinkage figure built on that
 * was fiction.
 */
export function buildStockAdjustmentLines(audit: StockAdjustmentInput): NewLine[] {
  const lines: NewLine[] = [];

  for (const item of audit.items) {
    if (item.countedQty < 0) {
      throw new Error(`audit: counted quantity for ${item.productId} cannot be negative`);
    }
    if (item.unitCost < 0) {
      throw new Error(`audit: unit cost for ${item.productId} cannot be negative`);
    }

    // Positive when more was found than recorded, negative when less.
    const delta = item.countedQty - item.systemQty;
    if (delta === 0) continue;

    const value = delta * item.unitCost;

    // Stock moves to match reality, carrying its value with it so the
    // weighted average of what remains stays correct.
    lines.push({
      account: "stock",
      subjectId: item.productId,
      qty: delta,
      amount: value,
    });

    // The mirror of that value. Missing stock is a cost the shop bore; found
    // stock cancels a cost it never really bore. A surplus therefore writes a
    // NEGATIVE expense rather than revenue — nothing was sold.
    if (value !== 0) {
      lines.push({ account: "expense", subjectId: "shrinkage", amount: -value });
    }
  }

  return lines;
}

/**
 * Did the auditor actually count this row?
 *
 * A blank box means "not counted yet", NEVER "counted zero". Treating the two
 * the same wrote off every product the auditor had not reached: start a جرد on
 * a category, count two items, confirm, and everything else in that category
 * was booked as shrinkage at full cost.
 *
 * It lives here, beside the builder it feeds, because it is the rule that
 * decides which rows become ledger lines — not a detail of one screen.
 */
export function isCounted(value: unknown): boolean {
  return String(value ?? "").trim() !== "";
}

export interface OpeningBalanceInput {
  productId: string;
  /** How many are physically on the shelf today. */
  quantity: number;
  /** What each one cost when it was originally bought, EGP. */
  unitCost: number;
}

/**
 * The stock a shop already owns on the day it starts using the app.
 *
 * A real shop does not begin at zero. Its owner counts the shelf and enters
 * "I have 40 of this". That is a genuine fact the user is asserting, recorded
 * as a real event — which is what separates it from the fake seeds we deleted,
 * where the SYSTEM invented inventory nobody had.
 *
 * It is NOT a توريد: no goods arrived, no supplier is owed, no cash moved. And
 * it deliberately does NOT write the `expense −` line that a جرد surplus does.
 * A surplus cancels a loss the shop had already assumed; an opening balance
 * assumes nothing — the goods were paid for out of the owner's earlier capital,
 * before the ledger existed. Booking a negative expense here would invent
 * profit out of the shop's own starting inventory.
 *
 * One line: the stock, with the value it carries. Its cost feeds the same
 * weighted average every later sale reads.
 */
export function buildOpeningBalanceLines(opening: OpeningBalanceInput): NewLine[] {
  if (opening.quantity <= 0) {
    throw new Error("opening balance: quantity must be positive");
  }
  if (opening.unitCost < 0) {
    throw new Error("opening balance: unit cost cannot be negative");
  }

  return [
    {
      account: "stock",
      subjectId: opening.productId,
      qty: opening.quantity,
      amount: opening.quantity * opening.unitCost,
    },
  ];
}

export interface WalletOpeningInput {
  /** Which till/account. Same subject id the sale lines use. */
  wallet: string;
  /** What is actually in it right now, EGP. */
  amount: number;
}

/**
 * The money a shop already has when it starts using the app.
 *
 * The wallet twin of `buildOpeningBalanceLines`, and it exists for the same
 * reason: a real shop does not open with an empty till and an empty Vodafone
 * Cash account. The owner states what is there and it is recorded as an event —
 * the user asserting a fact, never a number the code invented.
 *
 * One line. No counterpart: the money came from the owner's earlier capital,
 * before this ledger existed, so there is no expense or revenue to book against
 * it. Same shape as the till float the §1.3 scenario has always opened with.
 */
export function buildWalletOpeningLines(opening: WalletOpeningInput): NewLine[] {
  if (opening.amount === 0) {
    throw new Error("wallet opening balance: amount must not be zero");
  }
  if (!opening.wallet) {
    throw new Error("wallet opening balance: needs a wallet");
  }

  return [{ account: "wallet", subjectId: opening.wallet, amount: opening.amount }];
}

/**
 * Moving money between two of the shop's own accounts.
 *
 * Nothing is earned or spent — the total across wallets is unchanged — so the
 * two lines must be exactly equal and opposite. Writing this as a stored
 * `balance = balance ± amount` on each wallet is what let the displayed till
 * drift away from the ledger in the first place.
 */
export function buildWalletTransferLines(transfer: {
  fromWallet: string;
  toWallet: string;
  amount: number;
}): NewLine[] {
  if (transfer.amount <= 0) {
    throw new Error("wallet transfer: amount must be positive");
  }
  if (transfer.fromWallet === transfer.toWallet) {
    throw new Error("wallet transfer: from and to must be different wallets");
  }

  return [
    { account: "wallet", subjectId: transfer.fromWallet, amount: -transfer.amount },
    { account: "wallet", subjectId: transfer.toWallet, amount: transfer.amount },
  ];
}

/** How many products actually differ — what the caller shows before confirming. */
export function countDiscrepancies(items: AuditCountItem[]): number {
  return items.filter((item) => item.countedQty !== item.systemQty).length;
}

/**
 * Net value of the audit, EGP. Negative means the shop is short.
 *
 * This is the number worth putting in front of an owner: not "12 units
 * missing" but "1,400 ج.م walked out of the shop".
 */
export function auditNetValue(items: AuditCountItem[]): number {
  return items.reduce(
    (sum, item) => sum + (item.countedQty - item.systemQty) * item.unitCost,
    0,
  );
}
