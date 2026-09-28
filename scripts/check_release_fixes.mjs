/**
 * Final release fix pass — one regression per confirmed defect.
 *
 *     node --test scripts/check_release_fixes.mjs
 *
 * Pure rules are exercised with the app's own functions; wiring that only a
 * database can prove (row locks, RLS, the cause trigger) is asserted here on
 * the source and was exercised against migration 050 inside a rolled-back
 * transaction on the live project (see the release report).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/"))
      return next(new URL(`src/${specifier.slice(2)}.ts`, root).href, context);
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const R = await import(new URL("src/lib/shippingRates.ts", root).href);
const O = await import(new URL("src/lib/ledger/orders.ts", root).href);
const { computeShortages } = await import(new URL("src/lib/shortages.ts", root).href);

const migration = read("docs/migrations/050_release_fixes.sql");
const ordersPage = read("src/components/ecommerce/OrdersPage.tsx");
const orderForm = read("src/routes/ecommerce-orders.tsx");
const orderStore = read("src/store/useOrderStore.ts");
const customerStore = read("src/store/useCustomerStore.ts");

// ═══ A. Customer-caused shipping penalty — preserved, finite, one trip at a time ═══

/**
 * The customer's journey as the app runs it: `countsAsWastedTrip` → +1 on
 * confirmation (`recordReturn`), `shippingFeeFor` prices the next order,
 * `clearsShippingDebt` on delivery → −1 (`settleWastedTrip`, floored at 0).
 */
function deliverNext(owed, base = 60) {
  const fee = R.shippingFeeFor(base, { returned_orders_count: owed });
  const order = { shippingPenaltyApplied: fee > base ? true : undefined };
  const after = R.clearsShippingDebt(order) ? Math.max(0, owed - 1) : owed;
  return { fee, after };
}
function wasteTrips(n) {
  let owed = 0;
  for (let i = 0; i < n; i++) if (R.countsAsWastedTrip("customer", "return")) owed += 1;
  return owed;
}

test("A.1 one owed trip → next delivery 120 → debt 0", () => {
  const owed = wasteTrips(1);
  assert.equal(owed, 1);
  const d = deliverNext(owed);
  assert.deepEqual(d, { fee: 120, after: 0 });
  assert.equal(deliverNext(d.after).fee, 60, "back to normal");
});

test("A.2 two owed trips → 120, 120, then 60 (base + base, never base × count)", () => {
  let owed = wasteTrips(2);
  const fees = [];
  for (let i = 0; i < 3; i++) {
    const d = deliverNext(owed);
    fees.push(d.fee);
    owed = d.after;
  }
  assert.deepEqual(fees, [120, 120, 60]);
  assert.equal(owed, 0);
});

test("A.3 three owed trips → 3 → 2 → 1 → 0, then normal 60", () => {
  let owed = wasteTrips(3);
  const trail = [owed];
  const fees = [];
  while (owed > 0) {
    const d = deliverNext(owed);
    fees.push(d.fee);
    owed = d.after;
    trail.push(owed);
  }
  assert.deepEqual(trail, [3, 2, 1, 0]);
  assert.deepEqual(fees, [120, 120, 120], "one extra trip per delivery — no multiplier, no N+1");
  assert.equal(deliverNext(0).fee, 60);
});

test("A.4 courier- or shop-caused returns, and exchanges, create no debt", () => {
  for (const cause of ["courier", "shop"]) {
    assert.equal(R.countsAsWastedTrip(cause, "return"), false, cause);
  }
  for (const cause of ["customer", "courier", "shop"]) {
    assert.equal(R.countsAsWastedTrip(cause, "exchange"), false, `exchange/${cause}`);
  }
});

test("A.5 the counters: +1 per trip, −1 per settled delivery, never below 0, consumed once", () => {
  assert.match(
    customerStore,
    /returned_orders_count: \(current\.returned_orders_count \?\? 0\) \+ 1/,
  );
  assert.match(customerStore, /Math\.max\(0, \(current\.returned_orders_count \?\? 0\) - 1\)/);
  // Delivery consumes the debt only on the order that charged it, and clears
  // the flag so a replay cannot consume it twice.
  assert.match(ordersPage, /clearsShippingDebt\(order\)/);
  assert.match(ordersPage, /shippingPenaltyApplied: false/);
  // Migration 050 counts the trip with exactly the same rule.
  assert.match(migration, /p_cause = 'customer' AND p_movement = 'return'/);
  assert.match(migration, /returned_orders_count = COALESCE\(returned_orders_count, 0\) \+ 1/);
});

