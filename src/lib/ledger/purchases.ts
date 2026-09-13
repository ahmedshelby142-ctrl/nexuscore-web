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

// ── Invoice-driven supplier returns ─────────────────────────────────────────
//
// ## The reported bug, and what actually caused it
//
// "Returning goods to a supplier calculates an inflated unit cost." The
// arithmetic was never wrong — the INPUT was. شاشة المشتريات built each return
// line from a free product search and priced it `costOf(productId)`: the
// weighted average of everything currently on the shelf.
//
// WAC is the right cost for a SALE, because a sale consumes anonymous stock.
// It is the wrong cost for a supplier return, because a return is not
// anonymous — it names the supplier, and therefore the receipt, that brought
// those specific units in. Buy 10 at 100 from محمود and 10 at 200 from someone
// else, and the shelf averages 150. Send محمود's ten back and the ledger
// credited 1500 against an invoice of 1000: `payable_supplier` fell by 500 more
// than was ever owed, and 500 of inventory value left that had never entered.
// That is the inflation, and no display patch reaches it.
//
// The fix is the same shape as the wholesale one: a return is not described,
// it is RESOLVED against the purchase invoice that brought the goods in, and
// the cost comes off that invoice line.
//
// ## Where the ceiling lives, and why it is not a document
//
// `return_records` may only be written by ADMIN / POS_ECOMMERCE /
// ECOMMERCE_ONLY, and the role that owns `/purchasing` is ACCOUNTANT. A
// returned-quantity counter kept there would silently fail for the only user
// who needs it. So the cap is derived from the LEDGER — the `stock −` lines of
// past `supplier_return` events, grouped by the invoice they point at. Those
// events are writable by exactly ADMIN and ACCOUNTANT, readable by every
// member, append-only, and allocated by Postgres. The cap is the movement
// itself rather than a number describing it, so it cannot drift and two
// concurrent returns cannot both read a stale zero.

/** One line of a purchase invoice DOCUMENT, as `purchase_invoices` stores it. */
export interface PurchaseInvoiceLine {
  /** Stable per-line id. Every receipt writes one. */
  id?: string;
  productId: string;
  productName?: string;
  sku?: string;
  variantName?: string;
  quantity: number;
  /** What we actually paid per unit ON THIS RECEIPT. The authoritative cost. */
  unitCost?: number;
  total?: number;
}

/** A purchase invoice document. */
export interface PurchaseInvoiceDoc {
  id: string;
  invoiceNumber?: string;
  supplierId: string;
  supplierName?: string;
  items?: PurchaseInvoiceLine[];
  totalAmount?: number;
  paidAmount?: number;
  remainingAmount?: number;
  status?: string;
  createdAt?: unknown;
}

/**
 * How much has already gone back against one invoice, per product.
 *
 * Exactly the shape `balancesByRef({ account: "stock", refType:
 * "supplier_return", kind: "purchase" })` returns: `qty` is NEGATIVE, because
 * goods leaving the shelf is what a supplier return writes.
 */
export interface PriorSupplierReturn {
  /** The purchase invoice NUMBER the return was booked against. */
  refId: string;
  /** The product. */
  subjectId: string;
  /** Signed quantity — negative for goods that went back. */
  qty: number;
}

/** Two decimal places, without pulling decimal.js into the ledger. */
const money = (value: number): number => Math.round(value * 100) / 100;

/** How a line is addressed. The id when it has one, the product otherwise. */
export function purchaseLineKey(line: PurchaseInvoiceLine): string {
  return line.id ?? line.productId;
}

/** One invoice line with what is still returnable on it. */
export interface ReturnablePurchaseLine {
  key: string;
  line: PurchaseInvoiceLine;
  productId: string;
  productName: string;
  sku?: string;
  /** What the invoice received. */
  received: number;
  /** What has already gone back against this invoice, for this product. */
  returned: number;
  /** `received − returned`, floored at zero. */
  remaining: number;
  /** What we paid per unit on THIS receipt — never today's average. */
  unitCost: number;
}

/**
 * Every line of one purchase invoice with its returnable ceiling.
 *
 * The ceiling is keyed by PRODUCT rather than by line id, because the ledger
 * only knows products: a `stock` line names a product, not an invoice row. Two
 * lines of the same product on one invoice (different shades of one item)
 * therefore share one returnable pool, which is the only reading that can
 * reconcile exactly with the movements the ledger actually holds.
 */
