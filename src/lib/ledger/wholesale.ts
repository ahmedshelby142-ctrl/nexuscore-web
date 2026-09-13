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
import { lineCostOf, stockLinesFor, cogsLinesFor } from "./bundles.ts";

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
    // Bundle-aware — see `lineCostOf`.
    const lineCost = lineCostOf(item);
    goodsRevenue += lineRevenue;
    cogs += lineCost;

    // Stock leaves carrying its value, exactly as in a POS sale — this is what
    // keeps weighted-average cost right for whatever stays on the shelf.
    //
    // A بوكس charges its COMPONENTS, same as `buildSaleLines`. This branch was
    // missing here, so a bundle sold through الجملة booked stock against a
    // virtual product with no shelf while the real goods walked out untracked.
    if (!invoice.skipStockDeduction) {
      lines.push(...stockLinesFor(item, -1));
    }

    // Bundle-aware, like the stock lines above it. This was the other half of
    // the same hole: the stock branch charged the components while the COGS
    // line used `item.unitCost`, which is 0 for a virtual box — so a بوكس sold
    // through الجملة booked full revenue against no cost at all.
    lines.push(...cogsLinesFor(item, 1));
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

// ── Invoice-driven wholesale returns ────────────────────────────────────────
//
// ## The hole this section closes
//
// `buildWholesaleReturnLines` used to take an arbitrary `items` array with an
// arbitrary `unitPrice`, and both offline screens fed it exactly that: شاشة
// الجملة from a free product search, نقطة البيع from a cart of negative
// quantities. Nothing anywhere asked whether the trader had ever BOUGHT the
// thing coming back. Three separate ways to invent money followed:
//
//   1. A product the client never bought could be "returned" — stock appeared
//      on the shelf, revenue reversed, and the client's debt fell by a number
//      that corresponded to no sale.
//   2. A genuine return was credited at TODAY's wholesale price. Ten units
//      invoiced at 100 and returned after a rise to 140 credited 1400 against
//      a 1000 sale: 400 of debt written off that was never owed.
//   3. Nothing subtracted what had already come back, so the same ten units
//      could be returned over and over, once per click of the button.
//
// The fix is that a return is no longer described — it is RESOLVED against the
// invoice it came from. `resolveWholesaleReturn` is the only producer of the
// value `buildWholesaleReturnLines` accepts, so no screen can hand the ledger
// a product and a price it made up.

/**
 * One line of a wholesale invoice DOCUMENT, in every shape the app has written.
 *
 * Three writers exist — شاشة الجملة, نقطة البيع in وضع الجملة, and الطلبات on
 * a wholesale delivery — and they disagreed about the price field's name
 * (`wholesalePrice` vs `unitPrice`). Both are read here rather than picking a
 * winner and silently valuing half the invoices in the database at zero.
 */
export interface WholesaleInvoiceLine {
  /** Stable per-line id. Every writer sets one; older rows may not. */
  id?: string;
  productId: string;
  productName?: string;
  variantName?: string;
  quantity: number;
  /** شاشة الجملة / POS. */
  wholesalePrice?: number;
  /** الطلبات. Same meaning. */
  unitPrice?: number;
  /**
   * The cost the goods left at, captured on the invoice.
   *
   * Absent on invoices written before this fix — see `resolveWholesaleReturn`
   * for what happens then.
   */
  unitCost?: number;
  isBundle?: boolean;
  bundleItems?: { productId: string; quantity: number; unitCost: number }[];
}

/** A wholesale invoice document, as `wholesale_invoices` stores it. */
export interface WholesaleInvoiceDoc {
  id: string;
  invoiceNumber?: string;
  clientId: string;
  items?: WholesaleInvoiceLine[];
  /** List value of the goods, before any discount code. */
  goodsTotal?: number;
  /** Money taken off the goods. Shipping is never discounted. */
  discountAmount?: number;
  createdAt?: unknown;
}

/**
 * A return already recorded, as `return_records` stores it.
 *
 * Reuses the retail return document rather than inventing a wholesale one:
 * `original_order_id` is untyped text with no foreign key, so it holds the
 * wholesale INVOICE id here, and `type` says which it is. Same table, same
 * sync path, same RLS — and the ceiling is derived from documents that are
 * already written rather than from a stored counter that can drift.
 */
