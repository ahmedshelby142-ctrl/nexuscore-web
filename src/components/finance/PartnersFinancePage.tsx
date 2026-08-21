import { useState, useMemo } from "react";
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Users,
  Plus,
  HandCoins,
  UserPlus,
  PiggyBank,
  Trash2,
  BadgePercent,
  Wallet,
  AlertTriangle,
  Gauge,
  Ban,
  Calendar,
  Building2,
  Wrench,
  Zap,
  Megaphone,
  Truck,
  Store,
  Coffee,
  CircleDollarSign,
  FileBarChart,
  Inbox,
  Landmark,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useFinancialStore } from "@/store/useFinancialStore";
import { getPartnerEarnings } from "@/services/financeService";
import { add, subtract, multiply, divide, formatMoney } from "@/lib/math";
import type { BusinessPersona, ExpenseCategory } from "@/types";
import { useBalances } from "@/lib/ledger/useBalances";
import { useStock } from "@/lib/ledger/useStock";
import { CapitalEquityPage } from "@/components/finance/CapitalEquityPage";
import { ownershipFits, totalOwnership, activePartners, isPartnerArchived } from "@/lib/partners";
import { PartnerRemovalDialog } from "@/components/finance/PartnerRemovalDialog";
import { OwnerBudgetCard } from "@/components/finance/OwnerBudgetCard";
import { FinancialReportsPage } from "@/components/finance/FinancialReportsPage";
import { SHIPPING_SUBJECTS } from "@/lib/ledger/reports";
import { appendEvent } from "@/lib/ledger";
import { buildExpenseLines } from "@/lib/ledger/expenses";
import type { WalletType } from "@/types";
import { WALLET_LABELS, PARTNER_KIND_LABELS, PARTNER_KIND_HINTS } from "@/types";
import type { PartnerKind, Partner } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// ── Constants ────────────────────────────────────────────────────

/** Smart category labels per persona */
const CATEGORIES: Record<BusinessPersona, { value: ExpenseCategory; label: string }[]> = {
  retail: [
    { value: "store_rent", label: "إيجار الفروع" },
    { value: "shipping", label: "مصاريف شحن وتوصيل" },
    { value: "marketing", label: "تسويق وإعلانات" },
    { value: "office_supplies", label: "نثريات وضيافة" },
    { value: "utilities", label: "فواتير" },
    { value: "transport", label: "نقل" },
    { value: "maintenance", label: "صيانة" },
    { value: "other", label: "أخرى" },
  ],
  ecommerce: [
    { value: "shipping", label: "مصاريف شحن وتوصيل" },
    { value: "marketing", label: "تسويق وإعلانات" },
    { value: "office_supplies", label: "نثريات وضيافة" },
    { value: "utilities", label: "فواتير" },
    { value: "transport", label: "نقل" },
    { value: "maintenance", label: "صيانة" },
    { value: "other", label: "أخرى" },
  ],
};

const CATEGORY_ICONS: Record<string, React.ElementType> = {
  rent: Building2,
  store_rent: Store,
  utilities: Zap,
  salaries: Users,
  transport: Truck,
  maintenance: Wrench,
  marketing: Megaphone,
  office_supplies: Coffee,
  shipping: Truck,
};

// ── Helper: gauge colour ─────────────────────────────────────────

function gaugeColor(pct: number): string {
  if (pct >= 100) return "bg-red-500";
  if (pct >= 80) return "bg-yellow-500";
  return "bg-green-500";
}

function gaugeBg(pct: number): string {
  if (pct >= 100) return "bg-red-100";
  if (pct >= 80) return "bg-yellow-100";
  return "bg-green-100";
}

function gaugeLabel(pct: number): string {
  if (pct >= 100) return "ميزانية مخترقة";
  if (pct >= 80) return "تنبيه بقرب نفاد الميزانية";
  return "";
}

// ── Persona terminology ─────────────────────────────────────────

const PERSONA_TERMINOLOGY = {
  retail: {
    mainChartTitle: "حركة المبيعات اليومية",
    kpiSectionTitle: "مؤشرات المبيعات",
    expenseSectionTitle: "المصروفات التشغيلية للفروع",
    budgetSectionTitle: "الرقابة على الميزانية",
    assetSectionTitle: "الأصول الثابتة",
    assetSubLabel: "أصول المحل",
  },
  ecommerce: {
    mainChartTitle: "حركة الطلبات الإلكترونية",
    kpiSectionTitle: "مؤشرات المتجر الإلكتروني",
    expenseSectionTitle: "مصروفات التشغيل",
    budgetSectionTitle: "الرقابة على الميزانية",
    assetSectionTitle: "الأصول الثابتة",
    assetSubLabel: "أصول المتجر الإلكتروني",
  },
};

// ── Persona KPI card definitions ────────────────────────────────

/**
 * What the KPI cards are allowed to read: ledger SUMs and nothing else.
 *
 * It used to be `ReturnType<typeof computeFinancials>`, and `computeFinancials`
 * called `getTotalSales()` / `getOperatingExpenses()` / `getShippingRevenues()`
 * — store tallies that no live path has written since the ledger conversion.
 * Naming the shape here means a card cannot quietly reach for one again.
 */
interface LedgerSummary {
  /** SUM(revenue) — every channel, net of returns. */
  sales: number;
  /** SUM(revenue) for subject `pos`. */
  posSales: number;
  /** SUM(cogs). */
  cogs: number;
  /** SUM(expense) — running costs, جرد shrinkage and courier return fees. */
  opEx: number;
  /** The shipping slice of `opEx`. A SUBSET, never an extra deduction. */
  shippingCost: number;
  /** sales − cogs − opEx. */
  profit: number;
  /** SUM(receivable_client) — unpaid wholesale credit. */
  receivableClient: number;
  /** Total value of inventory on hand at cost. */
  inventoryValue: number;
  /** SUM(wallet) across all wallets. */
  walletsTotal: number;
}

const PERSONA_KPI_CONFIG: Record<
  BusinessPersona,
  Array<{
    key: string;
    label: string;
    sublabel: string;
    icon: React.ElementType;
    bgClass: string;
    iconBg: string;
    iconColor: string;
    valueColor: string;
    compute: (ls: LedgerSummary) => string;
  }>
