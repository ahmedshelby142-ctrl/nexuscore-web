import { getSupabaseClient } from "@/lib/supabase";
import { fromRemoteRow } from "@/services/api/fieldMapping";
import { balanceOf } from "@/lib/ledger";
import { buildableFromRecipe, variantStockFrom } from "@/lib/product";
import { mobileVisibilityFor } from "@/mobile/navigation/mobileVisibility";
import { useAuthStore } from "@/store/useAuthStore";
import { formatArabicCurrency } from "@/mobile/viewmodels/formatters";

export const MOBILE_PAGE_SIZE = 25;

export interface MobilePage<T> {
  rows: T[];
  total: number | null;
  hasMore: boolean;
}

export interface MobileListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  queue?: "action" | "today" | "all";
  customerId?: string;
  id?: string;
  /** ISO timestamp: only orders created strictly before it. */
  createdBefore?: string;
  /** ISO timestamp: only orders created at or after it. */
  createdFrom?: string;
}

function escapeLike(value: string): string {
  return value.replace(/[%,()]/g, " ").trim();
}

function clientOrThrow() {
  const client = getSupabaseClient();
  if (!client) throw new Error("لا يوجد اتصال بالسحابة");
  return client;
}

async function readPage<T>(
  table: string,
  query: MobileListQuery,
  configure: (builder: any) => any,
  map: (row: any) => T,
  columns = "*",
  source = table,
): Promise<MobilePage<T>> {
  const client = clientOrThrow();
  const pageSize = Math.min(Math.max(query.pageSize ?? MOBILE_PAGE_SIZE, 1), 100);
  const page = Math.max(query.page ?? 0, 0);
  const from = page * pageSize;
  const to = from + pageSize - 1;
  // Soft-deleted rows are not rows. `mobile_shortages` and every desktop
  // reader exclude them; this did not, so a deleted order stayed on the phone
  // — and stayed in the phone's `count` — after the desktop removed it.
  let builder = client.from(source).select(columns, { count: "exact" }).is("deleted_at", null);
  builder = configure(builder).range(from, to);
  const { data, count, error } = await builder;
  if (error) throw new Error(`[${table}] ${error.message}`);
  const rows = (data ?? []).map((row: any) => map(fromRemoteRow(table, row)));
  // `rows.length === pageSize` offered "تحميل المزيد" whenever the total was an
  // exact multiple of the page size, and the next page came back empty. The
  // exact count already knows whether anything follows, so ask it.
  const total = count ?? null;
  const hasMore = total === null ? rows.length === pageSize : from + rows.length < total;
  return { rows, total, hasMore };
}

// ── What a mobile order read may carry ─────────────────────────────────────
//
// `select("*")` sent every order's `cogsAmount` — what the goods COST — to
// every role, the Moderator included, although no mobile screen shows it.
// The order columns are listed instead. `courierFee` (the store's delivery
// cost, «عمولة المندوب») rides along only for roles that may see cost, and
// line `unitCost` is dropped from `items`/`stockItems` for the rest.
//
// The database enforces the same thing (047/048): these columns are read
// from `orders_operational`, which withholds cost from a Moderator itself, and
// a Moderator cannot select `orders` at all. This keeps the app's own state
// minimal on top of that.
const ORDER_COLUMNS = [
  "id", "orderNumber", "customerName", "customerPhone", "address", "governorate", "city",
  "items", "stockItems", "totalAmount", "shippingFee", "paymentMethod", "depositAmount",
  "depositWallet", "expectedCod", "discountAmount", "discountCodeId", "status", "courierId",
  "courierName", "createdAt", "updatedAt", "updated_at", "revenueLogged", "customerId",
  "codSettledAt", "returnConfirmedAt", "returnType", "return_cause", "isExchange",
  "original_order_id", "wholesaleClientId", "shippingPenaltyApplied", "store_id", "deleted_at",
  // 054: customer-facing (not a cost), exposed by `orders_operational` to every member.
  "wastedTripCompensation",
].join(",");

