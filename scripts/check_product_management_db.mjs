import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openBusinessDb, read, ROOT } from "./helpers/business-db.mjs";
import { uiHarness } from "./helpers/ui-harness.mjs";
import {
  buildImportPlan,
  checkImportDuplicates,
  summarizeImport,
  catalogCode,
} from "../src/lib/productImportWorkflow.ts";
import { buildSaleLines } from "../src/lib/ledger/sales.ts";
let db, admin, conservation;
const migration = "20261023161107_product_archive_safe_import.sql";
async function schemaSnapshot() {
  const functions = (
    await db.admin.query(
      "select p.oid::text id,n.nspname||'.'||p.oid::regprocedure::text name,md5(pg_get_functiondef(p.oid)) definition,p.proacl::text acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','financial_private') and p.prokind='f' order by p.oid",
    )
  ).rows;
  const tables = (
    await db.admin.query(
      "select c.oid::regclass::text name,c.relrowsecurity rls,c.relforcerowsecurity forced,c.relacl::text acl from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','financial_private') and c.relkind='r' order by c.oid",
    )
  ).rows;
  const policies = (
    await db.admin.query(
      "select * from pg_policies where schemaname in ('public','financial_private') order by schemaname,tablename,policyname",
    )
  ).rows;
  const data = [];
  for (const t of tables)
    data.push({
      table: t.name,
      rows: (
        await db.admin.query(
          `select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') rows from ${t.name} x`,
        )
      ).rows[0].rows,
    });
  return { functions, tables, policies, data };
}
before(async () => {
  db = await openBusinessDb();
  for (const file of fs
    .readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter((x) => x >= "20261012000000" && x < migration)
    .sort())
    await db.admin.query(read("supabase/migrations/" + file));
  admin = await db.client("ADMIN");
  await create(2, 1.25, "PRE-MIGRATION-HISTORY");
  const prior = await schemaSnapshot();
  await db.admin.query(read("supabase/migrations/" + migration));
  const next = await schemaSnapshot();
  conservation = { prior, next };
});
after(async () => {
  if (db) await db.close();
});
async function create(quantity = 3, cost = 1.25, sku = "CAT-" + crypto.randomUUID()) {
  const id = crypto.randomUUID();
  return (
    await admin.query("select public.record_product_catalog($1,$2,$3,'product_catalog',$4) r", [
      crypto.randomUUID(),
      db.store,
      db.device,
      {
        action: "create",
        product: { id, name: sku, sku, quantity, unitPrice: 2.55, metadata: { variants: [] } },
        unitCost: cost,
      },
    ])
  ).rows[0].r.product;
}
async function archive(product, action = "archive", id = crypto.randomUUID(), client = admin) {
  return (
    await client.query("select public.record_product_archive($1,$2,$3,'product_archive',$4) r", [
      id,
      db.store,
      db.device,
      { productId: product.id, action, expectedUpdatedAt: product.updated_at },
    ])
  ).rows[0].r;
}
const current = async (id) =>
  (await db.admin.query("select * from products where id=$1", [id])).rows[0];
const fingerprint = async () =>
  (
    await db.admin.query(
      "select md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) h from ledger_lines t where store_id=$1",
      [db.store],
    )
  ).rows[0].h;
const status = async (p) =>
  (await admin.query("select public.read_product_archive_status($1,$2) r", [db.store, p.id]))
    .rows[0].r;

test("PG17.6 additive migration preserves every old function hash/ACL,table/RLS policy and all historical rows byte-for-byte", () => {
  const { prior, next } = conservation,
    oldIds = new Set(prior.functions.map((f) => f.id));
  assert.deepEqual(
    next.functions.filter((f) => oldIds.has(f.id)),
    prior.functions,
  );
  assert.equal(next.functions.length - prior.functions.length, 7);
  for (const key of ["tables", "policies", "data"]) assert.deepEqual(next[key], prior[key]);
});

