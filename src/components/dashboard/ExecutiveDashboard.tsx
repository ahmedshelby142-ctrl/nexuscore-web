/**
 * نظرة عامة — the summary screen.
 *
 * The MONEY on this screen is the `owner_financial_summary` RPC's answer, read
 * through `useOwnerFinancialSummary` — the one reader that checks who is
 * asking, and the single authority for revenue, net profit and the four
 * positions behind صافي القيمة. Nothing here re-derives those figures; the
 * only arithmetic allowed on them is presentational — netting the four
 * positions into net worth, dividing revenue by the order count.
 *
 * The COUNTS (orders, returns, the top product) and the trend line come from
 * the same ledger through `ledger_balances` and `ledger_events_page`, because
 * the RPC does not carry counts.
 *
 * The screen this replaced read `useBusinessStore().transactions` (a store the
 * ledger conversion left behind) and a hardcoded "+12.5%" growth badge — none
 * of it moved when the shop traded.
 *
 * It is a SUMMARY, not a report: seven cards, one trend, one period filter.
 * The full aggregates with P&L per month/quarter/year live in الشركاء والمالية
 * (brief §3.12) and must not be duplicated here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  TrendingUp,
  AlertTriangle,
  ShoppingCart,
  Receipt,
  Undo2,
  Crown,
  Lock,
  Package,
  Landmark,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { balances, events } from "@/lib/ledger";
import {
  PERIOD_LABELS,
  netWorthOf,
  sumOf,
  windowCounts,
  trendDays,
  windowFor,
  periodLabel,
  type Period,
} from "@/lib/dashboard";
import { useStock } from "@/lib/ledger/useStock";
import { useOwnerFinancialSummary } from "@/lib/ledger/useOwnerFinancialSummary";
import { LoadError } from "@/components/ui/load-error";
import { useCollectionStatus } from "@/components/ui/collection-gate";
import { matchesStockFilter } from "@/components/inventory/StockSummaryCards";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useSubscriptionStore } from "@/store/useSubscriptionStore";
import { activeProducts } from "@/lib/product";
import { formatMoney, formatQty } from "@/lib/math";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type WindowCounts = ReturnType<typeof windowCounts>;

/**
 * The counts and the trend — everything this screen shows that the Owner
 * summary RPC does not carry.
 *
 * An order is any `sale` (POS or wholesale) plus any online order placed in
 * the window; a return is a confirmed one. The top product is the subject
 * whose goods left at the highest cost — a per-product `SUM(cogs)` off the
 * same ledger the money figures read, not a second opinion about any money
 * total. The trend asks the ledger once per day in the window (7 or 30 cheap
 * local aggregates, in parallel); if that ever shows up in a profile, the
 * upgrade is one `GROUP BY date(occurred_at)` in the driver — no caller
 * changes.
 */
