import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { performance } from "node:perf_hooks";
import {
  buildImportPlan,
  importProductId,
  IMPORT_LIMIT,
} from "../src/lib/productImportWorkflow.ts";
import { cloudErrorMessage } from "../src/lib/cloudError.ts";
import { uiHarness } from "./helpers/ui-harness.mjs";
const headers = ["sku", "name", "purchase_price", "retail_price", "stock_qty", "variants_raw"];
const good = ["HOTFIX-1", "قميص", 1.25, 2.55, 3, "أحمر / M:2, أزرق / L:1"];
const plan = () => buildImportPlan([headers, good]);
for (const format of ["xlsx", "biff8", "csv"])
  test(
    "real " +
      format +
      " Arabic/English workbook parses with exact decimals, variants and physical row numbers",
    () => {
      const w = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet([headers, [], good]), "Products");
      const b =
          format === "csv"
            ? Buffer.from(XLSX.utils.sheet_to_csv(w.Sheets.Products), "utf8")
            : XLSX.write(w, { bookType: format, type: "buffer" }),
        wb = XLSX.read(b, { type: "buffer", codepage: 65001 });
      const p = buildImportPlan(
        XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
          header: 1,
          defval: "",
          blankrows: true,
        }),
      );
      assert.equal(p.errors.length, 0);
      assert.equal(p.rows.length, 1);
      assert.equal(p.rows[0].excelRow, 3);
      assert.equal(p.rows[0].purchase_price, 1.25);
      assert.equal(p.rows[0].retail_price, 2.55);
      assert.equal(p.rows[0].stock_qty, 3);
      assert.deepEqual(p.rows[0].variants, [
        { name: "أحمر / M", stock: 2 },
        { name: "أزرق / L", stock: 1 },
      ]);
    },
  );
test("legacy Arabic template, BOM, optional blanks and Arabic numbers remain supported", () => {
  const p = buildImportPlan([
    ["\uFEFFالباركود", "اسم المنتج", "سعر الشراء", "الكمية الحالية"],
    ["001234", "حذاء", "١٢٫٣٤", "٢"],
    [],
    ["A", "كوب", "", ""],
  ]);
  assert.equal(p.errors.length, 0);
  assert.equal(p.rows[0].sku, "001234");
  assert.equal(p.rows[0].purchase_price, 12.34);
  assert.equal(p.rows[1].stock_qty, 0);
});
for (const [label, matrix] of [
  ["missing name column", [["wrong"], ["product"]]],
  ["missing name", [headers, ["A", ""]]],
  ["invalid price", [headers, ["A", "name", "ABC"]]],
  ["fractional quantity", [headers, ["A", "name", 1, 2, 1.5]]],
  ["negative price", [headers, ["A", "name", -1]]],
  ["fractional piastre", [headers, ["A", "name", 1.234]]],
  ["duplicate code", [headers, good, good]],
  ["variant mismatch", [headers, ["A", "name", 1, 2, 5, "red:2"]]],
  ["invalid variant qty", [headers, ["A", "name", 1, 2, 2, "red:2x"]]],
  [
    "ambiguous mapped headers",
    [
      ["name", "اسم المنتج"],
      ["one", "two"],
    ],
  ],
  ["empty file", []],
])
  test("validation rejects " + label + " before any write", () =>
    assert.ok(buildImportPlan(matrix).errors.length),
  );
test("existing SKU/barcode conflicts are visible and never update the catalog", () => {
  const p = buildImportPlan([headers, good], [{ sku: "another", barcode: "HOTFIX-1" }]);
  assert.equal(p.duplicates, 1);
  assert.match(p.errors[0].message, /لن يتم تعديل/);
});
test("identity is stable across same-file retries and isolated by tenant", async () => {
  const row = plan().rows[0],
    id = await importProductId("store-a", row);
  assert.equal(id, await importProductId("store-a", structuredClone(row)));
  assert.notEqual(id, await importProductId("store-b", row));
});
for (const size of [3, 200, IMPORT_LIMIT])
  test("bounded workbook " + size + " products validates all rows within a measured budget", () => {
    const rows = Array.from({ length: size }, (_, i) => [
      "SKU-" + i,
      "Product " + i,
      1.25,
      2.55,
      3,
      "red:3",
    ]);
    const start = performance.now();
    const p = buildImportPlan([headers, ...rows]);
    assert.equal(p.rows.length, size);
    assert.equal(p.errors.length, 0);
    assert.ok(performance.now() - start < 3000);
  });
