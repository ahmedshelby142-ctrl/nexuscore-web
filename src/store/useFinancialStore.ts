import { create } from "zustand";
import { persist } from "zustand/middleware";
import { add, multiply, divide } from "@/lib/math";
import type { OwnerBudget } from "@/lib/ledger/ownerDraw";
import type {
  ExpenseRecord,
  PayrollRecord,
  FixedAsset,
  BudgetCap,
  ExpenseCategory,
  ShippingTariff,
  EcommerceRevenueLedgerEntry,
  WalletType,
  Wallet,
  WalletTransfer,
  StockLog,
  StockActionType,
  CourierReceivable,
  SyncAction,
} from "@/types";
import { SyncService } from "@/services/api/SyncService";


import { WALLET_LABELS } from "@/types";

/**
 * Central Financial Engine — General Ledger
 *
 * Maintains expense, payroll, fixed-asset, and budget-cap registers.
 * Income-statement metrics are computed reactively by reading from the
 * business store (POS sales, wholesale invoices, purchase invoices, products).
 * SCOPE: Retail Shops (POS) and E-commerce only
 */
interface FinancialState {
  syncQueue: SyncAction[];
  flushSyncQueue: () => Promise<void>;

  // ── Ledger arrays ──────────────────────────────────────────────
  expenses: ExpenseRecord[];
  payroll: PayrollRecord[];
  assets: FixedAsset[];
  budgetCaps: BudgetCap[];

  // ── Shipping ledger ────────────────────────────────────────────
  shippingTariffs: ShippingTariff[];
  // `shippingRevenues` / `shippingExpenses` lived here as two running
  // counters. DELETED 2026-08-18 (7.4): nothing had written them since the
  // ledger conversion, so «ربح الشحن» read 0 for ever, and keeping them beside
  // a ledger that already carries both sides was a standing double-count risk.
  // Shipping cost is now `SUM(expense)` on the `SHIPPING_SUBJECTS` — a SLICE
  // of the one expense total, never a second one. See `@/lib/ledger/reports`.
  ecommerceRevenueLedger: EcommerceRevenueLedgerEntry[];

  // ── Multi-Wallet System (الخزينة) ───────────────────────────────
  wallets: Wallet[];
  walletTransfers: WalletTransfer[];

  // Capital & shareholders used to live here as a SECOND list of part-owners
  // beside `useBusinessStore.partners`. Deleted 2026-08-18: one list, one
  // `Partner` with a `kind` (شريك / مساهم). See `src/lib/partners.ts`.

  // ── Stock Log (سجل حركة الصنف) ────────────────────────────────
  stockLogs: StockLog[];

  // ── Courier Receivable (الربط المالي مع الشحن) ─────────────────
  courierReceivables: CourierReceivable[];

  // ── Actions ────────────────────────────────────────────────────
  addExpense: (
    record: Omit<ExpenseRecord, "id">,
  ) => Promise<
    | { success: true }
    | { success: false; reason: "over_budget"; capAmount: number; currentTotal: number }
  >;
  removeExpense: (id: string) => void;
  addPayroll: (record: Omit<PayrollRecord, "id">) => void;
  removePayroll: (id: string) => void;
  addAsset: (record: Omit<FixedAsset, "id" | "monthlyDepreciation">) => void;
  removeAsset: (id: string) => void;
  toggleAsset: (id: string) => void;
  setBudgetCap: (category: string, capAmount: number) => void;
  removeBudgetCap: (category: string) => void;

  // ── Shipping actions ───────────────────────────────────────────
  addShippingTariff: (t: Omit<ShippingTariff, "id">) => void;
  updateShippingTariff: (id: string, updates: Partial<ShippingTariff>) => void;
  removeShippingTariff: (id: string) => void;
  recordEcommerceOrderRevenue: (entry: EcommerceRevenueLedgerEntry) => void;
  reverseEcommerceOrderRevenue: (orderId: string) => void;

