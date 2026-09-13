/**
 * استبدال — what a replacement IS in this ERP, in one place.
 *
 * ## Why this file exists
 *
 * Three screens implemented "exchange" and none of them agreed:
 *
 *   - `routes/returns.tsx`  a `return_confirmed` + a separate `sale`, at the
 *                           counter, with a `pending_replacement` compensation
 *                           record when the second leg failed.
 *   - `sales/CheckoutForm`  ONE signed `sale` event — a mixed-sign cart whose
 *                           negative lines put goods back and whose positive
 *                           lines take goods out. Atomic, and correct.
 *   - `routes/ecommerce-orders.tsx`  a new order carrying NEGATIVE rows, which
 *                           `buildOrderPlacedLines` refuses outright. It threw
 *                           on every attempt; no e-commerce exchange has ever
 *                           been recorded through it.
 *
 * They also valued the returned goods differently: the counter scaled by the
 * order's discount, the e-commerce form used the raw list price. Two operators
 * doing "the same" swap got different refunds.
 *
 * ## The model, derived — not invented
 *
 * The schema already carries `orders.isExchange` and `orders.original_order_id`,
 * the Settings matrix already prices an `exchange` shipping movement, and
 * `buildReturnConfirmedLines` already has a `movement: "exchange"` branch. The
 * document model was decided long ago and left unfinished. It is:
 *
 *   an e-commerce exchange = a LINKED REPLACEMENT ORDER
 *                          + the original order's own return lifecycle
 *
 * Concretely, over time:
 *
 *   1. replacement order placed   `order_placed`   stock − (the new goods)
 *   2. original order → returned  `order_returned_pending`   nothing moves
 *   3. original return confirmed  `return_confirmed` with movement "exchange"
 *                                 stock +, revenue −, cogs −, LTV −, fee
 *                                 pass-through (the CUSTOMER pays an exchange
 *                                 trip, so it is never the shop's expense)
 *   4. replacement delivered      `order_delivered`  revenue +, cogs +, COD
 *
 * ## Why there is no "price difference" event
 *
 * There is deliberately NO arithmetic here that computes a difference and then
 * moves money by it. Step 4 books the replacement at its full price and step 3
 * reverses the original at its full price, so the net the books end up with IS
 * the difference — including the sign. A cheaper replacement nets negative on
 * its own, with no special case.
 *
 * `priceDifference` below therefore exists to be SHOWN to the operator before
 * they commit, and never to be booked. Every screen must keep booking through
 * the builders, which is the property that stops an exchange inventing money.
 *
 * Pure and free of React, the store and Supabase, so the rules can be asserted
 * directly — see `scripts/check_exchange.mjs`.
 */

/** The little of an order this module actually needs. */
export interface ExchangeableOrder {
  id: string;
  status: string;
  /** Set once the goods physically came back. */
  returnConfirmedAt?: unknown;
  /** List-priced lines, as the order reserved them. */
  stockItems?: { productId: string; quantity: number; unitPrice: number; unitCost?: number }[];
  /** What the customer actually paid for the goods, net of any order discount. */
  totalAmount?: number;
  /** Set on a REPLACEMENT order; points at the order being replaced. */
  original_order_id?: string | null;
  isExchange?: boolean;
}

/** A return already recorded against an order, as `return_records` stores it. */
export interface PriorReturn {
  original_order_id?: string | null;
  returned_items?: { product_id: string; quantity: number }[];
}

/**
 * Why this order may not be exchanged right now, or `null` if it may.
 *
 * Returned as a reason rather than a boolean because every caller has to TELL
 * the operator which of these it is — "مش متاح" on a button they can see is
 * worse than no button.
 */
export type ExchangeBlock =
  /** Not delivered yet. Goods that never reached the customer come back as an
   *  RTO or a cancellation, which reverse different things. */
  | "not_delivered"
  /** The goods already came back. There is nothing left to swap. */
  | "already_returned"
  /** A replacement order already exists against this one. */
  | "already_replaced"
  /** Every line has already been returned or swapped. */
  | "nothing_left";

