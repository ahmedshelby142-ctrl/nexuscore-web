import { useMemo, useState } from "react";
import { ArrowRight, Package, RefreshCw, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { MobileAppBar } from "@/mobile/components/MobileAppBar";
import { MobileSearch } from "@/mobile/components/MobileSearch";
import { FilterSheet } from "@/mobile/components/FilterSheet";
import { StatusPill } from "@/mobile/components/StatusPill";
import { EmptyState, ErrorState, OfflineState, SkeletonState } from "@/mobile/components/States";
import { useIsOffline } from "@/mobile/data/useIsOffline";
import { deriveStockStatusKey } from "@/mobile/viewmodels/stockViewModel";
import { resolveStockStatus } from "@/mobile/viewmodels/statusTaxonomies";
import { formatArabicQuantity } from "@/mobile/viewmodels/formatters";
import { readMobileProducts } from "@/mobile/data/mobileReaders";
import { useMobilePagedQuery } from "@/mobile/data/useMobilePagedQuery";
import { useMobileCapabilities } from "@/mobile/navigation/MobileRouteGuard";
import { Fragment } from "react";

// "نواقص" is gone from here on purpose. It was a filter that passed every row
// and an empty state apologising that the aggregate did not exist — it did, and
// it now has a screen of its own at /inventory/shortages, which this links to.
const FILTERS = [{ id: "all", label: "الكل" }, { id: "low", label: "منخفض" }, { id: "out", label: "نافد" }] as const;

export function MobileStockScreen() {
  const offline = useIsOffline();
  const navigate = useNavigate();
  // توريد سريع is a WRITE (`commitReceipt`), and `/restock` is guarded by the
  // `purchasing` capability. Drawing the button for a role that does not hold
  // it — MODERATOR, and ECOMMERCE_ONLY before it — offered an action whose only
  // possible outcome was a bounce back to the home screen.
  const canRestock = useMobileCapabilities().has("purchasing");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const page = useMobilePagedQuery(readMobileProducts, { search: query }, { watch: ["products", "ledger_events"] });
  const rows = useMemo(() => page.rows.map((product: any) => {
    const quantity = Number(product.mobileStock ?? 0);
    const statusKey = deriveStockStatusKey(quantity, Number(product.minStockLevel ?? 0));
    const status = resolveStockStatus(statusKey);
    return { id: String(product.id), name: String(product.name ?? "—"), sku: String(product.sku ?? "—"), quantityFormatted: formatArabicQuantity(quantity), statusKey, statusLabelAr: status.labelAr, statusTone: status.tone };
  }).filter((row) => filter === "all" || (filter === "low" && row.statusKey === "low_stock") || (filter === "out" && row.statusKey === "out_of_stock")), [filter, page.rows]);

  return (
    <section className="mobile-screen">
      <MobileAppBar
        title="المخزون"
        leadingAction={
          <button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع">
            <ArrowRight aria-hidden="true" />
          </button>
        }
        trailingAction={
          <Fragment>
            {canRestock && (
              <button type="button" className="mobile-icon-button" onClick={() => navigate("/restock")} aria-label="توريد سريع">
                <Plus aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="mobile-icon-button"
              onClick={() => void page.refresh()}
              disabled={page.refreshing}
              aria-label="تحديث"
              aria-busy={page.refreshing}
            >
              <RefreshCw aria-hidden="true" className={page.refreshing ? "mobile-spin" : undefined} />
            </button>
          </Fragment>
        }
      />
      <div className="mobile-screen-body">
        <MobileSearch value={query} onChange={setQuery} placeholder="ابحث عن منتج أو رمز" />
        <div className="mobile-filter-row">
          <FilterSheet label="حالة المخزون" options={FILTERS as readonly { id: string; label: string }[]} value={filter} onChange={setFilter} />
          <button type="button" className="mobile-inline-link" onClick={() => navigate("/inventory/shortages")}>
            تقرير النواقص
          </button>
        </div>
        {offline ? (
          <OfflineState />
        ) : page.loading ? (
          <SkeletonState />
        ) : page.error ? (
          <ErrorState messageAr="تعذّر تحميل المخزون." onRetry={page.reload} />
        ) : rows.length === 0 && !page.hasMore ? (
          <EmptyState titleAr="لا توجد أصناف" messageAr="لا توجد أصناف مطابقة لهذا الاختيار." />
        ) : (
          // «منخفض» / «نافد» filter the pages already loaded (stock is a ledger
          // sum, not a column the server can filter on). With more pages to
          // come, «لا توجد أصناف» was a claim about products never looked at —
          // so the list stays, empty, with its «تحميل المزيد».
          <Fragment>
            <div className="mobile-entity-list">
              {rows.map((row) => (
                <button type="button" className="mobile-stock-card" key={row.id} onClick={() => navigate(`/inventory/${row.id}`)}>
                  <div className="mobile-stock-card-icon">
                    <Package aria-hidden="true" />
                  </div>
                  <div className="mobile-stock-card-main">
                    <strong>{row.name}</strong>
                    <span dir="ltr">{row.sku}</span>
                    <div>
                      <StatusPill labelAr={row.statusLabelAr} tone={row.statusTone} />
                      <span className="mobile-stock-card-meta">المتاح: {row.quantityFormatted}</span>
                    </div>
                  </div>
                  <span className="mobile-chevron" aria-hidden="true">‹</span>
                </button>
              ))}
            </div>
            {page.hasMore && (
              <button type="button" className="mobile-primary-button mobile-load-more" onClick={page.loadMore} disabled={page.loadingMore}>
                {page.loadingMore ? "جارٍ التحميل…" : "تحميل المزيد"}
              </button>
            )}
          </Fragment>
        )}
      </div>
    </section>
  );
}