test("PG17.6 new import/reader/archive APIs deny unauthorized roles,cross-tenant and anonymous access;private helpers remain inaccessible", async () => {
  const input = {
    product: { id: crypto.randomUUID(), name: "Denied", sku: "DENIED", quantity: 0 },
  };
  for (const role of [
    "ACCOUNTANT",
    "POS_ECOMMERCE",
    "ECOMMERCE_ONLY",
    "CASHIER_ONLY",
    "MODERATOR",
  ]) {
    if (!db.users[role]) {
      const uid = crypto.randomUUID();
      db.users[role] = uid;
      await db.admin.query("insert into auth.users values($1,$2,now())", [
        uid,
        role + "@qa.invalid",
      ]);
      await db.admin.query("insert into store_members(user_id,store_id,role) values($1,$2,$3)", [
        uid,
        db.store,
        role,
      ]);
    }
    await assert.rejects(
      (await db.client(role)).query("select record_product_import($1,$2,$3,'product_import',$4)", [
        crypto.randomUUID(),
        db.store,
        db.device,
        input,
      ]),
      /NEXUS_PRODUCT_IMPORT_FORBIDDEN/,
    );
  }
  await assert.rejects(
    admin.query("select record_product_import($1,$2,$3,'product_import',$4)", [
      crypto.randomUUID(),
      crypto.randomUUID(),
      db.device,
      input,
    ]),
    /NEXUS_PRODUCT_IMPORT_FORBIDDEN/,
  );
  const acl = (
    await db.admin.query(
      "select has_function_privilege('anon','public.record_product_import(text,uuid,uuid,text,jsonb)','EXECUTE') anon_import,has_function_privilege('anon','public.record_product_archive(text,uuid,uuid,text,jsonb)','EXECUTE') anon_archive,has_function_privilege('anon','public.read_product_archive_status(uuid,text)','EXECUTE') anon_reader,has_function_privilege('authenticated','financial_private.catalog_code(text)','EXECUTE') private_code",
    )
  ).rows[0];
  assert.ok(Object.values(acl).every((v) => v === false));
});

