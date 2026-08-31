/**
 * Stock take (جرد) → ledger lines. Both directions.
 *
 *     node --test scripts/check_audit_lines.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStockAdjustmentLines,
  buildOpeningBalanceLines,
  buildWalletOpeningLines,
  buildWalletTransferLines,
  countDiscrepancies,
  auditNetValue,
  isCounted,
} from "../src/lib/ledger/audit.ts";

const amountOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((sum, l) => sum + (l.amount ?? 0), 0);
const qtyOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((sum, l) => sum + (l.qty ?? 0), 0);
const countOn = (lines, account) => lines.filter((l) => l.account === account).length;

test("counting FEWER than recorded takes stock down and books the loss", () => {
  // 20 on the books, 18 on the shelf, at 700 each → 1,400 gone.
  const lines = buildStockAdjustmentLines({
    items: [{ productId: "p-shoe", systemQty: 20, countedQty: 18, unitCost: 700 }],
  });

  assert.equal(lines.length, 2, "one stock line, one expense line");
  assert.equal(qtyOn(lines, "stock"), -2);
  assert.equal(amountOn(lines, "stock"), -1400, "value leaves with the units");
  assert.equal(amountOn(lines, "expense"), 1400, "shrinkage is a real cost");
});

test("counting MORE than recorded puts stock back and cancels the cost", () => {
  const lines = buildStockAdjustmentLines({
    items: [{ productId: "p-shoe", systemQty: 18, countedQty: 21, unitCost: 700 }],
  });

  assert.equal(lines.length, 2);
  assert.equal(qtyOn(lines, "stock"), 3, "the units are really there");
  assert.equal(amountOn(lines, "stock"), 2100);
  assert.equal(
    amountOn(lines, "expense"),
    -2100,
    "a surplus is a negative expense, not revenue — nothing was sold",
  );
});

test("a product that counted correctly writes no lines at all", () => {
  const lines = buildStockAdjustmentLines({
    items: [{ productId: "p-shoe", systemQty: 20, countedQty: 20, unitCost: 700 }],
  });
  assert.equal(lines.length, 0, "no discrepancy, no correction");
});

test("an audit where everything matched produces nothing to append", () => {
  const items = [
    { productId: "a", systemQty: 5, countedQty: 5, unitCost: 100 },
    { productId: "b", systemQty: 9, countedQty: 9, unitCost: 250 },
  ];
  assert.equal(buildStockAdjustmentLines({ items }).length, 0);
  assert.equal(countDiscrepancies(items), 0);
  assert.equal(auditNetValue(items), 0);
});

test("one audit is ONE event: every discrepancy in the same line set", () => {
  const items = [
    { productId: "a", systemQty: 10, countedQty: 8, unitCost: 100 }, // −2, −200
    { productId: "b", systemQty: 4, countedQty: 4, unitCost: 250 }, //  ok, skipped
    { productId: "c", systemQty: 6, countedQty: 9, unitCost: 50 }, //  +3, +150
  ];
  const lines = buildStockAdjustmentLines({ items });

  // Two discrepancies × (stock + expense) = 4 lines. The matching product
  // contributes none — splitting this into per-product events would let half
  // an audit land.
  assert.equal(lines.length, 4);
  assert.equal(countOn(lines, "stock"), 2);
  assert.equal(countOn(lines, "expense"), 2);
  assert.equal(countDiscrepancies(items), 2);

  // Net: 200 lost on a, 150 found on c → 50 short overall.
  assert.equal(amountOn(lines, "stock"), -50);
  assert.equal(amountOn(lines, "expense"), 50);
  assert.equal(auditNetValue(items), -50);
});

test("shrinkage is valued at real cost, not a flat per-unit guess", () => {
  // The code this replaces used `discrepancy * 10` for every product in the
  // shop. Two products missing one unit each must NOT cost the same.
  const cheap = buildStockAdjustmentLines({
    items: [{ productId: "pen", systemQty: 10, countedQty: 9, unitCost: 5 }],
  });
  const dear = buildStockAdjustmentLines({
    items: [{ productId: "tv", systemQty: 10, countedQty: 9, unitCost: 9000 }],
  });

  assert.equal(amountOn(cheap, "expense"), 5);
  assert.equal(amountOn(dear, "expense"), 9000);
  assert.notEqual(amountOn(cheap, "expense"), amountOn(dear, "expense"));
  // And neither is the old flat 10.
  assert.notEqual(amountOn(cheap, "expense"), 10);
  assert.notEqual(amountOn(dear, "expense"), 10);
});

test("a zero-cost product still corrects its count, booking no expense", () => {
  const lines = buildStockAdjustmentLines({
    items: [{ productId: "sample", systemQty: 5, countedQty: 3, unitCost: 0 }],
  });
  assert.equal(qtyOn(lines, "stock"), -2, "the count is still corrected");
  assert.equal(countOn(lines, "expense"), 0, "nothing of value was lost");
});

test("nonsense counts are refused, not booked", () => {
  assert.throws(
    () =>
      buildStockAdjustmentLines({
        items: [{ productId: "a", systemQty: 5, countedQty: -1, unitCost: 10 }],
      }),
    /negative/,
  );
  assert.throws(
    () =>
      buildStockAdjustmentLines({
        items: [{ productId: "a", systemQty: 5, countedQty: 4, unitCost: -10 }],
      }),
    /negative/,
  );
});

test("correcting to a count, then counting again, leaves nothing to correct", () => {
  // After an adjustment the ledger holds the counted number, so an immediate
  // recount must be a no-op. If it were not, every audit would drift.
  const first = buildStockAdjustmentLines({
    items: [{ productId: "p-shoe", systemQty: 20, countedQty: 18, unitCost: 700 }],
  });
  const after = 20 + qtyOn(first, "stock");
  assert.equal(after, 18);

  const second = buildStockAdjustmentLines({
    items: [{ productId: "p-shoe", systemQty: after, countedQty: 18, unitCost: 700 }],
  });
  assert.equal(second.length, 0);
});

// ── Opening balance: the stock a shop already owns on day one ──────────────

test("an opening balance puts stock on the shelf and books NO expense", () => {
  const lines = buildOpeningBalanceLines({ productId: "p-mug", quantity: 40, unitCost: 25 });

  assert.equal(lines.length, 1, "one stock line, nothing else");
  assert.equal(qtyOn(lines, "stock"), 40);
  assert.equal(amountOn(lines, "stock"), 1000, "40 at 25 each");

  // The critical difference from a جرد surplus: no negative expense. A surplus
  // cancels a loss the shop had assumed; an opening balance assumes nothing,
  // and booking one here would invent profit from the shop's own inventory.
  assert.equal(countOn(lines, "expense"), 0, "an opening balance must not create phantom profit");
  for (const account of ["wallet", "revenue", "cogs", "payable_supplier"]) {
    assert.equal(countOn(lines, account), 0, `${account} must not move — nothing was bought today`);
  }
});

test("a جرد surplus and an opening balance are NOT the same shape", () => {
  // Same quantity arriving, two different meanings. If these ever produce the
  // same lines, one of them is wrong.
  const opening = buildOpeningBalanceLines({ productId: "p-mug", quantity: 40, unitCost: 25 });
  const surplus = buildStockAdjustmentLines({
    items: [{ productId: "p-mug", systemQty: 0, countedQty: 40, unitCost: 25 }],
  });

  assert.equal(qtyOn(opening, "stock"), qtyOn(surplus, "stock"), "both put 40 on the shelf");
  assert.equal(countOn(opening, "expense"), 0);
  assert.equal(countOn(surplus, "expense"), 1, "the جرد explains itself as a cancelled loss");
  assert.notEqual(opening.length, surplus.length);
});

test("the opening cost is what every later sale reads as cost", () => {
  // 40 @ 25 opening. Selling 2 must cost 50 — the same weighted average the
  // purchase path feeds, so an opening balance is not a second costing rule.
  const opening = buildOpeningBalanceLines({ productId: "p-mug", quantity: 40, unitCost: 25 });
  const onHand = { qty: qtyOn(opening, "stock"), amount: amountOn(opening, "stock") };
  assert.equal(onHand.amount / onHand.qty, 25);
});

test("an opening balance of nothing is refused, not booked as an empty event", () => {
  assert.throws(
    () => buildOpeningBalanceLines({ productId: "p", quantity: 0, unitCost: 10 }),
    /positive/,
  );
  assert.throws(
    () => buildOpeningBalanceLines({ productId: "p", quantity: -5, unitCost: 10 }),
    /positive/,
  );
  assert.throws(
    () => buildOpeningBalanceLines({ productId: "p", quantity: 5, unitCost: -1 }),
    /negative/,
  );
});

// ── Wallets: opening balance and transfers ────────────────────────────────

test("a wallet opening balance is one line, on that wallet only", () => {
  const lines = buildWalletOpeningLines({ wallet: "vodafoneCash", amount: 500 });

  assert.equal(lines.length, 1);
  assert.equal(lines[0].account, "wallet");
  assert.equal(lines[0].subjectId, "vodafoneCash");
  assert.equal(lines[0].amount, 500);
  // No counterpart: this money predates the ledger, it was not earned today.
  assert.equal(countOn(lines, "revenue"), 0);
  assert.equal(countOn(lines, "expense"), 0);
});

test("each wallet's opening balance is independent", () => {
  const vodafone = buildWalletOpeningLines({ wallet: "vodafoneCash", amount: 500 });
  const cash = buildWalletOpeningLines({ wallet: "inStoreSafe", amount: 1200 });
  const all = [...vodafone, ...cash];

  const on = (w) =>
    all.filter((l) => l.subjectId === w).reduce((s, l) => s + (l.amount ?? 0), 0);
  assert.equal(on("vodafoneCash"), 500);
  assert.equal(on("inStoreSafe"), 1200);
  assert.equal(on("bankAccount"), 0, "a wallet with no event reads zero, not a stored default");
});

test("a newly added wallet type works with no extra code", () => {
  // InstaPay was added as a wallet type after the ledger was built. Because
  // balances are SUM(wallet) keyed by the wallet id, it needs no special case:
  // an opening balance and a transfer both behave like any other wallet.
  const opening = buildWalletOpeningLines({ wallet: "instaPay", amount: 750 });
  assert.equal(opening.length, 1);
  assert.equal(opening[0].subjectId, "instaPay");
  assert.equal(opening[0].amount, 750);

  const moved = buildWalletTransferLines({
    fromWallet: "instaPay",
    toWallet: "inStoreSafe",
    amount: 250,
  });
  assert.equal(amountOn(moved, "wallet"), 0, "still nets to zero across wallets");
  assert.equal(moved.find((l) => l.subjectId === "instaPay").amount, -250);
});

test("a wallet opening balance of zero is refused", () => {
  assert.throws(() => buildWalletOpeningLines({ wallet: "inStoreSafe", amount: 0 }), /zero/);
});

test("a transfer moves money between wallets without creating any", () => {
  const lines = buildWalletTransferLines({
    fromWallet: "inStoreSafe",
    toWallet: "bankAccount",
    amount: 300,
  });

  assert.equal(lines.length, 2);
  assert.equal(amountOn(lines, "wallet"), 0, "the shop is no richer for moving its own money");
  assert.equal(lines.find((l) => l.subjectId === "inStoreSafe").amount, -300);
  assert.equal(lines.find((l) => l.subjectId === "bankAccount").amount, 300);
});

test("a transfer to the same wallet, or of nothing, is refused", () => {
  assert.throws(
    () => buildWalletTransferLines({ fromWallet: "a", toWallet: "a", amount: 10 }),
    /different wallets/,
  );
  assert.throws(
    () => buildWalletTransferLines({ fromWallet: "a", toWallet: "b", amount: 0 }),
    /positive/,
  );
});

// ── §1.3: a جرد that is actually committed ─────────────────────────────────
// The reported bug was that the screen could count but never commit. These
// pin what committing must do to the numbers every screen reads back.

/** What `qtyOf` sums: every stock line for one product. */
const stockQty = (lines, productId) =>
  lines
    .filter((l) => l.account === "stock" && l.subjectId === productId)
    .reduce((sum, l) => sum + (l.qty ?? 0), 0);

