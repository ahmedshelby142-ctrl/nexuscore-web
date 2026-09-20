/**
 * The period filter, and the Owner-only financial reader.
 *
 *     node --test scripts/check_owner_financials.mjs
 *
 * ## Blocker A — a text column compared as text
 *
 * `driver.balances` filtered the window with
 * `.gte("ledger_events.occurred_at", from.toISOString())`. `occurred_at` is a
 * `text` column, so PostgREST compared strings. The table holds two spellings
 * of the same instant —
 *
 *     2026-09-12T14:18:07.675Z          ISO, what `toISOString()` produces
 *     2026-09-12 14:18:07.675957+00     Postgres style, 27 of 321 events
 *
 * — and `' ' (0x20) < 'T' (0x54)`, so a Postgres-style row sorts BELOW the
 * `...T00:00:00Z` bound of its own day. That breaks the window in BOTH
 * directions at once: the row is dropped from its own day, and it is pulled
 * into the PREVIOUS one, whose exclusive upper bound it now also sorts below.
 * Measured against the live database for 2026-09-12: 308.00 EGP of revenue
 * where the timestamps mean 3,100.00, with 14 in-period events missing.
 * Migration 034 casts once, in SQL, and `driver.balances` goes through it.
 *
 * ## Blocker B — "Owner-only" money was not role-isolated
 *
 * Every financial SELECT policy is `is_store_member(store_id)`; a MODERATOR
 * reads every revenue, cogs, wallet and payable line in its own store. Those
 * policies are deliberately NOT tightened — `customer_ltv`, stock and
 * shortages run through the same tables for the Moderator certified in M3.1.
 * The restricted surface is `owner_financial_summary`, which checks the caller
 * is authenticated, is a member of the store it was handed, and is ADMIN there.
 *
 * ## Why the interesting half is credential-gated
 *
 * Both are properties of the DATABASE. The old filter *looked* correct and the
 * old exposure was invisible from the source. So the real cases talk to
 * Postgres and skip (loudly) without credentials, in the same shape as
 * `check_ledger_atomicity.mjs`. The source guards run unconditionally and stop
 * the two shapes that would undo this: a lexical `occurred_at` comparison
 * coming back, and a second definition of profit appearing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { pnl } from "../src/lib/ledger/reports.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const migration = read("../docs/migrations/034_period_filter_and_owner_financials.sql");
const driver = read("../src/lib/ledger/driver.ts");
const ownerReader = read("../src/lib/ledger/ownerFinancials.ts");
const reports = read("../src/lib/ledger/reports.ts");
/** Comments quote the defect on purpose; the guards must read the CODE. */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const driverCode = strip(driver);
// `src/types/index.ts` imports through the `@/` alias, which node cannot
// resolve, so the wallet vocabulary is read as source rather than imported.
const types = read("../src/types/index.ts");

/** The canonical till keys, straight out of `WALLET_LABELS`. */
const WALLET_KEYS = [
  ...types
    .match(/export const WALLET_LABELS: Record<string, string> = \{([\s\S]*?)\};/)[1]
    .matchAll(/^\s*([A-Za-z]+):/gm),
].map((m) => m[1]);

// ═══════════════════════════════════════════════════════════════════════════
// A · The lexical comparison cannot come back
// ═══════════════════════════════════════════════════════════════════════════