export const EXCHANGE_BLOCK_TEXT: Record<ExchangeBlock, string> = {
  not_delivered: "الطلب لسه متسلّمش للعميل — الاستبدال بيبدأ بعد التسليم",
  already_returned: "الطلب ده مرتجع بالفعل ورجع للمخزون",
  already_replaced: "فيه طلب استبدال متعمل على الطلب ده بالفعل",
  nothing_left: "كل المنتجات في الطلب ده اترجعت أو اتستبدلت",
};

/**
 * How many of each product this order still has with the customer.
 *
 * An order's own `stockItems` say what WENT OUT, which stops being the
 * answer the moment one line comes back: the counter screen returns individual
 * lines and, until now, capped each one at the ORDERED quantity, so the same
 * item could be returned over and over — stock added and revenue reversed every
 * time, from one delivery.
 *
 * Derived from the return records rather than stored, because the records are
 * already written, already synced, and already carry `original_order_id`. A new
 * column would be a second truth to keep in step with them.
 */
export function remainingQuantities(
  order: ExchangeableOrder,
  priorReturns: readonly PriorReturn[],
): Map<string, number> {
  const remaining = new Map<string, number>();
  for (const line of order.stockItems ?? []) {
    remaining.set(line.productId, (remaining.get(line.productId) ?? 0) + line.quantity);
  }
  for (const record of priorReturns) {
    if (record.original_order_id !== order.id) continue;
    for (const item of record.returned_items ?? []) {
      const left = remaining.get(item.product_id);
      if (left === undefined) continue;
      // Never below zero: a record claiming more than went out is corrupt data,
      // and letting it go negative would hand the NEXT line a bigger ceiling.
      remaining.set(item.product_id, Math.max(0, left - item.quantity));
    }
  }
  return remaining;
}

/**
 * May this order be exchanged?
 *
 * `replacements` is every order in the store; the check looks for one already
 * pointing back at this one. Passing the whole list rather than a precomputed
 * flag keeps the answer derived from the documents — a replacement order that
 * exists is proof, a boolean on the original is a thing that can go stale.
 */
export function exchangeBlock(
  order: ExchangeableOrder,
  priorReturns: readonly PriorReturn[] = [],
  replacements: readonly ExchangeableOrder[] = [],
): ExchangeBlock | null {
  if (order.status !== "delivered") return "not_delivered";
  if (order.returnConfirmedAt) return "already_returned";
  if (replacements.some((o) => o.id !== order.id && o.original_order_id === order.id)) {
    return "already_replaced";
  }
  const remaining = remainingQuantities(order, priorReturns);
  let left = 0;
  for (const qty of remaining.values()) left += qty;
  if (left <= 0) return "nothing_left";
  return null;
}

/** The boolean form, for a `disabled` or a filter. */
export function canExchange(
  order: ExchangeableOrder,
  priorReturns: readonly PriorReturn[] = [],
  replacements: readonly ExchangeableOrder[] = [],
): boolean {
  return exchangeBlock(order, priorReturns, replacements) === null;
}

/**
 * The ratio between what an order's lines LIST for and what was actually PAID.
 *
 * A discount lives at the order level — `totalAmount` is the goods already net
 * of it — while each line still carries its list price. Valuing a returned line
 * at `quantity × unitPrice` therefore hands back more than was ever taken: two
 * items at 500 bought with 10% off cost 900, so returning one is worth 450, not
 * 500. The shop pays the promotion a second time, on the way out.
 *
 * `1` when there was no discount, when the order is malformed, or when
 * `totalAmount` is somehow the larger number — never a factor above 1, which
 * would refund MORE than list.
 */
export function discountFactor(order: ExchangeableOrder): number {
  const listTotal = (order.stockItems ?? []).reduce(
    (sum, line) => sum + line.unitPrice * line.quantity,
    0,
  );
  const paidTotal = order.totalAmount;
  if (!listTotal || !Number.isFinite(paidTotal) || (paidTotal as number) >= listTotal) return 1;
  return (paidTotal as number) / listTotal;
}

/** One line being handed back. */
export interface ReturnedLine {
  productId: string;
  quantity: number;
  /** The LIST price the order carried. Scaling to what was paid happens here. */
  unitPrice: number;
}

/**
 * What the returned lines are worth — the number both the refund and the
 * revenue reversal must use.
 *
 * This is the authoritative valuation. A screen that adds up displayed prices
 * instead will disagree with the ledger the moment a promo code is involved.
 */
