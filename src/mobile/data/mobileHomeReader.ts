import { getSupabaseClient } from "@/lib/supabase";
import { deriveAlerts } from "@/mobile/viewmodels/alertModel";
import { getMetricDefinition } from "@/mobile/viewmodels/metricDefinitions";
import { formatArabicCount } from "@/mobile/viewmodels/formatters";
import type { MobileCapability } from "@/mobile/navigation/mobileCapabilities";
import type { MobileAlert, MobileMetric, MobileQueueItem } from "@/mobile/viewmodels/types";
import { readMobileOrders, readMobileShipments } from "./mobileReaders";

export interface MobileShortageRow {
  product_id: string;
  product_name: string;
  sku: string;
  stock: number;
  required: number;
  deficit: number;
  order_count: number;
  waiting_orders: unknown[];
}

export interface MobileHomeSnapshot {
  todayOrders: number;
  pendingOrders: number;
  orders: any[];
  shipments: any[];
  shortages: MobileShortageRow[];
}

export interface ComposedMobileHomeSnapshot {
  alerts: MobileAlert[];
  metrics: MobileMetric[];
  queues: { id: "orders" | "stock" | "shipments"; titleAr: string; count: number; href: string; rows: MobileQueueItem[] }[];
}

function clientOrThrow() {
  const client = getSupabaseClient();
  if (!client) throw new Error("لا يوجد اتصال بالسحابة");
  return client;
}

export async function readMobileShortages(): Promise<MobileShortageRow[]> {
  const { data, error } = await clientOrThrow().rpc("mobile_shortages");
  if (error) throw new Error(`[mobile_shortages] ${error.message}`);
  return (data ?? []) as MobileShortageRow[];
}

export async function readMobileHomeSnapshot(capabilities: ReadonlySet<MobileCapability>): Promise<MobileHomeSnapshot> {
  const [today, pending, orders, shipments, shortages] = await Promise.all([
    capabilities.has("orders") ? readMobileOrders({ queue: "today", pageSize: 1 }) : Promise.resolve({ total: 0, rows: [], hasMore: false }),
    capabilities.has("orders") ? readMobileOrders({ status: "pending", pageSize: 1 }) : Promise.resolve({ total: 0, rows: [], hasMore: false }),
    capabilities.has("orders") ? readMobileOrders({ queue: "action", pageSize: 3 }) : Promise.resolve({ total: 0, rows: [], hasMore: false }),
    capabilities.has("shipments") ? readMobileShipments({ status: "shipped", pageSize: 3 }) : Promise.resolve({ total: 0, rows: [], hasMore: false }),
    capabilities.has("stock") ? readMobileShortages() : Promise.resolve([]),
  ]);
  return { todayOrders: today.total ?? 0, pendingOrders: pending.total ?? 0, orders: orders.rows, shipments: shipments.rows, shortages };
}

export function composeMobileHomeSnapshot(
  snapshot: MobileHomeSnapshot,
  capabilities: ReadonlySet<MobileCapability>,
  licenseAtRisk: boolean,
): ComposedMobileHomeSnapshot {
  const shortageOrderCount = snapshot.shortages.reduce((sum, row) => sum + Number(row.order_count || 0), 0);
  const alerts = deriveAlerts({
    ordersWithStockout: shortageOrderCount,
    agingPendingOrders: 0,
    longInTransitOrders: 0,
    stockoutWithWaitingOrders: shortageOrderCount,
    unsettledCodOrders: 0,
    licenseAtRisk,
    lowStockProducts: snapshot.shortages.length,
  }, capabilities);
  const metric = (id: string, value: number): MobileMetric => {
    const definition = getMetricDefinition(id);
    return { id, labelAr: definition.labelAr, value: formatArabicCount(value), unitAr: definition.unitAr, source: definition.source, priority: definition.priority, href: definition.href, capability: definition.capability };
  };
  const queues = [] as ComposedMobileHomeSnapshot["queues"];
  if (capabilities.has("orders") && snapshot.pendingOrders > 0) queues.push({ id: "orders", titleAr: "الطلبات التي تحتاج إجراء", count: snapshot.pendingOrders, href: "/orders", rows: snapshot.orders.slice(0, 3).map((order) => ({ id: String(order.id), title: String(order.orderNumber ?? order.id), subtitle: String(order.customerName ?? "—"), statusKey: String(order.status ?? ""), statusLabelAr: "قيد الإجراء", statusTone: "warning", primaryValue: String(order.totalAmount ?? ""), href: `/orders/${order.id}` })) });
  if (capabilities.has("stock") && snapshot.shortages.length > 0) queues.push({ id: "stock", titleAr: "نواقص تحتاج متابعة", count: snapshot.shortages.length, href: "/inventory/shortages", rows: snapshot.shortages.slice(0, 3).map((row) => ({ id: row.product_id, title: row.product_name, subtitle: row.sku, statusKey: "shortage", statusLabelAr: "نقص", statusTone: "critical", primaryValue: formatArabicCount(row.deficit), href: `/inventory/${row.product_id}` })) });
  if (capabilities.has("shipments") && snapshot.shipments.length > 0) queues.push({ id: "shipments", titleAr: "الشحنات في الطريق", count: snapshot.shipments.length, href: "/shipments", rows: snapshot.shipments.slice(0, 3).map((order) => ({ id: String(order.id), title: String(order.orderNumber ?? order.id), subtitle: String(order.customerName ?? "—"), statusKey: "shipped", statusLabelAr: "في الطريق", statusTone: "info", href: `/orders/${order.id}` })) });
  return { alerts, metrics: [capabilities.has("orders") && metric("today_orders", snapshot.todayOrders), capabilities.has("orders") && metric("pending_orders", snapshot.pendingOrders), capabilities.has("stock") && metric("low_stock_products", snapshot.shortages.length)].filter(Boolean) as MobileMetric[], queues };
}