test("a blank box is NOT a count — that is what the screen filters on", () => {
  assert.equal(isCounted(""), false, "not counted yet");
  assert.equal(isCounted("   "), false, "whitespace is still not a count");
  assert.equal(isCounted(undefined), false);
  assert.equal(isCounted(0), true, "a typed zero IS a count — the shelf is empty");
  assert.equal(isCounted("0"), true);
  assert.equal(isCounted(9), true);
});

test("committing a جرد with عجز 1 leaves the product one lower everywhere", () => {
  const SHOE = "p-shoe";
  const MUG = "p-mug";

  // The shop opens with 10 shoes and 5 mugs.
  const ledger = [
    ...buildOpeningBalanceLines({ productId: SHOE, quantity: 10, unitCost: 700 }),
    ...buildOpeningBalanceLines({ productId: MUG, quantity: 5, unitCost: 25 }),
  ];
  assert.equal(stockQty(ledger, SHOE), 10);
  assert.equal(stockQty(ledger, MUG), 5);

  // The auditor counts 9 shoes and leaves the mug row blank. Only counted
  // rows reach the builder — exactly what `countedRows` does on screen.
  const rows = [
    { productId: SHOE, systemQty: 10, actualQty: "9", unitCost: 700 },
    { productId: MUG, systemQty: 5, actualQty: "", unitCost: 25 },
  ];
  const items = rows
    .filter((r) => isCounted(r.actualQty))
    .map((r) => ({
      productId: r.productId,
      systemQty: r.systemQty,
      countedQty: parseInt(r.actualQty) || 0,
      unitCost: r.unitCost,
    }));

  assert.equal(items.length, 1, "the uncounted mug never reaches the ledger");

  const audit = buildStockAdjustmentLines({ items });
  assert.equal(audit.length, 2, "ONE stock line and ONE expense line, in ONE event");
  assert.equal(qtyOn(audit, "stock"), -1, "one unit gone");
  assert.equal(amountOn(audit, "expense"), 700, "the loss is valued at real cost");

  const after = [...ledger, ...audit];
  assert.equal(stockQty(after, SHOE), 9, "products/warehouses/POS all read 9 — one SUM");
  assert.equal(stockQty(after, MUG), 5, "the uncounted product is untouched");
});

