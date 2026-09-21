/**
 * Returns / Exchanges / Deposit — the business policy, asserted as money.
 *
 * The nine canonical scenarios, each checked at the LEDGER, not at the label.
 * A test that only read the Arabic wording would pass while the customer was
 * still being billed for the shop's mistake, which is the failure this file
 * exists to make impossible.
 *
 * The two rules everything here turns on:
 *
 *   RESPONSIBILITY FOLLOWS CAUSE, NOT REQUESTER.  A customer asking for a swap
 *   does not make it theirs. If we shipped the wrong item it is ours, however
 *   the request reached us.
 *
 *   A DEPOSIT IS NOT REFUNDED WHEN THE CUSTOMER WALKS AWAY.  It is what made
 *   the order real and the trip was committed on the strength of it.
 *
 * Reference: docs/RETURN_EXCHANGE_POLICY.md
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildOrderCancelledLines,
  buildReturnConfirmedLines,
  buildOrderRTOLines,
} from "../src/lib/ledger/orders.ts";
import {
  shippingBorneBy,
  depositForfeitedOn,
  countsAsWastedTrip,
  blockingCauseReason,
  compensationExpectedFrom,
  causeLabelsFor,
  EXCHANGE_CAUSE_LABELS,
} from "../src/lib/shippingRates.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/**
 * Net amount on an account across the lines of one event, in EGP.
 *
 * The builders speak EGP; `driver.append` is the single boundary that converts
 * to integer piastres. Asserting in piastres here would be testing a
 * conversion that has not happened yet.
 */
const on = (lines, account, subject) =>
  lines
    .filter((l) => l.account === account && (subject === undefined || l.subjectId === subject))
    .reduce((sum, l) => sum + (l.amount ?? 0), 0);

const ITEM = { productId: "A", quantity: 1, unitPrice: 500, unitCost: 300 };