/**
 * Where Mobile reads orders: `orders_operational` (migration 047), the same
 * rows as `orders` for any member of the store, with `cogsAmount` absent and —
 * for a role without finance — `courierFee` and line `unitCost` withheld BY THE
 * DATABASE. Since 048 a Moderator cannot select `orders` at all. Desktop and
 * every write still use `orders`.
 */
const ORDERS_SOURCE = "orders_operational";

/**
 * A product's shelf, as this viewer may know it.
 *
 * Roles with finance read the ledger balance — quantity AND the cost of what
 * is on the shelf — exactly as before. A Moderator cannot read the ledger
 * (048); it asks `mobile_stock_quantities`, which returns the same quantity
 * the ledger reports and no money.
 */
async function stockOf(productId: string): Promise<{ qty: number; amount?: number }> {
  if (viewerSeesCost()) return balanceOf("stock", productId);
  const { data, error } = await clientOrThrow().rpc("mobile_stock_quantities", { p_product_ids: [productId] });
  if (error) throw new Error(`[mobile_stock_quantities] ${error.message}`);
  const row = (data ?? [])[0] as { qty?: number | string } | undefined;
  return { qty: Number(row?.qty ?? 0) || 0 };
}

function viewerSeesCost(): boolean {
  return mobileVisibilityFor(useAuthStore.getState().userRole).cost;
}

function orderColumns(): string {
  return viewerSeesCost() ? `${ORDER_COLUMNS},courierFee` : ORDER_COLUMNS;
}

function withoutLineCost(lines: unknown): unknown {
  if (!Array.isArray(lines)) return lines;
  return lines.map((line) => {
    if (!line || typeof line !== "object") return line;
    const { unitCost: _unitCost, ...rest } = line as Record<string, unknown>;
    return rest;
  });
}

/** An order row as this viewer may hold it. */
export function toViewerOrder(row: any): any {
  if (!row || viewerSeesCost()) return row;
  return { ...row, items: withoutLineCost(row.items), stockItems: withoutLineCost(row.stockItems) };
}

/** The Orders filters, ONE definition — the list and its count-only twin both apply it. */
function ordersFilter(query: MobileListQuery) {
  const search = escapeLike(query.search ?? "");
  return (builder: any) => {
    let next = builder.order("createdAt", { ascending: false }).order("id", { ascending: false });
    if (query.id) next = next.eq("id", query.id);
    if (query.status && query.status !== "all") next = next.eq("status", query.status);
    if (query.customerId) next = next.eq("customerId", query.customerId);
    if (query.queue === "action") next = next.eq("status", "pending");
    if (query.queue === "today") {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      next = next.gte("createdAt", start.toISOString());
    }
    if (query.createdFrom) next = next.gte("createdAt", query.createdFrom);
    if (query.createdBefore) next = next.lt("createdAt", query.createdBefore);
    if (search) next = next.or(`orderNumber.ilike.%${search}%,customerName.ilike.%${search}%,customerPhone.ilike.%${search}%`);
    return next;
  };
}

export function readMobileOrders(query: MobileListQuery = {}) {
  return readPage("orders", query, ordersFilter(query), toViewerOrder, orderColumns(), ORDERS_SOURCE);
}

/**
 * How many orders match — the same filters as `readMobileOrders`, no rows.
 *
 * Home's counters used `readMobileOrders({ pageSize: 1 })` and kept only
 * `.total`, so each one downloaded a full order (36 columns, line items
 * included) to read one number. A HEAD request with an exact count returns
 * the number alone. Same source, same soft-delete rule, same RLS.
 */
export async function countMobileOrders(query: MobileListQuery = {}): Promise<number | null> {
  const builder = ordersFilter(query)(
    clientOrThrow().from(ORDERS_SOURCE).select("id", { count: "exact", head: true }).is("deleted_at", null),
  );
  const { count, error } = await builder;
  if (error) throw new Error(`[orders] ${error.message}`);
  return count ?? null;
}

