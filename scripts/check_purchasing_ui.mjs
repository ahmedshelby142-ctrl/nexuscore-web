// E1: actual React/Radix DOM behavior with synthetic hydrated business reads.
// No network or real browser session; deployed/real-device acceptance is separate.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
for (const name of [
  "window",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "Element",
  "Node",
  "NodeFilter",
  "MutationObserver",
  "CustomEvent",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "DocumentFragment",
  "HTMLSelectElement",
])
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url),
  React = require("react"),
  { act } = React,
  { createRoot } = require("react-dom/client");
const {
  getByRole,
  getByLabelText,
  queryByRole,
  within,
  fireEvent,
} = require("@testing-library/dom");
const userEvent = require("@testing-library/user-event").default;
const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const product = {
  id: "p1",
  name: "Cream",
  sku: "C1",
  quantity: 10,
  unitPrice: 30,
  metadata: { variants: [{ name: "Current renamed", stock: 10 }] },
};
const invoice = {
  id: "i1",
  invoiceNumber: "FM-001",
  supplierId: "s1",
  supplierName: "Supplier QA",
  items: [
    {
      id: "l1",
      productId: "p1",
      productName: "Cream",
      variantName: "Persisted large",
      quantity: 2,
      unitCost: 10,
      total: 20,
    },
  ],
  createdAt: "2026-01-01T00:00:00Z",
  totalAmount: 20,
  paidAmount: 0,
  remainingAmount: 20,
  status: "unpaid",
};
const supplier = { id: "s1", companyName: "Supplier QA" };
const noop = () => {};
const ready = { loading: false, error: null };
const writes = [];
const forbidden = () => {
  writes.push("unexpected write");
  throw new Error("No writes allowed in UI regression");
};
const stubs = {
  "@/store/useBusinessStore": {
    useBusinessStore: () => ({
      suppliers: [supplier],
      purchaseInvoices: [invoice],
      products: [product],
      addSupplier: forbidden,
      addPurchaseInvoice: forbidden,
      updatePurchaseInvoice: forbidden,
      removePurchaseInvoice: forbidden,
      applyStockMoves: forbidden,
    }),
  },
  "@/lib/ledger/useStock": { useStock: () => ({ ...ready, qtyOf: () => 10, refresh: noop }) },
  "@/lib/ledger/useBalances": {
    useBalances: () => ({ ...ready, amountOf: () => 20, total: 20, refresh: noop }),
  },
  "@/components/ui/collection-gate": {
    useCollectionStatus: () => ({ read: ready }),
    CollectionGate: ({ children }) => children,
  },
  "@/lib/ledger": { appendEvent: forbidden, balancesByRef: async () => [] },
  "@/services/documentNumber": { nextDocumentNumber: forbidden },
  "@/lib/receiving": { commitReceipt: forbidden },
  "@/lib/supplierPaymentCommand": {
    commitSupplierPayment: forbidden,
    formatSupplierPaymentSuccess: () => "",
  },
};
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  cache.set(file, exports);
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const localRequire = (id) => {
    if (stubs[id]) return stubs[id];
    if (id.startsWith("@/") || id.startsWith(".")) {
      const base = id.startsWith("@/")
        ? path.resolve("src", id.slice(2))
        : path.resolve(path.dirname(file), id);
      const resolved = [
        base,
        base + ".ts",
        base + ".tsx",
        path.join(base, "index.ts"),
        path.join(base, "index.tsx"),
      ].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      if (!resolved) throw new Error("Unresolved test import " + id + " from " + file);
      return load(resolved);
    }
    return require(id);
  };
  // Run in the same DOM realm as Radix and React.
  vm.runInThisContext(`(function(exports,require){${source}\n})`, { filename: file })(
    exports,
    localRequire,
  );
  return exports;
}
const { PurchasingPage } = load("src/components/purchasing/PurchasingPage.tsx");
const { FilterSheet } = load("src/mobile/components/FilterSheet.tsx");
const { OrderDateFilter } = load("src/mobile/components/OrderDateFilter.tsx");
const { ProductSearch } = load("src/components/products/ProductSearch.tsx");
const { WholesaleReturnPanel } = load("src/components/wholesale/WholesaleReturnPanel.tsx");
let root;
async function render(element) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(element);
  });
  return userEvent.setup({ document });
}
async function perform(fn) {
  await act(async () => {
    await fn();
  });
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  document.body.innerHTML = "";
  assert.deepEqual(writes, []);
});
const button = (name) => getByRole(document.body, "button", { name });
const dialog = () => getByRole(document.body, "dialog");
for (const mode of ["removed", "disabled"])
  test(`PUR-UI-focus-fallback-${mode}: unavailable invoker returns to Purchasing heading`, async () => {
    const { usePurchasingDialogFocus } = load(
      "src/components/purchasing/usePurchasingDialogFocus.ts",
    );
    const { Dialog, DialogContent, DialogTitle } = load("src/components/ui/dialog.tsx");
    function Example() {
      const [open, setOpen] = React.useState(false),
        [visible, setVisible] = React.useState(true);
      const focus = usePurchasingDialogFocus();
      return React.createElement(
        React.Fragment,
        null,
        React.createElement("h1", { id: "purchasing-heading", tabIndex: -1 }, "Purchasing"),
        (visible || mode === "disabled") &&
          React.createElement(
            "button",
            {
              disabled: !visible,
              onClick: (e) => {
                focus.remember(e.currentTarget);
                setVisible(false);
                setOpen(true);
              },
            },
            "Open",
          ),
        React.createElement(
          Dialog,
          { open, onOpenChange: setOpen },
          React.createElement(
            DialogContent,
            { onCloseAutoFocus: focus.restore, "aria-describedby": undefined },
            React.createElement(DialogTitle, null, "Details"),
          ),
        ),
      );
    }
    const u = await render(React.createElement(Example));
    await perform(() => u.click(button("Open")));
    await perform(() => u.keyboard("{Escape}"));
    assert.equal(document.activeElement, document.getElementById("purchasing-heading"));
  });