  // ── Multi-Wallet Actions ────────────────────────────────────────
  transferBetweenWallets: (transfer: Omit<WalletTransfer, "id" | "timestamp">) => void;

  // ── Owner budget (ميزانية صاحبة العمل) ──────────────────────────
  // A SETTING, not a total: the limit and the period are typed by the owner.
  // What she has spent is SUM(owner_budget) over the period — never stored.
  ownerBudget: OwnerBudget | null;
  setOwnerBudget: (budget: OwnerBudget) => void;
  /** «تصفير الميزانية» — starts a new open period from now. */
  resetOwnerBudget: () => void;
  clearOwnerBudget: () => void;

  // ── Stock Log Actions ───────────────────────────────────────────
  logStockChange: (entry: Omit<StockLog, "id" | "timestamp">) => void;
  getStockLogsByProduct: (productSku: string) => StockLog[];
  getStockLogsByDateRange: (start: Date, end: Date) => StockLog[];

  // ── Courier Receivable Actions ───────────────────────────────────
  createCourierReceivable: (entry: Omit<CourierReceivable, "id" | "createdAt">) => void;
  reconcileCourierOrder: (orderId: string, targetWallet: WalletType) => void;
  getCourierReceivables: (courierId?: string) => CourierReceivable[];
  getCourierReceivableTotal: (courierId?: string) => number;

  // ── Computed helpers (called from component, not persisted) ────
  getMonthlyDepreciationExpense: () => number;
  getBudgetSpending: (category: string) => { spent: number; cap: number; pct: number };
  getCategorySpending: (category: string) => number;
  getTotalOperatingExpenses: () => number;
}