test("a زيادة commits the same way, in one event, and lifts the count", () => {
  const CHARGER = "p-charger";
  const ledger = buildOpeningBalanceLines({ productId: CHARGER, quantity: 4, unitCost: 120 });

  const audit = buildStockAdjustmentLines({
    items: [{ productId: CHARGER, systemQty: 4, countedQty: 6, unitCost: 120 }],
  });

  assert.equal(stockQty([...ledger, ...audit], CHARGER), 6, "4 recorded, 6 on the shelf");
  assert.equal(amountOn(audit, "expense"), -240, "a surplus cancels cost, it is not revenue");
});


// ── the جرد must reconcile against the LEDGER, not the shelf record ─────────
//
// The screen used to show `getActualStock` (the mirror) as "system quantity"
// and then write a ledger adjustment relative to it. When the two had drifted —
// which is the whole reason a جرد is run — it corrected the mirror and left the
// ledger off by exactly the drift. The one screen whose job is making the books
// match the shelf was creating the mismatch.

/** What the screen now does: ledger delta off the ledger, mirror off the mirror. */
const auditOnce = ({ ledgerQty, mirrorQty, counted, unitCost = 10 }) => ({
  ledgerLines: buildStockAdjustmentLines({
    items: [{ productId: "p1", systemQty: ledgerQty, countedQty: counted, unitCost }],
  }),
  mirrorDelta: counted - mirrorQty,
});

