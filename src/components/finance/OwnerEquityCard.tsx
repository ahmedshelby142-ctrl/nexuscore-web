import { appendFinancialEvent } from "@/lib/financialCommand";
import { useMemo, useState } from "react";
import { Landmark, Plus, HandCoins } from "lucide-react";
import type { EquityView } from "@/lib/ledger/useEquityStatement";
import { buildOwnerCapitalLines, buildOwnerContributionLines } from "@/lib/ledger/equity";
import { OWNER_SUBJECT } from "@/lib/ledger/ownerDraw";
import { activePartners } from "@/lib/partners";
import { toAppRole } from "@/lib/roles";
import { formatMoney } from "@/lib/math";
import { useSubmitGate } from "@/hooks/useSubmitGate";
import { useAuthStore } from "@/store/useAuthStore";
import { useBusinessStore } from "@/store/useBusinessStore";
import { LoadError } from "@/components/ui/load-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { WALLET_LABELS, PARTNER_KIND_LABELS, type WalletType } from "@/types";

/**
 * حقوق الملكية — capital, contributions, accumulated result, drawings and the
 * owner's current equity, from `useEquityStatement` (src/lib/ledger/equity.ts).
 *
 * It belongs to the business, not to a partner row: a sole owner with no
 * partners sees all of it. Capital with no entry reads «غير مسجل», never 0.
 * Recording capital or a contribution is ADMIN-only (the database refuses
 * anyone else — 049); drawings are recorded from «ميزانية صاحبة الشغل».
 */

const SIGNED = (n: number) => (n < 0 ? `-${formatMoney(Math.abs(n))}` : formatMoney(n));
const today = () => new Date().toISOString().slice(0, 10);

type Mode = "capital" | "contribution";

