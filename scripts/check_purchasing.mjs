/**
 * المشتريات والموردين — cost in, debt out, and the average that prices sales.
 *
 *     node --test scripts/check_purchasing.mjs
 *
 * Three rules this pins:
 *
 *   a receipt      stock +(qty AND value)   wallet −paid   payable_supplier +owed
 *   an average     amount ÷ qty             the cost every future sale snapshots
 *   a return       stock −                  payable_supplier −   wallet ±surplus
 *
 * A supplier return is NOT a customer return: the goods were never sold, so
 * there is no revenue and no COGS to reverse.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPurchaseLines,
  buildSupplierPaymentLines,
  buildSupplierReturnLines,
  reconcileSupplierReturn,
  averageCost,
  purchaseTotal,
} from "../src/lib/ledger/purchases.ts";

const on = (l, a) => l.filter((x) => x.account === a).reduce((s, x) => s + (x.amount ?? 0), 0);
const qtyOn = (l, a, id) =>
  l.filter((x) => x.account === a && (id === undefined || x.subjectId === id))
    .reduce((s, x) => s + (x.qty ?? 0), 0);

// ── §1 the receipt, including the part-paid case ────────────────────────────

test("a fully paid receipt takes cash and owes nothing", () => {
  const l = buildPurchaseLines({
    items: [{ productId: "p1", quantity: 10, unitCost: 100 }],
    wallet: "inStoreSafe",
    supplierId: "s1",
    paidAmount: 1000,
  });
  assert.equal(qtyOn(l, "stock", "p1"), 10, "the goods arrive");
  assert.equal(on(l, "stock"), 1000, "carrying their value — this is what prices sales");
  assert.equal(on(l, "wallet"), -1000, "cash out of the till");
  assert.equal(on(l, "payable_supplier"), 0);
});

test("a PART-paid receipt splits cash and debt exactly", () => {
  // The case the screen could not produce until المدفوع نقداً existed.
  const l = buildPurchaseLines({
    items: [{ productId: "p1", quantity: 10, unitCost: 100 }],
    wallet: "inStoreSafe",
    supplierId: "s1",
    paidAmount: 400,
  });
  assert.equal(on(l, "wallet"), -400, "only what was handed over");
  assert.equal(on(l, "payable_supplier"), 600, "the rest is owed");
  assert.equal(-on(l, "wallet") + on(l, "payable_supplier"), 1000, "must add up to the receipt");
  assert.equal(on(l, "stock"), 1000, "all the goods arrived regardless of payment");
});

test("a wholly unpaid receipt is pure debt", () => {
  const l = buildPurchaseLines({
    items: [{ productId: "p1", quantity: 10, unitCost: 100 }],
    supplierId: "s1",
    paidAmount: 0,
  });
  assert.equal(on(l, "wallet"), 0, "no wallet line at all");
  assert.equal(on(l, "payable_supplier"), 1000);
});

test("a receipt cannot be over-paid or owed to nobody", () => {
  assert.throws(
    () =>
      buildPurchaseLines({
        items: [{ productId: "p1", quantity: 1, unitCost: 100 }],
        wallet: "inStoreSafe",
        paidAmount: 500,
      }),
    /more than the receipt total/,
  );
  assert.throws(
    () =>
      buildPurchaseLines({
        items: [{ productId: "p1", quantity: 1, unitCost: 100 }],
        wallet: "inStoreSafe",
        paidAmount: 40,
      }),
    /needs a supplier to owe/,
  );
  assert.throws(
    () => buildPurchaseLines({ items: [{ productId: "p1", quantity: 0, unitCost: 100 }], wallet: "w" }),
    /must be positive/,
  );
});

test("paying a supplier down moves cash and debt together", () => {
  const l = buildSupplierPaymentLines({ supplierId: "s1", wallet: "inStoreSafe", amount: 600 });
  assert.equal(on(l, "wallet"), -600);
  assert.equal(on(l, "payable_supplier"), -600);
});

// ── §3 weighted average cost ────────────────────────────────────────────────

test("the blueprint's case: 10 @ 100 then 10 @ 200 averages to 150", () => {
  const first = buildPurchaseLines({
    items: [{ productId: "p1", quantity: 10, unitCost: 100 }],
    wallet: "w",
  });
  const second = buildPurchaseLines({
    items: [{ productId: "p1", quantity: 10, unitCost: 200 }],
    wallet: "w",
  });
  const shelf = {
    qty: qtyOn([...first, ...second], "stock", "p1"),
    amount: on([...first, ...second], "stock"),
  };
  assert.equal(shelf.qty, 20);
  assert.equal(shelf.amount, 3000);
  assert.equal(averageCost(shelf), 150, "the cost every future sale snapshots");
});

test("the average follows what is left after some sold", () => {
  // 20 units worth 3000 (avg 150); sell 5 at that cost → 15 units worth 2250.
  const shelf = { qty: 20 - 5, amount: 3000 - 5 * 150 };
  assert.equal(averageCost(shelf), 150, "selling at the average does not move it");
});

test("an empty or negative shelf prices at zero rather than dividing by zero", () => {
  assert.equal(averageCost({ qty: 0, amount: 0 }), 0);
  assert.equal(averageCost({ qty: -3, amount: 500 }), 0);
});

test("purchaseTotal agrees with the lines it will become", () => {
  const items = [
    { productId: "p1", quantity: 3, unitCost: 99.5 },
    { productId: "p2", quantity: 2, unitCost: 40 },
  ];
  const l = buildPurchaseLines({ items, wallet: "w" });
  assert.equal(purchaseTotal(items), 378.5);
  assert.equal(on(l, "stock"), 378.5);
  assert.equal(on(l, "wallet"), -378.5, "defaults to paying the whole receipt");
});

// ── §2 the supplier return, reconciled ──────────────────────────────────────

/** 5 units that cost us 100 each = 500 going back. */
const backItems = [{ productId: "p1", quantity: 5, unitCost: 100 }];

