/**
 * نظرة عامة — the summary screen, entirely derived.
 *
 * Every figure here is a `SUM()` over the ledger for the selected window. The
 * screen this replaced read `useBusinessStore().transactions` (a store the
 * ledger conversion left behind), `orders.length`, a hardcoded "+12.5%" growth
 * badge and a list of three integrations described as "متصل ومفعل" that nobody
 * had connected. None of it was real, and none of it moved when the shop
 * traded.
 *
 * It is a SUMMARY, not a report: six cards, one trend, one period filter. The
 * full aggregates with P&L per month/quarter/year live in الشركاء والمالية
 * (brief §3.12) and must not be duplicated here.
 *
 * ponytail: the trend asks the ledger once per day in the window (7 or 30
 * cheap local aggregates, in parallel). If that ever shows up in a profile,
 * the upgrade is one `GROUP BY date(occurred_at)` in the driver — no caller
 * changes.
 */

import { useEffect, useMemo, useState } from "react";
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
  TREND_DAYS,
  summarise,
  netWorthOf,
  sumOf,
  trendDays,
  windowFor,
  periodLabel,
  type Period,
} from "@/lib/dashboard";
import { useStock } from "@/lib/ledger/useStock";
import { useBalances } from "@/lib/ledger/useBalances";
import { matchesStockFilter } from "@/components/inventory/StockSummaryCards";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useSubscriptionStore } from "@/store/useSubscriptionStore";
import { activeProducts } from "@/lib/product";
import { formatMoney, formatQty } from "@/lib/math";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Figures extends ReturnType<typeof summarise> {
  trend: { date: string; revenue: number }[];
}

/**
 * Every number on this screen, for one window, from the ledger.
 *
 * `revenue` already carries returns as negatives (a `return_confirmed` writes
 * `revenue −`), so net profit needs no separate correction for them.
 */
function useFigures(period: Period) {
  const [figures, setFigures] = useState<Figures | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const { from, to } = windowFor(period);
        const days = trendDays(period);

        const [revenueRows, cogsRows, expenseRows, windowEvents, ...dailyRevenue] =
          await Promise.all([
            balances({ account: "revenue", from, to }),
            balances({ account: "cogs", from, to }),
            balances({ account: "expense", from, to }),
            events({ from, to, limit: 2000 }),
            // One aggregate per day of the trend. Same query the cards use,
            // just narrower — the line and the cards cannot disagree.
            ...days.map((d) => balances({ account: "revenue", from: d.from, to: d.to })),
          ]);
        if (cancelled) return;

        setFigures({
          ...summarise({ revenueRows, cogsRows, expenseRows, events: windowEvents }),
          trend: dailyRevenue.map((rows, i) => ({
            date: period === "thisYear"
              ? days[i].from.toLocaleDateString("ar-EG", { month: "long" })
              : days[i].from.toLocaleDateString("ar-EG", { day: "numeric", month: "numeric" }),
            revenue: sumOf(rows),
          })),
        });
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // A failed read must never render as zeros — a dashboard of zeros
        // reads as "a quiet day", not as "we could not ask".
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [period]);

  return { figures, error, loading };
}

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
  const { figures, error, loading } = useFigures(period);

  const allProducts = useBusinessStore((s) => s.products);
  const products = useMemo(() => activeProducts(allProducts), [allProducts]);
  const { qtyOf } = useStock();

  /**
   * صافي القيمة is a point-in-time BALANCE, not a period figure, so it does not
   * come through `useFigures` (which windows everything by date). Four account
   * sums, read as they stand right now — hence the "دلوقتي" label, the same one
   * the restock card carries.
   */
  const { total: walletsTotal } = useBalances("wallet");
  const { total: inventoryValue } = useBalances("stock");
  const { total: receivableClient } = useBalances("receivable_client");
  const { total: payableSupplier } = useBalances("payable_supplier");
  const netWorth = netWorthOf({
    walletsTotal,
    inventoryValue,
    receivableClient,
    payableSupplier,
  });
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

  const topProductName = figures?.topProductId
    ? (allProducts.find((p) => p.id === figures.topProductId)?.name ?? "—")
    : "—";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">نظرة عامة</h1>
          <p className="text-muted-foreground mt-1">
            كل رقم هنا محسوب من دفتر الحسابات — اضغط أي كارت يوديك لشاشته
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border p-1">
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
              value={period.match(/^\d{4}-\d{2}$/) ? period : ""}
              onChange={(e) => {
                if (e.target.value) setPeriod(e.target.value);
              }}
              className="h-8 px-2 rounded bg-muted/40 text-sm hover:bg-muted focus:outline-none focus:ring-1 focus:ring-ring transition-colors cursor-pointer"
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm text-destructive">
            مقدرناش نقرأ الأرقام من الدفتر، فمفيش أرقام معروضة دلوقتي. جرّب تاني. ({error})
          </p>
        </div>
      )}

      {!error && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <Kpi
            label={periodLabel(period)}
            value={loading ? "…" : formatMoney(figures?.netProfit ?? 0)}
            hint="صافي الربح (مبيعات − تكلفة − مصاريف)"
            icon={TrendingUp}
            tone={(figures?.netProfit ?? 0) < 0 ? "bad" : "good"}
            onClick={() => navigate("/partners")}
          />
          <Kpi
            label={periodLabel(period)}
            value={loading ? "…" : formatQty(figures?.orders ?? 0)}
            hint="عدد العمليات (بيع + أونلاين)"
            icon={ShoppingCart}
            onClick={() => navigate("/orders")}
          />
          <Kpi
            label={periodLabel(period)}
            value={loading ? "…" : formatMoney(figures?.avgOrderValue ?? 0)}
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
            value={loading ? "…" : formatQty(figures?.returns ?? 0)}
            hint="مرتجعات مؤكدة"
            icon={Undo2}
            tone={(figures?.returns ?? 0) > 0 ? "warn" : "default"}
            onClick={() => navigate("/returns")}
          />
          <Kpi
            label="دلوقتي"
            value={
              netWorth >= 0 ? formatMoney(netWorth) : `-${formatMoney(Math.abs(netWorth))}`
            }
            hint="صافي القيمة (أصول − ديون الموردين)"
            icon={Landmark}
            tone={netWorth < 0 ? "bad" : "good"}
            onClick={() => navigate("/partners")}
          />
          <Kpi
            label="دلوقتي"
            value={formatQty(needsRestock)}
            hint="منتجات منخفضة أو نافدة"
            icon={AlertTriangle}
            tone={needsRestock > 0 ? "warn" : "default"}
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
                  ? `أشهر السنة حتى الآن (${figures?.trend?.length ?? 0})`
                  : `آخر ${figures?.trend?.length ?? 0} أيام`}
              </h3>
            </div>
            <span className="text-sm text-muted-foreground">
              إجمالي الفترة: {formatMoney(figures?.revenue ?? 0)}
            </span>
          </div>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={figures?.trend ?? []}>
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
