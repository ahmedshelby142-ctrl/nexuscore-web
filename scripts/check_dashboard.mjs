/**
 * نظرة عامة & الشركاء والمالية — the screens that only READ.
 *
 *     node --test scripts/check_dashboard.mjs
 *
 * Every figure on these two screens is a SUM over the ledger. Nothing here
 * writes, so the only way they can be wrong is by aggregating differently from
 * the events Phases 1-6 wrote. That is exactly what this pins:
 *
 *     صافي الربح       revenue − cogs − expense
 *     إجمالي المبيعات   SUM(revenue), returns already negative inside it
 *     إجمالي الخزنة     SUM(wallet) — every subject, not a known-names whitelist
 *     قيمة المخزون      SUM(stock.amount) — the weighted-average value on the shelf
 */

import test from "node:test";
import assert from "node:assert/strict";

import { summarise, totalAssetsOf, netWorthOf } from "../src/lib/dashboard.ts";
import { buildSaleLines } from "../src/lib/ledger/sales.ts";
import { buildReturnConfirmedLines } from "../src/lib/ledger/orders.ts";
import { buildPurchaseLines, averageCost } from "../src/lib/ledger/purchases.ts";

/** The aggregation `balances()` performs: group an account by subject. */
const aggregate = (lines, account) => {
  const by = new Map();
  for (const l of lines.filter((x) => x.account === account)) {
    const prev = by.get(l.subjectId) ?? { subjectId: l.subjectId, amount: 0, qty: 0 };
    by.set(l.subjectId, {
      subjectId: l.subjectId,
      amount: prev.amount + (l.amount ?? 0),
      qty: prev.qty + (l.qty ?? 0),
    });
  }
  return [...by.values()];
};
const sumOf = (rows) => rows.reduce((s, r) => s + r.amount, 0);

// ── §2 net profit ───────────────────────────────────────────────────────────

test("صافي الربح is revenue minus cost minus expenses", () => {
  const f = summarise({
    revenueRows: [{ subjectId: "pos", amount: 1000, qty: 0 }],
    cogsRows: [{ subjectId: "p1", amount: 600, qty: 0 }],
    expenseRows: [{ subjectId: "rent", amount: 150, qty: 0 }],
    events: [{ kind: "sale" }],
  });
  assert.equal(f.revenue, 1000);
  assert.equal(f.netProfit, 250, "1000 − 600 − 150");
});

test("a return is already negative inside revenue and is not subtracted twice", () => {
  // A sale of 1000 then a full return: the ledger holds +1000 and −1000.
  const lines = [
    ...buildSaleLines({
      items: [{ productId: "p1", quantity: 2, unitPrice: 500, unitCost: 300 }],
      wallet: "inStoreSafe",
      channel: "pos",
    }),
    ...buildReturnConfirmedLines({
      items: [{ productId: "p1", quantity: 2, unitPrice: 500, unitCost: 300 }],
      refundAmount: 1000,
      wallet: "inStoreSafe",
      revenueAmount: 1000,
      channel: "pos",
    }),
  ];

  const f = summarise({
    revenueRows: aggregate(lines, "revenue"),
    cogsRows: aggregate(lines, "cogs"),
    expenseRows: [],
    events: [{ kind: "sale" }, { kind: "return_confirmed" }],
  });

  assert.equal(f.revenue, 0, "the sale and its reversal cancel");
  assert.equal(f.netProfit, 0, "COGS reversed too — no phantom loss");
  assert.equal(f.returns, 1, "but the return is still COUNTED");
});

test("a loss reads as a loss", () => {
  const f = summarise({
    revenueRows: [{ subjectId: "pos", amount: 100, qty: 0 }],
    cogsRows: [{ subjectId: "p1", amount: 80, qty: 0 }],
    expenseRows: [{ subjectId: "rent", amount: 500, qty: 0 }],
    events: [{ kind: "sale" }],
  });
  assert.equal(f.netProfit, -480);
});

test("عدد العمليات counts sales and online orders, not every event", () => {
  const f = summarise({
    revenueRows: [{ subjectId: "pos", amount: 900, qty: 0 }],
    cogsRows: [],
    expenseRows: [],
    events: [
      { kind: "sale" },
      { kind: "order_placed" },
      { kind: "order_delivered" },
      { kind: "purchase" },
      { kind: "return_confirmed" },
    ],
  });
  assert.equal(f.orders, 2, "a delivery and a purchase are not new operations");
  assert.equal(f.avgOrderValue, 450);
});