test("PUR-UI-invoice: Tab/Enter and Space open one invoice, persisted variant in details/print; Escape/Close restore", async () => {
  const u = await render(React.createElement(PurchasingPage));
  const trigger = button("فتح فاتورة المشتريات FM-001");
  // Navigate through the actual tab order rather than assigning focus.
  for (let i = 0; i < 12 && document.activeElement !== trigger; i++) await perform(() => u.tab());
  assert.equal(document.activeElement, trigger);
  await perform(() => u.keyboard("{Enter}"));
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
  assert.match(dialog().textContent, /Persisted large/);
  assert.doesNotMatch(dialog().textContent, /Current renamed/);
  const print = document.querySelector('[class*="hidden print:block"]');
  assert.match(print.textContent, /Persisted large/);
  assert.doesNotMatch(print.textContent, /Current renamed/);
  await perform(() => u.keyboard("{Escape}"));
  assert.equal(document.activeElement, trigger);
  await perform(() => u.keyboard(" "));
  assert.ok(dialog());
  await perform(() => u.click(within(dialog()).getByRole("button", { name: "Close" })));
  assert.equal(document.activeElement, trigger);
});
test("PUR-UI-supplier: semantic keyboard action and nested settlement Cancel/Escape focus restoration", async () => {
  const u = await render(React.createElement(PurchasingPage));
  await perform(() => u.click(getByRole(document.body, "tab", { name: /الموردين/ })));
  const trigger = button("فتح ملف المورد Supplier QA");
  for (let i = 0; i < 12 && document.activeElement !== trigger; i++) await perform(() => u.tab());
  assert.equal(document.activeElement, trigger);
  await perform(() => u.keyboard(" "));
  assert.match(dialog().textContent, /Supplier QA/);
  const payment = button(/تسجيل دفعة \/ تسوية/);
  await perform(() => u.click(payment));
  await perform(() => u.click(button("إلغاء")));
  assert.equal(document.activeElement, payment);
  await perform(() => u.click(payment));
  await perform(() => u.keyboard("{Escape}"));
  assert.equal(document.activeElement, payment);
  await perform(() => u.keyboard("{Escape}"));
  assert.equal(document.activeElement, trigger);
});
test("PUR-UI-receipt: associated labels, variant picker return focus, correct remove action and Close restore", async () => {
  const u = await render(React.createElement(PurchasingPage));
  const trigger = button("تسجيل فاتورة مشتريات");
  await perform(() => u.click(trigger));
  const search = getByLabelText(dialog(), "بحث المنتجات");
  await perform(() => u.type(search, "Cream"));
  await perform(() => u.click(within(dialog()).getByRole("button", { name: /Cream/ })));
  await perform(() => u.click(button(/Current renamed/)));
  assert.equal(document.activeElement, search);
  assert.ok(getByLabelText(dialog(), "الكمية"));
  assert.ok(getByLabelText(dialog(), "تكلفة الوحدة"));
  assert.ok(getByRole(dialog(), "spinbutton", { name: /Cream.*Current renamed.*الكمية/ }));
  assert.ok(getByRole(dialog(), "spinbutton", { name: /Cream.*Current renamed.*تكلفة الوحدة/ }));
  assert.ok(button("حذف سطر المشتريات"));
  assert.equal(queryByRole(dialog(), "button", { name: "حذف سطر المرتجع" }), null);
  await perform(() => u.click(button("حذف سطر المشتريات")));
  assert.equal(queryByRole(dialog(), "spinbutton", { name: /Cream.*الكمية/ }), null);
  const supplierSelect = getByLabelText(dialog(), "المورد");
  await perform(() => u.selectOptions(supplierSelect, "__new__"));
  for (const name of ["اسم المورد", "رقم التليفون (اختياري)", "دفع نقدي من خزينة", "المدفوع نقداً"])
    assert.ok(getByLabelText(dialog(), name));
  await perform(() => u.click(button("Close")));
  assert.equal(document.activeElement, trigger);
});
test("PUR-UI-return: supplier/search/quantity labels, persisted source variant and Cancel/Escape restore", async () => {
  const u = await render(React.createElement(PurchasingPage));
  const trigger = button("مرتجع مورد");
  await perform(() => u.click(trigger));
  await perform(() => u.selectOptions(getByLabelText(dialog(), "المورد"), "s1"));
  assert.ok(getByLabelText(dialog(), "بحث فواتير المورد"));
  await perform(() => u.click(within(dialog()).getByRole("button", { name: /FM-001/ })));
  assert.match(dialog().textContent, /Persisted large/);
  assert.doesNotMatch(dialog().textContent, /Current renamed/);
  assert.ok(getByLabelText(dialog(), "كمية المرتجع"));
  assert.ok(getByRole(dialog(), "spinbutton", { name: /Cream.*Persisted large.*كمية المرتجع/ }));
  await perform(() => u.click(button("إلغاء")));
  assert.equal(document.activeElement, trigger);
  await perform(() => u.click(trigger));
  await perform(() => u.keyboard("{Escape}"));
  assert.equal(document.activeElement, trigger);
});
test("PUR-UI-dialog-extra-exits: variant Close/Escape, receipt Escape, return Close, supplier Enter/Close and disabled settlement fallback", async () => {
  const u = await render(React.createElement(PurchasingPage));
  const receipt = button("تسجيل فاتورة مشتريات");
  await perform(() => u.click(receipt));
  const search = getByLabelText(dialog(), "بحث المنتجات");
  for (const method of ["close", "escape"]) {
    await perform(() => u.type(search, "Cream"));
    await perform(() => u.click(within(dialog()).getByRole("button", { name: /Cream/ })));
    if (method === "close") await perform(() => u.click(button("Close")));
    else await perform(() => u.keyboard("{Escape}"));
    assert.equal(document.activeElement, search);
  }
  await perform(() => u.keyboard("{Escape}"));
  assert.equal(document.activeElement, receipt);
  const ret = button("مرتجع مورد");
  await perform(() => u.click(ret));
  await perform(() => u.click(button("Close")));
  assert.equal(document.activeElement, ret);
  await perform(() => u.click(getByRole(document.body, "tab", { name: /الموردين/ })));
  const supplier = button("فتح ملف المورد Supplier QA");
  await perform(() => supplier.focus());
  await perform(() => u.keyboard("{Enter}"));
  const payment = button(/تسجيل دفعة \/ تسوية/);
  await perform(() => u.click(payment));
  payment.disabled = true;
  await perform(() => u.click(button("Close")));
  assert.equal(document.activeElement, document.getElementById("purchasing-supplier-title"));
  payment.disabled = false;
  await perform(() => u.click(button("Close")));
  assert.equal(document.activeElement, supplier);
});
// Use each caller's real option array/label, extracted from its TSX AST rather
// than duplicating guessed values. Changing or adding a caller fails discovery.
const consumers = [
  "MobileOrdersScreen",
  "MobileShipmentsScreen",
  "MobileStockScreen",
  "MobilePurchasingScreen",
  "MobileOwnerScreen",
];
const discovered = fs
  .readdirSync("src/mobile/screens")
  .filter((f) => f.endsWith(".tsx") && read("src/mobile/screens/" + f).includes("<FilterSheet"))
  .map((f) => f.replace(".tsx", ""))
  .sort();
