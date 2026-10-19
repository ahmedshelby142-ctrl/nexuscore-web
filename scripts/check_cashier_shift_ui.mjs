import { test } from "node:test";
import assert from "node:assert/strict";
import { uiHarness } from "./helpers/ui-harness.mjs";
const money = (p) =>
  (p / 100).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
  " ج.م";
const shift = (status = "open", extra = {}) => ({
  id: "synthetic-shift",
  cashier_id: "synthetic-cashier",
  revision: 1,
  shift_day: "2026-10-18",
  status,
  opened_at: "2026-10-18T08:00:00Z",
  planned_end_at: "2026-10-18T16:00:00Z",
  opening_piastre: 50000,
  keep_piastre: 50000,
  live_expected_piastre: 270000,
  expected_piastre: null,
  actual_piastre: null,
  variance_piastre: null,
  retained_piastre: null,
  handover_piastre: null,
  cash_sales_piastre: 250000,
  cash_refunds_piastre: 10000,
  cash_expenses_piastre: 20000,
  other_cash_piastre: 0,
  electronic: [{ wallet_id: "bankAccount", amount_piastre: 2000 }],
  movements: [],
  ...extra,
});
function fixture({ admin = false, s = shift(), enabled = true, busy = false, error = "" } = {}) {
  const calls = [],
    h = uiHarness({
      "@/lib/supabase": { getSupabaseClient: () => null },
      "@/services/api/storeContext": { getSyncIdentity: async () => null },
      "@/services/operationalSource": { captureReadAuthority() {}, assertReadAuthority() {} },
      "@/lib/financialCommand": {
        runFinancialCommand() {
          throw Error("No financial call from component test");
        },
        resolvePendingFinancialCommand() {},
      },
    });
  const model = {
    eligible: true,
    data: {
      enabled,
      admin,
      policy: {
        cashier_id: "synthetic-cashier",
        revision: 1,
        opening_piastre: 50000,
        keep_piastre: 50000,
        updated_at: "synthetic-v1",
      },
      shift: s,
      cashiers: [{ id: "synthetic-cashier", email: "synthetic@qa.invalid" }],
      history: [],
      audit: [],
      allocatable: [],
    },
    loading: false,
    busy,
    error,
    overrideReason: "",
    setOverrideReason() {},
    canSell: true,
    refresh: async () => calls.push(["refresh"]),
    resolve: async () => calls.push(["resolve"]),
    execute: async (...a) => calls.push(a),
  };
  return {
    h,
    model,
    calls,
    async render(expand = true) {
      const Panel = h.load("src/components/sales/CashierShiftPanel.tsx").CashierShiftPanel;
      const user = await h.render(() => h.React.createElement(Panel, { model }));
      if (expand && s?.status === "open")
        await h.perform(() =>
          user.click(h.getByRole(document.body, "button", { name: "تفاصيل الوردية والإقفال" })),
        );
      return user;
    },
  };
}
test("real cashier shift reader renders exact2700 cash/500float, only own electronic20; no global balances/cost/profit or ADMIN controls", async () => {
  const f = fixture();
  try {
    await f.render();
    const text = document.body.textContent;
    for (const n of [270000, 50000, 250000, 10000, 20000, 2000])
      assert.ok(text.includes(money(n)), money(n));
    assert.doesNotMatch(
      text,
      /أرصدة الخزائن|رصيد البنك|حقوق الملكية|تكلفة البضاعة|صافي الربح|سياسة العهدة — للمدير فقط/,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.h.cleanup();
  }
});
test("active shift stays compact so POS remains usable; closing controls appear only on explicit expansion", async () => {
  const f = fixture();
  try {
    const user = await f.render(false),
      toggle = f.h.getByRole(document.body, "button", { name: "تفاصيل الوردية والإقفال" });
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(
      f.h.queryByRole(document.body, "button", { name: "إغلاق الوردية وحفظ العدّ" }),
      null,
    );
    await f.h.perform(() => user.click(toggle));
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.ok(f.h.getByRole(document.body, "button", { name: "إغلاق الوردية وحفظ العدّ" }));
    assert.equal(f.calls.length, 0);
  } finally {
    await f.h.cleanup();
  }
});
test("actual counted cash and explicit count confirmation are required;2700 closes with exact270000piastres", async () => {
  const f = fixture();
  try {
    const u = await f.render(),
      button = f.h.getByRole(document.body, "button", { name: "إغلاق الوردية وحفظ العدّ" });
    assert.equal(button.disabled, true);
    await f.h.perform(() =>
      u.type(f.h.getByLabelText(document.body, "النقدية الفعلية الموجودة (جنيه)"), "2700"),
    );
    assert.equal(button.disabled, true);
    assert.ok(document.body.textContent.includes(money(220000)));
    await f.h.perform(() =>
      u.click(f.h.getByLabelText(document.body, "عدَدت النقدية فعليًا وأوقفت معاملات هذه الوردية")),
    );
    await f.h.perform(() => u.click(button));
    assert.deepEqual(f.calls, [
      [
        "close",
        {
          shiftId: "synthetic-shift",
          expectedRevision: 1,
          actualPiastres: 270000,
          countConfirmed: true,
          reason: "",
        },
      ],
    ]);
  } finally {
    await f.h.cleanup();
  }
});
test("one-piastre shortage warns before submission; no fake expense command", async () => {
  const f = fixture();
  try {
    const u = await f.render();
    await f.h.perform(() =>
      u.type(f.h.getByLabelText(document.body, "النقدية الفعلية الموجودة (جنيه)"), "2699.99"),
    );
    assert.match(f.h.getByRole(document.body, "alert").textContent, /يتطلب توثيق ومراجعة المدير/);
    assert.ok(document.body.textContent.includes(money(-1)));
    assert.equal(f.calls.length, 0);
  } finally {
    await f.h.cleanup();
  }
});
test("cashier cannot approve discrepancy, and the blocked count is not reported as handed over", async () => {
  const f = fixture({
    s: shift("awaiting_review", {
      expected_piastre: 270000,
      actual_piastre: 269999,
      variance_piastre: -1,
      retained_piastre: 50000,
      handover_piastre: 219999,
    }),
  });
  try {
    await f.render();
    assert.match(document.body.textContent, /التسليم متوقف حتى مراجعة المدير/);
    assert.equal(
      f.h.queryByRole(document.body, "button", { name: "اعتماد الإقفال مع توثيق الفرق" }),
      null,
    );
    assert.equal(f.h.queryByRole(document.body, "button", { name: "تأكيد التسليم الفعلي" }), null);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.h.cleanup();
  }
});
test("handover needs explicit cashier confirmation; pending owner receipt is distinct from closed", async () => {
  const f = fixture({
    s: shift("awaiting_handover", {
      expected_piastre: 270000,
      actual_piastre: 270000,
      variance_piastre: 0,
      retained_piastre: 50000,
      handover_piastre: 220000,
    }),
  });
  try {
    const u = await f.render(),
      b = f.h.getByRole(document.body, "button", { name: "تأكيد التسليم الفعلي" });
    assert.equal(b.disabled, true);
    assert.match(document.body.textContent, /لم تسلّم النقدية بعد/);
    await f.h.perform(() =>
      u.click(f.h.getByLabelText(document.body, "سلّمت المبلغ فعليًا للمدير / الخزنة")),
    );
    await f.h.perform(() => u.click(b));
    assert.deepEqual(f.calls, [
      [
        "report_handover",
        { shiftId: "synthetic-shift", expectedRevision: 1, physicalHandoverConfirmed: true },
      ],
    ]);
  } finally {
    await f.h.cleanup();
  }
});
test("cashier-reported handover never exposes ADMIN receipt approval", async () => {
  const f = fixture({
    s: shift("handover_reported", { handover_piastre: 220000, retained_piastre: 50000 }),
  });
  try {
    await f.render();
    assert.match(document.body.textContent, /لا يُعد الاستلام مكتملًا حتى يؤكده المدير/);
    assert.equal(
      f.h.queryByRole(document.body, "button", { name: "تأكيد الاستلام واعتماد الإغلاق" }),
      null,
    );
  } finally {
    await f.h.cleanup();
  }
});
test("ADMIN must explicitly confirm physical receipt;2400 total sales is never used as drawer reconciliation", async () => {
  const f = fixture({
    admin: true,
    s: shift("handover_reported", { handover_piastre: 220000, retained_piastre: 50000 }),
  });
  try {
    const u = await f.render(),
      b = f.h.getByRole(document.body, "button", { name: "تأكيد الاستلام واعتماد الإغلاق" });
    assert.equal(b.disabled, true);
    await f.h.perform(() =>
      u.click(f.h.getByLabelText(document.body, /استلمت .* فعليًا وتحققت من العهدة المتبقية/)),
    );
    await f.h.perform(() => u.click(b));
    assert.deepEqual(f.calls, [
      [
        "confirm_handover",
        { shiftId: "synthetic-shift", expectedRevision: 1, cashReceivedConfirmed: true },
      ],
    ]);
  } finally {
    await f.h.cleanup();
  }
});
test("opening is a conscious custody receipt, not an automatic timer, salary or new revenue", async () => {
  const f = fixture({ s: null });
  try {
    const u = await f.render(),
      b = f.h.getByRole(document.body, "button", { name: "استلام العهدة وفتح الوردية" });
    assert.equal(b.disabled, true);
    assert.match(document.body.textContent, /مدة الثماني ساعات تذكير فقط/);
    await f.h.perform(() =>
      u.click(f.h.getByLabelText(document.body, /عدَدت واستلمت العهدة المخصصة فعليًا/)),
    );
    await f.h.perform(() => u.click(b));
    assert.deepEqual(f.calls, [
      ["open", { expectedPolicyRevision: 1, floatReceived: true, reason: "" }],
    ]);
  } finally {
    await f.h.cleanup();
  }
});
test("changed next-day float requires a specific physical top-up/return acknowledgement", async () => {
  for (const target of [40000, 60000]) {
    const f = fixture({ s: null });
    f.model.data.policy.opening_piastre = target;
    f.model.data.policy.previous_retained_piastre = 50000;
    f.model.data.policy.has_previous_shift = true;
    try {
      const user = await f.render(),
        button = f.h.getByRole(document.body, "button", { name: "استلام العهدة وفتح الوردية" });
      await f.h.perform(() =>
        user.click(f.h.getByLabelText(document.body, /عدَدت واستلمت العهدة المخصصة فعليًا/)),
      );
      assert.equal(button.disabled, true);
      const label =
        target < 50000
          ? /سلّمت فرق تخفيض العهدة .* إلى الخزنة فعليًا/
          : /استلمت زيادة العهدة .* من الخزنة فعليًا/;
      await f.h.perform(() => user.click(f.h.getByLabelText(document.body, label)));
      await f.h.perform(() => user.click(button));
      assert.deepEqual(f.calls, [
        [
          "open",
          {
            expectedPolicyRevision: 1,
            floatReceived: true,
            reason: "",
            floatAdjustmentConfirmed: true,
          },
        ],
      ]);
    } finally {
      await f.h.cleanup();
    }
  }
});
test("ADMIN float form uses existing cashier and exact piastres; active shift prevents changing its float snapshot", async () => {
  const f = fixture({ admin: true, s: null, enabled: false });
  try {
    const u = await f.render();
    await f.h.perform(() => u.click(f.h.getByText(document.body, "سياسة العهدة — للمدير فقط")));
    const a = f.h.getByLabelText(document.body, "عهدة بداية الوردية (جنيه)");
    await f.h.perform(() => u.clear(a));
    await f.h.perform(() => u.type(a, "500.01"));
    await f.h.perform(() =>
      u.click(f.h.getByRole(document.body, "button", { name: "حفظ وتفعيل سياسة العهدة" })),
    );
    assert.deepEqual(f.calls, [
      [
        "configure",
        {
          expectedPolicyRevision: 1,
          cashierId: "synthetic-cashier",
          openingPiastres: 50001,
          keepPiastres: 50000,
          enabled: true,
        },
      ],
    ]);
  } finally {
    await f.h.cleanup();
  }
  const g = fixture({ admin: true });
  try {
    const u = await g.render();
    await g.h.perform(() => u.click(g.h.getByText(document.body, "سياسة العهدة — للمدير فقط")));
    assert.equal(
      g.h.getByLabelText(document.body, "عهدة بداية الوردية (جنيه)").closest("fieldset").disabled,
      true,
    );
  } finally {
    await g.h.cleanup();
  }
});
test("invalid cash input never silently rounds, accepts negative, exponent or excess precision", async () => {
  const f = fixture();
  try {
    const { shiftMoneyInput } = f.h.load("src/lib/cashierShift.ts");
    assert.equal(shiftMoneyInput("0.01"), 1);
    assert.equal(shiftMoneyInput("2700"), 270000);
    for (const x of ["", "-1", "1e3", "NaN", "1.001", "10000000.01"])
      assert.throws(() => shiftMoneyInput(x));
  } finally {
    await f.h.cleanup();
  }
});
test("busy/error controls prevent duplicate handover submissions and provide same-attempt recovery", async () => {
  const f = fixture({
    busy: true,
    error: "Synthetic lost response",
    s: shift("awaiting_handover", { handover_piastre: 220000 }),
  });
  try {
    await f.render();
    assert.equal(
      f.h.getByRole(document.body, "button", { name: "تأكيد التسليم الفعلي" }).disabled,
      true,
    );
    assert.equal(
      f.h.getByRole(document.body, "button", { name: "تأكيد نتيجة المحاولة السابقة" }).disabled,
      true,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.h.cleanup();
  }
});
test("same financial-command retry envelope is used for shift close after a lost response", async () => {
  const calls = [],
    storage = new Map(),
    previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const h = uiHarness({
    "@/lib/supabase": {
      getSupabaseClient: () => ({
        rpc: async (name, args) => {
          calls.push({ name, args });
          return calls.length === 1
            ? { error: { message: "Synthetic lost response" } }
            : {
                data: {
                  requestId: args.p_id,
                  action: args.p_input.action,
                  shiftId: "synthetic-shift",
                  expectedRevision: 1,
                  replayed: true,
                },
                error: null,
              };
        },
      }),
    },
    "@/services/api/storeContext": {
      getSyncIdentity: async () => ({ storeId: "synthetic-store", deviceId: "synthetic-device" }),
    },
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
  });
  try {
    const { runFinancialCommand } = h.load("src/lib/financialCommand.ts");
    await runFinancialCommand(
      "cashier_shift",
      {
        action: "close",
        shiftId: "synthetic-shift",
        expectedRevision: 1,
        actualPiastres: 270000,
        countConfirmed: true,
      },
      "cashier-shift",
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].name, "record_cashier_shift");
    assert.equal(calls[0].args.p_id, calls[1].args.p_id);
    assert.deepEqual(calls[0].args.p_input, calls[1].args.p_input);
    assert.equal(storage.size, 0);
  } finally {
    await h.cleanup();
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else delete globalThis.sessionStorage;
  }
});

test("durable rejected response after a lost reply clears only that failed shift envelope", async () => {
  const calls = [],
    storage = new Map(),
    previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const h = uiHarness({
    "@/lib/supabase": {
      getSupabaseClient: () => ({
        rpc: async (name, args) => {
          calls.push({ name, args });
          return calls.length === 1
            ? { error: { message: "Synthetic lost response" } }
            : {
                data: {
                  requestId: args.p_id,
                  action: args.p_input.action,
                  replayed: calls.length === 2,
                  ...(calls.length === 2
                    ? { rejected: true, code: "NEXUS_SHIFT_STATE_CHANGED" }
                    : { shiftId: "synthetic-shift" }),
                },
                error: null,
              };
        },
      }),
    },
    "@/services/api/storeContext": {
      getSyncIdentity: async () => ({ storeId: "synthetic-store", deviceId: "synthetic-device" }),
    },
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
  });
  try {
    const { runFinancialCommand } = h.load("src/lib/financialCommand.ts");
    await assert.rejects(
      () =>
        runFinancialCommand(
          "cashier_shift",
          { action: "close", expectedRevision: 1 },
          "cashier-shift",
        ),
      /STATE_CHANGED/,
    );
    assert.equal(storage.size, 0);
    assert.equal(calls[0].args.p_id, calls[1].args.p_id);
    await runFinancialCommand(
      "cashier_shift",
      { action: "close", expectedRevision: 2 },
      "cashier-shift",
    );
    assert.notEqual(calls[2].args.p_id, calls[0].args.p_id);
  } finally {
    await h.cleanup();
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else delete globalThis.sessionStorage;
  }
});
test("closing resolves the original pending POS sale first and requires a new cash count", async () => {
  let resolved = 0,
    shiftCalls = 0;
  const h = uiHarness({
    "@/lib/supabase": { getSupabaseClient: () => null },
    "@/services/api/storeContext": { getSyncIdentity: async () => null },
    "@/services/operationalSource": { captureReadAuthority() {}, assertReadAuthority() {} },
    "./financialCommand": {
      resolvePendingFinancialCommand: async (scope) => {
        assert.equal(scope, "ledger:sale");
        resolved++;
        return { eventId: "original-committed-sale" };
      },
      runFinancialCommand: async () => {
        shiftCalls++;
      },
    },
  });
  try {
    const { actOnCashierShift } = h.load("src/lib/cashierShift.ts");
    await assert.rejects(
      () =>
        actOnCashierShift("close", {
          shiftId: "synthetic-shift",
          expectedRevision: 1,
          actualPiastres: 50000,
          countConfirmed: true,
        }),
      /أعد عدّ النقدية/,
    );
    assert.equal(resolved, 1);
    assert.equal(shiftCalls, 0);
  } finally {
    await h.cleanup();
  }
});

test("compact overview preserves expected cash and keeps closing controls behind explicit expansion", async () => {
  const f = fixture();
  try {
    await f.render(false);
    const overview = f.h.getByRole(document.body, "group", { name: "ملخص نقدية الوردية" });
    assert.ok(overview.textContent.includes(money(f.model.data.shift.live_expected_piastre)));
    assert.ok(overview.textContent.includes(money(f.model.data.shift.opening_piastre)));
    assert.equal(overview.querySelectorAll("dt").length, 2);
    assert.equal(
      f.h.queryByRole(document.body, "button", { name: "إغلاق الوردية وحفظ العدّ" }),
      null,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.h.cleanup();
  }
});

test("all ten financial labels retain their exact original source values after counted closing", async () => {
  const s = shift("closed");
  s.expected_piastre = s.live_expected_piastre;
  s.actual_piastre = s.live_expected_piastre;
  s.variance_piastre = 0;
  s.retained_piastre = s.keep_piastre;
  s.handover_piastre = s.live_expected_piastre - s.keep_piastre;
  const f = fixture({ s });
  try {
    await f.render();
    const values = new Map(
      [...document.querySelectorAll("dt")].map((dt) => [
        dt.textContent,
        dt.nextElementSibling.textContent,
      ]),
    );
    for (const [label, amount] of [
      ["عهدة البداية", s.opening_piastre],
      ["المبيعات النقدية", s.cash_sales_piastre],
      ["المرتجعات النقدية", s.cash_refunds_piastre],
      ["المصروفات النقدية المخصصة للدرج", s.cash_expenses_piastre],
      ["الحركات النقدية الأخرى", s.other_cash_piastre],
      ["النقدية المتوقعة", s.expected_piastre],
      ["النقدية المعدودة", s.actual_piastre],
      ["الزيادة / العجز", s.variance_piastre],
      ["المبلغ الذي يبقى للوردية التالية", s.retained_piastre],
      ["المبلغ المطلوب تسليمه للخزنة", s.handover_piastre],
    ])
      assert.equal(values.get(label), money(amount), label);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.h.cleanup();
  }
});

test("movement, history and audit disclosures retain complete references and original reasons", async () => {
  const f = fixture(),
    reference = "presentation-reference-with-a-long-suffix:".repeat(5),
    s = f.model.data.shift;
  s.movements = [
    {
      event_id: reference,
      document_number: "receipt-reference",
      wallet_id: "bankAccount",
      payment_piastre: s.electronic[0].amount_piastre,
      category: "sale",
      recorded_at: s.opened_at,
    },
  ];
  f.model.data.history = [{ ...s, id: reference }];
  f.model.data.audit = [
    {
      id: reference,
      action: "reopen",
      recorded_at: s.opened_at,
      detail: { input: { reason: "سبب المراجعة الأصلي — محفوظ كاملًا" } },
    },
  ];
  try {
    const user = await f.render();
    for (const label of [
      "الحركات والسجلات",
      "آخر ٢٠٠ حركة من هذه الوردية",
      "آخر ١٤ ملخص وردية",
      "سجل إجراءات العهدة والتسليم",
    ])
      await f.h.perform(() => user.click(f.h.getByText(document.body, label, { exact: false })));
    for (const summary of f.h.getAllByText(document.body, "المرجع الكامل"))
      await f.h.perform(() => user.click(summary));
    const refs = [...document.querySelectorAll(".shift-reference code")];
    assert.equal(refs.length, 3);
    assert.ok(refs.every((x) => x.textContent === reference && x.getAttribute("dir") === "ltr"));
    assert.ok(document.body.textContent.includes(f.model.data.audit[0].detail.input.reason));
    assert.equal(f.calls.length, 0);
  } finally {
    await f.h.cleanup();
  }
});

test("loading and empty states create no operation; error recovery preserves the existing resolver", async () => {
  const f = fixture({ s: null });
  f.model.data = null;
  f.model.loading = true;
  try {
    await f.render(false);
    assert.equal(document.querySelector(".cashier-shift-panel").getAttribute("aria-busy"), "true");
    assert.match(document.body.textContent, /جارٍ التحقق من الوردية/);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.h.cleanup();
  }
  const g = fixture({ s: null, error: "Synthetic lost response" });
  g.model.data = null;
  try {
    const user = await g.render(false);
    assert.ok(g.h.getByRole(document.body, "alert"));
    await g.h.perform(() =>
      user.click(g.h.getByRole(document.body, "button", { name: "تأكيد نتيجة المحاولة السابقة" })),
    );
    assert.deepEqual(g.calls, [["resolve"]]);
  } finally {
    await g.h.cleanup();
  }
});

test("manager policy remains visible in compact mode while its active-shift form stays disabled", async () => {
  const f = fixture({ admin: true });
  try {
    const user = await f.render(false);
    await f.h.perform(() => user.click(f.h.getByText(document.body, "سياسة العهدة — للمدير فقط")));
    const field = f.h.getByLabelText(document.body, "عهدة بداية الوردية (جنيه)");
    assert.equal(field.closest("fieldset").disabled, true);
    assert.ok(!field.closest("#cashier-shift-details"));
    assert.equal(f.calls.length, 0);
  } finally {
    await f.h.cleanup();
  }
});

test("ineligible users still render no shift or manager controls even when stale data exists", async () => {
  const f = fixture({ admin: true });
  f.model.eligible = false;
  try {
    await f.render(false);
    assert.equal(document.querySelector(".cashier-shift-panel"), null);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.h.cleanup();
  }
});
