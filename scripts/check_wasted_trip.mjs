/**
 * Wasted-trip compensation (054) — the release acceptance cases.
 *
 *     node --test scripts/check_wasted_trip.mjs
 *
 * OLD: shippingFee = base + one earlier wasted trip, and the whole of it was
 *      booked as `payable_courier` — the shop's recovery became courier cost.
 * NEW: shippingFee = base; wastedTripCompensation = the recovery, separately.
 *      The customer owes exactly what they owed before; the courier is owed
 *      the base (or an operator's override); the recovery stays with the shop.
 *
 * Every `order_delivered` set of lines is also run through the rules the LIVE
 * validator applies to that kind (ledger_validate_event, 046 + 054), so a line
 * shape the database would refuse fails here first.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildOrderDeliveredLines } from "../src/lib/ledger/orders.ts";
import {
  wastedTripCompensationFor,
  shippingFeeFor,
  isRepeatReturner,
  clearsShippingDebt,
  RETURN_PENALTY_MULTIPLIER,
} from "../src/lib/shippingRates.ts";
import { toRemoteRow, fromRemoteRow } from "../src/services/api/fieldMapping.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const on = (lines, account, subject) =>
  lines
    .filter((l) => l.account === account && (subject === undefined || l.subjectId === subject))
    .reduce((s, l) => s + (l.amount ?? 0), 0);

/** The 046/054 `order_delivered` rules, applied to built lines. */
function liveValidatorAccepts(lines, priorDeposits) {
  const allowed = new Set(["cogs", "receivable_courier", "revenue", "payable_courier", "customer_ltv", "expense", "stock"]);
  for (const l of lines) assert.ok(allowed.has(l.account), `order_delivered may not carry ${l.account}`);
  for (const acc of ["receivable_courier", "payable_courier", "revenue", "cogs", "expense"]) {
    assert.ok(lines.filter((l) => l.account === acc).every((l) => (l.amount ?? 0) >= 0), `${acc} never negative`);
  }
  const r = on(lines, "revenue");
  const ltv = on(lines, "customer_ltv");
  assert.ok(ltv === 0 || ltv === r, `ltv (${ltv}) must be 0 or the revenue (${r})`);
  const rco = on(lines, "receivable_courier");
  const pc = on(lines, "payable_courier");
  assert.ok(priorDeposits + rco <= r + pc + 1e-9, `COD + deposits (${priorDeposits + rco}) ≤ goods + shipping (${r + pc})`);
}

const goods = [{ productId: "p1", quantity: 1, unitPrice: 1000, unitCost: 400 }];
const repeat = { returned_orders_count: 1 };
const normal = { returned_orders_count: 0 };

/** What the order-creation screen computes and stores (ecommerce-orders.tsx). */
function place(base, customer, deposit) {
  const comp = wastedTripCompensationFor(base, customer);
  const grand = 1000 + base + comp;
  return { shippingFee: base, wastedTripCompensation: comp, grand, deposit, cod: grand - deposit };
}
function deliver(order, extra = {}) {
  return buildOrderDeliveredLines({
    items: goods,
    goodsTotal: 1000,
    shippingFee: order.shippingFee,
    wastedTripCompensation: order.wastedTripCompensation,
    depositAmount: order.deposit,
    codAmount: order.cod,
    courierId: "jt-express",
    customerId: "cust-1",
    ...extra,
  });
}

test("CASE A — normal Cairo: 1000 + 60, no compensation, courier 60", () => {
  const o = place(60, normal, 0);
  assert.deepEqual([o.shippingFee, o.wastedTripCompensation, o.grand], [60, 0, 1060]);
  const lines = deliver(o);
  assert.equal(on(lines, "payable_courier"), 60);
  assert.equal(on(lines, "revenue"), 1000);
  assert.equal(on(lines, "revenue", "wasted_trip_compensation"), 0);
  liveValidatorAccepts(lines, o.deposit);
});

test("CASE B — repeat Cairo: 1000 + 60 + 60 = 1120, deposit 300, COD 820, courier 60", () => {
  const o = place(60, repeat, 300);
  assert.deepEqual([o.shippingFee, o.wastedTripCompensation, o.grand, o.cod], [60, 60, 1120, 820]);
  const lines = deliver(o);
  assert.equal(on(lines, "payable_courier"), 60, "NOT 120");
  assert.equal(on(lines, "revenue", "wasted_trip_compensation"), 60, "the recovery stays with the shop");
  assert.equal(on(lines, "receivable_courier"), 820);
  liveValidatorAccepts(lines, o.deposit);
});

