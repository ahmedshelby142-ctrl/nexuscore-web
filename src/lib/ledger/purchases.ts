/**
 * Turning a supplier receipt (توريد) into ledger lines.
 *
 * This is where cost enters the system. Nothing else sets it: the sale path
 * derives its COGS from the value these lines put into stock, so a wrong cost
 * here is a wrong margin everywhere, and a *missing* cost here means the sale
 * books zero cost rather than a guess.
 *
 * Pure, like `sales.ts`, so the money rules are testable without a DB.
 */

import type { NewLine } from "./types";

export interface PurchaseLineItem {
  productId: string;
  quantity: number;
  /** What we actually paid per unit, EGP. */
  unitCost: number;
}

export interface PurchaseInput {
  items: PurchaseLineItem[];
  /** The till the cash comes out of. Required for any amount paid now. */
  wallet?: string;
  /** Received on credit — the unpaid part becomes a debt to this supplier. */
  supplierId?: string;
  /**
   * Cash handed over now, EGP. A receipt is often part-paid: some cash on the
   * spot, the rest owed. Defaults to the whole receipt when a wallet is given,
   * and to zero when it is not — so the two common cases need no extra field.
   */
  paidAmount?: number;
}

/**
 * A receipt writes: stock + (qty and value), then cash out, a debt, or both.
 *
 * Stock lines carry `amount` as well as `qty`. That is deliberate and is what
 * makes weighted-average cost derivable — see `averageCost` in `useStock`.
 */
export function buildPurchaseLines(purchase: PurchaseInput): NewLine[] {
  if (!purchase.wallet && !purchase.supplierId) {
    throw new Error("purchase: needs either a wallet to pay from or a supplier to owe");
  }

  const lines: NewLine[] = [];
  let total = 0;

  for (const item of purchase.items) {
    if (item.quantity <= 0) {
      throw new Error(`purchase: quantity for ${item.productId} must be positive`);
    }
    if (item.unitCost < 0) {
      throw new Error(`purchase: unit cost for ${item.productId} cannot be negative`);
    }

    const lineValue = item.unitCost * item.quantity;
    total += lineValue;

    lines.push({
      account: "stock",
      subjectId: item.productId,
      qty: item.quantity,
      amount: lineValue,
      unitCost: item.unitCost,
    });
  }

  const paid = purchase.paidAmount ?? (purchase.wallet ? total : 0);
  if (paid < 0) {
    throw new Error("purchase: paid amount cannot be negative");
  }
  if (paid > total) {
    throw new Error("purchase: paid amount is more than the receipt total");
  }
  const owed = total - paid;

  if (paid > 0) {
    if (!purchase.wallet) throw new Error("purchase: needs a wallet to pay from");
    // Cash leaves the till for the part paid on the spot.
    lines.push({ account: "wallet", subjectId: purchase.wallet, amount: -paid });
  }
  if (owed > 0) {
    if (!purchase.supplierId) throw new Error("purchase: needs a supplier to owe the rest to");
    // The unpaid rest is a debt to the supplier.
    lines.push({ account: "payable_supplier", subjectId: purchase.supplierId, amount: owed });
  }

  return lines;
}

export interface SupplierPaymentInput {
  supplierId: string;
  /** The till the cash leaves. */
  wallet: string;
  /** How much is being paid now, EGP. */
  amount: number;
}

/**
 * Paying a supplier down: cash out, debt down. The other direction of the
 * credit half of `buildPurchaseLines`.
 *
 * Without this, `payable_supplier` only ever grows — a receipt could put a
 * debt on the ledger but nothing could take it off, so the number on the
 * screen would drift further from reality with every payment made.
 *
 * Overpaying is allowed on purpose: it drives `payable_supplier` negative,
 * which is exactly what a credit balance with a supplier is. Refusing it here
 * would force the user to record a real payment as something it isn't.
 */
export function buildSupplierPaymentLines(payment: SupplierPaymentInput): NewLine[] {
  if (payment.amount <= 0) {
    throw new Error("supplier payment: amount must be positive");
  }

  return [
    { account: "wallet", subjectId: payment.wallet, amount: -payment.amount },
    { account: "payable_supplier", subjectId: payment.supplierId, amount: -payment.amount },
  ];
}

/** Receipt total in EGP. */
export function purchaseTotal(items: PurchaseLineItem[]): number {
  return items.reduce((sum, item) => sum + item.unitCost * item.quantity, 0);
}

/**
 * Weighted-average cost per unit, from a stock balance.
 *
 * `qty` and `amount` come straight off the aggregation view, so this is the
 * real cost of what is actually on the shelf — blending every receipt at the
 * price it was received at.
 *
 * Returns 0 for empty or negative stock rather than dividing by zero. A sale
 * against zero stock is blocked before it gets here; if one ever does, booking
 * zero cost is visibly wrong in a margin report, which is better than a
 * plausible-looking guess.
 *
 * ponytail: weighted average, not FIFO. FIFO needs per-batch layers and a
 * consumption order; WAC needs two numbers we already have. Revisit only if
 * the business actually needs batch-level costing.
 */
