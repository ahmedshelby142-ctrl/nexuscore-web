/**
 * Mobile Alert Derivation Model
 *
 * Derives operational alerts purely from real domain data. Each alert type
 * is defined with its data requirements. An alert is omitted if the required
 * data is not available or the condition is not met.
 *
 * Rules:
 * - No fake counts. No invented thresholds.
 * - No alert rows stored in the database.
 * - No notification records created.
 * - Every alert must be derivable from data already present in the domain.
 * - Alerts are sorted by level priority, then by count descending.
 * - An alert with count = 0 is not returned.
 */

import type { MobileAlert, AlertLevel } from "./types";
import type { MobileCapability } from "@/mobile/navigation/mobileCapabilities";
import { ALERT_LEVEL_TAXONOMY } from "./statusTaxonomies";

// ── Alert input shapes ────────────────────────────────────────────────────────

/**
 * The data the alert model needs. All arrays/counts come from the calling
 * data layer (hooks/stores that query Supabase). This function itself is pure.
 */
export interface AlertModelInput {
  /** Open orders (pending/processing) with at least one shortage shortfall > 0. */
  ordersWithStockout: number;
  /**
   * Open orders pending longer than the stale threshold.
   *
   * OPTIONAL, and the distinction matters: `undefined` means "no reader can
   * answer this yet" and the category is omitted, while `0` means "asked, and
   * there are none". These used to be passed as a hardcoded `0`, which
   * rendered an all-clear for a question nobody had asked.
   */
  agingPendingOrders?: number;
  /** Orders in shipped status in transit beyond a threshold. Optional — see above. */
  longInTransitOrders?: number;
  /** Products at zero stock that have waiting open orders. */
  stockoutWithWaitingOrders: number;
  /** Delivered orders with COD not yet settled. Optional — see above. */
  unsettledCodOrders?: number;
  /** Whether the current store license is in a risk/unverified state. */
  licenseAtRisk: boolean;
  /** Products at or below min stock level (not necessarily zero). */
  lowStockProducts: number;
}

// ── Thresholds (operationally meaningful, not invented) ───────────────────────

/** Orders pending longer than this many hours are considered aging. */
export const AGING_ORDER_THRESHOLD_HOURS = 24;

/** Shipments in transit longer than this many hours are flagged. */
export const LONG_TRANSIT_THRESHOLD_HOURS = 72;

// ── Alert definitions ─────────────────────────────────────────────────────────

interface AlertDefinition {
  id: string;
  level: AlertLevel;
  capability: MobileCapability;
  titleAr: string;
  /** Called with the count to produce the Arabic message body. */
  messageAr: (count: number) => string;
  clearConditionAr: string;
  href: string;
  /** Extracts the count from the input. Return 0 to suppress. */
  /** `undefined` = no reader can answer this yet, so omit the category. */
  getCount: (input: AlertModelInput) => number | undefined;
}

