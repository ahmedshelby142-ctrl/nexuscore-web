/**
 * التقارير المالية (§3.12) — the aggregate view.
 *
 * Every number on this screen is `SUM()` over `ledger_lines` inside the
 * selected window. There is no stored aggregate anywhere in this file: change
 * the period and the same queries run again against a different window.
 *
 * The arithmetic — and the reason returns and shipping are shown but never
 * subtracted twice — lives in `@/lib/ledger/reports`, so it is testable
 * without a database (`scripts/check_financial_report.mjs`).
 */

import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  CalendarRange,
  FileDown,
  PiggyBank,
  RotateCcw,
  ShoppingCart,
  TrendingDown,
  TrendingUp,
  Truck,
  Wallet,
} from "lucide-react";

import { balances } from "@/lib/ledger";
import {
  GRANULARITY_LABELS,
  PERIOD_LABELS,
  buckets,
  channelLabel,
  customWindow,
  defaultGranularity,
  fetchPnl,
  periodWindow,
} from "@/lib/ledger/reports";
import type { Bucket, Granularity, PeriodPreset, Pnl, ReportWindow } from "@/lib/ledger/reports";
import {readFixedAssetAccounting} from "@/lib/fixedAssetAccounting";
import { formatMoney } from "@/lib/math";
import { printTableAsPdf } from "@/lib/pdfGenerator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PRESETS: Exclude<PeriodPreset, "custom">[] = ["day", "week", "month", "quarter", "year"];
const GRANULARITIES: Granularity[] = ["day", "month", "quarter", "year"];

const signed = (v: number) => (v < 0 ? `-${formatMoney(Math.abs(v))}` : formatMoney(v));

