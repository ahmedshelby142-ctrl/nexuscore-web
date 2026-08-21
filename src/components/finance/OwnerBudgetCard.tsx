/**
 * ميزانية صاحبة العمل — the ceiling, live, and the draws that consume it.
 *
 * The limit and the period are SETTINGS she types. Everything else on this
 * card is derived: spent is `SUM(owner_budget)` for her own draws inside the
 * current period, remaining is the subtraction, and the bar is the ratio.
 * Nothing is accumulated in a store, so closing the app for a month and
 * reopening it cannot desynchronise the number.
 *
 * Two periods, because the owner asked for the choice rather than an assumed
 * monthly cycle: **شهري** follows the calendar (derived from the event date,
 * so it rolls over by itself) and **بدون مدة** is a fixed ceiling that runs
 * until she presses «تصفير الميزانية».
 *
 * A draw over the limit warns loudly and is still recorded. Blocking it would
 * only mean the money left the till without the ledger knowing.
 */

import { useEffect, useState } from "react";
import { PiggyBank, AlertTriangle, HandCoins, RotateCcw } from "lucide-react";
import { balances, appendEvent } from "@/lib/ledger";
import {
  buildOwnerDrawLines,
  budgetStatus,
  periodStart,
  BUDGET_PERIOD_LABELS,
  BUDGET_PERIOD_HINTS,
  OWNER_SUBJECT,
  ownerSubjectFor,
  ownerSpent,
  drawBreakdown,
  DRAW_CATEGORY_SUGGESTIONS,
  type BudgetPeriod,
} from "@/lib/ledger/ownerDraw";
import { useFinancialStore } from "@/store/useFinancialStore";
import { useBusinessStore } from "@/store/useBusinessStore";
import { activePartners } from "@/lib/partners";
import { useBalances } from "@/lib/ledger/useBalances";
import { formatMoney } from "@/lib/math";
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
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { WALLET_LABELS, PARTNER_KIND_LABELS } from "@/types";
import type { WalletType } from "@/types";
import { cn } from "@/lib/utils";

