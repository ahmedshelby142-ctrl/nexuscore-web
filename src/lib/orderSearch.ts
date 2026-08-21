/**
 * Finding an order by typing.
 *
 * One matcher, used by every screen that has to locate an order before acting
 * on it — cancel, edit, return, exchange, order management. Kept pure and
 * free of React so the matching rules can be tested directly, and so there is
 * exactly one answer to "does this order match what the user typed".
 *
 * The rules, deliberately forgiving because the person typing is usually
 * reading a number off a phone screen or a delivery note:
 *
 *   - one field, all three targets at once — order number, customer name,
 *     phone. No mode picker: the user should not have to tell the app what
 *     kind of thing they just typed.
 *   - Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) are treated as their Latin
 *     equivalents, so a phone copied from an Arabic keyboard still matches.
 *   - separators inside phone numbers are ignored, so "0100 123 4567",
 *     "01001234567" and "0100-123-4567" all find the same order.
 *   - every whitespace-separated word must match somewhere, so "احمد 4567"
 *     narrows to that customer's order rather than returning both halves.
 */

/** Arabic-Indic and Eastern Arabic-Indic digits → Latin. */
const DIGIT_MAP: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

/** Lowercased, with Arabic digits normalised to Latin. */
export function normaliseSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[٠-٩۰-۹]/g, (d) => DIGIT_MAP[d] ?? d)
    .trim();
}

/** Just the digits, so separators and spacing never block a phone match. */
function digitsOnly(value: string): string {
  return normaliseSearchText(value).replace(/\D/g, "");
}

/** The fields a search looks at. Any order-shaped object satisfies this. */
export interface SearchableOrder {
  orderNumber?: string;
  customerName?: string;
  customerPhone?: string;
}

/**
 * Does this order match everything the user typed?
 *
 * An empty query matches everything — a blank search box should not hide the
 * list, it should show it.
 */
export function matchesOrderQuery(order: SearchableOrder, query: string): boolean {
  const words = normaliseSearchText(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;

  const haystack = normaliseSearchText(
    [order.orderNumber, order.customerName, order.customerPhone].filter(Boolean).join(" "),
  );
  const phoneDigits = digitsOnly(order.customerPhone ?? "");
  const numberDigits = digitsOnly(order.orderNumber ?? "");

  return words.every((word) => {
    if (haystack.includes(word)) return true;
    // A run of digits should also match a phone or order number whose
    // separators differ from however the user typed it.
    const wordDigits = word.replace(/\D/g, "");
    if (wordDigits.length === 0) return false;
    return phoneDigits.includes(wordDigits) || numberDigits.includes(wordDigits);
  });
}

/** Filter a list of orders by a typed query, preserving their order. */
export function searchOrders<T extends SearchableOrder>(orders: T[], query: string): T[] {
  if (!query.trim()) return orders;
  return orders.filter((order) => matchesOrderQuery(order, query));
}

/**
 * The orders placed inside a date range, both ends inclusive.
 *
 * Kept here beside `searchOrders` because it is the same kind of thing — a
 * pure filter over the same list — and because the boundaries are exactly
 * where a date filter goes wrong: an order placed at 18:00 on the `to` day
 * must be IN the range, so the end bound is the end of that day, not midnight
 * at its start. Local time on purpose: the operator picks the day they are
 * looking at on their own screen.
 *
 * An empty bound means "no bound", so one box can be filled without the other.
 * `createdAt` is read through `new Date()` because zustand's localStorage
 * rehydration hands dates back as strings.
 */
export function ordersInPeriod<T extends { createdAt: Date | string }>(
  orders: T[],
  from: string,
  to: string,
): T[] {
  const start = from ? new Date(`${from}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
  const end = to ? new Date(`${to}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY;
  if (Number.isNaN(start) || Number.isNaN(end)) return orders;
  if (start === Number.NEGATIVE_INFINITY && end === Number.POSITIVE_INFINITY) return orders;

  return orders.filter((order) => {
    const at = new Date(order.createdAt).getTime();
    // An unparseable date is shown rather than hidden: dropping a row on a
    // filter it cannot be judged against is how an order disappears silently.
    if (Number.isNaN(at)) return true;
    return at >= start && at <= end;
  });
}
