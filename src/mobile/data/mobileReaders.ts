import { getSupabaseClient } from "@/lib/supabase";
import { fromRemoteRow } from "@/services/api/fieldMapping";
import { balanceOf } from "@/lib/ledger";

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
): Promise<MobilePage<T>> {
  const client = clientOrThrow();
  const pageSize = Math.min(Math.max(query.pageSize ?? MOBILE_PAGE_SIZE, 1), 100);
  const page = Math.max(query.page ?? 0, 0);
  const from = page * pageSize;
  const to = from + pageSize - 1;
  let builder = client.from(table).select("*", { count: "exact" });
  builder = configure(builder).range(from, to);
  const { data, count, error } = await builder;
  if (error) throw new Error(`[${table}] ${error.message}`);
  const rows = (data ?? []).map((row: any) => map(fromRemoteRow(table, row)));
  return { rows, total: count ?? null, hasMore: rows.length === pageSize };
}

export function readMobileOrders(query: MobileListQuery = {}) {
  const search = escapeLike(query.search ?? "");
  return readPage("orders", query, (builder) => {
    let next = builder.order("createdAt", { ascending: false }).order("id", { ascending: false });
    if (query.id) next = next.eq("id", query.id);
    if (query.status && query.status !== "all") next = next.eq("status", query.status);
    if (query.customerId) next = next.eq("customerId", query.customerId);
    if (query.queue === "action") next = next.in("status", ["pending", "processing"]);
    if (query.queue === "today") {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      next = next.gte("createdAt", start.toISOString());
    }
    if (search) next = next.or(`orderNumber.ilike.%${search}%,customerName.ilike.%${search}%,customerPhone.ilike.%${search}%`);
    return next;
  }, (row) => row);
}

export function readMobileCustomers(query: MobileListQuery = {}) {
  const search = escapeLike(query.search ?? "");
  return readPage("customers", query, (builder) => {
    let next = builder.order("updated_at", { ascending: false }).order("id", { ascending: false });
    if (search) next = next.or(`name.ilike.%${search}%,phone.ilike.%${search}%,address.ilike.%${search}%`);
    return next;
  }, (row) => row);
}

