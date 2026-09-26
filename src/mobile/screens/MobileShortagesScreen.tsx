import { useCallback, useEffect, useState } from "react";
import { ArrowRight, PackageX, RefreshCw, Plus, ShoppingCart } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { MobileAppBar } from "@/mobile/components/MobileAppBar";
import { MobileSearch } from "@/mobile/components/MobileSearch";
import { EmptyState, ErrorState, OfflineState, SkeletonState } from "@/mobile/components/States";
import { useIsOffline } from "@/mobile/data/useIsOffline";
import { formatArabicQuantity, formatArabicCount } from "@/mobile/viewmodels/formatters";
import { readMobileShortages, type MobileShortageRow } from "@/mobile/data/mobileHomeReader";
import { useMobileCapabilities } from "@/mobile/navigation/MobileRouteGuard";
import { useRealtimeTables } from "@/mobile/data/useMobileRealtime";

/**
 * تقرير النواقص — the products open orders demand more of than the shelf holds.
 *
 * ## Why this is its own screen
 *
 * `/inventory/shortages` used to route to `MobileStockScreen`, which read its
 * filter from a QUERY parameter (`?filter=shortage`) and not from the path — so
 * arriving by the path produced the plain stock list. Worse, the "نواقص" filter
 * it did have was `|| filter === "shortage"`, a predicate that passes every
 * row, and its empty state said the feature needed "مصدر تجميعي من دفتر
 * الحسابات". That aggregate source already existed: `mobile_shortages`. Home
 * was already calling it. Only the screen behind the link was missing.
 *
 * ## The authority
 *
 * Everything here comes from the `mobile_shortages` RPC and nothing is
 * recomputed on the client. That function defines the deficit as
 *
 *     deficit = required − COALESCE(SUM(ledger_lines.qty_delta), 0)
 *
 * over open (`pending`) order lines, and returns only rows where
 * it is positive. It reads the LEDGER for on-hand, never `products.quantity`,
 * and it consults no `shortfall` or `backorder` flag on the order line — a
 * plain order for 3 against a shelf holding 1 is a shortage of 2, whether or
 * not anybody remembered to tick something.
 *
 * `required`, `stock`, `deficit`, `order_count` and `waiting_orders` are shown
 * exactly as the database returned them. If they are ever wrong, they are
 * wrong in one place.
 */
