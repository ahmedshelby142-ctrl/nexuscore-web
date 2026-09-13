/**
 * Mobile View Model Types
 *
 * These are the shapes the Mobile UI consumes. They are produced by pure
 * view-model transformer functions from domain data, never fetched directly.
 *
 * Design rules:
 * - All string values visible to the user are Arabic.
 * - All IDs and hrefs are strings (safe for display as LTR, formatted by the UI).
 * - No Date objects — dates are pre-formatted to Arabic strings by the transformer.
 * - No business mutations live here.
 * - No database calls live here.
 */

import type { MobileCapability } from "@/mobile/navigation/mobileCapabilities";

// ── Metric ───────────────────────────────────────────────────────────────────

/**
 * A single KPI tile for the mobile home screen.
 *
 * `source` identifies the authoritative calculation so a reader can trace it.
 * `priority` controls display order (lower = more prominent).
 */
export interface MobileMetric {
  /** Unique stable identifier. */
  id: string;
  /** Arabic label for the metric. */
  labelAr: string;
  /** Pre-formatted value string (e.g. "١٢" or "٣٬٢٤٥.٠٠ ج.م."). */
  value: string;
  /** Optional Arabic unit label (e.g. "طلب", "ج.م."). */
  unitAr?: string;
  /** Where this figure comes from — traceability only. */
  source: string;
  /** Lower number = shown first. */
  priority: number;
  /** Deep-link path inside the mobile app (e.g. "/orders"). */
  href?: string;
  /** The capability a user must hold to see this metric. */
  capability: MobileCapability;
}

// ── Alert ────────────────────────────────────────────────────────────────────

export type AlertLevel = "CRITICAL" | "ACTION" | "WARNING" | "INFO";

/**
 * A derived operational alert.
 *
 * Alerts are never stored; they are derived from real domain data each time
 * the alert model runs. A condition that does not exist returns no alert.
 */
export interface MobileAlert {
  /** Unique stable identifier for this alert type. */
  id: string;
  level: AlertLevel;
  /** Arabic title (short). */
  titleAr: string;
  /** Arabic body (detail). */
  messageAr: string;
  /** How many items are in this condition. Never invented. */
  count: number;
  /** Deep-link path for the relevant screen. */
  href: string;
  /** The capability required to navigate to `href`. */
  capability: MobileCapability;
  /**
   * The condition that would make this alert disappear if resolved.
   * Plain Arabic — used in UI as a hint to the operator.
   */
  clearConditionAr: string;
}

// ── Queue Row ─────────────────────────────────────────────────────────────────

/**
 * A single item in any mobile queue list (orders queue, shipment queue, etc.).
 *
 * Deliberately generic so a single `QueueRow` component handles all queues.
 */
export interface MobileQueueItem {
  id: string;
  /** Primary line — typically a name or order number. */
  title: string;
  /** Secondary line — customer name, SKU, or similar. */
  subtitle?: string;
  /** Status key that maps to `ORDER_STATUS_TAXONOMY` or equivalent. */
  statusKey: string;
  /** The human-readable Arabic status label (pre-resolved from taxonomy). */
  statusLabelAr: string;
  /** The semantic tone key from the taxonomy. */
  statusTone: StatusTone;
  /** The main value to display prominently (e.g. "٢٤٥ ج.م." or "٣ قطع"). */
  primaryValue?: string;
  /** A secondary value (e.g. remaining COD). */
  secondaryValue?: string;
  /** How long ago this item was created/updated (Arabic relative string). */
  ageAr?: string;
  /** Deep-link within the mobile app. */
  href: string;
}

// ── Order Row ─────────────────────────────────────────────────────────────────

export interface MobileOrderRow extends MobileQueueItem {
  /** ISO date string from the domain (for further formatting if needed). */
  createdAt: string;
  /** Customer's name, Arabic if available. */
  customerName: string;
  /** Pre-formatted total (e.g. "٣٬٤٥٠.٠٠ ج.م."). */
  totalFormatted: string;
}

// ── Stock Row ─────────────────────────────────────────────────────────────────

export interface MobileStockRow {
  id: string;
  name: string;
  sku: string;
  /** Quantity from the authoritative ledger stock snapshot. */
  quantity: number;
  /** Pre-formatted (e.g. "١٢ قطعة"). */
  quantityFormatted: string;
  statusKey: StockStatusKey;
  statusLabelAr: string;
  statusTone: StatusTone;
  href: string;
}

// ── Shipment Row ──────────────────────────────────────────────────────────────

export interface MobileShipmentRow extends MobileQueueItem {
  /** ISO date string when the order was shipped. */
  shippedAt?: string;
  /** Courier name if available. */
  courierName?: string;
  /** Pre-formatted COD amount. */
  codFormatted?: string;
}

// ── Customer Row ──────────────────────────────────────────────────────────────

export interface MobileCustomerRow {
  id: string;
  name: string;
  /** Phone number — formatted LTR by the UI. */
  phone?: string;
  /** Pre-formatted last order date (Arabic). */
  lastOrderAr?: string;
  /** Number of orders for this customer. */
  orderCount: number;
  href: string;
}

// ── Status tones ──────────────────────────────────────────────────────────────

/**
 * Semantic tone keys that CSS classes and the StatusPill component map to.
 * The taxonomy owns what these mean visually; screens never pick colours.
 */
export type StatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "critical"
  | "muted";

/**
 * Stock status key. One of three states the stock taxonomy defines.
 */
export type StockStatusKey = "in_stock" | "low_stock" | "out_of_stock";