> = {
  retail: [
    {
      key: "pos",
      label: "مبيعات نقطة البيع",
      sublabel: "SUM(revenue) للقناة pos",
      icon: DollarSign,
      bgClass: "from-emerald-500/10",
      iconBg: "bg-green-100",
      iconColor: "text-green-600",
      valueColor: "text-green-600",
      // Was `sales * 0.6` — an invented 60/40 cash-vs-card split presented as
      // a takings figure. The channel is on the revenue line already.
      compute: (ls) => formatMoney(ls.posSales),
    },
    {
      key: "otherChannels",
      label: "مبيعات أونلاين وجملة",
      sublabel: "إجمالي المبيعات − نقطة البيع",
      icon: Wallet,
      bgClass: "from-blue-500/10",
      iconBg: "bg-blue-100",
      iconColor: "text-blue-600",
      valueColor: "text-blue-600",
      // Was `sales * 0.4`, the other half of the same invented split.
      compute: (ls) => formatMoney(ls.sales - ls.posSales),
    },
    {
      key: "branchExpenses",
      label: "المصروفات التشغيلية للفروع",
      sublabel: "إيجار + رواتب + فواتير",
      icon: Store,
      bgClass: "from-orange-500/10",
      iconBg: "bg-orange-100",
      iconColor: "text-orange-600",
      valueColor: "text-orange-600",
      compute: (ls) => formatMoney(ls.opEx),
    },
    {
      key: "netRetail",
      label: "صافي ربح التجزئة",
      sublabel: "المبيعات - (COGS + مصروفات)",
      icon: PiggyBank,
      bgClass: "from-primary/10",
      iconBg: "bg-white/30",
      iconColor: "text-primary-foreground",
      valueColor: "",
      compute: (ls) =>
        ls.profit >= 0 ? formatMoney(ls.profit) : `-${formatMoney(Math.abs(ls.profit))}`,
    },
    {
      key: "wholesaleDebts",
      label: "ديون مستحقة (عملاء الجملة)",
      sublabel: "أرصدة عملاء الجملة الآجلة",
      icon: TrendingUp,
      bgClass: "from-amber-500/10",
      iconBg: "bg-amber-100",
      iconColor: "text-amber-600",
      valueColor: "text-amber-600",
      compute: (ls) => formatMoney(ls.receivableClient),
    },
    {
      key: "totalAssets",
      label: "إجمالي أصول الشركة",
      sublabel: "خزائن + مخزون + ديون",
      icon: Landmark,
      bgClass: "from-purple-500/10",
      iconBg: "bg-purple-100",
      iconColor: "text-purple-600",
      valueColor: "text-purple-600",
      compute: (ls) => formatMoney(ls.walletsTotal + ls.inventoryValue + ls.receivableClient),
    },
  ],
  ecommerce: [
    {
      key: "onlineRevenue",
      label: "إيرادات الطلبات الإلكترونية",
      sublabel: "الطلبات المدفوعة والمتبقية",
      icon: DollarSign,
      bgClass: "from-emerald-500/10",
      iconBg: "bg-green-100",
      iconColor: "text-green-600",
      valueColor: "text-green-600",
      compute: (ls) => formatMoney(ls.sales),
    },
    {
      key: "shippingCost",
      label: "تكلفة الشحن",
      sublabel: "مصاريف مرتجعات الشحن — التوصيل بيتحصّل من العميل",
      icon: Truck,
      bgClass: "from-blue-500/10",
      iconBg: "bg-blue-100",
      iconColor: "text-blue-600",
      valueColor: "text-blue-600",
      // Was `getShippingRevenues() - getShippingExpensesTotal()` — two store
      // counters no live path writes, beside a ledger that already carries the
      // real thing. There is no "shipping profit" to report: per the schema's
      // who-bears-the-fee table a delivery fee arrives inside the COD and
      // leaves as a debt to the courier, so it is neither revenue nor cost. A
      // RETURN is the shop's only shipping expense, and it is an `expense`
      // line — which means it is already inside opEx and is only split out
      // here, never added on top.
      compute: (ls) => formatMoney(ls.shippingCost),
    },
    {
      key: "operatingExpenses",
      label: "مصروفات التشغيل",
      sublabel: "شحن + تسويق + فواتير + صيانة",
      icon: TrendingDown,
      bgClass: "from-orange-500/10",
      iconBg: "bg-orange-100",
      iconColor: "text-orange-600",
      valueColor: "text-orange-600",
      compute: (ls) => formatMoney(ls.opEx),
    },
    {
      key: "netEcommerce",
      label: "صافي ربح المتجر الإلكتروني",
      sublabel: "الإيرادات - إجمالي التكاليف",
      icon: PiggyBank,
      bgClass: "from-primary/10",
      iconBg: "bg-white/30",
      iconColor: "text-primary-foreground",
      valueColor: "",
      compute: (ls) =>
        ls.profit >= 0 ? formatMoney(ls.profit) : `-${formatMoney(Math.abs(ls.profit))}`,
    },
    {
      key: "wholesaleDebts",
      label: "ديون مستحقة (عملاء الجملة)",
      sublabel: "أرصدة عملاء الجملة الآجلة",
      icon: TrendingUp,
      bgClass: "from-amber-500/10",
      iconBg: "bg-amber-100",
      iconColor: "text-amber-600",
      valueColor: "text-amber-600",
      compute: (ls) => formatMoney(ls.receivableClient),
    },
    {
      key: "totalAssets",
      label: "إجمالي أصول الشركة",
      sublabel: "خزائن + مخزون + ديون",
      icon: Landmark,
      bgClass: "from-purple-500/10",
      iconBg: "bg-purple-100",
      iconColor: "text-purple-600",
      valueColor: "text-purple-600",
      compute: (ls) => formatMoney(ls.walletsTotal + ls.inventoryValue + ls.receivableClient),
    },
  ],
};

// ── Main Component ───────────────────────────────────────────────

