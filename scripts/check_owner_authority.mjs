/**
 * P1-E — one answer to "how much did the shop make".
 *
 *     node --test scripts/check_owner_authority.mjs
 *
 * ## What was actually duplicated
 *
 * `owner_financial_summary` (migration 034) is built on `ledger_balances` —
 * the same SQL function Desktop's `balances()` driver calls. So there was
 * never a second AGGREGATION; there is one SQL authority for every SUM. What
 * was duplicated was the arithmetic on top: net profit was written four times
 * — once in the RPC, and three more times on the client (`pnl()`,
 * `summarise()`, الشركاء والمالية inline). They agreed, which is what made them
 * dangerous: nothing would have noticed the day one grew a fourth term.
 *
 * ## Why Desktop still computes at all
 *
 * The RPC is ADMIN-only, by decision (034): it is the Owner cockpit's
 * surface. `/partners` is open to ACCOUNTANT too, and migration 034 says in so
 * many words that ACCOUNTANT keeps its screens on `useBalances`. The reports
 * tab needs up to 60 buckets per report, which one RPC call per bucket would
 * not serve. So:
 *
 *   نظرة عامة (ADMIN-only)  → consumes the RPC's figures, computes none
 *   everything else          → ONE client definition, `netProfitOf`, pinned
 *                              here to the SQL one
 *
 * The runtime cross-check (RPC vs Desktop reads, 13 metrics × 5 windows, 65
 * comparisons, 0 mismatches) is recorded in the audit, §P1-5.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { netProfitOf, pnl } from "../src/lib/ledger/reports.ts";
import { summarise } from "../src/lib/dashboard.ts";
import { fromPiastres } from "../src/lib/ledger/money.ts";
import { formatMoney } from "../src/lib/math.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const code = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
const src = (p) => code(read(p));

// ── One client definition ───────────────────────────────────────────────────

test("netProfitOf is revenue − cogs − expenses, and nothing else", () => {
  assert.equal(netProfitOf({ revenue: 1000, cogs: 400, expenses: 150 }), 450);
  assert.equal(netProfitOf({ revenue: 0, cogs: 0, expenses: 0 }), 0);
  assert.equal(netProfitOf({ revenue: 100, cogs: 300, expenses: 50 }), -250, "a loss stays a loss — no clamping");
});

test("pnl() and summarise() both answer through netProfitOf", () => {
  const rows = (n) => [{ subjectId: "pos", qty: 0, amount: n }];
  const p = pnl({
    revenueRows: rows(1000),
    expenseRows: [{ subjectId: "rent", qty: 0, amount: 150 }],
    cogs: 400,
    returnsRevenue: 0,
    purchases: 0,
  });
  const s = summarise({
    revenueRows: rows(1000),
    cogsRows: [{ subjectId: "p1", qty: 0, amount: 400 }],
    expenseRows: [{ subjectId: "rent", qty: 0, amount: 150 }],
    events: [],
  });
  const expected = netProfitOf({ revenue: 1000, cogs: 400, expenses: 150 });
  assert.equal(p.netProfit, expected);
  assert.equal(s.netProfit, expected);

  const reports = src("../src/lib/ledger/reports.ts");
  const dashboard = src("../src/lib/dashboard.ts");
  assert.match(reports, /netProfit: netProfitOf\(\{ revenue: netSales, cogs: input\.cogs, expenses \}\)/);
  assert.match(dashboard, /netProfit: netProfitOf\(\{/);
});

test("no screen writes its own profit subtraction", () => {
  // Any `<sales|revenue> − <cogs>` outside the one definition is a second
  // formula waiting to drift. Mobile is out of scope and reads the RPC.
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "mobile") walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(e.name)) continue;
      const s = src(path);
      // Member access included: `owner.data.revenue - owner.data.cogs` is the
      // same second formula as `revenue - cogs`.
      const hits = s.match(/[\w.?]*(revenue|sales|Sales|Revenue)[\w.?]*\s*-\s*[\w.?]*(cogs|COGS|Cogs)\w*/g) ?? [];
      for (const h of hits) {
        // The one definition, and pnl's gross profit (its only other line).
        if (path.endsWith("lib/ledger/reports.ts")) continue;
        offenders.push(`${path}: ${h}`);
      }
    }
  };
  walk("../src");
  assert.deepEqual(offenders, [], "a profit formula is being written outside netProfitOf");
});

test("Partners uses netProfitOf and stays on useBalances (034: ACCOUNTANT)", () => {
  const s = src("../src/components/finance/PartnersFinancePage.tsx");
  assert.match(s, /profit: netProfitOf\(\{ revenue: ledgerSales, cogs: totalCOGS, expenses: ledgerExpenses \}\)/);
  // Moving it onto the RPC would lock ACCOUNTANT out of a screen the route map
  // grants them — the RPC refuses every role but ADMIN.
  assert.ok(!/owner_financial_summary|useOwnerFinancialSummary/.test(s),
    "Partners moved onto the ADMIN-only reader — ACCOUNTANT would lose it");
  const roles = src("../src/lib/roles.ts");
  assert.match(roles, /"\/partners": \["ACCOUNTANT"\]/, "if ACCOUNTANT lost /partners, revisit this decision");
});

