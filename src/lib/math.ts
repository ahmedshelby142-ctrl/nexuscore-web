import Decimal from "decimal.js";

/**
 * Safe mathematical operations for currency values using decimal.js
 * to avoid floating-point precision errors.
 *
 * CRITICAL: Never use standard JavaScript floats for money calculations.
 * Always use these functions for any financial operations.
 *
 * TODO: Analytics Engine integration point
 * - Add transaction logging for audit trail
 * - Implement currency conversion support
 * - Add validation for business rules (minimum amounts, etc.)
 */

Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
});

/**
 * Add two currency values safely
 * @param a - First value (number or string)
 * @param b - Second value (number or string)
 * @returns Sum as a number
 */
export function add(a: number | string, b: number | string): number {
  return new Decimal(a).plus(new Decimal(b)).toNumber();
}

/**
 * Subtract two currency values safely
 * @param a - Minuend (number or string)
 * @param b - Subtrahend (number or string)
 * @returns Difference as a number
 */
export function subtract(a: number | string, b: number | string): number {
  return new Decimal(a).minus(new Decimal(b)).toNumber();
}

/**
 * Multiply two currency values safely
 * @param a - First value (number or string)
 * @param b - Second value (number or string)
 * @returns Product as a number
 */
export function multiply(a: number | string, b: number | string): number {
  return new Decimal(a).times(new Decimal(b)).toNumber();
}

/**
 * Divide two currency values safely
 * @param a - Dividend (number or string)
 * @param b - Divisor (number or string)
 * @returns Quotient as a number
 */
export function divide(a: number | string, b: number | string): number {
  return new Decimal(a).div(new Decimal(b)).toNumber();
}

/**
 * Round a currency value to a specified number of decimal places
 * @param value - Value to round (number or string)
 * @param decimalPlaces - Number of decimal places (default: 2 for currency)
 * @returns Rounded value as a number
 */
export function round(value: number | string, decimalPlaces: number = 2): number {
  return new Decimal(value).toDecimalPlaces(decimalPlaces).toNumber();
}

/**
 * The one way money reaches the screen.
 *
 * Two jobs, and the second is the reason this exists:
 *
 *   1. Arabic, RTL, `ج.م` — §2 of the rules. The old `formatCurrency` here was
 *      `en-US`/`USD` and would have printed "$1,234.00" to an Egyptian shop
 *      owner. It was dead code, so it never did; it is deleted rather than
 *      left lying around for someone to import.
 *   2. **A non-finite value never reaches the user.** `NaN.toLocaleString()`
 *      returns the literal string "NaN", and that is exactly what the order
 *      form showed. Formatting is the last gate before the screen, so it is
 *      the right place to make that impossible — a missing number renders as
 *      a dash, which reads as "we don't have this" instead of as gibberish.
 *
 * This is a display guard, not a licence to compute with NaN. Arithmetic that
 * can go non-finite is still a bug to fix at the source; this only guarantees
 * the user never has to read one.
 */
export function formatMoney(value: number | string | null | undefined): string {
  const numValue = typeof value === "string" ? parseFloat(value) : value;
  if (numValue == null || !Number.isFinite(numValue)) return "— ج.م";
  return `${numValue.toLocaleString("ar-EG")} ج.م`;
}

/**
 * The same guard for a bare number with no currency (counts, quantities).
 * Returns "0" rather than a dash: a count the app failed to compute is still
 * a count, and "0 قطعة" is the safe reading.
 */
export function formatQty(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "0";
  return value.toLocaleString("ar-EG");
}

/**
 * Calculate percentage of a value
 * @param value - Base value (number or string)
 * @param percentage - Percentage to calculate (number or string)
 * @returns Percentage value as a number
 */
export function percentage(value: number | string, percentage: number | string): number {
  return multiply(value, divide(percentage, 100));
}
