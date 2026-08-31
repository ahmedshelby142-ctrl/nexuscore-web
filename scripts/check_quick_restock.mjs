/**
 * توريد سريع من صف المنتج — the §1.3 scenario for screen 2.
 *
 * The dialog appends ONE `purchase` event built by `buildPurchaseLines`, the
 * SAME builder شاشة المشتريات uses — there is no second receive path. These
 * tests drive that builder exactly as the dialog does and check the numbers
 * the products row then reads back: `qtyOf` (SUM of stock qty) and `costOf`
 * (the ledger's weighted average).
 *
 * They also cover the supplier half: the dialog writes the matching invoice
 * document, so `supplierTotalsFrom` — the SAME reducer شاشة المشتريات reads —
 * has to move for the supplier who was picked, and only for them.
 *
 *     node --test scripts/check_quick_restock.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildPurchaseLines, averageCost } from "../src/lib/ledger/purchases.ts";
import { supplierTotalsFrom, totalsForSupplier } from "../src/lib/supplierTotals.ts";
import { buildOpeningBalanceLines } from "../src/lib/ledger/audit.ts";
import { buildSaleLines } from "../src/lib/ledger/sales.ts";

const SHOE = "p-shoe";
const WALLET = "inStoreSafe";

/** What the dialog builds for one row. */
const quickRestock = (quantity, unitCost) =>
  buildPurchaseLines({ items: [{ productId: SHOE, quantity, unitCost }], wallet: WALLET });

/** `useStock` reads: qty and value summed over the stock account. */
const stockOf = (lines, productId) =>
  lines
    .filter((l) => l.account === "stock" && l.subjectId === productId)
    .reduce(
      (acc, l) => ({ qty: acc.qty + (l.qty ?? 0), amount: acc.amount + (l.amount ?? 0) }),
      { qty: 0, amount: 0 },
    );

const walletOf = (lines) =>
  lines
    .filter((l) => l.account === "wallet" && l.subjectId === WALLET)
    .reduce((sum, l) => sum + (l.amount ?? 0), 0);

test("a quick توريد of 12 @ 50 puts 12 on the shelf and takes 600 out of the till", () => {
  const lines = quickRestock(12, 50);

  assert.equal(lines.length, 2, "ONE event: a stock line and the cash leaving");
  assert.equal(stockOf(lines, SHOE).qty, 12, "the row's quantity moves immediately");
  assert.equal(stockOf(lines, SHOE).amount, 600, "value rides with the units");
  assert.equal(walletOf(lines), -600, "cash left the chosen wallet");
});

test("it stacks on what the product already had, without a second path", () => {
  // The shop opened with 40 @ 25 (opening balance), then receives 12 @ 50.
  const opening = buildOpeningBalanceLines({ productId: SHOE, quantity: 40, unitCost: 25 });
  const ledger = [...opening, ...quickRestock(12, 50)];

  const stock = stockOf(ledger, SHOE);
  assert.equal(stock.qty, 52, "40 opening + 12 received");
  assert.equal(stock.amount, 40 * 25 + 12 * 50);
  assert.equal(averageCost(stock), 1600 / 52, "one blended cost, not two cost fields");
});

test("the received stock is sellable and comes straight back down", () => {
  const ledger = [...quickRestock(12, 50)];
  const cost = averageCost(stockOf(ledger, SHOE));
  const sale = buildSaleLines({
    items: [{ productId: SHOE, quantity: 2, unitPrice: 90, unitCost: cost }],
    wallet: WALLET,
  });

  assert.equal(stockOf([...ledger, ...sale], SHOE).qty, 10, "12 received − 2 sold");
  assert.equal(cost, 50, "the sale costs what the quick توريد actually paid");
});

test("nonsense is refused rather than booked", () => {
  assert.throws(() => quickRestock(0, 50), /quantity/, "no zero-quantity receipt");
  assert.throws(() => quickRestock(-3, 50), /quantity/);
  assert.throws(() => quickRestock(5, -1), /unit cost/);
});

test("a receipt with no wallet and no supplier is refused", () => {
  assert.throws(
    () => buildPurchaseLines({ items: [{ productId: SHOE, quantity: 1, unitCost: 10 }] }),
    /wallet|supplier/,
    "money has to come from somewhere — the dialog always sends a wallet",
  );
});

// ── The supplier half ───────────────────────────────────────────────────────
// The dialog registers the receipt against a supplier and writes the invoice
// document the purchases screen totals from. These build that document the
// same way the dialog does.

