/**
 * Every event in an order's life must name the order it belongs to.
 *
 *     node --test scripts/check_order_traceability.mjs
 *
 * ## The defect this exists to prevent
 *
 * `appendEvent` takes `refType` and `refId`, and `refId` is what ties a ledger
 * movement back to its document — it is what `balancesByRef` groups by and what
 * a per-order reconciliation reads.
 *
 * Every event in an order's life carried it — `order_delivered`,
 * `order_returned_pending`, `return_confirmed`, `rto_confirmed`,
 * `order_cancelled` from شاشة الطلبات — except the ONE that opens the order.
 * `order_placed` passed `refType: "ecommerce_order"` and no `refId` at all,
 * because the order number was minted inside `addOrder`, AFTER the ledger event
 * had already been written.
 *
 * Measured on QA-STORE, 2026-09-14: of 33 `order_placed` events, 19 had a NULL
 * `ref_id` — every single one written by the client. (The 14 that had one were
 * seeded directly by SQL.) So asking the ledger "show me everything that
 * happened to ECO-xxx" returned the delivery, the return and the refusal, but
 * not the reservation that took the stock or the deposit that took the money.
 * The order's own opening entry was untraceable.
 *
 * The fix allocates the number BEFORE the ledger write and hands it to the
 * store, which is why `addOrder` accepts an optional `orderNumber`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const ECO = read("../src/routes/ecommerce-orders.tsx");
const ORDERS_PAGE = read("../src/components/ecommerce/OrdersPage.tsx");
const RETURNS = read("../src/routes/returns.tsx");
const ORDER_STORE = read("../src/store/useOrderStore.ts");

/** The `appendEvent({...})` call whose `kind` is `kind`, as source text. */
function eventBlock(src, kind) {
  const at = src.indexOf(`kind: "${kind}"`);
  if (at < 0) return null;
  // The payload/lines of one call comfortably fit; we only need the header.
  return src.slice(at, at + 400);
}

test("the order number is allocated BEFORE the ledger event", () => {
  const placedAt = ECO.indexOf('kind: "order_placed"');
  const allocAt = ECO.indexOf("const orderNumber = `ECO-");
  assert.ok(allocAt > 0, "the route must mint the number itself");
  assert.ok(
    allocAt < placedAt,
    "allocating it after the event is what made the event untraceable",
  );
});

test("order_placed names its order", () => {
  const block = eventBlock(ECO, "order_placed");
  assert.ok(block, "order_placed must exist");
  assert.match(block, /refType: "ecommerce_order"/);
  assert.match(block, /refId: orderNumber/, "the event that reserves the stock must be traceable");
});

test("the compensating cancel names the same order", () => {
  // When the order DOCUMENT is refused, the reservation is released. The pair
  // must be readable as a pair, not as two orphans.
  const at = ECO.indexOf("order document refused");
  assert.ok(at > 0);
  const block = ECO.slice(Math.max(0, at - 400), at + 100);
  assert.match(block, /refId: orderNumber/);
});

test("the store uses the number the caller already published to the ledger", () => {
  assert.match(
    ORDER_STORE,
    /orderNumber: orderData\.orderNumber \|\| `ECO-\$\{Date\.now\(\)\}`/,
    "a second, different number would point the document away from its own event",
  );
  // Still optional, so the wholesale caller is unaffected.
  assert.match(ORDER_STORE, /orderNumber\?: string;/);
});

test("every other lifecycle event already names its order", () => {
  // These are the ones that were already correct; they must stay correct.
  for (const [src, kind, label] of [
    [ORDERS_PAGE, "order_cancelled", "OrdersPage cancel"],
    [ORDERS_PAGE, "rto_confirmed", "OrdersPage RTO"],
    [ORDERS_PAGE, "return_confirmed", "OrdersPage return"],
    [RETURNS, "rto_confirmed", "returns route RTO"],
    [RETURNS, "return_confirmed", "returns route return"],
  ]) {
    const block = eventBlock(src, kind);
    assert.ok(block, `${label}: ${kind} must exist`);
    assert.match(block, /refId:/, `${label}: ${kind} must carry a refId`);
  }
});

