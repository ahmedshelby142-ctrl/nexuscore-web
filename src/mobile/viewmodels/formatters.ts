/**
 * Mobile formatting helpers
 *
 * Shared pure functions used by view-model transformers to produce
 * Arabic-friendly display strings.
 *
 * Rules:
 * - No React, no hooks, no DOM.
 * - No database calls.
 * - All outputs are strings safe for RTL display.
 */

// ── Currency ──────────────────────────────────────────────────────────────────

/**
 * Formats a number as an Arabic-locale EGP amount.
 * Uses the system locale for digit shaping — Arabic locale uses Eastern
 * Arabic numerals (١٢٣), which is the store's standard.
 *
 * Example: 1234.5 → "١٬٢٣٤٫٥٠ ج.م."
 */
export function formatArabicCurrency(value: number | null | undefined): string {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return "—";
  return (
    num.toLocaleString("ar-EG", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + " ج.م."
  );
}

/**
 * Formats a plain integer count in Arabic locale digits.
 * Example: 24 → "٢٤"
 */
export function formatArabicCount(value: number | null | undefined): string {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return "—";
  return Math.round(num).toLocaleString("ar-EG");
}

// ── Dates ─────────────────────────────────────────────────────────────────────

/**
 * Produces a short Arabic relative time string.
 * e.g. "منذ ٣ ساعات", "منذ يومين", "منذ دقيقة"
 *
 * Falls back to a plain Arabic date string if the value cannot be parsed.
 *
 * @param isoOrTimestamp - ISO 8601 string or numeric timestamp.
 */
export function formatArabicRelativeTime(isoOrTimestamp: string | number | null | undefined): string {
  if (!isoOrTimestamp) return "—";
  let date: Date;
  try {
    date = new Date(isoOrTimestamp);
    if (isNaN(date.getTime())) return "—";
  } catch {
    return "—";
  }

  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHrs = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHrs / 24);

  if (diffSec < 60) return "الآن";
  if (diffMin < 60)
    return `منذ ${diffMin.toLocaleString("ar-EG")} ${diffMin === 1 ? "دقيقة" : "دقائق"}`;
  if (diffHrs < 24)
    return `منذ ${diffHrs.toLocaleString("ar-EG")} ${diffHrs === 1 ? "ساعة" : "ساعات"}`;
  if (diffDays < 7)
    return `منذ ${diffDays.toLocaleString("ar-EG")} ${diffDays === 1 ? "يوم" : "أيام"}`;

  // Beyond a week: show the date in Arabic
  return date.toLocaleDateString("ar-EG", { day: "numeric", month: "short" });
}

/**
 * Formats a date as a short Arabic date string.
 * e.g. "١٠ سبتمبر"
 */
export function formatArabicDate(isoOrTimestamp: string | number | null | undefined): string {
  if (!isoOrTimestamp) return "—";
  try {
    const date = new Date(isoOrTimestamp);
    if (isNaN(date.getTime())) return "—";
    return date.toLocaleDateString("ar-EG", { day: "numeric", month: "long" });
  } catch {
    return "—";
  }
}

// ── Quantity ──────────────────────────────────────────────────────────────────

/**
 * Formats a stock quantity with an Arabic unit.
 * e.g. 12 → "١٢ قطعة"
 */
export function formatArabicQuantity(qty: number | null | undefined, unitAr = "قطعة"): string {
  const n = Number(qty ?? 0);
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n).toLocaleString("ar-EG")} ${unitAr}`;
}
