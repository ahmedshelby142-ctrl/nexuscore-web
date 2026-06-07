import { Bar, BarChart, CartesianGrid, Legend, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const data = [
  { month: "Jan", profit: 28400, expenses: 18200 },
  { month: "Feb", profit: 31200, expenses: 17800 },
  { month: "Mar", profit: 26800, expenses: 19500 },
  { month: "Apr", profit: 36100, expenses: 16400 },
  { month: "May", profit: 42300, expenses: 17900 },
  { month: "Jun", profit: 48750, expenses: 15600 },
];

export function ProfitChart() {
  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Financial performance</p>
          <h3 className="font-display text-2xl font-semibold mt-1">Profit & Loss · Last 6 months</h3>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2">
            <span className="size-2.5 rounded-full" style={{ background: "var(--chart-1)" }} />
            Net Profit
          </div>
          <div className="flex items-center gap-2">
            <span className="size-2.5 rounded-full" style={{ background: "var(--chart-3)" }} />
            Expenses
          </div>
        </div>
      </div>

      <div className="h-[320px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 10, right: 10, bottom: 0, left: -10 }}>
            <defs>
              <linearGradient id="barProfit" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.95} />
                <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0.6} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="month" stroke="var(--muted-foreground)" fontSize={12} tickLine={false} axisLine={false} />
            <YAxis stroke="var(--muted-foreground)" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v / 1000}k`} />
            <Tooltip
              cursor={{ fill: "color-mix(in oklab, var(--primary) 6%, transparent)" }}
              contentStyle={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                fontSize: 12,
                boxShadow: "var(--shadow-soft)",
              }}
              formatter={(v: number) => `$${v.toLocaleString()}`}
            />
            <Bar dataKey="profit" fill="url(#barProfit)" radius={[8, 8, 0, 0]} barSize={28} />
            <Line type="monotone" dataKey="expenses" stroke="var(--chart-3)" strokeWidth={2.5} dot={{ r: 4, fill: "var(--chart-3)" }} activeDot={{ r: 6 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}