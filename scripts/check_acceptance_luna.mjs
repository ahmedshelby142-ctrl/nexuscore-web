/**
 * LUNA BEAUTY — business acceptance through the REAL ledger builders.
 *
 *     node --test scripts/check_acceptance_luna.mjs
 *
 * One continuous trading history for a beauty shop (store + online, COD,
 * couriers, a supplier, repeat customers). Every event is built exactly as the
 * screen builds it (same builder, same cause→deposit/fee policy functions the
 * Orders page calls), checked against the validator's per-kind rules AS 054
 * LEAVES THEM, posted to an in-memory ledger, and reconciled.
 *
 * What this cannot reach is the database itself (RLS, the RPCs' own checks,
 * refund_order_deposit): production is out of scope for this pass.
 */
process.env.TZ = "Africa/Cairo";

import test from "node:test";
import assert from "node:assert/strict";
import { buildPurchaseLines, buildSupplierPaymentLines, buildSupplierReturnLines, averageCost } from "../src/lib/ledger/purchases.ts";
import { buildSaleLines } from "../src/lib/ledger/sales.ts";
import {
  buildOrderPlacedLines, buildOrderDeliveredLines, buildCourierSettlementLines, buildOrderCancelledLines,
  buildOrderRTOLines, buildReturnConfirmedLines,
} from "../src/lib/ledger/orders.ts";
import { buildExpenseLines } from "../src/lib/ledger/expenses.ts";
import {
  wastedTripCompensationFor, shippingBorneBy, depositDispositionOn, countsAsWastedTrip, depositRefundEligible,
  blockingCauseReason, exchangeReturnFee, clearsShippingDebt,
} from "../src/lib/shippingRates.ts";
import { pnl, customWindow } from "../src/lib/ledger/reports.ts";
import { toPiastres } from "../src/lib/ledger/money.ts";
import { remainingSaleLines } from "../src/lib/posReturn.ts";
import { remainingUnits } from "../src/lib/exchange.ts";
import { dayRangeBounds, ordersInPeriod } from "../src/lib/orderSearch.ts";