test("the driver no longer compares occurred_at as text", () => {
  assert.ok(
    !/\.gte\(\s*["']ledger_events\.occurred_at["']/.test(driverCode),
    "a string comparison on a text timestamp column silently drops rows",
  );
  assert.ok(
    !/\.lt\(\s*["']ledger_events\.occurred_at["']/.test(driverCode),
    "same defect, upper bound",
  );
  assert.match(driver, /rpc\("ledger_balances"/, "the window is compared in SQL now");
  assert.match(driver, /p_from: query\.from \? query\.from\.toISOString\(\) : null/);
  assert.match(driver, /p_to: query\.to \? query\.to\.toISOString\(\) : null/);
});

test("the SQL reader casts the column before comparing it", () => {
  assert.match(
    migration,
    /e\.occurred_at::timestamptz >= p_from/,
    "the lower bound must be an instant comparison",
  );
  assert.match(migration, /e\.occurred_at::timestamptz <\s+p_to/);
  // A lifetime read must stay a lifetime read: both bounds optional.
  assert.match(migration, /p_from\s+timestamptz DEFAULT NULL/);
  assert.match(migration, /p_to\s+timestamptz DEFAULT NULL/);
  assert.match(migration, /p_from IS NULL OR/);
  assert.match(migration, /p_to\s+IS NULL OR/);
});

test("balancesByRef is untouched — it never had a window to get wrong", () => {
  // `RefBalanceQuery` carries no from/to, so it never had the defect and must
  // not be dragged into the change.
  const start = driverCode.indexOf("async balancesByRef");
  const byRef = driverCode.slice(start, driverCode.indexOf("async events", start));
  assert.ok(start > -1 && byRef.length > 0);
  assert.ok(!byRef.includes("occurred_at"), "balancesByRef does not filter by date");
  assert.ok(byRef.includes("ref_id"), "and still groups by the source document");
});

// ═══════════════════════════════════════════════════════════════════════════
// B · Gross profit has exactly one definition
// ═══════════════════════════════════════════════════════════════════════════

test("grossProfit is revenue − cogs, defined once in pnl()", () => {
  const report = pnl({
    revenueRows: [{ subjectId: "pos", amount: 300 }],
    expenseRows: [{ subjectId: "rent", amount: 175 }],
    cogs: 180,
    returnsRevenue: -100,
    purchases: 0,
  });
  assert.equal(report.grossProfit, 120);
  assert.equal(report.netProfit, report.grossProfit - report.expenses);
});

test("no second gross-profit formula exists anywhere in the reader", () => {
  // The reader may READ the field; it may not compute it.
  assert.ok(
    !/grossProfit\s*[:=]\s*[^,\n]*[-−]\s*\w*[Cc]ogs/.test(ownerReader),
    "the Owner reader must not re-derive gross profit",
  );
  assert.match(reports, /grossProfit: netSales - input\.cogs/);
  assert.match(migration, /'grossProfit',\s+v_revenue - v_cogs/);
});

// ═══════════════════════════════════════════════════════════════════════════
// C · The Owner reader is a narrow, ADMIN-gated surface
// ═══════════════════════════════════════════════════════════════════════════

test("the reader verifies authentication, membership and ADMIN separately", () => {
  const fn = migration.slice(migration.indexOf("FUNCTION public.owner_financial_summary"));
  assert.match(fn, /IF auth\.uid\(\) IS NULL THEN/, "authenticated caller");
  assert.match(fn, /IF public\.member_role\(p_store\) IS NULL THEN/, "member of THIS store");
  assert.match(fn, /IF public\.member_role\(p_store\) <> 'ADMIN' THEN/, "and an ADMIN there");
  assert.equal((fn.match(/ERRCODE = '42501'/g) ?? []).length, 3, "each refusal is a denial");
});

test("the gate uses none of the things the brief ruled out", () => {
  const fn = migration.slice(migration.indexOf("FUNCTION public.owner_financial_summary"));
  assert.ok(!fn.includes("is_system_owner"), "a global identity is not a store owner");
  assert.ok(!/public\.is_store_member\(/.test(fn), "membership alone admits MODERATOR");
  assert.ok(!fn.includes("has_role"), "has_role would also licence-gate a READ");
});

test("neither function is reachable by anon, and neither is a generic ledger dump", () => {
  for (const fn of ["ledger_balances", "owner_financial_summary"]) {
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}[\\s\\S]{0,120}FROM anon`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}[\\s\\S]{0,120}TO authenticated`));
    assert.match(migration, new RegExp(`SET search_path TO 'public', 'pg_temp'[\\s\\S]{0,4000}${fn}|${fn}[\\s\\S]{0,800}SET search_path TO 'public', 'pg_temp'`));
  }
  // The Owner reader returns aggregates, never rows of the ledger.
  assert.ok(!/RETURNS SETOF public\.ledger_lines/i.test(migration));
  assert.match(migration, /FUNCTION public\.owner_financial_summary[\s\S]{0,200}RETURNS jsonb/);
});

test("no SELECT policy on the ledger is touched", () => {
  assert.ok(
    !/(CREATE|DROP|ALTER) POLICY/i.test(migration),
    "tightening the tables would break Moderator stock, shortages and customer LTV",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// D · Authority: the audited sources, and only those
// ═══════════════════════════════════════════════════════════════════════════

test("the reader uses the ledger accounts and none of the rejected sources", () => {
  for (const account of [
    "'revenue'", "'cogs'", "'expense'", "'stock'", "'wallet'",
    "'payable_supplier'", "'receivable_courier'", "'payable_courier'", "'receivable_client'",
  ]) {
    assert.ok(migration.includes(account), `the ${account} account must be the authority`);
  }
  const fn = migration.slice(migration.indexOf("FUNCTION public.owner_financial_summary"));
  assert.ok(!/public\.transactions/.test(fn), "the transactions table holds 0 rows");
  assert.ok(!/public\.expenses\b/.test(fn), "the expenses table is NOT the expense account");
  assert.ok(!/public\.orders\b/.test(fn), "profit is the ledger's, not the orders table's");
});

test("metrics with no authoritative data are absent, not zero", () => {
  const fn = migration.slice(migration.indexOf("FUNCTION public.owner_financial_summary"));
  for (const absent of ["owner_budget", "owner_draw", "wallet_transfer", "previousPeriod", "yoy"]) {
    assert.ok(!fn.includes(absent), `${absent} has no authoritative data and must be omitted`);
  }
  assert.ok(!/'ownerDraw'|'capital'|'equity'/.test(fn));
});

test("positions are lifetime and flows are windowed", () => {
  const fn = migration.slice(migration.indexOf("FUNCTION public.owner_financial_summary"));
  // Flows carry the window…
  for (const flow of ["'revenue'", "'cogs'", "'expense'"]) {
    assert.match(
      fn,
      new RegExp(`ledger_balances\\(p_store, ${flow}, NULL, NULL, p_from, p_to\\)`),
      `${flow} is a flow and must take the period`,
    );
  }
  // …positions do not. A date window on a wallet balance is meaningless.
  for (const position of ["'stock'", "'wallet'", "'payable_supplier'", "'receivable_courier'", "'payable_courier'", "'receivable_client'"]) {
    assert.match(
      fn,
      new RegExp(`ledger_balances\\(p_store, ${position}\\)`),
      `${position} is a position and must be lifetime`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// E · Wallet canonicalisation, SQL against TypeScript
// ═══════════════════════════════════════════════════════════════════════════

test("the SQL folding covers every till canonicalWallet() knows about", () => {
  const sql = migration.slice(migration.indexOf("FUNCTION public.canonical_wallet_subject"));

  assert.deepEqual(
    [...WALLET_KEYS].sort(),
    ["bankAccount", "inStoreSafe", "instaPay", "vodafoneCash"],
    "the wallet vocabulary moved — the SQL below has to move with it",
  );

  // `canonicalWallet` folds case-insensitively onto each key. The SQL must map
  // the same lowercased spelling onto the same canonical one, or a till splits
  // in two the way `instaPay`/`instapay` already did.
  for (const key of WALLET_KEYS) {
    assert.match(
      sql,
      new RegExp(`WHEN '${key.toLowerCase()}'\\s+THEN '${key}'`),
      `SQL must fold ${key.toLowerCase()} onto ${key}`,
    );
  }

  // An unrecognised till stays itself in both — it must not be quietly folded
  // into a shop account it does not belong to.
  assert.match(types, /return subject;\s*\}/, "TS returns an unknown subject untouched");
  assert.match(sql, /ELSE p_subject/, "SQL must leave an unknown wallet alone too");
  assert.match(migration, /public\.canonical_wallet_subject\(b\.subject_id\)/, "and apply it on read");
});

// ═══════════════════════════════════════════════════════════════════════════
// F · The live database
// ═══════════════════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const skipDatabaseTests = !SUPABASE_URL || !SERVICE_KEY || !ANON_KEY;

const PASSWORD = "TestPassword123!";
const DEVICE = "00000000-0000-0000-0000-00000000000a";

let admin;
let adminA;
let adminB;
let moderator;
let accountant;
let seller;
let onlineOnly;
let storeA;
let storeB;
const createdUsers = [];

async function signUp() {
  const email = `owner-fin-${crypto.randomUUID()}@nexuscore.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw new Error(`could not create test user: ${error.message}`);
  createdUsers.push(data.user.id);
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw new Error(`could not sign in test user: ${signInError.message}`);
  client.userId = data.user.id;
  return client;
}

async function license(storeId) {
  await admin.from("store_licenses").insert({
    store_id: storeId,
    license_key: `QA-${storeId}`,
    plan_type: "BASIC",
    valid_until: new Date(Date.now() + 86400000).toISOString(),
    status: "active",
    notes: "owner financials QA",
  });
}

/** An event written with service-role, so the TEXT spelling is ours to choose. */
async function seedEvent(storeId, id, occurredAt, lines) {
  await admin.from("ledger_events").insert({
    id, store_id: storeId, device_id: DEVICE, kind: "sale",
    occurred_at: occurredAt, created_at: occurredAt,
    actor: "qa", ref_type: "qa_period", ref_id: id, payload: "{}",
  });
  await admin.from("ledger_lines").insert(
    lines.map((l, i) => ({
      id: `${id}-L${i}`, event_id: id, store_id: storeId, device_id: DEVICE, ...l,
    })),
  );
}

async function setup() {
  admin = createClient(SUPABASE_URL, SERVICE_KEY);

  adminA = await signUp();
  storeA = crypto.randomUUID();
  await adminA.rpc("claim_store", { local_store_id: storeA });
  await license(storeA);

  adminB = await signUp();
  storeB = crypto.randomUUID();
  await adminB.rpc("claim_store", { local_store_id: storeB });
  await license(storeB);

  moderator = await signUp();
  accountant = await signUp();
  seller = await signUp();
  onlineOnly = await signUp();
  await admin.from("store_members").insert([
    { user_id: moderator.userId, store_id: storeA, role: "MODERATOR" },
    { user_id: accountant.userId, store_id: storeA, role: "ACCOUNTANT" },
    { user_id: seller.userId, store_id: storeA, role: "POS_ECOMMERCE" },
    { user_id: onlineOnly.userId, store_id: storeA, role: "ECOMMERCE_ONLY" },
  ]);

  // THE case this phase exists for: the same day, in both spellings.
  await seedEvent(storeA, `qa-iso-${storeA}`, "2026-03-04T10:00:00.000Z", [
    { account: "revenue", subject_id: "pos", qty_delta: 0, amount_delta: 10000 },
    { account: "cogs", subject_id: "qa-prod", qty_delta: 0, amount_delta: 4000 },
  ]);
  await seedEvent(storeA, `qa-pg-${storeA}`, "2026-03-04 15:30:00.123456+00", [
    { account: "revenue", subject_id: "pos", qty_delta: 0, amount_delta: 30000 },
    { account: "cogs", subject_id: "qa-prod", qty_delta: 0, amount_delta: 9000 },
  ]);
  // The day after, to prove the upper bound excludes.
  await seedEvent(storeA, `qa-next-${storeA}`, "2026-03-05 09:00:00.000000+00", [
    { account: "revenue", subject_id: "pos", qty_delta: 0, amount_delta: 70000 },
  ]);
  // Two spellings of one wallet, which must fold into one row.
  await seedEvent(storeA, `qa-wallet-${storeA}`, "2026-03-04T11:00:00.000Z", [
    { account: "wallet", subject_id: "instaPay", qty_delta: 0, amount_delta: 50000 },
    { account: "wallet", subject_id: "instapay", qty_delta: 0, amount_delta: -20000 },
  ]);
  await seedEvent(storeA, `qa-expense-${storeA}`, "2026-03-04T12:00:00.000Z", [
    { account: "expense", subject_id: "rent", qty_delta: 0, amount_delta: 5000 },
  ]);
}

async function teardown() {
  for (const store of [storeA, storeB]) {
    await admin.from("ledger_lines").delete().eq("store_id", store);
    await admin.from("ledger_events").delete().eq("store_id", store);
  }
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id).catch(() => {});
}

const DAY = { from: "2026-03-04T00:00:00.000Z", to: "2026-03-05T00:00:00.000Z" };

test("period filter and Owner reader (live database)", { skip: skipDatabaseTests && "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_ANON_KEY missing" }, async (t) => {
  await setup();

  await t.test("A — both timestamp spellings land in the same day", async () => {
    const { data, error } = await adminA.rpc("ledger_balances", {
      p_store: storeA, p_account: "revenue", p_kind: null, p_subject_id: null,
      p_from: DAY.from, p_to: DAY.to,
    });
    assert.equal(error, null, error?.message);
    const total = (data ?? []).reduce((t, r) => t + Number(r.amount), 0);
    // 100.00 in ISO + 300.00 in Postgres style. The old lexical comparison
    // returned only the ISO row, because ' ' sorts below 'T'.
    assert.equal(total, 40000, "the Postgres-style row must be inside its own day");
  });

  await t.test("B — the exclusive upper bound still excludes the next day", async () => {
    const { data } = await adminA.rpc("ledger_balances", {
      p_store: storeA, p_account: "revenue", p_kind: null, p_subject_id: null,
      p_from: DAY.from, p_to: DAY.to,
    });
    const total = (data ?? []).reduce((t, r) => t + Number(r.amount), 0);
    // The three values the OLD comparison could produce, each wrong:
    //   10000  the Postgres-style row of this day dropped
    //   80000  …dropped, AND the next day's Postgres-style row pulled in,
    //          because it too sorts below this day's `...T00:00:00Z` bound
    //  110000  no windowing at all
    for (const wrong of [10000, 80000, 110000]) {
      assert.notEqual(total, wrong, `lexical comparison artefact: ${wrong}`);
    }
    assert.equal(total, 40000, "exactly this day, both spellings, nothing else");

    const { data: lifetime } = await adminA.rpc("ledger_balances", {
      p_store: storeA, p_account: "revenue", p_kind: null, p_subject_id: null,
      p_from: null, p_to: null,
    });
    const all = (lifetime ?? []).reduce((t, r) => t + Number(r.amount), 0);
    assert.equal(all, 110000, "a lifetime read is unaffected and sees everything");
  });

  await t.test("C — ADMIN of store A gets store A", async () => {
    const { data, error } = await adminA.rpc("owner_financial_summary", {
      p_store: storeA, p_from: DAY.from, p_to: DAY.to,
    });
    assert.equal(error, null, error?.message);
    assert.equal(data.unit, "piastres");
    assert.equal(Number(data.revenue), 40000);
    assert.equal(Number(data.cogs), 13000);
    assert.equal(Number(data.grossProfit), 27000, "revenue − cogs, computed in SQL");
    assert.equal(Number(data.expenses), 5000);
    assert.equal(Number(data.netProfit), 22000, "gross − expenses, the one formula");
  });

  await t.test("D — wallets fold onto the canonical key", async () => {
    const { data } = await adminA.rpc("owner_financial_summary", { p_store: storeA, p_from: null, p_to: null });
    const wallets = data.walletBalances ?? [];
    const instapay = wallets.filter((w) => w.subjectId.toLowerCase() === "instapay");
    assert.equal(instapay.length, 1, "two spellings of one till must not be two rows");
    assert.equal(instapay[0].subjectId, "instaPay", "folded onto the canonical spelling");
    assert.equal(Number(instapay[0].amount), 30000, "500.00 − 200.00, both spellings counted");
  });

  await t.test("E — a wallet balance is a POSITION and ignores the window", async () => {
    const inWindow = await adminA.rpc("owner_financial_summary", { p_store: storeA, p_from: DAY.from, p_to: DAY.to });
    const lifetime = await adminA.rpc("owner_financial_summary", { p_store: storeA, p_from: null, p_to: null });
    assert.deepEqual(
      inWindow.data.walletBalances,
      lifetime.data.walletBalances,
      "a till balance is what it is today — a date window on it is meaningless",
    );
    assert.equal(Number(inWindow.data.stockValue), Number(lifetime.data.stockValue));
    // …while the flows do move with the window.
    assert.notEqual(Number(inWindow.data.revenue), Number(lifetime.data.revenue));
  });

  await t.test("F — every non-ADMIN store role is refused", async () => {
    for (const [role, client] of [
      ["MODERATOR", moderator],
      ["ACCOUNTANT", accountant],
      ["POS_ECOMMERCE", seller],
      ["ECOMMERCE_ONLY", onlineOnly],
    ]) {
      const { data, error } = await client.rpc("owner_financial_summary", { p_store: storeA, p_from: null, p_to: null });
      assert.notEqual(error, null, `${role} must be refused`);
      assert.equal(error.code, "42501", `${role} must get an authorization failure`);
      assert.equal(data, null, `${role} must receive no figures at all`);
    }
  });

  await t.test("G — the refused roles can still do their operational reads", async () => {
    // The whole reason the table policies were NOT tightened.
    for (const [role, client] of [["MODERATOR", moderator], ["POS_ECOMMERCE", seller]]) {
      const { error } = await client.from("ledger_lines").select("id").eq("store_id", storeA).limit(1);
      assert.equal(error, null, `${role} must keep reading the ledger it always could: ${error?.message}`);
    }
    const { error: shortages } = await moderator.rpc("mobile_shortages", { p_store: storeA });
    assert.equal(shortages, null, "M3.1's shortages reader must be unaffected");
  });

  await t.test("H — store_id cannot be used to reach another tenant", async () => {
    const { data, error } = await adminA.rpc("owner_financial_summary", { p_store: storeB, p_from: null, p_to: null });
    assert.notEqual(error, null, "an ADMIN of A is nobody in B");
    assert.equal(error.code, "42501");
    assert.equal(data, null);

    const { error: back } = await adminB.rpc("owner_financial_summary", { p_store: storeA, p_from: null, p_to: null });
    assert.notEqual(back, null, "and the reverse");

    const own = await adminB.rpc("owner_financial_summary", { p_store: storeB, p_from: null, p_to: null });
    assert.equal(own.error, null, "each ADMIN still gets their OWN store");
    assert.equal(Number(own.data.revenue), 0, "store B genuinely has no revenue — a real zero");
  });

  await t.test("I — an anonymous caller is refused before the function runs", async () => {
    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { error } = await anon.rpc("owner_financial_summary", { p_store: storeA, p_from: null, p_to: null });
    assert.notEqual(error, null, "anon must be refused");
    const { error: balances } = await anon.rpc("ledger_balances", {
      p_store: storeA, p_account: "revenue", p_kind: null, p_subject_id: null, p_from: null, p_to: null,
    });
    assert.notEqual(balances, null, "and so must the balance reader");
  });

  await t.test("J — no figure is invented for a metric with no authority", async () => {
    const { data } = await adminA.rpc("owner_financial_summary", { p_store: storeA, p_from: null, p_to: null });
    for (const key of ["ownerDraw", "capital", "equity", "walletTransfers", "previousPeriod", "revenueYoY"]) {
      assert.ok(!(key in data), `${key} has no authoritative data — it must be ABSENT, not 0`);
    }
    // The metrics that ARE present are present even when genuinely empty.
    assert.ok("returnsValue" in data && Number(data.returnsValue) === 0, "asked, and there were none");
  });

  await teardown();
});
