/**
 * 044 — every NEW ledger event must make sense for its kind.
 *
 *     node --test scripts/check_ledger_semantic_integrity.mjs
 *
 * Three things are pinned here, and each one guards a different failure:
 *
 *   1. THE BUILDERS SATISFY THE DATABASE. Every line builder in src/lib/ledger
 *      is run on realistic inputs — partial payments, discounts, deposits,
 *      fees borne by either side, forfeits, fractions — and its output, rounded
 *      per line exactly as `driver.ts` rounds it, is checked against the SAME
 *      per-kind equations `ledger_validate_event` enforces. If a builder ever
 *      changes shape, this fails in CI instead of the till refusing a real sale
 *      in production.
 *   2. THE LISTS CANNOT DRIFT. The kinds, accounts and wallets the validator
 *      accepts are compared with the TypeScript unions and WALLET_LABELS.
 *   3. THE SQL HOLDS, and every protecting predicate is load-bearing: each is
 *      removed from a copy of the migration and the checker must notice.
 *
 * The behaviour itself was proven against the live database in rolled-back
 * transactions with scripts/security/044_semantic_matrix.sql — see
 * DESKTOP_PRODUCT_AUDIT.md §I.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildSaleLines } from "../src/lib/ledger/sales.ts";
import {
  buildOrderPlacedLines, buildOrderPaymentLines, buildOrderDeliveredLines, buildOrderCancelledLines,
  buildOrderEditLines, buildReturnConfirmedLines, buildOrderRTOLines, buildCourierSettlementLines,
  buildCourierBatchSettlementLines, buildReturnPendingLines,
} from "../src/lib/ledger/orders.ts";
import { buildPurchaseLines, buildSupplierPaymentLines, buildSupplierReturnLines } from "../src/lib/ledger/purchases.ts";
import { buildWholesaleInvoiceLines, buildClientPaymentLines, buildWholesaleReturnLines } from "../src/lib/ledger/wholesale.ts";
import { buildStockAdjustmentLines, buildOpeningBalanceLines, buildWalletOpeningLines, buildWalletTransferLines } from "../src/lib/ledger/audit.ts";
import { buildExpenseLines } from "../src/lib/ledger/expenses.ts";
import { buildOwnerDrawLines } from "../src/lib/ledger/ownerDraw.ts";
import { toPiastres } from "../src/lib/ledger/money.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const sql = (text) => text.replace(/--[^\n]*/g, "");
const MIGRATION = read("docs/migrations/044_ledger_event_semantic_integrity.sql");
const MATRIX = read("scripts/security/044_semantic_matrix.sql");

// ═══ The oracle: the validator's per-kind rules, in JS ═════════════════════
//
// Deliberately a transcription of the SQL, not an import of it — this is the
// independent second reading that makes a divergence visible.

const WALLETS = ["instoresafe", "vodafonecash", "instapay", "bankaccount"];
const ALLOWED = {
  sale: ["stock", "cogs", "wallet", "receivable_client", "revenue", "customer_ltv", "expense"],
  order_placed: ["stock", "wallet"],
  order_edited: ["stock"],
  order_cancelled: ["stock", "wallet", "revenue", "customer_ltv"],
  order_delivered: ["cogs", "receivable_courier", "revenue", "payable_courier", "customer_ltv"],
  return_confirmed: ["stock", "cogs", "wallet", "receivable_client", "receivable_courier", "payable_courier", "revenue", "expense", "customer_ltv"],
  rto_confirmed: ["stock", "payable_courier", "expense", "receivable_courier", "wallet", "revenue", "customer_ltv"],
  purchase: ["stock", "wallet", "payable_supplier"],
  supplier_payment: ["wallet", "payable_supplier"],
  client_payment: ["wallet", "receivable_client"],
  expense: ["wallet", "expense"],
  payroll: ["wallet", "expense"],
  wallet_transfer: ["wallet"],
  courier_settlement: ["wallet", "receivable_courier", "payable_courier", "expense"],
  owner_draw: ["wallet", "owner_budget"],
  stock_adjustment: ["stock", "expense", "wallet"],
};

/** Lines as `driver.ts` sends them: amounts rounded to piastres, per line. */
const wire = (lines) => lines.map((l) => ({
  account: l.account, subject: l.subjectId, q: l.qty ?? 0, a: toPiastres(l.amount ?? 0),
  uc: l.unitCost === undefined ? null : toPiastres(l.unitCost),
}));

