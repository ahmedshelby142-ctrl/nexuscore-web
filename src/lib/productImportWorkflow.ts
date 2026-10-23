import type { ImportRow } from "./productImport";

export const IMPORT_LIMIT = 2000;
export const IMPORT_BYTES = 5 * 1024 * 1024;
export type ImportProductRow = ImportRow & {
  excelRow: number;
  barcode: string;
  variants: { name: string; stock: number }[];
};
export type ImportPlan = {
  rows: ImportProductRow[];
  errors: { row: number; message: string }[];
  duplicates: number;
  alreadyImported?: number;
};
const aliases: Record<string, string> = {
  sku: "sku",
  الباركود: "sku",
  "كود المنتج": "sku",
  barcode: "barcode",
  name: "name",
  "اسم المنتج": "name",
  "اسم الصنف": "name",
  "product name": "name",
  category: "category",
  القسم: "category",
  التصنيف: "category",
  purchase_price: "purchase_price",
  "purchase price": "purchase_price",
  "سعر الشراء": "purchase_price",
  retail_price: "retail_price",
  "retail price": "retail_price",
  "سعر البيع": "retail_price",
  "سعر البيع قطاعي": "retail_price",
  wholesale_price: "wholesale_price",
  "سعر البيع جملة": "wholesale_price",
  stock_qty: "stock_qty",
  quantity: "stock_qty",
  الكمية: "stock_qty",
  "الكمية الحالية": "stock_qty",
  variants_raw: "variants_raw",
  variants: "variants_raw",
  "درجات الألوان (الاسم:الكمية,الاسم:الكمية)": "variants_raw",
};
const text = (v: unknown) => String(v ?? "").trim();
export const importHeader = (v: unknown) =>
  aliases[
    text(v)
      .replace(/^\uFEFF/, "")
      .replace(/\s+/g, " ")
      .toLowerCase()
  ];
function numeric(v: unknown, label: string, whole = false): number {
  if (v == null || text(v) === "") return 0;
  const normalized = text(v)
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 1632))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 1776))
    .replace(/٫/g, ".")
    .replace(/٬/g, ",");
  // Accept grouping separators only in groups of three, never guess 1,5 as 15.
  const valid = /^\+?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(normalized);
  const n = Number(normalized.replace(/,/g, ""));
  if (
    !valid ||
    !Number.isFinite(n) ||
    n < 0 ||
    n > 100000000 ||
    (whole && !Number.isInteger(n)) ||
    (!whole && Math.abs(n * 100 - Math.round(n * 100)) > 0.00001)
  )
    throw Error(
      `${label}: أدخل ${whole ? "كمية صحيحة غير سالبة" : "مبلغًا صحيحًا بدقة قرشين عشريين"}`,
    );
  return n;
}

