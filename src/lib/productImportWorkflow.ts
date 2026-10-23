import type { ImportRow } from "./productImport";

export const IMPORT_LIMIT = 2000;
export const IMPORT_BYTES = 5 * 1024 * 1024;
export type ImportProductRow = ImportRow & {
  excelRow: number;
  barcode: string;
  variants: { name: string; stock: number }[];
  min_stock_level?: number;
  separateIdentifiers?: boolean;
  disposition?: "new" | "existing" | "recovered" | "conflict";
  matchedProductId?: string;
};
export type ImportPlan = {
  rows: ImportProductRow[];
  errors: { row: number; message: string; kind?: "validation" | "conflict" | "formula" }[];
  duplicates: number;
  alreadyImported?: number;
  existingToSkip?: number;
  currentProductCount?: number;
  fileDuplicates?: number;
};
const aliases: Record<string, string> = {
  sku: "sku",
  الباركود: "sku",
  "كود المنتج": "sku",
  "sku / كود المنتج": "sku",
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
  "تكلفة الوحدة": "purchase_price",
  retail_price: "retail_price",
  "retail price": "retail_price",
  "سعر البيع": "retail_price",
  "سعر البيع قطاعي": "retail_price",
  "سعر البيع القطاعي": "retail_price",
  wholesale_price: "wholesale_price",
  "سعر البيع جملة": "wholesale_price",
  "سعر الجملة (اختياري)": "wholesale_price",
  stock_qty: "stock_qty",
  quantity: "stock_qty",
  الكمية: "stock_qty",
  "الحد الأدنى للمخزون": "min_stock_level",
  min_stock_level: "min_stock_level",
  "الكمية الحالية": "stock_qty",
  variants_raw: "variants_raw",
  variants: "variants_raw",
  "الدرجات / الألوان والمقاسات (الاسم:الكمية)": "variants_raw",
  "درجات الألوان (الاسم:الكمية,الاسم:الكمية)": "variants_raw",
};
const text = (v: unknown) => String(v ?? "").trim();
/** Same ASCII case/digit/NFKC policy as financial_private.catalog_code.
 * Codes remain TEXT: no zero stripping or product-name matching. */
export const catalogCode = (v: unknown) =>
  text(v)
    .normalize("NFKC")
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 1632))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 1776))
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
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
  // Old Arabic template used الباركود for its single SKU/code column.
  // The new template has a separate explicit SKU and barcode; preserve both.
  const hasSeparateSku = matrix[first].some(
    (h) => importHeader(h) === "sku" && text(h) !== "الباركود",
  );
  if (hasSeparateSku)
    matrix[first].forEach((h, i) => {
      if (text(h) === "الباركود") headers[i] = "barcode";
    });
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
  let totalValuePiastres = 0;
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
    if (headers.includes("min_stock_level")) row.min_stock_level = 0;
    if (
      hasSeparateSku &&
      text(raw.sku) &&
      text(raw.barcode) &&
      catalogCode(raw.sku) !== catalogCode(raw.barcode)
    )
      row.separateIdentifiers = true;
    try {
      if ([raw.sku, raw.barcode].some((v) => typeof v === "number" && !Number.isSafeInteger(v)))
        throw Error("الباركود طويل أو غير صحيح رقميًا؛ احفظ عمود الباركود كنص في Excel");
      if (!row.name) throw Error("اسم المنتج مفقود");
      if (!row.sku && !row.barcode)
        throw Error("أدخل SKU / كود المنتج أو الباركود كنص؛ لا يمكن مطابقة صف بلا معرّف بأمان");
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
      if (row.min_stock_level !== undefined)
        row.min_stock_level = numeric(raw.min_stock_level, "الحد الأدنى للمخزون", true);
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
      const valuePiastres = Math.round(row.purchase_price * 100) * row.stock_qty;
      if (!Number.isSafeInteger(totalValuePiastres + valuePiastres))
        throw Error("إجمالي قيمة الملف يتجاوز الحساب الدقيق؛ قسّم الملف قبل الحفظ");
      totalValuePiastres += valuePiastres;
      const rowCodes = [...new Set([row.sku, row.barcode].map(catalogCode).filter(Boolean))];
      if (rowCodes.some((code) => codes.has(code))) {
        plan.duplicates++;
        throw Error("باركود / SKU مكرر داخل الملف؛ راجع الصفوف المتكررة قبل الحفظ");
      }
      rowCodes.forEach((code) => codes.add(code));
    } catch (e) {
      plan.errors.push({ row: i + 1, message: (e as Error).message });
    }
    plan.rows.push(row);
  }
  if (!plan.rows.length && !plan.errors.length)
    plan.errors.push({ row: first + 2, message: "لا توجد صفوف منتجات" });
  return products.length ? checkImportDuplicates(plan, products) : plan;
}

