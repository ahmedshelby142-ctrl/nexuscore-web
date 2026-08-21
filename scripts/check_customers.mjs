/**
 * ربط الطلب بالعميل — the §1.3 scenario for 8 (§3.7).
 *
 *     node --test scripts/check_customers.mjs
 *
 * The scenario the brief asks for: place an order for a new phone number → a
 * customer is created; place a SECOND order with the same number → it reuses
 * the SAME customer id, and LTV accumulates on ONE record rather than two.
 *
 * The upsert decision itself lives in `@/lib/customers` precisely so this file
 * can drive it: a rule that only exists inside a zustand `set()` cannot be
 * tested without a browser, and this is the rule the whole feature is about.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  customerKey,
  sameCustomer,
  upsertTarget,
  resolveByPhone,
  searchCustomersByPhone,
  customerIdOf,
  orderBelongsTo,
  activeCustomers,
  isCustomerArchived,
  duplicateOf,
  customerRemovalMode,
} from "../src/lib/customers.ts";
import { buildOrderDeliveredLines } from "../src/lib/ledger/orders.ts";

/**
 * `upsertCustomerFromOrder`, reduced to what it decides. Mirrors the store:
 * `upsertTarget` picks the record, a miss mints a new id, and the returned id
 * is what the order document carries away.
 */
function placeOrder(book, order) {
  const existing = upsertTarget(book, order);
  if (existing) {
    // Activity only. The store deliberately does NOT copy the order's name or
    // phone over an existing record any more: re-ordering used to silently
    // rename a customer whose spelling the owner had just corrected in
    // قاعدة العملاء, undoing her edit with the next order.
    existing.totalOrders += 1;
    return { book, customerId: existing.id, created: false };
  }
  const created = {
    id: `cust-${book.length + 1}`,
    name: order.customerName,
    phone: order.customerPhone,
    totalOrders: 1,
  };
  return { book: [...book, created], customerId: created.id, created: true };
}

/** `SUM(customer_ltv)` per subject, the way the CRM screen reads it. */
function ltvBySubject(lines) {
  const totals = new Map();
  for (const l of lines) {
    if (l.account !== "customer_ltv") continue;
    totals.set(l.subjectId, (totals.get(l.subjectId) ?? 0) + (l.amount ?? 0));
  }
  return totals;
}

const deliveryLines = (customerId, goodsTotal) =>
  buildOrderDeliveredLines({
    items: [{ productId: "p1", quantity: 1, unitPrice: goodsTotal, unitCost: 60 }],
    goodsTotal,
    shippingFee: 0,
    depositAmount: goodsTotal,
    wallet: "inStoreSafe",
    codAmount: 0,
    courierId: "cour-1",
    customerId,
    channel: "ecommerce",
  });

// ── §1.3 ────────────────────────────────────────────────────────────────────

test("§1.3: two orders, same phone, different name spelling → ONE customer", () => {
  let book = [];

  // First order: nobody has this number yet.
  const first = placeOrder(book, {
    customerName: "أحمد محمد",
    customerPhone: "01012345678",
  });
  book = first.book;
  assert.equal(first.created, true, "a new phone number opens a record");
  assert.equal(book.length, 1);

  // Second order, same person: name spelled without the hamza, number written
  // the way WhatsApp shows it. Both used to open a second record.
  const second = placeOrder(book, {
    customerName: "احمد محمد",
    customerPhone: "+20 101 234 5678",
  });
  book = second.book;

  assert.equal(second.created, false, "the same number must NOT open a second record");
  assert.equal(second.customerId, first.customerId, "same id — this is the whole feature");
  assert.equal(book.length, 1, "ONE record");
  assert.equal(book[0].totalOrders, 2);
  assert.equal(book[0].name, "أحمد محمد", "the order did NOT rewrite the stored spelling");

  // And the money lands on that one record.
  const ltv = ltvBySubject([
    ...deliveryLines(first.customerId, 300),
    ...deliveryLines(second.customerId, 500),
  ]);
  assert.equal(ltv.size, 1, "LTV did not split across two subjects");
  assert.equal(ltv.get(first.customerId), 800, "300 + 500 on one customer");
});

test("a different number is a different person", () => {
  let book = [];
  book = placeOrder(book, { customerName: "أحمد", customerPhone: "01012345678" }).book;
  const other = placeOrder(book, { customerName: "أحمد", customerPhone: "01098765432" });

  assert.equal(other.created, true, "same name, different number → not the same person");
  assert.equal(other.book.length, 2);
});

test("a picked customer wins over the typed text", () => {
  const book = [
    { id: "c1", name: "أحمد محمد", phone: "01012345678", totalOrders: 3 },
    { id: "c2", name: "أحمد علي", phone: "01098765432", totalOrders: 1 },
  ];

  // She picked c2 in the phone search, then typed a number that keys to c1.
  // The confirmation she gave beats the string compare.
  const target = upsertTarget(book, {
    customerId: "c2",
    customerName: "أحمد",
    customerPhone: "01012345678",
  });
  assert.equal(target.id, "c2");
});

