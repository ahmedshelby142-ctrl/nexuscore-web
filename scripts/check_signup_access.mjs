/**
 * A stranger may sign up. A stranger may not use the ERP.
 *
 *     node --test scripts/check_signup_access.mjs
 *
 * NEXUS CORE is sold by hand: the System Owner activates a licence after the
 * customer is approved and has paid. Public signup therefore has to create a
 * real account and a real store that owns nothing it can do — and stay that way
 * until one specific person says otherwise.
 *
 * ## What was actually wrong
 *
 * The client half already worked: `TRIAL_DAYS = 0` means `claim_store` writes
 * no licence row, `evaluateLicense(null)` returns `unlicensed`, and
 * `LicenseGate` sends every business route to the lockout screen.
 *
 * The database half did not exist. Measured on 8 September 2026 as the ADMIN of
 * a store with its licence row removed: `create product` ALLOWED, `create
 * order` ALLOWED. RLS never looked at `store_licenses`. The lock was a routing
 * decision inside a bundle the customer controls, so anyone willing to send
 * their own PostgREST requests — with their own legitimate token — had a
 * working ERP without being approved by anyone.
 *
 * Migration 024 puts the check where it cannot be edited by the client. These
 * tests hold both halves in place.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateLicense, isUsable } from "../src/lib/license/evaluate.ts";
import { licenseState, actionsFor } from "../src/lib/license/state.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const m024 = read("../docs/migrations/024_license_required_to_write.sql");
const m019 = read("../docs/migrations/019_claim_store_onboarding.sql");
const gate = read("../src/components/auth/LicenseGate.tsx");
const app = read("../src/App.tsx");
const lockout = read("../src/pages/LicenseExpired.tsx");

test("a brand-new store has no licence, and no licence means locked", () => {
  // claim_store writes a row only when TRIAL_DAYS > 0, and it is 0.
  assert.match(m019, /TRIAL_DAYS CONSTANT INT := 0;/);
  assert.match(m019, /IF TRIAL_DAYS > 0 THEN/);

  const d = evaluateLicense(null, Date.now());
  assert.equal(d.verdict, "unlicensed");
  assert.equal(isUsable(d.verdict), false);
});

test("only an active, in-date licence opens the app", () => {
  for (const v of ["expired", "suspended", "unlicensed", "unverified"]) {
    assert.equal(isUsable(v), false, `${v} must not open the app`);
  }
  assert.equal(isUsable("ok"), true);
});

test("the owner sees a store with no licence row as UNLICENSED, with Activate", () => {
  // admin_list_stores LEFT JOINs store_licenses, so a brand-new store arrives
  // with nulls. No second state machine is needed to show an approval queue.
  const state = licenseState({ license_key: null, valid_until: null, status: null });
  assert.equal(state, "UNLICENSED");
  assert.deepEqual(actionsFor("UNLICENSED"), ["activate"]);
  // And the other transitions still exist.
  assert.deepEqual(actionsFor("ACTIVE"), ["extend", "suspend"]);
  assert.deepEqual(actionsFor("SUSPENDED"), ["reactivate"]);
  assert.deepEqual(actionsFor("EXPIRED"), ["extend", "activate"]);
});

test("the database, not the bundle, refuses the writes", () => {
  // The predicate: status AND date, matching licenseState() on the client.
  assert.match(m024, /CREATE OR REPLACE FUNCTION public\.store_licensed\(p_store_id uuid\)/);
  assert.match(m024, /l\.status = 'active'/);
  assert.match(m024, /l\.valid_until > now\(\)/);
  assert.match(m024, /SECURITY DEFINER/);
  assert.match(m024, /SET search_path = public, pg_temp/);
  assert.match(m024, /REVOKE ALL ON FUNCTION public\.store_licensed\(uuid\) FROM anon/);

  // Every business write funnels through has_role, so the licence goes there.
  assert.match(
    m024,
    /SELECT public\.member_role\(p_store_id\) = ANY\(p_roles\)\s*\n\s*AND public\.store_licensed\(p_store_id\)/,
  );

  // The two writes that are keyed on membership instead.
  assert.match(m024, /CREATE POLICY update_products[\s\S]*?store_licensed\(store_id\)/);
  assert.match(m024, /CREATE POLICY insert_ledger_lines[\s\S]*?store_licensed\(store_id\)/);
});

test("reads stay open, so an expired shop is not told it was never activated", () => {
  // `select_store_licenses` is USING (is_store_member(store_id)). If membership
  // required a licence, a suspended or expired store could not read the row
  // that says so, and the lockout screen would collapse two states into one —
  // the exact bug evaluate.ts was written to prevent.
  assert.ok(
    !/CREATE OR REPLACE FUNCTION public\.is_store_member/.test(m024),
    "is_store_member must keep its original meaning",
  );
  assert.match(m024, /READS ARE DELIBERATELY LEFT ALONE/);
});

test("the lockout screen says pending activation, not expired", () => {
  assert.match(lockout, /unlicensed: \{[\s\S]*?المتجر لسه متفعّلش/);
  assert.match(lockout, /الحساب والمتجر اتعملوا بنجاح/);
  // Four separate messages, so a new signup is never told its licence expired.
  for (const v of ["unlicensed", "suspended", "expired", "unverified"]) {
    assert.match(lockout, new RegExp(`${v}: \{`), `${v} needs its own copy`);
  }
  assert.match(lockout, /تسجيل الخروج/, "the customer must be able to log out");
});

test("activation lets them in without a support call", () => {
  // The screen polls, and leaves the moment the verdict turns usable.
  assert.match(lockout, /setInterval\(\(\) => void refresh\(\), 60_000\)/);
  assert.match(lockout, /if \(resolved && \(!decision \|\| isUsable\(decision\.verdict\)\)\) \{/);
  assert.match(lockout, /<Navigate to="\/" replace \/>/);
});

test("the gate blocks by routing, and holds the UI until it knows", () => {
  assert.match(gate, /if \(decision && !isUsable\(decision\.verdict\)\)/);
  assert.match(gate, /<Navigate to="\/license-expired" replace \/>/);
  assert.match(gate, /if \(!resolved\)/, "must not render business screens before the verdict");
});

test("the System Owner is never blocked by a store licence", () => {
  const ownerRoute = app.indexOf('path="/system-admin/licenses"');
  const gateOpen = app.indexOf("<LicenseGate />");
  const lockoutRoute = app.indexOf('path="/license-expired"');
  assert.ok(ownerRoute > 0 && gateOpen > 0);
  assert.ok(ownerRoute < gateOpen, "the owner screen must sit outside LicenseGate");
  assert.ok(lockoutRoute < gateOpen, "the lockout route must sit outside LicenseGate too");
});
