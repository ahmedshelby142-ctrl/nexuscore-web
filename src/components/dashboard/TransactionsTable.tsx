import { ArrowDownLeft, ArrowUpRight } from "lucide-react";

type Tx = {
  id: string;
  desc: string;
  channel: "نقاط البيع" | "متجر إلكتروني" | "جملة" | "مصروفات";
  date: string;
  amount: number;
  type: "in" | "out";
};

const txs: Tx[] = [
  { id: "INV-10428", desc: "أحمر شفاه روزيه × ٢٤ علبة", channel: "جملة", date: "٦ يونيو", amount: 4820, type: "in" },
  { id: "POS-77321", desc: "كريم أساس فيلفت درجة ٠٢", channel: "نقاط البيع", date: "٦ يونيو", amount: 380, type: "in" },
  { id: "EXP-0921", desc: "تغليف — برطمانات زجاجية", channel: "مصروفات", date: "٥ يونيو", amount: 1240, type: "out" },
  { id: "ORD-55810", desc: "طقم العناية بالبشرة أورورا", channel: "متجر إلكتروني", date: "٥ يونيو", amount: 920, type: "in" },
  { id: "EXP-0918", desc: "حملة تسويق مع مؤثرين", channel: "مصروفات", date: "٤ يونيو", amount: 3500, type: "out" },
  { id: "INV-10422", desc: "ماسكارا سيلك × ٦٠ قطعة", channel: "جملة", date: "٤ يونيو", amount: 6720, type: "in" },
  { id: "POS-77298", desc: "بلاشر بتلات الورد", channel: "نقاط البيع", date: "٣ يونيو", amount: 245, type: "in" },
];

const channelTint: Record<Tx["channel"], string> = {
  "نقاط البيع": "var(--chart-1)",
  "متجر إلكتروني": "var(--chart-2)",
  "جملة": "var(--chart-3)",
  "مصروفات": "var(--destructive)",
};

export function TransactionsTable() {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 h-full">
      <div className="flex items-center justify-between mb-5">
        <div>
          <p className="text-xs tracking-wider text-muted-foreground">النشاط</p>
          <h3 className="font-display text-2xl font-bold mt-1">أحدث العمليات</h3>
        </div>
        <button className="text-xs font-medium text-primary hover:underline">عرض الكل ←</button>
      </div>

      <div className="overflow-x-auto -mx-2">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-xs tracking-wider text-muted-foreground border-b border-border">
              <th className="font-medium py-2 px-2">المرجع</th>
              <th className="font-medium py-2 px-2">البيان</th>
              <th className="font-medium py-2 px-2">القناة</th>
              <th className="font-medium py-2 px-2">التاريخ</th>
              <th className="font-medium py-2 px-2 text-left">المبلغ</th>
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
                <td className="py-3 px-2 text-left">
                  <span
                    className="inline-flex items-center gap-1 font-semibold"
                    style={{ color: t.type === "in" ? "var(--success)" : "var(--destructive)" }}
                  >
                    {t.type === "in" ? <ArrowUpRight className="size-3" /> : <ArrowDownLeft className="size-3" />}
                    {t.type === "in" ? "+" : "−"}{t.amount.toLocaleString()} ج.م
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