import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { uiHarness } from "./helpers/ui-harness.mjs";
import {
  buildImportPlan,
  checkImportDuplicates,
  summarizeImport,
  importProductId,
  catalogCode,
} from "../src/lib/productImportWorkflow.ts";
const headers = ["sku", "name", "purchase_price", "retail_price", "stock_qty", "variants_raw"];
const good = ["P-001", "منتج", 1.25, 2.55, 3, "أحمر / M:2, أزرق / L:1"];

test("an oversized aggregate inventory value is rejected before an imprecise preview or any writer", () => {
  const p = buildImportPlan([
    headers,
    ...Array.from({ length: 3 }, (_, i) => ["BIG-" + i, "صنف", 800000, 2, 50000000, ""]),
  ]);
  assert.ok(p.errors.some((e) => /إجمالي قيمة الملف/.test(e.message)));
});
test("new-only preview distinguishes existing,conflicting and invalid rows without counting header errors as invalid products", () => {
  const p = checkImportDuplicates(
    buildImportPlan([headers, good, ["NEW", "جديد", 2, 3, 1, ""], ["BAD", "", 1, 2, 1, ""]]),
    [{ id: "old", sku: "p-001", barcode: "OLD-CODE" }],
  );
  const s = summarizeImport(p);
  assert.equal(s.existing, 1);
  assert.equal(s.invalid, 1);
  assert.equal(s.newProducts, 1);
  assert.equal(s.units, 1);
  assert.equal(s.valuePiastres, 200);
  assert.equal(s.resultingCount, 2);
  const bad = buildImportPlan([
    ["sku", "quantity"],
    ["X", 1],
  ]);
  assert.equal(summarizeImport(bad).invalid, 1);
  assert.equal(summarizeImport(bad).headerErrors, 1);
  const conflict = checkImportDuplicates(
    buildImportPlan([
      ["sku", "barcode", "name"],
      ["ONE", "TWO", "اسم"],
    ]),
    [
      { id: "a", sku: "ONE" },
      { id: "b", barcode: "TWO" },
    ],
  );
  assert.equal(summarizeImport(conflict).conflicts, 1);
  assert.equal(conflict.errors.length, 1);
});
test("identifier normalization never strips zeros or merges names;case/digit duplicate rows and inconsistent explicit pairs need review", () => {
  assert.equal(catalogCode("  A-٠٠١ "), "a-001");
  assert.notEqual(catalogCode("00123"), catalogCode("123"));
  const p = buildImportPlan([headers, ["a-٠٠١", "اسم"], ["A-001", "اسم آخر"]]);
  assert.equal(p.errors.length, 1);
  const separate = buildImportPlan([
    ["SKU / كود المنتج", "الباركود", "اسم المنتج"],
    ["ONE", "NEW-BAR", "اسم"],
  ]);
  assert.equal(separate.rows[0].separateIdentifiers, true);
  const c = checkImportDuplicates(separate, [{ id: "old", sku: "ONE", barcode: "OLD-BAR" }]);
  assert.equal(c.rows[0].disposition, "conflict");
  const names = checkImportDuplicates(buildImportPlan([headers, ["NEW-CODE", "نفس الاسم"]]), [
    { id: "old", sku: "OTHER", name: "نفس الاسم" },
  ]);
  assert.equal(names.rows[0].disposition, "new");
});
test("v1 acknowledged import identities survive preview-only metadata and classification changes", async () => {
  const row = buildImportPlan([headers, good]).rows[0];
  const id = await importProductId("tenant", row);
  assert.equal(
    await importProductId("tenant", { ...row, disposition: "existing", matchedProductId: "other" }),
    id,
  );
});

