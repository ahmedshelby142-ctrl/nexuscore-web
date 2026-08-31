/**
 * Excel import → opening stock. The §1.3 scenario for the importer.
 *
 * A shop installs the app and imports its real inventory: 3 products at
 * 40 / 10 / 5. Every number below comes from the REAL production functions —
 * the real .xlsx is written and read with the same `xlsx` library the screen
 * uses, parsed by `parseImportRows`, and turned into events by
 * `openingBalanceOf` + `buildOpeningBalanceLines`, the same builder the
 * product form's "الكمية الموجودة حالياً" writes through.
 *
 * The bug this locks down: the importer used to write the dead `quantity`
 * field on the product record, which nothing reads for stock, so an imported
 * shop opened at zero.
 *
 *     node --test scripts/check_product_import.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

import {
  parseImportRows,
  openingBalanceOf,
  findImportedProduct,
} from "../src/lib/productImport.ts";
import { buildOpeningBalanceLines } from "../src/lib/ledger/audit.ts";
import { buildSaleLines } from "../src/lib/ledger/sales.ts";

/** The sheet a real shop uploads, written with the template's Arabic headers. */
function sheetBuffer(rows) {
  const wb = XLSX.utils.book_new();
  const aoa = [
    ["الباركود", "اسم المنتج", "القسم", "سعر الشراء", "سعر البيع قطاعي", "سعر البيع جملة", "الكمية الحالية"],
    ...rows,
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "نموذج استيراد");
  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
}

const SHEET = [
  ["BC-001", "حذاء رياضي", "أحذية", 600, 1000, 900, 40],
  ["BC-002", "كوباية", "أدوات منزلية", 15, 40, 30, 10],
  ["BC-003", "شاحن سريع", "إلكترونيات", 120, 250, 200, 5],
];

/** Read the sheet back exactly as the import screen does. */
function readSheet() {
  const wb = XLSX.read(sheetBuffer(SHEET), { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return parseImportRows(XLSX.utils.sheet_to_json(ws, { defval: "" }));
}

/**
 * Runs the import the way the screen does: skip rows that match a registered
 * product, otherwise register and append ONE opening-balance event.
 * Returns the events; `products` is mutated like the store would be.
 */
function runImport(rows, products) {
  const events = [];
  for (const row of rows) {
    if (findImportedProduct(products, row)) continue;
    const product = { id: `p-${row.sku}`, sku: row.sku, barcode: row.sku, name: row.name };
    products.push(product);
    const opening = openingBalanceOf(row);
    if (opening.quantity <= 0) continue;
    events.push({
      kind: "stock_adjustment",
      refType: "opening_balance",
      lines: buildOpeningBalanceLines({ productId: product.id, ...opening }),
    });
  }
  return events;
}

/** What `balances({ account: "stock" })` sums, per product. */
const stockOf = (events, productId) =>
  events
    .flatMap((e) => e.lines)
    .filter((l) => l.account === "stock" && l.subjectId === productId)
    .reduce((sum, l) => sum + (l.qty ?? 0), 0);

test("importing 40/10/5 gives each product that stock, with no توريد", () => {
  const rows = readSheet();
  assert.equal(rows.length, 3, "three rows read off the sheet");
  assert.deepEqual(
    rows.map((r) => r.stock_qty),
    [40, 10, 5],
    "the quantity column is read, not ignored",
  );

  const products = [];
  const events = runImport(rows, products);

  assert.equal(events.length, 3, "ONE event per row that has a quantity");
  for (const e of events) {
    assert.equal(e.kind, "stock_adjustment");
    assert.equal(e.refType, "opening_balance", "user-asserted opening stock, not a purchase");
    assert.equal(e.lines.length, 1, "one stock line — an opening balance owes nobody anything");
    assert.equal(e.lines[0].account, "stock");
  }
  assert.equal(
    events.filter((e) => e.kind === "purchase").length,
    0,
    "no توريد was invented to carry the stock",
  );

  // The number the POS, the products screen and the warehouse all read.
  assert.equal(stockOf(events, "p-BC-001"), 40);
  assert.equal(stockOf(events, "p-BC-002"), 10);
  assert.equal(stockOf(events, "p-BC-003"), 5);
});

test("the opening balance carries the sheet's purchase price as its cost", () => {
  const events = runImport(readSheet(), []);
  const shoe = events[0].lines[0];
  assert.equal(shoe.qty, 40);
  assert.equal(shoe.amount, 40 * 600, "40 units valued at the sheet's 600 each");
  // costOf = amount / qty — the same weighted average a توريد feeds.
  assert.equal(shoe.amount / shoe.qty, 600);
});

test("re-importing the same sheet writes nothing — stock is not doubled", () => {
  const products = [];
  const first = runImport(readSheet(), products);
  const second = runImport(readSheet(), products);

  assert.equal(first.length, 3);
  assert.equal(second.length, 0, "every row matched a registered product");
  assert.equal(products.length, 3, "and no duplicate products were created");

  const all = [...first, ...second];
  assert.equal(stockOf(all, "p-BC-001"), 40, "still 40, not 80");
  assert.equal(stockOf(all, "p-BC-002"), 10);
  assert.equal(stockOf(all, "p-BC-003"), 5);
});

test("a row with no quantity writes no event — that product starts at zero", () => {
  const rows = parseImportRows([
    { الباركود: "BC-009", "اسم المنتج": "منتج بدون كمية", "الكمية الحالية": "" },
  ]);
  assert.equal(openingBalanceOf(rows[0]).quantity, 0);
  assert.equal(runImport(rows, []).length, 0);
});

test("POS sells out of the imported stock and it comes down", () => {
  const events = runImport(readSheet(), []);
  // Sell 3 of the 40, costed at the opening balance's own cost.
  const sale = {
    lines: buildSaleLines({
      items: [{ productId: "p-BC-001", quantity: 3, unitPrice: 1000, unitCost: 600 }],
      wallet: "inStoreSafe",
    }),
  };
  assert.equal(stockOf([...events, sale], "p-BC-001"), 37, "40 imported − 3 sold");
});
