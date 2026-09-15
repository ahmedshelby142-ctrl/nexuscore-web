/**
 * One customer, one history — whichever screen is asking.
 *
 * The defect: `deriveCustomerMetrics` matched on `order.customerId === id`
 * while the timeline beside it used `orderBelongsTo`, which also resolves a
 * phone key. So «إجمالي الطلبات» could read 0 next to a timeline listing five,
 * and every POS sale taken before the till linked a customer was invisible.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  customerKey,
  deriveCustomerMetrics,
  orderBelongsTo,
  saleBelongsTo,
} from "../src/lib/customers.ts";

const ahmed = { id: "c1", name: "أحمد محمد", phone: "01012345678" };
const other = { id: "c2", name: "أحمد علي", phone: "01099998888" };

test("the same number written three ways is one customer", () => {
  // The identity key normalises Egyptian trunk notation and separators, so
  // «+20 101 234 5678» and «0101-234-5678» resolve to the same person.
  const forms = ["01012345678", "+20 101 234 5678", "0101-234-5678", "0020 101 234 5678"];
  const keys = new Set(forms.map((phone) => customerKey({ phone })));
  assert.equal(keys.size, 1, `these must all key the same: ${[...keys].join(" | ")}`);
});

test("an order with no linked id still resolves by phone", () => {
  assert.equal(
    orderBelongsTo({ customerPhone: "+20 101 234 5678" }, ahmed),
    true,
    "the pre-link orders are exactly the ones the strict compare dropped",
  );
});

test("two people sharing a first name never see each other's orders", () => {
  assert.equal(orderBelongsTo({ customerPhone: other.phone }, ahmed), false);
  assert.equal(orderBelongsTo({ customerId: "c2" }, ahmed), false);
});

test("a POS sale belongs to the customer on its payload, id or phone", () => {
  assert.equal(saleBelongsTo({ payload: { customerId: "c1" } }, ahmed), true);
  assert.equal(saleBelongsTo({ payload: { customerPhone: "0101 234 5678" } }, ahmed), true);
  assert.equal(saleBelongsTo({ payload: { customerId: "c2" } }, ahmed), false);
  // No payload, or no customer on it, belongs to nobody — never to everybody.
  assert.equal(saleBelongsTo({}, ahmed), false);
  assert.equal(saleBelongsTo({ payload: {} }, ahmed), false);
});

test("the metrics count the SAME orders the timeline lists", () => {
  const orders = [
    // Linked by id.
    { id: "o1", customerId: "c1", createdAt: "2026-01-05", items: [{ productId: "P1", productName: "قميص", quantity: 2, unitPrice: 250 }] },
    // Pre-link: phone only, and written in another format.
    { id: "o2", customerPhone: "+20 101 234 5678", createdAt: "2026-02-05", items: [{ productId: "P1", productName: "قميص", quantity: 1, unitPrice: 250 }] },
    // Somebody else's.
    { id: "o3", customerId: "c2", createdAt: "2026-03-05", items: [{ productId: "P2", productName: "حذاء", quantity: 9, unitPrice: 400 }] },
  ];
  const sales = [
    { id: "s1", kind: "sale", occurredAt: "2026-04-01", payload: { customerId: "c1", items: [{ productId: "P2", productName: "حذاء", quantity: 1, unitPrice: 400 }] } },
    { id: "s2", kind: "sale", occurredAt: "2026-05-01", payload: { customerPhone: "0101-234-5678", items: [{ productId: "P1", productName: "قميص", quantity: 1, unitPrice: 250 }] } },
    { id: "s3", kind: "sale", occurredAt: "2026-06-01", payload: { customerId: "c2", items: [] } },
  ];

  const timelineCount =
    orders.filter((o) => orderBelongsTo(o, ahmed)).length +
    sales.filter((s) => saleBelongsTo(s, ahmed)).length;

  const metrics = deriveCustomerMetrics(ahmed, orders, sales);
  assert.equal(timelineCount, 4, "two orders and two till sales are his");
  assert.equal(metrics.totalOrders, timelineCount, "the two must never disagree");
});

test("the favourite product totals include the phone-matched history", () => {
  const orders = [
    { id: "o1", customerPhone: "0101 234 5678", createdAt: "2026-02-05", items: [{ productId: "P1", productName: "قميص", quantity: 3, unitPrice: 100 }] },
  ];
  const metrics = deriveCustomerMetrics(ahmed, orders, []);
  assert.equal(metrics.preferredProducts.length, 1);
  assert.equal(metrics.preferredProducts[0].quantity, 3);
  assert.equal(metrics.preferredProducts[0].spent, 300);
});

test("the last order date is the real latest, across both channels", () => {
  const orders = [{ id: "o1", customerId: "c1", createdAt: "2026-01-05", items: [] }];
  const sales = [
    { id: "s1", kind: "sale", occurredAt: "2026-07-09", payload: { customerId: "c1", items: [] } },
    { id: "s2", kind: "sale", occurredAt: "2026-03-01", payload: { customerId: "c1", items: [] } },
  ];
  const metrics = deriveCustomerMetrics(ahmed, orders, sales);
  assert.equal(
    metrics.lastOrderAt.toISOString().slice(0, 10),
    "2026-07-09",
    "not whichever row happened to come last in the array",
  );
});

test("nothing of another customer's leaks in", () => {
  const orders = [{ id: "o3", customerId: "c2", createdAt: "2026-03-05", items: [{ productId: "P2", productName: "حذاء", quantity: 9, unitPrice: 400 }] }];
  const metrics = deriveCustomerMetrics(ahmed, orders, []);
  assert.equal(metrics.totalOrders, 0);
  assert.deepEqual(metrics.preferredProducts, []);
});