test("a POS sale is identified by its event, not by a document number", () => {
  // Deliberately different: a till sale has no invoice number to point at, so
  // `refId` is absent and the EVENT id is the identity. `remainingSaleLines`
  // and `returnOfEventId` both key on it — see `src/lib/posReturn.ts`.
  const posReturn = read("../src/lib/posReturn.ts");
  assert.match(posReturn, /row\.sourceEventId !== event\.id/);
  assert.match(
    read("../src/components/sales/POSReturnModal.tsx"),
    /sourceEventId: rec\.id/,
    "the receipt's identity is its event id",
  );
});

// ── the wallet key ──────────────────────────────────────────────────────────

test("there is ONE spelling of each till, and it matches the writers", async () => {
  // `WALLET_LABELS` keyed `instapay` while `useFinancialStore`, the e-commerce
  // deposit default and the server zod enums all wrote `instaPay`. `WalletType`
  // is a bare string, so nothing caught it. Measured on QA-STORE: +5,040 in one
  // spelling, −2,700 in the other, and the till screen could only ever show one.
  const types = read("../src/types/index.ts");
  assert.match(types, /instaPay: "انستا باي"/, "the label key must match the writers");
  assert.doesNotMatch(types, /\n\s*instapay:/, "the lowercase key must be gone");

  const store = read("../src/store/useFinancialStore.ts");
  const eco = read("../src/routes/ecommerce-orders.tsx");
  for (const [src, label] of [[store, "useFinancialStore"], [eco, "order form"]]) {
    const wrong = src.match(/["']instapay["']/);
    assert.equal(wrong, null, `${label} must not use the lowercase spelling`);
  }
});

test("historical wallet spellings fold onto the canonical key on read", () => {
  // Source-level: `src/types/index.ts` imports through the `@/` alias, which
  // node's resolver cannot follow, and churning the type barrel to suit a test
  // would be a worse trade than reading the rule.
  const types = read("../src/types/index.ts");
  assert.match(types, /export function canonicalWallet\(subject: string\): string/);
  // Case-insensitive match against the canonical key set…
  assert.match(types, /key\.toLowerCase\(\) === lower/);
  // …and an unknown subject stays itself rather than being folded onto
  // somebody else's till.
  assert.match(types, /return subject;\s*\n\}/);

  // And the fold has to actually happen in the balance reader, for wallets only.
  const balances = read("../src/lib/ledger/useBalances.ts");
  assert.match(balances, /canonicalWallet\(row\.subjectId\)/);
  assert.match(balances, /account === "wallet"/, "only wallets may be case-folded");
  assert.match(balances, /folded\.set\(key, \(folded\.get\(key\) \?\? 0\) \+ row\.amount\)/);
});

// ── bundle stock in SELLABLE contexts ───────────────────────────────────────

test("every sellable-context stock read is bundle-aware", () => {
  // `getActualStock` returns 0 for a بوكس ON PURPOSE — a bundle owns no ledger
  // stock. So any screen that asks "can I sell this?" must use `sellableStock`,
  // which routes bundles to `bundleAvailableStock`. نقطة البيع learned this;
  // شاشة الجملة and the exchange replacement check had not, so a box read
  // «نفد المخزون» there while المخزون showed 7 buildable.
  for (const [file, label] of [
    ["../src/components/wholesale/WholesalePage.tsx", "wholesale product picker"],
    ["../src/routes/returns.tsx", "exchange replacement check"],
    ["../src/components/sales/CheckoutForm.tsx", "POS"],
  ]) {
    assert.match(read(file), /sellableStock\(/, `${label} must be bundle-aware`);
  }
});

test("the reads that are DELIBERATELY not bundle-aware stay that way", () => {
  // Unit totals must exclude virtual boxes or they double-count the components
  // they are made of; the جرد compares against the shelf RECORD by design.
  const inv = read("../src/components/inventory/InventoryTable.tsx");
  assert.match(inv, /getActualStock\(p\)/, "unit totals count real units only");
  const audit = read("../src/components/finance/StockAuditPage.tsx");
  assert.match(audit, /mirrorQty: getActualStock\(product\)/);
});
