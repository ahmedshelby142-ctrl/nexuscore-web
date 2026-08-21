/**
 * The money boundary. Above it: EGP. Below it: integer piastres.
 *
 * Deliberately dependency-free so it can be imported by tooling and tests
 * without dragging in the Tauri bridge. See docs/LEDGER_SCHEMA.md §2.
 */

/** EGP → piastres. Rounds here so float dust never reaches the database. */
export const toPiastres = (egp: number): number => Math.round(egp * 100);

/** Piastres → EGP. */
export const fromPiastres = (piastres: number): number => piastres / 100;

/**
 * The last gate before the ledger: no non-finite number may be written.
 *
 * ## Why this has to exist
 *
 * `Math.round(NaN * 100)` is `NaN`, and `NaN` serialises into the database
 * happily. The ledger is **append-only** — an event is never updated or
 * deleted — so a single `NaN` amount is not a bug you fix, it is a permanent
 * hole in the books that can only be papered over with a reversal event. Every
 * `SUM()` over that account returns `NaN` forever after, which means stock,
 * wallet balances, debts and profit all read `NaN` on every screen.
 *
 * A real order form did exactly this: a product price read from a field no
 * writer ever wrote gave `unitPrice: undefined`, `quantity * undefined` gave
 * `NaN`, and nothing between the input and the database looked.
 *
 * ## Why it lives here and not in the screen
 *
 * Because a guard on the screen only guards that screen. Every write in the
 * app funnels through `appendEvent` → `driver.append`, so this is the one
 * place that covers the order form, order editing, POS, wholesale, purchases,
 * returns and every path not yet written. Validation at the trust boundary,
 * once.
 *
 * Note the comparisons that do NOT work: `NaN <= 0` is `false`, so the
 * `quantity <= 0` checks in the line builders wave `NaN` straight through.
 * Only an explicit `Number.isFinite` catches it.
 *
 * Throws with the offending account and field named, because "الرقم غير صالح"
 * with no location is a bug report nobody can act on. The message is English:
 * it is a programmer-facing invariant that must never reach a user — the UI
 * catches the throw and shows its own Arabic message.
 */
export function assertFiniteLines(
  kind: string,
  lines: ReadonlyArray<{
    account: string;
    subjectId?: string;
    qty?: number;
    amount?: number;
    unitCost?: number;
  }>,
): void {
  lines.forEach((line, index) => {
    const check = (field: string, value: number | undefined) => {
      // `undefined` is legitimate — an optional field the caller omitted.
      // A *present* value that is not a finite number never is.
      if (value === undefined) return;
      if (!Number.isFinite(value)) {
        throw new Error(
          `ledger: refusing to write ${kind} — line ${index} (${line.account}` +
            `${line.subjectId ? `/${line.subjectId}` : ""}) has a non-finite ${field}: ${value}`,
        );
      }
    };
    check("qty", line.qty);
    check("amount", line.amount);
    check("unitCost", line.unitCost);
  });
}
