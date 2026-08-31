/**
 * Reading a shop's product sheet.
 *
 * Pure: a sheet row in, a decision out. No React, no store, no ledger — which
 * is what lets `scripts/check_product_import.mjs` run the REAL parser and the
 * REAL opening-balance rule over a REAL .xlsx file instead of a copy of them.
 *
 * The quantity column is the whole point of the file for a shop importing its
 * existing inventory, so it is read here and handed to `appendOpeningBalance`
 * as one event per row — never written onto the product record.
 */

/** One row of the import sheet, coerced. */
export interface ImportRow {
  sku: string;
  name: string;
  category: string;
  purchase_price: number;
  retail_price: number;
  wholesale_price: number;
  stock_qty: number;
  variants_raw: string;
}

/**
 * Sheet header → field. Both the English keys and the Arabic labels of the
 * template, because owners rename columns and export from other systems.
 */
const HEADER_MAP: Record<string, keyof ImportRow> = {
  sku: "sku",
  الباركود: "sku",
  name: "name",
  "اسم المنتج": "name",
  category: "category",
  القسم: "category",
  purchase_price: "purchase_price",
  "سعر الشراء": "purchase_price",
  retail_price: "retail_price",
  "سعر البيع قطاعي": "retail_price",
  wholesale_price: "wholesale_price",
  "سعر البيع جملة": "wholesale_price",
  stock_qty: "stock_qty",
  "الكمية الحالية": "stock_qty",
  الكمية: "stock_qty",
  "درجات الألوان (الاسم:الكمية,الاسم:الكمية)": "variants_raw",
  variants_raw: "variants_raw",
};

const TEXT_FIELDS = ["sku", "name", "category", "variants_raw"] as const;

function toNumber(val: unknown): number {
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;
  if (typeof val === "string") return Number(val.trim().replace(/^[+,]/, "")) || 0;
  return 0;
}

function toStr(val: unknown): string {
  if (typeof val === "string") return val.trim();
  if (typeof val === "number") return String(val);
  return "";
}

const emptyRow = (): ImportRow => ({
  sku: "",
  name: "",
  category: "",
  purchase_price: 0,
  retail_price: 0,
  wholesale_price: 0,
  stock_qty: 0,
  variants_raw: "",
});

/** Sheet rows (as `XLSX.utils.sheet_to_json` gives them) → typed rows. */
export function parseImportRows(raw: Record<string, unknown>[]): ImportRow[] {
  return raw.map((rawRow) => {
    const row = emptyRow();
    for (const [header, value] of Object.entries(rawRow)) {
      const field = HEADER_MAP[header.trim()];
      if (!field) continue;
      if ((TEXT_FIELDS as readonly string[]).includes(field)) {
        (row[field] as string) = toStr(value);
      } else {
        (row[field] as number) = toNumber(value);
      }
    }
    return row;
  });
}

/**
 * The opening stock this row asserts, ready for `appendOpeningBalance`.
 *
 * Whole units only — half a shoe on a shelf is a typo — and a negative price
 * on a sheet is treated as no price rather than rejecting the whole import.
 * A row with no quantity returns 0, and no event gets written for it.
 */
export function openingBalanceOf(row: ImportRow): { quantity: number; unitCost: number } {
  return {
    quantity: Math.max(0, Math.floor(row.stock_qty || 0)),
    unitCost: Math.max(0, row.purchase_price || 0),
  };
}

/**
 * The already-registered product this row refers to, if any.
 *
 * Re-importing the same sheet must not double the shelf. A matched row updates
 * details and writes NO second opening balance — the same guard the product
 * form applies on edit. Rows with no barcode/SKU can never match: they get a
 * generated one and are new products by definition.
 */
export function findImportedProduct<T extends { sku: string; barcode?: string }>(
  products: T[],
  row: ImportRow,
): T | undefined {
  const key = row.sku.trim();
  if (!key) return undefined;
  return products.find((p) => p.barcode?.trim() === key || p.sku.trim() === key);
}
