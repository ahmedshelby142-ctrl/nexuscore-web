/**
 * تقرير النواقص وطلبات التوريد — Shortages & Backorders.
 *
 * The table. The arithmetic behind it — why the deficit is the measured
 * `shortfall` rather than "ordered minus stock", and why "open" means
 * `pending` and `processing` only — lives in `lib/shortages.ts`, which is
 * pure and has a self-check beside it.
 */

import { useMemo } from "react";
import { AlertTriangle, PackageSearch, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useOrderStore } from "@/store/useOrderStore";
import { computeShortages, type ShortageRow } from "@/lib/shortages";
import { printTableAsPdf } from "@/lib/pdfGenerator";
import { formatQty } from "@/lib/math";

export function ShortagesReport() {
  const products = useBusinessStore((s) => s.products);
  const orders = useOrderStore((s) => s.orders);

  const rows = useMemo(() => computeShortages(orders, products), [orders, products]);
  const totalDeficit = rows.reduce((sum, r) => sum + r.deficit, 0);

  const handleExportPdf = () =>
    printTableAsPdf({
      title: "تقرير النواقص وطلبات التوريد",
      columns: [
        { label: "المنتج", accessor: (r: ShortageRow) => r.productName },
        { label: "SKU", accessor: (r: ShortageRow) => r.sku, align: "center" },
        { label: "المخزون الحالي", accessor: (r: ShortageRow) => String(r.stock), align: "center" },
        { label: "المطلوب بالطلبات", accessor: (r: ShortageRow) => String(r.required), align: "center" },
        { label: "العجز (للتوريد/التصنيع)", accessor: (r: ShortageRow) => String(r.deficit), align: "center" },
        {
          label: "الطلبات المنتظرة",
          accessor: (r: ShortageRow) =>
            r.waitingOrders.map((o) => `${o.orderNumber} (${o.customerName})`).join("، ") || "—",
        },
      ],
      rows,
      footer: `عدد المنتجات الناقصة: ${rows.length} — إجمالي العجز: ${totalDeficit} وحدة`,
    });

  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <div className="mb-6 flex items-start justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs tracking-wider text-muted-foreground">النواقص</p>
          <h3 className="font-display text-2xl font-bold mt-1 flex items-center gap-2">
            <AlertTriangle className="size-5 text-amber-600" />
            تقرير النواقص وطلبات التوريد
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            العجز هو العدد اللي المخزون ما غطاهوش وقت تأكيد النواقص — ده بالظبط اللي
            محتاج تشتريه أو تصنّعه عشان تقفل الطلبات المفتوحة، مش إجمالي الطلب.
          </p>
        </div>
        {rows.length > 0 && (
          <Button variant="outline" size="sm" onClick={handleExportPdf}>
            <Printer className="size-3.5 ml-2" />
            طباعة
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={PackageSearch}
          title="مفيش نواقص"
          description="مفيش طلب نواقص مفتوح غير مغطّى — كل حاجة اتباعت كان ليها رصيد."
        />
      ) : (
        <>
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 p-4">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              {rows.length} منتج ناقص — إجمالي العجز {formatQty(totalDeficit)} وحدة
            </p>
          </div>

          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-right">المنتج</TableHead>
                  <TableHead className="text-center">SKU</TableHead>
                  <TableHead className="text-center">المخزون الحالي</TableHead>
                  <TableHead className="text-center">المطلوب بالطلبات</TableHead>
                  <TableHead className="text-center">العجز (للتوريد/التصنيع)</TableHead>
                  <TableHead className="text-right">الطلبات والعملاء المنتظرين</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.productId} className="bg-amber-50/40 dark:bg-amber-950/10">
                    <TableCell className="font-medium text-right">{row.productName}</TableCell>
                    <TableCell className="text-center text-muted-foreground">{row.sku}</TableCell>
                    <TableCell className="text-center">{formatQty(row.stock)}</TableCell>
                    <TableCell className="text-center font-medium">{formatQty(row.required)}</TableCell>
                    <TableCell className="text-center">
                      <Badge variant="destructive" className="font-bold">
                        {formatQty(row.deficit)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {/* Who is actually waiting — the reason this row exists.
                          A count alone cannot be acted on. */}
                      <div className="flex flex-wrap gap-1 justify-end">
                        {row.waitingOrders.map((o) => (
                          <Badge key={o.orderId} variant="outline" className="font-normal">
                            <span className="font-mono text-[10px]">{o.orderNumber}</span>
                            <span className="mr-1">— {o.customerName}</span>
                          </Badge>
                        ))}
                        {row.waitingOrders.length === 0 && (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
