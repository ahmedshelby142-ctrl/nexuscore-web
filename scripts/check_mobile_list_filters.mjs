/**
 * Mobile list filters survive leaving the list; the customer value is labelled
 * for what it is.
 *
 * Live findings (503fe30, Production, POS_ECOMMERCE on LUNA BEAUTY):
 *  1. Orders filtered to «الكل» + 2/10–2/10, open an order, back → the list came
 *     back on «تحتاج إجراء» / «كل التواريخ» and EMPTY — read as "no orders".
 *     Customers lost its search the same way. The filters lived in component
 *     state, which dies with the screen.
 *  2. Customer Details showed «إيراد المسلم (مُسجل) ٣٠٠» beside «طلبات مسلمة ٠»:
 *     the figure is `customer_ltv` (a kept deposit counts), not delivered revenue.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const hook = read("src/mobile/data/useUrlFilters.ts");
const orders = read("src/mobile/screens/MobileOrdersScreen.tsx");
const customers = read("src/mobile/screens/MobileCustomersScreen.tsx");
const customer = read("src/mobile/screens/MobileCustomerDetails.tsx");

test("the filters live in the URL query string — one replace-navigation per change", () => {
  assert.match(hook, /useSearchParams\(\)/);
  assert.match(hook, /\{ replace: true \}/, "typing must not flood history");
  assert.match(hook, /if \(ok && !ok\.includes\(raw\)\) continue;/, "an unknown URL value falls back to the default");
  assert.match(hook, /value === defaults\[key\]\) next\.delete\(key\)/, "defaults stay out of the URL");
});

test("Orders keeps search, segment, status and date range in the URL — no component state", () => {
  assert.match(orders, /useUrlFilters\(\s*\{ q: "", seg: "action", status: "all", date: "all", from: "", to: "" \},/);
  assert.match(orders, /seg: SEGMENTS\.map\(\(s\) => s\.id\), status: STATUSES\.map\(\(s\) => s\.id\), date: ORDER_DATE_PRESETS\.map\(\(p\) => p\.id\)/);
  assert.match(orders, /setFilters\(\{ date: d\.preset, from: d\.from \?\? "", to: d\.to \?\? "" \}\)/, "a range is written in one update");
  assert.doesNotMatch(orders, /useState/);
});

test("Customers keeps its search in the URL", () => {
  assert.match(customers, /useUrlFilters\(\{ q: "" \}\)/);
  assert.doesNotMatch(customers, /useState\(""\)/);
});

test("the customer value is labelled as LTV, not delivered revenue", () => {
  assert.match(customer, /<span>قيمة العميل \(LTV\)<\/span>/);
  assert.doesNotMatch(customer, /إيراد المسلم/);
});
