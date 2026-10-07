import { execFileSync } from "node:child_process";
import { localDateInput } from "../src/lib/localDateInput.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { unsafeReloadReason } from "../src/mobile/pwa/updateLifecycle.ts";
import * as draw from "../src/lib/ledger/ownerDraw.ts";

import { buildExpenseLines } from "../src/lib/ledger/expenses.ts";
const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const compile = (src) =>
  ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
const equity = {};
vm.runInNewContext(compile(read("src/lib/ledger/equity.ts")), {
  exports: equity,
  require: () => draw,
});
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

// Run the real form handlers with a deterministic React hook host. Transport
// is fault-injected here; the companion PostgreSQL tests exercise real RPC/RLS.
function formHost({
  role = "ADMIN",
  record = async () => ({ success: true }),
  saved = new Map(),
} = {}) {
  let cursor = 0,
    state = [],
    effects = [],
    tree;
  const calls = [],
    exports = {};
  const react = {
    useState(init) {
      const i = cursor++;
      if (!(i in state)) state[i] = typeof init === "function" ? init() : init;
      return [
        state[i],
        (value) => {
          state[i] = typeof value === "function" ? value(state[i]) : value;
        },
      ];
    },
    useRef(init) {
      const i = cursor++;
      return (state[i] ??= { current: init });
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!state[i] || deps.some((v, j) => v !== state[i][j])) {
        state[i] = deps;
        effects.push(fn);
      }
    },
  };
  const modules = {
    react,
    "@/lib/localDateInput": { localDateInput },
    "react/jsx-runtime": {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
    "@/store/useAuthStore": { useAuthStore: (fn) => fn({ userRole: role }) },
    "@/lib/roles": { toAppRole: (r) => r },
    "@/services/api/storeContext": { getActiveStoreId: async () => "store" },
    "@/hooks/useOwnerBudget": {
      useOwnerBudget: () => ({
        ownerBudget: { limit: 20000, periodType: "open", startedAt: 1 },
        reload() {},
        setOwnerBudget: async (b) => calls.push(["budget", b]),
        clearOwnerBudget: async () => calls.push(["clear"]),
      }),
    },
    "@/lib/ledger": {
      events: async () => [],
      balances: async () => [{ subjectId: "owner", amount: 4000 }],
    },
    "@/lib/ledger/ownerDraw": draw,
    "@/lib/ledger/equity": equity,
    "@/lib/financialCommand": {
      appendFinancialEvent: async (input) => calls.push(["ledger", input]),
    },
    "@/lib/supplierPaymentCommand": {
      commitSupplierPayment: async (input) => {
        calls.push(["supplier", input]);
        return {};
      },
      formatSupplierPaymentSuccess: () => "saved",
    },
    "@/lib/financeDocument": {
      recordFinanceDocument: async (input) => {
        calls.push(["document", input]);
        return record(input);
      },
    },
    "@/lib/receiving/suppliers": {
      readSuppliers: async () => [{ id: "supplier", companyName: "Supplier" }],
    },
    "@/lib/expenseCategories": {
      EXPENSE_CATEGORIES: { retail: [{ value: "other", label: "أخرى" }] },
    },
    "@/types": { WALLET_LABELS: { inStoreSafe: "الخزنة", bank: "بنك" } },
    "@/mobile/viewmodels/formatters": { formatArabicCurrency: String },
    "@/mobile/data/useMobileRealtime": { useRealtimeTables() {} },
    sonner: { toast: { success() {} } },
  };
  vm.runInNewContext(
    compile(
      read("src/mobile/screens/MobileFinanceActions.tsx") +
        "\nexport { FinanceActions as TestForm };",
    ),
    {
      exports,
      require: (name) => {
        assert.ok(modules[name], name);
        return modules[name];
      },
      crypto,
      Date,
      sessionStorage: {
        getItem: (k) => saved.get(k) ?? null,
        setItem: (k, v) => saved.set(k, v),
        removeItem: (k) => saved.delete(k),
      },
      setTimeout: (fn) => {
        fn();
        return 1;
      },
      clearTimeout() {},
      window: { confirm: () => true },
    },
  );
  const render = () => {
    cursor = 0;
    tree = exports.TestForm({ supplierPayable: [], onSaved() {} });
    const pending = effects;
    effects = [];
    pending.forEach((f) => f());
    return tree;
  };
  const walk = (node) =>
    !node || typeof node !== "object"
      ? []
      : Array.isArray(node)
        ? node.flatMap((n) => walk(n))
        : [node, ...walk(node.props?.children)];
  const nodes = (node = tree) => walk(node);
  const text = (node) =>
    node == null
      ? ""
      : Array.isArray(node)
        ? node.map(text).join("")
        : typeof node === "object"
          ? text(node.props?.children)
          : String(node);
  const button = (label) => nodes().find((n) => n.type === "button" && text(n) === label);
  const change = (label, value) => {
    const parent = nodes().find((n) => n.type === "label" && text(n).startsWith(label));
    const input = nodes(parent).find((n) => n.type === "input" || n.type === "select");
    assert.ok(input, label);
    input.props.onChange({ target: { value, checked: value } });
    render();
  };
  const submit = () =>
    nodes()
      .find((n) => n.type === "form")
      .props.onSubmit({ preventDefault() {} });
  return {
    render,
    nodes,
    text,
    button,
    change,
    submit,
    calls,
    saved,
    allowed: () => exports.MobileFinanceActions({ supplierPayable: [], onSaved() {} }),
    dirty: () =>
      unsafeReloadReason({
        querySelector: (sel) =>
          sel.includes("data-pwa-unsaved") && tree.props["data-pwa-unsaved"] ? {} : null,
        querySelectorAll: () => [],
      }),
  };
}

