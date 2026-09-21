/**
 * Desktop P0 Wave 1 — the four production blockers, locked shut.
 *
 * Each block below names the bug it prevents from coming back. Sources are
 * read with comments stripped for every "must NOT appear" assertion, because
 * these modules deliberately describe what they refuse to do and an assertion
 * that cannot tell prose from code fails on good documentation.
 *
 * Reference: docs/DESKTOP_PRODUCT_AUDIT.md §D.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const app = read("../src/App.tsx");
const appCode = strip(app);
const protectedRoute = strip(read("../src/components/auth/ProtectedRoute.tsx"));
const realtime = strip(read("../src/hooks/useRealtimeSync.ts"));
const reconcile = strip(read("../src/lib/auth/useSessionReconciliation.ts"));
const authStore = strip(read("../src/store/useAuthStore.ts"));
const featureStore = read("../src/store/useFeatureStore.ts");
const featureCode = strip(featureStore);
const sidebar = strip(read("../src/components/dashboard/Sidebar.tsx"));
const roles = strip(read("../src/lib/roles.ts"));
const requireAccess = strip(read("../src/components/auth/RequireAccess.tsx"));
const identity = read("../src/components/layout/SessionIdentity.tsx");
const identityCode = strip(identity);
const header = read("../src/components/dashboard/Header.tsx");
const headerCode = strip(header);
const layout = read("../src/components/layout/Layout.tsx");
const layoutCode = strip(layout);

// ═══════════════════════════════════════════════════════════════════════════
// P0-1 · Public production access
//
// The production URL sat behind Vercel Authentication, so an ordinary shop
// reached a Vercel login and never saw NexusCore's own. That is a project
// setting, not a repository fact, so the only honest check is an HTTP one.
//
// Opt-in, because a test that reaches the public internet on every run is
// flaky by construction:
//
//     NEXUS_PUBLIC_URL=https://nexuscore-web1.vercel.app npm run test:units
// ═══════════════════════════════════════════════════════════════════════════

const PUBLIC_URL = process.env.NEXUS_PUBLIC_URL;

test(
  "P0-1 · an anonymous visitor reaches NexusCore, not a Vercel login",
  { skip: PUBLIC_URL ? false : "NEXUS_PUBLIC_URL not set" },
  async () => {
    // No credentials, no cookie jar — the same request a shop's browser makes
    // on its first visit.
    const res = await fetch(PUBLIC_URL, { redirect: "follow" });
    assert.equal(res.status, 200, `expected 200 from ${PUBLIC_URL}, got ${res.status}`);

    // Vercel's SSO challenge announces itself two ways: it sets `_vercel_sso`
    // and it bounces to vercel.com. Neither may appear.
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.ok(!/_vercel_sso/.test(setCookie), "a Vercel SSO cookie means the gate is still up");
    assert.ok(
      !/vercel\.com\/sso|vercel\.com\/login/.test(res.url),
      `the request was redirected to a Vercel login: ${res.url}`,
    );

    const body = await res.text();
    assert.match(body, /<title>NexusCore/, "the served document must be the application shell");
    assert.ok(
      !/Authentication Required/i.test(body),
      "Vercel's interstitial is being served instead of the app",
    );

    // And the SPA fallback must survive, or every deep link 404s for a real
    // visitor while `/` looks fine.
    const deep = await fetch(new URL("/login", PUBLIC_URL), { redirect: "follow" });
    assert.equal(deep.status, 200, "the SPA rewrite must serve /login");
    assert.match(await deep.text(), /<title>NexusCore/);
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// P0-2 · The header showed a person who does not exist
//
// `dashboard/Header.tsx` rendered the literals "سارة المصري" and
// "مدير النظام" to every signed-in user of every store, and the SHIPPED shell
// (`layout/Layout.tsx`) showed no identity at all — so nobody could see they
// were looking at someone else's session on a shared till.
// ═══════════════════════════════════════════════════════════════════════════

test("P0-2 · no chrome hardcodes a persona", () => {
  for (const [name, src] of [
    ["Header", headerCode],
    ["Layout", layoutCode],
    ["SessionIdentity", identityCode],
  ]) {
    assert.ok(!src.includes("سارة المصري"), `${name} must not name a fictional user`);
    // The role LABEL is legitimate in `lib/roles.ts`; hardcoding it in chrome
    // is what showed ADMIN to a cashier.
    assert.ok(
      !/["'>]\s*مدير النظام\s*["'<]/.test(src),
      `${name} must not print a role label it did not resolve`,
    );
  }
});

test("P0-2 · identity is read from the session store, field by field", () => {
  assert.match(identityCode, /useAuthStore\(\(s\) => s\.username\)/, "the name comes from the session");
  assert.match(identityCode, /useAuthStore\(\(s\) => s\.userRole\)/, "the role comes from the session");
  assert.match(
    identityCode,
    /useAuthStore\(\(s\) => s\.isSystemOwner\)/,
    "the global identity comes from the session",
  );
  // Reaching past the store into storage would reintroduce exactly the
  // localStorage-as-authority problem P0-4 exists to remove.
  assert.ok(!/localStorage/.test(identityCode), "the chip must not read storage directly");
});

test("P0-2 · the role label comes from the one canonical map", () => {
  assert.match(identityCode, /ROLE_LABELS\[toAppRole\(userRole\)\]/, "one map, no second table");
  assert.match(identity, /from "@\/lib\/roles"/);
  // A private label table here would drift from the invite dropdown and the
  // sidebar, which is how two names for one role get shipped.
  for (const label of ["كاشير وأونلاين", "محاسب ومخازن", "أونلاين فقط", "مشرف متابعة"]) {
    assert.ok(!identityCode.includes(label), `${label} must come from ROLE_LABELS, not a literal`);
  }
});

test("P0-2 · every role has a label, so no user reads a blank or a raw key", () => {
  const roleLabels = roles.slice(roles.indexOf("export const ROLE_LABELS"));
  for (const role of ["ADMIN", "POS_ECOMMERCE", "ECOMMERCE_ONLY", "ACCOUNTANT", "MODERATOR"]) {
    assert.match(
      roleLabels,
      new RegExp(`${role}:\\s*"[^"]+"`),
      `${role} must have an Arabic label for the header to show`,
    );
  }
});

test("P0-2 · System Owner stays distinct from store ADMIN", () => {
  // Shown ALONGSIDE the store role, never instead of it: an owner who also
  // administers their own shop is both, and collapsing them hides which one a
  // screen is answering to.
  assert.match(identityCode, /isSystemOwner && \(/, "the owner badge is conditional");
  assert.match(identityCode, /مالك النظام/, "and is labelled as the global identity");
  assert.match(identityCode, /<span>\{roleLabel\}<\/span>/, "the store role is still printed");
  // And it must remain un-persisted, or the badge becomes a localStorage edit.
  const partialize = authStore.match(/partialize: \(s\) => \(\{[\s\S]*?\}\),/)[0];
  assert.ok(!partialize.includes("isSystemOwner"), "the owner flag must never be persisted");
});

test("P0-2 · the shipped shell renders the identity", () => {
  // `Layout` is what `App` mounts. `Header` is the unmounted TanStack route's
  // chrome — both must show the same truth, because the fiction survived in
  // one of them precisely by being the copy nobody looked at.
  assert.match(layoutCode, /<SessionIdentity/, "the shipped header must show who is signed in");
  assert.match(headerCode, /<SessionIdentity/, "and so must the file-route header");
});

test("P0-2 · the dead controls beside it are gone, not rewired", () => {
  // A search input with no handler and a bell with an unconditional unread dot
  // are focusable, labelled controls that answer a press with nothing.
  assert.ok(!/<Bell/.test(headerCode), "a notification bell with no notifications is a lie");
  assert.ok(!/placeholder="ابحث/.test(headerCode), "a search box with no handler must not ship");
  assert.ok(!/useState<"قطاعي"/.test(headerCode), "a mode toggle nothing reads must not ship");
});

// ═══════════════════════════════════════════════════════════════════════════
// P0-3 · Returns and Integrations were hidden on every fresh browser
//
// `useFeatureStore` defaulted both module flags to `false`, persisted them
// per-browser, and `Sidebar.useNavItems` filtered the navigation on them. A new
// machine opened NexusCore with no «المرتجعات والاستبدال» and no
// «ربط المتجر الإلكتروني» in the menu, and clearing site data re-hid them.
// ═══════════════════════════════════════════════════════════════════════════

test("P0-3 · the two module flags default ON", () => {
  // Scoped to the INITIALIZER. A bare file-wide match passes on the `true`
  // inside `migrate` alone, which a mutation run proved: flipping the default
  // back to `false` left this test green. The default and the migration are
  // two separate guarantees and each needs its own assertion.
  // Anchored on the IMPLEMENTATION, not on `toggleReturns:` — that spelling
  // appears first in the `FeatureState` interface above `persist(`, which made
  // the slice empty and the test fail for the wrong reason.
  const start = featureCode.indexOf("persist(");
  const end = featureCode.indexOf("toggleReturns: () => set");
  assert.ok(start > -1 && end > start, "the initial state block must be found");
  const init = featureCode.slice(start, end);
  assert.match(init, /returnsEnabled: true/, "Returns is a finished, authorized screen");
  assert.match(init, /ecommerceSyncEnabled: true/, "so is the integrations screen");
  assert.ok(!/returnsEnabled: false/.test(init), "…and not overridden to false below it");
  assert.ok(!/ecommerceSyncEnabled: false/.test(init));
});

test("P0-3 · a browser that already stored the old default is corrected", () => {
  // `persist` rehydrates OVER the initializer, so a new default alone leaves
  // every existing browser with both modules hidden forever.
  assert.match(featureCode, /version: 1/, "the stored blob needs a version to migrate from");
  assert.match(featureCode, /migrate: \(persisted, from\)/, "and a migration to run");
  assert.match(
    featureCode,
    /from < 1[\s\S]{0,160}returnsEnabled: true[\s\S]{0,80}ecommerceSyncEnabled: true/,
    "the migration must force both module flags on, once",
  );
});

test("P0-3 · the preference survives — this is not a flag deletion", () => {
  // A shop that does not take returns must still be able to switch it off.
  // Deleting the flags would have traded one silent decision for another.
  assert.match(featureCode, /toggleReturns: \(\) =>/, "the toggle must still exist");
  assert.match(featureCode, /toggleEcommerceSync: \(\) =>/);
  assert.match(sidebar, /featureKey: "returnsEnabled"/, "and still drive the link");
  assert.match(sidebar, /featureKey: "ecommerceSyncEnabled"/);
});

test("P0-3 · visibility is a preference; ACCESS is the role map", () => {
  // The nav filter ANDs three things. `canAccess` is the authorization half and
  // must stay first-class — a feature flag may hide a link, never open one.
  assert.match(
    sidebar,
    /canAccess\(userRole, item\.path\) &&[\s\S]{0,200}featureFlags\[item\.featureKey\]/,
    "the role check must remain part of the filter",
  );
  // And the router asks the same function, so a hidden link and an open URL
  // cannot drift apart again.
  assert.match(requireAccess, /canAccess\(userRole, location\.pathname\)/);
});

test("P0-3 · clearing localStorage cannot change what a role may open", () => {
  // Authorization must not consult the browser at all. If `roles.ts` ever read
  // storage, emptying it would become a permission change.
  assert.ok(!/localStorage|sessionStorage/.test(roles), "the access map must not read storage");
  assert.ok(!/localStorage|sessionStorage/.test(requireAccess), "nor may the route guard");
  // Unknown or absent roles fall to the least privileged, never to admin.
  assert.match(roles, /if \(!role\) return "ECOMMERCE_ONLY"/, "a missing role is not an admin");
  assert.match(
    roles,
    /return LEGACY_ROLE_MAP\[role\] \?\? "ECOMMERCE_ONLY"/,
    "a typo in a role is not an admin",
  );
});

test("P0-3 · MODERATOR gains nothing from the modules becoming visible", () => {
  // Read-only is enforced in Postgres — MODERATOR appears in no `has_role`
  // array — and on desktop it reaches /preferences only. Turning a flag on must
  // not have widened that.
  const access = roles.slice(roles.indexOf("const ROUTE_ACCESS"), roles.indexOf("const ROLE_HOME"));
  const returnsLine = access.match(/"\/returns": \[[^\]]*\]/)[0];
  assert.ok(!returnsLine.includes("MODERATOR"), "MODERATOR must not reach /returns");
  // /integrations is absent from the map entirely, which means ADMIN-only.
  assert.ok(!/"\/integrations":/.test(access), "/integrations stays ADMIN-only by omission");
});

// ═══════════════════════════════════════════════════════════════════════════
// P0-4 · The reconciled session was computed and thrown away
//
// `useRealtimeSync` called `useSessionReconciliation()` and discarded it, so
// `ProtectedRoute` gated on `isAuthenticated` — a boolean in localStorage.
// A stale flag rendered the whole application while every read 401'd.
// ═══════════════════════════════════════════════════════════════════════════

test("P0-4 · the reconciled session reaches the guard", () => {
  assert.match(realtime, /return sessionState;/, "the hook must report what it asked");
  assert.match(appCode, /const sessionState = useRealtimeSync\(\)/, "and App must keep it");
  assert.match(
    appCode,
    /<ProtectedRoute sessionState=\{sessionState\} \/>/,
    "and hand it to the gate",
  );
});

test("P0-4 · the guard holds while the answer is in flight", () => {
  // Rendering the app "just for that moment" hands someone a working-looking
  // till for the moment; bouncing to /login flashes a lockout at a valid user.
  assert.match(protectedRoute, /if \(sessionState === "checking"\)/, "the first render must hold");
  assert.match(protectedRoute, /جارٍ التحقق من الجلسة/, "and say why");
});

test("P0-4 · anything but an authenticated verdict is refused", () => {
  assert.match(
    protectedRoute,
    /if \(sessionState !== "authenticated" \|\| !isAuthenticated\) \{\s*return <Navigate to="\/login" replace \/>;/,
    "both halves must agree before protected UI renders",
  );
  // `unavailable` means no Supabase is configured. There is no local database
  // to fall back to, so there is no session to have.
  assert.ok(
    !/sessionState === "unavailable"[\s\S]{0,80}<Outlet/.test(protectedRoute),
    "an unconfigured client must not be treated as signed in",
  );
});

test("P0-4 · the membership is re-read on EVERY boot, not only a lost flag", () => {
  // This block used to sit behind `if (!isAuthenticated)`, so an ordinary
  // reload kept the persisted `userRole` verbatim — which is how a demoted user
  // kept an ADMIN sidebar and a role typed into devtools survived a refresh.
  assert.ok(
    !/if \(!useAuthStore\.getState\(\)\.isAuthenticated\) \{[\s\S]{0,200}from\("store_members"\)/.test(
      reconcile,
    ),
    "the membership read must not be conditional on the local flag",
  );
  assert.match(reconcile, /from\("store_members"\)[\s\S]{0,80}\.select\("role, store_id"\)/);
  assert.match(
    reconcile,
    /setSession\(\{[\s\S]{0,400}role: toAppRole\(membership\?\.role\)/,
    "the role written must be the one the server just returned",
  );
});

test("P0-4 · a revoked membership ends the session; a dropped packet does not", () => {
  // `maybeSingle()` answers "no row" as `{data: null, error: null}` and a
  // transport failure as `{data: null, error: {...}}`. Treating those the same
  // would sign a user out over flaky wifi and throw away their work — and
  // Postgres refuses every read and write from a revoked member regardless, so
  // holding the UI open through an inconclusive answer exposes nothing.
  assert.match(
    reconcile,
    /if \(!membershipError && !membership && !useAuthStore\.getState\(\)\.isSystemOwner\)/,
    "sign out only on a definite answer, and never on the global identity",
  );
  const branch = reconcile.slice(reconcile.indexOf("if (!membershipError && !membership"));
  assert.match(branch.slice(0, 400), /logout\(\);\s*return "unauthenticated";/);
});

test("P0-4 · realtime consumes the verdict, it does not issue one", () => {
  // Realtime applies RLS using the token the socket JOINED with, so a channel
  // opened before the session is restored joins as anon and silently delivers
  // nothing for the rest of its life.
  assert.match(realtime, /const authenticated = sessionState === "authenticated"/);
  assert.match(realtime, /if \(isCloudSyncMode\(\) && authenticated\) \{/, "the channel waits");
  assert.match(
    realtime,
    /if \(!isCloudSyncMode\(\)\) return;\s*if \(!authenticated\) return;/,
    "and so does the boot hydrate",
  );
  // It must not decide anything: no redirect, no role, no grant.
  assert.ok(!/<Navigate|setUserRole|setSystemOwner\(true\)/.test(realtime),
    "the realtime hook must never become a second auth authority");
});

test("P0-4 · the licence gate is still the licence's, and still downstream", () => {
  // Order matters: signed in, then licensed, then authorized. A licence check
  // above the session check would ask about a store nobody has proven they are
  // a member of.
  const guard = appCode.indexOf("<ProtectedRoute");
  const licence = appCode.indexOf("<LicenseGate />");
  const access = appCode.indexOf("<RequireAccess />");
  assert.ok(guard > -1 && licence > -1 && access > -1);
  assert.ok(guard < licence, "the session gate must sit above the licence gate");
  assert.ok(licence < access, "the licence gate must sit above the role gate");
  // And /license-expired must stay reachable, or a locked shop loops forever.
  assert.ok(
    appCode.indexOf('path="/license-expired"') < licence,
    "the lockout screen must sit outside the gate that redirects to it",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Cross-cutting · localStorage is not the authority
// ═══════════════════════════════════════════════════════════════════════════

test("editing localStorage cannot resurrect a signed-out session", () => {
  // `logout()` clears the flag AND the session, and reconciliation re-asks the
  // server on the next boot. Flipping `isAuthenticated` back to true in
  // devtools now yields "unauthenticated" from the server and a redirect.
  const impl = authStore.search(/logout: \(\) =>\s*\r?\n?\s*set\(\{/);
  assert.ok(impl > -1);
  const body = authStore.slice(impl, impl + 500);
  assert.match(body, /isAuthenticated: false/);
  assert.match(body, /session: null/);
  assert.match(body, /isSystemOwner: false/);
  assert.match(reconcile, /auth\.getSession\(\)/, "and the next boot asks the server, not the flag");
});

test("editing localStorage cannot make anyone System Owner", () => {
  assert.match(reconcile, /rpc\("is_system_owner"\)/, "the verdict is the server's");
  assert.match(
    reconcile,
    /setSystemOwner\(!error && owner === true\)/,
    "and a failed call denies rather than promotes",
  );
});
