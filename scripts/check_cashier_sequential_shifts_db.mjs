// Actual captured-schema PostgreSQL17.6, loopback disposable DB only. No cloud credentials.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openBusinessDb, read, ROOT } from "./helpers/business-db.mjs";
import { buildSaleLines } from "../src/lib/ledger/sales.ts";
import { uiHarness } from "./helpers/ui-harness.mjs";
const migration = "20261019135331_cashier_sequential_shifts.sql";
let db, admin, cashier, other, moderator, combined, seeded;
const evidence = [];
const q = async (c, name, args) =>
  (await c.query(`select public.${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) r`, args))
    .rows[0].r;
const snap = (f, c = cashier) => q(c, "cashier_shift_snapshot", [f.store]);
const raw = (f, c, input, id = crypto.randomUUID()) =>
  q(c, "record_cashier_shift", [id, f.store, f.device, "cashier_shift", input]);
async function act(f, c, action, extra = {}, id) {
  const s = await snap(f, c === other ? admin : c);
  const r = await raw(
    f,
    c,
    {
      action,
      ...(action === "open" || action === "configure"
        ? { expectedPolicyRevision: s.policy?.revision ?? 0 }
        : { shiftId: s.shift?.id, expectedRevision: s.shift?.revision }),
      ...(action === "open"
        ? { floatReceived: true, expectedPreviousShiftId: s.policy?.previous_shift_id ?? null }
        : {}),
      ...extra,
    },
    id,
  );
  assert.notEqual(r.rejected, true, JSON.stringify(r));
  return r;
}
async function fixture({ opening = 200000, keep = 50000 } = {}) {
  const f = { store: crypto.randomUUID(), device: crypto.randomUUID() };
  f.users = {};
  for (const [role, c] of [
    ["ADMIN", admin],
    ["CASHIER_ONLY", cashier],
    ["OTHER", other],
    ["MODERATOR", moderator],
    ["POS_ECOMMERCE", combined],
  ]) {
    db.users[role] = f.users[role] = crypto.randomUUID();
    await db.admin.query("insert into auth.users values($1,$2,now())", [
      f.users[role],
      f.users[role] + "@synthetic.invalid",
    ]);
    await c.query("select set_config('request.jwt.claim.sub',$1,false)", [f.users[role]]);
  }
  await db.insert("stores", { id: f.store, name: "Synthetic sequential drawer" });
  await db.insert("store_licenses", {
    store_id: f.store,
    license_key: f.store,
    valid_until: new Date(Date.now() + 86400000).toISOString(),
  });
  for (const role of ["ADMIN", "CASHIER_ONLY", "OTHER", "MODERATOR", "POS_ECOMMERCE"])
    await db.insert("store_members", {
      store_id: f.store,
      user_id: db.users[role],
      role: role === "OTHER" ? "CASHIER_ONLY" : role,
    });
  await q(admin, "ledger_append", [
    {
      ...db.event("stock_adjustment", "opening_balance", "synthetic", [
        { account: "wallet", subjectId: "inStoreSafe", amount: 5000 },
      ]),
      store_id: f.store,
      device_id: f.device,
    },
  ]);
  await act(f, admin, "configure", {
    cashierId: db.users.CASHIER_ONLY,
    openingPiastres: opening,
    keepPiastres: keep,
    enabled: true,
  });
  return f;
}
async function finish(f, actual) {
  const id = (await snap(f)).shift.id;
  await act(f, cashier, "close", { actualPiastres: actual, countConfirmed: true });
  await act(f, cashier, "report_handover", { physicalHandoverConfirmed: true });
  await act(f, admin, "confirm_handover", { cashReceivedConfirmed: true });
  return (
    await db.admin.query(
      "select to_jsonb(s) r from financial_private.cashier_shifts s where id=$1",
      [id],
    )
  ).rows[0].r;
}
const money = async (f) =>
  (
    await db.admin.query(
      "select account,subject_id,sum(amount_delta)::bigint n from ledger_lines where store_id=$1 group by 1,2 order by 1,2",
      [f.store],
    )
  ).rows;
