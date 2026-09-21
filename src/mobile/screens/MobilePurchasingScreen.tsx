/**
 * المشتريات — the purchasing surface for ACCOUNTANT and the Owner.
 *
 * ## What was missing, and what was not
 *
 * The WRITE has been on the phone since توريد سريع shipped: `/restock` calls
 * `executeQuickRestock` → `commitReceipt`, which is the ONE way a supplier
 * receipt reaches the database on either platform. What did not exist was the
 * read — the persona architecture's Owner table records Purchases as
 * "➖ written ✅, not read", and this route was a قريباً card while being
 * ACCOUNTANT's primary bottom-nav destination.
 *
 * So this screen adds no purchasing policy and no second accounting path. It
 * answers the two questions the write already produced answers for:
 *
 *   الفواتير  — did that receipt land, and what is still owed on it
 *   الموردين  — who do I owe, and how much
 *
 * and hands توريد جديد straight to the existing canonical flow.
 *
 * ## Where each number comes from
 *
 * The invoice list renders `purchase_invoices` as written — including its own
 * `status`, which `commitReceipt` set from what was actually handed over. It is
 * not recomputed here; the desktop purchasing table reads the same column.
 *
 * What is still OWED is deliberately not summed from the documents.
 * `supplierTotals.ts` says it outright: the owed figure is
 * `SUM(payable_supplier)` from the ledger, "so it stays right no matter which
 * screen moved the money". A supplier payment made on Desktop moves the ledger
 * without touching an invoice row, so an owed column derived from
 * `totalAmount − paidAmount` would quietly disagree with the Owner's cockpit.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Plus, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { balances } from "@/lib/ledger";
import type { Balance } from "@/lib/ledger/types";
import { MobileAppBar } from "@/mobile/components/MobileAppBar";
import { MobileSearch } from "@/mobile/components/MobileSearch";
import { FilterSheet } from "@/mobile/components/FilterSheet";
import { EmptyState, ErrorState, OfflineState, SkeletonState } from "@/mobile/components/States";
import { useIsOffline } from "@/mobile/data/useIsOffline";
import { StatusPill } from "@/mobile/components/StatusPill";
import { readMobilePurchaseInvoices } from "@/mobile/data/mobileReaders";
import { useMobilePagedQuery } from "@/mobile/data/useMobilePagedQuery";
import { useRealtimeTables } from "@/mobile/data/useMobileRealtime";
import { useSubjectNames } from "@/mobile/data/useSubjectNames";
import { formatArabicCurrency, formatArabicDate } from "@/mobile/viewmodels/formatters";
import type { StatusTone } from "@/mobile/viewmodels/types";

const SEGMENTS = [
  { id: "invoices", label: "الفواتير" },
  { id: "suppliers", label: "الموردين" },
] as const;

/** The document's own status, in the same words the desktop table uses. */
const INVOICE_STATUS: Record<string, { labelAr: string; tone: StatusTone }> = {
  paid: { labelAr: "مسددة", tone: "success" },
  partial: { labelAr: "مسددة جزئياً", tone: "warning" },
  unpaid: { labelAr: "آجل", tone: "critical" },
};

const STATUS_FILTERS = [
  { id: "all", label: "كل الفواتير" },
  { id: "unpaid", label: "عليها مستحقات" },
  { id: "paid", label: "مسددة" },
] as const;

function statusOf(raw: unknown) {
  return INVOICE_STATUS[String(raw ?? "")] ?? { labelAr: "غير معروف", tone: "neutral" as StatusTone };
}