// ── The Owner cockpit consumes the server ───────────────────────────────────

const dash = src("../src/components/dashboard/ExecutiveDashboard.tsx");

test("نظرة عامة reads its money from owner_financial_summary", () => {
  assert.match(dash, /const owner = useOwnerFinancialSummary\(ownerWindow\);/);
  assert.match(dash, /owner\.data\?\.netProfit/);
  assert.match(dash, /owner\.data\?\.revenue/);
  for (const field of ["walletBalances", "stockValue", "receivableClient", "supplierPayable"]) {
    assert.ok(dash.includes(`owner.data.${field}`), `net worth must be built from the server's ${field}`);
  }
});

test("نظرة عامة computes no money figure of its own", () => {
  assert.ok(!/useBalances\(/.test(dash), "a client ledger sum is back on the Owner cockpit");
  assert.ok(!/summarise\(/.test(dash), "summarise() re-derives net profit — the cockpit must take the server's");
  assert.ok(!/netProfitOf\(/.test(dash));
  assert.match(dash, /windowCounts\(\{ cogsRows, events: windowEvents \}\)/, "counts come from the one shared definition");
  // `balances()` is still called — for the COUNTS and the trend, which the
  // RPC does not carry — but never on the three money accounts' totals.
  assert.ok(!/balances\(\{ account: "(expense|wallet|stock|payable_supplier|receivable_client)"/.test(dash));
});

test("the cockpit shows no figure while a read has failed", () => {
  assert.match(dash, /\{!error && \(/, "the KPI grid must be withdrawn on failure, not zeroed");
  const grid = dash.indexOf("{!error && (");
  assert.ok(grid > -1 && grid < dash.indexOf("owner.data?.netProfit"));
});

const hook = src("../src/lib/ledger/useOwnerFinancialSummary.ts");

test("a failed Owner read drops the last figures instead of keeping them", () => {
  const onError = hook.slice(hook.indexOf("(e) => {"));
  assert.match(onError.slice(0, 600), /setData\(null\);/, "a number from the last window under a new window's failure is stale-as-current");
});

test("a refusal is told apart from a network failure", () => {
  assert.match(hook, /42501\|permission denied\|ADMIN only/);
  assert.match(hook, /setError\(refused \? DENIED_MESSAGE : FAILED_MESSAGE\);/);
});

test("a failed Owner read is handled, not left as an unhandled rejection", () => {
  // Found at runtime: `void promise.finally(...)` re-rejected into nothing.
  assert.ok(!/void promise\.finally\(/.test(hook), "`.finally` returns a new promise that re-rejects unhandled");
  assert.match(hook, /promise\.then\(clear, clear\);/);
});

test("a double-clicked retry asks the RPC once", () => {
  assert.match(hook, /const reload = useCallback\(\(\) => \{\s*if \(inFlight\.current\) return;/);
  assert.match(hook, /if \(existing && existing\.key === key\) \{\s*promise = existing\.promise;/);
});

// ── SQL and TypeScript are the same formula ─────────────────────────────────

test("the RPC's subtractions are the client's subtractions", () => {
  const m = read("../docs/migrations/034_period_filter_and_owner_financials.sql");
  assert.match(m, /'grossProfit',\s*v_revenue - v_cogs,/);
  assert.match(m, /'netProfit',\s*v_revenue - v_cogs - v_expenses,/);
  assert.match(m, /'returnsValue',\s*-v_returns,/);
  // And both sides aggregate through the same SQL function.
  assert.match(m, /FROM public\.ledger_balances\(p_store, 'revenue', NULL, NULL, p_from, p_to\)/);
  const reports = src("../src/lib/ledger/reports.ts");
  assert.match(reports, /grossProfit: netSales - input\.cogs,/);
  assert.match(reports, /returns: -input\.returnsRevenue,/);
});

test("piastres → EGP → netProfitOf displays exactly what SQL computed", () => {
  // The RPC subtracts integer piastres; the client subtracts EGP floats after
  // `fromPiastres`. A float residue (0.1 + 0.2) must never reach the screen.
  // Deterministic sweep, including the live QA-STORE figures (65 checks, 0
  // mismatches: revenue 750000, cogs 346964, expenses 383143 → net 19893).
  const cases = [[750000, 346964, 383143]];
  let seed = 7;
  const rand = () => (seed = (seed * 48271) % 2147483647) % 10_000_000;
  for (let i = 0; i < 2000; i++) cases.push([rand(), rand(), rand()]);
  for (const [r, c, e] of cases) {
    const sql = r - c - e;
    const client = netProfitOf({ revenue: fromPiastres(r), cogs: fromPiastres(c), expenses: fromPiastres(e) });
    assert.equal(formatMoney(client), formatMoney(fromPiastres(sql)), `r=${r} c=${c} e=${e}`);
  }
});
