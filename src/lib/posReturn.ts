/**
 * Returning a POS sale, resolved against the sale that actually happened.
 *
 * ## The reported bug, and what actually caused it
 *
 * "استرجاع بفاتورة finds the right invoice and date, but the lines are wrong —
 * wrong product name, wrong quantity, «منتج غير معروف»."
 *
 * The picker was rebuilding the sold lines out of LEDGER lines:
 *
 *     const revenueLines = lines.filter(l => l.account === "revenue" && l.amount_delta > 0);
 *
 * `buildSaleLines` writes exactly ONE revenue line per sale, and its subject is
 * the CHANNEL — `"pos"` — not a product. So every receipt resolved to a single
 * row whose `subject_id` was the literal string `pos`:
 *
 *   * `products.find(p => p.id === "pos")` → nothing → **«منتج غير معروف»**
 *   * no `stock` line has subject `"pos"` → quantity fell back to **1**
 *   * so the unit price became the WHOLE SALE TOTAL divided by one
 *
 * Three symptoms, one cause. No amount of display patching reaches it, because
 * the numbers being displayed were never the sold lines.
 *
 * ## What is authoritative
 *
 * The sale DOCUMENT — `payload.items`, written by the checkout at the moment of
 * the sale and carrying the product id, the name as it was then, the shade, the
 * quantity and the price actually charged. That is the historical record of
 * what the customer bought. Today's catalog is not: a product can be renamed,
 * repriced, given variants or archived between the sale and the return, and
 * every one of those would rewrite history if the picker read the catalog.
 *
 * `stock` lines are still used for ONE thing — the returnable ceiling — because
 * a movement cannot drift the way a counter can. See `remainingSaleLines`.
 *
 * Pure, like `purchases.ts` and `orderSearch.ts`, so the rule is testable
 * without a DB or a browser.
 */

/** One line of a POS sale, exactly as the checkout recorded it. */
export interface HistoricalSaleLine {
  productId: string;
  /** The name AT THE TIME OF SALE. Never re-read from the catalog. */
  productName: string;
  variantName?: string;
  /** How many were sold on this line. Always positive. */
  quantity: number;
  /** What the customer was actually charged per unit, EGP. */
  unitPrice: number;
}

/** A sale line with what is still returnable on it. */
export interface ReturnableSaleLine extends HistoricalSaleLine {
  /** Stable address for this line — product plus shade. */
  key: string;
  /** What the receipt sold. */
  sold: number;
  /** What has already come back against this receipt. */
  returned: number;
  /** `sold − returned`, floored at zero. */
  remaining: number;
}

/** The shape of a `pos_sale` event this module reads. */
export interface PosSaleEventLike {
  id: string;
  payload?: unknown;
}

/**
 * A line's address: product plus shade.
 *
 * Two shades of one shirt on one receipt are two independently returnable
 * lines, and keying on the product alone would let a return of the red one
 * consume the blue one's ceiling.
 */
export function saleLineKey(line: { productId: string; variantName?: string }): string {
  return `${line.productId}::${line.variantName ?? ""}`;
}

const toFiniteNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The lines of a sale, from its own document.
 *
 * Returns `[]` for an event whose payload has no `items` array — a receipt
 * written before the payload carried them. That is the honest answer: the
 * picker then shows "this receipt has no line detail" instead of inventing
 * lines out of aggregate ledger rows, which is the bug this replaces.
 */
export function historicalSaleLines(event: PosSaleEventLike): HistoricalSaleLine[] {
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return [];
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];

  // ── What the customer was ACTUALLY charged per unit ───────────────────────
  //
  // A POS discount is applied to the whole CART, not to a line: the payload
  // carries `unitPrice` at list price and `discountAmount` separately, and
  // `buildSaleLines` books revenue net of it. Refunding at the raw `unitPrice`
  // therefore hands back more than was ever taken and over-reverses revenue by
  // exactly the discount.
  //
  // Measured on QA-STORE: a بوكس listed at 500 sold under QAUAT10 for 450, and
  // the return picker offered 500 — a 50 over-refund on one line.
  //
  // So the discount is spread across the lines in proportion to their value,
  // which is the only split that makes the refunded total equal the revenue
  // that was booked.
  const gross = items.reduce((sum: number, raw: unknown) => {
    if (!raw || typeof raw !== "object") return sum;
    const item = raw as Record<string, unknown>;
    const q = toFiniteNumber(item.quantity);
    return q > 0 ? sum + q * toFiniteNumber(item.unitPrice) : sum;
  }, 0);
  const discount = Math.max(0, toFiniteNumber((payload as { discountAmount?: unknown }).discountAmount));
  // Clamped: a discount at or above the goods cannot make a refund negative.
  const charged = gross > 0 ? Math.max(0, gross - discount) / gross : 1;

  const lines: HistoricalSaleLine[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const productId = String(item.productId ?? "").trim();
    if (!productId) continue;

    // A return is recorded as a negative-quantity sale on the same refType, so
    // a receipt's own lines are the POSITIVE ones. `Math.abs` would turn a
    // refund receipt into something returnable all over again.
    const quantity = toFiniteNumber(item.quantity);
    if (quantity <= 0) continue;

    const variantName = item.variantName ? String(item.variantName) : undefined;

    lines.push({
      productId,
      // The name the receipt was printed with. `productId` is the fallback, not
      // «منتج غير معروف» — an id at least identifies the thing.
      productName: String(item.productName ?? item.name ?? productId),
      variantName,
      quantity,
      // Rounded to the piastre, like every other money figure that reaches a
      // screen — see `money()` in `purchases.ts`.
      unitPrice: Math.round(toFiniteNumber(item.unitPrice) * charged * 100) / 100,
    });
  }
  return lines;
}