test("oversized input is rejected instead of silently truncating", () =>
  assert.ok(
    buildImportPlan([
      headers,
      ...Array.from({ length: IMPORT_LIMIT + 1 }, (_, i) => ["P" + i, "Product"]),
    ]).errors.some((e) => /الحد الأقصى/.test(e.message)),
  ));
for (const [input, expected] of [
  [{ code: "42501", message: "SQL private secret" }, /صلاحية/],
  [{ status: 401 }, /انتهت جلسة/],
  [{ code: "42703" }, /عدم توافق/],
  [{ status: 429 }, /مشغول/],
  [{ code: "57014" }, /مهلة/],
  [{ message: "Failed to fetch" }, /الاتصال/],
  [{ message: "internal SQL secret" }, /تعذّر تحميل المنتجات/],
])
  test("honest non-secret cloud classification " + JSON.stringify(input), () => {
    const message = cloudErrorMessage(input, "المنتجات");
    assert.match(message, expected);
    assert.doesNotMatch(message, /SQL|secret/);
  });

function importHarness(options = {}) {
  let saved = [],
    existing = options.existing ?? [],
    recoverCalls = 0;
  const h = uiHarness({
    "@/store/useAuthStore": {
      useAuthStore: {
        getState: () => ({ permissionsVerified: true, userRole: options.role ?? "ADMIN" }),
      },
    },
    "@/store/useBusinessStore": { useBusinessStore: { setState() {} } },
    "@/services/api/storeContext": { getSyncIdentity: async () => ({ storeId: "tenant-a" }) },
    "@/services/operationalSource": { captureReadAuthority: () => 1, assertReadAuthority() {} },
    "@/services/cloudData": { cloudList: async () => existing },
    "./catalogStockCommand": {
      resolvePendingCatalog: async () => {
        recoverCalls++;
      },
      saveCatalogProduct: async (fields, o) => {
        if (options.failAt === saved.length) throw { code: "42501" };
        saved.push({ fields, o });
        existing.push({ id: o.createId, sku: fields.sku, barcode: fields.barcode });
        return existing.at(-1);
      },
    },
  });
  return {
    h,
    saved,
    get recovered() {
      return recoverCalls;
    },
    run: (p = plan()) =>
      h.load("src/lib/productImportCommand.ts").executeProductImport(p, () => {}),
  };
}
test("actual import controller uses authoritative create-only stock command, exact costs; replay acknowledges old IDs without any writes", async () => {
  const f = importHarness();
  try {
    const r = await f.run();
    assert.equal(r.created, 1);
    assert.equal(r.units, 3);
    assert.equal(f.saved[0].o.quantity, 3);
    assert.equal(f.saved[0].o.unitCost, 1.25);
    assert.equal(f.saved[0].fields.unitPrice, 2.55);
    assert.equal(f.saved[0].o.existing, undefined);
    assert.equal((await f.run()).recovered, 1);
    assert.equal(f.saved.length, 1);
  } finally {
    await f.h.cleanup();
  }
});
test("authoritative duplicate preflight prevents ALL writes including rows before the conflict", async () => {
  const p = buildImportPlan([headers, ["NEW", "first"], good]),
    f = importHarness({ existing: [{ id: "old", sku: "HOTFIX-1", quantity: 99 }] });
  try {
    const r = await f.run(p);
    assert.equal(r.created, 0);
    assert.equal(f.saved.length, 0);
    assert.equal(r.failedRow, 3);
    assert.match(r.error, /لن يتغير/);
  } finally {
    await f.h.cleanup();
  }
});
test("partial failure reports acknowledged count and exact Excel row; retry skips committed row and resumes safely", async () => {
  const opts = { failAt: 1 },
    f = importHarness(opts),
    p = buildImportPlan([headers, good, ["NEXT", "second", 2, 3, 1]]);
  try {
    let r = await f.run(p);
    assert.equal(r.created, 1);
    assert.equal(r.failedRow, 3);
    assert.match(r.error, /صلاحية/);
    opts.failAt = undefined;
    r = await f.run(p);
    assert.equal(r.created, 1);
    assert.equal(r.recovered, 1);
    assert.equal(f.saved.length, 2);
  } finally {
    await f.h.cleanup();
  }
});
test("invalid file and unauthorized role never reach a business writer", async () => {
  const f = importHarness({ role: "CASHIER_ONLY" });
  try {
    assert.equal((await f.run()).created, 0);
    assert.equal((await f.run(buildImportPlan([["bad"]]))).created, 0);
    assert.equal(f.saved.length, 0);
  } finally {
    await f.h.cleanup();
  }
});