const closedRow = async (id) =>
  (
    await db.admin.query(
      "select to_jsonb(s) r from financial_private.cashier_shifts s where id=$1",
      [id],
    )
  ).rows[0].r;
async function spend(f, amount = 15000, note = "تغليف وفطار — إيصال 12") {
  return act(f, cashier, "expense", { category: "office_supplies", amountPiastres: amount, note });
}
async function sell(f, amount = 1000, wallet = "inStoreSafe") {
  const product = crypto.randomUUID();
  await q(admin, "record_product_catalog", [
    crypto.randomUUID(),
    f.store,
    f.device,
    "product_catalog",
    {
      action: "create",
      unitCost: 1,
      product: {
        id: product,
        name: "Synthetic shift item",
        sku: product,
        quantity: 2,
        unitPrice: amount,
        metadata: { variants: [] },
      },
    },
  ]);
  const items = [
    {
      productId: product,
      productName: "Synthetic shift item",
      unitPrice: amount,
      unitCost: 0,
      quantity: 1,
    },
  ];
  return q(cashier, "record_pos_sale", [
    crypto.randomUUID(),
    f.store,
    f.device,
    "pos_sale",
    {
      kind: "sale",
      refType: "pos_sale",
      actor: "POS",
      payload: { walletId: wallet, channel: "pos", items },
      lines: buildSaleLines({ items, wallet }),
    },
  ]);
}
async function history(f, id, c = cashier) {
  const role =
    c === admin
      ? "ADMIN"
      : c === cashier
        ? "CASHIER_ONLY"
        : c === other
          ? "OTHER"
          : c === moderator
            ? "MODERATOR"
            : "POS_ECOMMERCE";
  await c.query("select set_config('request.jwt.claim.sub',$1,false)", [f.users[role]]);
  return q(c, "read_cashier_shift_history", [f.store, id]);
}
before(async () => {
  db = await openBusinessDb();
  assert.match(db.version, /PostgreSQL 17\.6/);
  for (const file of fs
    .readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter((f) => f >= "20261012000000" && f < migration)
    .sort())
    await db.admin.query(read("supabase/migrations/" + file));
  for (const role of ["CASHIER_ONLY", "OTHER", "MODERATOR"]) {
    db.users[role] = crypto.randomUUID();
    await db.admin.query("insert into auth.users values($1,$2,now())", [
      db.users[role],
      role + "@synthetic.invalid",
    ]);
  }
  admin = await db.client("ADMIN");
  cashier = await db.client("CASHIER_ONLY");
  other = await db.client("OTHER");
  moderator = await db.client("MODERATOR");
  combined = await db.client("POS_ECOMMERCE");
  seeded = await fixture({ opening: 50000, keep: 20000 });
  await act(seeded, cashier, "open");
  await spend(seeded, 500);
  seeded.row = await finish(seeded, 49500);
});
after(async () => {
  if (db) {
    fs.writeFileSync(
      path.join(ROOT, "logs/final-v1-sprint/sequential-shifts-" + Date.now() + ".json"),
      JSON.stringify(
        { scope: "LOCAL ONLY", postgres: db.version, dataDir: db.dataDir, evidence },
        null,
        2,
      ),
    );
    await db.close();
  }
});