export async function readMobileCustomers(query: MobileListQuery = {}) {
  const search = escapeLike(query.search ?? "");
  const page = await readPage("customers", query, (builder) => {
    let next = builder.order("updated_at", { ascending: false }).order("id", { ascending: false });
    if (search) next = next.or(`name.ilike.%${search}%,phone.ilike.%${search}%,address.ilike.%${search}%`);
    return next;
  }, (row) => row);

  // `orderCount` and `lastOrderAt` are NOT columns on `customers` — the table
  // holds only id, name, phone, address, tenancy and returned_orders_count.
  // The view model read them anyway, so every customer rendered
  // "لا يوجد طلب سابق", including one with 28 orders behind her. The orders
  // themselves are the authority for how many orders there are, so ask them —
  // once for the whole page, not once per row.
  const ids = page.rows.map((c: any) => String(c.id)).filter(Boolean);
  if (ids.length === 0) return page;

  const { data, error } = await clientOrThrow()
    .from(ORDERS_SOURCE)
    .select("customerId, createdAt")
    .in("customerId", ids)
    .is("deleted_at", null);
  // A failed count is not "0 orders": it used to render every customer on the
  // page as «لا يوجد طلب سابق».
  if (error) throw new Error(`[orders] ${error.message}`);

  const counts = new Map<string, { orderCount: number; lastOrderAt: string | null }>();
  for (const row of (data ?? []) as any[]) {
    const id = String(row.customerId ?? "");
    if (!id) continue;
    const seen = counts.get(id) ?? { orderCount: 0, lastOrderAt: null };
    seen.orderCount += 1;
    if (!seen.lastOrderAt || String(row.createdAt) > seen.lastOrderAt) {
      seen.lastOrderAt = String(row.createdAt);
    }
    counts.set(id, seen);
  }

  return {
    ...page,
    rows: page.rows.map((c: any) => ({
      ...c,
      ...(counts.get(String(c.id)) ?? { orderCount: 0, lastOrderAt: null }),
    })),
  };
}

/**
 * WHO the couriers are — the registry table, the same one desktop's
 * `useCourierStore` and `CourierSelect` write and read.
 *
 * Mobile had no reader for this at all and rendered `order.courierName`, a
 * free-text field. In QA-STORE that means 8 orders showing a courier that is
 * not a registry entity (`courierId = "default"`, the legacy bucket) and 3
 * showing a typed name with no id — three "couriers" whose money can never be
 * settled against one account. Identity is `courierId`; the name is a label.
 */
export async function readMobileCouriers(): Promise<Map<string, { id: string; name: string; phone: string | null }>> {
  const { data, error } = await clientOrThrow()
    .from("couriers")
    .select("id, name, phone")
    .is("deleted_at", null);
  if (error) throw new Error(`[couriers] ${error.message}`);
  return new Map(
    (data ?? []).map((c: any) => [String(c.id), { id: String(c.id), name: String(c.name ?? ""), phone: c.phone ?? null }]),
  );
}

export function readMobileShipments(query: MobileListQuery = {}) {
  const search = escapeLike(query.search ?? "");
  return readPage("orders", query, (builder) => {
    let next = builder.in("status", ["pending", "shipped", "delivered"]).order("updatedAt", { ascending: false }).order("id", { ascending: false });
    if (query.status === "ready") next = next.eq("status", "pending");
    if (query.status === "shipped") next = next.eq("status", "shipped");
    if (query.status === "delivered") next = next.eq("status", "delivered");
    if (search) next = next.or(`orderNumber.ilike.%${search}%,customerName.ilike.%${search}%,courierName.ilike.%${search}%`);
    return next;
  }, toViewerOrder, orderColumns(), ORDERS_SOURCE);
}

