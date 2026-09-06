/**
 * The manager's state machine: four states, and the buttons each one allows.
 *
 *     node --test scripts/check_license_admin.mjs
 *
 * The business model this protects is manual and simple — the customer pays in
 * the real world, the system owner turns the key — so the whole risk is in the
 * owner pressing a button that does something other than what it says. Two
 * failures matter:
 *
 *   * a row showing the wrong state (a suspended shop reading as "expired", so
 *     the owner extends the licence and wonders why the shop is still shut);
 *   * a row offering an action that cannot apply (Reactivate on a licence that
 *     was never suspended), which fails in Postgres and teaches the owner to
 *     distrust the screen.
 *
 * Every one of these RPCs raises for a nonsensical call, so this is not the
 * security boundary. It is the difference between a screen that is usable in
 * seconds and one that has to be learned by trial and error.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { licenseState, actionsFor } from "../src/lib/license/state.ts";

const NOW = Date.parse("2026-09-06T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const row = (over = {}) => ({
  license_key: "NEXUS-PRO-AAAA-BBBB-CCCC-DDDD",
  valid_until: iso(NOW + 90 * DAY),
  status: "active",
  ...over,
});

// ── States ──────────────────────────────────────────────────────────────────

test("a store with no licence row is UNLICENSED", () => {
  assert.equal(licenseState({ license_key: null, valid_until: null, status: null }, NOW), "UNLICENSED");
  // Half a row is still no licence: both halves are needed to say anything.
  assert.equal(licenseState(row({ license_key: null }), NOW), "UNLICENSED");
  assert.equal(licenseState(row({ valid_until: null }), NOW), "UNLICENSED");
});

test("a current licence is ACTIVE", () => {
  assert.equal(licenseState(row(), NOW), "ACTIVE");
});

test("a licence whose date has passed is EXPIRED even while status says active", () => {
  // Nothing writes `status` when a date rolls by, and nothing should — expiry
  // is what the calendar does, the status column is what the owner did. A
  // manager that only read `status` would show a lapsed shop as trading.
  assert.equal(licenseState(row({ valid_until: iso(NOW - DAY) }), NOW), "EXPIRED");
});

test("the boundary: the last moment is still ACTIVE, the moment itself is not", () => {
  const at = iso(NOW);
  assert.equal(licenseState(row({ valid_until: at }), NOW), "EXPIRED");
  assert.equal(licenseState(row({ valid_until: at }), NOW - 1), "ACTIVE");
});

test("a suspended licence is SUSPENDED, whatever the date says", () => {
  // With time left — the ordinary case, a shop switched off mid-period.
  assert.equal(licenseState(row({ status: "suspended" }), NOW), "SUSPENDED");
  // And past its date: still SUSPENDED, because reactivating is what the owner
  // has to undo first. Showing EXPIRED here would offer Extend, which the
  // server refuses on a suspended licence.
  assert.equal(
    licenseState(row({ status: "suspended", valid_until: iso(NOW - 10 * DAY) }), NOW),
    "SUSPENDED",
  );
});

test("an explicitly ended licence is EXPIRED with time left on the clock", () => {
  assert.equal(licenseState(row({ status: "expired" }), NOW), "EXPIRED");
});

// ── Actions ─────────────────────────────────────────────────────────────────

test("each state offers only the actions that apply", () => {
  assert.deepEqual(actionsFor("ACTIVE"), ["extend", "suspend"]);
  assert.deepEqual(actionsFor("EXPIRED"), ["extend", "activate"]);
  assert.deepEqual(actionsFor("SUSPENDED"), ["reactivate"]);
  assert.deepEqual(actionsFor("UNLICENSED"), ["activate"]);
});

test("no state offers a contradictory pair", () => {
  for (const state of ["ACTIVE", "EXPIRED", "SUSPENDED", "UNLICENSED"]) {
    const a = actionsFor(state);
    assert.ok(!(a.includes("suspend") && a.includes("reactivate")), `${state}: both switches`);
    // Suspend belongs to exactly one state: the one that is currently on.
    assert.equal(a.includes("suspend"), state === "ACTIVE", `${state}: suspend`);
    // And reactivate to exactly the one that is off by the owner's hand.
    assert.equal(a.includes("reactivate"), state === "SUSPENDED", `${state}: reactivate`);
  }
});

test("a store with no licence cannot be extended", () => {
  // There is nothing to extend, and the server says so — but the owner should
  // never get that far. Activate is the only thing that makes sense.
  assert.ok(!actionsFor("UNLICENSED").includes("extend"));
});

test("a suspended store is not offered extend", () => {
  // Quietly switching a shop back on because someone reached for the wrong
  // button is the one mistake this screen must not make easy.
  assert.ok(!actionsFor("SUSPENDED").includes("extend"));
  assert.ok(!actionsFor("SUSPENDED").includes("activate"));
});

test("every state offers at least one way forward", () => {
  for (const state of ["ACTIVE", "EXPIRED", "SUSPENDED", "UNLICENSED"]) {
    assert.ok(actionsFor(state).length > 0, `${state} is a dead end`);
  }
});

// ── The screen renders the machine, not its own opinion ─────────────────────

test("the manager screen decides buttons from actionsFor, not from row fields", () => {
  const screen = readFileSync(
    new URL("../src/routes/system-admin-licenses.tsx", import.meta.url),
    "utf8",
  );
  assert.match(screen, /actionsFor\(state\)/, "the row must ask the state machine");
  for (const action of ["extend", "activate", "reactivate", "suspend"]) {
    assert.match(
      screen,
      new RegExp('actions\\.includes\\("' + action + '"\\)'),
      `the ${action} button must be gated on the action list`,
    );
  }
  // The old screen decided by poking at the row directly, which is how Suspend
  // ended up disabled-but-present on a licence that was already off.
  assert.ok(
    !/disabled=\{!r\.license_key/.test(screen),
    "buttons are being enabled/disabled from raw row fields again",
  );
});

test("the manager filters on all four states", () => {
  const screen = readFileSync(
    new URL("../src/routes/system-admin-licenses.tsx", import.meta.url),
    "utf8",
  );
  for (const f of ["active", "expired", "suspended", "unlicensed"]) {
    assert.match(screen, new RegExp('"' + f + '"'), `the filter must offer ${f}`);
  }
});
