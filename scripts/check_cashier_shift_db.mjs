// Captured-schema PG17.6, loopback disposable databases only. No cloud env.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openBusinessDb, read, ROOT } from "./helpers/business-db.mjs";
import { buildSaleLines } from "../src/lib/ledger/sales.ts";
import { buildExpenseLines } from "../src/lib/ledger/expenses.ts";
import { uiHarness } from "./helpers/ui-harness.mjs";
const migration = "20261018105411_cashier_simple_shift_custody.sql";
let db, admin, cashier, other;
const evidence = [];
const q = async (c, name, args) =>
  (await c.query(`select public.${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) r`, args))
    .rows[0].r;
const requestPins = new Map();
const action = async (f, c, name, input = {}, id = crypto.randomUUID()) => {
  // A test form pins its real server snapshot; the SAME request keeps that pin on replay.
  if (!requestPins.has(id)) {
    const view = await snap(f, c);
    requestPins.set(
      id,
      name === "open" || name === "configure"
        ? { expectedPolicyRevision: view.policy?.revision ?? 0 }
        : { expectedRevision: view.shift?.revision ?? 0 },
    );
  }
  const result = await q(c, "record_cashier_shift", [
    id,
    f.store,
    f.device,
    "cashier_shift",
    { action: name, ...requestPins.get(id), ...input },
  ]);
  if (result.rejected) throw Object.assign(new Error(result.code), { code: result.code });
  return result;
};
const snap = (f, c = cashier) => q(c, "cashier_shift_snapshot", [f.store]);
const money = async (f) =>
  (
    await db.admin.query(
      "select coalesce(jsonb_object_agg(account||':'||subject_id,amount),'{}'::jsonb) r from(select account,subject_id,sum(amount_delta)::int amount from ledger_lines where store_id=$1 group by account,subject_id)x",
      [f.store],
    )
  ).rows[0].r;
const event = (f, kind, ref, id, lines, payload = {}) => ({
  ...db.event(kind, ref, id, lines, payload),
  store_id: f.store,
  device_id: f.device,
});
const command = (f, c, name, input, id = crypto.randomUUID()) =>
  q(c, "record_" + name, [id, f.store, f.device, name, input]);
