import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { uiHarness } from "./helpers/ui-harness.mjs";
const writes = [];
let refuse = false;
const product = {
  id: "p",
  name: "Synthetic cream",
  sku: "SYN",
  quantity: 10,
  unitPrice: 30,
  isActive: true,
};
const discount = {
  id: "d",
  code: "SYN10",
  type: "percentage",
  value: 10,
  active: true,
  maxUses: 2,
  usedCount: 1,
  totalDiscount: 3,
  expiryDate: null,
  createdAt: new Date(),
};
const write = async (...args) => {
  if (refuse) throw Error("Synthetic refusal");
  writes.push(args);
};
let h;
const business = {
  products: [product],
  promoDiscounts: [discount],
  addPromoDiscount: write,
  updatePromoDiscount: write,
  removePromoDiscount: write,
  addProduct: write,
  updateProduct: write,
  removeProduct: write,
};
const stubs = {
  "@/store/useCourierStore": {
    useCourierStore: (selector) =>
      selector({ accounts: [{ id: "synthetic-courier", name: "Synthetic courier" }] }),
  },
  "@/store/useBusinessStore": {
    useBusinessStore: (selector) => (selector ? selector(business) : business),
  },
  "@/store/useOrderStore": { useOrderStore: () => ({ orders: [] }) },
  "@/hooks/useDraftState": {
    useDraftState: (_key, value) => h.React.useState(value),
    clearDrafts: () => {},
  },
  "@/components/ui/collection-gate": { CollectionGate: ({ children }) => children },
  "@/lib/ledger": { events: async () => [] },
  "@/lib/ledger/useStock": { useStock: () => ({ qtyOf: () => 10, costOf: () => 10 }) },
  "@/components/products/ProductSearch": {
    ProductSearch: ({ onSelect }) =>
      h.React.createElement(
        "button",
        { onClick: () => onSelect(product) },
        "Select synthetic component",
      ),
  },
};
h = uiHarness(stubs);
const { DiscountsPage } = h.load("src/components/ecommerce/DiscountsPage.tsx");
const { BundlesPage } = h.load("src/components/ecommerce/BundlesPage.tsx");
const { CourierSelect } = h.load("src/components/shipping/CourierSelect.tsx");
const field = (name) => h.getByLabelText(document.body, name),
  button = (name) => h.getByRole(document.body, "button", { name });
afterEach(async () => {
  await h.cleanup();
  writes.length = 0;
  refuse = false;
});
test("SPR-UI-01: discount definition controls expose distinct accessible names", async () => {
  await h.render(DiscountsPage);
  for (const name of ["الكود", "قيمة الخصم", "حد الاستخدام", "تاريخ الانتهاء"])
    assert.ok(field(name));
  assert.ok(h.getByRole(document.body, "combobox", { name: "نوع الخصم" }));
});
test("SPR-UI-02: invalid percentage and fractional limit retain draft and perform no write", async () => {
  const user = await h.render(DiscountsPage);
  await h.perform(async () => {
    await user.type(field("الكود"), "NEW");
    await user.type(field("قيمة الخصم"), "101");
    await user.click(button("إضافة الخصم"));
  });
  assert.match(h.getByRole(document.body, "alert").textContent, /غير صالحة/);
  assert.equal(writes.length, 0);
  await h.perform(async () => {
    await user.clear(field("قيمة الخصم"));
    await user.type(field("قيمة الخصم"), "10");
    await user.type(field("حد الاستخدام"), "1.2");
    await user.click(button("إضافة الخصم"));
  });
  assert.match(h.getByRole(document.body, "alert").textContent, /عددًا صحيحًا/);
  assert.equal(field("الكود").value, "NEW");
  assert.equal(writes.length, 0);
});
test("SPR-UI-03: edit existing discount preserves identity and sends definitions, never usage counters", async () => {
  const user = await h.render(DiscountsPage);
  await h.perform(() => user.click(button("تعديل SYN10")));
  assert.equal(field("قيمة الخصم").value, "10");
  await h.perform(async () => {
    await user.clear(field("قيمة الخصم"));
    await user.type(field("قيمة الخصم"), "15");
    await user.click(button("حفظ تعديل الخصم"));
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "d");
  assert.equal(writes[0][1].value, 15);
  assert.equal(writes[0][1].usedCount, undefined);
  assert.equal(writes[0][1].totalDiscount, undefined);
  assert.equal(field("الكود").value, "");
});
test("SPR-UI-04: refused discount save retains entered values for retry", async () => {
  refuse = true;
  const user = await h.render(DiscountsPage);
  await h.perform(async () => {
    await user.type(field("الكود"), "RETRY");
    await user.type(field("قيمة الخصم"), "10");
    await user.click(button("إضافة الخصم"));
  });
  assert.equal(field("الكود").value, "RETRY");
  assert.equal(field("قيمة الخصم").value, "10");
  assert.equal(writes.length, 0);
});
test("SPR-UI-05: real bundle form exposes quantity/price and saves chosen recipe with cost", async () => {
  const user = await h.render(BundlesPage);
  await h.perform(async () => {
    await user.type(field("اسم البوكس"), "Synthetic box");
    await user.type(field("SKU البوكس"), "SYN-BOX");
    await user.type(field("سعر البوكس"), "80");
    await user.click(button("Select synthetic component"));
  });
  const quantity = field("كمية Synthetic cream في البوكس");
  assert.equal(quantity.value, "1");
  await h.perform(async () => {
    await user.clear(quantity);
    await user.type(quantity, "2");
    await user.click(button(/حفظ البوكس/));
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].unitPrice, 80);
  assert.deepEqual(writes[0][0].bundleItems, [
    { productId: "p", quantity: 2, variantName: undefined },
  ]);
});
test("SPR-UI-06: shared courier picker exposes its business label and selected registry name", async () => {
  await h.render(() =>
    h.React.createElement(CourierSelect, { value: "synthetic-courier", onChange() {} }),
  );
  const picker = h.getByRole(document.body, "combobox", { name: "شركة الشحن" });
  assert.match(picker.textContent, /Synthetic courier/);
});
