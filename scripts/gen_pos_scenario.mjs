/**
 * Generates the §1.3 receive-then-sell scenario as wire JSON, using the REAL
 * production functions — `buildPurchaseLines`, `averageCost`, `buildSaleLines`
 * and `toPiastres` — not hand-written copies.
 *
 * The Rust test `pos_scenario.rs` appends this exact JSON through the real
 * ledger and asserts the balances. If the TypeScript builders change, the
 * fixture changes and the Rust assertions catch it.
 *
 *     node scripts/gen_pos_scenario.mjs
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildPurchaseLines,
  buildSupplierPaymentLines,
  averageCost,
} from "../src/lib/ledger/purchases.ts";
import { buildSaleLines, saleTotal } from "../src/lib/ledger/sales.ts";
import {
  buildWholesaleInvoiceLines,
  buildClientPaymentLines,
} from "../src/lib/ledger/wholesale.ts";
import {
  buildOrderPlacedLines,
  buildOrderDeliveredLines,
  buildReturnPendingLines,
  buildReturnConfirmedLines,
  buildCourierSettlementLines,
  buildOrderCancelledLines,
  buildOrderEditLines,
  orderItemsTotal,
} from "../src/lib/ledger/orders.ts";
import {
  buildStockAdjustmentLines,
  buildOpeningBalanceLines,
  buildWalletOpeningLines,
} from "../src/lib/ledger/audit.ts";
import { toPiastres } from "../src/lib/ledger/money.ts";

const STORE = "store-scenario";
const DEVICE = "device-scenario";
const SHOE = "p-shoe";
const MUG = "p-mug";
const CUSTOMER = "cust-1";
const WALLET = "inStoreSafe";
const VODAFONE = "vodafoneCash";
const SUPPLIER = "sup-3";
const CLIENT = "client-7";
const COURIER = "courier-1";
const ONLINE_CUSTOMER = "cust-online";

let seq = 0;
const id = (tag) => `${tag}-${String(++seq).padStart(4, "0")}`;

/** Mirrors appendEvent(): fills bookkeeping and converts EGP → piastres. */
function wire(kind, lines, extra = {}) {
  return {
    id: id(kind),
    store_id: STORE,
    device_id: DEVICE,
    kind,
    occurred_at: "2026-08-16T09:00:00Z",
    created_at: "2026-08-16T09:00:00Z",
    actor: extra.actor ?? "POS",
    ref_type: extra.refType ?? null,
    ref_id: extra.refId ?? null,
    payload: JSON.stringify(extra.payload ?? {}),
    lines: lines.map((l) => ({
      id: id("line"),
      account: l.account,
      subject_id: l.subjectId,
      qty_delta: l.qty ?? 0,
      amount_delta: toPiastres(l.amount ?? 0),
      unit_cost: l.unitCost === undefined ? null : toPiastres(l.unitCost),
    })),
  };
}

// ── 1. The till opens with a 10,000.00 float ───────────────────────────────
const float = wire("stock_adjustment", [{ account: "wallet", subjectId: WALLET, amount: 10000 }], {
  actor: "opening",
});

// ── 2. Receive 10 pairs @ 600.00, paid cash ────────────────────────────────
const firstReceipt = [{ productId: SHOE, quantity: 10, unitCost: 600 }];
const purchaseCash = wire("purchase", buildPurchaseLines({ items: firstReceipt, wallet: WALLET }), {
  actor: "توريد",
  refType: "supplier_invoice",
});

// ── 3. Receive 10 more @ 800.00, on credit ─────────────────────────────────
// Different price on purpose: the sale must use the BLENDED cost, not either
// receipt's price and not a field on the product record.
const secondReceipt = [{ productId: SHOE, quantity: 10, unitCost: 800 }];
const purchaseCredit = wire(
  "purchase",
  buildPurchaseLines({ items: secondReceipt, supplierId: SUPPLIER }),
  { actor: "توريد", refType: "supplier_invoice" },
);

