/**
 * Migration 051 — fixed assets, budget caps and payroll as shared store data,
 * and an atomic order cancellation.
 *
 *     node --test scripts/check_finance_records.mjs
 *
 * The store actions run for real against a stubbed Supabase client, so what
 * is asserted is what the app sends: which RPC, with which document and which
 * ledger event, and what it commits locally. The database side (RLS, the row
 * lock, idempotency, tenant isolation) was exercised against the live project
 * inside a rolled-back transaction — see the release report.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");
const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;

globalThis.__rpc = [];
globalThis.__writes = [];
globalThis.__deletes = [];
globalThis.__rpcAnswer = null;
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
// zustand's `persist` finds its storage on `window`; without one it attaches no API.
globalThis.window ??= globalThis;

const STUBS = {
  "@/lib/supabase": stub(`
    export const getSupabaseClient = () => ({
      rpc: async (name, args) => {
        globalThis.__rpc.push({ name, args });
        const a = globalThis.__rpcAnswer;
        if (a) return a(name, args);
        const doc = args.p_payroll ?? args.p_asset ?? args.p_expense;
        const key = args.p_payroll ? "payroll" : args.p_asset ? "asset" : "expense";
        return { data: { [key]: doc, replayed: false }, error: null };
      },
    });`),
  "@/services/cloudData": stub(`
    export const writeThrough = async (table, row) => { globalThis.__writes.push({ table, row }); return { ...row }; };
    export const deleteThrough = async (table, id) => { globalThis.__deletes.push({ table, id }); };`),
  "@/services/api/storeContext": stub(`export const getSyncIdentity = async () => ({ storeId: "S1", deviceId: "D1" });`),
  "@/services/api/fieldMapping": stub(`
    export const toRemoteRow = (_t, row, o) => ({ ...row, store_id: o.storeId, device_id: o.deviceId });
    export const fromRemoteRow = (_t, row) => ({ ...row });`),
  "@/lib/ledger": stub(`export const prepareEvent = async (e) => ({ id: "EV-" + e.refId, kind: e.kind, ref_type: e.refType, ref_id: e.refId, store_id: "S1" });`),
  "@/services/api/SyncService": stub(`export const SyncService = { pushChanges: async () => {} };`),
};
const ts = (u) => (existsSync(fileURLToPath(u + ".ts")) ? u + ".ts" : u + "/index.ts");
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    if (specifier.startsWith("@/")) return next(ts(new URL(`src/${specifier.slice(2)}`, root).href), context);
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
      return next(ts(new URL(specifier, context.parentURL).href), context);
    return next(specifier, context);
  },
});

const { useFinancialStore, LEGACY_FINANCE_KEY } = await import(new URL("src/store/useFinancialStore.ts", root).href);
const { useSyncStatus } = await import(new URL("src/store/useSyncStatus.ts", root).href);
const F = () => useFinancialStore.getState();
const reset = () => {
  globalThis.__rpc = [];
  globalThis.__writes = [];
  globalThis.__deletes = [];
  globalThis.__rpcAnswer = null;
  useFinancialStore.setState({ assets: [], payroll: [], budgetCaps: [], expenses: [] });
};
const ready = (...tables) => {
  for (const t of ["budget_caps", "expenses", "payroll"]) useSyncStatus.getState().markTable(t, "loading");
  for (const t of tables) useSyncStatus.getState().markTable(t, "ready");
};
const migration = read("docs/migrations/051_finance_records_and_atomic_cancel.sql");
const m052 = read("docs/migrations/052_atomic_expense.sql");

// ═══ Fixed assets ═══

test("FA.1 an asset paid from a wallet is ONE call: document + expense event, linked by id", async () => {
  reset();
  const r = await F().recordAsset(
    { id: "A1", name: "كاشير", purchaseValue: 6000, salvageValue: 600, usefulLifeYears: 3, purchaseDate: new Date(), isActive: true, paymentSource: "inStoreSafe" },
    { kind: "expense", refType: "fixed_asset", refId: "A1", lines: [] },
  );
  assert.equal(r.success, true);
  assert.equal(globalThis.__rpc.length, 1);
  const { name, args } = globalThis.__rpc[0];
  assert.equal(name, "record_fixed_asset");
  assert.equal(args.p_asset.monthlyDepreciation, 150, "(6000 − 600) / (3 × 12) — the existing formula, unchanged");
  assert.equal(args.p_asset.store_id, "S1");
  assert.equal(args.p_event.ref_id, "A1");
  assert.deepEqual(F().assets.map((a) => a.id), ["A1"], "committed only after the database answered");
});

test("FA.2 a prepaid asset moves no money", async () => {
  reset();
  await F().recordAsset({ id: "A2", name: "رف", purchaseValue: 1000, salvageValue: 0, usefulLifeYears: 2, purchaseDate: new Date(), isActive: true, paymentSource: "prepaid" }, null);
  assert.equal(globalThis.__rpc[0].args.p_event, null);
});

test("FA.3 failures commit nothing and say whether a retry is safe", async () => {
  reset();
  globalThis.__rpcAnswer = () => ({ data: null, error: { message: "RLS", code: "42501" } });
  const refused = await F().recordAsset({ id: "A3", name: "x", purchaseValue: 1, usefulLifeYears: 1, purchaseDate: new Date(), isActive: true }, null);
  assert.deepEqual(refused, { success: false, reason: "RLS", definite: true });
  globalThis.__rpcAnswer = () => { throw new Error("network"); };
  const lost = await F().recordAsset({ id: "A3", name: "x", purchaseValue: 1, usefulLifeYears: 1, purchaseDate: new Date(), isActive: true }, null);
  assert.equal(lost.definite, false, "unknown outcome: retry with the SAME id");
  assert.deepEqual(F().assets, []);
});

test("FA.4 a replayed retry is reported, not recorded twice", async () => {
  reset();
  globalThis.__rpcAnswer = (_n, a) => ({ data: { asset: a.p_asset, replayed: true }, error: null });
  const doc = { id: "A4", name: "x", purchaseValue: 1, usefulLifeYears: 1, purchaseDate: new Date(), isActive: true };
  await F().recordAsset(doc, null);
  const r = await F().recordAsset(doc, null);
  assert.equal(r.replayed, true);
  assert.equal(F().assets.length, 1);
});

test("FA.5 مستبعد and delete go to the cloud", async () => {
  reset();
  useFinancialStore.setState({ assets: [{ id: "A5", isActive: true }] });
  await F().toggleAsset("A5");
  assert.deepEqual(globalThis.__writes[0], { table: "fixed_assets", row: { id: "A5", isActive: false } });
  assert.equal(F().assets[0].isActive, false);
  await F().removeAsset("A5");
  assert.deepEqual(globalThis.__deletes[0], { table: "fixed_assets", id: "A5" });
  assert.deepEqual(F().assets, []);
});

// ═══ Budget caps ═══

test("BC.1 a cap is a store row, one per category, whichever device sets it", async () => {
  reset();
  await F().setBudgetCap("marketing", 20000);
  assert.deepEqual(globalThis.__writes[0], { table: "budget_caps", row: { id: "cap:S1:marketing", category: "marketing", capAmount: 20000 } });
  await F().setBudgetCap("marketing", 25000);
  assert.equal(globalThis.__writes[1].row.id, "cap:S1:marketing", "an update, not a second cap");
  assert.equal(F().budgetCaps.length, 1);
  assert.equal(F().budgetCaps[0].capAmount, 25000);
  await F().removeBudgetCap("marketing");
  assert.deepEqual(globalThis.__deletes[0], { table: "budget_caps", id: "cap:S1:marketing" });
});

test("BC.2 existing semantics: 20,000 cap, 5,000 + 7,000 spent → 8,000 more reaches it, 8,001 is blocked", () => {
  reset();
  ready("budget_caps", "expenses", "payroll");
  useFinancialStore.setState({
    budgetCaps: [{ id: "c", category: "marketing", capAmount: 20000 }],
    expenses: [{ category: "marketing", amount: 5000 }, { category: "marketing", amount: 7000 }],
  });
  assert.equal(F().getCategorySpending("marketing"), 12000);
  assert.deepEqual(F().checkExpenseBudget("marketing", 8000), { ok: true });
  assert.deepEqual(F().checkExpenseBudget("marketing", 8001), {
    ok: false, reason: "over_budget", capAmount: 20000, currentTotal: 12000,
  });
  assert.deepEqual(F().checkExpenseBudget("rent", 999999), { ok: true }, "no cap, no limit — as before");
});

test("BC.3 an unread cap is not 'no cap'", () => {
  reset();
  ready("expenses", "payroll");
  assert.deepEqual(F().checkExpenseBudget("rent", 1), { ok: false, reason: "spending_unknown" });
  ready("budget_caps", "expenses");
  useFinancialStore.setState({ budgetCaps: [{ id: "c", category: "salaries", capAmount: 10 }] });
  assert.deepEqual(F().checkExpenseBudget("salaries", 1), { ok: false, reason: "spending_unknown" }, "salaries also counts payroll documents");
});

test("BC.4 salaries spending includes shared payroll documents, as before", () => {
  reset();
  useFinancialStore.setState({ expenses: [{ category: "salaries", amount: 100 }], payroll: [{ amount: 4000 }] });
  assert.equal(F().getCategorySpending("salaries"), 4100);
});

// ═══ Payroll ═══

test("PR.1 a salary is ONE call: document + payroll event, linked by id", async () => {
  reset();
  const r = await F().recordPayroll(
    { id: "P1", employeeName: "سارة", type: "salary", amount: 4000, date: new Date(), wallet: "inStoreSafe" },
    { kind: "payroll", refType: "payroll", refId: "P1", lines: [] },
  );
  assert.equal(r.success, true);
  assert.equal(globalThis.__rpc[0].name, "record_payroll");
  assert.equal(globalThis.__rpc[0].args.p_event.ref_id, "P1");
  assert.deepEqual(F().payroll.map((p) => p.id), ["P1"]);
});

test("PR.2 deleting a payroll document removes the document only", async () => {
  reset();
  useFinancialStore.setState({ payroll: [{ id: "P2" }] });
  await F().removePayroll("P2");
  assert.deepEqual(globalThis.__deletes, [{ table: "payroll", id: "P2" }]);
  assert.equal(globalThis.__rpc.length, 0, "no ledger reversal — unchanged behaviour");
});

// ═══ Persistence ═══

test("PS.1 none of the three is kept per browser any more; old copies wait for an explicit upload", () => {
  const opts = useFinancialStore.persist.getOptions();
  const kept = opts.partialize({ payroll: [1], assets: [1], budgetCaps: [1], expenses: [1], ownerBudget: { limit: 1 }, walletTransfers: [] });
  // The owner's personal budget stays local; the transfer history left too (053).
  assert.deepEqual(Object.keys(kept).sort(), ["ownerBudget"], "the owner's personal budget stays local");
  const migrated = opts.migrate({ payroll: [{ id: "p" }], assets: [{ id: "a" }], budgetCaps: [], ownerBudget: null }, 0);
  assert.equal("payroll" in migrated || "assets" in migrated || "budgetCaps" in migrated, false);
  assert.deepEqual(JSON.parse(localStorage.getItem(LEGACY_FINANCE_KEY)), { assets: [{ id: "a" }], payroll: [{ id: "p" }], budgetCaps: [] });
});

test("PS.2 hydrated from their tables on every device", () => {
  const hydrate = read("src/services/cloudHydrate.ts");
  assert.match(hydrate, /fixed_assets: \(rows\) => useFinancialStore\.setState\(\{ assets: rows \}\)/);
  assert.match(hydrate, /budget_caps: \(rows\) => useFinancialStore\.setState\(\{ budgetCaps: rows \}\)/);
  assert.match(hydrate, /payroll: \(rows\) => useFinancialStore\.setState\(\{ payroll: rows \}\)/);
  const schema = read("src/services/api/cloudSchema.ts");
  for (const t of ["fixed_assets", "budget_caps", "payroll"]) assert.match(schema, new RegExp(`\\n  ${t}: \\{`));
});

// ═══ Cancellation ═══

test("CX.1 cancellation is ONE call: status, cause and event together", () => {
  const page = read("src/components/ecommerce/OrdersPage.tsx");
  const body = page.slice(page.indexOf("const cancelOrder = async"), page.indexOf("const confirmReturn = async"));
  assert.match(body, /useOrderStore\.getState\(\)\.cancelOrder\(\{/);
  assert.doesNotMatch(body, /await appendEvent\(/, "the event is not sent on its own");
  assert.doesNotMatch(body, /updateOrderStatus\(orderId, "cancelled"\)/, "the status is not sent on its own");
  assert.doesNotMatch(body, /updateOrder\(orderId, \{ return_cause/, "the cause is not sent on its own");
  assert.match(read("src/store/useOrderStore.ts"), /sb\.rpc\("cancel_order"/);
});

test("CX.2 the RPC locks, refuses a repeat and a non-pending order, and never swallows a refusal", () => {
  const fn = migration.slice(migration.indexOf("FUNCTION public.cancel_order"), migration.indexOf("REVOKE ALL ON FUNCTION public.record_payroll"));
  assert.match(fn, /FOR UPDATE;/);
  assert.match(fn, /NEXUS_ORDER_ALREADY_CANCELLED/);
  assert.match(fn, /v_order\.status IS DISTINCT FROM 'pending'/);
  assert.match(fn, /NEXUS_EVENT_NOT_THIS_ORDER/);
  assert.doesNotMatch(fn, /SECURITY DEFINER/);
});

// ═══ Migration shape ═══

test("MG.1 051: ADMIN/ACCOUNTANT only, no subtransaction around a ledger write, anon revoked", () => {
  assert.match(migration, /m\.role IN \('ADMIN', 'ACCOUNTANT'\)/);
  assert.match(migration, /has_role\(store_id, VARIADIC ARRAY\['ADMIN', 'ACCOUNTANT'\]\)/);
  assert.doesNotMatch(migration, /\bEXCEPTION\s+WHEN\b/i, "043");
  assert.doesNotMatch(migration, /SAVEPOINT/i);
  for (const f of ["record_payroll\\(jsonb, jsonb\\)", "record_fixed_asset\\(jsonb, jsonb\\)", "cancel_order\\(text, text, jsonb\\)"]) {
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${f} FROM public, anon;`));
  }
  assert.match(migration, /budget_caps_category_per_store/);
  assert.match(migration, /payroll_one_event/);
});

// ═══ Expense (052) ═══

const expenseDoc = (id, amount = 5000) => ({ id, category: "marketing", amount, date: new Date() });
const expenseEvent = (id) => ({ kind: "expense", refType: "expense", refId: id, lines: [] });

test("EX.1 an expense is ONE call: document + ledger event, linked by id", async () => {
  reset();
  const r = await F().recordExpense(expenseDoc("E1"), expenseEvent("E1"));
  assert.equal(r.success, true);
  assert.equal(globalThis.__rpc.length, 1, "no second request that could fail on its own");
  assert.equal(globalThis.__rpc[0].name, "record_expense");
  assert.equal(globalThis.__rpc[0].args.p_expense.store_id, "S1");
  assert.equal(globalThis.__rpc[0].args.p_event.ref_id, "E1");
  assert.deepEqual(F().expenses.map((e) => e.id), ["E1"]);
});

test("EX.2 a refusal (ledger, document, cap, role) commits nothing locally", async () => {
  reset();
  for (const message of ["ledger: expense — money out must equal the cost booked", "duplicate key", "NEXUS_OVER_BUDGET", "row-level security"]) {
    globalThis.__rpcAnswer = () => ({ data: null, error: { message, code: "23514" } });
    const r = await F().recordExpense(expenseDoc("E2"), expenseEvent("E2"));
    assert.deepEqual(r, { success: false, reason: message, definite: true });
  }
  assert.deepEqual(F().expenses, []);
});

test("EX.3 a lost answer is ambiguous; the retry with the SAME id is replayed, not charged twice", async () => {
  reset();
  globalThis.__rpcAnswer = () => { throw new Error("network"); };
  const lost = await F().recordExpense(expenseDoc("E3"), expenseEvent("E3"));
  assert.equal(lost.definite, false);
  assert.deepEqual(F().expenses, []);
  globalThis.__rpcAnswer = (_n, a) => ({ data: { expense: a.p_expense, replayed: true }, error: null });
  const retry = await F().recordExpense(expenseDoc("E3"), expenseEvent("E3"));
  assert.equal(retry.replayed, true);
  assert.equal(F().expenses.length, 1, "shown once");
});

test("EX.4 the page keeps the id across an ambiguous failure and checks the cap first", () => {
  const page = read("src/components/finance/PartnersFinancePage.tsx");
  const fn = page.slice(page.indexOf("const handleAddExpense = async"), page.indexOf("const handleAddPayroll = async"));
  assert.match(fn, /const id = pendingExpenseId\.current \?\? crypto\.randomUUID\(\);/);
  assert.match(fn, /if \(result\.definite\) pendingExpenseId\.current = null;/);
  assert.ok(fn.indexOf("checkExpenseBudget(") < fn.indexOf("await recordExpense("));
  assert.match(page, /const handleAddExpense = async[\s\S]{0,400}if \(!expenseGate\.enter\(\)\) return;/, "double click gated");
});

test("EX.5 052: cap enforced in the transaction before any write; idempotent; the event must be THIS expense", () => {
  const fn = m052.slice(m052.indexOf("CREATE OR REPLACE FUNCTION public.record_expense"));
  const replay = fn.indexOf("'replayed', true");
  const cap = fn.indexOf("NEXUS_OVER_BUDGET");
  const insert = fn.indexOf("INSERT INTO public.expenses");
  const append = fn.indexOf("PERFORM public.ledger_append");
  assert.ok(replay > 0 && replay < cap && cap < insert && insert < append);
  assert.match(fn, /FOR UPDATE;/, "two devices spending the last of a cap at once cannot both pass");
  assert.match(fn, /IF v_spent \+ v_amount > v_cap THEN/, "the screen's rule: reaching the cap is allowed, exceeding it is not");
  assert.match(fn, /v_booked <> round\(v_amount \* 100\)/);
  assert.doesNotMatch(m052, /EXCEPTION\s+WHEN/i, "043");
  assert.doesNotMatch(fn, /SECURITY DEFINER/);
  assert.match(m052, /REVOKE ALL ON FUNCTION public\.record_expense\(jsonb, jsonb\) FROM public, anon;/);
  assert.match(m052, /expenses_one_event/);
});

// ═══ Wallet transfer — not an expense ═══

const { buildWalletTransferLines } = await import(new URL("src/lib/ledger/audit.ts", root).href);

const transferEvent = (op) => ({
  kind: "wallet_transfer",
  refType: "wallet_transfer",
  refId: op,
  lines: buildWalletTransferLines({ fromWallet: "inStoreSafe", toWallet: "vodafoneCash", amount: 10000 }),
});

test("TR.1 a 10,000 transfer is ONE idempotent call — no expense, no «أخرى» budget usage", async () => {
  reset();
  ready("budget_caps", "expenses", "payroll");
  useFinancialStore.setState({
    budgetCaps: [{ id: "c", category: "other", capAmount: 20000 }],
    expenses: [{ id: "x", category: "other", amount: 12000 }],
  });
  globalThis.__rpcAnswer = () => ({ data: { event_id: "EV-OP1", replayed: false }, error: null });
  const r = await F().recordWalletTransfer(transferEvent("OP1"));
  assert.deepEqual(r, { success: true, replayed: false });
  assert.equal(globalThis.__rpc.length, 1);
  assert.equal(globalThis.__rpc[0].name, "record_wallet_transfer");
  assert.equal(globalThis.__rpc[0].args.p_event.ref_id, "OP1", "the operation id travels as the event's ref_id");
  assert.deepEqual(F().expenses, [{ id: "x", category: "other", amount: 12000 }], "expenses unchanged");
  assert.equal(F().getCategorySpending("other"), 12000, "«أخرى» usage unchanged");
  assert.deepEqual(F().checkExpenseBudget("other", 8000), { ok: true });
  assert.equal(globalThis.__writes.length, 0, "no document written anywhere else");
});

test("TR.1b lost answer → ambiguous; the retry with the SAME operation id is replayed, not moved again", async () => {
  reset();
  globalThis.__rpcAnswer = () => { throw new Error("network"); };
  const lost = await F().recordWalletTransfer(transferEvent("OP2"));
  assert.deepEqual(lost, { success: false, reason: "network", definite: false });
  globalThis.__rpcAnswer = () => ({ data: { event_id: "EV-OP2", replayed: true }, error: null });
  const retry = await F().recordWalletTransfer(transferEvent("OP2"));
  assert.deepEqual(retry, { success: true, replayed: true });
  assert.equal(globalThis.__rpc[1].args.p_event.ref_id, "OP2");
  globalThis.__rpcAnswer = () => ({ data: null, error: { message: "ledger: wallet_transfer — moves money between wallets and creates none", code: "23514" } });
  const refused = await F().recordWalletTransfer(transferEvent("OP3"));
  assert.equal(refused.definite, true, "a genuine refusal: nothing exists, a fresh id is safe");
});

test("TR.1c the history is read from the ledger, newest first, never kept per browser", async () => {
  reset();
  globalThis.__rpcAnswer = (name, args) => {
    assert.equal(name, "wallet_transfer_history");
    assert.equal(args.p_store, "S1");
    return { data: [
      { id: "e2", occurred_at: "2026-09-29T10:00:00Z", actor: "تحويل بين الخزائن", notes: null, from_wallet: "vodafoneCash", to_wallet: "bankAccount", amount: 2500 },
      { id: "e1", occurred_at: "2026-09-28T10:00:00Z", actor: "تحويل بين الخزائن", notes: "إيداع", from_wallet: "inStoreSafe", to_wallet: "vodafoneCash", amount: 10000 },
    ], error: null };
  };
  await F().loadWalletTransfers();
  assert.equal(F().walletTransfersStatus, "ready");
  assert.deepEqual(F().walletTransfers.map((t) => [t.id, t.fromWallet, t.toWallet, t.amount]), [
    ["e2", "vodafoneCash", "bankAccount", 2500],
    ["e1", "inStoreSafe", "vodafoneCash", 10000],
  ]);
  globalThis.__rpcAnswer = () => ({ data: null, error: { message: "boom", code: "42501" } });
  await F().loadWalletTransfers();
  assert.equal(F().walletTransfersStatus, "error", "a failed read is not «no transfers»");
  const opts = useFinancialStore.persist.getOptions();
  const kept = opts.partialize({ walletTransfers: [1], walletTransfersStatus: "ready", ownerBudget: null });
  assert.deepEqual(Object.keys(kept), ["ownerBudget"], "not persisted — clearing the browser loses nothing");
  assert.equal("walletTransfers" in opts.migrate({ walletTransfers: [{ id: "old" }] }, 1), false, "the old local list is dropped");
});

test("TR.2 the money moves on ONE wallet_transfer event: −A, +B, netting to zero", () => {
  const lines = buildWalletTransferLines({ fromWallet: "inStoreSafe", toWallet: "vodafoneCash", amount: 10000 });
  assert.deepEqual(lines, [
    { account: "wallet", subjectId: "inStoreSafe", amount: -10000 },
    { account: "wallet", subjectId: "vodafoneCash", amount: 10000 },
  ]);
  assert.ok(!lines.some((l) => l.account === "expense"), "no cost line");
  assert.throws(() => buildWalletTransferLines({ fromWallet: "a", toWallet: "a", amount: 1 }));
  assert.throws(() => buildWalletTransferLines({ fromWallet: "a", toWallet: "b", amount: 0 }));
});

test("TR.3 the screen: one operation id per transfer, kept across an ambiguous failure; gated; no expense", () => {
  const page = read("src/components/finance/CapitalEquityPage.tsx");
  const fn = page.slice(page.indexOf("const handleTransfer = async"), page.indexOf("setWalletBusy(false);", page.indexOf("const handleTransfer = async")));
  assert.match(fn, /runOnce\(async \(\) => \{/, "double click");
  assert.match(fn, /const op = pendingTransferOp\.current \?\? crypto\.randomUUID\(\);/);
  assert.match(fn, /refId: op,/);
  assert.match(fn, /if \(result\.definite\) pendingTransferOp\.current = null;/);
  assert.equal(fn.match(/await recordWalletTransfer\(\{/g)?.length, 1);
  assert.doesNotMatch(fn, /appendEvent|recordExpense|addExpense|expenses/, "no second path, no expense");
  assert.match(page, /void loadWalletTransfers\(\);/, "the history is read from the ledger on open and after a transfer");
});

test("TR.3b 053: one transfer per operation per store; replay before append; tenant-scoped; history from the ledger", () => {
  const m = read("docs/migrations/053_wallet_transfer_idempotency_and_history.sql");
  assert.match(m, /ON public\.ledger_events \(store_id, ref_id\)\s+WHERE kind = 'wallet_transfer' AND ref_id IS NOT NULL/);
  const fn = m.slice(m.indexOf("FUNCTION public.record_wallet_transfer"), m.indexOf("FUNCTION public.wallet_transfer_history"));
  assert.ok(fn.indexOf("pg_advisory_xact_lock") < fn.indexOf("'replayed', true") && fn.indexOf("'replayed', true") < fn.indexOf("ledger_append"));
  assert.match(fn, /e\.store_id = v_store AND e\.kind = 'wallet_transfer' AND e\.ref_id = v_op/);
  assert.doesNotMatch(m, /\bEXCEPTION\s+WHEN\b/i, "043");
  assert.doesNotMatch(m, /SECURITY DEFINER/);
  assert.doesNotMatch(m, /CREATE TABLE/, "no second copy of any transfer");
  assert.match(m, /REVOKE ALL ON FUNCTION public\.record_wallet_transfer\(jsonb\) FROM public, anon;/);
  assert.match(m, /REVOKE ALL ON FUNCTION public\.wallet_transfer_history\(uuid, integer\) FROM public, anon;/);
});

test("TR.4 no local-only phantom expense path is left in the store", () => {
  const store = read("src/store/useFinancialStore.ts").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(store, /logDiscrepancyToProfitLoss/);
  // The only writers of `expenses` are the hydrate, the atomic RPC and delete.
  const writes = store.match(/expenses:\s*[^,\n]*/g) ?? [];
  assert.ok(!writes.some((w) => /\[\s*\.\.\.state\.expenses/.test(w)), `a local expense append: ${writes.join(" | ")}`);
  assert.doesNotMatch(store, /category: "other",\s*amount/);
});
