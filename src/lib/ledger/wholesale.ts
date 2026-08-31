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
  /** Whether this item is a bundle/kit of other products. */
  isBundle?: boolean;
  /** The components making up this bundle, if isBundle is true. */
  bundleItems?: { productId: string; quantity: number; unitCost: number }[];
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
  /**
   * Money taken off the invoice, EGP. Already computed by `discountAmountFor`.
   *
   * POS in وضع الجملة applies a discount code and writes the DISCOUNTED figure
   * onto the invoice document — but this builder had no discount term, so the
   * ledger booked the full price. The client was told they owed the discounted
   * amount while `receivable_client` held the undiscounted one, and the gap
   * stayed on the books as a debt nobody would ever collect.
   */
  discountAmount?: number;
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
    //
    // A بوكس charges its COMPONENTS, same as `buildSaleLines`. This branch was
    // missing here, so a bundle sold through الجملة booked stock against a
    // virtual product with no shelf while the real goods walked out untracked.
    if (!invoice.skipStockDeduction) {
      if (item.isBundle && item.bundleItems?.length) {
        for (const comp of item.bundleItems) {
          lines.push({
            account: "stock",
            subjectId: comp.productId,
            qty: -(comp.quantity * item.quantity),
            amount: -(comp.unitCost * comp.quantity * item.quantity),
          });
        }
      } else {
        lines.push({
          account: "stock",
          subjectId: item.productId,
          qty: -item.quantity,
          amount: -lineCost,
        });
      }
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

  const discount = invoice.discountAmount ?? 0;
  if (discount < 0) {
    throw new Error("wholesale: discount cannot be negative");
  }
  // Same trust boundary as `buildSaleLines`: a discount larger than the goods
  // would drive revenue and the receivable negative. Refuse it.
  if (discount > goodsRevenue) {
    throw new Error(
      `wholesale: discount (${discount}) is more than the goods are worth (${goodsRevenue})`,
    );
  }

  // What the client owes is the discounted goods plus whatever we charged for
  // delivery. Shipping is NOT discounted — a promo on the merchandise does not
  // change what the courier costs.
  const total = goodsRevenue - discount + shippingCharge;

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

// ── Wholesale returns: goods back, debt down, and maybe cash either way ──────

export interface WholesaleReturnInput {
  /** What is coming back, at the price it went out at and the cost it left at. */
  items: WholesaleLineItem[];
  clientId: string;
  /** The till any cash movement touches. Required if money actually moves. */
  wallet?: string;
  /**
   * What the client owes us RIGHT NOW, EGP — `receivable_client` for them.
   *
   * Read at the moment of the return and passed in, exactly like `unitCost`:
   * this builder is pure, and the debt is a fact about the world it is told,
   * never one it looks up.
   */
  currentDebt: number;
  /**
   * Cash the client hands over during the same visit to pay down what is left,
   * EGP. Only meaningful when the return does not already clear the debt.
   */
  paidNow?: number;
}

/**
 * A wholesale return, reconciled against the client's debt in one event.
 *
 * ## Why this is not "a refund"
 *
 * A trader almost never gets cash back. They owe us money, so goods coming
 * back pay down that debt first — and only what is left over, if anything, is
 * actually handed across the counter. Refunding cash to a client who still
 * owes us would take money out of the till and leave the debt standing.
 *
 * The two directions, with R = returned value and D = the debt:
 *
 *   R < D    the debt absorbs the whole return. `receivable_client` falls by
 *            R, and by P more if the client also pays cash today. The till
 *            RECEIVES that P — it is a repayment, not a refund.
 *
 *   R >= D   the debt is cleared and the surplus is real money owed back.
 *            `receivable_client` falls by D, the till PAYS OUT R − D, and P
 *            is meaningless because nothing is left to pay down.
 *
 * `revenue`, `cogs` and `stock` reverse identically either way — what changed
 * hands is a separate question from what came back off the shelf.
 */
export function buildWholesaleReturnLines(ret: WholesaleReturnInput): NewLine[] {
  const lines: NewLine[] = [];

  let returnedValue = 0;
  for (const item of ret.items) {
    if (item.quantity <= 0) {
      throw new Error(`wholesale return: quantity for ${item.productId} must be positive`);
    }
    if (item.unitPrice < 0) {
      throw new Error(`wholesale return: price for ${item.productId} cannot be negative`);
    }

    const lineValue = item.unitPrice * item.quantity;
    const lineCost = item.unitCost * item.quantity;
    returnedValue += lineValue;

    // The goods are back, carrying their value back into inventory. A بوكس
    // comes back as its components — it has no shelf of its own.
    if (item.isBundle && item.bundleItems?.length) {
      for (const comp of item.bundleItems) {
        lines.push({
          account: "stock",
          subjectId: comp.productId,
          qty: comp.quantity * item.quantity,
          amount: comp.unitCost * comp.quantity * item.quantity,
        });
      }
    } else {
      lines.push({
        account: "stock",
        subjectId: item.productId,
        qty: item.quantity,
        amount: lineCost,
      });
    }

    // And their cost stops being a cost of goods sold.
    if (lineCost !== 0) {
      lines.push({
        account: "cogs",
        subjectId: item.productId,
        amount: -lineCost,
        unitCost: item.unitCost,
      });
    }
  }

  const debt = ret.currentDebt ?? 0;
  if (!Number.isFinite(debt) || debt < 0) {
    throw new Error("wholesale return: current debt cannot be negative");
  }

  const paidNow = ret.paidNow ?? 0;
  if (!Number.isFinite(paidNow) || paidNow < 0) {
    throw new Error("wholesale return: amount paid cannot be negative");
  }
  // Nothing left to pay down means nothing to pay. Taking the cash anyway
  // would push the client into credit through a door meant for repayment.
  if (paidNow > 0 && returnedValue >= debt) {
    throw new Error(
      `wholesale return: the return (${returnedValue}) already clears the debt (${debt}) — nothing to pay`,
    );
  }

  // The sale reverses whatever happens to the money.
  lines.push({ account: "revenue", subjectId: "wholesale", amount: -returnedValue });

  // The debt absorbs the return first; cash only covers the surplus.
  const cashRefund = Math.max(0, returnedValue - debt);
  const debtReduction = Math.min(returnedValue, debt) + paidNow;
  if (debtReduction > 0) {
    lines.push({ account: "receivable_client", subjectId: ret.clientId, amount: -debtReduction });
  }

  // One net wallet line: money in from the repayment, out for the surplus.
  // They can never both be non-zero — a surplus means the debt is already gone.
  const walletDelta = paidNow - cashRefund;
  if (walletDelta !== 0) {
    if (!ret.wallet) throw new Error("wholesale return: needs a wallet when money moves");
    lines.push({ account: "wallet", subjectId: ret.wallet, amount: walletDelta });
  }

  return lines;
}

/**
 * What a wholesale return does to the account, before anything is written.
 *
 * The screens need these numbers to draw the تسوية panel and the builder needs
 * them to write the lines. Deriving them in one place is what stops POS,
 * الطلبات and الجملة from each inventing their own idea of "المتبقي" — the same
 * drift that made an exchange book +600 for 100 of cash.
 *
 * `paidInput` is clamped rather than rejected: a cashier typing over the
 * remaining debt means "settle it all", not "put this client in credit".
 */
export function reconcileWholesaleReturn(
  returnValue: number,
  currentDebt: number,
  paidInput: number | string = 0,
): {
  /** Owed after the goods are credited, before any cash. */
  remainingDebt: number;
  /** Handed back across the counter, when the return outruns the debt. */
  cashBack: number;
  /** The clamped repayment actually applied. */
  paidNow: number;
  /** What the client owes once this is done. */
  newDebt: number;
} {
  const R = Number.isFinite(returnValue) && returnValue > 0 ? returnValue : 0;
  const D = Number.isFinite(currentDebt) && currentDebt > 0 ? currentDebt : 0;

  const remainingDebt = Math.max(0, D - R);
  const cashBack = Math.max(0, R - D);

  const asked = Number(paidInput) || 0;
  const paidNow = Math.min(Math.max(0, asked), remainingDebt);

  return { remainingDebt, cashBack, paidNow, newDebt: remainingDebt - paidNow };
}