export function MobileShortagesScreen() {
  const offline = useIsOffline();
  const navigate = useNavigate();
  // توريد is a WRITE (`commitReceipt`) behind the `purchasing` capability. A
  // role that can SEE a shortage is not automatically a role that can fill it —
  // MODERATOR reads this screen and buys nothing.
  const canRestock = useMobileCapabilities().has("purchasing");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<MobileShortageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // `quiet`: re-check without the skeleton, so a realtime cue does not blank
  // the list under the operator's thumb.
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      setRows(await readMobileShortages());
    } catch (e) {
      // Not the previous answer: «إجمالي العجز» above the error would
      // otherwise keep showing a total nobody can vouch for any more.
      setRows([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A shortage is open orders against ledger stock, so either one moving can
  // open or close one — including a توريد recorded on another device.
  useRealtimeTables(["orders", "ledger_events"], () => { void load(true); });

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? rows.filter(
        (r) =>
          String(r.product_name ?? "").toLowerCase().includes(needle) ||
          String(r.sku ?? "").toLowerCase().includes(needle),
      )
    : rows;

  const totalDeficit = rows.reduce((sum, r) => sum + Number(r.deficit || 0), 0);

  return (
    <section className="mobile-screen">
      <MobileAppBar
        title="النواقص"
        eyebrow={rows.length > 0 ? `${formatArabicCount(rows.length)} صنف ناقص` : undefined}
        leadingAction={
          <button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع">
            <ArrowRight aria-hidden="true" />
          </button>
        }
        trailingAction={
          <button type="button" className="mobile-icon-button" onClick={() => void load()} aria-label="تحديث">
            <RefreshCw aria-hidden="true" />
          </button>
        }
      />

      <div className="mobile-screen-body">
        {rows.length > 0 && (
          <div className="mobile-shortage-summary" role="status">
            <span>إجمالي العجز</span>
            <strong>{formatArabicQuantity(totalDeficit)}</strong>
          </div>
        )}

        <MobileSearch value={query} onChange={setQuery} placeholder="ابحث عن صنف ناقص" />

        {offline ? (
          <OfflineState />
        ) : loading ? (
          <SkeletonState />
        ) : error ? (
          <ErrorState messageAr="تعذّر تحميل تقرير النواقص." onRetry={() => void load()} />
        ) : visible.length === 0 ? (
          <EmptyState
            titleAr={rows.length === 0 ? "لا توجد نواقص" : "لا توجد نتائج"}
            messageAr={
              rows.length === 0
                ? "كل الطلبات المفتوحة مغطاة بالمخزون الحالي."
                : "لا يوجد صنف ناقص مطابق لهذا البحث."
            }
          />
        ) : (
          <div className="mobile-entity-list">
            {visible.map((row) => {
              const waiting = Array.isArray(row.waiting_orders) ? row.waiting_orders : [];
              return (
                <article className="mobile-shortage-card" key={row.product_id}>
                  <header className="mobile-shortage-card-head">
                    <div className="mobile-stock-card-icon" aria-hidden="true">
                      <PackageX />
                    </div>
                    <div className="mobile-shortage-card-title">
                      <strong>{row.product_name}</strong>
                      <span dir="ltr">{row.sku}</span>
                    </div>
                    <div className="mobile-shortage-deficit">
                      <span>ناقص</span>
                      <strong>{formatArabicQuantity(Number(row.deficit || 0))}</strong>
                    </div>
                  </header>

                  {/* required − stock = deficit, shown side by side so the number
                      is checkable on the spot rather than taken on trust. */}
                  <dl className="mobile-shortage-figures">
                    <div>
                      <dt>مطلوب للطلبات</dt>
                      <dd>{formatArabicQuantity(Number(row.required || 0))}</dd>
                    </div>
                    <div>
                      <dt>المتاح فعلياً</dt>
                      <dd>{formatArabicQuantity(Number(row.stock || 0))}</dd>
                    </div>
                    <div>
                      <dt>طلبات منتظرة</dt>
                      <dd>{formatArabicCount(Number(row.order_count || 0))}</dd>
                    </div>
                  </dl>

                  {waiting.length > 0 && (
                    <div className="mobile-shortage-waiting">
                      <h3>العملاء المنتظرون</h3>
                      <ul>
                        {waiting.map((w: any) => (
                          <li key={String(w?.orderId ?? w?.orderNumber)}>
                            <button
                              type="button"
                              className="mobile-shortage-waiting-row"
                              onClick={() => navigate(`/orders/${w?.orderId}`)}
                            >
                              <span className="mobile-shortage-waiting-customer">{String(w?.customerName ?? "—")}</span>
                              <span className="mobile-shortage-waiting-order" dir="ltr">
                                {String(w?.orderNumber ?? w?.orderId ?? "")}
                              </span>
                              <span className="mobile-chevron" aria-hidden="true">‹</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <footer className="mobile-shortage-actions">
                    <button
                      type="button"
                      className="mobile-secondary-button"
                      onClick={() => navigate(`/inventory/${row.product_id}`)}
                    >
                      <ShoppingCart aria-hidden="true" />
                      فتح الصنف
                    </button>
                    {canRestock && (
                      <button
                        type="button"
                        className="mobile-primary-button"
                        onClick={() => navigate(`/restock?products=${encodeURIComponent(row.product_id)}`)}
                      >
                        <Plus aria-hidden="true" />
                        توريد
                      </button>
                    )}
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
