import { test } from "node:test";
import assert from "node:assert/strict";
import { uiHarness } from "./helpers/ui-harness.mjs";
const shift = {
  id: "saved-shift",
  cashier_id: "synthetic-cashier",
  status: "closed",
  movements: [
    {
      event_id: "saved-expense",
      document_number: "EXP-1",
      wallet_id: "inStoreSafe",
      payment_piastre: -15000,
      cash_piastre: -15000,
      category: "expense",
      expense_category: "office_supplies",
      expense_description: "تغليف وفطار — إيصال 12",
      recorded_at: "2026-10-19T08:00:00Z",
    },
  ],
};
test("historical reader sends only current tenant and requested shift; validates response and stale read authority", async () => {
  const calls = [];
  let stale = false,
    value = { shift, audit: [] };
  const h = uiHarness({
    "@/lib/supabase": {
      getSupabaseClient: () => ({
        rpc: async (...args) => {
          calls.push(args);
          return { data: value, error: null };
        },
      }),
    },
    "@/services/api/storeContext": {
      getSyncIdentity: async () => ({ storeId: "synthetic-store" }),
    },
    "@/services/operationalSource": {
      captureReadAuthority: () => 1,
      assertReadAuthority: () => {
        if (stale) throw Error("authority changed");
      },
    },
    "@/lib/financialCommand": {},
  });
  try {
    const { readCashierShiftHistory, shiftError } = h.load("src/lib/cashierShift.ts");
    assert.deepEqual(await readCashierShiftHistory("saved-shift"), value);
    assert.deepEqual(calls, [
      ["read_cashier_shift_history", { p_store: "synthetic-store", p_shift: "saved-shift" }],
    ]);
    stale = true;
    await assert.rejects(() => readCashierShiftHistory("saved-shift"), /authority changed/);
    stale = false;
    value = { shift: { ...shift, id: "wrong-shift" }, audit: [] };
    await assert.rejects(
      () => readCashierShiftHistory("saved-shift"),
      /تعذّر التحقق من سجل الوردية/,
    );
    assert.match(shiftError(Error("NEXUS_SHIFT_OPEN_SNAPSHOT_REQUIRED")), /حدّث التطبيق/);
  } finally {
    await h.cleanup();
  }
});
test("real historical UI is read-only, shows saved expense category/amount/actor/reference and preserves safe retry after read failure", async () => {
  let reject = true,
    count = 0;
  const h = uiHarness({
    "@/lib/cashierShift": {
      readCashierShiftHistory: async () => {
        count++;
        if (reject) throw Error("تعذر الاتصال");
        return { shift, audit: [] };
      },
      shiftError: (e) => e.message,
    },
    "@/store/useAuthStore": { useAuthStore: (selector) => selector({ accessRevision: 1 }) },
  });
  try {
    const C = h.load(
        "src/components/sales/CashierShiftHistoryDetails.tsx",
      ).CashierShiftHistoryDetails,
      u = await h.render(() => h.React.createElement(C, { shiftId: shift.id }));
    const b = h.getByRole(document.body, "button", { name: "عرض حركات الوردية للقراءة فقط" });
    await h.perform(() => u.click(b));
    assert.match(document.body.textContent, /تعذر الاتصال/);
    assert.equal(h.queryByLabelText(document.body, "حركات الوردية السابقة"), null);
    reject = false;
    await h.perform(() => u.click(b));
    assert.equal(count, 2);
    assert.match(document.body.textContent, /تغليف وفطار|نثريات وضيافة/);
    assert.ok(document.body.textContent.includes("synthetic-cashier"));
    assert.ok(document.body.textContent.includes("١٥٠٫٠٠"));
    assert.equal(
      h.queryByRole(document.body, "button", { name: /فتح وردية|تسجيل المصروف|إغلاق الوردية/ }),
      null,
    );
    assert.doesNotMatch(document.body.textContent, /رصيد البنك|تكلفة البضاعة|صافي الربح/);
  } finally {
    await h.cleanup();
  }
});
test("historical UI discards late response and removes previously loaded data after authority change", async () => {
  let authority = 1,
    resolve;
  const h = uiHarness({
    "@/lib/cashierShift": {
      readCashierShiftHistory: () =>
        new Promise((r) => {
          resolve = r;
        }),
      shiftError: (e) => e.message,
    },
    "@/store/useAuthStore": { useAuthStore: (selector) => selector({ accessRevision: authority }) },
  });
  let rerender;
  try {
    const C = h.load(
        "src/components/sales/CashierShiftHistoryDetails.tsx",
      ).CashierShiftHistoryDetails,
      u = await h.render(() => {
        const [, setTick] = h.React.useState(0);
        rerender = () => setTick((x) => x + 1);
        return h.React.createElement(C, { shiftId: shift.id, authority });
      });
    await h.perform(() =>
      u.click(h.getByRole(document.body, "button", { name: "عرض حركات الوردية للقراءة فقط" })),
    );
    authority++;
    await h.perform(() => rerender());
    await h.perform(async () => resolve({ shift, audit: [] }));
    assert.doesNotMatch(document.body.textContent, /تغليف وفطار/);
    await h.perform(() =>
      u.click(h.getByRole(document.body, "button", { name: "عرض حركات الوردية للقراءة فقط" })),
    );
    await h.perform(async () => resolve({ shift, audit: [] }));
    assert.match(document.body.textContent, /تغليف وفطار/);
    authority++;
    await h.perform(() => rerender());
    assert.doesNotMatch(document.body.textContent, /تغليف وفطار/);
  } finally {
    await h.cleanup();
  }
});