test("when the books agree, both move by the same amount", () => {
  const { ledgerLines, mirrorDelta } = auditOnce({ ledgerQty: 10, mirrorQty: 10, counted: 8 });
  assert.equal(qtyOn(ledgerLines, "stock"), -2);
  assert.equal(mirrorDelta, -2);
});

test("when they have DRIFTED, each is corrected to the same count", () => {
  // Ledger says 12, shelf record says 10, the auditor physically counts 8.
  const { ledgerLines, mirrorDelta } = auditOnce({ ledgerQty: 12, mirrorQty: 10, counted: 8 });

  assert.equal(qtyOn(ledgerLines, "stock"), -4, "12 → 8");
  assert.equal(12 + qtyOn(ledgerLines, "stock"), 8, "the ledger lands on the count");

  assert.equal(mirrorDelta, -2, "10 → 8");
  assert.equal(10 + mirrorDelta, 8, "and so does the shelf record");
});

test("the old behaviour would have left the ledger wrong", () => {
  // Both deltas taken from the mirror — what the screen used to do.
  const wrong = buildStockAdjustmentLines({
    items: [{ productId: "p1", systemQty: 10, countedQty: 8, unitCost: 10 }],
  });
  assert.equal(12 + qtyOn(wrong, "stock"), 10, "ledger ends at 10, not the counted 8");
  assert.notEqual(12 + qtyOn(wrong, "stock"), 8, "which is the bug this pins");
});

test("a surplus corrects upward from whichever baseline each book holds", () => {
  const { ledgerLines, mirrorDelta } = auditOnce({ ledgerQty: 3, mirrorQty: 5, counted: 9 });
  assert.equal(3 + qtyOn(ledgerLines, "stock"), 9);
  assert.equal(5 + mirrorDelta, 9);
});

test("an already-correct count writes nothing at all", () => {
  const { ledgerLines, mirrorDelta } = auditOnce({ ledgerQty: 7, mirrorQty: 7, counted: 7 });
  assert.equal(ledgerLines.length, 0, "no event, no shrinkage line");
  assert.equal(mirrorDelta, 0);
});

test("a variant product reconciles its TOTAL against the ledger", () => {
  // The ledger holds one number per product; only the mirror knows the درجات.
  // Counting أحمر=4 and أزرق=3 with the ledger at 10 must move the ledger by
  // −3, not by two separate per-variant deltas against a product-level figure.
  const newTotal = 4 + 3;
  const lines = buildStockAdjustmentLines({
    items: [{ productId: "box", systemQty: 10, countedQty: newTotal, unitCost: 20 }],
  });
  assert.equal(qtyOn(lines, "stock"), -3);
  assert.equal(10 + qtyOn(lines, "stock"), newTotal);
});

test("an uncounted درجة keeps its stock inside the product total", () => {
  // أحمر counted at 4; أزرق never counted and still holding 3. The product
  // total is 7 — booking 4 would write off a درجة nobody looked at.
  const counted = 4;
  const untouched = 3;
  const lines = buildStockAdjustmentLines({
    items: [{ productId: "box", systemQty: 10, countedQty: counted + untouched, unitCost: 20 }],
  });
  assert.equal(10 + qtyOn(lines, "stock"), 7, "not 4");
});
