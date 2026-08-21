/**
 * Wholesale invoice (فاتورة جملة) → ledger lines, and the client debt that
 * has to move BOTH ways.
 *
 *     node --test scripts/check_wholesale_lines.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWholesaleInvoiceLines,
  buildClientPaymentLines,
  wholesaleTotal,
} from "../src/lib/ledger/wholesale.ts";

const amountOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((sum, l) => sum + (l.amount ?? 0), 0);
const qtyOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((sum, l) => sum + (l.qty ?? 0), 0);
const countOn = (lines, account) => lines.filter((l) => l.account === account).length;

const ITEMS = [{ productId: "p-shoe", quantity: 5, unitPrice: 900, unitCost: 700 }];
const CLIENT = "client-7";

test("a fully-credit invoice ships goods and books the whole total as a receivable", () => {
  const lines = buildWholesaleInvoiceLines({ items: ITEMS, clientId: CLIENT });

  // stock, cogs, receivable_client, revenue — counted, not eyeballed.
  assert.equal(lines.length, 4);
  assert.equal(countOn(lines, "stock"), 1);
  assert.equal(countOn(lines, "cogs"), 1);
  assert.equal(countOn(lines, "receivable_client"), 1);
  assert.equal(countOn(lines, "revenue"), 1);
  assert.equal(countOn(lines, "wallet"), 0, "credit must not touch a till");

  assert.equal(qtyOn(lines, "stock"), -5);
  assert.equal(amountOn(lines, "stock"), -3500, "inventory value leaves with the units");
  assert.equal(amountOn(lines, "cogs"), 3500, "5 units at the real 700 cost");
  assert.equal(amountOn(lines, "revenue"), 4500);
  assert.equal(amountOn(lines, "receivable_client"), 4500, "the client owes the whole invoice");
  assert.equal(wholesaleTotal(ITEMS), 4500);
});

test("a part-paid invoice splits into cash in AND a receivable for the rest", () => {
  const lines = buildWholesaleInvoiceLines({
    items: ITEMS,
    clientId: CLIENT,
    wallet: "inStoreSafe",
    paidAmount: 1500,
  });

  assert.equal(countOn(lines, "wallet"), 1);
  assert.equal(countOn(lines, "receivable_client"), 1);
  assert.equal(amountOn(lines, "wallet"), 1500, "cash into the till");
  assert.equal(amountOn(lines, "receivable_client"), 3000);
  // Paid + owed must account for the invoice exactly — no dust either way.
  assert.equal(amountOn(lines, "wallet") + amountOn(lines, "receivable_client"), 4500);
});

test("paying in full writes no receivable; paying nothing writes no wallet line", () => {
  const full = buildWholesaleInvoiceLines({
    items: ITEMS,
    clientId: CLIENT,
    wallet: "inStoreSafe",
    paidAmount: 4500,
  });
  assert.equal(countOn(full, "receivable_client"), 0);
  assert.equal(amountOn(full, "wallet"), 4500);

  const none = buildWholesaleInvoiceLines({
    items: ITEMS,
    clientId: CLIENT,
    wallet: "inStoreSafe",
    paidAmount: 0,
  });
  assert.equal(countOn(none, "wallet"), 0);
  assert.equal(amountOn(none, "receivable_client"), 4500);
});

test("shipping rides on the same event: charge into revenue, cost into expense", () => {
  const lines = buildWholesaleInvoiceLines({
    items: ITEMS,
    clientId: CLIENT,
    shippingCharge: 200,
    shippingCost: 150,
  });

  assert.equal(amountOn(lines, "revenue"), 4700, "goods 4500 + delivery 200");
  assert.equal(amountOn(lines, "receivable_client"), 4700, "the client owes delivery too");
  assert.equal(amountOn(lines, "expense"), 150, "what the delivery actually cost us");
  assert.equal(wholesaleTotal(ITEMS, 200), 4700);

  // Margin on this invoice = revenue − cogs − shipping cost.
  assert.equal(
    amountOn(lines, "revenue") - amountOn(lines, "cogs") - amountOn(lines, "expense"),
    1050,
  );
});

test("free delivery books no expense line at all", () => {
  const lines = buildWholesaleInvoiceLines({ items: ITEMS, clientId: CLIENT });
  assert.equal(countOn(lines, "expense"), 0);
});

test("nonsense quantities, prices and overpayment are refused, not booked", () => {
  assert.throws(
    () =>
      buildWholesaleInvoiceLines({
        items: [{ productId: "x", quantity: 0, unitPrice: 5, unitCost: 1 }],
        clientId: CLIENT,
      }),
    /positive/,
  );
  assert.throws(
    () =>
      buildWholesaleInvoiceLines({
        items: [{ productId: "x", quantity: 1, unitPrice: -5, unitCost: 1 }],
        clientId: CLIENT,
      }),
    /negative/,
  );
  assert.throws(
    () =>
      buildWholesaleInvoiceLines({
        items: ITEMS,
        clientId: CLIENT,
        wallet: "w",
        paidAmount: 9000,
      }),
    /more than the invoice total/,
  );
  assert.throws(
    () => buildWholesaleInvoiceLines({ items: ITEMS, clientId: CLIENT, paidAmount: 100 }),
    /wallet/,
    "cash paid into no till",
  );
});

// ── The other direction: the client pays the debt back down ─────────────────

test("a client payment takes cash in and the receivable down, by the same amount", () => {
  const lines = buildClientPaymentLines({
    clientId: CLIENT,
    wallet: "inStoreSafe",
    amount: 1500,
  });

  assert.equal(lines.length, 2, "wallet + receivable_client, nothing else");
  assert.equal(amountOn(lines, "wallet"), 1500, "cash into the till");
  assert.equal(amountOn(lines, "receivable_client"), -1500, "the debt comes down");
  assert.equal(qtyOn(lines, "stock"), 0, "collecting a debt moves no stock");
});

test("a credit invoice then a payment nets to the remaining debt", () => {
  // The whole point: without the payment event, receivable_client could only
  // ever grow — the same gap the supplier side had.
  const invoiced = buildWholesaleInvoiceLines({ items: ITEMS, clientId: CLIENT }); // +4500
  const paid = buildClientPaymentLines({ clientId: CLIENT, wallet: "w", amount: 3000 });

  const debt = amountOn(invoiced, "receivable_client") + amountOn(paid, "receivable_client");
  assert.equal(debt, 1500, "4500 invoiced, 3000 collected, 1500 left");

  const rest = buildClientPaymentLines({ clientId: CLIENT, wallet: "w", amount: 1500 });
  assert.equal(debt + amountOn(rest, "receivable_client"), 0, "settles exactly, no dust");
});

test("a payment of nothing is refused, not booked as an empty event", () => {
  const bad = { clientId: CLIENT, wallet: "inStoreSafe" };
  assert.throws(() => buildClientPaymentLines({ ...bad, amount: 0 }), /positive/);
  assert.throws(() => buildClientPaymentLines({ ...bad, amount: -50 }), /positive/);
});
