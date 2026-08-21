/**
 * Finding the customer who is already in the book.
 *
 * §3.7's open item: an order used to carry a customer NAME and a phone STRING,
 * and every screen that needed the actual person re-derived them with its own
 * `(phone.trim() || name.trim())` comparison. Three consequences, all real:
 *
 *   - «01012345678» and «+20 101 234 5678» are the same person and did not
 *     match, so the second order opened a SECOND record and the LTV split
 *     across two rows that no screen would ever add back together;
 *   - a name typed «أحمد» once and «احمد» the next time did the same thing;
 *   - an order placed for someone not registered yet resolved to nobody, so
 *     `order_delivered` wrote no `customer_ltv` line at all.
 *
 * The fix is one key and one resolver, here. The key is the PHONE, because a
 * name is spelled differently by the same person on different days and a phone
 * number is not. `toWhatsAppNumber` already normalises exactly the way this
 * needs — Arabic-Indic digits to Latin, separators dropped, Egyptian trunk `0`
 * to `20` — so a number matches the same way it dials.
 *
 * Everything here is pure so `scripts/check_customers.mjs` can drive it
 * without React or a store.
 */

// Explicit extensions: `node --test` loads this file directly (see
// `scripts/check_customers.mjs`) and does not resolve bare specifiers.
import { toWhatsAppNumber } from "./phone.ts";
import { normaliseSearchText } from "./orderSearch.ts";
import type { EcommerceOrder } from "@/types";
import type { LedgerEvent } from "./ledger";

/** The fields this module needs. Any customer-shaped object satisfies it. */
export interface MatchableCustomer {
  id: string;
  name: string;
  phone: string;
  lastOrderAt?: Date | string;
}

/**
 * Archive tombstone, same shape as `Product.deleted_at` and `Partner`.
 *
 * Kept separate from `MatchableCustomer` so the matching helpers stay usable
 * on any customer-shaped object, including the plain rows the tests build.
 */
export interface ArchivableCustomer {
  deleted_at?: string | null;
}

/** The fields of an order this module needs. */
export interface CustomerBearingOrder {
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
}

/**
 * The identity key for a person, or `null` when there is nothing to key on.
 *
 * A dialable phone always wins. A customer entered without one — a walk-in the
 * owner named but never got a number for — falls back to the normalised name,
 * which is weaker but is better than treating every nameless row as the same
 * person. `null` (no phone AND no name) never matches anything, including
 * another `null`: two blanks are not evidence of the same customer.
 */
export function customerKey(person: {
  phone?: string | null;
  name?: string | null;
}): string | null {
  const phone = toWhatsAppNumber(person.phone);
  if (phone) return `tel:${phone}`;
  const name = normaliseSearchText(person.name ?? "");
  return name ? `name:${name}` : null;
}

/** Do these two describe the same person? `null` keys never match. */
export function sameCustomer(
  a: { phone?: string | null; name?: string | null },
  b: { phone?: string | null; name?: string | null },
): boolean {
  const keyA = customerKey(a);
  return keyA !== null && keyA === customerKey(b);
}

// ── Archived customers ──────────────────────────────────────────────────────

export function isCustomerArchived(customer: ArchivableCustomer): boolean {
  return customer.deleted_at != null;
}

/**
 * The customers a picker, a search or a new order may land on.
 *
 * Archiving means "stop using this record", so an archived customer must not
 * come back through the phone search or through `upsertTarget` — a new order
 * from that number opens a fresh record rather than resurrecting the old one,
 * exactly as an archived partner's percentage is freed rather than reclaimed.
 * Reading history is the opposite question and uses the FULL list: see
 * `customerIdOf`.
 */
export function activeCustomers<T extends ArchivableCustomer>(customers: T[]): T[] {
  return customers.filter((c) => !isCustomerArchived(c));
}

// ── Editing the directory by hand ───────────────────────────────────────────

/**
 * Someone else already using this identity, or `null` if the field is free.
 *
 * The guard on manual add and edit. Without it the owner can type a number
 * that already belongs to another row, and from then on `resolveByPhone`
 * reports that number as permanently `ambiguous` and `upsertTarget` picks
 * whichever record happens to come first in the array — the duplicate problem
 * this module exists to end, reintroduced by hand.
 *
 * `excludeId` is the row being edited: correcting a customer's own spelling
 * must not collide with themselves.
 */
