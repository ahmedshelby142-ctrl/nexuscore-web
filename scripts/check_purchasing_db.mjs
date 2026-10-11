// Real captured public DDL/RLS/grants/functions, synthetic rows, loopback only.
// auth.uid reads claims; this does not exercise JWT signing, GoTrue or PostgREST.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import pg from "pg";
import EmbeddedPostgres from "embedded-postgres";
import {
  buildSupplierReturnLines,
  resolveSupplierReturn,
  purchaseLineKey,
} from "../src/lib/ledger/purchases.ts";
const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const migration = "supabase/migrations/20261011051927_receipt_product_validation.sql";
const A = crypto.randomUUID(),
  B = crypto.randomUUID(),
  USER = crypto.randomUUID(),
  OTHER = crypto.randomUUID(),
  MOD = crypto.randomUUID(),
  ACCOUNTANT = crypto.randomUUID(),
  DEVICE = crypto.randomUUID();
let admin, port, dir, server, ctl, c;
const clients = [];
async function client(user = USER) {
  const db = new pg.Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database: "postgres",
    password: "test-only",
  });
  await db.connect();
  clients.push(db);
  await db.query("set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  return db;
}
async function insert(table, row) {
  const keys = Object.keys(row),
    q = (s) => '"' + s.replaceAll('"', '""') + '"';
  return admin.query(
    `insert into ${q(table)} (${keys.map(q)}) values (${keys.map((_, i) => "$" + (i + 1))})`,
    Object.values(row),
  );
}
const command = (input, id = crypto.randomUUID(), db = c, type = "receipt", store = A) =>
  db
    .query("select record_financial_command($1,$2,$3,$4,$5) result", [
      id,
      store,
      DEVICE,
      type,
      input,
    ])
    .then((r) => r.rows[0].result);