test("an import skip uses its cloud acknowledgement without overwriting a newer realtime product revision", async () => {
  const fresh = { id: "old", sku: "P-001", barcode: "P-001", updated_at: 20, name: "Earlier" },
    newer = { ...fresh, updated_at: 30, name: "Later" };
  const state = { products: [newer] };
  let writes = 0;
  const h = uiHarness({
    "@/store/useAuthStore": {
      useAuthStore: { getState: () => ({ permissionsVerified: true, userRole: "ADMIN" }) },
    },
    "@/store/useBusinessStore": {
      useBusinessStore: { setState: (f) => Object.assign(state, f(state)) },
    },
    "@/services/api/storeContext": { getSyncIdentity: async () => ({ storeId: "tenant" }) },
    "@/services/operationalSource": { captureReadAuthority: () => 1, assertReadAuthority() {} },
    "@/services/cloudData": { cloudList: async () => [fresh] },
    "./catalogStockCommand": {
      resolvePendingCatalog: async () => {},
      resolvePendingImport: async () => {},
      importCatalogProduct: async () => {
        writes++;
      },
    },
  });
  try {
    const r = await h
      .load("src/lib/productImportCommand.ts")
      .executeProductImport(buildImportPlan([headers, good]), () => {}, "tenant", "owned");
    assert.equal(r.skipped, 1);
    assert.equal(writes, 0);
    assert.deepEqual(state.products, [newer]);
  } finally {
    await h.cleanup();
  }
});
test("Arabic downloadable workbook has real-schema columns,text codes,instructions and valid examples;formula/rejection export cannot execute formulas", async () => {
  const h = uiHarness({});
  const previous = globalThis.FileReader;
  globalThis.FileReader = window.FileReader;
  try {
    const m = h.load("src/lib/productImportFile.ts"),
      bytes = m.productTemplate(),
      book = XLSX.read(bytes, { type: "array" });
    assert.equal(book.SheetNames.length, 2);
    assert.ok(book.SheetNames.includes("تعليمات"));
    const parsed = await m.readProductFile(new window.File([bytes], "نموذج.xlsx"));
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.rows[0].sku, "SKU-001");
    assert.equal(parsed.rows[0].barcode, "000123456789");
    assert.equal(parsed.rows[0].min_stock_level, 5);
    assert.equal(parsed.rows[1].stock_qty, 0);
    book.Sheets[book.SheetNames[0]].G2.f = "1+1";
    const formula = XLSX.write(book, { type: "array", bookType: "xlsx" });
    const rejected = await m.readProductFile(new window.File([formula], "formula.xlsx"));
    assert.ok(rejected.errors.some((e) => e.kind === "formula"));
    const dangerous = buildImportPlan([headers, ['=HYPERLINK("x")', "=1+1", "bad"]]);
    const report = XLSX.read(m.productImportRejections(dangerous), { type: "array" });
    const cells = Object.entries(report.Sheets[report.SheetNames[0]]).filter(
      ([k]) => !k.startsWith("!"),
    );
    assert.ok(cells.every(([, c]) => !c.f));
    assert.ok(cells.some(([, c]) => String(c.v).includes("=1+1")));
  } finally {
    globalThis.FileReader = previous;
    await h.cleanup();
  }
});