const saleInput = (f, qty, wallet = "inStoreSafe", extra = {}) => {
  const items = [
    {
      productId: f.product,
      productName: "Synthetic shift item",
      quantity: qty,
      unitPrice: 10,
      unitCost: 0,
    },
  ];
  return {
    kind: "sale",
    refType: "pos_sale",
    actor: "POS",
    payload: { walletId: wallet, channel: "pos", items, ...extra },
    lines: buildSaleLines({ items, wallet }),
  };
};
const sell = (
  f,
  qty = 1,
  wallet = "inStoreSafe",
  extra = {},
  c = cashier,
  id = crypto.randomUUID(),
) => {
  const input = saleInput(f, qty, wallet, extra);
  if (c === admin) {
    input.payload.items.forEach((i) => (i.unitCost = 1));
    input.lines = buildSaleLines({ items: input.payload.items, wallet });
  }
  return command(f, c, "pos_sale", input, id);
};
async function fixture({ opening = 50000, keep = 50000, funded = 5000, enabled = true } = {}) {
  const f = {
    store: crypto.randomUUID(),
    device: crypto.randomUUID(),
    product: crypto.randomUUID(),
  };
  for (const role of ["ADMIN", "CASHIER_ONLY", "OTHER"]) {
    db.users[role] = crypto.randomUUID();
    await db.admin.query("insert into auth.users values($1,$2,now())", [
      db.users[role],
      db.users[role] + "@qa.invalid",
    ]);
  }
  for (const [client, role] of [
    [admin, "ADMIN"],
    [cashier, "CASHIER_ONLY"],
    [other, "OTHER"],
  ])
    await client.query("select set_config('request.jwt.claim.sub',$1,false)", [db.users[role]]);
  await db.insert("stores", { id: f.store, name: "Synthetic one drawer" });
  await db.insert("store_licenses", {
    store_id: f.store,
    license_key: f.store,
    valid_until: new Date(Date.now() + 86400000).toISOString(),
  });
  for (const [role, id] of [
    ["ADMIN", db.users.ADMIN],
    ["CASHIER_ONLY", db.users.CASHIER_ONLY],
    ["CASHIER_ONLY", db.users.OTHER],
  ])
    await db.insert("store_members", { user_id: id, store_id: f.store, role });
  await command(f, admin, "product_catalog", {
    action: "create",
    unitCost: 1,
    product: {
      id: f.product,
      name: "Synthetic shift item",
      sku: f.product,
      quantity: 1000,
      unitPrice: 10,
      metadata: { variants: [] },
    },
  });
  await q(admin, "ledger_append", [
    event(f, "stock_adjustment", "opening_balance", "cash-opening", [
      { account: "wallet", subjectId: "inStoreSafe", amount: funded },
    ]),
  ]);
  if (enabled)
    await action(f, admin, "configure", {
      cashierId: db.users.CASHIER_ONLY,
      openingPiastres: opening,
      keepPiastres: keep,
      enabled: true,
    });
  return f;
}
async function open(f) {
  await action(f, cashier, "open", { floatReceived: true });
  return (await snap(f)).shift;
}
async function expense(f, amount = 200) {
  const id = crypto.randomUUID(),
    payload = {
      category: "rent",
      amount,
      wallet: "inStoreSafe",
      description: "Synthetic drawer expense",
    };
  const e = event(f, "expense", "expense", id, buildExpenseLines(payload), payload);
  await q(admin, "record_expense", [
    {
      id,
      store_id: f.store,
      device_id: f.device,
      category: "rent",
      amount,
      description: payload.description,
      date: new Date().toISOString(),
    },
    e,
  ]);
  return e.id;
}
async function finish(f, s, actual, reason) {
  await action(f, cashier, "close", {
    shiftId: s.id,
    actualPiastres: actual,
    countConfirmed: true,
  });
  if (reason) await action(f, admin, "review_discrepancy", { shiftId: s.id, reason });
  await action(f, cashier, "report_handover", { shiftId: s.id, physicalHandoverConfirmed: true });
  await action(f, admin, "confirm_handover", { shiftId: s.id, cashReceivedConfirmed: true });
  return (await snap(f)).shift;
}
before(async () => {
  db = await openBusinessDb();
  admin = await db.client();
  for (const file of fs
    .readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter((f) => f >= "20261012000000" && f < migration)
    .sort())
    await db.admin.query(read("supabase/migrations/" + file));
  for (const role of ["CASHIER_ONLY", "OTHER"]) {
    db.users[role] = crypto.randomUUID();
    await db.admin.query("insert into auth.users values($1,$2,now())", [
      db.users[role],
      role + "@qa.invalid",
    ]);
  }
  cashier = await db.client("CASHIER_ONLY");
  other = await db.client("OTHER");
  const baseline = await db.admin.query(
    "select jsonb_agg(to_jsonb(t) order by id) r from ledger_events t",
  );
  const defs = await db.admin.query(
    "select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','financial_private') order by 1,2,3",
  );
  await db.admin.query("BEGIN");
  await db.admin.query(read("supabase/migrations/" + migration));
  await db.admin.query("ROLLBACK");
  assert.equal(
    (await db.admin.query("select to_regclass('financial_private.cashier_shifts') r")).rows[0].r,
    null,
  );
  await db.admin.query(read("supabase/migrations/" + migration));
  assert.deepEqual(
    (await db.admin.query("select jsonb_agg(to_jsonb(t) order by id) r from ledger_events t")).rows,
    baseline.rows,
  );
  for (const old of defs.rows) {
    const now = (
      await db.admin.query(
        "select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname=$2 and pg_get_function_identity_arguments(p.oid)=$3",
        [old.nspname, old.proname, old.args],
      )
    ).rows[0];
    assert.equal(now?.def, old.def);
  }
  assert.match(db.version, /PostgreSQL 17\.6/);
  evidence.push({
    postgres: db.version,
    migration,
    historicalLedgerUnchanged: true,
    existingFinancialFunctionBodiesUnchanged: defs.rowCount,
    atomicMigrationRollback: true,
  });
});
after(async () => {
  if (db) {
    fs.writeFileSync(
      path.join(ROOT, "logs/final-v1-sprint/cashier-shift-" + Date.now() + ".json"),
      JSON.stringify({ scope: "LOCAL ONLY; no Production acceptance", evidence }, null, 2),
    );
    await db.close();
  }
});

