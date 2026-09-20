/**
 * المالية — the Store Owner's cockpit.
 *
 * ## Whose screen this is
 *
 * The Store Owner is `ADMIN` of the current store, and nothing else. Not the
 * System Owner, which is a global email allowlist holding no store membership.
 * The route guard asks for the `owner` capability, which is keyed on that same
 * role, and `owner_financial_summary` checks it again in Postgres — so a
 * forged client gets a `42501`, not a screenful of someone else's money.
 *
 * ## Every number here came from one query
 *
 * Nothing on this screen is computed. `grossProfit`, `netProfit`, the channel
 * split and every balance arrive already summed by the reader, which is the
 * same ledger arithmetic `pnl()` performs on Desktop. There is no second
 * accounting implementation and no screen-local subtraction.
 *
 * ## Fact, then why — never a number alone
 *
 * The persona architecture (§3) asks for a hierarchy rather than a KPI grid: a
 * grid of twelve tiles is a way of having no opinion about what matters. So
 * each figure carries the account it came from, and the order is the order the
 * questions actually get asked — what did I make, where did it come from, what
 * do I hold, who owes whom.
 *
 * ## Flows move with the period. Positions do not.
 *
 * Revenue, COGS, expenses and returns are FLOWS and are measured over the
 * selected window. A wallet balance, a supplier debt and inventory value are
 * POSITIONS — what they are right now — so a date filter on them is
 * meaningless and the reader does not apply one. The headings say which is
 * which, because a reader who thinks «رصيد المحفظة» is "this month's" will
 * mis-plan a payment.
 */

