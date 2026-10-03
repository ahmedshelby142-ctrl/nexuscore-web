import { useMemo } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { MobileAppBar } from "@/mobile/components/MobileAppBar";
import { MobileSearch } from "@/mobile/components/MobileSearch";
import { FilterSheet } from "@/mobile/components/FilterSheet";
import { OrderDateFilter } from "@/mobile/components/OrderDateFilter";
import { resolveOrderDateFilter, ORDER_DATE_PRESETS, type OrderDatePreset, type OrderDateSelection } from "@/mobile/viewmodels/orderDateFilter";
import { useUrlFilters } from "@/mobile/data/useUrlFilters";
import { QueueRow } from "@/mobile/components/QueueRow";
import { EmptyState, ErrorState, OfflineState, SkeletonState } from "@/mobile/components/States";
import { useIsOffline } from "@/mobile/data/useIsOffline";
import { toMobileOrderQueue } from "@/mobile/viewmodels/orderViewModel";
import { readMobileOrders } from "@/mobile/data/mobileReaders";
import { useMobilePagedQuery } from "@/mobile/data/useMobilePagedQuery";

const SEGMENTS = [{ id: "action", label: "تحتاج إجراء" }, { id: "today", label: "اليوم" }, { id: "all", label: "الكل" }] as const;
const STATUSES = [{ id: "all", label: "كل الحالات" }, { id: "pending", label: "معلّق" }, { id: "shipped", label: "مع المندوب" }, { id: "delivered", label: "تم التسليم" }] as const;

export function MobileOrdersScreen() {
  const offline = useIsOffline();
  const navigate = useNavigate();
  // In the URL, so back from an order (or a refresh) keeps the list as it was.
  const [filters, setFilters] = useUrlFilters(
    { q: "", seg: "action", status: "all", date: "all", from: "", to: "" },
    { seg: SEGMENTS.map((s) => s.id), status: STATUSES.map((s) => s.id), date: ORDER_DATE_PRESETS.map((p) => p.id) },
  );
  const query = filters.q;
  const setQuery = (q: string) => setFilters({ q });
  const segment = filters.seg;
  const setSegment = (seg: string) => setFilters({ seg });
  const status = filters.status;
  const setStatus = (value: string) => setFilters({ status: value });
  const dateFilter = useMemo<OrderDateSelection>(
    () => ({ preset: filters.date as OrderDatePreset, from: filters.from || undefined, to: filters.to || undefined }),
    [filters.date, filters.from, filters.to],
  );
  const setDateFilter = (d: OrderDateSelection) => setFilters({ date: d.preset, from: d.from ?? "", to: d.to ?? "" });
  // Resolved once per selection, so a preset's start does not drift on every
  // render (which would re-key the query). Only a complete, ordered range is
  // ever applied by the sheet; anything else falls back to no bound.
  const dateBounds = useMemo(() => {
    const resolved = resolveOrderDateFilter(dateFilter);
    return resolved.status === "ok" ? resolved.bounds : {};
  }, [dateFilter]);
  const page = useMobilePagedQuery(readMobileOrders, { search: query, queue: segment as "action" | "today" | "all", status, ...dateBounds }, { watch: ["orders"] });
  const rows = useMemo(() => toMobileOrderQueue(page.rows), [page.rows]);

  return <section className="mobile-screen">
    <MobileAppBar title="الطلبات" leadingAction={<button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع"><ArrowRight aria-hidden="true" /></button>} trailingAction={<button type="button" className="mobile-icon-button" onClick={() => void page.refresh()} disabled={page.refreshing} aria-label="تحديث" aria-busy={page.refreshing}><RefreshCw aria-hidden="true" className={page.refreshing ? "mobile-spin" : undefined} /></button>} />
    <div className="mobile-screen-body">
      <MobileSearch value={query} onChange={setQuery} placeholder="ابحث برقم الطلب أو العميل" />
      <div className="mobile-segmented-control" role="tablist">{SEGMENTS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={segment === item.id} className={segment === item.id ? "is-active" : ""} onClick={() => setSegment(item.id)}>{item.label}</button>)}</div>
      <div className="mobile-filter-row"><FilterSheet label="حالة الطلب" options={STATUSES as readonly { id: string; label: string }[]} value={status} onChange={setStatus} /><OrderDateFilter value={dateFilter} onChange={setDateFilter} /></div>
      {offline ? <OfflineState /> : page.loading ? <SkeletonState /> : page.error ? <ErrorState messageAr="تعذّر تحميل الطلبات." onRetry={page.reload} /> : rows.length === 0 ? <EmptyState titleAr="لا توجد طلبات" messageAr="ستظهر الطلبات هنا عند توفرها." /> : <><div className="mobile-queue-list">{rows.map((row) => <QueueRow key={row.id} item={row} />)}</div>{page.hasMore && <button type="button" className="mobile-primary-button mobile-load-more" onClick={page.loadMore} disabled={page.loadingMore}>{page.loadingMore ? "جارٍ التحميل…" : "تحميل المزيد"}</button>}</>}
    </div>
  </section>;
}