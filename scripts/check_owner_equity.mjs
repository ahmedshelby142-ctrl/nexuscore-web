/**
 * حقوق الملكية — owner capital, contributions, drawings and equity (049).
 *
 *     node --test scripts/check_owner_equity.mjs
 *
 * ## The defect this exists to prevent
 *
 * «رأس المال» was `partner.capitalContribution`: a number typed into the
 * browser (partners have no cloud table), summed over partner rows. A sole
 * owner with no partner row had no capital at all; «إضافة مساهمة» moved no
 * money and wrote nothing to the ledger; two devices disagreed.
 *
 * Now capital and contributions are ledger events (`owner_capital`,
 * `owner_contribution` → `owner_equity`), drawings stay `owner_draw` →
 * `owner_budget`, profit is the one P&L definition, and ONE function —
 * `equityStatement` — turns them into the statement every screen shows.
 *
 * Behaviour against the live database: scripts/security/049_equity_matrix.sql
 * (both parts, rolled back) — docs/OWNER_EQUITY_MODEL.md.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const fnOf = (text, name) => text.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$function\\$;`))?.[0] ?? "";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) return next(new URL(`src/${specifier.slice(2)}.ts`, root).href, context);
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const eq = await import(new URL("src/lib/ledger/equity.ts", root).href);

const M046 = read("docs/migrations/046_order_deposit_boundary.sql");
const M049 = read("docs/migrations/049_owner_equity.sql");

// ── helpers ─────────────────────────────────────────────────────────────────
const rows = (...pairs) => pairs.map(([subjectId, amount]) => ({ subjectId, amount }));
const base = {
  capitalRows: [], contributionRows: [], drawRows: [], capitalCash: 0,
  adjustmentStock: 0, adjustmentWallet: 0, adjustmentExpense: 0, revenue: 0, cogs: 0, expenses: 0,
};
const stmt = (over) => eq.equityStatement({ ...base, ...over });

// ═══ The spec scenarios ═════════════════════════════════════════════════════

test("§10 sole owner: 500k capital + 100k contribution + 300k profit − 80k drawings = 820k equity", () => {
  const s = stmt({
    capitalRows: rows(["owner", 500000]), capitalCash: 500000,
    contributionRows: rows(["owner", 100000]),
    drawRows: rows(["owner", 80000]),
    revenue: 450000, cogs: 100000, expenses: 50000, // profit 300,000
  });
  assert.equal(s.capital, 500000, "capital is what was PUT IN — not 820,000");
  assert.equal(s.contributions, 100000);
  assert.equal(s.accumulatedResult, 300000);
  assert.equal(s.withdrawals, 80000);
  assert.equal(s.totalEquity, 820000);
  assert.equal(s.openingBalances, 0);
});

test("§11 loss: 500k + 100k − 150k loss − 50k drawings = 400k", () => {
  const s = stmt({
    capitalRows: rows(["owner", 500000]), capitalCash: 500000,
    contributionRows: rows(["owner", 100000]),
    drawRows: rows(["owner", 50000]),
    revenue: 100000, cogs: 50000, expenses: 200000, // −150,000
  });
  assert.equal(s.accumulatedResult, -150000);
  assert.equal(s.capital, 500000, "a loss never touches capital");
  assert.equal(s.totalEquity, 400000);
});

test("§12 no partners: capital and equity exist with only the owner", () => {
  const s = stmt({ capitalRows: rows(["owner", 250000]), capitalCash: 250000 });
  assert.equal(s.capital, 250000);
  assert.equal(s.totalEquity, 250000);
  assert.deepEqual(s.owners.map((o) => o.subjectId), ["owner"]);
  // Nothing in the formula or the card is conditioned on partner rows.
  assert.doesNotMatch(code(read("src/lib/ledger/equity.ts")), /partners?\b/i);
  assert.doesNotMatch(code(read("src/components/finance/OwnerEquityCard.tsx")), /partners\.length\s*>|owners\.length\s*>\s*0\s*&&\s*<OwnerEquity/);
  assert.match(read("src/components/finance/PartnersFinancePage.tsx"), /\{\/\* Equity belongs to the business: shown with or without partners\. \*\/\}\n\s*<OwnerEquityCard equity=\{equity\} \/>/);
});

test("§13 no opening capital: «not recorded», never an invented number", () => {
  // A historical store: opening wallets + stock, sales, expenses — no capital entry.
  const s = stmt({ adjustmentStock: 300000, adjustmentWallet: 50000, revenue: 200000, cogs: 120000, expenses: 30000 });
  assert.equal(s.capital, null, "absent, not 0 — and not derived from assets or equity");
  assert.equal(s.openingBalances, 350000, "the opening balances stay what they are");
  assert.equal(s.totalEquity, 400000);
  // An authoritative zero is still a zero: an entry, corrected down to nothing.
  const zero = stmt({ capitalRows: rows(["owner", 100000], ["owner", -100000]) });
  assert.equal(zero.capital, 0);
  const card = read("src/components/finance/OwnerEquityCard.tsx");
  assert.match(card, /s\.capital === null \? "غير مسجل" : formatMoney\(s\.capital\)/);
  assert.match(card, /رأس المال الافتتاحي غير مسجل — ده مش معناه إنه صفر/);
});

test("§14 a withdrawal lowers equity, never profit", () => {
  const before = stmt({ capitalRows: rows(["owner", 100000]), capitalCash: 100000, revenue: 50000 });
  const after = stmt({ capitalRows: rows(["owner", 100000]), capitalCash: 100000, revenue: 50000, drawRows: rows(["owner#أكل", 20000]) });
  assert.equal(after.accumulatedResult, before.accumulatedResult, "profit untouched");
  assert.equal(after.totalEquity, before.totalEquity - 20000);
  assert.equal(after.capital, before.capital);
  assert.equal(after.owners.find((o) => o.subjectId === "owner").withdrawals, 20000, "a categorised draw is still the owner's");
  // And the draw itself is not an expense: its own kind, its own account.
  const lines = read("src/lib/ledger/ownerDraw.ts");
  assert.match(lines, /\{ account: "owner_budget", subjectId: draw\.subjectId, amount: draw\.amount \}/);
});

test("§15 a contribution raises equity and cash, never revenue or profit", () => {
  const lines = eq.buildOwnerContributionLines({ subjectId: "owner", amount: 100000, wallet: "bankAccount" });
  assert.deepEqual(lines, [
    { account: "owner_equity", subjectId: "owner", amount: 100000 },
    { account: "wallet", subjectId: "bankAccount", amount: 100000 },
  ]);
  assert.ok(!lines.some((l) => ["revenue", "expense", "cogs"].includes(l.account)));
  const s = stmt({ contributionRows: rows(["owner", 100000]) });
  assert.equal(s.accumulatedResult, 0);
  assert.equal(s.totalEquity, 100000);
});

test("§17 two-year history: original capital stays distinguishable from current equity", () => {
  // Go-live: 50k in wallets and 300k of stock recorded as opening balances.
  // The owner declares she started with 200k (paid long before the ledger).
  // Two years: 900k revenue, 500k cost, 150k expenses; a 100k contribution; 120k drawn.
  const s = stmt({
    adjustmentStock: 300000, adjustmentWallet: 50000,
    capitalRows: rows(["owner", 200000]), capitalCash: 0,
    contributionRows: rows(["owner", 100000]),
    drawRows: rows(["owner", 120000]),
    revenue: 900000, cogs: 500000, expenses: 150000,
  });
  assert.equal(s.capital, 200000, "the declared original capital, unchanged by profit or stock");
  assert.equal(s.openingBalances, 150000, "declared capital is carved OUT of the opening balances, not added");
  assert.equal(s.accumulatedResult, 250000);
  assert.equal(s.totalEquity, 200000 + 100000 + 150000 + 250000 - 120000);
  // Declaring historical capital moves no equity — only its classification.
  const undeclared = stmt({ ...s, adjustmentStock: 300000, adjustmentWallet: 50000, capitalRows: [], capitalCash: 0,
    contributionRows: rows(["owner", 100000]), drawRows: rows(["owner", 120000]), revenue: 900000, cogs: 500000, expenses: 150000 });
  assert.equal(undeclared.totalEquity, s.totalEquity);
});

test("§8 multiple partners: capital, contributions and drawings per owner; profit is not allocated", () => {
  const s = stmt({
    capitalRows: rows(["owner", 300000], ["p-1", 200000]), capitalCash: 500000,
    contributionRows: rows(["p-1", 50000]),
    drawRows: rows(["owner", 10000], ["p-1", 5000]),
    revenue: 100000,
  });
  const byId = Object.fromEntries(s.owners.map((o) => [o.subjectId, o]));
  assert.deepEqual(byId["p-1"], { subjectId: "p-1", capital: 200000, contributions: 50000, withdrawals: 5000 });
  assert.deepEqual(byId.owner, { subjectId: "owner", capital: 300000, contributions: 0, withdrawals: 10000 });
  assert.ok(!("profitShare" in byId["p-1"]), "no invented profit-sharing rule");
  assert.equal(s.capital, 500000);
});

test("no double counting: profit and withdrawals each enter equity exactly once", () => {
  const s = stmt({ capitalRows: rows(["owner", 100]), capitalCash: 100, revenue: 70, drawRows: rows(["owner", 30]) });
  assert.equal(s.totalEquity, 100 + 70 - 30);
  // Equity is built from its components — never "net assets, then + profit again".
  const src = code(read("src/lib/ledger/equity.ts"));
  assert.match(src, /const totalEquity = round2\(\s*\(capital \?\? 0\) \+ contributions \+ openingBalances \+ accumulatedResult - withdrawals,?\s*\);/);
  assert.doesNotMatch(src, /netWorthOf|walletsTotal|inventoryValue/, "capital and equity are never derived from assets");
  // Profit is the one P&L definition.
  assert.match(src, /netProfitOf\(\{ revenue: i\.revenue, cogs: i\.cogs, expenses: i\.expenses \}\)/);
});

test("a failed ledger read is an error, never a statement of zeros", async () => {
  let calls = 0;
  const failing = async () => { calls += 1; if (calls === 3) throw new Error("network"); return []; };
  await assert.rejects(() => eq.fetchEquity(failing), /network/);
  const hook = read("src/lib/ledger/useEquityStatement.ts");
  assert.match(hook, /setData\(null\);\n\s*setError\(/, "a failure drops the old figures");
  assert.match(read("src/components/finance/OwnerEquityCard.tsx"), /equity\.error \? \(\n\s*<LoadError/);
});

test("fetchEquity reads each figure from its ledger account and kind", async () => {
  const asked = [];
  await eq.fetchEquity(async (q) => { asked.push(`${q.account}:${q.kind ?? "*"}`); return []; });
  assert.deepEqual(asked.sort(), [
    "cogs:*", "expense:*", "expense:stock_adjustment", "owner_budget:*", "owner_equity:owner_capital",
    "owner_equity:owner_contribution", "revenue:*", "stock:stock_adjustment", "wallet:owner_capital", "wallet:stock_adjustment",
  ].sort());
});

test("capital builders: cash now or declared history; corrections; nonsense refused", () => {
  assert.deepEqual(eq.buildOwnerCapitalLines({ subjectId: "owner", amount: 500, wallet: "inStoreSafe" }), [
    { account: "owner_equity", subjectId: "owner", amount: 500 },
    { account: "wallet", subjectId: "inStoreSafe", amount: 500 },
  ]);
  assert.deepEqual(eq.buildOwnerCapitalLines({ subjectId: "owner", amount: 500 }), [
    { account: "owner_equity", subjectId: "owner", amount: 500 },
  ], "historical capital moves no wallet");
  assert.equal(eq.buildOwnerCapitalLines({ subjectId: "owner", amount: -100 })[0].amount, -100, "a correction");
  assert.throws(() => eq.buildOwnerCapitalLines({ subjectId: "owner", amount: 0 }));
  assert.throws(() => eq.buildOwnerCapitalLines({ subjectId: "", amount: 10 }));
  assert.throws(() => eq.buildOwnerContributionLines({ subjectId: "owner", amount: 10, wallet: "" }));
  assert.throws(() => eq.buildOwnerContributionLines({ subjectId: "owner", amount: -10, wallet: "inStoreSafe" }));
});

// ═══ The database authority ═════════════════════════════════════════════════

// Each 049 edit, as [what 046 had, what 049 has]. Reversing all of them must
// give back 046's function exactly: nothing else changed, nothing weakened.
const EDITS_049 = [
  [`      'deposit_refunded']) THEN`, `      'deposit_refunded',\n      -- 049: owner equity\n      'owner_capital', 'owner_contribution']) THEN`],
  [`BEGIN\n  IF jsonb_typeof`, `  -- 049: owner equity\n  oe bigint; v_oe_lines int; v_oe_subject text;\nBEGIN\n  IF jsonb_typeof`],
  [`    WHEN 'deposit_refunded'   THEN ARRAY['wallet','revenue','customer_ltv']\n  END;`, `    WHEN 'deposit_refunded'   THEN ARRAY['wallet','revenue','customer_ltv']\n    WHEN 'owner_capital'      THEN ARRAY['owner_equity','wallet']\n    WHEN 'owner_contribution' THEN ARRAY['owner_equity','wallet']\n  END;`],
  [`'customer_ltv','owner_budget'])),`, `'customer_ltv','owner_budget','owner_equity'])),`],
  [`    count(*) FILTER (WHERE acc = 'cogs' AND a < 0)\n  INTO`, `    count(*) FILTER (WHERE acc = 'cogs' AND a < 0),\n    COALESCE(sum(a) FILTER (WHERE acc = 'owner_equity'), 0),\n    count(*) FILTER (WHERE acc = 'owner_equity'),\n    (array_agg(subj) FILTER (WHERE acc = 'owner_equity'))[1]\n  INTO`],
  [`v_ex_neg, v_ex_pos, v_cogs_neg\n  FROM ln;`, `v_ex_neg, v_ex_pos, v_cogs_neg,\n       oe, v_oe_lines, v_oe_subject\n  FROM ln;`],
];
const BLOCK_049 = /\n\n  -- ── 049: owner equity ─[\s\S]*?(?=\n  END IF;\nEND;\n\$function\$;)/;

test("049's validator is 046's, byte for byte, plus the owner-equity edits", () => {
  let v = fnOf(M049, "ledger_validate_event");
  assert.ok(BLOCK_049.test(v), "the two owner rules are where they belong");
  v = v.replace(BLOCK_049, "");
  for (const [before, after] of EDITS_049) {
    assert.ok(v.includes(after), `edit present: ${after.slice(0, 50)}`);
    v = v.replace(after, before);
  }
  assert.equal(v, fnOf(M046, "ledger_validate_event"));
});

test("049's rules: one capital line, cash equal to it, never below zero; contributions are cash in", () => {
  const block = fnOf(M049, "ledger_validate_event").match(BLOCK_049)[0];
  assert.match(block, /ELSIF v_kind = 'owner_capital' THEN\n\s+IF v_oe_lines <> 1 OR oe = 0 OR v_wallet_in \+ v_wallet_out > 1 OR \(v_wallet_in \+ v_wallet_out = 1 AND w <> oe\) THEN/);
  assert.match(block, /IF v_prior \+ oe < 0 THEN/);
  assert.match(block, /AND e\.kind = 'owner_capital' AND l\.subject_id = v_oe_subject;/);
  assert.match(block, /ELSIF v_kind = 'owner_contribution' THEN\n\s+IF v_oe_lines <> 1 OR oe <= 0 OR v_wallet_in <> 1 OR v_wallet_out <> 0 OR w <> oe THEN/);
  assert.doesNotMatch(block, /\bEXCEPTION\s+WHEN\b/, "043: no subtransaction around a ledger append");
});

test("only ADMIN may post capital or contributions; every other branch unchanged", () => {
  const policy = M049.slice(M049.indexOf("ALTER POLICY insert_ledger_events"));
  assert.match(policy, /WHEN kind = ANY \(ARRAY\['owner_capital', 'owner_contribution'\]\)\n\s+THEN public\.has_role\(store_id, VARIADIC ARRAY\['ADMIN'\]\)/);
  // It is the FIRST branch, so the selling-role ELSE can never reach them.
  assert.ok(policy.indexOf("'owner_capital'") < policy.indexOf("'stock_adjustment'"));
  assert.match(policy, /WHEN kind = ANY \(ARRAY\['stock_adjustment', 'purchase', 'supplier_payment'\]\)\n\s+THEN public\.has_role\(store_id, VARIADIC ARRAY\['ADMIN', 'ACCOUNTANT'\]\)/);
  assert.match(policy, /WHEN kind = ANY \(ARRAY\['expense', 'payroll', 'owner_draw', 'wallet_transfer', 'deposit_refunded'\]\)\n\s+THEN public\.has_role\(store_id, VARIADIC ARRAY\['ADMIN', 'ACCOUNTANT'\]\)/);
  assert.match(policy, /ELSE public\.has_role\(store_id, VARIADIC ARRAY\['ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT'\]\)/);
  assert.match(policy, /public\.is_store_member\(store_id\) AND/, "tenant isolation stays the first condition");
});

// ═══ One authority ══════════════════════════════════════════════════════════

test("capital is never read from, or written to, the browser-local partner field", () => {
  assert.doesNotMatch(read("src/store/useBusinessStore.ts"), /addCapitalContribution:/);
  for (const f of ["src/components/finance/PartnersFinancePage.tsx", "src/components/finance/CapitalEquityPage.tsx"]) {
    const src = code(read(f));
    assert.doesNotMatch(src, /totalCapital|addCapitalContribution|capitalContribution:\s*capital/, f);
    // The only surviving mention: the legacy hint that asks for it to be recorded.
    const uses = src.match(/capitalContribution/g) ?? [];
    assert.ok(uses.length <= 2, `${f}: only the legacy hint may read it`);
  }
  assert.match(read("src/components/finance/CapitalEquityPage.tsx"), /capitalContributed: paidInOf\(row\.partner\.id\),/);
  assert.match(read("src/lib/pdfGenerator.ts"), /s\.capitalContributed === null \? "غير مسجل"/);
});