test("PUR-UI-filter-consumers: complete shared consumer inventory", () =>
  assert.deepEqual(discovered, [...consumers].sort()));
function consumerProps(name) {
  const source = read("src/mobile/screens/" + name + ".tsx");
  const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const constants = new Map();
  let attrs;
  function walk(n) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer)
      constants.set(n.name.text, n.initializer);
    if (
      (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
      n.tagName.getText(ast) === "FilterSheet"
    )
      attrs = n.attributes.properties;
    ts.forEachChild(n, walk);
  }
  walk(ast);
  const optionAttr = attrs.find((a) => a.name?.text === "options");
  let expression = optionAttr.initializer.expression;
  while (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression))
    expression = expression.expression;
  if (ts.isIdentifier(expression)) expression = constants.get(expression.text);
  const text = expression.getText(ast);
  const box = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule("exports.value=" + text, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    box,
  );
  return {
    label: attrs.find((a) => a.name?.text === "label")?.initializer.text ?? "تصفية",
    options: box.exports.value,
  };
}
for (const name of consumers)
  test(`PUR-UI-filter-${name}: entry, Tab/Shift+Tab trap, Escape/Close/selection restore`, async () => {
    const props = consumerProps(name),
      changes = [];
    const u = await render(
      React.createElement(
        "div",
        null,
        React.createElement("button", null, "outside"),
        React.createElement(FilterSheet, {
          ...props,
          value: props.options[0].id,
          onChange: (v) => changes.push(v),
        }),
      ),
    );
    const trigger = document.querySelector(".mobile-filter-trigger");
    await perform(() => u.click(trigger));
    assert.ok(dialog().contains(document.activeElement));
    const all = within(dialog()).getAllByRole("button"),
      first = all[0],
      last = all.at(-1);
    await perform(() => last.focus());
    await perform(() => u.tab());
    assert.equal(document.activeElement, first);
    await perform(() => first.focus());
    await perform(() => u.tab({ shift: true }));
    assert.equal(document.activeElement, last);
    await perform(() => u.keyboard("{Escape}"));
    assert.equal(queryByRole(document.body, "dialog"), null);
    assert.equal(document.activeElement, trigger);
    await perform(() => u.click(trigger));
    await perform(() => u.click(button("إغلاق")));
    assert.equal(document.activeElement, trigger);
    await perform(() => u.click(trigger));
    await perform(() => u.click(document.querySelector(".mobile-sheet-backdrop")));
    assert.equal(queryByRole(document.body, "dialog"), null);
    assert.equal(document.activeElement, trigger);
    await perform(() => u.click(trigger));
    await perform(() =>
      u.click(within(dialog()).getByRole("button", { name: props.options[1].label })),
    );
    assert.deepEqual(changes, [props.options[1].id]);
    assert.equal(document.activeElement, trigger);
  });