import { useMemo, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { MobileAppBar } from "@/mobile/components/MobileAppBar";
import { MobileSection } from "@/mobile/components/MobileSection";
import { FilterSheet } from "@/mobile/components/FilterSheet";
import { EmptyState, ErrorState, SkeletonState } from "@/mobile/components/States";
import { useOwnerFinancials } from "@/mobile/data/useOwnerFinancials";
import { formatArabicCurrency } from "@/mobile/viewmodels/formatters";
import { channelLabel, periodWindow, type PeriodPreset } from "@/lib/ledger/reports";
import { WALLET_LABELS } from "@/types";
import type { OwnerSubjectAmount } from "@/lib/ledger/ownerFinancials";

/**
 * The three windows a phone is read in.
 *
 * `periodWindow` is the canonical one from `reports.ts` — the same function
 * التقارير المالية uses on Desktop, so «الشهر» means the same month on both.
 * Quarter and year are deliberately absent: the ledger is weeks old, and a
 * yearly card would be a mostly-empty box pretending to be a trend.
 */
const PERIODS = [
  { id: "day", label: "اليوم" },
  { id: "week", label: "الأسبوع" },
  { id: "month", label: "الشهر" },
] as const;

/** A wallet subject already folded onto its canonical key by the reader. */
function walletLabel(subjectId: string): string {
  return WALLET_LABELS[subjectId] ?? subjectId;
}

function AmountRow({
  label,
  amount,
  hint,
  tone,
}: {
  label: string;
  amount: number;
  hint?: string;
  tone?: "positive" | "negative" | "muted";
}) {
  return (
    <div className="mobile-owner-row">
      <div className="mobile-owner-row-main">
        <span className="mobile-owner-row-label">{label}</span>
        <span className={`mobile-owner-row-value${tone ? ` is-${tone}` : ""}`} dir="ltr">
          {formatArabicCurrency(amount)}
        </span>
      </div>
      {hint && <p className="mobile-owner-row-hint">{hint}</p>}
    </div>
  );
}

function SubjectList({
  rows,
  emptyAr,
  labelOf,
}: {
  rows: OwnerSubjectAmount[];
  emptyAr: string;
  labelOf?: (subjectId: string) => string;
}) {
  if (rows.length === 0) return <EmptyState messageAr={emptyAr} />;
  return (
    <div className="mobile-owner-list">
      {rows.map((row) => (
        <AmountRow
          key={row.subjectId}
          label={labelOf ? labelOf(row.subjectId) : row.subjectId}
          amount={row.amount}
          tone={row.amount < 0 ? "negative" : undefined}
        />
      ))}
    </div>
  );
}

export function MobileOwnerScreen() {
  const navigate = useNavigate();
  const [preset, setPreset] = useState<Exclude<PeriodPreset, "custom">>("day");

  // Derived from the DATE every time, not stored: an app left open past
  // midnight must report the period it is actually in.
  const window = useMemo(() => periodWindow(preset), [preset]);
  const { data, loading, error, denied, reload } = useOwnerFinancials(window);

  const periodLabel = PERIODS.find((p) => p.id === preset)?.label ?? "";

  return (
    <section className="mobile-screen">
      <MobileAppBar
        title="المالية"
        leadingAction={
          <button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع">
            <ArrowRight aria-hidden="true" />
          </button>
        }
        trailingAction={
          <button type="button" className="mobile-icon-button" onClick={reload} aria-label="تحديث">
            <RefreshCw aria-hidden="true" />
          </button>
        }
      />

      <div className="mobile-screen-body">
        <div className="mobile-filter-row">
          <FilterSheet
            label="الفترة"
            options={PERIODS as readonly { id: string; label: string }[]}
            value={preset}
            onChange={(id) => setPreset(id as Exclude<PeriodPreset, "custom">)}
          />
        </div>

        {loading && <SkeletonState count={6} />}

        {/* A refusal and a broken connection need different words, and neither
            may be rendered as a figure. */}
        {!loading && error && (
          denied
            ? <EmptyState titleAr="غير مصرّح" messageAr={error} />
            : <ErrorState messageAr={error} onRetry={reload} />
        )}

        {!loading && !error && data && (
          <>
            <MobileSection titleAr={`الأرباح — ${periodLabel}`}>
              <div className="mobile-owner-card">
                <AmountRow
                  label="صافي المبيعات"
                  amount={data.revenue}
                  hint="حساب revenue في دفتر الحسابات — بعد خصم المرتجعات"
                />
                <AmountRow
                  label="تكلفة البضاعة المباعة"
                  amount={data.cogs}
                  hint="حساب cogs — بعد خصم المرتجعات كمان"
                  tone="muted"
                />
                <AmountRow
                  label="مجمل الربح"
                  amount={data.grossProfit}
                  hint="صافي المبيعات − التكلفة"
                  tone={data.grossProfit < 0 ? "negative" : "positive"}
                />
                <AmountRow
                  label="المصروفات"
                  amount={data.expenses}
                  hint="حساب expense — إيجار ورواتب وعجز الجرد ورسوم مرتجع الشحن"
                  tone="muted"
                />
                <AmountRow
                  label="صافي الربح"
                  amount={data.netProfit}
                  hint="مجمل الربح − المصروفات"
                  tone={data.netProfit < 0 ? "negative" : "positive"}
                />
              </div>
            </MobileSection>

            <MobileSection titleAr={`المبيعات حسب القناة — ${periodLabel}`} headingLevel={2}>
              <SubjectList
                rows={data.salesByChannel}
                emptyAr="لا مبيعات في الفترة دي."
                labelOf={channelLabel}
              />
            </MobileSection>

            <MobileSection titleAr={`المرتجعات — ${periodLabel}`}>
              <div className="mobile-owner-card">
                <AmountRow
                  label="قيمة المرتجعات"
                  amount={data.returnsValue}
                  hint="سطور return_confirmed — متخصومة بالفعل من صافي المبيعات أعلاه، معروضة للعلم فقط"
                  tone="muted"
                />
              </div>
            </MobileSection>

            {/* Everything below is a POSITION: it is what it is now, and the
                period filter above does not touch it. */}
            <MobileSection titleAr="المراكز المالية — دلوقتي">
              <div className="mobile-owner-card">
                <AmountRow
                  label="قيمة المخزون"
                  amount={data.stockValue}
                  hint="مجموع حساب stock"
                />
                <AmountRow
                  label="مستحقات عملاء الجملة"
                  amount={data.receivableClient}
                  hint="حساب receivable_client"
                  tone={data.receivableClient < 0 ? "negative" : undefined}
                />
              </div>
            </MobileSection>

            <MobileSection titleAr="الخزن والمحافظ — دلوقتي" headingLevel={3}>
              <SubjectList
                rows={data.walletBalances}
                emptyAr="لا توجد حركة على أي خزنة."
                labelOf={walletLabel}
              />
            </MobileSection>

            <MobileSection titleAr="مستحقات الموردين — دلوقتي" headingLevel={3}>
              <SubjectList rows={data.supplierPayable} emptyAr="لا مستحقات للموردين." />
            </MobileSection>

            <MobileSection titleAr="شركات الشحن — دلوقتي" headingLevel={3}>
              <div className="mobile-owner-subgroup">
                <h4 className="mobile-owner-subtitle">لك عند المندوبين</h4>
                <SubjectList rows={data.courierReceivable} emptyAr="لا مستحقات لك." />
                <h4 className="mobile-owner-subtitle">عليك للمندوبين</h4>
                <SubjectList rows={data.courierPayable} emptyAr="لا مستحقات عليك." />
              </div>
            </MobileSection>
          </>
        )}
      </div>
    </section>
  );
}
