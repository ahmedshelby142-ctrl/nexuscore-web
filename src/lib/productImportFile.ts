import * as XLSX from "xlsx";
import { buildImportPlan, importHeader, IMPORT_BYTES, IMPORT_LIMIT } from "./productImportWorkflow";

export async function readProductFile(file: File) {
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw Error("اختر ملف XLSX أو XLS أو CSV");
  if (file.size > IMPORT_BYTES) throw Error("حجم الملف أكبر من 5 MB؛ قسّم الملف قبل الاستيراد");
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(Error("تعذّرت قراءة الملف. أعد اختياره من الجهاز."));
    reader.onabort = () => reject(Error("أُلغيت قراءة الملف؛ يمكنك اختياره مجددًا."));
    reader.readAsArrayBuffer(file);
  });
  try {
    const workbook = XLSX.read(buffer, {
      type: "array",
      sheetRows: IMPORT_LIMIT + 3,
      codepage: 65001,
    });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw Error("empty");
    const range = XLSX.utils.decode_range(sheet["!fullref"] || sheet["!ref"] || "A1");
    if (range.e.r > IMPORT_LIMIT || range.e.c > 99)
      return {
        rows: [],
        duplicates: 0,
        errors: [
          {
            row: 1,
            message: `الحد الأقصى ${IMPORT_LIMIT} منتج و100 عمود؛ قسّم الملف واحذف الصفوف المنسّقة الزائدة.`,
          },
        ],
      };
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      blankrows: true,
    });
    const first = matrix.findIndex((row) => row.some((value) => String(value ?? "").trim() !== ""));
    if (first >= 0)
      matrix[first].forEach((header, column) => {
        if (!["sku", "barcode"].includes(importHeader(header))) return;
        for (let row = first + 1; row < matrix.length; row++) {
          const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
          if (cell?.t === "n" && Number.isSafeInteger(cell.v))
            matrix[row][column] = XLSX.utils.format_cell(cell);
        }
      });
    return buildImportPlan(matrix);
  } catch {
    throw Error("تعذّر تحليل الملف. استخدم نموذج المنتجات واحفظه بصيغة XLSX أو XLS أو CSV.");
  }
}

export function productTemplate(): Uint8Array {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    [
      "الباركود",
      "اسم المنتج",
      "القسم",
      "سعر الشراء",
      "سعر البيع قطاعي",
      "سعر البيع جملة",
      "الكمية الحالية",
      "درجات الألوان (الاسم:الكمية,الاسم:الكمية)",
    ],
    ["SKU-001", "منتج تجريبي", "إلكترونيات", 100, 250, 200, 50, "أحمر / M:30, أزرق / L:20"],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "نموذج استيراد");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" });
}
