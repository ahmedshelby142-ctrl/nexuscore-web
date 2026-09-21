import { ArrowRight, Phone, UserRound, AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { MobileAppBar } from "@/mobile/components/MobileAppBar";
import { MobileSection } from "@/mobile/components/MobileSection";
import { QueueRow } from "@/mobile/components/QueueRow";
import { EmptyState, ErrorState, OfflineState, SkeletonState } from "@/mobile/components/States";
import { toMobileOrderQueue } from "@/mobile/viewmodels/orderViewModel";
import { formatArabicCurrency, formatArabicDate, formatArabicRelativeTime, formatArabicCount } from "@/mobile/viewmodels/formatters";
import { readMobileCustomer, readMobileCustomerFinancialSummary, readMobileCustomerOrderHistory } from "@/mobile/data/mobileReaders";
import { useMobileEntity } from "@/mobile/data/useMobileEntity";
import { useIsOffline } from "@/mobile/data/useIsOffline";

export function MobileCustomerDetails() {
  const navigate = useNavigate();
  const { customerId } = useParams();
  const loadCustomer = useCallback(() => readMobileCustomer(customerId ?? ""), [customerId]);
  const { data: customer, loading, error, reload } = useMobileEntity(loadCustomer);
  const offline = useIsOffline();
  // One back affordance for every terminal state: an operator who lands on
  // "not found", an error or a lost connection must still be able to leave.
  const back = (
    <button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع">
      <ArrowRight aria-hidden="true" />
    </button>
  );
  const [financials, setFinancials] = useState<any>(null);
  const [financialsLoading, setFinancialsLoading] = useState(true);
  const [financialsError, setFinancialsError] = useState<string | null>(null);
  const [ordersPage, setOrdersPage] = useState<{ rows: any[]; total: number | null; hasMore: boolean; loading: boolean; loadingMore: boolean; error: string | null }>({
    rows: [], total: null, hasMore: false, loading: true, loadingMore: false, error: null
  });
  const [pageNum, setPageNum] = useState(0);

  /**
   * The customer's money.
   *
   * `financialsError` used to be set and never rendered: the whole الملخص
   * المالي card is behind `{financials && …}`, so a failed read made the
   * section VANISH. Nothing said the figures were unavailable — the screen
   * simply looked like a customer who had never traded.
   *
   * On failure `financials` is cleared rather than left holding the previous
   * customer's answer. A number under the wrong name is worse than no number,
   * and the section now says which of the two it is showing.
   */
  const loadFinancials = useCallback(async () => {
    if (!customerId) return;
    setFinancialsLoading(true);
    setFinancialsError(null);
    try {
      setFinancials(await readMobileCustomerFinancialSummary(customerId));
    } catch (err) {
      setFinancials(null);
      setFinancialsError(err instanceof Error ? err.message : String(err));
    } finally {
      setFinancialsLoading(false);
    }
  }, [customerId]);

  /** The order history, hoisted so its error state can ask again. */
  const loadOrders = useCallback(async (page = 0) => {
    if (!customerId) return;
    setOrdersPage((current) => ({ ...current, loading: page === 0, loadingMore: page > 0, error: null }));
    try {
      const result = await readMobileCustomerOrderHistory(customerId, page, 25);
      setOrdersPage((current) => ({
        rows: page === 0 ? result.rows : [...current.rows, ...result.rows.filter((next: any) => !current.rows.some((existing: any) => String(existing.id) === String(next.id)))],
        total: result.total,
        hasMore: result.hasMore,
        loading: false,
        loadingMore: false,
        error: null,
      }));
    } catch (err) {
      setOrdersPage((current) => ({ ...current, loading: false, loadingMore: false, error: err instanceof Error ? err.message : String(err) }));
    }
  }, [customerId]);

  useEffect(() => { void loadFinancials(); }, [loadFinancials]);
  useEffect(() => { void loadOrders(0); }, [loadOrders]);


  const loadMoreOrders = () => {
    if (ordersPage.hasMore && !ordersPage.loadingMore) {
      setPageNum(p => p + 1);
      const nextPage = pageNum + 1;
      readMobileCustomerOrderHistory(customerId ?? "", nextPage, 25).then((result) => {
        setOrdersPage((current) => ({
          rows: [...current.rows, ...result.rows.filter((next: any) => !current.rows.some((existing: any) => String(existing.id) === String(next.id)))],
          total: result.total,
          hasMore: result.hasMore,
          loading: false,
          loadingMore: false,
          error: null
        }));
      });
    }
  };

  // EVERY hook runs before the first conditional return.
  //
  // This `useMemo` used to sit BELOW the three early returns. On the first
  // render `loading` was true, the component returned at the skeleton and the
  // hook never ran — 21 hooks. On the next render `loading` was false, control
  // reached the `useMemo` — 22 hooks. React saw the count change, threw
  // "Rendered more hooks than during the previous render", and the error
  // boundary swallowed the whole screen. `/customers/:id` crashed one hundred
  // percent of the time, for every customer, and the crash had nothing to do
  // with the customer's data.
  const history = useMemo(() => toMobileOrderQueue(ordersPage.rows), [ordersPage.rows]);

  if (offline) return <><MobileAppBar title="تفاصيل العميل" leadingAction={back} /><div className="mobile-screen-body"><OfflineState /></div></>;
  if (loading) return <><MobileAppBar title="تفاصيل العميل" /><div className="mobile-screen-body"><SkeletonState /></div></>;
  if (error) return <><MobileAppBar title="تفاصيل العميل" leadingAction={back} /><ErrorState messageAr="تعذّر تحميل العميل." onRetry={reload} /></>;
  if (!customer) return <><MobileAppBar title="تفاصيل العميل" leadingAction={<button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع"><ArrowRight aria-hidden="true" /></button>} /><EmptyState titleAr="العميل غير موجود" messageAr="تعذّر العثور على هذا العميل." /></>;

  const warnings: string[] = [];
  if (financials) {
    if (financials.wastedTrips > 0) warnings.push(`لديه ${financials.wastedTrips} ${financials.wastedTrips === 1 ? "رحلة مهدرة" : "رحلات مهدرة"} (رفض استلام)`);
    if (financials.openExposure > 0) warnings.push(`مستحقات مفتوحة: ${formatArabicCurrency(financials.openExposure)}`);
    if (financials.returnedOrders > financials.deliveredOrders && financials.deliveredOrders > 0) warnings.push("معدل المرتجعات مرتفع");
    if (financials.openOrders > 10) warnings.push(`${financials.openOrders} طلبات نشطة — متابعة مطلوبة`);
  }

  return <section className="mobile-screen">
    <MobileAppBar title="تفاصيل العميل" leadingAction={<button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع"><ArrowRight aria-hidden="true" /></button>} />
    <div className="mobile-screen-body">
      <div className="mobile-detail-hero">
        <div className="mobile-customer-avatar">
          <UserRound aria-hidden="true" />
        </div>
        <div>
          <h2>{customer.name}</h2>
          <a href={`tel:${customer.phone ?? ""}`} dir="ltr" style={{ textDecoration: "none", color: "inherit" }}>
            <Phone aria-hidden="true" /> {customer.phone ?? "—"}
          </a>
        </div>
      </div>

      <MobileSection titleAr="بيانات التواصل">
        <p className="mobile-muted">{customer.address ?? "لا يوجد عنوان مسجل"}</p>
        {customer.governorate && <div className="mobile-detail-line"><span>المحافظة</span><strong>{customer.governorate}</strong></div>}
        {customer.region && <div className="mobile-detail-line"><span>المنطقة</span><strong>{customer.region}</strong></div>}
        {customer.email && <div className="mobile-detail-line"><span>البريد الإلكتروني</span><strong dir="ltr">{customer.email}</strong></div>}
      </MobileSection>

      <MobileSection titleAr="الملخص المالي">
        {financialsLoading ? (
          <SkeletonState count={3} />
        ) : financialsError ? (
          /* Never a zero and never the previous customer's figures: a money
             section that failed says so, and offers to ask again. */
          <ErrorState messageAr="تعذّر تحميل الملخص المالي لهذا العميل." onRetry={() => void loadFinancials()} />
        ) : !financials ? (
          <EmptyState messageAr="لا توجد بيانات مالية لهذا العميل." />
        ) : (
          <div className="mobile-customer-financial-grid">
            <div>
              <span>إيراد المسلم (مُسجل)</span>
              <strong style={{ color: "var(--success)" }}>{formatArabicCurrency(financials.deliveredRevenue)}</strong>
            </div>
            <div>
              <span>المستحقات المفتوحة (COD)</span>
              <strong style={{ color: "var(--warning)" }}>{formatArabicCurrency(financials.openExposure)}</strong>
            </div>
            <div>
              <span>إجمالي الطلبات</span>
              <strong>{formatArabicCount(financials.totalOrders)}</strong>
            </div>
            <div>
              <span>طلبات نشطة</span>
              <strong>{formatArabicCount(financials.openOrders)}</strong>
            </div>
            <div>
              <span>طلبات مسلمة</span>
              <strong style={{ color: "var(--success)" }}>{formatArabicCount(financials.deliveredOrders)}</strong>
            </div>
            <div>
              <span>مرتجعات</span>
              <strong style={{ color: "var(--critical)" }}>{formatArabicCount(financials.returnedOrders)}</strong>
            </div>
            <div>
              <span>ملغية</span>
              <strong style={{ color: "var(--muted-foreground)" }}>{formatArabicCount(financials.cancelledOrders)}</strong>
            </div>
            <div>
              <span>رحلات مهدرة</span>
              <strong style={{ color: financials.wastedTrips > 0 ? "var(--destructive)" : "var(--success)" }}>{formatArabicCount(financials.wastedTrips)}</strong>
            </div>
          </div>
        )}
      </MobileSection>

      {warnings.length > 0 && (
        <MobileSection titleAr="تنبيهات">
          {warnings.map((w, i) => (
            <div className="mobile-warning-callout" key={i}>
              <AlertTriangle aria-hidden="true" style={{ marginInlineEnd: "0.5rem" }} />
              {w}
            </div>
          ))}
        </MobileSection>
      )}

      <MobileSection titleAr={`سجل الطلبات (${ordersPage.total ?? history.length})`}>
        {ordersPage.loading ? (
          <SkeletonState count={3} />
        ) : ordersPage.error ? (
          <ErrorState messageAr="تعذّر تحميل سجل الطلبات." onRetry={() => void loadOrders(0)} />
        ) : history.length === 0 ? (
          <EmptyState titleAr="لا يوجد سجل طلبات" messageAr="هذا العميل ليس لديه طلبات مسجلة." />
        ) : (
          <>
            <div className="mobile-queue-list">
              {history.map((row) => <QueueRow key={row.id} item={row} />)}
            </div>
            {ordersPage.hasMore && (
              <button type="button" className="mobile-primary-button mobile-load-more" onClick={loadMoreOrders} disabled={ordersPage.loadingMore}>
                {ordersPage.loadingMore ? "جارٍ التحميل…" : "تحميل المزيد"}
              </button>
            )}
          </>
        )}
      </MobileSection>

      <MobileSection titleAr="معلومات النظام">
        <div className="mobile-detail-line"><span>معرف العميل</span><strong dir="ltr">{customer.id}</strong></div>
        {customer.createdAt && <div className="mobile-detail-line"><span>تاريخ الإنشاء</span><strong>{formatArabicDate(customer.createdAt)}</strong></div>}
        {customer.updatedAt && <div className="mobile-detail-line"><span>آخر تحديث</span><strong>{formatArabicDate(customer.updatedAt)}</strong></div>}
        {customer.lastOrderAt && <div className="mobile-detail-line"><span>آخر طلب</span><strong>{formatArabicDate(customer.lastOrderAt)} · {formatArabicRelativeTime(customer.lastOrderAt)}</strong></div>}
        <div className="mobile-detail-line"><span>إجمالي الطلبات</span><strong>{formatArabicCount(ordersPage.total ?? history.length)}</strong></div>
      </MobileSection>
    </div>
  </section>;
}