function useWindowCounts(period: Period) {
  const [counts, setCounts] = useState<WindowCounts | null>(null);
  const [trend, setTrend] = useState<{ date: string; revenue: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  // Reads issued but not settled. A retry while one is running is a no-op.
  const pending = useRef(0);

  useEffect(() => {
    let cancelled = false;
    pending.current += 1;
    setLoading(true);

    void (async () => {
      try {
        const { from, to } = windowFor(period);
        const days = trendDays(period);

        const [cogsRows, windowEvents, ...dailyRevenue] = await Promise.all([
          balances({ account: "cogs", from, to }),
          events({ from, to, limit: 2000 }),
          // One aggregate per day of the trend. Same account the money figures
          // sum, just narrower — the line and the cards cannot disagree.
          ...days.map((d) => balances({ account: "revenue", from: d.from, to: d.to })),
        ]);
        if (cancelled) return;

        setCounts(windowCounts({ cogsRows, events: windowEvents }));
        setTrend(
          dailyRevenue.map((rows, i) => ({
            date:
              period === "thisYear"
                ? days[i].from.toLocaleDateString("ar-EG", { month: "long" })
                : days[i].from.toLocaleDateString("ar-EG", { day: "numeric", month: "numeric" }),
            revenue: sumOf(rows),
          })),
        );
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // A failed read must never render as zeros — a dashboard of zeros
        // reads as "a quiet day", not as "we could not ask". The old counts
        // go too: a number from the last successful window under a failed
        // retry is worse than no number.
        setError(e instanceof Error ? e.message : String(e));
        setCounts(null);
        setTrend([]);
      } finally {
        pending.current -= 1;
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [period, tick]);

  // A retry while a read is running is a no-op: the answer it is waiting for
  // is the answer this retry wants. Keeps a double-clicked button from
  // stampeding the ledger.
  const reload = useCallback(() => {
    if (pending.current > 0) return;
    setTick((t) => t + 1);
  }, []);

  return { counts, trend, error, loading, reload };
}

const FIGURES_FAILED_MESSAGE =
  "مقدرناش نقرأ الأرقام من الدفتر، فمفيش أرقام معروضة دلوقتي. جرّب تاني.";

interface KpiProps {
  label: string;
  value: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "default" | "good" | "bad" | "warn";
  onClick: () => void;
}

/** One clickable card. Clicking opens the screen the number came from. */
function Kpi({ label, value, hint, icon: Icon, tone = "default", onClick }: KpiProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-2xl border border-border bg-card p-5 text-right transition-colors hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-ring"
    >
      <div className="flex items-center justify-between mb-3">
        <div
          className={cn(
            "size-9 rounded-xl flex items-center justify-center",
            tone === "good" && "bg-green-100 dark:bg-green-950/40 text-green-600",
            tone === "bad" && "bg-red-100 dark:bg-red-950/40 text-destructive",
            tone === "warn" && "bg-amber-100 dark:bg-amber-950/40 text-amber-600",
            tone === "default" && "bg-primary/10 text-primary",
          )}
        >
          <Icon className="size-4.5" />
        </div>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p
        className={cn(
          "text-2xl font-bold",
          tone === "good" && "text-green-600",
          tone === "bad" && "text-destructive",
        )}
      >
        {value}
      </p>
      <p className="text-sm text-muted-foreground mt-1">{hint}</p>
    </button>
  );
}

export function ExecutiveDashboard() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<Period>("today");

  // The money, from the one RPC that checks who is asking. The window's `to`
  // is "now" for most periods, so it is resolved once per period choice and
  // once per retry — NOT once per render, or the hooks keyed on its
  // milliseconds would refetch after every state change.
  const [windowStamp, setWindowStamp] = useState(0);
  const ownerWindow = useMemo(() => windowFor(period), [period, windowStamp]);
  const owner = useOwnerFinancialSummary(ownerWindow);
  const windowFigures = useWindowCounts(period);

  const allProducts = useBusinessStore((s) => s.products);
  const products = useMemo(() => activeProducts(allProducts), [allProducts]);
  const { qtyOf, loading: stockLoading, error: stockError, refresh: refreshStock } = useStock();
  // المنتجات المنخفضة counts the product LIST, which arrives by hydrate — so
  // the card is only a number once both the list and the ledger have landed.
  // Otherwise an unloaded list reads as "0 need restocking".
  const productsState = useCollectionStatus(["products"]);
  const restockStatus: "loading" | "error" | "ready" =
    stockError || productsState.status === "error"
      ? "error"
      : stockLoading || productsState.status === "loading"
        ? "loading"
        : "ready";

  /**
   * صافي القيمة is a point-in-time BALANCE, not a period figure — the RPC
   * returns the four positions lifetime, ignoring the window, which is exactly
   * the "دلوقتي" the card promises. Netting them here is presentation, not a
   * second authority: every input is the server's own number.
   */
  const netWorth = owner.data
    ? netWorthOf({
        walletsTotal: owner.data.walletBalances.reduce((sum, w) => sum + w.amount, 0),
        inventoryValue: owner.data.stockValue,
        receivableClient: owner.data.receivableClient,
        payableSupplier: owner.data.supplierPayable.reduce((sum, s) => sum + s.amount, 0),
      })
    : null;
  const { isProPlan } = useSubscriptionStore();

  // Same predicate the stock cards count with, so this number always equals
  // what المخازن shows when you click through.
  const needsRestock = useMemo(
    () =>
      products.filter(
        (p) =>
          matchesStockFilter(qtyOf(p.id), p, "low") || matchesStockFilter(qtyOf(p.id), p, "out"),
      ).length,
    [products, qtyOf],
  );

  // The two figure sources fail separately; either failure means no figure may
  // be painted. The owner's message wins the banner because a refusal explains
  // itself better than a transport error does.
  const error = owner.error ?? (windowFigures.error ? FIGURES_FAILED_MESSAGE : null);
  const detail = owner.error ? owner.detail : windowFigures.error;
  const loading = owner.loading || windowFigures.loading;

  // متوسط قيمة العملية — the one figure assembled on the client, from two
  // server numbers: the RPC's revenue over the event page's order count. A
  // ratio for reading, not a second opinion about the money.
  const avgOrderValue =
    owner.data && windowFigures.counts && windowFigures.counts.orders > 0
      ? owner.data.revenue / windowFigures.counts.orders
      : 0;

  const topProductId = windowFigures.counts?.topProductId ?? null;
  const topProductName = topProductId
    ? (allProducts.find((p) => p.id === topProductId)?.name ?? "—")
    : "—";

  // One button, every source. A retry while either figure read is running is a
  // no-op — the in-flight answer is the retry's answer — so a double click
  // issues one round of reads, not two.
  const retry = useCallback(() => {
    if (owner.loading || windowFigures.loading) return;
    setWindowStamp((s) => s + 1);
    owner.reload();
    windowFigures.reload();
    refreshStock();
  }, [
    owner.loading,
    owner.reload,
    windowFigures.loading,
    windowFigures.reload,
    refreshStock,
  ]);

  // When another device's ledger events arrive, re-resolve the window (its
  // `to` may have moved past the last retry) and re-read both sources. The
  // hooks no-op their own reads if one is already running.
  useEffect(() => {
    const onPulled = () => {
      setWindowStamp((s) => s + 1);
      owner.reload();
      windowFigures.reload();
    };
    window.addEventListener("ledger-sync-pulled", onPulled);
    return () => window.removeEventListener("ledger-sync-pulled", onPulled);
  }, [owner.reload, windowFigures.reload]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">نظرة عامة</h1>
          <p className="text-muted-foreground mt-1">
            كل رقم هنا محسوب من دفتر الحسابات — اضغط أي كارت يوديك لشاشته
          </p>
        </div>
        {/*
          `flex-wrap`, not a scrolling chip row.

          Measured at 390px: this row was 542px wide inside a 390px main, and
          because the app is RTL the overflow ran off the START edge — the
          month picker sat at right:-5, entirely off screen, reachable only by
          horizontally scrolling the whole dashboard. A filter you cannot see
          is a filter that does not exist.

          Wrapping rather than `overflow-x-auto` is deliberate: a scrolling row
          hides the same controls behind a gesture with no affordance, and the
          period buttons are short enough to reflow cleanly onto two lines.
        */}
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border p-1">
          {(Object.keys(PERIOD_LABELS) as Period[]).map((key) => (
            <Button
              key={key}
              size="sm"
              variant={period === key ? "secondary" : "ghost"}
              onClick={() => setPeriod(key)}
            >
              {PERIOD_LABELS[key as keyof typeof PERIOD_LABELS]}
            </Button>
          ))}
          <div className="relative flex items-center pr-2 pl-1 border-r border-border ml-1">
            <input 
              type="month"
              aria-label="اختيار شهر محدد"
              value={period.match(/^\d{4}-\d{2}$/) ? period : ""}
              onChange={(e) => {
                if (e.target.value) setPeriod(e.target.value);
              }}
              className="h-8 px-2 rounded bg-muted/40 text-sm hover:bg-muted focus:outline-none focus:ring-1 focus:ring-ring transition-colors cursor-pointer"
            />
          </div>
        </div>
      </div>

      {error && <LoadError message={error} detail={detail} onRetry={retry} busy={loading} />}
      {/* The stock read can fail on its own. The money cards are still true
          then, so they stay — only the restock count is withdrawn, and this
          is the button its «جرّب تاني» promises. */}
      {!error && restockStatus === "error" && (
        <LoadError
          message="تعذّرت قراءة المخزون، فعدد المنتجات المنخفضة مش معروض دلوقتي."
          detail={stockError ?? productsState.error}
          onRetry={() => {
            refreshStock();
            productsState.retry();
          }}
        />
      )}

      {/*
        Two columns from 360px, not from `sm` (640px) — every phone is below
        `sm`, so a store owner opening the dashboard got seven full-width cards
        and 2.66 screens of scrolling before reaching the chart. Measured in the
        live app at 390: two columns clips nothing (the card wraps, it does not
        truncate) and takes the page from 2048px to 1743px. 320 keeps one
        column, where 128px-wide cards would be mean.
      */}
      {!error && (
        <div className="grid grid-cols-1 min-[360px]:grid-cols-2 lg:grid-cols-3 gap-4">
          <Kpi
            label={periodLabel(period)}
            value={loading ? "…" : formatMoney(owner.data?.netProfit ?? 0)}
            hint="صافي الربح (مبيعات − تكلفة − مصاريف)"
            icon={TrendingUp}
            tone={(owner.data?.netProfit ?? 0) < 0 ? "bad" : "good"}
            onClick={() => navigate("/partners")}
          />
          <Kpi
            label={periodLabel(period)}
            value={loading ? "…" : formatQty(windowFigures.counts?.orders ?? 0)}
            hint="عدد العمليات (بيع + أونلاين)"
            icon={ShoppingCart}
            onClick={() => navigate("/orders")}
          />
          <Kpi
            label={periodLabel(period)}
            value={loading ? "…" : formatMoney(avgOrderValue)}
            hint="متوسط قيمة العملية"
            icon={Receipt}
            onClick={() => navigate("/orders")}
          />
          <Kpi
            label={periodLabel(period)}
            value={loading ? "…" : topProductName}
            hint="أكتر منتج خرج من المخزن"
            icon={Package}
            onClick={() => navigate("/products")}
          />
          <Kpi
            label={periodLabel(period)}
            value={loading ? "…" : formatQty(windowFigures.counts?.returns ?? 0)}
            hint="مرتجعات مؤكدة"
            icon={Undo2}
            tone={(windowFigures.counts?.returns ?? 0) > 0 ? "warn" : "default"}
            onClick={() => navigate("/returns")}
          />
          <Kpi
            label="دلوقتي"
            value={
              loading || netWorth === null
                ? "…"
                : netWorth >= 0
                  ? formatMoney(netWorth)
                  : `-${formatMoney(Math.abs(netWorth))}`
            }
            hint="صافي القيمة (أصول − ديون الموردين)"
            icon={Landmark}
            tone={netWorth !== null && netWorth < 0 ? "bad" : "good"}
            onClick={() => navigate("/partners")}
          />
          <Kpi
            label="دلوقتي"
            value={
              restockStatus === "error"
                ? "—"
                : restockStatus === "loading"
                  ? "…"
                  : formatQty(needsRestock)
            }
            hint={restockStatus === "error" ? "تعذّرت قراءة المخزون — جرّب تاني" : "منتجات منخفضة أو نافدة"}
            icon={AlertTriangle}
            tone={restockStatus === "error" || (restockStatus === "ready" && needsRestock > 0) ? "warn" : "default"}
            onClick={() => navigate("/inventory")}
          />
        </div>
      )}

      {/* Sales trend — one point per day, each its own ledger SUM */}
      {!error && (
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <p className="text-xs tracking-wider text-muted-foreground">المبيعات</p>
              <h3 className="font-display text-xl font-bold mt-1">
                {period === "thisYear"
                  ? `أشهر السنة حتى الآن (${windowFigures.trend.length})`
                  : `آخر ${windowFigures.trend.length} أيام`}
              </h3>
            </div>
            <span className="text-sm text-muted-foreground">
              إجمالي الفترة: {loading ? "…" : formatMoney(owner.data?.revenue ?? 0)}
            </span>
          </div>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={windowFigures.trend}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="date"
                  className="text-xs text-muted-foreground"
                  tick={{ fill: "currentColor" }}
                />
                <YAxis className="text-xs text-muted-foreground" tick={{ fill: "currentColor" }} />
                <Tooltip
                  formatter={(value) => [formatMoney(Number(value)), "مبيعات"]}
                  contentStyle={{
                    backgroundColor: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                  }}
                  itemStyle={{ color: "var(--foreground)" }}
                />
                <Line
                  type="monotone"
                  dataKey="revenue"
                  stroke="var(--primary)"
                  strokeWidth={2}
                  dot={{ fill: "var(--primary)", strokeWidth: 2 }}
                  activeDot={{ r: 6 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Subscription state is real (it is a setting, not a measurement). The
          panel that used to sit here listed three integrations as "متصل ومفعل"
          without asking anything — deleted rather than replaced: a connected
          store is §3.15's job to prove, not this screen's to claim. */}
      {!isProPlan && (
        <div className="rounded-2xl border border-purple-200 dark:border-purple-900 bg-purple-50 dark:bg-purple-950/20 p-6">
          <div className="flex flex-col md:flex-row items-start md:items-center gap-6">
            <div className="size-12 rounded-xl flex items-center justify-center bg-purple-100 dark:bg-purple-900/40 shrink-0">
              <Lock className="size-6 text-purple-600 dark:text-purple-300" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-purple-900 dark:text-purple-200 text-lg mb-2">
                فتح التكامل متعدد القنوات
              </h3>
              <p className="text-sm text-purple-700 dark:text-purple-300 mb-4">
                الترقية للخطة الاحترافية بتفتح الربط مع المتاجر الإلكترونية ومزامنة الطلبات
                والمخزون من مكان واحد.
              </p>
              <Button
                onClick={() => navigate("/settings")}
                className="bg-purple-600 hover:bg-purple-700"
              >
                <Crown className="size-4 ml-2" />
                ترقية إلى Pro
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