export function duplicateOf<T extends MatchableCustomer & ArchivableCustomer>(
  customers: T[],
  person: { phone?: string | null; name?: string | null },
  excludeId?: string,
): T | null {
  const key = customerKey(person);
  if (!key) return null;
  return (
    activeCustomers(customers).find((c) => c.id !== excludeId && customerKey(c) === key) ?? null
  );
}

/**
 * May this customer be really deleted, or only archived?
 *
 * Same question the product and partner screens ask, one entity over, and
 * answered on ROW COUNT rather than on a sum. A customer who bought 300 and
 * returned all of it sums to exactly zero `customer_ltv` and still has a full
 * history behind them; hard-deleting the row would leave those ledger lines
 * and every past order pointing at an id no screen can name.
 */
export function customerRemovalMode(
  ledgerRows: unknown[],
  orderCount: number,
): "delete" | "archive" {
  return ledgerRows.length > 0 || orderCount > 0 ? "archive" : "delete";
}

// ── Search-first, the Odoo/SAP habit ────────────────────────────────────────

/**
 * What the order form found for the phone being typed.
 *
 * `ambiguous` exists because the directory can already contain duplicates from
 * before this module — the old exact-string matching created them freely — and
 * silently picking one of two people to attach money to is worse than asking.
 */
export type CustomerMatch =
  | { kind: "none" }
  | { kind: "one"; customer: MatchableCustomer }
  | { kind: "ambiguous"; customers: MatchableCustomer[] };

/** How many digits before the form starts suggesting. */
const MIN_SEARCH_DIGITS = 4;

/**
 * Customers whose number contains the digits typed so far, newest order first.
 *
 * A CONTAINS match, not an exact one, because the owner is reading a number off
 * a WhatsApp message and types the last few digits she can see. The exact key
 * still decides identity at save time — this only decides what to show her.
 */
export function searchCustomersByPhone<T extends MatchableCustomer & ArchivableCustomer>(
  customers: T[],
  query: string,
): T[] {
  const digits = normaliseSearchText(query).replace(/\D/g, "");
  if (digits.length < MIN_SEARCH_DIGITS) return [];

  return activeCustomers(customers)
    .filter((c) =>
      normaliseSearchText(c.phone ?? "")
        .replace(/\D/g, "")
        .includes(digits),
    )
    .sort((a, b) => orderTime(b.lastOrderAt) - orderTime(a.lastOrderAt));
}