export interface PriorWholesaleReturn {
  type?: string;
  original_order_id?: string | null;
  returned_items?: { line_id?: string; product_id?: string; quantity?: number }[];
}

/** `return_records.type` for a wholesale return. */
export const WHOLESALE_RETURN_TYPE = "wholesale_return";

/** Two decimal places, without dragging decimal.js into the ledger. */
const money = (value: number): number => Math.round(value * 100) / 100;

/**
 * How a line is addressed across the invoice, the return record and the UI.
 *
 * The id when the line has one. The product + variant otherwise, which is
 * unique within an invoice because every writer merges a repeated
 * product/variant into the existing line instead of appending a second one.
 */
export function wholesaleLineKey(line: WholesaleInvoiceLine): string {
  return line.id ?? `${line.productId}::${line.variantName ?? ""}`;
}

/** The per-unit price the invoice carries, whichever field it used. */
export function wholesaleLinePrice(line: WholesaleInvoiceLine): number {
  const price = line.wholesalePrice ?? line.unitPrice ?? 0;
  return Number.isFinite(price) ? price : 0;
}

/**
 * The ratio between what an invoice's lines LIST for and what was charged.
 *
 * The mirror of `discountFactor` in `lib/exchange`, and it exists for the same
 * reason: a discount code lives at the invoice level while each line still
 * carries its list price, so crediting `quantity × unitPrice` hands back more
 * than was ever taken. Wholesale can be exact where retail has to infer —
 * `goodsTotal` and `discountAmount` are both stored on the document.
 *
 * Never above 1, and never below 0.
 */
export function wholesaleDiscountFactor(invoice: WholesaleInvoiceDoc): number {
  const goods = Number(invoice.goodsTotal);
  const discount = Number(invoice.discountAmount);
  if (!Number.isFinite(goods) || goods <= 0) return 1;
  if (!Number.isFinite(discount) || discount <= 0) return 1;
  if (discount >= goods) return 0;
  return (goods - discount) / goods;
}

/** One invoice line, with what is still returnable on it. */
export interface ReturnableWholesaleLine {
  key: string;
  line: WholesaleInvoiceLine;
  productId: string;
  productName: string;
  variantName?: string;
  /** What the invoice sold. */
  sold: number;
  /** What has already come back, across every prior return. */
  returned: number;
  /** `sold − returned`, floored at zero. */
  remaining: number;
  /** List price per unit, as printed on the invoice. */
  listUnitPrice: number;
  /** What the client actually PAID per unit — list, scaled by the discount. */
  netUnitPrice: number;
}

/**
 * Every line of one invoice with its returnable ceiling.
 *
 * Returns ALL lines, fully-returned ones included, because a screen that wants
 * to show "0 متبقي" next to a line the trader is asking about needs the line —
 * callers filter. The ceiling itself is derived from the prior return records,
 * never stored, for the reason `remainingQuantities` gives in `lib/exchange`:
 * a stored counter is a second truth to keep in step with the documents.
 */
export function remainingWholesaleLines(
  invoice: WholesaleInvoiceDoc,
  priorReturns: readonly PriorWholesaleReturn[] = [],
): ReturnableWholesaleLine[] {
  const factor = wholesaleDiscountFactor(invoice);

  const returnedByKey = new Map<string, number>();
  for (const record of priorReturns) {
    if (record.original_order_id !== invoice.id) continue;
    if (record.type !== WHOLESALE_RETURN_TYPE) continue;
    for (const item of record.returned_items ?? []) {
      // `line_id` is what this writer stores. `product_id` is the fallback for
      // a record written against a line that never had an id.
      const key = item.line_id ?? `${item.product_id ?? ""}::`;
      const qty = Number(item.quantity);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      returnedByKey.set(key, (returnedByKey.get(key) ?? 0) + qty);
    }
  }

  return (invoice.items ?? []).map((line) => {
    const key = wholesaleLineKey(line);
    const sold = Number.isFinite(line.quantity) ? Math.max(0, line.quantity) : 0;
    // Matched by id first, then by the product-only fallback key, so a record
    // written either way still counts against the line.
    const returned =
      (returnedByKey.get(key) ?? 0) +
      (line.id ? (returnedByKey.get(`${line.productId}::`) ?? 0) : 0);
    const listUnitPrice = wholesaleLinePrice(line);
    return {
      key,
      line,
      productId: line.productId,
      productName: line.productName ?? line.productId,
      variantName: line.variantName,
      sold,
      returned,
      // Never below zero: a record claiming more than went out is corrupt
      // data, and a negative here would enlarge the NEXT line's ceiling.
      remaining: Math.max(0, sold - returned),
      listUnitPrice,
      netUnitPrice: money(listUnitPrice * factor),
    };
  });
}

