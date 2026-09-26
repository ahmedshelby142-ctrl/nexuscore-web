/**
 * P1-D — loading, empty and error are three different things.
 *
 *     node --test scripts/check_load_states.mjs
 *
 * Two readers answered "nothing" in situations that were not nothing:
 *
 *   * the hydrated stores start EMPTY, so `rows.length === 0` meant "no
 *     products", "not arrived yet" and "the read failed" at once — and every
 *     list said «لا توجد …» for all three;
 *   * `useBalances` answers `total = 0` before its read lands AND after it
 *     fails, so every money figure built on it printed «٠ ج.م» for a read that
 *     never happened.
 *
 * Worse than the labels: four commit paths DECIDED on those zeros — a supplier
 * or trader return settled against an unread debt of 0 posts as a cash refund,
 * and a جرد against an unread quantity of 0 books phantom surplus.
 *
 * The rules (`figure.ts`, `useSyncStatus`) are driven for real. The wiring on
 * each screen is asserted on comment-stripped source, the house style — those
 * modules import through `@/` and React, which `node --test` cannot resolve.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { statusOf, moneyFigure, figureOr } from "../src/lib/figure.ts";
import { formatMoney } from "../src/lib/math.ts";
import { useSyncStatus } from "../src/store/useSyncStatus.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/** Comments stripped: every file here explains the old behaviour in prose. */
const code = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");

const src = (p) => code(read(p));

const OK = { loading: false, error: null };
const LOADING = { loading: true, error: null };
const FAILED = { loading: false, error: "network" };
const RETRYING = { loading: true, error: "network" };

// ── The figure rule, driven ─────────────────────────────────────────────────

test("a failed read never renders as zero", () => {
  assert.notEqual(moneyFigure(0, FAILED), formatMoney(0));
  assert.equal(moneyFigure(0, FAILED), formatMoney(null), "it uses the project's own «— ج.م»");
  // And never as the stale number either — a failure after a success must
  // not keep painting what the last good read said.
  assert.equal(moneyFigure(12345, FAILED), formatMoney(null));
});

test("loading never renders as zero or as empty", () => {
  assert.equal(moneyFigure(0, LOADING), "…");
  assert.notEqual(moneyFigure(0, LOADING), formatMoney(0));
});

test("a real zero is still a zero", () => {
  assert.equal(moneyFigure(0, OK), formatMoney(0));
  assert.equal(moneyFigure(1500, OK), formatMoney(1500));
});

test("failure outranks loading — a retry in flight is still a failure", () => {
  assert.equal(statusOf(RETRYING), "error");
  assert.equal(statusOf(OK, LOADING, FAILED), "error");
  assert.equal(statusOf(OK, LOADING), "loading");
  assert.equal(statusOf(OK, OK), "ready");
  assert.equal(statusOf(), "ready", "no reads, nothing to wait for");
});

test("a figure built on several reads needs every one of them", () => {
  assert.equal(moneyFigure(100, OK, FAILED), formatMoney(null));
  assert.equal(moneyFigure(100, OK, LOADING), "…");
});

test("figureOr never even computes a figure from unread inputs", () => {
  let called = 0;
  const render = () => {
    called += 1;
    return "computed";
  };
  figureOr(render, FAILED);
  figureOr(render, LOADING);
  assert.equal(called, 0);
  assert.equal(figureOr(render, OK), "computed");
});

test("a successful retry clears the error", () => {
  // The sequence a screen goes through: failed → retrying → answered.
  assert.equal(moneyFigure(250, FAILED), formatMoney(null));
  assert.equal(moneyFigure(250, RETRYING), formatMoney(null));
  assert.equal(moneyFigure(250, OK), formatMoney(250));
});

// ── Per-table status, driven ────────────────────────────────────────────────