export function returnedValue(order: ExchangeableOrder, lines: readonly ReturnedLine[]): number {
  const factor = discountFactor(order);
  return lines.reduce((sum, line) => sum + line.quantity * line.unitPrice * factor, 0);
}

/**
 * What the customer owes (positive) or is owed (negative), for DISPLAY.
 *
 * Never book this. See the header: the difference is what the two full-value
 * legs already net to, and booking it as well would count it twice.
 */
export function priceDifference(replacementTotal: number, returnedTotal: number): number {
  return replacementTotal - returnedTotal;
}

/** One replacement product going out, as a return record describes it. */
export interface ExchangedItem {
  product_id: string;
  product_name: string;
  quantity: number;
  price: number;
}

/**
 * Every replacement item on a return record, whatever shape it was stored in.
 *
 * ## Why this exists
 *
 * `return_records.exchanged_item` is a single JSONB object, and the POS wrote
 * `positiveItems[0]` into it — so a cashier who swapped one returned item for
 * THREE different products got a ledger that was completely correct and a
 * document that mentioned one of them. The other two vanished from the
 * exchange log, the PDF export and the CRM view, with nothing to say they had
 * ever been there.
 *
 * The column is JSONB, so an ARRAY fits with no migration and no new column.
 * Writers now always store an array; this normalises on the way back out so
 * every row already in the database — all of them single objects — keeps
 * reading correctly. Both shapes in, one shape out.
 */