test("PG17.6 archive/restore preserve identity,variants,stock,value and immutable ledger; receipt replays do not undo newer restoration", async () => {
  assert.match(db.version, /PostgreSQL 17\.6/);
  const p = await create(),
    hash = await fingerprint(),
    id = crypto.randomUUID();
  const a = await archive(p, "archive", id);
  assert.ok(a.product.deleted_at);
  assert.equal(a.product.quantity, 3);
  assert.equal(a.eventId, null);
  assert.equal((await status(p)).hasHistory, true);
  assert.equal((await status(p)).canDelete, false);
  const restored = await archive(a.product, "restore");
  assert.equal(restored.product.deleted_at, null);
  assert.equal(restored.product.id, p.id);
  const replay = await archive(p, "archive", id);
  assert.equal(replay.replayed, true);
  assert.equal((await current(p.id)).deleted_at, null);
  assert.equal(await fingerprint(), hash);
});
test("PG17.6 archive has optimistic revision and unforgeable writer; direct stale full-row/upsert cannot touch quantities", async () => {
  const p = await create();
  await db.admin.query("update products set name=$1,updated_at=updated_at+1 where id=$2", [
    "Newer name",
    p.id,
  ]);
  await assert.rejects(archive(p), /NEXUS_PRODUCT_STALE/);
  await assert.rejects(
    admin.query("update products set deleted_at=1 where id=$1", [p.id]),
    /NEXUS_PRODUCT_ARCHIVE_COMMAND_REQUIRED/,
  );
  assert.equal((await current(p.id)).deleted_at, null);
  assert.equal((await current(p.id)).name, "Newer name");
});
test("PG17.6 pending/backorder commitment prevents archive and deletion with no journal or ledger partial commit", async () => {
  const p = await create(0),
    hash = await fingerprint(),
    op = crypto.randomUUID();
  await db.insert("orders", {
    id: crypto.randomUUID(),
    store_id: db.store,
    device_id: db.device,
    orderNumber: "QA-PENDING-" + p.id,
    customerName: "Synthetic",
    customerPhone: "01000000000",
    items: [{ productId: p.id, quantity: 5 }],
    stockItems: [],
    totalAmount: 0,
    status: "pending",
  });
  const d = await status(p);
  assert.equal(d.canArchive, false);
  assert.equal(d.canDelete, false);
  assert.equal(d.pendingOrders, 1);
  await assert.rejects(archive(p, "archive", op), /NEXUS_PRODUCT_HAS_PENDING_COMMITMENTS/);
  await assert.rejects(
    admin.query("delete from products where id=$1", [p.id]),
    /NEXUS_PRODUCT_HISTORY_REQUIRES_ARCHIVE/,
  );
  assert.equal(
    (
      await db.admin.query(
        "select count(*)::int n from financial_private.catalog_commands where id=$1",
        [op],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(await fingerprint(), hash);
});
test("PG17.6 active box dependency blocks component archive; archiving the box preserves its definition and permits later component archive", async () => {
  const p = await create();
  const box = await db.insert("products", {
    id: crypto.randomUUID(),
    store_id: db.store,
    device_id: db.device,
    name: "Synthetic box",
    sku: "BOX-" + p.id,
    isBundle: true,
    bundleItems: [{ productId: p.id, quantity: 1 }],
    quantity: 0,
    unitPrice: 5,
    updated_at: 1,
  });
  const b = (await db.admin.query("select * from products where sku=$1", ["BOX-" + p.id])).rows[0];
  assert.equal((await status(p)).bundleDependencies, 1);
  await assert.rejects(archive(p), /NEXUS_PRODUCT_USED_IN_ACTIVE_BUNDLE/);
  const archivedBox = await archive(b);
  const archivedPart = await archive(p);
  assert.deepEqual(archivedBox.product.bundleItems, b.bundleItems);
  await assert.rejects(archive(archivedBox.product, "restore"), /مكون البوكس غير متاح/);
  await archive(archivedPart.product, "restore");
  await archive(archivedBox.product, "restore");
});
test("PG17.6 historical zero-stock order references require archive rather than erasing invoice lookup", async () => {
  const p = await create(0);
  await db.insert("orders", {
    id: crypto.randomUUID(),
    store_id: db.store,
    device_id: db.device,
    orderNumber: "QA-HISTORY-" + p.id,
    customerName: "Synthetic",
    customerPhone: "01000000000",
    items: [{ productId: p.id, quantity: 1 }],
    totalAmount: 0,
    status: "delivered",
  });
  assert.equal((await status(p)).hasHistory, true);
  await archive(p);
  assert.ok(await current(p.id));
  await assert.rejects(
    admin.query("delete from products where id=$1", [p.id]),
    /NEXUS_PRODUCT_HISTORY_REQUIRES_ARCHIVE/,
  );
});
test("PG17.6 archive rollback after late trigger failure also removes the uncommitted replay receipt", async () => {
  const p = await create(),
    hash = await fingerprint(),
    op = crypto.randomUUID();
  await db.admin.query(
    `create function public.qa_archive_late() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_ARCHIVE_LATE';end$$;create trigger qa_archive_late after update of deleted_at on products for each row when(new.id='${p.id}') execute function public.qa_archive_late()`,
  );
  try {
    await assert.rejects(archive(p, "archive", op), /SYNTHETIC_ARCHIVE_LATE/);
    assert.equal((await current(p.id)).deleted_at, null);
    assert.equal(
      (
        await db.admin.query(
          "select count(*)::int n from financial_private.catalog_commands where id=$1",
          [op],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(await fingerprint(), hash);
  } finally {
    await db.admin.query(
      "drop trigger qa_archive_late on products;drop function public.qa_archive_late()",
    );
  }
  await archive(p, "archive", op);
});
test("PG17.6 archive role/tenant gates retain Accountant, deny actual Cashier/Online contexts and cross-store reads", async () => {
  const p = await create();
  await archive(p, "archive", crypto.randomUUID(), await db.client("ACCOUNTANT"));
  for (const role of ["POS_ECOMMERCE", "ECOMMERCE_ONLY"]) {
    const c = await db.client(role);
    await assert.rejects(
      archive(p, "restore", crypto.randomUUID(), c),
      /NEXUS_PRODUCT_ARCHIVE_FORBIDDEN/,
    );
    await assert.rejects(
      c.query("select read_product_archive_status($1,$2)", [db.store, p.id]),
      /NEXUS_PRODUCT_ARCHIVE_FORBIDDEN/,
    );
  }
  await assert.rejects(
    archive(p, "restore", crypto.randomUUID(), await db.client("CASHIER_ONLY")),
    /NEXUS_PRODUCT_ARCHIVE_FORBIDDEN/,
  );
  await assert.rejects(
    admin.query("select read_product_archive_status($1,$2)", [crypto.randomUUID(), p.id]),
    /NEXUS_PRODUCT_ARCHIVE_FORBIDDEN/,
  );
});
test("PG17.6 concurrent archive requests change no stock and produce a single physical lifecycle transition", async () => {
  const p = await create(),
    hash = await fingerprint(),
    c = await db.client("ADMIN");
  const results = await Promise.all([archive(p), archive(p, "archive", crypto.randomUUID(), c)]);
  assert.equal(results.filter((x) => !x.unchanged).length, 1);
  assert.equal(results.filter((x) => x.unchanged).length, 1);
  assert.equal(await fingerprint(), hash);
});

test("PG17.6 archive shares fulfillment serialization with a real POS transaction and refuses its now-stale revision", async () => {
  const p = await create(),
    c = await db.client("ADMIN");
  await c.query("begin");
  await c.query("select financial_private.fulfillment_lock($1)", [db.store]);
  let settled = false;
  const pending = archive(p)
    .then(
      (r) => ({ r }),
      (e) => ({ e }),
    )
    .finally(() => {
      settled = true;
    });
  try {
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(settled, false);
    const items = [{ productId: p.id, name: p.name, quantity: 1, unitPrice: 2.55, unitCost: 1.25 }];
    await c.query("select record_pos_sale($1,$2,$3,'pos_sale',$4)", [
      crypto.randomUUID(),
      db.store,
      db.device,
      {
        kind: "sale",
        refType: "pos_sale",
        payload: { walletId: "inStoreSafe", items },
        lines: buildSaleLines({ items, wallet: "inStoreSafe" }),
      },
    ]);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  }
  const result = await pending;
  assert.match(result.e?.message ?? "", /NEXUS_PRODUCT_STALE/);
  assert.equal((await current(p.id)).deleted_at, null);
  assert.equal(Number((await current(p.id)).quantity), 2);
});
test("PG17.6 archived product stays in historical POS invoice/refund;new sale denied,old refund restores exact original COGS and stock once", async () => {
  const p = await create(),
    item = { productId: p.id, name: p.name, quantity: 1, unitPrice: 2.55, unitCost: 1.25 };
  const pos = async (items, extra = {}, id = crypto.randomUUID()) =>
    (
      await admin.query("select record_pos_sale($1,$2,$3,'pos_sale',$4) r", [
        id,
        db.store,
        db.device,
        {
          kind: "sale",
          refType: "pos_sale",
          payload: { walletId: "inStoreSafe", items, ...extra },
          lines: buildSaleLines({ items, wallet: "inStoreSafe" }),
        },
      ])
    ).rows[0].r;
  const sale = await pos([item]);
  await archive(await current(p.id));
  await assert.rejects(pos([item]), /NEXUS_.*PRODUCT|منتج/i);
  const id = crypto.randomUUID();
  await pos([{ ...item, quantity: -1 }], { returnOfEventId: sale.eventId }, id);
  const hash = await fingerprint();
  await pos([{ ...item, quantity: -1 }], { returnOfEventId: sale.eventId }, id);
  assert.equal(await fingerprint(), hash);
  const doc = (await db.admin.query("select * from return_records where id=$1", ["return:" + id]))
    .rows[0];
  assert.equal(doc.original_order_id, sale.eventId);
  assert.equal(Number(doc.financial_difference), -2.55);
  assert.equal(doc.returned_items[0].product_id, p.id);
  const balance = (
    await db.admin.query(
      "select sum(qty_delta)::int units,sum(amount_delta)::int piastres from ledger_lines where store_id=$1 and subject_id=$2 and account='stock'",
      [db.store, p.id],
    )
  ).rows[0];
  assert.deepEqual(balance, { units: 3, piastres: 375 });
  assert.ok((await current(p.id)).deleted_at);
});
test("PG17.6 restoration refuses a reused active identifier without changing either product or the ledger", async () => {
  const p = await create(1),
    a = await archive(p),
    other = await create(2, 1.25, p.sku),
    hash = await fingerprint();
  await assert.rejects(archive(a.product, "restore"), /NEXUS_PRODUCT_RESTORE_CODE_CONFLICT/);
  assert.ok((await current(p.id)).deleted_at);
  assert.equal((await current(other.id)).deleted_at, null);
  assert.equal(await fingerprint(), hash);
});

async function importHarness() {
  const uid = crypto.randomUUID(),
    store = crypto.randomUUID();
  await db.admin.query("insert into auth.users values($1,$2,now())", [uid, uid + "@qa.invalid"]);
  const client = await db.client("ADMIN");
  await client.query("select set_config('request.jwt.claim.sub',$1,false)", [uid]);
  await db.admin.query("insert into stores(id,name) values($1,$2)", [
    store,
    "Dedicated synthetic scale context",
  ]);
  await db.admin.query(
    "insert into store_licenses(store_id,license_key,valid_until) values($1,$2,now()+interval '1 year')",
    [store, store],
  );
  await db.admin.query("insert into store_members(user_id,store_id,role) values($1,$2,'ADMIN')", [
    uid,
    store,
  ]);
  const state = { products: [] },
    auth = {
      userRole: "ADMIN",
      permissionsVerified: true,
      session: { user: { id: uid } },
      accessRevision: 1,
    };
  let h,
    lost = false,
    lostTriggered = false;
  let failSku = null;
  const sb = {
    rpc: async (name, p) => {
      try {
        assert.ok(
          ["record_product_import", "record_product_catalog", "record_product_archive"].includes(
            name,
          ),
        );
        const data = (
          await client.query(`select public.${name}($1,$2,$3,$4,$5) r`, [
            p.p_id,
            p.p_store,
            p.p_device,
            p.p_command,
            p.p_input,
          ])
        ).rows[0].r;
        if (name === "record_product_import" && lost && !lostTriggered) {
          lostTriggered = true;
          throw Object.assign(new Error("Synthetic lost response"), { transport: true });
        }
        return { data, error: null };
      } catch (e) {
        if (e.transport) throw e;
        return { data: null, error: { message: e.message, code: e.code } };
      }
    },
  };
  h = uiHarness({
    "@/lib/supabase": { getSupabaseClient: () => sb },
    "@/services/api/storeContext": {
      getSyncIdentity: async () => ({ storeId: store, deviceId: db.device }),
    },
    "@/store/useAuthStore": { useAuthStore: { getState: () => auth } },
    "@/store/useBusinessStore": {
      useBusinessStore: {
        getState: () => state,
        setState: (patch) =>
          Object.assign(state, typeof patch === "function" ? patch(state) : patch),
      },
    },
    "@/services/operationalSource": { captureReadAuthority: () => 1, assertReadAuthority() {} },
    "@/services/cloudData": {
      cloudList: async () =>
        (await client.query("select * from products where store_id=$1", [store])).rows.map((p) =>
          h.load("src/services/api/fieldMapping.ts").fromRemoteRow("products", p),
        ),
    },
  });
  const execute = h.load("src/lib/productImportCommand.ts").executeProductImport;
  return {
    h,
    store,
    state,
    run: (p, context = "owned") => execute(p, () => {}, store, context),
    loseOneResponse() {
      lost = true;
    },
    async totals() {
      return (
        await db.admin.query(
          "select (select count(*)::int from products where store_id=$1) products,(select count(*)::int from ledger_events where store_id=$1) events,(select coalesce(sum(qty_delta),0)::numeric from ledger_lines where store_id=$1 and account='stock') units,(select coalesce(sum(amount_delta),0)::int from ledger_lines where store_id=$1 and account='stock') piastres",
          [store],
        )
      ).rows[0];
    },
  };
}
const headers = [
  "SKU / كود المنتج",
  "اسم المنتج",
  "تكلفة الوحدة",
  "سعر البيع القطاعي",
  "الكمية",
  "الدرجات / الألوان والمقاسات (الاسم:الكمية)",
];
const rows = (start, count) =>
  Array.from({ length: count }, (_, j) => {
    const i = start + j,
      q = i % 3;
    return [
      "SCALE-" + String(i).padStart(4, "0"),
      "صنف " + i,
      (100 + (i % 5)) / 100,
      2.55,
      q,
      i % 7 === 0 ? "أحمر / M:" + q : "",
    ];
  });
test("PG17.6 actual controller/shared retry layer:200 opening+50 new=250; original200 byte-identical; same/reordered files add no stock", async () => {
  const f = await importHarness();
  try {
    const first = rows(1, 200),
      later = rows(201, 50);
    const r = await f.run(buildImportPlan([headers, ...first]), "opening");
    assert.equal(r.created, 200);
    const initial = (
      await db.admin.query(
        "select to_jsonb(p) row from products p where store_id=$1 order by sku",
        [f.store],
      )
    ).rows;
    const next = await f.run(buildImportPlan([headers, ...later]));
    assert.equal(next.created, 50);
    assert.equal((await f.totals()).products, 250);
    const original = (
      await db.admin.query(
        "select to_jsonb(p) row from products p where store_id=$1 and sku<='SCALE-0200' order by sku",
        [f.store],
      )
    ).rows;
    assert.deepEqual(original, initial);
    const expectedRows = [...first, ...later],
      units = expectedRows.reduce((s, r) => s + r[4], 0),
      piastres = expectedRows.reduce((s, r) => s + Math.round(r[2] * 100) * r[4], 0);
    const before = await f.totals();
    assert.equal(Number(before.units), units);
    assert.equal(before.piastres, piastres);
    assert.equal(before.events, expectedRows.filter((r) => r[4] > 0).length);
    const replay = await f.run(buildImportPlan([headers, ...later]));
    assert.equal(replay.created, 0);
    assert.equal(replay.recovered, 50);
    const reordered = await f.run(
      buildImportPlan([headers, ...later.toReversed().map((r) => [r[0], r[1], 999, 999, 999, ""])]),
    );
    assert.equal(reordered.created, 0);
    assert.equal(reordered.skipped, 50);
    assert.deepEqual(await f.totals(), before);
    const invalid = buildImportPlan([
      headers,
      first[0],
      ["NEW-MIXED", "new", 1, 2, 1, ""],
      ["BAD", "", 1, 2, 1, ""],
    ]);
    const rejected = await f.run(invalid);
    assert.equal(rejected.created, 0);
    assert.deepEqual(await f.totals(), before);
  } finally {
    await f.h.cleanup();
  }
});
test("PG17.6 actual transport loses one committed response:shared retry reuses identity and creates one stock event", async () => {
  const f = await importHarness();
  try {
    f.loseOneResponse();
    const r = await f.run(buildImportPlan([headers, ["LOST-RESPONSE", "صنف", 1.25, 2.55, 3, ""]]));
    assert.equal(r.created, 1);
    assert.deepEqual(await f.totals(), { products: 1, events: 1, units: "3", piastres: 375 });
  } finally {
    await f.h.cleanup();
  }
});
test("PG17.6 partial import late failure reports one acknowledgement;retry resumes and never recreates first stock/financial identity", async () => {
  const f = await importHarness();
  try {
    await db.admin.query(
      "create function public.qa_import_late_partial() returns trigger language plpgsql as $$begin if NEW.sku='PARTIAL-TWO' then raise exception 'SYNTHETIC_IMPORT_LATE';end if;return NEW;end$$;create trigger qa_import_late_partial after insert on products for each row execute function public.qa_import_late_partial()",
    );
    const plan = buildImportPlan([
      headers,
      ["PARTIAL-ONE", "أول", 1.25, 2.55, 3, ""],
      ["PARTIAL-TWO", "ثاني", 2, 3, 1, ""],
    ]);
    try {
      const r = await f.run(plan);
      assert.equal(r.created, 1);
      assert.equal(r.failedRow, 3);
      assert.ok(r.error);
      assert.deepEqual(await f.totals(), { products: 1, events: 1, units: "3", piastres: 375 });
    } finally {
      await db.admin.query(
        "drop trigger qa_import_late_partial on products;drop function public.qa_import_late_partial()",
      );
    }
    const resumed = await f.run(plan);
    assert.equal(resumed.created, 1);
    assert.equal(resumed.recovered, 1);
    assert.deepEqual(await f.totals(), { products: 2, events: 2, units: "4", piastres: 575 });
  } finally {
    await f.h.cleanup();
  }
});
test("PG17.6 new purchase is not silently capitalized;zero-stock import creates no inventory asset", async () => {
  const f = await importHarness();
  try {
    const blocked = await f.run(
      buildImportPlan([headers, ["PURCHASE", "صنف", 1, 2, 2, ""]]),
      "catalog",
    );
    assert.equal(blocked.created, 0);
    assert.match(blocked.error, /فاتورة/);
    assert.equal((await f.totals()).products, 0);
    const zero = await f.run(buildImportPlan([headers, ["ZERO", "صنف", 1, 2, 0, ""]]), "catalog");
    assert.equal(zero.created, 1);
    assert.deepEqual(await f.totals(), { products: 1, events: 0, units: "0", piastres: 0 });
  } finally {
    await f.h.cleanup();
  }
});
test("PG17.6 normalized code parity keeps leading zeros;server concurrent imports skip existing rows without overwriting quantities", async () => {
  for (const value of [
    "  ABC-٠٠١  ",
    "００１２３",
    "۰۰۰42",
    "00123",
    "v",
    "V42v",
    "\vABC\v",
    "\u2028A\u2029",
    "\u00a0X\u00a0",
  ])
    assert.equal(
      (await db.admin.query("select financial_private.catalog_code($1) v", [value])).rows[0].v,
      catalogCode(value),
    );
  const input = {
    product: {
      id: crypto.randomUUID(),
      name: "Concurrent",
      sku: "  CASE-٠٠١ ",
      barcode: "CASE-٠٠١",
      quantity: 3,
      unitPrice: 2,
      metadata: { variants: [] },
    },
    unitCost: 1.25,
    stockContext: "owned",
  };
  const c = await db.client("ADMIN"),
    run = (client, p) =>
      client.query("select record_product_import($1,$2,$3,'product_import',$4) r", [
        crypto.randomUUID(),
        db.store,
        db.device,
        p,
      ]);
  const r = await Promise.all([
    run(admin, input),
    run(c, {
      ...input,
      product: {
        ...input.product,
        id: crypto.randomUUID(),
        sku: "case-001",
        barcode: "case-001",
        quantity: 9,
      },
    }),
  ]);
  assert.equal(r.filter((x) => x.rows[0].r.skipped).length, 1);
  assert.equal(
    (
      await db.admin.query(
        "select count(*)::int n from products where store_id=$1 and financial_private.catalog_code(sku)='case-001'",
        [db.store],
      )
    ).rows[0].n,
    1,
  );
});
