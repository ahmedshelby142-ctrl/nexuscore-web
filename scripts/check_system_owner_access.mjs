/**
 * The System Owner is a GLOBAL identity, not a store role.
 *
 * ## The bug this locks shut
 *
 * `establishSupabaseSession` read `store_members` and refused to create an app
 * session without a row. A System Owner who held no membership was therefore
 * treated as a stranger by the client:
 *
 *   - `missingMembership: "reject"` → sign-in refused outright, so
 *     `isAuthenticated` never became true, so `ProtectedRoute` bounced them to
 *     /login and License Management was unreachable. This is the reported
 *     symptom: signed out, signed back in, screen gone.
 *   - `missingMembership: "claim"` (desktop) → `claim_store` MINTED THEM A
 *     STORE as a side effect of logging in. Two such empty stores exist in the
 *     production database, created one minute apart, one per owner email.
 *
 * The server was never wrong. `is_system_owner()` matches the signed-in email
 * against an allowlist in `auth.users`: no store id, no `store_members`, no
 * `has_role`, no `store_licensed`. Verified against the live database — with
 * the membership deleted, the owner still returned `true` and
 * `admin_list_stores()` still returned every store.
 *
 * So these tests assert the CLIENT now matches the server: the question is
 * asked before membership matters, and no membership answer can veto it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const workflow = strip(read("../src/lib/auth/sessionWorkflow.ts"));
const authStore = strip(read("../src/store/useAuthStore.ts"));
const licenseGate = strip(read("../src/components/auth/LicenseGate.tsx"));
const ownerGate = strip(read("../src/components/auth/SystemOwnerGate.tsx"));
const app = strip(read("../src/App.tsx"));
const login = strip(read("../src/pages/Login.tsx"));
const reconcile = strip(read("../src/lib/auth/useSessionReconciliation.ts"));

test("ownership is decided BEFORE membership is required", () => {
  const asked = workflow.indexOf('rpc("is_system_owner")');
  assert.ok(asked > -1, "the workflow must ask the server who this is");

  // Both places that can refuse or divert a session on membership grounds.
  const rejectGuard = workflow.indexOf('input.missingMembership === "reject"');
  const claimGuard = workflow.indexOf('input.missingMembership === "claim"');
  assert.ok(rejectGuard > -1 && claimGuard > -1);

  assert.ok(asked < claimGuard, "ownership must be known before the claim branch");
  assert.ok(asked < rejectGuard, "ownership must be known before the reject branch");
});

test("no membership outcome can veto an exempt System Owner", () => {
  // `reject` must not refuse the session…
  assert.match(
    workflow,
    /if \(!membership && input\.missingMembership === "reject" && !systemOwnerExempt\)/,
    "refusing the owner locks the licence issuer out of the licence screen",
  );
  // …and `claim` must not hand them a tenant they never asked for.
  assert.match(
    workflow,
    /if \(!membership && input\.missingMembership === "claim" && !systemOwnerExempt\)/,
    "a global identity must not acquire a store by signing in",
  );

  // The exemption must be derived before either branch reads it — a `const`
  // consulted above its own declaration is a temporal-dead-zone crash, not a
  // type error, so TypeScript would not have caught it.
  const declared = workflow.indexOf("const systemOwnerExempt");
  assert.ok(declared > -1 && declared < workflow.indexOf('input.missingMembership === "claim"'));
});

test("the store-less session is opt-in, and only where the manager lives", () => {
  // Identity is global; a session with no store is only USEFUL on the surface
  // that hosts /system-admin/licenses. Mobile deliberately does not opt in:
  // letting a store-less owner in there would swap a clear "you belong to no
  // store" for an empty shell behind a licence screen for a store they lack.
  assert.match(workflow, /systemOwnerNeedsNoStore\?: boolean/, "an explicit per-surface flag");
  assert.match(
    workflow,
    /const systemOwnerExempt = isSystemOwner && input\.systemOwnerNeedsNoStore === true/,
    "the exemption needs BOTH the identity and the surface's consent",
  );
  assert.match(login, /systemOwnerNeedsNoStore: true/, "desktop hosts the manager and opts in");

  const mobileLogin = strip(read("../src/mobile/auth/MobileLogin.tsx"));
  assert.ok(
    !/systemOwnerNeedsNoStore/.test(mobileLogin),
    "mobile has no System Owner surface and must keep failing closed",
  );
  // And the identity itself is still resolved everywhere, on every surface.
  assert.match(workflow, /setSystemOwner\(isSystemOwner\)/);
});

test("a store-less session does not crash on a null membership", () => {
  // Scoped to `establishSupabaseSession`. `completePasswordSetup` lower in the
  // file also derefs `membership.role`, but returns early on a null membership
  // first — it is the invite flow, not the sign-in path, and is left alone.
  const establish = workflow.slice(
    workflow.indexOf("export async function establishSupabaseSession"),
    workflow.indexOf("export async function signInWithPassword"),
  );
  // This was `toAppRole(membership.role)` — a real null dereference that
  // TypeScript had been reporting as TS18047 for as long as the file existed.
  assert.ok(
    !/toAppRole\(membership\.role\)/.test(establish),
    "membership is legitimately null for an owner with no store",
  );
  assert.match(establish, /toAppRole\(membership\?\.role \?\? null\)/, "least privilege, no crash");
});

test("the global identity is stored separately from the store role", () => {
  assert.match(authStore, /isSystemOwner: boolean/, "a field of its own");
  assert.match(authStore, /setSystemOwner: \(isSystemOwner\) => set\(\{ isSystemOwner \}\)/);
  // Folding it into `userRole` would re-couple it to a store, which is the bug.
  assert.ok(
    !/userRole: "SYSTEM_OWNER"|AppRole \| "SYSTEM_OWNER"/.test(authStore),
    "ownership is not a store role and must not be smuggled into one",
  );
});

test("signing out forgets that this machine held a System Owner", () => {
  // Anchored on the implementation's `set({`, because a bare "logout: () =>"
  // matches the interface declaration higher up the file first.
  const impl = authStore.search(/logout: \(\) =>\s*\r?\n\s*set\(\{/);
  assert.ok(impl > -1, "the logout implementation must be found, not its type declaration");
  assert.match(authStore.slice(impl, impl + 500), /isSystemOwner: false/, "the next user is not the owner");
});

test("the licence manager is reachable without a usable store licence", () => {
  // Mounted outside <LicenseGate> — a lapsed store must not hide the screen
  // that un-lapses it.
  const gateAt = app.indexOf("<LicenseGate />");
  const routeAt = app.indexOf('path="/system-admin/licenses"');
  assert.ok(routeAt > -1 && gateAt > -1);
  assert.ok(routeAt < gateAt, "the admin route must sit above the licence gate");

  // And the gate itself must not dead-end the owner at /license-expired, which
  // is a screen telling them to renew a licence only they can issue.
  assert.match(
    licenseGate,
    /if \(isSystemOwner\) return <Navigate to="\/system-admin\/licenses" replace \/>;/,
    "a locked store must divert the owner to the manager, not to the lockout",
  );
});

test("the identity survives a refresh, because it is re-asked on every boot", () => {
  // `isSystemOwner` is deliberately NOT persisted (see the next test), so it
  // is `false` after every reload unless something re-resolves it. Only
  // `establishSupabaseSession` did — i.e. only on an explicit LOGIN.
  //
  // That left a real hole. A store-less owner sees no `store_licenses` row
  // (RLS: `is_store_member` is false for them everywhere), so
  // `evaluateLicense(null)` returns `unlicensed` and `LicenseGate` bounces
  // anyone without the flag to /license-expired. Pressing F5 therefore
  // reproduced the exact bug the login path had just been fixed to remove:
  // the person whose job is to issue licences, told their licence lapsed.
  assert.match(
    reconcile,
    /rpc\("is_system_owner"\)/,
    "session reconciliation must resolve the global identity too",
  );
  assert.match(
    reconcile,
    /setSystemOwner\(!error && owner === true\)/,
    "and record it the same fail-closed way the login path does",
  );
  // A boot with no session must actively clear it, not leave a stale true.
  const noSession = reconcile.indexOf("if (!data.session)");
  const cleared = reconcile.indexOf("setSystemOwner(false)");
  assert.ok(noSession > -1 && cleared > noSession, "no session means no global identity");
  // And it is asked BEFORE the membership lookup, exactly as on the login path.
  assert.ok(
    reconcile.indexOf('rpc("is_system_owner")') < reconcile.indexOf('from("store_members")'),
    "identity is global, so it is resolved before any store question",
  );
});

test("the flag is never persisted, so it cannot be granted from localStorage", () => {
  // The whole reason it has to be re-asked: a flag in localStorage that
  // decides what the UI unlocks is a flag an attacker edits.
  const partialize = authStore.match(/partialize: \(s\) => \(\{[\s\S]*?\}\),/)[0];
  assert.ok(
    !partialize.includes("isSystemOwner"),
    "persisting it would make System Owner a localStorage edit away",
  );
});

test("resolving the identity on boot does not widen Mobile", () => {
  // Mobile mounts `useSessionReconciliation` too, so this had to be inert
  // there: nothing under src/mobile reads the flag, and MobileSessionGate
  // decides access without it.
  const mobileGate = strip(read("../src/mobile/shell/MobileSessionGate.tsx"));
  assert.ok(!mobileGate.includes("isSystemOwner"), "the mobile gate must not consult it");
  assert.ok(!mobileGate.includes("system-admin"), "mobile has no System Owner surface");
  // …and mobile still refuses a store-less session, which is what keeps a
  // store-less owner out of an empty mobile shell.
  assert.match(
    strip(read("../src/mobile/auth/MobileLogin.tsx")),
    /missingMembership: "reject"/,
    "mobile fails closed on a missing membership",
  );
  assert.ok(
    !strip(read("../src/mobile/auth/MobileLogin.tsx")).includes("systemOwnerNeedsNoStore"),
    "mobile must not opt into the store-less session",
  );
});

test("the owner allowlist is never shipped to the client", () => {
  // The verdict comes from the server precisely so the emails stay server-side
  // and cannot drift from the RPCs they guard.
  assert.match(ownerGate, /checkSystemOwner/, "the gate asks the server");
  for (const src of [ownerGate, authStore, workflow, login, licenseGate]) {
    assert.ok(!/@gmail\.com/.test(src), "no owner email may appear in the bundle");
  }
});

test("the login error union can represent what the workflow returns", () => {
  // `membership_missing` is the code at the centre of this bug, and the store
  // could not hold it — `setError({ code: result.code })` did not type-check.
  for (const code of ["membership_missing", "session_unavailable"]) {
    assert.ok(authStore.includes(`"${code}"`), `AuthError must cover ${code}`);
  }
});

test("the server-side check is store-independent by construction", () => {
  // Asserted against the migration that defines it, because this is the
  // property the whole fix rests on: if `is_system_owner` ever learns about
  // stores, the client decoupling above becomes decoration.
  const sql = read("../docs/migrations/008_license_admin_rpc.sql");
  const start = sql.indexOf("FUNCTION public.is_system_owner");
  assert.ok(start > -1, "the defining migration must contain the function");
  // The body is quoted with $fn$ in this migration.
  const fn = sql.slice(start, sql.indexOf("$fn$;", start) + 5);
  for (const coupling of ["store_members", "has_role", "store_licensed", "store_id"]) {
    assert.ok(!fn.includes(coupling), `is_system_owner must not consult ${coupling}`);
  }
  assert.match(fn, /auth\.users/, "identity comes from the account, not from a tenant");
});