// ═══ B. Couriers — one shared authority ═══

test("B.1 couriers live in the cloud, not in one browser", () => {
  const store = read("src/store/useCourierStore.ts");
  assert.doesNotMatch(store, /persist\(/, "no localStorage copy");
  assert.match(store, /writeThrough\("couriers"/);
  assert.match(
    read("src/services/cloudHydrate.ts"),
    /couriers: \(rows\) => useCourierStore\.setState\(\{ accounts: rows \}\)/,
  );
  assert.match(read("src/services/api/cloudSchema.ts"), /couriers: \{/);
});

// ═══ C. Exchange — one trip, one charge ═══

const RATES = [{ id: "r", governorate: "القاهرة", delivery: 60, return: 60, exchange: 75 }];
const item = { productId: "p", quantity: 1, unitPrice: 500, unitCost: 200 };
/** Every courier line one swap books: the replacement's delivery + the original's return. */
function swap(cause) {
  const base = R.rateFor(RATES, "القاهرة", "exchange");
  const replacementFee =
    R.shippingBorneBy(cause, "exchange") === "customer" ? R.shippingFeeFor(base, null) : 0;
  const delivered = O.buildOrderDeliveredLines({
    items: [item],
    goodsTotal: 500,
    shippingFee: replacementFee,
    depositAmount: 0,
    codAmount: 500 + replacementFee,
    courierId: "k",
    customerId: "c",
    channel: "ecommerce",
  });
  const locked = R.lockedExchangeCause("exchange", cause) ?? cause;
  const returned = O.buildReturnConfirmedLines({
    items: [item],
    refundAmount: 500,
    revenueAmount: 500,
    wallet: "inStoreSafe",
    refundVia: "wallet",
    returnFee: R.exchangeReturnFee(base, replacementFee),
    movement: "exchange",
    feeBorneBy: R.shippingBorneBy(locked, "exchange"),
    courierId: "k",
    customerId: "c",
    channel: "ecommerce",
  });
  const sum = (lines, account) =>
    lines.filter((l) => l.account === account).reduce((s, l) => s + (l.amount ?? 0), 0);
  const all = [...delivered, ...returned];
  return {
    customerPays: replacementFee,
    courierOwed: sum(all, "payable_courier"),
    courierOwesBack: sum(returned, "receivable_courier"),
    shopExpense: sum(all, "expense"),
  };
}

test("C.1 normal delivery: customer 60, courier 60", () => {
  const lines = O.buildOrderDeliveredLines({
    items: [item],
    goodsTotal: 500,
    shippingFee: 60,
    depositAmount: 0,
    codAmount: 560,
    courierId: "k",
    customerId: "c",
    channel: "ecommerce",
  });
  assert.equal(
    lines.filter((l) => l.account === "payable_courier").reduce((s, l) => s + l.amount, 0),
    60,
  );
});

test("C.2 shop-caused exchange: customer 0, shop 75, courier paid once (75)", () => {
  assert.deepEqual(swap("shop"), {
    customerPays: 0,
    courierOwed: 75,
    courierOwesBack: 0,
    shopExpense: 75,
  });
});

test("C.3 customer-caused exchange: customer 75, courier paid once (75), shop 0", () => {
  assert.deepEqual(swap("customer"), {
    customerPays: 75,
    courierOwed: 75,
    courierOwesBack: 0,
    shopExpense: 0,
  });
});

test("C.4 courier-caused exchange: customer 0, shop 0, courier's own trip nets to 0", () => {
  assert.deepEqual(swap("courier"), {
    customerPays: 0,
    courierOwed: 75,
    courierOwesBack: 75,
    shopExpense: 0,
  });
});

test("C.5 the form asks WHY before it prices the swap, and records it on the original first", () => {
  assert.match(
    orderForm,
    /exchangeChargesCustomer = !isExchange \|\| shippingBorneBy\(exchangeCause, "exchange"\) === "customer"/,
  );
  assert.match(
    orderForm,
    /if \(isExchange && blockingCauseReason\(exchangeCause, "exchange"\)\) return false;/,
  );
  const causeWrite = orderForm.indexOf("return_cause: exchangeCause");
  const placement = orderForm.indexOf("const placed = await placeOrder(");
  assert.ok(
    causeWrite > 0 && causeWrite < placement,
    "cause is written (and the trigger asked) before any stock or money moves",
  );
  // …and the confirmation reuses it rather than asking again.
  assert.match(
    ordersPage,
    /lockedExchangeCause\(movement, order\.return_cause\) \?\? confirmCause/,
  );
  assert.match(ordersPage, /exchangeReturnFee\(/);
  assert.equal(
    R.lockedExchangeCause("return", "shop"),
    null,
    "a plain return is still picked at confirmation",
  );
  assert.equal(
    R.lockedExchangeCause("exchange", "unknown"),
    null,
    "a legacy swap with no recorded cause is still picked",
  );
});

// ═══ D. Return confirmation — all or nothing ═══

test("D.1 confirmation is ONE call: events, stamp, cause and trip together", () => {
  const body = ordersPage.slice(
    ordersPage.indexOf("const confirmReturn = async"),
    ordersPage.indexOf("const markReturnPending"),
  );
  assert.match(body, /confirmOrderReturn\(\{/);
  const retail = body.slice(
    body.indexOf(
      'kind: "return_confirmed",\n          actor: "أونلاين",\n          refType: "ecommerce_order"',
    ),
  );
  assert.doesNotMatch(retail, /recordReturn\(/, "no separate trip write");
  assert.doesNotMatch(
    retail,
    /updateOrder\(order\.id, \{ returnConfirmedAt/,
    "no separate stamp write",
  );
  assert.doesNotMatch(
    body,
    /await appendEvent\(\{\s*kind: "(rto_confirmed|return_confirmed)",\s*actor: "أونلاين",\s*refType: "ecommerce_order"/,
    "retail events are not sent on their own",
  );
  assert.match(orderStore, /sb\.rpc\("confirm_order_return"/);
});

test("D.2 the RPC locks, refuses a repeat, and never swallows a ledger refusal", () => {
  assert.match(migration, /FOR UPDATE;/);
  assert.match(
    migration,
    /"returnConfirmedAt" IS NOT NULL THEN\s+RAISE EXCEPTION 'NEXUS_RETURN_ALREADY_CONFIRMED'/,
  );
  assert.match(migration, /NEXUS_EVENT_NOT_THIS_ORDER/);
  const fn = migration.slice(
    migration.indexOf("FUNCTION public.confirm_order_return"),
    migration.indexOf("REVOKE ALL ON FUNCTION public.confirm_order_return"),
  );
  assert.doesNotMatch(fn, /\bEXCEPTION\s+WHEN\b/i, "043: no subtransaction around ledger_append");
  assert.doesNotMatch(fn, /SAVEPOINT/i);
  assert.doesNotMatch(fn, /SECURITY DEFINER/, "RLS and the cause trigger decide, as before");
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.confirm_order_return\(text, text, text, jsonb, text\) FROM public, anon;/,
  );
});

test("D.3 refusals reach the operator in Arabic", () => {
  assert.match(
    orderStore,
    /NEXUS_RETURN_ALREADY_CONFIRMED"\)\) return "المرتجع ده اتأكد استلامه قبل كده\."/,
  );
  assert.match(orderStore, /NEXUS_CAUSE_NOT_AUTHORISED/);
});

test("D.4 cancellation is one transaction, so a refused cause moves nothing", () => {
  // Superseded the interim "cause first" ordering: since 051 the cause, the
  // status and the event land together in `cancel_order` (check_finance_records CX).
  const body = ordersPage.slice(
    ordersPage.indexOf("const cancelOrder = async"),
    ordersPage.indexOf("const confirmReturn = async"),
  );
  assert.match(body, /useOrderStore\.getState\(\)\.cancelOrder\(\{/);
  assert.doesNotMatch(body, /await appendEvent\(/);
});

// ═══ E. Shortages — Desktop = Mobile = Quick Restock = WhatsApp need ═══

const products = (stock) =>
  Object.entries(stock).map(([id, q]) => ({ id, name: id, sku: id, totalQuantity: q }));
const line = (productId, quantity, shortfall) => ({
  productId,
  quantity,
  ...(shortfall === undefined ? {} : { shortfall }),
});

test("E.1 none", () => {
  assert.deepEqual(computeShortages([], products({ a: 5 })), []);
});

test("E.2 one: 27 on hand, order of 30 (already deducted → ledger −3) is short 3, not 33", () => {
  const rows = computeShortages(
    [{ id: "o1", status: "pending", stockItems: [line("a", 30, 3)] }],
    products({ a: -3 }),
  );
  assert.equal(rows[0].deficit, 3);
});

test("E.3 a pending order that the shelf covered is not a shortage", () => {
  assert.deepEqual(
    computeShortages(
      [{ id: "o1", status: "pending", stockItems: [line("a", 4, 0)] }],
      products({ a: 1 }),
    ),
    [],
  );
});

test("E.4 several products, multiple pending orders", () => {
  const rows = computeShortages(
    [
      { id: "o1", status: "pending", stockItems: [line("a", 30, 3)] },
      { id: "o2", status: "pending", stockItems: [line("a", 2, 2), line("c", 1, 1)] },
    ],
    products({ a: -5, c: -1 }),
  );
  assert.deepEqual(
    rows.map((r) => [r.productId, r.deficit, r.orderCount]),
    [
      ["a", 5, 2],
      ["c", 1, 1],
    ],
  );
});

test("E.5 delivered, cancelled and deleted orders are out", () => {
  for (const status of ["shipped", "delivered", "cancelled", "returned"]) {
    assert.deepEqual(
      computeShortages([{ id: "o", status, stockItems: [line("a", 9, 9)] }], products({ a: 0 })),
      [],
      status,
    );
  }
});

test("E.6 mobile_shortages computes the same deficit", () => {
  const fn = migration.slice(migration.indexOf("FUNCTION public.mobile_shortages"));
  assert.match(fn, /line->>'shortfall'/);
  assert.match(fn, /line->>'backorder'\) = 'true' THEN qty/);
  assert.match(fn, /d\.owed - GREATEST\(COALESCE\(h\.stock, 0\), 0\)/);
  assert.match(fn, /o\.status IN \('pending'\)/);
  assert.match(fn, /o\.deleted_at IS NULL/);
  assert.match(
    fn,
    /VARIADIC ARRAY\['ADMIN', 'ACCOUNTANT', 'ECOMMERCE_ONLY', 'MODERATOR'\]/,
    "role gate unchanged",
  );
});

// ═══ F. Partners — shared business data ═══

test("F.1 partners are a cloud table: schema, hydrate, archived rows still listed", () => {
  const schema = read("src/services/api/cloudSchema.ts");
  assert.match(
    schema,
    /partners: \{[\s\S]*?rename: \{ deleted_at: "archived_at" \},\s*keepsArchived: true,/,
  );
  assert.match(
    read("src/services/cloudData.ts"),
    /CLOUD_SCHEMA\[table\]\?\.keepsArchived === true/,
  );
  assert.match(
    read("src/services/cloudHydrate.ts"),
    /partners: \(rows\) => useBusinessStore\.setState\(\{ partners: rows \}\)/,
  );
});

test("F.2 writes go to the cloud first; nothing is persisted per browser", () => {
  const store = read("src/store/useBusinessStore.ts");
  assert.match(store, /commitRow\(set, "partners", "partners", row\)/);
  assert.match(store, /removeRow\(set, "partners", "partners", id\)/);
  const part = store.slice(store.indexOf("partialize:"));
  assert.doesNotMatch(part.slice(0, part.indexOf("}),")), /partners: state\.partners/);
  // Old local partners are handed to an explicit upload, never pushed silently.
  assert.match(store, /localStorage\.setItem\(LEGACY_PARTNERS_KEY/);
});

test("F.3 only ADMIN/ACCOUNTANT read or write partners; equity stays within 0–100", () => {
  assert.match(migration, /m\.role IN \('ADMIN', 'ACCOUNTANT'\)/);
  assert.match(migration, /has_role\(store_id, VARIADIC ARRAY\['ADMIN', 'ACCOUNTANT'\]\)/);
  assert.match(migration, /CHECK \("equityPercentage" >= 0 AND "equityPercentage" <= 100\)/);
  assert.match(migration, /REVOKE ALL ON public\.partners FROM anon;/);
});

// ═══ H/I. Truthful settings; mandatory deposit unchanged ═══

test("H.1 no screen claims a sync, tracking, commission or branch scoping that does not exist", () => {
  const settings = read("src/routes/settings.tsx");
  assert.doesNotMatch(settings, /مزامنة تلقائية نشطة/);
  assert.doesNotMatch(settings, /قنوات الربط النشطة/);
  assert.match(settings, /تتبع المناديب الآلي/);
  assert.match(settings, /حساب عمولات موظفي المبيعات والمناديب"\s+description="غير متاح حاليًا\."/);
  assert.doesNotMatch(read("src/routes/branches.tsx"), /عند تفعيل النطاق/);
  assert.doesNotMatch(read("src/components/dashboard/ExecutiveDashboard.tsx"), /ترقية إلى Pro/);
});

test("I.1 mandatory deposit: a positive deposit is required when the owner turned it on — nothing more", () => {
  assert.match(orderForm, /if \(depositMandatory && depositVal <= 0\) return false;/);
});