// ── 4. Receive 5 more @ 700.00, part-paid: 2,000 cash now, rest on credit ──
// The receipt total is 3,500 — the split must land 2,000 in the till and
// 1,500 on the supplier's tab, with all 5 units arriving either way.
const thirdReceipt = [{ productId: SHOE, quantity: 5, unitCost: 700 }];
const purchaseSplit = wire(
  "purchase",
  buildPurchaseLines({
    items: thirdReceipt,
    wallet: WALLET,
    supplierId: SUPPLIER,
    paidAmount: 2000,
  }),
  { actor: "توريد", refType: "supplier_invoice" },
);

// ── 5. Pay the supplier 3,500 of what is owed ──────────────────────────────
// The debt stands at 8,000 (credit receipt) + 1,500 (unpaid rest of the split)
// = 9,500. Paying 3,500 must leave exactly 6,000 — the direction the ledger
// could not express until `supplier_payment` was wired.
const SUPPLIER_PAYMENT = 3500;
const supplierPayment = wire(
  "supplier_payment",
  buildSupplierPaymentLines({
    supplierId: SUPPLIER,
    wallet: WALLET,
    amount: SUPPLIER_PAYMENT,
  }),
  { actor: "توريد", refType: "supplier_invoice" },
);

// ── 6. Cost the sale from the ledger, exactly as useStock/costOf does ──────
// 10@600 + 10@800 + 5@700 = 17,500 over 25 units.
const onHand = { qty: 25, amount: 6000 + 8000 + 3500 };
const derivedCost = averageCost(onHand); // 17500 / 25 = 700

// ── 7. POS sells 2 pairs @ 1000.00 to a known customer ─────────────────────
const cart = [{ productId: SHOE, quantity: 2, unitPrice: 1000, unitCost: derivedCost }];
const sale = wire("sale", buildSaleLines({ items: cart, wallet: WALLET, customerId: CUSTOMER }), {
  refType: "pos_sale",
  refId: "POS-0001",
  payload: { channel: "pos", itemCount: cart.length },
});

const revenue = saleTotal(cart); // 2000
const cogs = derivedCost * 2; // 1400

// ── 8. Wholesale: 5 pairs @ 900 on mostly-credit, with delivery ────────────
// Sold out of the SAME stock the receipts created, costed at the SAME blended
// 700 — this is what proves wholesale and POS share one inventory and one cost
// basis rather than each keeping its own.
const wholesaleCart = [
  { productId: SHOE, quantity: 5, unitPrice: 900, unitCost: derivedCost },
];
const WHOLESALE_PREPAID = 700;
const SHIPPING_CHARGE = 200;
const SHIPPING_COST = 150;
const wholesaleInvoice = wire(
  "sale",
  buildWholesaleInvoiceLines({
    items: wholesaleCart,
    clientId: CLIENT,
    wallet: WALLET,
    paidAmount: WHOLESALE_PREPAID,
    shippingCharge: SHIPPING_CHARGE,
    shippingCost: SHIPPING_COST,
  }),
  { actor: "جملة", refType: "wholesale_invoice", payload: { channel: "wholesale" } },
);

const wholesaleGoods = 900 * 5; // 4500
const wholesaleTotalDue = wholesaleGoods + SHIPPING_CHARGE; // 4700
const wholesaleCogs = derivedCost * 5; // 3500

// ── 9. The client pays 1,500 of what they owe ─────────────────────────────
// 4700 invoiced − 700 prepaid = 4000 owed; paying 1500 must leave 2500.
const CLIENT_PAYMENT = 1500;
const clientPayment = wire(
  "client_payment",
  buildClientPaymentLines({ clientId: CLIENT, wallet: WALLET, amount: CLIENT_PAYMENT }),
  { actor: "جملة", refType: "wholesale_invoice" },
);

// ── 10. Online order: placed (stock reserved, nothing sold) ───────────────
// 3 pairs @ 1100 + 60 shipping = 3360 due; 360 paid up front, 3000 on COD.
const onlineCart = [{ productId: SHOE, quantity: 3, unitPrice: 1100, unitCost: derivedCost }];
const ONLINE_SHIPPING = 60; // the delivery rate for this governorate
const ONLINE_TOTAL = 1100 * 3 + ONLINE_SHIPPING; // 3360
const ONLINE_DEPOSIT = 360;
const ONLINE_COD = 3000;
const orderPlaced = wire("order_placed", buildOrderPlacedLines({ items: onlineCart }), {
  actor: "أونلاين",
  refType: "ecommerce_order",
});