test("a return smaller than the debt just reduces what we owe", () => {
  const l = buildSupplierReturnLines({
    items: backItems,
    supplierId: "s1",
    wallet: "inStoreSafe",
    currentDebt: 800,
  });
  assert.equal(qtyOn(l, "stock", "p1"), -5, "the goods leave the shelf");
  assert.equal(on(l, "stock"), -500, "and their value leaves with them");
  assert.equal(on(l, "payable_supplier"), -500, "we owe 500 less");
  assert.equal(on(l, "wallet"), 0, "no cash moved — it came off the account");
});

test("the mixed case: return 500 against 800 debt, pay 150 now", () => {
  const r = reconcileSupplierReturn(500, 800, "150");
  assert.deepEqual(r, { remainingDebt: 300, cashBack: 0, paidNow: 150, newDebt: 150 });

  const l = buildSupplierReturnLines({
    items: backItems,
    supplierId: "s1",
    wallet: "inStoreSafe",
    currentDebt: 800,
    paidNow: r.paidNow,
  });
  assert.equal(on(l, "payable_supplier"), -650, "500 of goods + 150 of cash");
  assert.equal(on(l, "wallet"), -150, "cash OUT — we paid them");
  assert.equal(800 + on(l, "payable_supplier"), 150, "the debt left standing");
});

test("a return bigger than the debt brings cash back INTO the till", () => {
  // The direction that differs from a trader's return.
  const l = buildSupplierReturnLines({
    items: backItems,
    supplierId: "s1",
    wallet: "inStoreSafe",
    currentDebt: 300,
  });
  assert.equal(on(l, "payable_supplier"), -300, "cleared, not driven negative");
  assert.equal(on(l, "wallet"), 200, "the supplier refunds the surplus to US");
});

test("a return with no debt at all is a straight refund to us", () => {
  const l = buildSupplierReturnLines({
    items: backItems,
    supplierId: "s1",
    wallet: "inStoreSafe",
    currentDebt: 0,
  });
  assert.equal(on(l, "payable_supplier"), 0, "no debt line — there was none");
  assert.equal(on(l, "wallet"), 500);
});

