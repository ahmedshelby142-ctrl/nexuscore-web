/** Forward model: demanded quantity is separate from actual reserved stock.
 * Missing is authoritative and decreases only in the stock transaction.
 * The historical floor/subtraction formula below applies ONLY to legacy rows.
 */
/**
 * النواقص — what has to be bought or manufactured, exactly.
 *
 * ## Why this is not "ordered minus stock"
 *
 * Stock is deducted the moment an order is TAKEN, not when it ships — the
 * `order_placed` event reserves it and `applyStockMoves` moves the record with
 * it. So a pending order's units are already off the shelf, and comparing the
 * open-order total against what is left double-counts every one of them:
 *
 *     shelf 3, order for 5 → shelf floors to 0, order still "requires" 5
 *     naive deficit = 5 − 0 = 5     the owner only has to make 2
 *
 * The honest number is measured at the one moment both halves are known: when
 * the user confirms the نواقص and the interceptor can see how much of that
 * line the shelf could not cover. That is the line's `shortfall`, and it is
 * carried on the order document from there.
 *
 * ## The formula
 *
 *     deficit = Σ(shortfall on open-order lines) − getActualStock(product)
 *
 * The subtraction is what makes a row disappear once you actually restock: owe
 * 2, receive 10, and the 2 are covered — the reservation for them is already
 * accounted for in the units that were floored away when the order was taken.
 *
 * "Open" means the order is still ours to fulfil: `pending`.
 * `shipped`/`delivered` have left the building, `returned`/`cancelled` were
 * called off and their goods went back on the shelf.
 *
 * Pure and store-free on purpose — the renderer lives in
 * `components/inventory/ShortagesReport.tsx`, and this half is what
 * `shortages.selfcheck.ts` runs.
 */

import { getActualStock } from "./product.ts";

/** Order states that still owe the customer goods. */
const OPEN_STATUSES = new Set(["pending"]);

export interface ShortageRow {
  productId: string;
  productName: string;
  sku: string;
  variantName?: string;
  allocated?: number;
  /** On the shelf right now. */
  stock: number;
  /** Everything open orders have promised — context, not the deficit. */
  required: number;
  /** Units to buy or manufacture. Always > 0 for a row that appears. */
  deficit: number;
  /** How many open orders are waiting on it. */
  orderCount: number;
  /**
   * WHICH orders are waiting, so the owner can ring the customers whose goods
   * this توريد is for instead of just seeing that "4" of something is late.
   * Newest-known order last; the renderer decides how many to show.
   */
  waitingOrders: { orderId: string; orderNumber: string; customerName: string; customerPhone?: string; requested?: number; allocated?: number; missing?: number }[];
}

/**
 * What this line could not cover when it was taken.
 *
 * The `?? backorder && quantity` fallback is for order documents flagged as
 * نواقص before `shortfall` was recorded on them. It is the old, overstated
 * number — but a flagged line with no measurement is genuinely short by an
 * unknown amount, and the line quantity is the only conservative answer.
 */
function shortfallOf(line: any): number {
  const measured = Number(line?.shortfall);
  if (Number.isFinite(measured)) return Math.max(0, measured);
  const quantity = Number(line?.quantity);
  return line?.backorder && Number.isFinite(quantity) ? Math.max(0, quantity) : 0;
}

