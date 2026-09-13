/**
 * Mobile Shipment View Model
 *
 * Transforms raw order data (filtered to shipped/returned states) into
 * mobile-friendly shipment row structures.
 * Pure function — no DB calls, no React state.
 */

import type { MobileShipmentRow } from "./types";
import { resolveShipmentStatus } from "./statusTaxonomies";
import { formatArabicRelativeTime, formatArabicCurrency } from "./formatters";

/** Order statuses that belong in the shipment queue. */
const SHIPMENT_STATUSES = new Set(["shipped", "delivered", "returned"]);

/**
 * Transforms a raw order into a `MobileShipmentRow`.
 * Only call this for orders whose status is a shipment status.
 */
export function toMobileShipmentRow(order: any): MobileShipmentRow {
  const id = String(order?.id ?? "");
  const statusKey = String(order?.status ?? "");
  const statusEntry = resolveShipmentStatus(statusKey);
  const customerName = String(order?.customerName ?? order?.customer_name ?? "—");
  const shippedAt = String(order?.shippedAt ?? order?.shipped_at ?? "");
  const codAmount = Number(order?.cod ?? order?.codAmount ?? 0);

  return {
    id,
    title: String(order?.orderNumber ?? order?.order_number ?? id),
    subtitle: customerName,
    statusKey,
    statusLabelAr: statusEntry.labelAr,
    statusTone: statusEntry.tone,
    primaryValue: customerName,
    secondaryValue: codAmount > 0 ? `بدل: ${formatArabicCurrency(codAmount)}` : undefined,
    ageAr: shippedAt ? formatArabicRelativeTime(shippedAt) : undefined,
    href: `/orders/${id}`,
    // MobileShipmentRow-specific fields
    shippedAt: shippedAt || undefined,
    courierName:
      String(order?.courierName ?? order?.courier_name ?? "") || undefined,
    codFormatted: codAmount > 0 ? formatArabicCurrency(codAmount) : undefined,
  };
}

/**
 * Transforms a list of raw orders into mobile shipment rows.
 * Filters to shipment-relevant statuses automatically.
 * Sorted by status priority (active/in-transit first), then by ship time.
 */
export function toMobileShipmentQueue(orders: any[]): MobileShipmentRow[] {
  if (!Array.isArray(orders)) return [];
  return orders
    .filter((o) => SHIPMENT_STATUSES.has(String(o?.status ?? "")))
    .map((o) => {
      try {
        return toMobileShipmentRow(o);
      } catch {
        return null;
      }
    })
    .filter((row): row is MobileShipmentRow => row !== null);
}
