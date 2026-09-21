import { useMemo, useState } from "react";
import { ArrowRight, Phone, RefreshCw, UserRound } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { MobileAppBar } from "@/mobile/components/MobileAppBar";
import { MobileSearch } from "@/mobile/components/MobileSearch";
import { EmptyState, ErrorState, OfflineState, SkeletonState } from "@/mobile/components/States";
import { useIsOffline } from "@/mobile/data/useIsOffline";
import { toMobileCustomerQueue } from "@/mobile/viewmodels/customerViewModel";
import { readMobileCustomers } from "@/mobile/data/mobileReaders";
import { useMobilePagedQuery } from "@/mobile/data/useMobilePagedQuery";

export function MobileCustomersScreen() {
  const navigate = useNavigate();
  const offline = useIsOffline();
  const [query, setQuery] = useState("");
  const page = useMobilePagedQuery(readMobileCustomers, { search: query }, { watch: ["customers", "orders"] });
  const rows = useMemo(() => toMobileCustomerQueue(page.rows), [page.rows]);

  return <section className="mobile-screen">
    <MobileAppBar title="العملاء" leadingAction={<button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع"><ArrowRight aria-hidden="true" /></button>} trailingAction={<button type="button" className="mobile-icon-button" onClick={() => void page.refresh()} disabled={page.refreshing} aria-label="تحديث" aria-busy={page.refreshing}><RefreshCw aria-hidden="true" className={page.refreshing ? "mobile-spin" : undefined} /></button>} />
    <div className="mobile-screen-body">
      <MobileSearch value={query} onChange={setQuery} placeholder="ابحث بالاسم أو الهاتف" />
      {offline ? <OfflineState /> : page.loading ? <SkeletonState /> : page.error ? <ErrorState messageAr="تعذّر تحميل العملاء." onRetry={page.reload} /> : rows.length === 0 ? <EmptyState titleAr="لا يوجد عملاء" messageAr="لا توجد نتائج مطابقة." /> : <><div className="mobile-entity-list">{rows.map((row) => <button type="button" className="mobile-customer-card" key={row.id} onClick={() => navigate(`/customers/${row.id}`)}><div className="mobile-customer-avatar"><UserRound aria-hidden="true" /></div><div className="mobile-customer-main"><strong>{row.name}</strong>{row.phone && <span dir="ltr"><Phone aria-hidden="true" /> {row.phone}</span>}<small>{row.lastOrderAr ?? "لا يوجد طلب سابق"}</small></div><span className="mobile-chevron" aria-hidden="true">‹</span></button>)}</div>{page.hasMore && <button type="button" className="mobile-primary-button mobile-load-more" onClick={page.loadMore} disabled={page.loadingMore}>{page.loadingMore ? "جارٍ التحميل…" : "تحميل المزيد"}</button>}</>}
    </div>
  </section>;
}