/**
 * P0 — MODERATOR is Mobile-native: invite, reset and sign-in end on Mobile Home.
 *
 *     node --test scripts/check_auth_routing.mjs
 *
 * The bug: an invited or reset MODERATOR («مشرف متابعة») landed on the
 * Desktop's «التفضيلات الشخصية والمظهر» with nothing but «تسجيل الخروج».
 * Every auth link opened the Desktop origin, the Desktop's only home for the
 * role was `/preferences`, and a recovery link at the root became a session
 * with no password step at all.
 *
 * The final flow:
 *   invite  → Mobile /set-password → password once → Mobile Home
 *   reset   → Mobile /set-password → password once → Mobile Home
 *   sign-in → Mobile /login → Mobile Home;  refresh → Mobile Home;  logout → /login
 * and a link Supabase could only send to the Desktop (the Site URL) moves its
 * session, untouched, to the Mobile password screen — never a second sign-in.
 *
 * These are deterministic route/bootstrap checks. The browser run against a
 * local mock Auth server is recorded in the release report; a run with a real
 * invitation email is still the final proof.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { APP_ROLES, canAccess, homeFor } from "../src/lib/roles.ts";
import { parseAuthLinkIntent, routeAuthLinkToPasswordSetup, authLinkIntent } from "../src/lib/auth/authLinkIntent.ts";
import { MOBILE_APP_URL, mobileAppUrl, mobileSessionUrl } from "../src/lib/appSurfaces.ts";

// CRLF-normalised: a fresh Windows checkout (core.autocrlf) has \r\n line ends.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = read("src/App.tsx");
const redirect = read("src/routes/mobile-app.tsx");
const transfer = read("src/lib/auth/mobileSessionTransfer.ts");
const workflow = read("src/lib/auth/sessionWorkflow.ts");
const desktopSetPassword = read("src/pages/SetPassword.tsx");
const mobileSetPassword = read("src/mobile/auth/MobileSetPassword.tsx");
const mobileLogin = read("src/mobile/auth/MobileLogin.tsx");
const mobileRouter = read("src/mobile/router.tsx");
const invite = read("supabase/functions/invite-staff/index.ts");
const capabilities = read("src/mobile/navigation/mobileCapabilities.ts");

const fnBody = (src, name) => src.match(new RegExp(`(?:export )?(?:async )?function ${name}[\\s\\S]*?\\n}\\n`))[0];

// ── role → initial route ────────────────────────────────────────────────────

test("OTHER ROLES: Desktop homes are unchanged, and every home is openable", () => {
  const expected = {
    ADMIN: "/",
    POS_ECOMMERCE: "/pos",
    ECOMMERCE_ONLY: "/orders",
    ACCOUNTANT: "/purchasing",
    MODERATOR: "/mobile-app",
  };
  assert.deepEqual([...APP_ROLES].sort(), Object.keys(expected).sort());
  for (const role of APP_ROLES) {
    assert.equal(homeFor(role), expected[role], `${role} home`);
    assert.ok(canAccess(role, homeFor(role)), `${role} must be able to open its own home`);
  }
});

test("MODERATOR never lands on Preferences or a handoff", () => {
  assert.notEqual(homeFor("MODERATOR"), "/preferences");
  assert.doesNotMatch(app + read("src/lib/roles.ts"), /mobile-handoff/, "the Desktop handoff is gone");
  assert.ok(canAccess("MODERATOR", "/preferences"), "Preferences stays reachable, just not a destination");
});

test("the Desktop redirect route is MODERATOR's alone (ADMIN is implicit everywhere)", () => {
  assert.ok(canAccess("MODERATOR", "/mobile-app"));
  for (const role of ["POS_ECOMMERCE", "ECOMMERCE_ONLY", "ACCOUNTANT"]) {
    assert.equal(canAccess(role, "/mobile-app"), false, role);
  }
});

test("ROLE SAFETY: MODERATOR gets no finance, admin or write screen on Desktop", () => {
  for (const path of ["/", "/owner", "/partners", "/purchasing", "/pos", "/orders", "/ecommerce-orders",
    "/inventory", "/products", "/courier-ledger", "/wholesale", "/credit-invoices", "/returns",
    "/settings", "/users", "/branches", "/backups", "/integrations", "/system-admin/licenses"]) {
    assert.equal(canAccess("MODERATOR", path), false, `MODERATOR must not reach ${path}`);
  }
});

test("ROLE SAFETY: MODERATOR's Mobile surfaces are unchanged — no owner/finance/purchasing", () => {
  const stated = capabilities
    .match(/const MODERATOR_CAPABILITIES: readonly MobileCapability\[\] = \[([\s\S]*?)\]/)[1]
    .match(/"[a-z]+"/g)
    .map((s) => s.replaceAll('"', ""));
  assert.deepEqual([...stated].sort(), ["customers", "home", "more", "orders", "preferences", "shipments", "stock"]);
});

// ── INVITATION ──────────────────────────────────────────────────────────────

test("INVITATION: a MODERATOR invite targets the Mobile app's /set-password", () => {
  const accept = fnBody(invite, "acceptUrl");
  assert.match(accept, /role === "MODERATOR"\s*\?\s*MOBILE_APP_URL/);
  assert.match(accept, /new URL\("\/set-password", base\)/);
  assert.match(invite, /const MOBILE_APP_URL = Deno\.env\.get\("MOBILE_APP_URL"\) \|\| "https:\/\/nexuscore-mobile\.vercel\.app"/);
  assert.match(invite, /redirectTo: acceptUrl\(req, role\)/);
  // Other roles keep the previous target.
  assert.match(accept, /: Deno\.env\.get\("APP_URL"\) \|\| req\.headers\.get\("origin"\)/);
});

test("INVITATION: Mobile /set-password → password once → Mobile Home", () => {
  assert.match(mobileRouter, /path="\/set-password"/);
  assert.match(mobileSetPassword, /completePasswordSetup\(password\)/);
  assert.match(mobileSetPassword, /navigate\("\/", \{ replace: true \}\)/, "Mobile Home, no second sign-in");
  assert.doesNotMatch(mobileSetPassword, /signInWithPassword/);
  assert.doesNotMatch(fnBody(workflow, "completePasswordSetup"), /claim_store/, "never creates a tenant");
});

// ── the Desktop fallback: a link Supabase sent to the Site URL ──────────────

test("a MODERATOR link that reached the Desktop moves to Mobile /set-password before any form", () => {
  assert.match(desktopSetPassword, /setupSession\.role === "MODERATOR"/);
  assert.match(desktopSetPassword, /moveSessionToMobile\(\s*"\/set-password"/);
  assert.ok(
    desktopSetPassword.indexOf("moveSessionToMobile(") < desktopSetPassword.indexOf("setEmail("),
    "the move happens before the Desktop form could render",
  );
  assert.match(fnBody(workflow, "readPasswordSetupSession"), /from\("store_members"\)[\s\S]*select\("role"\)/);
});

test("the transferred session is exactly what the Mobile client consumes", () => {
  const url = mobileSessionUrl(
    "/set-password",
    { access_token: "a.b.c", refresh_token: "r1", expires_at: 2_000_000_600 },
    "invite",
    2_000_000_000_000,
  );
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, `${MOBILE_APP_URL}/set-password`);
  assert.equal(parsed.search, "", "no token in the query string — only the fragment");
  const p = new URLSearchParams(parsed.hash.slice(1));
  // supabase-js `_getSessionFromURL` requires these four.
  assert.equal(p.get("access_token"), "a.b.c");
  assert.equal(p.get("refresh_token"), "r1");
  assert.equal(p.get("token_type"), "bearer");
  assert.equal(p.get("expires_in"), "600");
  assert.equal(p.get("expires_at"), "2000000600");
  // …and the Mobile app still recognises it as an invite.
  assert.equal(parseAuthLinkIntent(url), "invite");
  assert.equal(parseAuthLinkIntent(mobileSessionUrl("/", { access_token: "a", refresh_token: "r" })), null);
});

test("the Desktop drops its copy without revoking the session it handed over", () => {
  assert.doesNotMatch(transfer, /\.signOut\(/, "signOut revokes server-side, killing the Mobile session");
  assert.match(transfer, /stopAutoRefresh\(\)/, "no Desktop refresh racing the Mobile one");
  assert.match(transfer, /localStorage\.removeItem/);
  assert.match(transfer, /window\.location\.replace\(target\)/);
});

// ── PASSWORD RESET ──────────────────────────────────────────────────────────

test("RESET: Mobile forgot-password → Mobile /set-password → Mobile Home", () => {
  const fn = fnBody(workflow, "requestPasswordReset");
  assert.match(fn, /resetPasswordForEmail\(address, \{\s*redirectTo: `\$\{window\.location\.origin\}\/set-password`/);
  assert.match(mobileLogin, /requestPasswordReset\(email\)/);
  assert.match(mobileSetPassword, /intent === "recovery" \? "تغيير كلمة المرور"/);
});

test("RESET: auth links are recognised from the fragment or the query", () => {
  const base = "https://nexuscore-web1.vercel.app";
  assert.equal(parseAuthLinkIntent(`${base}/#access_token=x&type=invite`), "invite");
  assert.equal(parseAuthLinkIntent(`${base}/#access_token=x&refresh_token=y&type=recovery`), "recovery");
  assert.equal(parseAuthLinkIntent(`${base}/?type=recovery&token_hash=abc`), "recovery");
  assert.equal(
    parseAuthLinkIntent(`${base}/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid`),
    "link_error",
  );
  assert.equal(parseAuthLinkIntent(`${base}/#access_token=x&type=signup`), null);
  assert.equal(parseAuthLinkIntent(`${base}/orders?error=x`), null, "a plain ?error= is not an auth link");
  assert.equal(parseAuthLinkIntent(`${base}/`), null);
  assert.equal(parseAuthLinkIntent("not a url"), null);
});

function fakeWindow(href) {
  const url = new URL(href);
  const calls = [];
  return {
    calls,
    location: { href, pathname: url.pathname, search: url.search, hash: url.hash },
    history: { replaceState: (_d, _u, next) => calls.push(next) },
  };
}

test("RESET: a recovery link at the Site URL root is moved to /set-password with its fragment", () => {
  const win = fakeWindow("https://nexuscore-web1.vercel.app/#access_token=x&type=recovery");
  assert.equal(routeAuthLinkToPasswordSetup(win), "recovery");
  assert.deepEqual(win.calls, ["/set-password#access_token=x&type=recovery"]);
  assert.equal(authLinkIntent(), "recovery", "the password screen reads the captured intent");
});

test("an invite link already on /set-password is left alone; a refresh is never rewritten", () => {
  const onPage = fakeWindow("https://nexuscore-mobile.vercel.app/set-password#access_token=x&type=invite");
  assert.equal(routeAuthLinkToPasswordSetup(onPage), "invite");
  assert.deepEqual(onPage.calls, []);
  const refresh = fakeWindow("https://nexuscore-mobile.vercel.app/orders");
  routeAuthLinkToPasswordSetup(refresh);
  assert.deepEqual(refresh.calls, []);
});

test("the link is captured before the Supabase client can consume it", () => {
  for (const entry of ["src/main.tsx", "src/mobile/main.tsx"]) {
    const firstImport = read(entry).match(/^import\s.*$/m)[0];
    assert.equal(firstImport, 'import "@/lib/auth/authLinkIntent";', `${entry} must import it first`);
  }
  assert.doesNotMatch(read("src/lib/auth/authLinkIntent.ts"), /^import\s/m, "must stay dependency-free");
});

// ── NORMAL LOGIN / REFRESH / LOGOUT ─────────────────────────────────────────

test("NORMAL LOGIN: Mobile /login → Mobile Home, never creating a store", () => {
  assert.match(mobileLogin, /missingMembership: "reject"/);
  assert.match(mobileLogin, /: "\/", \{ replace: true \}\)/);
});

test("REFRESH: the Mobile boot re-reads the session and membership, then Home", () => {
  assert.match(read("src/mobile/MobileApp.tsx"), /useSessionReconciliation\(\)/);
  const gate = read("src/mobile/shell/MobileSessionGate.tsx");
  assert.match(gate, /sessionState === "checking"/, "unresolved bootstrap shows loading");
  assert.match(gate, /<Outlet \/>/);
  assert.match(read("src/lib/auth/useSessionReconciliation.ts"), /from\("store_members"\)/);
});

test("LOGOUT: Mobile sign-out → Mobile /login", () => {
  const sheet = read("src/mobile/shell/MobileMoreSheet.tsx");
  assert.match(sheet, /await signOutCurrentSession\(\);[\s\S]{0,80}navigate\("\/login", \{ replace: true \}\)/);
});

// ── Desktop defensive fallback ──────────────────────────────────────────────

test("Desktop: a MODERATOR session is moved to Mobile Home, with no Desktop shell", () => {
  const protectedAt = app.indexOf("<Route element={<ProtectedRoute");
  assert.ok(app.indexOf('path="/set-password"') < protectedAt, "/set-password must not wait for a session");
  const at = app.indexOf('path="/mobile-app"');
  assert.ok(at > protectedAt, "needs a session");
  assert.ok(at > app.indexOf("<Route element={<LicenseGate />}>"), "licence, then role — same order as every screen");
  assert.ok(at < app.indexOf('<Route path="/" element={<Layout />}>'), "no sidebar");
  assert.match(app.slice(at - 120, at), /<RequireAccess \/>/, "same access map as every screen");
  assert.match(redirect, /moveSessionToMobile\("\/"\)/);
  assert.match(redirect, /افتح تطبيق العمليات على الموبايل/);
  assert.match(read("src/pages/Login.tsx"), /navigate\(homeFor\(toAppRole\(useAuthStore\.getState\(\)\.userRole\)\), \{ replace: true \}\)/);
});

test("the Mobile URL has one client-side source of truth", () => {
  assert.equal(mobileAppUrl("/login"), `${MOBILE_APP_URL}/login`);
  const offenders = [
    "src/App.tsx", "src/pages/Login.tsx", "src/pages/SetPassword.tsx", "src/routes/mobile-app.tsx",
    "src/lib/auth/mobileSessionTransfer.ts", "src/lib/auth/sessionWorkflow.ts",
  ].filter((f) => read(f).includes("nexuscore-mobile.vercel.app"));
  assert.deepEqual(offenders, []);
  assert.match(read(".env.example"), /^VITE_MOBILE_APP_URL=/m);
});

test("unresolved bootstrap shows loading on Desktop too", () => {
  const guard = read("src/components/auth/ProtectedRoute.tsx");
  assert.match(guard, /جارٍ التحقق من الجلسة/);
  assert.match(desktopSetPassword, /if \(checking\)/);
  assert.match(mobileSetPassword, /if \(checking\)/);
});
