import { RefreshCw, Search, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { toAppRole } from "@/lib/roles";
import { useAuthStore } from "@/store/useAuthStore";
import { useStoreLicense } from "@/store/useStoreLicense";
import { getMobileCapabilities } from "@/mobile/navigation/mobileCapabilities";
import { useMobileHomeData } from "@/mobile/data/useMobileHomeData";
import { MobileAppBar } from "@/mobile/components/MobileAppBar";
import { AlertCard } from "@/mobile/components/AlertCard";
import { MetricTile } from "@/mobile/components/MetricTile";
import { QueueRow } from "@/mobile/components/QueueRow";
import { EmptyState, ErrorState, OfflineState, SkeletonState } from "@/mobile/components/States";

export function MobileHomePlaceholder() {
  const userRole = useAuthStore((state) => state.userRole);
  const username = useAuthStore((state) => state.username);
  const licenseDecision = useStoreLicense((state) => state.decision);
  const refreshLicense = useStoreLicense((state) => state.refresh);
  const [isOffline, setIsOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  const role = toAppRole(userRole);
  const capabilities = getMobileCapabilities(role);
  const homeData = useMobileHomeData(capabilities, licenseDecision?.verdict === "unverified" || licenseDecision?.verdict === "suspended");

  useEffect(() => {
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const home = homeData.data;

  return (
    <section className="mobile-home" aria-labelledby="mobile-home-title">
      <MobileAppBar
        title="الرئيسية"
        eyebrow={username ? `مرحباً ${username}` : "مركز العمليات"}
        leadingAction={<ShieldCheck aria-hidden="true" className="mobile-header-mark" />}
        trailingAction={<button type="button" className="mobile-icon-button" onClick={() => { void homeData.reload(); void refreshLicense(); }} aria-label="تحديث"><RefreshCw aria-hidden="true" /></button>}
      />
      <h1 id="mobile-home-title" className="sr-only">مركز العمليات</h1>

      <div className="mobile-home-body">
        {isOffline ? (
          <OfflineState />
        ) : homeData.loading ? (
          <SkeletonState count={3} />
        ) : homeData.error ? (
          <ErrorState messageAr="تعذّر تحميل بيانات مركز العمليات." onRetry={homeData.reload} />
        ) : home && home.alerts.length > 0 ? (
          <section className="mobile-home-section" aria-labelledby="attention-title">
            <div className="mobile-section-heading"><h2 id="attention-title">يحتاج انتباهك</h2><span>{home.alerts.length}</span></div>
            <div className="mobile-attention-stack">{home.alerts.map((alert) => <AlertCard key={alert.id} alert={alert} />)}</div>
          </section>
        ) : (
          <EmptyState titleAr="لا توجد تنبيهات عاجلة" messageAr="كل شيء هادئ حالياً." />
        )}

        {home && home.metrics.length > 0 && (
          <section className="mobile-home-section" aria-labelledby="today-title">
            <div className="mobile-section-heading"><h2 id="today-title">اليوم</h2></div>
            <div className="mobile-metric-strip">{home.metrics.map((metric) => <MetricTile key={metric.id} metric={metric} />)}</div>
          </section>
        )}

        {home && home.queues.length > 0 && (
          <section className="mobile-home-section" aria-labelledby="queues-title">
            <div className="mobile-section-heading"><h2 id="queues-title">الخطوات التالية</h2></div>
            <div className="mobile-queue-sections">
              {home.queues.map((queue) => (
                <section key={queue.id} className="mobile-queue-section" aria-labelledby={`${queue.id}-queue-title`}>
                  <div className="mobile-queue-heading"><h3 id={`${queue.id}-queue-title`}>{queue.titleAr}</h3><Link to={queue.href}>عرض الكل</Link><strong>{queue.count}</strong></div>
                  {queue.rows.map((row) => <QueueRow key={row.id} item={row} />)}
                </section>
              ))}
            </div>
          </section>
        )}

        <section className="mobile-home-section" aria-labelledby="quick-title">
          <div className="mobile-section-heading"><h2 id="quick-title">وصول سريع</h2></div>
          <div className="mobile-quick-actions">
            {capabilities.has("orders") && <Link to="/orders"><Search aria-hidden="true" /> بحث في الطلبات</Link>}
            {capabilities.has("stock") && <Link to="/inventory"><Search aria-hidden="true" /> بحث عن منتج</Link>}
            {capabilities.has("customers") && <Link to="/customers"><Search aria-hidden="true" /> بحث عن عميل</Link>}
          </div>
        </section>
      </div>
    </section>
  );
}
