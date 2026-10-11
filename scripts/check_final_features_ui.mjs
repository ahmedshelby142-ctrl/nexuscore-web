import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { uiHarness } from "./helpers/ui-harness.mjs";
const a = { id: "a", name: "Component A", sku: "A", unitPrice: 20, isActive: true },
  b = { id: "b", name: "Component B", sku: "B", unitPrice: 30, isActive: true };
const box = {
  id: "box",
  name: "Existing box",
  sku: "BOX",
  unitPrice: 80,
  isBundle: true,
  isActive: true,
  updated_at: 123,
  bundleItems: [{ productId: "a", quantity: 2 }],
};
const order = {
  id: "replacement",
  orderNumber: "ECO-NEW",
  status: "pending",
  totalAmount: 60,
  exchangeDetails: {
    id: "exchange",
    originalOrderId: "original",
    originalOrderNumber: "ECO-ORIG",
    status: "pending",
    cause: "shop",
    refundPiastres: 4500,
    selections: [
      {
        lineId: "line",
        productId: "a",
        productName: "Original A",
        quantity: 1,
        unitNumbers: [2],
        refundPiastres: 4500,
      },
    ],
  },
};
let h,
  writes = [],
  saved = [],
  refuse = false,
  recovered = null;
const business = {
  products: [a, b, box],
  addProduct: async () => {},
  updateProduct: async () => {},
  removeProduct: async () => {},
};
const stubs = {
  "@/lib/financialCommand": {
    resolvePendingFinancialCommand: async () => recovered,
    runFinancialCommand: async (command, input, scope) => {
      if (refuse) throw Error("رفض محلي");
      writes.push({ command, input, scope });
      return command === "bundle_edit"
        ? { product: { ...box, ...input.patch } }
        : {
            order: { ...order, exchangeDetails: { ...order.exchangeDetails, status: "confirmed" } },
            affectedProductIds: ["a"],
          };
    },
  },
  "@/services/featureStockMirror": { refreshFeatureStock: async () => {} },
  "@/store/useBusinessStore": {
    useBusinessStore: Object.assign((selector) => (selector ? selector(business) : business), {
      setState: (fn) => {
        saved.push(fn(business));
      },
    }),
  },
  "@/hooks/useDraftState": {
    useDraftState: (_key, value) => h.React.useState(value),
    clearDrafts: () => {},
  },
  "@/components/ui/collection-gate": { CollectionGate: ({ children }) => children },
  "@/lib/ledger/useStock": { useStock: () => ({ qtyOf: () => 10, costOf: () => 10 }) },
  "@/components/products/ProductSearch": {
    ProductSearch: ({ onSelect }) =>
      h.React.createElement("button", { onClick: () => onSelect(b) }, "Add B"),
  },
};
h = uiHarness(stubs);
const { BundlesPage } = h.load("src/components/ecommerce/BundlesPage.tsx");
const { ExchangeReturnPanel } = h.load("src/components/ecommerce/ExchangeReturnPanel.tsx");
const field = (name) => h.getByLabelText(document.body, name),
  button = (name) => h.getByRole(document.body, "button", { name });
afterEach(async () => {
  await h.cleanup();
  writes = [];
  saved = [];
  refuse = false;
  recovered = null;
});
test("FEATURE-UI-01: edit bundle with keyboard, replace component and preserve captured before/version", async () => {
  const user = await h.render(BundlesPage);
  await h.perform(async () => {
    button("تعديل Existing box").focus();
    await user.keyboard("{Enter}");
  });
  assert.equal(field("اسم البوكس").value, "Existing box");
  assert.equal(field("كمية Component A في البوكس").value, "2");
  await h.perform(async () => {
    await user.clear(field("اسم البوكس"));
    await user.type(field("اسم البوكس"), "Edited");
    await user.clear(field("SKU البوكس"));
    await user.type(field("SKU البوكس"), "NEW");
    await user.clear(field("سعر البوكس"));
    await user.type(field("سعر البوكس"), "90");
    await user.click(button("حذف Component A من البوكس"));
    await user.click(button("Add B"));
    await user.click(button("حفظ تعديل البوكس"));
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].command, "bundle_edit");
  assert.deepEqual(writes[0].input.before, {
    name: "Existing box",
    sku: "BOX",
    unitPrice: 80,
    bundleItems: box.bundleItems,
    updated_at: 123,
  });
  assert.equal(writes[0].input.patch.name, "Edited");
  assert.equal(writes[0].input.patch.sku, "NEW");
  assert.equal(writes[0].input.patch.unitPrice, 90);
  assert.deepEqual(writes[0].input.patch.bundleItems, [
    { productId: "b", variantName: undefined, quantity: 1 },
  ]);
});
test("FEATURE-UI-02: refused bundle edit retains recipe, price and stale version for a safe retry", async () => {
  const user = await h.render(BundlesPage);
  refuse = true;
  await h.perform(async () => {
    await user.click(button("تعديل Existing box"));
    await user.click(button("حفظ تعديل البوكس"));
  });
  assert.equal(field("اسم البوكس").value, "Existing box");
  assert.equal(field("كمية Component A في البوكس").value, "2");
  assert.equal(writes.length, 0);
});
test("FEATURE-UI-03: shared Desktop/Mobile exchange confirmation requires physical receipt and sends named financial choices", async () => {
  const user = await h.render(() =>
    h.React.createElement(ExchangeReturnPanel, { order, onSaved: (o) => saved.push(o) }),
  );
  assert.equal(button("تأكيد استلام وحدات الاستبدال").disabled, true);
  assert.match(document.body.textContent, /١٥/);
  await h.perform(async () => {
    await user.click(field("استلمت الوحدات المحددة فعليًا"));
    await user.selectOptions(field("طريقة رد قيمة الاستبدال"), "wallet");
    await user.selectOptions(field("خزينة رد الاستبدال"), "instaPay");
    await user.clear(field("تكلفة رحلة رجوع الاستبدال"));
    await user.type(field("تكلفة رحلة رجوع الاستبدال"), "5");
    button("تأكيد استلام وحدات الاستبدال").focus();
    await user.keyboard("{Enter}");
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].command, "exchange_return");
  assert.deepEqual(writes[0].input, {
    exchangeId: "exchange",
    refundVia: "wallet",
    wallet: "instaPay",
    returnFee: 5,
  });
  assert.equal(saved[0].exchangeDetails.status, "confirmed");
});
test("FEATURE-UI-04: confirmed/cancelled/read-only states expose no financial submit control", async () => {
  for (const props of [
    { order: { ...order, exchangeDetails: { ...order.exchangeDetails, status: "confirmed" } } },
    { order: { ...order, exchangeDetails: { ...order.exchangeDetails, status: "cancelled" } } },
    { order, readOnly: true },
  ]) {
    await h.render(() =>
      h.React.createElement(ExchangeReturnPanel, { ...props, onSaved: () => {} }),
    );
    assert.equal(
      h.queryByRole(document.body, "button", { name: "تأكيد استلام وحدات الاستبدال" }),
      null,
    );
    await h.cleanup();
  }
});

test("FEATURE-UI-05: two clicks in the same render submit one physical-receipt command", async () => {
  const user = await h.render(() =>
    h.React.createElement(ExchangeReturnPanel, { order, onSaved: (o) => saved.push(o) }),
  );
  await h.perform(async () => {
    await user.click(field("استلمت الوحدات المحددة فعليًا"));
  });
  await h.perform(async () => {
    const submit = button("تأكيد استلام وحدات الاستبدال");
    submit.click();
    submit.click();
  });
  assert.equal(writes.length, 1);
  assert.equal(saved.length, 1);
});
