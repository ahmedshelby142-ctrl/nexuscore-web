import { useEffect, useMemo, useState } from "react";
import { ArrowRight, RefreshCw, Truck } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { MobileAppBar } from "@/mobile/components/MobileAppBar";
import { MobileSearch } from "@/mobile/components/MobileSearch";
import { FilterSheet } from "@/mobile/components/FilterSheet";
import { QueueRow } from "@/mobile/components/QueueRow";
import { EmptyState, ErrorState, OfflineState, SkeletonState } from "@/mobile/components/States";
import { toMobileShipmentQueue } from "@/mobile/viewmodels/shipmentViewModel";
import { toMobileOrderQueue } from "@/mobile/viewmodels/orderViewModel";
import { readMobileShipments, readMobileCouriers } from "@/mobile/data/mobileReaders";
import type { CourierRegistry } from "@/mobile/viewmodels/shipmentViewModel";
import { useMobilePagedQuery } from "@/mobile/data/useMobilePagedQuery";

const PIPELINE = [{ id: "ready", label: "جاهز للشحن" }, { id: "shipped", label: "في الطريق" }, { id: "delivered", label: "تم التسليم" }] as const;

export function MobileShipmentsScreen() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("ready");
  const page = useMobilePagedQuery(readMobileShipments, { search: query, status: stage });

  // WHO the couriers are — one read, the same registry table desktop writes.
  // Orders carry a `courierId`; the name on the order is only a frozen label.
  const [couriers, setCouriers] = useState<CourierRegistry>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    void readMobileCouriers()
      .then((registry) => { if (!cancelled) setCouriers(registry); })
      .catch(() => { /* no registry: rows fall back to their frozen label */ });
    return () => { cancelled = true; };
  }, []);

  const pipelineRows = useMemo(() => {
    const shipmentRows = toMobileShipmentQueue(page.rows, couriers);
    const readyRows = toMobileOrderQueue(page.rows.filter((order: any) => String(order.status) === "processing")).map((row) => ({ ...row, statusLabelAr: "جاهز للشحن", statusTone: "warning" as const }));
    return [...readyRows, ...shipmentRows].filter((row) => {
      const matchesSearch = !query || `${row.title} ${row.subtitle ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
      const matchesStage = stage === "ready" ? row.statusKey === "processing" : row.statusKey === stage;
      return matchesSearch && matchesStage;
    });
  }, [page.rows, query, stage, couriers]);

  return <section className="mobile-screen">
    <MobileAppBar title="الشحنات" leadingAction={<button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع"><ArrowRight aria-hidden="true" /></button>} trailingAction={<button type="button" className="mobile-icon-button" aria-label="تحديث"><RefreshCw aria-hidden="true" /></button>} />
    <div className="mobile-screen-body">
      <MobileSearch value={query} onChange={setQuery} placeholder="ابحث برقم الطلب أو المندوب" />
      <div className="mobile-segmented-control" role="tablist">{PIPELINE.map((item) => <button key={item.id} type="button" role="tab" aria-selected={stage === item.id} className={stage === item.id ? "is-active" : ""} onClick={() => setStage(item.id)}>{item.label}</button>)}</div>
      <div className="mobile-filter-row"><FilterSheet label="مرحلة الشحن" options={PIPELINE as readonly { id: string; label: string }[]} value={stage} onChange={setStage} /></div>
      {typeof navigator !== "undefined" && !navigator.onLine ? <OfflineState /> : page.loading ? <SkeletonState /> : page.error ? <ErrorState messageAr="تعذّر تحميل الشحنات." onRetry={page.reload} /> : pipelineRows.length === 0 ? <EmptyState titleAr="لا توجد شحنات" messageAr="لا توجد شحنات في هذه المرحلة." /> : <><div className="mobile-queue-list">{pipelineRows.map((row) => <QueueRow key={row.id} item={row} />)}</div>{page.hasMore && <button type="button" className="mobile-primary-button mobile-load-more" onClick={page.loadMore} disabled={page.loadingMore}>{page.loadingMore ? "جارٍ التحميل…" : "تحميل المزيد"}</button>}</>}
    </div>
  </section>;
}