/** What the operator asked to send back: one line of one invoice. */
export interface WholesaleReturnRequest {
  invoiceId: string;
  /** `wholesaleLineKey` of the line on that invoice. */
  lineKey: string;
  quantity: number;
}

/** One resolved line — the invoice's own facts, not the screen's. */
export interface ResolvedWholesaleReturnLine {
  invoiceId: string;
  invoiceNumber: string;
  lineKey: string;
  productId: string;
  productName: string;
  variantName?: string;
  quantity: number;
  /** What the client paid per unit on THAT invoice, net of its discount. */
  unitPrice: number;
  /** The cost the goods left at, or today's WAC when the invoice omitted it. */
  unitCost: number;
  isBundle?: boolean;
  bundleItems?: { productId: string; quantity: number; unitCost: number }[];
}

/**
 * A return that has been proved against real invoices.
 *
 * `buildWholesaleReturnLines` takes this and nothing else, and only
 * `resolveWholesaleReturn` produces it — that is the whole enforcement. A
 * screen cannot assemble one by hand without going through the checks, because
 * the checks are what fill in `unitPrice`.
 */
export interface ResolvedWholesaleReturn {
  clientId: string;
  lines: ResolvedWholesaleReturnLine[];
  /** What the client is credited, EGP — the sum of the resolved lines. */
  returnValue: number;
}

export interface ResolveWholesaleReturnInput {
  /** Whose account this settles against. Every invoice must belong to them. */
  clientId: string;
  requests: readonly WholesaleReturnRequest[];
  /** The client's invoices, already store-scoped by RLS on the way in. */
  invoices: readonly WholesaleInvoiceDoc[];
  /** Every return record in the store. Filtered per invoice inside. */
  priorReturns?: readonly PriorWholesaleReturn[];
  /** Today's weighted-average cost, for invoices written without one. */
  costOf: (productId: string) => number;
}

/**
 * Turn what the operator picked into what the ledger may book — or refuse it.
 *
 * Every rule in the brief's §4 is checked HERE rather than in a screen,
 * because three screens start wholesale returns and a guard in one of them is
 * not a rule. The checks:
 *
 *   * the invoice exists
 *   * it belongs to THIS client (a forged id from another trader is refused)
 *   * the line exists on that invoice
 *   * the quantity is a positive number
 *   * it does not exceed what is still returnable on that line
 *   * no line is asked for twice in one return, which would let two requests
 *     of 6 each pass a ceiling of 10 by checking themselves independently
 *
 * Store isolation needs no check of its own: `invoices` comes from a store
 * -scoped query, so an invoice from another store is simply not in the list
 * and fails the first rule.
 *
 * ## The two prices
 *
 * `unitPrice` is what the client PAID on that invoice — list price scaled by
 * the invoice's own discount. That is the customer-side reversal, and it is
 * deliberately not today's wholesale price and not the retail price.
 *
 * `unitCost` is the inventory side and answers a different question: what did
 * these goods cost us when they left. The invoice carries it from now on;
 * where it does not, today's WAC is the only figure available and is used with
 * that limitation stated rather than silently pretending it is the same thing.
 */