const MORADY = "sup-morady";
const OTHER = "sup-other";

/** The paid-in-full invoice a quick توريد writes. */
const quickInvoice = (supplierId, quantity, unitCost) => ({
  supplierId,
  totalAmount: quantity * unitCost,
  paidAmount: quantity * unitCost,
});

test("a quick توريد moves the chosen supplier's totals by the same amount", () => {
  const lines = buildPurchaseLines({
    items: [{ productId: SHOE, quantity: 12, unitCost: 50 }],
    wallet: WALLET,
    supplierId: MORADY,
    paidAmount: 600,
  });
  const invoices = [quickInvoice(MORADY, 12, 50)];

  // The ledger side is unchanged by naming a supplier on a paid receipt.
  assert.equal(stockOf(lines, SHOE).qty, 12);
  assert.equal(walletOf(lines), -600);
  assert.equal(
    lines.filter((l) => l.account === "payable_supplier").length,
    0,
    "paid in full, so no debt is booked — the supplier is owed nothing",
  );

  // The purchases screen reads this reducer.
  const totals = totalsForSupplier(invoices, MORADY);
  assert.equal(totals.purchased, 600, "the receipt shows in what we bought from them");
  assert.equal(totals.paid, 600, "and in what we handed over");
});

test("the SAME product from a different supplier lands on that supplier only", () => {
  // The owner's point: a product has no fixed supplier. Two receipts of the
  // same item from two suppliers must not blur into one account.
  const invoices = [quickInvoice(MORADY, 12, 50), quickInvoice(OTHER, 5, 60)];
  const totals = supplierTotalsFrom(invoices);

  assert.equal(totals.get(MORADY).purchased, 600);
  assert.equal(totals.get(OTHER).purchased, 300);
  assert.equal(totals.size, 2, "two accounts, not one");
});

test("quick receipts and typed invoices count through the same reducer", () => {
  // A typed credit invoice (half paid) beside a quick cash receipt.
  const typed = { supplierId: MORADY, totalAmount: 1000, paidAmount: 400 };
  const totals = totalsForSupplier([typed, quickInvoice(MORADY, 12, 50)], MORADY);

  assert.equal(totals.purchased, 1600, "1000 invoiced + 600 received quickly");
  assert.equal(totals.paid, 1000, "400 paid on the invoice + 600 cash");
});

test("a supplier with no receipts reads zero, not undefined", () => {
  assert.deepEqual(totalsForSupplier([], MORADY), { purchased: 0, paid: 0 });
});

// ── Bulk receive from المخازن ───────────────────────────────────────────────
// Ticking several rows opens the SAME dialog with several lines. It must stay
// ONE event and ONE invoice — a loop of events would make five products five
// receipts, any of which could half-fail.

const MUG = "p-mug";
const CHARGER = "p-charger";

test("three ticked products become ONE receipt, not three", () => {
  const lines = buildPurchaseLines({
    items: [
      { productId: SHOE, quantity: 10, unitCost: 50 },
      { productId: MUG, quantity: 4, unitCost: 15 },
      { productId: CHARGER, quantity: 6, unitCost: 30 },
    ],
    wallet: WALLET,
    supplierId: MORADY,
    paidAmount: 500 + 60 + 180,
  });

  assert.equal(stockOf(lines, SHOE).qty, 10);
  assert.equal(stockOf(lines, MUG).qty, 4);
  assert.equal(stockOf(lines, CHARGER).qty, 6);
  assert.equal(
    lines.filter((l) => l.account === "wallet").length,
    1,
    "ONE cash line for the whole receipt, not one per product",
  );
  assert.equal(walletOf(lines), -740, "500 + 60 + 180 left the till once");
});

test("a bulk receipt lands on the supplier as a single invoice", () => {
  const invoices = [{ supplierId: MORADY, totalAmount: 740, paidAmount: 740 }];
  assert.deepEqual(totalsForSupplier(invoices, MORADY), { purchased: 740, paid: 740 });
});

test("rows left blank are not received", () => {
  // The dialog filters to lines with a quantity before it builds anything;
  // an empty row must never reach the builder as a zero.
  assert.throws(
    () =>
      buildPurchaseLines({
        items: [
          { productId: SHOE, quantity: 10, unitCost: 50 },
          { productId: MUG, quantity: 0, unitCost: 0 },
        ],
        wallet: WALLET,
      }),
    /quantity/,
    "a zero line is refused by the builder — which is why the dialog drops it first",
  );
});
