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

/** WHO the couriers are, keyed by `courierId`. See `readMobileCouriers`. */
export type CourierRegistry = ReadonlyMap<string, { id: string; name: string; phone: string | null }>;

/**
 * The legacy courier bucket. Before the registry (migration 030) an order
 * carried a typed `courierName` and usually no id at all; those rows were
 * swept under this subject. It is not a company and must never be shown as
 * one — see `lib/courierBatch.ts`, which books its money the same way.
 */
const LEGACY_COURIER_ID = "default";

/** Order statuses that belong in the shipment queue. */
const SHIPMENT_STATUSES = new Set(["shipped", "delivered", "returned"]);

/**
 * Transforms a raw order into a `MobileShipmentRow`.
 * Only call this for orders whose status is a shipment status.
 */
export function toMobileShipmentRow(order: any, couriers?: CourierRegistry): MobileShipmentRow {
  const id = String(order?.id ?? "");
  const statusKey = String(order?.status ?? "");
  const statusEntry = resolveShipmentStatus(statusKey);
  const customerName = String(order?.customerName ?? order?.customer_name ?? "—");
  const courierId = String(order?.courierId ?? order?.courier_id ?? "");
  // `shippedAt` is NOT a column on `orders` — verified against the live
  // schema — so this read `undefined` on every order and no shipment ever
  // showed an age. `updatedAt` is real and is what last moved the row, so it
  // is labelled as last movement rather than as a ship time it cannot know.
  const lastMovedAt = String(order?.updatedAt ?? order?.updated_at ?? "");
  // `cod` and `codAmount` are not columns either. The COD authority is
  // `orders.expectedCod` — the same field the order detail screen, the courier
  // ledger and `courierBatch` all read. Reading the two phantoms meant every
  // shipment reported بدل ٠ and the badge never rendered once.
  const codAmount = Number(order?.expectedCod ?? 0);

  return {
    id,
    title: String(order?.orderNumber ?? order?.order_number ?? id),
    subtitle: customerName,
    statusKey,
    statusLabelAr: statusEntry.labelAr,
    statusTone: statusEntry.tone,
    primaryValue: customerName,
    secondaryValue: codAmount > 0 ? `بدل: ${formatArabicCurrency(codAmount)}` : undefined,
    ageAr: lastMovedAt ? formatArabicRelativeTime(lastMovedAt) : undefined,
    href: `/orders/${id}`,
    // MobileShipmentRow-specific fields
    lastMovedAt: lastMovedAt || undefined,
    courierId: courierId || undefined,
    courierName: resolveCourierName(order, courierId, couriers),
    courierIsLegacy: !courierId || courierId === LEGACY_COURIER_ID,
    codFormatted: codAmount > 0 ? formatArabicCurrency(codAmount) : undefined,
  };
}

/**
 * The courier's name, from the REGISTRY where the order names a registry id.
 *
 * Identity is `courierId`; `courierName` on the order is a label frozen at
 * write time. Mobile had no registry reader at all and rendered that label
 * alone, which is how «أرامكس» typed twice becomes two couriers whose money
 * can never be settled against one account.
 *
 * The frozen label is still shown for rows the registry cannot answer — a
 * `courierId` of `"default"` or none at all — because those are real
 * historical orders and hiding their courier would lose information. They are
 * flagged `courierIsLegacy` so the UI can mark them rather than pass them off
 * as registry entities.
 */
function resolveCourierName(order: any, courierId: string, couriers?: CourierRegistry): string | undefined {
  const fromRegistry = courierId && courierId !== LEGACY_COURIER_ID ? couriers?.get(courierId) : undefined;
  if (fromRegistry?.name) return fromRegistry.name;
  return String(order?.courierName ?? order?.courier_name ?? "") || undefined;
}

/**
 * Transforms a list of raw orders into mobile shipment rows.
 * Filters to shipment-relevant statuses automatically.
 * Sorted by status priority (active/in-transit first), then by ship time.
 */
export function toMobileShipmentQueue(orders: any[], couriers?: CourierRegistry): MobileShipmentRow[] {
  if (!Array.isArray(orders)) return [];
  return orders
    .filter((o) => SHIPMENT_STATUSES.has(String(o?.status ?? "")))
    .map((o) => {
      try {
        return toMobileShipmentRow(o, couriers);
      } catch {
        return null;
      }
    })
    .filter((row): row is MobileShipmentRow => row !== null);
}