function violations(kind, raw, ctx = {}) {
  const lines = wire(raw);
  const out = [];
  const sum = (acc) => lines.filter((l) => l.account === acc).reduce((s, l) => s + l.a, 0);
  const count = (f) => lines.filter(f).length;
  const [w, r, rc, rco, pc, ps, ex, st, ltv, ob] =
    ["wallet", "revenue", "receivable_client", "receivable_courier", "payable_courier",
     "payable_supplier", "expense", "stock", "customer_ltv", "owner_budget"].map(sum);
  if (kind === "order_returned_pending") return lines.length === 0 ? [] : ["pending moves nothing"];
  if (lines.length === 0) return ["must move something"];
  if (count((l) => l.account !== "stock" && l.q !== 0)) out.push("qty off stock");
  if (count((l) => l.account === "stock" && (l.q === 0 || (l.q > 0 && l.a < 0) || (l.q < 0 && l.a > 0)))) out.push("stock sign");
  if (count((l) => l.uc !== null && (l.uc < 0 || !["stock", "cogs"].includes(l.account)))) out.push("unit cost");
  if (count((l) => l.account === "wallet" && !WALLETS.includes(String(l.subject).toLowerCase()))) out.push("wallet");
  if (ALLOWED[kind] && count((l) => !ALLOWED[kind].includes(l.account))) out.push(`${kind} cannot move that account`);
  const stockIn = count((l) => l.account === "stock" && l.q > 0);
  const stockOut = count((l) => l.account === "stock" && l.q < 0);
  const walletIn = count((l) => l.account === "wallet" && l.a > 0);
  const walletOut = count((l) => l.account === "wallet" && l.a <= 0);
  const revNotDeposit = count((l) => l.account === "revenue" && (l.a <= 0 || !["forfeited_deposit", "deposit_pending_resolution"].includes(l.subject)));
  const ltvOk = ltv === 0 || ltv === r;
  switch (kind) {
    case "sale": if (w + rc !== r || !ltvOk || count((l) => l.account === "expense" && l.a < 0)) out.push("sale equation"); break;
    case "order_edited": break; // stock only — the allowed-account check above is the whole rule
    case "order_placed": if (!stockOut || stockIn || walletOut) out.push("order_placed shape"); break;
    case "order_cancelled": if (stockOut || walletIn || revNotDeposit || (w < 0 && r > 0) || !ltvOk) out.push("cancel shape"); break;
    case "order_delivered": if ((ctx.priorDeposits ?? 0) + rco > r + pc || !ltvOk) out.push("COD exceeds owed"); break;
    case "return_confirmed": if (w + rc + rco - pc + ex !== r || r > 0 || stockOut || !ltvOk) out.push("return equation"); break;
    case "rto_confirmed": if (rco - pc + ex !== 0 || walletIn || revNotDeposit || stockOut || !ltvOk) out.push("rto equation"); break;
    case "purchase": if (st + w - ps !== 0) out.push("purchase equation"); break;
    case "supplier_payment": if (w !== ps || w >= 0) out.push("supplier payment"); break;
    case "client_payment":
      if (walletOut) out.push("payment out");
      if (lines.some((l) => l.account === "receivable_client")) { if (w + rc !== 0) out.push("client payment equation"); }
      else if (ctx.orderOutstanding === undefined || w > toPiastres(ctx.orderOutstanding)) out.push("top-up not backed by order");
      break;
    case "expense": case "payroll": if (w + ex !== 0 || w >= 0) out.push("expense equation"); break;
    case "wallet_transfer": if (lines.length < 2 || w !== 0) out.push("transfer creates money"); break;
    case "courier_settlement": if (w + rco - pc + ex !== 0 || walletOut || count((l) => l.account === "receivable_courier" && l.a >= 0) || count((l) => l.account === "payable_courier" && l.a >= 0)) out.push("settlement equation"); break;
    case "owner_draw": if (w + ob !== 0 || w >= 0) out.push("draw equation"); break;
    case "stock_adjustment":
      if (walletIn + walletOut && (ctx.refType !== "opening_balance" || lines.length !== 1)) out.push("wallet in adjustment");
      if (count((l) => l.account === "expense") && st + ex !== 0) out.push("audit equation");
      break;
    default: out.push(`unknown kind ${kind}`);
  }
  return out;
}

