/**
 * Mobile Metric Definitions
 *
 * Each mobile metric is explicitly declared here with its source, authority,
 * and role-visibility rules. No metric may be displayed unless it appears
 * in this catalog.
 *
 * Rules:
 * - Sources must reference existing shared library calculations.
 * - No new arithmetic is introduced here.
 * - No second ledger engine.
 * - Stock quantity must come from the ledger stock snapshot, not products.quantity.
 * - Revenue figures must come from the existing `summarise()` / ledger balances.
 * - Payment-channel metrics are omitted unless the order model proves the channel.
 * - Each metric defines what to show when data is empty or errored.
 */

import type { MobileCapability } from "@/mobile/navigation/mobileCapabilities";

// ── Metric definition ─────────────────────────────────────────────────────────

export interface MetricDefinition {
  /** Unique stable identifier — used as React key and for testing. */
  id: string;
  /** Arabic label shown above the value. */
  labelAr: string;
  /**
   * The calculation source (traceability only — the actual computation runs
   * in the data layer that calls summarise() or the ledger stock snapshot).
   */
  source: string;
  /**
   * The existing function or concept that owns this figure.
   * This is documentation, not runtime — it links metric to implementation.
   */
  authority: string;
  /** Which mobile capability gates this metric's visibility. */
  capability: MobileCapability;
  /** Arabic string shown when the value is zero or no data is available. */
  emptyValueAr: string;
  /**
   * Arabic string shown when the data load fails.
   * Must never show a fake number.
   */
  errorValueAr: string;
  /** Optional Arabic unit label (e.g. "طلب", "ج.م."). */
  unitAr?: string;
  /** Deep-link path for tapping the metric. */
  href?: string;
  /** Display order (lower = more prominent). */
  priority: number;
}

// ── Catalog ───────────────────────────────────────────────────────────────────

/**
 * The authoritative mobile metric catalog.
 *
 * Ordered by priority. The home screen renders metrics the current user's
 * capabilities permit, in this priority order.
 */
export const MOBILE_METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    id: "today_orders",
    labelAr: "طلبات اليوم",
    source: "ecommerce_orders table, created_at = today",
    authority: "summarise({ events }).orders filtered to order_placed kind, today window",
    capability: "orders",
    emptyValueAr: "لا طلبات",
    errorValueAr: "—",
    unitAr: "طلب",
    href: "/orders",
    priority: 1,
  },
  {
    id: "pending_orders",
    labelAr: "الطلبات قيد الانتظار",
    source: "ecommerce_orders where status = 'pending'",
    authority: "Order store / status filter on pending",
    capability: "orders",
    emptyValueAr: "لا طلبات معلقة",
    errorValueAr: "—",
    unitAr: "طلب",
    href: "/orders",
    priority: 2,
  },
  {
    id: "shipped_orders",
    labelAr: "طلبات مع المندوب",
    source: "ecommerce_orders where status = 'shipped'",
    authority: "Order store / status filter on shipped",
    capability: "shipments",
    emptyValueAr: "لا شحنات",
    errorValueAr: "—",
    unitAr: "طلب",
    href: "/shipments",
    priority: 3,
  },
  {
    id: "low_stock_products",
    labelAr: "منتجات بمخزون منخفض",
    source: "ledger stock snapshot where qty <= minStockLevel",
    authority: "getActualStock() from lib/product.ts + productMinLevel()",
    capability: "stock",
    emptyValueAr: "المخزون جيد",
    errorValueAr: "—",
    unitAr: "منتج",
    href: "/inventory",
    priority: 4,
  },
  {
    id: "out_of_stock_products",
    labelAr: "منتجات نفد مخزونها",
    source: "ledger stock snapshot where qty <= 0",
    authority: "getActualStock() from lib/product.ts",
    capability: "stock",
    emptyValueAr: "لا نفاد مخزون",
    errorValueAr: "—",
    unitAr: "منتج",
    href: "/inventory",
    priority: 5,
  },
] as const;

/**
 * Returns the metric definitions that this capability set is allowed to see,
 * in priority order.
 */
export function metricsForCapabilities(
  capabilities: ReadonlySet<MobileCapability>,
): readonly MetricDefinition[] {
  return MOBILE_METRIC_DEFINITIONS.filter((m) => capabilities.has(m.capability)).sort(
    (a, b) => a.priority - b.priority,
  );
}

/**
 * Returns a single metric definition by ID.
 * Throws if the ID does not exist — a missing metric is a programming error.
 */
export function getMetricDefinition(id: string): MetricDefinition {
  const def = MOBILE_METRIC_DEFINITIONS.find((m) => m.id === id);
  if (!def) throw new Error(`Mobile metric "${id}" is not in the catalog.`);
  return def;
}