export function remainingPurchaseLines(
  invoice: PurchaseInvoiceDoc,
  priorReturns: readonly PriorSupplierReturn[] = [],
): ReturnablePurchaseLine[] {
  const invoiceKey = invoice.invoiceNumber ?? invoice.id;

  const returnedByProduct = new Map<string, number>();
  for (const row of priorReturns) {
    if (row.refId !== invoiceKey) continue;
    const qty = Math.abs(Number(row.qty) || 0);
    if (qty <= 0) continue;
    returnedByProduct.set(row.subjectId, (returnedByProduct.get(row.subjectId) ?? 0) + qty);
  }

  // Spread one product's already-returned total across its lines in order, so
  // a two-line product shows the first line consumed before the second rather
  // than both showing the full deduction.
  const budget = new Map(returnedByProduct);

  return (invoice.items ?? []).map((line) => {
    const received = Number.isFinite(line.quantity) ? Math.max(0, line.quantity) : 0;
    const left = budget.get(line.productId) ?? 0;
    const taken = Math.min(left, received);
    budget.set(line.productId, left - taken);

    const unitCost = Number.isFinite(line.unitCost as number) ? (line.unitCost as number) : 0;

    return {
      key: purchaseLineKey(line),
      line,
      productId: line.productId,
      productName: line.productName ?? line.productId,
      sku: line.sku,
      received,
      returned: taken,
      remaining: Math.max(0, received - taken),
      unitCost,
    };
  });
}

/** What the operator asked to send back: one line of one purchase invoice. */
export interface SupplierReturnRequest {
  invoiceId: string;
  /** `purchaseLineKey` of the line on that invoice. */
  lineKey: string;
  quantity: number;
}

/** One resolved line — the invoice's own facts, not the screen's. */
export interface ResolvedSupplierReturnLine {
  invoiceId: string;
  invoiceNumber: string;
  lineKey: string;
  productId: string;
  productName: string;
  quantity: number;
  /** The cost on THAT receipt. This is the number the whole fix is about. */
  unitCost: number;
  variantName?: string;
}

/**
 * A supplier return proved against real purchase invoices.
 *
 * `buildSupplierReturnLines` takes this and nothing else, and only
 * `resolveSupplierReturn` produces it — so a screen cannot hand the ledger a
 * product and a cost it invented.
 */
export interface ResolvedSupplierReturn {
  supplierId: string;
  lines: ResolvedSupplierReturnLine[];
  /** What the supplier is credited, EGP — the sum of the resolved lines. */
  returnValue: number;
}

export interface ResolveSupplierReturnInput {
  supplierId: string;
  requests: readonly SupplierReturnRequest[];
  /** This supplier's invoices, already store-scoped by RLS on the way in. */
  invoices: readonly PurchaseInvoiceDoc[];
  /** From `balancesByRef` — the ledger's own record of what already went back. */
  priorReturns?: readonly PriorSupplierReturn[];
  /**
   * What is physically on the shelf, per product. Goods cannot go back to a
   * supplier if they are not there: unlike a customer return, nothing is
   * arriving — units leave. Returning 10 of an invoice of 10 after 8 were sold
   * would drive stock negative and invent inventory value to send away.
   */
  onHand?: (productId: string) => number;
}

/**
 * Turn what the operator picked into what the ledger may book — or refuse it.
 *
 * Every rule of the brief's §4/§6/§14 is checked here rather than in a screen,
 * because the screen is not the security boundary:
 *
 *   * the invoice exists and is in this store's list
 *   * it belongs to THIS supplier (a forged id from another one is refused)
 *   * the line exists on that invoice
 *   * the quantity is a positive, finite number
 *   * it does not exceed what is still returnable on that line
 *   * no line is asked for twice in one return
 *   * the goods are actually on the shelf to send back
 *
 * Store isolation needs no check of its own: `invoices` comes from a store
 * -scoped query, so an invoice from another shop is simply not in the list.
 */