test("CASE C — repeat Giza: 1000 + 70 + 70 = 1140, courier 70", () => {
  const o = place(70, repeat, 0);
  assert.deepEqual([o.shippingFee, o.wastedTripCompensation, o.grand], [70, 70, 1140]);
  const lines = deliver(o);
  assert.equal(on(lines, "payable_courier"), 70);
  assert.equal(on(lines, "revenue", "wasted_trip_compensation"), 70);
  liveValidatorAccepts(lines, o.deposit);
});

test("CASE D — full prepaid: deposit 1120, COD 0, courier still 60", () => {
  const o = place(60, repeat, 1120);
  assert.equal(o.cod, 0);
  const lines = deliver(o);
  assert.equal(on(lines, "payable_courier"), 60);
  assert.equal(on(lines, "receivable_courier"), 0);
  liveValidatorAccepts(lines, o.deposit);
});

test("CASE E — the debt flag is the old one, exactly, and is consumed in one place only", () => {
  // `shippingPenaltyApplied` used to be `shippingFeeFor(base) > base`; it is now
  // `compensation > 0`. Same answer for every input the screen can produce:
  // `rateFor` returns a positive tariff or 0, never a negative or NaN one (for
  // a negative base the old test was true while charging nothing — a flag
  // with no recovery behind it, which the new one no longer raises).
  assert.match(read("src/lib/shippingRates.ts"), /return Number\.isFinite\(value\) && value > 0 \? value : 0;/);
  for (const base of [0, 40, 60, 70]) {
    for (const count of [undefined, 0, 1, 3, -1]) {
      const c = { returned_orders_count: count };
      const old = shippingFeeFor(base, c) > base;
      assert.equal(wastedTripCompensationFor(base, c) > 0, old, `base ${base}, count ${count}`);
      // The customer's total is unchanged from the old combined fee.
      if (Number.isFinite(base) && base > 0) assert.equal(base + wastedTripCompensationFor(base, c), shippingFeeFor(base, c));
    }
  }
  assert.equal(wastedTripCompensationFor(60, repeat), 60 * (RETURN_PENALTY_MULTIPLIER - 1), "exactly one base rate");
  assert.equal(isRepeatReturner({ returned_orders_count: 1 }), true);
  assert.equal(isRepeatReturner({ returned_orders_count: 0 }), false);
  assert.equal(clearsShippingDebt({ shippingPenaltyApplied: true }), true);
  assert.equal(clearsShippingDebt({ shippingPenaltyApplied: false }), false);

  // Consumed only on delivery reconciliation — never on creation, payment or
  // settlement — and the flag is cleared in the same step so it cannot repeat.
  const callers = ["src/components/ecommerce/OrdersPage.tsx", "src/routes/ecommerce-orders.tsx", "src/routes/returns.tsx",
    "src/components/ecommerce/CourierLedgerPage.tsx", "src/store/useOrderStore.ts"]
    .flatMap((f) => [...read(f).matchAll(/settleWastedTrip\(/g)].map(() => f));
  assert.deepEqual(callers, ["src/components/ecommerce/OrdersPage.tsx"]);
  const page = read("src/components/ecommerce/OrdersPage.tsx");
  assert.match(page, /if \(clearsShippingDebt\(order\) && customerId\) \{\s*await useCustomerStore\.getState\(\)\.settleWastedTrip\(customerId\);\s*await updateOrder\(order\.id, \{ shippingPenaltyApplied: false \}\);/);
  // …and the counter moves by exactly one, never below zero.
  assert.match(read("src/store/useCustomerStore.ts"), /returned_orders_count: Math\.max\(0, \(current\.returned_orders_count \?\? 0\) - 1\)/);
});

test("CASE F — courier override 45: courier owed 45, compensation still 60", () => {
  const o = place(60, repeat, 300);
  const lines = deliver(o, { courierFee: 45 });
  assert.equal(on(lines, "payable_courier"), 45);
  assert.equal(on(lines, "revenue", "wasted_trip_compensation"), 60);
  assert.equal(on(lines, "revenue", "shipping_delivery_margin"), 15);
  liveValidatorAccepts(lines, o.deposit);
});

test("CASE G — courier override 75: courier owed 75, compensation still 60, overrun is shipping cost", () => {
  const o = place(60, repeat, 300);
  const lines = deliver(o, { courierFee: 75 });
  assert.equal(on(lines, "payable_courier"), 75);
  assert.equal(on(lines, "revenue", "wasted_trip_compensation"), 60);
  assert.equal(on(lines, "expense", "shipping"), 15, "the P&L's own shipping-cost subject");
  liveValidatorAccepts(lines, o.deposit);
});

test("CASE H — a legacy order (combined fee, no compensation field) books exactly as before", () => {
  const legacy = { shippingFee: 120, deposit: 300, cod: 820 }; // pre-054: 60 + 60 combined
  const lines = deliver(legacy, { courierFee: 120 });
  assert.equal(on(lines, "payable_courier"), 120, "unchanged from the old booking");
  assert.equal(on(lines, "revenue"), 1000);
  assert.equal(lines.some((l) => l.subjectId === "wasted_trip_compensation"), false);
  liveValidatorAccepts(lines, legacy.deposit);
});

test("a courierFee left at the column default (0) owes the base fee, as the builder always did", () => {
  const o = place(60, normal, 0);
  const lines = deliver(o, { courierFee: 0 });
  assert.equal(on(lines, "payable_courier"), 60);
  assert.equal(on(lines, "revenue", "shipping_delivery_margin"), 0);
});

test("CASE I — cloud round-trip keeps shipping 60, compensation 60, courier 60", () => {
  const order = { id: "o1", orderNumber: "ORD-1", shippingFee: 60, wastedTripCompensation: 60, courierFee: 60, totalAmount: 1000, depositAmount: 300, expectedCod: 820 };
  const remote = toRemoteRow("orders", order, { storeId: "33333333-4444-4555-8666-777777777777", deviceId: "11111111-1111-4111-8111-111111111111" });
  assert.deepEqual([remote.shippingFee, remote.wastedTripCompensation, remote.courierFee, remote.expectedCod], [60, 60, 60, 820]);
  const back = fromRemoteRow("orders", remote);
  assert.deepEqual([back.shippingFee, back.wastedTripCompensation, back.courierFee], [60, 60, 60]);
  // A legacy row from before 054 has no such key and still loads.
  const old = fromRemoteRow("orders", { id: "o0", shippingFee: 120 });
  assert.equal(old.wastedTripCompensation ?? 0, 0);
});

test("every money path that totals an order includes the compensation", () => {
  const files = {
    "src/routes/ecommerce-orders.tsx": [/total_price \+ shipping_fee \+ wastedTripCompensation - depositVal/, /full_prepaid"\) return total_price \+ shipping_fee \+ wastedTripCompensation/],
    "src/components/ecommerce/OrdersPage.tsx": [/draftTotal \+ order\.shippingFee \+ \(order\.wastedTripCompensation \?\? 0\) - order\.depositAmount/],
    "src/routes/returns.tsx": [/order\.totalAmount \+ order\.shippingFee \+ \(order\.wastedTripCompensation \?\? 0\)/],
    "src/mobile/screens/MobileOrderDetails.tsx": [/const collected = netGoods \+ shippingFee \+ wastedTripCompensation;/],
  };
  for (const [f, patterns] of Object.entries(files)) for (const p of patterns) assert.match(read(f), p, f);
  assert.match(read("src/mobile/data/mobileReaders.ts"), /"wastedTripCompensation"/, "Mobile reads it from orders_operational");
});

test("054 is additive, guarded, idempotent and extends the Mobile view append-only", () => {
  const sql = read("docs/migrations/054_wasted_trip_compensation.sql");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "wastedTripCompensation" numeric NOT NULL DEFAULT 0/);
  assert.match(sql, /CHECK \("wastedTripCompensation" >= 0\)/);
  assert.match(sql, /IF v_count <> 1 THEN/, "each replaced text must occur exactly once");
  assert.match(sql, /already carries the compensation equation/, "re-running is a no-op");
  assert.doesNotMatch(sql, /\bUPDATE\s+public\.|\bDELETE\s+FROM|TRUNCATE|ledger_events\s+SET/i, "no historical row is rewritten");
  const view = sql.slice(sql.indexOf("CREATE OR REPLACE VIEW public.orders_operational"));
  assert.match(view, /WITH \(security_barrier = true\)/);
  assert.match(view, /deleted_at,\s*"wastedTripCompensation"\s*FROM public\.orders o\s*WHERE public\.is_store_member\(store_id\);/);
  assert.match(view, /THEN "courierFee" ELSE NULL::numeric END AS "courierFee"/, "cost masking kept");
});

test("reports name the new revenue subjects in Arabic", () => {
  const reports = read("src/lib/ledger/reports.ts");
  assert.match(reports, /wasted_trip_compensation: "تعويض رحلة شحن سابقة"/);
  assert.match(reports, /shipping_delivery_margin: "/);
});