/** A past return, as recorded on a later `pos_sale` event. */
export interface PriorPosReturn {
  /** The receipt this came back against — `payload.returnOfEventId`. */
  sourceEventId: string;
  productId: string;
  variantName?: string;
  /** How many came back. Positive. */
  quantity: number;
}

/**
 * Past returns against POS receipts, read off the return events themselves.
 *
 * A return is a `pos_sale` whose lines are negative and whose payload names the
 * receipt it is returning — `returnOfEventId`. Reading the movement rather than
 * keeping a counter is the same choice `remainingPurchaseLines` makes, and for
 * the same reason: two tills returning at once cannot both read a stale zero.
 */
export function priorReturnsFrom(events: readonly PosSaleEventLike[]): PriorPosReturn[] {
  const rows: PriorPosReturn[] = [];
  for (const event of events) {
    const payload = event.payload;
    if (!payload || typeof payload !== "object") continue;
    const sourceEventId = String((payload as { returnOfEventId?: unknown }).returnOfEventId ?? "");
    if (!sourceEventId) continue;

    const items = (payload as { items?: unknown }).items;
    if (!Array.isArray(items)) continue;

    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const productId = String(item.productId ?? "").trim();
      if (!productId) continue;
      const quantity = toFiniteNumber(item.quantity);
      // Only the negative lines are the return itself.
      if (quantity >= 0) continue;
      rows.push({
        sourceEventId,
        productId,
        variantName: item.variantName ? String(item.variantName) : undefined,
        quantity: Math.abs(quantity),
      });
    }
  }
  return rows;
}

/**
 * Every line of one receipt with how much of it can still come back.
 *
 * Lines that are fully returned stay in the list with `remaining: 0`, so the
 * operator can see that the customer already brought that one back rather than
 * being shown a receipt that silently lost a row.
 */
export function remainingSaleLines(
  event: PosSaleEventLike,
  priorReturns: readonly PriorPosReturn[] = [],
): ReturnableSaleLine[] {
  const returnedByKey = new Map<string, number>();
  for (const row of priorReturns) {
    if (row.sourceEventId !== event.id) continue;
    const key = saleLineKey(row);
    returnedByKey.set(key, (returnedByKey.get(key) ?? 0) + Math.abs(row.quantity));
  }

  // Spread a key's already-returned total across its lines in order, so a
  // receipt that sold the same shade on two rows shows the first consumed
  // before the second rather than both showing the full deduction.
  const budget = new Map(returnedByKey);

  return historicalSaleLines(event).map((line) => {
    const key = saleLineKey(line);
    const left = budget.get(key) ?? 0;
    const taken = Math.min(left, line.quantity);
    budget.set(key, left - taken);

    return {
      ...line,
      key,
      sold: line.quantity,
      returned: taken,
      remaining: Math.max(0, line.quantity - taken),
    };
  });
}

/** What the operator asked to bring back. */
export interface PosReturnRequest {
  sourceEventId: string;
  key: string;
  quantity: number;
}

/**
 * Check one requested return line against the receipt, or refuse it.
 *
 * The ceiling is enforced here rather than in the modal, because the modal is
 * not the boundary: the same cart can be reached by scanning a barcode.
 */
export function resolvePosReturnLine(
  event: PosSaleEventLike,
  request: PosReturnRequest,
  priorReturns: readonly PriorPosReturn[] = [],
): ReturnableSaleLine {
  const line = remainingSaleLines(event, priorReturns).find((l) => l.key === request.key);
  if (!line) {
    throw new Error("المنتج ده مش على الفاتورة دي");
  }
  const quantity = Number(request.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`الكمية المرتجعة لـ"${line.productName}" لازم تكون أكبر من صفر`);
  }
  if (quantity > line.remaining) {
    throw new Error(
      `"${line.productName}" — فاضل ${line.remaining} بس ممكن يترجع من الفاتورة دي`,
    );
  }
  return { ...line, quantity };
}