export function FinancialReportsPage() {
  const [preset, setPreset] = useState<PeriodPreset>("month");
  const [fromISO, setFromISO] = useState(() => format(new Date(), "yyyy-MM-01"));
  const [toISO, setToISO] = useState(() => format(new Date(), "yyyy-MM-dd"));

  // The window is DERIVED on every render from the preset and today's date —
  // never stored — so a screen left open past midnight reports the period it
  // is actually in. Same rule as the owner budget (7.3).
  const window: ReportWindow | null = useMemo(
    () => (preset === "custom" ? customWindow(fromISO, toISO) : periodWindow(preset)),
    [preset, fromISO, toISO],
  );

  const [granularity, setGranularity] = useState<Granularity | null>(null);
  const effectiveGranularity = granularity ?? (window ? defaultGranularity(window) : "month");

  const rows: Bucket[] = useMemo(
    () => (window ? buckets(window, effectiveGranularity) : []),
    [window, effectiveGranularity],
  );

  const [total, setTotal] = useState<Pnl | null>(null);
  const [rowPnl, setRowPnl] = useState<Pnl[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick,setRefreshTick]=useState(0);
  useEffect(()=>{const refresh=()=>setRefreshTick(t=>t+1);globalThis.window.addEventListener("ledger-sync-pulled",refresh);return()=>globalThis.window.removeEventListener("ledger-sync-pulled",refresh);},[]);

  // ponytail: one `fetchPnl` for the headline plus one per table row, fired
  // in parallel and capped at 60 rows by `buckets` — so at worst 305 indexed
  // SUMs in Postgres. If this ever drags, the fix is a GROUP
  // BY in the driver, not a cached total.
  useEffect(() => {
    if (!window) {
      setError("النطاق غير صحيح — تاريخ البداية لازم يكون قبل تاريخ النهاية.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const [headline, perRow] = await Promise.all([
          fetchPnl(balances, window,readFixedAssetAccounting),
          Promise.all(rows.map((b) => fetchPnl(balances, { from: b.from, to: b.to },readFixedAssetAccounting))),
        ]);
        if (cancelled) return;
        setTotal(headline);
        setRowPnl(perRow);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // A failed read must never render as zeros — that reads as "no
        // business this month" and is a worse lie than an error message.
        setTotal(null);
        setRowPnl([]);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [window, rows,refreshTick]);

  // Non-cash, and deliberately NOT inside SUM(expense). See the memo line
  // below the P&L for the whole reasoning.

  const periodLabel = window
    ? `${format(window.from, "dd/MM/yyyy")} — ${format(new Date(window.to.getTime() - 1), "dd/MM/yyyy")}`
    : "—";

  const handleExportPdf = () => {
    if (!total || !window) return;
    printTableAsPdf({
      title: "التقرير المالي — أرباح وخسائر",
      subtitle: periodLabel,
      columns: [
        { label: "الفترة", accessor: (r: PdfRow) => r.label },
        { label: "المبيعات (صافي)", accessor: (r) => formatMoney(r.netSales) },
        { label: "تكلفة البضاعة", accessor: (r) => formatMoney(r.cogs) },
        { label: "المصروفات والرواتب", accessor: (r) => formatMoney(r.opex) },
        { label: "عمولات ومصاريف الشحن", accessor: (r) => formatMoney(r.shipping) },
        { label: "المرتجعات", accessor: (r) => formatMoney(r.returns) },
        { label: "الربح قبل الإهلاك", accessor: (r) => signed(r.profitBeforeDepreciation??r.netProfit) },
        { label: "إهلاك الفترة", accessor: (r) => formatMoney(r.depreciation??0) },
        { label: "صافي الربح بعد الإهلاك", accessor: (r) => signed(r.netProfit) },
      ],
      rows: [
        ...rows.map((b, i) => ({ label: b.label, ...(rowPnl[i] ?? emptyPnl) })),
        { label: "الإجمالي", ...total },
      ],
      footer:
        `صافي الربح بعد الإهلاك للفترة: ${signed(total.netProfit)}` +
        ` — المشتريات: ${formatMoney(total.purchases)} (تحوّل نقدية لمخزون، مش مصروف)` +
        ((total.depreciation??0) > 0
          ? ` — إهلاك الفترة غير النقدي: ${formatMoney(total.depreciation??0)}`
          : ""),
    });
  };

  return (
    <div className="space-y-6">
      {/* ── Period filter ── */}
      <div className="rounded-2xl border border-border/60 bg-card/80 p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <CalendarRange className="size-5 text-muted-foreground" />
          <span className="font-semibold ml-2">الفترة</span>
          {PRESETS.map((p) => (
            <Button
              key={p}
              size="sm"
              variant={preset === p ? "default" : "outline"}
              onClick={() => {
                setPreset(p);
                setGranularity(null);
              }}
            >
              {PERIOD_LABELS[p]}
            </Button>
          ))}
          <Button
            size="sm"
            variant={preset === "custom" ? "default" : "outline"}
            onClick={() => {
              setPreset("custom");
              setGranularity(null);
            }}
          >
            {PERIOD_LABELS.custom}
          </Button>

          <div className="flex-1" />

          <Button size="sm" variant="outline" onClick={handleExportPdf} disabled={!total||loading||!!error}>
            <FileDown className="size-4 ml-2" />
            تصدير PDF
          </Button>
        </div>

        {preset === "custom" && (
          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <Label htmlFor="report-from">من</Label>
              <Input
                id="report-from"
                type="date"
                value={fromISO}
                onChange={(e) => setFromISO(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="report-to">إلى</Label>
              <Input
                id="report-to"
                type="date"
                value={toISO}
                onChange={(e) => setToISO(e.target.value)}
              />
            </div>
          </div>
        )}

        <p className="text-sm text-muted-foreground">
          كل الأرقام تحت محسوبة من دفتر الحركات للفترة: <strong>{periodLabel}</strong>
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 dark:bg-red-950/20 p-4 text-sm text-red-800 dark:text-red-300">
          تعذّر حساب التقرير: {error}
        </div>
      )}

      {loading && !total && (
        <div className="rounded-xl border border-border/60 p-6 text-center text-muted-foreground">
          بنحسب من دفتر الحركات…
        </div>
      )}

      {total && (
        <>
          {/* ── Headline numbers ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <Kpi
              icon={TrendingUp}
              tone="green"
              label="إجمالي المبيعات"
              sublabel="نقطة البيع + أونلاين + جملة، بعد خصم المرتجعات"
              value={signed(total.netSales)}
            />
            <Kpi
              icon={ShoppingCart}
              tone="slate"
              label="إجمالي المشتريات"
              sublabel="بضاعة دخلت المخزن — مش مصروف، دي نقدية بقت مخزون"
              value={formatMoney(total.purchases)}
            />
            <Kpi
              icon={RotateCcw}
              tone="amber"
              label="إجمالي المرتجعات"
              sublabel="مطروحة من المبيعات فوق — متتطرحش تاني"
              value={formatMoney(total.returns)}
            />
            <Kpi
              icon={TrendingDown}
              tone="orange"
              label="المصروفات والرواتب"
              sublabel="إيجار + رواتب + تسويق + فواتير + فروقات الجرد"
              value={signed(total.opex)}
            />
            <Kpi
              icon={Truck}
              tone="blue"
              label="عمولات ومصاريف الشحن"
              sublabel="مصاريف مرتجعات الشحن + شحن الجملة"
              value={signed(total.shipping)}
            />
            <Kpi
              icon={PiggyBank}
              tone={total.netProfit >= 0 ? "green" : "red"}
              label="صافي الربح بعد الإهلاك"
              sublabel="الربح قبل الإهلاك − إهلاك نفس الفترة"
              value={signed(total.netProfit)}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Kpi icon={PiggyBank} tone="green" label="الربح قبل الإهلاك" sublabel="المبيعات − تكلفة البضاعة − مصروفات التشغيل" value={signed(total.profitBeforeDepreciation??total.netProfit)}/>
            <Kpi icon={TrendingDown} tone="slate" label="إهلاك الفترة" sublabel="غير نقدي؛ يُستبعد الإهلاك السابق لبدء المحاسبة" value={formatMoney(total.depreciation??0)}/>
          </div>

          {/* ── Sales by channel ── */}
          {total.salesByChannel.length > 0 && (
            <div className="rounded-2xl border border-border/60 bg-card/80 p-4">
              <h3 className="font-display font-bold mb-3 flex items-center gap-2">
                <Wallet className="size-4 text-muted-foreground" />
                المبيعات حسب القناة
              </h3>
              <div className="flex flex-wrap gap-3">
                {total.salesByChannel.map((c) => (
                  <div key={c.subjectId} className="rounded-xl border border-border/60 px-4 py-2">
                    <p className="text-xs text-muted-foreground">{channelLabel(c.subjectId)}</p>
                    <p className="font-bold">{signed(c.amount)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── P&L ── */}
          <div className="rounded-2xl border border-border/60 bg-card/80 p-4 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h3 className="font-display text-xl font-bold">أرباح وخسائر</h3>
              <div className="flex items-center gap-2">
                <Label htmlFor="report-granularity" className="text-sm text-muted-foreground">
                  التجميع
                </Label>
                <Select
                  value={effectiveGranularity}
                  onValueChange={(v) => setGranularity(v as Granularity)}
                >
                  <SelectTrigger id="report-granularity" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GRANULARITIES.map((g) => (
                      <SelectItem key={g} value={g}>
                        {GRANULARITY_LABELS[g]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <PnlTable rows={rows} rowPnl={rowPnl} total={total} />

            {/* The two things 7.1 flagged, answered where the P&L defines its
                terms. Both are display decisions with a reason, not TODOs. */}
            <div className="rounded-xl border border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-900 p-4 space-y-2">
              <p className="text-sm font-semibold text-blue-900 dark:text-blue-200">
                إهلاك الأصول الثابتة للفترة — {formatMoney(total.depreciation??0)}
              </p>
              <p className="text-sm text-blue-900 dark:text-blue-300">
                الإهلاك تكلفة <strong>غير نقدية</strong>، يُخصم مرة واحدة من ربح نفس الفترة.
                لا تُخصم شراءات الأصول بالكامل من التشغيل، ولا يدخل الإهلاك السابق لبدء المحاسبة في ربح الفترة الجديدة.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── P&L table ───────────────────────────────────────────────────────────────

const emptyPnl: Pnl = {
  salesByChannel: [],
  netSales: 0,
  cogs: 0,
  grossProfit: 0,
  shipping: 0,
  opex: 0,
  expenses: 0,
  returns: 0,
  purchases: 0,
  netProfit: 0,
};

interface PdfRow extends Pnl {
  label: string;
}

function PnlTable({ rows, rowPnl, total }: { rows: Bucket[]; rowPnl: Pnl[]; total: Pnl }) {
  // The bar is scaled against the biggest absolute profit in the table, so a
  // loss month reads as a red bar of the same length a profit month would.
  const peak = Math.max(1, ...rowPnl.map((p) => Math.abs(p.netProfit)));

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-right">الفترة</TableHead>
            <TableHead className="text-center">المبيعات (صافي)</TableHead>
            <TableHead className="text-center">تكلفة البضاعة</TableHead>
            <TableHead className="text-center">المصروفات والرواتب</TableHead>
            <TableHead className="text-center">الشحن</TableHead>
            <TableHead className="text-center">المرتجعات</TableHead>
            <TableHead className="text-center">الربح قبل الإهلاك</TableHead>
            <TableHead className="text-center">إهلاك الفترة</TableHead>
            <TableHead className="text-center">صافي الربح بعد الإهلاك</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="text-center text-muted-foreground py-6">
                لا توجد فترات في هذا النطاق
              </TableCell>
            </TableRow>
          )}
          {rows.map((b, i) => {
            const p = rowPnl[i] ?? emptyPnl;
            return (
              <TableRow key={b.label}>
                <TableCell className="font-medium">{b.label}</TableCell>
                <TableCell className="text-center">{signed(p.netSales)}</TableCell>
                <TableCell className="text-center">{signed(p.cogs)}</TableCell>
                <TableCell className="text-center">{signed(p.opex)}</TableCell>
                <TableCell className="text-center">{signed(p.shipping)}</TableCell>
                <TableCell className="text-center">{formatMoney(p.returns)}</TableCell>
                <TableCell className="text-center">{signed(p.profitBeforeDepreciation??p.netProfit)}</TableCell>
                <TableCell className="text-center">{formatMoney(p.depreciation??0)}</TableCell>
                <TableCell className="text-center">
                  <span className={p.netProfit >= 0 ? "text-green-600" : "text-red-600"}>
                    {signed(p.netProfit)}
                  </span>
                  <span className="block h-1 mt-1 rounded-full bg-muted overflow-hidden">
                    <span
                      className={`block h-full ${p.netProfit >= 0 ? "bg-green-500" : "bg-red-500"}`}
                      style={{ width: `${(Math.abs(p.netProfit) / peak) * 100}%` }}
                    />
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
          <TableRow className="font-bold bg-muted/40">
            <TableCell>الإجمالي</TableCell>
            <TableCell className="text-center">{signed(total.netSales)}</TableCell>
            <TableCell className="text-center">{signed(total.cogs)}</TableCell>
            <TableCell className="text-center">{signed(total.opex)}</TableCell>
            <TableCell className="text-center">{signed(total.shipping)}</TableCell>
            <TableCell className="text-center">{formatMoney(total.returns)}</TableCell>
            <TableCell className="text-center">{signed(total.profitBeforeDepreciation??total.netProfit)}</TableCell>
            <TableCell className="text-center">{formatMoney(total.depreciation??0)}</TableCell>
            <TableCell
              className={`text-center ${total.netProfit >= 0 ? "text-green-600" : "text-red-600"}`}
            >
              {signed(total.netProfit)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

// ── One headline card ───────────────────────────────────────────────────────

const TONES: Record<string, { bg: string; icon: string; value: string }> = {
  green: { bg: "bg-green-100", icon: "text-green-600", value: "text-green-600" },
  red: { bg: "bg-red-100", icon: "text-red-600", value: "text-red-600" },
  amber: { bg: "bg-amber-100", icon: "text-amber-600", value: "text-amber-600" },
  orange: { bg: "bg-orange-100", icon: "text-orange-600", value: "text-orange-600" },
  blue: { bg: "bg-blue-100", icon: "text-blue-600", value: "text-blue-600" },
  slate: { bg: "bg-slate-100", icon: "text-slate-600", value: "text-slate-700" },
};

function Kpi({
  icon: Icon,
  tone,
  label,
  sublabel,
  value,
}: {
  icon: React.ElementType;
  tone: keyof typeof TONES;
  label: string;
  sublabel: string;
  value: string;
}) {
  const t = TONES[tone];
  return (
    <div className="rounded-2xl border border-border/60 bg-card/80 backdrop-blur-sm p-6 shadow-sm">
      <div className={`size-10 rounded-xl flex items-center justify-center mb-3 ${t.bg}`}>
        <Icon className={`size-5 ${t.icon}`} />
      </div>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={`font-display text-2xl font-bold mt-1 ${t.value}`}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{sublabel}</p>
    </div>
  );
}
