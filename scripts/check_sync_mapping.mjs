/**
 * Local record ⇄ Supabase columns.
 *
 *     node --test scripts/check_sync_mapping.mjs
 *
 * The bug this guards: `stockMirror` writes `totalQuantity`, the table has
 * `quantity`, and the sync layer pushed the local object verbatim — so every
 * stock movement was rejected and the shelf count never left the device.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  toRemoteRow,
  fromRemoteRow,
  noteMissingColumn,
  knownMissingColumns,
  resetMissingColumns,
  unknownColumnFrom,
} from "../src/services/api/fieldMapping.ts";

// The learned-missing set is module state; every test starts from a clean one.
test.beforeEach(() => resetMissingColumns());

/** A product as the Zustand store holds it, mid-life. */
const local = () => ({
  id: "p1",
  name: "قميص قطن",
  sku: "SH-1",
  barcode: "111",
  category: "ملابس",
  unitPrice: 100,
  wholesalePrice: 80,
  totalQuantity: 7,
  quantity: 0, // legacy placeholder nothing maintains
  isActive: true,
  isBundle: false,
  metadata: { variants: [{ name: "أحمر", stock: 7 }] },
  costPrice: 60,
  updated_at: 1234,
});

test("the shelf count reaches the column that holds it", () => {
  const row = toRemoteRow("products", local());
  assert.equal(row.quantity, 7, "totalQuantity must land in `quantity`");
  assert.ok(!("totalQuantity" in row), "the local-only name must not be sent");
});

test("the legacy placeholder never overwrites the real count", () => {
  // `quantity: 0` sits on every record addProduct created. If it won the
  // merge, syncing would zero the shelf on the server.
  const row = toRemoteRow("products", { ...local(), quantity: 0, totalQuantity: 7 });
  assert.equal(row.quantity, 7);
});

test("camelCase price maps to its snake_case column", () => {
  const row = toRemoteRow("products", local());
  assert.equal(row.wholesale_price, 80);
  assert.ok(!("wholesalePrice" in row));
});

test("costPrice is never sent — cost is the ledger's, not the record's", () => {
  assert.ok(!("costPrice" in toRemoteRow("products", local())));
});

test("variant stock IS sent, so a server that has the column keeps it", () => {
  const row = toRemoteRow("products", local());
  assert.deepEqual(row.metadata, { variants: [{ name: "أحمر", stock: 7 }] });
});

test("once the server has refused metadata, every key left is a real column", () => {
  // `products` columns common to both schema files in the repo. `metadata` is
  // absent on purpose: it is sent optimistically and dropped on refusal, which
  // is exactly the state this asserts — an un-migrated server ends up here.
  const columns = new Set([
    "id", "name", "sku", "image_url", "category", "description", "quantity",
    "unitPrice", "wholesale_price", "minStockLevel", "maxStockLevel", "barcode",
    "isActive", "isBundle", "bundleItems", "updated_at", "deleted_at",
    "store_id", "device_id", "sync_status",
  ]);

  noteMissingColumn("products", "metadata"); // what the first push would learn
  for (const key of Object.keys(toRemoteRow("products", local()))) {
    assert.ok(columns.has(key), `"${key}" is not a column on products`);
  }
});

test("a pull puts the count back where getActualStock reads it", () => {
  const remote = { id: "p1", name: "قميص قطن", quantity: 12, wholesale_price: 80 };
  const row = fromRemoteRow("products", remote);
  assert.equal(row.totalQuantity, 12);
  assert.equal(row.wholesalePrice, 80);
  // Kept alongside: dropping a field on the way in is how a pull deletes data.
  assert.equal(row.quantity, 12);
});

test("push then pull is lossless for the fields that have columns", () => {
  const before = local();
  const after = fromRemoteRow("products", toRemoteRow("products", before));
  for (const key of ["id", "name", "sku", "barcode", "category", "unitPrice", "wholesalePrice", "totalQuantity", "isActive"]) {
    assert.deepEqual(after[key], before[key], `${key} did not survive the round trip`);
  }
});

test("a described table is filtered, not passed through", () => {
  // This test used to assert the opposite: only `products` was mapped and every
  // other table went out verbatim. That was the deliberate choice while just
  // one schema was confirmed — and it is exactly why reference data never
  // synced: an unfiltered row names columns the table does not have and
  // PostgREST rejects the whole upsert.
  //
  // All seven tables are now described in `cloudSchema.ts`, and
  // check_cloud_schema.mjs verifies every declared column against the deployed
  // SQL, so filtering them is a checked claim rather than a guess.
  const branch = { id: "b1", name: "فرع مدينة نصر", totalQuantity: 5 };
  const out = toRemoteRow("branches", branch);
  assert.equal(out.id, "b1");
  assert.equal(out.name, "فرع مدينة نصر");
  assert.ok(!("totalQuantity" in out), "branches has no such column — it must be dropped");
});

test("a table with no description still passes through untouched", () => {
  // "Not described yet" must never become data loss.
  const row = { id: "x", anything: 1 };
  assert.deepEqual(toRemoteRow("some_future_table", row), row);
  assert.deepEqual(fromRemoteRow("some_future_table", row), row);
});

test("null and non-object rows survive without throwing", () => {
  for (const junk of [null, undefined, "x", 3]) {
    assert.equal(toRemoteRow("products", junk), junk);
    assert.equal(fromRemoteRow("products", junk), junk);
  }
});


// ── learning which columns the server actually has ──────────────────────────

test("a rejected column is dropped from the next payload", () => {
  assert.ok("metadata" in toRemoteRow("products", local()));
  noteMissingColumn("products", "metadata");
  const row = toRemoteRow("products", local());
  assert.ok(!("metadata" in row), "must stop sending what the server refused");
  // Everything else still goes, including the count this whole fix is about.
  assert.equal(row.quantity, 7);
});

test("what is learned is remembered, and scoped to its table", () => {
  noteMissingColumn("products", "metadata");
  assert.ok(knownMissingColumns("products").has("metadata"));
  assert.ok(!knownMissingColumns("branches").has("metadata"));
});

test("the shelf count survives even if `quantity` itself were rejected", () => {
  // Belt and braces: the mapped-to column is checked too, so a bad schema
  // degrades to a smaller payload rather than an infinite retry.
  noteMissingColumn("products", "quantity");
  const row = toRemoteRow("products", local());
  assert.ok(!("quantity" in row));
  assert.ok(!("totalQuantity" in row));
});

test("the column name is read out of a real PostgREST rejection", () => {
  const real = {
    code: "PGRST204",
    message: "Could not find the 'metadata' column of 'products' in the schema cache",
  };
  assert.equal(unknownColumnFrom(real), "metadata");
});

test("an unrelated failure is not mistaken for a missing column", () => {
  // RLS must surface as an error, never be swallowed as a schema quirk.
  const rls = {
    code: "42501",
    message: 'new row violates row-level security policy for table "products"',
  };
  assert.equal(unknownColumnFrom(rls), null);
  assert.equal(unknownColumnFrom(null), null);
  assert.equal(unknownColumnFrom({}), null);
});

test("dropping columns one at a time always terminates", () => {
  // Each rejection removes one key, so the payload strictly shrinks.
  let row = toRemoteRow("products", local());
  const before = Object.keys(row).length;
  noteMissingColumn("products", Object.keys(row)[0]);
  row = toRemoteRow("products", local());
  assert.ok(Object.keys(row).length < before);
});
