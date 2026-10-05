/** Supplier settlement preview arithmetic. The authoritative write locks and
 * allocates invoices inside record_financial_command, committing allocations
 * and ledger lines together. This pure allocator only previews the payment. */

import { round } from "./math.ts";

/** The fields of a purchase invoice a settlement needs. */
export interface SettleableInvoice {
  id: string;
  invoiceNumber?: string;
  totalAmount?: number;
  paidAmount?: number;
  remainingAmount?: number;
  dueDate?: string;
  createdAt?: unknown;
  supplierId?: string;
}

/** How much of one invoice is still open, EGP. Never negative. */
export function outstandingOn(invoice: SettleableInvoice): number {
  const stored = Number(invoice.remainingAmount);
  if (Number.isFinite(stored)) return Math.max(0, round(stored));
  const total = Number(invoice.totalAmount) || 0;
  const paid = Number(invoice.paidAmount) || 0;
  return Math.max(0, round(total - paid));
}

/**
 * This supplier's still-open invoices, oldest first.
 *
 * Oldest first because that is how a supplier account is actually settled —
 * the money pays down the debt that has been waiting longest. A newest-first
 * allocation would leave an ancient invoice open while a fresh one showed paid,
 * and the عمر الدين report would be nonsense.
 *
 * `dueDate` leads, with the creation date as the tiebreak: what is overdue
 * matters more than what was entered first.
 */
export function openInvoicesFor(
  invoices: readonly SettleableInvoice[],
  supplierId: string,
): SettleableInvoice[] {
  const asTime = (value: unknown): number => {
    const t = new Date(value as string).getTime();
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
  };
  return invoices
    .filter((i) => i.supplierId === supplierId && outstandingOn(i) > 0)
    .sort(
      (a, b) =>
        asTime(a.dueDate ?? a.createdAt) - asTime(b.dueDate ?? b.createdAt) ||
        asTime(a.createdAt) - asTime(b.createdAt),
    );
}

export interface PaymentAllocation {
  invoiceId: string;
  invoiceNumber: string;
  /** What was open on it before this payment. */
  outstanding: number;
  /** What this payment puts against it. */
  applied: number;
}

export interface PaymentPlan {
  allocations: PaymentAllocation[];
  /** Total actually placed against invoices. */
  applied: number;
  /**
   * Money left over after every open invoice is settled, EGP.
   *
   * NOT refused. `buildSupplierPaymentLines` allows overpaying on purpose: it
   * drives `payable_supplier` negative, which is exactly what a credit balance
   * with a supplier is, and refusing it would force the user to record a real
   * payment as something it is not. It is surfaced so the operator sees they
   * are creating a credit rather than clearing a debt.
   */
  unapplied: number;
}

/**
 * Spread a payment across the open invoices, oldest first.
 *
 * Pure: no ledger, no store, no rounding surprises — every figure is rounded
 * the way `round` rounds, so the plan the operator confirms and the lines the
 * ledger books cannot differ by a piastre.
 */
export function allocateSupplierPayment(
  openInvoices: readonly SettleableInvoice[],
  amount: number,
): PaymentPlan {
  const asked = Number(amount);
  if (!Number.isFinite(asked) || asked <= 0) {
    throw new Error("قيمة الدفعة لازم تكون أكبر من صفر");
  }

  let left = round(asked);
  const allocations: PaymentAllocation[] = [];

  for (const invoice of openInvoices) {
    if (left <= 0) break;
    const outstanding = outstandingOn(invoice);
    if (outstanding <= 0) continue;
    const applied = round(Math.min(outstanding, left));
    left = round(left - applied);
    allocations.push({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber ?? invoice.id,
      outstanding,
      applied,
    });
  }

  return {
    allocations,
    applied: round(asked - left),
    unapplied: round(left),
  };
}