export function MobilePurchasingScreen() {
  const navigate = useNavigate();
  const [segment, setSegment] = useState<string>("invoices");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("all");

  const page = useMobilePagedQuery(
    readMobilePurchaseInvoices,
    { search: query, status: status === "all" ? undefined : status },
    { watch: ["purchase_invoices"] },
  );

  return (
    <section className="mobile-screen">
      <MobileAppBar
        title="المشتريات"
        leadingAction={
          <button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع">
            <ArrowRight aria-hidden="true" />
          </button>
        }
        trailingAction={
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
        }
      />

      <div className="mobile-screen-body">
        {/* The write, exactly where someone looking at what they owe expects to
            find it — and it is the SAME flow, not a purchasing-only copy. */}
        <button type="button" className="mobile-primary-button" onClick={() => navigate("/restock")}>
          <Plus aria-hidden="true" /> توريد جديد
        </button>

        <div className="mobile-segmented-control" role="tablist">
          {SEGMENTS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={segment === item.id}
              className={segment === item.id ? "is-active" : ""}
              onClick={() => setSegment(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {segment === "invoices" ? (
          <InvoicesTab
            page={page}
            query={query}
            onQuery={setQuery}
            status={status}
            onStatus={setStatus}
          />
        ) : (
          <SuppliersTab />
        )}
      </div>
    </section>
  );
}

function InvoicesTab({
  page,
  query,
  onQuery,
  status,
  onStatus,
}: {
  page: ReturnType<typeof useMobilePagedQuery<any>>;
  query: string;
  onQuery: (value: string) => void;
  status: string;
  onStatus: (value: string) => void;
}) {
  const offline = useIsOffline();
  return (
    <>
      <MobileSearch value={query} onChange={onQuery} placeholder="ابحث برقم الفاتورة أو المورد" />
      <div className="mobile-filter-row">
        <FilterSheet
          label="الحالة"
          options={STATUS_FILTERS as readonly { id: string; label: string }[]}
          value={status}
          onChange={onStatus}
        />
      </div>

      {offline ? (
        <OfflineState />
      ) : page.loading ? (
        <SkeletonState />
      ) : page.error ? (
        <ErrorState messageAr="تعذّر تحميل فواتير المشتريات." onRetry={page.reload} />
      ) : page.rows.length === 0 ? (
        <EmptyState
          titleAr="لا توجد فواتير مشتريات"
          messageAr="كل توريد يتسجّل هنا بفاتورته ورقمها."
        />
      ) : (
        <>
          <div className="mobile-entity-list">
            {page.rows.map((invoice: any) => {
              const entry = statusOf(invoice.status);
              const remaining = Number(invoice.remainingAmount ?? 0);
              return (
                <div className="mobile-owner-row" key={String(invoice.id)}>
                  <div className="mobile-owner-row-main">
                    <span className="mobile-owner-row-label" dir="ltr">
                      {String(invoice.invoiceNumber ?? invoice.id)}
                    </span>
                    <span className="mobile-owner-row-value" dir="ltr">
                      {formatArabicCurrency(Number(invoice.totalAmount ?? 0))}
                    </span>
                  </div>
                  <p className="mobile-owner-row-hint">
                    {String(invoice.supplierName || "—")} · {formatArabicDate(invoice.createdAt)} ·{" "}
                    <StatusPill labelAr={entry.labelAr} tone={entry.tone} />
                    {remaining > 0 && <> · باقي {formatArabicCurrency(remaining)}</>}
                  </p>
                </div>
              );
            })}
          </div>
          {page.hasMore && (
            <button
              type="button"
              className="mobile-primary-button mobile-load-more"
              onClick={page.loadMore}
              disabled={page.loadingMore}
            >
              {page.loadingMore ? "جارٍ التحميل…" : "تحميل المزيد"}
            </button>
          )}
        </>
      )}
    </>
  );
}

/**
 * Who we owe, from the ledger.
 *
 * `balances({ account: "payable_supplier" })` is the same SUM the Owner cockpit
 * and the desktop purchasing screen read. Suppliers with nothing outstanding do
 * not appear — a list of zeroes is not an answer to "who do I owe".
 */
function SuppliersTab() {
  const offline = useIsOffline();
  const [rows, setRows] = useState<Balance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const names = useSubjectNames(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await balances({ account: "payable_supplier" }));
    } catch (e) {
      setRows(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // A receipt or a supplier payment both land as ledger events.
  useRealtimeTables(["ledger_events", "purchase_invoices"], () => { void load(); });

  const owed = useMemo(
    () => (rows ?? []).filter((row) => Math.abs(row.amount) > 0.005).sort((a, b) => b.amount - a.amount),
    [rows],
  );

  if (offline) return <OfflineState />;
  if (error) return <ErrorState messageAr="تعذّر تحميل مستحقات الموردين." onRetry={() => void load()} />;
  if (rows === null) return <SkeletonState />;
  if (owed.length === 0) {
    return <EmptyState titleAr="لا مستحقات للموردين" messageAr="مافيش حاجة مستحقة لأي مورد دلوقتي." />;
  }

  return (
    <div className="mobile-owner-list">
      {owed.map((row) => {
        // An id with no supplier row is an orphaned debt, not a blank. Same
        // convention the Owner cockpit uses: say it is unknown, keep the id.
        const resolved = names.suppliers.get(row.subjectId);
        return (
          <div className="mobile-owner-row" key={row.subjectId}>
            <div className="mobile-owner-row-main">
              <span className="mobile-owner-row-label">{resolved ?? "غير معروف"}</span>
              <span
                className={`mobile-owner-row-value${row.amount < 0 ? " is-negative" : ""}`}
                dir="ltr"
              >
                {formatArabicCurrency(row.amount)}
              </span>
            </div>
            <p className="mobile-owner-row-hint">
              {resolved ? "حساب payable_supplier" : row.subjectId}
            </p>
          </div>
        );
      })}
    </div>
  );
}
