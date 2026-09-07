/**
 * The role restrictions on writes have to restrict.
 *
 *     node --test scripts/check_role_write_enforcement.mjs
 *
 * ## The bug this exists to prevent
 *
 * Found in the roles audit on 2026-09-07. Six tables carried a role-gated `ALL`
 * policy AND a second, permissive INSERT/UPDATE policy keyed only on
 * `is_store_member`:
 *
 *     write_products    FOR ALL    USING has_role(store_id,'ADMIN','ACCOUNTANT')
 *     insert_products   FOR INSERT WITH CHECK is_store_member(store_id)
 *     update_products   FOR UPDATE USING      is_store_member(store_id)
 *
 * Postgres OR-s permissive policies, so the narrow one governed nothing but
 * DELETE. Verified against the live database, acting as a POS_ECOMMERCE member
 * inside a transaction that rolled back:
 *
 *     products INSERT → ALLOWED, products UPDATE → 5 rows repriced,
 *     branches INSERT → ALLOWED, suppliers INSERT → ALLOWED
 *
 * The till operator has no Products screen at all — `/products` is ADMIN-only in
 * `lib/roles.ts` — so the UI hid a door the database had left unlocked, and the
 * price columns are the ones that matter: set a price to zero, sell, set it
 * back.
 *
 * ## Why this guard is source-level
 *
 * The policies live in Postgres, and the bad ones were never in this repository
 * to begin with — like the `orders` policy found in the hardening audit, they
 * were created directly against the project. A test that reads migration files
 * cannot prove what the database currently enforces.
 *
 * So this asserts the two things a repository CAN own: that the migration which
 * closes the hole is still here and still says what it said, and that the
 * client-side route map still agrees about who owns the Products screen. The
 * authoritative check is the SQL probe in `scripts/role_matrix_probe.sql`,
 * which runs against the live database and is reproduced in docs/SECURITY.md.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canAccess } from "../src/lib/roles.ts";

const migration = readFileSync(
  new URL("../docs/migrations/022_role_write_enforcement.sql", import.meta.url),
  "utf8",
);

/** The permissive twins that made the role gate a no-op. */
const DROPPED = [
  ["branches", "insert"], ["branches", "update"],
  ["suppliers", "insert"], ["suppliers", "update"],
  ["customers", "insert"], ["customers", "update"],
  ["discount_codes", "insert"], ["discount_codes", "update"],
  ["return_records", "insert"], ["return_records", "update"],
  ["products", "insert"],
];

test("the migration still drops every permissive write policy", () => {
  const missing = [];
  for (const [table, verb] of DROPPED) {
    const name = `${verb}_${table}`;
    if (!new RegExp(`DROP POLICY IF EXISTS\\s+${name}\\b`, "i").test(migration)) {
      missing.push(name);
    }
  }
  assert.deepEqual(
    missing,
    [],
    "these permissive policies are no longer dropped, so the role gate is a no-op again:\n  " +
      missing.join("\n  "),
  );
});

test("products keeps its UPDATE policy, guarded by column instead", () => {
  // `update_products` is deliberately NOT dropped: `applyStockMoves` writes the
  // quantity mirror from الطلبات, which POS_ECOMMERCE and ECOMMERCE_ONLY own.
  // Dropping it would break order handling for exactly the roles whose screen
  // it is. The trigger is what protects the columns that define the product.
  assert.ok(
    !/DROP POLICY IF EXISTS\s+update_products\b/i.test(migration),
    "dropping update_products breaks the stock mirror for the selling roles",
  );
  assert.match(migration, /CREATE TRIGGER products_guard_definition_columns/i);
  assert.match(migration, /BEFORE UPDATE ON public\.products/i);
});

test("the guarded columns are the ones that define a product", () => {
  // Prices first — they are the fraud path. The rest are identity, thresholds,
  // the recipe and the tombstone.
  for (const column of [
    "unitPrice", "wholesale_price", "name", "sku", "barcode", "category",
    "description", "image_url", "minStockLevel", "maxStockLevel",
    "isActive", "isBundle", "bundleItems", "deleted_at", "store_id",
  ]) {
    assert.ok(
      migration.includes(column),
      `${column} is no longer guarded — a non-admin could change it`,
    );
  }
  // And the mirror columns must NOT be guarded, or orders stop working.
  const guardBody = migration.slice(
    migration.indexOf("IS DISTINCT FROM"),
    migration.indexOf("RAISE EXCEPTION"),
  );
  for (const free of ["quantity", "metadata"]) {
    assert.ok(
      !new RegExp(`NEW\\.${free}\\b`).test(guardBody),
      `${free} must stay writable — it is the stock mirror the selling roles update`,
    );
  }
});

test("the trigger lets ADMIN and ACCOUNTANT through, and no one else", () => {
  assert.match(
    migration,
    /has_role\(NEW\.store_id, VARIADIC ARRAY\['ADMIN', 'ACCOUNTANT'\]\)/,
    "the trigger must exempt exactly the two roles that own product definitions",
  );
  // Service-role / SQL sessions have no end user and already bypass RLS.
  assert.match(migration, /auth\.uid\(\) IS NULL/, "a backend session must not be blocked");
});

test("the route map still agrees who owns the Products screen", () => {
  // If /products were ever opened to a selling role, the database rule above
  // would start contradicting the UI instead of backing it up.
  assert.equal(canAccess("ADMIN", "/products"), true);
  assert.equal(canAccess("ACCOUNTANT", "/products"), false);
  assert.equal(canAccess("POS_ECOMMERCE", "/products"), false);
  assert.equal(canAccess("ECOMMERCE_ONLY", "/products"), false);
});

test("no role but ADMIN can reach the screens that manage people or the shop", () => {
  for (const path of ["/users", "/branches", "/settings", "/backups", "/integrations"]) {
    assert.equal(canAccess("ADMIN", path), true, `ADMIN must reach ${path}`);
    for (const role of ["POS_ECOMMERCE", "ECOMMERCE_ONLY", "ACCOUNTANT"]) {
      assert.equal(canAccess(role, path), false, `${role} must not reach ${path}`);
    }
  }
});