// ═══ The validator's per-kind rules, as 054 leaves them (independent reading) ═
const WALLETS = ["instoresafe", "vodafonecash", "instapay", "bankaccount"];
const ALLOWED = {
  sale: ["stock", "cogs", "wallet", "receivable_client", "revenue", "customer_ltv", "expense"],
  order_placed: ["stock", "wallet"],
  order_cancelled: ["stock", "wallet", "revenue", "customer_ltv"],
  order_delivered: ["cogs", "receivable_courier", "revenue", "payable_courier", "customer_ltv", "expense"], // 054 adds expense
  return_confirmed: ["stock", "cogs", "wallet", "receivable_client", "receivable_courier", "payable_courier", "revenue", "expense", "customer_ltv"],
  rto_confirmed: ["stock", "payable_courier", "expense", "receivable_courier", "wallet", "revenue", "customer_ltv"],
  purchase: ["stock", "wallet", "payable_supplier"],
  supplier_payment: ["wallet", "payable_supplier"],
  expense: ["wallet", "expense"],
  courier_settlement: ["wallet", "receivable_courier", "payable_courier", "expense"],
};
function violations(kind, raw, ctx = {}) {
  const lines = raw.map((l) => ({ account: l.account, subject: l.subjectId, q: l.qty ?? 0, a: toPiastres(l.amount ?? 0) }));
  const out = [];
  const sum = (acc) => lines.filter((l) => l.account === acc).reduce((s, l) => s + l.a, 0);
  const count = (f) => lines.filter(f).length;
  const [w, r, rc, rco, pc, ps, ex, st, ltv] = ["wallet", "revenue", "receivable_client", "receivable_courier", "payable_courier", "payable_supplier", "expense", "stock", "customer_ltv"].map(sum);
  if (lines.length === 0) return ["must move something"];
  if (count((l) => l.account !== "stock" && l.q !== 0)) out.push("qty off stock");
  if (count((l) => l.account === "stock" && (l.q === 0 || (l.q > 0 && l.a < 0) || (l.q < 0 && l.a > 0)))) out.push("stock sign");
  if (count((l) => l.account === "wallet" && !WALLETS.includes(String(l.subject).toLowerCase()))) out.push("wallet");
  if (ALLOWED[kind] && count((l) => !ALLOWED[kind].includes(l.account))) out.push(`${kind} cannot move that account`);
  const stockIn = count((l) => l.account === "stock" && l.q > 0);
  const stockOut = count((l) => l.account === "stock" && l.q < 0);
  const walletIn = count((l) => l.account === "wallet" && l.a > 0);
  const walletOut = count((l) => l.account === "wallet" && l.a <= 0);
  const revNotDeposit = count((l) => l.account === "revenue" && (l.a <= 0 || !["forfeited_deposit", "deposit_pending_resolution"].includes(l.subject)));
  const ltvOk = ltv === 0 || ltv === r;
  const exNeg = count((l) => l.account === "expense" && l.a < 0);
  switch (kind) {
    case "sale": if (w + rc !== r || !ltvOk || exNeg) out.push("sale equation"); break;
    case "order_placed":
      if (!stockOut || stockIn || walletOut) out.push("order_placed shape");
      // 046 + 054: the order row's own equation.
      if (ctx.order) {
        const o = ctx.order;
        if (Math.abs(o.deposit + o.cod - o.total - o.ship - (o.comp ?? 0)) >= 0.005) out.push("placement equation");
      }
      break;
    case "order_cancelled": if (stockOut || walletIn || revNotDeposit || (w < 0 && r > 0) || !ltvOk) out.push("cancel shape"); break;
    case "order_delivered":
      if (count((l) => ["receivable_courier", "payable_courier", "revenue", "cogs"].includes(l.account) && l.a < 0) || exNeg || !ltvOk) out.push("delivered: never negative");
      if ((ctx.priorDeposits ?? 0) + rco > r + pc) out.push("COD exceeds owed");
      break;
    case "return_confirmed": if (w + rc + rco - pc + ex !== r || r > 0 || stockOut || !ltvOk) out.push("return equation"); break;
    case "rto_confirmed": if (rco - pc + ex !== 0 || walletIn || revNotDeposit || stockOut || !ltvOk) out.push("rto equation"); break;
    case "purchase": if (st + w - ps !== 0) out.push("purchase equation"); break;
    case "supplier_payment": if (w !== ps || w >= 0) out.push("supplier payment"); break;
    case "expense": if (w + ex !== 0 || w >= 0) out.push("expense equation"); break;
    case "courier_settlement": if (w + rco - pc + ex !== 0 || walletOut) out.push("settlement equation"); break;
    default: out.push(`unknown kind ${kind}`);
  }
  return out;
}

// ═══ An in-memory ledger ════════════════════════════════════════════════════
const r2 = (n) => Math.round(n * 100) / 100;
function makeLedger() {
  const book = new Map();
  const events = [];
  const post = (kind, lines, ctx = {}) => {
    assert.deepEqual(violations(kind, lines, ctx), [], `${kind} refused: ${JSON.stringify(lines)}`);
    events.push({ kind, lines });
    for (const l of lines) {
      const k = `${l.account}|${l.subjectId}`;
      const cur = book.get(k) ?? { qty: 0, amount: 0 };
      book.set(k, { qty: cur.qty + (l.qty ?? 0), amount: r2(cur.amount + (l.amount ?? 0)) });
    }
  };
  const bal = (account, subject) =>
    [...book].filter(([k]) => k.split("|")[0] === account && (subject === undefined || k.split("|")[1] === subject))
      .reduce((s, [, v]) => ({ qty: s.qty + v.qty, amount: r2(s.amount + v.amount) }), { qty: 0, amount: 0 });
  const rows = (account) => [...book].filter(([k]) => k.split("|")[0] === account).map(([k, v]) => ({ subjectId: k.split("|")[1], amount: v.amount }));
  return { post, bal, rows, events };
}

const line = (productId, quantity, unitPrice, unitCost) => ({ productId, quantity, unitPrice, unitCost });