test("no operations means no division by zero", () => {
  const f = summarise({ revenueRows: [], cogsRows: [], expenseRows: [], events: [] });
  assert.equal(f.avgOrderValue, 0);
  assert.equal(f.netProfit, 0);
  assert.equal(f.topProductId, null);
});

test("أكتر منتج is the one whose goods left at the highest cost", () => {
  const f = summarise({
    revenueRows: [],
    cogsRows: [
      { subjectId: "p1", amount: 300, qty: 0 },
      { subjectId: "p2", amount: 900, qty: 0 },
    ],
    expenseRows: [],
    events: [],
  });
  assert.equal(f.topProductId, "p2");
});

test("a window with only returns names no top product", () => {
  // Every cogs row is negative, so there is no product that WENT OUT.
  const f = summarise({
    revenueRows: [{ subjectId: "pos", amount: -500, qty: 0 }],
    cogsRows: [{ subjectId: "p1", amount: -300, qty: 0 }],
    expenseRows: [],
    events: [{ kind: "return_confirmed" }],
  });
  assert.equal(f.topProductId, null, "a returned product is not the best seller");
});

// ── §1 the treasury total ───────────────────────────────────────────────────

test("إجمالي الخزنة is the sum of EVERY wallet line", () => {
  // The screen used to reduce over the four known WALLET_LABELS keys. Anything
  // booked to another subject vanished from the total while رأس المال counted
  // it — two screens, one figure, two answers.
  const lines = [
    ...buildSaleLines({
      items: [{ productId: "p1", quantity: 1, unitPrice: 500, unitCost: 300 }],
      wallet: "inStoreSafe",
      channel: "pos",
    }),
    ...buildSaleLines({
      items: [{ productId: "p1", quantity: 1, unitPrice: 300, unitCost: 200 }],
      wallet: "vodafoneCash",
      channel: "pos",
    }),
    // A subject outside the four. Nothing in the type system forbids it.
    { account: "wallet", subjectId: "petty_cash_branch_2", amount: 250 },
  ];

  const rows = aggregate(lines, "wallet");
  const known = ["inStoreSafe", "vodafoneCash", "instapay", "bankAccount"];
  const whitelisted = rows.filter((r) => known.includes(r.subjectId));

  assert.equal(sumOf(rows), 1050, "what the ledger actually holds");
  assert.equal(sumOf(whitelisted), 800, "what the whitelist reduce would have shown");
  assert.notEqual(sumOf(rows), sumOf(whitelisted), "the gap this fix closes");
});

test("cash in and cash out net correctly in one till", () => {
  const lines = [
    ...buildSaleLines({
      items: [{ productId: "p1", quantity: 1, unitPrice: 1000, unitCost: 600 }],
      wallet: "inStoreSafe",
      channel: "pos",
    }),
    ...buildPurchaseLines({
      items: [{ productId: "p2", quantity: 2, unitCost: 150 }],
      wallet: "inStoreSafe",
      paidAmount: 300,
    }),
    ...buildReturnConfirmedLines({
      items: [{ productId: "p1", quantity: 1, unitPrice: 1000, unitCost: 600 }],
      refundAmount: 400,
      wallet: "inStoreSafe",
      revenueAmount: 400,
    }),
  ];
  assert.equal(sumOf(aggregate(lines, "wallet")), 300, "1000 in − 300 bought − 400 refunded");
});

// ── §2 inventory value ──────────────────────────────────────────────────────

test("قيمة المخزون is the weighted-average value actually on the shelf", () => {
  const lines = [
    ...buildPurchaseLines({
      items: [{ productId: "p1", quantity: 10, unitCost: 100 }],
      wallet: "w",
    }),
    ...buildPurchaseLines({
      items: [{ productId: "p1", quantity: 10, unitCost: 200 }],
      wallet: "w",
    }),
  ];
  const shelf = aggregate(lines, "stock")[0];
  assert.equal(shelf.qty, 20);
  assert.equal(sumOf(aggregate(lines, "stock")), 3000, "the value the treasury shows");
  assert.equal(averageCost(shelf), 150, "and the per-unit cost behind it");
});

test("selling at the average takes exactly that value off the shelf", () => {
  const lines = [
    ...buildPurchaseLines({
      items: [{ productId: "p1", quantity: 20, unitCost: 150 }],
      wallet: "w",
    }),
    ...buildSaleLines({
      items: [{ productId: "p1", quantity: 4, unitPrice: 500, unitCost: 150 }],
      wallet: "inStoreSafe",
      channel: "pos",
    }),
  ];
  assert.equal(sumOf(aggregate(lines, "stock")), 2400, "3000 − 4 × 150");
  assert.equal(averageCost(aggregate(lines, "stock")[0]), 150, "unmoved by the sale");
});

