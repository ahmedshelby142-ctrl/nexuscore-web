/**
 * المشتريات and الإعدادات — the last two mobile placeholders.
 *
 *     node --test scripts/check_mobile_purchasing_preferences.mjs
 *
 * The role assertions are BEHAVIOURAL: they call `canAccess` itself, because
 * who may open purchasing is a decision, not a string. The rest are source
 * assertions, for the reason `check_mobile_realtime.mjs` states — these modules
 * import through `@/` and reach Supabase on import.
 *
 * What is pinned here is deliberately not "the screen exists". A placeholder
 * passes that. What is pinned is that the screen performs no purchasing
 * arithmetic of its own, that what a supplier is owed still comes from the
 * ledger, and that signing out still goes through the one canonical path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { APP_ROLES, canAccess } from "../src/lib/roles.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/** Source with comments stripped — the prose names what the code refuses to do. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\r\n]*/g, "$1");
}

const purchasing = read("../src/mobile/screens/MobilePurchasingScreen.tsx");
const preferences = read("../src/mobile/screens/MobilePreferencesScreen.tsx");
const router = read("../src/mobile/router.tsx");
const navigation = read("../src/mobile/navigation/mobileNavigation.ts");
const capabilities = read("../src/mobile/navigation/mobileCapabilities.ts");
const readers = read("../src/mobile/data/mobileReaders.ts");

// ═══════════════════════════════════════════════════════════════════════════
// Both screens are real
// ═══════════════════════════════════════════════════════════════════════════

test("neither route lands on the قريباً placeholder any more", () => {
  assert.doesNotMatch(code(router), /MobileDeferredScreen/);
  assert.match(router, /<Route path="purchasing" element=\{<MobilePurchasingScreen \/>\} \/>/);
  assert.match(router, /<Route path="preferences" element=\{<MobilePreferencesScreen \/>\} \/>/);
});

test("the More sheet no longer advertises them as coming soon", () => {
  // `isImplemented: false` renders a disabled row with a قريباً badge, so a
  // stale flag is a screen that exists, routes, and cannot be opened.
  for (const capability of ["purchasing", "preferences"]) {
    const line = new RegExp(`${capability}: \\{[^}]*isImplemented: true`);
    assert.match(navigation, line, `${capability} must be marked implemented`);
  }
  assert.doesNotMatch(navigation, /isImplemented: false/);
});

// ═══════════════════════════════════════════════════════════════════════════
// Purchasing — authorization
// ═══════════════════════════════════════════════════════════════════════════

test("purchasing is reachable by exactly the roles the database lets write", () => {
  // `write_purchase_invoices` and `write_suppliers` are both
  // has_role(store, ADMIN, ACCOUNTANT). The capability must not be wider.
  const allowed = APP_ROLES.filter((role) => canAccess(role, "/purchasing"));
  assert.deepEqual([...allowed].sort(), ["ACCOUNTANT", "ADMIN"]);
});