/**
 * فواتير المشتريات — the read side of a write mobile already performs.
 *
 * `commitReceipt` has written `purchase_invoices` from the phone since توريد
 * سريع shipped; nothing on the phone could read them back, which is the "➖
 * written ✅, not read" line in the persona architecture's Owner table.
 *
 * Newest first, because the question a purchasing screen answers on a phone is
 * "did that receipt land, and what do I still owe on it" — not "show me the
 * history from the beginning".
 *
 * `status` is the DOCUMENT's own paid/partial/unpaid, written by `commitReceipt`
 * from what was actually handed over. It is not recomputed here: the desktop
 * purchasing table reads the same column, and a second opinion about whether an
 * invoice is settled is exactly the kind of divergence this codebase keeps
 * deleting.
 */
export function readMobilePurchaseInvoices(query: MobileListQuery = {}) {
  const search = escapeLike(query.search ?? "");
  return readPage("purchase_invoices", query, (builder) => {
    let next = builder
      .order("createdAt", { ascending: false })
      .order("id", { ascending: false });
    if (query.id) next = next.eq("id", query.id);
    // "آجل" on the segmented control means anything still owed — partial counts.
    if (query.status === "unpaid") next = next.neq("status", "paid");
    if (query.status === "paid") next = next.eq("status", "paid");
    if (search) {
      next = next.or(`invoiceNumber.ilike.%${search}%,supplierName.ilike.%${search}%`);
    }
    return next;
  }, (row) => row);
}

export async function readMobileProducts(query: MobileListQuery = {}) {
  const page = await readPage("products", query, (builder) => {
    const search = escapeLike(query.search ?? "");
    let next = builder.order("name", { ascending: true }).order("id", { ascending: true });
    if (query.id) next = next.eq("id", query.id);
    if (search) next = next.or(`name.ilike.%${search}%,sku.ilike.%${search}%,barcode.ilike.%${search}%,category.ilike.%${search}%`);
    return next;
  }, (row) => row);

  // Product.quantity is intentionally never read. Each visible product gets
  // its current quantity and weighted cost from the existing ledger authority.
  //
  // A بوكس is the exception, and showing it raw was misleading: a bundle owns
  // no shelf, so `balanceOf("stock", bundleId)` is legitimately 0 and the
  // screen read "0 in stock" for a box whose components were sitting there.
  // Availability for a box is how many are BUILDABLE — the same
  // `buildableFromRecipe` rule desktop uses, fed from the ledger instead of
  // from hydrated product records.
  const rows = await Promise.all(page.rows.map(async (product: any) => {
    const stockBalance = await stockOf(String(product.id));
    const recipe = product?.isBundle ? (product.bundleItems ?? product.metadata?.bundleItems) : null;

    if (!recipe?.length) {
      return {
        ...product,
        // Floored, exactly as `getActualStock` floors it on desktop: a ledger
        // that has drifted negative is a reconciliation problem, and
        // "المتاح: ؜-٢" is not a thing an operator may ever be shown. What is
        // genuinely owed lives in تقرير النواقص, which is signed on purpose.
        mobileStock: Math.max(0, stockBalance.qty),
        // The shelf's COST. Held only for roles that may see it.
        mobileCost: viewerSeesCost() ? stockBalance.amount : undefined,
        mobileIsBundle: false,
      };
    }

    // A recipe may pin a درجة ("احمر"), and a بوكس that needs the red one
    // cannot be built out of the blue ones. The ledger keeps ONE quantity per
    // product — there are no per-درجة lines — so the split can only come from
    // the product record, clamped to the ledger total. That clamp is
    // `variantStockFrom`, the same function `getVariantStock` uses on desktop:
    // one formula, two sources of "how much is there", which is the split the
    // helper was factored out for.
    const componentProducts = new Map<string, any>();
    const componentStock = new Map<string, number>();
    await Promise.all(
      recipe.map(async (c: any) => {
        const id = String(c.productId);
        if (componentStock.has(id)) return;
        const [b, row] = await Promise.all([
          stockOf(id),
          readMobileRawProduct(id),
        ]);
        componentStock.set(id, Math.max(0, b.qty));
        componentProducts.set(id, row);
      }),
    );

    return {
      ...product,
      mobileStock: buildableFromRecipe(recipe, (id, variantName) =>
        variantStockFrom(
          componentProducts.get(String(id)),
          variantName,
          componentStock.get(String(id)) ?? 0,
        ),
      ),
      // The ledger holds no value for a virtual product; the cost of a box is
      // its components', derived at the moment of a movement, never stored.
      mobileCost: 0,
      mobileIsBundle: true,
    };
  }));
  return { ...page, rows };
}

