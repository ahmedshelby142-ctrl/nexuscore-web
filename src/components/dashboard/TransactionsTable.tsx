import { ArrowDownLeft, ArrowUpRight } from "lucide-react";

type Tx = {
  id: string;
  desc: string;
  channel: "Retail POS" | "Online" | "Wholesale" | "Expense";
  date: string;
  amount: number;
  type: "in" | "out";
};

const txs: Tx[] = [
  { id: "INV-10428", desc: "Rosé Lip Tint Bundle ×24", channel: "Wholesale", date: "Jun 06", amount: 4820, type: "in" },
  { id: "POS-77321", desc: "Velvet Foundation N02", channel: "Retail POS", date: "Jun 06", amount: 128, type: "in" },
  { id: "EXP-0921", desc: "Packaging — Glass jars", channel: "Expense", date: "Jun 05", amount: 1240, type: "out" },
  { id: "ORD-55810", desc: "Aurora Skincare Set", channel: "Online", date: "Jun 05", amount: 312, type: "in" },
  { id: "EXP-0918", desc: "Influencer campaign", channel: "Expense", date: "Jun 04", amount: 3500, type: "out" },
  { id: "INV-10422", desc: "Silk Mascara ×60", channel: "Wholesale", date: "Jun 04", amount: 6720, type: "in" },
  { id: "POS-77298", desc: "Blush Petal Compact", channel: "Retail POS", date: "Jun 03", amount: 86, type: "in" },
];

const channelTint: Record<Tx["channel"], string> = {
  "Retail POS": "var(--chart-1)",
  Online: "var(--chart-2)",
  Wholesale: "var(--chart-3)",
  Expense: "var(--destructive)",
};

export function TransactionsTable() {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 h-full">
      <div className="flex items-center justify-between mb-5">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Activity</p>
          <h3 className="font-display text-2xl font-semibold mt-1">Recent Transactions</h3>
        </div>
        <button className="text-xs font-medium text-primary hover:underline">View all →</button>
      </div>

      <div className="overflow-x-auto -mx-2">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
              <th className="font-medium py-2 px-2">Reference</th>
              <th className="font-medium py-2 px-2">Description</th>
              <th className="font-medium py-2 px-2">Channel</th>
              <th className="font-medium py-2 px-2">Date</th>
              <th className="font-medium py-2 px-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {txs.map((t) => (
              <tr key={t.id} className="border-b border-border/60 last:border-0 hover:bg-muted/50 transition-colors">
                <td className="py-3 px-2 font-mono text-xs text-muted-foreground">{t.id}</td>
                <td className="py-3 px-2 font-medium">{t.desc}</td>
                <td className="py-3 px-2">
                  <span
                    className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium"
                    style={{
                      color: channelTint[t.channel],
                      backgroundColor: `color-mix(in oklab, ${channelTint[t.channel]} 14%, transparent)`,
                    }}
                  >
                    {t.channel}
                  </span>
                </td>
                <td className="py-3 px-2 text-muted-foreground">{t.date}</td>
                <td className="py-3 px-2 text-right">
                  <span
                    className="inline-flex items-center gap-1 font-semibold"
                    style={{ color: t.type === "in" ? "var(--success)" : "var(--destructive)" }}
                  >
                    {t.type === "in" ? <ArrowUpRight className="size-3" /> : <ArrowDownLeft className="size-3" />}
                    {t.type === "in" ? "+" : "-"}${t.amount.toLocaleString()}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}