const item = (over = {}) => ({ productId: "p1", quantity: 2, unitPrice: 150, unitCost: 90, ...over });
const ok = (kind, lines, ctx) => assert.deepEqual(violations(kind, lines, ctx), [], `${kind}: ${JSON.stringify(wire(lines))}`);

// ═══ 1. Every builder, realistic inputs, against the database's rules ═══════

test("POS sales, refunds, exchanges and discounts satisfy the sale equation", () => {
  ok("sale", buildSaleLines({ items: [item()], wallet: "inStoreSafe", customerId: "c1" }));
  ok("sale", buildSaleLines({ items: [item(), item({ productId: "p2", unitPrice: 33.33, quantity: 3 })], wallet: "vodafoneCash", discountAmount: 12.49 }));
  ok("sale", buildSaleLines({ items: [item({ quantity: -1 })], wallet: "inStoreSafe", customerId: "c1" }), undefined); // return mode
  ok("sale", buildSaleLines({ items: [item({ quantity: -1 }), item({ productId: "p2", quantity: 1, unitPrice: 200 })], wallet: "inStoreSafe" }));
});

test("wholesale invoices, payments and returns — including fractional discounts", () => {
  for (const paidAmount of [0, 100, 333.33, 1000.005]) {
    ok("sale", buildWholesaleInvoiceLines({
      clientId: "w1", wallet: "instaPay", paidAmount: Math.min(paidAmount, 900),
      items: [item({ quantity: 7, unitPrice: 133.337 })], discountAmount: 17.777, shippingCharge: 45.5, shippingCost: 30,
    }));
  }
  ok("sale", buildWholesaleInvoiceLines({ clientId: "w1", skipStockDeduction: true, items: [item()] }));
  ok("client_payment", buildClientPaymentLines({ clientId: "w1", wallet: "inStoreSafe", amount: 250.75 }));
  const resolved = { clientId: "w1", lines: [{ ...item({ quantity: 3, unitPrice: 99.99 }), invoiceNumber: "FJ-1" }] };
  for (const [currentDebt, paidNow] of [[0, 0], [100, 0], [1000, 0], [1000, 50], [299.97, 0]]) {
    ok("return_confirmed", buildWholesaleReturnLines({ resolved, wallet: "vodafoneCash", currentDebt, paidNow }));
  }
});

test("purchases, supplier returns and supplier payments", () => {
  for (const paidAmount of [undefined, 0, 120.5, 331.11]) {
    ok("purchase", buildPurchaseLines({ wallet: "inStoreSafe", supplierId: "s1", paidAmount, items: [{ productId: "p1", quantity: 3, unitCost: 110.37 }] }));
  }
  ok("purchase", buildPurchaseLines({ supplierId: "s1", items: [{ productId: "p1", quantity: 1, unitCost: 0 }] }));
  const resolved = { supplierId: "s1", lines: [{ productId: "p1", quantity: 2, unitCost: 80.4, invoiceNumber: "FM-1" }] };
  for (const [currentDebt, paidNow] of [[0, 0], [50, 0], [500, 0], [500, 20]]) {
    ok("purchase", buildSupplierReturnLines({ resolved, wallet: "inStoreSafe", currentDebt, paidNow }));
  }
  ok("supplier_payment", buildSupplierPaymentLines({ supplierId: "s1", wallet: "bankAccount", amount: 999.99 }));
});