function archiveHarness({ readState, save, role = "ADMIN" } = {}) {
  const state = { userRole: role, permissionsVerified: true };
  const sb = {
    rpc: async () => ({
      data: readState ?? {
        productId: "p",
        storeId: "tenant",
        canArchive: true,
        canDelete: false,
        hasHistory: true,
        pendingOrders: 0,
        pendingReplacements: 0,
        bundleDependencies: 0,
      },
      error: null,
    }),
  };
  const h = uiHarness({
    "@/lib/supabase": { getSupabaseClient: () => sb },
    "@/services/api/storeContext": {
      getSyncIdentity: async () => ({ storeId: "tenant", deviceId: "d" }),
    },
    "@/services/operationalSource": {
      captureReadAuthority: () => 1,
      assertReadAuthority() {},
      operationalSource: (x) => x,
    },
    "@/lib/financialCommand": { runFinancialCommand: async () => {} },
    "@/store/useAuthStore": { useAuthStore: { getState: () => state } },
    "@/store/useBusinessStore": {
      useBusinessStore: () => ({
        archiveProduct: save ?? (async () => {}),
        removeProduct: async () => {
          throw Error("not expected");
        },
      }),
    },
  });
  return h;
}
test("actual archive dialog waits for server acknowledgement;same-tick double click makes one request and closes once after success", async () => {
  let calls = 0,
    close = 0,
    refresh = 0,
    release;
  const h = archiveHarness({
    save: async () => {
      calls++;
      return new Promise((r) => (release = r));
    },
  });
  try {
    const C = h.load("src/components/products/ProductRemovalDialog.tsx").ProductRemovalDialog;
    await h.render(() =>
      h.React.createElement(C, {
        product: { id: "p", name: "منتج", updated_at: 1 },
        onClose() {
          close++;
        },
        onRemoved() {
          refresh++;
        },
      }),
    );
    const button = h.getByRole(document.body, "button", { name: "تأكيد الأرشفة" });
    await h.perform(() => {
      button.click();
      button.click();
    });
    assert.equal(calls, 1);
    assert.equal(close, 0);
    assert.equal(refresh, 0);
    assert.match(document.body.textContent, /جارٍ تأكيد/);
    await h.perform(() => release());
    assert.equal(close, 1);
    assert.equal(refresh, 1);
  } finally {
    await h.cleanup();
  }
});
test("actual archive dialog keeps a rejected operation open with a genuine Arabic restriction and no false local success", async () => {
  let close = 0;
  const h = archiveHarness({
    save: async () => {
      throw new Error("NEXUS_PRODUCT_HAS_PENDING_COMMITMENTS");
    },
  });
  try {
    const C = h.load("src/components/products/ProductRemovalDialog.tsx").ProductRemovalDialog;
    const u = await h.render(() =>
      h.React.createElement(C, {
        product: { id: "p", name: "منتج", updated_at: 1 },
        onClose() {
          close++;
        },
      }),
    );
    await h.perform(() => u.click(h.getByRole(document.body, "button", { name: "تأكيد الأرشفة" })));
    assert.equal(close, 0);
    assert.match(h.getByRole(document.body, "alert").textContent, /طلبات أو بدائل معلّقة/);
    assert.doesNotMatch(document.body.textContent, /NEXUS_/);
    assert.equal(h.getByRole(document.body, "button", { name: "تأكيد الأرشفة" }).disabled, false);
  } finally {
    await h.cleanup();
  }
});
test("archive preflight stops genuine pending constraints and unauthorized Cashier before confirmation", async () => {
  for (const options of [
    { readState: { productId: "p", storeId: "tenant", canArchive: false, bundleDependencies: 1 } },
    { role: "CASHIER_ONLY" },
  ]) {
    let writes = 0;
    const h = archiveHarness({ ...options, save: async () => writes++ });
    try {
      const C = h.load("src/components/products/ProductRemovalDialog.tsx").ProductRemovalDialog;
      await h.render(() =>
        h.React.createElement(C, { product: { id: "p", name: "منتج" }, onClose() {} }),
      );
      assert.equal(h.getByRole(document.body, "button", { name: "تأكيد المسح" }).disabled, true);
      assert.equal(writes, 0);
    } finally {
      await h.cleanup();
    }
  }
});
test("archive client reads current server state after replay rather than publishing an old archived snapshot over a newer restore", async () => {
  const latest = {
    id: "p",
    store_id: "tenant",
    sku: "X",
    name: "current",
    quantity: 3,
    updated_at: 20,
    deleted_at: null,
  };
  let args;
  const requests = [];
  const query = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    single: async () => ({ data: latest, error: null }),
  };
  const h = uiHarness({
    "@/lib/supabase": {
      getSupabaseClient: () => ({
        from: () => query,
        rpc: async (name, p) => {
          requests.push(p.p_id);
          if (requests.length === 1) throw new Error("Synthetic lost archive response");
          args = [name, p.p_input];
          return { data: { product: { ...latest, deleted_at: 10, updated_at: 10 } }, error: null };
        },
      }),
    },
    "@/services/api/storeContext": {
      getSyncIdentity: async () => ({ storeId: "tenant", deviceId: "d" }),
    },
    "@/services/operationalSource": {
      captureReadAuthority: () => 1,
      assertReadAuthority() {},
      operationalSource: (x) => x,
    },
    "@/store/useAuthStore": {
      useAuthStore: { getState: () => ({ userRole: "ADMIN", permissionsVerified: true }) },
    },
  });
  try {
    const actual = await h
      .load("src/lib/productArchive.ts")
      .changeProductArchive({ id: "p", updated_at: 1 }, "archive");
    assert.equal(actual.deleted_at, null);
    assert.equal(actual.updated_at, 20);
    assert.equal(requests.length, 2);
    assert.equal(requests[0], requests[1]);
    assert.deepEqual(args[1], { productId: "p", action: "archive", expectedUpdatedAt: 1 });
  } finally {
    await h.cleanup();
  }
});
test("actual import UI requires owned-stock declaration;new-purchase choice cannot write opening capital;double confirmation is gated", async () => {
  let writes = 0,
    release;
  const parsed = buildImportPlan([headers, good]);
  const h = uiHarness({
    "@/store/useAuthStore": {
      useAuthStore: (sel) => sel({ userRole: "ADMIN", accessRevision: 1 }),
    },
    "@/services/cloudData": { cloudList: async () => [] },
    "@/services/api/storeContext": { getSyncIdentity: async () => ({ storeId: "tenant" }) },
    "@/lib/productImportFile": {
      readProductFile: async () => parsed,
      productTemplate: () => new Uint8Array(),
    },
    "@/lib/productImportCommand": {
      executeProductImport: async (...args) => {
        writes++;
        assert.equal(args[3], "owned");
        return new Promise(
          (r) => (release = () => r({ created: 1, recovered: 0, skipped: 0, units: 3 })),
        );
      },
    },
  });
  try {
    const C = h.load("src/components/products/BulkImportProduct.tsx").BulkImportProduct;
    const u = await h.render(() => h.React.createElement(C, { onClose() {} }));
    await h.perform(() =>
      u.upload(
        h.getByLabelText(document.body, "ملف المنتجات"),
        new window.File(["fixture"], "products.xlsx"),
      ),
    );
    let confirm = h.getByRole(document.body, "button", { name: /تأكيد وحفظ/ });
    assert.equal(confirm.disabled, true);
    assert.equal(writes, 0);
    await h.perform(() =>
      u.selectOptions(h.getByLabelText(document.body, "نوع مخزون الاستيراد"), "purchase"),
    );
    assert.match(h.getByRole(document.body, "alert").textContent, /فاتورة توريد/);
    assert.equal(confirm.disabled, true);
    await h.perform(() =>
      u.selectOptions(h.getByLabelText(document.body, "نوع مخزون الاستيراد"), "owned"),
    );
    await h.perform(() => u.click(h.getByRole(document.body, "checkbox")));
    confirm = h.getByRole(document.body, "button", { name: /تأكيد وحفظ/ });
    assert.equal(confirm.disabled, false);
    await h.perform(() => {
      confirm.click();
      confirm.click();
    });
    assert.equal(writes, 1);
    await h.perform(() => release());
    assert.match(document.body.textContent, /اكتمل الاستيراد/);
  } finally {
    await h.cleanup();
  }
});
test("actual shared valuation card counts active products but retains archived stock value without exposing finance to Cashier", async () => {
  for (const role of ["ADMIN", "CASHIER_ONLY"]) {
    const h = uiHarness({
      "@/store/useAuthStore": { useAuthStore: (sel) => sel({ userRole: role }) },
      "@/components/ui/collection-gate": {
        useCollectionStatus: () => ({ read: { loading: false, error: null } }),
      },
    });
    try {
      const p = { id: "a", minStockLevel: 5 },
        archived = { id: "b", minStockLevel: 5, deleted_at: 1 };
      h.load("src/lib/ledger/stockSnapshot.ts").setStockSnapshot(
        new Map([
          ["a", 3],
          ["b", 2],
        ]),
      );
      const C = h.load("src/components/inventory/StockSummaryCards.tsx").StockSummaryCards;
      await h.render(() =>
        h.React.createElement(C, {
          products: [p],
          valuationProducts: [p, archived],
          value: "all",
          onChange() {},
          costOf: (id) => (id === "a" ? 1.25 : 2),
          read: { loading: false, error: null },
        }),
      );
      assert.match(document.body.textContent, /تشمل المخزون المؤرشف/);
      if (role === "ADMIN") assert.match(document.body.textContent, /٧٫٧٥|7\.75/);
      else {
        assert.match(document.body.textContent, /للمصرّح لهم/);
        assert.doesNotMatch(document.body.textContent, /٧٫٧٥|7\.75/);
      }
    } finally {
      await h.cleanup();
    }
  }
});