test("PUR-UI-date-filter: entry/trap/Escape restore, draft cancellation and custom apply contract retained", async () => {
  const changes = [],
    u = await render(
      React.createElement(OrderDateFilter, {
        value: { preset: "all" },
        onChange: (v) => changes.push(v),
      }),
    );
  const trigger = document.querySelector(".mobile-filter-trigger");
  await perform(() => u.click(trigger));
  assert.ok(dialog().contains(document.activeElement));
  await perform(() => u.click(button(/فترة مخصصة/)));
  assert.ok(getByLabelText(dialog(), "من تاريخ"));
  assert.ok(getByLabelText(dialog(), "إلى تاريخ"));
  assert.equal(button("تطبيق").disabled, true);
  const first = within(dialog()).getByRole("button", { name: "إغلاق" });
  await perform(() => {
    getByLabelText(dialog(), "إلى تاريخ").focus();
  });
  await perform(() => u.keyboard("{Tab}"));
  assert.equal(document.activeElement, first);
  await perform(() => u.keyboard("{Escape}"));
  assert.equal(document.activeElement, trigger);
  assert.deepEqual(changes, []);
  await perform(() => u.click(trigger));
  assert.equal(queryByRole(dialog(), "button", { name: "تطبيق" }), null);
});
test("PUR-UI-date-apply: valid range applies once and clear preserves the established contract", async () => {
  const changes = [];
  function Example() {
    const [value, setValue] = React.useState({ preset: "all" });
    return React.createElement(OrderDateFilter, {
      value,
      onChange: (next) => {
        changes.push(next);
        setValue(next);
      },
    });
  }
  const u = await render(React.createElement(Example));
  const trigger = document.querySelector(".mobile-filter-trigger");
  await perform(() => u.click(trigger));
  await perform(() => u.click(button("فترة مخصصة")));
  await perform(() =>
    fireEvent.change(getByLabelText(dialog(), "من تاريخ"), { target: { value: "2026-10-01" } }),
  );
  await perform(() =>
    fireEvent.change(getByLabelText(dialog(), "إلى تاريخ"), { target: { value: "2026-10-10" } }),
  );
  assert.equal(button("تطبيق").disabled, false);
  await perform(() => u.click(button("تطبيق")));
  assert.deepEqual(changes, [{ preset: "custom", from: "2026-10-01", to: "2026-10-10" }]);
  assert.equal(document.activeElement, trigger);
  await perform(() => u.click(trigger));
  await perform(() => u.click(button("مسح التاريخ")));
  assert.deepEqual(changes.at(-1), { preset: "all" });
  assert.equal(changes.length, 2);
  assert.equal(document.activeElement, trigger);
});
for (const variant of ["client", "supplier"])
  test(`PUR-UI-return-panel-${variant}: visible paid label association, arithmetic unchanged`, async () => {
    await render(
      React.createElement(WholesaleReturnPanel, {
        variant,
        debt: 30,
        returnValue: 10,
        paidInput: "5",
        onPaidChange: noop,
        debtRead: ready,
      }),
    );
    assert.equal(getByLabelText(document.body, "المبلغ المدفوع").value, "5");
    assert.match(document.body.textContent, /١٥/);
  });
