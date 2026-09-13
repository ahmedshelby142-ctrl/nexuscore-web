/**
 * Mobile Customer View Model
 *
 * Transforms raw customer domain data into mobile-friendly customer row
 * structures. Pure function — no DB calls, no React state.
 */

import type { MobileCustomerRow } from "./types";
import { formatArabicDate, formatArabicCount } from "./formatters";

/**
 * Transforms a raw customer profile into a `MobileCustomerRow`.
 */
export function toMobileCustomerRow(customer: any): MobileCustomerRow {
  const id = String(customer?.id ?? "");
  const orderCount = Number(customer?.orderCount ?? customer?.order_count ?? 0);
  const lastOrderAt =
    customer?.lastOrderAt ?? customer?.last_order_at ?? customer?.lastOrder ?? null;

  return {
    id,
    name: String(customer?.name ?? customer?.customerName ?? "—"),
    phone: String(customer?.phone ?? customer?.phoneNumber ?? "") || undefined,
    lastOrderAr: lastOrderAt ? formatArabicDate(lastOrderAt) : undefined,
    orderCount: Number.isFinite(orderCount) ? Math.max(0, orderCount) : 0,
    href: `/customers/${id}`,
  };
}

/**
 * Transforms a list of raw customers into mobile customer rows.
 * Sorted by order count descending (most active first).
 */
export function toMobileCustomerQueue(customers: any[]): MobileCustomerRow[] {
  if (!Array.isArray(customers)) return [];
  return customers
    .map((c) => {
      try {
        return toMobileCustomerRow(c);
      } catch {
        return null;
      }
    })
    .filter((row): row is MobileCustomerRow => row !== null)
    .sort((a, b) => b.orderCount - a.orderCount);
}

/**
 * Formats an order count for display.
 * e.g. 5 → "٥ طلبات"
 */
export function formatCustomerOrderCount(count: number): string {
  if (count === 0) return "لا طلبات";
  const formatted = formatArabicCount(count);
  return count === 1 ? `${formatted} طلب` : `${formatted} طلبات`;
}