export const useFinancialStore = create<FinancialState>()(
  persist(
    (set, get) => ({
      syncQueue: [],
      // No-op: nothing queues any more, every write is awaited.
      flushSyncQueue: async () => {},
      expenses: [],
      payroll: [],
      assets: [],
      budgetCaps: [],
      shippingTariffs: [
        {
          id: "ship-default-1",
          destination: "القاهرة / الجيزة",
          customerCharge: 65,
          actualCost: 45,
          deliveryDays: 1,
          isActive: true,
        },
        {
          id: "ship-default-2",
          destination: "الإسكندرية",
          customerCharge: 95,
          actualCost: 70,
          deliveryDays: 2,
          isActive: true,
        },
        {
          id: "ship-default-3",
          destination: "الدلتا (المنصورة / طنطا)",
          customerCharge: 85,
          actualCost: 60,
          deliveryDays: 2,
          isActive: true,
        },
        {
          id: "ship-default-4",
          destination: "الصعيد (أسيوط / سوهاج)",
          customerCharge: 120,
          actualCost: 90,
          deliveryDays: 3,
          isActive: true,
        },
        {
          id: "ship-default-5",
          destination: "شحن دولي — السعودية",
          customerCharge: 450,
          actualCost: 320,
          deliveryDays: 5,
          isActive: true,
        },
        {
          id: "ship-default-6",
          destination: "شحن دولي — الإمارات",
          customerCharge: 380,
          actualCost: 280,
          deliveryDays: 4,
          isActive: true,
        },
      ],
      ecommerceRevenueLedger: [],

      // ── Multi-Wallet System ───────────────────────────────
      // Wallets are a LIST, not balances. What is in each one is
      // SUM(wallet) over the ledger — see `useBalances("wallet")`. A stored
      // balance here is what made the POS show a till that never moved.
      wallets: [
        { type: "inStoreSafe", label: "الخزينة" },
        { type: "vodafoneCash", label: "فودافون كاش" },
        { type: "instaPay", label: "انستا باي" },
        { type: "bankAccount", label: "الحساب البنكي" },
      ],
      walletTransfers: [],

      // ── Stock Log ──────────────────────────────────────────
      stockLogs: [],

      // ── Courier Receivable ─────────────────────────────────
      courierReceivables: [],

      // ── Expense (with budget-cap enforcement) ──────────────────
      addExpense: async (record) => {
        const categoryBudget = get().budgetCaps.find((b) => b.category === record.category);
        if (categoryBudget) {
          const currentTotal = get().getCategorySpending(record.category);
          const newTotal = add(currentTotal, record.amount);
          if (newTotal > categoryBudget.capAmount) {
            return {
              success: false as const,
              reason: "over_budget" as const,
              capAmount: categoryBudget.capAmount,
              currentTotal,
            };
          }
        }
        const expense: ExpenseRecord = {
          ...record,
          id: crypto.randomUUID(),
        };

        // Awaited, and committed only on success. The queue this replaces held
        // the expense locally when the push failed and drained it on a later
        // reconnect — a fallback that has no place in a cloud-native app, and
        // that made a rejected write look identical to an accepted one.
        await SyncService.pushChanges("expenses", expense);
        set((state) => ({ expenses: [...state.expenses, expense] }));

        return { success: true as const };
      },

      removeExpense: (id) => {
        set((state) => ({ expenses: state.expenses.filter((e) => e.id !== id) }));
      },

      // ── Payroll ────────────────────────────────────────────────
      addPayroll: (record) => {
        const entry: PayrollRecord = {
          ...record,
          id: crypto.randomUUID(),
        };
        set((state) => ({ payroll: [...state.payroll, entry] }));
      },

      removePayroll: (id) => {
        set((state) => ({ payroll: state.payroll.filter((p) => p.id !== id) }));
      },

      // ── Fixed Assets ───────────────────────────────────────────
      addAsset: (record) => {
        const salvage = record.salvageValue || 0;
        const monthlyDepreciation =
          record.usefulLifeYears > 0
            ? divide(record.purchaseValue - salvage, multiply(record.usefulLifeYears, 12))
            : 0;
        const asset: FixedAsset = {
          ...record,
          id: crypto.randomUUID(),
          monthlyDepreciation,
        };
        set((state) => ({ assets: [...state.assets, asset] }));
      },

      removeAsset: (id) => {
        set((state) => ({ assets: state.assets.filter((a) => a.id !== id) }));
      },

      toggleAsset: (id) => {
        set((state) => ({
          assets: state.assets.map((a) => (a.id === id ? { ...a, isActive: !a.isActive } : a)),
        }));
      },

      // ── Budget Caps ────────────────────────────────────────────
      setBudgetCap: (category, capAmount) => {
        set((state) => {
          const exists = state.budgetCaps.find((b) => b.category === category);
          if (exists) {
            return {
              budgetCaps: state.budgetCaps.map((b) =>
                b.category === category ? { ...b, capAmount } : b,
              ),
            };
          }
          return { budgetCaps: [...state.budgetCaps, { category, capAmount }] };
        });
      },

      removeBudgetCap: (category) => {
        set((state) => ({
          budgetCaps: state.budgetCaps.filter((b) => b.category !== category),
        }));
      },

      // ── Shipping actions ───────────────────────────────────────
      addShippingTariff: (t) => {
        const tariff: ShippingTariff = { ...t, id: crypto.randomUUID() };
        set((s) => ({ shippingTariffs: [...s.shippingTariffs, tariff] }));
      },
      updateShippingTariff: (id, updates) => {
        set((s) => ({
          shippingTariffs: s.shippingTariffs.map((t) => (t.id === id ? { ...t, ...updates } : t)),
        }));
      },
      removeShippingTariff: (id) => {
        set((s) => ({ shippingTariffs: s.shippingTariffs.filter((t) => t.id !== id) }));
      },
      recordEcommerceOrderRevenue: (entry) => {
        set((state) => {
          if (state.ecommerceRevenueLedger.some((item) => item.orderId === entry.orderId)) {
            return state;
          }
          return { ecommerceRevenueLedger: [...state.ecommerceRevenueLedger, entry] };
        });
      },
      reverseEcommerceOrderRevenue: (orderId) => {
        set((state) => {
          const entry = state.ecommerceRevenueLedger.find((item) => item.orderId === orderId);
          if (!entry) return state;
          return {
            ecommerceRevenueLedger: state.ecommerceRevenueLedger.filter(
              (item) => item.orderId !== orderId,
            ),
          };
        });
      },

      // ── Multi-Wallet Actions ─────────────────────────────────────
      transferBetweenWallets: (transferData) => {
        const { fromWallet, toWallet, amount } = transferData;
        if (amount <= 0) return;

        // Records the transfer DOCUMENT for the history list only. The money
        // moves on the `wallet_transfer` ledger event the caller appends, and
        // the sufficient-funds check happens there against the real balance.
        const transfer: WalletTransfer = {
          ...transferData,
          id: crypto.randomUUID(),
          timestamp: new Date(),
        };

        set((state) => ({
          walletTransfers: [...state.walletTransfers, transfer],
        }));

        // Log as expense for audit trail
        const fromLabel = WALLET_LABELS[fromWallet];
        const toLabel = WALLET_LABELS[toWallet];
        set((state) => ({
          expenses: [
            ...state.expenses,
            {
              id: crypto.randomUUID(),
              category: "other",
              amount,
              description: `تحويل من ${fromLabel} إلى ${toLabel}`,
              date: new Date(),
            },
          ],
        }));
      },

      // ── Owner budget ─────────────────────────────────────────────
      ownerBudget: null,
      setOwnerBudget: (budget) => set({ ownerBudget: budget }),
      resetOwnerBudget: () =>
        set((state) =>
          state.ownerBudget
            ? { ownerBudget: { ...state.ownerBudget, startedAt: Date.now() } }
            : state,
        ),
      clearOwnerBudget: () => set({ ownerBudget: null }),

      // ── Stock Log Actions ────────────────────────────────────────
      logStockChange: (entry) => {
        const log: StockLog = {
          ...entry,
          id: crypto.randomUUID(),
          timestamp: new Date(),
        };
        set((state) => ({
          stockLogs: [...state.stockLogs, log],
        }));
      },

      getStockLogsByProduct: (productSku) => {
        return get().stockLogs.filter((log) => log.productSku === productSku);
      },

      getStockLogsByDateRange: (start, end) => {
        return get().stockLogs.filter((log) => {
          const logDate = new Date(log.timestamp);
          return logDate >= start && logDate <= end;
        });
      },

      // ── Courier Receivable Actions ────────────────────────────────
      createCourierReceivable: (entryData) => {
        const entry: CourierReceivable = {
          ...entryData,
          id: crypto.randomUUID(),
          createdAt: new Date(),
        };
        set((state) => ({
          courierReceivables: [...state.courierReceivables, entry],
        }));
      },

      reconcileCourierOrder: (orderId, targetWallet) => {
        const receivable = get().courierReceivables.find(
          (r) => r.orderId === orderId && r.status === "pending",
        );
        if (!receivable) return;

        set((state) => ({
          courierReceivables: state.courierReceivables.map((r) =>
            r.id === receivable.id
              ? { ...r, status: "reconciled", reconciledAt: new Date(), targetWallet }
              : r,
          ),
        }));

        // NO expense row. This used to write one per reconciled order, for the
        // full courier fee — money the shop never pays. A DELIVERY fee is the
        // customer's and passes straight through to the courier (§3.9); the one
        // shipping cost that is genuinely ours is a RETURN, and
        // `return_confirmed` books that on the ledger. Writing it here as well
        // invented an expense for every delivery and double-counted every
        // return, in a list the owner reads as real spending.
      },

      getCourierReceivables: (courierId) => {
        if (!courierId) return get().courierReceivables;
        return get().courierReceivables.filter((r) => r.courierId === courierId);
      },

      getCourierReceivableTotal: (courierId) => {
        const receivables = courierId
          ? get().courierReceivables.filter(
              (r) => r.courierId === courierId && r.status === "pending",
            )
          : get().courierReceivables.filter((r) => r.status === "pending");
        return receivables.reduce((sum, r) => add(sum, r.amountDue), 0);
      },

      // ── Computed helpers ───────────────────────────────────────
      getMonthlyDepreciationExpense: () => {
        return get()
          .assets.filter((a) => a.isActive)
          .reduce((sum, a) => add(sum, a.monthlyDepreciation), 0);
      },

      getBudgetSpending: (category) => {
        const spent = get().getCategorySpending(category);
        const cap = get().budgetCaps.find((b) => b.category === category)?.capAmount ?? 0;
        return { spent, cap, pct: cap > 0 ? divide(spent, cap) * 100 : 0 };
      },

      getCategorySpending: (category) => {
        const store = get();
        const fromExpenses = store.expenses
          .filter((e) => e.category === category)
          .reduce((s, e) => add(s, e.amount), 0);
        const fromPayroll =
          category === "salaries" ? store.payroll.reduce((s, p) => add(s, p.amount), 0) : 0;
        return add(fromExpenses, fromPayroll);
      },

      getTotalOperatingExpenses: () => {
        const store = get();
        const expenseTotal = store.expenses.reduce((s, e) => add(s, e.amount), 0);
        const payrollTotal = store.payroll.reduce((s, p) => add(s, p.amount), 0);
        return add(expenseTotal, payrollTotal);
      },
    }),
    { name: "financial-storage" },
  ),
);

