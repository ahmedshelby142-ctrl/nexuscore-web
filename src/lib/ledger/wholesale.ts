/**
 * Turning a wholesale invoice (فاتورة جملة) into ledger lines.
 *
 * A wholesale invoice is a sale — goods leave, revenue lands — but it is
 * normally sold on credit, so the money side is a receivable rather than cash
 * in the till. That receivable is `receivable_client`, the mirror of
 * `payable_supplier` on the buying side.
 *
 * Pure, like `sales.ts` and `purchases.ts`, so the money rules are testable
 * without a DB.
 */

import type { NewLine } from "./types";

export interface WholesaleLineItem {
  productId: string;
  quantity: number;
  /** Wholesale price per unit, EGP. */
  unitPrice: number;
  /** Cost per unit, EGP, derived from the ledger at invoice time. */
  unitCost: number;
  /** The specific shade/color picked if this product has variants. */
  variantName?: string;
}

export interface WholesaleInvoiceInput {
  items: WholesaleLineItem[];
  clientId: string;
  /** The till any up-front payment lands in. Required if `paidAmount` > 0. */
  wallet?: string;
  /** Paid up front, EGP. Defaults to zero — wholesale is credit by default. */
  paidAmount?: number;
  /** What the client is charged for delivery, EGP. Part of what they owe. */
  shippingCharge?: number;
  /** What the delivery actually costs us, EGP. Booked as an expense. */
  shippingCost?: number;
  /** Skip deducting stock (e.g., if already reserved by an electronic order_placed event). */
  skipStockDeduction?: boolean;
}

/**
 * The lines a wholesale invoice writes.
 *
 * Same shape as a POS sale — stock out at cost, COGS, revenue — except the
 * unpaid part becomes `receivable_client` instead of landing in a till, and
 * shipping is folded in here rather than accumulated in a separate store. A
 * shipping total kept outside this event is half the invoice living somewhere
 * the ledger cannot see.
 *
 * No `customer_ltv` line: wholesale clients are a separate directory from the
 * retail customer base (brief §3.13), and mixing them would inflate retail LTV
 * with trade orders.
 */
export function buildWholesaleInvoiceLines(invoice: WholesaleInvoiceInput): NewLine[] {
  const lines: NewLine[] = [];
  let goodsRevenue = 0;
  let cogs = 0;

  for (const item of invoice.items) {
    if (item.quantity <= 0) {
      throw new Error(`wholesale: quantity for ${item.productId} must be positive`);
    }
    if (item.unitPrice < 0) {
      throw new Error(`wholesale: price for ${item.productId} cannot be negative`);
    }

    const lineRevenue = item.unitPrice * item.quantity;
    const lineCost = item.unitCost * item.quantity;
    goodsRevenue += lineRevenue;
    cogs += lineCost;

    // Stock leaves carrying its value, exactly as in a POS sale — this is what
    // keeps weighted-average cost right for whatever stays on the shelf.
    if (!invoice.skipStockDeduction) {
      lines.push({
        account: "stock",
        subjectId: item.productId,
        qty: -item.quantity,
        amount: -lineCost,
      });
    }

    if (lineCost !== 0) {
      lines.push({
        account: "cogs",
        subjectId: item.productId,
        amount: lineCost,
        unitCost: item.unitCost,
      });
    }
  }

  const shippingCharge = invoice.shippingCharge ?? 0;
  const shippingCost = invoice.shippingCost ?? 0;
  // What the client owes is the goods plus whatever we charged for delivery.
  const total = goodsRevenue + shippingCharge;

  const paid = invoice.paidAmount ?? 0;
  if (paid < 0) {
    throw new Error("wholesale: paid amount cannot be negative");
  }
  if (paid > total) {
    throw new Error("wholesale: paid amount is more than the invoice total");
  }
  const owed = total - paid;

  if (paid > 0) {
    if (!invoice.wallet) throw new Error("wholesale: needs a wallet for the amount paid up front");
    lines.push({ account: "wallet", subjectId: invoice.wallet, amount: paid });
  }
  if (owed > 0) {
    // The client owes us. This is the line that made a new account necessary:
    // `payable_supplier` is what WE owe, and a receivable is not a negative
    // payable — they are different people and different screens.
    lines.push({ account: "receivable_client", subjectId: invoice.clientId, amount: owed });
  }

  lines.push({ account: "revenue", subjectId: "wholesale", amount: total });

  if (shippingCost > 0) {
    lines.push({ account: "expense", subjectId: "shipping", amount: shippingCost });
  }

  return lines;
}

export interface ClientPaymentInput {
  clientId: string;
  /** The till the cash lands in. */
  wallet: string;
  amount: number;
}

/**
 * A client settling up: cash in, receivable down. The other direction of the
 * credit half of `buildWholesaleInvoiceLines`.
 *
 * Overpaying is allowed and drives `receivable_client` negative — that is a
 * credit the client holds with us, which is a real situation.
 */
export function buildClientPaymentLines(payment: ClientPaymentInput): NewLine[] {
  if (payment.amount <= 0) {
    throw new Error("client payment: amount must be positive");
  }

  return [
    { account: "wallet", subjectId: payment.wallet, amount: payment.amount },
    { account: "receivable_client", subjectId: payment.clientId, amount: -payment.amount },
  ];
}

/** Invoice total in EGP — goods plus delivery. The number the client sees. */
export function wholesaleTotal(items: WholesaleLineItem[], shippingCharge = 0): number {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0) + shippingCharge;
}
