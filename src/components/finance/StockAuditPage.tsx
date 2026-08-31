import { useState, useMemo, useEffect } from "react";
import { Package, Plus, Search, FileText, AlertTriangle, Copy, Inbox } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useFinancialStore } from "@/store/useFinancialStore";
import { add, subtract, formatQty, formatMoney } from "@/lib/math";
import { activeProducts } from "@/lib/product";
import { appendEvent, events as fetchLedgerEvents } from "@/lib/ledger";
import {
  buildStockAdjustmentLines,
  countDiscrepancies,
  auditNetValue,
  isCounted,
} from "@/lib/ledger/audit";
import { useStock } from "@/lib/ledger/useStock";
import { getActualStock } from "@/lib/product";
import { useBalances } from "@/lib/ledger/useBalances";
import { generateFinancialPdf } from "@/lib/pdfGenerator";
import type { StockActionType, StockLog } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";

const ACTION_LABELS: Record<StockActionType, string> = {
  sale: "بيع",
  purchase: "شراء",
  return: "إرجاع",
  adjustment: "تعديل",
  import: "استيراد",
  ecommerce_order: "طلب إلكتروني",
  ecommerce_return: "إرجاع إلكتروني",
};

export function StockAuditPage() {
  // A جرد counts what is on the shelf today, so archived products are out of
  // it — their history stays in the ledger either way.
  const allProducts = useBusinessStore((s) => s.products);
  const products = useMemo(() => activeProducts(allProducts), [allProducts]);
  // What the ledger says is on the shelf, and what each unit really cost.
  const { qtyOf, costOf, refresh: refreshStock } = useStock();
  const [isSaving, setIsSaving] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  // Nothing is written until the auditor has seen a summary of what will
  // change and confirmed it. "تأكيد المراجعة" used to commit on the first click.
  const [isReviewing, setIsReviewing] = useState(false);
  
  // Ledger-based audit history
  const [auditEvents, setAuditEvents] = useState<any[]>([]);

  // رصيد المخزن — SUM(stock.amount), the weighted-average value actually on the
  // shelf. This card used to show SUM(wallet), the TILL total, on a screen about
  // inventory: a real number, answering a question nobody asked here.
  const { total: inventoryValue, refresh: refreshInventoryValue } = useBalances("stock");

  const [isAuditOpen, setIsAuditOpen] = useState(false);
  const [auditCategory, setAuditCategory] = useState("all");
  const [auditDateRange, setAuditDateRange] = useState({
    startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    endDate: new Date().toISOString().slice(0, 10),
  });
  const [auditResults, setAuditResults] = useState<
    Array<{
      product: any;
      variantName?: string;
      /** What the auditor is shown — the ledger for a plain product. */
      systemQty: number;
      /** What the shelf RECORD holds, which the mirror move is relative to. */
      mirrorQty: number;
      actualQty: number | "";
      discrepancy: number;
    }>
  >([]);

  const categories = useMemo(() => {
    const all = products.map((p) => p.category);
    return ["all", ...Array.from(new Set(all))];
  }, [products]);

  const filteredProducts = useMemo(() => {
    if (auditCategory === "all") return products;
    return products.filter((p) => p.category === auditCategory);
  }, [products, auditCategory]);

  // Fetch stock audit events from the ledger
  const fetchAudits = async () => {
    try {
      const rows = await fetchLedgerEvents({ refType: "stock_audit" });
      setAuditEvents(rows);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchAudits();
  }, []);

  const auditsByDate = useMemo(() => {
    const start = new Date(auditDateRange.startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(auditDateRange.endDate);
    end.setHours(23, 59, 59, 999);
    
    return auditEvents.filter((ev) => {
      // `createdAt`, not `created_at`. The driver hands back camelCase; reading
      // the snake_case name gave `undefined` → `Invalid Date` → every
      // comparison false, so this table has never rendered a single row. The
      // fallback covers a raw row arriving straight off the wire.
      const logDate = new Date(ev.createdAt ?? ev.created_at);
      return logDate >= start && logDate <= end;
    });
  }, [auditEvents, auditDateRange]);

  const handlePerformAudit = () => {
    const results = filteredProducts.flatMap((product) => {
      const vars = product.metadata?.variants || [];
      if (vars.length > 0) {
        // The ledger holds ONE quantity per product; only the mirror knows the
        // per-درجة split. So a variant row is counted against the mirror, and
        // the product TOTAL is reconciled against the ledger at commit time.
        return vars.map((v: any) => ({
          product,
          variantName: v.name,
          systemQty: v.stock || 0,
          mirrorQty: v.stock || 0,
          actualQty: "" as any,
          discrepancy: 0,
        }));
      }
      return [{
        product,
        // What the AUDITOR is shown is what every other screen shows: the
        // ledger. It used to be `getActualStock` — the mirror — which is how a
        // جرد could correct the shelf record and leave the ledger disagreeing
        // by exactly the drift it was run to find.
        systemQty: qtyOf(product.id),
        mirrorQty: getActualStock(product),
        actualQty: "" as any,
        discrepancy: 0,
      }];
    });
    setAuditResults(results);
    setIsReviewing(false);
    setAuditError(null);
  };

  const handleActualQtyChange = (productId: string, variantName: string | undefined, actualQty: string) => {
    const qty = parseInt(actualQty) || 0;
    setAuditResults((prev) =>
      prev.map((r) =>
        r.product.id === productId && r.variantName === variantName
          ? {
              ...r,
              actualQty: actualQty as any,
              discrepancy: subtract(r.systemQty, qty),
            }
          : { ...r },
      ),
    );
  };

  /**
   * Only rows the user actually counted.
   *
   * A blank box means "not counted yet", NOT "counted zero". Treating the two
   * the same wrote off every product the auditor had not reached: start a جرد
   * on a category, count two items, confirm — and everything else in that
   * category was booked as shrinkage at full cost.
   */
  const countedRows = auditResults.filter((r) => isCounted(r.actualQty));

  /**
   * The ledger correction: one item per PRODUCT, never per درجة.
   *
   * The ledger keeps a single quantity per product, so a variant product needs
   * its whole new total — the درجات that were counted, plus the ones that were
   * not, still holding what they held. Sending a line per variant would
   * reconcile each against a product-level number and land nowhere near it.
   *
   * `systemQty` is the LEDGER's figure so the delta corrects the ledger to the
   * count. The mirror is moved separately below, against its own baseline —
   * two books, one truth, each reached from where it actually stands.
   */
  const auditItems = useMemo(() => {
    const byProduct = new Map<string, { counted: number; touched: boolean }>();

    for (const r of auditResults) {
      const entry = byProduct.get(r.product.id) ?? { counted: 0, touched: false };
      if (isCounted(r.actualQty)) {
        entry.counted += parseInt(r.actualQty as any) || 0;
        entry.touched = true;
      } else {
        // Not counted: it keeps whatever the shelf record already says.
        entry.counted += r.mirrorQty ?? 0;
      }
      byProduct.set(r.product.id, entry);
    }

    return [...byProduct.entries()]
      .filter(([, v]) => v.touched)
      .map(([productId, v]) => ({
        productId,
        systemQty: qtyOf(productId),
        countedQty: v.counted,
        // Real weighted-average cost from the ledger. The code this replaces
        // valued every missing unit at a flat 10 ج.م, whatever the product.
        unitCost: costOf(productId),
      }));
  }, [auditResults, qtyOf, costOf]);

  const handleConfirmAudit = async () => {
    const items = auditItems;

    const lines = buildStockAdjustmentLines({ items });
    if (lines.length === 0) {
      // Everything matched. There is nothing to correct, and appending an
      // event with no lines is rejected by the ledger anyway.
      setIsAuditOpen(false);
      setAuditResults([]);
      return;
    }

    setIsSaving(true);
    setAuditError(null);

    try {
      // ONE event for the whole جرد. Every discrepancy lands together or none
      // does — a half-applied audit would leave some products corrected and
      // others not, with no way to tell which pass a number belongs to.
      await appendEvent({
        kind: "stock_adjustment",
        actor: "جرد",
        refType: "stock_audit",
        payload: {
          countedProducts: items.length,
          discrepancies: countDiscrepancies(items),
          netValue: auditNetValue(items),
        },
        lines: buildStockAdjustmentLines({ items }),
      });
    } catch (e) {
      setAuditError(
        `لم يُسجَّل الجرد ولم يتغيّر المخزون. ${e instanceof Error ? e.message : String(e)}`,
      );
      setIsSaving(false);
      return;
    }

    // We no longer manually log to stockLogs for UI history; the ledger event
    // is the source of truth for audits. 

    // The count IS the new truth, for plain products as much as for variants.
    // This used to be gated on `if (result.variantName)`, so auditing a shop
    // of plain products moved the ledger and left every record untouched —
    // and the next جرد reported the very same discrepancy again.
    //
    // An audit states an absolute quantity, so it is expressed as the delta
    // from what the record currently holds. `applyStockMoves` then owns the
    // write, exactly as a sale or a توريد does.
    useBusinessStore.getState().applyStockMoves(
      countedRows.map((result) => ({
        productId: result.product.id,
        // Relative to the MIRROR's own figure, not the ledger's. Using one
        // baseline for both books is what let a جرد fix one and break the other.
        delta: (parseInt(result.actualQty as any) || 0) - (result.mirrorQty ?? result.systemQty),
        variantName: result.variantName,
      })),
    );

    refreshStock();
    // The card reads its OWN aggregation, so `refreshStock` alone left رصيد
    // المخزن showing the pre-جرد figure next to a corrected shelf.
    refreshInventoryValue();
    fetchAudits();
    setIsSaving(false);
    setIsAuditOpen(false);
    setAuditResults([]);
    setIsReviewing(false);
  };

  const handleExportPdf = () => {
    const discrepancies = auditResults.filter((r) => r.discrepancy !== 0);
    generateFinancialPdf({
      companyName: "تقرير جرد المخزون",
      reportDate: new Date(),
      financialSummary: {
        totalSales: 0,
        totalExpenses: discrepancies.reduce((s, r) => s + Math.abs(r.discrepancy) * 10, 0),
        netProfit: 0,
        shippingProfit: 0,
      },
      walletBalances: [],
      shareholderDistributions: [],
      expenses: [],
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">الجرد وسجل حركة الصنف</h1>
          <p className="text-muted-foreground mt-1">مطابقة المخزون الفعلي بالنظام وتسجيل الحركات</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-3 mb-2">
            <Package className="size-5 text-primary" />
            <p className="text-sm text-muted-foreground">إجمالي SKUs</p>
          </div>
          <p className="text-2xl font-bold">{products.length}</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-3 mb-2">
            <FileText className="size-5 text-blue-600" />
            <p className="text-sm text-muted-foreground">عمليات الجرد</p>
          </div>
          <p className="text-2xl font-bold">{auditEvents.length}</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-3 mb-2">
            <AlertTriangle className="size-5 text-amber-600" />
            <p className="text-sm text-muted-foreground">رصيد المخزن (بالتكلفة)</p>
          </div>
          <p className="text-2xl font-bold">{formatMoney(inventoryValue)}</p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-4">
        <Button onClick={() => setIsAuditOpen(true)}>
          <Plus className="size-4 ml-2" /> بدء مراجعة جرد
        </Button>
        <Button variant="outline" onClick={handleExportPdf}>
          <FileText className="size-4 ml-2" /> تصدير PDF
        </Button>
        <div className="flex items-center gap-2">
          <Label htmlFor="startDate">من تاريخ:</Label>
          <Input
            id="startDate"
            type="date"
            value={auditDateRange.startDate}
            onChange={(e) => setAuditDateRange((r) => ({ ...r, startDate: e.target.value }))}
            className="w-auto"
          />
          <Label htmlFor="endDate">إلى تاريخ:</Label>
          <Input
            id="endDate"
            type="date"
            value={auditDateRange.endDate}
            onChange={(e) => setAuditDateRange((r) => ({ ...r, endDate: e.target.value }))}
            className="w-auto"
          />
        </div>
      </div>

      {/* Stock Logs Table */}
      <div className="rounded-2xl border border-border bg-card p-6">
        <h3 className="font-display text-xl font-bold mb-4">سجل حركة المخزون</h3>
        {auditsByDate.length === 0 ? (
          <div className="py-8">
            <EmptyState icon={Inbox} title="لا توجد حركات مخزون مسجلة" />
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right px-4">التاريخ</TableHead>
                  <TableHead className="text-right px-4">المرجع</TableHead>
                  <TableHead className="text-center px-4">المنتجات المجردة</TableHead>
                  <TableHead className="text-center px-4">المنتجات المخالفة</TableHead>
                  <TableHead className="text-center px-4">صافي العجز/الزيادة</TableHead>
                  <TableHead className="text-right px-4">الموظف</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {auditsByDate
                  .map((ev) => {
                    const payload = ev.payload || {};
                    return (
                      <TableRow key={ev.id}>
                        <TableCell className="text-sm px-4">
                          {new Date(ev.createdAt ?? ev.created_at).toLocaleString("ar-EG")}
                        </TableCell>
                        <TableCell className="font-mono text-xs px-4">
                          {ev.id.split('-')[0]}
                        </TableCell>
                        <TableCell className="text-center px-4 font-mono">
                          {payload.countedProducts || 0}
                        </TableCell>
                        <TableCell className="text-center px-4 font-mono text-amber-600">
                          {payload.discrepancies || 0}
                        </TableCell>
                        <TableCell className="text-center px-4 font-mono font-bold">
                          {payload.netValue === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : payload.netValue < 0 ? (
                            <span className="text-red-600">عجز {formatQty(Math.abs(payload.netValue))} ج.م</span>
                          ) : (
                            <span className="text-green-600">زيادة {formatQty(payload.netValue)} ج.م</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm px-4">{ev.actor || "النظام"}</TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Audit Dialog */}
      <Dialog open={isAuditOpen} onOpenChange={setIsAuditOpen}>
        {/* A column that does not scroll as a whole: only the middle scrolls,
            so the confirm buttons are ALWAYS on screen. They used to sit after
            a tall body inside a scrolling dialog — on a laptop they fell below
            the fold, and the wheel scrolled the inner product table instead of
            the dialog, so the جرد looked like it had no way to commit. */}
        <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>مراجعة جرد المخزون</DialogTitle>
            <DialogDescription>أدخل الكمية الفعلية للمنتجات للمقارنة مع النظام</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 flex-1 overflow-y-auto min-h-0 pl-1">
            <div className="space-y-2">
              <Label>الفئة</Label>
              <select
                value={auditCategory}
                onChange={(e) => setAuditCategory(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {categories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat === "all" ? "كل الفئات" : cat}
                  </option>
                ))}
              </select>
            </div>

            <Button onClick={handlePerformAudit}>
              <Search className="size-4 ml-2" /> بدء المراجعة
            </Button>

            {auditResults.length > 0 && (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-right px-4">SKU</TableHead>
                      <TableHead className="text-right px-4">اسم المنتج</TableHead>
                      <TableHead className="text-center px-4">الكمية في النظام</TableHead>
                      <TableHead className="text-center px-4">الكمية الفعلية</TableHead>
                      <TableHead className="text-center px-4">الفرق</TableHead>
                      <TableHead className="text-center px-4">قيمة الفرق</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {auditResults.map((r, idx) => (
                      <TableRow key={idx}>
                        <TableCell className="font-mono text-xs px-4">{r.product.sku}</TableCell>
                        <TableCell className="text-sm px-4">
                          {r.product.name}
                          {r.variantName && (
                            <Badge variant="outline" className="ml-2 text-[10px]">
                              {r.variantName}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-center px-4 font-mono">
                          {formatQty(r.systemQty)}
                        </TableCell>
                        <TableCell className="text-center px-4">
                          <Input
                            type="number"
                            min="0"
                            value={r.actualQty}
                            onChange={(e) => handleActualQtyChange(r.product.id, r.variantName, e.target.value)}
                            className="w-20 mx-auto text-center"
                          />
                        </TableCell>
                        {/* `discrepancy` is system − counted, so a POSITIVE
                            number means units are missing. Spelled out in words
                            as well as sign and colour, because a bare "-2" does
                            not tell an owner whether that is good or bad. */}
                        <TableCell className="text-center px-4">
                          {String(r.actualQty ?? "").trim() === "" ? (
                            <span className="text-xs text-muted-foreground">لم تُجرد</span>
                          ) : r.discrepancy > 0 ? (
                            <span className="font-mono font-semibold text-red-600">
                              عجز {formatQty(Math.abs(r.discrepancy))}
                            </span>
                          ) : r.discrepancy < 0 ? (
                            <span className="font-mono font-semibold text-green-600">
                              زيادة {formatQty(Math.abs(r.discrepancy))}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">مطابق</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center px-4 font-mono text-sm">
                          {String(r.actualQty ?? "").trim() === "" || r.discrepancy === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <span className={r.discrepancy > 0 ? "text-red-600" : "text-green-600"}>
                              {formatQty(
                                Math.round(Math.abs(r.discrepancy) * costOf(r.product.id)),
                              )}{" "}
                              ج.م
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
          {/* The confirmation step, deliberately outside the scroll area so it
              is read where the buttons are. Nothing is written until the
              auditor has seen exactly what will change and pressed the second
              button. */}
          {isReviewing && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 space-y-2">
              <p className="text-sm font-semibold text-amber-900">
                مراجعة أخيرة قبل التسجيل
              </p>
              <ul className="text-sm text-amber-900 space-y-1">
                <li>• منتجات اتجردت: {countedRows.length} من {auditResults.length}</li>
                <li>• فروقات هتتسجّل: {countDiscrepancies(auditItems)}</li>
                <li>
                  •{" "}
                  {auditNetValue(auditItems) < 0
                    ? `صافي عجز: ${formatQty(Math.round(Math.abs(auditNetValue(auditItems))))} ج.م`
                    : auditNetValue(auditItems) > 0
                      ? `صافي زيادة: ${formatQty(Math.round(auditNetValue(auditItems)))} ج.م`
                      : "مفيش فرق في القيمة"}
                </li>
              </ul>
              {countedRows.length < auditResults.length && (
                <p className="text-xs text-amber-800">
                  المنتجات اللي مجردتهاش مش هتتغيّر — سيبها فاضية وهي هتفضل زي ما هي.
                </p>
              )}
              <p className="text-xs text-amber-800">
                ده هيتسجّل كحركة جرد واحدة في الدفتر، ومش هينفع يتلغي — التصحيح بيبقى بجرد جديد.
              </p>
            </div>
          )}

          {auditError && (
            <div className="rounded-xl p-4 flex items-start gap-3 bg-red-50 border border-red-200">
              <AlertTriangle className="size-5 text-red-600 mt-0.5 shrink-0" />
              <p className="text-sm font-medium text-red-900">{auditError}</p>
            </div>
          )}
          <DialogFooter className="gap-2 shrink-0 border-t border-border pt-3">
            <Button
              variant="outline"
              onClick={() => (isReviewing ? setIsReviewing(false) : setIsAuditOpen(false))}
            >
              {isReviewing ? "رجوع" : "إلغاء"}
            </Button>
            {isReviewing ? (
              <Button onClick={() => void handleConfirmAudit()} disabled={isSaving}>
                <Copy className="size-4 ml-2" />
                {isSaving ? "جاري التسجيل..." : "تأكيد وتسجيل الجرد"}
              </Button>
            ) : (
              <div className="flex items-center gap-3 flex-wrap justify-end">
                {auditResults.length > 0 && countedRows.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    اكتب الكمية الفعلية لمنتج واحد على الأقل عشان تقدر تراجع وتسجّل
                  </p>
                )}
                {countedRows.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    اتجرد {countedRows.length} من {auditResults.length}
                  </p>
                )}
                <Button
                  onClick={() => {
                    setAuditError(null);
                    setIsReviewing(true);
                  }}
                  disabled={countedRows.length === 0}
                >
                  <Copy className="size-4 ml-2" />
                  مراجعة النتيجة
                </Button>
              </div>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