export function exchangedItems(record: {
  exchanged_item?: ExchangedItem | ExchangedItem[] | null;
}): ExchangedItem[] {
  const raw = record.exchanged_item;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/** The replacement items summarised for one line of display. */
export function exchangedItemsLabel(record: {
  exchanged_item?: ExchangedItem | ExchangedItem[] | null;
}): string {
  const items = exchangedItems(record);
  if (items.length === 0) return "—";
  return items.map((i) => `${i.product_name} × ${i.quantity}`).join("، ");
}

/**
 * Is this order the original half of an exchange — i.e. does a replacement
 * order point at it?
 *
 * This is what decides `movement` when the return is confirmed: on an exchange
 * the CUSTOMER pays the courier's trip, so the fee is a pass-through and not
 * the shop's expense. Booking it as an expense understates profit on every
 * swap, which is the branch `buildReturnConfirmedLines` has always had and
 * nothing has ever reached.
 */
export function movementFor(
  order: ExchangeableOrder,
  allOrders: readonly ExchangeableOrder[],
): "return" | "exchange" {
  return allOrders.some((o) => o.id !== order.id && o.original_order_id === order.id)
    ? "exchange"
    : "return";
}

/**
 * What a `return_records.type` is called on screen.
 *
 * Both the returns log and its PDF export used to read
 * `type === "return" ? "إرجاع" : "استبدال"` — a binary that was true when the
 * only two kinds were a retail return and a retail swap. It stopped being true
 * when wholesale and supplier returns started writing to the same table: every
 * one of them rendered as "استبدال", so صفحة المرتجعات told the operator a
 * trader's refund was a swap, and the EXPORTED PDF said so too.
 *
 * A map rather than a second ternary, so adding a kind cannot silently fall
 * into whichever branch happens to be the `else`.
 */
const RETURN_TYPE_LABELS: Record<string, string> = {
  return: "إرجاع",
  exchange: "استبدال",
  wholesale_return: "مرتجع جملة",
  supplier_return: "مرتجع مورد",
};

/** The Arabic label for a return record's type. Unknown kinds say so plainly. */
export function returnTypeLabel(type: string | null | undefined): string {
  const key = String(type ?? "").trim();
  // `||` and not `??`: an absent type arrives as "" after the String(), and
  // `"" ?? fallback` is "", which would render a blank cell.
  return RETURN_TYPE_LABELS[key] || key || "مرتجع";
}

/**
 * What a customer may actually hand back, priced the way they bought it.
 *
 * ## The bug this exists to kill
 *
 * صفحة المرتجعات built its returnable lines straight from `order.stockItems`.
 * For a plain order that is right — the lines that went out are the lines that
 * come back. For a **بوكس** it is wrong in a way that costs the customer money.
 *
 * A bundle order stores the SOLD line in `items` (one بوكس at 500) and the
 * COMPONENTS in `stockItems`, each carrying `unitPrice: 0` because the price
 * lives on the bundle, not on its parts. So the return screen offered
 * "QA-UAT-WIDGET — ٠ ج.م" and "غسول سيرافي — ٠ ج.م", and confirming it put the
 * components back on the shelf, reversed their COGS, and refunded the customer
 * **nothing**. The shop kept the 500 and the goods. Measured on QA-STORE with
 * ECO-1789244668137.
 *
 * ## The unit a return is denominated in
 *
 * A بوكس is sold as one thing and comes back as one thing. So a bundle's
 * components collapse into ONE returnable unit keyed by `bundleId`, priced from
 * the sold line, carrying its recipe so the ledger can expand it again — which
 * `stockLinesFor` / `cogsLinesFor` already know how to do. Plain lines are
 * untouched and keep keying on `productId`.
 */
export interface ReturnableUnit {
  /** `bundleId` for a بوكس, `productId` otherwise. What the ceiling keys on. */
  key: string;
  productId: string;
  productName: string;
  variantName?: string;
  /** How many went out. */
  quantity: number;
  /** What the customer paid per unit — the bundle's price for a بوكس. */
  unitPrice: number;
  /** Cost per unit; for a بوكس the components carry it instead. */
  unitCost: number;
  isBundle?: boolean;
  bundleItems?: { productId: string; quantity: number; unitCost: number }[];
}

/**
 * The order's lines as returnable units — bundles collapsed, plain lines as-is.
 *
 * `items` supplies the price (it is the sold line); `stockItems` supplies the
 * recipe and the costs (they are what physically moved). Neither alone can
 * describe a bundle return correctly.
 */
export function returnableUnits(order: any): ReturnableUnit[] {
  const stockItems: any[] = order?.stockItems ?? [];
  const soldItems: any[] = order?.items ?? [];

  const units: ReturnableUnit[] = [];
  const bundles = new Map<string, ReturnableUnit>();

  for (const line of stockItems) {
    const bundleId = line?.bundleId;
    if (!bundleId) {
      units.push({
        key: line.productId,
        productId: line.productId,
        productName: line.productName,
        variantName: line.variantName,
        quantity: line.quantity,
        unitPrice: Number(line.unitPrice) || 0,
        unitCost: Number(line.unitCost) || 0,
      });
      continue;
    }

    // The sold line is where a بوكس keeps its price and its quantity.
    const sold = soldItems.find((i) => i?.bundleId === bundleId);
    const boxes = Number(sold?.quantity) || 1;
    let unit = bundles.get(bundleId);
    if (!unit) {
      unit = {
        key: bundleId,
        productId: bundleId,
        productName: sold?.productName ?? line.bundleName ?? "بوكس",
        quantity: boxes,
        unitPrice: Number(sold?.unitPrice) || 0,
        // A بوكس has no cost of its own; `bundleItems` below carries it.
        unitCost: 0,
        isBundle: true,
        bundleItems: [],
      };
      bundles.set(bundleId, unit);
      units.push(unit);
    }
    // Per-box component quantity: the stock line holds the total that left.
    unit.bundleItems!.push({
      productId: line.productId,
      quantity: (Number(line.quantity) || 0) / (boxes || 1),
      unitCost: Number(line.unitCost) || 0,
    });
  }

  return units;
}

/**
 * How much of each returnable UNIT is still with the customer.
 *
 * The bundle-aware sibling of `remainingQuantities`: same derivation from the
 * return records, but keyed by `returnableUnits`' `key`, so a بوكس is capped as
 * one box rather than as loose components that were never sold separately.
 */
export function remainingUnits(
  order: any,
  priorReturns: readonly PriorReturn[],
): Map<string, number> {
  const remaining = new Map<string, number>();
  for (const unit of returnableUnits(order)) {
    remaining.set(unit.key, (remaining.get(unit.key) ?? 0) + unit.quantity);
  }
  for (const record of priorReturns) {
    if (record.original_order_id !== order.id) continue;
    for (const item of record.returned_items ?? []) {
      const left = remaining.get(item.product_id);
      if (left === undefined) continue;
      remaining.set(item.product_id, Math.max(0, left - item.quantity));
    }
  }
  return remaining;
}
