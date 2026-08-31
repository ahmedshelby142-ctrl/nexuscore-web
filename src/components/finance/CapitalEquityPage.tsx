import { useState, useMemo, useEffect } from "react";
import {
  Landmark,
  Users,
  Plus,
  Trash2,
  BadgePercent,
  Wallet,
  ArrowDownToDot,
  ArrowUpFromDot,
  FileText,
  Loader2,
  Users as UsersIcon,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { useFinancialStore } from "@/store/useFinancialStore";
import { useBusinessStore } from "@/store/useBusinessStore";
import { distributionFor } from "@/lib/partners";
import { PARTNER_KIND_LABELS } from "@/types";
import { appendEvent, balances } from "@/lib/ledger";
import { customWindow, fetchPnl } from "@/lib/ledger/reports";
import { useBalances } from "@/lib/ledger/useBalances";
import { buildWalletOpeningLines, buildWalletTransferLines } from "@/lib/ledger/audit";
import type { WalletType } from "@/types";
import { add, subtract, multiply, divide, formatMoney } from "@/lib/math";
import { generateFinancialPdf, storeIdentity } from "@/lib/pdfGenerator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { WALLET_LABELS } from "@/types";

export function CapitalEquityPage() {
  const { wallets, transferBetweenWallets, walletTransfers } = useFinancialStore();
  // ONE list of part-owners. This screen used to keep its own `shareholders`
  // slice beside `useBusinessStore.partners` — same three fields, second list,
  // and each validated its own 100%. Registration lives on the الشركاء tab;
  // this tab reads the list and distributes to it.
  const partners = useBusinessStore((s) => s.partners);
  const activePartners = useMemo(() => partners.filter((p) => p.status !== "inactive"), [partners]);
  // What each working partner has already drawn: SUM(owner_budget) keyed by
  // partner id. Zero until the Owner Budget path (7.3) writes `owner_draw`
  // events — the read is here now so the rule is visible where it applies.
  const { amountOf: drawsOf } = useBalances("owner_budget");

  const [isShareholderOpen, setIsShareholderOpen] = useState(false);
  const [shareholderForm, setShareholderForm] = useState({
    name: "",
    capitalContributed: "",
    sharePercentage: "",
  });
  const [isTransferOpen, setIsTransferOpen] = useState(false);
  const [transferForm, setTransferForm] = useState({
    fromWallet: "inStoreSafe" as keyof typeof WALLET_LABELS,
    toWallet: "vodafoneCash" as keyof typeof WALLET_LABELS,
    amount: "",
    notes: "",
  });
  const [isDividendOpen, setIsDividendOpen] = useState(false);
  const [dividendPeriod, setDividendPeriod] = useState({
    startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    endDate: new Date().toISOString().slice(0, 10),
  });

  const totalCapital = useMemo(
    () => activePartners.reduce((total, p) => add(total, p.capitalContribution || 0), 0),
    [activePartners],
  );

  // `totalLifetimeDividends` is gone with the `lifetimeDividendsPaid` field it
  // summed: a stored per-person running total, the same shape as the CRM's
  // stored LTV. Dividends paid are documents; what each person is OWED is
  // derived below.

  // Every wallet figure on this screen is SUM(wallet) for that wallet — the
  // same source the POS picker reads, so the two screens cannot disagree.
  const {
    amountOf: walletBalance,
    total: walletsTotal,
    error: walletError,
    refresh: refreshWallets,
  } = useBalances("wallet");

  const [isOpeningOpen, setIsOpeningOpen] = useState(false);
  const [openingWallet, setOpeningWallet] = useState<WalletType>("inStoreSafe");
  const [openingAmount, setOpeningAmount] = useState("");
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletActionError, setWalletActionError] = useState<string | null>(null);

  /**
   * What the shop already has in a wallet on day one. Entered by the owner,
   * recorded as an event — never a number the code assumed.
   */
  const handleWalletOpening = async () => {
    const amount = parseFloat(openingAmount);
    if (!amount) return;

    setWalletBusy(true);
    setWalletActionError(null);
    try {
      await appendEvent({
        kind: "stock_adjustment",
        actor: "رصيد افتتاحي",
        refType: "opening_balance",
        refId: openingWallet,
        payload: { wallet: openingWallet, amount },
        lines: buildWalletOpeningLines({ wallet: openingWallet, amount }),
      });
      refreshWallets();
      setOpeningAmount("");
      setIsOpeningOpen(false);
    } catch (e) {
      setWalletActionError(
        `الرصيد الافتتاحي متسجّلش. ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setWalletBusy(false);
    }
  };

  const handleTransfer = async () => {
    const amount = parseFloat(transferForm.amount);
    if (!amount || amount <= 0 || transferForm.fromWallet === transferForm.toWallet) return;

    if (amount > walletBalance(transferForm.fromWallet)) {
      setWalletActionError(
        `الرصيد مش كفاية — متاح ${formatMoney(walletBalance(transferForm.fromWallet))} بس`,
      );
      return;
    }

    setWalletBusy(true);
    setWalletActionError(null);
    try {
      // ONE event, two equal and opposite lines. Moving the shop's own money
      // between its own accounts creates none, so the pair must net to zero.
      await appendEvent({
        kind: "wallet_transfer",
        actor: "تحويل بين الخزائن",
        refType: "wallet_transfer",
        payload: { notes: transferForm.notes || undefined },
        lines: buildWalletTransferLines({
          fromWallet: transferForm.fromWallet,
          toWallet: transferForm.toWallet,
          amount,
        }),
      });

      // The transfer document is kept for the history list below; the money
      // itself moved on the ledger, not in a stored balance.
      transferBetweenWallets({
        fromWallet: transferForm.fromWallet as any,
        toWallet: transferForm.toWallet as any,
        amount,
        notes: transferForm.notes,
      });
      refreshWallets();
      setTransferForm({
        fromWallet: "inStoreSafe",
        toWallet: "vodafoneCash",
        amount: "",
        notes: "",
      });
      setIsTransferOpen(false);
    } catch (e) {
      setWalletActionError(
        `التحويل متسجّلش ومفيش رصيد اتغيّر. ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setWalletBusy(false);
    }
  };

  /**
   * What each part-owner is owed for the period — gross, advance, net.
   *
   * Gross is ownership % × net profit, identical arithmetic for شريك and
   * مساهم. A working partner's draws during the period are an ADVANCE on that
   * share, so they are deducted: paying the full percentage on top would hand
   * over the same money twice. A negative net (drew more than earned) is shown
   * as such rather than floored at zero.
   */
  /**
   * Net profit for the dividend period — the SAME figure التقارير المالية
   * reports, from the same `fetchPnl` query.
   *
   * It used to be `getNetProfitForPeriod`, which summed the `transactions`
   * store (empty since the POS moved to the ledger), guessed POS cost at
   * `posSales × 0.7` — the hardcoded margin the ledger's `unit_cost` snapshot
   * exists to replace — and added two shipping counters nothing writes. Every
   * partner's share was computed from that. A distribution has to agree with
   * the P&L, or one of the two screens is lying about the same period.
   */
  const [periodProfit, setPeriodProfit] = useState<number | null>(null);
  const [profitError, setProfitError] = useState<string | null>(null);

  useEffect(() => {
    const w = customWindow(dividendPeriod.startDate, dividendPeriod.endDate);
    if (!w) {
      setPeriodProfit(null);
      setProfitError("النطاق غير صحيح — تاريخ البداية لازم يكون قبل تاريخ النهاية.");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const report = await fetchPnl(balances, w);
        if (cancelled) return;
        setPeriodProfit(report.netProfit);
        setProfitError(null);
      } catch (e) {
        if (cancelled) return;
        // Never fall back to zero: zero profit distributes nothing and reads
        // as a settled period rather than as a failed read.
        setPeriodProfit(null);
        setProfitError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dividendPeriod]);

  const distributions = useMemo(
    () =>
      periodProfit === null
        ? []
        : activePartners.map((p) => ({
            partner: p,
            ...distributionFor(p, periodProfit, drawsOf(p.id)),
          })),
    [activePartners, periodProfit, drawsOf],
  );

  const handleExportPdf = () => {
    // The printout covers the period the SCREEN is showing. It used to print
    // its own fixed last-30-days window, so the PDF and the table above it
    // could disagree about the same distribution.
    const netProfit = periodProfit ?? 0;

    // The PDF prints what the screen shows: ledger balances, not stored ones.
    const walletRows = (Object.keys(WALLET_LABELS) as WalletType[]).map((type) => ({
      type,
      label: WALLET_LABELS[type],
      balance: walletBalance(type),
    }));
    const totalSales = walletsTotal;
    generateFinancialPdf({
      companyName: storeIdentity().name,
      reportDate: new Date(),
      financialSummary: {
        totalSales,
        totalExpenses: 0,
        netProfit,
        shippingProfit: 0,
      },
      walletBalances: walletRows,
      // The printout says the same three numbers the screen does: gross share,
      // the advance already drawn, and what is actually payable.
      shareholderDistributions: distributions.map((row) => ({
        name: `${row.partner.name} (${PARTNER_KIND_LABELS[row.partner.kind]})`,
        capitalContributed: row.partner.capitalContribution || 0,
        sharePercentage: row.partner.equityPercentage,
        drawsTaken: row.draws,
        currentShare: row.net,
      })),
      expenses: [],
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">الأسهم والمساهمين</h1>
          <p className="text-muted-foreground mt-1">إدارة رأس المال وتوزيع الأرباح بين المساهمين</p>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-3 mb-2">
            <Landmark className="size-5 text-primary" />
            <p className="text-sm text-muted-foreground">إجمالي رأس المال</p>
          </div>
          <p className="text-2xl font-bold">{formatMoney(totalCapital)}</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-3 mb-2">
            <Users className="size-5 text-blue-600" />
            <p className="text-sm text-muted-foreground">الشركاء والمساهمين النشطين</p>
          </div>
          <p className="text-2xl font-bold">{activePartners.length}</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-3 mb-2">
            <ArrowDownToDot className="size-5 text-green-600" />
            <p className="text-sm text-muted-foreground">إجمالي نسب الملكية</p>
          </div>
          <p className="text-2xl font-bold">
            {activePartners.reduce((t, p) => t + (p.equityPercentage || 0), 0)}%
          </p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setIsDividendOpen(true)}>
            <ArrowDownToDot className="size-4 ml-2" /> حساب الأرباح التلقائي
          </Button>
          <Button variant="outline" onClick={() => setIsTransferOpen(true)}>
            <ArrowUpFromDot className="size-4 ml-2" /> تحويل بين الخزائن
          </Button>
          <Button variant="outline" onClick={handleExportPdf}>
            <FileText className="size-4 ml-2" /> تصدير PDF
          </Button>
        </div>
        <div className="text-sm text-muted-foreground">
          الرصيد الإجمالي للخزائن: {formatMoney(walletsTotal)}
        </div>
      </div>

      {/* Distribution table — one list, both kinds, three honest numbers. */}
      <div className="rounded-2xl border border-border bg-card overflow-x-auto">
        <div className="p-4 pb-0">
          <h3 className="font-display text-lg font-bold">توزيع الأرباح للفترة</h3>
          <p className="text-sm text-muted-foreground mt-1">
            نصيب كل واحد = نسبته × صافي ربح الفترة. اللي بيشتغل في المحل وسحب من نصيبه، المسحوب
            بيتخصم — عشان ماياخدش نصيبه مرتين.
          </p>
          {/* The number the whole table hangs on, stated out loud — it is the
              same one تبويب «التقارير المالية» reports for the same window. */}
          {profitError ? (
            <p className="text-sm text-red-600 mt-2">تعذّر حساب صافي الربح: {profitError}</p>
          ) : periodProfit === null ? (
            <p className="text-sm text-muted-foreground mt-2">بنحسب صافي الربح من دفتر الحركات…</p>
          ) : (
            <p className="text-sm mt-2">
              صافي ربح الفترة:{" "}
              <strong className={periodProfit >= 0 ? "text-green-600" : "text-red-600"}>
                {formatMoney(periodProfit)}
              </strong>
            </p>
          )}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-right px-4">الاسم</TableHead>
              <TableHead className="text-center px-4">النوع</TableHead>
              <TableHead className="text-center px-4">نسبة الملكية (%)</TableHead>
              <TableHead className="text-center px-4">رأس المال</TableHead>
              <TableHead className="text-center px-4">نصيبه من الأرباح</TableHead>
              <TableHead className="text-center px-4">مسحوبات الفترة</TableHead>
              <TableHead className="text-center px-4">المستحق صافي</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
              {partners.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-12">
                    {periodProfit === null ? (
                      <div className="flex justify-center items-center gap-2 text-muted-foreground py-4">
                        <Loader2 className="size-4 animate-spin" />
                        <span>استنّي شوية — بنحسب أرباح الفترة</span>
                      </div>
                    ) : (
                      <EmptyState
                        icon={UsersIcon}
                        title="مفيش شركاء ولا مساهمين مسجلين"
                        description='سجّلهم من تبويب "الشركاء ورأس المال"'
                      />
                    )}
                  </TableCell>
                </TableRow>
              ) : (
              distributions.map((row) => (
                <TableRow key={row.partner.id}>
                  <TableCell className="font-medium px-4">{row.partner.name}</TableCell>
                  <TableCell className="text-center px-4">
                    <Badge variant={row.partner.kind === "working" ? "default" : "secondary"}>
                      {PARTNER_KIND_LABELS[row.partner.kind]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-center px-4">
                    {row.partner.equityPercentage}%
                  </TableCell>
                  <TableCell className="text-center px-4 font-mono">
                    {formatMoney(row.partner.capitalContribution || 0)}
                  </TableCell>
                  <TableCell className="text-center px-4 font-mono">
                    {formatMoney(row.gross)}
                  </TableCell>
                  <TableCell className="text-center px-4 font-mono">
                    {row.partner.kind === "working" ? (
                      formatMoney(row.draws)
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell
                    className={`text-center px-4 font-mono font-bold ${row.net < 0 ? "text-destructive" : "text-green-600"}`}
                  >
                    {formatMoney(row.net)}
                    {row.net < 0 && (
                      <span className="block text-[10px] font-normal">سحب أكتر من نصيبه</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Wallets Summary */}
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <h3 className="font-display text-xl font-bold">ملخص الخزائن</h3>
          <Button variant="outline" onClick={() => setIsOpeningOpen(true)}>
            تسجيل رصيد افتتاحي
          </Button>
        </div>
        {walletError && (
          <div className="mb-4 rounded-lg p-3 bg-red-50 border border-red-200">
            <p className="text-sm font-medium text-red-900">
              تعذّرت قراءة أرصدة الخزائن — الأرقام دي مش موثوقة. {walletError}
            </p>
          </div>
        )}
        {walletActionError && (
          <div className="mb-4 rounded-lg p-3 bg-red-50 border border-red-200">
            <p className="text-sm font-medium text-red-900">{walletActionError}</p>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(Object.keys(WALLET_LABELS) as WalletType[]).map((type) => (
            <div key={type} className="rounded-xl border border-border p-4 bg-muted/30">
              <div className="flex items-center gap-2 mb-2">
                <Wallet className="size-4 text-primary" />
                <span className="font-medium">{WALLET_LABELS[type]}</span>
              </div>
              {/* SUM(wallet) for this wallet — no stored balance anywhere. */}
              <p className="text-xl font-bold font-mono">{formatMoney(walletBalance(type))}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Transfers */}
      {walletTransfers.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-6">
          <h3 className="font-display text-xl font-bold mb-4">سجل التحويلات الأخيرة</h3>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {walletTransfers
              .slice(-10)
              .reverse()
              .map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/30"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{WALLET_LABELS[t.fromWallet]}</span>
                    <ArrowUpFromDot className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{WALLET_LABELS[t.toWallet]}</span>
                  </div>
                  <div className="text-left">
                    <p className="font-mono text-green-600">+{formatMoney(t.amount)}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(t.timestamp).toLocaleDateString("ar-EG")}
                    </p>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Add Shareholder Dialog */}
      {/* The "add shareholder" dialog lived here. Deleted: a part-owner is
          registered ONCE, on the الشركاء ورأس المال tab, where the نوع
          (شريك / مساهم) and the ≤100% check live. */}
      <Dialog open={isOpeningOpen} onOpenChange={setIsOpeningOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>رصيد افتتاحي للخزينة</DialogTitle>
            <DialogDescription>
              سجّل الفلوس اللي فعلاً موجودة في الخزينة دلوقتي. ده بيتسجّل كحركة في الدفتر، مش رقم
              محفوظ — وبعد كده كل بيعة أو مصروف بيحرّكه لوحده.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>الخزينة</Label>
              <select
                value={openingWallet}
                onChange={(e) => setOpeningWallet(e.target.value as WalletType)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {(Object.keys(WALLET_LABELS) as WalletType[]).map((type) => (
                  <option key={type} value={type}>
                    {WALLET_LABELS[type]}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                الرصيد الحالي: {formatMoney(walletBalance(openingWallet))}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="openingAmount">المبلغ الموجود حالياً</Label>
              <Input
                id="openingAmount"
                type="number"
                step="0.01"
                value={openingAmount}
                onChange={(e) => setOpeningAmount(e.target.value)}
                placeholder="0.00"
              />
              <p className="text-xs text-muted-foreground">
                لو الخزينة عليها عجز، اكتب رقم بالسالب.
              </p>
            </div>
            {walletActionError && (
              <div className="rounded-lg p-3 bg-red-50 border border-red-200">
                <p className="text-sm font-medium text-red-900">{walletActionError}</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpeningOpen(false)}>
              إلغاء
            </Button>
            <Button
              onClick={() => void handleWalletOpening()}
              disabled={walletBusy || !parseFloat(openingAmount)}
            >
              {walletBusy ? "جاري التسجيل..." : "تسجيل الرصيد"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isTransferOpen} onOpenChange={setIsTransferOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>تحويل بين الخزائن</DialogTitle>
            <DialogDescription>حرك الأموال بين الخزائن الداخلية بأمان</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>من الخزينة</Label>
              <select
                value={transferForm.fromWallet}
                onChange={(e) =>
                  setTransferForm((f) => ({ ...f, fromWallet: e.target.value as any }))
                }
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {Object.entries(WALLET_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>إلى الخزينة</Label>
              <select
                value={transferForm.toWallet}
                onChange={(e) =>
                  setTransferForm((f) => ({ ...f, toWallet: e.target.value as any }))
                }
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {Object.entries(WALLET_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>المبلغ</Label>
              <Input
                type="number"
                min="0"
                placeholder="أدخل المبلغ"
                value={transferForm.amount}
                onChange={(e) => setTransferForm((f) => ({ ...f, amount: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>ملاحظات (اختياري)</Label>
              <Input
                placeholder="سبب التحويل"
                value={transferForm.notes}
                onChange={(e) => setTransferForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsTransferOpen(false)}>
              إلغاء
            </Button>
            <Button
              onClick={() => void handleTransfer()}
              disabled={!transferForm.amount || walletBusy}
            >
              <ArrowUpFromDot className="size-4 ml-2" /> تحويل
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dividend Calculator Dialog */}
      <Dialog open={isDividendOpen} onOpenChange={setIsDividendOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>حاسبة الأرباح التلقائي</DialogTitle>
            <DialogDescription>حسب أرباح المساهمين لفترة محددة</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>تاريخ البدء</Label>
                <Input
                  type="date"
                  value={dividendPeriod.startDate}
                  onChange={(e) => setDividendPeriod((p) => ({ ...p, startDate: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>تاريخ الانتهاء</Label>
                <Input
                  type="date"
                  value={dividendPeriod.endDate}
                  onChange={(e) => setDividendPeriod((p) => ({ ...p, endDate: e.target.value }))}
                />
              </div>
            </div>

            {distributions.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">
                  المستحق لكل واحد: نصيبه ناقص اللي سحبه في الفترة
                </p>
                <div className="max-h-60 overflow-y-auto space-y-2">
                  {distributions.map((row) => (
                    <div
                      key={row.partner.id}
                      className="p-3 rounded-lg border border-border bg-muted/30"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">
                          {row.partner.name}{" "}
                          <span className="text-xs text-muted-foreground">
                            ({PARTNER_KIND_LABELS[row.partner.kind]})
                          </span>
                        </span>
                        <span
                          className={`font-mono font-bold ${row.net < 0 ? "text-destructive" : "text-green-600"}`}
                        >
                          {formatMoney(row.net)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        نصيبه {formatMoney(row.gross)}
                        {row.partner.kind === "working" && ` − مسحوبات ${formatMoney(row.draws)}`}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsDividendOpen(false)}>
              إلغاء
            </Button>
            {/* Paying a dividend moves real money, so it needs its own event
                (wallet − per partner). That is 7.3/7.4 territory; until then
                this dialog previews and does not pretend to pay. */}
            <Button variant="outline" onClick={() => setIsDividendOpen(false)}>
              تمام
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