// ═══ 2. Supplier / purchases ═════════════════════════════════════════════════
test("SUPPLIER: unpaid invoice → partial → return → final payment; stock, payable and inventory value", () => {
  const L = makeLedger();
  L.post("purchase", buildPurchaseLines({ supplierId: "sup", wallet: "inStoreSafe", paidAmount: 0, items: [{ productId: "lip", quantity: 100, unitCost: 80 }, { productId: "serum", quantity: 40, unitCost: 150 }] }));
  assert.equal(L.bal("payable_supplier", "sup").amount, 14000, "8000 + 6000, nothing paid");
  assert.equal(L.bal("wallet").amount, 0);
  L.post("supplier_payment", buildSupplierPaymentLines({ supplierId: "sup", wallet: "bankAccount", amount: 5000 }));
  assert.equal(L.bal("payable_supplier", "sup").amount, 9000);
  // 10 lipsticks go back against the debt.
  L.post("purchase", buildSupplierReturnLines({ resolved: { supplierId: "sup", lines: [{ productId: "lip", quantity: 10, unitCost: 80, invoiceNumber: "FM-1" }] }, wallet: "bankAccount", currentDebt: 9000, paidNow: 0 }));
  assert.deepEqual(L.bal("stock", "lip"), { qty: 90, amount: 7200 });
  assert.equal(L.bal("payable_supplier", "sup").amount, 8200, "the return reduces what we owe, no cash moves");
  assert.equal(L.bal("wallet", "bankAccount").amount, -5000);
  L.post("supplier_payment", buildSupplierPaymentLines({ supplierId: "sup", wallet: "bankAccount", amount: 8200 }));
  assert.equal(L.bal("payable_supplier", "sup").amount, 0, "settled");
  assert.equal(L.bal("stock").amount, 7200 + 6000, "inventory value = cost of what is on the shelf");
  assert.equal(averageCost(L.bal("stock", "serum")), 150);
});

test("SUPPLIER: a return larger than the debt pays cash back, never a negative payable", () => {
  const L = makeLedger();
  L.post("purchase", buildPurchaseLines({ supplierId: "sup", wallet: "inStoreSafe", paidAmount: 800, items: [{ productId: "lip", quantity: 10, unitCost: 80 }] }));
  L.post("purchase", buildSupplierReturnLines({ resolved: { supplierId: "sup", lines: [{ productId: "lip", quantity: 5, unitCost: 80, invoiceNumber: "FM-2" }] }, wallet: "inStoreSafe", currentDebt: 0, paidNow: 0 }));
  assert.equal(L.bal("payable_supplier", "sup").amount, 0);
  assert.equal(L.bal("wallet", "inStoreSafe").amount, -400, "800 out, 400 back");
  assert.equal(L.bal("stock", "lip").qty, 5);
});

// ═══ 3. POS ═══════════════════════════════════════════════════════════════════
test("POS: multi-line, multi-qty, discount, walk-in; return; a second return of the same unit is blocked", () => {
  const L = makeLedger();
  L.post("purchase", buildPurchaseLines({ supplierId: "sup", wallet: "inStoreSafe", paidAmount: 0, items: [{ productId: "lip", quantity: 50, unitCost: 80 }, { productId: "serum", quantity: 20, unitCost: 150 }] }));
  const items = [line("lip", 3, 150, 80), line("serum", 2, 300, 150)];
  L.post("sale", buildSaleLines({ items, wallet: "inStoreSafe", discountAmount: 50 })); // walk-in, no LTV
  assert.equal(L.bal("revenue", "pos").amount, 450 + 600 - 50);
  assert.equal(L.bal("wallet", "inStoreSafe").amount, 1000);
  assert.equal(L.bal("customer_ltv").amount, 0, "no customer, no lifetime value");
  assert.deepEqual([L.bal("stock", "lip").qty, L.bal("stock", "serum").qty], [47, 18]);
  // A known customer buys, then returns one lipstick off that receipt.
  L.post("sale", buildSaleLines({ items: [line("lip", 2, 150, 80)], wallet: "inStoreSafe", customerId: "c-pos" }));
  L.post("sale", buildSaleLines({ items: [line("lip", -1, 150, 80)], wallet: "inStoreSafe", customerId: "c-pos" }));
  assert.equal(L.bal("stock", "lip").qty, 46);
  assert.equal(L.bal("customer_ltv", "c-pos").amount, 150);
  const receipt = { id: "ev-sale-2", payload: { items: [{ productId: "lip", productName: "Lip", unitPrice: 150, quantity: 2 }] } };
  const after1 = remainingSaleLines(receipt, [{ sourceEventId: "ev-sale-2", productId: "lip", quantity: 1 }]);
  assert.equal(after1[0].remaining, 1);
  const after2 = remainingSaleLines(receipt, [{ sourceEventId: "ev-sale-2", productId: "lip", quantity: 1 }, { sourceEventId: "ev-sale-2", productId: "lip", quantity: 1 }]);
  assert.equal(after2[0].remaining, 0, "nothing left to return: a third return is refused");
});