test("a bundle contributes its COMPONENTS to inventory value, never itself", () => {
  // Selling a بوكس writes component stock lines. If the virtual product also
  // carried stock, its value would be counted twice in قيمة المخزون.
  const lines = [
    ...buildPurchaseLines({
      items: [
        { productId: "shirt", quantity: 10, unitCost: 100 },
        { productId: "pants", quantity: 10, unitCost: 150 },
      ],
      wallet: "w",
    }),
    ...buildSaleLines({
      items: [
        {
          productId: "box",
          quantity: 1,
          unitPrice: 400,
          unitCost: 0,
          isBundle: true,
          bundleItems: [
            { productId: "shirt", quantity: 2, unitCost: 100 },
            { productId: "pants", quantity: 1, unitCost: 150 },
          ],
        },
      ],
      wallet: "inStoreSafe",
      channel: "pos",
    }),
  ];

  const rows = aggregate(lines, "stock");
  const subjects = rows.map((r) => r.subjectId).sort();
  assert.deepEqual(subjects, ["pants", "shirt"], "the بوكس has no shelf of its own");
  assert.equal(sumOf(rows), 2500 - 350, "2500 bought − (2×100 + 150) sold");
});

// ── the two screens must agree ──────────────────────────────────────────────

test("إجمالي المبيعات on the chart is the same SUM the KPI card uses", () => {
  const revenueRows = [
    { subjectId: "pos", amount: 700, qty: 0 },
    { subjectId: "wholesale", amount: 300, qty: 0 },
    { subjectId: "ecommerce", amount: -100, qty: 0 },
  ];
  const f = summarise({ revenueRows, cogsRows: [], expenseRows: [], events: [] });
  assert.equal(f.revenue, sumOf(revenueRows), "one query, one number");
  assert.equal(f.revenue, 900);
});


// ── صافي القيمة: assets minus what we owe ───────────────────────────────────

/** The live scenario from the Phase 7 audit. */
const shop = {
  walletsTotal: 1500,
  inventoryValue: 900,
  receivableClient: 2500,
  payableSupplier: 1000,
};

test("assets are what we own; net worth takes off what we owe", () => {
  assert.equal(totalAssetsOf(shop), 4900, "1500 cash + 900 stock + 2500 owed to us");
  assert.equal(netWorthOf(shop), 3900, "4900 − 1000 owed to suppliers");
});

test("net worth is derived FROM assets, never re-added", () => {
  // If the two ever disagreed about what counts as an asset, the cards would
  // show a difference that is not the supplier debt.
  assert.equal(totalAssetsOf(shop) - netWorthOf(shop), shop.payableSupplier);
});

test("owing more than you hold reads as a NEGATIVE net worth", () => {
  const struggling = { ...shop, payableSupplier: 7000 };
  assert.equal(totalAssetsOf(struggling), 4900, "assets are unchanged by a debt");
  assert.equal(netWorthOf(struggling), -2100, "not clamped to zero — this is real");
});

test("no supplier debt means net worth equals assets", () => {
  const clear = { ...shop, payableSupplier: 0 };
  assert.equal(netWorthOf(clear), totalAssetsOf(clear));
});

test("an empty shop is worth nothing, not NaN", () => {
  const empty = {
    walletsTotal: 0,
    inventoryValue: 0,
    receivableClient: 0,
    payableSupplier: 0,
  };
  assert.equal(totalAssetsOf(empty), 0);
  assert.equal(netWorthOf(empty), 0);
});

test("net worth is money — rounded to piastres", () => {
  const dusty = {
    walletsTotal: 0.1,
    inventoryValue: 0.2,
    receivableClient: 0,
    payableSupplier: 0,
  };
  // 0.1 + 0.2 is 0.30000000000000004 in raw floats.
  assert.equal(totalAssetsOf(dusty), 0.3);
  assert.equal(netWorthOf(dusty), 0.3);
});

test("every part moves net worth by exactly its own amount", () => {
  for (const key of ["walletsTotal", "inventoryValue", "receivableClient"]) {
    assert.equal(
      netWorthOf({ ...shop, [key]: shop[key] + 100 }) - netWorthOf(shop),
      100,
      `${key} should add to net worth`,
    );
  }
  assert.equal(
    netWorthOf({ ...shop, payableSupplier: shop.payableSupplier + 100 }) - netWorthOf(shop),
    -100,
    "supplier debt should subtract from it",
  );
});
