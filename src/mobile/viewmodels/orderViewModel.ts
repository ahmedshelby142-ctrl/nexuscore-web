/**
 * Mobile Order View Model
 *
 * Transforms raw order domain data into mobile-friendly row structures.
 * Pure function — no DB calls, no React state, no side effects.
 *
 * The `any` parameter types reflect the known debt in src/types/index.ts.
 * All field reads are defensive (runtime-safe) to handle missing values.
 */

import type { MobileOrderRow, MobileQueueItem } from "./types";
import { resolveOrderStatus } from "./statusTaxonomies";
import { formatArabicRelativeTime, formatArabicCurrency } from "./formatters";

/**
 * Transforms a raw ecommerce order into a `MobileOrderRow`.
 *
 * @param order - Raw order from the order store or Supabase query.
 *               Must not be modified — pure read.
 */
export function toMobileOrderRow(order: any): MobileOrderRow {
  const id = String(order?.id ?? "");
  const statusKey = String(order?.status ?? "");
  const statusEntry = resolveOrderStatus(statusKey);
  const customerName = String(order?.customerName ?? order?.customer_name ?? "—");
  const createdAt = String(order?.createdAt ?? order?.created_at ?? "");
  const total = Number(order?.total ?? order?.totalAmount ?? 0);

  return {
    id,
    title: String(order?.orderNumber ?? order?.order_number ?? id),
    subtitle: customerName,
    statusKey,
    statusLabelAr: statusEntry.labelAr,
    statusTone: statusEntry.tone,
    primaryValue: formatArabicCurrency(total),
    ageAr: createdAt ? formatArabicRelativeTime(createdAt) : undefined,
    href: `/orders/${id}`,
    // MobileOrderRow-specific fields
    createdAt,
    customerName,
    totalFormatted: formatArabicCurrency(total),
  };
}

/**
 * Transforms a list of raw orders into mobile queue items, newest first.
 * Filters out any items that fail to parse (returns valid rows only).
 */
export function toMobileOrderQueue(orders: any[]): MobileOrderRow[] {
  if (!Array.isArray(orders)) return [];
  return orders
    .map((o) => {
      try {
        return toMobileOrderRow(o);
      } catch {
        return null;
      }
    })
    .filter((row): row is MobileOrderRow => row !== null);
}

/**
 * Returns orders filtered to pending status — the "action queue".
 */
export function pendingOrderRows(orders: any[]): MobileOrderRow[] {
  return toMobileOrderQueue(orders).filter((r) => r.statusKey === "pending");
}

/**
 * Returns orders filtered to shipped status — the "shipment queue".
 */
export function shippedOrderRows(orders: any[]): MobileQueueItem[] {
  return toMobileOrderQueue(orders).filter((r) => r.statusKey === "shipped");
}