test("the selling roles and the Moderator do not reach purchasing", () => {
  for (const role of ["POS_ECOMMERCE", "ECOMMERCE_ONLY"]) {
    assert.equal(canAccess(role, "/purchasing"), false, `${role} must not hold purchasing`);
  }
  // MODERATOR resolves from its own stated set, not from `canAccess` — the
  // capability is absent there, which is what keeps the one mobile write
  // (`/restock`) out of a read-only persona's reach.
  const stated = /MODERATOR_CAPABILITIES: readonly MobileCapability\[\] = \[([\s\S]*?)\];/.exec(capabilities);
  assert.ok(stated);
  const moderator = [...stated[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(!moderator.includes("purchasing"), "the Moderator must stay read-only");
  assert.ok(moderator.includes("preferences"), "every role may open its own settings");
});

test("preferences is reachable by every role", () => {
  for (const role of APP_ROLES) {
    const reachable = role === "MODERATOR"
      ? /"preferences"/.test(capabilities)
      : canAccess(role, "/preferences");
    assert.ok(reachable, `${role} must be able to reach its own settings`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Purchasing — one accounting path, and it is not in React
// ═══════════════════════════════════════════════════════════════════════════

test("the purchasing screen writes nothing itself", () => {
  const body = code(purchasing);
  // The write already exists and is canonical. A purchasing-only copy of it is
  // exactly the second path `commitReceipt` was centralised to prevent.
  for (const forbidden of ["commitReceipt", "appendEvent", "insert(", "upsert(", "update(", "delete("]) {
    assert.ok(!body.includes(forbidden), `purchasing must not call ${forbidden}`);
  }
  // It hands over to the canonical flow instead.
  assert.match(body, /navigate\("\/restock"\)/);
});

test("what a supplier is owed comes from the ledger, not from the documents", () => {
  const body = code(purchasing);
  assert.match(body, /balances\(\{ account: "payable_supplier" \}\)/);
  // `totalAmount − paidAmount` would disagree with the Owner cockpit the moment
  // a supplier payment moved the ledger without touching an invoice row.
  assert.ok(!/totalAmount\s*-\s*/.test(body), "owed must not be derived in React");
  assert.ok(!/paidAmount\s*[-+*]/.test(body), "no screen-local settlement arithmetic");
});

test("the invoice list shows the document's own status, not a recomputed one", () => {
  const body = code(purchasing);
  assert.match(body, /INVOICE_STATUS\[String\(raw \?\? ""\)\]/);
  // The three the desktop purchasing table renders, in its words.
  for (const status of ["paid", "partial", "unpaid"]) {
    assert.match(purchasing, new RegExp(`${status}: \\{ labelAr:`));
  }
  assert.match(body, /labelAr: "غير معروف", tone: "neutral"/,
    "a status the document did not write must not be guessed at");
});

test("the invoice reader is the canonical paged mobile reader", () => {
  assert.match(readers, /export function readMobilePurchaseInvoices/);
  assert.match(readers, /return readPage\("purchase_invoices", query,/);
  // `readPage` excludes soft-deleted rows and is scoped by RLS. A hand-rolled
  // query here would have to remember both.
  assert.match(purchasing, /readMobilePurchaseInvoices/);
});

// ═══════════════════════════════════════════════════════════════════════════
// Tenant isolation
// ═══════════════════════════════════════════════════════════════════════════

test("no mobile screen or reader carries a store_id", () => {
  // Scope is `is_store_member(store_id)` inside Postgres. A client that names
  // its own store is a client that can be asked to name a different one.
  for (const [name, source] of Object.entries({ purchasing, preferences, readers })) {
    assert.ok(!/store_id\s*[:=]/.test(code(source)), `${name} must not set a store_id`);
    assert.ok(!/\.eq\("store_id"/.test(code(source)), `${name} must not filter by store_id`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Preferences — sign-out, and what is deliberately absent
// ═══════════════════════════════════════════════════════════════════════════

test("sign-out goes through the ONE canonical session path", () => {
  assert.match(preferences, /import \{ signOutCurrentSession \} from "@\/lib\/auth\/sessionWorkflow";/);
  assert.match(preferences, /await signOutCurrentSession\(\);/);
  // A local-only clear leaves the Supabase session alive — the exact bug
  // `useSessionReconciliation` exists to catch on the next boot.
  const body = code(preferences);
  assert.ok(!/auth\.signOut\(\)/.test(body), "must not re-implement the Supabase call");
  assert.ok(!/useAuthStore\.getState\(\)\.logout/.test(body), "must not clear only the local flag");
});

test("signing out cannot be undone with Back", () => {
  // `replace` drops the authenticated entry from history. A push would leave
  // the screen one Back press away from a session that no longer exists.
  assert.match(preferences, /navigate\("\/login", \{ replace: true \}\)/);
});

test("a second press cannot race the sign-out round trip", () => {
  assert.match(preferences, /if \(signingOut\) return;/);
  assert.match(preferences, /disabled=\{signingOut\}/);
});

test("preferences exposes no privileged or store-wide control", () => {
  const body = code(preferences);
  for (const forbidden of ["license", "License", "store_licenses", "claim_store", "is_system_owner",
                           "store_members", "branches", "admin_", "invite"]) {
    assert.ok(!body.includes(forbidden), `preferences must not surface ${forbidden}`);
  }
});

test("preferences offers nothing to configure about being offline", () => {
  // Online-only: there is no queue to drain, no conflict policy to choose and
  // no local accounting to switch on.
  const body = code(preferences);
  for (const forbidden of ["offline", "Offline", "syncQueue", "conflict", "reconcil"]) {
    assert.ok(!body.includes(forbidden), `preferences must not offer ${forbidden}`);
  }
});

test("the account card states role from the canonical map", () => {
  assert.match(preferences, /ROLE_LABELS\[role\]/);
  assert.match(preferences, /toAppRole\(userRole\)/);
});

test("the theme toggle uses the existing store and applier", () => {
  assert.match(preferences, /useThemeStore/);
  assert.match(preferences, /applyTheme\(next, preset, customColors\)/);
  assert.doesNotMatch(code(preferences), /document\.documentElement\.classList/,
    "theme must not be painted by hand around the canonical applier");
});
