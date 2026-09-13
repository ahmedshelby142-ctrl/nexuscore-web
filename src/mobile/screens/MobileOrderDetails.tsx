import { ArrowRight, Clock, Package, User, MapPin, Phone, Wallet, Truck, CreditCard, FileText, AlertTriangle, CheckCircle2, XCircle, RotateCcw, DollarSign } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { MobileAppBar } from "@/mobile/components/MobileAppBar";
import { MobileSection } from "@/mobile/components/MobileSection";
import { StatusPill } from "@/mobile/components/StatusPill";
import { EmptyState, ErrorState, SkeletonState } from "@/mobile/components/States";
import { resolveOrderStatus, resolveShipmentStatus } from "@/mobile/viewmodels/statusTaxonomies";
import { formatArabicCurrency, formatArabicDate, formatArabicRelativeTime, formatArabicQuantity } from "@/mobile/viewmodels/formatters";
import { readMobileOrder, readMobileOrderTimeline } from "@/mobile/data/mobileReaders";
import { useMobileEntity } from "@/mobile/data/useMobileEntity";

export function MobileOrderDetails() {
  const navigate = useNavigate();
  const { orderId } = useParams();
  const loadOrder = useCallback(() => readMobileOrder(orderId ?? ""), [orderId]);
  const { data: order, loading, error } = useMobileEntity(loadOrder);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [timelineError, setTimelineError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (orderId) {
      setTimelineLoading(true);
      readMobileOrderTimeline(orderId).then((data) => {
        if (active) { setTimeline(data); setTimelineLoading(false); }
      }).catch((err) => { if (active) { setTimelineError(err.message); setTimelineLoading(false); } });
    }
    return () => { active = false; };
  }, [orderId]);

  if (loading) return <><MobileAppBar title="تفاصيل الطلب" /><div className="mobile-screen-body"><SkeletonState /></div></>;
  if (error) return <><MobileAppBar title="تفاصيل الطلب" /><ErrorState messageAr="تعذّر تحميل الطلب." /></>;
  if (!order) return <><MobileAppBar title="تفاصيل الطلب" leadingAction={<button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع"><ArrowRight aria-hidden="true" /></button>} /><EmptyState titleAr="الطلب غير موجود" messageAr="تعذّر العثور على هذا الطلب." /></>;

  const status = resolveOrderStatus(order.status);
  const items = Array.isArray(order.items) ? order.items : [];
  const stockItems = Array.isArray(order.stockItems) ? order.stockItems : [];
  const displayItems = stockItems.length > 0 ? stockItems : items;
  const goodsTotal = displayItems.reduce((sum, item) => sum + Number(item.unitPrice ?? 0) * Number(item.quantity ?? 0), 0);
  const shippingFee = Number(order.shippingFee ?? order.courierFee ?? 0);
  const depositAmount = Number(order.depositAmount ?? 0);
  const discountAmount = Number(order.discountAmount ?? 0);
  const totalAmount = Number(order.totalAmount ?? order.total ?? 0);
  const expectedCod = Number(order.expectedCod ?? 0);
  const courierFee = Number(order.courierFee ?? 0);

  const netGoods = Math.max(0, goodsTotal - discountAmount);
  const collected = netGoods + shippingFee;
  const depositPlusCod = depositAmount + expectedCod;
  const financialsMatch = Math.abs(collected - depositPlusCod) < 0.01;

  const customerName = order.customerName ?? "—";
  const customerPhone = order.customerPhone ?? "—";
  const address = order.address ?? "لا يوجد عنوان مسجل";
  const governorate = order.governorate ?? "—";
  const courierName = order.courierName ?? "غير محدد";
  const courierId = order.courierId ?? null;

  return <section className="mobile-screen">
    <MobileAppBar title="تفاصيل الطلب" leadingAction={<button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع"><ArrowRight aria-hidden="true" /></button>} />
    <div className="mobile-screen-body">
      <div className="mobile-detail-hero">
        <Package aria-hidden="true" />
        <div>
          <span className="mobile-eyebrow">الطلب</span>
          <h2 dir="ltr">{order.orderNumber ?? order.id}</h2>
          <span>{formatArabicDate(order.createdAt ?? order.created_at)} · {formatArabicRelativeTime(order.createdAt ?? order.created_at)}</span>
        </div>
        <StatusPill labelAr={status.labelAr} tone={status.tone} />
      </div>

      <div className="mobile-detail-total">
        <span>إجمالي الطلب</span>
        <strong>{formatArabicCurrency(totalAmount)}</strong>
      </div>

      <MobileSection titleAr="العميل">
        <div className="mobile-detail-line">
          <span>{customerName}</span>
          <a href={`tel:${customerPhone}`} dir="ltr" style={{ textDecoration: "none", color: "inherit" }}>{customerPhone}</a>
        </div>
        <p className="mobile-muted">{address}</p>
        <div className="mobile-detail-line">
          <span>المحافظة</span>
          <strong>{governorate}</strong>
        </div>
      </MobileSection>

      <MobileSection titleAr="الأصناف">
        {displayItems.length === 0 ? (
          <p className="mobile-muted">لا توجد تفاصيل أصناف.</p>
        ) : (
          displayItems.map((item: any, index: number) => {
            const qty = Number(item.quantity ?? 0);
            const price = Number(item.unitPrice ?? 0);
            const lineTotal = qty * price;
            const productId = item.productId;
            const productName = item.productName ?? item.product_id ?? item.bundleName ?? "صنف";
            const variantName = item.variantName;
            return (
              <div className="mobile-detail-line" key={item.id ?? `${productId}-${index}`}>
                <div>
                  <strong>{productName}</strong>
                  {variantName && <span className="mobile-muted" style={{ marginInlineStart: "0.5rem" }}>{variantName}</span>}
                  {productId && <span className="mobile-muted" style={{ display: "block", fontSize: "0.7rem" }}>ID: {productId}</span>}
                </div>
                <div style={{ textAlign: "left" }}>
                  <span>{formatArabicQuantity(qty)}</span>
                  <span style={{ marginInlineStart: "0.5rem", color: "var(--muted-foreground)" }}>{formatArabicCurrency(price)} × {qty}</span>
                  <span style={{ display: "block", marginBlockStart: "0.25rem", fontWeight: "700" }}>{formatArabicCurrency(lineTotal)}</span>
                </div>
              </div>
            );
          })
        )}
        {discountAmount > 0 && (
          <div className="mobile-detail-line" style={{ color: "var(--success)" }}>
            <span>الخصم المطبق</span>
            <strong>− {formatArabicCurrency(discountAmount)}</strong>
          </div>
        )}
        <div className="mobile-detail-line">
          <span>إجمالي البضاعة (صافي)</span>
          <strong>{formatArabicCurrency(netGoods)}</strong>
        </div>
      </MobileSection>

      <MobileSection titleAr="التفصيل المالي">
        <div className="mobile-detail-line"><span>إجمالي البضاعة</span><strong>{formatArabicCurrency(goodsTotal)}</strong></div>
        {discountAmount > 0 && <div className="mobile-detail-line"><span>الخصم</span><strong>− {formatArabicCurrency(discountAmount)}</strong></div>}
        <div className="mobile-detail-line"><span>صافي البضاعة</span><strong>{formatArabicCurrency(netGoods)}</strong></div>
        <div className="mobile-detail-line"><span>رسوم التوصيل</span><strong>{formatArabicCurrency(shippingFee)}</strong></div>
        <div className="mobile-detail-line"><span>المجموع المستحق</span><strong>{formatArabicCurrency(collected)}</strong></div>
        <div className="mobile-detail-line" style={{ borderTop: "1px solid var(--border)", paddingBlockStart: "0.5rem" }}>
          <span>مدفوع مقدماً (عربون)</span>
          <strong>{formatArabicCurrency(depositAmount)}</strong>
        </div>
        <div className="mobile-detail-line">
          <span>المتبقي على المندوب (COD)</span>
          <strong>{formatArabicCurrency(expectedCod)}</strong>
        </div>
        <div className="mobile-detail-line" style={{ borderTop: "1px solid var(--border)", paddingBlockStart: "0.5rem" }}>
          <span>مجموع المدفوع + المتبقي</span>
          <strong>{formatArabicCurrency(depositPlusCod)}</strong>
        </div>
        <div className="mobile-detail-line" style={{ color: financialsMatch ? "var(--success)" : "var(--destructive)" }}>
          <span>مطابقة الحساب</span>
          <strong>{financialsMatch ? "✓ متطابق" : "✗ اختلاف"}</strong>
        </div>
        {courierFee > 0 && <div className="mobile-detail-line"><span>عمولة المندوب</span><strong>{formatArabicCurrency(courierFee)}</strong></div>}
      </MobileSection>

      <MobileSection titleAr="الشحن والمندوب">
        <div className="mobile-detail-line"><span>المندوب</span><strong>{courierName}</strong></div>
        {courierId && <div className="mobile-detail-line"><span>معرف المندوب</span><strong dir="ltr">{courierId}</strong></div>}
        <div className="mobile-detail-line"><span>حالة الشحنة</span><StatusPill labelAr={resolveShipmentStatus(order.status).labelAr} tone={resolveShipmentStatus(order.status).tone} /></div>
        {order.trackingNumber && <div className="mobile-detail-line"><span>رقم التتبع</span><strong dir="ltr">{order.trackingNumber}</strong></div>}
        {expectedCod > 0 && <div className="mobile-detail-line"><span>المبلغ المستحق تحصيله (COD)</span><strong>{formatArabicCurrency(expectedCod)}</strong></div>}
        {order.codSettledAt && <div className="mobile-detail-line"><span>تم التوريد في</span><strong>{formatArabicDate(order.codSettledAt)}</strong></div>}
      </MobileSection>

      <MobileSection titleAr="الخط الزمني">
        {timelineLoading ? (
          <SkeletonState count={3} />
        ) : timelineError ? (
          <ErrorState messageAr={timelineError} />
        ) : timeline.length === 0 ? (
          <EmptyState titleAr="لا يوجد خط زمني" messageAr="لا توجد أحداث مسجلة لهذا الطلب." />
        ) : (
          timeline.map((event) => (
            <div className="mobile-timeline-event" key={event.id}>
              <div className="mobile-timeline-event-main">
                <div className="mobile-timeline-event-header">
                  <span className="mobile-timeline-event-label">{event.labelAr}</span>
                  <StatusPill labelAr={resolveOrderStatus(event.status)?.labelAr ?? event.status} tone={resolveOrderStatus(event.status)?.tone ?? "neutral"} />
                </div>
                <div className="mobile-timeline-event-meta">
                  <span dir="ltr">{formatArabicDate(event.timestamp)} · {formatArabicRelativeTime(event.timestamp)}</span>
                  <span className="mobile-muted">مصدر: {event.source}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </MobileSection>

      <MobileSection titleAr="معلومات النظام">
        <div className="mobile-detail-line"><span>معرف الطلب</span><strong dir="ltr">{order.id}</strong></div>
        <div className="mobile-detail-line"><span>تاريخ الإنشاء</span><strong>{formatArabicDate(order.createdAt ?? order.created_at)}</strong></div>
        {order.updatedAt && <div className="mobile-detail-line"><span>آخر تحديث</span><strong>{formatArabicDate(order.updatedAt)}</strong></div>}
        {order.revenueLogged ? (
          <div className="mobile-detail-line"><span>حالة الإيراد</span><strong style={{ color: "var(--success)" }}>مسجل عند التسليم</strong></div>
        ) : (
          <div className="mobile-detail-line"><span>حالة الإيراد</span><strong style={{ color: "var(--warning)" }}>غير مسجل</strong></div>
        )}
        {order.codSettledAt ? (
          <div className="mobile-detail-line"><span>توريد المندوب</span><strong style={{ color: "var(--success)" }}>مستلم</strong></div>
        ) : expectedCod > 0 ? (
          <div className="mobile-detail-line"><span>توريد المندوب</span><strong style={{ color: "var(--warning)" }}>معلق</strong></div>
        ) : (
          <div className="mobile-detail-line"><span>توريد المندوب</span><strong style={{ color: "var(--muted-foreground)" }}>غير مطلوب (مدفوع بالكامل)</strong></div>
        )}
        {order.returnConfirmedAt ? (
          <div className="mobile-detail-line"><span>تأكيد المرتجع</span><strong style={{ color: "var(--success)" }}>مؤكد — {formatArabicDate(order.returnConfirmedAt)}</strong></div>
        ) : order.returnedAt ? (
          <div className="mobile-detail-line"><span>حالة المرتجع</span><strong style={{ color: "var(--warning)" }}>بانتظار التأكيد في المخزن</strong></div>
        ) : (
          <div className="mobile-detail-line"><span>مرتجع</span><strong style={{ color: "var(--muted-foreground)" }}>لا يوجد</strong></div>
        )}
        {order.isExchange && <div className="mobile-detail-line"><span>نوع الطلب</span><strong style={{ color: "var(--primary)" }}>طلب استبدال</strong></div>}
      </MobileSection>

      <MobileSection titleAr="إجراءات مرتبطة" action={
        <button type="button" className="mobile-text-button" onClick={() => navigate(`/customers/${order.customerId ?? order.customer_id}`)}>
          عرض العميل
        </button>
      }>
        <div className="mobile-detail-line">
          <span>العميل</span>
          <button type="button" className="mobile-text-button" onClick={() => order.customerId ? navigate(`/customers/${order.customerId}`) : null} disabled={!order.customerId}>
            {customerName}
          </button>
        </div>
        {displayItems.length > 0 && (
          <div className="mobile-detail-line">
            <span>أول صنف</span>
            <button type="button" className="mobile-text-button" onClick={() => displayItems[0]?.productId ? navigate(`/inventory/${displayItems[0].productId}`) : null} disabled={!displayItems[0]?.productId}>
              {displayItems[0]?.productName ?? "—"}
            </button>
          </div>
        )}
      </MobileSection>
    </div>
  </section>;
}