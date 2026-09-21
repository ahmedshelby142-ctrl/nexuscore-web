import type { MobileCapability } from "@/mobile/navigation/mobileCapabilities";
import { deriveAlerts, type AlertModelInput } from "@/mobile/viewmodels/alertModel";
import { toMobileOrderQueue } from "@/mobile/viewmodels/orderViewModel";
import { toMobileStockQueue } from "@/mobile/viewmodels/stockViewModel";
import { formatArabicCount } from "@/mobile/viewmodels/formatters";
import { getMetricDefinition } from "@/mobile/viewmodels/metricDefinitions";
import type { MobileAlert, MobileMetric, MobileQueueItem } from "@/mobile/viewmodels/types";

export interface HomeComposerInput {
  role: string;
  capabilities: ReadonlySet<MobileCapability>;
  orders: readonly unknown[];
  products: readonly unknown[];
  stock?: ReadonlyMap<string, number>;
  licenseAtRisk: boolean;
  now?: Date;
}

export interface HomeSection {
  id: "orders" | "stock" | "shipments";
  titleAr: string;
  count: number;
  href: string;
  rows: MobileQueueItem[];
}

export interface ComposedHome {
  alerts: MobileAlert[];
  metrics: MobileMetric[];
  queues: HomeSection[];
  hasOperationalData: boolean;
}

const OPEN_ORDER_STATUSES = new Set(["pending"]);

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

function orderStatus(order: unknown): string {
  return String(asRecord(order).status ?? "");
}

function orderCreatedAt(order: unknown): string {
  const value = asRecord(order).createdAt ?? asRecord(order).created_at;
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}

function isToday(value: string, now: Date): boolean {
  if (!value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toDateString() === now.toDateString();
}

function stockoutWaitingOrders(orders: readonly unknown[], stock: ReadonlyMap<string, number>): number {
  return orders.filter((order) => {
    const record = asRecord(order);
    if (!OPEN_ORDER_STATUSES.has(orderStatus(order))) return false;
    const items = Array.isArray(record.stockItems) ? record.stockItems : record.items;
    return Array.isArray(items) && items.some((item: unknown) => {
      const line = asRecord(item);
      const productId = String(line.productId ?? "");
      return productId && (stock.get(productId) ?? 0) <= 0;
    });
  }).length;
}

function buildAlertInput(input: HomeComposerInput, lowStockCount: number): AlertModelInput {
  const agingPendingOrders = input.orders.filter((order) => {
    const status = orderStatus(order);
    const age = Date.now() - new Date(orderCreatedAt(order)).getTime();
    return status === "pending" && Number.isFinite(age) && age > 24 * 60 * 60 * 1000;
  }).length;

  return {
    ordersWithStockout: stockoutWaitingOrders(input.orders, input.stock ?? new Map()),
    agingPendingOrders,
    longInTransitOrders: 0,
    stockoutWithWaitingOrders: stockoutWaitingOrders(input.orders, input.stock ?? new Map()),
    unsettledCodOrders: 0,
    licenseAtRisk: input.licenseAtRisk,
    lowStockProducts: lowStockCount,
  };
}

export function composeHomeSections(input: HomeComposerInput): ComposedHome {
  const orderRows = toMobileOrderQueue([...input.orders]);
  const stockRows = toMobileStockQueue([...input.products]).filter((row) => row.statusKey !== "in_stock");
  const pendingRows = orderRows.filter((row) => OPEN_ORDER_STATUSES.has(row.statusKey));
  const shippedRows = orderRows.filter((row) => row.statusKey === "shipped");
  const now = input.now ?? new Date();
  const todayOrders = input.orders.filter((order) => isToday(orderCreatedAt(order), now)).length;
  const metric = (id: string, value: number): MobileMetric => {
    const definition = getMetricDefinition(id);
    return {
      id: definition.id,
      labelAr: definition.labelAr,
      value: formatArabicCount(value),
      unitAr: definition.unitAr,
      source: definition.source,
      priority: definition.priority,
      href: definition.href,
      capability: definition.capability,
    };
  };

  const alerts = deriveAlerts(buildAlertInput(input, stockRows.length), input.capabilities);
  const metrics: MobileMetric[] = [
    input.capabilities.has("orders") && metric("today_orders", todayOrders),
    input.capabilities.has("orders") && metric("pending_orders", pendingRows.length),
    input.capabilities.has("stock") && metric("low_stock_products", stockRows.length),
  ].filter(Boolean) as MobileMetric[];

  const queues: HomeSection[] = [
    input.capabilities.has("orders") && pendingRows.length > 0 && {
      id: "orders",
      titleAr: "الطلبات التي تحتاج إجراء",
      count: pendingRows.length,
      href: "/orders",
      rows: pendingRows.slice(0, 3),
    },
    input.capabilities.has("stock") && stockRows.length > 0 && {
      id: "stock",
      titleAr: "مخزون ينفد",
      count: stockRows.length,
      href: "/inventory",
      rows: stockRows.slice(0, 3).map((row) => ({
        id: row.id,
        title: row.name,
        subtitle: row.sku,
        statusKey: row.statusKey,
        statusLabelAr: row.statusLabelAr,
        statusTone: row.statusTone,
        primaryValue: row.quantityFormatted,
        href: row.href,
      })),
    },
    input.capabilities.has("shipments") && shippedRows.length > 0 && {
      id: "shipments",
      titleAr: "جاهز للشحن",
      count: shippedRows.length,
      href: "/shipments",
      rows: shippedRows.slice(0, 3),
    },
  ].filter(Boolean) as HomeSection[];

  return {
    alerts,
    metrics,
    queues,
    hasOperationalData: input.orders.length > 0 || input.products.length > 0,
  };
}