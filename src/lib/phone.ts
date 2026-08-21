/**
 * Phone numbers → a WhatsApp link.
 *
 * The supplier and customer directories hold numbers the way Egyptians write
 * them: `01012345678`, `+20 101 234 5678`, `0100-123-4567`, sometimes in
 * Arabic-Indic digits. `wa.me` accepts none of that — it wants bare
 * international digits, `201012345678`.
 *
 * Reuses `normaliseSearchText` (the order-search normaliser) for the
 * Arabic-Indic → Latin step, so a number types the same way it searches.
 */

import { normaliseSearchText } from "./orderSearch.ts";

/** Egypt. The only country code this app converts to, because it is the shop's. */
const EGYPT = "20";

/**
 * International digits for `wa.me`, or `null` when there is nothing dialable.
 *
 * Rules, in order:
 *   - Arabic-Indic digits become Latin, and every separator is dropped.
 *   - `00` and `+` prefixes are international already — strip and keep.
 *   - a leading `0` is Egyptian trunk notation (`01…` mobile, `02…` landline):
 *     replace it with the country code.
 *   - anything else long enough is assumed to be already international.
 */
export function toWhatsAppNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;

  let digits = normaliseSearchText(String(phone)).replace(/\D/g, "");
  if (!digits) return null;

  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = EGYPT + digits.slice(1);

  // Shortest sane international number is ~8 digits (country code + line);
  // below that it is an extension or a typo, and a wa.me link would 404.
  return digits.length >= 8 ? digits : null;
}

/** The link itself, or `null` when the number cannot be dialled. */
export function whatsAppLink(phone: string | null | undefined): string | null {
  const number = toWhatsAppNumber(phone);
  return number ? `https://wa.me/${number}` : null;
}
