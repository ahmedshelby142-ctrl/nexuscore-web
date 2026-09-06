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
import { readFileSync } from "node:fs";

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

// ── The four states are four states ─────────────────────────────────────────
//
// UNLICENSED / ACTIVE / EXPIRED / SUSPENDED used to collapse into two answers:
// an owner-suspended shop and a lapsed one both came back as `expired`, and a
// shop that had never been licensed at all got the same word. Each one needs a
// different sentence and a different next step from the person reading it —
// renew, phone the administrator, or wait for activation.

test("a suspended licence is suspended, not expired", () => {
  // The date is still 300 days out. Nothing has expired; the owner switched it
  // off. Calling that "expired" sends the customer looking for a renewal
  // button when what they need is a phone call.
  const d = evaluateLicense(active(iso(NOW + 300 * DAY), "suspended"), NOW);
  assert.equal(d.verdict, "suspended");
  assert.equal(isUsable(d.verdict), false);
});

test("a suspension outranks the date in both directions", () => {
  // Suspended and already past its date is still SUSPENDED: reactivating is
  // what the owner has to undo first, and the screen must say so.
  const past = evaluateLicense(active(iso(NOW - 10 * DAY), "suspended"), NOW);
  assert.equal(past.verdict, "suspended");
  // And a suspension is not lifted by the clock running on.
  const future = evaluateLicense(active(iso(NOW + DAY), "suspended"), NOW);
  assert.equal(future.verdict, "suspended");
});

test("a status this build has never heard of locks the shop", () => {
  // The database can be migrated ahead of the bundle reading it. A status like
  // 'frozen' must not fall through to the date check and open the shop —
  // that is a protection system failing open, which is not a protection
  // system. It reports `unverified`, because the fault is ours, not theirs.
  const d = evaluateLicense(active(iso(NOW + 300 * DAY), "frozen"), NOW);
  assert.equal(d.verdict, "unverified");
  assert.equal(isUsable(d.verdict), false);
});

test("the four lockout verdicts each say something different", () => {
  const said = new Map();
  for (const [name, d] of [
    ["unlicensed", evaluateLicense(null, NOW)],
    ["expired", evaluateLicense(active(iso(NOW - DAY)), NOW)],
    ["suspended", evaluateLicense(active(iso(NOW + DAY), "suspended"), NOW)],
    ["unverified", evaluateLicense(active("bad"), NOW)],
  ]) {
    assert.equal(d.verdict, name);
    assert.ok(!said.has(d.messageAr), `"${d.messageAr}" is used for more than one verdict`);
    said.set(d.messageAr, name);
  }
});

test("the lockout screen sends a licensed shop back, below every hook", () => {
  // Two separate things, both learned the hard way.
  //
  // 1. This screen lives OUTSIDE `LicenseGate`, so nothing else re-checks
  //    whether the lockout still applies once it has rendered. A shop
  //    reactivated while the screen is open — or redirected here on one frame
  //    of a stale cache — was left reading a lockout that no longer applied,
  //    with no way back but a button.
  //
  // 2. The early return has to sit BELOW every hook. Written above them, it
  //    skipped `useState`/`useEffect` on exactly the render where the verdict
  //    came back good, and React threw #300 ("rendered fewer hooks than
  //    expected"). The screen went blank in the one case it exists to handle.
  const src = readFileSync(new URL("../src/pages/LicenseExpired.tsx", import.meta.url), "utf8");

  assert.match(src, /isUsable\(decision\.verdict\)/, "the screen must notice a good verdict");
  assert.match(src, /<Navigate to="\/" replace \/>/, "and send the shop back to the app");

  const body = src.slice(src.indexOf("export function LicenseExpired"));
  const guardAt = body.indexOf("if (resolved &&");
  assert.ok(guardAt > 0, "the early return must exist");
  const lastHookAt = Math.max(
    body.lastIndexOf("useState("),
    body.lastIndexOf("useEffect("),
    body.lastIndexOf("useStoreLicense("),
    body.lastIndexOf("useNavigate("),
    body.lastIndexOf("useAuthStore("),
  );
  assert.ok(
    guardAt > lastHookAt,
    "the early return sits above a hook — React will throw #300 on the render that takes it",
  );
});

test("the lockout screen has copy for each of the four, not a nested ternary", () => {
  // Source-level: the verdicts were right in this module long before the
  // SCREEN told them apart. It collapsed them into `unverified ? … : unlicensed
  // ? … : "expired"`, so every brand-new signup — `claim_store` creates a store
  // with no licence row — was told its licence had run out.
  const page = readFileSync(new URL("../src/pages/LicenseExpired.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");

  for (const verdict of ["unlicensed", "suspended", "expired", "unverified"]) {
    assert.match(
      page,
      new RegExp(verdict + ":\\s*\\{"),
      `the copy table must have an entry for "${verdict}"`,
    );
  }

  // The expiry wording must be reachable under the `expired` key and no other.
  const at = page.indexOf("انتهت صلاحية الترخيص");
  assert.ok(at > 0, "the expiry wording should still exist for a real expiry");
  const keys = [...page.slice(0, at).matchAll(/(unlicensed|suspended|expired|unverified|ok):\s*\{/g)];
  assert.equal(
    keys[keys.length - 1]?.[1],
    "expired",
    "the expiry wording sits under a verdict that is not `expired`",
  );

  assert.ok(
    !/unverified\s*\?[\s\S]{0,200}unlicensed\s*\?/.test(page),
    "the verdicts are being chosen by a nested ternary again",
  );
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
