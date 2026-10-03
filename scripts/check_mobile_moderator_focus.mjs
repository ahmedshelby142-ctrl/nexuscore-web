/**
 * Mobile MODERATOR focus — the support role sees the customer and the order,
 * not the shop's internals; every other role sees exactly what it did.
 *
 *     node --test scripts/check_mobile_moderator_focus.mjs
 *
 * The REAL Order Details and Customer Details screens are rendered to HTML
 * (react-dom/server, MemoryRouter) once per role, with only their data hooks
 * fed fixtures. Assertions are on what reaches the screen.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");
const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
globalThis.window ??= globalThis;

globalThis.__ui = { role: "MODERATOR", entity: null, writes: [] };
const STUBS = {
  "@/store/useAuthStore": stub(`
    const state = () => ({ userRole: globalThis.__ui.role, isAuthenticated: true });
    export const useAuthStore = Object.assign((sel) => sel(state()), { getState: state });`),
  "@/mobile/data/useMobileEntity": stub(`export const useMobileEntity = () => ({ data: globalThis.__ui.entity, loading: false, error: null, reload() {} });`),
  "@/mobile/data/useIsOffline": stub(`export const useIsOffline = () => false;`),
  "@/mobile/data/useStoreName": stub(`export const useStoreName = () => "متجر الاختبار";`),
  "@/mobile/data/mobileReaders": stub(`
    const never = () => new Promise(() => {});
    export const readMobileOrder = never, readMobileOrderTimeline = never, readMobileCouriers = never,
      readMobileCustomer = never, readMobileCustomerFinancialSummary = never, readMobileCustomerOrderHistory = never;`),
};
const ts_ = (u) => (existsSync(fileURLToPath(u + ".ts")) ? u + ".ts" : existsSync(fileURLToPath(u + ".tsx")) ? u + ".tsx" : u + "/index.ts");
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    if (specifier.startsWith("@/")) return next(ts_(new URL(`src/${specifier.slice(2)}`, root).href), context);
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier))
      return next(ts_(new URL(specifier, context.parentURL).href), context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.endsWith(".tsx")) return next(url, context);
    const out = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: fileURLToPath(url),
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});

const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MemoryRouter } = await import("react-router-dom");
const { MobileOrderDetails } = await import(new URL("src/mobile/screens/MobileOrderDetails.tsx", root).href);
const { MobileCustomerDetails } = await import(new URL("src/mobile/screens/MobileCustomerDetails.tsx", root).href);

const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&[a-z#0-9]+;/g, " ").replace(/\s+/g, " ");
function render(Screen, role, entity) {
  globalThis.__ui.role = role;
  globalThis.__ui.entity = entity;
  return renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(Screen)));
}

const baseOrder = {
  id: "ord-uuid-0001", orderNumber: "ORD-1001", status: "returned", createdAt: "2026-09-20T10:00:00Z",
  customerId: "cust-1", customerName: "منى أحمد", customerPhone: "01012345678", address: "شارع النيل", governorate: "القاهرة",
  stockItems: [{ productId: "p1", productName: "قميص", quantity: 2, unitPrice: 500 }],
  totalAmount: 1000, discountAmount: 0, shippingFee: 60, depositAmount: 300, expectedCod: 760,
  courierId: "courier-uuid-77", courierName: "J&T EXPRESS", courierFee: 45,
  revenueLogged: false, codSettledAt: "2026-09-25T10:00:00Z",
  returnConfirmedAt: "2026-09-24T10:00:00Z", return_cause: "customer", isExchange: false,
};

// ── Order Details ───────────────────────────────────────────────────────────

test("MODERATOR order: identity, phone, WhatsApp, items, payment state and courier are all there", () => {
  const html = render(MobileOrderDetails, "MODERATOR", baseOrder);
  const t = text(html);
  for (const must of ["ORD-1001", "منى أحمد", "01012345678", "قميص", "رسوم التوصيل", "مدفوع مقدماً (عربون)", "المتبقي على المندوب (COD)", "J&T EXPRESS", "حالة الشحنة", "الخط الزمني"]) {
    assert.ok(t.includes(must), `missing: ${must}`);
  }
  assert.match(html, /href="https:\/\/wa\.me\/201012345678\?text=/, "WhatsApp to the customer's number");
  assert.match(html, /aria-label="فتح واتساب"/);
  assert.match(html, /href="\/customers\/cust-1"|عرض العميل/, "the way to the customer stays");
});

test("MODERATOR order: the hero keeps the stored order total; the full amount owed is in the payment section", () => {
  const t = text(render(MobileOrderDetails, "MODERATOR", baseOrder));
  const hero = t.slice(t.indexOf("إجمالي الطلب"), t.indexOf("إجمالي الطلب") + 40);
  assert.match(hero, /١٬?٠٠٠/, hero);
  assert.ok(t.includes("المجموع المستحق"), "what the customer owes, goods + shipping");
});

test("MODERATOR order: return context is up front — cause and confirmation", () => {
  const t = text(render(MobileOrderDetails, "MODERATOR", baseOrder));
  assert.ok(t.includes("المرتجع") && t.includes("السبب") && t.includes("العميل") && t.includes("مؤكد"), t);
  const cancelled = text(render(MobileOrderDetails, "MODERATOR", { ...baseOrder, status: "cancelled", returnConfirmedAt: null, return_cause: "shop" }));
  assert.ok(cancelled.includes("الإلغاء") && cancelled.includes("المحل"), "cancellation reason");
  const exchange = text(render(MobileOrderDetails, "MODERATOR", { ...baseOrder, status: "delivered", isExchange: true, returnConfirmedAt: null, return_cause: "customer" }));
  assert.ok(exchange.includes("الاستبدال") && exchange.includes("طلب استبدال") && exchange.includes("تغيير رغبة العميلة"), "exchange reason");
  const plain = text(render(MobileOrderDetails, "MODERATOR", { ...baseOrder, status: "shipped", returnConfirmedAt: null, return_cause: "unknown" }));
  assert.equal(plain.includes("السبب"), false, "no case block for an ordinary order");
});

test("MODERATOR order: internal ids, revenue/remittance flags, reconciliation and courier cost are NOT shown", () => {
  const t = text(render(MobileOrderDetails, "MODERATOR", baseOrder));
  for (const hidden of ["ord-uuid-0001", "courier-uuid-77", "معرف المندوب", "معلومات النظام", "حالة الإيراد", "توريد المندوب", "تم التوريد في", "مطابقة الحساب", "مجموع المدفوع + المتبقي", "عمولة المندوب"]) {
    assert.equal(t.includes(hidden), false, `Moderator must not see: ${hidden}`);
  }
});

test("ADMIN order: every internal line is still there, exactly as before", () => {
  const t = text(render(MobileOrderDetails, "ADMIN", baseOrder));
  for (const shown of ["معلومات النظام", "ord-uuid-0001", "معرف المندوب", "courier-uuid-77", "حالة الإيراد", "توريد المندوب", "تم التوريد في", "مطابقة الحساب", "مجموع المدفوع + المتبقي", "عمولة المندوب", "إجمالي البضاعة"]) {
    assert.ok(t.includes(shown), `ADMIN lost: ${shown}`);
  }
});

// ── Customer Details ────────────────────────────────────────────────────────

const customer = { id: "cust-uuid-9", name: "منى أحمد", phone: "01012345678", address: "شارع النيل", governorate: "القاهرة", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };

test("MODERATOR customer: name, phone, WhatsApp and the order summary; no record ids or audit dates", () => {
  const html = render(MobileCustomerDetails, "MODERATOR", customer);
  const t = text(html);
  for (const must of ["منى أحمد", "01012345678", "شارع النيل", "ملخص الطلبات", "سجل الطلبات"]) assert.ok(t.includes(must), `missing: ${must}`);
  assert.match(html, /href="https:\/\/wa\.me\/201012345678\?text=/);
  for (const hidden of ["cust-uuid-9", "معلومات النظام", "الملخص المالي"]) assert.equal(t.includes(hidden), false, `Moderator must not see: ${hidden}`);
});

test("MODERATOR customer with no phone or a landline: no WhatsApp link at all", () => {
  for (const phone of [null, "0223456789"]) {
    const html = render(MobileCustomerDetails, "MODERATOR", { ...customer, phone });
    assert.doesNotMatch(html, /wa\.me/, `phone ${phone}`);
  }
});

test("ADMIN customer: summary title and system section unchanged", () => {
  const t = text(render(MobileCustomerDetails, "ADMIN", customer));
  for (const shown of ["الملخص المالي", "معلومات النظام", "cust-uuid-9"]) assert.ok(t.includes(shown), `ADMIN lost: ${shown}`);
});

// ── security / scope ────────────────────────────────────────────────────────

test("no new permission, no write: the gate is the existing canViewCost, and the screens only read", () => {
  for (const f of ["src/mobile/screens/MobileOrderDetails.tsx", "src/mobile/screens/MobileCustomerDetails.tsx"]) {
    const src = read(f);
    assert.match(src, /= useMobileVisibility\(\);/, `${f}: the existing role gate, via the one Mobile policy`);
    assert.doesNotMatch(src, /userRole/, `${f}: no role logic of its own`);
    assert.doesNotMatch(src, /\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(|appendEvent|writeThrough/, `${f}: no write path`);
  }
  // The one Mobile visibility policy — and it is exactly the existing gate.
  const policy = read("src/mobile/navigation/mobileVisibility.ts");
  assert.match(policy, /const cost = canViewCost\(role\);\n\s*visibility = Object\.freeze\(\{ cost, internal: cost \}\);/);
  assert.match(policy, /return mobileVisibilityFor\(useAuthStore\(\(s\) => s\.userRole\)\);/);
  assert.match(read("src/lib/roles.ts"), /export function canViewCost\(role: string \| null \| undefined\): boolean \{\s*return toAppRole\(role\) !== "MODERATOR";/);
  // Cost stays withheld by the database for the Moderator too (047/048).
  assert.match(read("src/mobile/data/mobileReaders.ts"), /return viewerSeesCost\(\) \? `\$\{ORDER_COLUMNS\},courierFee` : ORDER_COLUMNS;/);
});