export function resolveSupplierReturn(
  input: ResolveSupplierReturnInput,
): ResolvedSupplierReturn {
  const { supplierId, requests, invoices, priorReturns = [], onHand } = input;

  if (!supplierId) throw new Error("supplier return: no supplier chosen");
  if (!requests.length) throw new Error("supplier return: nothing selected to return");

  const returnableCache = new Map<string, Map<string, ReturnablePurchaseLine>>();
  const returnableFor = (invoice: PurchaseInvoiceDoc) => {
    let byKey = returnableCache.get(invoice.id);
    if (!byKey) {
      byKey = new Map(remainingPurchaseLines(invoice, priorReturns).map((l) => [l.key, l]));
      returnableCache.set(invoice.id, byKey);
    }
    return byKey;
  };

  // ONE source invoice per return. Not a UI convenience: the ledger event
  // carries a single `ref_id`, and that ref_id IS the ceiling — it is what
  // `balancesByRef` groups past returns by. An event spanning two invoices
  // could only name one of them, so the other's units would be deducted from
  // the shelf and still show as fully returnable. §11 of the brief allows one
  // return per source invoice, and this is why that is the honest option.
  const invoiceIds = new Set(requests.map((r) => r.invoiceId));
  if (invoiceIds.size > 1) {
    throw new Error(
      "supplier return: one return covers one purchase invoice — سجّل مرتجع منفصل لكل فاتورة",
    );
  }

  const seen = new Set<string>();
  const lines: ResolvedSupplierReturnLine[] = [];
  /** Running total per product, so a multi-line return cannot oversell the shelf. */
  const takenFromShelf = new Map<string, number>();
  let returnValue = 0;

  for (const request of requests) {
    const invoice = invoices.find((i) => i.id === request.invoiceId);
    if (!invoice) {
      throw new Error(`supplier return: invoice ${request.invoiceId} is not this store's`);
    }
    if (invoice.supplierId !== supplierId) {
      throw new Error(
        `supplier return: invoice ${invoice.invoiceNumber ?? invoice.id} belongs to another supplier`,
      );
    }

    const dedupe = `${request.invoiceId}::${request.lineKey}`;
    if (seen.has(dedupe)) {
      throw new Error(`supplier return: line ${request.lineKey} appears twice in the same return`);
    }
    seen.add(dedupe);

    const returnable = returnableFor(invoice).get(request.lineKey);
    if (!returnable) {
      throw new Error(
        `supplier return: ${request.lineKey} is not a line on invoice ${invoice.invoiceNumber ?? invoice.id}`,
      );
    }

    const quantity = Number(request.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`supplier return: quantity for ${returnable.productName} must be positive`);
    }
    if (quantity > returnable.remaining) {
      throw new Error(
        `supplier return: ${returnable.productName} — only ${returnable.remaining} left to return on ${invoice.invoiceNumber ?? invoice.id}`,
      );
    }

    if (onHand) {
      const already = takenFromShelf.get(returnable.productId) ?? 0;
      const shelf = onHand(returnable.productId);
      if (already + quantity > shelf) {
        throw new Error(
          `supplier return: ${returnable.productName} — only ${Math.max(0, shelf - already)} on the shelf to send back`,
        );
      }
      takenFromShelf.set(returnable.productId, already + quantity);
    }

    const resolved: ResolvedSupplierReturnLine = {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber ?? invoice.id,
      lineKey: returnable.key,
      productId: returnable.productId,
      productName: returnable.productName,
      quantity,
      // THE fix: the cost on this receipt, not the shelf's weighted average.
      unitCost: returnable.unitCost,
      variantName: returnable.line.variantName,
    };

    lines.push(resolved);
    returnValue += resolved.unitCost * quantity;
  }

  return { supplierId, lines, returnValue: money(returnValue) };
}

// ── Returning goods TO a supplier ───────────────────────────────────────────

export interface SupplierReturnInput {
  /**
   * The proved return. Produced ONLY by `resolveSupplierReturn`, which is what
   * makes "these units came in on a real receipt from this supplier, at this
   * cost, and that many are still returnable" a precondition of the ledger
   * write rather than a hope about the screen.
   */
  resolved: ResolvedSupplierReturn;
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
 * Stock goes out at the cost it came in at — the cost on the PURCHASE INVOICE
 * LINE being returned, resolved by `resolveSupplierReturn`. It used to be the
 * weighted average of the whole shelf, which is a different number the moment
 * the same product was ever bought twice at two prices, and is the reported
 * inflation. See the section header above.
 */
export function buildSupplierReturnLines(ret: SupplierReturnInput): NewLine[] {
  const lines: NewLine[] = [];

  if (!ret.resolved?.lines?.length) {
    throw new Error("supplier return: nothing resolved to return");
  }

  let returnedValue = 0;
  for (const item of ret.resolved.lines) {
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

  // Rounded exactly as `resolveSupplierReturn` rounds `returnValue`, so the
  // figure the تسوية panel showed and the figure the ledger books cannot
  // differ by a fraction of a piastre.
  returnedValue = money(returnedValue);

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
    lines.push({
      account: "payable_supplier",
      subjectId: ret.resolved.supplierId,
      amount: -debtReduction,
    });
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