/** A confirmed return, parameterised by the two things that decide the money. */
function bookReturn({ cause, movement, deposit = 0, fee = 40 }) {
  return buildReturnConfirmedLines({
    items: [ITEM],
    refundAmount: 500,
    revenueAmount: 500,
    wallet: "inStoreSafe",
    courierId: "cr1",
    customerId: "c1",
    returnFee: fee,
    movement,
    feeBorneBy: shippingBorneBy(cause, movement),
    forfeitedDeposit: depositForfeitedOn(cause, movement) ? deposit : 0,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 1 · The customer cancels after paying a deposit
// ═══════════════════════════════════════════════════════════════════════════

test("S1 · a cancelled order does not hand the deposit back", () => {
  const lines = buildOrderCancelledLines({
    items: [ITEM],
    forfeitedDeposit: 200,
    wallet: "inStoreSafe",
    customerId: "c1",
  });

  // The cash never moves. `order_placed` banked it; cancelling is the moment it
  // stops being a holding and becomes income.
  assert.equal(on(lines, "wallet"), 0, "a forfeited deposit writes NO wallet line");
  assert.equal(
    on(lines, "revenue", "forfeited_deposit"),
    200,
    "it is recognised as income under its own subject, not netted into sales",
  );
  assert.equal(on(lines, "customer_ltv", "c1"), 200, "LTV mirrors revenue");
  // …and the goods still come back on the shelf, which is the other half of a
  // cancellation and must not be lost to the deposit change.
  assert.equal(
    lines.filter((l) => l.account === "stock").reduce((s, l) => s + (l.qty ?? 0), 0),
    1,
    "the reservation is released",
  );
});

test("S1 · the ONLY cancellation that refunds is one where no order existed", () => {
  // The rollback in شاشة الطلبات الإلكترونية: `order_placed` banked the deposit
  // and then Postgres refused the order document. Forfeiting there would book
  // income against a document that is not there.
  const lines = buildOrderCancelledLines({
    items: [ITEM],
    refundedDeposit: 200,
    wallet: "inStoreSafe",
  });
  assert.equal(on(lines, "wallet", "inStoreSafe"), -200, "the money comes back out");
  assert.equal(on(lines, "revenue", "forfeited_deposit"), 0, "and is NOT recognised as income");
});

test("S1 · a deposit cannot be both kept and refunded", () => {
  assert.throws(
    () =>
      buildOrderCancelledLines({
        items: [ITEM],
        forfeitedDeposit: 100,
        refundedDeposit: 100,
        wallet: "inStoreSafe",
      }),
    /both kept and refunded/,
  );
});

test("S1 · the customer-cancellation call site forfeits, and says so", () => {
  // The screen, not just the builder: passing `refundedDeposit` here would be
  // the old behaviour restored one layer up.
  const orders = strip(read("../src/components/ecommerce/OrdersPage.tsx"));
  const cancel = orders.slice(orders.indexOf("const cancelOrder ="), orders.indexOf("const confirmReturn ="));
  assert.match(cancel, /forfeitedDeposit:/, "the customer's deposit is kept");
  assert.match(cancel, /Math\.min\(order\.depositAmount/, "capped at what was actually paid");
  assert.ok(!/refundedDeposit/.test(cancel), "and never handed back on this path");
  // …and gated on the deposit having actually been BOOKED. A pre-`depositWallet`
  // order holds an amount with no wallet and never wrote a wallet line at
  // placement, so forfeiting it would recognise income against cash the ledger
  // never saw — inventing revenue rather than retaining it.
  assert.match(
    cancel,
    /canonicalWallet\(order\.depositWallet \?\? ""\)\s*\?/,
    "a legacy order with no deposit wallet must forfeit nothing",
  );
  // The old field is gone from the type, so an old call site cannot compile.
  const builders = strip(read("../src/lib/ledger/orders.ts"));
  const iface = builders.slice(
    builders.indexOf("export interface OrderCancelledInput"),
    builders.indexOf("export function buildOrderPlacedLines"),
  );
  assert.ok(!/depositAmount/.test(iface), "OrderCancelledInput must not accept a bare amount");
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIOS 2–4 · Return responsibility
// ═══════════════════════════════════════════════════════════════════════════

test("S2 · a COMPANY-caused return is the company's cost", () => {
  const lines = bookReturn({ cause: "shop", movement: "return", deposit: 200 });
  assert.equal(shippingBorneBy("shop", "return"), "shop");
  assert.equal(on(lines, "expense", "shipping_return"), 40, "the trip is our expense");
  // Not billed onward to anyone: the only receivable line is the refund being
  // settled by the courier, never the fee.
  assert.equal(
    lines.filter((l) => l.account === "receivable_courier" && l.amount === 40).length,
    0,
    "no fee receivable is raised against the courier",
  );
  assert.equal(countsAsWastedTrip("shop", "return"), false, "and no debt lands on the customer");
});

test("S3 · a COURIER-caused return raises compensation, not an expense", () => {
  const lines = bookReturn({ cause: "courier", movement: "return", deposit: 200 });
  assert.equal(shippingBorneBy("courier", "return"), "courier");
  assert.equal(compensationExpectedFrom("courier", "return"), "courier");
  assert.equal(on(lines, "expense"), 0, "the shop never bore the cost");
  // We owe them for the trip and they owe us for causing it: the two cancel,
  // which is what compensation looks like against a settled account.
  assert.equal(on(lines, "payable_courier", "cr1"), 40);
  assert.equal(
    lines.filter((l) => l.account === "receivable_courier" && l.amount === 40).length,
    1,
    "the fee is raised as a receivable against the courier",
  );
  assert.equal(countsAsWastedTrip("courier", "return"), false, "not the customer's debt");
});

test("S4 · a CUSTOMER-caused return keeps the deposit and charges the trip", () => {
  const lines = bookReturn({ cause: "customer", movement: "return", deposit: 200 });
  assert.equal(shippingBorneBy("customer", "return"), "customer");
  assert.equal(depositForfeitedOn("customer", "return"), true, "the deposit is NOT refunded");
  assert.equal(on(lines, "revenue", "forfeited_deposit"), 200, "…and is booked as income");
  assert.equal(on(lines, "expense"), 0, "the trip is not the shop's cost");
  assert.equal(countsAsWastedTrip("customer", "return"), true, "the wasted trip is theirs");
  // The refund actually handed over is reduced by the retained deposit.
  assert.equal(on(lines, "wallet", "inStoreSafe"), -300, "500 paid − 200 kept = 300 out");
});

test("S2/S3 · a deposit is only ever kept on a movement the customer caused", () => {
  assert.equal(depositForfeitedOn("shop", "return"), false);
  assert.equal(depositForfeitedOn("courier", "return"), false);
  // Forfeiting on our own mistake would mean profiting from it.
  const shopReturn = bookReturn({ cause: "shop", movement: "return", deposit: 200 });
  assert.equal(on(shopReturn, "revenue", "forfeited_deposit"), 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIOS 5–9 · Exchange responsibility — the correction
// ═══════════════════════════════════════════════════════════════════════════

test("S5 · a COMPANY-caused exchange is NOT customer-paid", () => {
  assert.equal(shippingBorneBy("shop", "exchange"), "shop", "our mistake, our cost");
  const lines = bookReturn({ cause: "shop", movement: "exchange" });
  assert.equal(on(lines, "expense", "shipping_return"), 40, "the swap trip is our expense");
});

test("S6 · a COURIER-caused exchange uses the compensation path", () => {
  assert.equal(shippingBorneBy("courier", "exchange"), "courier");
  assert.equal(compensationExpectedFrom("courier", "exchange"), "courier");
  const lines = bookReturn({ cause: "courier", movement: "exchange" });
  assert.equal(on(lines, "expense"), 0, "never the shop's expense");
  assert.equal(
    lines.filter((l) => l.account === "receivable_courier" && l.amount === 40).length,
    1,
    "compensation is owed to us",
  );
});

test("S7 · a VOLUNTARY customer exchange IS customer-paid", () => {
  // The one case that is genuinely theirs, and the reason the model is not
  // simply "the shop always pays".
  assert.equal(shippingBorneBy("customer", "exchange"), "customer");
  assert.equal(compensationExpectedFrom("customer", "exchange"), null);
  const lines = bookReturn({ cause: "customer", movement: "exchange" });
  assert.equal(on(lines, "expense"), 0, "a pass-through, not our cost");
  assert.equal(on(lines, "payable_courier", "cr1"), 40, "we still owe the courier");
});

test("S8/S9 · company fault and product defect are the SAME cause, and not the customer's", () => {
  // The distinction the model must NOT try to draw: who asked. A customer
  // requesting a swap because we sent the wrong item, and one requesting it
  // because the item is faulty, are both `shop` — the cause, not the requester.
  //
  // `EXCHANGE_CAUSE_LABELS.shop` names both out loud for exactly this reason,
  // so an operator does not reach for «العميلة» because the customer rang up.
  assert.match(EXCHANGE_CAUSE_LABELS.shop, /خطأ من المحل/);
  assert.match(EXCHANGE_CAUSE_LABELS.shop, /عيب في المنتج/);
  assert.equal(shippingBorneBy("shop", "exchange"), "shop");
  assert.equal(on(bookReturn({ cause: "shop", movement: "exchange" }), "expense"), 40);
});

test("an exchange never forfeits the deposit — the same money funds the swap", () => {
  for (const cause of ["customer", "courier", "shop", "unknown"]) {
    assert.equal(depositForfeitedOn(cause, "exchange"), false, cause);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// The blanket rule, refused at the point of writing
// ═══════════════════════════════════════════════════════════════════════════

test("an unclassified movement cannot be confirmed", () => {
  assert.ok(blockingCauseReason("unknown", "exchange"), "an exchange needs a cause");
  assert.ok(blockingCauseReason("unknown", "return"), "so does a return");
  for (const cause of ["customer", "courier", "shop"]) {
    assert.equal(blockingCauseReason(cause, "return"), null, cause);
    assert.equal(blockingCauseReason(cause, "exchange"), null, cause);
  }
});

test("the 'unknown' fallback survives for HISTORY only", () => {
  // It must keep answering, because every pre-migration-026 row is 'unknown'
  // and re-deciding them would move historical figures…
  assert.equal(shippingBorneBy("unknown", "exchange"), "customer");
  assert.equal(shippingBorneBy("unknown", "return"), "shop");
  // …and it must be unreachable for anything new.
  assert.ok(blockingCauseReason("unknown", "exchange"));
});

test("both confirm handlers refuse an unclassified movement, not just the buttons", () => {
  // A disabled button is a courtesy. The handler is where the ledger event
  // becomes permanent, and a dialog can sit open while state changes under it.
  for (const path of [
    "../src/components/ecommerce/OrdersPage.tsx",
    "../src/routes/returns.tsx",
  ]) {
    const src = strip(read(path));
    assert.match(
      src,
      /blockingCauseReason\([\s\S]{0,40}\)\s*;?\s*\n?\s*if \(/,
      `${path} must re-check before writing`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Wording · the UI must communicate CAUSE, not a blanket rule
// ═══════════════════════════════════════════════════════════════════════════

test("the exchange wording names the cause, and the customer case is voluntary", () => {
  assert.equal(causeLabelsFor("exchange"), EXCHANGE_CAUSE_LABELS);
  assert.match(EXCHANGE_CAUSE_LABELS.customer, /تغيير رغبة/, "the voluntary case, named");
  assert.ok(
    !/^العميل/.test(EXCHANGE_CAUSE_LABELS.customer),
    "a bare «العميل» on a swap reads as the requester, not the cause",
  );
  assert.match(EXCHANGE_CAUSE_LABELS.courier, /خطأ من المندوب/);
});

test("no active screen claims a blanket exchange charge", () => {
  // The banned phrasings, allowed only where they are conditional on the
  // voluntary case — which, in a label map keyed by cause, they always are.
  for (const path of [
    "../src/components/ecommerce/OrdersPage.tsx",
    "../src/routes/returns.tsx",
    "../src/routes/ecommerce-orders.tsx",
    "../src/lib/exchange.ts",
  ]) {
    const src = strip(read(path));
    assert.ok(!/الاستبدال على العميل/.test(src), `${path}: blanket exchange charge`);
    assert.ok(!/العميل يدفع الاستبدال/.test(src), `${path}: blanket exchange charge`);
    assert.ok(!/المرتجع على العميل/.test(src), `${path}: blanket return charge`);
  }
});

test("the screens show WHO PAYS before the operator commits", () => {
  const orders = strip(read("../src/components/ecommerce/OrdersPage.tsx"));
  assert.match(orders, /المسؤول المالي/, "the financial responsibility is stated");
  assert.match(orders, /تعويض من شركة الشحن/, "including the courier-compensation case");
});

// ═══════════════════════════════════════════════════════════════════════════
// Authorization · responsibility is not a client-only accounting field
// ═══════════════════════════════════════════════════════════════════════════

test("the cause is carried on the ledger event, not only on the document", () => {
  // A document field alone could be edited by any role that may write the
  // table. The event payload is append-only and cannot be updated by anyone.
  const orders = strip(read("../src/components/ecommerce/OrdersPage.tsx"));
  assert.match(orders, /payload:[\s\S]{0,300}return_cause: cause/, "recorded on the event");
  const returns = strip(read("../src/routes/returns.tsx"));
  assert.match(returns, /return_cause: counterCause/, "and on the counter document");
});

test("MODERATOR cannot record a responsibility at all", () => {
  // Read-only is enforced in Postgres — it appears in no `has_role` array — and
  // desktop gives it no screen that writes one.
  const roles = strip(read("../src/lib/roles.ts"));
  const access = roles.slice(roles.indexOf("const ROUTE_ACCESS"), roles.indexOf("const ROLE_HOME"));
  const returnsLine = access.match(/"\/returns": \[[^\]]*\]/)[0];
  assert.ok(!returnsLine.includes("MODERATOR"));
  assert.ok(!access.includes('"/orders": ["MODERATOR"'));
});