// ═══ 4. Online orders + courier ══════════════════════════════════════════════
function online(L, { customer, base = 60, repeat = false, deposit = 300, courierFee, courier = "jt", goods = [line("lip", 5, 200, 80)] }) {
  const total = goods.reduce((s, g) => s + g.quantity * g.unitPrice, 0);
  const comp = wastedTripCompensationFor(base, { returned_orders_count: repeat ? 1 : 0 });
  const cod = total + base + comp - deposit;
  L.post("order_placed", buildOrderPlacedLines({ items: goods, depositAmount: deposit, wallet: "vodafoneCash" }), { order: { total, ship: base, comp, deposit, cod } });
  return { goods, total, base, comp, deposit, cod, courier, customer, courierFee };
}
function deliver(L, o) {
  L.post("order_delivered", buildOrderDeliveredLines({
    items: o.goods, goodsTotal: o.total, shippingFee: o.base, wastedTripCompensation: o.comp, courierFee: o.courierFee,
    depositAmount: o.deposit, codAmount: o.cod, courierId: o.courier, customerId: o.customer,
  }), { priorDeposits: toPiastres(o.deposit) });
}

test("ONLINE + COURIER: normal and repeat-return orders, overrides, settlement — compensation never courier cost", () => {
  const L = makeLedger();
  L.post("purchase", buildPurchaseLines({ supplierId: "sup", wallet: "inStoreSafe", paidAmount: 0, items: [{ productId: "lip", quantity: 100, unitCost: 80 }] }));
  const a = online(L, { customer: "c-a" });                     // Cairo, normal
  const b = online(L, { customer: "c-b", repeat: true });       // the frozen case
  const g = online(L, { customer: "c-g", base: 70, repeat: true, courier: "bosta" }); // Giza
  assert.deepEqual([b.total + b.base + b.comp, b.deposit, b.cod, b.comp], [1120, 300, 820, 60], "frozen Cairo case");
  assert.equal(g.total + g.base + g.comp, 1140);
  assert.equal(L.bal("stock", "lip").qty, 85, "reserved at placement");
  assert.equal(L.bal("wallet", "vodafoneCash").amount, 900, "three deposits");
  deliver(L, a); deliver(L, b); deliver(L, g);
  assert.equal(L.bal("payable_courier", "jt").amount, 120, "60 + 60 — NOT 180");
  assert.equal(L.bal("payable_courier", "bosta").amount, 70, "NOT 140");
  assert.equal(L.bal("revenue", "wasted_trip_compensation").amount, 130, "60 + 70 kept by the shop");
  assert.equal(L.bal("customer_ltv", "c-b").amount, 1060, "goods + the recovery the customer paid the shop");
  // Overrides: the courier is owed what the operator entered; compensation stays 60.
  const low = online(L, { customer: "c-l", repeat: true, courierFee: 45 });
  const high = online(L, { customer: "c-h", repeat: true, courierFee: 75 });
  deliver(L, low); deliver(L, high);
  assert.equal(L.bal("payable_courier", "jt").amount, 120 + 45 + 75);
  assert.equal(L.bal("revenue", "wasted_trip_compensation").amount, 130 + 60 + 60);
  assert.equal(L.bal("revenue", "shipping_delivery_margin").amount, 15);
  assert.equal(L.bal("expense", "shipping").amount, 15, "the overrun is the shop's shipping cost");
  // Remittance: each courier hands over its COD less what it is owed.
  for (const [courier, codTotal] of [["jt", a.cod + b.cod + low.cod + high.cod], ["bosta", g.cod]]) {
    const fee = L.bal("payable_courier", courier).amount;
    L.post("courier_settlement", buildCourierSettlementLines({ courierId: courier, wallet: "inStoreSafe", amount: codTotal, commission: fee }));
    assert.deepEqual([L.bal("receivable_courier", courier).amount, L.bal("payable_courier", courier).amount], [0, 0], `${courier} settled`);
  }
});

// ═══ 1. Cancellation / RTO / return / exchange matrix ════════════════════════
function stocked() {
  const L = makeLedger();
  L.post("purchase", buildPurchaseLines({ supplierId: "sup", wallet: "inStoreSafe", paidAmount: 0, items: [{ productId: "lip", quantity: 100, unitCost: 80 }] }));
  return L;
}

