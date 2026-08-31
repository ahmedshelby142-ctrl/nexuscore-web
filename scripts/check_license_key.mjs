/**
 * Licence-key generation and the expiry-date arithmetic behind the manager.
 *
 *     node --test scripts/check_license_key.mjs
 *
 * Both are the kind of code that looks finished and is silently wrong: a key
 * generator that repeats, or a date helper that hands every customer east of
 * UTC a licence one day short.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  generateLicenseKey,
  toDateInput,
  plusMonths,
  endOfDayIso,
} from "../src/lib/license/key.ts";

test("key looks like NEXUS-<PLAN>-XXXX-XXXX-XXXX-XXXX", () => {
  assert.match(generateLicenseKey("PRO"), /^NEXUS-PRO(-[A-Z2-9]{4}){4}$/);
  assert.match(generateLicenseKey("BASIC"), /^NEXUS-BASIC(-[A-Z2-9]{4}){4}$/);
});

test("the alphabet excludes the characters people misread", () => {
  // I/1 and O/0 down a phone line are the classic support call.
  const body = generateLicenseKey("PRO").split("-").slice(2).join("");
  assert.doesNotMatch(body, /[IO01]/);
});

test("keys do not repeat across a large batch", () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(generateLicenseKey("PRO"));
  assert.equal(seen.size, 5000, "a collision in 5000 draws means the entropy is broken");
});

test("every symbol of the alphabet is reachable", () => {
  // Catches an off-by-one in the modulo that would quietly shrink the keyspace.
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    for (const ch of generateLicenseKey("PRO").split("-").slice(2).join("")) seen.add(ch);
  }
  assert.equal(seen.size, 32, `expected all 32 symbols, saw ${seen.size}`);
});

test("the generator draws from the injected source, not a hidden one", () => {
  // Proves the randomness is really coming from getRandomValues and the mapping
  // is index-stable: 0 → first symbol of the alphabet.
  const zeros = (n) => new Uint32Array(n);
  assert.equal(generateLicenseKey("PRO", zeros), "NEXUS-PRO-AAAA-AAAA-AAAA-AAAA");
});

test("toDateInput uses the LOCAL day, not the UTC day", () => {
  // The bug this guards: `.toISOString().slice(0,10)` on a local-midnight Date
  // returns YESTERDAY for any timezone ahead of UTC.
  const localMidnight = new Date(2026, 7, 30, 0, 30, 0); // 30 Aug 2026, 00:30 local
  assert.equal(toDateInput(localMidnight), "2026-08-30");

  const localLate = new Date(2026, 7, 30, 23, 45, 0); // 23:45 local
  assert.equal(toDateInput(localLate), "2026-08-30");
});

test("plusMonths lands on the same day-of-month", () => {
  const from = new Date(2026, 7, 30, 12, 0, 0); // 30 Aug 2026
  assert.equal(plusMonths(12, from), "2027-08-30");
  assert.equal(plusMonths(1, from), "2026-09-30");
  assert.equal(plusMonths(3, from), "2026-11-30");
});

test("plusMonths clamps instead of overflowing into the next month", () => {
  // 30 Aug + 6 months is 30 February. Unclamped, JS rolls that to 2 March and
  // the "6 شهور" button produces a date in the wrong month.
  assert.equal(plusMonths(6, new Date(2026, 7, 30, 12, 0, 0)), "2027-02-28");
  // Leap year: February really does have a 29th.
  assert.equal(plusMonths(1, new Date(2028, 0, 31, 12, 0, 0)), "2028-02-29");
  // 31 Jan + 1 month in a common year.
  assert.equal(plusMonths(1, new Date(2026, 0, 31, 12, 0, 0)), "2026-02-28");
  // A 31-day month into a 30-day one.
  assert.equal(plusMonths(1, new Date(2026, 4, 31, 12, 0, 0)), "2026-06-30");
});

test("endOfDayIso gives the shop the whole final day", () => {
  // "valid until the 30th" must still be valid at 6pm on the 30th.
  const iso = endOfDayIso("2026-08-30");
  assert.ok(iso);
  const sixPmOn30th = new Date(2026, 7, 30, 18, 0, 0).getTime();
  assert.ok(Date.parse(iso) > sixPmOn30th, "licence expired before the day was over");

  // …and not into the next day.
  const oneAmOn31st = new Date(2026, 7, 31, 1, 0, 0).getTime();
  assert.ok(Date.parse(iso) < oneAmOn31st);
});

test("endOfDayIso rejects junk instead of producing an Invalid Date", () => {
  assert.equal(endOfDayIso("not-a-date"), null);
  assert.equal(endOfDayIso(""), null);
});