// ── 11. Delivered: the sale is booked, COD sits with the courier ──────────
const orderDelivered = wire(
  "order_delivered",
  buildOrderDeliveredLines({
    items: onlineCart,
    // Goods and the delivery fee kept apart: only the goods are revenue.
    goodsTotal: ONLINE_TOTAL - ONLINE_SHIPPING,
    shippingFee: ONLINE_SHIPPING,
    depositAmount: ONLINE_DEPOSIT,
    wallet: WALLET,
    codAmount: ONLINE_COD,
    courierId: COURIER,
    customerId: ONLINE_CUSTOMER,
    channel: "ecommerce",
  }),
  { actor: "أونلاين", refType: "ecommerce_order" },
);
const onlineCogs = derivedCost * 3; // 2100

// ── 12. The courier hands the COD over, keeping a 150 commission ──────────
// They withhold exactly the delivery fee they were owed at this point. The
// return has not happened yet, so its fee is still outstanding afterwards.
const COURIER_COMMISSION = ONLINE_SHIPPING;
const courierSettlement = wire(
  "courier_settlement",
  buildCourierSettlementLines({
    courierId: COURIER,
    wallet: WALLET,
    amount: ONLINE_COD,
    commission: COURIER_COMMISSION,
  }),
  { actor: "أونلاين", refType: "ecommerce_order" },
);

// ── 13. The courier CLAIMS a return — this must move NOTHING ──────────────
// Zero lines on purpose (§3.9). The Rust test asserts the event exists AND
// that it carries no lines, so "nothing moved" is a confirmed fact rather
// than the shape a missing event would also have.
const returnPending = wire("order_returned_pending", buildReturnPendingLines(), {
  actor: "أونلاين",
  refType: "ecommerce_order",
});

// ── 14. A human confirms the goods arrived — six lines ────────────────────
const RETURN_FEE = 80;
const returnConfirmed = wire(
  "return_confirmed",
  buildReturnConfirmedLines({
    items: onlineCart,
    // The goods are refunded and their revenue reversed. The delivery fee was
    // never our revenue, so there is none of it to reverse.
    refundAmount: ONLINE_TOTAL - ONLINE_SHIPPING,
    wallet: WALLET,
    revenueAmount: ONLINE_TOTAL - ONLINE_SHIPPING,
    returnFee: RETURN_FEE,
    movement: "return",
    courierId: COURIER,
    customerId: ONLINE_CUSTOMER,
    channel: "ecommerce",
  }),
  { actor: "أونلاين", refType: "ecommerce_order" },
);

// ── 15. A second order is placed and then CANCELLED before delivery ───────
// The reserved stock has to come back. Without `order_cancelled` these 4
// units would be gone from the shelf with nothing pointing at them — the
// forgotten reverse direction on the online path.
const cancelCart = [{ productId: SHOE, quantity: 4, unitPrice: 1100, unitCost: derivedCost }];
const orderPlacedThenCancelled = wire(
  "order_placed",
  buildOrderPlacedLines({ items: cancelCart }),
  { actor: "أونلاين", refType: "ecommerce_order" },
);
const orderCancelled = wire("order_cancelled", buildOrderCancelledLines({ items: cancelCart }), {
  actor: "أونلاين",
  refType: "ecommerce_order",
});

// ── 16. جرد: the shelf is counted and 2 pairs are missing ────────────────
// Stock stands at 18 after everything above. The count finds 16 — two pairs
// walked. Valued at the ledger's real 700 each, not a flat guess.
const STOCK_BEFORE_AUDIT = 18;
const COUNTED = 16;
const auditItems = [
  {
    productId: SHOE,
    systemQty: STOCK_BEFORE_AUDIT,
    countedQty: COUNTED,
    unitCost: derivedCost,
  },
];
const stockAudit = wire("stock_adjustment", buildStockAdjustmentLines({ items: auditItems }), {
  actor: "جرد",
  refType: "stock_audit",
});
const SHRINKAGE = (STOCK_BEFORE_AUDIT - COUNTED) * derivedCost; // 1400