test("A. customer-caused cancellation before delivery: stock back, deposit forfeited as income", () => {
  const L = stocked();
  const o = online(L, { customer: "c1" });
  assert.equal(depositDispositionOn("customer", "return"), "forfeit");
  L.post("order_cancelled", buildOrderCancelledLines({ items: o.goods, forfeitedDeposit: Math.min(o.deposit, o.total), wallet: "vodafoneCash", customerId: "c1" }));
  assert.equal(L.bal("stock", "lip").qty, 100, "reservation released");
  assert.equal(L.bal("revenue", "forfeited_deposit").amount, 300);
  assert.equal(L.bal("wallet", "vodafoneCash").amount, 300, "the deposit stays in the till");
  assert.equal(countsAsWastedTrip("customer", "return"), true, "and the server counts the trip (050: cause customer + movement return)");
});

test("B. shop-caused cancellation: stock back, deposit held pending the refund decision — eligible for refund", () => {
  const L = stocked();
  const o = online(L, { customer: "c1" });
  assert.equal(depositDispositionOn("shop", "return"), "pending_resolution");
  L.post("order_cancelled", buildOrderCancelledLines({ items: o.goods, pendingDeposit: Math.min(o.deposit, o.total), wallet: "vodafoneCash", customerId: "c1" }));
  assert.equal(L.bal("stock", "lip").qty, 100);
  assert.equal(L.bal("revenue", "deposit_pending_resolution").amount, 300, "held, not forfeited income");
  assert.equal(L.bal("revenue", "forfeited_deposit").amount, 0);
  assert.equal(depositRefundEligible("shop"), true);
  assert.equal(depositRefundEligible("customer"), false, "a customer who cancelled cannot get it back");
  assert.equal(countsAsWastedTrip("shop", "return"), false, "no debt on the customer");
});

test("C. customer-caused return after failed delivery (RTO): fee on the customer, deposit forfeited, debt counted", () => {
  const L = stocked();
  const o = online(L, { customer: "c1" });
  const feeBorneBy = shippingBorneBy("customer", "return");
  assert.equal(feeBorneBy, "customer");
  L.post("rto_confirmed", buildOrderRTOLines({ items: o.goods, returnFee: 50, feeBorneBy, courierId: "jt", forfeitedDeposit: o.deposit, customerId: "c1" }));
  assert.equal(L.bal("stock", "lip").qty, 100, "goods back on the shelf");
  assert.equal(L.bal("revenue", "forfeited_deposit").amount, 300);
  assert.equal(L.bal("expense").amount, 0, "the shop bears no shipping cost");
  assert.equal(countsAsWastedTrip("customer", "return"), true);
  // …and the NEXT order recovers one base rate.
  assert.equal(wastedTripCompensationFor(60, { returned_orders_count: 1 }), 60);
});

test("D. shop-caused return after failed delivery: the shop bears the trip, deposit held, NO customer debt", () => {
  const L = stocked();
  const o = online(L, { customer: "c1" });
  const feeBorneBy = shippingBorneBy("shop", "return");
  assert.equal(feeBorneBy, "shop");
  L.post("rto_confirmed", buildOrderRTOLines({ items: o.goods, returnFee: 50, feeBorneBy, courierId: "jt", pendingDeposit: o.deposit, customerId: "c1" }));
  assert.equal(L.bal("stock", "lip").qty, 100);
  assert.equal(L.bal("expense", "shipping_return").amount, 50, "the trip is the shop's cost");
  assert.equal(L.bal("payable_courier", "jt").amount, 50, "the courier is owed it");
  assert.equal(L.bal("revenue", "deposit_pending_resolution").amount, 300);
  assert.equal(countsAsWastedTrip("shop", "return"), false);
  assert.equal(wastedTripCompensationFor(60, { returned_orders_count: 0 }), 0, "next order: no compensation");
});

