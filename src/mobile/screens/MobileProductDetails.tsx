import { ArrowRight, Package, AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { productMinLevel, productPrice, productWholesalePrice, isProductArchived } from "@/lib/product";
import { MobileAppBar } from "@/mobile/components/MobileAppBar";
import { MobileSection } from "@/mobile/components/MobileSection";
import { StatusPill } from "@/mobile/components/StatusPill";
import { EmptyState, ErrorState, OfflineState, SkeletonState } from "@/mobile/components/States";
import { deriveStockStatusKey } from "@/mobile/viewmodels/stockViewModel";
import { resolveStockStatus } from "@/mobile/viewmodels/statusTaxonomies";
import { formatArabicCurrency, formatArabicDate, formatArabicQuantity } from "@/mobile/viewmodels/formatters";
import { readMobileProduct, readMobileProductWaitingOrders } from "@/mobile/data/mobileReaders";
import { useMobileEntity } from "@/mobile/data/useMobileEntity";
import { useIsOffline } from "@/mobile/data/useIsOffline";

export function MobileProductDetails() {
  const navigate = useNavigate();
  const { productId } = useParams();
  const loadProduct = useCallback(() => readMobileProduct(productId ?? ""), [productId]);
  const { data: product, loading, error, reload } = useMobileEntity(loadProduct);
  const offline = useIsOffline();
  // One back affordance for every terminal state: an operator who lands on
  // "not found", an error or a lost connection must still be able to leave.
  const back = (
    <button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع">
      <ArrowRight aria-hidden="true" />
    </button>
  );
  const [waitingOrders, setWaitingOrders] = useState<any[]>([]);
  const [waitingLoading, setWaitingLoading] = useState(true);
  const [waitingError, setWaitingError] = useState<string | null>(null);

  /**
   * Who is waiting on this product.
   *
   * Lifted out of the effect so the error state can ask again through the SAME
   * reader. `waitingError` used to be set and never rendered: a failed read
   * left `waitingOrders` at `[]`, and the empty branch then told the operator
   * «لا توجد طلبات نشطة تنتظر هذا المنتج» — which is a different claim
   * entirely, and the one they would act on when deciding not to reorder.
   */
  const loadWaiting = useCallback(async () => {
    if (!productId) return;
    setWaitingLoading(true);
    setWaitingError(null);
    try {
      setWaitingOrders(await readMobileProductWaitingOrders(productId));
    } catch (err) {
      // No partial list: half an answer about who is waiting is worse than
      // saying the question could not be answered.
      setWaitingOrders([]);
      setWaitingError(err instanceof Error ? err.message : String(err));
    } finally {
      setWaitingLoading(false);
    }
  }, [productId]);

  useEffect(() => { void loadWaiting(); }, [loadWaiting]);

  if (offline) return <><MobileAppBar title="تفاصيل المنتج" leadingAction={back} /><div className="mobile-screen-body"><OfflineState /></div></>;
  if (loading) return <><MobileAppBar title="تفاصيل المنتج" /><div className="mobile-screen-body"><SkeletonState /></div></>;
  if (error) return <><MobileAppBar title="تفاصيل المنتج" leadingAction={back} /><ErrorState messageAr="تعذّر تحميل المنتج." onRetry={reload} /></>;
  if (!product) return <><MobileAppBar title="تفاصيل المنتج" leadingAction={<button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع"><ArrowRight aria-hidden="true" /></button>} /><EmptyState titleAr="المنتج غير موجود" messageAr="تعذّر العثور على هذا المنتج." /></>;

  const archived = isProductArchived(product);
  // The LEDGER quantity `readMobileProduct` attached — the same number the
  // stock list shows. The shared `lib/product` stock helper was used here, and
  // on mobile it can only answer from the `products.quantity` mirror: its snapshot is
  // filled by desktop's `useStock`, which mobile never mounts. So the list and
  // this screen disagreed about one product, and this one was the mirror.
  const quantity = Number((product as any).mobileStock ?? 0);
  const minLevel = productMinLevel(product);
  const statusKey = deriveStockStatusKey(quantity, minLevel);
  const status = resolveStockStatus(statusKey);
  const retailPrice = productPrice(product);
  const wholesalePrice = productWholesalePrice(product);
  const avgCost = Number((product as any).mobileCost ?? 0);
  const sku = product.sku ?? "—";
  const barcode = product.barcode ?? "—";
  const category = product.category ?? "—";

  const variants = product.metadata?.variants ?? product.variants;
  const hasVariants = Array.isArray(variants) && variants.length > 0;
  const isBundle = product.isBundle === true || product.metadata?.isBundle === true;
  const bundleItems = isBundle ? (product.bundleItems ?? product.metadata?.bundleItems ?? []) : [];

  return <section className="mobile-screen">
    <MobileAppBar title="تفاصيل المنتج" leadingAction={<button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع"><ArrowRight aria-hidden="true" /></button>} />
    <div className="mobile-screen-body">
      {archived && (
        <div className="mobile-archived-banner">
          <AlertTriangle aria-hidden="true" />
          <span>هذا المنتج مؤرشف — مخفي من القوائم النشطة</span>
        </div>
      )}

      <div className="mobile-detail-hero">
        <Package aria-hidden="true" />
        <div>
          <h2>{product.name}</h2>
          <span dir="ltr">{sku}</span>
          {barcode !== "—" && <span className="mobile-muted" dir="ltr">باركود: {barcode}</span>}
          <span className="mobile-muted">الصنف: {category}</span>
        </div>
        <StatusPill labelAr={status.labelAr} tone={status.tone} />
      </div>

      <MobileSection titleAr="المخزون">
        <div className="mobile-detail-grid">
          <div>
            <span>المتاح على الرف</span>
            <strong>{formatArabicQuantity(quantity)}</strong>
          </div>
          <div>
            <span>حد إعادة الطلب</span>
            <strong>{formatArabicQuantity(minLevel)}</strong>
          </div>
          <div>
            <span>متوسط التكلفة (المرجح)</span>
            <strong>{formatArabicCurrency(avgCost)}</strong>
          </div>
          <div>
            <span>قيمة المخزون الحالية</span>
            <strong>{formatArabicCurrency(quantity * avgCost)}</strong>
          </div>
        </div>
        <div className="mobile-detail-line" style={{ marginBlockStart: "0.5rem" }}>
          <span>الحالة</span>
          <StatusPill labelAr={status.labelAr} tone={status.tone} />
        </div>
      </MobileSection>

      <MobileSection titleAr="التسعير">
        <div className="mobile-detail-grid">
          <div>
            <span>سعر البيع (قطاعي)</span>
            <strong>{formatArabicCurrency(retailPrice)}</strong>
          </div>
          <div>
            <span>سعر الجملة</span>
            <strong>{formatArabicCurrency(wholesalePrice)}</strong>
          </div>
          {avgCost > 0 && retailPrice > 0 && (
            <div>
              <span>هامش البيع</span>
              <strong style={{ color: "var(--success)" }}>
                {formatArabicCurrency(retailPrice - avgCost)} ({(Math.round(((retailPrice - avgCost) / retailPrice) * 10000) / 100)}%)
              </strong>
            </div>
          )}
          {avgCost > 0 && wholesalePrice > 0 && wholesalePrice !== retailPrice && (
            <div>
              <span>هامش الجملة</span>
              <strong style={{ color: "var(--success)" }}>
                {formatArabicCurrency(wholesalePrice - avgCost)} ({(Math.round(((wholesalePrice - avgCost) / wholesalePrice) * 10000) / 100)}%)
              </strong>
            </div>
          )}
        </div>
      </MobileSection>

      {hasVariants && (
        <MobileSection titleAr="الدرجات / الألوان">
          {variants.map((v: any) => (
            <div className="mobile-detail-line" key={v.name}>
              <span>{v.name}</span>
              <strong>{formatArabicQuantity(v.stock ?? 0)}</strong>
            </div>
          ))}
        </MobileSection>
      )}

      <MobileSection titleAr={waitingOrders.length > 0 ? `طلبات تنتظر هذا المنتج (${waitingOrders.length})` : "طلبات تنتظر هذا المنتج"}>
        {waitingLoading ? (
          <SkeletonState count={2} />
        ) : waitingError ? (
          <ErrorState messageAr="تعذّر تحميل الطلبات المنتظرة." onRetry={() => void loadWaiting()} />
        ) : waitingOrders.length === 0 ? (
          <p className="mobile-muted">لا توجد طلبات نشطة تنتظر هذا المنتج.</p>
        ) : (
          <>
          {waitingOrders.slice(0, 10).map((wo: any) => (
            <button
              type="button"
              className="mobile-waiting-order-row"
              key={wo.orderId}
              onClick={() => navigate(`/orders/${wo.orderId}`)}
            >
              <div>
                <strong dir="ltr">{wo.orderNumber}</strong>
                <span className="mobile-muted" style={{ display: "block", fontSize: "0.75rem" }}>{wo.customerName}</span>
              </div>
              <div style={{ textAlign: "left" }}>
                <span className="mobile-quantity-badge">{formatArabicQuantity(wo.quantity)}</span>
                <StatusPill
                  labelAr={resolveStockStatus(deriveStockStatusKey(0, 0)).labelAr}
                  tone={wo.status === "pending" ? "warning" : "info"}
                />
              </div>
            </button>
          ))}
          {waitingOrders.length > 10 && (
            <p className="mobile-muted" style={{ textAlign: "center", marginBlockStart: "0.5rem" }}>
              و {waitingOrders.length - 10} طلبات أخرى…
            </p>
          )}
          </>
        )}
      </MobileSection>

      {isBundle && bundleItems.length > 0 && (
        <MobileSection titleAr="مكونات الباقة">
          {bundleItems.map((item: any) => (
            <div className="mobile-detail-line" key={`${item.productId}-${item.variantName ?? ""}`}>
              <span>{item.productName ?? item.productId}</span>
              <strong>{formatArabicQuantity(item.quantity)}</strong>
            </div>
          ))}
        </MobileSection>
      )}

      <MobileSection titleAr="معلومات النظام">
        <div className="mobile-detail-line"><span>معرف المنتج</span><strong dir="ltr">{product.id}</strong></div>
        <div className="mobile-detail-line"><span>الباركود</span><strong dir="ltr">{barcode}</strong></div>
        <div className="mobile-detail-line"><span>الكود (SKU)</span><strong dir="ltr">{sku}</strong></div>
        <div className="mobile-detail-line"><span>الصنف</span><strong>{category}</strong></div>
        {product.createdAt && <div className="mobile-detail-line"><span>تاريخ الإنشاء</span><strong>{formatArabicDate(product.createdAt)}</strong></div>}
        {product.updatedAt && <div className="mobile-detail-line"><span>آخر تحديث</span><strong>{formatArabicDate(product.updatedAt)}</strong></div>}
        <div className="mobile-detail-line"><span>مؤرشف</span><strong>{archived ? "نعم" : "لا"}</strong></div>
      </MobileSection>
    </div>
  </section>;
}