test("new migration rollback/commit preserve seeded closed shift, expense/ledger, RLS, ACL and all unrelated function bodies", async () => {
  const defs = (
    await db.admin.query(
      "select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) def,p.proacl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','financial_private') and p.prokind='f'",
    )
  ).rows;
  const policies = (
    await db.admin.query("select * from pg_policies order by schemaname,tablename,policyname")
  ).rows;
  const before = await money(seeded);
  await db.admin.query("begin");
  await db.admin.query(read("supabase/migrations/" + migration));
  await db.admin.query("rollback");
  assert.ok(
    (
      await db.admin.query(
        "select 1 from pg_constraint where conrelid='financial_private.cashier_shifts'::regclass and conname='cashier_shifts_store_id_shift_day_key'",
      )
    ).rowCount,
  );
  assert.equal(
    (
      await db.admin.query(
        "select to_regprocedure('public.read_cashier_shift_history(uuid,uuid)') r",
      )
    ).rows[0].r,
    null,
  );
  await db.admin.query(read("supabase/migrations/" + migration));
  assert.deepEqual(await closedRow(seeded.row.id), seeded.row);
  assert.deepEqual(await money(seeded), before);
  assert.deepEqual(
    (await db.admin.query("select * from pg_policies order by schemaname,tablename,policyname"))
      .rows,
    policies,
  );
  for (const d of defs) {
    const now = (
      await db.admin.query(
        "select pg_get_functiondef(p.oid) def,p.proacl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname=$2 and pg_get_function_identity_arguments(p.oid)=$3",
        [d.nspname, d.proname, d.args],
      )
    ).rows[0];
    assert.deepEqual(now.proacl, d.proacl, d.proname);
    if (!["record_cashier_shift", "cashier_shift_snapshot"].includes(d.proname))
      assert.equal(now.def, d.def, d.proname);
  }
  assert.equal(
    (
      await db.admin.query(
        "select count(*)::int n from pg_index where indexrelid='financial_private.cashier_shift_one_active'::regclass and indisunique",
      )
    ).rows[0].n,
    1,
  );
  evidence.push({
    case: "migration preservation",
    seededClosedShift: seeded.row.id,
    unrelatedFunctions: defs.length - 2,
    financialRowsUnchanged: true,
    rlsUnchanged: true,
    atomicRollback: true,
  });
});
test("2000 opening +1000 cash sale -150 expense =2850; handover2350/retain500; second SAME-DAY shift has separate UUID and no duplicated cash", async () => {
  const f = await fixture();
  const first = await act(f, cashier, "open");
  await sell(f);
  await spend(f);
  const live = (await snap(f)).shift;
  assert.equal(live.live_expected_piastre, 285000);
  assert.equal(live.cash_expenses_piastre, 15000);
  const old = await finish(f, 285000);
  assert.equal(old.handover_piastre, 235000);
  assert.equal(old.retained_piastre, 50000);
  await act(f, admin, "configure", {
    cashierId: db.users.CASHIER_ONLY,
    openingPiastres: 50000,
    keepPiastres: 50000,
    enabled: true,
  });
  const before = await money(f),
    second = await act(f, cashier, "open");
  assert.notEqual(second.shiftId, first.shiftId);
  const next = (await snap(f)).shift;
  assert.equal(next.shift_day, old.shift_day);
  assert.equal(next.opening_piastre, 50000);
  assert.equal(next.carry_in_piastre, 50000);
  assert.equal(next.float_adjustment_piastre, 0);
  assert.equal(next.cash_expenses_piastre, 0);
  assert.equal(next.movements.length, 0);
  await spend(f, 1, "تغليف — قرش واحد");
  await finish(f, 49999);
  assert.deepEqual(await closedRow(old.id), old);
  const rows = await money(f);
  assert.equal(
    Number(rows.find((x) => x.account === "wallet" && x.subject_id === "inStoreSafe").n),
    Number(before.find((x) => x.account === "wallet" && x.subject_id === "inStoreSafe").n) - 1,
  );
  const hs = (await snap(f, admin)).history;
  assert.equal(hs.length, 2);
  assert.equal(hs[0].id, second.shiftId);
  assert.ok(hs[0].opened_at);
  assert.ok(hs[0].closed_at);
  const detail = await history(f, first.shiftId);
  assert.equal(detail.shift.cash_expenses_piastre, 15000);
  assert.ok(detail.shift.movements.some((x) => x.expense_description === "تغليف وفطار — إيصال 12"));
  evidence.push({
    case: "exact illustrative acceptance",
    store: f.store,
    first: first.shiftId,
    second: second.shiftId,
    opening: 200000,
    cashSale: 100000,
    expense: 15000,
    expected: 285000,
    handover: 235000,
    retained: 50000,
    secondOpening: 50000,
    firstUnchanged: true,
  });
});
test("old same-request open replay remains old identity even after close and later shift; delayed DIFFERENT request cannot start another shift", async () => {
  const f = await fixture({ opening: 50000, keep: 50000 });
  const s = await snap(f),
    id = crypto.randomUUID();
  const input = {
    action: "open",
    expectedPolicyRevision: s.policy.revision,
    floatReceived: true,
    expectedPreviousShiftId: null,
  };
  const first = await raw(f, cashier, input, id);
  await finish(f, 50000);
  const late = await raw(f, cashier, input);
  assert.equal(late.code, "NEXUS_SHIFT_STATE_CHANGED");
  assert.equal(late.rejected, true);
  const second = await act(f, cashier, "open");
  const replay = await raw(f, cashier, input, id);
  assert.equal(replay.shiftId, first.shiftId);
  assert.equal(replay.replayed, true);
  assert.notEqual(first.shiftId, second.shiftId);
  assert.equal((await snap(f)).history.length, 2);
  await assert.rejects(
    () => raw(f, cashier, { ...input, floatReceived: false }, id),
    /PAYLOAD_MISMATCH/,
  );
});
test("old-client missing predecessor pin is durably rejected, no financial write; refresh gives supported flag and correct prior identity", async () => {
  const f = await fixture(),
    s = await snap(f),
    before = await money(f),
    id = crypto.randomUUID();
  const input = { action: "open", expectedPolicyRevision: s.policy.revision, floatReceived: true };
  const r = await raw(f, cashier, input, id);
  assert.equal(r.code, "NEXUS_SHIFT_OPEN_SNAPSHOT_REQUIRED");
  assert.equal((await raw(f, cashier, input, id)).replayed, true);
  assert.deepEqual(await money(f), before);
  assert.equal((await snap(f)).shift, null);
  assert.equal(s.sequential_opening, true);
  assert.equal(s.policy.previous_shift_id, null);
});
test("simultaneous different open IDs permit one active drawer; simultaneous SAME-ID retry creates exactly one shift/audit", async () => {
  for (const sameId of [false, true]) {
    const f = await fixture({ opening: 50000, keep: 50000 });
    await act(f, cashier, "open");
    await finish(f, 50000);
    const a = await db.client("CASHIER_ONLY"),
      b = await db.client("CASHIER_ONLY"),
      s = await snap(f),
      id = crypto.randomUUID();
    const input = {
      action: "open",
      expectedPolicyRevision: s.policy.revision,
      floatReceived: true,
      expectedPreviousShiftId: s.policy.previous_shift_id,
    };
    const results = await Promise.all([
      raw(f, a, input, id),
      raw(f, b, input, sameId ? id : crypto.randomUUID()),
    ]);
    assert.equal(results.filter((r) => !r.rejected && !r.replayed).length, 1);
    assert.equal(results.filter((r) => r.replayed === true).length, sameId ? 1 : 0);
    if (!sameId) assert.equal(results.find((r) => r.rejected).code, "NEXUS_SHIFT_DUPLICATE");
    const count = (
      await db.admin.query(
        "select count(*)::int n from financial_private.cashier_shifts where store_id=$1 and status<>'closed'",
        [f.store],
      )
    ).rows[0].n;
    assert.equal(count, 1);
    assert.equal((await snap(f)).history.length, 2);
    await a.end();
    await b.end();
  }
});
test("handover pending/manager receipt pending cannot be bypassed by opening; closed row cannot be reopened", async () => {
  const f = await fixture({ opening: 50000, keep: 50000 });
  await act(f, cashier, "open");
  await act(f, cashier, "close", { actualPiastres: 50000, countConfirmed: true });
  let s = await snap(f);
  const input = {
    action: "open",
    floatReceived: true,
    expectedPolicyRevision: s.policy.revision,
    expectedPreviousShiftId: null,
  };
  assert.equal((await raw(f, cashier, input)).code, "NEXUS_SHIFT_DUPLICATE");
  await act(f, cashier, "report_handover", { physicalHandoverConfirmed: true });
  assert.equal((await raw(f, cashier, input)).code, "NEXUS_SHIFT_DUPLICATE");
  await act(f, admin, "confirm_handover", { cashReceivedConfirmed: true });
  s = await snap(f);
  const old = await closedRow(s.shift.id);
  const reopen = await raw(f, admin, {
    action: "reopen",
    shiftId: s.shift.id,
    expectedRevision: s.shift.revision,
    reason: "Must not edit a closed shift",
  });
  assert.equal(reopen.code, "NEXUS_SHIFT_STATE_INVALID");
  assert.deepEqual(await closedRow(old.id), old);
  await act(f, cashier, "open");
});
test("retained amount only is carried; different opening policy requires an explicit physical adjustment even on the same date", async () => {
  for (const target of [20000, 70000]) {
    const f = await fixture({ opening: 50000, keep: 50000 });
    await act(f, cashier, "open");
    await finish(f, 50000);
    await act(f, admin, "configure", {
      cashierId: db.users.CASHIER_ONLY,
      openingPiastres: target,
      keepPiastres: target,
      enabled: true,
    });
    const s = await snap(f),
      before = await money(f);
    const i = {
      action: "open",
      floatReceived: true,
      expectedPolicyRevision: s.policy.revision,
      expectedPreviousShiftId: s.policy.previous_shift_id,
    };
    assert.equal((await raw(f, cashier, i)).code, "NEXUS_SHIFT_FLOAT_TRANSFER_CONFIRM_REQUIRED");
    await raw(f, cashier, { ...i, floatAdjustmentConfirmed: true });
    const n = (await snap(f)).shift;
    assert.equal(n.carry_in_piastre, 50000);
    assert.equal(n.float_adjustment_piastre, target - 50000);
    assert.equal(n.live_expected_piastre, target);
    assert.deepEqual(await money(f), before);
  }
});
test("midnight-crossing active shift keeps its own ID/day and eight-hour duration; next shift uses current Cairo day", async () => {
  const f = await fixture({ opening: 50000, keep: 50000 });
  await act(f, cashier, "open");
  const s = (await snap(f)).shift;
  assert.ok(Math.abs(Date.parse(s.planned_end_at) - Date.parse(s.opened_at) - 28800000) < 100);
  // Historical clock fixture ONLY. Production timestamps are never rewritten.
  await db.admin.query(
    "update financial_private.cashier_shifts set shift_day=(clock_timestamp() at time zone 'Africa/Cairo')::date-1,opened_at=(((clock_timestamp() at time zone 'Africa/Cairo')::date-1)+time '23:58') at time zone 'Africa/Cairo',planned_end_at=((((clock_timestamp() at time zone 'Africa/Cairo')::date-1)+time '23:58') at time zone 'Africa/Cairo')+interval '8 hours' where id=$1",
    [s.id],
  );
  const old = await finish(f, 50000);
  await act(f, cashier, "open");
  const n = (await snap(f)).shift;
  const day = (
    await db.admin.query("select (clock_timestamp() at time zone 'Africa/Cairo')::date::text d")
  ).rows[0].d;
  assert.equal(n.shift_day, day);
  assert.notEqual(n.shift_day, old.shift_day);
  assert.deepEqual(await closedRow(old.id), old);
});
test("new expenses target only the new active shift; stale closed-shift expense is rejected without historical/ledger changes", async () => {
  const f = await fixture({ opening: 50000, keep: 50000 });
  await act(f, cashier, "open");
  const old = await finish(f, 50000);
  await act(f, cashier, "open");
  const before = await money(f);
  const bad = await raw(f, cashier, {
    action: "expense",
    shiftId: old.id,
    expectedRevision: old.revision,
    category: "office_supplies",
    amountPiastres: 100,
    note: "Invalid retroactive expense",
  });
  assert.equal(bad.code, "NEXUS_SHIFT_NOT_OPEN");
  assert.deepEqual(await closedRow(old.id), old);
  assert.deepEqual(await money(f), before);
  const r = await spend(f, 100);
  assert.equal((await history(f, old.id)).shift.cash_expenses_piastre, 0);
  assert.equal((await snap(f)).shift.movements.filter((x) => x.event_id === r.eventId).length, 1);
});
test("read-only past-shift drill-down remains own-store/own-cashier/authorized role only; no global finance or cost projection", async () => {
  const before = await money(seeded),
    d = await history(seeded, seeded.row.id);
  assert.equal(d.shift.id, seeded.row.id);
  assert.ok(d.shift.movements.some((x) => x.expense_category === "office_supplies"));
  assert.ok(d.audit.length);
  assert.deepEqual(await money(seeded), before);
  assert.doesNotMatch(
    JSON.stringify(d),
    /unit_cost|unitCost|stock_value|cogs|profit|owner_equity|bank_balance/i,
  );
  for (const c of [other, moderator, combined])
    await assert.rejects(() => history(seeded, seeded.row.id, c), /SHIFT_FORBIDDEN/);
  const f = await fixture();
  await assert.rejects(() => history(f, seeded.row.id), /SHIFT_FORBIDDEN/);
  const adminRead = await history(seeded, seeded.row.id, admin);
  assert.equal(adminRead.shift.cash_expenses_piastre, 500);
  const acl = (
    await db.admin.query(
      "select has_function_privilege('anon','public.read_cashier_shift_history(uuid,uuid)','execute') anon,has_table_privilege('authenticated','financial_private.cashier_shifts','select') direct",
    )
  ).rows[0];
  assert.deepEqual(acl, { anon: false, direct: false });
});
test("actual React historical reader consumes real persisted PG expense/actor/amount without opening or altering a shift", async () => {
  const snapshot = await history(seeded, seeded.row.id),
    before = await money(seeded);
  let pendingRead;
  const h = uiHarness({
    "@/lib/cashierShift": {
      readCashierShiftHistory: (id) => (pendingRead = history(seeded, id)),
      shiftError: (e) => e.message,
    },
    "@/store/useAuthStore": { useAuthStore: (sel) => sel({ accessRevision: 1 }) },
  });
  try {
    const Component = h.load(
      "src/components/sales/CashierShiftHistoryDetails.tsx",
    ).CashierShiftHistoryDetails;
    const u = await h.render(() => h.React.createElement(Component, { shiftId: seeded.row.id }));
    await h.perform(async () => {
      await u.click(
        h.getByRole(document.body, "button", { name: "عرض حركات الوردية للقراءة فقط" }),
      );
      await pendingRead;
    });
    assert.match(document.body.textContent, /تغليف وفطار|إيصال 12/);
    assert.match(document.body.textContent, /نثريات وضيافة/);
    assert.ok(document.body.textContent.includes(seeded.users.CASHIER_ONLY));
    assert.equal(h.queryByRole(document.body, "button", { name: /فتح وردية|تسجيل المصروف/ }), null);
    assert.deepEqual(await closedRow(seeded.row.id), seeded.row);
    assert.deepEqual(await money(seeded), before);
    assert.equal(snapshot.shift.cash_expenses_piastre, 500);
  } finally {
    await h.cleanup();
  }
});