test("actual React upload/preview/confirmation never submits a parent form; double-click cannot repeat stock and selected file blocks PWA reload", async () => {
  let submits = 0,
    writes = 0,
    release;
  const actualPlan = plan();
  const h = uiHarness({
    "@/store/useAuthStore": {
      useAuthStore: (sel) => sel({ userRole: "ADMIN", accessRevision: 1 }),
    },
    "@/services/cloudData": { cloudList: async () => [] },
    "@/services/api/storeContext": { getSyncIdentity: async () => ({ storeId: "ui-synthetic" }) },
    "@/lib/productImportFile": {
      readProductFile: async () => actualPlan,
      productTemplate: () => new Uint8Array(),
    },
    "@/lib/productImportCommand": {
      executeProductImport: async () => {
        writes++;
        return new Promise((r) => (release = () => r({ created: 1, recovered: 0, units: 3 })));
      },
    },
  });
  try {
    const C = h.load("src/components/products/BulkImportProduct.tsx").BulkImportProduct;
    const u = await h.render(() =>
      h.React.createElement(
        "form",
        {
          onSubmit: (e) => {
            e.preventDefault();
            submits++;
          },
        },
        h.React.createElement(C, { onClose() {} }),
      ),
    );
    const input = h.getByLabelText(document.body, "ملف المنتجات");
    await h.perform(() =>
      u.upload(
        input,
        new window.File(["synthetic"], "products.xlsx", {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      ),
    );
    assert.match(document.body.textContent, /صالح مبدئيًا/);
    assert.equal(writes, 0);
    assert.ok(document.querySelector('[data-pwa-unsaved="true"]'));
    const button = h.getByRole(document.body, "button", { name: /تأكيد وحفظ/ });
    assert.equal(button.type, "button");
    await h.perform(() => {
      button.click();
      button.click();
    });
    assert.equal(writes, 1);
    assert.equal(submits, 0);
    await h.perform(() => release());
    assert.match(document.body.textContent, /اكتمل الاستيراد/);
  } finally {
    await h.cleanup();
  }
});

test("cloud hydration shares overlapping requests, keeps healthy data on reconnect failure and never stamps partial failure as successful sync", async () => {
  let fail = false,
    calls = 0;
  const stores = {};
  for (const [mod, name] of [
    ["useBusinessStore", "useBusinessStore"],
    ["useCourierStore", "useCourierStore"],
    ["useCustomerStore", "useCustomerStore"],
    ["useBranchStore", "useBranchStore"],
    ["useOrderStore", "useOrderStore"],
    ["useFinancialStore", "useFinancialStore"],
    ["useShippingRatesStore", "useShippingRatesStore"],
  ]) {
    const state = {};
    stores["@/store/" + mod] = {
      [name]: { getState: () => state, setState: (patch) => Object.assign(state, patch) },
    };
  }
  const auth = {
    session: { user: { id: "verified-user" } },
    userRole: "ADMIN",
    isAuthenticated: true,
    permissionsVerified: true,
    accessRevision: 1,
  };
  const toasts = [];
  const h = uiHarness({
    ...stores,
    "@/store/useAuthStore": { useAuthStore: { getState: () => auth } },
    "@/lib/ledger/stockSnapshot": { clearStockSnapshot() {} },
    "@/store/useSettingsStore": {
      useSettingsStore: {
        getState: () => ({ pullSettings: async () => {}, pullWholesaleFeature: async () => {} }),
      },
    },
    "./cloudData": {
      cloudList: async (table) => {
        calls++;
        await new Promise((r) => setTimeout(r, 1));
        if (fail && table === "products") throw { code: "42501", message: "private SQL" };
        return table === "products" ? [{ id: "persisted-product" }] : [];
      },
    },
    sonner: { toast: { error: (message, opts) => toasts.push({ message, opts }), dismiss() {} } },
  });
  try {
    const { hydrateAll } = h.load("src/services/cloudHydrate.ts"),
      status = h.load("src/store/useSyncStatus.ts").useSyncStatus;
    const [a, b] = await Promise.all([hydrateAll(), hydrateAll()]);
    assert.deepEqual(a, b);
    assert.equal(calls, Object.keys(a.loaded).length);
    const time = status.getState().lastSyncAt;
    assert.ok(time);
    fail = true;
    const result = await hydrateAll();
    assert.match(result.failed.products, /صلاحية/);
    assert.equal(status.getState().lastSyncAt, time);
    assert.equal(status.getState().syncing, false);
    assert.equal(status.getState().tables.products, "failed");
    assert.deepEqual(stores["@/store/useBusinessStore"].useBusinessStore.getState().products, [
      { id: "persisted-product" },
    ]);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].opts.id, "cloud-hydration-error");
    assert.doesNotMatch(toasts[0].message, /SQL|private|الإنترنت/);
    fail = false;
    await hydrateAll();
    assert.equal(status.getState().tables.products, "ready");
  } finally {
    await h.cleanup();
  }
});

