/**
 * ميزانية صاحبة العمل — the §1.3 scenario for 7.3.
 *
 *     node --test scripts/check_owner_budget.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOwnerDrawLines,
  budgetStatus,
  periodStart,
  OWNER_SUBJECT,
} from "../src/lib/ledger/ownerDraw.ts";
import { distributionFor } from "../src/lib/partners.ts";

const WALLET = "inStoreSafe";

/** What `SUM(owner_budget)` returns for one subject. */
const drawnBy = (lines, subjectId) =>
  lines
    .filter((l) => l.account === "owner_budget" && l.subjectId === subjectId)
    .reduce((sum, l) => sum + (l.amount ?? 0), 0);
const walletOf = (lines) =>
  lines
    .filter((l) => l.account === "wallet" && l.subjectId === WALLET)
    .reduce((sum, l) => sum + (l.amount ?? 0), 0);

test("a draw takes cash out and records who took it", () => {
  const lines = buildOwnerDrawLines({ subjectId: OWNER_SUBJECT, amount: 4200, wallet: WALLET });

  assert.equal(lines.length, 2, "what was drawn, and the cash that left");
  assert.equal(drawnBy(lines, OWNER_SUBJECT), 4200);
  assert.equal(walletOf(lines), -4200, "the till is lighter — a draw is real money");
});

test("§1.3: a 5000 limit, a 4200 draw, then 900 more", () => {
  const LIMIT = 5000;

  // First draw: 4,200 of 5,000.
  const first = buildOwnerDrawLines({ subjectId: OWNER_SUBJECT, amount: 4200, wallet: WALLET });
  const afterFirst = budgetStatus(LIMIT, drawnBy(first, OWNER_SUBJECT));
  assert.equal(afterFirst.spent, 4200);
  assert.equal(afterFirst.remaining, 800);
  assert.equal(Math.round(afterFirst.percent), 84);
  assert.equal(afterFirst.level, "warn", "84% → amber: على وشك الانتهاء");

  // Second draw: 900 more, which goes past the ceiling.
  const both = [
    ...first,
    ...buildOwnerDrawLines({ subjectId: OWNER_SUBJECT, amount: 900, wallet: WALLET }),
  ];
  const afterSecond = budgetStatus(LIMIT, drawnBy(both, OWNER_SUBJECT));
  assert.equal(afterSecond.spent, 5100);
  assert.equal(afterSecond.remaining, -100, "over-limit shows as negative, not floored at zero");
  assert.equal(afterSecond.level, "over", "100%+ → red: انتهت الميزانية");

  // And the draw was still RECORDED: warning, never blocking.
  assert.equal(drawnBy(both, OWNER_SUBJECT), 5100);
  assert.equal(walletOf(both), -5100, "the money really left, so the ledger says so");
});

test("the alert thresholds sit exactly where they are described", () => {
  assert.equal(budgetStatus(1000, 799).level, "ok");
  assert.equal(budgetStatus(1000, 800).level, "warn", "80% is already a warning");
  assert.equal(budgetStatus(1000, 999).level, "warn");
  assert.equal(budgetStatus(1000, 1000).level, "over", "exactly the limit is spent, not safe");
  assert.equal(budgetStatus(0, 0).level, "ok", "no limit set yet is not an alarm");
});

test("a monthly period is the calendar month, from the DATE", () => {
  const now = new Date("2026-08-18T15:30:00");
  const start = periodStart({ limit: 5000, periodType: "monthly", startedAt: 0 }, now);
  assert.equal(start.getDate(), 1);
  assert.equal(start.getMonth(), 7, "August");
  assert.equal(start.getHours(), 0);

  // The month rolls over on its own, even if the app was closed for weeks.
  const next = periodStart({ limit: 5000, periodType: "monthly", startedAt: 0 }, new Date("2026-09-02T09:00:00"));
  assert.equal(next.getMonth(), 8, "September — no stored counter to go stale");
});

test("an open period runs from the last reset, and a reset starts a new one", () => {
  const opened = new Date("2026-08-10T12:00:00").getTime();
  const budget = { limit: 5000, periodType: "open", startedAt: opened };
  assert.equal(periodStart(budget).getTime(), opened);

  // «تصفير الميزانية» moves the start; past draws stay in the ledger but fall
  // outside the new window.
  const reset = new Date("2026-08-18T12:00:00").getTime();
  assert.equal(periodStart({ ...budget, startedAt: reset }).getTime(), reset);
});

test("a partner's advance does NOT eat the owner's budget", () => {
  // Both are `owner_draw` events; the SUBJECT is what separates them.
  const lines = [
    ...buildOwnerDrawLines({ subjectId: OWNER_SUBJECT, amount: 1000, wallet: WALLET }),
    ...buildOwnerDrawLines({ subjectId: "partner-a", amount: 1500, wallet: WALLET }),
  ];

  assert.equal(drawnBy(lines, OWNER_SUBJECT), 1000, "the owner's budget sees only her own draws");
  assert.equal(drawnBy(lines, "partner-a"), 1500);
  assert.equal(budgetStatus(5000, drawnBy(lines, OWNER_SUBJECT)).spent, 1000);

  // And 7.2's rule reads the same line for the partner: an advance on a share.
  const row = distributionFor(
    { id: "partner-a", name: "شريك", kind: "working", equityPercentage: 25 },
    10000,
    drawnBy(lines, "partner-a"),
  );
  assert.equal(row.gross, 2500);
  assert.equal(row.net, 1000, "2500 share − 1500 already taken");
});