export function OwnerEquityCard({ equity }: { equity: EquityView }) {
  const isAdmin = toAppRole(useAuthStore((s) => s.userRole)) === "ADMIN";
  const partners = useBusinessStore((s) => s.partners);
  const owners = useMemo(() => activePartners(partners), [partners]);
  const nameOf = (subjectId: string) =>
    subjectId === OWNER_SUBJECT
      ? "صاحبة الشغل"
      : (owners.find((p) => p.id === subjectId)?.name ??
        partners.find((p) => p.id === subjectId)?.name ??
        "شريك (غير موجود في القائمة)");

  // With partners the totals are everyone's; the label must say so.
  const whose = owners.length > 0 ? "صاحبة الشغل والشركاء" : "صاحبة الشغل";
  const [mode, setMode] = useState<Mode | null>(null);
  const [form, setForm] = useState({
    who: OWNER_SUBJECT,
    amount: "",
    date: today(),
    note: "",
    // Capital only: did the money arrive in a wallet now, or before the ledger?
    cashNow: false,
    wallet: "inStoreSafe" as WalletType,
  });
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const gate = useSubmitGate();

  const amount = parseFloat(form.amount);
  const open = (m: Mode) => {
    setActionError(null);
    setForm((f) => ({ ...f, amount: "", note: "", date: today(), cashNow: m === "contribution" }));
    setMode(m);
  };

  async function submit() {
    if (!mode || !(amount > 0) || saving || !gate.enter()) return;
    setSaving(true);
    setActionError(null);
    try {
      const withCash = mode === "contribution" || form.cashNow;
      await appendFinancialEvent({
        kind: mode === "capital" ? "owner_capital" : "owner_contribution",
        occurredAt: new Date(`${form.date}T00:00:00`),
        actor: useAuthStore.getState().username || "ADMIN",
        refType: mode === "capital" ? "owner_capital" : "owner_contribution",
        refId: form.who,
        payload: {
          note: form.note.trim() || undefined,
          wallet: withCash ? form.wallet : undefined,
        },
        lines:
          mode === "capital"
            ? buildOwnerCapitalLines({
                subjectId: form.who,
                amount,
                wallet: withCash ? form.wallet : null,
              })
            : buildOwnerContributionLines({ subjectId: form.who, amount, wallet: form.wallet }),
      });
      // Every ledger reader — this card, the wallet cards, the budget — re-reads.
      window.dispatchEvent(
        new CustomEvent("ledger-sync-pulled", { detail: { table: "ledger_events" } }),
      );
      setMode(null);
    } catch (e) {
      setActionError(`${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
      gate.exit();
    }
  }

  const s = equity.data;

  return (
    <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Landmark className="size-5 text-primary" />
          <div>
            <h3 className="font-display text-lg font-bold">حقوق الملكية</h3>
            <p className="text-sm text-muted-foreground">
              حق صاحبة الشغل في المشروع — محسوب من حركات الدفتر، مش رقم مكتوب.
            </p>
          </div>
        </div>
        {isAdmin && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => open("capital")}>
              <Plus className="size-4 ml-1" />
              رأس المال
            </Button>
            <Button size="sm" variant="outline" onClick={() => open("contribution")}>
              <HandCoins className="size-4 ml-1" />
              مساهمة إضافية
            </Button>
          </div>
        )}
      </div>

      {equity.error ? (
        <LoadError
          message="تعذّر حساب حقوق الملكية من الدفتر، فمفيش رقم معروض."
          detail={equity.error}
          onRetry={equity.refresh}
          busy={equity.loading}
        />
      ) : !s ? (
        <p className="text-sm text-muted-foreground">بنحسب حقوق الملكية من الدفتر…</p>
      ) : (
        <>
          <dl className="divide-y divide-border rounded-xl border border-border">
            <Row
              label={`رأس مال ${whose}`}
              hint="المبلغ اللي اتضخّ في المشروع كرأس مال."
              value={s.capital === null ? "غير مسجل" : formatMoney(s.capital)}
              muted={s.capital === null}
            />
            <Row
              label="مساهمات إضافية"
              hint="فلوس دخلت من صاحبة الشغل بعد رأس المال."
              value={formatMoney(s.contributions)}
            />
            <Row
              label="الأرباح والخسائر المتراكمة"
              hint="المبيعات − تكلفة البضاعة − المصروفات، من أول تسجيل على النظام."
              value={SIGNED(s.accumulatedResult)}
            />
            <Row
              label={`مسحوبات ${whose}`}
              hint="فلوس خرجت لصاحبة الشغل أو الشركاء — مش مصروف."
              value={s.withdrawals > 0 ? `-${formatMoney(s.withdrawals)}` : formatMoney(0)}
            />
            {s.openingBalances !== 0 && (
              <Row
                label="أرصدة افتتاحية غير مصنفة كرأس مال"
                hint="خزائن ومخزون اتسجلوا كأرصدة بداية من غير ما يتحدد جزء منهم كرأس مال — غالباً أرباح ما قبل النظام."
                value={SIGNED(s.openingBalances)}
              />
            )}
            <Row
              label="صافي حقوق الملكية"
              hint="حق صاحبة الشغل الحالي بعد الأرباح/الخسائر والمساهمات والمسحوبات."
              value={SIGNED(s.totalEquity)}
              strong
            />
          </dl>
          {s.capital === null && (
            <p className="text-sm text-amber-700">
              رأس المال الافتتاحي غير مسجل — ده مش معناه إنه صفر. سجّليه لما يبقى الرقم معروف.
            </p>
          )}
          {s.owners.some((o) => o.subjectId !== OWNER_SUBJECT) && (
            <div className="space-y-2">
              <p className="text-sm font-semibold">لكل مالك</p>
              <table className="w-full text-sm">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-right font-normal py-1">المالك</th>
                    <th className="text-center font-normal py-1">رأس المال</th>
                    <th className="text-center font-normal py-1">مساهمات</th>
                    <th className="text-center font-normal py-1">مسحوبات</th>
                  </tr>
                </thead>
                <tbody>
                  {s.owners.map((o) => (
                    <tr key={o.subjectId} className="border-t border-border">
                      <td className="py-1">{nameOf(o.subjectId)}</td>
                      <td className="text-center">
                        {o.capital === null ? "غير مسجل" : formatMoney(o.capital)}
                      </td>
                      <td className="text-center">{formatMoney(o.contributions)}</td>
                      <td className="text-center">{formatMoney(o.withdrawals)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-muted-foreground">
                الأرباح مش متوزعة هنا على الشركاء: التوزيع بيتحسب بالنسب في «توزيع الأرباح للفترة».
              </p>
            </div>
          )}
        </>
      )}

      <Dialog open={mode !== null} onOpenChange={(v) => !v && setMode(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {mode === "capital" ? "تسجيل رأس المال الافتتاحي" : "تسجيل مساهمة إضافية"}
            </DialogTitle>
            <DialogDescription>
              {mode === "capital"
                ? "المبلغ اللي بدأ بيه المشروع. ده مش إيراد ومش بيزوّد الأرباح."
                : "فلوس دخلت المشروع من صاحبة الشغل أو شريك. مش إيراد ومش بتزوّد الأرباح."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="equity-who">مين</Label>
              <select
                id="equity-who"
                value={form.who}
                onChange={(e) => setForm((f) => ({ ...f, who: e.target.value }))}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value={OWNER_SUBJECT}>صاحبة الشغل</option>
                {owners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({PARTNER_KIND_LABELS[p.kind]})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="equity-amount">المبلغ (ج.م)</Label>
              <Input
                id="equity-amount"
                type="number"
                min="0"
                inputMode="decimal"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="equity-date">تاريخ السريان</Label>
              <Input
                id="equity-date"
                type="date"
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              />
            </div>
            {mode === "capital" && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={form.cashNow}
                  onChange={(e) => setForm((f) => ({ ...f, cashNow: e.target.checked }))}
                />
                <span>
                  الفلوس دي داخلة خزنة دلوقتي
                  <span className="block text-xs text-muted-foreground">
                    سيبيها فاضية لو رأس المال اتدفع زمان قبل ما تبدئي على النظام — ساعتها مش هيزوّد
                    رصيد أي خزنة.
                  </span>
                </span>
              </label>
            )}
            {(mode === "contribution" || form.cashNow) && (
              <div className="space-y-1.5">
                <Label htmlFor="equity-wallet">دخلت في</Label>
                <select
                  id="equity-wallet"
                  value={form.wallet}
                  onChange={(e) => setForm((f) => ({ ...f, wallet: e.target.value as WalletType }))}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  {Object.entries(WALLET_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="equity-note">ملاحظة (اختياري)</Label>
              <Input
                id="equity-note"
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              />
            </div>
            {actionError && <p className="text-sm text-destructive">{actionError}</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setMode(null)} disabled={saving}>
              إلغاء
            </Button>
            <Button onClick={() => void submit()} disabled={!(amount > 0) || saving}>
              {saving ? "جاري التسجيل…" : "تسجيل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({
  label,
  hint,
  value,
  strong = false,
  muted = false,
}: {
  label: string;
  hint: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div>
        <dt className={strong ? "font-bold" : "font-medium"}>{label}</dt>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <dd
        className={`${strong ? "text-lg font-bold" : "font-semibold"} ${muted ? "text-muted-foreground" : ""} whitespace-nowrap`}
      >
        {value}
      </dd>
    </div>
  );
}
