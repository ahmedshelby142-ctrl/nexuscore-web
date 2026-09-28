import { create } from "zustand";
import { useSyncStatus } from "./useSyncStatus";
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
import { writeThrough, deleteThrough } from "@/services/cloudData";
import { getSupabaseClient } from "@/lib/supabase";
import { getSyncIdentity } from "@/services/api/storeContext";
import { fromRemoteRow, toRemoteRow } from "@/services/api/fieldMapping";
import { prepareEvent, type NewEvent } from "@/lib/ledger";



/**
 * Where a browser's pre-051 local fixed assets, payroll documents and budget
 * caps wait for an explicit upload (see the persist `migrate` below).
 */
export const LEGACY_FINANCE_KEY = "nexus-legacy-finance";

/**
 * A document written together with its ledger event (migration 051).
 *
 * `definite`: the database answered and refused, so NOTHING exists. When false
 * the answer never arrived — retry with the SAME document id: the RPC returns
 * the row already recorded (`replayed`) instead of paying twice.
 */
export type RecordResult<T> =
  | { success: true; row: T; replayed: boolean }
  | { success: false; reason: string; definite: boolean };

async function recordWithEvent<T>(
  rpc: "record_payroll" | "record_fixed_asset" | "record_expense",
  table: "payroll" | "fixed_assets" | "expenses",
  docArg: "p_payroll" | "p_asset" | "p_expense",
  resultKey: "payroll" | "asset" | "expense",
  doc: Record<string, unknown>,
  event: NewEvent | null,
): Promise<RecordResult<T>> {
  const sb = getSupabaseClient();
  const identity = await getSyncIdentity();
  if (!sb || !identity) return { success: false, reason: "لا يوجد اتصال بالسحابة", definite: true };
  try {
    const remote = toRemoteRow(table, doc, {
      storeId: identity.storeId,
      deviceId: identity.deviceId,
      stamp: Date.now(),
    });
    const p_event = event ? await prepareEvent(event) : null;
    const { data, error } = await sb.rpc(rpc, { [docArg]: remote, p_event });
    if (error) return { success: false, reason: error.message, definite: Boolean(error.code) };
    return {
      success: true,
      row: fromRemoteRow(table, (data as any)[resultKey]) as T,
      replayed: (data as any).replayed === true,
    };
  } catch (e) {
    return { success: false, reason: e instanceof Error ? e.message : String(e), definite: false };
  }
}

/** Commit what the database stored, replacing any local copy of that row. */
function upsertLocal(
  set: (fn: (state: any) => any) => void,
  field: "payroll" | "assets" | "budgetCaps" | "expenses",
  row: any,
) {
  set((state: any) => {
    const list: any[] = state[field] ?? [];
    const at = list.findIndex((r) => r.id === row.id);
    if (at < 0) return { [field]: [...list, row] };
    const next = list.slice();
    next[at] = { ...list[at], ...row };
    return { [field]: next };
  });
}

