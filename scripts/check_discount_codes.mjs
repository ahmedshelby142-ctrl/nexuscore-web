/**
 * كود الخصم — eligibility, usage accounting, and the two screens agreeing.
 *
 * `check_discounts.mjs` proves the AMOUNT (`discountAmountFor`). This file
 * proves the part that was missing entirely: whether a code may be used at all,
 * and what the Discounts screen is allowed to say about it.
 *
 * Every test below is a way the old code let something through. نقطة البيع and
 * طلبات المتجر each carried their own copy of:
 *
 *     promoDiscounts.find((x) => x.code === input.trim() && x.active)
 *
 * which is case-sensitive against an upper-cased stored code, ignores
 * `expiryDate`, and ignores `maxUses` — a limit nothing counted against anyway.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyDiscountCode,
  canUseDiscount,
  discountBlock,
  DISCOUNT_BLOCK_MESSAGE,
  findDiscountByCode,
  isExhausted,
  isExpired,
  normalizeCode,
  redemptionsFor,
  remainingUses,
  usageOf,
} from "../src/lib/discounts.ts";

const NOW = new Date("2026-09-13T12:00:00Z");
const day = (n) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

const PERCENT = { id: "p", code: "SAVE10", type: "percentage", value: 10, active: true };
const FIXED = { id: "f", code: "FLAT50", type: "fixed", value: 50, active: true };
const CODES = [PERCENT, FIXED];

// ── the match ───────────────────────────────────────────────────────────────

test("a code typed in any case still finds its row", () => {
  // The stored code is upper-cased by the Discounts screen; the old compare was
  // `x.code === input`, so "save10" simply "did not exist".
  for (const typed of ["SAVE10", "save10", "Save10", "  save10  "]) {
    assert.equal(findDiscountByCode(CODES, typed)?.id, "p", `typed ${JSON.stringify(typed)}`);
  }
  assert.equal(normalizeCode("  save10 "), "SAVE10");
});

test("a blank or unknown code finds nothing", () => {
  assert.equal(findDiscountByCode(CODES, ""), undefined);
  assert.equal(findDiscountByCode(CODES, "   "), undefined);
  assert.equal(findDiscountByCode(CODES, "NOPE"), undefined);
});

test("an inactive or expired code is FOUND, so the operator can be told why", () => {
  // Reporting "does not exist" for a code that is merely expired sends the
  // cashier hunting for a typo that is not there.
  const dead = { ...PERCENT, active: false };
  assert.equal(findDiscountByCode([dead], "SAVE10")?.id, "p");
  assert.equal(discountBlock(dead, NOW), "inactive");
});

// ── the blocks ──────────────────────────────────────────────────────────────

test("every refusal reason is reported, in priority order", () => {
  assert.equal(discountBlock(undefined, NOW), "not_found");
  assert.equal(discountBlock({ ...PERCENT, active: false }, NOW), "inactive");
  assert.equal(discountBlock({ ...PERCENT, expiryDate: day(-1) }, NOW), "expired");
  assert.equal(discountBlock({ ...PERCENT, maxUses: 2, usedCount: 2 }, NOW), "exhausted");
  assert.equal(discountBlock(PERCENT, NOW), null);
  // Inactive beats expired beats exhausted: the operator is told the fact that
  // actually stops them, not whichever check ran first.
  assert.equal(
    discountBlock({ ...PERCENT, active: false, expiryDate: day(-1), maxUses: 1, usedCount: 5 }, NOW),
    "inactive",
  );
});

test("every block has an Arabic message, so the two screens cannot word it differently", () => {
  for (const block of ["not_found", "inactive", "expired", "exhausted"]) {
    assert.equal(typeof DISCOUNT_BLOCK_MESSAGE[block], "string");
    assert.ok(DISCOUNT_BLOCK_MESSAGE[block].length > 0, block);
  }
});

// ── expiry ──────────────────────────────────────────────────────────────────

test("expiry is checked at all — it was ignored entirely", () => {
  assert.equal(isExpired({ ...PERCENT, expiryDate: day(-1) }, NOW), true);
  assert.equal(isExpired({ ...PERCENT, expiryDate: day(1) }, NOW), false);
  assert.equal(canUseDiscount({ ...PERCENT, expiryDate: day(-1) }, NOW), false);
});

test("no expiry, or an unparseable one, never takes a working code away", () => {
  for (const raw of [null, undefined, ""]) {
    assert.equal(isExpired({ ...PERCENT, expiryDate: raw }, NOW), false, String(raw));
  }
  // A junk date is a data problem, not an expiry. Refusing here would remove a
  // valid discount because a column holds nonsense.
  assert.equal(isExpired({ ...PERCENT, expiryDate: "not-a-date" }, NOW), false);
});

test("a Date object works as well as an ISO string", () => {
  assert.equal(isExpired({ ...PERCENT, expiryDate: new Date(day(-1)) }, NOW), true);
});

// ── the usage limit ─────────────────────────────────────────────────────────

test("remaining uses counts down, and an absent limit means unlimited", () => {
  assert.equal(remainingUses({ ...PERCENT, maxUses: 5, usedCount: 0 }), 5);
  assert.equal(remainingUses({ ...PERCENT, maxUses: 5, usedCount: 3 }), 2);
  assert.equal(remainingUses({ ...PERCENT, maxUses: 5, usedCount: 5 }), 0);
  for (const max of [null, undefined, "", 0]) {
    assert.equal(remainingUses({ ...PERCENT, maxUses: max, usedCount: 99 }), null, String(max));
  }
});

test("a counter past its limit reads as zero left, never as a negative", () => {
  // A negative remaining would let one more through.
  assert.equal(remainingUses({ ...PERCENT, maxUses: 5, usedCount: 9 }), 0);
  assert.equal(isExhausted({ ...PERCENT, maxUses: 5, usedCount: 9 }), true);
});

test("the boundary: limit 5 is valid at 4 uses and refused at 5", () => {
  const at = (used) => canUseDiscount({ ...PERCENT, maxUses: 5, usedCount: used }, NOW);
  for (const used of [0, 1, 2, 3, 4]) assert.equal(at(used), true, `used ${used}`);
  assert.equal(at(5), false, "the fifth use consumes the last one");
  assert.equal(at(6), false);
});

test("a one-use code is dead after one use", () => {
  assert.equal(canUseDiscount({ ...PERCENT, maxUses: 1, usedCount: 0 }, NOW), true);
  assert.equal(canUseDiscount({ ...PERCENT, maxUses: 1, usedCount: 1 }, NOW), false);
});

// ── apply: one answer for both screens ──────────────────────────────────────

test("applying a percentage code gives the amount AND the total", () => {
  const r = applyDiscountCode(CODES, "save10", 1000, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.amount, 100);
  assert.equal(r.total, 900, "1000 − 100");
});

test("applying a fixed code gives the flat amount", () => {
  const r = applyDiscountCode(CODES, "FLAT50", 1000, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.amount, 50);
  assert.equal(r.total, 950);
});

test("a fixed code bigger than the basket never pays the customer", () => {
  const r = applyDiscountCode([{ ...FIXED, value: 5000 }], "FLAT50", 1000, NOW);
  assert.equal(r.amount, 1000, "capped at the goods");
  assert.equal(r.total, 0, "never negative");
});

test("a refused code returns the reason and its message, and no amount", () => {
  for (const [code, block] of [
    [{ ...PERCENT, active: false }, "inactive"],
    [{ ...PERCENT, expiryDate: day(-1) }, "expired"],
    [{ ...PERCENT, maxUses: 1, usedCount: 1 }, "exhausted"],
  ]) {
    const r = applyDiscountCode([code], "SAVE10", 1000, NOW);
    assert.equal(r.ok, false, block);
    assert.equal(r.block, block);
    assert.equal(r.message, DISCOUNT_BLOCK_MESSAGE[block]);
    assert.equal(r.amount, undefined, "a refused code grants nothing");
  }
  assert.equal(applyDiscountCode(CODES, "NOPE", 1000, NOW).block, "not_found");
});

test("POS and the order form reach the same answer from the same inputs", () => {
  // The whole point of the shared module: two screens, one rule. Drift is only
  // possible if one of them stops calling this.
  for (const subtotal of [0, 1, 99.99, 1000, 12345.67]) {
    for (const code of [PERCENT, FIXED]) {
      const pos = applyDiscountCode([code], code.code, subtotal, NOW);
      const ecom = applyDiscountCode([code], code.code.toLowerCase(), subtotal, NOW);
      assert.deepEqual(pos, ecom, `subtotal ${subtotal} code ${code.code}`);
    }
  }
});

test("an empty basket discounts nothing rather than dividing by it", () => {
  const r = applyDiscountCode(CODES, "SAVE10", 0, NOW);
  assert.equal(r.amount, 0);
  assert.equal(r.total, 0);
});

// ── what the Discounts screen is allowed to say ─────────────────────────────

test("usage is read off the code row, which only the claim RPC writes", () => {
  const u = usageOf({ ...PERCENT, maxUses: 5, usedCount: 2, totalDiscount: 240 });
  assert.deepEqual(u, { used: 2, limit: 5, remaining: 3, total: 240 });
});

test("an unlimited code reports no limit and no remaining", () => {
  const u = usageOf({ ...PERCENT, usedCount: 7, totalDiscount: 700 });
  assert.equal(u.used, 7);
  assert.equal(u.limit, null);
  assert.equal(u.remaining, null);
  assert.equal(u.total, 700);
});

test("a never-used code reports zeroes, not blanks", () => {
  // The reported bug rendered nothing at all here.
  assert.deepEqual(usageOf(PERCENT), { used: 0, limit: null, remaining: null, total: 0 });
});

test("missing or junk counters never render as NaN", () => {
  const u = usageOf({ ...PERCENT, usedCount: undefined, totalDiscount: "abc" });
  assert.equal(u.used, 0);
  assert.equal(u.total, 0);
});

// ── the audit trail behind the count ────────────────────────────────────────

test("redemptions list the orders and POS sales that carried the code", () => {
  const orders = [
    { orderNumber: "ECO-1", discountCodeId: "p", discountAmount: 100, createdAt: day(-2) },
    { orderNumber: "ECO-2", discountCodeId: "other", discountAmount: 50, createdAt: day(-1) },
  ];
  const pos = [
    { id: "e1", occurredAt: day(-3), payload: { discountCodeId: "p", discountAmount: 40, invoiceNumber: "POS-9" } },
    { id: "e2", occurredAt: day(-1), payload: { discountAmount: 10 } },
  ];
  const rows = redemptionsFor("p", orders, pos);
  assert.equal(rows.length, 2, "only this code's documents");
  assert.deepEqual(rows.map((r) => r.ref), ["ECO-1", "POS-9"], "newest first");
  assert.deepEqual(rows.map((r) => r.channel), ["order", "pos"]);
  assert.equal(rows.reduce((s, r) => s + r.amount, 0), 140);
});

test("a code with no documents lists nothing rather than throwing", () => {
  assert.deepEqual(redemptionsFor("p", [], []), []);
});