/** Pure validation of EVERY populated row before the first business command. */
export function buildImportPlan(
  matrix: unknown[][],
  products: { sku?: string; barcode?: string }[] = [],
): ImportPlan {
  const plan: ImportPlan = { rows: [], errors: [], duplicates: 0 };
  const first = matrix.findIndex((row) => row.some((v) => text(v) !== ""));
  if (first < 0) return { ...plan, errors: [{ row: 1, message: "الملف فارغ" }] };
  const headers = matrix[first].map(importHeader);
  if (!headers.includes("name"))
    plan.errors.push({
      row: first + 1,
      message: "عمود اسم المنتج (name) مطلوب؛ استخدم النموذج الاسترشادي",
    });
  const columns = headers.filter(Boolean);
  if (new Set(columns).size !== columns.length)
    plan.errors.push({
      row: first + 1,
      message: "أعمدة متكررة لنفس الحقل؛ احتفظ بعمود واحد لكل حقل",
    });
  const codes = new Set<string>();
  const existing = new Set(products.flatMap((p) => [text(p.sku), text(p.barcode)]).filter(Boolean));
  for (let i = first + 1; i < matrix.length; i++) {
    const cells = matrix[i];
    if (!cells.some((v) => text(v) !== "")) continue;
    if (plan.rows.length >= IMPORT_LIMIT) {
      plan.errors.push({
        row: i + 1,
        message: `الحد الأقصى ${IMPORT_LIMIT} منتج للملف؛ قسّم الملف`,
      });
      break;
    }
    const raw: Record<string, unknown> = {};
    headers.forEach((field, j) => {
      if (field) raw[field] = cells[j];
    });
    const row: ImportProductRow = {
      excelRow: i + 1,
      sku: text(raw.sku),
      barcode: text(raw.barcode || raw.sku),
      name: text(raw.name),
      category: text(raw.category),
      purchase_price: 0,
      retail_price: 0,
      wholesale_price: 0,
      stock_qty: 0,
      variants_raw: text(raw.variants_raw),
      variants: [],
    };
    try {
      if ([raw.sku, raw.barcode].some((v) => typeof v === "number" && !Number.isSafeInteger(v)))
        throw Error("الباركود طويل أو غير صحيح رقميًا؛ احفظ عمود الباركود كنص في Excel");
      if (!row.name) throw Error("اسم المنتج مفقود");
      for (const key of ["purchase_price", "retail_price", "wholesale_price", "stock_qty"] as const)
        row[key] = numeric(
          raw[key],
          {
            purchase_price: "سعر الشراء",
            retail_price: "سعر البيع",
            wholesale_price: "سعر الجملة",
            stock_qty: "الكمية",
          }[key],
          key === "stock_qty",
        );
      if (row.variants_raw) {
        const names = new Set<string>();
        row.variants = row.variants_raw.split(/[,،]/).map((part) => {
          const split = part.lastIndexOf(":");
          if (split < 1) throw Error("صيغة الأنواع: أحمر / M:2, أزرق / L:3");
          const name = text(part.slice(0, split)),
            stock = numeric(part.slice(split + 1), "كمية النوع", true);
          if (names.has(name) || !name) throw Error("اسم نوع مكرر أو فارغ");
          names.add(name);
          return { name, stock };
        });
        const quantity = row.variants.reduce((sum, v) => sum + v.stock, 0);
        if (text(raw.stock_qty) !== "" && quantity !== row.stock_qty)
          throw Error("مجموع كميات الأنواع لا يساوي الكمية الحالية");
        row.stock_qty = numeric(quantity, "مجموع كميات الأنواع", true);
      }
      if (!Number.isSafeInteger(Math.round(row.purchase_price * 100) * row.stock_qty))
        throw Error("قيمة المخزون كبيرة جدًا للحساب الدقيق؛ قسّم الكمية إلى مستندات أصغر");
      const rowCodes = [...new Set([row.sku, row.barcode].filter(Boolean))];
      if (rowCodes.some((code) => existing.has(code) || codes.has(code))) {
        plan.duplicates++;
        throw Error("باركود / SKU مكرر في الملف أو موجود بالمتجر؛ لن يتم تعديل المنتج الموجود");
      }
      rowCodes.forEach((code) => codes.add(code));
    } catch (e) {
      plan.errors.push({ row: i + 1, message: (e as Error).message });
    }
    plan.rows.push(row);
  }
  if (!plan.rows.length && !plan.errors.length)
    plan.errors.push({ row: first + 2, message: "لا توجد صفوف منتجات" });
  return plan;
}

export function checkImportDuplicates(
  plan: ImportPlan,
  products: { sku?: string; barcode?: string; id?: string }[],
  ownIds = new Map<number, string>(),
): ImportPlan {
  const codes = new Map(
    products.flatMap((p) =>
      [text(p.sku), text(p.barcode)].filter(Boolean).map((code) => [code, p.id] as const),
    ),
  );
  const conflicts = plan.rows.filter(
    (row) =>
      !plan.errors.some((e) => e.row === row.excelRow) &&
      [row.sku, row.barcode].some(
        (code) =>
          code &&
          codes.has(code) &&
          (!ownIds.has(row.excelRow) || codes.get(code) !== ownIds.get(row.excelRow)),
      ),
  );
  const existingIds = new Set(products.map((p) => p.id));
  return {
    ...plan,
    alreadyImported: plan.rows.filter(
      (row) => ownIds.has(row.excelRow) && existingIds.has(ownIds.get(row.excelRow)),
    ).length,
    duplicates: plan.duplicates + conflicts.length,
    errors: [
      ...plan.errors,
      ...conflicts.map((row) => ({
        row: row.excelRow,
        message: "باركود / SKU موجود بالمتجر؛ لن يتم تعديل المنتج الموجود",
      })),
    ],
  };
}

/** Stable create-only identity across retries/reloads/tabs of the same file data.
 * The database catalog command still validates tenant, role, SKU and stock. */
export async function importProductId(storeId: string, row: ImportProductRow): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(["catalog-import-v1", storeId, row]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  digest[6] = (digest[6] & 15) | 0x50;
  digest[8] = (digest[8] & 63) | 0x80;
  const hex = [...digest.slice(0, 16)].map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