export function checkImportDuplicates(
  plan: ImportPlan,
  products: { sku?: string; barcode?: string; id?: string }[],
  ownIds = new Map<number, string>(),
): ImportPlan {
  const codes = new Map<string, typeof products>();
  for (const p of products)
    for (const code of new Set([catalogCode(p.sku), catalogCode(p.barcode)].filter(Boolean)))
      codes.set(code, [...(codes.get(code) ?? []), p]);
  const errors = plan.errors.filter((e) => e.kind !== "conflict");
  const existingIds = new Set(products.map((p) => p.id));
  let recovered = 0,
    skipped = 0,
    conflicts = 0;
  const rows = plan.rows.map((source) => {
    const row: ImportProductRow = { ...source, disposition: "new", matchedProductId: undefined };
    if (errors.some((e) => e.row === row.excelRow)) return row;
    const matches = [
      ...new Set([row.sku, row.barcode].flatMap((code) => codes.get(catalogCode(code)) ?? [])),
    ];
    const own = ownIds.get(row.excelRow);
    if (own && existingIds.has(own) && matches.every((p) => p.id === own)) {
      row.disposition = "recovered";
      row.matchedProductId = own;
      recovered++;
      return row;
    }
    if (
      matches.length > 1 ||
      (matches.length === 1 &&
        row.separateIdentifiers &&
        (catalogCode(row.sku) !== catalogCode(matches[0].sku) ||
          (row.barcode && catalogCode(row.barcode) !== catalogCode(matches[0].barcode))))
    ) {
      row.disposition = "conflict";
      conflicts++;
      errors.push({
        row: row.excelRow,
        kind: "conflict",
        message: "تعارض SKU / الباركود مع هوية منتج موجود؛ لن يتم تعديل أي منتج. راجع المعرّفين.",
      });
    } else if (matches.length === 1) {
      row.disposition = "existing";
      row.matchedProductId = matches[0].id;
      skipped++;
    }
    return row;
  });
  const fileDuplicates = plan.fileDuplicates ?? plan.duplicates;
  return {
    ...plan,
    rows,
    errors,
    fileDuplicates,
    alreadyImported: recovered,
    existingToSkip: skipped,
    currentProductCount: products.length,
    duplicates: fileDuplicates + conflicts,
  };
}

export function summarizeImport(plan: ImportPlan) {
  const invalidRows = new Set(
    plan.rows.filter((r) => plan.errors.some((e) => e.row === r.excelRow)).map((r) => r.excelRow),
  );
  const fresh = plan.rows.filter(
    (r) => !invalidRows.has(r.excelRow) && (!r.disposition || r.disposition === "new"),
  );
  return {
    total: plan.rows.length,
    invalid: invalidRows.size,
    headerErrors: plan.errors.filter((e) => !plan.rows.some((r) => r.excelRow === e.row)).length,
    newProducts: fresh.length,
    existing: plan.existingToSkip ?? 0,
    recovered: plan.alreadyImported ?? 0,
    conflicts: plan.rows.filter((r) => r.disposition === "conflict").length,
    resultingCount: (plan.currentProductCount ?? 0) + fresh.length,
    units: fresh.reduce((s, r) => s + r.stock_qty, 0),
    valuePiastres: fresh.reduce((s, r) => s + Math.round(r.purchase_price * 100) * r.stock_qty, 0),
  };
}

/** Stable create-only identity across retries/reloads/tabs of the same file data.
 * The database catalog command still validates tenant, role, SKU and stock. */
export async function importProductId(storeId: string, row: ImportProductRow): Promise<string> {
  // Keep v1 identities stable when adding preview-only classification fields.
  const identity: Record<string, unknown> = {
    excelRow: row.excelRow,
    sku: row.sku,
    barcode: row.barcode,
    name: row.name,
    category: row.category,
    purchase_price: row.purchase_price,
    retail_price: row.retail_price,
    wholesale_price: row.wholesale_price,
    stock_qty: row.stock_qty,
    variants_raw: row.variants_raw,
    variants: row.variants,
  };
  if (row.min_stock_level !== undefined) identity.min_stock_level = row.min_stock_level;
  const data = new TextEncoder().encode(JSON.stringify(["catalog-import-v1", storeId, identity]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  digest[6] = (digest[6] & 15) | 0x50;
  digest[8] = (digest[8] & 63) | 0x80;
  const hex = [...digest.slice(0, 16)].map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
