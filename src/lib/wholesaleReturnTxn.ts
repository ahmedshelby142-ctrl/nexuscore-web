/**
 * The ORDER a wholesale return is written in, and how it is undone.
 *
 * Pure and import-free on purpose: `commitWholesaleReturn` wires the real
 * store and ledger into it, and `check_wholesale_return_txn.mjs` drives it
 * with fakes, failure by failure, under plain node.
 *
 * ## The rule: nothing that can fail may run after the ledger event
 *
 * `ledger_events` is append-only (`no_delete_*` / `no_update_*` are
 * `USING (false)`), so a step that fails AFTER the event leaves money moved
 * and no way to take it back. That is exactly what the invoice credit did: it
 * ran after the event, in three screens, with its failure swallowed — and on
 * committed `main` it did not exist at all, so it threw a TypeError after the
 * ledger had already moved and told the operator nothing was recorded.
 *
 * So every DOCUMENT is written first and the ledger event is the last step:
 *
 *   1. return records   — the returnable ceiling (see `commitWholesaleReturn`)
 *   2. invoice credits  — each source invoice's open balance
 *   3. ledger event     — the money. Last. If it lands, the return is done.
 *
 * If step 2 or 3 fails, every document already written is put back — the
 * invoices to the exact balance they held, the records deleted — and the
 * ORIGINAL error is rethrown. The operator's «لم يُسجَّل المرتجع» is then true.
 *
 * If the undo itself fails, that is said out loud (`WholesaleReturnUndoError`)
 * with what was left behind — never folded into a quiet success.
 */

export interface InvoiceCredit {
  invoiceId: string;
  /** EGP, positive. What comes off this invoice's open balance. */
  amount: number;
}

export interface WholesaleReturnSteps {
  /** Write the return records; resolve with their ids. Throws → nothing written. */
  writeRecords: () => Promise<string[]>;
  deleteRecord: (id: string) => Promise<void>;
  /** Credit one invoice; resolve with the open balance it REPLACED. */
  creditInvoice: (invoiceId: string, amount: number) => Promise<number>;
  /** Put an invoice's open balance back to exactly `remaining`. */
  restoreInvoice: (invoiceId: string, remaining: number) => Promise<void>;
  /** Append the ledger event. The last step, always. */
  appendLedger: () => Promise<unknown>;
}

/** The undo did not fully succeed. `failure` is what triggered it. */
export class WholesaleReturnUndoError extends Error {
  /** The failure that triggered the undo. */
  readonly failure: unknown;
  /** What could not be put back, in words an operator can act on. */
  readonly leftBehind: string[];

  // Plain fields, not constructor parameter properties: node's type stripping
  // (which the test suite runs under) does not support those.
  constructor(failure: unknown, leftBehind: string[]) {
    super(
      `${failure instanceof Error ? failure.message : String(failure)} — ` +
        `وتعذّر التراجع الكامل: ${leftBehind.join("، ")}. راجعها قبل أي محاولة تانية.`,
    );
    this.name = "WholesaleReturnUndoError";
    this.failure = failure;
    this.leftBehind = leftBehind;
  }
}

/** One credit per source invoice: the paid price of what came back from it. */
export function invoiceCredits(
  lines: Array<{ invoiceId: string; unitPrice: number; quantity: number }>,
): InvoiceCredit[] {
  const byInvoice = new Map<string, number>();
  for (const l of lines) {
    byInvoice.set(l.invoiceId, (byInvoice.get(l.invoiceId) ?? 0) + l.unitPrice * l.quantity);
  }
  // To the piastre — the same rounding the return record's `refund_amount` uses.
  return [...byInvoice].map(([invoiceId, amount]) => ({
    invoiceId,
    amount: Math.round(amount * 100) / 100,
  }));
}

export async function runWholesaleReturn(
  credits: InvoiceCredit[],
  steps: WholesaleReturnSteps,
): Promise<void> {
  const recordIds = await steps.writeRecords();
  const credited: Array<{ invoiceId: string; before: number }> = [];
  try {
    for (const c of credits) {
      const before = await steps.creditInvoice(c.invoiceId, c.amount);
      credited.push({ invoiceId: c.invoiceId, before });
    }
    await steps.appendLedger();
  } catch (e) {
    const leftBehind: string[] = [];
    // Newest first, so a partial credit run unwinds in reverse.
    for (const c of credited.reverse()) {
      try {
        await steps.restoreInvoice(c.invoiceId, c.before);
      } catch {
        leftBehind.push(`رصيد الفاتورة ${c.invoiceId}`);
      }
    }
    for (const id of recordIds) {
      try {
        await steps.deleteRecord(id);
      } catch {
        // A record with no ledger event only makes those units LESS
        // returnable — the safe direction — but it is still reported.
        leftBehind.push(`سجل المرتجع ${id}`);
      }
    }
    if (leftBehind.length > 0) throw new WholesaleReturnUndoError(e, leftBehind);
    throw e;
  }
}
