/**
 * Mobile Status Taxonomies
 *
 * Centralised status → presentation mapping for every domain state shown in
 * the mobile app. Screens MUST NOT invent their own labels or colours for
 * domain states that already exist here.
 *
 * Rules:
 * - Arabic labels are the only user-visible text.
 * - `tone` maps to CSS custom properties via StatusPill.
 * - `priority` is ascending order (lower = more urgent / shown first).
 * - Only statuses that exist in the live domain are listed.
 * - No new business statuses are introduced here.
 */

import type { StatusTone, StockStatusKey, AlertLevel } from "./types";

// ── Shared entry shape ────────────────────────────────────────────────────────

export interface TaxonomyEntry {
  labelAr: string;
  tone: StatusTone;
  /** Lower = shown earlier in sorted lists. */
  priority: number;
}

// ── Order status ──────────────────────────────────────────────────────────────

/**
 * Maps EcommerceOrderStatus values (from the domain) to mobile presentation.
 * Status strings match exactly what the database and `orderLifecycle.ts` use.
 */
export const ORDER_STATUS_TAXONOMY: Record<string, TaxonomyEntry> = {
  pending: {
    labelAr: "قيد الانتظار",
    tone: "warning",
    priority: 1,
  },
  shipped: {
    labelAr: "مع المندوب",
    tone: "info",
    priority: 2,
  },
  delivered: {
    labelAr: "تم التسليم",
    tone: "success",
    priority: 3,
  },
  returned: {
    labelAr: "مرتجع",
    tone: "critical",
    priority: 4,
  },
  cancelled: {
    labelAr: "ملغي",
    tone: "muted",
    priority: 5,
  },
} as const;

/** Fallback entry for an unknown status value. */
export const UNKNOWN_ORDER_STATUS: TaxonomyEntry = {
  labelAr: "غير معروف",
  tone: "neutral",
  priority: 99,
};

export function resolveOrderStatus(status: string | null | undefined): TaxonomyEntry {
  return ORDER_STATUS_TAXONOMY[String(status ?? "")] ?? UNKNOWN_ORDER_STATUS;
}

// ── Shipment status ───────────────────────────────────────────────────────────

/**
 * Mobile shipment view focuses on the in-transit phase of the order lifecycle.
 * These map to a subset of order statuses relevant to the shipment queue.
 */
export const SHIPMENT_STATUS_TAXONOMY: Record<string, TaxonomyEntry> = {
  shipped: {
    labelAr: "في الطريق",
    tone: "info",
    priority: 1,
  },
  delivered: {
    labelAr: "وصل للعميل",
    tone: "success",
    priority: 2,
  },
  returned: {
    labelAr: "مرتجع من المندوب",
    tone: "critical",
    priority: 3,
  },
} as const;

export function resolveShipmentStatus(status: string | null | undefined): TaxonomyEntry {
  return SHIPMENT_STATUS_TAXONOMY[String(status ?? "")] ?? UNKNOWN_ORDER_STATUS;
}

// ── Stock status ──────────────────────────────────────────────────────────────

/**
 * Derived from quantity vs. min-level thresholds. Calculation lives in the
 * stock view model; only the presentation mapping lives here.
 */
export const STOCK_STATUS_TAXONOMY: Record<StockStatusKey, TaxonomyEntry> = {
  in_stock: {
    labelAr: "متوفر",
    tone: "success",
    priority: 3,
  },
  low_stock: {
    labelAr: "مخزون منخفض",
    tone: "warning",
    priority: 2,
  },
  out_of_stock: {
    labelAr: "نفد المخزون",
    tone: "critical",
    priority: 1,
  },
} as const;

export function resolveStockStatus(key: StockStatusKey): TaxonomyEntry {
  return STOCK_STATUS_TAXONOMY[key];
}

// ── Alert level ───────────────────────────────────────────────────────────────

export interface AlertLevelEntry {
  labelAr: string;
  tone: StatusTone;
  /** Sort order across different alert levels. Lower = higher urgency. */
  priority: number;
}

export const ALERT_LEVEL_TAXONOMY: Record<AlertLevel, AlertLevelEntry> = {
  CRITICAL: {
    labelAr: "حرج",
    tone: "critical",
    priority: 1,
  },
  ACTION: {
    labelAr: "يتطلب إجراء",
    tone: "warning",
    priority: 2,
  },
  WARNING: {
    labelAr: "تحذير",
    tone: "warning",
    priority: 3,
  },
  INFO: {
    labelAr: "معلومة",
    tone: "info",
    priority: 4,
  },
} as const;

export function resolveAlertLevel(level: AlertLevel): AlertLevelEntry {
  return ALERT_LEVEL_TAXONOMY[level];
}
