import { test } from "node:test";
import assert from "node:assert/strict";
import { uiHarness } from "./helpers/ui-harness.mjs";
const services = {
  "@/store/useAuthStore": { useAuthStore: (select) => select({ accessRevision: 1 }) },
  "@/lib/supabase": { getSupabaseClient: () => null },
  "@/services/api/storeContext": { getSyncIdentity: async () => null },
  "@/services/operationalSource": { captureReadAuthority() {}, assertReadAuthority() {} },
};
async function fixture(record = async () => true, disabled = false) {
  const h = uiHarness(services),
    calls = [];
  const Form = h.load("src/components/sales/CashierShiftExpenseForm.tsx").CashierShiftExpenseForm;
  const user = await h.render(() =>
    h.React.createElement(Form, {
      availablePiastres: 124000,
      disabled,
      onRecord: async (x) => {
        calls.push(x);
        return record(x);
      },
    }),
  );
  await h.perform(() => user.click(document.querySelector("summary")));
  return {
    h,
    user,
    calls,
    amount: h.getByLabelText(document.body, "مبلغ المصروف (جنيه)"),
    note: h.getByLabelText(document.body, "الوصف أو رقم الإيصال الورقي (اختياري)"),
    submit: h.getByRole(document.body, "button", { name: "تسجيل المصروف من النقدية" }),
  };
}
test("real shared form submits breakfast60 via existing category, exact6000piastres and paper note; clears only after confirmation", async () => {
  const f = await fixture();
  try {
    await f.h.perform(() => f.user.type(f.amount, "60"));
    await f.h.perform(() => f.user.type(f.note, "فطار الموظفين — إيصال 12"));
    await f.h.perform(() => f.user.click(f.submit));
    assert.deepEqual(f.calls, [
      { category: "office_supplies", amountPiastres: 6000, note: "فطار الموظفين — إيصال 12" },
    ]);
    assert.equal(f.amount.value, "");
    assert.match(f.h.getByRole(document.body, "status").textContent, /مرة واحدة/);
    assert.doesNotMatch(
      document.body.textContent,
      /رصيد البنك|أرصدة الخزائن|حقوق الملكية|صافي الربح|موافق عليه/,
    );
  } finally {
    await f.h.cleanup();
  }
});
test("rejected or uncertain expense retains amount/note and never simulates successful recording", async () => {
  const f = await fixture(async () => false);
  try {
    await f.h.perform(() => f.user.type(f.amount, "60.01"));
    await f.h.perform(() => f.user.type(f.note, "رقم 9"));
    await f.h.perform(() => f.user.click(f.submit));
    assert.equal(f.amount.value, "60.01");
    assert.equal(f.note.value, "رقم 9");
    assert.equal(f.h.queryByRole(document.body, "status"), null);
    assert.equal(f.calls[0].amountPiastres, 6001);
  } finally {
    await f.h.cleanup();
  }
});
test("pending submission disables the form and a second click cannot submit a second expense", async () => {
  let done;
  const wait = new Promise((r) => {
    done = r;
  });
  const f = await fixture(() => wait);
  try {
    await f.h.perform(() => f.user.type(f.amount, "60"));
    await f.h.perform(() => f.user.click(f.submit));
    assert.equal(document.querySelector("fieldset").disabled, true);
    await f.h.perform(() => f.user.click(document.querySelector("button")));
    assert.equal(f.calls.length, 1);
    await f.h.perform(() => {
      done(false);
    });
    assert.equal(f.amount.value, "60");
    assert.equal(f.h.queryByRole(document.body, "status"), null);
  } finally {
    done(false);
    await f.h.cleanup();
  }
});
for (const value of ["0", "-1", "60.001", "1240.01"])
  test("invalid/unfunded amount " + value + " produces no financial call", async () => {
    const f = await fixture();
    try {
      await f.h.perform(() => f.user.type(f.amount, value));
      await f.h.perform(() => f.user.click(f.submit));
      assert.equal(f.calls.length, 0);
      assert.ok(f.h.getByRole(document.body, "alert"));
    } finally {
      await f.h.cleanup();
    }
  });