test("the e-commerce lifecycle: place, top up, deliver, cancel, edit, return, RTO", () => {
  ok("order_placed", buildOrderPlacedLines({ items: [item()], depositAmount: 50, wallet: "vodafoneCash" }));
  ok("order_placed", buildOrderPlacedLines({ items: [item({ unitCost: 0 })] }));
  ok("client_payment", buildOrderPaymentLines({ wallet: "instaPay", amount: 40 }), { orderOutstanding: 40 });
  // deposit + COD = net goods + shipping; the deposit was booked earlier
  for (const [deposit, discount] of [[0, 0], [50, 0], [50, 12.5], [300, 0]]) {
    const goodsTotal = 300, shippingFee = 45;
    const cod = goodsTotal - discount + shippingFee - deposit;
    ok("order_delivered", buildOrderDeliveredLines({
      items: [item()], goodsTotal, shippingFee, courierId: "k1", depositAmount: deposit, codAmount: cod,
      customerId: "c1", discountAmount: discount,
    }), { priorDeposits: toPiastres(deposit) });
  }
  ok("order_cancelled", buildOrderCancelledLines({ items: [item()] }));
  ok("order_cancelled", buildOrderCancelledLines({ items: [item()], refundedDeposit: 50, wallet: "vodafoneCash" }));
  ok("order_cancelled", buildOrderCancelledLines({ items: [item()], forfeitedDeposit: 50, customerId: "c1" }));
  ok("order_cancelled", buildOrderCancelledLines({ items: [item()], pendingDeposit: 50, customerId: "c1" }));
  ok("order_edited", buildOrderEditLines({ before: [item()], after: [item({ quantity: 1 }), item({ productId: "p2", quantity: 3 })] }));
  assert.deepEqual(violations("order_returned_pending", buildReturnPendingLines()), []);
  const base = { items: [item()], refundAmount: 300, revenueAmount: 300, customerId: "c1", courierId: "k1" };
  ok("return_confirmed", buildReturnConfirmedLines({ ...base, wallet: "inStoreSafe" }));
  ok("return_confirmed", buildReturnConfirmedLines({ ...base, wallet: "inStoreSafe", returnFee: 40 }));
  ok("return_confirmed", buildReturnConfirmedLines({ ...base, wallet: "inStoreSafe", returnFee: 40, movement: "exchange" }));
  ok("return_confirmed", buildReturnConfirmedLines({ ...base, refundVia: "courier", returnFee: 40, feeBorneBy: "customer" }));
  ok("return_confirmed", buildReturnConfirmedLines({ ...base, wallet: "inStoreSafe", forfeitedDeposit: 50 }));
  ok("return_confirmed", buildReturnConfirmedLines({ ...base, wallet: "inStoreSafe", pendingDeposit: 50 }));
  const rto = { items: [item()], courierId: "k1", customerId: "c1" };
  ok("rto_confirmed", buildOrderRTOLines({ ...rto, returnFee: 40 }));
  ok("rto_confirmed", buildOrderRTOLines({ ...rto, returnFee: 40, feeBorneBy: "customer" }));
  ok("rto_confirmed", buildOrderRTOLines({ ...rto, refundedDeposit: 50, wallet: "vodafoneCash" }));
  ok("rto_confirmed", buildOrderRTOLines({ ...rto, forfeitedDeposit: 50 }));
});

test("courier settlements — single, batch with withheld fees, batch with a shortfall", () => {
  ok("courier_settlement", buildCourierSettlementLines({ courierId: "k1", wallet: "inStoreSafe", amount: 345, commission: 45 }));
  const orders = [{ orderId: "a", cod: 345, fee: 45 }, { orderId: "b", cod: 200.5, fee: 40 }];
  ok("courier_settlement", buildCourierBatchSettlementLines({ courierId: "k1", wallet: "inStoreSafe", orders, netReceived: 460.5 }));
  ok("courier_settlement", buildCourierBatchSettlementLines({ courierId: "k1", wallet: "inStoreSafe", orders, netReceived: 400 }));
  ok("courier_settlement", buildCourierBatchSettlementLines({ courierId: "k1", wallet: "inStoreSafe", orders, netReceived: 545.5 }));
});

test("expenses, payroll, owner draws, transfers, openings and stock counts", () => {
  ok("expense", buildExpenseLines({ category: "rent", amount: 1500.25, wallet: "bankAccount" }));
  ok("payroll", buildExpenseLines({ category: "salaries", amount: 4000, wallet: "inStoreSafe" }));
  ok("owner_draw", buildOwnerDrawLines({ subjectId: "owner", amount: 700, wallet: "inStoreSafe" }));
  ok("wallet_transfer", buildWalletTransferLines({ fromWallet: "inStoreSafe", toWallet: "bankAccount", amount: 900.1 }));
  ok("stock_adjustment", buildWalletOpeningLines({ wallet: "vodafoneCash", amount: -120 }), { refType: "opening_balance" });
  ok("stock_adjustment", buildOpeningBalanceLines({ productId: "p1", quantity: 5, unitCost: 33.337 }), { refType: "opening_balance" });
  ok("stock_adjustment", buildStockAdjustmentLines({ items: [
    { productId: "p1", systemQty: 10, countedQty: 7, unitCost: 91.119 },
    { productId: "p2", systemQty: 1, countedQty: 4, unitCost: 12.5 },
    { productId: "p3", systemQty: 3, countedQty: 1, unitCost: 0 },
  ] }), { refType: "stock_audit" });
});