function orderTime(at: Date | string | undefined): number {
  if (!at) return 0;
  const t = new Date(at).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Resolve a typed phone to a decision, never to a silent selection.
 *
 * An EXACT key match on its own is still reported as `one` rather than applied:
 * the caller shows it and the owner confirms. Attaching an order — and every
 * pound of LTV that follows it — to a person she did not look at is the failure
 * mode this whole search-first flow exists to avoid.
 */
export function resolveByPhone<T extends MatchableCustomer & ArchivableCustomer>(
  customers: T[],
  phone: string,
): CustomerMatch {
  const key = customerKey({ phone });
  // Archived rows never resurface as a suggestion — see `activeCustomers`.
  const live = activeCustomers(customers);
  const exact = key ? live.filter((c) => customerKey(c) === key) : [];
  if (exact.length === 1) return { kind: "one", customer: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", customers: exact };

  const partial = searchCustomersByPhone(customers, phone);
  if (partial.length === 0) return { kind: "none" };
  if (partial.length === 1) return { kind: "one", customer: partial[0] };
  return { kind: "ambiguous", customers: partial };
}

// ── Writing: which record does this order update? ───────────────────────────

/**
 * The existing customer an incoming order belongs to, or `null` to create one.
 *
 * The single decision behind `upsertCustomerFromOrder`. It lives here, pure,
 * because it is the thing the §1.3 scenario is actually about — two orders,
 * one phone, ONE record — and a decision that only exists inside a zustand
 * `set()` cannot be tested without a browser.
 *
 * Precedence, and why:
 *
 *   1. `customerId` — she picked this person out of the phone search and
 *      looked at their record. A human confirmation beats a string compare,
 *      and it is what lets her attach an order to «أحمد محمد» after typing
 *      «احمد» in the name field.
 *   2. the identity key — phone first, normalised name if there is no phone.
 *   3. nothing → a new record.
 */
export function upsertTarget<T extends MatchableCustomer & ArchivableCustomer>(
  customers: T[],
  order: CustomerBearingOrder,
): T | null {
  // Archived customers are not candidates: a new order from an archived
  // number opens a fresh record instead of quietly un-archiving one the owner
  // deliberately put away.
  const live = activeCustomers(customers);
  if (order.customerId) {
    const picked = live.find((c) => c.id === order.customerId);
    if (picked) return picked;
    // A stale id — deleted or archived while the draft sat open — falls
    // through to the key rather than resurrecting a customer that is gone.
  }
  const key = customerKey({ phone: order.customerPhone, name: order.customerName });
  if (!key) return null;
  return live.find((c) => customerKey(c) === key) ?? null;
}

// ── Reading an order back ───────────────────────────────────────────────────

/**
 * The customer id an order belongs to, or `null` for a genuine guest order.
 *
 * `customerId` is authoritative and is what every order placed since §3.7 has
 * carried. The key fallback is for orders recorded BEFORE it, which hold only
 * a name and a phone string — dropping them would empty the CRM timeline of
 * every customer's history on the day this shipped.
 */
export function customerIdOf(
  order: CustomerBearingOrder,
  // The FULL list, archived included: an archived customer's past orders must
  // still resolve, or their timeline empties the moment they are put away.
  customers: MatchableCustomer[],
): string | null {
  if (order.customerId) return order.customerId;
  const key = customerKey({ phone: order.customerPhone, name: order.customerName });
  if (!key) return null;
  return customers.find((c) => customerKey(c) === key)?.id ?? null;
}

/** Is this order part of that customer's history? */
export function orderBelongsTo(order: CustomerBearingOrder, customer: MatchableCustomer): boolean {
  if (order.customerId) return order.customerId === customer.id;
  return sameCustomer({ phone: order.customerPhone, name: order.customerName }, customer);
}

// ── Dynamic CRM Metrics ──────────────────────────────────────────────────────

export interface CustomerMetrics {
  totalOrders: number;
  preferredProducts: { productId: string; name: string; quantity: number; spent: number }[];
  lastOrderAt?: Date;
}

/**
 * Calculates a customer's total order count and favorite products on-the-fly.
 * Sums the EcommerceOrders and POS sales tied to that customerId.
 * Favorite products are derived by aggregating the items from those exact same orders.
 */
export function deriveCustomerMetrics(
  customerId: string,
  orders: EcommerceOrder[],
  sales: LedgerEvent[],
): CustomerMetrics {
  let totalOrders = 0;
  const products = new Map<string, { productId: string; name: string; quantity: number; spent: number }>();
  let lastOrderAt: Date | undefined = undefined;

  const updateTime = (t: Date | string | undefined) => {
    if (!t) return;
    const d = new Date(t);
    if (isNaN(d.getTime())) return;
    if (!lastOrderAt || d > lastOrderAt) lastOrderAt = d;
  };

  const addProduct = (productId: string, name: string, quantity: number, spent: number) => {
    const current = products.get(productId) || { productId, name, quantity: 0, spent: 0 };
    current.quantity += quantity;
    current.spent += spent;
    products.set(productId, current);
  };

  for (const order of orders) {
    if (order.customerId === customerId) {
      totalOrders++;
      updateTime(order.createdAt);
      for (const item of order.items) {
        addProduct(
          item.productId,
          item.productName || item.productId,
          item.quantity,
          item.quantity * (item.unitPrice || 0),
        );
      }
    }
  }

  for (const sale of sales) {
    if (sale.kind === "sale" && sale.payload) {
      const payload = sale.payload as any; // SaleInput
      if (payload.customerId === customerId) {
        totalOrders++;
        updateTime(sale.occurredAt);
        if (Array.isArray(payload.items)) {
          for (const item of payload.items) {
            addProduct(
              item.productId,
              item.productName || item.productId,
              item.quantity,
              item.quantity * (item.unitPrice || 0),
            );
          }
        }
      }
    }
  }

  return {
    totalOrders,
    preferredProducts: Array.from(products.values()).sort((a, b) => b.quantity - a.quantity || b.spent - a.spent),
    lastOrderAt,
  };
}