export function averageCost(stock: { qty: number; amount: number }): number {
  if (stock.qty <= 0) return 0;
  return stock.amount / stock.qty;
}

// ── Returning goods TO a supplier ───────────────────────────────────────────

export interface SupplierReturnInput {
  /** What is going back, at the cost it was received at. */
  items: PurchaseLineItem[];
  supplierId: string;
  /** The till any cash movement touches. Required when money actually moves. */
  wallet?: string;
  /** What WE owe this supplier right now, EGP — `payable_supplier` for them. */
  currentDebt: number;
  /**
   * Cash we hand over during the same visit to clear what is left, EGP. Only
   * meaningful while the return has not already wiped the debt out.
   */
  paidNow?: number;
}

/**
 * What a supplier return does to the account, before anything is written.
 *
 * The mirror of `reconcileWholesaleReturn`, and deliberately the same shape so
 * the screens can share one panel. The DIRECTION is what differs: a trader owes
 * us, so their return pays down `receivable_client` and a surplus leaves the
 * till. We owe a supplier, so our return pays down `payable_supplier` and a
 * surplus comes back INTO the till — they refund us.
 */
export function reconcileSupplierReturn(
  returnValue: number,
  currentDebt: number,
  paidInput: number | string = 0,
): { remainingDebt: number; cashBack: number; paidNow: number; newDebt: number } {
  const R = Number.isFinite(returnValue) && returnValue > 0 ? returnValue : 0;
  const D = Number.isFinite(currentDebt) && currentDebt > 0 ? currentDebt : 0;

  const remainingDebt = Math.max(0, D - R);
  const cashBack = Math.max(0, R - D);

  const asked = Number(paidInput) || 0;
  const paidNow = Math.min(Math.max(0, asked), remainingDebt);

  return { remainingDebt, cashBack, paidNow, newDebt: remainingDebt - paidNow };
}

/**
 * Goods going back to the supplier, reconciled against what we owe them.
 *
 * ## What this does NOT write
 *
 * No `cogs` line and no `revenue` line. A customer return reverses a SALE, so
 * it has both to undo. Goods going back to a supplier were never sold — they
 * only ever sat in inventory. Reversing COGS here would credit a cost that was
 * never booked and quietly inflate margin on every supplier return.
 *
 * ## The value that leaves
 *
 * Stock goes out at the cost it came in at, passed by the caller (the weighted
 * average on the shelf). Sending it back at anything else would move inventory
 * value that never actually moved — the same rule the customer-return path
 * follows.
 */
export function buildSupplierReturnLines(ret: SupplierReturnInput): NewLine[] {
  const lines: NewLine[] = [];

  let returnedValue = 0;
  for (const item of ret.items) {
    if (item.quantity <= 0) {
      throw new Error(`supplier return: quantity for ${item.productId} must be positive`);
    }
    if (item.unitCost < 0) {
      throw new Error(`supplier return: unit cost for ${item.productId} cannot be negative`);
    }

    const lineValue = item.unitCost * item.quantity;
    returnedValue += lineValue;

    // The units leave the shelf, carrying their value out with them.
    lines.push({
      account: "stock",
      subjectId: item.productId,
      qty: -item.quantity,
      amount: -lineValue,
      unitCost: item.unitCost,
    });
  }

  const debt = ret.currentDebt ?? 0;
  if (!Number.isFinite(debt) || debt < 0) {
    throw new Error("supplier return: current debt cannot be negative");
  }

  const paidNow = ret.paidNow ?? 0;
  if (!Number.isFinite(paidNow) || paidNow < 0) {
    throw new Error("supplier return: amount paid cannot be negative");
  }
  if (paidNow > 0 && returnedValue >= debt) {
    throw new Error(
      `supplier return: the return (${returnedValue}) already clears the debt (${debt}) — nothing to pay`,
    );
  }

  // What we owe them falls by the goods, and by whatever cash we also hand over.
  const cashBack = Math.max(0, returnedValue - debt);
  const debtReduction = Math.min(returnedValue, debt) + paidNow;
  if (debtReduction > 0) {
    lines.push({ account: "payable_supplier", subjectId: ret.supplierId, amount: -debtReduction });
  }

  // One net wallet line. Cash IN when they refund a surplus, OUT when we settle
  // the remainder — never both, because a surplus means the debt is gone.
  const walletDelta = cashBack - paidNow;
  if (walletDelta !== 0) {
    if (!ret.wallet) throw new Error("supplier return: needs a wallet when money moves");
    lines.push({ account: "wallet", subjectId: ret.wallet, amount: walletDelta });
  }

  return lines;
}