test("PUR-UI-product-search: optional label ID preserves shared default selection and archived/out-of-stock behavior", async () => {
  const selected = [],
    u = await render(
      React.createElement(
        "div",
        null,
        React.createElement("label", { htmlFor: "qa-search" }, "Find product"),
        React.createElement(ProductSearch, {
          inputId: "qa-search",
          products: [
            product,
            { ...product, id: "archived", name: "Cream archived", deleted_at: "2026-01-01" },
            { ...product, id: "empty", name: "Cream empty", quantity: 0, metadata: {} },
          ],
          onSelect: (p) => selected.push(p.id),
        }),
      ),
    );
  await perform(() => u.type(getByLabelText(document.body, "Find product"), "Cream"));
  assert.doesNotMatch(document.body.textContent, /Cream archived/);
  await perform(() => u.click(button(/Cream empty/)));
  assert.deepEqual(selected, []);
  await perform(() => u.click(document.querySelector(".divide-y button:not(:disabled)")));
  assert.deepEqual(selected, ["p1"]);
});
test("PUR-UI-source-contracts: print uses persisted variant, scoped focus hooks and supplier-return display only", () => {
  const src = read("src/components/purchasing/PurchasingPage.tsx");
  assert.equal((src.match(/item\.variantName &&/g) ?? []).length, 2);
  for (const name of ["receipt", "return", "invoice", "supplier", "payment", "variant"])
    assert.ok(src.includes(`onCloseAutoFocus={${name}Focus.restore}`));
  // Evaluate the actual presentation helper without loading transport/hooks.
  const finance = ts.createSourceFile(
    "finance.tsx",
    read("src/mobile/screens/MobileFinanceActions.tsx"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const statements = finance.statements.filter(
    (n) =>
      (ts.isFunctionDeclaration(n) && n.name?.text === "financeActivityLabel") ||
      (ts.isVariableStatement(n) &&
        n.declarationList.declarations.some((d) => d.name.getText(finance) === "KINDS")),
  );
  const box = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(statements.map((n) => n.getText(finance)).join("\n"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    box,
  );
  const label = box.exports.financeActivityLabel,
    ret = { kind: "purchase", refType: "supplier_return" };
  assert.equal(label(ret), "مرتجع مورد");
  assert.deepEqual(ret, { kind: "purchase", refType: "supplier_return" });
  assert.equal(label({ kind: "purchase", refType: "supplier_invoice" }), "توريد");
  assert.equal(label({ kind: "supplier_payment", refType: "supplier_payment" }), "دفعة مورد");
  assert.match(
    read("src/mobile/screens/MobileFinanceActions.tsx"),
    /<strong>\{financeActivityLabel\(row\)\}<\/strong>/,
  );
});