async function fixture() {
  const productId = crypto.randomUUID(),
    supplierId = crypto.randomUUID();
  await insert("products", {
    id: productId,
    store_id: A,
    device_id: DEVICE,
    name: "Synthetic cream",
    sku: productId,
    quantity: 0,
    unitPrice: 30,
  });
  await insert("suppliers", {
    id: supplierId,
    store_id: A,
    device_id: DEVICE,
    companyName: "Synthetic supplier",
    contactPerson: "",
    phone: "",
  });
  return { productId, supplierId };
}
const receipt = (f, paidAmount = 0, extra = {}) => ({
  supplierId: f.supplierId,
  wallet: "inStoreSafe",
  paidAmount,
  items: [
    {
      productId: f.productId,
      productName: "Cream",
      variantName: "Historical large",
      quantity: 2,
      unitCost: 10,
    },
  ],
  ...extra,
});
async function totals() {
  return (
    await admin.query(
      `select account,subject_id, sum(qty_delta)::text qty,sum(amount_delta)::text amount from ledger_lines where store_id=$1 group by account,subject_id order by account,subject_id`,
      [A],
    )
  ).rows;
}
async function snapshot() {
  const counts = (
    await admin.query(
      `select (select count(*) from suppliers) suppliers,(select count(*) from purchase_invoices) invoices,(select count(*) from ledger_events) events,(select count(*) from ledger_lines) lines,(select jsonb_agg(to_jsonb(c) order by store_id,name) from store_counters c) counters,(select jsonb_agg(to_jsonb(p) order by id) from products p) products`,
    )
  ).rows[0];
  return { counts, totals: await totals() };
}
async function lines(id) {
  return (
    await admin.query(
      "select account,subject_id,qty_delta::float8 qty,amount_delta::float8 amount from ledger_lines where event_id=$1 order by account",
      [id],
    )
  ).rows;
}
before(async () => {
  port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  fs.mkdirSync("logs/purchasing-repair", { recursive: true });
  dir = fs.mkdtempSync(path.resolve("logs/purchasing-repair/pg-"));
  if (process.platform === "win32") {
    const bins = await import("@embedded-postgres/windows-x64");
    ctl = bins.pg_ctl;
    const init = spawnSync(
      bins.initdb,
      ["-D", dir, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C"],
      { windowsHide: true, encoding: "utf8" },
    );
    assert.equal(init.status, 0, init.stderr);
    server = spawn(bins.postgres, ["-D", dir, "-p", String(port), "-h", "127.0.0.1"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    server = new EmbeddedPostgres({
      databaseDir: dir,
      port,
      user: "postgres",
      password: "test-only",
      persistent: true,
      onLog() {},
      onError() {},
    });
    await server.initialise();
    await server.start();
  }
  for (let i = 0; i < 80; i++) {
    admin = new pg.Client({
      host: "127.0.0.1",
      port,
      user: "postgres",
      database: "postgres",
      password: "test-only",
    });
    try {
      await admin.connect();
      break;
    } catch (e) {
      await admin.end().catch(() => {});
      if (i === 79) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await admin.query(read("scripts/fixtures/purchasing-public-schema.sql"));
  await admin.query(read("supabase/migrations/20261010183049_wholesale_feature_toggle.sql"));
  for (const user of [USER, OTHER, MOD, ACCOUNTANT])
    await admin.query("insert into auth.users values($1,$2,now())", [user, user + "@qa.invalid"]);
  for (const store of [A, B]) {
    await admin.query("insert into stores(id,name) values($1,$2)", [store, "Synthetic QA"]);
    await admin.query(
      "insert into store_licenses(store_id,license_key,valid_until) values($1,$2,now()+interval '1 year')",
      [store, store],
    );
  }
  for (const [user, store, role] of [
    [USER, A, "ADMIN"],
    [OTHER, B, "ADMIN"],
    [MOD, A, "MODERATOR"],
    [ACCOUNTANT, A, "ACCOUNTANT"],
  ])
    await admin.query("insert into store_members(user_id,store_id,role) values($1,$2,$3)", [
      user,
      store,
      role,
    ]);
  c = await client();
  // Reproduce the exact pre-repair vulnerability, then roll back the probe.
  const f = await fixture();
  await c.query("begin");
  const beforeFix = await command(receipt({ ...f, productId: "missing-baseline" }));
  assert.equal(beforeFix.invoice.items[0].productId, "missing-baseline");
  await c.query("rollback");
  await admin.query(read(migration));
  fs.writeFileSync(
    "logs/purchasing-repair/db-environment.json",
    JSON.stringify(
      {
        source: "440d8ed public catalog, no production rows",
        localVersion: (await admin.query("select version()")).rows[0].version,
        productionVersion: "17.6",
        baselineUnknownProductAccepted: true,
        baselineProbeRolledBack: true,
        migration,
        host: "127.0.0.1",
        limitations: [
          "JWT signing/GoTrue/PostgREST not exercised",
          "PostgreSQL major version differs",
          "No deployed UI acceptance",
        ],
      },
      null,
      2,
    ),
  );
});
after(async () => {
  await Promise.allSettled(clients.map((db) => db.end()));
  await admin?.end();
  if (ctl)
    spawnSync(ctl, ["-D", dir, "stop", "-m", "fast"], { windowsHide: true, stdio: "ignore" });
  else if (server?.stop) await server.stop();
});
test("PUR-DB-new-supplier: legitimate creation and receipt remain atomic", async () => {
  const f = await fixture(),
    id = crypto.randomUUID();
  const r = await command(
    receipt(f, 5, {
      supplierId: "__new__",
      newSupplierName: "New synthetic supplier",
      newSupplierPhone: "01000000000",
    }),
    id,
  );
  assert.equal(r.supplier.id, id);
  assert.equal(r.invoice.supplierId, id);
  assert.equal(r.supplier.companyName, "New synthetic supplier");
  assert.equal((await lines(id)).find((l) => l.account === "payable_supplier").amount, 1500);
});
test("PUR-DB-late-rejection: invalid financial line rolls back invoice, new supplier, counter and all balances", async () => {
  const f = await fixture(),
    old = await snapshot();
  await assert.rejects(
    command(
      receipt(f, 20, { supplierId: "__new__", newSupplierName: "Rollback supplier", wallet: null }),
    ),
  );
  assert.deepEqual(await snapshot(), old);
});
test("PUR-DB-reference-lock: archiving waits until validated receipt commits", async () => {
  const f = await fixture(),
    d = await client();
  await c.query("begin");
  try {
    await command(receipt(f));
    await d.query("set lock_timeout='150ms'");
    await assert.rejects(
      d.query("update products set deleted_at=1 where id=$1", [f.productId]),
      (e) => e.code === "55P03",
    );
    await c.query("commit");
    await d.query("update products set deleted_at=1 where id=$1", [f.productId]);
  } finally {
    await c.query("rollback");
  }
});
for (const [name, paid] of [
  ["cash", 20],
  ["partial", 5],
  ["credit", 0],
])
  test(`PUR-DB-${name}: valid receipt exact stock/wallet/debt and persisted variant`, async () => {
    const f = await fixture(),
      r = await command(receipt(f, paid));
    assert.equal(r.invoice.totalAmount, 20);
    assert.equal(r.invoice.remainingAmount, 20 - paid);
    assert.equal(r.invoice.items[0].variantName, "Historical large");
    const l = await lines(r.eventId);
    assert.deepEqual(
      l.filter((x) => x.account === "stock"),
      [{ account: "stock", subject_id: f.productId, qty: 2, amount: 2000 }],
    );
    assert.equal(l.find((x) => x.account === "wallet")?.amount ?? 0, paid ? -paid * 100 : 0);
    assert.equal(l.find((x) => x.account === "payable_supplier")?.amount ?? 0, (20 - paid) * 100);
    assert.equal(
      l.some((x) => ["revenue", "cogs"].includes(x.account)),
      false,
    );
  });
for (const kind of ["unknown", "foreign", "mixed", "archived", "new-supplier-invalid"])
  test(`PUR-DB-reject-${kind}: full rollback including counters and supplier creation`, async () => {
    const f = await fixture();
    let bad = "missing-" + crypto.randomUUID();
    if (kind === "foreign") {
      bad = crypto.randomUUID();
      await insert("products", {
        id: bad,
        store_id: B,
        device_id: DEVICE,
        name: "Foreign",
        sku: bad,
        quantity: 0,
        unitPrice: 20,
      });
    }
    if (kind === "archived") {
      bad = f.productId;
      await admin.query("update products set deleted_at=1 where id=$1", [bad]);
    }
    let input = receipt({ ...f, productId: bad });
    if (kind === "mixed") input.items.unshift(receipt(f).items[0]);
    if (kind === "new-supplier-invalid")
      input = { ...input, supplierId: "__new__", newSupplierName: "Must not persist" };
    const old = await snapshot();
    await assert.rejects(
      command(input),
      (e) => e.code === "23514" && e.message.includes("NEXUS_RECEIPT_PRODUCT_INVALID"),
    );
    assert.deepEqual(await snapshot(), old);
  });
test("PUR-DB-settlement: partial then full, oldest applicable invoice first and exact ledger effects", async () => {
  const f = await fixture();
  const later = await command(receipt(f, 0, { dueDate: "2026-02-01" }));
  const older = await command(receipt(f, 5, { dueDate: "2026-01-01" }));
  const p = await command(
    { supplierId: f.supplierId, wallet: "inStoreSafe", amount: 10 },
    undefined,
    c,
    "supplier_payment",
  );
  assert.deepEqual(
    p.allocations.map((x) => [x.invoiceId, x.applied]),
    [[older.invoiceId, 10]],
  );
  const full = await command(
    { supplierId: f.supplierId, wallet: "inStoreSafe", amount: 25 },
    undefined,
    c,
    "supplier_payment",
  );
  assert.deepEqual(
    full.allocations.map((x) => [x.invoiceId, x.applied]),
    [
      [older.invoiceId, 5],
      [later.invoiceId, 20],
    ],
  );
  assert.deepEqual(
    (await lines(full.eventId)).map((x) => [x.account, x.amount]),
    [
      ["payable_supplier", -2500],
      ["wallet", -2500],
    ],
  );
  assert.equal(
    (
      await admin.query(
        'select sum("remainingAmount")::float8 amount from purchase_invoices where "supplierId"=$1',
        [f.supplierId],
      )
    ).rows[0].amount,
    0,
  );
});
test("PUR-DB-retry: stable identity, archived historical replay, changed payload rejected", async () => {
  const f = await fixture(),
    input = receipt(f, 5),
    id = crypto.randomUUID(),
    r = await command(input, id);
  await admin.query("update products set deleted_at=1 where id=$1", [f.productId]);
  const old = await snapshot(),
    replay = await command(input, id);
  assert.equal(replay.replayed, true);
  assert.equal(replay.invoiceNumber, r.invoiceNumber);
  await assert.rejects(
    command({ ...input, paidAmount: 6 }, id),
    /NEXUS_OPERATION_PAYLOAD_MISMATCH/,
  );
  assert.deepEqual(await snapshot(), old);
});
test("PUR-DB-concurrent: distinct numbers and exactly once same-operation retry", async () => {
  const f = await fixture(),
    d = await client(),
    input = receipt(f),
    id = crypto.randomUUID();
  const results = await Promise.all([command(input, id, c), command(input, id, d)]);
  assert.deepEqual(results.map((r) => r.replayed).sort(), [false, true]);
  const distinct = await Promise.all([command(input, undefined, c), command(input, undefined, d)]);
  assert.notEqual(distinct[0].invoiceNumber, distinct[1].invoiceNumber);
  const balances = await totals();
  assert.deepEqual(
    balances.find((l) => l.account === "stock" && l.subject_id === f.productId),
    { account: "stock", subject_id: f.productId, qty: "6", amount: "6000" },
  );
  assert.equal(
    balances.find((l) => l.account === "payable_supplier" && l.subject_id === f.supplierId).amount,
    "6000",
  );
  assert.equal(
    (
      await admin.query('select count(*) from purchase_invoices where "supplierId"=$1', [
        f.supplierId,
      ])
    ).rows[0].count,
    "3",
  );
});
test("PUR-DB-return: persisted original cost survives different later purchase price", async () => {
  const f = await fixture(),
    r = await command(receipt(f));
  await command(receipt(f, 0, { items: [{ productId: f.productId, quantity: 2, unitCost: 30 }] }));
  const resolved = resolveSupplierReturn({
    supplierId: f.supplierId,
    invoices: [r.invoice],
    requests: [
      { invoiceId: r.invoiceId, lineKey: purchaseLineKey(r.invoice.items[0]), quantity: 1 },
    ],
    onHand: () => 4,
  });
  assert.equal(resolved.returnValue, 10);
  assert.equal(resolved.lines[0].variantName, "Historical large");
  const ls = buildSupplierReturnLines({
    resolved,
    wallet: "inStoreSafe",
    currentDebt: 80,
    paidNow: 0,
  });
  const id = crypto.randomUUID(),
    event = {
      id,
      store_id: A,
      device_id: DEVICE,
      kind: "purchase",
      ref_type: "supplier_return",
      ref_id: r.invoiceNumber,
      occurred_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      payload: "{}",
      lines: ls.map((l) => ({
        id: crypto.randomUUID(),
        account: l.account,
        subject_id: l.subjectId,
        qty_delta: l.qty ?? 0,
        amount_delta: Math.round(l.amount * 100),
        unit_cost: l.unitCost == null ? null : Math.round(l.unitCost * 100),
      })),
    };
  await c.query("select ledger_append($1)", [event]);
  const balances = await totals();
  assert.deepEqual(
    balances.find((l) => l.account === "stock" && l.subject_id === f.productId),
    { account: "stock", subject_id: f.productId, qty: "3", amount: "7000" },
  );
  assert.equal(
    balances.find((l) => l.account === "payable_supplier" && l.subject_id === f.supplierId).amount,
    "7000",
  );
  assert.deepEqual(
    (await lines(id)).map((x) => [x.account, x.qty, x.amount]),
    [
      ["payable_supplier", 0, -1000],
      ["stock", -1, -1000],
    ],
  );
});
test("PUR-DB-permissions: foreign tenant and moderator denied, accountant accepted; invoker/RLS intact", async () => {
  const f = await fixture(),
    old = await snapshot();
  for (const user of [OTHER, MOD])
    await assert.rejects(
      command(receipt(f), undefined, await client(user)),
      (e) => e.code === "42501",
    );
  assert.deepEqual(await snapshot(), old);
  await command(receipt(f), undefined, await client(ACCOUNTANT));
  assert.equal(
    (await admin.query("select prosecdef from pg_proc where proname='record_financial_command'"))
      .rows[0].prosecdef,
    false,
  );
  assert.equal(
    (await admin.query("select wholesale_enabled from stores where id=$1", [A])).rows[0]
      .wholesale_enabled,
    false,
  );
});
