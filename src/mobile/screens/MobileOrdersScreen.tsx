import { useMemo, useState } from "react";
import { ArrowRight, ClipboardList, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { MobileAppBar } from "@/mobile/components/MobileAppBar";
import { MobileSearch } from "@/mobile/components/MobileSearch";
import { FilterSheet } from "@/mobile/components/FilterSheet";
import { QueueRow } from "@/mobile/components/QueueRow";
import { EmptyState, ErrorState, OfflineState, SkeletonState } from "@/mobile/components/States";
import { toMobileOrderQueue } from "@/mobile/viewmodels/orderViewModel";
import { readMobileOrders } from "@/mobile/data/mobileReaders";
import { useMobilePagedQuery } from "@/mobile/data/useMobilePagedQuery";

const SEGMENTS = [{ id: "action", label: "تحتاج إجراء" }, { id: "today", label: "اليوم" }, { id: "all", label: "الكل" }] as const;
const STATUSES = [{ id: "all", label: "كل الحالات" }, { id: "pending", label: "معلّق" }, { id: "shipped", label: "مع المندوب" }, { id: "delivered", label: "تم التسليم" }] as const;

export function MobileOrdersScreen() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [segment, setSegment] = useState("action");
  const [status, setStatus] = useState("all");
  const page = useMobilePagedQuery(readMobileOrders, { search: query, queue: segment as "action" | "today" | "all", status });
  const rows = useMemo(() => toMobileOrderQueue(page.rows), [page.rows]);

  return <section className="mobile-screen">
    <MobileAppBar title="الطلبات" leadingAction={<button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع"><ArrowRight aria-hidden="true" /></button>} trailingAction={<button type="button" className="mobile-icon-button" aria-label="تحديث"><RefreshCw aria-hidden="true" /></button>} />
    <div className="mobile-screen-body">
      <MobileSearch value={query} onChange={setQuery} placeholder="ابحث برقم الطلب أو العميل" />
      <div className="mobile-segmented-control" role="tablist">{SEGMENTS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={segment === item.id} className={segment === item.id ? "is-active" : ""} onClick={() => setSegment(item.id)}>{item.label}</button>)}</div>
      <div className="mobile-filter-row"><FilterSheet label="حالة الطلب" options={STATUSES as readonly { id: string; label: string }[]} value={status} onChange={setStatus} /></div>
      {typeof navigator !== "undefined" && !navigator.onLine ? <OfflineState /> : page.loading ? <SkeletonState /> : page.error ? <ErrorState messageAr="تعذّر تحميل الطلبات." onRetry={page.reload} /> : rows.length === 0 ? <EmptyState titleAr="لا توجد طلبات" messageAr="ستظهر الطلبات هنا عند توفرها." /> : <><div className="mobile-queue-list">{rows.map((row) => <QueueRow key={row.id} item={row} />)}</div>{page.hasMore && <button type="button" className="mobile-primary-button mobile-load-more" onClick={page.loadMore} disabled={page.loadingMore}>{page.loadingMore ? "جارٍ التحميل…" : "تحميل المزيد"}</button>}</>}
    </div>
  </section>;
}