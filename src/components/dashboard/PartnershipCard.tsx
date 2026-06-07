import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

const NET_PROFIT = 154720;
const partners = [
  { name: "Aurelia Marchetti", role: "Founder", equity: 60, color: "var(--chart-1)" },
  { name: "Lior Bensimon", role: "Co-Founder", equity: 30, color: "var(--chart-2)" },
  { name: "Investor Pool", role: "Series Seed", equity: 10, color: "var(--chart-4)" },
];

export function PartnershipCard() {
  const data = partners.map((p) => ({ name: p.name, value: p.equity, color: p.color }));
  return (
    <div className="rounded-2xl border border-border bg-card p-6 h-full">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Equity & profit split</p>
          <h3 className="font-display text-2xl font-semibold mt-1">Partnership Distribution</h3>
        </div>
      </div>

      <div className="flex items-center gap-6 mt-5">
        <div className="relative size-32 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} dataKey="value" innerRadius={42} outerRadius={60} paddingAngle={3} stroke="none">
                {data.map((d, i) => (
                  <Cell key={i} fill={d.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Profit</p>
            <p className="font-display text-lg font-semibold">${(NET_PROFIT / 1000).toFixed(1)}k</p>
          </div>
        </div>
        <div className="flex-1 space-y-3">
          {partners.map((p) => (
            <div key={p.name} className="group">
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className="size-2.5 rounded-full" style={{ background: p.color }} />
                  <span className="font-medium">{p.name}</span>
                </div>
                <span className="font-semibold">{p.equity}%</span>
              </div>
              <div className="flex items-center justify-between mt-0.5 pl-4.5 text-xs text-muted-foreground">
                <span>{p.role}</span>
                <span className="text-foreground/70">${((NET_PROFIT * p.equity) / 100).toLocaleString()}</span>
              </div>
              <div className="mt-1.5 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500 group-hover:opacity-90"
                  style={{ width: `${p.equity}%`, background: p.color }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}