test("C/D'. return AFTER delivery (return_confirmed): refund reverses the sale, stock and COGS come back", () => {
  for (const cause of ["customer", "shop"]) {
    const L = stocked();
    const o = online(L, { customer: "c1", deposit: 0 });
    deliver(L, o);
    L.post("courier_settlement", buildCourierSettlementLines({ courierId: "jt", wallet: "inStoreSafe", amount: o.cod, commission: 60 }));
    const feeBorneBy = shippingBorneBy(cause, "return");
    L.post("return_confirmed", buildReturnConfirmedLines({
      items: o.goods, refundAmount: o.total, revenueAmount: o.total, wallet: "inStoreSafe", returnFee: 50, movement: "return",
      feeBorneBy, courierId: "jt", customerId: "c1", channel: "ecommerce",
    }));
    assert.equal(L.bal("stock", "lip").qty, 100, `${cause}: stock restored`);
    assert.equal(L.bal("revenue", "ecommerce").amount, 0, `${cause}: the sale is reversed`);
    assert.equal(L.bal("cogs").amount, 0, `${cause}: COGS reversed`);
    assert.equal(L.bal("customer_ltv", "c1").amount, 0, `${cause}: LTV back to zero`);
    assert.equal(L.bal("expense", "shipping_return").amount, cause === "shop" ? 50 : 0, `${cause}: who bears the trip`);
    assert.equal(countsAsWastedTrip(cause, "return"), cause === "customer");
  }
});

test("E. exchange: goods back in, replacement out, deposit untouched, never a wasted-trip debt", () => {
  const L = stocked();
  const o = online(L, { customer: "c1", deposit: 0 });
  deliver(L, o);
  assert.equal(depositDispositionOn("customer", "exchange"), "none");
  assert.equal(countsAsWastedTrip("customer", "exchange"), false);
  assert.equal(blockingCauseReason("unknown", "exchange") !== null, true, "an exchange needs a cause");
  // The replacement order carries its own shipping, so the return leg charges no second trip.
  const replacement = online(L, { customer: "c1", deposit: 0, goods: [line("lip", 5, 200, 80)] });
  assert.equal(exchangeReturnFee(60, replacement.base), 0, "one trip, one charge");
  L.post("return_confirmed", buildReturnConfirmedLines({
    items: o.goods, refundAmount: o.total, revenueAmount: o.total, wallet: "inStoreSafe", returnFee: 0, movement: "exchange",
    feeBorneBy: shippingBorneBy("customer", "exchange"), courierId: "jt", customerId: "c1", channel: "ecommerce",
  }));
  assert.equal(L.bal("stock", "lip").qty, 95, "100 − 5 (original) − 5 (replacement) + 5 (came back)");
});

test("F/G. partial return is supported and capped; a fully returned order cannot be returned again", () => {
  const order = { id: "o-1", stockItems: [{ productId: "lip", quantity: 3, unitPrice: 200 }, { productId: "serum", quantity: 1, unitPrice: 300 }] };
  const first = [{ original_order_id: "o-1", returned_items: [{ product_id: "lip", quantity: 2 }] }];
  const left = remainingUnits(order, first);
  assert.equal(left.get("lip"), 1, "2 of 3 returned, 1 still returnable");
  assert.equal(left.get("serum"), 1);
  const all = [...first, { original_order_id: "o-1", returned_items: [{ product_id: "lip", quantity: 1 }, { product_id: "serum", quantity: 1 }] }];
  const none = remainingUnits(order, all);
  assert.deepEqual([none.get("lip"), none.get("serum")], [0, 0], "nothing left: a repeat return is refused");
  // A partial return books only what came back.
  const L = stocked();
  const o = online(L, { customer: "c1", deposit: 0, goods: [line("lip", 3, 200, 80)] });
  deliver(L, o);
  L.post("return_confirmed", buildReturnConfirmedLines({
    items: [line("lip", 2, 200, 80)], refundAmount: 400, revenueAmount: 400, wallet: "inStoreSafe", returnFee: 0, movement: "return",
    feeBorneBy: "shop", courierId: "jt", customerId: "c1", channel: "ecommerce",
  }));
  assert.equal(L.bal("stock", "lip").qty, 99);
  assert.equal(L.bal("revenue", "ecommerce").amount, 200, "one lipstick still sold");
});

test("debt consumption: only the order that charged the compensation clears it, once", () => {
  assert.equal(clearsShippingDebt({ shippingPenaltyApplied: true }), true);
  assert.equal(clearsShippingDebt({ shippingPenaltyApplied: false }), false, "after clearing, a replay clears nothing");
  assert.equal(clearsShippingDebt({}), false, "a normal order never clears it");
});