// ─────────────────────────────────────────────────────────────────
//  Income-statement helpers — what is LEFT of them
// ─────────────────────────────────────────────────────────────────
//
// DELETED 2026-08-18 (7.4, §3.12): `getTotalSales`, `getOperatingExpenses`,
// `getShippingRevenues`, `getShippingExpensesTotal`, `getEcommerceRevenue`,
// `getEcommerceCogs`, `getNetProfit` and `getNetProfitForPeriod`.
//
// They were the last store-side income statement, and every one of them was
// wrong in the way `getCostOfGoodsSold` was before it:
//
//   - sales summed the `transactions` store, which a POS sale has not written
//     since the ledger conversion, so «إجمالي المبيعات» was missing the shop;
//   - `getNetProfitForPeriod` guessed POS cost at `posSales × 0.7` — the exact
//     hardcoded margin the ledger's `unit_cost` snapshot exists to replace —
//     and PARTNER DISTRIBUTIONS were computed from it;
//   - both added `shippingRevenues` / `shippingExpenses`, two counters nothing
//     writes, beside a ledger that already carries the real fees.
//
// There is now ONE definition of profit in the app: `netSales − cogs −
// expenses`, all three `SUM()` over `ledger_lines` for the window, in
// `@/lib/ledger/reports`. Screens call `fetchPnl(balances, window)`.
//
// Deliberately not reimplemented as sync wrappers here: the ledger is read
// asynchronously, and a sync wrapper would only exist to be handed a stale or
// invented number again.

/** Helper to get monthly depreciation expense. NON-CASH — never a ledger line. */
export function getMonthlyDepreciationExpense(): number {
  return useFinancialStore.getState().getMonthlyDepreciationExpense();
}

// ── Wallet Management Exports ────────────────────────────────────

export function getWallets(): Wallet[] {
  return useFinancialStore.getState().wallets;
}

export function logDiscrepancyToProfitLoss(amount: number, notes: string) {
  const store = useFinancialStore.getState();
  useFinancialStore.setState((state) => ({
    expenses: [
      ...state.expenses,
      {
        id: crypto.randomUUID(),
        category: "other",
        amount,
        description: notes,
        date: new Date(),
      },
    ],
  }));
}
