/**
 * What we have bought from a supplier, and what we have handed over.
 *
 * Summed from the invoice DOCUMENTS, per brief §3.5 ("from actual invoices").
 * The third number — what is still owed — deliberately does not live here: it
 * is `SUM(payable_supplier)` from the ledger, so it stays right no matter
 * which screen moved the money.
 *
 * It is a module rather than eight lines inside شاشة المشتريات because two
 * screens now feed it: the full invoice form and المنتجات' quick توريد. One
 * function means a quick receive cannot be counted differently from a typed
 * invoice — that split is exactly what this session has spent its time
 * deleting elsewhere.
 */

export interface SupplierInvoiceTotals {
  /** Value of everything invoiced by this supplier. */
  purchased: number;
  /** Of that, how much has actually been handed over. */
  paid: number;
}

export interface CountableInvoice {
  supplierId: string;
  totalAmount: number;
  paidAmount: number;
}

/** supplierId → { purchased, paid }. Suppliers with no invoices are absent. */
export function supplierTotalsFrom(
  invoices: CountableInvoice[],
): Map<string, SupplierInvoiceTotals> {
  const totals = new Map<string, SupplierInvoiceTotals>();
  for (const invoice of invoices) {
    const acc = totals.get(invoice.supplierId) ?? { purchased: 0, paid: 0 };
    acc.purchased += invoice.totalAmount;
    acc.paid += invoice.paidAmount;
    totals.set(invoice.supplierId, acc);
  }
  return totals;
}

/** One supplier's totals, zeroed when they have no invoices yet. */
export function totalsForSupplier(
  invoices: CountableInvoice[],
  supplierId: string,
): SupplierInvoiceTotals {
  return supplierTotalsFrom(invoices).get(supplierId) ?? { purchased: 0, paid: 0 };
}
