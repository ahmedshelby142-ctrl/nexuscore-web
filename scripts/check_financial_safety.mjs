import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import pg from "pg";
import EmbeddedPostgres from "embedded-postgres";
import { buildPurchaseLines } from "../src/lib/ledger/purchases.ts";
const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
let server,
  admin,
  port,
  dir,
  ctl,
  clients = [];
const STORE = crypto.randomUUID(),
  USER = crypto.randomUUID(),
  MOD = crypto.randomUUID(),
  ACCOUNTANT = crypto.randomUUID(),
  DEVICE = crypto.randomUUID();
before(async () => {
  port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const testRoot = path.resolve("logs");
  fs.mkdirSync(testRoot, { recursive: true });
  dir = fs.mkdtempSync(path.join(testRoot, "financial-db-"));
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
      onLog: () => {},
      onError: () => {},
    });
    await server.initialise();
    await server.start();
  }
  for (let i = 0; i < 60; i++) {
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
      if (i === 59) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await admin.query(read("scripts/fixtures/financial-schema.sql"));
  // Use the real existing semantic validator, not a mock of the transaction.
  const migration = read("docs/migrations/049_owner_equity.sql");
  await admin.query(
    migration.match(
      /CREATE OR REPLACE FUNCTION public\.ledger_validate_event[\s\S]*?\$function\$;/,
    )[0],
  );
  await admin.query(read("supabase/migrations/20261005015827_financial_write_safety.sql"));
  await admin.query(
    "insert into store_members values ($1,$4,'ADMIN'),($2,$4,'MODERATOR'),($3,$4,'ACCOUNTANT')",
    [USER, MOD, ACCOUNTANT, STORE],
  );
});
after(async () => {
  for (const c of clients) await c.end();
  await admin?.end();
  if (ctl)
    spawnSync(ctl, ["-D", dir, "stop", "-m", "fast"], { windowsHide: true, stdio: "ignore" });
  else if (server) await server.stop();
});
async function client(user = USER) {
  const c = new pg.Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database: "postgres",
    password: "test-only",
  });
  await c.connect();
  clients.push(c);
  await c.query("set role authenticated");
  await c.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  return c;
}
async function invoke(c, command, input, id = crypto.randomUUID(), store = STORE) {
  return (
    await c.query("select record_financial_command($1,$2,$3,$4,$5) as result", [
      id,
      store,
      DEVICE,
      command,
      input,
    ])
  ).rows[0].result;
}
async function count(id) {
  return Number(
    (await admin.query("select count(*) as n from ledger_events where id=$1", [id])).rows[0].n,
  );
}
const draw = (kind = "owner_draw") => ({
  kind,
  refType: kind,
  refId: "owner",
  lines: [
    {
      account: kind === "owner_draw" ? "owner_budget" : "owner_equity",
      subjectId: "owner",
      amount: 100,
    },
    { account: "wallet", subjectId: "inStoreSafe", amount: kind === "owner_draw" ? -100 : 100 },
  ],
});
const receipt = (extra = {}) => ({
  supplierId: "__new__",
  newSupplierName: "fixture",
  wallet: "inStoreSafe",
  items: [{ productId: "fixture-product", productName: "Fixture", quantity: 5, unitCost: 20 }],
  paidAmount: 0,
  actor: "test",
  via: "test",
  ...extra,
});
test("ledger draw/capital/contribution: committed response lost, replay and changed-payload rejection", async () => {
  const c = await client();
  for (const kind of ["owner_draw", "owner_capital", "owner_contribution"]) {
    const id = crypto.randomUUID(),
      input = draw(kind);
    await invoke(c, "ledger", input, id);
    const replay = await invoke(c, "ledger", input, id);
    assert.equal(replay.replayed, true);
    assert.equal(await count(id), 1);
    await assert.rejects(
      invoke(c, "ledger", { ...input, actor: "changed" }, id),
      /PAYLOAD_MISMATCH/,
    );
    assert.equal(await count(id), 1);
  }
});
test("concurrent duplicate requests on independent DB connections commit once", async () => {
  const a = await client(),
    b = await client(),
    id = crypto.randomUUID();
  const results = await Promise.all([
    invoke(a, "ledger", draw(), id),
    invoke(b, "ledger", draw(), id),
  ]);
  assert.deepEqual(results.map((x) => x.replayed).sort(), [false, true]);
  assert.equal(await count(id), 1);
});
test("pre-commit validation failure has no effect; same identity can subsequently succeed", async () => {
  const c = await client(),
    id = crypto.randomUUID();
  await assert.rejects(invoke(c, "ledger", { ...draw(), lines: [] }, id));
  assert.equal(await count(id), 0);
  await invoke(c, "ledger", draw(), id);
  assert.equal(await count(id), 1);
});
test("receipt commits invoice + ledger + supplier once across response loss and concurrent replay", async () => {
  const a = await client(),
    b = await client(),
    id = crypto.randomUUID(),
    input = receipt({ paidAmount: 40 });
  const first = await invoke(a, "receipt", input, id);
  const again = await Promise.all([
    invoke(a, "receipt", input, id),
    invoke(b, "receipt", input, id),
  ]);
  assert.ok(again.every((x) => x.replayed));
  assert.equal(first.invoice.paidAmount, 40);
  assert.equal(first.invoice.remainingAmount, 60);
  assert.equal(await count(id), 1);
  assert.equal(
    Number(
      (await admin.query("select count(*) n from purchase_invoices where id=$1", [id])).rows[0].n,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        await admin.query(
          "select sum(amount_delta) n from ledger_lines where event_id=$1 and account='wallet'",
          [id],
        )
      ).rows[0].n,
    ),
    -4000,
  );
  await assert.rejects(invoke(a, "receipt", { ...input, paidAmount: 50 }, id), /PAYLOAD_MISMATCH/);
});
test("inner receipt failure rolls back invoice, supplier, counter and ledger; no compensation delete", async () => {
  const c = await client(),
    id = crypto.randomUUID();
  await assert.rejects(
    invoke(c, "receipt", receipt({ paidAmount: 10, wallet: "invalid-wallet" }), id),
  );
  assert.equal(await count(id), 0);
  assert.equal(
    Number(
      (await admin.query("select count(*) n from purchase_invoices where id=$1", [id])).rows[0].n,
    ),
    0,
  );
  assert.equal(
    Number((await admin.query("select count(*) n from suppliers where id=$1", [id])).rows[0].n),
    0,
  );
  assert.doesNotMatch(
    read("src/lib/receiving/commitReceipt.ts"),
    /removePurchaseInvoice|\.delete\(/,
  );
});
test("supplier partial, multi-invoice oldest due, excess, and replay preserve exact allocations", async () => {
  const c = await client();
  const first = await invoke(c, "receipt", receipt({ dueDate: "2026-01-01" }));
  const sid = first.supplier.id;
  const second = await invoke(
    c,
    "receipt",
    receipt({ supplierId: sid, newSupplierName: undefined, dueDate: "2026-02-01" }),
  );
  const id = crypto.randomUUID(),
    input = { supplierId: sid, wallet: "inStoreSafe", amount: 150 };
  const paid = await invoke(c, "supplier_payment", input, id);
  assert.deepEqual(
    paid.allocations.map((x) => [x.invoiceId, x.applied]),
    [
      [first.invoiceId, 100],
      [second.invoiceId, 50],
    ],
  );
  assert.equal((await invoke(c, "supplier_payment", input, id)).replayed, true);
  assert.equal(await count(id), 1);
  const excess = await invoke(c, "supplier_payment", { ...input, amount: 80 });
  assert.equal(excess.applied, 50);
  assert.equal(excess.unapplied, 30);
  const rows = (
    await admin.query(
      'select "paidAmount","remainingAmount" from purchase_invoices where "supplierId"=$1',
      [sid],
    )
  ).rows;
  assert.ok(rows.every((x) => Number(x.paidAmount) === 100 && Number(x.remainingAmount) === 0));
});
test("supplier inner ledger failure rolls back invoice allocations and payment", async () => {
  const c = await client();
  const r = await invoke(c, "receipt", receipt());
  const id = crypto.randomUUID();
  await assert.rejects(
    invoke(c, "supplier_payment", { supplierId: r.supplier.id, wallet: "invalid", amount: 25 }, id),
  );
  assert.equal(await count(id), 0);
  assert.equal(
    Number(
      (
        await admin.query('select "remainingAmount" from purchase_invoices where id=$1', [
          r.invoiceId,
        ])
      ).rows[0].remainingAmount,
    ),
    100,
  );
});
test("different concurrent payments serialize their invoice allocations", async () => {
  const a = await client(),
    b = await client();
  const r = await invoke(a, "receipt", receipt());
  const input = { supplierId: r.supplier.id, wallet: "inStoreSafe", amount: 75 };
  const results = await Promise.all([
    invoke(a, "supplier_payment", input),
    invoke(b, "supplier_payment", input),
  ]);
  assert.equal(
    results.reduce((n, x) => n + x.applied, 0),
    100,
  );
  assert.equal(
    results.reduce((n, x) => n + x.unapplied, 0),
    50,
  );
});
test("ADMIN allowed; MODERATOR and forged stores denied; ACCOUNTANT cannot contribute capital", async () => {
  const mod = await client(MOD),
    acct = await client(ACCOUNTANT),
    a = await client();
  for (const command of ["ledger", "receipt", "supplier_payment"])
    await assert.rejects(
      invoke(mod, command, command === "ledger" ? draw() : receipt()),
      /FORBIDDEN/,
    );
  await assert.rejects(
    invoke(a, "ledger", draw(), crypto.randomUUID(), crypto.randomUUID()),
    /FORBIDDEN/,
  );
  await assert.rejects(invoke(acct, "ledger", draw("owner_contribution")), /FORBIDDEN/);
  await invoke(acct, "ledger", draw());
});
test("opening stock/wallet commands replay and new empty financial events are rejected", async () => {
  const c = await client();
  for (const lines of [
    [{ account: "wallet", subjectId: "bankAccount", amount: 200 }],
    [{ account: "stock", subjectId: "fixture-product", qty: 2, amount: 100, unitCost: 50 }],
  ]) {
    const id = crypto.randomUUID(),
      input = { kind: "stock_adjustment", refType: "opening_balance", refId: "fixture", lines };
    await invoke(c, "ledger", input, id);
    assert.equal((await invoke(c, "ledger", input, id)).replayed, true);
    assert.equal(await count(id), 1);
  }
});

test("purchase cash/credit/partial lines retain existing builder amounts and ISO date filtering", async () => {
  const c = await client();
  for (const paidAmount of [0, 40, 100]) {
    const input = receipt({ paidAmount }),
      r = await invoke(c, "receipt", input);
    const expected = buildPurchaseLines({
      items: input.items,
      wallet: input.wallet,
      supplierId: r.supplier.id,
      paidAmount,
    }).map((l) => ({
      account: l.account,
      subject_id: l.subjectId,
      qty_delta: l.qty ?? 0,
      amount_delta: Math.round((l.amount ?? 0) * 100),
      unit_cost: l.unitCost === undefined ? null : Math.round(l.unitCost * 100),
    }));
    const actual = (
      await admin.query(
        "select account,subject_id,qty_delta,amount_delta,unit_cost from ledger_lines where event_id=$1",
        [r.eventId],
      )
    ).rows;
    const sort = (rows) => rows.sort((a, b) => a.account.localeCompare(b.account));
    assert.deepEqual(sort(actual), sort(expected));
    const event = (
      await admin.query("select created_at,occurred_at from ledger_events where id=$1", [r.eventId])
    ).rows[0];
    assert.match(event.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(event.occurred_at >= new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  }
});