export async function readMobileOrder(id: string) {
  const page = await readMobileOrders({ id, pageSize: 1 });
  return page.rows[0] ?? null;
}

export async function readMobileCustomer(id: string) {
  return (await readPage("customers", { pageSize: 1 }, (builder) => builder.eq("id", id), (row) => row)).rows[0] ?? null;
}

export async function readMobileProduct(id: string) {
  return (await readMobileProducts({ pageSize: 1, search: undefined, id })).rows[0] ?? null;
}

/**
 * One product row, untouched — no ledger attached.
 *
 * Deliberately NOT `readMobileProduct`: that one attaches stock, and calling it
 * for each bundle component would recurse through the bundle resolver. This is
 * only ever the source of `metadata.variants`, the درجة mirror.
 *
 * Cached for the life of the tab. A recipe's components repeat across boxes and
 * across pages, and the mirror does not move between two renders of one list.
 */
const rawProductCache = new Map<string, Promise<any>>();
export function readMobileRawProduct(id: string): Promise<any> {
  const hit = rawProductCache.get(id);
  if (hit) return hit;
  const request = (async () => {
    try {
      const { data, error } = await clientOrThrow()
        .from("products")
        .select("id, name, sku, metadata")
        .eq("id", id)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw error;
      return data ? fromRemoteRow("products", data) : null;
    } catch {
      // Not cached: a transient failure must not pin `null` for the tab's life.
      rawProductCache.delete(id);
      return null;
    }
  })();
  rawProductCache.set(id, request);
  return request;
}

export interface MobileOrderTimelineEvent {
  id: string;
  labelAr: string;
  timestamp: string;
  status: string;
  source: string;
  relatedEntity?: { id: string; type: "order" | "shipment" | "courier" | "return" | "payment" };
}

/**
 * What each order-scoped ledger kind is called on a timeline, in Arabic.
 *
 * The keys are the `EventKind`s that `lib/ledger/orders.ts` and
 * `lib/ledger/sales.ts` actually append against `ref_type = "ecommerce_order"`
 * — verified against the live `ledger_events` table, not against a wish list.
 */
const TIMELINE_LABELS: Record<string, { labelAr: string; entity: "order" | "shipment" | "courier" | "return" | "payment" }> = {
  order_placed: { labelAr: "تم إنشاء الطلب", entity: "order" },
  sale: { labelAr: "تم تسجيل البيع", entity: "order" },
  order_edited: { labelAr: "تم تعديل الطلب", entity: "order" },
  order_delivered: { labelAr: "تم التسليم للعميل", entity: "shipment" },
  order_returned_pending: { labelAr: "مرتجع في الطريق (لم يصل المخزن بعد)", entity: "return" },
  return_confirmed: { labelAr: "تأكد استلام المرتجع في المخزن", entity: "return" },
  rto_confirmed: { labelAr: "رفض الاستلام (مرتجع شحن)", entity: "return" },
  order_cancelled: { labelAr: "تم إلغاء الطلب", entity: "order" },
  courier_settlement: { labelAr: "توريد المندوب (استلمنا الكاش)", entity: "courier" },
  client_payment: { labelAr: "دفعة من العميل", entity: "payment" },
  // تسوية العميلة on Desktop (038) — read-only here. Also what Order Details
  // reads the deposit's state from (`depositOutcome`).
  deposit_refunded: { labelAr: "العربون اترد للعميلة", entity: "payment" },
};