test("a failed table records why, and a reload clears it", () => {
  const s = useSyncStatus.getState();
  s.markTable("products", "loading");
  assert.equal(useSyncStatus.getState().tables.products, "loading");
  s.markTable("products", "failed", "boom");
  assert.equal(useSyncStatus.getState().tables.products, "failed");
  assert.equal(useSyncStatus.getState().tableErrors.products, "boom");
  s.markTable("products", "ready");
  assert.equal(useSyncStatus.getState().tables.products, "ready");
  assert.equal(useSyncStatus.getState().tableErrors.products, undefined, "a stale error would outlive its fix");
});

// ── The hydrate records status, and retry reuses it ─────────────────────────

const hydrate = src("../src/services/cloudHydrate.ts");

test("hydrateAll marks every table loading before it reads any", () => {
  const body = hydrate.slice(hydrate.indexOf("export async function hydrateAll"));
  const markAll = body.indexOf('markTable(table, "loading")');
  const loop = body.indexOf("await hydrateTable(table)");
  assert.ok(markAll > -1, "the tables emptied by the clear are not marked loading");
  assert.ok(loop > -1, "hydrateAll no longer reads through hydrateTable");
  assert.ok(markAll < loop, "tables late in the serial loop would claim `ready` while holding nothing");
});

test("hydrateTable is the one reader: same list call, same sink, status recorded", () => {
  const fn = hydrate.slice(hydrate.indexOf("export async function hydrateTable"));
  assert.match(fn, /await cloudList\(table\)/);
  assert.match(fn, /sink\(rows\)/);
  assert.match(fn, /markTable\(table, "ready"\)/);
  assert.match(fn, /markTable\(table, "failed"/);
  assert.match(fn, /if \(hydrating\.has\(table\)\) return -1;/, "a double retry would read the table twice");
  assert.ok(!/clearCloudOwnedState\(/.test(fn), "a single-table retry must not blank every other screen");
});

const gate = src("../src/components/ui/collection-gate.tsx");

test("an unknown table status is loading, never empty", () => {
  assert.match(gate, /tables\.some\(\(t\) => statuses\[t\] !== "ready"\)/);
  assert.match(gate, /failed\.length > 0 \? "error" : loading \? "loading" : "ready"/, "failure must outrank loading");
});

test("the gate's retry re-reads only the failed tables, through hydrateTable", () => {
  assert.match(gate, /hydrateTable\(table\)/);
  assert.match(gate, /tables\[table\] === "failed"/);
  assert.ok(!/hydrateAll/.test(gate), "a retry must not wipe and re-read every table");
});

test("the gate renders children only when ready", () => {
  const body = gate.slice(gate.indexOf("export function CollectionGate"));
  assert.match(body, /if \(status === "error"\) \{\s*return <LoadError/);
  assert.match(body, /if \(status === "loading"\) \{/);
  assert.ok(body.indexOf('status === "error"') < body.indexOf("<>{children}</>"));
});

// ── Retry cannot be double-fired ────────────────────────────────────────────

const loadError = src("../src/components/ui/load-error.tsx");

test("LoadError refuses a click while busy or just clicked", () => {
  assert.match(loadError, /if \(busy \|\| locked\.current\) return;/);
  assert.match(loadError, /locked\.current = true;[\s\S]*onRetry\(\);/, "lock before calling, or two same-frame clicks both get through");
  assert.match(loadError, /disabled=\{busy \|\| locked\.current\}/);
  assert.ok(!/fetch\(|supabase|rpc\(/.test(loadError), "the banner must never fetch anything itself");
});

test("useBalances reports a recovery as loading, and only a recovery", () => {
  const hook = src("../src/lib/ledger/useBalances.ts");
  assert.match(hook, /failed\.current = error !== null;/);
  assert.match(hook, /if \(failed\.current\) setLoading\(true\);/, "a retry after failure would be invisible — nothing for `busy` to hold");
});

// ── Every list screen gates its empty message ───────────────────────────────

/** [file, table, the empty message that must sit inside a gate for it] */
const EMPTY_STATES = [
  ["../src/components/products/ProductsPage.tsx", "products", "لسه مفيش منتجات"],
  ["../src/components/inventory/InventoryTable.tsx", "products", "لسه مفيش منتجات"],
  ["../src/components/purchasing/PurchasingPage.tsx", "purchase_invoices", "لا توجد فواتير مشتريات"],
  ["../src/components/purchasing/PurchasingPage.tsx", "suppliers", "لا يوجد موردين"],
  ["../src/components/wholesale/WholesalePage.tsx", "wholesale_invoices", "مفيش فواتير جملة"],
  ["../src/components/wholesale/WholesalePage.tsx", "wholesale_clients", "مفيش عملاء متسجلين"],
  ["../src/components/ecommerce/OrdersPage.tsx", "orders", "لا توجد طلبات في هذا التصنيف"],
  ["../src/components/ecommerce/CRMPage.tsx", "customers", "لسه مفيش عملاء"],
  ["../src/components/ecommerce/CRMPage.tsx", "orders", "لا توجد طلبات لهذا العميل"],
  ["../src/components/ecommerce/BundlesPage.tsx", "products", "لا توجد تجميعات محفوظة"],
  ["../src/components/ecommerce/DiscountsPage.tsx", "discount_codes", "لا توجد أكواد خصم محفوظة"],
  ["../src/routes/returns.tsx", "return_records", "لا توجد عمليات إرجاع أو استبدال حتى الآن"],
  ["../src/routes/returns.tsx", "orders", "مفيش أوردرات معلقة في حالة مرتجع حاليا"],
  ["../src/routes/branches.tsx", "branches", "لا توجد فروع مسجلة"],
];

test("no list says «empty» before its table has actually been read", () => {
  for (const [file, table, message] of EMPTY_STATES) {
    const s = src(file);
    const at = s.indexOf(message);
    assert.ok(at > -1, `${file}: the empty message moved — retarget the test`);
    const opened = s.lastIndexOf(`<CollectionGate tables={["${table}"]}`, at);
    const closed = s.lastIndexOf("</CollectionGate>", at);
    assert.ok(
      opened > -1 && opened > closed,
      `${file}: «${message}» renders without waiting for "${table}" — during the hydrate or after a failed read it lies`,
    );
  }
});

test("every gated table is one the hydrate actually loads", () => {
  // A gate on a table with no sink waits forever — it is never marked ready.
  const sinks = hydrate.slice(hydrate.indexOf("const SINKS"), hydrate.indexOf("};", hydrate.indexOf("const SINKS")));
  const named = new Set(EMPTY_STATES.map(([, t]) => t));
  for (const t of named) {
    assert.match(sinks, new RegExp(`\\n\\s*${t}:`), `${t} is gated but never hydrated`);
  }
});

test("the returns log reads the store reactively", () => {
  const s = src("../src/routes/returns.tsx");
  assert.ok(
    !/getState\(\)\.returnRecords\.length/.test(s) && !/\[\.\.\.useBusinessStore\.getState\(\)\.returnRecords\]/.test(s),
    "read once per render with getState(), the log never learns about records the hydrate delivers later",
  );
});

// ── Money figures on every financial screen ─────────────────────────────────

test("courier balances are withdrawn, not zeroed, when a read fails", () => {
  const s = src("../src/components/ecommerce/CourierLedgerPage.tsx");
  for (const expr of [
    "moneyFigure(owedToUs.total, owedToUs)",
    "moneyFigure(owedToThem.total, owedToThem)",
    "moneyFigure(returnFeesBorne, expense)",
    "moneyFigure(owedToUs.total - owedToThem.total, owedToUs, owedToThem)",
    "moneyFigure(ours, owedToUs)",
    "moneyFigure(theirs, owedToThem)",
  ]) {
    assert.ok(s.includes(expr), `courier: ${expr} is missing — that figure prints ٠ on failure`);
  }
  assert.ok(!/formatMoney\(owedTo(Us|Them)\.total\)/.test(s), "a raw courier total is back");
  assert.match(s, /<LoadError[\s\S]{0,200}onRetry=\{retryBalances\}/);
});

test("a courier statement is never printed from unread balances", () => {
  const s = src("../src/components/ecommerce/CourierLedgerPage.tsx");
  const fn = s.slice(s.indexOf("const handleExportPdf"));
  assert.match(fn.slice(0, 200), /if \(balanceStatus !== "ready"\) return;/);
  assert.match(s, /disabled=\{balanceStatus !== "ready"\}/);
});

test("supplier balances and the purchasing totals wait for their reads", () => {
  const s = src("../src/components/purchasing/PurchasingPage.tsx");
  assert.match(s, /figureOr\(\s*\(\) => formatBalance\(supplierMetrics\?\.owed \?\? 0/);
  assert.match(s, /moneyFigure\(totalVolume, docsRead\)/);
  assert.match(s, /disabled=\{statusOf\(supplierDebt\) !== "ready"\}/, "a payment pre-filled from an unread balance pre-fills nothing");
});

test("client receivables, the POS wallets and customer LTV wait for their reads", () => {
  const w = src("../src/components/wholesale/WholesalePage.tsx");
  assert.match(w, /moneyFigure\(Math\.abs\(totalReceivables\), clientDebt\)/);
  assert.match(w, /figureOr\(\(\) => formatBalance\(owed\), clientDebt\)/);
  assert.match(w, /statusOf\(clientDebt\) === "ready" \? \(\s*<Badge/, "«حساب جيد» must only be claimed of a balance that was read");
  const pos = src("../src/components/sales/CheckoutForm.tsx");
  assert.match(pos, /moneyFigure\(walletBalance\(key\), wallets\)/);
  const crm = src("../src/components/ecommerce/CRMPage.tsx");
  assert.match(crm, /moneyFigure\(ltvOf\(customer\.id\), ltv\)/);
  const form = src("../src/routes/ecommerce-orders.tsx");
  assert.match(form, /ltvOf=\{statusOf\(ltv\) === "ready" \? ltvOf : undefined\}/);
});

test("stock value waits for BOTH the ledger and the product list", () => {
  const s = src("../src/components/inventory/StockSummaryCards.tsx");
  assert.match(s, /read: ReadState;/, "the read state must be required, like costOf");
  assert.match(s, /moneyFigure\(totalValue, read, listRead\)/);
  assert.match(s, /figure: count\(products\.length\)/);
});

test("Partners withdraws a card when ANY read under it is loading or failed", () => {
  const s = src("../src/components/finance/PartnersFinancePage.tsx");
  assert.match(s, /const val = figureOr\(\(\) => kpi\.compute\(ls\), \.\.\.reads\);/);
  assert.match(s, /const profitAvailable = statusOf\(salesRead, cogsRead, expenseRead\) === "ready";/);
  assert.match(s, /walletsKnown && !hasOpeningBalance/, "an unread wallet read prompts a second opening balance");
  assert.match(s, /<LoadError[\s\S]{0,300}onRetry=\{retryLedgerReads\}/);
});

// ── The commit paths that used to DECIDE on an unread zero ──────────────────

test("no return is settled against an unread debt", () => {
  for (const [file, read] of [
    ["../src/components/purchasing/PurchasingPage.tsx", "supplierDebt"],
    ["../src/components/wholesale/WholesalePage.tsx", "clientDebt"],
    ["../src/components/sales/CheckoutForm.tsx", "clientDebt"],
    ["../src/components/ecommerce/OrdersPage.tsx", "clientDebt"],
  ]) {
    const s = src(file);
    assert.ok(
      s.includes(`if (statusOf(${read}) !== "ready") {`),
      `${file}: a return can be settled against a debt read that did not answer — it would post as a cash refund`,
    );
  }
});

test("the return panel shows no settlement built on an unread debt", () => {
  const s = src("../src/components/wholesale/WholesaleReturnPanel.tsx");
  assert.match(s, /debtRead: ReadState;/, "required, so no caller can forget it");
  assert.match(s, /debtStatus !== "ready" \? \(/);
});

test("a stock count is never booked against an unread ledger", () => {
  const s = src("../src/components/finance/StockAuditPage.tsx");
  const fn = s.slice(s.indexOf("const handleConfirmAudit"));
  const guard = fn.indexOf('if (statusOf(stock) !== "ready") {');
  const append = fn.indexOf("appendEvent(");
  assert.ok(guard > -1 && guard < append, "a جرد against qtyOf() = 0 books phantom surplus");
});

test("a dividend is never computed without the partners' draws", () => {
  const s = src("../src/components/finance/CapitalEquityPage.tsx");
  assert.match(s, /periodProfit === null \|\| statusOf\(draws\) !== "ready"\s*\?\s*\[\]/, "draws of 0 pay a working partner twice");
  assert.match(s, /const exportReady =\s*periodProfit !== null && statusOf\(walletRead\) === "ready" && statusOf\(draws\) === "ready";/);
  const exportFn = s.slice(s.indexOf("const handleExportPdf"));
  const guard = exportFn.indexOf("if (!exportReady) return;");
  assert.ok(
    guard > -1 && guard < exportFn.indexOf("periodProfit ?? 0"),
    "the PDF prints `periodProfit ?? 0` — it must be unreachable until the profit was read",
  );
});

test("a failed profit read is not shown as 'still calculating'", () => {
  const s = src("../src/components/finance/CapitalEquityPage.tsx");
  // Inside the no-partners branch: the error is checked before the spinner.
  const branch = s.slice(s.indexOf("partners.length === 0 ?"));
  const err = branch.indexOf("تعذّر حساب صافي الربح — شوف الرسالة فوق");
  const spinner = branch.indexOf("Loader2");
  assert.ok(err > -1 && err < spinner, "an error rendered as the loading spinner never ends");
  assert.match(s, /onRetry=\{\(\) => setProfitTick\(\(t\) => t \+ 1\)\}/);
});

test("store settings are never pushed over values that were not read", () => {
  const store = src("../src/store/useSettingsStore.ts");
  const push = store.slice(store.indexOf("pushSettings: async"));
  assert.match(push.slice(0, 900), /if \(state\.settingsStatus !== "ready"\) \{\s*throw new Error/);
  assert.match(store, /set\(\{ settingsStatus: "failed", settingsError: error\.message \}\);/);
  assert.match(store, /partialize: \(s\) => \(\{[\s\S]*?vatRate: s\.vatRate,\s*\}\)/, "the load status must not be persisted");
  assert.ok(!/partialize[\s\S]{0,300}settingsStatus/.test(store));
  const panel = src("../src/components/settings/GeneralSettingsPanel.tsx");
  assert.match(panel, /<fieldset disabled=\{!editable\}/);
  assert.match(panel, /disabled=\{isSaving \|\| !editable\}/);
});

test("the staff list says a failed read failed, instead of 'no one but you'", () => {
  const s = src("../src/components/auth/UserManagementPanel.tsx");
  const err = s.indexOf("staffMembers.length === 0 && error ?");
  const empty = s.indexOf("مفيش مستخدمين غيرك");
  assert.ok(err > -1 && err < empty);
});

test("the dashboard's restock count waits for the list and the ledger", () => {
  const s = src("../src/components/dashboard/ExecutiveDashboard.tsx");
  assert.match(s, /useCollectionStatus\(\["products"\]\)/);
  assert.match(s, /restockStatus === "error"\s*\?\s*"—"\s*:\s*restockStatus === "loading"/);
});
