/**
 * Turning a POS cart into ledger lines.
 *
 * Kept as a pure function, separate from the React component, so the money
 * rules can be tested without a DOM, a store, or a database. `CheckoutForm`
 * calls this and hands the result straight to `appendEvent`.
 *
 * Deliberately does not import the app's `Product` type — it takes the four
 * fields it actually needs. That keeps the test free of the store's shape and
 * makes it obvious what a sale depends on.
 */

import type { NewLine } from "./types";

export interface SaleCartItem {
  productId: string;
  quantity: number;
  /** Selling price per unit, EGP. */
  unitPrice: number;
  /** Cost price per unit, EGP, as it stands at the moment of the sale. */
  unitCost: number;
  /** Whether this item is a bundle/kit of other products. */
  isBundle?: boolean;
  /** The components making up this bundle, if isBundle is true. */
  bundleItems?: { productId: string; quantity: number; unitCost: number }[];
  /** The specific shade/color picked if this product has variants. */
  variantName?: string;
}

export interface SaleInput {
  items: SaleCartItem[];
  /** Which till the cash lands in. Brief §3.3. */
  wallet: string;
  /** Omit for a walk-in customer — no LTV line is written. */
  customerId?: string;
  /** Revenue channel, for reporting. */
  channel?: string;
  discountCodeId?: string;
  discountAmount?: number;
}

/**
 * The six-ish lines a POS sale writes.
 *
 * COGS is `unitCost × quantity`, summed per product. The code this replaces
 * used `totalAmount × 0.7` as the unit cost of *every* line — which was not
 * only a made-up margin but applied the whole cart's total to each item, so a
 * two-line cart booked roughly 140% of revenue as cost. Every profit figure
 * downstream inherited that.
 */
export function buildSaleLines(sale: SaleInput): NewLine[] {
  const lines: NewLine[] = [];
  let revenue = 0;
  let cogs = 0;

  for (const item of sale.items) {
    const lineRevenue = item.unitPrice * item.quantity;
    const lineCost = item.unitCost * item.quantity;
    revenue += lineRevenue;
    cogs += lineCost;

    // Stock leaves, carrying its value out with it.
    if (item.isBundle && item.bundleItems) {
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

    // Cost of what left, per product, at its real cost price.
    if (lineCost !== 0) {
      lines.push({
        account: "cogs",
        subjectId: item.productId,
        amount: lineCost,
        unitCost: item.unitCost,
      });
    }
  }

  const discount = sale.discountAmount ?? 0;
  if (discount < 0) {
    throw new Error("sale: discount cannot be negative");
  }
  // A discount bigger than the goods would push `wallet` and `revenue`
  // NEGATIVE — cash leaving the drawer for a sale where the cashier collected
  // nothing. `discountAmountFor` caps it, but this is the trust boundary: the
  // ledger is append-only, so it refuses the event rather than booking it.
  if (discount > revenue) {
    throw new Error(
      `sale: discount (${discount}) is more than the sale is worth (${revenue})`,
    );
  }
  
  // The net amount actually received (or refunded, if negative).
  const netRevenue = revenue - discount;

  // Cash into the chosen till.
  lines.push({ account: "wallet", subjectId: sale.wallet, amount: netRevenue });

  // Revenue, by channel.
  lines.push({ account: "revenue", subjectId: sale.channel ?? "pos", amount: netRevenue });

  // LTV, only when the sale is attached to a known customer.
  if (sale.customerId) {
    lines.push({ account: "customer_ltv", subjectId: sale.customerId, amount: netRevenue });
  }

  return lines;
}

/** Cart total in EGP. The number the cashier sees must be this one. */
export function saleTotal(items: SaleCartItem[]): number {
  return items.reduce((total, item) => total + item.unitPrice * item.quantity, 0);
}