test("nonsense draws are refused, not booked", () => {
  assert.throws(() => buildOwnerDrawLines({ subjectId: OWNER_SUBJECT, amount: 0, wallet: WALLET }), /positive/);
  assert.throws(() => buildOwnerDrawLines({ subjectId: OWNER_SUBJECT, amount: -5, wallet: WALLET }), /positive/);
  assert.throws(() => buildOwnerDrawLines({ subjectId: "", amount: 5, wallet: WALLET }), /who/);
  assert.throws(() => buildOwnerDrawLines({ subjectId: OWNER_SUBJECT, amount: 5, wallet: "" }), /wallet/);
});

// ── Editable ceiling, and categories inside the SAME budget ────────────────

import {
  ownerSubjectFor,
  isOwnerSubject,
  categoryOfSubject,
  ownerSpent,
  drawBreakdown,
} from "../src/lib/ledger/ownerDraw.ts";

test("a category rides in the SUBJECT, so the split is summed from lines", () => {
  // Not from payload: payload is descriptive and may not be summed, so a
  // category kept only there could drift from the money.
  assert.equal(ownerSubjectFor("أكل"), "owner#أكل");
  assert.equal(ownerSubjectFor(""), OWNER_SUBJECT, "no category → the plain subject");
  assert.equal(ownerSubjectFor("  "), OWNER_SUBJECT, "whitespace is not a category");
  assert.equal(ownerSubjectFor(null), OWNER_SUBJECT);

  assert.equal(categoryOfSubject("owner#أكل"), "أكل");
  assert.equal(categoryOfSubject(OWNER_SUBJECT), null, "uncategorised, not a category named ''");
});

test("categorised and uncategorised draws are ONE ceiling", () => {
  const lines = [
    ...buildOwnerDrawLines({ subjectId: ownerSubjectFor("أكل"), amount: 800, wallet: WALLET }),
    ...buildOwnerDrawLines({ subjectId: ownerSubjectFor("مشاوير"), amount: 300, wallet: WALLET }),
    ...buildOwnerDrawLines({ subjectId: ownerSubjectFor(), amount: 4000, wallet: WALLET }),
  ];
  // What `balances({ account: "owner_budget" })` hands back, per subject.
  const rows = [
    { subjectId: "owner#أكل", amount: 800 },
    { subjectId: "owner#مشاوير", amount: 300 },
    { subjectId: "owner", amount: 4000 },
  ];

  assert.equal(ownerSpent(rows), 5100, "one total: 800 + 300 + 4000");
  assert.equal(budgetStatus(5000, ownerSpent(rows)).level, "over", "the same ceiling as before");
  assert.equal(
    lines.filter((l) => l.account === "wallet").reduce((s, l) => s + l.amount, 0),
    -5100,
    "and the till carries all of it out",
  );
});

test("the breakdown groups the same rows the ceiling counted, biggest first", () => {
  const rows = [
    { subjectId: "owner#أكل", amount: 800 },
    { subjectId: "owner", amount: 4000 },
    { subjectId: "owner#مشاوير", amount: 300 },
    { subjectId: "partner-a", amount: 1500 },
  ];
  const split = drawBreakdown(rows);

  assert.deepEqual(split, [
    { category: null, amount: 4000 },
    { category: "أكل", amount: 800 },
    { category: "مشاوير", amount: 300 },
  ]);
  assert.equal(
    split.reduce((s, r) => s + r.amount, 0),
    ownerSpent(rows),
    "the split always adds up to the ceiling's spent — same rows, grouped",
  );
  assert.equal(
    split.some((r) => r.category === "partner-a"),
    false,
    "a partner's advance is not one of her categories",
  );
});

test("a partner subject is never mistaken for the owner's", () => {
  assert.equal(isOwnerSubject("owner"), true);
  assert.equal(isOwnerSubject("owner#أكل"), true);
  assert.equal(isOwnerSubject("partner-a"), false);
  assert.equal(isOwnerSubject("ownership-thing"), false, "prefix match must be exact + '#'");
});

test("changing the limit re-reads against the SAME spending", () => {
  // Editing the ceiling is reference data: past draws are untouched, only the
  // verdict changes.
  const spent = 4200;
  assert.equal(budgetStatus(5000, spent).level, "warn");
  assert.equal(budgetStatus(4000, spent).level, "over", "lowering it can put her over at once");
  assert.equal(budgetStatus(4000, spent).remaining, -200);
  assert.equal(budgetStatus(9000, spent).level, "ok", "raising it clears the alert");
  assert.equal(budgetStatus(9000, spent).spent, 4200, "the draws themselves never move");
});
