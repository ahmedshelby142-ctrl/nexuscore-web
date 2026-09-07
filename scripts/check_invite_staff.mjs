/**
 * Adding a member of staff must stay a server-side decision.
 *
 *     node --test scripts/check_invite_staff.mjs
 *
 * الصلاحيات had no way to add anyone. The gap was not cosmetic: `claim_store`
 * gives an account with NO membership a shop of its own, as ADMIN of it, so an
 * employee who signed up unprompted landed in a separate empty tenant that
 * their employer could not see. The screen told them to do exactly that.
 *
 * The fix — an Edge Function that creates the account and links it — introduces
 * the two failure modes this file exists to prevent from creeping back:
 *
 *   1. **A service key in the browser.** Creating an auth user needs one. A
 *      service key in a Vite bundle is a public key that bypasses every policy
 *      in the database, and `envPrefix` here accepts NEXT_PUBLIC_ too, so the
 *      usual "it isn't VITE_ so it won't ship" reasoning is false.
 *
 *   2. **Authorization decided in TypeScript.** The function runs with a
 *      service key in scope. If it ever took the store id from the request
 *      body, or inserted the membership with the admin client, any signed-in
 *      user could add themselves to any shop as ADMIN. The store id must come
 *      from `staff_invite_context()` (derived from `auth.uid()`), and the
 *      INSERT must go through the caller's own client so RLS re-checks it.
 *
 * The live behaviour behind these assertions was measured on 2026-09-07:
 * unauthenticated → 401, forged JWT → 401, the anon key used as a bearer → 403,
 * a non-ADMIN member → 42501, a real ADMIN writing into another shop → 42501,
 * role 'SYSTEM_OWNER' → refused by the column's CHECK.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const fnSource = read("../supabase/functions/invite-staff/index.ts");
const fn = strip(fnSource);
const migration = read("../docs/migrations/023_staff_invitations.sql");
const store = strip(read("../src/store/useUsersStore.ts"));
const panel = strip(read("../src/components/auth/UserManagementPanel.tsx"));
const roles = read("../src/lib/roles.ts");

test("the service key never leaves the Edge Function", () => {
  const src = new URL("../src/", import.meta.url);
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(new URL(`${e.name}/`, dir))
        : [readFileSync(new URL(e.name, dir), "utf8")],
    );

  for (const file of walk(src)) {
    assert.ok(
      !/service_role|SERVICE_ROLE/.test(file),
      "a service_role key must never be referenced from src/ — it ships to the browser",
    );
  }
  // `.env.example` documents an UNPREFIXED `SUPABASE_SERVICE_ROLE_KEY`, which
  // is right — Edge Functions read it. What must never happen is a public
  // prefix on it: `vite.config.ts` exposes both VITE_ and NEXT_PUBLIC_, so
  // either one would compile the key into the bundle.
  for (const name of ["../.env.example", "../vite.config.ts", "../.env.local"]) {
    let text;
    try {
      text = read(name);
    } catch {
      continue; // .env.local is not in the repo
    }
    assert.ok(
      !/(VITE_|NEXT_PUBLIC_)[A-Z_]*SERVICE_ROLE/i.test(text),
      `${name} must not expose a service_role key under a public prefix`,
    );
  }
});

test("the store is derived from the caller, never taken from the request", () => {
  const body = fn.match(/const body = await req\.json\(\);([\s\S]*?)\n  \}/)[1];
  assert.ok(!/store/i.test(body), "the request body must not carry a store id");

  assert.match(
    fn,
    /storeId\s*=\s*context\?\.store_id/,
    "the store id must come from staff_invite_context(), which reads auth.uid()",
  );
  assert.match(fn, /if \(!storeId\) return reply\(403/);
});

test("the membership INSERT runs as the caller, so RLS re-checks it", () => {
  const insert = fn.match(/\.from\("store_members"\)[\s\S]{0,120}/)[0];
  assert.ok(
    /asCaller[\s\S]*?\.from\("store_members"\)/.test(fn),
    "store_members must be written through the caller's client, not the service client",
  );
  assert.ok(!/admin[\s\S]{0,80}store_members/.test(fn), insert);

  // The service client exists for exactly one call.
  const adminUses = fn.match(/\badmin\.[a-zA-Z.]+/g) ?? [];
  assert.deepEqual(adminUses, ["admin.auth.admin.inviteUserByEmail"]);
});

test("only the four real roles are accepted", () => {
  const declared = [...roles.matchAll(/"(ADMIN|POS_ECOMMERCE|ECOMMERCE_ONLY|ACCOUNTANT)"/g)]
    .map((m) => m[1]);
  const allowed = fn.match(/const ROLES = \[([^\]]+)\]/)[1]
    .match(/"([A-Z_]+)"/g)
    .map((s) => s.replaceAll('"', ""));

  assert.deepEqual([...allowed].sort(), [...new Set(declared)].sort());
  assert.match(fn, /!\(ROLES as readonly string\[\]\)\.includes\(role\)/);
  // Anything else is refused before a single row is touched.
  const guardIndex = fn.indexOf("includes(role)");
  assert.ok(guardIndex > 0 && guardIndex < fn.indexOf("staff_invite_context"));
});

test("a request with no bearer token is refused before anything else", () => {
  const guard = fn.indexOf('authHeader.startsWith("Bearer ")');
  assert.ok(guard > 0);
  assert.ok(guard < fn.indexOf("createClient(url, anonKey"));
  assert.ok(guard < fn.indexOf("createClient(url, serviceKey"));
});

test("the database, not the function, owns the rules", () => {
  // One person, one shop — the assumption `getActiveStoreId()` has always made.
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS store_members_one_store_per_user\s+ON public\.store_members \(user_id\)/,
  );
  // The anon key is a valid JWT, so the platform admits it; this REVOKE is what
  // actually stops it. Measured: anon key as bearer → 403.
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.staff_invite_context\(TEXT\) FROM anon/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.staff_invite_context\(TEXT\) TO authenticated/);
  // Definer functions without a pinned search_path are a privilege ladder.
  assert.match(migration, /SET search_path = public, pg_temp/);
  // It refuses a caller who is not an ADMIN of a store.
  assert.match(migration, /only a store admin may invite staff/);
  // It must not hand an admin the id of somebody in another tenant.
  assert.match(migration, /WHEN v_status IN \('no_account','belongs_elsewhere'\) THEN NULL/);
});

test("the client never claims an invitation that the server did not confirm", () => {
  assert.match(store, /if \(!result\?\.ok\)/);
  // Success re-reads the table rather than optimistically inserting a row.
  assert.match(store, /await get\(\)\.fetchStaffMembers\(\)/);
  assert.ok(
    !/staffMembers: \[\s*\.\.\.state\.staffMembers/.test(store),
    "no optimistic row — a membership on screen but not in the table is the bug this replaced",
  );
  // A non-2xx must surface the function's own Arabic reason, not supabase-js's
  // "Edge Function returned a non-2xx status code".
  assert.match(store, /context instanceof Response/);

  assert.match(panel, /toast\.success\(result\.message\)/);
  const success = panel.indexOf("toast.success");
  assert.ok(panel.lastIndexOf("if (!result.ok)", success) > 0);
});

test("the screen no longer tells staff to sign up on their own", () => {
  // The old copy said an employee signs up and "then appears here". They land
  // in a separate empty shop instead, and cannot be linked afterwards.
  assert.ok(!/بيعمل حساب من شاشة الدخول وبعدين يظهر هنا/.test(panel));
  assert.match(panel, /إضافة موظف/);
});