test("a stale picked id falls back to the key instead of resurrecting anyone", () => {
  const book = [{ id: "c1", name: "أحمد", phone: "01012345678", totalOrders: 1 }];
  const target = upsertTarget(book, {
    customerId: "deleted-while-the-draft-sat-open",
    customerName: "أحمد",
    customerPhone: "01012345678",
  });
  assert.equal(target.id, "c1");

  const nobody = upsertTarget(book, {
    customerId: "also-gone",
    customerName: "سعاد",
    customerPhone: "01055555555",
  });
  assert.equal(nobody, null, "creates a new record rather than attaching to a ghost");
});

// ── The identity key ────────────────────────────────────────────────────────

test("the same Egyptian number in any notation is one key", () => {
  const forms = [
    "01012345678",
    "+201012345678",
    "+20 101 234 5678",
    "0101-234-5678",
    "00201012345678",
    "٠١٠١٢٣٤٥٦٧٨",
  ];
  const keys = new Set(forms.map((phone) => customerKey({ phone })));
  assert.equal(keys.size, 1, `every notation must key the same, got ${[...keys].join(" | ")}`);
  assert.equal([...keys][0], "tel:201012345678");
});

test("no phone falls back to the name, and two blanks are never the same person", () => {
  assert.equal(customerKey({ name: "سعاد" }), "name:سعاد");
  assert.equal(customerKey({ phone: "  ", name: "  " }), null);
  assert.equal(customerKey({}), null);

  assert.equal(sameCustomer({ name: "سعاد" }, { name: "سعاد" }), true);
  assert.equal(sameCustomer({}, {}), false, "a null key matches nothing, including another null");
  assert.equal(
    sameCustomer({ phone: "0101", name: "سعاد" }, { name: "سعاد" }),
    true,
    "too short to dial → both fall back to the name",
  );
});

// ── Search-first ────────────────────────────────────────────────────────────

const DIRECTORY = [
  { id: "c1", name: "أحمد محمد", phone: "01012345678", lastOrderAt: "2026-08-01" },
  { id: "c2", name: "أحمد علي", phone: "01012349999", lastOrderAt: "2026-08-15" },
  { id: "c3", name: "سعاد", phone: "01099998888" },
];

test("the search waits for enough digits to be worth showing", () => {
  assert.deepEqual(searchCustomersByPhone(DIRECTORY, "010"), [], "3 digits matches everyone");
  assert.equal(searchCustomersByPhone(DIRECTORY, "0101").length, 2);
  assert.equal(searchCustomersByPhone(DIRECTORY, "5678").length, 1, "the tail of the number");
});

test("suggestions come back with the most recent customer first", () => {
  assert.deepEqual(
    searchCustomersByPhone(DIRECTORY, "0101").map((c) => c.id),
    ["c2", "c1"],
    "c2 ordered more recently",
  );
});

test("an exact match is reported, never applied", () => {
  const match = resolveByPhone(DIRECTORY, "+20 101 234 5678");
  assert.equal(match.kind, "one", "one candidate — for her to confirm, not for us to take");
  assert.equal(match.customer.id, "c1");
});

test("several near-matches are ambiguous, not a coin toss", () => {
  const match = resolveByPhone(DIRECTORY, "010123");
  assert.equal(match.kind, "ambiguous");
  assert.deepEqual(
    match.customers.map((c) => c.id),
    ["c2", "c1"],
  );
});

test("duplicates already in the book are surfaced, not silently picked", () => {
  // Two records for one number — exactly what the old string matching created.
  const withDupes = [
    { id: "c1", name: "أحمد محمد", phone: "01012345678" },
    { id: "c9", name: "احمد", phone: "+201012345678" },
  ];
  const match = resolveByPhone(withDupes, "01012345678");
  assert.equal(match.kind, "ambiguous", "the app must not choose which one gets the money");
  assert.equal(match.customers.length, 2);
});

test("an unknown number is a new customer, not a wrong one", () => {
  assert.deepEqual(resolveByPhone(DIRECTORY, "01277776666"), { kind: "none" });
});

// ── Reading orders back ─────────────────────────────────────────────────────

test("orders placed before §3.7 still resolve, by phone", () => {
  const legacy = { customerName: "أحمد محمد", customerPhone: "+20 101 234 5678" };
  assert.equal(customerIdOf(legacy, DIRECTORY), "c1", "no customerId, matched on the key");
  assert.equal(orderBelongsTo(legacy, DIRECTORY[0]), true);

  const modern = { customerId: "c2", customerName: "أي حاجة", customerPhone: "01012345678" };
  assert.equal(customerIdOf(modern, DIRECTORY), "c2", "the id wins over the phone");
  assert.equal(orderBelongsTo(modern, DIRECTORY[1]), true);
  assert.equal(orderBelongsTo(modern, DIRECTORY[0]), false);
});

test("a guest order resolves to nobody rather than to someone", () => {
  assert.equal(customerIdOf({}, DIRECTORY), null);
  assert.equal(customerIdOf({ customerPhone: "01277776666" }, DIRECTORY), null);
  assert.equal(orderBelongsTo({}, DIRECTORY[0]), false);
});

