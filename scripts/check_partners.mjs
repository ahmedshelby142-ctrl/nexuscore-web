/**
 * شريك / مساهم — one list, and the advance rule.
 *
 *     node --test scripts/check_partners.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  totalOwnership,
  ownershipFits,
  grossShare,
  netPayable,
  distributionFor,
  canDraw,
} from "../src/lib/partners.ts";

const working = (id, pct) => ({ id, name: id, kind: "working", equityPercentage: pct, status: "active" });
const investor = (id, pct) => ({ id, name: id, kind: "investor", equityPercentage: pct, status: "active" });

test("a shop has ONE hundred per cent, not one per screen", () => {
  // The bug the merge deletes: partners and shareholders were separate lists,
  // each validating its own total, so 100 + 100 = 200% was accepted.
  const people = [working("a", 60), investor("b", 40)];
  assert.equal(totalOwnership(people), 100);
  assert.equal(ownershipFits(people, 1), false, "not one point more");
  assert.equal(ownershipFits([working("a", 60)], 40), true);
});

test("editing a person does not count them against themselves", () => {
  const people = [working("a", 60), investor("b", 30)];
  assert.equal(totalOwnership(people, "a"), 30, "a is excluded while being edited");
  assert.equal(ownershipFits(people, 70, "a"), true, "a can go 60 → 70");
  assert.equal(ownershipFits(people, 71, "a"), false);
});

test("an inactive person frees their share", () => {
  const people = [working("a", 60), { ...investor("b", 40), status: "inactive" }];
  assert.equal(totalOwnership(people), 60);
});

test("profit share is the same arithmetic for both kinds", () => {
  assert.equal(grossShare(25, 10000), 2500);
  assert.equal(
    distributionFor(working("a", 25), 10000, 0).gross,
    distributionFor(investor("b", 25), 10000, 0).gross,
    "a مساهم earns exactly what a شريك with the same % earns",
  );
});

test("a working partner's draws are an ADVANCE, deducted at distribution", () => {
  // 25% of 10,000 = 2,500 gross; they already took 1,000 during the period.
  const row = distributionFor(working("a", 25), 10000, 1000);
  assert.equal(row.gross, 2500);
  assert.equal(row.draws, 1000);
  assert.equal(row.net, 1500, "paying the full 2,500 on top would pay them twice");
});

test("drawing more than the share shows as negative, not hidden at zero", () => {
  const row = distributionFor(working("a", 10), 10000, 1800);
  assert.equal(row.gross, 1000);
  assert.equal(row.net, -800, "they owe the business back — a zero would hide it");
  assert.equal(netPayable(1000, 1800), -800);
});

test("an investor's draws are structurally zero, whatever is passed", () => {
  const row = distributionFor(investor("b", 25), 10000, 999);
  assert.equal(row.draws, 0, "capital-only: there is no draw path to take");
  assert.equal(row.net, 2500);
  assert.equal(canDraw("investor"), false);
  assert.equal(canDraw("working"), true);
});

test("a loss is shared the same way it is earned", () => {
  const row = distributionFor(working("a", 40), -5000, 0);
  assert.equal(row.gross, -2000, "40% of the loss");
});

// ── Removing a part-owner: delete vs archive ───────────────────────────────

import { isPartnerArchived, activePartners, partnerRemovalMode, countDistributionsFor } from "../src/lib/partners.ts";

const archived = (id, pct) => ({ ...working(id, pct), deleted_at: 1_755_000_000_000 });

test("a part-owner with NO history can really be deleted", () => {
  assert.equal(partnerRemovalMode([], 0), "delete");
});

test("any draw or any past distribution means archive, not delete", () => {
  const oneDraw = [{ account: "owner_budget", subjectId: "a", qty: 0, amount: 1500 }];
  assert.equal(partnerRemovalMode(oneDraw, 0), "archive", "a recorded draw is history");
  assert.equal(partnerRemovalMode([], 1), "archive", "so is a past distribution");
  assert.equal(partnerRemovalMode(oneDraw, 3), "archive");
});

test("THE TRAP: draws that net to zero are still history", () => {
  // Drew 1,000 and paid it back: the SUM is 0, the rows exist. Deleting this
  // person would orphan both lines — row COUNT decides, as it does for stock.
  const settled = [{ account: "owner_budget", subjectId: "a", qty: 0, amount: 0 }];
  assert.equal(partnerRemovalMode(settled, 0), "archive");
});

test("archiving frees the percentage and drops the capital claim", () => {
  const before = [working("a", 60), investor("b", 40)];
  assert.equal(totalOwnership(before), 100);
  assert.equal(ownershipFits(before, 10), false, "nothing left to give");

  // b is archived — same list, tombstone set.
  const after = [working("a", 60), archived("b", 40)];
  assert.equal(isPartnerArchived(after[1]), true);
  assert.equal(totalOwnership(after), 60, "their 40% is free again");
  assert.equal(ownershipFits(after, 40), true, "a new person can take exactly it");
  assert.deepEqual(
    activePartners(after).map((p) => p.id),
    ["a"],
    "out of the active list, so out of رأس المال and out of future distributions",
  );
  assert.equal(after.length, 2, "the record still exists — past reports resolve their name");
});

test("a real delete frees the percentage too, and leaves nothing behind", () => {
  const after = [working("a", 60)]; // "b" was hard-deleted
  assert.equal(totalOwnership(after), 60);
  assert.equal(after.length, 1, "no record, because there was no history to keep");
});

test("counting distributions finds the person by id, not by name", () => {
  const ledger = [
    { partnerDistributions: [{ partnerId: "a" }, { partnerId: "b" }] },
    { partnerDistributions: [{ partnerId: "a" }] },
    { partnerDistributions: [] },
  ];
  assert.equal(countDistributionsFor(ledger, "a"), 2);
  assert.equal(countDistributionsFor(ledger, "b"), 1);
  assert.equal(countDistributionsFor(ledger, "never-paid"), 0);
});
