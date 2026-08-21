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
