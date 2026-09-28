/**
 * WhatsApp actions: a prefilled message, opened with `wa.me`, sent by a human.
 *
 * No API, no server, no background sending. NEXUS writes the draft; WhatsApp
 * opens on the phone; the user reads it and presses Send. The only external
 * destination is the `wa.me` link the user taps.
 *
 * ## Why a second check on top of `toWhatsAppNumber`
 *
 * `toWhatsAppNumber` (./phone.ts) is also the customer IDENTITY key
 * (`customerKey`) and the CRM form's "is this dialable" rule, so its leniency
 * is load-bearing and it stays as it is. Opening a chat needs more: a number
 * that is wrong for WhatsApp must produce a state the user can fix, never a
 * link to a stranger. `whatsAppTarget` adds exactly those refusals.
 *
 * Every builder here is pure and takes only what the screen really holds. A
 * missing store name, supplier name or quantity is left OUT of the message —
 * never replaced by a plausible one.
 */

import { toWhatsAppNumber } from "./phone.ts";

export type WhatsAppTarget =
  | { status: "ok"; number: string }
  /** Nothing stored. */
  | { status: "missing" }
  /** Something stored that cannot be opened with confidence. */
  | { status: "invalid" };

/**
 * The number to open, or why there is none.
 *
 *   - Egypt (`20…`): mobiles only — `201[0125]` + 8 digits. A landline has no
 *     WhatsApp, and any other length is a typo. `+20 0 10…` (the trunk 0 kept
 *     after the country code) is the one mistake fixed, because it is
 *     unambiguous.
 *   - `1…` must be a full North-American number (11 digits). This is also what
 *     refuses an Egyptian mobile typed without its 0 (`1012345678`), which
 *     `toWhatsAppNumber` would otherwise pass on as a US number.
 *   - Any other country: 10–15 digits (E.164). No country code is ever added
 *     to a number that did not already say which country it is.
 */
export function whatsAppTarget(phone: string | null | undefined): WhatsAppTarget {
  if (!phone || !String(phone).trim()) return { status: "missing" };
  let n = toWhatsAppNumber(phone);
  if (!n) return { status: "invalid" };
  if (/^2001[0125]\d{8}$/.test(n)) n = `20${n.slice(3)}`;

  const ok = n.startsWith("20")
    ? /^201[0125]\d{8}$/.test(n)
    : n.startsWith("1")
      ? n.length === 11
      : n.length >= 10 && n.length <= 15;
  return ok ? { status: "ok", number: n } : { status: "invalid" };
}

/** `wa.me` with the message encoded — Arabic, spaces and line breaks included. */
export function whatsAppUrl(number: string, message: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

const clean = (s: string | null | undefined) => (s ?? "").trim() || null;

/** A customer: greeting and who is writing. The rest is the user's to type. */
export function customerMessage(input: {
  customerName?: string | null;
  storeName?: string | null;
}): string {
  const name = clean(input.customerName);
  const store = clean(input.storeName);
  return [name ? `أهلاً ${name}،` : "أهلاً،", store && `معاك من ${store}.`]
    .filter(Boolean)
    .join("\n");
}

/** A supplier: the trade greeting, not the customer one. */
export function supplierMessage(input: {
  supplierName?: string | null;
  storeName?: string | null;
}): string {
  const name = clean(input.supplierName);
  const store = clean(input.storeName);
  return [name ? `السلام عليكم ${name}،` : "السلام عليكم،", store && `معاك من ${store}.`]
    .filter(Boolean)
    .join("\n");
}

export interface RestockItem {
  name: string;
  /** The درجة, only when one was chosen. */
  variant?: string | null;
  /** Only a real figure — typed on the receipt or the shortage's deficit. */
  quantity?: number | null;
}

/**
 * `need=id:qty,…` from the نواقص → توريد link: the deficit that screen read
 * from `mobile_shortages`. Anything that is not a positive number is dropped —
 * no quantity is better than a wrong one.
 */
export function parseRestockNeed(param: string | null | undefined): Map<string, number> {
  const need = new Map<string, number>();
  for (const pair of (param ?? "").split(",")) {
    const at = pair.lastIndexOf(":");
    const id = pair.slice(0, at).trim();
    const n = Number(pair.slice(at + 1));
    if (at > 0 && id && Number.isFinite(n) && n > 0) need.set(id, n);
  }
  return need;
}

/** «١٢» — the digits the rest of the Arabic message uses. */
const qty = (n: number) => n.toLocaleString("ar-EG", { maximumFractionDigits: 3 });

/** A restock request: every product and quantity NEXUS already knows. */
export function restockRequestMessage(input: {
  supplierName?: string | null;
  storeName?: string | null;
  items: RestockItem[];
}): string {
  const lines = input.items
    .filter((item) => clean(item.name))
    .map((item) => {
      const variant = clean(item.variant);
      const known = item.quantity != null && Number.isFinite(item.quantity) && item.quantity > 0;
      return `- ${item.name.trim()}${variant ? ` (${variant})` : ""}${known ? ` — الكمية: ${qty(item.quantity as number)}` : ""}`;
    });
  return [
    supplierMessage(input),
    lines.length === 1 ? "محتاجين توريد المنتج:" : "محتاجين توريد المنتجات دي:",
    ...lines,
    "من فضلك أكد التوفر والسعر.",
    "شكراً.",
  ].join("\n");
}