// ── 17. A shop that already had stock: opening balance, then a sale ──────
// The owner registers a product she has owned for months and enters "I have
// 40 on the shelf". No توريد happened — no supplier, no cash — so this writes
// ONE stock line and no expense. Then she sells 2, and the ledger must read 38
// with the cost coming from the opening figure.
const OPENING_QTY = 40;
const OPENING_COST = 25;
const openingBalance = wire(
  "stock_adjustment",
  buildOpeningBalanceLines({ productId: MUG, quantity: OPENING_QTY, unitCost: OPENING_COST }),
  { actor: "رصيد افتتاحي", refType: "opening_balance", refId: MUG },
);

const MUG_SOLD = 2;
const MUG_PRICE = 60;
const mugCart = [
  { productId: MUG, quantity: MUG_SOLD, unitPrice: MUG_PRICE, unitCost: OPENING_COST },
];
// A guest sale — no customer, so no LTV line. Four lines, not five.
const mugSale = wire("sale", buildSaleLines({ items: mugCart, wallet: WALLET }), {
  refType: "pos_sale",
  refId: "POS-0002",
  payload: { channel: "pos", itemCount: mugCart.length },
});
const mugRevenue = MUG_PRICE * MUG_SOLD; // 120
const mugCogs = OPENING_COST * MUG_SOLD; // 50

// ── 18. A pending order is EDITED: swap a product and change a quantity ──
// Placed with 2 shoes; edited to 1 shoe + 6 mugs. The old order_placed event is
// untouched — the edit writes its own event holding only what changed: 1 shoe
// back on the shelf, 6 mugs off it.
const editBefore = [{ productId: SHOE, quantity: 2, unitPrice: 1100, unitCost: derivedCost }];
const editAfter = [
  { productId: SHOE, quantity: 1, unitPrice: 1100, unitCost: derivedCost },
  { productId: MUG, quantity: 6, unitPrice: 60, unitCost: OPENING_COST },
];
const editedOrderPlaced = wire("order_placed", buildOrderPlacedLines({ items: editBefore }), {
  actor: "أونلاين",
  refType: "ecommerce_order",
  refId: "ECO-EDIT",
});
const orderEdited = wire(
  "order_edited",
  buildOrderEditLines({ before: editBefore, after: editAfter }),
  { actor: "أونلاين", refType: "ecommerce_order", refId: "ECO-EDIT" },
);
// 1 shoe reserved (−700) and 6 mugs reserved (−150) once the dust settles.
const EDIT_SHOE_HELD = 1;
const EDIT_MUG_HELD = 6;
const EDIT_TOTAL = orderItemsTotal(editAfter); // 1100 + 360 = 1460

// ── 19. Wallets are independent: Vodafone opens at 500, then takes a sale ─
// The reported bug was a POS till that never moved after a sale. These two
// events prove each wallet moves on its own: Vodafone gets an opening balance
// and one sale, and the cash till must be untouched by either.
const VODAFONE_OPENING = 500;
const walletOpening = wire(
  "stock_adjustment",
  buildWalletOpeningLines({ wallet: VODAFONE, amount: VODAFONE_OPENING }),
  { actor: "رصيد افتتاحي", refType: "opening_balance", refId: VODAFONE },
);

// A 200 sale paid by Vodafone Cash — 4 lines, and the money lands on VODAFONE.
const VODAFONE_SALE = 200;
const vodafoneCart = [
  { productId: MUG, quantity: 4, unitPrice: 50, unitCost: OPENING_COST },
];
const vodafoneSale = wire(
  "sale",
  buildSaleLines({ items: vodafoneCart, wallet: VODAFONE }),
  { refType: "pos_sale", refId: "POS-0003", payload: { channel: "pos" } },
);
const vodafoneSoldQty = 4;
const vodafoneCogs = OPENING_COST * vodafoneSoldQty;