test("500 float +2500 cash -100 refund -200 expense =2700; handover2200, retain500; electronic separate, zero fake business money", async () => {
  const f = await fixture(),
    before = await money(f),
    s = await open(f);
  assert.deepEqual(await money(f), before);
  assert.ok(
    Date.parse(s.planned_end_at) - Date.parse(s.opened_at) >= 28800000 &&
      Date.parse(s.planned_end_at) - Date.parse(s.opened_at) < 28801000,
  );
  const sold = await sell(f, 250);
  await sell(f, -10, "inStoreSafe", { returnOfEventId: sold.eventId });
  await sell(f, 2, "bankAccount");
  const expenseId = await expense(f);
  await action(f, admin, "attach_movement", {
    shiftId: s.id,
    eventId: expenseId,
    reason: "Actual recorded expense paid from this drawer",
  });
  const live = (await snap(f)).shift;
  assert.equal(live.live_expected_piastre, 270000);
  assert.equal(live.cash_sales_piastre, 250000);
  assert.equal(live.cash_refunds_piastre, 10000);
  assert.equal(live.cash_expenses_piastre, 20000);
  assert.deepEqual(live.electronic, [{ wallet_id: "bankAccount", amount_piastre: 2000 }]);
  assert.equal(live.movements.length, 4);
  const finances = await money(f);
  const closed = await finish(f, s, 270000);
  assert.equal(closed.status, "closed");
  assert.equal(closed.handover_piastre, 220000);
  assert.equal(closed.retained_piastre, 50000);
  assert.equal(closed.variance_piastre, 0);
  assert.deepEqual(await money(f), finances);
  assert.equal(finances["wallet:inStoreSafe"] - before["wallet:inStoreSafe"], 220000);
  const refreshed = await snap(f);
  assert.equal(refreshed.history[0].handover_piastre, 220000);
  assert.equal(refreshed.shift.actual_piastre, 270000);
  assert.equal((await snap(f, admin)).shift.expected_piastre, refreshed.shift.expected_piastre);
  for (const view of [refreshed, await snap(f, admin)]) {
    const h = uiHarness({
      "@/lib/supabase": { getSupabaseClient: () => null },
      "@/services/api/storeContext": { getSyncIdentity: async () => null },
      "@/services/operationalSource": { captureReadAuthority() {}, assertReadAuthority() {} },
      "@/lib/financialCommand": {
        runFinancialCommand() {
          throw Error("Read-only PG snapshot render");
        },
        resolvePendingFinancialCommand() {},
      },
    });
    try {
      const Panel = h.load("src/components/sales/CashierShiftPanel.tsx").CashierShiftPanel;
      await h.render(() =>
        h.React.createElement(Panel, {
          model: {
            eligible: true,
            data: view,
            loading: false,
            busy: false,
            error: "",
            overrideReason: "",
            setOverrideReason() {},
            refresh: async () => {},
            execute() {
              throw Error("No UI mutation");
            },
          },
        }),
      );
      for (const n of [270000, 220000, 50000])
        assert.ok(
          document.body.textContent.includes(
            (n / 100).toLocaleString("ar-EG", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }) + " ج.م",
          ),
        );
    } finally {
      await h.cleanup();
    }
  }
  evidence.push({
    scenario: "Required 500/2500/100/200 EGP",
    opening: 50000,
    cashSales: 250000,
    refund: 10000,
    expense: 20000,
    expected: 270000,
    handover: 220000,
    retain: 50000,
    financialBalancesIdenticalBeforeAfterClosing: true,
  });
});
test("policy disabled preserves normal POS and does not retrofit old receipts", async () => {
  const f = await fixture({ enabled: false });
  const sold = await sell(f);
  assert.equal((await snap(f)).enabled, false);
  assert.equal(
    (
      await db.admin.query(
        "select count(*)::int n from financial_private.cashier_shift_movements where event_id=$1",
        [sold.eventId],
      )
    ).rows[0].n,
    0,
  );
});
test("Cashier cannot configure float, approve differences, confirm owner receipt or allocate expenses", async () => {
  const f = await fixture(),
    s = await open(f);
  for (const name of ["configure", "review_discrepancy", "confirm_handover", "attach_movement"])
    await assert.rejects(() => action(f, cashier, name, { shiftId: s.id }), /ADMIN_REQUIRED/);
});
test("auth role/store boundaries and private tables do not disclose global wallet, cost or other drawer data", async () => {
  const f = await fixture();
  await open(f);
  const r = await snap(f);
  assert.doesNotMatch(
    JSON.stringify(r),
    /unitCost|unit_cost|profit|walletBalances|owner_equity|cogs/,
  );
  await assert.rejects(() => q(cashier, "ledger_balances", [f.store, "wallet"]), /FORBIDDEN/);
  await assert.rejects(
    () => cashier.query("select * from financial_private.cashier_shifts"),
    /permission denied/,
  );
  await assert.rejects(
    () => q(cashier, "cashier_shift_snapshot", [crypto.randomUUID()]),
    /FORBIDDEN/,
  );
  const anon = await db.client();
  await anon.query("set role anon");
  await assert.rejects(() => q(anon, "cashier_shift_snapshot", [f.store]), /permission denied/);
});
test("no active shift, wrong cashier and undocumented ADMIN override roll back all financial/stock effects", async () => {
  const f = await fixture();
  const b = await money(f);
  await assert.rejects(() => sell(f), /OPEN_REQUIRED/);
  assert.deepEqual(await money(f), b);
  await open(f);
  await assert.rejects(() => sell(f, 1, "inStoreSafe", {}, other), /WRONG_CASHIER/);
  await assert.rejects(() => sell(f, 1, "inStoreSafe", {}, admin), /OVERRIDE_REASON_REQUIRED/);
  assert.deepEqual(await money(f), b);
  await sell(f, 1, "inStoreSafe", { shiftOverrideReason: "Manager covered cashier break" }, admin);
  assert.equal((await snap(f)).shift.movements.length, 1);
  assert.ok((await snap(f, admin)).audit.some((x) => x.action === "admin_pos_override"));
});
test("opening float must already be funded; cashier must acknowledge physical receipt", async () => {
  const f = await fixture({ funded: 100 });
  const b = await money(f);
  await assert.rejects(() => open(f), /UNFUNDED/);
  assert.deepEqual(await money(f), b);
  const g = await fixture();
  await assert.rejects(() => action(g, cashier, "open", {}), /FLOAT_CONFIRM_REQUIRED/);
});
test("one shift per day and one active drawer; same request replays without repeating custody", async () => {
  const f = await fixture(),
    id = crypto.randomUUID(),
    input = { floatReceived: true };
  const r = await action(f, cashier, "open", input, id);
  assert.equal((await action(f, cashier, "open", input, id)).replayed, true);
  await assert.rejects(
    () => action(f, cashier, "open", { floatReceived: false }, id),
    /PAYLOAD_MISMATCH/,
  );
  await assert.rejects(() => action(f, cashier, "open", input), /SHIFT_DUPLICATE/);
  await finish(f, (await snap(f)).shift, 50000);
  await assert.rejects(() => open(f), /SHIFT_DUPLICATE/);
  assert.equal((await snap(f)).history.length, 1);
  assert.equal(r.shiftId, (await snap(f)).shift.id);
});
test("discrepancy blocks handover; ADMIN reason preserves exact variance without expenses or silent balance changes", async () => {
  const f = await fixture(),
    s = await open(f),
    b = await money(f);
  await action(f, cashier, "close", { shiftId: s.id, actualPiastres: 49999, countConfirmed: true });
  assert.equal((await snap(f)).shift.variance_piastre, -1);
  await assert.rejects(
    () => action(f, cashier, "report_handover", { shiftId: s.id, physicalHandoverConfirmed: true }),
    /CONFIRM_REQUIRED/,
  );
  await assert.rejects(
    () => action(f, admin, "review_discrepancy", { shiftId: s.id, reason: "" }),
    /REASON_REQUIRED/,
  );
  await action(f, admin, "review_discrepancy", {
    shiftId: s.id,
    reason: "One piastre shortage documented for owner investigation",
  });
  assert.equal((await snap(f)).shift.variance_piastre, -1);
  assert.deepEqual(await money(f), b);
});
test("surplus remains visible and actual money below retained-float policy never produces negative handover", async () => {
  const f = await fixture(),
    s = await open(f);
  const r = await finish(f, s, 50001, "One piastre surplus retained in custody history");
  assert.equal(r.variance_piastre, 1);
  assert.equal(r.handover_piastre, 1);
  const g = await fixture(),
    t = await open(g);
  await action(g, cashier, "close", { shiftId: t.id, actualPiastres: 100, countConfirmed: true });
  assert.equal((await snap(g)).shift.retained_piastre, 100);
  assert.equal((await snap(g)).shift.handover_piastre, 0);
});
test("physical handover is never inferred; cashier report and ADMIN receipt are separate idempotent confirmations", async () => {
  const f = await fixture(),
    s = await open(f);
  await action(f, cashier, "close", { shiftId: s.id, actualPiastres: 50000, countConfirmed: true });
  await assert.rejects(
    () => action(f, cashier, "report_handover", { shiftId: s.id }),
    /CONFIRM_REQUIRED/,
  );
  await assert.rejects(
    () => action(f, admin, "confirm_handover", { shiftId: s.id, cashReceivedConfirmed: true }),
    /CONFIRM_REQUIRED/,
  );
  const reportId = crypto.randomUUID(),
    report = { shiftId: s.id, physicalHandoverConfirmed: true };
  await action(f, cashier, "report_handover", report, reportId);
  assert.equal((await action(f, cashier, "report_handover", report, reportId)).replayed, true);
  const receiptId = crypto.randomUUID(),
    receipt = { shiftId: s.id, cashReceivedConfirmed: true };
  await action(f, admin, "confirm_handover", receipt, receiptId);
  assert.equal((await action(f, admin, "confirm_handover", receipt, receiptId)).replayed, true);
  await assert.rejects(() => action(f, admin, "confirm_handover", receipt), /CONFIRM_REQUIRED/);
  assert.equal((await snap(f)).shift.status, "closed");
});
test("closing rejects repeat, cash sales while closed, and stale post-close financial operations atomically", async () => {
  const f = await fixture(),
    s = await open(f),
    id = crypto.randomUUID(),
    input = { shiftId: s.id, actualPiastres: 50000, countConfirmed: true };
  await action(f, cashier, "close", input, id);
  assert.equal((await action(f, cashier, "close", input, id)).replayed, true);
  await assert.rejects(() => action(f, cashier, "close", input), /NOT_OPEN/);
  const b = await money(f);
  await assert.rejects(() => sell(f), /OPEN_REQUIRED/);
  assert.deepEqual(await money(f), b);
});
test("financial sale retry after closing does not re-link or charge a new shift", async () => {
  const f = await fixture(),
    s = await open(f),
    id = crypto.randomUUID(),
    input = saleInput(f, 1);
  await command(f, cashier, "pos_sale", input, id);
  await finish(f, s, 51000);
  const b = await money(f);
  assert.equal((await command(f, cashier, "pos_sale", input, id)).replayed, true);
  assert.deepEqual(await money(f), b);
  assert.equal((await snap(f)).shift.movements.length, 1);
});
test("reopen/recount is ADMIN-only before reported handover and keeps original count audit", async () => {
  const f = await fixture(),
    s = await open(f);
  await action(f, cashier, "close", { shiftId: s.id, actualPiastres: 49000, countConfirmed: true });
  await assert.rejects(
    () => action(f, cashier, "reopen", { shiftId: s.id, reason: "Recount physical cash" }),
    /ADMIN_REQUIRED/,
  );
  await action(f, admin, "reopen", {
    shiftId: s.id,
    reason: "Owner requested a second physical count",
  });
  assert.equal((await snap(f)).shift.status, "open");
  assert.equal((await snap(f)).shift.actual_piastre, null);
  assert.ok(
    (await snap(f, admin)).audit.some(
      (a) => a.action === "reopen" && a.detail.before.actual_piastre === 49000,
    ),
  );
});
test("expense allocation uses immutable cash lines, not caller amounts, and cannot duplicate an allocation", async () => {
  const f = await fixture(),
    s = await open(f),
    id = await expense(f, 2);
  const b = await money(f);
  await action(f, admin, "attach_movement", {
    shiftId: s.id,
    eventId: id,
    reason: "Two pounds actually paid from drawer",
    amount: 99999,
  });
  assert.equal((await snap(f)).shift.live_expected_piastre, 49800);
  await assert.rejects(
    () =>
      action(f, admin, "attach_movement", {
        shiftId: s.id,
        eventId: id,
        reason: "Duplicate should fail",
      }),
    /SHIFT_DUPLICATE/,
  );
  assert.deepEqual(await money(f), b);
});
test("concurrent same-open/same-close calls serialize; losing calls do not create another shift or money", async () => {
  const f = await fixture(),
    a = await db.client("CASHIER_ONLY"),
    b = await db.client("CASHIER_ONLY");
  const opened = await Promise.allSettled([
    action(f, a, "open", { floatReceived: true }),
    action(f, b, "open", { floatReceived: true }),
  ]);
  assert.equal(opened.filter((x) => x.status === "fulfilled").length, 1);
  const s = (await snap(f)).shift;
  const closed = await Promise.allSettled([
    action(f, a, "close", { shiftId: s.id, actualPiastres: 50000, countConfirmed: true }),
    action(f, b, "close", { shiftId: s.id, actualPiastres: 50000, countConfirmed: true }),
  ]);
  assert.equal(closed.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal((await snap(f)).history.length, 1);
});
test("atomic exchange may refund first but only needs its final net drawer cash; legs and source stay linked", async () => {
  const f = await fixture({ enabled: false });
  const original = await sell(f, 10);
  await action(f, admin, "configure", {
    cashierId: db.users.CASHIER_ONLY,
    openingPiastres: 1000,
    keepPiastres: 1000,
    enabled: true,
  });
  await open(f);
  const returning = saleInput(f, -10, "inStoreSafe", { returnOfEventId: original.eventId });
  const replacement = saleInput(f, 11);
  delete replacement.lines;
  const r = await command(f, cashier, "pos_exchange", { return: returning, replacement });
  assert.equal(r.netPiastres, 1000);
  assert.equal((await snap(f)).shift.live_expected_piastre, 2000);
  assert.equal((await snap(f)).shift.movements.length, 2);
});
test("a refund cannot consume main-safe money when the assigned drawer lacks cash; all effects roll back", async () => {
  const f = await fixture({ enabled: false });
  const original = await sell(f, 10);
  await action(f, admin, "configure", {
    cashierId: db.users.CASHIER_ONLY,
    openingPiastres: 1000,
    keepPiastres: 1000,
    enabled: true,
  });
  await open(f);
  const b = await money(f);
  await assert.rejects(
    () => sell(f, -2, "inStoreSafe", { returnOfEventId: original.eventId }),
    /DRAWER_CASH_INSUFFICIENT/,
  );
  assert.deepEqual(await money(f), b);
  assert.equal((await snap(f)).shift.movements.length, 0);
});
test("in-flight sale completes before closing; stale count is rejected for recount without losing the sale", async () => {
  const f = await fixture(),
    s = await open(f),
    a = await db.client("CASHIER_ONLY"),
    b = await db.client("CASHIER_ONLY");
  await a.query("BEGIN");
  let closing;
  try {
    await sell(f, 1, "inStoreSafe", {}, a);
    closing = action(f, b, "close", {
      shiftId: s.id,
      actualPiastres: 50000,
      countConfirmed: true,
      expectedRevision: s.revision,
    });
    await a.query("COMMIT");
    await assert.rejects(() => closing, /STATE_CHANGED/);
  } finally {
    await a.query("ROLLBACK");
  }
  const r = (await snap(f)).shift;
  assert.equal(r.live_expected_piastre, 51000);
  assert.equal(r.expected_piastre, null);
  assert.equal(r.status, "open");
});
test("new policy changes only future shift floats; physical carry-in and reasoned override are recorded without ledger transfers", async () => {
  const f = await fixture(),
    s = await open(f),
    b = await money(f);
  await assert.rejects(
    () =>
      action(f, admin, "configure", {
        cashierId: db.users.CASHIER_ONLY,
        openingPiastres: 1,
        keepPiastres: 1,
        enabled: true,
      }),
    /SHIFT_ACTIVE/,
  );
  await finish(f, s, 50000);
  await action(f, admin, "configure", {
    cashierId: db.users.CASHIER_ONLY,
    openingPiastres: 40000,
    keepPiastres: 40000,
    enabled: true,
  });
  assert.equal((await snap(f)).policy.opening_piastre, 40000);
  assert.equal((await snap(f)).shift.opening_piastre, 50000);
  assert.deepEqual(await money(f), b);
});
test("next-day float decreases/increases require explicit physical transfer acknowledgement and never mint cash", async () => {
  for (const target of [40000, 60000]) {
    const f = await fixture({ opening: target, keep: target }),
      previous = crypto.randomUUID();
    // NEW synthetic custody fixture for yesterday; no historical financial row is rewritten.
    await db.admin.query(
      `insert into financial_private.cashier_shifts(id,store_id,cashier_id,shift_day,opened_at,opened_by,planned_end_at,opening_piastre,keep_piastre,status,expected_piastre,actual_piastre,variance_piastre,retained_piastre,handover_piastre,received_by,closed_at)
   values($1,$2,$3,(clock_timestamp() at time zone 'Africa/Cairo')::date-1,clock_timestamp()-interval '1 day',$3,clock_timestamp()-interval '16 hours',50000,50000,'closed',50000,50000,0,50000,0,$4,clock_timestamp()-interval '16 hours')`,
      [previous, f.store, db.users.CASHIER_ONLY, db.users.ADMIN],
    );
    const before = await money(f);
    assert.equal((await snap(f)).policy.previous_retained_piastre, 50000);
    await assert.rejects(
      () => action(f, cashier, "open", { floatReceived: true }),
      /FLOAT_TRANSFER_CONFIRM_REQUIRED/,
    );
    await action(f, cashier, "open", { floatReceived: true, floatAdjustmentConfirmed: true });
    const s = (await snap(f)).shift;
    assert.equal(s.opening_piastre, target);
    assert.equal(s.carry_in_piastre, 50000);
    assert.equal(s.float_adjustment_piastre, target - 50000);
    assert.deepEqual(await money(f), before);
  }
});

test("stale float policy and stale handover acknowledgements fail against monotonic revisions", async () => {
  const f = await fixture(),
    oldPolicy = (await snap(f)).policy.revision;
  await action(f, admin, "configure", {
    cashierId: db.users.CASHIER_ONLY,
    openingPiastres: 60000,
    keepPiastres: 50000,
    enabled: true,
  });
  await assert.rejects(
    () => action(f, cashier, "open", { floatReceived: true, expectedPolicyRevision: oldPolicy }),
    /POLICY_CHANGED/,
  );
  const s = await open(f);
  await action(f, cashier, "close", { shiftId: s.id, actualPiastres: 60000, countConfirmed: true });
  const oldClosing = (await snap(f)).shift;
  await action(f, admin, "reopen", { shiftId: s.id, reason: "Owner requested a physical recount" });
  await action(f, cashier, "close", { shiftId: s.id, actualPiastres: 59999, countConfirmed: true });
  await action(f, admin, "review_discrepancy", {
    shiftId: s.id,
    reason: "One piastre difference recorded after recount",
  });
  await assert.rejects(
    () =>
      action(f, cashier, "report_handover", {
        shiftId: s.id,
        physicalHandoverConfirmed: true,
        expectedRevision: oldClosing.revision,
      }),
    /STATE_CHANGED/,
  );
  assert.equal((await snap(f)).shift.status, "awaiting_handover");
});
test("durable negative receipt remains rejected after policy changes, while a fresh reviewed request can proceed", async () => {
  const f = await fixture({ funded: 100 }),
    id = crypto.randomUUID(),
    input = {
      action: "open",
      floatReceived: true,
      expectedPolicyRevision: (await snap(f)).policy.revision,
    };
  const rejected = await q(cashier, "record_cashier_shift", [
    id,
    f.store,
    f.device,
    "cashier_shift",
    input,
  ]);
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.code, "NEXUS_SHIFT_FLOAT_UNFUNDED");
  const before = await money(f);
  await action(f, admin, "configure", {
    cashierId: db.users.CASHIER_ONLY,
    openingPiastres: 5000,
    keepPiastres: 5000,
    enabled: true,
  });
  const replay = await q(cashier, "record_cashier_shift", [
    id,
    f.store,
    f.device,
    "cashier_shift",
    input,
  ]);
  assert.equal(replay.rejected, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.code, rejected.code);
  assert.equal((await snap(f)).shift, null);
  await open(f);
  assert.equal((await snap(f)).shift.opening_piastre, 5000);
  assert.deepEqual(await money(f), before);
});