// ═══ The oracle refuses what production refused ════════════════════════════

test("the reproduced attacks are refused by the same rules", () => {
  const W = (amount, wallet = "inStoreSafe") => ({ account: "wallet", subjectId: wallet, amount });
  assert.ok(violations("sale", [W(1_000_000)]).length, "lone wallet +1M on a sale");
  assert.ok(violations("bonus", [W(1_000_000)]).length, "invented kind");
  assert.ok(violations("order_delivered", [{ account: "receivable_courier", subjectId: "k", amount: 1_000_000 }]).length, "COD with no goods");
  assert.ok(violations("client_payment", [W(1_000_000)]).length, "top-up on no order");
  assert.ok(violations("client_payment", [W(1_000_000)], { orderOutstanding: 40 }).length, "top-up above owed");
  assert.ok(violations("sale", [W(30, "my-pocket"), { account: "revenue", subjectId: "pos", amount: 30 }]).length, "phantom wallet");
  assert.ok(violations("return_confirmed", [{ account: "stock", subjectId: "p", qty: 1, amount: 10 }, W(300), { account: "revenue", subjectId: "e", amount: 300 }]).length, "return paying in");
  assert.ok(violations("wallet_transfer", [W(-10), W(20, "bankAccount")]).length, "transfer creating money");
});

// ═══ 2. The lists cannot drift from the code ═══════════════════════════════

