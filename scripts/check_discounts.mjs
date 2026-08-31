/**
 * محرك الخصومات — the discount, the tax it changes, and the money it moves.
 *
 *     node --test scripts/check_discounts.mjs
 *
 * The order of operations this pins:
 *
 *     net   = subtotal − discount          (discount comes off FIRST)
 *     VAT   = net × r / (100 + r)          (extracted from the DISCOUNTED net)
 *     till  = net                          (never more, never negative)
 *
 * Prices are tax-INCLUSIVE, so the discount reduces the grand total and the
 * VAT shown on the receipt falls out of the new total by itself.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { discountAmountFor, includedVat, subtract, round } from "../src/lib/math.ts";
import { buildSaleLines } from "../src/lib/ledger/sales.ts";
import { buildWholesaleInvoiceLines } from "../src/lib/ledger/wholesale.ts";

const amountOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((sum, l) => sum + (l.amount ?? 0), 0);

// ── the two cases the blueprint names ───────────────────────────────────────

test("a 10% discount takes exactly a tenth off", () => {
  assert.equal(discountAmountFor(1000, "percentage", 10), 100);
  assert.equal(subtract(1000, discountAmountFor(1000, "percentage", 10)), 900);
});

test("a fixed 50 ج.م discount takes exactly 50 off", () => {
  assert.equal(discountAmountFor(1000, "fixed", 50), 50);
  assert.equal(subtract(1000, discountAmountFor(1000, "fixed", 50)), 950);
});

// ── the cap: a discount can never exceed the goods ──────────────────────────

test("a percentage over 100 is capped at the subtotal, not left to go negative", () => {
  // `SAVE500` at 500% is a code the discounts screen will happily create.
  assert.equal(discountAmountFor(200, "percentage", 500), 200);
  assert.equal(subtract(200, discountAmountFor(200, "percentage", 500)), 0);
});

test("a fixed discount larger than the cart is capped too", () => {
  assert.equal(discountAmountFor(80, "fixed", 500), 80);
});

test("nonsense values take nothing off rather than throwing", () => {
  for (const bad of [0, -10, NaN, undefined, null]) {
    assert.equal(discountAmountFor(500, "percentage", bad), 0, `value ${String(bad)}`);
    assert.equal(discountAmountFor(500, "fixed", bad), 0, `value ${String(bad)}`);
  }
  assert.equal(discountAmountFor(0, "percentage", 10), 0);
  assert.equal(discountAmountFor(-5, "fixed", 10), 0);
});

test("the discount is money — rounded to piastres, no float dust", () => {
  // 33.33 × 3 = 99.99; 10% of that is 9.999 and must not reach the ledger.
  const d = discountAmountFor(99.99, "percentage", 10);
  assert.equal(d, 10);
  assert.equal(round(d), d, "already rounded");
});

// ── VAT comes out of the DISCOUNTED total ───────────────────────────────────

test("VAT is 14% of the discounted net, not the original", () => {
  const subtotal = 1140;
  const net = subtract(subtotal, discountAmountFor(subtotal, "percentage", 10)); // 1026
  assert.equal(net, 1026);

  const vatBefore = includedVat(subtotal, 14); // 140
  const vatAfter = includedVat(net, 14); // 126
  assert.equal(vatBefore, 140);
  assert.equal(vatAfter, 126);
  assert.ok(vatAfter < vatBefore, "the receipt's tax must fall with the price");

  // Tax-inclusive: the VAT is 14% of the pre-tax part of the DISCOUNTED total.
  assert.equal(round(net - vatAfter), 900, "net of tax");
  assert.equal(round(900 * 0.14), vatAfter);
});

test("no tax rate set means no tax line, discount or not", () => {
  assert.equal(includedVat(subtract(1000, discountAmountFor(1000, "fixed", 50)), 0), 0);
});

// ── POS: what the till receives ─────────────────────────────────────────────

const cart = [{ productId: "p1", quantity: 2, unitPrice: 500, unitCost: 300 }];

test("the till receives the discounted total, exactly", () => {
  const discount = discountAmountFor(1000, "percentage", 10);
  const lines = buildSaleLines({
    items: cart,
    wallet: "inStoreSafe",
    discountAmount: discount,
  });
  assert.equal(amountOn(lines, "wallet"), 900);
  assert.equal(amountOn(lines, "revenue"), 900);
});

test("COGS is untouched by a discount — the goods cost what they cost", () => {
  const plain = buildSaleLines({ items: cart, wallet: "inStoreSafe" });
  const discounted = buildSaleLines({
    items: cart,
    wallet: "inStoreSafe",
    discountAmount: 100,
  });
  assert.equal(amountOn(plain, "cogs"), 600);
  assert.equal(amountOn(discounted, "cogs"), 600, "a promo is not a cheaper purchase");
});

test("customer LTV records what they actually paid", () => {
  const lines = buildSaleLines({
    items: cart,
    wallet: "inStoreSafe",
    customerId: "c1",
    discountAmount: 100,
  });
  assert.equal(amountOn(lines, "customer_ltv"), 900);
});

test("the ledger refuses a discount bigger than the sale", () => {
  // Uncapped, this booked a NEGATIVE wallet line — cash out of the drawer for
  // a sale where nothing was collected.
  assert.throws(
    () => buildSaleLines({ items: cart, wallet: "inStoreSafe", discountAmount: 5000 }),
    /more than the sale is worth/,
  );
  assert.throws(
    () => buildSaleLines({ items: cart, wallet: "inStoreSafe", discountAmount: -1 }),
    /cannot be negative/,
  );
});

// ── Wholesale: debt + cash must equal the discounted invoice ────────────────

const wholesaleItems = [{ productId: "p1", quantity: 10, unitPrice: 100, unitCost: 60 }];

test("debt plus cash equals the discounted total, to the piastre", () => {
  const discount = discountAmountFor(1000, "percentage", 10); // 100 → total 900
  const lines = buildWholesaleInvoiceLines({
    items: wholesaleItems,
    clientId: "client-1",
    wallet: "inStoreSafe",
    paidAmount: 400,
    discountAmount: discount,
  });

  const cash = amountOn(lines, "wallet");
  const debt = amountOn(lines, "receivable_client");
  assert.equal(cash, 400);
  assert.equal(debt, 500, "900 invoiced − 400 paid");
  assert.equal(cash + debt, 900, "must equal the DISCOUNTED grand total");
  assert.equal(amountOn(lines, "revenue"), 900);
});

test("paying the discounted total in full leaves no phantom debt", () => {
  // The exact bug: the client was told 900, paid 900, and the books kept a
  // 100 receivable because the ledger had booked 1000.
  const lines = buildWholesaleInvoiceLines({
    items: wholesaleItems,
    clientId: "client-1",
    wallet: "inStoreSafe",
    paidAmount: 900,
    discountAmount: 100,
  });
  assert.equal(amountOn(lines, "receivable_client"), 0);
  assert.equal(amountOn(lines, "wallet"), 900);
});

test("shipping is charged on top and is not discounted", () => {
  // A promo on the merchandise does not change what the courier costs.
  const lines = buildWholesaleInvoiceLines({
    items: wholesaleItems,
    clientId: "client-1",
    paidAmount: 0,
    discountAmount: 100,
    shippingCharge: 50,
  });
  assert.equal(amountOn(lines, "receivable_client"), 950, "900 goods + 50 delivery");
});

test("an undiscounted invoice is unchanged by the new term", () => {
  const lines = buildWholesaleInvoiceLines({
    items: wholesaleItems,
    clientId: "client-1",
    paidAmount: 0,
  });
  assert.equal(amountOn(lines, "receivable_client"), 1000);
  assert.equal(amountOn(lines, "revenue"), 1000);
});

test("the wholesale ledger refuses an impossible discount", () => {
  assert.throws(
    () =>
      buildWholesaleInvoiceLines({
        items: wholesaleItems,
        clientId: "client-1",
        paidAmount: 0,
        discountAmount: 5000,
      }),
    /more than the goods are worth/,
  );
});

test("paying more than the discounted total is still refused", () => {
  // The guard reads the discounted total, so overpaying is caught at 900.
  assert.throws(
    () =>
      buildWholesaleInvoiceLines({
        items: wholesaleItems,
        clientId: "client-1",
        wallet: "inStoreSafe",
        paidAmount: 950,
        discountAmount: 100,
      }),
    /more than the invoice total/,
  );
});

// ── every line still balances ───────────────────────────────────────────────

test("a discounted sale books cash and revenue as the same number", () => {
  for (const [kind, value] of [["percentage", 10], ["fixed", 50], ["percentage", 33.5]]) {
    const discount = discountAmountFor(1000, kind, value);
    const lines = buildSaleLines({ items: cart, wallet: "inStoreSafe", discountAmount: discount });
    assert.equal(
      amountOn(lines, "wallet"),
      amountOn(lines, "revenue"),
      `${kind} ${value}: till and revenue must agree`,
    );
  }
});


// ── الزيرو-VAT: the shop has no commercial register yet ─────────────────────

test("a zero rate produces no tax line anywhere", () => {
  // The setting is the only switch. Nothing else decides whether tax exists.
  for (const total of [900, 3600, 0.5, 1_000_000]) {
    assert.equal(includedVat(total, 0), 0, `total ${total}`);
  }
});

test("the tax line appears the moment a rate is set, with no other change", () => {
  const net = subtract(1000, discountAmountFor(1000, "percentage", 10)); // 900
  assert.equal(includedVat(net, 0), 0, "hidden today");
  assert.equal(includedVat(net, 14), 110.53, "visible once الإعدادات say 14");
  // The grand total is identical either way — turning VAT on reveals a
  // breakdown, it does not change what the customer pays.
  assert.equal(net, 900);
});

test("a blank or malformed rate is treated as no tax, never as a crash", () => {
  for (const rate of [undefined, null, NaN, -14, ""]) {
    assert.equal(includedVat(900, rate), 0, `rate ${String(rate)}`);
  }
});

// ── the discount survives an order edit ─────────────────────────────────────

/** What OrdersPage now does when the basket changes under a discount code. */
const reprice = (goods, code, storedAmount) =>
  code
    ? discountAmountFor(goods, code.type, code.value)
    : Math.min(storedAmount ?? 0, goods);

test("a percentage re-applies to the edited basket", () => {
  const code = { type: "percentage", value: 10 };
  assert.equal(reprice(1000, code), 100);
  // Remove a line: the discount follows the basket down.
  assert.equal(reprice(600, code), 60);
  assert.equal(subtract(600, reprice(600, code)), 540);
});

test("a deleted code still honours what the customer was promised", () => {
  assert.equal(reprice(1000, undefined, 100), 100);
});

test("a deleted code can never exceed a shrunken basket", () => {
  // Basket edited down to 80 with a 100 discount agreed: charging −20 would
  // mean paying the customer to take the goods.
  assert.equal(reprice(80, undefined, 100), 80);
  assert.equal(subtract(80, reprice(80, undefined, 100)), 0);
});

test("an order with no discount is unaffected by the edit path", () => {
  assert.equal(reprice(1000, undefined, undefined), 0);
  assert.equal(subtract(1000, reprice(1000, undefined, undefined)), 1000);
});