/**
 * One order's history, read from the LEDGER — the same authority Desktop uses.
 *
 * ## What this replaced, and why it was a 400 on every order
 *
 * This used to `select` `shippedAt, deliveredAt, returnedAt, cancelledAt` off
 * `orders`. None of those four columns exist on the deployed table — verified
 * against the live schema — so PostgREST refused the entire request with
 * `42703 column orders.shippedAt does not exist`, and the detail screen
 * printed that error string where the timeline should have been. Every order,
 * every time.
 *
 * The facts they were reaching for are not missing; they were never on the
 * order row. "Delivered" is an `order_delivered` event, "returned" is
 * `order_returned_pending` / `rto_confirmed`, "settled with the courier" is
 * `courier_settlement`. The ledger is append-only and stamps `occurred_at`, so
 * it is both the authority for WHETHER something happened and the only honest
 * answer for WHEN — a mutable column on the order can be overwritten, an event
 * cannot.
 *
 * `codSettledAt` and `returnConfirmedAt` ARE real columns; the detail screen
 * reads them for current state and this does not re-derive them.
 */
export async function readMobileOrderTimeline(orderId: string): Promise<MobileOrderTimelineEvent[]> {
  const client = clientOrThrow();

  const { data: order, error: orderError } = await client
    .from(ORDERS_SOURCE)
    .select("id, orderNumber, createdAt, courierId, depositAmount")
    .eq("id", orderId)
    .maybeSingle();

  if (orderError) throw new Error(`[orders] ${orderError.message}`);
  if (!order) return [];

  // The ledger's `ref_id` for an order is its ORDER NUMBER, not its uuid —
  // every writer in `OrdersPage`, `ecommerce-orders` and `returns` stamps
  // `refId: order.orderNumber`. Verified against `ledger_events` in the live
  // database, where the order rows read `ECO-…`, never a uuid. Asking with the
  // uuid returns nothing at all, which looks exactly like "this order has no
  // history" and is the quietest possible way to be wrong.
  const events = order.orderNumber ? await ledgerEventsFor(String(order.orderNumber)) : [];

  const timeline: MobileOrderTimelineEvent[] = [];

  for (const event of events) {
    const mapped = TIMELINE_LABELS[event.kind];
    if (!mapped) continue;
    timeline.push({
      id: event.id,
      labelAr: mapped.labelAr,
      timestamp: event.occurredAt,
      status: event.kind,
      source: "ledger_events",
      relatedEntity: {
        id: mapped.entity === "courier" ? String(order.courierId ?? order.id) : String(order.id),
        type: mapped.entity,
      },
    });
  }

  // The عربون is a fact about the DOCUMENT, taken at creation; it has no event
  // of its own because `order_placed` carries it inside its lines. Shown from
  // the column, which is where it actually lives.
  if (Number(order.depositAmount ?? 0) > 0 && order.createdAt) {
    timeline.push({
      id: `deposit-${order.id}`,
      labelAr: `عربون مدفوع: ${formatArabicCurrency(Number(order.depositAmount))}`,
      timestamp: order.createdAt,
      status: "deposit",
      source: "orders",
      relatedEntity: { id: String(order.id), type: "payment" },
    });
  }

  // An order with no ledger event yet is not an error — it is a document that
  // has moved nothing. Show its creation rather than an empty panel.
  if (timeline.length === 0 && order.createdAt) {
    timeline.push({
      id: `created-${order.id}`,
      labelAr: "تم إنشاء الطلب",
      timestamp: order.createdAt,
      status: "created",
      source: "orders",
      relatedEntity: { id: String(order.id), type: "order" },
    });
  }

  return timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

/**
 * This order's ledger events, by order NUMBER.
 *
 * An unreachable ledger costs the timeline, not the screen — but it must SAY
 * so. It used to answer `[]`, and the timeline then showed only «تم إنشاء
 * الطلب»: a delivered, settled order drawn as one nothing had happened to.
 * The detail screen reads this separately and renders its own retry.
 */
async function ledgerEventsFor(orderNumber: string): Promise<{ id: string; kind: string; occurredAt: string }[]> {
  // `mobile_order_timeline` (047): which lifecycle events happened and when —
  // no payload, no lines, no money — for every role, from the caller's own
  // store. A Moderator cannot read `ledger_events` since 048.
  const { data, error } = await clientOrThrow().rpc("mobile_order_timeline", { p_order_number: orderNumber });
  if (error) throw new Error(`[mobile_order_timeline] ${error.message}`);
  return ((data ?? []) as { id: string; kind: string; occurred_at: string }[]).map((e) => ({
    id: String(e.id),
    kind: String(e.kind),
    occurredAt: String(e.occurred_at),
  }));
}

export interface MobileProductWaitingOrder {
  orderId: string;
  orderNumber: string;
  customerName: string;
  quantity: number;
  status: string;
  createdAt: string;
}

export async function readMobileProductWaitingOrders(productId: string): Promise<MobileProductWaitingOrder[]> {
  const client = clientOrThrow();
  
  const { data: orders, error } = await client
    .from(ORDERS_SOURCE)
    .select("id, orderNumber, customerName, items, stockItems, status, createdAt")
    .eq("status", "pending")
    // A deleted order is waiting for nothing; `mobile_shortages` agrees.
    .is("deleted_at", null)
    .or(`items.cs.[{"productId":"${productId}"}],stockItems.cs.[{"productId":"${productId}"}]`);
  
  if (error) throw new Error(`[orders] ${error.message}`);
  if (!orders?.length) return [];
  
  const waiting: MobileProductWaitingOrder[] = [];
  
  for (const order of orders) {
    const lines = (order.stockItems?.length ? order.stockItems : order.items) ?? [];
    for (const line of lines) {
      if (line?.productId === productId && Number(line?.quantity ?? 0) > 0) {
        waiting.push({
          orderId: order.id,
          orderNumber: order.orderNumber ?? order.id,
          customerName: order.customerName ?? "—",
          quantity: Number(line.quantity),
          status: order.status,
          createdAt: order.createdAt,
        });
      }
    }
  }
  
  return waiting.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export interface MobileCustomerFinancialSummary {
  totalOrders: number;
  openOrders: number;
  deliveredOrders: number;
  returnedOrders: number;
  cancelledOrders: number;
  /** Null for a role without finance: not read, and not a zero. */
  deliveredRevenue: number | null;
  openExposure: number;
  wastedTrips: number;
}

/**
 * A customer's standing, read from the SAME authorities Desktop uses.
 *
 * ## What this replaced, and why it was wrong
 *
 * This reader used to add up `order.totalAmount` itself and count
 * `returnType === 'rto'` rows. Both contradicted the verified Core:
 *
 *   * **Lifetime value** is the `customer_ltv` ledger account. A confirmed
 *     return writes `customer_ltv −`, so a PARTIAL return — which leaves the
 *     order `delivered` with its full `totalAmount` intact — was counted in
 *     full by the old loop while the ledger had already taken it off.
 *
 *   * **Wasted trips** are `customers.returned_orders_count`, which is a DEBT,
 *     not a history. It only rises when `countsAsWastedTrip(cause, movement)`
 *     holds — the customer caused it and it was not an exchange — and it FALLS
 *     when a penalised delivery settles it. Counting `rto` rows ignored the
 *     cause entirely and never decreased, so after a paydown Desktop read 0
 *     while mobile still read 1.
 *
 * Order counts stay derived from the orders themselves: those are document
 * facts, not money, and the documents are their own authority.
 */
export async function readMobileCustomerFinancialSummary(customerId: string): Promise<MobileCustomerFinancialSummary> {
  const client = clientOrThrow();

  const [{ data: orders, error }, ltv, customerRead] = await Promise.all([
    client
      .from(ORDERS_SOURCE)
      .select("id, status, expectedCod, customerId, customerPhone")
      .or(`customerId.eq.${customerId},customerPhone.eq.${customerId}`)
      // Same population as the order history below it, which already
      // excluded deleted orders — the two sections disagreed on the count.
      .is("deleted_at", null),
    // The ledger's own answer. Returns have already been deducted from it.
    // NOT caught: a failed ledger read used to become «٠ ج.م.» lifetime value,
    // a money zero nobody measured. The screen renders an error + retry.
    // A Moderator cannot read the ledger (048), and a customer's lifetime
    // revenue is not operational — it is not asked for, rather than shown as 0.
    viewerSeesCost() ? balanceOf("customer_ltv", customerId) : Promise.resolve(null),
    client
      .from("customers")
      .select("returned_orders_count")
      .eq("id", customerId)
      .maybeSingle(),
  ]);

  if (error) throw new Error(`[orders] ${error.message}`);
  if (customerRead.error) throw new Error(`[customers] ${customerRead.error.message}`);
  const customer = customerRead.data as { returned_orders_count?: number } | null;

  const statusCounts: Record<string, number> = {
    pending: 0, shipped: 0, delivered: 0, returned: 0, cancelled: 0,
  };
  let openExposure = 0;

  for (const order of orders ?? []) {
    if (statusCounts[order.status] !== undefined) statusCounts[order.status]++;
    if (["pending", "shipped"].includes(order.status)) {
      openExposure += Number(order.expectedCod ?? 0);
    }
  }

  return {
    totalOrders: orders?.length ?? 0,
    openOrders: statusCounts.pending + statusCounts.shipped,
    deliveredOrders: statusCounts.delivered,
    returnedOrders: statusCounts.returned,
    cancelledOrders: statusCounts.cancelled,
    // `customer_ltv`, net of every confirmed return — the Desktop authority.
    deliveredRevenue: ltv === null ? null : Math.max(0, Number(ltv?.amount ?? 0)),
    openExposure,
    // The shipping DEBT, which settles back down. Never a count of returns.
    wastedTrips: Math.max(0, Number(customer?.returned_orders_count ?? 0)),
  };
}

export async function readMobileCustomerOrderHistory(customerId: string, page = 0, pageSize = 25): Promise<{ rows: any[]; total: number | null; hasMore: boolean }> {
  return readPage("orders", { page, pageSize, customerId }, (builder) => {
    let next = builder.order("createdAt", { ascending: false }).order("id", { ascending: false });
    if (customerId) next = next.eq("customerId", customerId);
    return next;
  }, toViewerOrder, orderColumns(), ORDERS_SOURCE);
}

/**
 * Search products for mobile quick restock selection.
 * Returns products with current stock from ledger for immediate display.
 */
export async function readMobileProductsForRestock(query: MobileListQuery = {}): Promise<MobilePage<any>> {
  const page = await readPage("products", query, (builder) => {
    const search = escapeLike(query.search ?? "");
    let next = builder.order("name", { ascending: true }).order("id", { ascending: true });
    if (query.id) next = next.eq("id", query.id);
    if (search) next = next.or(`name.ilike.%${search}%,sku.ilike.%${search}%,barcode.ilike.%${search}%,category.ilike.%${search}%`);
    return next;
  }, (row) => row);

  // Attach current stock from ledger for each product
  const rows = await Promise.all(page.rows.map(async (product: any) => {
    const stockBalance = await stockOf(String(product.id));
    return { ...product, mobileStock: Math.max(0, stockBalance.qty), mobileCost: viewerSeesCost() ? stockBalance.amount : undefined };
  }));
  return { ...page, rows };
}