const out = {
  store_id: STORE,
  derived_cost: derivedCost,
  events: [
    float,
    purchaseCash,
    purchaseCredit,
    purchaseSplit,
    supplierPayment,
    sale,
    wholesaleInvoice,
    clientPayment,
    orderPlaced,
    orderDelivered,
    courierSettlement,
    returnPending,
    returnConfirmed,
    orderPlacedThenCancelled,
    orderCancelled,
    stockAudit,
    openingBalance,
    mugSale,
    editedOrderPlaced,
    orderEdited,
    walletOpening,
    vodafoneSale,
  ],
  // What the ledger must report afterwards. EGP, as a human reads it.
  // Keys are labels only — `account` says which account is being checked, so
  // two subjects on the same account (retail vs wholesale revenue) both fit.
  expected: {
    // 25 received, 2 sold retail, 5 sold wholesale. Value in 17500, out at the
    // blended cost both times.
    // 25 received; 2 retail, 5 wholesale, 3 online out and 3 back again, then
    // 4 reserved and cancelled. Both round trips must leave stock exactly
    // where it started — a cancel that swallowed stock would show up here.
    // …then the جرد corrects 18 down to the 16 actually on the shelf, and the
    // edited order holds 1 shoe in reservation.
    stock: {
      account: "stock",
      subject: SHOE,
      qty: COUNTED - EDIT_SHOE_HELD,
      egp:
        17500 -
        cogs -
        wholesaleCogs -
        onlineCogs +
        onlineCogs -
        SHRINKAGE -
        EDIT_SHOE_HELD * derivedCost,
    },
    // 10000 float − 6000 cash purchase − 2000 part payment − 3500 supplier
    // settlement + 2000 POS sale + 700 wholesale prepaid + 1500 collected.
    wallet: {
      account: "wallet",
      subject: WALLET,
      qty: 0,
      egp:
        10000 -
        6000 -
        2000 -
        SUPPLIER_PAYMENT +
        revenue +
        WHOLESALE_PREPAID +
        CLIENT_PAYMENT +
        // online: deposit in, courier's cash in (less their cut), refund out
        ONLINE_DEPOSIT +
        (ONLINE_COD - COURIER_COMMISSION) -
        (ONLINE_TOTAL - ONLINE_SHIPPING) +
        mugRevenue,
    },
    // 8000 full credit + 1500 unpaid rest of the split, less 3500 paid back.
    payable_supplier: {
      account: "payable_supplier",
      subject: SUPPLIER,
      qty: 0,
      egp: 8000 + 1500 - SUPPLIER_PAYMENT,
    },
    // 4700 invoiced − 700 prepaid − 1500 collected. The direction the ledger
    // could not express before `client_payment` existed.
    receivable_client: {
      account: "receivable_client",
      subject: CLIENT,
      qty: 0,
      egp: wholesaleTotalDue - WHOLESALE_PREPAID - CLIENT_PAYMENT,
    },
    // POS revenue now covers the shoe sale and the mug sale.
    revenue_pos: {
      account: "revenue",
      subject: "pos",
      qty: 0,
      egp: revenue + mugRevenue + VODAFONE_SALE,
    },
    // The whole point: opening 40, sold 2, reads 38 — from the ledger, with the
    // value still at the opening cost.
    // 40 opening − 2 sold − 6 reserved by the edited order − 4 sold on Vodafone.
    stock_mug: {
      account: "stock",
      subject: MUG,
      qty: OPENING_QTY - MUG_SOLD - EDIT_MUG_HELD - vodafoneSoldQty,
      egp:
        OPENING_QTY * OPENING_COST -
        mugCogs -
        EDIT_MUG_HELD * OPENING_COST -
        vodafoneCogs,
    },
    // THE POINT: Vodafone opened at 500 and took a 200 sale → 700. Nothing
    // else in the whole scenario touched it, and the cash till below is
    // unaffected by either event.
    wallet_vodafone: {
      account: "wallet",
      subject: VODAFONE,
      qty: 0,
      egp: VODAFONE_OPENING + VODAFONE_SALE,
    },
    cogs_mug: { account: "cogs", subject: MUG, qty: 0, egp: mugCogs + vodafoneCogs },
    // Booked at delivery, fully reversed at return_confirmed → exactly zero.
    revenue_ecommerce: { account: "revenue", subject: "ecommerce", qty: 0, egp: 0 },
    // Delivered put the COD on the courier; settlement cleared it.
    receivable_courier: { account: "receivable_courier", subject: COURIER, qty: 0, egp: 0 },
    // What we owe the courier: the delivery fee we collected FOR them (60) plus
    // the return fee we owe them (80), less the 150 they withheld at settlement.
    payable_courier: {
      account: "payable_courier",
      subject: COURIER,
      qty: 0,
      egp: ONLINE_SHIPPING + RETURN_FEE - COURIER_COMMISSION,
    },
    // The online customer's LTV rose on delivery and came back down on the
    // confirmed return — they did not really spend this.
    customer_ltv_online: {
      account: "customer_ltv",
      subject: ONLINE_CUSTOMER,
      qty: 0,
      egp: 0,
    },
    revenue_wholesale: {
      account: "revenue",
      subject: "wholesale",
      qty: 0,
      egp: wholesaleTotalDue,
    },
    // Both channels book cost against the same product, at the same cost.
    // Online COGS booked at delivery and reversed at the confirmed return, so
    // only the retail and wholesale costs remain.
    cogs: { account: "cogs", subject: SHOE, qty: 0, egp: cogs + wholesaleCogs },
    // Wholesale delivery cost is ours (that path bills it to us directly).
    expense_shipping: {
      account: "expense",
      subject: "shipping",
      qty: 0,
      egp: SHIPPING_COST,
    },
    // THE POINT: the shop's shipping cost is the RETURN only. The online
    // delivery fee (60) was the customer's and never reaches expense.
    expense_shipping_return: {
      account: "expense",
      subject: "shipping_return",
      qty: 0,
      egp: RETURN_FEE,
    },
    // Missing stock is a cost, booked at what the goods really cost us.
    expense_shrinkage: {
      account: "expense",
      subject: "shrinkage",
      qty: 0,
      egp: SHRINKAGE,
    },
    // Wholesale writes no LTV line — trade orders must not inflate retail LTV.
    customer_ltv: { account: "customer_ltv", subject: CUSTOMER, qty: 0, egp: revenue },
  },
};

