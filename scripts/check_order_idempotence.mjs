/**
 * One click, one event — even when the click happens twice.
 *
 *     node --test scripts/check_order_idempotence.mjs
 *
 * The bug this pins, from the live database: `ECO-1786978185609` carries THREE
 * `order_delivered` events, 6 and 13 seconds apart, each a complete event, and
 * three `return_confirmed` behind them. The totals netted out. That was luck.
 *
 * Both handlers already re-checked `canDo` before writing. What they read was a
 * React render snapshot, and the status only becomes `delivered` AFTER the
 * append resolves — so every click landing inside that window saw `shipped` and
 * passed. `disabled={isWorking}` does not close it either: a second click can be
 * dispatched before React commits.
 *
 * So the assertions here are about the WINDOW, not about the final status. A
 * test that only checks "a delivered order cannot be delivered" would have
 * passed on the broken code.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { claimOrder, releaseOrder, canDo } from "../src/lib/orderLifecycle.ts";

const ORDERS_PAGE = new URL("../src/components/ecommerce/OrdersPage.tsx", import.meta.url);

// ── The claim itself ───────────────────────────────────────────────────────

test("a second claim on the same order is refused while the first is in flight", () => {
  assert.equal(claimOrder("o1", "shipped", "deliver"), "ok");
  assert.equal(claimOrder("o1", "shipped", "deliver"), "busy");
  assert.equal(claimOrder("o1", "shipped", "settle"), "busy", "any action, not just the same one");
  releaseOrder("o1");
  assert.equal(claimOrder("o1", "shipped", "deliver"), "ok", "released, so claimable again");
  releaseOrder("o1");
});

test("a different order is never blocked by another order's claim", () => {
  assert.equal(claimOrder("o1", "shipped", "deliver"), "ok");
  assert.equal(claimOrder("o2", "shipped", "deliver"), "ok");
  releaseOrder("o1");
  releaseOrder("o2");
});

test("once the status has moved past مع المندوب, تسليم and مرتجع are refused", () => {
  assert.equal(claimOrder("o3", "delivered", "deliver"), "illegal");
  assert.equal(claimOrder("o3", "delivered", "settle"), "illegal");
  assert.equal(claimOrder("o3", "returned", "deliver"), "illegal");
  assert.equal(claimOrder("o3", "returned", "return"), "illegal", "مرتجع twice");
  assert.equal(claimOrder("o3", "cancelled", "return"), "illegal");
  // Refused means NOT claimed — a rejected click must not leave the row stuck.
  assert.equal(claimOrder("o3", "shipped", "deliver"), "ok");
  releaseOrder("o3");
});

test("illegal is reported ahead of busy, so the operator is told the real reason", () => {
  assert.equal(claimOrder("o4", "shipped", "deliver"), "ok");
  assert.equal(claimOrder("o4", "delivered", "deliver"), "illegal");
  releaseOrder("o4");
});

// ── The double-click, end to end ───────────────────────────────────────────

/**
 * The delivery handler's exact shape: read the CURRENT status, claim, await the
 * append, then move the status. The status write lands last on purpose — that
 * is the real ordering, and the point is that the guard holds despite it.
 */
function deliverHandler(store, appended) {
  return async (orderId) => {
    const order = store.orders.find((o) => o.id === orderId);
    if (!order) return;
    const claim = claimOrder(order.id, order.status, "deliver");
    if (claim !== "ok") return claim;
    try {
      await new Promise((r) => setTimeout(r, 10)); // appendEvent
      appended.push({ kind: "order_delivered", refId: order.id });
      order.status = "delivered";
    } finally {
      releaseOrder(order.id);
    }
    return "written";
  };
}

test("a rapid double-click on تسليم writes exactly ONE order_delivered", async () => {
  const store = { orders: [{ id: "ECO-1786978185609", status: "shipped" }] };
  const appended = [];
  const deliver = deliverHandler(store, appended);

  // Both clicks fired before the first append resolves — the 6-second gap in
  // the real data is the same window, only wider.
  const results = await Promise.all([deliver("ECO-1786978185609"), deliver("ECO-1786978185609")]);

  assert.equal(appended.length, 1, "one click, one event");
  assert.deepEqual(results.sort(), ["busy", "written"]);
  assert.equal(store.orders[0].status, "delivered");
});

test("three clicks, the actual reported shape, still write ONE", async () => {
  const store = { orders: [{ id: "ECO-1786978185609", status: "shipped" }] };
  const appended = [];
  const deliver = deliverHandler(store, appended);

  await Promise.all([1, 2, 3].map(() => deliver("ECO-1786978185609")));
  assert.equal(appended.length, 1);

  // And the click that arrives AFTER it all settled is refused on status.
  assert.equal(await deliver("ECO-1786978185609"), "illegal");
  assert.equal(appended.length, 1);
});

test("a failed append releases the claim — a broken write must not lock the row", async () => {
  const store = { orders: [{ id: "o9", status: "shipped" }] };
  const boom = async (orderId) => {
    const order = store.orders.find((o) => o.id === orderId);
    if (claimOrder(order.id, order.status, "deliver") !== "ok") return "refused";
    try {
      throw new Error("ledger append failed");
    } finally {
      releaseOrder(order.id);
    }
  };
  await assert.rejects(boom("o9"));
  assert.equal(claimOrder("o9", "shipped", "deliver"), "ok", "still claimable after a failure");
  releaseOrder("o9");
});

// ── The handlers actually use it ───────────────────────────────────────────

test("every handler in OrdersPage that appends an event claims first", () => {
  const source = readFileSync(ORDERS_PAGE, "utf8");

  // A guard nothing calls is the bug that produced this file: `confirmReturn`
  // had no status check of any kind while `canDo` sat one import away.
  for (const handler of [
    "markReturnPending",
    "confirmDeliver",
    "confirmReturn",
    "cancelOrder",
    "saveEdit",
  ]) {
    const start = source.indexOf(`const ${handler} = async`);
    assert.ok(start > 0, `${handler} still exists`);
    const body = source.slice(start, source.indexOf("\n  };", start));
    assert.ok(body.includes("claimOrder("), `${handler} claims the order before writing`);
    assert.ok(body.includes("currentOrder("), `${handler} resolves the order from the store`);
    assert.ok(body.includes("releaseOrder("), `${handler} releases the claim`);
    assert.ok(
      body.indexOf("claimOrder(") < body.indexOf("await appendEvent"),
      `${handler} claims BEFORE its first await, not after`,
    );
  }
});

test("the handlers read the status from the store, not from the render", () => {
  const source = readFileSync(ORDERS_PAGE, "utf8");
  assert.ok(
    source.includes("useOrderStore.getState().orders.find"),
    "currentOrder() reads the live store",
  );
  // `editingOrder` stays a render value on purpose — the dialog has to
  // re-draw when the order changes. It is the SAVE that must not use it.
  assert.ok(
    !source.includes("const order = editingOrder"),
    "saveEdit no longer acts on the render snapshot",
  );
});

test("the lifecycle table is what says an action is illegal — the claim adds nothing to it", () => {
  // The claim must never widen what is legal. Same answer, both routes.
  for (const status of ["pending", "shipped", "delivered", "returned", "cancelled"]) {
    for (const action of ["deliver", "settle", "return", "confirmReturn"]) {
      const claimed = claimOrder(`x-${status}-${action}`, status, action);
      assert.equal(claimed === "illegal", !canDo(status, action), `${status} / ${action}`);
      if (claimed === "ok") releaseOrder(`x-${status}-${action}`);
    }
  }
});
