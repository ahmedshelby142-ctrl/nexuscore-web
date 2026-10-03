/**
 * «COD المستحق» / «المتبقي على المندوب» — only while the customer still owes it.
 *
 * Live finding (e6f03c8, LUNA BEAUTY): ECO-0001 (collected, remitted, then
 * returned) still listed «COD المستحق ٧٦٠», and ECO-0002 (returned, deposit
 * refunded) «٨٢٠» — on Desktop's Orders list and on Mobile's Order Details,
 * which the Moderator reads to customers. `expectedCod` is a placement-time
 * figure; shown raw it read as money due on orders that owe nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { codState, COD_STATE_LABELS_AR } from "../src/lib/shippingRates.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const page = read("src/components/ecommerce/OrdersPage.tsx");
const mobile = read("src/mobile/screens/MobileOrderDetails.tsx");
const crm = read("src/components/ecommerce/CRMPage.tsx");

test("a returned order owes no COD — the two live cases", () => {
  assert.equal(codState({ status: "returned", expectedCod: 760, codSettledAt: "2026-10-02T17:05:13Z" }), "returned", "ECO-0001");
  assert.equal(codState({ status: "returned", expectedCod: 820, codSettledAt: null }), "returned", "ECO-0002");
  assert.equal(COD_STATE_LABELS_AR.returned, "مرتجع — مفيش تحصيل");
});

test("a cancelled order owes no COD", () => {
  assert.equal(codState({ status: "cancelled", expectedCod: 450 }), "cancelled");
});

test("outstanding COD is still shown while it is genuinely owed", () => {
  assert.equal(codState({ status: "pending", expectedCod: 820 }), "due");
  assert.equal(codState({ status: "shipped", expectedCod: 820 }), "due");
  assert.equal(codState({ status: "delivered", expectedCod: 820, codSettledAt: null }), "with_courier");
});

test("remitted and fully-prepaid orders are not outstanding", () => {
  assert.equal(codState({ status: "delivered", expectedCod: 820, codSettledAt: "2026-10-02T17:05:13Z" }), "remitted");
  assert.equal(codState({ status: "delivered", expectedCod: 0 }), "none");
  assert.equal(codState({ status: "pending", expectedCod: null }), "none");
});

test("Desktop list prints the amount only while outstanding", () => {
  assert.match(page, /const cod = codState\(order\);\s*if \(cod === "due" \|\| cod === "with_courier"\) return formatMoney\(order\.expectedCod\);/);
  assert.doesNotMatch(page, /text-amber-600">\s*\{formatMoney\(order\.expectedCod\)\}\s*<\/TableCell>/, "the raw amount cell must not come back");
});

test("Mobile Order Details keeps its labels but shows the amount only while outstanding", () => {
  assert.match(mobile, /const codOutstanding = cod === "due" \|\| cod === "with_courier";/);
  assert.match(mobile, /<span>المتبقي على المندوب \(COD\)<\/span>\s*<strong>\{codOutstanding \? formatArabicCurrency\(expectedCod\) :/);
  assert.match(mobile, /showInternal && codOutstanding && <div className="mobile-detail-line"><span>المبلغ المستحق تحصيله \(COD\)/);
  assert.match(mobile, /\) : codOutstanding \? \(\s*<div className="mobile-detail-line"><span>توريد المندوب<\/span><strong style=\{\{ color: "var\(--warning\)" \}\}>معلق/);
});

test("CRM order timeline: Arabic status, and COD only while outstanding", () => {
  // Live: the customer's timeline read «returned» in English and «COD ٨٢٠» on a returned order.
  assert.match(crm, /cod: codState\(o\),/);
  assert.match(crm, /\{STATUS_META\[event\.status as EcommerceOrderStatus\]\?\.label \?\? event\.status\}/);
  assert.match(crm, /\{event\.cod === "due" \|\| event\.cod === "with_courier" \? \(\s*formatMoney\(event\.expectedCod\)/);
  assert.doesNotMatch(crm, /\{event\.expectedCod > 0 \? formatMoney\(event\.expectedCod\) : "-"\}/, "the raw COD cell must not come back");
  assert.match(page, /export const STATUS_META: Record</);
});
