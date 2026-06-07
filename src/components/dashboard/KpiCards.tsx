import { ArrowDownRight, ArrowUpRight, DollarSign, Receipt, TrendingUp, ShoppingBag } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";

type Kpi = {
  label: string;
  value: string;
  delta: number;
  icon: typeof DollarSign;
  tint: string;
  data: { v: number }[];
};

const spark = (seed: number[]) => seed.map((v) => ({ v }));

const kpis: Kpi[] = [
  {
    label: "Total Revenue",
    value: "$248,930",
    delta: 12.4,
    icon: DollarSign,
    tint: "var(--chart-1)",
    data: spark([12, 18, 14, 22, 19, 28, 26, 34, 31, 38, 42, 48]),
  },
  {
    label: "Total Expenses",
    value: "$94,210",
    delta: -4.8,
    icon: Receipt,
    tint: "var(--chart-3)",
    data: spark([22, 24, 21, 26, 23, 25, 21, 23, 20, 22, 19, 18]),
  },
  {
    label: "Net Profit",
    value: "$154,720",
    delta: 18.2,
    icon: TrendingUp,
    tint: "var(--chart-5)",
    data: spark([8, 10, 12, 15, 14, 18, 22, 24, 28, 30, 34, 39]),
  },
  {
    label: "Online + Retail Orders",
    value: "3,482",
    delta: 9.1,
    icon: ShoppingBag,
    tint: "var(--chart-2)",
    data: spark([20, 22, 28, 25, 30, 28, 33, 36, 34, 40, 38, 44]),
  },
];

export function KpiCards() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
      {kpis.map((k) => {
        const up = k.delta >= 0;
        return (
          <div
            key={k.label}
            className="group relative overflow-hidden rounded-2xl border border-border bg-card p-5 transition-all duration-300 hover:-translate-y-1 hover:shadow-[var(--shadow-soft)]"
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">{k.label}</p>
                <p className="font-display text-3xl font-semibold mt-2 tracking-tight">{k.value}</p>
              </div>
              <div
                className="size-10 rounded-xl flex items-center justify-center"
                style={{ backgroundColor: `color-mix(in oklab, ${k.tint} 15%, transparent)`, color: k.tint }}
              >
                <k.icon className="size-5" />
              </div>
            </div>

            <div className="mt-4 flex items-end justify-between gap-3">
              <div
                className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full`}
                style={{
                  color: up ? "var(--success)" : "var(--destructive)",
                  backgroundColor: up
                    ? "color-mix(in oklab, var(--success) 12%, transparent)"
                    : "color-mix(in oklab, var(--destructive) 12%, transparent)",
                }}
              >
                {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
                {Math.abs(k.delta)}%
              </div>
              <div className="h-12 flex-1 max-w-[120px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={k.data}>
                    <defs>
                      <linearGradient id={`g-${k.label}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={k.tint} stopOpacity={0.4} />
                        <stop offset="100%" stopColor={k.tint} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <Area type="monotone" dataKey="v" stroke={k.tint} strokeWidth={2} fill={`url(#g-${k.label})`} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}