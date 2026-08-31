/**
 * Reference-data payloads — the shape that actually reaches Supabase.
 *
 *     node --test scripts/check_cloud_schema.mjs
 *
 * Every failure this guards was silent. A payload naming one column the table
 * does not have is rejected WHOLE by PostgREST; a payload without `store_id` is
 * rejected by RLS with a 403. Both were logged and swallowed, so the app looked
 * like it saved and the other device simply never saw it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  toRemoteRow,
  fromRemoteRow,
  resetMissingColumns,
  noteMissingColumn,
} from "../src/services/api/fieldMapping.ts";
import { CLOUD_SCHEMA, resetDroppedReport } from "../src/services/api/cloudSchema.ts";

const STORE = "11111111-2222-4333-8444-555555555555";
const DEVICE = "99999999-8888-4777-8666-555555555555";

test.beforeEach(() => {
  resetMissingColumns();
  resetDroppedReport();
});

test("every declared column really exists in the deployed schema", () => {
  // The whole design rests on this file matching the SQL. If they drift, the
  // whitelist starts dropping real data or sending phantom columns.
  // EVERY migration, not just the master one. Migrations are additive: a table
  // added in 010 is just as deployed as one declared in 000, and reading only
  // the master made a correctly-migrated table look missing.
  const dir = fileURLToPath(new URL("../docs/migrations/", import.meta.url));
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(dir + f, "utf8"))
    .join(String.fromCharCode(10));

  // Columns the §6 patch loop adds to every synced table.
  const patched = new Set(["store_id", "updated_at"]);

  for (const [table, schema] of Object.entries(CLOUD_SCHEMA)) {
    const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS public.${table} (`);
    assert.ok(start > 0, `${table} is not in the master schema`);
    const body = sql.slice(start, sql.indexOf("\n);", start));

    for (const col of schema.columns) {
      if (patched.has(col)) continue;
      // Quoted camelCase columns appear as "unitPrice" in the DDL.
      const present = body.includes(`\n  ${col} `) || body.includes(`"${col}"`);
      assert.ok(present, `${table}.${col} is declared here but not in the SQL`);
    }
  }
});

test("every order status the app writes is allowed by the CHECK constraint", () => {
  // `cancelled` shipped in the UI but was absent from `orders_status_check`,
  // so Postgres refused every cancellation. A column whitelist cannot catch
  // that — the column existed, the VALUE was rejected — so the enum needs its
  // own guard.
  const dir = fileURLToPath(new URL("../docs/migrations/", import.meta.url));
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(dir + f, "utf8"))
    .join(String.fromCharCode(10));

  // The LAST definition wins, the same way the migrations apply in order.
  const defs = [...sql.matchAll(/orders_status_check"?\s*[\s\S]{0,80}?CHECK\s*\(status = ANY \(ARRAY\[([^\]]+)\]/g)];
  assert.ok(defs.length > 0, "orders_status_check must be defined in a migration");
  const allowed = new Set(
    [...defs[defs.length - 1][1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
  );

  const src = readFileSync(
    new URL("../src/components/ecommerce/OrdersPage.tsx", import.meta.url),
    "utf8",
  );
  const written = new Set(
    [...src.matchAll(/updateOrderStatus\([^,]+,\s*"([a-z_]+)"/g)].map((m) => m[1]),
  );
  assert.ok(written.size > 0, "no updateOrderStatus calls found — did the file move?");

  for (const status of written) {
    assert.ok(
      allowed.has(status),
      `OrdersPage writes status "${status}" but orders_status_check allows only: ` +
        [...allowed].join(", "),
    );
  }
});

test("store_id is attached to every payload — RLS refuses it otherwise", () => {
  for (const table of Object.keys(CLOUD_SCHEMA)) {
    const out = toRemoteRow(table, { id: "x" }, { storeId: STORE });
    assert.equal(out.store_id, STORE, `${table} lost its store_id`);
  }
});

test("a row's own stale store_id never overrides the active one", () => {
  // A record pulled from another store must not be pushed back under this one.
  const out = toRemoteRow("products", { id: "p1", store_id: "some-other-store" }, {
    storeId: STORE,
  });
  assert.equal(out.store_id, STORE);
});

test("nested objects and local-only junk are stripped, not sent", () => {
  // The reported failure: a purchase line carrying its whole `supplier` object.
  const out = toRemoteRow(
    "suppliers",
    {
      id: "s1",
      companyName: "مورد الشمال",
      contactPerson: "أحمد",
      phone: "0100",
      supplier: { id: "nested", name: "should not be sent" },
      invoices: [{ id: "i1" }],
      uiExpanded: true,
    },
    { storeId: STORE },
  );

  assert.equal(out.companyName, "مورد الشمال");
  assert.equal(out.contactPerson, "أحمد");
  assert.ok(!("supplier" in out), "nested supplier object must be dropped");
  assert.ok(!("invoices" in out), "nested invoices array must be dropped");
  assert.ok(!("uiExpanded" in out), "local UI flag must be dropped");
});

test("quoted camelCase columns are NOT snake_cased", () => {
  // `suppliers."companyName"` is a real column. Converting it to company_name
  // is the obvious "fix" that would break every supplier push.
  const out = toRemoteRow("suppliers", { id: "s1", companyName: "x", taxId: "t" }, {
    storeId: STORE,
  });
  assert.ok("companyName" in out, "companyName must survive verbatim");
  assert.ok("taxId" in out, "taxId must survive verbatim");
  assert.ok(!("company_name" in out));
  assert.ok(!("tax_id" in out));
});

test("products still map totalQuantity to the quantity column", () => {
  // The Phase 2 fix. `stockMirror` writes totalQuantity; the column is quantity.
  const out = toRemoteRow("products", { id: "p1", totalQuantity: 12, wholesalePrice: 30 }, {
    storeId: STORE,
  });
  assert.equal(out.quantity, 12);
  assert.equal(out.wholesale_price, 30);
  assert.ok(!("totalQuantity" in out));
  assert.ok(!("wholesalePrice" in out));
});

test("costPrice is never sent — cost is the ledger's, not a stored field", () => {
  const out = toRemoteRow("products", { id: "p1", costPrice: 99 }, { storeId: STORE });
  assert.ok(!("costPrice" in out));
  assert.ok(!("cost_price" in out));
});

test("updated_at is stamped, or the row is invisible to every other device", () => {
  // The pull watermark is `updated_at`. A row without one lands and is never
  // seen again by anyone.
  const before = Date.now();
  const out = toRemoteRow("customers", { id: "c1", name: "س" }, { storeId: STORE });
  assert.ok(typeof out.updated_at === "number");
  assert.ok(out.updated_at >= before);

  // An explicit stamp wins, so a batch shares one clock.
  const fixed = toRemoteRow("customers", { id: "c2" }, { storeId: STORE, stamp: 4242 });
  assert.equal(fixed.updated_at, 4242);
});

test("a column the server rejected once is not sent again", () => {
  noteMissingColumn("products", "metadata");
  const out = toRemoteRow("products", { id: "p1", metadata: { variants: [] } }, {
    storeId: STORE,
  });
  assert.ok(!("metadata" in out), "a known-missing column must be skipped");
});

test("an undescribed table passes through rather than being emptied", () => {
  // "We have not mapped this yet" must not become data loss.
  const row = { id: "x", whatever: 1 };
  assert.deepEqual(toRemoteRow("some_future_table", row, { storeId: STORE }), row);
});

test("the pull puts quantity back where the stock code reads it", () => {
  const local = fromRemoteRow("products", { id: "p1", quantity: 7, name: "ب" });
  assert.equal(local.totalQuantity, 7, "getActualStock reads totalQuantity");
  assert.equal(local.quantity, 7, "both are kept — dropping one deletes data");
});

test("push then pull round-trips a product without losing the shelf count", () => {
  const remote = toRemoteRow("products", { id: "p1", name: "ب", totalQuantity: 5 }, {
    storeId: STORE,
  });
  const back = fromRemoteRow("products", remote);
  assert.equal(back.totalQuantity, 5);
  assert.equal(back.name, "ب");
});

test("a rename beats a same-named field, whatever the key order", () => {
  // Every product carries BOTH the legacy `quantity: 0` placeholder and the
  // real `totalQuantity`. Whichever key lands last in a single pass wins, so a
  // one-pass mapper zeroes the shelf on the server about half the time —
  // depending only on property order, which is why it survives casual testing.
  const withPlaceholderLast = { id: "p1", totalQuantity: 7, quantity: 0 };
  const withPlaceholderFirst = { id: "p1", quantity: 0, totalQuantity: 7 };

  assert.equal(toRemoteRow("products", withPlaceholderLast, { storeId: STORE }).quantity, 7);
  assert.equal(toRemoteRow("products", withPlaceholderFirst, { storeId: STORE }).quantity, 7);
});

test("device_id is attached — it is NOT NULL on the deployed tables", () => {
  // The exact rejection this guards:
  //   null value in column "device_id" of relation "products"
  //       violates not-null constraint
  for (const table of Object.keys(CLOUD_SCHEMA)) {
    const out = toRemoteRow(table, { id: "x" }, { storeId: STORE, deviceId: DEVICE });
    assert.equal(out.device_id, DEVICE, `${table} lost its device_id`);
  }
});

test("an existing device_id is kept, not overwritten by ours", () => {
  // A row that came from the other machine and is being pushed back should
  // still name the device that actually wrote it.
  const out = toRemoteRow(
    "products",
    { id: "p1", device_id: "00000000-1111-4222-8333-444444444444" },
    { storeId: STORE, deviceId: DEVICE },
  );
  assert.equal(out.device_id, "00000000-1111-4222-8333-444444444444");
});

test("no payload leaves with a null device_id", () => {
  // A row explicitly carrying null must still be filled, or the insert fails.
  const out = toRemoteRow("customers", { id: "c1", device_id: null }, {
    storeId: STORE,
    deviceId: DEVICE,
  });
  assert.equal(out.device_id, DEVICE);
});

test("the string \"undefined\" never reaches a UUID column", () => {
  // The 22P02: `String(row.device_id)` on a NULL produced the literal
  // "undefined", which is truthy and non-null, so every guard preserved it and
  // Postgres rejected the insert with
  //   invalid input syntax for type uuid: "undefined"
  for (const junk of ["undefined", "null", "dummy", "", "not-a-uuid", "  "]) {
    const out = toRemoteRow("products", { id: "p1", device_id: junk }, {
      storeId: STORE,
      deviceId: DEVICE,
    });
    assert.equal(out.device_id, DEVICE, `junk device_id ${JSON.stringify(junk)} survived`);
  }
});

test("a genuine UUID from another device is still preserved", () => {
  // The replacement above must not become "always overwrite" — provenance
  // still matters for a row pushed back from elsewhere.
  const other = "00000000-1111-4222-8333-444444444444";
  const out = toRemoteRow("products", { id: "p1", device_id: other }, {
    storeId: STORE,
    deviceId: DEVICE,
  });
  assert.equal(out.device_id, other);
});
