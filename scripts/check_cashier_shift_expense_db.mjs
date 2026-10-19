// Disposable captured-schema PostgreSQL17.6 only; never a shared cloud database.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openBusinessDb, read, ROOT } from "./helpers/business-db.mjs";
import { buildExpenseLines } from "../src/lib/ledger/expenses.ts";
import { buildSaleLines } from "../src/lib/ledger/sales.ts";
import { uiHarness } from "./helpers/ui-harness.mjs";
const migration = "20261019114804_cashier_shift_cash_expense.sql";
let db, admin, cashier, other, accountant;
const q = async (c, name, args) =>
  (
    await c.query(
      "select public." + name + "(" + args.map((_, i) => "$" + (i + 1)).join(",") + ") r",
      args,
    )
  ).rows[0].r;
const snap = (f, c = cashier) => q(c, "cashier_shift_snapshot", [f.store]);
const raw = (f, c, input, id = crypto.randomUUID()) =>
  q(c, "record_cashier_shift", [id, f.store, f.device, "cashier_shift", input]);
async function act(f, c, action, input = {}) {
  const s = await snap(f, c === other ? admin : c);
  const r = await raw(f, c, {
    action,
    ...(action === "open" || action === "configure"
      ? { expectedPolicyRevision: s.policy?.revision ?? 0 }
      : { shiftId: s.shift?.id, expectedRevision: s.shift?.revision }),
    ...input,
  });
  assert.notEqual(r.rejected, true, JSON.stringify(r));
  return r;
}
const input = async (f, extra = {}) => ({
  action: "expense",
  shiftId: (await snap(f)).shift.id,
  expectedRevision: (await snap(f)).shift.revision,
  category: "office_supplies",
  amountPiastres: 6000,
  note: "فطار الموظفين — إيصال 12",
  ...extra,
});
const ev = (f, kind, ref, id, lines, payload = {}) => ({
  ...db.event(kind, ref, id, lines, payload),
  store_id: f.store,
  device_id: f.device,
});
const totals = async (f) =>
  (
    await db.admin.query(
      "select account,subject_id,sum(amount_delta)::int n from ledger_lines where store_id=$1 group by 1,2 order by 1,2",
      [f.store],
    )
  ).rows;
const financialRows = async (f) =>
  (
    await db.admin.query(
      "select jsonb_build_object('events',(select jsonb_agg(to_jsonb(t) order by id) from ledger_events t where store_id=$1),'lines',(select jsonb_agg(to_jsonb(t) order by id) from ledger_lines t where store_id=$1),'expenses',(select jsonb_agg(to_jsonb(t) order by id) from expenses t where store_id=$1)) r",
      [f.store],
    )
  ).rows[0].r;