export function PartnersFinancePage() {
  const {
    partners,
    partnerLedger,
    partnershipEnabled,
    businessMode,
    addPartner,
    updatePartner,
    restorePartner,
    addCapitalContribution,
    transactions,
  } = useBusinessStore();
  const persona: BusinessPersona = businessMode === "ecommerce" ? "ecommerce" : "retail";

  const financialStore = useFinancialStore();
  const {
    expenses,
    payroll,
    assets,
    budgetCaps,
    addExpense,
    removeExpense,
    addPayroll,
    removePayroll,
    addAsset,
    removeAsset,
    toggleAsset,
    setBudgetCap,
    removeBudgetCap,
    getMonthlyDepreciationExpense,
    getBudgetSpending,
    getCategorySpending,
  } = financialStore;

  // ── Reactive income statement ──
  // No `getTotalSales()` here any more: it summed the `transactions` store,
  // which a POS sale has not written since the ledger conversion. Sales are
  // SUM(revenue) below.
  // The real figure: SUM(cogs) over the ledger, booked at each sale from the
  // cost actually paid on توريد. Covers POS, wholesale and e-commerce together.
  const { total: totalCOGS, error: cogsError } = useBalances("cogs");
  // Sales and operating costs from the ledger, not from stores.
  // `getTotalSales()` summed the `transactions` store (which a POS sale has not
  // written since the ledger conversion), the wholesale invoice documents and a
  // financial-store array — three parallel tallies, none of them the truth.
  // SUM(revenue) already covers POS, wholesale and e-commerce, and carries
  // returns as negatives. SUM(expense) covers what was just wired above plus
  // جرد shrinkage and courier return fees.
  const { total: ledgerSales, error: salesError, amountOf: revenueOf } = useBalances("revenue");
  const { total: ledgerExpenses, error: expenseError, amountOf: expenseOf, refresh: refreshExpenses } = useBalances("expense");
  const { refresh: refreshWallets, amountOf: walletAmountOf } = useBalances("wallet");
  const { total: receivableClientTotal } = useBalances("receivable_client");
  const { total: inventoryValue } = useBalances("stock");
  
  const walletsTotal = (Object.keys(WALLET_LABELS) as WalletType[]).reduce(
    (sum, w) => sum + walletAmountOf(w),
    0
  );

  const hasOpeningBalance = (Object.keys(WALLET_LABELS) as WalletType[]).some(
    (w) => walletAmountOf(w) !== 0,
  );
  const [activeFinanceTab, setActiveFinanceTab] = useState("finance");
  const [ownershipError, setOwnershipError] = useState<string | null>(null);
  const [pendingPartnerRemoval, setPendingPartnerRemoval] = useState<Partner | null>(null);
  // Operating costs are SUM(expense) below — the account the expense/payroll
  // events now write, plus جرد shrinkage and courier return fees.
  const monthlyDepreciation = useMemo(() => getMonthlyDepreciationExpense(), [assets]);
  // The shipping slice of SUM(expense) — the SAME rows opEx already counts,
  // grouped differently. Splitting it out of one total is what makes it
  // impossible to double-count, which two parallel store counters were not.
  const shippingCost = SHIPPING_SUBJECTS.reduce((sum, subject) => sum + expenseOf(subject), 0);

  // Force reactive re-read helpers on every render via a counter subscription
  // We use useBusinessStore and useFinancialStore directly so Zustand triggers re-renders.
  const busTrigger = useBusinessStore(
    (s) => s.transactions.length + s.wholesaleInvoices.length + s.products.length,
  );
  const finTrigger = useFinancialStore(
    (s) => s.expenses.length + s.payroll.length + s.assets.length + s.budgetCaps.length,
  );

  // Re-read helpers each render so computed values stay fresh
  const ls = useMemo(() => {
    void busTrigger;
    void finTrigger;
    return {
      sales: ledgerSales,
      posSales: revenueOf("pos"),
      cogs: totalCOGS,
      opEx: ledgerExpenses,
      shippingCost,
      // The whole formula, from three ledger SUMs. Nothing stored, nothing
      // guessed, and no term counted twice — `shippingCost` is a slice of
      // `opEx`, not a fourth deduction. Depreciation is deliberately absent:
      // it is non-cash, so it lives as a memo on the reports tab (§3.12).
      profit: ledgerSales - totalCOGS - ledgerExpenses,
      receivableClient: receivableClientTotal,
      inventoryValue: inventoryValue,
      walletsTotal: walletsTotal,
    };
  }, [busTrigger, finTrigger, totalCOGS, ledgerSales, ledgerExpenses, revenueOf, shippingCost, receivableClientTotal, inventoryValue, walletsTotal]);

  // ── Partner earnings map ──
  const partnerEarningsMap = useMemo(() => {
    const map: Record<string, { totalEarnings: number; transactionCount: number }> = {};
    for (const p of partners) map[p.id] = getPartnerEarnings(p.id, partnerLedger);
    return map;
  }, [partners, partnerLedger]);

  // ── Dialogs state ──
  const [isExpenseOpen, setIsExpenseOpen] = useState(false);
  const [expenseTab, setExpenseTab] = useState<"expense" | "payroll">("expense");
  // Which wallet the money actually leaves. Manual wallets (§3.6a) — the owner
  // says which one paid; nothing is imported from a bank or a gateway.
  const [expenseWallet, setExpenseWallet] = useState<WalletType>("inStoreSafe");
  const [spendError, setSpendError] = useState<string | null>(null);
  const [expenseForm, setExpenseForm] = useState({
    category: "",
    amount: "",
    description: "",
    date: new Date().toISOString().slice(0, 10),
  });
  const [payrollForm, setPayrollForm] = useState({
    employeeName: "",
    type: "salary" as "salary" | "bonus" | "advance",
    amount: "",
    description: "",
    date: new Date().toISOString().slice(0, 10),
  });

  const [overBudgetAlert, setOverBudgetAlert] = useState<{
    category: string;
    cap: number;
    current: number;
  } | null>(null);

  const [isPartnerOpen, setIsPartnerOpen] = useState(false);
  const [partnerForm, setPartnerForm] = useState({
    name: "",
    // Required at registration: it is what makes شريك and مساهم different.
    kind: "working" as PartnerKind,
    equityPercentage: "",
    capitalContribution: "",
  });
  const [isCapitalOpen, setIsCapitalOpen] = useState(false);
  const [capitalPartnerId, setCapitalPartnerId] = useState("");
  const [capitalAmount, setCapitalAmount] = useState("");

  const [isBudgetOpen, setIsBudgetOpen] = useState(false);
  const [budgetForm, setBudgetForm] = useState({ category: "", capAmount: "" });

  const [isAssetOpen, setIsAssetOpen] = useState(false);
  const [assetForm, setAssetForm] = useState({ 
    name: "", 
    purchaseValue: "", 
    salvageValue: "",
    usefulLifeYears: "",
    purchaseDate: new Date().toISOString().slice(0, 10),
    paymentSource: "prepaid" // "prepaid" or wallet string
  });

  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  // Archived people are hidden by default but never lost — this shows them
  // with their own badge and the way back.
  const [showArchivedPartners, setShowArchivedPartners] = useState(false);
  // Archived part-owners leave the list. Their record survives for past
  // reports; they are no longer a claim on the business.
  const livePartners = useMemo(() => partners.filter((p) => !isPartnerArchived(p)), [partners]);
  const archivedPartners = useMemo(() => partners.filter(isPartnerArchived), [partners]);
  const filteredPartners = useMemo(() => {
    if (showArchivedPartners) return archivedPartners;
    return statusFilter === "all"
      ? livePartners
      : livePartners.filter((p) => p.status === statusFilter);
  }, [livePartners, archivedPartners, showArchivedPartners, statusFilter]);

  // Only active claims. An archived (or inactive) part-owner's capital is not
  // part of the business's active capital any more — that was the reported
  // bug: a "deleted" partner's contribution kept counting here forever.
  const totalCapital = useMemo(
    () => activePartners(partners).reduce((s, p) => add(s, p.capitalContribution || 0), 0),
    [partners],
  );

  // ── Category list for current persona ──
  const personaCategories = CATEGORIES[persona] || CATEGORIES.retail;
  const terms = PERSONA_TERMINOLOGY[persona];

  // ── Handlers ──
  const handleAddExpense = async () => {
    const amount = parseFloat(expenseForm.amount);
    if (!amount || amount <= 0 || !expenseForm.category) return;

    // ONE event first: the cost and the cash that paid it, together. Recording
    // the document without this is what let the till keep the rent money.
    setSpendError(null);
    try {
      await appendEvent({
        kind: "expense",
        actor: "مصروف",
        refType: "expense",
        payload: {
          category: expenseForm.category,
          description: expenseForm.description || undefined,
          wallet: expenseWallet,
        },
        occurredAt: new Date(expenseForm.date),
        lines: buildExpenseLines({
          category: expenseForm.category,
          amount,
          wallet: expenseWallet,
        }),
      });
    } catch (e) {
      // Nothing was written, so no document is recorded either — a listed
      // expense with no money behind it is the drift being deleted everywhere.
      setSpendError(
        `المصروف متسجّلش، ومفيش فلوس اتحركت. ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    refreshWallets();
    refreshExpenses();

    const result = addExpense({
      category: expenseForm.category as ExpenseCategory,
      amount,
      description: expenseForm.description || undefined,
      date: new Date(expenseForm.date),
    });
    if (!result.success) {
      setOverBudgetAlert({
        category: expenseForm.category,
        cap: result.capAmount,
        current: result.currentTotal,
      });
      return;
    }
    setExpenseForm({
      category: "",
      amount: "",
      description: "",
      date: new Date().toISOString().slice(0, 10),
    });
    setIsExpenseOpen(false);
  };

  const handleAddPayroll = async () => {
    const amount = parseFloat(payrollForm.amount);
    if (!amount || amount <= 0 || !payrollForm.employeeName) return;

    // A salary is an operating expense with a name on it: same two lines,
    // different event kind.
    setSpendError(null);
    try {
      await appendEvent({
        kind: "payroll",
        actor: "مرتبات",
        refType: "payroll",
        payload: {
          employeeName: payrollForm.employeeName,
          type: payrollForm.type,
          wallet: expenseWallet,
        },
        occurredAt: new Date(payrollForm.date),
        lines: buildExpenseLines({ category: "salaries", amount, wallet: expenseWallet }),
      });
    } catch (e) {
      setSpendError(
        `المرتب متسجّلش، ومفيش فلوس اتحركت. ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    refreshWallets();
    refreshExpenses();

    addPayroll({
      employeeName: payrollForm.employeeName,
      type: payrollForm.type,
      amount,
      description: payrollForm.description || undefined,
      date: new Date(payrollForm.date),
    });
    setPayrollForm({
      employeeName: "",
      type: "salary",
      amount: "",
      description: "",
      date: new Date().toISOString().slice(0, 10),
    });
    setIsExpenseOpen(false);
  };

  const handleAddPartner = () => {
    const equity = parseFloat(partnerForm.equityPercentage);
    const capital = parseFloat(partnerForm.capitalContribution) || 0;
    if (!partnerForm.name || isNaN(equity) || equity < 0 || equity > 100) return;
    // A shop has ONE hundred per cent. The two separate lists each checked
    // their own total, so 100% partners + 100% shareholders used to pass.
    if (!ownershipFits(partners, equity)) {
      setOwnershipError(
        `النسب المتاحة ${100 - totalOwnership(partners)}% بس — المسجّل حالياً ${totalOwnership(partners)}%.`,
      );
      return;
    }
    setOwnershipError(null);
    addPartner({
      name: partnerForm.name,
      kind: partnerForm.kind,
      equityPercentage: equity,
      capitalContribution: capital,
      joinedDate: new Date(),
      status: "active",
    } as any);
    setPartnerForm({ name: "", kind: "working", equityPercentage: "", capitalContribution: "" });
    setIsPartnerOpen(false);
  };

  const handleCapitalContribution = () => {
    const amount = parseFloat(capitalAmount);
    if (!capitalPartnerId || !amount || amount <= 0) return;
    addCapitalContribution(capitalPartnerId, amount);
    setCapitalPartnerId("");
    setCapitalAmount("");
    setIsCapitalOpen(false);
  };

  const handleAddAsset = async () => {
    const pv = parseFloat(assetForm.purchaseValue);
    const salvage = parseFloat(assetForm.salvageValue) || 0;
    const life = parseFloat(assetForm.usefulLifeYears);
    const pDate = new Date(assetForm.purchaseDate);
    if (!assetForm.name || !pv || pv <= 0 || !life || life <= 0 || isNaN(pDate.getTime())) return;
    
    if (assetForm.paymentSource !== "prepaid") {
      setSpendError(null);
      try {
        await appendEvent({
          kind: "expense",
          actor: "أصول",
          refType: "fixed_asset",
          payload: {
            category: "assets",
            description: `شراء أصل ثابت: ${assetForm.name}`,
            wallet: assetForm.paymentSource,
          },
          occurredAt: pDate,
          lines: buildExpenseLines({
            category: "assets",
            amount: pv,
            wallet: assetForm.paymentSource,
          }),
        });
      } catch (e) {
        setSpendError(
          `فشلت عملية شراء الأصل، لم يتم خصم المبلغ من الخزينة. ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      refreshWallets();
      refreshExpenses();
    }

    addAsset({
      name: assetForm.name,
      purchaseValue: pv,
      salvageValue: salvage,
      usefulLifeYears: life,
      purchaseDate: pDate,
      isActive: true,
    });
    setAssetForm({ 
      name: "", 
      purchaseValue: "", 
      salvageValue: "", 
      usefulLifeYears: "", 
      purchaseDate: new Date().toISOString().slice(0, 10), 
      paymentSource: "prepaid" 
    });
    setIsAssetOpen(false);
  };

  const handleSetBudget = () => {
    const cap = parseFloat(budgetForm.capAmount);
    if (!budgetForm.category || !cap || cap <= 0) return;
    setBudgetCap(budgetForm.category, cap);
    setBudgetForm({ category: "", capAmount: "" });
    setIsBudgetOpen(false);
  };

  // ── All unique categories with spending ──
  const budgetSummary = useMemo(() => {
    const seen = new Set<string>();
    const allCats = [...personaCategories.map((c) => c.value)];
    // Also include any category that has budget caps or expenses
    for (const e of expenses)
      if (!seen.has(e.category)) {
        seen.add(e.category);
      }
    for (const b of budgetCaps)
      if (!seen.has(b.category)) {
        seen.add(b.category);
      }
    return [...new Set([...allCats, ...seen])].map((cat) => {
      const icon = CATEGORY_ICONS[cat] || CircleDollarSign;
      const label = personaCategories.find((c) => c.value === cat)?.label || cat;
      const spent = getCategorySpending(cat);
      const bc = budgetCaps.find((b) => b.category === cat);
      return {
        cat,
        label,
        icon,
        spent,
        cap: bc?.capAmount ?? 0,
        pct: bc && bc.capAmount > 0 ? divide(spent, bc.capAmount) * 100 : 0,
      };
    });
  }, [personaCategories, expenses, payroll, budgetCaps, finTrigger]);

  return (
    <div className="space-y-6">
      {/* A failed COGS read must never render as "cost = 0", because that shows
          up as profit. Same rule the ledger hooks hold for stock and wallets:
          say the number is unavailable rather than print a flattering zero. */}
      {cogsError && (
        <div className="rounded-2xl border border-red-300 bg-red-50 p-4 flex items-start gap-3">
          <Ban className="size-5 text-red-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-bold text-red-900">تعذر حساب تكلفة المبيعات من الدفتر</p>
            <p className="text-sm text-red-700 mt-1">
              أرقام التكلفة والأرباح تحت مش كاملة — متاخدش قرار عليها لحد ما المشكلة تتحل.
            </p>
          </div>
        </div>
      )}
      {overBudgetAlert && (
        <div className="rounded-2xl border border-red-300 bg-red-50 p-6 flex items-start gap-4">
          <Ban className="size-6 text-red-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-bold text-red-900">تجاوز سقف الميزانية</p>
            <p className="text-sm text-red-700 mt-1">
              الميزانية المخصصة لـ &laquo;{overBudgetAlert.category}&raquo; هي{" "}
              {formatMoney(overBudgetAlert.cap)}. المصروفات الحالية{" "}
              {formatMoney(overBudgetAlert.current)}. لا يمكن تجاوز الحد المسموح.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setOverBudgetAlert(null)}
            >
              حسناً
            </Button>
          </div>
        </div>
      )}

      <Tabs value={activeFinanceTab} onValueChange={setActiveFinanceTab} className="space-y-6">
        <TabsList>
          <TabsTrigger value="finance">
            <DollarSign className="size-4 ml-2" />
            المالية العامة
          </TabsTrigger>
          <TabsTrigger value="partners">
            <Users className="size-4 ml-2" />
            الشركاء ورأس المال
          </TabsTrigger>
          {/* The opening-balance / transfer / capital screen. It was built and
              then had ZERO importers — the owner could not open it at all, so
              she had no way to tell the app what is really in her wallets. It
              belongs here because §3.6 calls this screen
              "الشركاء والمالية / رأس المال". */}
          <TabsTrigger value="capital">
            <Wallet className="size-4 ml-2" />
            الأرصدة الافتتاحية والتحويلات
          </TabsTrigger>
          {/* §3.12. A tab rather than its own sidebar entry: it reads the same
              accounts the cards above do, and the owner compares the two. */}
          <TabsTrigger value="reports">
            <FileBarChart className="size-4 ml-2" />
            التقارير المالية
          </TabsTrigger>
        </TabsList>

        {/* ════════════════════ TAB 1: GENERAL FINANCE ════════════════════ */}
        <TabsContent value="finance" className="space-y-6">
          {/* First thing a real shop does: tell the app what is actually in the
              wallets today. Until that happens every figure on this screen is
              measured from zero, so the prompt sits above the numbers rather
              than waiting to be discovered in a tab. It disappears on its own
              once any wallet has been opened. */}
          {!hasOpeningBalance && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 p-4 flex items-start gap-3 flex-wrap">
              <Wallet className="size-5 text-amber-600 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                  ابدئي بتسجيل الأرصدة الافتتاحية
                </p>
                <p className="text-sm text-amber-900 dark:text-amber-300 mt-1">
                  سجّلي اللي موجود فعلاً دلوقتي في الخزينة وفودافون كاش وانستا باي والحساب البنكي.
                  من غير كده كل الأرقام هنا محسوبة من صفر، مش من الحقيقة.
                </p>
              </div>
              <Button size="sm" onClick={() => setActiveFinanceTab("capital")}>
                تسجيل الأرصدة الافتتاحية
              </Button>
            </div>
          )}

          {/* Personal draws are not operating costs, so the budget sits on its
              own card rather than inside المصروفات. */}
          <OwnerBudgetCard />

          {/* ── Dynamic Persona KPI Cards ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {PERSONA_KPI_CONFIG[persona].map((kpi) => {
              const Icon = kpi.icon;
              const val = kpi.compute(ls);
              const isNegative = val.startsWith("-");
              return (
                <div
                  key={kpi.key}
                  className="rounded-2xl border border-border/60 bg-card/80 backdrop-blur-sm p-6 shadow-sm"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div
                      className={`size-10 rounded-xl flex items-center justify-center ${kpi.iconBg}`}
                    >
                      <Icon className={`size-5 ${kpi.iconColor}`} />
                    </div>
                    <span className="text-xs font-medium text-muted-foreground">{kpi.label}</span>
                  </div>
                  <p
                    className={`text-2xl font-bold ${kpi.valueColor || (isNegative ? "text-red-600" : "text-green-600")}`}
                  >
                    {val}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">{kpi.sublabel}</p>
                </div>
              );
            })}
          </div>

          {/* ── Budget Caps Gauges ── */}
          {budgetSummary.some((b) => b.cap > 0) && (
            <div className="rounded-2xl border border-border bg-card p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="size-10 rounded-xl flex items-center justify-center bg-purple-100">
                    <Gauge className="size-5 text-purple-600" />
                  </div>
                  <div>
                    <p className="text-xs tracking-wider text-muted-foreground">
                      {terms.budgetSectionTitle}
                    </p>
                    <h3 className="font-display text-xl font-bold mt-1">سقف الميزانية الشهري</h3>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setBudgetForm({ category: "", capAmount: "" });
                    setIsBudgetOpen(true);
                  }}
                >
                  <Plus className="size-4 ml-2" /> تحديد سقف
                </Button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {budgetSummary
                  .filter((b) => b.cap > 0)
                  .map((b) => {
                    const Icon = b.icon;
                    return (
                      <div key={b.cat} className="p-4 rounded-xl border border-border bg-muted/30">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <Icon className="size-4 text-muted-foreground" />
                            <span className="text-sm font-medium">{b.label}</span>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatMoney(b.spent)} / {formatMoney(b.cap)}
                          </div>
                        </div>
                        <div className={`h-2.5 rounded-full overflow-hidden ${gaugeBg(b.pct)}`}>
                          <div
                            className={`h-full rounded-full transition-all ${gaugeColor(b.pct)}`}
                            style={{ width: `${Math.min(b.pct, 100)}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-xs text-muted-foreground">{b.pct.toFixed(0)}%</span>
                          {b.pct >= 80 && (
                            <span
                              className="flex items-center gap-1 text-xs font-medium"
                              style={{
                                color:
                                  b.pct >= 100 ? "var(--color-red-600)" : "var(--color-yellow-600)",
                              }}
                            >
                              <AlertTriangle className="size-3" /> {gaugeLabel(b.pct)}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* ── Expense & Payroll Logger ── */}
          <div className="rounded-2xl border border-border bg-card p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="size-10 rounded-xl flex items-center justify-center bg-orange-100">
                  <HandCoins className="size-5 text-orange-600" />
                </div>
                <div>
                  <p className="text-xs tracking-wider text-muted-foreground">
                    {terms.expenseSectionTitle}
                  </p>
                  <h3 className="font-display text-xl font-bold mt-1">تسجيل مصروف / راتب</h3>
                </div>
              </div>
              <Button
                onClick={() => {
                  setExpenseTab("expense");
                  setExpenseForm({
                    category: "",
                    amount: "",
                    description: "",
                    date: new Date().toISOString().slice(0, 10),
                  });
                  setIsExpenseOpen(true);
                }}
              >
                <Plus className="size-4 ml-2" />+ تسجيل مصروف / راتب
              </Button>
            </div>

            {/* Recent expenses + payroll */}
            <div className="mt-6">
              <h4 className="font-semibold mb-3">{terms.mainChartTitle}</h4>
              {expenses.length === 0 && payroll.length === 0 ? (
                <div className="py-8">
                  <EmptyState icon={Inbox} title="لا توجد معاملات مسجلة بعد" />
                </div>
              ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {[...expenses, ...payroll.map((p) => ({ ...p, _type: "payroll" as const }))]
                    .sort(
                      (a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime(),
                    )
                    .slice(0, 20)
                    .map((entry: any) => {
                      const isPayroll = entry._type === "payroll";
                      const catLabel =
                        personaCategories.find((c) => c.value === entry.category)?.label ||
                        entry.category ||
                        "راتب";
                      return (
                        <div
                          key={entry.id}
                          className="flex items-center justify-between p-3 rounded-xl border border-border bg-muted/30"
                        >
                          <div className="flex items-center gap-3">
                            <div
                              className={`size-8 rounded-lg flex items-center justify-center ${isPayroll ? "bg-blue-100" : "bg-red-100"}`}
                            >
                              {isPayroll ? (
                                <Users className="size-4 text-blue-600" />
                              ) : (
                                <TrendingDown className="size-4 text-red-600" />
                              )}
                            </div>
                            <div>
                              <p className="text-sm font-medium">
                                {isPayroll ? `راتب: ${entry.employeeName}` : catLabel}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {new Date(entry.date).toLocaleDateString("ar-EG")}
                                {entry.description ? ` - ${entry.description}` : ""}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-sm text-red-600">
                              -{formatMoney(entry.amount)}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 text-muted-foreground hover:text-destructive"
                              onClick={() => {
                                isPayroll ? removePayroll(entry.id) : removeExpense(entry.id);
                              }}
                            >
                              <Trash2 className="size-3" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          </div>

          {/* ── Fixed Asset Depreciation Calculator ── */}
          <div className="rounded-2xl border border-border bg-card p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="size-10 rounded-xl flex items-center justify-center bg-indigo-100">
                  <Building2 className="size-5 text-indigo-600" />
                </div>
                <div>
                  <p className="text-xs tracking-wider text-muted-foreground">
                    {terms.assetSectionTitle}
                  </p>
                  <h3 className="font-display text-xl font-bold mt-1">إهلاك الأصول الثابتة</h3>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setAssetForm({ 
                    name: "", 
                    purchaseValue: "", 
                    salvageValue: "", 
                    usefulLifeYears: "", 
                    purchaseDate: new Date().toISOString().slice(0, 10), 
                    paymentSource: "prepaid" 
                  });
                  setIsAssetOpen(true);
                }}
              >
                <Plus className="size-4 ml-2" /> إضافة أصل
              </Button>
            </div>

            {assets.length === 0 ? (
              <div className="py-6">
                <EmptyState
                  icon={Building2}
                  title="لا توجد أصول ثابتة مسجلة"
                  description="أضف أصلاً لبدء حساب الإهلاك الشهري."
                />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right px-4">الأصل</TableHead>
                    <TableHead className="text-center px-4">قيمة الشراء</TableHead>
                    <TableHead className="text-center px-4">العمر الافتراضي</TableHead>
                    <TableHead className="text-center px-4">الإهلاك الشهري</TableHead>
                    <TableHead className="text-center px-4">الحالة</TableHead>
                    <TableHead className="text-center px-4"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assets.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="font-medium px-4 whitespace-nowrap">{a.name}</TableCell>
                      <TableCell className="text-center px-4 font-mono whitespace-nowrap">
                        {formatMoney(a.purchaseValue)}
                      </TableCell>
                      <TableCell className="text-center px-4 whitespace-nowrap">
                        {a.usefulLifeYears} سنة
                      </TableCell>
                      <TableCell className="text-center px-4 font-mono text-indigo-600 whitespace-nowrap">
                        {formatMoney(a.monthlyDepreciation)}
                      </TableCell>
                      <TableCell className="text-center px-4">
                        <Badge variant={a.isActive ? "default" : "secondary"}>
                          {a.isActive ? "نشط" : "مستبعد"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center px-4">
                        <div className="flex items-center justify-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            onClick={() => toggleAsset(a.id)}
                          >
                            <BadgePercent className="size-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-destructive"
                            onClick={() => removeAsset(a.id)}
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-muted/50 font-semibold">
                    <TableCell className="px-4">الإجمالي</TableCell>
                    <TableCell className="text-center px-4 whitespace-nowrap">
                      {formatMoney(assets.reduce((s, a) => add(s, a.purchaseValue), 0))}
                    </TableCell>
                    <TableCell className="text-center px-4"></TableCell>
                    <TableCell className="text-center px-4 text-indigo-600 whitespace-nowrap">
                      {formatMoney(monthlyDepreciation)}
                    </TableCell>
                    <TableCell colSpan={2} />
                  </TableRow>
                </TableBody>
              </Table>
            )}

            {/* This used to promise the depreciation was "added to operating
                expenses automatically". It never was, and it must not be: the
                figure is NON-CASH — no wallet moves — so writing it as a
                ledger event would need a monthly posting job whose second run
                would permanently overstate cost in an append-only ledger.
                It is reported as a memo instead, here and on التقارير المالية,
                where the P&L states the profit after it. */}
            {monthlyDepreciation > 0 && (
              <div className="mt-4 p-4 rounded-xl bg-blue-50 border border-blue-200">
                <p className="text-sm text-blue-900 font-medium">الإهلاك الشهري المحتسب</p>
                <p className="text-xs text-blue-700 mt-1">
                  {formatMoney(monthlyDepreciation)} شهرياً — دي تكلفة <strong>غير نقدية</strong>،
                  يعني مفيش فلوس بتخرج من المحفظة، فمش متسجّلة كحركة في الدفتر ومش داخلة في «مصروفات
                  التشغيل» فوق. تلاقيها كسطر مستقل في تبويب «التقارير المالية».
                </p>
              </div>
            )}
          </div>
        </TabsContent>

        {/* ════════════════════ TAB 2: PARTNERS & CAPITAL ════════════════════ */}
        <TabsContent value="partners" className="space-y-6">
          {/* ── Partner Stats ── */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="rounded-2xl border border-border bg-card p-6">
              <p className="text-2xl font-bold">{partners.length}</p>
              <p className="text-sm text-muted-foreground mt-1">إجمالي الشركاء</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-6">
              <p className="text-2xl font-bold">{formatMoney(totalCapital)}</p>
              <p className="text-sm text-muted-foreground mt-1">إجمالي رأس المال</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-6">
              <p className="text-2xl font-bold">
                {formatMoney(
                  totalCapital > 0 && activePartners(partners).length > 0
                    ? totalCapital / activePartners(partners).length
                    : 0,
                )}
              </p>
              <p className="text-sm text-muted-foreground mt-1">متوسط المساهمة</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-6">
              <p
                className="text-2xl font-bold"
                style={{
                  color: ls.profit >= 0 ? "var(--color-green-600)" : "var(--color-red-600)",
                }}
              >
                {formatMoney(ls.profit)}
              </p>
              <p className="text-sm text-muted-foreground mt-1">صافي الربح الحالي</p>
            </div>
          </div>

          {/* ── Toolbar ── */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Button
                onClick={() => {
                  setPartnerForm({
                    name: "",
                    kind: "working",
                    equityPercentage: "",
                    capitalContribution: "",
                  });
                  setIsPartnerOpen(true);
                }}
              >
                <UserPlus className="size-4 ml-2" /> إضافة شريك أو مساهم
              </Button>
              {archivedPartners.length > 0 && (
                <Button
                  variant={showArchivedPartners ? "secondary" : "outline"}
                  onClick={() => setShowArchivedPartners((v) => !v)}
                >
                  المؤرشفين ({archivedPartners.length})
                </Button>
              )}
              <Select value={statusFilter} onValueChange={(v: any) => setStatusFilter(v)}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">الكل</SelectItem>
                  <SelectItem value="active">نشط</SelectItem>
                  <SelectItem value="inactive">غير نشط</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* ── Partners Table with dynamic Profit Share ── */}
          <div className="rounded-2xl border border-border bg-card overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right px-4">الاسم</TableHead>
                  <TableHead className="text-center px-4">النوع</TableHead>
                  <TableHead className="text-center px-4">الحالة</TableHead>
                  <TableHead className="text-center px-4">نسبة رأس المال (%)</TableHead>
                  <TableHead className="text-center px-4">رأس المال المدفوع</TableHead>
                  <TableHead className="text-center px-4">الحصة المستحقة من صافي الربح</TableHead>
                  <TableHead className="text-center px-4">إجمالي الأرباح السابقة</TableHead>
                  <TableHead className="text-center px-4">تاريخ الانضمام</TableHead>
                  <TableHead className="text-center px-4"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredPartners.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-muted-foreground py-12">
                      لا يوجد شركاء ولا مساهمين حالياً
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredPartners.map((partner) => {
                    const earnings = partnerEarningsMap[partner.id] || {
                      totalEarnings: 0,
                      transactionCount: 0,
                    };
                    const currentShare = multiply(ls.profit, divide(partner.equityPercentage, 100));
                    return (
                      <TableRow key={partner.id}>
                        <TableCell className="font-medium px-4 whitespace-nowrap">
                          {partner.name}
                          {/* A working partner may be tied to a login; an
                              investor never is. */}
                          {partner.kind === "working" && partner.userId && (
                            <span className="block text-[10px] text-muted-foreground">
                              مربوط بحساب دخول
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-center px-4">
                          <Badge variant={partner.kind === "working" ? "default" : "outline"}>
                            {PARTNER_KIND_LABELS[partner.kind]}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-center px-4">
                          {/* "غير نشط" alone did not say why. An archived
                              person is one who HAS history — that is the whole
                              reason they were not deleted. */}
                          {isPartnerArchived(partner) ? (
                            <Badge variant="outline">مؤرشف — له سجل سابق</Badge>
                          ) : (
                            <Badge variant={partner.status === "active" ? "default" : "secondary"}>
                              {partner.status === "active" ? "نشط" : "غير نشط"}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-center px-4 whitespace-nowrap">
                          {partner.equityPercentage}%
                        </TableCell>
                        <TableCell className="text-center px-4 font-mono whitespace-nowrap">
                          {formatMoney(partner.capitalContribution || 0)}
                        </TableCell>
                        <TableCell
                          className="text-center px-4 font-mono whitespace-nowrap"
                          style={{
                            color:
                              currentShare >= 0 ? "var(--color-green-600)" : "var(--color-red-600)",
                          }}
                        >
                          {formatMoney(currentShare)}
                        </TableCell>
                        <TableCell className="text-center px-4 font-mono text-green-600 whitespace-nowrap">
                          {formatMoney(earnings.totalEarnings)}
                        </TableCell>
                        <TableCell className="text-center px-4 whitespace-nowrap text-sm text-muted-foreground">
                          {new Date(partner.joinedDate).toLocaleDateString("ar-EG")}
                        </TableCell>
                        <TableCell className="text-center px-4">
                          <div className="flex items-center justify-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              title="إضافة مساهمة رأسمالية"
                              onClick={() => {
                                setCapitalPartnerId(partner.id);
                                setCapitalAmount("");
                                setIsCapitalOpen(true);
                              }}
                            >
                              <BadgePercent className="size-4" />
                            </Button>
                            {/* Asks first, and the dialog decides delete vs
                                archive off the ledger — the old button just
                                toggled `status` to "inactive" forever. */}
                            {isPartnerArchived(partner) ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => restorePartner(partner.id)}
                              >
                                استرجاع
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8 text-destructive"
                                title="مسح أو أرشفة"
                                onClick={() => setPendingPartnerRemoval(partner)}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {/* Partnership Status Info */}
          {!partnershipEnabled && (
            <div className="rounded-2xl border border-orange-200 bg-orange-50 p-6">
              <div className="flex items-start gap-3">
                <Users className="size-5 text-orange-600 mt-0.5" />
                <div>
                  <p className="font-semibold text-orange-900">نظام الشراكة غير مفعّل</p>
                  <p className="text-sm text-orange-700 mt-1">
                    قم بتفعيل نظام الشراكة من الإعدادات لتتبع توزيع الأرباح بين الشركاء آلياً
                  </p>
                </div>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ═══════════ TAB 3: OPENING BALANCES / CAPITAL ═══════════ */}
        <TabsContent value="reports" className="space-y-6">
          <FinancialReportsPage />
        </TabsContent>

        <TabsContent value="capital" className="space-y-6">
          <CapitalEquityPage />
        </TabsContent>
      </Tabs>

      {/* ════════════════════ DIALOGS ════════════════════ */}

      {/* ── Expense / Payroll Dialog ── */}
      <Dialog open={isExpenseOpen} onOpenChange={setIsExpenseOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>تسجيل مصروف / راتب</DialogTitle>
            <DialogDescription>أدخل التفاصيل لتسجيل القيد في السجل المالي</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 mb-4">
            <Button
              variant={expenseTab === "expense" ? "default" : "outline"}
              size="sm"
              onClick={() => setExpenseTab("expense")}
              className="flex-1"
            >
              <HandCoins className="size-4 ml-2" /> مصروف
            </Button>
            <Button
              variant={expenseTab === "payroll" ? "default" : "outline"}
              size="sm"
              onClick={() => setExpenseTab("payroll")}
              className="flex-1"
            >
              <Users className="size-4 ml-2" /> راتب
            </Button>
          </div>

          {expenseTab === "expense" ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>نوع المصروف</Label>
                <Select
                  value={expenseForm.category}
                  onValueChange={(v) => setExpenseForm((f) => ({ ...f, category: v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="اختر التصنيف" />
                  </SelectTrigger>
                  <SelectContent>
                    {personaCategories.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>المبلغ</Label>
                <Input
                  type="number"
                  placeholder="أدخل المبلغ"
                  value={expenseForm.amount}
                  onChange={(e) => setExpenseForm((f) => ({ ...f, amount: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>البيان / الوصف</Label>
                <Input
                  placeholder="وصف المصروف"
                  value={expenseForm.description}
                  onChange={(e) => setExpenseForm((f) => ({ ...f, description: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>التاريخ</Label>
                <Input
                  type="date"
                  value={expenseForm.date}
                  onChange={(e) => setExpenseForm((f) => ({ ...f, date: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>اتدفع من (الخزينة)</Label>
                <select
                  value={expenseWallet}
                  onChange={(e) => setExpenseWallet(e.target.value as WalletType)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  {Object.entries(WALLET_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  الفلوس هتنزل فعلاً من الحساب ده، فراجعه على الدرج أو الموبايل زي ما بتعملي دايماً.
                </p>
              </div>
              {spendError && <p className="text-sm text-destructive">{spendError}</p>}
              <DialogFooter className="gap-2 pt-2">
                <Button variant="outline" onClick={() => setIsExpenseOpen(false)}>
                  إلغاء
                </Button>
                <Button
                  onClick={() => void handleAddExpense()}
                  disabled={!expenseForm.amount || !expenseForm.category}
                >
                  <Plus className="size-4 ml-2" /> تسجيل
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>اسم الموظف</Label>
                <Input
                  placeholder="اسم الموظف"
                  value={payrollForm.employeeName}
                  onChange={(e) => setPayrollForm((f) => ({ ...f, employeeName: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>النوع</Label>
                <Select
                  value={payrollForm.type}
                  onValueChange={(v: any) => setPayrollForm((f) => ({ ...f, type: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="salary">راتب</SelectItem>
                    <SelectItem value="bonus">مكافأة</SelectItem>
                    <SelectItem value="advance">سلفة</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>المبلغ</Label>
                <Input
                  type="number"
                  placeholder="أدخل المبلغ"
                  value={payrollForm.amount}
                  onChange={(e) => setPayrollForm((f) => ({ ...f, amount: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>البيان</Label>
                <Input
                  placeholder="ملاحظات"
                  value={payrollForm.description}
                  onChange={(e) => setPayrollForm((f) => ({ ...f, description: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>التاريخ</Label>
                <Input
                  type="date"
                  value={payrollForm.date}
                  onChange={(e) => setPayrollForm((f) => ({ ...f, date: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>اتدفع من (الخزينة)</Label>
                <select
                  value={expenseWallet}
                  onChange={(e) => setExpenseWallet(e.target.value as WalletType)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  {Object.entries(WALLET_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              {spendError && <p className="text-sm text-destructive">{spendError}</p>}
              <DialogFooter className="gap-2 pt-2">
                <Button variant="outline" onClick={() => setIsExpenseOpen(false)}>
                  إلغاء
                </Button>
                <Button
                  onClick={() => void handleAddPayroll()}
                  disabled={!payrollForm.amount || !payrollForm.employeeName}
                >
                  <Plus className="size-4 ml-2" /> تسجيل
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <PartnerRemovalDialog
        partner={pendingPartnerRemoval}
        onClose={() => setPendingPartnerRemoval(null)}
      />

      {/* ── Add Partner Dialog ── */}
      <Dialog open={isPartnerOpen} onOpenChange={setIsPartnerOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>إضافة شريك أو مساهم</DialogTitle>
            <DialogDescription>
              الاتنين بياخدوا نصيب من الأرباح بنفس الطريقة. الفرق إن الشريك بيشتغل في المحل.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* النوع first: it changes what the rest of the form means. */}
            <div className="space-y-2">
              <Label>النوع</Label>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(PARTNER_KIND_LABELS) as PartnerKind[]).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => setPartnerForm((f) => ({ ...f, kind }))}
                    className={`rounded-xl border p-3 text-right transition-colors ${
                      partnerForm.kind === kind
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/40"
                    }`}
                  >
                    <span className="font-semibold block">{PARTNER_KIND_LABELS[kind]}</span>
                    <span className="text-xs text-muted-foreground block mt-1">
                      {PARTNER_KIND_HINTS[kind]}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>الاسم</Label>
              <Input
                placeholder="الاسم الكامل"
                value={partnerForm.name}
                onChange={(e) => setPartnerForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>نسبة الملكية (%)</Label>
              <Input
                type="number"
                min={0}
                max={100}
                placeholder="0-100"
                value={partnerForm.equityPercentage}
                onChange={(e) => {
                  setOwnershipError(null);
                  setPartnerForm((f) => ({ ...f, equityPercentage: e.target.value }));
                }}
              />
              <p className="text-xs text-muted-foreground">
                المسجّل حالياً {totalOwnership(partners)}% — المتاح {100 - totalOwnership(partners)}
                %
              </p>
              {ownershipError && <p className="text-xs text-destructive">{ownershipError}</p>}
            </div>
            <div className="space-y-2">
              <Label>رأس المال المساهم (اختياري)</Label>
              <Input
                type="number"
                min={0}
                placeholder="المبلغ"
                value={partnerForm.capitalContribution}
                onChange={(e) =>
                  setPartnerForm((f) => ({ ...f, capitalContribution: e.target.value }))
                }
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsPartnerOpen(false)}>
              إلغاء
            </Button>
            <Button
              onClick={handleAddPartner}
              disabled={!partnerForm.name || !partnerForm.equityPercentage}
            >
              <UserPlus className="size-4 ml-2" /> إضافة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Capital Contribution Dialog ── */}
      <Dialog open={isCapitalOpen} onOpenChange={setIsCapitalOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>إضافة مساهمة رأسمالية</DialogTitle>
            <DialogDescription>أدخل المبلغ المضاف لرأس مال الشريك</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>المبلغ</Label>
              <Input
                type="number"
                min={0}
                placeholder="أدخل المبلغ"
                value={capitalAmount}
                onChange={(e) => setCapitalAmount(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsCapitalOpen(false)}>
              إلغاء
            </Button>
            <Button onClick={handleCapitalContribution} disabled={!capitalAmount}>
              <BadgePercent className="size-4 ml-2" /> إضافة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Budget Cap Dialog ── */}
      <Dialog open={isBudgetOpen} onOpenChange={setIsBudgetOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>تحديد سقف ميزانية</DialogTitle>
            <DialogDescription>ضع حداً أقصى للإنفاق على هذا التصنيف شهرياً</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>التصنيف</Label>
              <Select
                value={budgetForm.category}
                onValueChange={(v) => setBudgetForm((f) => ({ ...f, category: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="اختر التصنيف" />
                </SelectTrigger>
                <SelectContent>
                  {personaCategories.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>سقف الميزانية (ج.م)</Label>
              <Input
                type="number"
                min={0}
                placeholder="الحد الأقصى"
                value={budgetForm.capAmount}
                onChange={(e) => setBudgetForm((f) => ({ ...f, capAmount: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsBudgetOpen(false)}>
              إلغاء
            </Button>
            <Button
              onClick={handleSetBudget}
              disabled={!budgetForm.category || !budgetForm.capAmount}
            >
              <Gauge className="size-4 ml-2" /> تعيين
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Add Asset Dialog ── */}
      <Dialog open={isAssetOpen} onOpenChange={setIsAssetOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>إضافة أصل ثابت</DialogTitle>
            <DialogDescription>سيتم احتساب الإهلاك الشهري تلقائياً</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>اسم الأصل <span className="text-red-500">*</span></Label>
              <Input
                placeholder="مثال: جهاز كمبيوتر"
                value={assetForm.name}
                onChange={(e) => setAssetForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>قيمة الشراء (ج.م) <span className="text-red-500">*</span></Label>
                <Input
                  type="number"
                  min={0}
                  placeholder="مثال: 50000"
                  value={assetForm.purchaseValue}
                  onChange={(e) => setAssetForm((f) => ({ ...f, purchaseValue: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>تاريخ الشراء <span className="text-red-500">*</span></Label>
                <Input
                  type="date"
                  value={assetForm.purchaseDate}
                  onChange={(e) => setAssetForm((f) => ({ ...f, purchaseDate: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>قيمة التكهين/الخردة (ج.م)</Label>
                <Input
                  type="number"
                  min={0}
                  placeholder="اختياري (الافتراضي 0)"
                  value={assetForm.salvageValue}
                  onChange={(e) => setAssetForm((f) => ({ ...f, salvageValue: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>العمر الافتراضي (سنوات) <span className="text-red-500">*</span></Label>
                <Input
                  type="number"
                  min={1}
                  placeholder="مثال: 10"
                  value={assetForm.usefulLifeYears}
                  onChange={(e) => setAssetForm((f) => ({ ...f, usefulLifeYears: e.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>مصدر الدفع <span className="text-red-500">*</span></Label>
              <Select
                value={assetForm.paymentSource}
                onValueChange={(v) => setAssetForm((f) => ({ ...f, paymentSource: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="اختر مصدر الدفع" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="prepaid">تم الدفع مسبقاً (موجود بالفعل)</SelectItem>
                  {Object.entries(WALLET_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      دفع من: {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                {assetForm.paymentSource === "prepaid" 
                  ? "لن يتم خصم أي مبالغ مالية من الخزينة، فقط تسجيل الأصل." 
                  : "سيتم خصم قيمة الشراء من الخزينة المحددة فورا."}
              </p>
            </div>

            {spendError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200">
                <p className="text-sm text-red-900">{spendError}</p>
              </div>
            )}

            {assetForm.purchaseValue &&
              assetForm.usefulLifeYears &&
              parseFloat(assetForm.usefulLifeYears) > 0 && (
                <div className="p-3 rounded-lg bg-indigo-50 border border-indigo-200">
                  <p className="text-sm text-indigo-900 font-medium">الإهلاك الشهري المقدر</p>
                  <p className="text-lg font-bold text-indigo-700 mt-1">
                    {formatMoney(
                      divide(
                        parseFloat(assetForm.purchaseValue) - (parseFloat(assetForm.salvageValue) || 0),
                        multiply(parseFloat(assetForm.usefulLifeYears), 12),
                      ),
                    )}
                  </p>
                </div>
              )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsAssetOpen(false)}>
              إلغاء
            </Button>
            <Button
              onClick={handleAddAsset}
              disabled={!assetForm.name || !assetForm.purchaseValue || !assetForm.usefulLifeYears}
            >
              <Plus className="size-4 ml-2" /> إضافة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
