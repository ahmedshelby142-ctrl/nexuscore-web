/**
 * Which order action is legal in which status.
 *
 *     node --test scripts/check_order_lifecycle.mjs
 *
 * Hand-testing found the row actions offering physically impossible things: a
 * PENDING order could be marked returned (taking back goods that never left the
 * shop) and could be marked delivered with a wallet chosen (booking revenue,
 * COGS and COD for a delivery that had not happened). The actions were rendered
 * unconditionally and merely `disabled` for one or two statuses.
 *
 * These assertions are mostly NEGATIVE on purpose. The bug was never "a legal
 * action is missing" — it was "an illegal action is offered", and only a test
 * that says "this must NOT be available" can catch that coming back.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { actionsFor, canDo } from "../src/lib/orderLifecycle.ts";

const ALL_STATUSES = ["pending", "shipped", "delivered", "returned", "cancelled"];
const ALL_ACTIONS = ["ship", "deliver", "settle", "return", "confirmReturn", "edit", "cancel"];

// ── The reported bugs, as regression assertions ─────────────────────────────

test("a PENDING order can NOT be returned — nothing has left the shop", () => {
  assert.equal(canDo("pending", "return"), false);
  assert.ok(!actionsFor("pending").includes("return"));
});

test("a PENDING order can NOT be delivered — the courier has not had it yet", () => {
  assert.equal(canDo("pending", "deliver"), false);
  assert.equal(canDo("pending", "settle"), false);
});

test("shipping is offered ONLY from pending", () => {
  // It used to appear on delivered, returned and cancelled rows too, because it
  // was disabled for `shipped` alone.
  assert.equal(canDo("pending", "ship"), true);
  for (const status of ["shipped", "delivered", "returned", "cancelled"]) {
    assert.equal(canDo(status, "ship"), false, `ship must not be offered on ${status}`);
  }
});

// ── The lifecycle the brief describes ───────────────────────────────────────

test("pending → hand over, change, call off, or take money", () => {
  assert.deepEqual([...actionsFor("pending")].sort(), ["cancel", "edit", "pay", "ship"]);
});

test("with the courier → it arrives, comes back, or gets paid down", () => {
  assert.deepEqual([...actionsFor("shipped")].sort(), ["deliver", "pay", "return", "settle"]);
});

test("a customer can pay down an order right up until it is delivered", () => {
  // Money can arrive by transfer while the goods sit in the shop OR ride in the
  // van — both are moments where the COD can still be reduced before the
  // courier knocks.
  assert.ok(canDo("pending", "pay"));
  assert.ok(canDo("shipped", "pay"));
});

test("but not after — by then the courier has already collected", () => {
  // Past delivery, further movement is a settlement or a refund, and those have
  // their own actions with their own ledger events.
  for (const status of ["delivered", "returned", "cancelled"]) {
    assert.equal(canDo(status, "pay"), false, `${status} must not accept a payment`);
  }
});

test("delivered → only a return, which reverses the money too", () => {
  assert.deepEqual([...actionsFor("delivered")], ["return"]);
});

test("returned → only the human confirmation that moves stock (§3.9)", () => {
  // The two-step return is the point: `return` records a courier's CLAIM and
  // moves nothing; `confirmReturn` is a person saying the goods are on the
  // shelf. Collapsing them would put stock back on a courier's word.
  assert.deepEqual([...actionsFor("returned")], ["confirmReturn"]);
  assert.equal(canDo("returned", "confirmReturn"), true);
  assert.equal(canDo("shipped", "confirmReturn"), false, "cannot confirm before it is claimed");
});

test("cancelled is terminal — no actions at all", () => {
  assert.deepEqual([...actionsFor("cancelled")], []);
  for (const action of ALL_ACTIONS) {
    assert.equal(canDo("cancelled", action), false, `${action} must not be offered on cancelled`);
  }
});

// ── Editing: the append-only boundary ───────────────────────────────────────

test("editing is legal ONLY while the order is still in the shop", () => {
  assert.equal(canDo("pending", "edit"), true);
  for (const status of ["shipped", "delivered", "returned", "cancelled"]) {
    assert.equal(
      canDo(status, "edit"),
      false,
      `once it is ${status} a change is a return, not an edit`,
    );
  }
});

// ── Structural guarantees ───────────────────────────────────────────────────

test("every status has an explicit entry — no status falls through", () => {
  for (const status of ALL_STATUSES) {
    assert.ok(Array.isArray(actionsFor(status)), `${status} must be declared`);
  }
});

test("an unknown status offers nothing rather than everything", () => {
  // Fail closed: a status added to the type but forgotten here must not
  // accidentally expose every button.
  assert.deepEqual([...actionsFor("not_a_real_status")], []);
});

test("no action is offered in every status", () => {
  // A sanity check on the whole table: if some action were legal everywhere it
  // would mean it is not really gated, which is the bug being fixed.
  for (const action of ALL_ACTIONS) {
    const everywhere = ALL_STATUSES.every((status) => canDo(status, action));
    assert.equal(everywhere, false, `${action} is offered in every status — not gated`);
  }
});

test("each of the two delivery modes exists exactly where money can move", () => {
  // "settle" means the cash came back to us; "deliver" means it is still with
  // the courier. Both are only meaningful from `shipped`.
  const settle = ALL_STATUSES.filter((s) => canDo(s, "settle"));
  const deliver = ALL_STATUSES.filter((s) => canDo(s, "deliver"));
  assert.deepEqual(settle, ["shipped"]);
  assert.deepEqual(deliver, ["shipped"]);
});