test("the CRM timeline no longer mixes two people who share a first name", () => {
  // The old filter was `phone === c.phone || name === c.name`, so an order for
  // «أحمد علي» showed up under «أحمد محمد» whenever the names collided.
  const order = { customerId: "c2", customerName: "أحمد", customerPhone: "01012349999" };
  assert.equal(orderBelongsTo(order, DIRECTORY[1]), true);
  assert.equal(orderBelongsTo(order, DIRECTORY[0]), false);
});

test("delivery writes the LTV line against the id, or none at all", () => {
  const withCustomer = ltvBySubject(deliveryLines("c1", 300));
  assert.equal(withCustomer.get("c1"), 300);

  const guest = ltvBySubject(deliveryLines(undefined, 300));
  assert.equal(guest.size, 0, "a guest order writes no customer_ltv line");
});

// ── Editing the directory by hand (§3.13, closed 2026-08-19) ────────────────

test("an order no longer overwrites a corrected name", () => {
  // The behaviour the hand-test caught: she fixes «احمد» to «أحمد محمد» in
  // قاعدة العملاء, then his next order arrives typed the old way.
  let book = [{ id: "c1", name: "أحمد محمد", phone: "01012345678", totalOrders: 1 }];
  const again = placeOrder(book, { customerName: "احمد", customerPhone: "01012345678" });

  assert.equal(again.created, false);
  assert.equal(again.book[0].name, "أحمد محمد", "her edit survives the next order");
  assert.equal(again.book[0].totalOrders, 2, "the activity still counts");
});

test("archived customers leave every picker but keep their history", () => {
  const book = [
    { id: "c1", name: "أحمد", phone: "01012345678", deleted_at: "2026-08-19T00:00:00.000Z" },
    { id: "c2", name: "سعاد", phone: "01099998888", deleted_at: null },
  ];

  assert.equal(isCustomerArchived(book[0]), true);
  assert.equal(isCustomerArchived(book[1]), false, "null is not archived");
  assert.deepEqual(
    activeCustomers(book).map((c) => c.id),
    ["c2"],
  );

  // Not suggested, not matched, not silently revived by a new order…
  assert.deepEqual(searchCustomersByPhone(book, "0101"), []);
  assert.deepEqual(resolveByPhone(book, "01012345678"), { kind: "none" });
  assert.equal(
    upsertTarget(book, { customerName: "أحمد", customerPhone: "01012345678" }),
    null,
    "a new order from an archived number opens a FRESH record",
  );
  assert.equal(
    upsertTarget(book, { customerId: "c1", customerPhone: "01012345678" }),
    null,
    "not even a stale picked id revives them",
  );

  // …but their past orders still resolve, or their timeline empties.
  assert.equal(customerIdOf({ customerId: "c1" }, book), "c1");
  assert.equal(customerIdOf({ customerPhone: "+201012345678" }, book), "c1");
  assert.equal(orderBelongsTo({ customerId: "c1" }, book[0]), true);
});

test("two active customers can never be handed the same identity", () => {
  const book = [
    { id: "c1", name: "أحمد", phone: "01012345678" },
    { id: "c2", name: "سعاد", phone: "01099998888" },
  ];

  // Registering someone new on a number that is already taken.
  assert.equal(duplicateOf(book, { phone: "+20 101 234 5678" })?.id, "c1");
  // Editing c2 onto c1's number.
  assert.equal(duplicateOf(book, { phone: "01012345678" }, "c2")?.id, "c1");
  // Editing c1's own row is not a collision with itself.
  assert.equal(duplicateOf(book, { phone: "01012345678" }, "c1"), null);
  // A free number.
  assert.equal(duplicateOf(book, { phone: "01277776666" }), null);
  // Nothing to key on is not a collision either.
  assert.equal(duplicateOf(book, {}), null);
});

test("an archived row does not block the number for a new card", () => {
  const book = [
    { id: "c1", name: "أحمد", phone: "01012345678", deleted_at: "2026-08-19T00:00:00.000Z" },
  ];
  assert.equal(
    duplicateOf(book, { phone: "01012345678" }),
    null,
    "she archived them deliberately — the number is free again",
  );
});

test("delete only when there is nothing to orphan", () => {
  assert.equal(customerRemovalMode([], 0), "delete");
  assert.equal(customerRemovalMode([{}], 0), "archive", "a ledger line is history");
  assert.equal(customerRemovalMode([], 1), "archive", "so is a pending order");

  // The trap the row-count rule exists to avoid: bought 300, returned all of
  // it. `SUM(customer_ltv)` is exactly 0 and the history is real.
  const boughtAndReturned = [
    { subjectId: "c1", amount: 300 },
    { subjectId: "c1", amount: -300 },
  ];
  assert.equal(
    boughtAndReturned.reduce((t, r) => t + r.amount, 0),
    0,
    "the sum says nothing happened",
  );
  assert.equal(customerRemovalMode(boughtAndReturned, 0), "archive", "the rows say it did");
});