export function OwnerBudgetCard() {
  const { ownerBudget, setOwnerBudget, resetOwnerBudget } = useFinancialStore();
  const partners = useBusinessStore((s) => s.partners);
  const { refresh: refreshWallets } = useBalances("wallet");

  const [spent, setSpent] = useState(0);
  const [readError, setReadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const [isSetupOpen, setIsSetupOpen] = useState(false);
  const [isDrawOpen, setIsDrawOpen] = useState(false);
  const [isResetOpen, setIsResetOpen] = useState(false);
  const [setupForm, setSetupForm] = useState({ limit: "", periodType: "monthly" as BudgetPeriod });
  const [drawForm, setDrawForm] = useState({
    amount: "",
    wallet: "inStoreSafe" as WalletType,
    who: OWNER_SUBJECT,
    // Optional. Free text with suggestions — metadata on the SAME draw, not a
    // second budget.
    category: "",
  });
  const [breakdown, setBreakdown] = useState<{ category: string | null; amount: number }[]>([]);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Working partners can draw too — as an advance on their dividend (7.2).
  // Their draws are keyed to them, so they never touch this budget.
  const drawers = activePartners(partners).filter((p) => p.kind === "working");

  useEffect(() => {
    if (!ownerBudget) return;
    let cancelled = false;
    void (async () => {
      try {
        const from = periodStart(ownerBudget);
        // Every subject on the account for the period — the owner's plain and
        // categorised subjects, plus any partner draws. `ownerSpent` and
        // `drawBreakdown` filter the same rows, so the ceiling and the split
        // are guaranteed to agree.
        const rows = await balances({ account: "owner_budget", from, to: new Date() });
        if (cancelled) return;
        setSpent(ownerSpent(rows));
        setBreakdown(drawBreakdown(rows));
        setReadError(null);
      } catch (e) {
        if (cancelled) return;
        // A failed read must not render as "nothing spent yet".
        setReadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerBudget, tick]);

  const status = budgetStatus(ownerBudget?.limit ?? 0, spent);

  async function recordDraw() {
    const amount = parseFloat(drawForm.amount);
    if (!(amount > 0) || saving) return;
    setSaving(true);
    setDrawError(null);
    try {
      // ONE event, the same builder for the owner and for a شريك — only the
      // subject differs, which is what keeps the two budgets apart.
      await appendEvent({
        kind: "owner_draw",
        actor: drawForm.who === OWNER_SUBJECT ? "صاحبة العمل" : "شريك",
        refType: "owner_draw",
        refId: drawForm.who,
        // Payload stays descriptive: the category that MATTERS is in the
        // subject below, where a SUM can group by it without trusting text.
        payload: { wallet: drawForm.wallet, category: drawForm.category.trim() || undefined },
        lines: buildOwnerDrawLines({
          subjectId:
            drawForm.who === OWNER_SUBJECT
              ? ownerSubjectFor(drawForm.category)
              : drawForm.who,
          amount,
          wallet: drawForm.wallet,
        }),
      });
      refreshWallets();
      setTick((t) => t + 1);
      setDrawForm({ amount: "", wallet: drawForm.wallet, who: drawForm.who, category: "" });
      setIsDrawOpen(false);
    } catch (e) {
      setDrawError(
        `المسحوب متسجّلش، ومفيش فلوس اتحركت. ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  function openSetup() {
    // Prefill, so "تعديل" edits the ceiling instead of asking for it again.
    setSetupForm({
      limit: ownerBudget ? String(ownerBudget.limit) : "",
      periodType: ownerBudget?.periodType ?? "monthly",
    });
    setIsSetupOpen(true);
  }

  function saveSetup() {
    const limit = parseFloat(setupForm.limit);
    if (!(limit > 0)) return;
    setOwnerBudget({
      limit,
      periodType: setupForm.periodType,
      // Editing the ceiling must NOT restart the period — that would wipe the
      // running total by accident. The period only moves when she resets it,
      // or when the calendar does it for شهري. A brand-new budget starts now.
      startedAt: ownerBudget?.startedAt ?? Date.now(),
    });
    setIsSetupOpen(false);
  }

  // Not set up yet: one prompt, not an empty card pretending to be a number.
  if (!ownerBudget) {
    return (
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <div className="size-10 rounded-xl flex items-center justify-center bg-purple-100 dark:bg-purple-950/40">
              <PiggyBank className="size-5 text-purple-600" />
            </div>
            <div>
              <h3 className="font-display text-xl font-bold">ميزانية صاحبة العمل</h3>
              <p className="text-sm text-muted-foreground mt-1 max-w-prose">
                حدّدي مبلغ لنفسك، والنظام يقول لك كل جنيه راح منه. المسحوبات دي مش مصروفات
                المحل — دي فلوس بتخرج لك إنتِ.
              </p>
            </div>
          </div>
          <Button onClick={openSetup}>تحديد الميزانية</Button>
        </div>
        {renderSetupDialog()}
      </div>
    );
  }

  const from = periodStart(ownerBudget);
  const barColor =
    status.level === "over" ? "bg-destructive" : status.level === "warn" ? "bg-amber-500" : "bg-green-600";

  return (
    <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="size-10 rounded-xl flex items-center justify-center bg-purple-100 dark:bg-purple-950/40">
            <PiggyBank className="size-5 text-purple-600" />
          </div>
          <div>
            <h3 className="font-display text-xl font-bold">ميزانية صاحبة العمل</h3>
            <p className="text-sm text-muted-foreground mt-1">
              {BUDGET_PERIOD_LABELS[ownerBudget.periodType]} —{" "}
              {ownerBudget.periodType === "monthly"
                ? `من ${from.toLocaleDateString("ar-EG")} (بداية الشهر)`
                : `من ${from.toLocaleDateString("ar-EG")} (آخر تصفير)`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button onClick={() => setIsDrawOpen(true)} className="gap-2">
            <HandCoins className="size-4" />
            تسجيل مسحوب
          </Button>
          {ownerBudget.periodType === "open" && (
            <Button variant="outline" className="gap-2" onClick={() => setIsResetOpen(true)}>
              <RotateCcw className="size-4" />
              تصفير الميزانية
            </Button>
          )}
          <Button variant="ghost" onClick={openSetup}>
            تعديل
          </Button>
        </div>
      </div>

      {readError && (
        <p className="text-sm text-destructive">
          مقدرناش نقرأ المسحوبات من الدفتر، فالأرقام دي مش مضمونة. ({readError})
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border border-border bg-muted/30 p-4">
          <p className="text-xs text-muted-foreground">المبلغ المحدد</p>
          <p className="text-2xl font-bold mt-1">{formatMoney(ownerBudget.limit)}</p>
        </div>
        <div className="rounded-xl border border-border bg-muted/30 p-4">
          <p className="text-xs text-muted-foreground">اتسحب في الفترة</p>
          <p className="text-2xl font-bold mt-1">{formatMoney(status.spent)}</p>
        </div>
        <div className="rounded-xl border border-border bg-muted/30 p-4">
          <p className="text-xs text-muted-foreground">الباقي</p>
          <p
            className={cn(
              "text-2xl font-bold mt-1",
              status.remaining < 0 ? "text-destructive" : "text-green-600",
            )}
          >
            {formatMoney(status.remaining)}
          </p>
        </div>
      </div>

      {/* The bar caps at 100% visually; the numbers above tell the truth. */}
      <div>
        <div className="h-3 w-full rounded-full bg-muted overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all", barColor)}
            style={{ width: `${Math.min(100, Math.max(0, status.percent))}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {Math.round(status.percent)}% من الميزانية
        </p>
      </div>

      {breakdown.length > 0 && (
        <div className="rounded-xl border border-border bg-muted/20 p-4">
          <p className="text-sm font-medium mb-3">راح فين؟</p>
          <div className="space-y-2">
            {breakdown.map((row) => {
              const share = status.spent > 0 ? (row.amount / status.spent) * 100 : 0;
              return (
                <div key={row.category ?? "—"}>
                  <div className="flex items-center justify-between text-sm">
                    <span>{row.category ?? "بلا تصنيف"}</span>
                    <span className="font-mono">{formatMoney(row.amount)}</span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-muted mt-1 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-purple-500"
                      style={{ width: `${Math.min(100, Math.max(0, share))}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {status.level !== "ok" && (
        <div
          className={cn(
            "rounded-xl border p-4 flex items-start gap-3",
            status.level === "over"
              ? "border-destructive/40 bg-destructive/5"
              : "border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900",
          )}
        >
          <AlertTriangle
            className={cn(
              "size-5 mt-0.5 shrink-0",
              status.level === "over" ? "text-destructive" : "text-amber-600",
            )}
          />
          <p className="text-sm">
            {status.level === "over"
              ? `انتهت الميزانية — سحبتي ${formatMoney(status.spent)} من ${formatMoney(ownerBudget.limit)}. لسه تقدري تسحبي، بس الزيادة بتتسجل وبتبان هنا بالسالب.`
              : `على وشك الانتهاء — فاضل ${formatMoney(status.remaining)} بس من ميزانية الفترة.`}
          </p>
        </div>
      )}

      {renderSetupDialog()}
      {renderDrawDialog()}
      {renderResetDialog()}
    </div>
  );

  function renderSetupDialog() {
    return (
      <Dialog open={isSetupOpen} onOpenChange={setIsSetupOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>ميزانية صاحبة العمل</DialogTitle>
            <DialogDescription>
              المبلغ اللي بتسمحي لنفسك بيه، والمدة اللي بيتحسب عليها.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="budget-limit">المبلغ المحدد (ج.م)</Label>
              <Input
                id="budget-limit"
                type="number"
                min="0"
                inputMode="decimal"
                value={setupForm.limit}
                onChange={(e) => setSetupForm((f) => ({ ...f, limit: e.target.value }))}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label>المدة</Label>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(BUDGET_PERIOD_LABELS) as BudgetPeriod[]).map((period) => (
                  <button
                    key={period}
                    type="button"
                    onClick={() => setSetupForm((f) => ({ ...f, periodType: period }))}
                    className={cn(
                      "rounded-xl border p-3 text-right transition-colors",
                      setupForm.periodType === period
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/40",
                    )}
                  >
                    <span className="font-semibold block">{BUDGET_PERIOD_LABELS[period]}</span>
                    <span className="text-xs text-muted-foreground block mt-1">
                      {BUDGET_PERIOD_HINTS[period]}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsSetupOpen(false)}>
              إلغاء
            </Button>
            <Button onClick={saveSetup} disabled={!(parseFloat(setupForm.limit) > 0)}>
              حفظ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  function renderDrawDialog() {
    const amount = parseFloat(drawForm.amount) || 0;
    const after = budgetStatus(ownerBudget?.limit ?? 0, spent + amount);
    const ownerDraw = drawForm.who === OWNER_SUBJECT;

    return (
      <Dialog open={isDrawOpen} onOpenChange={setIsDrawOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>تسجيل مسحوب شخصي</DialogTitle>
            <DialogDescription>
              دي فلوس بتخرج من المحل لشخص، مش مصروف تشغيل — فمش بتتحسب في أرباح المحل.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="draw-who">مين اللي سحب</Label>
              <select
                id="draw-who"
                value={drawForm.who}
                onChange={(e) => setDrawForm((f) => ({ ...f, who: e.target.value }))}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value={OWNER_SUBJECT}>صاحبة العمل — من الميزانية دي</option>
                {drawers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({PARTNER_KIND_LABELS[p.kind]}) — خصم من نصيبه في الأرباح
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {ownerDraw
                  ? "المسحوب ده بيتحسب على ميزانيتك أنتِ."
                  : "مسحوب الشريك بيتخصم من نصيبه وقت توزيع الأرباح، ومبيمسّش ميزانيتك."}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="draw-amount">المبلغ (ج.م)</Label>
              <Input
                id="draw-amount"
                type="number"
                min="0"
                inputMode="decimal"
                value={drawForm.amount}
                onChange={(e) => setDrawForm((f) => ({ ...f, amount: e.target.value }))}
              />
            </div>
            {/* Only the owner's own draws carry a category — a partner's draw
                is an advance on their share, not a household expense. */}
            {ownerDraw && (
              <div className="space-y-1.5">
                <Label htmlFor="draw-category">التصنيف (اختياري)</Label>
                <Input
                  id="draw-category"
                  list="draw-category-suggestions"
                  placeholder="أكل، مشاوير، فواتير…"
                  value={drawForm.category}
                  onChange={(e) => setDrawForm((f) => ({ ...f, category: e.target.value }))}
                />
                <datalist id="draw-category-suggestions">
                  {DRAW_CATEGORY_SUGGESTIONS.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
                <p className="text-xs text-muted-foreground">
                  نفس الميزانية ونفس الإجمالي — التصنيف بس عشان تعرفي فلوسك راحت فين.
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="draw-wallet">اتسحب من</Label>
              <select
                id="draw-wallet"
                value={drawForm.wallet}
                onChange={(e) => setDrawForm((f) => ({ ...f, wallet: e.target.value as WalletType }))}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {Object.entries(WALLET_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            {/* Warn before, not after — but never refuse. */}
            {ownerDraw && amount > 0 && after.level !== "ok" && (
              <p
                className={cn(
                  "text-sm",
                  after.level === "over" ? "text-destructive" : "text-amber-600",
                )}
              >
                {after.level === "over"
                  ? `المسحوب ده هيعدّي الميزانية — الباقي هيبقى ${formatMoney(after.remaining)}. هيتسجل عادي.`
                  : `بعد المسحوب ده هيفضل ${formatMoney(after.remaining)} بس.`}
              </p>
            )}
            {drawError && <p className="text-sm text-destructive">{drawError}</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsDrawOpen(false)} disabled={saving}>
              إلغاء
            </Button>
            <Button onClick={() => void recordDraw()} disabled={!(amount > 0) || saving}>
              {saving ? "جاري التسجيل…" : "تسجيل المسحوب"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  function renderResetDialog() {
    return (
      <AlertDialog open={isResetOpen} onOpenChange={setIsResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>تصفير الميزانية؟</AlertDialogTitle>
            <AlertDialogDescription>
              هتبدأ فترة جديدة من دلوقتي، والعداد يرجع لصفر. المسحوبات القديمة مش هتتمسح — هي
              متسجلة في الدفتر وهتفضل، بس مش هتتحسب في الفترة الجديدة.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                resetOwnerBudget();
                setTick((t) => t + 1);
              }}
            >
              تأكيد التصفير
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }
}