export function resolveWholesaleReturn(
  input: ResolveWholesaleReturnInput,
): ResolvedWholesaleReturn {
  const { clientId, requests, invoices, priorReturns = [], costOf } = input;

  if (!clientId) throw new Error("wholesale return: no client chosen");
  if (!requests.length) throw new Error("wholesale return: nothing selected to return");

  // Cached per invoice so ten lines of one invoice do not re-scan the records
  // ten times, and so the ceiling every line sees is the same snapshot.
  const returnableCache = new Map<string, Map<string, ReturnableWholesaleLine>>();
  const returnableFor = (invoice: WholesaleInvoiceDoc) => {
    let byKey = returnableCache.get(invoice.id);
    if (!byKey) {
      byKey = new Map(remainingWholesaleLines(invoice, priorReturns).map((l) => [l.key, l]));
      returnableCache.set(invoice.id, byKey);
    }
    return byKey;
  };

  const seen = new Set<string>();
  const lines: ResolvedWholesaleReturnLine[] = [];
  let returnValue = 0;

  for (const request of requests) {
    const invoice = invoices.find((i) => i.id === request.invoiceId);
    if (!invoice) {
      throw new Error(`wholesale return: invoice ${request.invoiceId} is not this store's`);
    }
    if (invoice.clientId !== clientId) {
      throw new Error(
        `wholesale return: invoice ${invoice.invoiceNumber ?? invoice.id} belongs to another client`,
      );
    }

    const dedupe = `${request.invoiceId}::${request.lineKey}`;
    if (seen.has(dedupe)) {
      throw new Error(`wholesale return: line ${request.lineKey} appears twice in the same return`);
    }
    seen.add(dedupe);

    const returnable = returnableFor(invoice).get(request.lineKey);
    if (!returnable) {
      throw new Error(
        `wholesale return: ${request.lineKey} is not a line on invoice ${invoice.invoiceNumber ?? invoice.id}`,
      );
    }

    const quantity = Number(request.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`wholesale return: quantity for ${returnable.productName} must be positive`);
    }
    if (quantity > returnable.remaining) {
      throw new Error(
        `wholesale return: ${returnable.productName} — only ${returnable.remaining} left to return on ${invoice.invoiceNumber ?? invoice.id}`,
      );
    }

    const line = returnable.line;
    // The cost the goods left at. Today's average is the fallback, not the
    // rule: reversing at a cost the goods never carried moves inventory value
    // that never moved.
    const unitCost = Number.isFinite(line.unitCost as number)
      ? (line.unitCost as number)
      : costOf(returnable.productId);

    const resolved: ResolvedWholesaleReturnLine = {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber ?? invoice.id,
      lineKey: returnable.key,
      productId: returnable.productId,
      productName: returnable.productName,
      variantName: returnable.variantName,
      quantity,
      unitPrice: returnable.netUnitPrice,
      unitCost,
      ...(line.isBundle && line.bundleItems?.length
        ? { isBundle: true, bundleItems: line.bundleItems }
        : {}),
    };

    lines.push(resolved);
    returnValue += resolved.unitPrice * quantity;
  }

  return { clientId, lines, returnValue: money(returnValue) };
}

// ── Wholesale returns: goods back, debt down, and maybe cash either way ──────

export interface WholesaleReturnInput {
  /**
   * The proved return. Produced ONLY by `resolveWholesaleReturn`, which is what
   * makes "this product came from a real invoice to this client, and there is
   * still that much of it left to send back" a precondition of the ledger
   * write rather than a hope about the screen.
   */
  resolved: ResolvedWholesaleReturn;
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

  if (!ret.resolved?.lines?.length) {
    throw new Error("wholesale return: nothing resolved to return");
  }

  let returnedValue = 0;
  for (const item of ret.resolved.lines) {
    if (item.quantity <= 0) {
      throw new Error(`wholesale return: quantity for ${item.productId} must be positive`);
    }
    if (item.unitPrice < 0) {
      throw new Error(`wholesale return: price for ${item.productId} cannot be negative`);
    }

    const lineValue = item.unitPrice * item.quantity;
    returnedValue += lineValue;

    // The goods are back, carrying their value back into inventory. A بوكس
    // comes back as its components — it has no shelf of its own.
    lines.push(...stockLinesFor(item, 1));

    // And their cost stops being a cost of goods sold — components included.
    lines.push(...cogsLinesFor(item, -1));
  }

  // Rounded exactly as `resolveWholesaleReturn` rounds `returnValue`, so the
  // number the تسوية panel showed the operator and the number the ledger books
  // cannot differ by a discount-scaling fraction of a piastre.
  returnedValue = money(returnedValue);

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
    lines.push({
      account: "receivable_client",
      subjectId: ret.resolved.clientId,
      amount: -debtReduction,
    });
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