test("loading/error disabled state prevents editing or submitting the expense", async () => {
  const f = await fixture(async () => true, true);
  try {
    await f.h.perform(() => f.user.type(f.amount, "60"));
    assert.equal(f.amount.value, "");
    assert.equal(f.calls.length, 0);
  } finally {
    await f.h.cleanup();
  }
});
test("new expense uses the existing durable financial envelope: unknown answer retries same ID/input; close resolves it before closing", async () => {
  const calls = [];
  let unknown = true;
  const h = uiHarness({
    ...services,
    "@/lib/supabase": {
      getSupabaseClient: () => ({
        rpc: async (name, args) => {
          calls.push({ name, args });
          if (unknown) throw Error("Synthetic lost response");
          return {
            data: {
              requestId: args.p_id,
              action: args.p_input.action,
              shiftId: "shift",
              replayed: true,
            },
            error: null,
          };
        },
      }),
    },
    "@/services/api/storeContext": {
      getSyncIdentity: async () => ({ storeId: "synthetic-store", deviceId: "device" }),
    },
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: window.sessionStorage,
    configurable: true,
  });
  try {
    const { actOnCashierShift } = h.load("src/lib/cashierShift.ts");
    const request = {
      shiftId: "shift",
      expectedRevision: 1,
      category: "office_supplies",
      amountPiastres: 6000,
      note: "فطار",
    };
    await assert.rejects(() => actOnCashierShift("expense", request), /لم يصل تأكيد/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].args.p_id, calls[1].args.p_id);
    unknown = false;
    await assert.rejects(
      () =>
        actOnCashierShift("close", {
          shiftId: "shift",
          expectedRevision: 1,
          actualPiastres: 124000,
          countConfirmed: true,
        }),
      /العملية السابقة/,
    );
    assert.equal(calls.length, 3);
    assert.equal(calls[2].args.p_id, calls[0].args.p_id);
    assert.deepEqual(calls[2].args.p_input, calls[0].args.p_input);
    assert.equal(calls[2].args.p_input.action, "expense");
    assert.equal(sessionStorage.length, 0);
  } finally {
    delete globalThis.sessionStorage;
    await h.cleanup();
  }
});

test("fresh client after reload restores the original uncertain expense envelope and never creates a new document identity", async () => {
  const calls = [];
  let lost = true;
  const stubs = {
    ...services,
    "@/lib/supabase": {
      getSupabaseClient: () => ({
        rpc: async (name, args) => {
          calls.push(args);
          if (lost) throw Error("synthetic unknown response");
          return { data: { requestId: args.p_id, action: "expense", replayed: true }, error: null };
        },
      }),
    },
    "@/services/api/storeContext": {
      getSyncIdentity: async () => ({ storeId: "synthetic-reload", deviceId: "device" }),
    },
  };
  const first = uiHarness(stubs),
    storage = window.sessionStorage;
  Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
  try {
    await assert.rejects(
      () =>
        first
          .load("src/lib/cashierShift.ts")
          .actOnCashierShift("expense", {
            shiftId: "shift",
            expectedRevision: 2,
            category: "office_supplies",
            amountPiastres: 6000,
            note: "فطار",
          }),
      /لم يصل تأكيد/,
    );
    await first.cleanup();
    lost = false;
    const fresh = uiHarness(stubs);
    try {
      const r = await fresh
        .load("src/lib/financialCommand.ts")
        .resolvePendingFinancialCommand("cashier-shift");
      assert.equal(r.replayed, true);
      assert.equal(calls.length, 3);
      assert.equal(calls[2].p_id, calls[0].p_id);
      assert.deepEqual(calls[2].p_input, calls[0].p_input);
      assert.equal(storage.length, 0);
    } finally {
      await fresh.cleanup();
    }
  } finally {
    delete globalThis.sessionStorage;
    await first.cleanup();
  }
});

test("shared Desktop/Mobile panel offers self-service expense only for an enabled open cashier shift", async () => {
  for (const [admin, status, enabled, present] of [
    [false, "open", true, true],
    [true, "open", true, false],
    [false, "closed", true, false],
    [false, "open", false, false],
  ]) {
    const h = uiHarness(services);
    const data = {
      admin,
      enabled,
      policy: null,
      cashiers: [],
      allocatable: [],
      history: [],
      audit: [],
      shift: {
        id: "shift",
        revision: 1,
        cashier_id: "cashier",
        shift_day: "2026-10-19",
        status,
        opened_at: "2026-10-19T08:00:00Z",
        planned_end_at: "2026-10-19T16:00:00Z",
        opening_piastre: 100000,
        keep_piastre: 100000,
        live_expected_piastre: 124000,
        cash_sales_piastre: 30000,
        cash_refunds_piastre: 0,
        cash_expenses_piastre: 6000,
        other_cash_piastre: 0,
        electronic: [],
        movements: [],
      },
    };
    try {
      const Panel = h.load("src/components/sales/CashierShiftPanel.tsx").CashierShiftPanel;
      await h.render(() =>
        h.React.createElement(Panel, {
          model: {
            eligible: true,
            data,
            busy: false,
            loading: false,
            error: "",
            overrideReason: "",
            execute: async () => false,
            refresh: async () => {},
            resolve: async () => {},
          },
        }),
      );
      assert.equal(
        [...document.querySelectorAll("summary")].some(
          (x) => x.textContent === "تسجيل مصروف من العهدة",
        ),
        present,
        JSON.stringify({ admin, status, enabled }),
      );
    } finally {
      await h.cleanup();
    }
  }
});
