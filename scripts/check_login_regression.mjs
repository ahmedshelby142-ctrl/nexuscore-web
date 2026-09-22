/**
 * Login must survive the session-reconciliation gate.
 *
 * ## The regression these lock shut
 *
 * `useSessionReconciliation` resolves ONCE, in a `useEffect` with `[]` deps,
 * and then watches `onAuthStateChange`. That watcher was one-directional:
 *
 *     if (!session && (event === "SIGNED_OUT" || event === "TOKEN_REFRESHED"))
 *
 * A `SIGNED_IN` event always carries a session, so it matched nothing. The
 * state therefore never moved back UP — once a boot with no session resolved
 * to `"unauthenticated"`, nothing short of a page reload could change it.
 *
 * That was harmless while the value was discarded. It stopped being harmless
 * when `ProtectedRoute` started gating on it:
 *
 *     boot with no session   → sessionState = "unauthenticated"
 *     user signs in          → isAuthenticated = true, navigate to "/"
 *     ProtectedRoute         → sessionState !== "authenticated" → /login
 *
 * — a bounce straight back to the login screen, on correct credentials.
 *
 * Mobile did not bounce, because `MobileSessionGate` tests `"unavailable"`
 * rather than `!== "authenticated"`. It lost something quieter instead:
 * `useMobileRealtime(sessionState === "authenticated")` never turned on after
 * a fresh sign-in, so the app ran without realtime until the next reload.
 *
 * One root cause, two surfaces, and the fix is that the watcher must report a
 * session that APPEARS, not only one that disappears.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const RECONCILE = strip(read("../src/lib/auth/useSessionReconciliation.ts"));
const GUARD = strip(read("../src/components/auth/ProtectedRoute.tsx"));
const MGATE = strip(read("../src/mobile/shell/MobileSessionGate.tsx"));
const MAPP = strip(read("../src/mobile/MobileApp.tsx"));
const APP = strip(read("../src/App.tsx"));
const WORKFLOW = strip(read("../src/lib/auth/sessionWorkflow.ts"));
const STORE = strip(read("../src/store/useAuthStore.ts"));

// ═══════════════════════════════════════════════════════════════════════════
// THE REGRESSION
// ═══════════════════════════════════════════════════════════════════════════

test("a session that APPEARS moves the state up, not only one that vanishes", () => {
  // The whole bug in one assertion. Without a branch that reacts to a session
  // being present, a sign-in after boot can never be observed and the gate
  // bounces a correctly-authenticated user back to /login.
  const listener = RECONCILE.slice(
    RECONCILE.indexOf("onAuthStateChange"),
    RECONCILE.indexOf("unsubscribe = "),
  );
  assert.ok(listener.length > 0, "the auth-state listener must exist");
  assert.match(
    listener,
    /if \(session\)[\s\S]{0,400}setState\("authenticated"\)/,
    "a session-bearing event must resolve to authenticated",
  );
});

test("…and a session that vanishes still signs out", () => {
  const listener = RECONCILE.slice(
    RECONCILE.indexOf("onAuthStateChange"),
    RECONCILE.indexOf("unsubscribe = "),
  );
  assert.match(listener, /logout\(\)/, "a revoked session must clear the local flag");
  assert.match(listener, /setState\("unauthenticated"\)/);
  // The hardening from the P0 wave is not traded away to fix the bounce.
  assert.match(RECONCILE, /auth\.getSession\(\)/, "boot still asks the server");
  assert.match(RECONCILE, /rpc\("is_system_owner"\)/, "and still resolves the global identity");
});

test("the desktop guard requires BOTH halves, and still does", () => {
  // The fix must not be "stop checking sessionState" — that would undo P0-4
  // and let a hand-edited localStorage flag render the whole application.
  assert.match(
    GUARD,
    /if \(sessionState !== "authenticated" \|\| !isAuthenticated\)/,
    "the server verdict AND the store flag",
  );
  assert.match(GUARD, /if \(sessionState === "checking"\)/, "and it still holds while asking");
});

test("mobile turns realtime on once the session is real", () => {
  // The quieter half of the same regression: mobile did not bounce, but it ran
  // without realtime until the next reload.
  assert.match(MAPP, /useMobileRealtime\(sessionState === "authenticated"\)/);
  // The gate's own condition is unchanged — mobile fails closed on
  // `unavailable` and on a missing local flag.
  assert.match(MGATE, /if \(sessionState === "unavailable" \|\| !isAuthenticated\)/);
});

test("both surfaces read ONE reconciliation, not two", () => {
  assert.match(APP, /const sessionState = useRealtimeSync\(\)/);
  assert.match(MAPP, /const sessionState = useSessionReconciliation\(\)/);
  // Desktop's wrapper must keep returning it rather than swallowing it again.
  const realtime = strip(read("../src/hooks/useRealtimeSync.ts"));
  assert.match(realtime, /return sessionState;/);
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTH ≠ AUTHORIZATION ≠ LICENCE
// ═══════════════════════════════════════════════════════════════════════════

test("a valid sign-in establishes a session before membership is judged", () => {
  // `is_system_owner` is asked BEFORE the membership branches, so a store-less
  // System Owner is not treated as a stranger…
  assert.ok(
    WORKFLOW.indexOf('rpc("is_system_owner")') < WORKFLOW.indexOf('input.missingMembership === "claim"'),
    "ownership is resolved before membership can veto",
  );
  // …and the desktop path claims a store rather than refusing the session.
  assert.match(WORKFLOW, /input\.missingMembership === "claim"/);
  assert.match(WORKFLOW, /rpc\("claim_store"/);
  // Mobile fails closed instead, deliberately.
  const mlogin = strip(read("../src/mobile/auth/MobileLogin.tsx"));
  assert.match(mlogin, /missingMembership: "reject"/);
});

test("the licence gate sits BELOW the session gate, not inside it", () => {
  // Authentication must not be confused with authorisation: a licensed-out
  // shop still signs in, and is then stopped by `LicenseGate`.
  const guardAt = APP.indexOf("<ProtectedRoute");
  const licenceAt = APP.indexOf("<LicenseGate />");
  assert.ok(guardAt > -1 && licenceAt > -1);
  assert.ok(guardAt < licenceAt, "signed in first, licensed second");
  assert.ok(
    !/sessionState[\s\S]{0,200}store_licenses|licen[cs]e/i.test(
      RECONCILE.slice(RECONCILE.indexOf("export function useSessionReconciliation")),
    ),
    "reconciliation must not consult the licence",
  );
});

test("a store-less System Owner is not signed out by reconciliation", () => {
  assert.match(
    RECONCILE,
    /!membership && !useAuthStore\.getState\(\)\.isSystemOwner/,
    "the global identity is exempt from the membership sign-out",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// LOCALSTORAGE IS NEVER THE AUTHORITY
// ═══════════════════════════════════════════════════════════════════════════

test("a forged flag cannot authenticate", () => {
  // `isAuthenticated` alone is not enough — the server verdict is required too.
  assert.match(GUARD, /sessionState !== "authenticated" \|\| !isAuthenticated/);
  // And the server verdict is never persisted.
  const partialize = STORE.match(/partialize: \(s\) => \(\{[\s\S]*?\}\),/)[0];
  assert.ok(!partialize.includes("isSystemOwner"), "ownership must not be persisted");
});

test("stale local state cannot PREVENT a valid session from booting", () => {
  // The other direction, and the one this regression broke. Reconciliation
  // writes the server's answer unconditionally rather than only when the local
  // flag is missing, so a stale role or username is replaced, not obeyed.
  assert.ok(
    !/if \(!useAuthStore\.getState\(\)\.isAuthenticated\) \{[\s\S]{0,200}from\("store_members"\)/.test(
      RECONCILE,
    ),
    "the membership read must not be conditional on the local flag",
  );
  assert.match(RECONCILE, /setSession\(\{[\s\S]{0,400}role: toAppRole\(membership\?\.role\)/);
});
