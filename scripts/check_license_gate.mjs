/**
 * The licence verdict — the one piece of logic that can shut a shop down.
 *
 *     node --test scripts/check_license_gate.mjs
 *
 * Every branch here has a cost when it is wrong in either direction: fail open
 * and the protection is decorative, fail closed and a paying shop cannot sell.
 * The boundary case (the exact millisecond of expiry) and the offline
 * clock-rollback case are the two that a hand test would never catch.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateLicense,
  isUsable,
  renewalWarning,
} from "../src/lib/license/evaluate.ts";

const NOW = Date.parse("2026-08-30T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

const active = (validUntil, status = "active") => ({
  license_key: "NX-PRO-0001",
  plan_type: "PRO",
  valid_until: validUntil,
  status,
});

test("a licence valid for another month lets the shop trade", () => {
  const d = evaluateLicense(active(iso(NOW + 30 * DAY)), NOW);
  assert.equal(d.verdict, "ok");
  assert.equal(isUsable(d.verdict), true);
  assert.equal(d.daysLeft, 30);
});

test("a licence past its date locks the shop", () => {
  const d = evaluateLicense(active(iso(NOW - DAY)), NOW);
  assert.equal(d.verdict, "expired");
  assert.equal(isUsable(d.verdict), false);
});

test("the exact millisecond of expiry is already expired", () => {
  // `>=`, not `>`. An off-by-one here hands out a free day on every licence.
  const at = iso(NOW);
  assert.equal(evaluateLicense(active(at), NOW).verdict, "expired");
  assert.equal(evaluateLicense(active(at), NOW - 1).verdict, "ok");
});

test("an explicitly revoked licence is dead even with time left on the clock", () => {
  // This is how a licence is killed early — non-payment, or a handover dispute.
  const d = evaluateLicense(active(iso(NOW + 300 * DAY), "expired"), NOW);
  assert.equal(d.verdict, "expired");
});

test("no licence row at all is 'unlicensed', not 'ok'", () => {
  for (const empty of [null, undefined]) {
    const d = evaluateLicense(empty, NOW);
    assert.equal(d.verdict, "unlicensed");
    assert.equal(isUsable(d.verdict), false);
  }
});

test("a licence whose date cannot be read is never honoured", () => {
  const d = evaluateLicense(active("not-a-date"), NOW);
  assert.equal(isUsable(d.verdict), false);
  assert.equal(d.verdict, "unverified");
});

test("offline, a rolled-back clock cannot revive an expiring licence", () => {
  // The attack: set the machine clock back a year, stay offline, keep selling.
  const row = active(iso(NOW + DAY));
  const cachedAndTampered = evaluateLicense(row, NOW, {
    fromCache: true,
    clockRolledBack: true,
  });
  assert.equal(isUsable(cachedAndTampered.verdict), false);

  // But the same row judged from a FRESH server read is fine: the row arrived
  // this second, so the local clock bought nothing.
  assert.equal(evaluateLicense(row, NOW, { clockRolledBack: true }).verdict, "ok");
});

test("a rolled-back clock alone does not lock a shop that is merely offline", () => {
  // Clock fine, offline, licence good → still trading. Locking here would brick
  // a shop for a network outage.
  const d = evaluateLicense(active(iso(NOW + 10 * DAY)), NOW, { fromCache: true });
  assert.equal(d.verdict, "ok");
});

test("renewal warning appears in the last two weeks and not before", () => {
  const at = (days) => evaluateLicense(active(iso(NOW + days * DAY)), NOW);
  assert.equal(renewalWarning(at(30)), null);
  assert.equal(renewalWarning(at(20)), null);
  assert.match(renewalWarning(at(10)), /10/);
  assert.match(renewalWarning(at(1)), /غداً/);
  // Once expired the lockout screen speaks for itself.
  assert.equal(renewalWarning(at(-5)), null);
});

test("every non-ok verdict carries Arabic copy for the lockout screen", () => {
  const cases = [
    evaluateLicense(null, NOW),
    evaluateLicense(active(iso(NOW - DAY)), NOW),
    evaluateLicense(active("bad"), NOW),
  ];
  for (const d of cases) {
    assert.ok(d.messageAr.length > 0, "message must not be empty");
    // Arabic range — guards against an English string sneaking into the UI.
    assert.match(d.messageAr, /[\u0600-\u06FF]/);
  }
});
