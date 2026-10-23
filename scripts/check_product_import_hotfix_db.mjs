// Actual import controller -> actual catalog adapter -> unchanged deployed SQL contracts.
// Disposable loopback PostgreSQL 17.6 only; no cloud environment or customer rows.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openBusinessDb, read, ROOT } from "./helpers/business-db.mjs";
import { uiHarness } from "./helpers/ui-harness.mjs";
import { buildImportPlan } from "../src/lib/productImportWorkflow.ts";
let db, admin, accountant, h, execute;
before(async () => {
  db = await openBusinessDb();
  admin = await db.client("ADMIN");
  accountant = await db.client("ACCOUNTANT");
  for (const file of fs
    .readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter((f) => f >= "20261012000000")
    .sort())
    await db.admin.query(read("supabase/migrations/" + file));
  const state = { products: [] };
  h = uiHarness({
    "@/lib/financialCommand": {
      resolvePendingFinancialCommand: async () => null,
      resolvePendingOpeningBalance: async () => {},
      runFinancialCommand: async (command, input) => {
        assert.equal(command, "product_import");
        return (
          await admin.query(
            "select public.record_product_import($1,$2,$3,'product_import',$4) r",
            [crypto.randomUUID(), db.store, db.device, input],
          )
        ).rows[0].r;
      },
    },
    "@/services/api/storeContext": {
      getSyncIdentity: async () => ({ storeId: db.store, deviceId: db.device }),
    },
    "@/store/useAuthStore": {
      useAuthStore: {
        getState: () => ({
          permissionsVerified: true,
          userRole: "ADMIN",
          session: { user: { id: db.users.ADMIN } },
          accessRevision: 1,
        }),
      },
    },
    "@/store/useBusinessStore": {
      useBusinessStore: {
        getState: () => state,
        setState: (fn) => Object.assign(state, typeof fn === "function" ? fn(state) : fn),
      },
    },
    "@/services/cloudData": {
      cloudList: async () =>
        (
          await admin.query(
            "select * from public.products where store_id=$1 and deleted_at is null",
            [db.store],
          )
        ).rows,
    },
  });
  execute = h.load("src/lib/productImportCommand.ts").executeProductImport;
});
after(async () => {
  if (h) await h.cleanup();
  if (db) await db.close();
});
const headers = ["sku", "name", "purchase_price", "retail_price", "stock_qty", "variants_raw"];
const make = (sku = "PG-IMPORT") =>
  buildImportPlan([headers, [sku, "Synthetic import", 1.25, 2.55, 3, "RED / M:2, BLUE / L:1"]]);
const stock = async (id) =>
  (
    await db.admin.query(
      "select sum(qty_delta)::numeric::text qty,sum(amount_delta)::text piastres from ledger_lines where store_id=$1 and account='stock' and subject_id=$2",
      [db.store, id],
    )
  ).rows[0];
test("PG17.6: XLSX plan persists atomic product, variants, stock and 375 piastres; fresh Desktop/Mobile reader and retry see one identity", async () => {
  assert.match(db.version, /PostgreSQL 17\.6/);
  const p = make(),
    r = await execute(p, () => {},undefined,'owned');
  assert.equal(r.created, 1);
  assert.equal(r.error, undefined);
  const product = (
    await admin.query("select * from products where store_id=$1 and sku=$2", [
      db.store,
      "PG-IMPORT",
    ])
  ).rows[0];
  assert.equal(Number(product.quantity), 3);
  assert.equal(Number(product.unitPrice), 2.55);
  assert.deepEqual(product.metadata.variants, [
    { name: "RED / M", stock: 2 },
    { name: "BLUE / L", stock: 1 },
  ]);
  assert.deepEqual(await stock(product.id), { qty: "3", piastres: "375" });
  assert.equal(
    Number(
      (
        await accountant.query("select quantity from products where store_id=$1 and id=$2", [
          db.store,
          product.id,
        ])
      ).rows[0].quantity,
    ),
    3,
  );
  const replay = await execute(p, () => {},undefined,'owned');
  assert.equal(replay.created, 0);
  assert.equal(replay.recovered, 1);
  assert.deepEqual(await stock(product.id), { qty: "3", piastres: "375" });
  assert.equal(
    (
      await db.admin.query(
        "select count(*)::int n from ledger_events e where e.store_id=$1 and e.id in (select event_id from ledger_lines where subject_id=$2)",
        [db.store, product.id],
      )
    ).rows[0].n,
    1,
  );
});
test("PG17.6: failure after product creation rolls back product and ledger; retry uses normal command", async () => {
  await db.admin.query(
    "create function qa_import_late() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_LATE_IMPORT';end$$; create trigger qa_import_late after insert on ledger_lines for each row execute function qa_import_late()",
  );
  try {
    const r = await execute(make("PG-ROLLBACK"), () => {},undefined,'owned');
    assert.equal(r.created, 0);
    assert.ok(r.error);
    assert.equal(
      (
        await db.admin.query(
          "select count(*)::int n from products where store_id=$1 and sku='PG-ROLLBACK'",
          [db.store],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await db.admin.query(
      "drop trigger qa_import_late on ledger_lines;drop function qa_import_late()",
    );
  }
  assert.equal((await execute(make("PG-ROLLBACK"), () => {},undefined,'owned')).created, 1);
});
test("PG17.6: existing product is skipped while new rows append; concurrent same-file imports cannot duplicate stock", async () => {
  const before = (
    await db.admin.query(
      "select jsonb_agg(to_jsonb(p) order by id) r from products p where store_id=$1",
      [db.store],
    )
  ).rows[0].r;
  const conflict = buildImportPlan([
    headers,
    ["NEW-BEFORE-CONFLICT", "New", 1, 2, 1],
    ["PG-IMPORT", "Unwanted overwrite", 99, 100, 20],
  ]);
  const r = await execute(conflict, () => {},undefined,'owned');
  assert.equal(r.created, 1);
  assert.equal(r.skipped,1);
  assert.equal(r.error,undefined);
  assert.deepEqual(
    (
      await db.admin.query(
        "select jsonb_agg(to_jsonb(p) order by id) r from products p where store_id=$1",
        [db.store],
      )
    ).rows[0].r.filter(p=>before.some(original=>original.id===p.id)),
    before,
  );
  const p = make("PG-CONCURRENT");
  await Promise.all([execute(p, () => {},undefined,'owned'), execute(p, () => {},undefined,'owned')]);
  const rows = (
    await db.admin.query("select id from products where store_id=$1 and sku='PG-CONCURRENT'", [
      db.store,
    ])
  ).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(await stock(rows[0].id), { qty: "3", piastres: "375" });
  assert.equal((await execute(p, () => {},undefined,'owned')).recovered, 1);
});