const ALERT_DEFINITIONS: readonly AlertDefinition[] = [
  {
    id: "license_at_risk",
    level: "CRITICAL",
    capability: "home",
    titleAr: "تحذير الترخيص",
    messageAr: () => "ترخيص المتجر في حالة غير مستقرة. تواصل مع مسؤول النظام.",
    clearConditionAr: "تجديد الترخيص أو التواصل مع مسؤول المتجر",
    href: "/license-expired",
    getCount: (input) => (input.licenseAtRisk ? 1 : 0),
  },
  {
    id: "stockout_with_waiting_orders",
    level: "CRITICAL",
    capability: "stock",
    titleAr: "طلبات معلقة بسبب نفاد المخزون",
    messageAr: (count) =>
      `${count} ${count === 1 ? "منتج" : "منتجات"} نفد مخزونها وعليها طلبات مفتوحة.`,
    clearConditionAr: "تسوية الطلبات أو إعادة التوريد",
    href: "/inventory",
    getCount: (input) => input.stockoutWithWaitingOrders,
  },
  {
    id: "aging_pending_orders",
    level: "ACTION",
    capability: "orders",
    titleAr: "الطلبات المتأخرة",
    messageAr: (count) =>
      `${count} ${count === 1 ? "طلب" : "طلبات"} قيد الانتظار أكثر من ${AGING_ORDER_THRESHOLD_HOURS} ساعة.`,
    clearConditionAr: "شحن أو إلغاء الطلبات المعلقة",
    href: "/orders",
    getCount: (input) => input.agingPendingOrders,
  },
  {
    id: "unsettled_cod",
    level: "ACTION",
    capability: "orders",
    titleAr: "بدل تسليم غير محصّل",
    messageAr: (count) =>
      `${count} ${count === 1 ? "طلب" : "طلبات"} تم تسليمها والبدل لم يُحصَّل بعد.`,
    clearConditionAr: "تسوية البدل مع المندوب",
    href: "/orders",
    getCount: (input) => input.unsettledCodOrders,
  },
  {
    id: "orders_with_stockout",
    level: "ACTION",
    capability: "orders",
    titleAr: "الطلبات التي بها نقص في المخزون",
    messageAr: (count) =>
      `${count} ${count === 1 ? "طلب" : "طلبات"} بها منتجات ناقصة من المخزون.`,
    clearConditionAr: "توريد البضاعة الناقصة أو تعديل الطلبات",
    href: "/orders",
    getCount: (input) => input.ordersWithStockout,
  },
  {
    id: "long_in_transit",
    level: "WARNING",
    capability: "shipments",
    titleAr: "شحنات طويلة في الطريق",
    messageAr: (count) =>
      `${count} ${count === 1 ? "شحنة" : "شحنات"} في الطريق أكثر من ${LONG_TRANSIT_THRESHOLD_HOURS} ساعة.`,
    clearConditionAr: "متابعة الشحنات مع شركة الشحن",
    href: "/shipments",
    getCount: (input) => input.longInTransitOrders,
  },
  {
    id: "low_stock",
    level: "WARNING",
    capability: "stock",
    titleAr: "مخزون منخفض",
    messageAr: (count) =>
      `${count} ${count === 1 ? "منتج" : "منتجات"} وصلت حد الطلب الأدنى.`,
    clearConditionAr: "توريد المنتجات المنخفضة",
    href: "/inventory",
    getCount: (input) => input.lowStockProducts,
  },
] as const;

// ── Derivation ────────────────────────────────────────────────────────────────

/**
 * Derive the current alert list from real domain input.
 *
 * Returns only alerts with count > 0, sorted by level priority then count.
 * Filters to capabilities the user holds.
 *
 * Pure function — no side effects, no DB calls.
 */
export function deriveAlerts(
  input: AlertModelInput,
  capabilities: ReadonlySet<MobileCapability>,
): MobileAlert[] {
  const alerts: MobileAlert[] = [];

  for (const def of ALERT_DEFINITIONS) {
    // Skip if the user cannot navigate to this alert's destination.
    if (!capabilities.has(def.capability)) continue;

    const count = def.getCount(input);
    // `undefined` is not zero: it means this signal has no authoritative reader
    // yet, so the category is omitted rather than shown as an all-clear.
    if (count === undefined || count === null || count <= 0) continue;

    alerts.push({
      id: def.id,
      level: def.level,
      titleAr: def.titleAr,
      messageAr: def.messageAr(count),
      count,
      href: def.href,
      capability: def.capability,
      clearConditionAr: def.clearConditionAr,
    });
  }

  // Sort: by level priority first (CRITICAL < ACTION < WARNING < INFO),
  // then by count descending within the same level.
  return alerts.sort((a, b) => {
    const pa = ALERT_LEVEL_TAXONOMY[a.level].priority;
    const pb = ALERT_LEVEL_TAXONOMY[b.level].priority;
    if (pa !== pb) return pa - pb;
    return b.count - a.count;
  });
}
