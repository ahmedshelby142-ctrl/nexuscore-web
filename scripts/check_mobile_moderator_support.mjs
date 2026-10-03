/**
 * Moderator support fixes on Mobile (live findings, 503fe30, LUNA BEAUTY):
 *
 *  1. Order Details never said what became of the عربون. ECO-0001 (customer
 *     caused, kept) and ECO-0002 (shop caused, refunded by تسوية العميلة) both
 *     read only «مدفوع مقدماً ٣٠٠»; Desktop says «تمت تسوية العميلة — العربون
 *     اترد». `deposit_refunded` was also dropped from the timeline.
 *  2. Product Details showed «معلومات النظام» / the product's record id to the
 *     Moderator; Order Details hides that section behind `showInternal`.
 *  3. The status filter had no «مرتجع» / «ملغي».
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) return next(new URL(`src/${specifier.slice(2)}.ts`, root).href, context);
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { depositOutcome, DEPOSIT_OUTCOME_LABELS_AR } = await import(new URL("src/mobile/viewmodels/depositOutcome.ts", root).href);

const returned = (cause, extra = {}) => ({ depositAmount: 300, status: "returned", returnConfirmedAt: "2026-10-02T17:49:47Z", return_cause: cause, ...extra });

test("the live orders: ECO-0001 kept, ECO-0002 refunded", () => {
  assert.equal(depositOutcome(returned("customer"), false), "kept");
  assert.equal(depositOutcome(returned("shop"), true), "refunded");
});

test("a shop- or courier-caused deposit is held until `deposit_refunded`", () => {
  assert.equal(depositOutcome(returned("shop"), false), "held");
  assert.equal(depositOutcome(returned("courier"), false), "held");
  assert.equal(depositOutcome(returned("courier"), true), "refunded");
});

test("an unreadable ledger never guesses «held» — but a kept deposit needs no ledger", () => {
  assert.equal(depositOutcome(returned("shop"), null), "unknown");
  assert.equal(depositOutcome(returned("customer"), null), "kept", "refund_order_deposit refuses a customer cause");
  assert.equal(depositOutcome(returned("unknown"), null), "kept", "'unknown' forfeits, as depositDispositionOn says");
});

test("cancellations follow the same rule; unconfirmed returns, exchanges and no deposit say nothing final", () => {
  assert.equal(depositOutcome({ depositAmount: 300, status: "cancelled", return_cause: "customer" }, false), "kept");
  assert.equal(depositOutcome({ depositAmount: 300, status: "cancelled", return_cause: "shop" }, false), "held");
  assert.equal(depositOutcome({ depositAmount: 300, status: "returned", return_cause: "shop" }, false), "awaiting_return");
  assert.equal(depositOutcome(returned("shop", { isExchange: true }), false), "none");
  assert.equal(depositOutcome(returned("shop", { depositAmount: 0 }), false), "none");
  assert.equal(depositOutcome({ depositAmount: 300, status: "delivered" }, false), "none");
});

test("every non-none state has an Arabic label", () => {
  for (const state of ["refunded", "held", "kept", "awaiting_return", "unknown"]) assert.ok(DEPOSIT_OUTCOME_LABELS_AR[state].labelAr);
});

test("Order Details shows the state to every role, from the ledger timeline", () => {
  const screen = read("src/mobile/screens/MobileOrderDetails.tsx");
  assert.match(screen, /timeline\.find\(\(e\) => e\.status === "deposit_refunded"\)/);
  assert.match(screen, /depositOutcome\(order, timelineLoading \|\| timelineError \? null : refundEvent !== null\)/);
  assert.match(screen, /\{deposit !== "none" && \(\n\s*<div className="mobile-detail-line">\n\s*<span>حالة العربون<\/span>/, "not behind showInternal");
  assert.match(read("src/mobile/data/mobileReaders.ts"), /deposit_refunded: \{ labelAr: "العربون اترد للعميلة", entity: "payment" \}/);
});

test("Product Details hides «معلومات النظام» with the Order Details gate", () => {
  const screen = read("src/mobile/screens/MobileProductDetails.tsx");
  assert.match(screen, /const \{ cost: showCost, internal: showInternal \} = useMobileVisibility\(\);/);
  assert.match(read("src/mobile/screens/MobileOrderDetails.tsx"), /const \{ cost: showCost, internal: showInternal \} = useMobileVisibility\(\);/, "the same policy as Order Details");
  assert.match(screen, /\{showInternal && <MobileSection titleAr="معلومات النظام">/);
  assert.equal((screen.match(/معرف المنتج/g) ?? []).length, 1);
});

test("the status filter offers «مرتجع» and «ملغي» with their database values", () => {
  const screen = read("src/mobile/screens/MobileOrdersScreen.tsx");
  assert.match(screen, /\{ id: "returned", label: "مرتجع" \}, \{ id: "cancelled", label: "ملغي" \}\] as const;/);
});