/** The answer to "may this expense be recorded?" — unknown is not "yes". */
export type ExpenseBudgetCheck =
  | { ok: true }
  | { ok: false; reason: "over_budget"; capAmount: number; currentTotal: number }
  | { ok: false; reason: "spending_unknown" };


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
  /**
   * The store's transfer history, READ FROM THE LEDGER (`wallet_transfer_history`,
   * 053) — newest first. Never kept per browser: it used to be a list only the
   * device that made the transfer had.
   */
  walletTransfers: WalletTransfer[];
  walletTransfersStatus: "idle" | "loading" | "ready" | "error";

  // Capital & shareholders used to live here as a SECOND list of part-owners
  // beside `useBusinessStore.partners`. Deleted 2026-08-18: one list, one
  // `Partner` with a `kind` (شريك / مساهم). See `src/lib/partners.ts`.

  // ── Stock Log (سجل حركة الصنف) ────────────────────────────────
  stockLogs: StockLog[];

  // ── Courier Receivable (الربط المالي مع الشحن) ─────────────────
  courierReceivables: CourierReceivable[];

  // ── Actions ────────────────────────────────────────────────────
  /**
   * May an expense of `amount` in `category` be recorded? Asked BEFORE the
   * ledger event — see `checkExpenseBudget` below for why it moved.
   */
  checkExpenseBudget: (category: string, amount: number) => ExpenseBudgetCheck;
  /**
   * The expense document AND its `expense` ledger event, in one transaction
   * (`record_expense`, 052). The screen checks the budget first; the database
   * checks it again inside the transaction, before anything moves.
   */
  recordExpense: (
    record: ExpenseRecord & { id: string },
    event: NewEvent,
  ) => Promise<RecordResult<ExpenseRecord>>;
  removeExpense: (id: string) => Promise<void>;
  // Migration 051: all cloud-first. Nothing changes on screen until the
  // database has the row; each write throws (or reports) on failure.
  /** The payroll document AND its `payroll` event, in one transaction. */
  recordPayroll: (
    record: PayrollRecord & { id: string },
    event: NewEvent,
  ) => Promise<RecordResult<PayrollRecord>>;
  /** Removes the DOCUMENT only — the salary already paid stays on the ledger, as before. */
  removePayroll: (id: string) => Promise<void>;
  /** The asset AND, when paid from a wallet now, its `expense` event, in one transaction. */
  recordAsset: (
    record: FixedAsset & { id: string },
    event: NewEvent | null,
  ) => Promise<RecordResult<FixedAsset>>;
  removeAsset: (id: string) => Promise<void>;
  toggleAsset: (id: string) => Promise<void>;
  setBudgetCap: (category: string, capAmount: number) => Promise<void>;
  removeBudgetCap: (category: string) => Promise<void>;

  // ── Shipping actions ───────────────────────────────────────────
  addShippingTariff: (t: Omit<ShippingTariff, "id">) => void;
  updateShippingTariff: (id: string, updates: Partial<ShippingTariff>) => void;
  removeShippingTariff: (id: string) => void;
  recordEcommerceOrderRevenue: (entry: EcommerceRevenueLedgerEntry) => void;
  reverseEcommerceOrderRevenue: (orderId: string) => void;

  // ── Multi-Wallet Actions ────────────────────────────────────────
  /**
   * One transfer, idempotent on its operation id (`event.refId`): a retry with
   * the SAME id after a lost answer returns the transfer already recorded
   * (`replayed`) instead of moving the money twice (`record_wallet_transfer`, 053).
   */
  recordWalletTransfer: (
    event: NewEvent,
  ) => Promise<{ success: true; replayed: boolean } | { success: false; reason: string; definite: boolean }>;
  /** Re-read the shared transfer history from the ledger. */
  loadWalletTransfers: () => Promise<void>;

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
      walletTransfersStatus: "idle",

      // ── Stock Log ──────────────────────────────────────────
      stockLogs: [],

      // ── Courier Receivable ─────────────────────────────────
      courierReceivables: [],

      // ── Expense (with budget-cap enforcement) ──────────────────
      // The cap check used to live INSIDE `addExpense`, and الشركاء والمالية
      // calls `addExpense` AFTER appending the `expense` ledger event. So an
      // over-budget expense moved the money out of the wallet first, and was
      // then "refused" with «لا يمكن تجاوز الحد المسموح» — while the ledger
      // had already booked it and no document was kept. And the spending it
      // compared against is the hydrated `expenses` list, which reads as 0
      // before it loads or after it fails — so a failed read waved any expense
      // through a cap. Asked first now, and "unknown" is its own answer.
      checkExpenseBudget: (category, amount) => {
        const tables = useSyncStatus.getState().tables;
        // The caps are cloud data now (051): an unread cap is not "no cap".
        if (tables.budget_caps !== "ready") return { ok: false, reason: "spending_unknown" };
        const cap = get().budgetCaps.find((b) => b.category === category);
        if (!cap) return { ok: true };
        if (tables.expenses !== "ready" || (category === "salaries" && tables.payroll !== "ready")) {
          return { ok: false, reason: "spending_unknown" };
        }
        const currentTotal = get().getCategorySpending(category);
        if (add(currentTotal, amount) > cap.capAmount) {
          return { ok: false, reason: "over_budget", capAmount: cap.capAmount, currentTotal };
        }
        return { ok: true };
      },

      // It was two requests — the ledger event, then this document — so a
      // failed document write left money out of the wallet with no expense
      // listed and nothing counted against the category's cap, and a retry
      // after a lost answer paid twice. One transaction now, idempotent on
      // the document id, committed locally only after the database answered.
      recordExpense: async (record, event) => {
        const result = await recordWithEvent<ExpenseRecord>(
          "record_expense", "expenses", "p_expense", "expense", record, event,
        );
        if (result.success) upsertLocal(set, "expenses", result.row);
        return result;
      },

      removeExpense: async (id) => {
        // Deleted in the cloud FIRST. This used to drop the expense from local
        // state only, so the row lived on in Supabase forever and came back the
        // moment another device (or a boot-time hydrate) read the table.
        const { deleteThrough } = await import("@/services/cloudData");
        await deleteThrough("expenses", id);
        set((state) => ({ expenses: state.expenses.filter((e) => e.id !== id) }));
      },

      // ── Payroll ────────────────────────────────────────────────
      // These three registers lived only in this browser (`financial-storage`):
      // another device had none of them and clearing site data erased them.
      // Migration 051 gives each a store table; the money was already shared.
      recordPayroll: async (record, event) => {
        const result = await recordWithEvent<PayrollRecord>(
          "record_payroll", "payroll", "p_payroll", "payroll", record, event,
        );
        if (result.success) upsertLocal(set, "payroll", result.row);
        return result;
      },

      removePayroll: async (id) => {
        await deleteThrough("payroll", id);
        set((state) => ({ payroll: state.payroll.filter((p) => p.id !== id) }));
      },

      // ── Fixed Assets ───────────────────────────────────────────
      recordAsset: async (record, event) => {
        const salvage = record.salvageValue || 0;
        const monthlyDepreciation =
          record.usefulLifeYears > 0
            ? divide(record.purchaseValue - salvage, multiply(record.usefulLifeYears, 12))
            : 0;
        const result = await recordWithEvent<FixedAsset>(
          "record_fixed_asset", "fixed_assets", "p_asset", "asset",
          { ...record, monthlyDepreciation }, event,
        );
        if (result.success) upsertLocal(set, "assets", result.row);
        return result;
      },

      removeAsset: async (id) => {
        await deleteThrough("fixed_assets", id);
        set((state) => ({ assets: state.assets.filter((a) => a.id !== id) }));
      },

      toggleAsset: async (id) => {
        const current = get().assets.find((a) => a.id === id);
        if (!current) return;
        const saved = await writeThrough("fixed_assets", { ...current, isActive: !current.isActive });
        upsertLocal(set, "assets", saved);
      },

      // ── Budget Caps ────────────────────────────────────────────
      // One cap per category per STORE (unique in 051). The id is derived from
      // the store and the category, so two devices setting the same category
      // write the same row instead of racing to create two.
      setBudgetCap: async (category, capAmount) => {
        const identity = await getSyncIdentity();
        if (!identity) throw new Error("لم يتم ربط هذا الجهاز بمتجر بعد — سجّل الدخول أولاً");
        const existing = get().budgetCaps.find((b) => b.category === category);
        const saved = await writeThrough("budget_caps", {
          id: existing?.id ?? `cap:${identity.storeId}:${category}`,
          category,
          capAmount,
        });
        upsertLocal(set, "budgetCaps", saved);
      },

      removeBudgetCap: async (category) => {
        const existing = get().budgetCaps.find((b) => b.category === category);
        if (!existing) return;
        await deleteThrough("budget_caps", existing.id);
        set((state) => ({ budgetCaps: state.budgetCaps.filter((b) => b.category !== category) }));
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
      // The money moves on ONE `wallet_transfer` event — two equal and opposite
      // wallet lines, no expense (a transfer between the shop's own wallets is
      // not a cost; it used to also add a fake local «أخرى» expense). The
      // event's `ref_id` is the operation id the screen keeps across a failed
      // attempt, and the database refuses a second transfer under it.
      recordWalletTransfer: async (event) => {
        const sb = getSupabaseClient();
        if (!sb) return { success: false, reason: "لا يوجد اتصال بالسحابة", definite: true };
        try {
          const p_event = await prepareEvent(event);
          const { data, error } = await sb.rpc("record_wallet_transfer", { p_event });
          if (error) return { success: false, reason: error.message, definite: Boolean(error.code) };
          return { success: true, replayed: (data as any)?.replayed === true };
        } catch (e) {
          return { success: false, reason: e instanceof Error ? e.message : String(e), definite: false };
        }
      },

      loadWalletTransfers: async () => {
        const sb = getSupabaseClient();
        const identity = await getSyncIdentity();
        if (!sb || !identity) return;
        set({ walletTransfersStatus: "loading" });
        const { data, error } = await sb.rpc("wallet_transfer_history", {
          p_store: identity.storeId,
          p_limit: 50,
        });
        if (error) {
          // A failed read is not "no transfers": the screen says so.
          set({ walletTransfersStatus: "error" });
          return;
        }
        set({
          walletTransfersStatus: "ready",
          walletTransfers: (data ?? []).map((r: any) => ({
            id: r.id,
            fromWallet: r.from_wallet,
            toWallet: r.to_wallet,
            amount: Number(r.amount),
            notes: r.notes ?? undefined,
            actor: r.actor ?? undefined,
            timestamp: r.occurred_at,
          })),
        });
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
    {
      name: "financial-storage",
      /**
       * `expenses` is cloud-owned now (it has a table, RLS and a hydration
       * sink), so persisting it would recreate the stale-cache problem the
       * rest of this codebase deletes: a device showing rows the database no
       * longer has, and showing nothing on a browser that never cached them.
       *
       * Payroll, fixed assets and budget caps joined it in 051. What is still
       * kept here has no table — courier receivables, wallet transfers, the
       * owner's personal budget setting — so this stays a deny-list.
       */
      partialize: (state: any) => {
        const {
          expenses: _cloudOwned,
          payroll: _payroll,
          assets: _assets,
          budgetCaps: _caps,
          walletTransfers: _transfers,
          walletTransfersStatus: _transfersStatus,
          syncQueue: _noQueue,
          ...keep
        } = state;
        return keep;
      },
      // v1: assets, payroll and budget caps left this blob for their 051
      // tables. A browser's old copies go to LEGACY_FINANCE_KEY for an explicit
      // upload rather than being dropped or pushed silently — the blob is per
      // BROWSER, not per store.
      // v2: the transfer history left this blob (053) — it is read from the
      // ledger, which already holds every transfer, so the old local copy is
      // simply dropped: it was never the record of anything.
      version: 2,
      migrate: (persisted: any, version: number) => {
        if (version < 1 && persisted) {
          const legacy = {
            assets: Array.isArray(persisted.assets) ? persisted.assets : [],
            payroll: Array.isArray(persisted.payroll) ? persisted.payroll : [],
            budgetCaps: Array.isArray(persisted.budgetCaps) ? persisted.budgetCaps : [],
          };
          if (legacy.assets.length + legacy.payroll.length + legacy.budgetCaps.length > 0) {
            try {
              localStorage.setItem(LEGACY_FINANCE_KEY, JSON.stringify(legacy));
            } catch {
              /* storage full or blocked: nothing to hand over */
            }
          }
        }
        const { assets: _a, payroll: _p, budgetCaps: _b, walletTransfers: _t, ...rest } = persisted ?? {};
        return rest;
      },
    },
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

// `logDiscrepancyToProfitLoss` DELETED: it appended a local-only «أخرى»
// expense with no ledger movement behind it — the same phantom as the wallet
// transfer's — and nothing called it. A stock discrepancy is booked by the
// جرد screen as a `stock_adjustment` ledger event.
