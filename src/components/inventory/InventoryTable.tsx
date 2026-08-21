import { useState, useMemo } from "react";
import {
  Package,
  AlertTriangle,
  Trash2,
  Printer,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  PackageCheck,
  Inbox,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useStock } from "@/lib/ledger/useStock";
import {
  StockSummaryCards,
  matchesStockFilter,
  stockStatusOf,
  type StockFilter,
} from "@/components/inventory/StockSummaryCards";
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
import { printTableAsPdf } from "@/lib/pdfGenerator";
import { ProductRemovalDialog } from "@/components/products/ProductRemovalDialog";
import { QuickRestockDialog } from "@/components/products/QuickRestockDialog";
import { productPrice, productMinLevel, activeProducts } from "@/lib/product";
import { searchProducts } from "@/lib/productSearch";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/math";
import type { Product } from "@/types";

export function InventoryTable() {
  const allProducts = useBusinessStore((s) => s.products);
  // Archived products leave this list too — same rule as المنتجات.
  const products = useMemo(() => activeProducts(allProducts), [allProducts]);
  // Same source as المنتجات: quantity is SUM(stock) and the value card prices
  // it at the weighted-average cost, so the two screens cannot disagree.
  const { qtyOf, refresh: refreshStock } = useStock();
  const [stockFilter, setStockFilter] = useState<StockFilter>("all");
  const [pendingRemoval, setPendingRemoval] = useState<Product | null>(null);
  // Sorting is a view concern only — it reorders `qtyOf` reads, never touches
  // a number.
  const [quantitySort, setQuantitySort] = useState<"none" | "asc" | "desc">("none");
  // Bulk receive: ticked rows go into ONE receipt, not one per row.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const lowStockProducts = products.filter(
    (p) => qtyOf(p.id) > 0 && qtyOf(p.id) <= productMinLevel(p),
  );
  const outOfStockProducts = products.filter((p) => qtyOf(p.id) <= 0);

  const visibleProducts = useMemo(() => {
    // The shared matcher again — name/SKU/barcode with Arabic-Indic digits
    // normalised, the same one POS and المنتجات search with.
    const rows = searchProducts(products, searchQuery).filter((p) =>
      matchesStockFilter(qtyOf(p.id), p, stockFilter),
    );
    if (quantitySort === "none") return rows;
    // Sorted on the ledger quantity, the same `qtyOf` the row prints — so the
    // order can never disagree with the numbers beside it.
    return [...rows].sort((a, b) =>
      quantitySort === "asc" ? qtyOf(a.id) - qtyOf(b.id) : qtyOf(b.id) - qtyOf(a.id),
    );
  }, [products, searchQuery, stockFilter, quantitySort, qtyOf]);

  /**
   * Ticks SURVIVE searching and filtering.
   *
   * The owner ticks three items, types to find a fourth, ticks it — the first
   * three must still be there. So the receipt is built from every ticked
   * product, not just the ones the current query happens to show. Nothing is
   * hidden by this: the dialog lists every ticked product by name before
   * anything is written, and the toolbar says how many are ticked.
   */
  const selectedProducts = useMemo(
    () => products.filter((p) => selectedIds.includes(p.id)),
    [products, selectedIds],
  );
  const allVisibleTicked =
    visibleProducts.length > 0 && visibleProducts.every((p) => selectedIds.includes(p.id));

  // Asks first, and the dialog decides delete-vs-archive off the ledger.
  const handleDelete = (product: Product) => {
    setPendingRemoval(product);
  };

  // Phase F: PDF export — reuses printTableAsPdf so the layout matches
  // the financial / courier / orders reports.
  const handleExportPdf = () => {
    printTableAsPdf({
      title: "جرد المخزون",
      columns: [
        { label: "اسم المنتج", accessor: (p) => p.name },
        { label: "الباركود", accessor: (p) => p.barcode || "—", align: "center" },
        { label: "SKU", accessor: (p) => p.sku, align: "center" },
        { label: "التصنيف", accessor: (p) => p.category, align: "center" },
        { label: "الكمية", accessor: (p) => String(qtyOf(p.id)), align: "center" },
        { label: "الحد الأدنى", accessor: (p) => String(p.minStockLevel ?? 0), align: "center" },
        { label: "سعر البيع", accessor: (p) => formatMoney(productPrice(p)), align: "center" },
        { label: "الحالة", accessor: (p) => stockStatusOf(qtyOf(p.id), p).label, align: "center" },
      ],
      // Exports what is on screen, including the active card filter.
      rows: visibleProducts,
      footer: `إجمالي المنتجات: ${visibleProducts.length} — إجمالي الوحدات: ${visibleProducts.reduce((s, p) => s + qtyOf(p.id), 0)} — نافذ: ${outOfStockProducts.length} — منخفض: ${lowStockProducts.length}`,
    });
  };

  return (
    <div className="space-y-6">
      {/* The same four cards as المنتجات, from the same component and the same
          ledger figures — clicking one filters the table below. */}
      <StockSummaryCards products={products} value={stockFilter} onChange={setStockFilter} />

      <div className="rounded-2xl border border-border bg-card p-6">
      {/* A one-line prompt, not a list.
          It used to print every low and out-of-stock product inline, which
          pushed the actual table off the screen — the more urgent the
          situation, the further you had to scroll to act on it. The names now
          live where they belong: in the table, revealed by the card filter
          these buttons set. */}
      {(lowStockProducts.length > 0 || outOfStockProducts.length > 0) && stockFilter === "all" && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 p-4">
          <div className="flex items-center gap-3 flex-wrap">
            <AlertTriangle className="size-5 text-amber-600 shrink-0" />
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200 flex-1 min-w-0">
              {outOfStockProducts.length > 0 && `${outOfStockProducts.length} منتج نافد`}
              {outOfStockProducts.length > 0 && lowStockProducts.length > 0 && " · "}
              {lowStockProducts.length > 0 && `${lowStockProducts.length} منتج يحتاج توريد`}
            </p>
            {outOfStockProducts.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setStockFilter("out")}>
                اعرض النافد
              </Button>
            )}
            {lowStockProducts.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setStockFilter("low")}>
                اعرض المنخفض
              </Button>
            )}
          </div>
        </div>
      )}

      {/* While a card filter is on, say what is being shown and offer the way
          back — otherwise a filtered table looks like a shrunken inventory. */}
      {stockFilter !== "all" && (
        <div className="mb-6 rounded-xl border border-border bg-muted/40 p-3 flex items-center gap-3 flex-wrap">
          <p className="text-sm font-medium flex-1 min-w-0">
            {stockFilter === "out" ? "المنتجات النافدة فقط" : "المنتجات المنخفضة فقط"} —{" "}
            {visibleProducts.length} منتج
          </p>
          <Button variant="ghost" size="sm" onClick={() => setStockFilter("all")}>
            عرض الكل
          </Button>
        </div>
      )}

      <div className="mb-6 flex items-start justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs tracking-wider text-muted-foreground">المخزون</p>
          <h3 className="font-display text-2xl font-bold mt-1">إدارة المخزون</h3>
          <p className="text-sm text-muted-foreground mt-1">
            إجمالي {products.length} منتج — {products.reduce((s, p) => s + qtyOf(p.id), 0)} وحدة في
            المخزون
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="بحث بالاسم، SKU، الباركود..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pr-9 w-56"
            />
          </div>
          {selectedProducts.length > 0 && (
            <>
              <Button onClick={() => setBulkOpen(true)} className="gap-2">
                <PackageCheck className="size-4" />
                توريد {selectedProducts.length} صنف
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedIds([])}>
                إلغاء التحديد
              </Button>
            </>
          )}
          <Button variant="outline" onClick={handleExportPdf} className="gap-2">
            <Printer className="size-4" />
            تصدير PDF
          </Button>
        </div>
      </div>

      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-center px-3 w-10">
                <input
                  type="checkbox"
                  aria-label="اختيار كل المنتجات الظاهرة"
                  checked={allVisibleTicked}
                  onChange={(e) =>
                    setSelectedIds((ids) => {
                      const visible = visibleProducts.map((p) => p.id);
                      // Ticks outside the current view are left alone — this
                      // box speaks for the rows it can see, nothing else.
                      return e.target.checked
                        ? [...new Set([...ids, ...visible])]
                        : ids.filter((id) => !visible.includes(id));
                    })
                  }
                  className="size-4 align-middle accent-primary"
                />
              </TableHead>
              <TableHead className="text-right px-4">اسم المنتج</TableHead>
              <TableHead className="text-center px-4">الباركود</TableHead>
              <TableHead className="text-center px-4">التصنيف</TableHead>
              <TableHead className="text-center px-4">
                <button
                  type="button"
                  onClick={() =>
                    setQuantitySort((current) =>
                      current === "desc" ? "asc" : current === "asc" ? "none" : "desc",
                    )
                  }
                  className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                  title="ترتيب حسب الكمية"
                >
                  المخزون
                  {quantitySort === "desc" ? (
                    <ArrowDown className="size-3.5" />
                  ) : quantitySort === "asc" ? (
                    <ArrowUp className="size-3.5" />
                  ) : (
                    <ArrowUpDown className="size-3.5 opacity-50" />
                  )}
                </button>
              </TableHead>
              <TableHead className="text-center px-4">الحالة</TableHead>
              <TableHead className="text-center px-4">حذف</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleProducts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-12">
                  {products.length === 0 ? (
                    <EmptyState icon={Inbox} title="لسه مفيش منتجات" />
                  ) : searchQuery.trim() ? (
                    <EmptyState icon={Search} title="لا توجد نتائج مطابقة للبحث" />
                  ) : (
                    <EmptyState icon={Package} title="مفيش منتجات في التصنيف ده" />
                  )}
                </TableCell>
              </TableRow>
            ) : (
              visibleProducts.map((product) => {
                const qty = qtyOf(product.id);
                const status = stockStatusOf(qty, product);
                const isLow = status.variant === "secondary";
                const isOut = status.variant === "destructive";
                return (
                  <TableRow
                    key={product.id}
                    className={isLow || isOut ? "bg-red-50/50 hover:bg-red-100/50" : ""}
                  >
                    <TableCell className="text-center px-3">
                      <input
                        type="checkbox"
                        aria-label={`اختيار ${product.name}`}
                        checked={selectedIds.includes(product.id)}
                        onChange={(e) =>
                          setSelectedIds((ids) =>
                            e.target.checked
                              ? [...ids, product.id]
                              : ids.filter((id) => id !== product.id),
                          )
                        }
                        className="size-4 align-middle accent-primary"
                      />
                    </TableCell>
                    <TableCell className="font-medium px-4 whitespace-nowrap">
                      {product.name}
                    </TableCell>
                    <TableCell
                      dir="ltr"
                      className="text-center px-4 font-mono text-xs text-muted-foreground whitespace-nowrap"
                    >
                      {product.barcode || "—"}
                    </TableCell>
                    <TableCell className="text-center px-4 whitespace-nowrap">
                      <span className="text-sm bg-muted/60 px-2 py-0.5 rounded-md">
                        {product.category}
                      </span>
                    </TableCell>
                    <TableCell className="text-center px-4 whitespace-nowrap">
                      <span
                        className={`font-semibold ${isOut ? "text-destructive" : isLow ? "text-amber-600" : ""}`}
                      >
                        {qty}
                      </span>
                    </TableCell>
                    <TableCell className="text-center px-4">
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </TableCell>
                    <TableCell className="text-center px-4">
                      <div className="flex items-center justify-center">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 text-destructive hover:text-destructive"
                          onClick={() => handleDelete(product)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      </div>

      <ProductRemovalDialog
        product={pendingRemoval}
        onClose={() => setPendingRemoval(null)}
        onRemoved={refreshStock}
      />

      {/* The SAME dialog المنتجات opens for one row — it has always taken a
          list, because `buildPurchaseLines` takes a list. Many products, ONE
          purchase event and ONE supplier invoice. */}
      <QuickRestockDialog
        products={bulkOpen ? selectedProducts : null}
        onClose={() => setBulkOpen(false)}
        onReceived={() => {
          refreshStock();
          setSelectedIds([]);
        }}
      />
    </div>
  );
}
