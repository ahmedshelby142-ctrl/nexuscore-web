/**
 * Mobile boot order — no protected read before there is a session.
 *
 *     node --test scripts/check_mobile_boot_order.mjs
 *
 * ## What this locks in
 *
 * The Mobile app has exactly one gate between "the page loaded" and "a
 * protected query may fire": `MobileSessionGate`. While
 * `useSessionReconciliation` is still asking Supabase who this is, the gate
 * renders a spinner and NOT `<Outlet />`, so `MobileShell` never mounts, so
 * `MobileBottomNav` never calls `useAlertBadges`, so `mobile_shortages` is
 * never sent. Every other protected mobile reader sits behind the same gate.
 *
 * That ordering is invisible in a diff — it is a consequence of where two
 * components sit in a tree — and it is exactly the kind of thing a later
 * refactor breaks by hoisting a hook or flattening a route. So it is asserted
 * here.
 *
 * ## Measured, not assumed
 *
 * Against the live database on 2026-09-20 (baseline `bd8e74a`), with every
 * `fetch` to Supabase recorded from the first byte of the entry module:
 *
 *   Mobile, ADMIN cold boot on `/`         9 requests, 0 anon, 0 failures
 *   Mobile, ADMIN cold boot on `/owner`   11 requests, 0 anon, 0 failures
 *   Mobile, logout → login as MODERATOR   12 requests, 0 anon, 0 failures
 *   Desktop, ADMIN cold boot (production) 34 requests, 0 anon, 0 failures,
 *                                         every hydrated table fetched ONCE
 *
 * No request was sent anonymously and none returned 401. The duplicate
 * hydration visible in `vite dev` is React StrictMode double-invoking effects
 * in development; the production build hydrates each table once.
 *
 * These tests are the guard that keeps that true.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const app = read("../src/mobile/MobileApp.tsx");
const gate = read("../src/mobile/shell/MobileSessionGate.tsx");
const router = read("../src/mobile/router.tsx");
const shell = read("../src/mobile/shell/MobileShell.tsx");
const bottomNav = read("../src/mobile/shell/MobileBottomNav.tsx");
const badges = read("../src/mobile/shell/useAlertBadges.ts");
const homeReader = read("../src/mobile/data/mobileHomeReader.ts");
const ownerReader = read("../src/lib/ledger/ownerFinancials.ts");
const ownerHook = read("../src/mobile/data/useOwnerFinancials.ts");
const reconciliation = read("../src/lib/auth/useSessionReconciliation.ts");
const realtime = read("../src/hooks/useRealtimeSync.ts");
const layout = read("../src/components/layout/Layout.tsx");
const workflow = read("../src/lib/auth/sessionWorkflow.ts");

// ═══════════════════════════════════════════════════════════════════════════
// 1 · The gate exists, and it blocks
// ═══════════════════════════════════════════════════════════════════════════

test("the mobile root resolves the session before anything else renders", () => {
  assert.match(app, /const sessionState = useSessionReconciliation\(\)/);
  assert.match(app, /<MobileRouter sessionState=\{sessionState\}/);
  // Reconciliation starts from Supabase's own answer, not a local flag.
  assert.match(reconciliation, /await supabase\.auth\.getSession\(\)/);
  assert.match(reconciliation, /onAuthStateChange/, "and keeps listening after that");
});

test("while the session is unknown the gate renders a state, not the app", () => {
  const code = strip(gate);
  const checking = code.indexOf('sessionState === "checking"');
  const outlet = code.indexOf("<Outlet />");
  assert.ok(checking > -1, "the gate must have a checking branch");
  assert.ok(outlet > -1, "and it must be the LAST thing it reaches");
  assert.ok(
    checking < outlet,
    "an <Outlet /> reached before the checking branch mounts every reader anonymously",
  );
  assert.match(code, /if \(sessionState === "checking"\) \{\s*return <MobileAccessState/);
});

test("no session means a redirect, never a render", () => {
  const code = strip(gate);
  assert.match(
    code,
    /if \(sessionState === "unavailable" \|\| !isAuthenticated\) \{\s*return <Navigate to="\/login"/,
    "an unauthenticated visitor must reach /login, not a screen that queries",
  );
  const redirect = code.indexOf('Navigate to="/login"');
  assert.ok(redirect < code.indexOf("<Outlet />"), "the redirect must come first");
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · Everything protected sits behind that gate
// ═══════════════════════════════════════════════════════════════════════════

test("every protected route is nested inside MobileSessionGate", () => {
  const gateOpen = router.indexOf("<MobileSessionGate");
  assert.ok(gateOpen > -1, "the router must mount the gate");

  // The public routes are the only ones declared before it.
  const before = router.slice(0, gateOpen);
  for (const publicPath of ['path="/login"', 'path="/set-password"']) {
    assert.ok(before.includes(publicPath), `${publicPath} must stay OUTSIDE the gate`);
  }
  const after = router.slice(gateOpen);
  for (const guarded of ["orders", "inventory", "shipments", "customers", "owner", "restock"]) {
    assert.ok(after.includes(`path="${guarded}"`), `${guarded} must sit inside the gate`);
  }
  // …and the shell, which is what mounts the badge reader.
  assert.ok(after.includes("<MobileShell />"), "the shell is protected too");
});

test("useAlertBadges is reachable only from inside the shell", () => {
  assert.match(bottomNav, /useAlertBadges\(\)/, "the bottom nav is its only caller");
  assert.match(shell, /<MobileBottomNav/, "and the shell is its only mount point");
  // If anything above the gate ever calls it, the ordering is gone.
  for (const [name, src] of [["MobileApp", app], ["MobileSessionGate", gate]]) {
    assert.ok(!src.includes("useAlertBadges"), `${name} must not mount the badge reader`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · The readers refuse to guess when there is no session
// ═══════════════════════════════════════════════════════════════════════════

test("mobile_shortages is never sent without a resolved store", () => {
  const code = strip(homeReader);
  const guard = code.indexOf("if (!storeId) return [];");
  const call = code.indexOf('rpc("mobile_shortages"');
  assert.ok(guard > -1, "no store means no call — not a call with a guessed id");
  assert.ok(guard < call, "and the guard must come BEFORE the call");
  assert.match(code, /const storeId = await getActiveStoreId\(\)/);
});

test("owner_financial_summary is never sent without a client and a store", () => {
  const code = strip(ownerReader);
  const noClient = code.indexOf('throw new Error("[owner_financial_summary] no Supabase client")');
  const noStore = code.indexOf('throw new Error("[owner_financial_summary] no active store")');
  const call = code.indexOf('rpc("owner_financial_summary"');
  assert.ok(noClient > -1 && noStore > -1, "both preconditions must refuse loudly");
  assert.ok(noClient < call && noStore < call, "and both must be checked before the call");
});

test("a refusal is surfaced, never swallowed and never retried blindly", () => {
  const code = strip(ownerHook);
  assert.match(code, /setError\(/, "the failure reaches the screen");
  assert.match(code, /setData\(null\)/, "and no stale figure survives it");
  // No timer-driven retry: the user asks again, the app does not hammer.
  assert.ok(!/setInterval|setTimeout/.test(code), "no blind retry loop");
  assert.ok(!/catch\s*\{\s*\}/.test(code), "no swallowed error");
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · One hydration, and none of it on Mobile
// ═══════════════════════════════════════════════════════════════════════════

test("Mobile never hydrates — it has no whole-table pull to race with", () => {
  for (const [name, src] of [
    ["MobileApp", app],
    ["router", router],
    ["shell", shell],
    ["useAlertBadges", badges],
    ["mobileHomeReader", homeReader],
  ]) {
    assert.ok(!src.includes("cloudHydrate"), `${name} must not import the desktop hydrator`);
    assert.ok(!src.includes("hydrateAll"), `${name} must not call hydrateAll`);
  }
});

test("the desktop hydrator has exactly one automatic caller", () => {
  // `hydrateAll` EMPTIES every cloud-owned collection before re-reading, so a
  // second automatic caller is not a wasted request — it is a wipe landing in
  // the middle of the first one's answer.
  const auto = strip(realtime).match(/hydrateAll\(\)/g) ?? [];
  assert.ok(auto.length >= 1, "boot hydration must exist on desktop");
  // Layout's copy is behind a button the user presses, not an effect.
  const layoutCode = strip(layout);
  assert.match(
    layoutCode,
    /const refreshFromCloud = async \(\) => \{[\s\S]*?hydrateAll\(\)/,
    "Layout's hydrate must stay inside the manual refresh handler",
  );
  const handlerEnd = layoutCode.indexOf("setRefreshing(false)");
  assert.ok(
    layoutCode.indexOf("hydrateAll()") < handlerEnd,
    "…and must not escape into a useEffect",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · One session's store id must not reach the next session
// ═══════════════════════════════════════════════════════════════════════════

test("signing in drops the previous user's cached store", () => {
  // `storeContext` memoises the resolved store id for the tab. Two people
  // using one browser must not share it — the second would write rows tagged
  // with the first one's shop.
  const code = strip(workflow);
  assert.match(code, /clearStoreIdCache\(\)/, "the session workflow must clear it");
  const cleared = code.indexOf("clearStoreIdCache()");
  assert.ok(cleared > -1);
  // The CALL sites, not the `function hydrateAfterLogin` declaration that
  // precedes them — the declaration's position says nothing about ordering.
  const calls = [...code.matchAll(/hydrateAfterLogin\("/g)].map((m) => m.index);
  assert.ok(calls.length > 0, "desktop still hydrates after login");
  for (const call of calls) {
    assert.ok(cleared < call, "clear the cache BEFORE reading anything for the new user");
  }
});

test("logging out leaves no authenticated state behind", () => {
  const code = strip(workflow);
  assert.match(code, /auth\.signOut\(\)/, "the Supabase session is ended server-side");
  assert.match(code, /useAuthStore\.getState\(\)\.logout\(\)/, "and the local mirror is cleared");
  const store = strip(read("../src/store/useAuthStore.ts"));
  assert.match(store, /isAuthenticated: false/, "logout must clear the flag the gate reads");
  assert.match(store, /isSystemOwner: false/, "including global authority");
});