test("a supplier return reverses NO revenue and NO cogs", () => {
  // The goods were never sold. Reversing COGS here would credit a cost that
  // was never booked and inflate margin on every supplier return.
  const l = buildSupplierReturnLines({
    items: backItems,
    supplierId: "s1",
    wallet: "inStoreSafe",
    currentDebt: 800,
  });
  assert.equal(on(l, "revenue"), 0);
  assert.equal(on(l, "cogs"), 0);
  assert.equal(on(l, "customer_ltv"), 0);
});

test("paying when the return already clears the debt is refused", () => {
  assert.throws(
    () =>
      buildSupplierReturnLines({
        items: backItems,
        supplierId: "s1",
        wallet: "inStoreSafe",
        currentDebt: 300,
        paidNow: 50,
      }),
    /nothing to pay/,
  );
});

test("the panel and the builder land on the same numbers", () => {
  for (const [R, D, P] of [[500, 800, 150], [500, 800, 0], [500, 300, 0], [500, 500, 0], [500, 0, 0]]) {
    const r = reconcileSupplierReturn(R, D, P);
    const l = buildSupplierReturnLines({
      items: [{ productId: "p1", quantity: 1, unitCost: R }],
      supplierId: "s1",
      wallet: "inStoreSafe",
      currentDebt: D,
      paidNow: r.paidNow,
    });
    assert.equal(on(l, "wallet"), r.cashBack - r.paidNow, `wallet R=${R} D=${D} P=${P}`);
    assert.equal(D + on(l, "payable_supplier"), r.newDebt, `debt R=${R} D=${D} P=${P}`);
  }
});

test("a repayment over the remaining debt is clamped, not refused", () => {
  assert.equal(reconcileSupplierReturn(500, 800, "9999").paidNow, 300);
  assert.equal(reconcileSupplierReturn(500, 800, "9999").newDebt, 0);
});

test("nonsense never invents money", () => {
  for (const bad of ["", "abc", undefined, null, NaN, -50]) {
    assert.equal(reconcileSupplierReturn(500, 800, bad).paidNow, 0, `input ${String(bad)}`);
  }
  assert.throws(
    () =>
      buildSupplierReturnLines({
        items: [{ productId: "p1", quantity: -1, unitCost: 100 }],
        supplierId: "s1",
        currentDebt: 0,
      }),
    /must be positive/,
  );
  assert.throws(
    () =>
      buildSupplierReturnLines({
        items: backItems,
        supplierId: "s1",
        currentDebt: -5,
      }),
    /cannot be negative/,
  );
});

test("a return that moves money needs a till to move it through", () => {
  assert.throws(
    () => buildSupplierReturnLines({ items: backItems, supplierId: "s1", currentDebt: 0 }),
    /needs a wallet/,
  );
});

// ── the round trip ──────────────────────────────────────────────────────────

test("buy 10, return 4: the shelf and the average both stay honest", () => {
  const bought = buildPurchaseLines({
    items: [{ productId: "p1", quantity: 10, unitCost: 100 }],
    supplierId: "s1",
    paidAmount: 0,
  });
  const back = buildSupplierReturnLines({
    items: [{ productId: "p1", quantity: 4, unitCost: 100 }],
    supplierId: "s1",
    wallet: "inStoreSafe",
    currentDebt: 1000,
  });
  const all = [...bought, ...back];

  assert.equal(qtyOn(all, "stock", "p1"), 6, "six left on the shelf");
  assert.equal(on(all, "stock"), 600, "worth what they cost");
  assert.equal(averageCost({ qty: 6, amount: 600 }), 100, "the average is untouched");
  assert.equal(on(all, "payable_supplier"), 600, "1000 owed − 400 sent back");
  assert.equal(on(all, "wallet"), 0, "nothing ever crossed the counter");
});
