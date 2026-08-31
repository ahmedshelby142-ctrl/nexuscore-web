/**
 * Finding an order by typing — the shared matcher.
 *
 *     node --test scripts/check_order_search.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  matchesOrderQuery,
  searchOrders,
  normaliseSearchText,
  ordersInPeriod,
} from "../src/lib/orderSearch.ts";

const ORDERS = [
  { orderNumber: "ECO-1001", customerName: "أحمد محمود", customerPhone: "01001234567" },
  { orderNumber: "ECO-1002", customerName: "منى سيد", customerPhone: "01112223333" },
  { orderNumber: "ECO-1003", customerName: "أحمد سيد", customerPhone: "01099887766" },
];

test("one field searches order number, name and phone at once", () => {
  // No mode picker: the user should not have to tell the app what they typed.
  assert.equal(searchOrders(ORDERS, "1002").length, 1, "by order number");
  assert.equal(searchOrders(ORDERS, "منى").length, 1, "by customer name");
  assert.equal(searchOrders(ORDERS, "0111").length, 1, "by phone");
});

test("a partial phone finds the order, however it was typed", () => {
  for (const typed of ["01001234567", "0100 123 4567", "0100-123-4567", "1234567"]) {
    const found = searchOrders(ORDERS, typed);
    assert.equal(found.length, 1, `"${typed}" should find exactly one order`);
    assert.equal(found[0].orderNumber, "ECO-1001");
  }
});

test("Arabic-Indic digits match a Latin-digit phone", () => {
  // A number copied off an Arabic keyboard must still find its order.
  assert.equal(normaliseSearchText("٠١٠٠"), "0100");
  const found = searchOrders(ORDERS, "٠١٠٠١٢٣٤٥٦٧");
  assert.equal(found.length, 1);
  assert.equal(found[0].orderNumber, "ECO-1001");
});

test("every typed word must match, so two words narrow rather than widen", () => {
  // "أحمد" alone hits two orders; adding part of the phone picks one.
  assert.equal(searchOrders(ORDERS, "أحمد").length, 2);
  const narrowed = searchOrders(ORDERS, "أحمد 9988");
  assert.equal(narrowed.length, 1, "both words must match the same order");
  assert.equal(narrowed[0].orderNumber, "ECO-1003");
});

test("an empty query shows everything rather than hiding the list", () => {
  assert.equal(searchOrders(ORDERS, "").length, 3);
  assert.equal(searchOrders(ORDERS, "   ").length, 3);
  assert.equal(matchesOrderQuery(ORDERS[0], ""), true);
});

test("a query that matches nothing returns nothing, not everything", () => {
  assert.equal(searchOrders(ORDERS, "ECO-9999").length, 0);
  assert.equal(searchOrders(ORDERS, "خالد").length, 0);
});

test("search is case-insensitive on the order number", () => {
  assert.equal(searchOrders(ORDERS, "eco-1001").length, 1);
  assert.equal(searchOrders(ORDERS, "ECO-1001").length, 1);
});

test("orders with missing fields do not crash the matcher", () => {
  const partial = [{ orderNumber: "ECO-2000" }, { customerName: "بدون رقم" }, {}];
  assert.equal(searchOrders(partial, "ECO-2000").length, 1);
  assert.equal(searchOrders(partial, "بدون").length, 1);
  assert.equal(searchOrders(partial, "zzz").length, 0);
});

test("results keep their original order, so the newest stays on top", () => {
  const found = searchOrders(ORDERS, "أحمد");
  assert.deepEqual(
    found.map((o) => o.orderNumber),
    ["ECO-1001", "ECO-1003"],
  );
});

test("100+ orders stay findable by a single distinctive term", () => {
  // The scaling claim: one exact term must reduce a long list to one row, so
  // the screen never depends on scrolling.
  const many = Array.from({ length: 250 }, (_, i) => ({
    orderNumber: `ECO-${2000 + i}`,
    customerName: `عميل ${i}`,
    customerPhone: `0100000${String(i).padStart(4, "0")}`,
  }));
  assert.equal(searchOrders(many, "ECO-2137").length, 1);
  assert.equal(searchOrders(many, "01000000137").length, 1);
});

// ── The date filter (§3.8) ─────────────────────────────────────────────────

const DATED = [
  { orderNumber: "A", createdAt: new Date("2026-08-01T09:00:00") },
  { orderNumber: "B", createdAt: new Date("2026-08-15T18:30:00") },
  // A string, which is what zustand's localStorage rehydration hands back.
  { orderNumber: "C", createdAt: "2026-08-31T23:30:00" },
];

const numbers = (rows) => rows.map((r) => r.orderNumber);

test("no bounds means no filtering — a blank filter shows the list, not nothing", () => {
  assert.deepEqual(numbers(ordersInPeriod(DATED, "", "")), ["A", "B", "C"]);
});

test("both ends are INCLUSIVE, to the end of the `to` day", () => {
  // The boundary bug this exists for: an order placed at 18:30 on the last day
  // of the range must be in it. Comparing against midnight drops it.
  assert.deepEqual(numbers(ordersInPeriod(DATED, "2026-08-15", "2026-08-15")), ["B"]);
  assert.deepEqual(numbers(ordersInPeriod(DATED, "2026-08-01", "2026-08-15")), ["A", "B"]);
  assert.deepEqual(
    numbers(ordersInPeriod(DATED, "2026-08-31", "2026-08-31")),
    ["C"],
    "23:30 counts",
  );
});

test("one bound can be set without the other", () => {
  assert.deepEqual(numbers(ordersInPeriod(DATED, "2026-08-15", "")), ["B", "C"]);
  assert.deepEqual(numbers(ordersInPeriod(DATED, "", "2026-08-15")), ["A", "B"]);
});

test("a date string is read the same as a Date object", () => {
  assert.deepEqual(numbers(ordersInPeriod(DATED, "2026-08-31", "")), ["C"]);
});

test("an unparseable date is SHOWN, never silently dropped", () => {
  // A row hidden by a filter it cannot be judged against is an order that
  // vanished. Better on screen where it can be seen and fixed.
  const broken = [...DATED, { orderNumber: "D", createdAt: "not a date" }];
  assert.ok(numbers(ordersInPeriod(broken, "2026-08-01", "2026-08-02")).includes("D"));
});

test("the counters count the same list the table draws — by construction", () => {
  // The counters are `ordersInPeriod(...)` grouped by status, and the tab is
  // the same list filtered by one status, so the two cannot disagree.
  const rows = [
    { orderNumber: "A", status: "shipped", createdAt: new Date("2026-08-01T09:00:00") },
    { orderNumber: "B", status: "shipped", createdAt: new Date("2026-08-20T09:00:00") },
    { orderNumber: "C", status: "delivered", createdAt: new Date("2026-08-01T09:00:00") },
  ];
  const period = ordersInPeriod(rows, "2026-08-01", "2026-08-01");
  const shippedCount = period.filter((r) => r.status === "shipped").length;
  assert.equal(shippedCount, 1, "the badge");
  assert.equal(
    numbers(period.filter((r) => r.status === "shipped")).length,
    shippedCount,
    "the tab",
  );
});
