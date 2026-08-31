/**
 * Purchase (توريد) → ledger lines, and the cost chain that feeds COGS.
 *
 *     node --test scripts/check_purchase_lines.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPurchaseLines,
  buildSupplierPaymentLines,
  purchaseTotal,
  averageCost,
} from "../src/lib/ledger/purchases.ts";
import { buildSaleLines } from "../src/lib/ledger/sales.ts";

const amountOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((sum, l) => sum + (l.amount ?? 0), 0);
const qtyOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((sum, l) => sum + (l.qty ?? 0), 0);

const ITEMS = [{ productId: "p-shoe", quantity: 10, unitCost: 600 }];

test("a cash purchase adds stock and takes the money out of the till", () => {
  const lines = buildPurchaseLines({ items: ITEMS, wallet: "inStoreSafe" });

  assert.equal(qtyOn(lines, "stock"), 10);
  assert.equal(amountOn(lines, "stock"), 6000, "stock carries its value, not just its count");
  assert.equal(amountOn(lines, "wallet"), -6000, "cash leaves the till");
  assert.equal(purchaseTotal(ITEMS), 6000);
  assert.equal(lines.filter((l) => l.account === "payable_supplier").length, 0);
});

test("a credit purchase adds stock and owes the supplier instead", () => {
  const lines = buildPurchaseLines({ items: ITEMS, supplierId: "sup-3" });

  assert.equal(qtyOn(lines, "stock"), 10);
  assert.equal(amountOn(lines, "payable_supplier"), 6000, "the debt is the receipt total");
  assert.equal(amountOn(lines, "wallet"), 0, "credit must not touch the till");
});

test("a part-paid receipt splits into cash out AND a debt for the rest", () => {
  const lines = buildPurchaseLines({
    items: ITEMS,
    wallet: "inStoreSafe",
    supplierId: "sup-3",
    paidAmount: 2500,
  });

  // One stock line, one wallet line, one debt line — counted, not eyeballed.
  assert.equal(lines.length, 3);
  assert.equal(lines.filter((l) => l.account === "stock").length, 1);
  assert.equal(lines.filter((l) => l.account === "wallet").length, 1);
  assert.equal(lines.filter((l) => l.account === "payable_supplier").length, 1);

  assert.equal(qtyOn(lines, "stock"), 10, "all 10 arrive, however it was paid");
  assert.equal(amountOn(lines, "stock"), 6000, "stock value is the full receipt");
  assert.equal(amountOn(lines, "wallet"), -2500);
  assert.equal(amountOn(lines, "payable_supplier"), 3500);
  // The money side must account for the receipt exactly: paid + owed = total.
  assert.equal(-amountOn(lines, "wallet") + amountOn(lines, "payable_supplier"), 6000);
});

test("paying the full amount writes no debt line, paying none writes no cash line", () => {
  const full = buildPurchaseLines({
    items: ITEMS,
    wallet: "inStoreSafe",
    supplierId: "sup-3",
    paidAmount: 6000,
  });
  assert.equal(full.length, 2, "stock + wallet only");
  assert.equal(full.filter((l) => l.account === "payable_supplier").length, 0);

  const none = buildPurchaseLines({
    items: ITEMS,
    wallet: "inStoreSafe",
    supplierId: "sup-3",
    paidAmount: 0,
  });
  assert.equal(none.length, 2, "stock + debt only");
  assert.equal(none.filter((l) => l.account === "wallet").length, 0);
  assert.equal(amountOn(none, "payable_supplier"), 6000);
});

test("a purchase must say where the money comes from", () => {
  assert.throws(() => buildPurchaseLines({ items: ITEMS }), /wallet.*supplier/);
  assert.throws(
    () => buildPurchaseLines({ items: ITEMS, wallet: "w", paidAmount: 3000 }),
    /supplier/,
    "part-paid with nobody to owe the rest to",
  );
  assert.throws(
    () => buildPurchaseLines({ items: ITEMS, supplierId: "sup-3", paidAmount: 3000 }),
    /wallet/,
    "cash paid from no till",
  );
  assert.throws(
    () => buildPurchaseLines({ items: ITEMS, wallet: "w", paidAmount: 9000 }),
    /more than the receipt total/,
  );
  assert.throws(
    () => buildPurchaseLines({ items: ITEMS, wallet: "w", paidAmount: -1 }),
    /negative/,
  );
});

test("nonsense quantities and costs are refused, not booked", () => {
  assert.throws(
    () => buildPurchaseLines({ items: [{ productId: "x", quantity: 0, unitCost: 5 }], wallet: "w" }),
    /positive/,
  );
  assert.throws(
    () =>
      buildPurchaseLines({ items: [{ productId: "x", quantity: 1, unitCost: -5 }], wallet: "w" }),
    /negative/,
  );
});

// ── The other direction: paying the debt back down ──────────────────────────

test("a supplier payment takes cash out and the debt down, by the same amount", () => {
  const lines = buildSupplierPaymentLines({
    supplierId: "sup-3",
    wallet: "inStoreSafe",
    amount: 2500,
  });

  assert.equal(lines.length, 2, "wallet + payable_supplier, nothing else");
  assert.equal(lines.filter((l) => l.account === "wallet").length, 1);
  assert.equal(lines.filter((l) => l.account === "payable_supplier").length, 1);

  assert.equal(amountOn(lines, "wallet"), -2500, "cash leaves the till");
  assert.equal(amountOn(lines, "payable_supplier"), -2500, "the debt comes down");
  assert.equal(qtyOn(lines, "stock"), 0, "paying a bill moves no stock");
});

test("a credit receipt then a payment nets to the remaining debt", () => {
  // This is the whole point: before the payment event existed,
  // payable_supplier could only ever grow.
  const received = buildPurchaseLines({ items: ITEMS, supplierId: "sup-3" }); // +6000
  const paid = buildSupplierPaymentLines({
    supplierId: "sup-3",
    wallet: "inStoreSafe",
    amount: 4000,
  });

  const debt = amountOn(received, "payable_supplier") + amountOn(paid, "payable_supplier");
  assert.equal(debt, 2000, "6000 owed, 4000 paid, 2000 left");

  // Paying the rest clears it exactly — no dust left behind.
  const rest = buildSupplierPaymentLines({
    supplierId: "sup-3",
    wallet: "inStoreSafe",
    amount: 2000,
  });
  assert.equal(debt + amountOn(rest, "payable_supplier"), 0);
});

test("a payment of nothing is refused, not booked as an empty event", () => {
  const bad = { supplierId: "sup-3", wallet: "inStoreSafe" };
  assert.throws(() => buildSupplierPaymentLines({ ...bad, amount: 0 }), /positive/);
  assert.throws(() => buildSupplierPaymentLines({ ...bad, amount: -50 }), /positive/);
});

// ── The cost chain: receive → average cost → COGS on sale ───────────────────

test("average cost comes from what was actually paid on receive", () => {
  const lines = buildPurchaseLines({ items: ITEMS, wallet: "inStoreSafe" });
  const stock = { qty: qtyOn(lines, "stock"), amount: amountOn(lines, "stock") };

  assert.equal(averageCost(stock), 600, "10 units at 6000 total = 600 each");
});

test("two receipts at different prices blend into a weighted average", () => {
  // 10 @ 600, then 10 @ 800. Not 700 by luck — by equal quantities.
  const first = buildPurchaseLines({ items: ITEMS, wallet: "w" });
  const second = buildPurchaseLines({
    items: [{ productId: "p-shoe", quantity: 10, unitCost: 800 }],
    wallet: "w",
  });
  const combined = { qty: 20, amount: amountOn(first, "stock") + amountOn(second, "stock") };
  assert.equal(averageCost(combined), 700);

  // Uneven quantities must weight toward the larger receipt.
  const third = buildPurchaseLines({
    items: [{ productId: "p-shoe", quantity: 30, unitCost: 800 }],
    wallet: "w",
  });
  const skewed = { qty: 40, amount: amountOn(first, "stock") + amountOn(third, "stock") };
  assert.equal(averageCost(skewed), 750, "10@600 + 30@800 = 30000/40 = 750");
});

test("a sale books the derived cost, and stock value leaves with the units", () => {
  const purchase = buildPurchaseLines({ items: ITEMS, wallet: "inStoreSafe" });
  const onHand = { qty: qtyOn(purchase, "stock"), amount: amountOn(purchase, "stock") };
  const cost = averageCost(onHand);

  const sale = buildSaleLines({
    items: [{ productId: "p-shoe", quantity: 2, unitPrice: 1000, unitCost: cost }],
    wallet: "inStoreSafe",
  });

  assert.equal(amountOn(sale, "cogs"), 1200, "2 units at the real 600 cost");
  assert.equal(amountOn(sale, "stock"), -1200, "inventory value leaves with the units");
  assert.equal(qtyOn(sale, "stock"), -2);

  // After the sale, the remaining 8 units still cost 600 each — selling at
  // average cost must not move the average.
  const after = {
    qty: onHand.qty + qtyOn(sale, "stock"),
    amount: onHand.amount + amountOn(sale, "stock"),
  };
  assert.equal(after.qty, 8);
  assert.equal(averageCost(after), 600, "selling at average cost leaves the average unchanged");
});

test("empty stock reports zero cost rather than dividing by zero", () => {
  assert.equal(averageCost({ qty: 0, amount: 0 }), 0);
  assert.equal(Number.isFinite(averageCost({ qty: 0, amount: 500 })), true);
  assert.equal(averageCost({ qty: -3, amount: -100 }), 0);
});
