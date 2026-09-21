/**
 * المالية — the Mobile Store Owner cockpit.
 *
 *     node --test scripts/check_owner_mobile.mjs
 *
 * ## What this is defending
 *
 * The Owner screen is the first Mobile surface that shows money, and money has
 * three ways of going wrong that no amount of UI review catches:
 *
 *   1. **A second accounting implementation.** The moment a screen subtracts
 *      its own cost from its own revenue, it disagrees with التقارير المالية
 *      the first time someone forgets that `cogs` is already net of returns.
 *      Every figure here must come back already summed from
 *      `owner_financial_summary`.
 *
 *   2. **A failed read rendered as zero.** «٠ ج.م.» under "صافي الربح" tells
 *      an owner the shop took nothing today. `alertModel` already refuses this
 *      for counts; the reader refuses it for money by dropping its data on
 *      failure, and the screen must honour that.
 *
 *   3. **The UI and the database disagreeing about who the Owner is.** The
 *      `owner` capability is keyed on `ADMIN` because that is exactly what
 *      `owner_financial_summary` checks. Any other rule and the nav draws a
 *      screen Postgres will refuse, or hides one it would have answered.
 *
 * The live half asserts 3 directly: for every role, the capability the client
 * computes and the answer Postgres gives are the same answer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { APP_ROLES } from "../src/lib/roles.ts";
import { periodWindow } from "../src/lib/ledger/reports.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const capabilities = read("../src/mobile/navigation/mobileCapabilities.ts");
const navigation = read("../src/mobile/navigation/mobileNavigation.ts");
const router = read("../src/mobile/router.tsx");
const screen = read("../src/mobile/screens/MobileOwnerScreen.tsx");
const hook = read("../src/mobile/data/useOwnerFinancials.ts");
const metrics = read("../src/mobile/viewmodels/metricDefinitions.ts");
const roles = read("../src/lib/roles.ts");

// Comments name the things these guards forbid, on purpose — the reasoning is
// worth keeping. So the guards read the CODE.
const screenCode = strip(screen);
const hookCode = strip(hook);
const capabilitiesCode = strip(capabilities);
const routerCode = strip(router);
const metricsCode = strip(metrics);
const rolesCode = strip(roles);

// ═══════════════════════════════════════════════════════════════════════════
// 1 · Owner capability access — ADMIN, and nothing else
// ═══════════════════════════════════════════════════════════════════════════

test("the owner capability is keyed on the ADMIN role, not on a desktop path", () => {
  assert.match(capabilities, /export const OWNER_CAPABILITY_ROLE: AppRole = "ADMIN";/);
  assert.match(capabilities, /if \(role === OWNER_CAPABILITY_ROLE\) capabilities\.add\("owner"\);/);
  // It must NOT be resolvable through the shared desktop route map, which is
  // what would let a widened desktop route hand the money to another role.
  const map = capabilities.match(/DESKTOP_RESOURCE_FOR_CAPABILITY: Record<[\s\S]*?\n\};/)[0];
  assert.ok(!map.includes("owner:"), "owner must not project a desktop screen");
});

test("no other role can reach the owner capability", () => {
  // MODERATOR states its set literally; the rest resolve through canAccess and
  // then the ADMIN check. Neither path may admit anyone else.
  const moderator = capabilities.match(
    /const MODERATOR_CAPABILITIES: readonly MobileCapability\[\] = \[([\s\S]*?)\]/,
  )[1];
  assert.ok(!moderator.includes('"owner"'), "the read-only persona sees no money");

  for (const role of APP_ROLES.filter((r) => r !== "ADMIN")) {
    assert.ok(
      !new RegExp(`role === "${role}"[\\s\\S]{0,120}add\\("owner"\\)`).test(capabilities),
      `${role} must not be granted the owner capability`,
    );
  }
});

test("the Store Owner is not the System Owner", () => {
  for (const source of [capabilitiesCode, screenCode, hookCode, routerCode]) {
    assert.ok(!source.includes("is_system_owner"), "a global identity is not a store owner");
    assert.ok(!/admin_list_stores|system-admin|LicenseManager/.test(source));
  }
  // And nothing here touches the role model itself.
  assert.ok(!/"OWNER"/.test(rolesCode), "no new role was created for this persona");
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · Direct-route protection
// ═══════════════════════════════════════════════════════════════════════════

test("/owner is behind the owner capability guard", () => {
  assert.match(
    router,
    /MobileRouteGuard capability="owner"[\s\S]{0,80}path="owner"/,
    "a deep link to /owner must hit the same guard the nav respects",
  );
});

test("the Owner destination is reachable, and المزيد is still on the bar", () => {
  const body = navigation.match(/case "ADMIN":[\s\S]*?return \[(.*?)\];/)[1];
  assert.match(body, /ALL_MODULES\.owner/, "the Owner needs a way in");
  assert.match(body, /ALL_MODULES\.more/);
  assert.ok((body.match(/ALL_MODULES\./g) ?? []).length <= 4, "four destinations maximum");
  assert.match(navigation, /owner: \{ id: "owner"[\s\S]*?path: "\/owner", isImplemented: true \}/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · One accounting implementation
// ═══════════════════════════════════════════════════════════════════════════

test("the screen reads the secure reader and nothing else", () => {
  assert.match(screen, /useOwnerFinancials/);
  assert.match(hook, /readOwnerFinancialSummary/);
  // No raw table access from the UI when the reader already has the answer.
  for (const forbidden of ['from("ledger_lines")', 'from("ledger_events")', 'from("transactions")', 'from("expenses")', "balances(", "useBalances("]) {
    assert.ok(!screenCode.includes(forbidden), `the screen must not call ${forbidden}`);
    assert.ok(!hookCode.includes(forbidden), `the hook must not call ${forbidden}`);
  }
});

test("no profit is recomputed on the client", () => {
  // The reader returns grossProfit and netProfit already summed. Subtracting
  // again here is how the phone and التقارير المالية start disagreeing.
  for (const [name, code] of [["screen", screenCode], ["hook", hookCode]]) {
    assert.ok(
      !/(revenue|netSales)\s*[-−]\s*(data\.)?cogs/.test(code),
      `${name} must not re-derive gross profit`,
    );
    assert.ok(
      !/grossProfit\s*[-−]\s*(data\.)?expenses/.test(code),
      `${name} must not re-derive net profit`,
    );
    assert.ok(!/\.reduce\(/.test(code), `${name} must not sum ledger figures itself`);
  }
  assert.match(screen, /data\.grossProfit/, "it READS the canonical field");
  assert.match(screen, /data\.netProfit/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · Period selector, flows and positions
// ═══════════════════════════════════════════════════════════════════════════

test("the period selector uses the canonical window, not a new one", () => {
  assert.match(screen, /periodWindow/, "the same function التقارير المالية uses");
  assert.match(screen, /from "@\/lib\/ledger\/reports"/);
  const presets = [...screen.match(/const PERIODS = \[([\s\S]*?)\] as const;/)[1].matchAll(/id: "([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(presets, ["day", "week", "month"], "weeks-old ledger — no quarter, no year");
  // Each preset must be a real preset of the shared function.
  for (const preset of presets) {
    const w = periodWindow(preset, new Date("2026-03-15T12:00:00Z"));
    assert.ok(w.from instanceof Date && w.to instanceof Date && w.from < w.to, preset);
  }
});

test("positions are labelled as positions, flows as the period", () => {
  // A reader who thinks «رصيد المحفظة» is "this month's" mis-plans a payment.
  assert.match(screen, /titleAr=\{`الأرباح — \$\{periodLabel\}`\}/);
  assert.match(screen, /titleAr=\{`المبيعات حسب القناة — \$\{periodLabel\}`\}/);
  assert.match(screen, /titleAr="المراكز المالية — دلوقتي"/);
  assert.match(screen, /titleAr="الخزن والمحافظ — دلوقتي"/);
  assert.match(screen, /titleAr="مستحقات الموردين — دلوقتي"/);
});

test("returns are shown as already deducted, never as a second subtraction", () => {
  assert.match(screen, /data\.returnsValue/);
  assert.match(screen, /متخصومة بالفعل/, "the label has to say so");
});

test("sales by channel uses the shared channel labels", () => {
  assert.match(screen, /labelOf=\{channelLabel\}/, "no second channel vocabulary");
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · Wallet canonicalisation
// ═══════════════════════════════════════════════════════════════════════════

test("wallet rows are labelled from WALLET_LABELS and folded upstream", () => {
  assert.match(screen, /WALLET_LABELS\[subjectId\] \?\? subjectId/);
  // The FOLDING is the reader's job (canonical_wallet_subject in SQL). The
  // screen must not group wallets itself, or an unknown till gets a second
  // rule to disagree with.
  assert.ok(!/instapay|instaPay/i.test(screenCode), "no spelling is special-cased here");
  assert.match(screen, /rows=\{data\.walletBalances\}/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · Loading, empty, error — and never a fabricated zero
// ═══════════════════════════════════════════════════════════════════════════

test("a failed read drops its figures instead of showing them as zero", () => {
  assert.match(hook, /setData\(null\)/, "stale or absent figures, never a zero");
  assert.ok(
    !/setData\(\{[\s\S]{0,200}0/.test(hookCode),
    "the hook must never synthesise a zeroed summary",
  );
  assert.match(hook, /denied/, "a refusal is distinguishable from a broken connection");
  assert.match(hook, /42501/, "and it is recognised by Postgres' own code");
});

test("the screen renders one of offline / loading / error / denied / data — never a mix", () => {
  // `offline` joined the set in the P2 pass. It comes FIRST and every other
  // branch is gated behind it: a money screen with no connection must show no
  // figures at all, not the last ones it happens to be holding.
  assert.match(screenCode, /\{offline && <OfflineState \/>\}/);
  assert.match(screenCode, /\{!offline && loading && <SkeletonState/);
  assert.match(screenCode, /\{!offline && !loading && error &&/);
  assert.match(screenCode, /\{!offline && !loading && !error && data &&/);
  assert.match(screenCode, /denied[\s\S]{0,120}EmptyState[\s\S]{0,120}ErrorState/, "different words for different failures");
  assert.match(screen, /onRetry=\{reload\}/, "a broken read is retryable");
});

test("empty lists say they are empty rather than printing nothing", () => {
  for (const empty of ["لا مبيعات في الفترة دي.", "لا توجد حركة على أي خزنة.", "لا مستحقات للموردين."]) {
    assert.ok(screen.includes(empty), `missing empty state: ${empty}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 · metricDefinitions registration
// ═══════════════════════════════════════════════════════════════════════════

test("every Owner metric is registered, gated on the owner capability", () => {
  const owner = [...metrics.matchAll(/\{\s*id: "(owner_[a-z_]+)"[\s\S]*?priority: \d+,\s*\},/g)];
  assert.ok(owner.length >= 9, `expected the Owner block, found ${owner.length}`);
  for (const [block, id] of owner.map((m) => [m[0], m[1]])) {
    assert.match(block, /capability: "owner"/, `${id} must be gated on the owner capability`);
    assert.match(block, /source: "owner_financial_summary\(\)/, `${id} must name its reader`);
    assert.match(block, /authority: "/, `${id} must name its ledger authority`);
    assert.match(block, /emptyValueAr: "/, `${id} needs an empty state`);
    assert.match(block, /errorValueAr: "—"/, `${id} must not show a number on failure`);
  }
});

test("the metrics the audit proved have no authority are NOT registered", () => {
  for (const forbidden of ["owner_draw", "owner_capital", "owner_equity", "wallet_transfer", "_yoy", "previous_period"]) {
    assert.ok(!metrics.includes(`id: "${forbidden}`), `${forbidden} has no authoritative data`);
  }
  assert.ok(!/owner_budget/.test(metricsCode), "owner_budget holds 0 lines in the live ledger");
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 · Desktop is untouched
// ═══════════════════════════════════════════════════════════════════════════

test("no Desktop Owner dashboard was created", () => {
  const desktopRoutes = read("../src/lib/roles.ts");
  assert.ok(!desktopRoutes.includes('"/owner"'), "/owner is a MOBILE route only");
  // And the desktop route map did not move for anybody.
  const map = desktopRoutes.match(/const ROUTE_ACCESS: Record<[\s\S]*?\n\};/)[0];
  assert.ok(!map.includes("owner"), "ROUTE_ACCESS must not learn about the mobile cockpit");
});

// ═══════════════════════════════════════════════════════════════════════════
// 9 · The live database: the client and Postgres must agree on who the Owner is
// ═══════════════════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const skipDatabaseTests = !SUPABASE_URL || !SERVICE_KEY || !ANON_KEY;

const PASSWORD = "TestPassword123!";
let admin;
let storeA;
const createdUsers = [];
const clients = {};

async function signUp() {
  const email = `owner-mobile-${crypto.randomUUID()}@nexuscore.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw new Error(`could not create test user: ${error.message}`);
  createdUsers.push(data.user.id);
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw new Error(`could not sign in: ${signInError.message}`);
  client.userId = data.user.id;
  return client;
}

test("the capability and the database agree, role by role (live)", { skip: skipDatabaseTests && "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_ANON_KEY missing" }, async (t) => {
  admin = createClient(SUPABASE_URL, SERVICE_KEY);

  clients.ADMIN = await signUp();
  storeA = crypto.randomUUID();
  await clients.ADMIN.rpc("claim_store", { local_store_id: storeA });
  await admin.from("store_licenses").insert({
    store_id: storeA, license_key: `QA-${storeA}`, plan_type: "BASIC",
    valid_until: new Date(Date.now() + 86400000).toISOString(), status: "active", notes: "owner mobile QA",
  });

  for (const role of ["MODERATOR", "ACCOUNTANT", "POS_ECOMMERCE", "ECOMMERCE_ONLY"]) {
    clients[role] = await signUp();
    await admin.from("store_members").insert({ user_id: clients[role].userId, store_id: storeA, role });
  }

  // `getMobileCapabilities` imports through the `@/` alias, which node cannot
  // resolve, so the client's decision is read from the source rule instead:
  // the capability is granted iff the role is OWNER_CAPABILITY_ROLE.
  const ownerRole = capabilities.match(/OWNER_CAPABILITY_ROLE: AppRole = "([A-Z_]+)"/)[1];

  await t.test("every role's screen access matches its RPC answer", async () => {
    for (const role of ["ADMIN", "MODERATOR", "ACCOUNTANT", "POS_ECOMMERCE", "ECOMMERCE_ONLY"]) {
      const clientWouldDraw = role === ownerRole;
      const { data, error } = await clients[role].rpc("owner_financial_summary", {
        p_store: storeA, p_from: null, p_to: null,
      });
      const databaseAnswers = error === null && data !== null;
      assert.equal(
        clientWouldDraw,
        databaseAnswers,
        `${role}: the nav ${clientWouldDraw ? "draws" : "hides"} المالية but Postgres ${databaseAnswers ? "answers" : "refuses"}`,
      );
      if (!databaseAnswers) assert.equal(error.code, "42501", `${role} must be refused, not broken`);
    }
  });

  await t.test("the Owner's payload carries every field the screen renders", async () => {
    const { data } = await clients.ADMIN.rpc("owner_financial_summary", { p_store: storeA, p_from: null, p_to: null });
    for (const field of [
      "revenue", "cogs", "grossProfit", "expenses", "netProfit", "returnsValue",
      "salesByChannel", "stockValue", "walletBalances", "supplierPayable",
      "courierReceivable", "courierPayable", "receivableClient",
    ]) {
      assert.ok(field in data, `the screen renders ${field}; the reader must return it`);
    }
    // A brand-new store: real zeros, because the ledger was asked and is empty.
    assert.equal(Number(data.revenue), 0);
    assert.deepEqual(data.walletBalances, []);
  });

  for (const id of createdUsers) await admin.auth.admin.deleteUser(id).catch(() => {});
});
