/**
 * مرتجع مورد — pick the receipt first, then the line, then the quantity.
 *
 * ## Why this replaced a product search
 *
 * شاشة المشتريات used to start a return from a free product picker priced at
 * `costOf(productId)` — the weighted average of everything on the shelf.
 * Nothing asked whether the chosen supplier had ever sold us that product, and
 * the cost credited back had no relationship to what we actually paid them.
 * Buy at 100 from one supplier and at 200 from another and the average is 150:
 * returning the first supplier's goods credited them 50 a unit they never
 * charged. That is the reported "inflated cost", and it is an input problem,
 * not an arithmetic one.
 *
 * The order here is the business rule made visible:
 *
 *     المورد → فواتيره → فاتورة → بنودها → المتبقي → الكمية
 *
 * A product that supplier never supplied has no row to type a quantity into,
 * and each line shows what it cost ON THAT RECEIPT. `resolveSupplierReturn`
 * re-checks every rule before the ledger is touched, so this screen is the
 * explanation, not the enforcement.
 *
 * Presentational: it owns no submit and no event. The caller keeps the
 * selection and decides what to do with it.
 */

import { useMemo, useState } from "react";
import { format } from "date-fns";
import { ChevronDown, ChevronLeft, FileText } from "lucide-react";
import { formatMoney } from "@/lib/math";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  remainingPurchaseLines,
  type PriorSupplierReturn,
  type PurchaseInvoiceDoc,
  type ReturnablePurchaseLine,
} from "@/lib/ledger/purchases";

/** `invoiceId::lineKey` → quantity the operator typed. */
export type SupplierReturnSelection = Record<string, number>;

export const supplierSelectionKey = (invoiceId: string, lineKey: string) =>
  `${invoiceId}::${lineKey}`;

export interface SupplierReturnPickerProps {
  /** The chosen supplier's purchase invoices. */
  invoices: readonly PurchaseInvoiceDoc[];
  /** From the ledger — what has already gone back, per invoice per product. */
  priorReturns: readonly PriorSupplierReturn[];
  selection: SupplierReturnSelection;
  onSelectionChange: (next: SupplierReturnSelection) => void;
  /** What is physically on the shelf, so a line can say when it cannot ship. */
  onHand?: (productId: string) => number;
  /** Shown instead of the list when no supplier has been chosen yet. */
  supplierMissing?: boolean;
}

function invoiceDate(invoice: PurchaseInvoiceDoc): string {
  const raw = invoice.createdAt;
  if (!raw) return "";
  const date = new Date(raw as string);
  return Number.isNaN(date.getTime()) ? "" : format(date, "yyyy/MM/dd");
}

const STATUS_TEXT: Record<string, string> = {
  paid: "مدفوعة",
  partial: "مدفوعة جزئياً",
  unpaid: "آجلة",
  overdue: "متأخرة",
};