test("real FileReader accepts XLSX/XLS/UTF-8 CSV and rejects unsupported/oversize files before parsing", async () => {
  const h = uiHarness({});
  const previous = globalThis.FileReader;
  globalThis.FileReader = window.FileReader;
  try {
    const { readProductFile } = h.load("src/lib/productImportFile.ts");
    for (const format of ["xlsx", "biff8", "csv"]) {
      const wb = XLSX.utils.book_new(),
        sheet = XLSX.utils.aoa_to_sheet([headers, good]);
      XLSX.utils.book_append_sheet(wb, sheet, "Products");
      const bytes =
        format === "csv"
          ? Buffer.from(XLSX.utils.sheet_to_csv(sheet), "utf8")
          : XLSX.write(wb, { bookType: format, type: "buffer" });
      const p = await readProductFile(
        new window.File([bytes], "synthetic." + (format === "biff8" ? "xls" : format)),
      );
      assert.equal(p.errors.length, 0);
      assert.equal(p.rows[0].name, "قميص");
      assert.equal(p.rows[0].purchase_price, 1.25);
    }
    await assert.rejects(() => readProductFile({ name: "catalog.exe", size: 2 }), /XLSX/);
    await assert.rejects(() => readProductFile({ name: "catalog.xlsx", size: 6000000 }), /5 MB/);
    const wb = XLSX.utils.book_new(),
      sheet = XLSX.utils.aoa_to_sheet([headers, good]);
    sheet["!ref"] = "A1:F2005";
    XLSX.utils.book_append_sheet(wb, sheet, "Products");
    const p = await readProductFile(
      new window.File([XLSX.write(wb, { type: "buffer", bookType: "xlsx" })], "too-many.xlsx"),
    );
    assert.ok(p.errors.length);
    assert.equal(p.rows.length, 0);
  } finally {
    if (previous === undefined) delete globalThis.FileReader;
    else globalThis.FileReader = previous;
    await h.cleanup();
  }
});

test("stale optional chunk cannot reload over an import preview, while clean-page recovery remains installed", async () => {
  const h = uiHarness({});
  const old = globalThis.sessionStorage;
  globalThis.sessionStorage = window.sessionStorage;
  try {
    const { installStaleChunkRecovery } = h.load("src/lib/staleChunkRecovery.ts");
    installStaleChunkRecovery();
    const section = document.createElement("section");
    section.dataset.pwaUnsaved = "true";
    document.body.append(section);
    const event = new window.Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(event);
    assert.equal(sessionStorage.getItem("nexus-chunk-reload"), null);
    assert.equal(event.defaultPrevented, false);
  } finally {
    if (old === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = old;
    await h.cleanup();
  }
});

test("retry preview recognizes only deterministic same-file products; unrelated existing codes remain blocking", async () => {
  const { checkImportDuplicates } = await import("../src/lib/productImportWorkflow.ts");
  const p = plan(),
    id = await importProductId("store-a", p.rows[0]),
    ownIds = new Map([[p.rows[0].excelRow, id]]);
  const resumed = checkImportDuplicates(p, [{ id, sku: p.rows[0].sku }], ownIds);
  assert.equal(resumed.errors.length, 0);
  assert.equal(resumed.alreadyImported, 1);
  const conflict = checkImportDuplicates(p, [{ id: "unrelated", sku: p.rows[0].sku }], ownIds);
  assert.equal(conflict.errors.length, 1);
  assert.equal(conflict.duplicates, 1);
});

test("preview from a different store is refused before recovery or any import write", async () => {
  const f = importHarness();
  try {
    const run = f.h.load("src/lib/productImportCommand.ts").executeProductImport;
    const r = await run(plan(), () => {}, "other-tenant");
    assert.equal(r.created, 0);
    assert.match(r.error, /صلاحيات الجلسة/);
    assert.equal(f.saved.length, 0);
    assert.equal(f.recovered, 0);
  } finally {
    await f.h.cleanup();
  }
});
