import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { openBusinessDb, read, ROOT } from "./helpers/business-db.mjs";
const db = await openBusinessDb();
let result;
try {
  for (const file of fs
    .readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter((x) => x >= "20261012000000" && x <= "20261019135331_cashier_sequential_shifts.sql")
    .sort())
    await db.admin.query(read("supabase/migrations/" + file));
  const client = await db.client("ADMIN"),
    id = crypto.randomUUID(),
    operation = crypto.randomUUID();
  const created = (
    await client.query("select public.record_product_catalog($1,$2,$3,'product_catalog',$4) r", [
      operation,
      db.store,
      db.device,
      {
        action: "create",
        product: {
          id,
          name: "Synthetic archive diagnostic",
          sku: "ARCHIVE-DIAG",
          quantity: 3,
          unitPrice: 2.55,
          metadata: { variants: [] },
        },
        unitCost: 1.25,
      },
    ])
  ).rows[0].r.product;
  let rejection;
  try {
    await client.query(
      "insert into public.products select (jsonb_populate_record(null::public.products,$1::jsonb)).* on conflict(id) do update set deleted_at=excluded.deleted_at,updated_at=excluded.updated_at",
      [{ ...created, deleted_at: Date.now(), updated_at: created.updated_at + 1 }],
    );
  } catch (e) {
    rejection = { code: e.code, message: e.message };
  }
  assert.equal(rejection?.code, "23514");
  assert.match(rejection.message, /NEXUS_CATALOG_ATOMIC_REQUIRED/);
  const unchanged = (await db.admin.query("select deleted_at from products where id=$1", [id]))
    .rows[0].deleted_at;
  assert.equal(unchanged, null);
  // A minimal metadata UPDATE avoids the insert trigger, but the released
  // schema has no pending-commitment archive guard. Demonstrate only locally.
  await db.insert("orders", {
    id: crypto.randomUUID(),
    store_id: db.store,
    device_id: db.device,
    orderNumber: "QA-ARCHIVE-PENDING",
    customerName: "Synthetic",
    customerPhone: "01000000000",
    items: [{ productId: id, quantity: 1 }],
    stockItems: [],
    totalAmount: 0,
    shippingFee: 0,
    depositAmount: 0,
    expectedCod: 0,
    status: "pending",
  });
  await client.query(
    "update public.products set deleted_at=$1,updated_at=updated_at+1 where id=$2",
    [Date.now(), id],
  );
  const current = (await db.admin.query("select deleted_at from products where id=$1", [id]))
    .rows[0];
  assert.ok(current.deleted_at !== null);
  const stock = (
    await db.admin.query(
      "select sum(qty_delta)::int units,sum(amount_delta)::int piastres,count(*)::int lines from ledger_lines where store_id=$1 and account='stock' and subject_id=$2",
      [db.store, id],
    )
  ).rows[0];
  assert.deepEqual(stock, { units: 3, piastres: 375, lines: 1 });
  result = {
    at: new Date().toISOString(),
    environment: "ISOLATED LOOPBACK ONLY",
    version: db.version,
    baselineSha: "1e41aafc9a161803ca581a7e5c47556671e59981",
    legacyFullRowUpsert: rejection,
    rejectedArchiveDidNotChangeProduct: true,
    minimalPatchCurrentlyArchivesDespitePendingOrder: true,
    stockUnchanged: stock,
    productionMutations: 0,
  };
} finally {
  await db.close();
}
const dir = process.env.NEXUS_PRODUCT_EVIDENCE ?? path.join(ROOT, "logs/product-archive-import");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, "archive-baseline-diagnostic.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