test("ADMIN sees Mobile actions, MODERATOR renders none", () => {
  assert.ok(formHost().allowed());
  assert.equal(formHost({ role: "MODERATOR" }).allowed(), null);
});
test("budget 20000 minus authoritative owner draws 4000 leaves 16000", async () => {
  const h = formHost();
  h.render();
  await flush();
  h.render();
  assert.match(h.text(h.render()), /المتبقي: 16000/);
});
test("each finance form protects PWA reload even a selection-only draft; cancel releases it", async () => {
  const h = formHost();
  h.render();
  await flush();
  h.render();
  for (const label of [
    "مصروف تشغيل",
    "راتب / دفعة موظف",
    "دفعة مورد",
    "مسحوب شخصي",
    "رأس مال",
    "مساهمة إضافية",
    "ضبط الميزانية الشخصية",
  ]) {
    h.button(label).props.onClick();
    h.render();
    assert.equal(h.dirty(), "unsaved-work");
    h.button("إلغاء").props.onClick();
    h.render();
    assert.equal(h.dirty(), null);
  }
});
test("uncertain expense freezes draft, survives reload and reuses same document ID; success releases PWA", async () => {
  const h = formHost({
    record: async () => ({ success: false, definite: false, reason: "connection lost" }),
  });
  h.render();
  await flush();
  h.render();
  h.button("مصروف تشغيل").props.onClick();
  h.render();
  h.change("المبلغ", "0.01");
  h.change("ملاحظات", "QA draft");
  h.submit();
  await flush();
  h.render();
  const id = h.calls[0][1].id;
  assert.equal(h.button("إلغاء").props.disabled, true);
  assert.equal(h.dirty(), "unsaved-work");
  const second = formHost({ saved: h.saved });
  second.render();
  await flush();
  second.render();
  second.submit();
  await flush();
  second.render();
  assert.equal(second.calls[0][1].id, id);
  assert.equal(second.calls[0][1].note, "QA draft");
  assert.equal(second.saved.size, 0);
  assert.equal(second.dirty(), null);
});
test("definite rejection preserves editable draft; repeated same-tick submit sends once", async () => {
  let resolve;
  const h = formHost({
    record: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  h.render();
  await flush();
  h.render();
  h.button("راتب / دفعة موظف").props.onClick();
  h.render();
  h.change("المبلغ", "0.01");
  h.change("اسم الموظف", "QA employee");
  h.submit();
  h.submit();
  assert.equal(h.calls.length, 1);
  resolve({ success: false, definite: true, reason: "denied" });
  await flush();
  h.render();
  assert.equal(h.button("إلغاء").props.disabled, false);
  assert.equal(h.saved.size, 0);
  assert.equal(
    h.nodes().find((n) => n.type === "input" && n.props.value === "0.01").props.value,
    "0.01",
  );
});
test("owner draw and historical capital retain shared accounting semantics", async () => {
  for (const [label, kind, accounts] of [
    ["مسحوب شخصي", "owner_draw", ["owner_budget", "wallet"]],
    ["رأس مال", "owner_capital", ["owner_equity"]],
  ]) {
    const h = formHost();
    h.render();
    await flush();
    h.render();
    h.button(label).props.onClick();
    h.render();
    h.change("المبلغ", "0.01");
    h.submit();
    await flush();
    h.render();
    assert.equal(h.calls[0][1].kind, kind);
    assert.deepEqual(
      Array.from(h.calls[0][1].lines, (x) => x.account),
      accounts,
    );
  }
});
test("shared document adapter calls Desktop recordExpense/recordPayroll with matching ledger effects", async () => {
  const exports = {},
    calls = [];
  vm.runInNewContext(compile(read("src/lib/financeDocument.ts")), {
    exports,
    Date,
    require: (name) =>
      name.includes("useFinancialStore")
        ? {
            useFinancialStore: {
              getState: () =>
                Object.fromEntries(
                  ["recordExpense", "recordPayroll"].map((key) => [
                    key,
                    async (...args) => {
                      calls.push([key, ...args]);
                      return { success: true };
                    },
                  ]),
                ),
            },
          }
        : { buildExpenseLines },
  });
  for (const kind of ["expense", "payroll"])
    await exports.recordFinanceDocument({
      id: kind,
      kind,
      amount: 1,
      category: "other",
      wallet: "inStoreSafe",
      date: "2026-10-05",
      employeeName: "QA",
      paymentType: "advance",
      note: "QA",
    });
  assert.deepEqual(
    calls.map((x) => x[0]),
    ["recordExpense", "recordPayroll"],
  );
  for (const [, doc, event] of calls) {
    assert.equal(doc.id, event.refId);
    assert.equal(event.lines[1].amount, -1);
  }
  assert.equal(calls[1][2].lines[0].subjectId, "salaries");
});

test("supplier form delegates allocation, contribution adds cash, and budget saves shared setting", async () => {
  for (const label of ["دفعة مورد", "مساهمة إضافية", "ضبط الميزانية الشخصية"]) {
    const h = formHost();
    h.render();
    await flush();
    h.render();
    h.button(label).props.onClick();
    h.render();
    await flush();
    h.render();
    h.change(label.includes("ميزانية") ? "حد الميزانية" : "المبلغ", "0.01");
    if (label === "دفعة مورد") h.change("المورد", "supplier");
    h.submit();
    await flush();
    h.render();
    assert.equal(h.calls.length, 1);
    assert.equal(h.dirty(), null);
    if (label === "دفعة مورد") {
      assert.equal(h.calls[0][0], "supplier");
      assert.equal(h.calls[0][1].invoices.length, 0);
    }
    if (label === "مساهمة إضافية") {
      assert.equal(h.calls[0][1].kind, "owner_contribution");
      assert.equal(h.calls[0][1].lines.find((l) => l.account === "wallet").amount, 0.01);
    }
    if (label.includes("ميزانية")) {
      assert.equal(h.calls[0][0], "budget");
      assert.equal(h.calls[0][1].startedAt, 1);
    }
  }
});

test("shared budget service ignores browser settings, distinguishes absent/error and saves only explicitly", async () => {
  const exports = {},
    writes = [];
  let answer = { data: null, error: null };
  const query = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    maybeSingle: async () => answer,
    upsert: async (value) => {
      writes.push(value);
      return { error: null };
    },
  };
  vm.runInNewContext(compile(read("src/lib/ownerBudget.ts")), {
    exports,
    Date,
    Event,
    localStorage: {
      getItem() {
        throw Error("must never read browser settings");
      },
    },
    window: { dispatchEvent() {} },
    require: (name) =>
      name.includes("supabase")
        ? {
            getSupabaseClient: () => ({
              from: (name) => {
                assert.equal(name, "owner_budgets");
                return query;
              },
            }),
          }
        : { getActiveStoreId: async () => "store" },
  });
  assert.equal(await exports.readOwnerBudget(), null);
  assert.equal(writes.length, 0);
  answer = {
    data: { budget_limit: "20000", period_type: "open", started_at: "2026-10-05T00:00:00Z" },
    error: null,
  };
  const budget = await exports.readOwnerBudget();
  assert.equal(budget.limit, 20000);
  assert.equal(writes.length, 0);
  await exports.saveOwnerBudget(budget);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].store_id, "store");
  answer = { data: null, error: { message: "read failed" } };
  await assert.rejects(exports.readOwnerBudget(), /read failed/);
  await assert.rejects(exports.saveOwnerBudget({ ...budget, limit: Infinity }), /غير صالحة/);
  const storeSource = read("src/store/useFinancialStore.ts");
  assert.doesNotMatch(storeSource, /setOwnerBudget:|ownerBudget: null/);
  assert.match(read("src/components/finance/OwnerBudgetCard.tsx"), /useOwnerBudget\(\)/);
});

test("finance date defaults to the local day across Cairo midnight", () => {
  const url = new URL("../src/lib/localDateInput.ts", import.meta.url).href;
  const code = `import {localDateInput} from ${JSON.stringify(url)}; console.log(localDateInput(new Date('2026-10-05T22:30:00Z')));`;
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { ...process.env, TZ: "Africa/Cairo" },
    windowsHide: true,
  });
  assert.equal(result.trim(), "2026-10-06");
});
