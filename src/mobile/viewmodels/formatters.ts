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
 * Formats a number as an Arabic-locale EGP amount — display only.
 *
 * Arabic-Indic digits, `٬` thousands, `٫` decimals, never compact (no «ألف»).
 * Piastre precision, as before: a whole amount has no decimals to show
 * (800000 → «٨٠٠٬٠٠٠ ج.م.»), and an amount with piastres always shows both
 * places (1234.5 → «١٬٢٣٤٫٥٠ ج.م.»).
 *
 * `null` / `undefined` are MISSING, not zero: «غير مسجل». A zero is «٠ ج.م.».
 * This used to print «٠٫٠٠ ج.م.» for both — see the Owner equity capital line.
 */
export function formatArabicCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return "غير مسجل";
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  // Rounded to the piastre only to decide how many places to SHOW — the same
  // two places the old formatter rounded to. `|| 0` folds −0 into 0.
  const piastres = Math.round(num * 100);
  const digits = piastres % 100 === 0 ? 0 : 2;
  return (
    (piastres / 100 || 0).toLocaleString("ar-EG", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
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
