import test from "node:test";
import assert from "node:assert/strict";
import { courierFeeTotals } from "../src/lib/courierFees.ts";
import { discountDefinitionError, bundleDefinitionError } from "../src/lib/businessDefinitions.ts";
import {
  remainingSaleLines,
  costedReturnLine,
  posRefundValue,
  returnStockFields,
} from "../src/lib/posReturn.ts";
import { fetchPnl, channelLabel } from "../src/lib/ledger/reports.ts";
import { isFullExchangeSelection } from "../src/lib/exchange.ts";
test("SPR-FEE-01: courier fee drill-down excludes refund principal and settlements; historical linked swaps classified", () => {
  const row = (kind, ref, amount, movement) => ({
    subject_id: "courier",
    amount_delta: amount,
    ledger_events: { kind, ref_id: ref, payload: JSON.stringify({ movement }) },
  });
  const totals = courierFeeTotals(
    [
      row("order_delivered", "A", 500),
      row("return_confirmed", "A", 300),
      row("return_confirmed", "B", 700),
      row("return_confirmed", "C", 900, "exchange"),
      row("courier_settlement", "A", -500),
    ],
    [
      { id: "b", orderNumber: "B" },
      { id: "replacement", orderNumber: "REPL", original_order_id: "b", isExchange: true },
    ],
  );
  assert.deepEqual(totals.courier, { delivery: 5, returns: 3, exchange: 16 });
});
test("SPR-DEF-01: discount/bundle definitions reject malformed money and fractional limits", () => {
  for (const v of [NaN, Infinity, -Infinity, 0, -1]) {
    assert.ok(discountDefinitionError("fixed", v, "", ""));
    assert.ok(bundleDefinitionError(v, [{ quantity: 1 }]));
  }
  assert.ok(discountDefinitionError("percentage", 101, "", ""));
  assert.ok(discountDefinitionError("fixed", 5, "1.2", ""));
  assert.ok(discountDefinitionError("fixed", 5, "-2", ""));
  assert.ok(bundleDefinitionError(80, [{ quantity: 0.5 }]));
  assert.equal(discountDefinitionError("percentage", 10, "2", "2026-12-01"), null);
  assert.equal(bundleDefinitionError(80, [{ quantity: 2 }]), null);
});
test("SPR-POS-02: cumulative piastre allocation makes split refunds exactly equal discounted sale", () => {
  const event = {
    id: "s",
    payload: {
      items: [{ productId: "p", productName: "P", quantity: 3, unitPrice: 0.01 }],
      discountAmount: 0.01,
    },
  };
  let total = 0;
  for (let returned = 0; returned < 3; returned++) {
    const line = remainingSaleLines(
      event,
      returned ? [{ sourceEventId: "s", productId: "p", quantity: returned }] : [],
    )[0];
    total += Math.round(posRefundValue(line, 1) * 100);
  }
  assert.equal(total, 2);
  assert.equal(posRefundValue(remainingSaleLines(event)[0], 3), 0.02);
});
test("SPR-POS-03: archived/renamed plain receipt derives immutable cost, ambiguous old mixed box refuses a guess", () => {
  const event = { id: "s", payload: { items: [{ productId: "p", quantity: 2, unitPrice: 50 }] } };
  assert.equal(
    costedReturnLine(event, remainingSaleLines(event)[0], [
      { account: "stock", subject_id: "p", qty_delta: -2, amount_delta: -2000 },
    ]).unitCost,
    10,
  );
  const mixed = {
    id: "m",
    payload: {
      items: [
        { productId: "box", quantity: 1, unitPrice: 80 },
        { productId: "p", quantity: 1, unitPrice: 50 },
      ],
    },
  };
  assert.throws(
    () => costedReturnLine(mixed, remainingSaleLines(mixed)[0], [], true),
    /فاتورة مختلطة/,
  );
});
test("SPR-ECO-05: partial selection cannot reach a command that returns the whole original basket", () => {
  const original = {
    id: "o",
    status: "delivered",
    stockItems: [
      { productId: "p", quantity: 2, unitPrice: 50 },
      { productId: "q", quantity: 1, unitPrice: 30 },
    ],
  };
  assert.equal(isFullExchangeSelection(original, [], [{ productId: "p", quantity: 1 }]), false);
  assert.equal(
    isFullExchangeSelection(
      original,
      [],
      [
        { productId: "p", quantity: 2 },
        { productId: "q", quantity: 1 },
      ],
    ),
    true,
  );
});
test("SPR-FIN-09: returns-only report request includes POS without a second deduction; pending deposit has Arabic label", async () => {
  const queries = [];
  const report = await fetchPnl(async (query) => {
    queries.push(query);
    return [
      {
        subjectId: "pos",
        amount: query.returnsOnly
          ? -50
          : query.account === "revenue"
            ? 100
            : query.account === "cogs"
              ? 20
              : 0,
      },
    ];
  }, {});
  assert.equal(report.returns, 50);
  assert.equal(report.netProfit, 80);
  assert.ok(queries.some((q) => q.returnsOnly && !q.kind));
  assert.equal(channelLabel("deposit_pending_resolution"), "عربون بانتظار تسوية العميل");
});
test("SPR-POS-05: historical bundle cost fields never overwrite signed quantity or rounded refund price", () => {
  const historical = {
    quantity: 3,
    unitPrice: 0.02 / 3,
    unitCost: 0,
    isBundle: true,
    bundleItems: [{ productId: "p", quantity: 1, unitCost: 10 }],
  };
  const refund = { quantity: -1, unitPrice: 0.01, ...returnStockFields(historical) };
  assert.equal(refund.quantity, -1);
  assert.equal(refund.unitPrice, 0.01);
  assert.equal(refund.bundleItems[0].unitCost, 10);
});