export function readMobileShipments(query: MobileListQuery = {}) {
  const search = escapeLike(query.search ?? "");
  return readPage("orders", query, (builder) => {
    let next = builder.in("status", ["processing", "shipped", "delivered"]).order("updatedAt", { ascending: false }).order("id", { ascending: false });
    if (query.status === "ready") next = next.eq("status", "processing");
    if (query.status === "shipped") next = next.eq("status", "shipped");
    if (query.status === "delivered") next = next.eq("status", "delivered");
    if (search) next = next.or(`orderNumber.ilike.%${search}%,customerName.ilike.%${search}%,courierName.ilike.%${search}%`);
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
  const rows = await Promise.all(page.rows.map(async (product: any) => {
    const stockBalance = await balanceOf("stock", String(product.id));
    return { ...product, mobileStock: stockBalance.qty, mobileCost: stockBalance.amount };
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

export interface MobileOrderTimelineEvent {
  id: string;
  labelAr: string;
  timestamp: string;
  status: string;
  source: string;
  relatedEntity?: { id: string; type: "order" | "shipment" | "courier" | "return" | "payment" };
}

export async function readMobileOrderTimeline(orderId: string): Promise<MobileOrderTimelineEvent[]> {
  const client = clientOrThrow();
  
  const { data: order, error: orderError } = await client
    .from("orders")
    .select("id, orderNumber, status, createdAt, updatedAt, shippedAt, deliveredAt, returnedAt, cancelledAt, returnConfirmedAt, courierName, courierId, depositAmount, expectedCod, revenueLogged, codSettledAt, returnType, isExchange")
    .eq("id", orderId)
    .single();
  
  if (orderError) throw new Error(`[orders] ${orderError.message}`);
  if (!order) return [];
  
  const events: MobileOrderTimelineEvent[] = [];
  
  if (order.createdAt) {
    events.push({
      id: `created-${order.id}`,
      labelAr: "تم إنشاء الطلب",
      timestamp: order.createdAt,
      status: "created",
      source: "orders",
      relatedEntity: { id: order.id, type: "order" },
    });
  }
  
  if (order.shippedAt) {
    events.push({
      id: `shipped-${order.id}`,
      labelAr: "سُلِّم للمندوب",
      timestamp: order.shippedAt,
      status: "shipped",
      source: "orders",
      relatedEntity: { id: order.courierId ?? order.id, type: "courier" },
    });
  }
  
  if (order.deliveredAt) {
    events.push({
      id: `delivered-${order.id}`,
      labelAr: "تم التسليم للعميل",
      timestamp: order.deliveredAt,
      status: "delivered",
      source: "orders",
      relatedEntity: { id: order.id, type: "shipment" },
    });
  }
  
  if (order.returnedAt) {
    events.push({
      id: `returned-${order.id}`,
      labelAr: order.returnType === "rto" ? "رفض الاستلام (مرتجع شحن)" : "مرتجع من العميل",
      timestamp: order.returnedAt,
      status: "returned",
      source: "orders",
      relatedEntity: { id: order.id, type: "return" },
    });
  }
  
  if (order.returnConfirmedAt) {
    events.push({
      id: `return-confirmed-${order.id}`,
      labelAr: "تأكد استلام المرتجع في المخزن",
      timestamp: order.returnConfirmedAt,
      status: "return_confirmed",
      source: "orders",
      relatedEntity: { id: order.id, type: "return" },
    });
  }
  
  if (order.cancelledAt) {
    events.push({
      id: `cancelled-${order.id}`,
      labelAr: "تم إلغاء الطلب",
      timestamp: order.cancelledAt,
      status: "cancelled",
      source: "orders",
      relatedEntity: { id: order.id, type: "order" },
    });
  }
  
  if (order.depositAmount && order.depositAmount > 0) {
    events.push({
      id: `deposit-${order.id}`,
      labelAr: `عربون مدفوع: ${Number(order.depositAmount).toLocaleString("ar-EG")} ج.م.`,
      timestamp: order.createdAt,
      status: "deposit",
      source: "orders",
      relatedEntity: { id: order.id, type: "payment" },
    });
  }
  
  if (order.codSettledAt) {
    events.push({
      id: `cod-settled-${order.id}`,
      labelAr: "توريد المندوب (استلمنا الكاش)",
      timestamp: order.codSettledAt,
      status: "cod_settled",
      source: "orders",
      relatedEntity: { id: order.courierId ?? order.id, type: "courier" },
    });
  }
  
  if (order.revenueLogged && order.deliveredAt) {
    events.push({
      id: `revenue-${order.id}`,
      labelAr: "سُجِّل الإيراد وتكلفة البضاعة",
      timestamp: order.deliveredAt,
      status: "revenue_logged",
      source: "orders",
      relatedEntity: { id: order.id, type: "order" },
    });
  }
  
  return events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
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
    .from("orders")
    .select("id, orderNumber, customerName, items, stockItems, status, createdAt")
    .in("status", ["pending", "processing"])
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
  deliveredRevenue: number;
  openExposure: number;
  wastedTrips: number;
}

export async function readMobileCustomerFinancialSummary(customerId: string): Promise<MobileCustomerFinancialSummary> {
  const client = clientOrThrow();
  
  const { data: orders, error } = await client
    .from("orders")
    .select("id, status, totalAmount, expectedCod, depositAmount, revenueLogged, returnType, customerId, customerPhone, createdAt")
    .or(`customerId.eq.${customerId},customerPhone.eq.${customerId}`);
  
  if (error) throw new Error(`[orders] ${error.message}`);
  if (!orders?.length) {
    return { totalOrders: 0, openOrders: 0, deliveredOrders: 0, returnedOrders: 0, cancelledOrders: 0, deliveredRevenue: 0, openExposure: 0, wastedTrips: 0 };
  }
  
  let deliveredRevenue = 0;
  let openExposure = 0;
  let wastedTrips = 0;
  const statusCounts: Record<string, number> = { pending: 0, processing: 0, shipped: 0, delivered: 0, returned: 0, cancelled: 0 };
  
  for (const order of orders) {
    const status = order.status;
    if (statusCounts[status] !== undefined) statusCounts[status]++;
    
    if (status === "delivered" && order.revenueLogged) {
      deliveredRevenue += Number(order.totalAmount ?? 0);
    }
    if (["pending", "processing", "shipped"].includes(status)) {
      openExposure += Number(order.expectedCod ?? 0);
    }
    if (order.returnType === "rto") {
      wastedTrips++;
    }
  }
  
  return {
    totalOrders: orders.length,
    openOrders: (statusCounts.pending ?? 0) + (statusCounts.processing ?? 0) + (statusCounts.shipped ?? 0),
    deliveredOrders: statusCounts.delivered ?? 0,
    returnedOrders: statusCounts.returned ?? 0,
    cancelledOrders: statusCounts.cancelled ?? 0,
    deliveredRevenue,
    openExposure,
    wastedTrips,
  };
}

export async function readMobileCustomerOrderHistory(customerId: string, page = 0, pageSize = 25): Promise<{ rows: any[]; total: number | null; hasMore: boolean }> {
  return readPage("orders", { page, pageSize, customerId }, (builder) => {
    let next = builder.order("createdAt", { ascending: false }).order("id", { ascending: false });
    if (customerId) next = next.eq("customerId", customerId);
    return next;
  }, (row) => row);
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
    const stockBalance = await balanceOf("stock", String(product.id));
    return { ...product, mobileStock: stockBalance.qty, mobileCost: stockBalance.amount };
  }));
  return { ...page, rows };
}