test("the validator's kinds, accounts and wallets are exactly the code's", () => {
  const types = read("src/lib/ledger/types.ts");
  const union = (name) => [...types.match(new RegExp(`export type ${name} =([\\s\\S]*?);`))[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
  const src = sql(MIGRATION);
  const kinds = [...src.match(/v_kind <> ALL \(ARRAY\[([\s\S]*?)\]\)/)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(kinds, [...union("EventKind"), "deposit_refunded"].sort(), "kinds = EventKind + 038's deposit_refunded");
  const accounts = [...src.match(/acc <> ALL \(ARRAY\['stock','wallet'([\s\S]*?)\]\)\)/)[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(accounts, union("Account"));
  const labels = read("src/types/index.ts").match(/export const WALLET_LABELS[\s\S]*?\{([\s\S]*?)\};/)[1];
  const wallets = [...labels.matchAll(/^\s*(\w+):/gm)].map((m) => m[1].toLowerCase()).sort();
  assert.deepEqual(wallets, [...WALLETS].sort());
  assert.match(src, new RegExp(`ARRAY\\[${WALLETS.map((w) => `'${w}'`).join(",")}\\]`));
});

// ═══ 3. The SQL, and each protecting predicate is load-bearing ═════════════

const RULES = {
  "kind list": /IF v_kind IS NULL OR v_kind <> ALL \(ARRAY\[/,
  "account list": /count\(\*\) FILTER \(WHERE acc IS NULL OR acc <> ALL/,
  "wallet list": /AND lower\(subj\) <> ALL \(ARRAY\['instoresafe'/,
  "allowed accounts per kind": /IF v_off_kind > 0 THEN/,
  "sale: money in = revenue": /IF w \+ rc <> r THEN/,
  "order_placed shape": /IF v_stock_out = 0 OR v_stock_in > 0 OR v_wallet_out > 0 THEN/,
  "delivery: COD within what is owed": /IF v_prior \+ rco > r \+ pc THEN/,
  "deposits only from deposit kinds": /e\.kind IN \('order_placed', 'client_payment', 'order_cancelled', 'rto_confirmed', 'deposit_refunded'\)/,
  "return equation": /IF w \+ rc \+ rco - pc \+ ex <> r OR r > 0/,
  "rto: fee nets out, money only back": /IF rco - pc \+ ex <> 0 OR v_wallet_in > 0/,
  "purchase equation": /IF st \+ w - ps <> 0 THEN/,
  "top-up backed by an order": /IF v_ref_type IS DISTINCT FROM 'ecommerce_order' OR NOT FOUND THEN/,
  "top-up within what is owed": /IF w > round\(COALESCE\(v_outstanding, 0\) \* 100\) THEN/,
  "transfer creates no money": /IF v_n < 2 OR w <> 0 THEN/,
  "settlement equation": /IF w \+ rco - pc \+ ex <> 0 OR v_wallet_out > 0/,
  "settlement within courier balance": /RAISE EXCEPTION 'ledger: courier_settlement — more than courier/,
  "settlement serialized per courier": /pg_advisory_xact_lock\(hashtext\('ledger_courier:'/,
  "wallet only as lone opening balance": /IF v_wallet_in \+ v_wallet_out > 0 AND \(v_ref_type IS DISTINCT FROM 'opening_balance' OR v_n <> 1\) THEN/,
};

function problems(text) {
  const src = sql(text);
  const out = Object.entries(RULES).filter(([, re]) => !re.test(src)).map(([name]) => `missing: ${name}`);
  const append = src.match(/CREATE OR REPLACE FUNCTION public\.ledger_append[\s\S]*?\$function\$;/)?.[0] ?? "";
  const validate = append.indexOf("PERFORM public.ledger_validate_event(p_event);");
  const firstInsert = append.indexOf("INSERT INTO public.ledger_events");
  if (validate < 0 || firstInsert < 0 || validate > firstInsert) out.push("ledger_append must validate BEFORE its first insert");
  if (/\bEXCEPTION\s+WHEN\b/i.test(src)) out.push("an exception handler would break 043's same-transaction rule");
  if (/SECURITY DEFINER/.test(src)) out.push("the validator must read through the caller's RLS");
  if (!/REVOKE ALL ON FUNCTION public\.ledger_validate_event\(jsonb\) FROM public, anon;/.test(src)) out.push("anon must not execute the validator");
  if (/\b(INSERT INTO public\.ledger_lines[\s\S]*?VALUES|UPDATE public\.|DELETE FROM|ALTER TABLE|DROP )/i.test(src.replace(/INSERT INTO public\.ledger_(events|lines) \([\s\S]*?\);/g, ""))) out.push("044 must rewrite no data or schema");
  return out;
}

test("044 holds: every rule present, validated before any write, no handler, no data touched", () => {
  assert.deepEqual(problems(MIGRATION), []);
});

test("removing any protecting predicate is caught", () => {
  for (const [name, re] of Object.entries(RULES)) {
    const mutant = MIGRATION.replace(re, "IF false THEN");
    assert.notEqual(mutant, MIGRATION, `mutant for "${name}" did not apply`);
    assert.ok(problems(mutant).includes(`missing: ${name}`), `mutant "${name}" survived`);
  }
  const moved = MIGRATION.replace("  PERFORM public.ledger_validate_event(p_event);\n", "")
    .replace("  GET DIAGNOSTICS v_count = ROW_COUNT;", "  GET DIAGNOSTICS v_count = ROW_COUNT;\n  PERFORM public.ledger_validate_event(p_event);");
  assert.ok(problems(moved).some((p) => p.startsWith("ledger_append must validate BEFORE")), "validating after the insert survived");
  const handler = MIGRATION.replace("  RETURN v_id;\nEND;", "  RETURN v_id;\nEXCEPTION WHEN others THEN RETURN NULL;\nEND;");
  assert.ok(problems(handler).some((p) => p.includes("exception handler")), "an exception handler survived");
});

// ═══ The runtime matrix that proved it stays complete ══════════════════════

test("the 044 runtime matrix covers every kind, both roles, and every attack class", () => {
  const legit = [...MATRIX.matchAll(/pg_temp\.e\('qa044-L\d+','([a-z_]+)'/g)].map((m) => m[1]);
  const kinds = [...sql(MIGRATION).match(/v_kind <> ALL \(ARRAY\[([\s\S]*?)\]\)/)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  for (const kind of kinds) assert.ok(legit.includes(kind), `no legitimate ${kind} in the matrix`);
  for (const label of [
    "A sale = lone wallet +1,000,000 EGP", "A invented kind bonus", "A invented account free_money",
    "A order_delivered COD +1M with no goods", "A courier_settlement +1M from a courier holding 0",
    "A top-up on an order that does not exist", "A top-up above what is owed on a real order",
    "A wallet line to a wallet that does not exist", "A stock line signed against its value",
    "A delivery that ignores the deposit already taken", "A ADMIN wallet_transfer that creates money",
    "A cross-tenant: valid sale into another store", "A 043 still in force: line on an OLD event",
    "NO PARTIAL WRITE: refused events", "BALANCE store wallets moved only by legitimate lines",
  ]) {
    assert.ok(MATRIX.includes(`'${label}'`), `matrix lost: ${label}`);
  }
  assert.doesNotMatch(sql(MATRIX), /\bcommit\b/i, "the matrix must never commit");
});