async function fixture(opening = 100000) {
  const f = { store: crypto.randomUUID(), device: crypto.randomUUID() };
  for (const [role, c, member] of [
    ["ADMIN", admin, "ADMIN"],
    ["CASHIER_ONLY", cashier, "CASHIER_ONLY"],
    ["OTHER", other, "CASHIER_ONLY"],
    ["ACCOUNTANT", accountant, "ACCOUNTANT"],
  ]) {
    db.users[role] = crypto.randomUUID();
    await db.admin.query("insert into auth.users values($1,$2,now())", [
      db.users[role],
      db.users[role] + "@synthetic.invalid",
    ]);
    await c.query("select set_config('request.jwt.claim.sub',$1,false)", [db.users[role]]);
  }
  await db.insert("stores", { id: f.store, name: "Synthetic custody expense" });
  await db.insert("store_licenses", {
    store_id: f.store,
    license_key: f.store,
    valid_until: new Date(Date.now() + 86400000).toISOString(),
  });
  for (const [role, member] of [
    ["ADMIN", "ADMIN"],
    ["CASHIER_ONLY", "CASHIER_ONLY"],
    ["OTHER", "CASHIER_ONLY"],
    ["ACCOUNTANT", "ACCOUNTANT"],
  ])
    await db.insert("store_members", { store_id: f.store, user_id: db.users[role], role: member });
  await q(admin, "ledger_append", [
    ev(f, "stock_adjustment", "opening_balance", "synthetic", [
      { account: "wallet", subjectId: "inStoreSafe", amount: 3000 },
    ]),
  ]);
  await act(f, admin, "configure", {
    cashierId: db.users.CASHIER_ONLY,
    openingPiastres: opening,
    keepPiastres: opening,
    enabled: true,
  });
  await act(f, cashier, "open", { floatReceived: true });
  return f;
}
async function sale(f, amount, wallet = "inStoreSafe") {
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
        name: "Synthetic item",
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
      productName: "Synthetic item",
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
async function normalExpense(f, c = admin, amount = 60) {
  const id = crypto.randomUUID(),
    p = {
      category: "office_supplies",
      amount,
      wallet: "inStoreSafe",
      description: "Ordinary manager expense",
    };
  return q(c, "record_expense", [
    {
      id,
      store_id: f.store,
      device_id: f.device,
      category: p.category,
      amount,
      description: p.description,
    },
    ev(f, "expense", "expense", id, buildExpenseLines(p), p),
  ]);
}
before(async () => {
  db = await openBusinessDb();
  assert.match(db.version, /PostgreSQL 17\.6/);
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
  admin = await db.client("ADMIN");
  cashier = await db.client("CASHIER_ONLY");
  other = await db.client("OTHER");
  accountant = await db.client("ACCOUNTANT");
});
after(async () => {
  await db?.close();
});
test("migration rolls back atomically, preserves financial rows/RLS and changes only reviewed function bodies", async () => {
  const rows = await financialRows({ store: db.store });
  const defs = (
    await db.admin.query(
      "select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','financial_private')",
    )
  ).rows;
  const policies = (
    await db.admin.query("select * from pg_policies order by schemaname,tablename,policyname")
  ).rows;
  await db.admin.query("begin");
  await db.admin.query(read("supabase/migrations/" + migration));
  await db.admin.query("rollback");
  assert.equal(
    (
      await db.admin.query(
        "select to_regprocedure('financial_private.record_expense_document(jsonb,jsonb)') x",
      )
    ).rows[0].x,
    null,
  );
  await db.admin.query(read("supabase/migrations/" + migration));
  assert.deepEqual(await financialRows({ store: db.store }), rows);
  assert.deepEqual(
    (await db.admin.query("select * from pg_policies order by schemaname,tablename,policyname"))
      .rows,
    policies,
  );
  for (const d of defs) {
    if (
      [
        "record_expense",
        "record_cashier_shift",
        "cashier_shift_summary",
        "append_authorized_event",
      ].includes(d.proname)
    )
      continue;
    assert.equal(
      (
        await db.admin.query(
          "select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname=$2 and pg_get_function_identity_arguments(p.oid)=$3",
          [d.nspname, d.proname, d.args],
        )
      ).rows[0]?.def,
      d.def,
      d.proname,
    );
  }
});
test("exact acceptance:1000+cashsale300-breakfast60=1240; one document/event/movement, actor, description and private projection", async () => {
  const f = await fixture();
  await sale(f, 300);
  const before = await totals(f);
  const request = await input(f),
    r = await raw(f, cashier, request);
  assert.notEqual(r.rejected, true);
  const s = (await snap(f)).shift;
  assert.equal(s.live_expected_piastre, 124000);
  assert.equal(s.cash_expenses_piastre, 6000);
  const doc = (await db.admin.query("select * from expenses where store_id=$1", [f.store])).rows;
  assert.equal(doc.length, 1);
  assert.equal(Number(doc[0].amount), 60);
  assert.equal(doc[0].ledger_event_id, r.eventId);
  const lines = (
    await db.admin.query(
      "select account,subject_id,amount_delta from ledger_lines where event_id=$1 order by account",
      [r.eventId],
    )
  ).rows;
  assert.deepEqual(lines, [
    { account: "expense", subject_id: "office_supplies", amount_delta: 6000 },
    { account: "wallet", subject_id: "inStoreSafe", amount_delta: -6000 },
  ]);
  const e = (await db.admin.query("select * from ledger_events where id=$1", [r.eventId])).rows[0];
  assert.equal(e.actor, db.users.CASHIER_ONLY);
  assert.equal(e.kind, "expense");
  assert.equal(e.ref_id, doc[0].id);
  const m = s.movements.filter((m) => m.event_id === r.eventId);
  assert.equal(m.length, 1);
  assert.equal(m[0].expense_description, request.note);
  assert.equal(m[0].expense_category, "office_supplies");
  assert.equal(
    (await snap(f, admin)).shift.movements.find((m) => m.event_id === r.eventId)
      .expense_description,
    request.note,
  );
  const beforeCash = before.find((x) => x.account === "wallet" && x.subject_id === "inStoreSafe").n;
  assert.equal(
    (await totals(f)).find((x) => x.account === "wallet" && x.subject_id === "inStoreSafe").n,
    beforeCash - 6000,
  );
  const saved = await financialRows(f);
  await act(f, cashier, "close", { actualPiastres: 122000, countConfirmed: true });
  assert.equal((await snap(f)).shift.variance_piastre, -2000);
  await act(f, admin, "reopen", { reason: "Physical recount requested" });
  await act(f, cashier, "close", { actualPiastres: 124000, countConfirmed: true });
  assert.equal((await snap(f)).shift.variance_piastre, 0);
  assert.deepEqual(await financialRows(f), saved);
});
test("same request replays after close; changed amount cannot reuse credit or identity", async () => {
  const f = await fixture(),
    request = await input(f),
    id = crypto.randomUUID(),
    r = await raw(f, cashier, request, id);
  await act(f, cashier, "close", { actualPiastres: 94000, countConfirmed: true });
  const rows = await financialRows(f);
  assert.equal((await raw(f, cashier, request, id)).replayed, true);
  assert.deepEqual(await financialRows(f), rows);
  await assert.rejects(
    () => raw(f, cashier, { ...request, amountPiastres: 6001 }, id),
    /PAYLOAD_MISMATCH/,
  );
  assert.equal(r.amountPiastres, 6000);
});
test("electronic payment stays separate from expense and physical expected cash", async () => {
  const f = await fixture();
  await raw(f, cashier, await input(f));
  await sale(f, 20, "instaPay");
  const s = (await snap(f)).shift;
  assert.equal(s.live_expected_piastre, 94000);
  assert.equal(s.electronic[0].amount_piastre, 2000);
  assert.equal(s.cash_expenses_piastre, 6000);
});
test("one piastre and exact decimal document amount, no salary/equity/stock or electronic lines", async () => {
  const f = await fixture(),
    r = await raw(f, cashier, await input(f, { amountPiastres: 1 }));
  assert.equal((await snap(f)).shift.live_expected_piastre, 99999);
  assert.equal(
    Number(
      (await db.admin.query("select amount from expenses where id=$1", [r.expenseId])).rows[0]
        .amount,
    ),
    0.01,
  );
  assert.equal(
    (
      await db.admin.query(
        "select count(*)::int n from ledger_lines where event_id=$1 and (account not in ('expense','wallet') or (account='wallet' and subject_id<>'inStoreSafe'))",
        [r.eventId],
      )
    ).rows[0].n,
    0,
  );
});
test("malformed, salary, forged wallet/actor/lines and excessive note are rejected without financial effects", async () => {
  const f = await fixture(),
    rows = await financialRows(f);
  for (const extra of [
    { amountPiastres: 0 },
    { amountPiastres: -1 },
    { amountPiastres: 1.1 },
    { amountPiastres: "NaN" },
    { amountPiastres: 1000000001 },
    { category: "salaries" },
    { category: null },
    { wallet: "bankAccount" },
    { actor: "ADMIN" },
    { lines: [] },
    { note: "x".repeat(501) },
    { note: {} },
  ]) {
    const r = await raw(f, cashier, await input(f, extra));
    assert.equal(r.rejected, true, JSON.stringify(extra));
    assert.equal(r.code, "NEXUS_SHIFT_EXPENSE_INVALID");
    assert.deepEqual(await financialRows(f), rows);
  }
});
test("insufficient own drawer is a durable negative receipt; no bank/company balance disclosed", async () => {
  const f = await fixture(100),
    r = await raw(f, cashier, await input(f, { amountPiastres: 101 }));
  assert.equal(r.code, "NEXUS_DRAWER_CASH_INSUFFICIENT");
  assert.equal(r.rejected, true);
  assert.doesNotMatch(JSON.stringify(r), /300000|bankAccount|balance|profit/);
  assert.equal(
    (await db.admin.query("select count(*)::int n from expenses where store_id=$1", [f.store]))
      .rows[0].n,
    0,
  );
});
test("existing category cap is enforced privately; rejected original never becomes payable after cap changes", async () => {
  const f = await fixture();
  await db.insert("budget_caps", {
    id: crypto.randomUUID(),
    store_id: f.store,
    category: "office_supplies",
    capAmount: 100,
  });
  await raw(f, cashier, await input(f));
  const id = crypto.randomUUID(),
    request = await input(f),
    r = await raw(f, cashier, request, id);
  assert.equal(r.code, "NEXUS_OVER_BUDGET");
  await db.admin.query('update budget_caps set "capAmount"=200 where store_id=$1', [f.store]);
  assert.equal((await raw(f, cashier, request, id)).rejected, true);
  assert.equal((await snap(f)).shift.cash_expenses_piastre, 6000);
});
test("other cashier, ADMIN override, accountant and foreign tenant cannot use own-shift expense authority", async () => {
  const f = await fixture(),
    request = await input(f),
    rows = await financialRows(f);
  for (const c of [other, admin]) assert.equal((await raw(f, c, request)).rejected, true);
  await assert.rejects(() => raw(f, accountant, request), /FORBIDDEN/);
  await assert.rejects(() => raw({ ...f, store: db.store }, cashier, request), /FORBIDDEN/);
  assert.deepEqual(await financialRows(f), rows);
});
test("cashier general expense/ledger/private helper remain denied and private readers return no rows", async () => {
  const f = await fixture();
  await assert.rejects(() => normalExpense(f, cashier), /FORBIDDEN/);
  await assert.rejects(
    () => cashier.query("select financial_private.record_expense_document('{}','{}')"),
    /permission denied/,
  );
  assert.equal(
    (await cashier.query("select count(*)::int n from expenses where store_id=$1", [f.store]))
      .rows[0].n,
    0,
  );
  assert.equal(
    (await cashier.query("select count(*)::int n from budget_caps where store_id=$1", [f.store]))
      .rows[0].n,
    0,
  );
  await assert.rejects(
    () =>
      q(cashier, "ledger_append", [
        ev(
          f,
          "expense",
          "expense",
          "forged",
          buildExpenseLines({ category: "other", wallet: "inStoreSafe", amount: 1 }),
        ),
      ]),
    /FORBIDDEN/,
  );
});
test("ADMIN/ACCOUNTANT original expense contract remains atomic and allocation still manual", async () => {
  const f = await fixture();
  for (const c of [admin, accountant]) assert.ok((await normalExpense(f, c)).expense);
  assert.equal((await snap(f)).shift.live_expected_piastre, 100000);
  assert.equal(
    (await db.admin.query("select count(*)::int n from expenses where store_id=$1", [f.store]))
      .rows[0].n,
    2,
  );
});
test("injected failure after canonical expense posting rolls document, ledger and drawer back together", async () => {
  const f = await fixture(),
    rows = await financialRows(f),
    s = (await snap(f)).shift;
  await db.admin.query(
    "create function financial_private.synthetic_expense_failure() returns trigger language plpgsql as $$begin raise exception 'synthetic rollback check';end$$;create trigger synthetic_expense_failure before insert on financial_private.cashier_shift_movements for each row when(new.category='expense') execute function financial_private.synthetic_expense_failure()",
  );
  async function attempt() {
    return raw(f, cashier, await input(f));
  }
  try {
    await assert.rejects(attempt, /synthetic rollback check/);
  } finally {
    await db.admin.query(
      "drop trigger synthetic_expense_failure on financial_private.cashier_shift_movements;drop function financial_private.synthetic_expense_failure()",
    );
  }
  assert.deepEqual(await financialRows(f), rows);
  assert.equal((await snap(f)).shift.revision, s.revision);
});
test("concurrent identical requests produce one expense and one movement", async () => {
  const f = await fixture(),
    second = await db.client("CASHIER_ONLY"),
    request = await input(f),
    id = crypto.randomUUID();
  const results = await Promise.all([raw(f, cashier, request, id), raw(f, second, request, id)]);
  assert.equal(results.filter((x) => x.replayed).length, 1);
  assert.equal((await snap(f)).shift.cash_expenses_piastre, 6000);
  assert.equal(
    (await db.admin.query("select count(*)::int n from expenses where store_id=$1", [f.store]))
      .rows[0].n,
    1,
  );
});
test("expense vs close serializes under the existing store lock and stale revision cannot silently commit", async () => {
  const f = await fixture(),
    second = await db.client("CASHIER_ONLY"),
    request = await input(f);
  const results = await Promise.all([
    raw(f, cashier, request),
    raw(f, second, {
      action: "close",
      shiftId: request.shiftId,
      expectedRevision: request.expectedRevision,
      actualPiastres: 100000,
      countConfirmed: true,
    }),
  ]);
  assert.equal(results.filter((x) => x.rejected).length, 1);
  const s = (await snap(f)).shift;
  assert.equal(s.live_expected_piastre, 100000 - s.cash_expenses_piastre);
  if (s.status !== "open") assert.equal(s.expected_piastre, s.live_expected_piastre);
});
test("ordinary manager expense vs cashier expense preserves cap under concurrency without a lock-order deadlock", async () => {
  const f = await fixture();
  await db.insert("budget_caps", {
    id: crypto.randomUUID(),
    store_id: f.store,
    category: "office_supplies",
    capAmount: 100,
  });
  const request = await input(f);
  const results = await Promise.allSettled([normalExpense(f, admin), raw(f, cashier, request)]);
  const rows = (
    await db.admin.query(
      "select count(*)::int n,sum(amount)::int amount from expenses where store_id=$1",
      [f.store],
    )
  ).rows[0];
  assert.equal(rows.n, 1);
  assert.equal(rows.amount, 60);
  for (const r of results)
    if (r.status === "rejected") assert.match(r.reason.message, /NEXUS_OVER_BUDGET/);
    else if (r.value.rejected) assert.equal(r.value.code, "NEXUS_OVER_BUDGET");
});
test("actual React shift panel consumes the real PostgreSQL reader: breakfast description and exact expected cash, without private finance", async () => {
  const f = await fixture();
  await sale(f, 300);
  await raw(f, cashier, await input(f));
  const h = uiHarness({
    "@/lib/supabase": {
      getSupabaseClient: () => ({
        rpc: async (name, args) => ({ data: await q(cashier, name, [args.p_store]), error: null }),
      }),
    },
    "@/services/api/storeContext": {
      getSyncIdentity: async () => ({ storeId: f.store, deviceId: f.device }),
    },
    "@/services/operationalSource": { captureReadAuthority() {}, assertReadAuthority() {} },
  });
  try {
    const data = await h.load("src/lib/cashierShift.ts").readCashierShift();
    const Panel = h.load("src/components/sales/CashierShiftPanel.tsx").CashierShiftPanel;
    const model = {
      eligible: true,
      data,
      loading: false,
      busy: false,
      error: "",
      overrideReason: "",
      setOverrideReason() {},
      refresh: async () => {},
      execute: async () => false,
      resolve: async () => {},
    };
    const user = await h.render(() => h.React.createElement(Panel, { model }));
    await h.perform(() =>
      user.click(h.getByRole(document.body, "button", { name: "تفاصيل الوردية والإقفال" })),
    );
    assert.match(document.body.textContent, /فطار الموظفين — إيصال 12/);
    const value = (1240).toLocaleString("ar-EG", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    assert.ok(document.body.textContent.includes(value));
    assert.doesNotMatch(
      document.body.textContent,
      /أرصدة الخزائن|رصيد البنك|صافي الربح|تكلفة البضاعة/,
    );
  } finally {
    await h.cleanup();
  }
});

test("closed/disabled/unlicensed shifts reject expense and existing non-cashier presets gain no authority", async () => {
  const f = await fixture(),
    rows = await financialRows(f);
  const person = db.users.OTHER;
  for (const role of ["POS_ECOMMERCE", "ECOMMERCE_ONLY", "MODERATOR"]) {
    await db.admin.query("update store_members set role=$1 where store_id=$2 and user_id=$3", [
      role,
      f.store,
      person,
    ]);
    await assert.rejects(() => raw(f, other, { action: "expense" }), /FORBIDDEN/);
  }
  await db.admin.query(
    "update financial_private.cashier_shift_policy set enabled=false where store_id=$1",
    [f.store],
  );
  assert.equal((await raw(f, cashier, await input(f))).code, "NEXUS_SHIFT_NOT_OPEN");
  await db.admin.query(
    "update financial_private.cashier_shift_policy set enabled=true where store_id=$1",
    [f.store],
  );
  await act(f, cashier, "close", { actualPiastres: 100000, countConfirmed: true });
  assert.equal((await raw(f, cashier, await input(f))).code, "NEXUS_SHIFT_NOT_OPEN");
  await act(f, cashier, "report_handover", { physicalHandoverConfirmed: true });
  await act(f, admin, "confirm_handover", { cashReceivedConfirmed: true });
  assert.equal((await snap(f)).shift.status, "closed");
  await db.admin.query(
    "update store_licenses set valid_until=now()-interval '1 day' where store_id=$1",
    [f.store],
  );
  await assert.rejects(() => raw(f, cashier, { action: "expense" }), /FORBIDDEN/);
  assert.deepEqual(await financialRows(f), rows);
});

test("new private helpers are not callable and stock/finance authorization bodies remain unchanged", async () => {
  for (const signature of [
    "financial_private.record_expense_document(jsonb,jsonb)",
    "financial_private.record_cashier_shift_expense(text,uuid,uuid,jsonb)",
  ]) {
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal(
        (
          await db.admin.query("select has_function_privilege($1,$2,'EXECUTE') ok", [
            role,
            signature,
          ])
        ).rows[0].ok,
        false,
      );
    }
  }
  for (const name of ["ledger_append", "apply_stock_event"]) {
    const def = (
      await db.admin.query(
        "select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname=$1 and n.nspname in ('public','financial_private')",
        [name],
      )
    ).rows[0].def;
    assert.match(
      def,
      name === "ledger_append" ? /NEXUS_LEDGER_FORBIDDEN/ : /NEXUS_STOCK_FORBIDDEN/,
    );
  }
});