const target = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src-tauri",
  "tests",
  "pos_scenario.json",
);
writeFileSync(target, JSON.stringify(out, null, 2), "utf-8");

console.log(`wrote ${target}`);
console.log(`  received:      10 @ 600.00 (cash) + 10 @ 800.00 (credit) + 5 @ 700.00 (part-paid)`);
console.log(`  supplier debt: 9500.00 owed − ${SUPPLIER_PAYMENT.toFixed(2)} paid = 6000.00 left`);
console.log(`  derived cost:  ${derivedCost.toFixed(2)} EGP  ← blended, from the ledger`);
console.log(`  sold:          2 @ 1000.00  → COGS ${cogs.toFixed(2)}`);
console.log(`  sale lines:    ${sale.lines.length}`);
console.log(
  `  wholesale:     5 @ 900.00 + ${SHIPPING_CHARGE.toFixed(2)} shipping = ${wholesaleTotalDue.toFixed(2)} due`,
);
console.log(
  `  client debt:   ${(wholesaleTotalDue - WHOLESALE_PREPAID).toFixed(2)} owed − ${CLIENT_PAYMENT.toFixed(2)} paid = ${(wholesaleTotalDue - WHOLESALE_PREPAID - CLIENT_PAYMENT).toFixed(2)} left`,
);
console.log(
  `  online order:  placed(${orderPlaced.lines.length}) → delivered(${orderDelivered.lines.length}) → settled(${courierSettlement.lines.length}) → return claimed(${returnPending.lines.length}) → confirmed(${returnConfirmed.lines.length})`,
);
console.log(
  `  cancelled:     placed 4 units then cancelled → stock back, net 0`,
);
console.log(
  `  جرد:           counted ${COUNTED} against ${STOCK_BEFORE_AUDIT} → shrinkage ${SHRINKAGE.toFixed(2)} EGP at real cost`,
);
console.log(
  `  opening bal:   registered ${MUG} with ${OPENING_QTY} on the shelf @ ${OPENING_COST} → sold ${MUG_SOLD} → reads ${OPENING_QTY - MUG_SOLD}`,
);
console.log(
  `  order edit:    2 shoes → 1 shoe + 6 mugs = ${orderEdited.lines.length} lines, new total ${EDIT_TOTAL.toFixed(2)}`,
);
console.log(
  `  wallets:       ${VODAFONE} opens ${VODAFONE_OPENING.toFixed(2)} + sale ${VODAFONE_SALE.toFixed(2)} = ${(VODAFONE_OPENING + VODAFONE_SALE).toFixed(2)} (cash till untouched)`,
);
