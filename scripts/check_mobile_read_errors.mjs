/**
 * P2-8 — no Mobile read may fail silently.
 *
 *     node --test scripts/check_mobile_read_errors.mjs
 *
 * Four values were set and never rendered, and each failure mode was a
 * DIFFERENT lie rather than a missing spinner:
 *
 *   waitingError     → «لا توجد طلبات نشطة تنتظر هذا المنتج», when nobody had
 *                      actually been asked. That is the sentence someone reads
 *                      before deciding not to reorder.
 *   financialsError  → the whole الملخص المالي card VANISHED. The screen looked
 *                      like a customer who had never traded.
 *   suppliersError   → an empty picker, indistinguishable from "no suppliers
 *                      yet", leaving «+ مورد جديد» as the only apparent option.
 *                      `lib/receiving/suppliers.ts` exists because that mints a
 *                      duplicate supplier and splinters `payable_supplier`.
 *   ordersPage.error → a retry button wired to `setOrdersPage({loading:true})`,
 *                      which re-renders a spinner and never calls the reader.
 *
 * So these assertions are about what the user is TOLD, not about whether an
 * error variable exists.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/** Source with comments stripped — the prose names what the code refuses to do. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\r\n]*/g, "$1");
}

const product = read("../src/mobile/screens/MobileProductDetails.tsx");
const customer = read("../src/mobile/screens/MobileCustomerDetails.tsx");
const restock = read("../src/mobile/screens/MobileQuickRestock.tsx");

// ═══════════════════════════════════════════════════════════════════════════
// 1 · Every error reaches the screen
// ═══════════════════════════════════════════════════════════════════════════

test("waitingError is rendered, with a retry", () => {
  assert.match(product, /waitingError \?/, "the error must be a render branch, not just state");
  assert.match(product, /<ErrorState messageAr="تعذّر تحميل الطلبات المنتظرة\." onRetry=\{\(\) => void loadWaiting\(\)\} \/>/);
});

test("financialsError is rendered, with a retry", () => {
  assert.match(customer, /financialsError \?/);
  assert.match(customer, /<ErrorState messageAr="تعذّر تحميل الملخص المالي لهذا العميل\." onRetry=\{\(\) => void loadFinancials\(\)\} \/>/);
});

