/** A date input is a local calendar day, not the UTC day from toISOString(). */
export function localDateInput(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