export function SupplierReturnPicker({
  invoices,
  priorReturns,
  selection,
  onSelectionChange,
  onHand,
  supplierMissing = false,
}: SupplierReturnPickerProps) {
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // One pass over the ledger rows per render, not one per line — and the
  // snapshot every ceiling on screen agrees on.
  const returnable = useMemo(() => {
    const byInvoice = new Map<string, ReturnablePurchaseLine[]>();
    for (const invoice of invoices) {
      byInvoice.set(invoice.id, remainingPurchaseLines(invoice, priorReturns));
    }
    return byInvoice;
  }, [invoices, priorReturns]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return invoices;
    return invoices.filter((i) =>
      [i.invoiceNumber, i.status, String(i.totalAmount ?? ""), invoiceDate(i)]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q)),
    );
  }, [invoices, query]);

  const setQty = (invoiceId: string, line: ReturnablePurchaseLine, raw: string) => {
    const key = supplierSelectionKey(invoiceId, line.key);
    const next = { ...selection };
    const asked = Number(raw);
    // Clamped, not rejected: typing over the ceiling means "all of it". The
    // resolver refuses an over-quantity anyway, so this is never the only guard.
    const ceiling = Math.min(line.remaining, onHand ? Math.max(0, onHand(line.productId)) : Infinity);
    const qty = Number.isFinite(asked) ? Math.min(Math.max(0, asked), ceiling) : 0;
    if (qty > 0) next[key] = qty;
    else delete next[key];
    onSelectionChange(next);
  };

  if (supplierMissing) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-center text-base text-muted-foreground">
        اختر المورد أولاً عشان نعرض فواتيره.
      </div>
    );
  }

  if (invoices.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="مفيش فواتير مشتريات للمورد ده"
        description="المرتجع لازم يكون من فاتورة اتشحنت فعلاً من المورد، عشان التكلفة تطلع بسعر الشراء الحقيقي مش بمتوسط المخزن."
      />
    );
  }

  return (
    <div className="space-y-2">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="ابحث برقم الفاتورة أو التاريخ أو المبلغ..."
        className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
      />

      {shown.length === 0 && (
        <p className="p-3 text-center text-sm text-muted-foreground">مفيش فاتورة مطابقة للبحث.</p>
      )}

      {shown.map((invoice) => {
        const lines = returnable.get(invoice.id) ?? [];
        const leftOnInvoice = lines.reduce((sum, l) => sum + l.remaining, 0);
        const pickedOnInvoice = lines.reduce(
          (sum, l) => sum + (selection[supplierSelectionKey(invoice.id, l.key)] ?? 0),
          0,
        );
        const isOpen = openInvoiceId === invoice.id;

        return (
          <div key={invoice.id} className="rounded-xl border overflow-hidden">
            <button
              type="button"
              onClick={() => setOpenInvoiceId(isOpen ? null : invoice.id)}
              className={cn(
                "flex w-full items-center gap-3 p-3 text-right transition-colors",
                isOpen ? "bg-muted" : "hover:bg-muted/50",
              )}
            >
              {isOpen ? (
                <ChevronDown className="h-4 w-4 shrink-0" />
              ) : (
                <ChevronLeft className="h-4 w-4 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold">{invoice.invoiceNumber ?? invoice.id}</span>
                  <span className="text-xs text-muted-foreground">{invoiceDate(invoice)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatMoney(Number(invoice.totalAmount ?? 0))}
                  {invoice.status ? ` · ${STATUS_TEXT[invoice.status] ?? invoice.status}` : ""}
                </p>
              </div>
              {pickedOnInvoice > 0 && (
                <Badge variant="default" className="shrink-0">
                  مختار {pickedOnInvoice}
                </Badge>
              )}
              <Badge variant={leftOnInvoice > 0 ? "secondary" : "outline"} className="shrink-0">
                {leftOnInvoice > 0 ? `متبقي للإرجاع ${leftOnInvoice}` : "اترجعت بالكامل"}
              </Badge>
            </button>

            {isOpen && (
              <div className="divide-y border-t">
                {lines.length === 0 && (
                  <p className="p-3 text-sm text-muted-foreground">
                    الفاتورة دي مفيهاش بنود مسجلة.
                  </p>
                )}
                {lines.map((line) => {
                  const key = supplierSelectionKey(invoice.id, line.key);
                  const picked = selection[key] ?? 0;
                  const shelf = onHand ? onHand(line.productId) : Infinity;
                  // Goods cannot go back if they are not here. Unlike a customer
                  // return, nothing arrives — units leave the shelf.
                  const blockedByShelf = line.remaining > 0 && shelf <= 0;
                  return (
                    <div key={key} className="flex flex-wrap items-center gap-3 p-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{line.productName}</p>
                        <p className="text-xs text-muted-foreground">
                          {line.sku ? `${line.sku} · ` : ""}
                          اتشحن {line.received} · اترجع {line.returned} · متبقي {line.remaining}
                          {Number.isFinite(shelf) ? ` · بالمخزن ${shelf}` : ""}
                        </p>
                        {blockedByShelf && (
                          <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                            مفيش كمية بالمخزن ترجّعها
                          </p>
                        )}
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-bold">{formatMoney(line.unitCost)}</p>
                        <p className="text-[10px] text-muted-foreground">تكلفة الشراء</p>
                      </div>
                      <input
                        type="number"
                        min={0}
                        max={Math.min(line.remaining, Number.isFinite(shelf) ? shelf : line.remaining)}
                        step={1}
                        disabled={line.remaining <= 0 || blockedByShelf}
                        value={picked === 0 ? "" : picked}
                        placeholder="0"
                        onChange={(e) => setQty(invoice.id, line, e.target.value)}
                        className="h-10 w-24 rounded-lg border border-input bg-background px-3 text-lg font-bold text-left disabled:opacity-40"
                      />
                      <span className="w-24 text-left text-sm font-bold text-amber-700 dark:text-amber-400">
                        {picked > 0 ? formatMoney(picked * line.unitCost) : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
