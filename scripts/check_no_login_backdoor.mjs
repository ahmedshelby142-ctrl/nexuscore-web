/**
 * There is exactly one way into this app: Supabase Auth.
 *
 *     node --test scripts/check_no_login_backdoor.mjs
 *
 * Two bypasses have been removed from the login path, and this guards both
 * from coming back. They are worth stating plainly, because the second one
 * looked like a legitimate offline mode.
 *
 * 1. The login SCREEN once accepted a hardcoded `owner` / `owner` and set an
 *    admin session without asking anything. On a public URL that is not a
 *    developer convenience: it is an unauthenticated admin login compiled into
 *    a bundle any visitor can read.
 *
 * 2. `authServer.login` then kept the same account one layer down.
 *    `ensureBootstrapped()` seeded an in-memory table with `owner` / `owner`,
 *    role "owner", reached whenever `getSupabaseClient()` returned null.
 *
 *    The condition was not two conditions. `getOperationMode()` returns
 *    "offline_local" for exactly one reason — the Supabase env vars are absent
 *    — and that is the SAME fact that makes the client null. So "we are in
 *    offline mode" and "the seeded owner is live" were one state: any build
 *    served without those variables (a preview deployment, a fork, a mistyped
 *    name in the Vercel dashboard) accepted owner/owner and returned a full
 *    owner session.
 *
 * Nothing replaced it. Every read in the app goes through `cloudList`, which
 * throws `CloudUnavailable` with no client, so an offline login unlocks a UI
 * with no data behind it. The screen now says the deployment is missing its
 * configuration and refuses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const authServer = read("../src/lib/api/authServer.ts");
const login = read("../src/pages/Login.tsx");

/** Comments stripped: both files EXPLAIN the removed bypass by name. */
const code = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");

test("no account is seeded when the cloud is unconfigured", () => {
  const src = code(authServer);
  assert.ok(
    !/ensureBootstrapped/.test(src),
    "the seeding routine is back — an unconfigured build would accept its account",
  );
  assert.ok(
    !/hashPassword\(\s*["']owner["']\s*\)/.test(src),
    "an owner password is being minted from a literal",
  );
  assert.ok(
    !/inMemoryUsers\.push\(/.test(src.slice(0, src.indexOf("export const createUser"))),
    "something fills the in-memory user table before any authenticated caller could",
  );
});

test("the login screen refuses instead of authenticating offline", () => {
  const src = code(login);
  assert.ok(
    !/serverLogin/.test(src),
    "the screen calls the local username/password login again",
  );
  assert.match(
    src,
    /opMode === "offline_local"[\s\S]{0,400}?return;/,
    "the offline_local branch must return without setting a session",
  );
  const branch = src.slice(
    src.indexOf('opMode === "offline_local"'),
    src.indexOf("const sb = getSupabaseClient();"),
  );
  assert.ok(
    !/setSession\(/.test(branch),
    "a session is being created on a build that has no cloud to check it against",
  );
});

test("the only credential check left is Supabase Auth", () => {
  const src = code(login);
  assert.match(src, /auth\.signInWithPassword/, "the real login must still be there");
  assert.ok(
    !/password\s*===|username\s*===\s*["']owner["']/.test(src),
    "credentials are being compared against a literal in the client",
  );
});
