/**
 * Mobile ↔ Core alignment (M1 + M2).
 *
 * Every test here corresponds to a way the mobile data layer had drifted from
 * the Desktop/Core semantics that were verified earlier. They are deliberately
 * source-level where the defect is "which module does this call" — the same
 * shape `check_online_only.mjs` uses — and behavioural where the defect is an
 * arithmetic rule.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildableFromRecipe, bundleAvailableStock } from "../src/lib/product.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ── M1: one receipt write, not three ────────────────────────────────────────

test("there is exactly ONE place that writes a supplier receipt", () => {
  // شاشة المشتريات, QuickRestockDialog and the mobile command each had their
  // own copy. Only the first was ever corrected, so the numbering and ordering
  // defects survived in the other two.
  for (const file of [
    "../src/components/purchasing/PurchasingPage.tsx",
    "../src/components/products/QuickRestockDialog.tsx",
    "../src/mobile/screens/MobileQuickRestock.tsx",
  ]) {
    const src = read(file);
    assert.doesNotMatch(
      src,
      /purchaseInvoices\.length \+ 1/,
      `${file} must not compute an invoice number from a local array length`,
    );
  }
  const command = read("../src/lib/receiving/command.ts");
  assert.doesNotMatch(command, /purchaseInvoices\.length \+ 1/);
});

test("the transaction allocates a unique invoice number", () => {
 const sql=read("../supabase/migrations/20261005115027_financial_write_safety.sql");
 assert.match(sql,/next_document_number\(p_store,'purchase_invoice','FM-'\)/);
 assert.match(sql,/EXIT WHEN NOT EXISTS\(SELECT 1 FROM public.purchase_invoices/);
});

test("the receipt uses one transaction without compensating deletion", () => {
 const src=read("../src/lib/receiving/commitReceipt.ts");
 assert.match(src,/runFinancialCommand[\s\S]*?\("receipt",/);
 assert.doesNotMatch(src,/removePurchaseInvoice|appendEvent|addPurchaseInvoice/);
});

test("every receipt path goes through the shared commit", () => {
  assert.match(read("../src/components/purchasing/PurchasingPage.tsx"), /commitReceipt\(/);
  assert.match(read("../src/components/products/QuickRestockDialog.tsx"), /executeQuickRestock\(/);
  assert.match(read("../src/mobile/screens/MobileQuickRestock.tsx"), /executeQuickRestock\(/);
  assert.match(read("../src/lib/receiving/command.ts"), /commitReceipt\(/);
});

test("the receipt carries variantName onto the invoice line", () => {
  // Desktop's supplier return is invoice-driven and needs the shade to know
  // which one came back.
  assert.match(read("../src/lib/receiving/commitReceipt.ts"), /variantName: l\.variantName/);
});

// ── M1: supplier resolution ─────────────────────────────────────────────────

test("suppliers are resolved from the server, not from the unhydrated store", () => {
  // Mobile never calls `hydrateAll`, so `useBusinessStore.suppliers` is
  // permanently []. Resolving against it made every existing supplier look
  // missing and minted a duplicate on every mobile receipt.
  const command = read("../src/lib/receiving/command.ts");
  assert.match(read("../supabase/migrations/20261005115027_financial_write_safety.sql"), /FROM public.suppliers WHERE id=p_input->>'supplierId' AND store_id=p_store/);
  assert.doesNotMatch(command, /suppliers\.find\(/, "must not resolve from the local store array");

  const screen = read("../src/mobile/screens/MobileQuickRestock.tsx");
  assert.match(screen, /readSuppliers\(/, "the picker must load suppliers from the server");
});

test("new supplier creation is guarded inside the receipt transaction", () => {
 const sql=read("../supabase/migrations/20261005115027_financial_write_safety.sql");
 assert.match(sql,/IF p_input->>'supplierId'='__new__' THEN/);
 assert.ok(sql.indexOf("IF p_input->>'supplierId'='__new__'") < sql.indexOf('INSERT INTO public.suppliers'));
});

// ── M2: customer financials come from the Core authorities ──────────────────

test("customer lifetime value reads customer_ltv, not a sum of order totals", () => {
  const src = read("../src/mobile/data/mobileReaders.ts");
  assert.match(src, /balanceOf\("customer_ltv", customerId\)/);
  assert.doesNotMatch(
    src,
    /deliveredRevenue \+= Number\(order\.totalAmount/,
    "summing order totals overstates a partial return, which customer_ltv already deducted",
  );
});

test("wasted trips read the settling DEBT, not a count of RTO rows", () => {
  const src = read("../src/mobile/data/mobileReaders.ts");
  assert.match(src, /returned_orders_count/);
  assert.doesNotMatch(
    src,
    /if \(order\.returnType === "rto"\) \{\s*wastedTrips\+\+/,
    "counting rto rows ignores return_cause and never decreases when the debt is settled",
  );
});

// ── M2: alerts must not fake an all-clear ───────────────────────────────────

test("a signal with no reader is omitted, not shown as zero", () => {
  // Asserted at source rather than by execution: `alertModel` sits behind the
  // mobile module graph, whose extensionless imports the node runner cannot
  // resolve, and churning every mobile import to satisfy a test would be a
  // worse trade than reading the guard.
  const src = read("../src/mobile/viewmodels/alertModel.ts");
  assert.match(
    src,
    /count === undefined \|\| count === null \|\| count <= 0/,
    "an unanswerable signal must be skipped, not treated as an all-clear",
  );
  assert.match(src, /agingPendingOrders\?: number/, "and the field must be optional");
  assert.match(src, /longInTransitOrders\?: number/);
  assert.match(src, /unsettledCodOrders\?: number/);
});

test("home no longer passes hardcoded zeros for unanswerable signals", () => {
  const src = read("../src/mobile/data/mobileHomeReader.ts");
  assert.doesNotMatch(src, /agingPendingOrders: 0/);
  assert.doesNotMatch(src, /longInTransitOrders: 0/);
  assert.doesNotMatch(src, /unsettledCodOrders: 0/);
});

// ── M2: bundle availability is ONE rule ─────────────────────────────────────

test("buildable boxes are the scarcest component, floored", () => {
  const recipe = [
    { productId: "X", quantity: 2 },
    { productId: "Y", quantity: 1 },
  ];
  const stock = { X: 5, Y: 9 };
  assert.equal(buildableFromRecipe(recipe, (id) => stock[id] ?? 0), 2, "5/2 floors to 2");
  assert.equal(buildableFromRecipe(recipe, () => 0), 0, "nothing on the shelf, nothing buildable");
  assert.equal(buildableFromRecipe([], () => 99), 0, "a box with no recipe is unbuildable");
  assert.equal(buildableFromRecipe(undefined, () => 99), 0);
});

test("a zero-quantity component line cannot make a box infinitely available", () => {
  const recipe = [{ productId: "X", quantity: 0 }, { productId: "Y", quantity: 1 }];
  assert.equal(buildableFromRecipe(recipe, (id) => (id === "Y" ? 3 : 0)), 3);
});

test("the desktop entry point still gives the same answer through the shared rule", () => {
  // `bundleAvailableStock` now delegates; its behaviour must not have moved.
  const products = [
    { id: "X", totalQuantity: 5, quantity: 5 },
    { id: "Y", totalQuantity: 9, quantity: 9 },
  ];
  const box = { id: "BOX", isBundle: true, bundleItems: [
    { productId: "X", quantity: 2 }, { productId: "Y", quantity: 1 },
  ] };
  assert.equal(bundleAvailableStock(box, products), buildableFromRecipe(box.bundleItems, (id) => {
    const p = products.find((x) => x.id === id);
    return p ? p.totalQuantity : 0;
  }));
});

test("mobile derives box availability from components, never from the virtual balance", () => {
  const src = read("../src/mobile/data/mobileReaders.ts");
  assert.match(src, /buildableFromRecipe\(/, "must use the shared rule");
  assert.doesNotMatch(
    src,
    /Math\.min\([^;]*Math\.floor/,
    "and must not carry its own copy of it",
  );
  // A recipe may pin a درجة. Dropping `variantName` on the floor made a
  // box needing the red one look buildable out of the blue ones, and gave
  // desktop and mobile two different answers for one box.
  assert.match(
    src,
    /buildableFromRecipe\(recipe, \(id, variantName\)/,
    "the recipe callback must receive the variant, not just the id",
  );
  assert.match(src, /variantStockFrom\(/, "and must resolve it with the shared clamp");
});

// ── M2: the shortage question ───────────────────────────────────────────────

test("shortages pass the active store explicitly", () => {
  const src = read("../src/mobile/data/mobileHomeReader.ts");
  assert.match(src, /getActiveStoreId\(\)/);
  assert.match(src, /rpc\("mobile_shortages", \{ p_store: storeId \}\)/);
});

test("the shortage gate fails CLOSED for a non-member", () => {
  // `has_role` is `member_role(store) = ANY(roles)`, and `member_role` is NULL
  // for someone who is not a member at all — so `NOT has_role(...)` is NULL and
  // plpgsql runs the body anyway. Verified live before the fix: an ADMIN of a
  // different shop read QA-STORE's shortages.
  const sql = read("../docs/migrations/028_mobile_shortages_real_demand.sql");
  assert.match(sql, /IF NOT COALESCE\(public\.has_role\(/);
  assert.match(sql, /\), false\) THEN/);
});

test("the shortage RPC is not callable by a signed-out client", () => {
  const sql = read("../docs/migrations/028_mobile_shortages_real_demand.sql");
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.mobile_shortages\(uuid\) FROM anon/);
});

test("ledger stock is cast to the column's own type", () => {
  // `qty_delta` is `real`; the declared column is `numeric`. Postgres only
  // raises the mismatch once a row actually comes back, so it hid behind an
  // empty result for as long as nothing was short.
  assert.match(
    read("../docs/migrations/028_mobile_shortages_real_demand.sql"),
    /SUM\(l\.qty_delta\)::numeric AS stock/,
  );
});

test("the active store is the one membership, not an arbitrary first row", () => {
  // `store_members_one_store_per_user` is a UNIQUE index on user_id, so there
  // is exactly one row. `.limit(1)` would only serve to hide the day that stops
  // being true, by answering with whichever row came back first.
  const src = read("../src/services/api/storeContext.ts");
  assert.doesNotMatch(src, /\.eq\("user_id", uid\)\s+\.limit\(1\)/);
  assert.match(src, /\.eq\("user_id", uid\)\s+\.maybeSingle\(\)/);
});

// ── isolation ───────────────────────────────────────────────────────────────

test("mobile still pulls in no desktop screens and no hydrateAll", () => {
  for (const file of [
    "../src/mobile/data/mobileReaders.ts",
    "../src/mobile/data/mobileHomeReader.ts",
    "../src/mobile/screens/MobileQuickRestock.tsx",
  ]) {
    const src = read(file);
    // The CALL, not the word — these files explain in comments why mobile
    // deliberately never hydrates, and that explanation must stay.
    assert.doesNotMatch(src, /hydrateAll\s*\(/, `${file} must not hydrate the whole desktop dataset`);
    assert.doesNotMatch(src, /@\/components\/(ecommerce|wholesale|purchasing|sales|finance)\//, file);
  }
});