function computeLegacyShortages(orders: any[], products: any[]): ShortageRow[] {
  const owed = new Map<string, number>();
  const required = new Map<string, number>();
  // Keyed by order id so two lines of the same product on one order count the
  // customer once, and ordered by insertion so the list is stable across
  // renders rather than reshuffling on every recompute.
  const waiting = new Map<string, Map<string, { orderId: string; orderNumber: string; customerName: string }>>();

  for (const order of orders) {
    if (!OPEN_STATUSES.has(String(order?.status))) continue;
    // Bundles are already broken into the products that leave the shelf in
    // `stockItems` — a box of three is three units to make, not one. `items`
    // is the fallback for order documents written before that field existed.
    const lines = (order?.stockItems?.length ? order.stockItems : order?.items) ?? [];
    for (const line of lines) {
      const id = line?.productId;
      const quantity = Number(line?.quantity);
      // Return lines ride as negatives. They reduce demand, never create it.
      if (!id || !Number.isFinite(quantity) || quantity <= 0) continue;

      required.set(id, (required.get(id) ?? 0) + quantity);
      if (!waiting.has(id)) waiting.set(id, new Map());
      waiting.get(id)!.set(String(order.id), {
        orderId: String(order.id),
        // An order document written before `orderNumber` existed still has to
        // be identifiable, so fall back to the id rather than showing blank.
        orderNumber: String(order.orderNumber ?? order.id ?? "—"),
        customerName: String(order.customerName ?? "—"),
      });

      const short = shortfallOf(line);
      if (short > 0) owed.set(id, (owed.get(id) ?? 0) + short);
    }
  }

  const byId = new Map(products.map((p) => [p.id, p]));
  const rows: ShortageRow[] = [];

  for (const [productId, owedQty] of owed) {
    const product = byId.get(productId);
    const stock = getActualStock(product);
    const deficit = owedQty - stock;
    if (deficit <= 0) continue;
    rows.push({
      productId,
      productName: product?.name ?? productId,
      sku: product?.sku ?? "—",
      stock,
      required: required.get(productId) ?? owedQty,
      deficit,
      orderCount: waiting.get(productId)?.size ?? 0,
      waitingOrders: [...(waiting.get(productId)?.values() ?? [])],
    });
  }

  // Worst first — the owner acts top-down.
  return rows.sort((a, b) => b.deficit - a.deficit);
}

/** New forward rows carry CURRENT allocated/missing, not a historical floor.
 * Keep legacy projections isolated; never subtract today's ATP from a saved
 * authoritative missing quantity or interpret BLUE as supply for RED. */
export function computeShortages(orders: any[], products: any[]): ShortageRow[] {
  const live = orders.filter(o => !o.deleted_at);
  const rows = computeLegacyShortages(live.filter(o => !o.fulfillment), products);
  const grouped = new Map<string, ShortageRow>();
  const catalog = new Map(products.map(p => [p.id, p]));
  for (const order of live) {
    if (order.status !== "pending" || order.fulfillment?.version !== 1) continue;
    for (const d of order.fulfillment.demands ?? []) {
      const key = JSON.stringify([d.productId, d.variantName || ""]);
      const product = catalog.get(d.productId);
      let row = grouped.get(key);
      if (!row) {
        const variantStock = product?.metadata?.variants?.find((v: any) => v.name === d.variantName)?.stock;
        row = { productId: d.productId, productName: `${product?.name ?? d.productName ?? d.productId}${d.variantName ? ` — ${d.variantName}` : ""}`,
          sku: product?.sku ?? "—", variantName: d.variantName,
          stock: d.variantName ? Number(variantStock ?? 0) : getActualStock(product),
          required: 0, allocated: 0, deficit: 0, orderCount: 0, waitingOrders: [] };
        grouped.set(key, row);
      }
      row.required += Number(d.quantity);
      row.allocated = (row.allocated ?? 0) + Number(d.allocated);
      row.deficit += Number(d.missing);
      const waiting = row.waitingOrders.find(w => w.orderId === order.id);
      if (waiting) {
        waiting.requested = (waiting.requested ?? 0) + Number(d.quantity);
        waiting.allocated = (waiting.allocated ?? 0) + Number(d.allocated);
        waiting.missing = (waiting.missing ?? 0) + Number(d.missing);
      } else row.waitingOrders.push({ orderId: order.id, orderNumber: order.orderNumber ?? order.id,
        customerName: order.customerName ?? "—", customerPhone: order.customerPhone,
        requested: Number(d.quantity), allocated: Number(d.allocated), missing: Number(d.missing) });
      row.orderCount = row.waitingOrders.length;
    }
  }
  return [...rows, ...[...grouped.values()].filter(r => r.deficit > 0)].sort((a, b) => b.deficit - a.deficit);
}