test("suppliersError is rendered, with a retry", () => {
  assert.match(restock, /\{suppliersError && \(/);
  assert.match(restock, /onRetry=\{\(\) => void loadSuppliers\(\)\}/);
});

test("the order-history retry actually re-reads", () => {
  // It used to be `onRetry={() => setOrdersPage(p => ({ ...p, loading: true }))}`
  // — a spinner that never resolves, because nothing was fetched.
  assert.match(customer, /onRetry=\{\(\) => void loadOrders\(0\)\}/);
  assert.doesNotMatch(code(customer), /onRetry=\{\(\) => setOrdersPage/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · Retry goes through the canonical reader
// ═══════════════════════════════════════════════════════════════════════════

test("each retry re-runs the SAME reader, not a second fetch path", () => {
  for (const [name, source, reader] of [
    ["waiting", product, "readMobileProductWaitingOrders"],
    ["financials", customer, "readMobileCustomerFinancialSummary"],
    ["orders", customer, "readMobileCustomerOrderHistory"],
    ["suppliers", restock, "readSuppliers"],
  ]) {
    const calls = (code(source).match(new RegExp(`${reader}\\(`, "g")) ?? []).length;
    assert.ok(calls >= 1, `${name} must call ${reader}`);
    // `loadMoreOrders` legitimately calls the history reader a second time for
    // pagination; nothing else may have two call sites.
    const ceiling = reader === "readMobileCustomerOrderHistory" ? 2 : 1;
    assert.ok(calls <= ceiling, `${name} has ${calls} call sites for ${reader} — retry must reuse one`);
  }
});

test("a retry clears the previous error before asking again", () => {
  // Otherwise a recovered read still renders the stale failure underneath it.
  for (const [name, source, setter] of [
    ["waiting", product, "setWaitingError"],
    ["financials", customer, "setFinancialsError"],
    ["suppliers", restock, "setSuppliersError"],
  ]) {
    assert.match(source, new RegExp(`${setter}\\(null\\);`), `${name} must reset its error on retry`);
  }
  assert.match(customer, /error: null,?\s*\}\)\);/, "the history loader clears its error too");
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · A failure is never dressed up as an answer
// ═══════════════════════════════════════════════════════════════════════════

test("a failed waiting read is not reported as 'nobody is waiting'", () => {
  const body = code(product);
  // The error branch must be reached BEFORE the empty branch.
  const errorAt = body.indexOf("waitingError ?");
  const emptyAt = body.indexOf("waitingOrders.length === 0 ?");
  assert.ok(errorAt > -1 && emptyAt > -1, "both branches must exist");
  assert.ok(errorAt < emptyAt, "the error must be checked before the empty state");
  assert.match(body, /setWaitingOrders\(\[\]\);/, "a failed read must not keep a partial list");
});

test("a failed financial read never becomes a zero or a stale figure", () => {
  const body = code(customer);
  // `financials` is cleared on failure, so nothing can render the previous
  // customer's numbers under the new name.
  assert.match(body, /setFinancials\(null\);/);
  // The error branch precedes both the empty branch and the figures.
  const errorAt = body.indexOf("financialsError ?");
  const emptyAt = body.indexOf("!financials ?");
  const gridAt = body.indexOf("mobile-customer-financial-grid");
  assert.ok(errorAt > -1 && errorAt < emptyAt && errorAt < gridAt,
    "a money section must say it failed before it shows anything");
  // And the screen performs no arithmetic to compensate for a missing read.
  assert.ok(!/financials\?\.\w+\s*\?\?\s*0/.test(body), "no defaulting a failed read to zero");
});

test("a failed supplier read does not look like a shop with no suppliers", () => {
  const body = code(restock);
  assert.match(body, /setSuppliers\(\[\]\);/);
  // The dangerous affordance is withheld while the list is unknown: choosing
  // "new" against a list that merely failed to load is how duplicates appear.
  assert.match(body, /\{!suppliersError && <SelectItem value=\{NEW_SUPPLIER\}>/);
  assert.match(body, /disabled=\{Boolean\(suppliersError\)\}/);
});

test("a receipt cannot be committed while the supplier list is unknown", () => {
  assert.match(restock, /const canSave = [^;]*&& !suppliersError;/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · Loading is still distinct from failing
// ═══════════════════════════════════════════════════════════════════════════

test("each section still shows loading, empty and success separately", () => {
  assert.match(product, /waitingLoading \? \(\s*<SkeletonState/);
  assert.match(product, /لا توجد طلبات نشطة تنتظر هذا المنتج/);
  assert.match(customer, /financialsLoading \? \(\s*<SkeletonState/);
  assert.match(customer, /<EmptyState messageAr="لا توجد بيانات مالية لهذا العميل\." \/>/);
  assert.match(restock, /suppliersLoading \? "جارٍ تحميل الموردين…" : "اختر المورد…"/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · Online-only — nothing was smuggled in to "fix" a failed read
// ═══════════════════════════════════════════════════════════════════════════

test("no local storage, queue or write was added to survive a failure", () => {
  for (const [name, source] of Object.entries({ product, customer, restock })) {
    const body = code(source);
    for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "syncQueue", "enqueue", "navigator.serviceWorker"]) {
      assert.ok(!body.includes(forbidden), `${name} must not use ${forbidden} to paper over a read error`);
    }
  }
});

test("the one write path is unchanged", () => {
  assert.match(restock, /executeQuickRestock/);
  assert.ok(!code(restock).includes("commitReceipt"), "the screen must not call the writer directly");
  const commit = read("../src/lib/receiving/commitReceipt.ts");
  assert.match(commit, /throw new Error/);
});
