/**
 * مرتجع جملة — pick the invoice first, then the line, then the quantity.
 *
 * ## Why this replaced a product search
 *
 * Both offline return screens used to start from a free product picker: choose
 * a trader, then choose ANY product in the catalogue, at today's wholesale
 * price. Nothing asked whether that trader had ever bought it. The operator
 * could not answer "which invoice is this coming back against?" because the
 * screen never asked, and the ledger was handed a price that corresponded to no
 * sale — see the header of `lib/ledger/wholesale`.
 *
 * The order here is the business rule made visible:
 *
 *     التاجر → فواتيره → فاتورة → بنودها → المتبقي → الكمية
 *
 * A product the client never bought has no row to type a quantity into, and a
 * line that is already fully back shows a zero ceiling with a disabled box.
 * `resolveWholesaleReturn` re-checks every one of those rules before the ledger
 * is touched, so this screen is the explanation, not the enforcement.
 *
 * Presentational: it owns no submit, no event and no wallet. The caller keeps
 * the selection and decides what to do with it.
 */

import { useMemo, useState } from "react";
import { format } from "date-fns";
import { ChevronDown, ChevronLeft, Receipt } from "lucide-react";
import { formatMoney } from "@/lib/math";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  remainingWholesaleLines,
  type PriorWholesaleReturn,
  type ReturnableWholesaleLine,
  type WholesaleInvoiceDoc,
} from "@/lib/ledger/wholesale";

/** `invoiceId::lineKey` → quantity the operator typed. */
export type ReturnSelection = Record<string, number>;

export const selectionKey = (invoiceId: string, lineKey: string) => `${invoiceId}::${lineKey}`;

export interface WholesaleInvoiceReturnPickerProps {
  /** The chosen trader's invoices. Empty means they have never been invoiced. */
  invoices: readonly WholesaleInvoiceDoc[];
  /** Every return record in the store; the ceiling is derived per invoice. */
  priorReturns: readonly PriorWholesaleReturn[];
  selection: ReturnSelection;
  onSelectionChange: (next: ReturnSelection) => void;
  /** Shown instead of the list when no trader has been chosen yet. */
  clientMissing?: boolean;
}

function invoiceDate(invoice: WholesaleInvoiceDoc): string {
  const raw = invoice.createdAt;
  if (!raw) return "";
  const date = new Date(raw as string);
  return Number.isNaN(date.getTime()) ? "" : format(date, "yyyy/MM/dd");
}

export function WholesaleInvoiceReturnPicker({
  invoices,
  priorReturns,
  selection,
  onSelectionChange,
  clientMissing = false,
}: WholesaleInvoiceReturnPickerProps) {
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null);

  // One pass over the records per render, not one per line. Also the snapshot
  // every ceiling on screen agrees on.
  const returnable = useMemo(() => {
    const byInvoice = new Map<string, ReturnableWholesaleLine[]>();
    for (const invoice of invoices) {
      byInvoice.set(invoice.id, remainingWholesaleLines(invoice, priorReturns));
    }
    return byInvoice;
  }, [invoices, priorReturns]);

  const setQty = (invoiceId: string, line: ReturnableWholesaleLine, raw: string) => {
    const key = selectionKey(invoiceId, line.key);
    const next = { ...selection };
    const asked = Number(raw);
    // Clamped, not rejected: typing over the ceiling means "all of it", and a
    // silent clamp beats an error message on every keystroke. The resolver
    // refuses an over-quantity anyway, so this cannot be the only guard.
    const qty = Number.isFinite(asked) ? Math.min(Math.max(0, asked), line.remaining) : 0;
    if (qty > 0) next[key] = qty;
    else delete next[key];
    onSelectionChange(next);
  };

  if (clientMissing) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-center text-base text-muted-foreground">
        اختر التاجر أولاً عشان نعرض فواتيره.
      </div>
    );
  }

  if (invoices.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        title="مفيش فواتير جملة للتاجر ده"
        description="المرتجع لازم يكون من فاتورة اتباعت فعلاً للتاجر. لو الفاتورة اتسجلت على تاجر تاني، افتح المرتجع من عنده."
      />
    );
  }

  return (
    <div className="space-y-2">
      {invoices.map((invoice) => {
        const lines = returnable.get(invoice.id) ?? [];
        const leftOnInvoice = lines.reduce((sum, l) => sum + l.remaining, 0);
        const pickedOnInvoice = lines.reduce(
          (sum, l) => sum + (selection[selectionKey(invoice.id, l.key)] ?? 0),
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
                  {formatMoney(Number(invoice.goodsTotal ?? 0))}
                  {Number(invoice.discountAmount) > 0
                    ? ` − خصم ${formatMoney(Number(invoice.discountAmount))}`
                    : ""}
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
                  const key = selectionKey(invoice.id, line.key);
                  const picked = selection[key] ?? 0;
                  return (
                    <div key={key} className="flex flex-wrap items-center gap-3 p-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{line.productName}</p>
                        <p className="text-xs text-muted-foreground">
                          اتباع {line.sold} · اترجع {line.returned} · متبقي {line.remaining}
                        </p>
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-bold">{formatMoney(line.netUnitPrice)}</p>
                        {line.netUnitPrice !== line.listUnitPrice && (
                          <p className="text-xs text-muted-foreground line-through">
                            {formatMoney(line.listUnitPrice)}
                          </p>
                        )}
                      </div>
                      <input
                        type="number"
                        min={0}
                        max={line.remaining}
                        step={1}
                        disabled={line.remaining <= 0}
                        value={picked === 0 ? "" : picked}
                        placeholder="0"
                        onChange={(e) => setQty(invoice.id, line, e.target.value)}
                        className="h-10 w-24 rounded-lg border border-input bg-background px-3 text-lg font-bold text-left disabled:opacity-40"
                      />
                      <span className="w-24 text-left text-sm font-bold text-green-700 dark:text-green-400">
                        {picked > 0 ? formatMoney(picked * line.netUnitPrice) : ""}
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