// ═══ 5. Finance / P&L reconciliation ════════════════════════════════════════
test("FINANCE: a trading month reconciles — revenue, COGS, compensation, expenses, wallets, couriers, supplier", () => {
  const L = stocked();                                               // 100 lip @80 on credit
  L.post("supplier_payment", buildSupplierPaymentLines({ supplierId: "sup", wallet: "bankAccount", amount: 5000 }));
  L.post("sale", buildSaleLines({ items: [line("lip", 2, 150, 80)], wallet: "inStoreSafe", customerId: "c-pos" }));
  const a = online(L, { customer: "c-a" });
  const b = online(L, { customer: "c-b", repeat: true });
  deliver(L, a); deliver(L, b);
  const c = online(L, { customer: "c-c" });
  L.post("order_cancelled", buildOrderCancelledLines({ items: c.goods, forfeitedDeposit: 300, wallet: "vodafoneCash", customerId: "c-c" }));
  L.post("courier_settlement", buildCourierSettlementLines({ courierId: "jt", wallet: "inStoreSafe", amount: a.cod + b.cod, commission: 120 }));
  L.post("expense", buildExpenseLines({ category: "rent", wallet: "inStoreSafe", amount: 4000 }));

  const report = pnl({ revenueRows: L.rows("revenue"), expenseRows: L.rows("expense"), cogs: L.bal("cogs").amount, returnsRevenue: 0, purchases: 8000 });
  assert.equal(report.netSales, 300 + 1000 + 1000 + 60 + 300, "POS + 2 deliveries + compensation + forfeited deposit");
  assert.equal(report.cogs, 12 * 80);
  assert.equal(report.netProfit, report.netSales - 960 - 4000);
  assert.deepEqual(report.salesByChannel.map((r) => r.subjectId).sort(), ["ecommerce", "forfeited_deposit", "pos", "wasted_trip_compensation"]);
  assert.equal(L.bal("payable_supplier", "sup").amount, 3000);
  assert.equal(L.bal("receivable_courier").amount, 0);
  assert.equal(L.bal("payable_courier").amount, 0);
  assert.equal(L.bal("wallet", "inStoreSafe").amount, 300 + (760 + 820 - 120) - 4000);
  assert.equal(L.bal("wallet", "vodafoneCash").amount, 900, "three deposits, one forfeited and kept");
  assert.equal(L.bal("wallet", "bankAccount").amount, -5000);
  assert.equal(L.bal("stock", "lip").qty, 100 - 2 - 5 - 5, "cancelled order's 5 came back");
  // Every customer's lifetime value is exactly the revenue they produced.
  assert.deepEqual([L.bal("customer_ltv", "c-pos").amount, L.bal("customer_ltv", "c-a").amount, L.bal("customer_ltv", "c-b").amount], [300, 1000, 1060]);
  // No event the validator would refuse was ever posted (checked on every post).
  assert.ok(L.events.length >= 10);
});

// ═══ 6. Period filters across a YEAR boundary ═══════════════════════════════
test("DATES: 2025-12-31 → 2026-01-01 — inclusive both ends, Cairo midnight, no off-by-one", () => {
  const b = dayRangeBounds("2025-12-31", "2026-01-01");
  assert.equal(b.start.toISOString(), "2025-12-30T22:00:00.000Z", "31 Dec 00:00 Cairo (UTC+2 in winter)");
  assert.equal(b.end.toISOString(), "2026-01-01T22:00:00.000Z", "2 Jan 00:00 Cairo — exclusive");
  const at = (iso, id) => ({ id, createdAt: iso });
  const orders = [
    at("2025-12-30T21:59:59.999Z", "30dec-2359"), at("2025-12-30T22:00:00.000Z", "31dec-0000"),
    at("2025-12-31T21:59:59.999Z", "31dec-2359"), at("2025-12-31T22:00:00.000Z", "01jan-0000"),
    at("2026-01-01T21:59:59.999Z", "01jan-2359"), at("2026-01-01T22:00:00.000Z", "02jan-0000"),
  ];
  assert.deepEqual(ordersInPeriod(orders, "2025-12-31", "2026-01-01").map((o) => o.id), ["31dec-0000", "31dec-2359", "01jan-0000", "01jan-2359"]);
  assert.deepEqual(ordersInPeriod(orders, "2026-01-01", "2026-01-01").map((o) => o.id), ["01jan-0000", "01jan-2359"], "start = end is one whole day");
  // The dashboard/P&L custom window uses the same inclusive rule.
  const w = customWindow("2025-12-31", "2026-01-01");
  assert.equal(w.from.toISOString(), b.start.toISOString());
  assert.equal(w.to.toISOString(), b.end.toISOString());
  assert.equal(customWindow("2026-01-01", "2025-12-31"), null, "reversed refused");
});
