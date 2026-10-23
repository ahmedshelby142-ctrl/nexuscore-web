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
    const plan = buildImportPlan(matrix);
    // XLSX reads cached formula values but never evaluates them. Do not
    // silently accept a stale cached price/quantity as an owner's declaration.
    for (const [address, cell] of Object.entries(sheet))
      if (!address.startsWith("!") && (cell as XLSX.CellObject).f) {
        const row = XLSX.utils.decode_cell(address).r + 1;
        plan.errors.push({
          row,
          kind: "formula",
          message: "توجد معادلة Excel؛ احفظ قيمتها كنص أو رقم ثابت ثم أعد رفع الملف.",
        });
      }
    return plan;
  } catch {
    throw Error("تعذّر تحليل الملف. استخدم نموذج المنتجات واحفظه بصيغة XLSX أو XLS أو CSV.");
  }
}

export function productTemplate(): Uint8Array {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    [
      "اسم المنتج",
      "SKU / كود المنتج",
      "الباركود",
      "التصنيف",
      "سعر البيع القطاعي",
      "سعر الجملة (اختياري)",
      "تكلفة الوحدة",
      "الكمية",
      "الحد الأدنى للمخزون",
      "الدرجات / الألوان والمقاسات (الاسم:الكمية)",
    ],
    [
      "مثال — احذف هذا الصف",
      "SKU-001",
      "000123456789",
      "ملابس",
      2.55,
      0,
      1.25,
      3,
      5,
      "أحمر / M:2, أزرق / L:1",
    ],
    ["مثال صنف بلا مخزون — احذفه", "SKU-002", "000123456790", "عام", 3, 0, 2, 0, 5, ""],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "نموذج استيراد");
  const instructions = XLSX.utils.aoa_to_sheet([
    ["تعليمات إضافة المنتجات الجديدة فقط"],
    [
      "احذف صفوف الأمثلة واكتب منتجاتك. يلزم اسم المنتج وSKU أو باركود ثابت. لا نطابق المنتجات بالاسم.",
    ],
    ["احفظ الأكواد كنص للحفاظ على الأصفار. لا تضع معادلات؛ حوّل النتائج إلى قيم ثابتة."],
    [
      "كل صف صنف رئيسي واحد. الدرجات/الألوان والمقاسات: أحمر / M:2, أزرق / L:1 ومجموعها يساوي كمية الصف.",
    ],
    ["المخطط يدعم اسم الدرجة وكمّيتها، ولا يدعم SKU مستقلًا لكل درجة؛ لا تضف أعمدة غير مدعومة."],
    ["الأسعار والتكلفة بالجنيه بدقة قرشين عشريين، والكميات أعداد صحيحة غير سالبة."],
    [
      "الموجود بالفعل يُتخطى ولا تتغير كميته أو سعره أو تكلفته. تعارض الأكواد أو الأخطاء يوقف الحفظ حتى التصحيح.",
    ],
    [
      "رصيد افتتاحي/مخزون مملوك بالفعل يحتاج اختيارًا وتأكيدًا في المعاينة. الشراء الجديد يُسجل بفاتورة توريد بعد إضافة الصنف بكمية صفر.",
    ],
    ["كمية صفر لا تُنشئ أصل مخزون. راجع إجمالي الأصناف والكمية والقيمة المتوقعة قبل التأكيد."],
    ["القالب القديم والحقول الإنجليزية المدعومة مستمران. حد الملف 2000 صنف و5 MB و100 عمود."],
  ]);
  XLSX.utils.book_append_sheet(workbook, instructions, "تعليمات");
  for (const address of Object.keys(sheet)) if (/^[BC]\d+$/.test(address)) sheet[address].z = "@";
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" });
}

export function productImportRejections(
  plan: import("./productImportWorkflow").ImportPlan,
): Uint8Array {
  const rows = [
    ["صف Excel", "اسم المنتج", "SKU", "الباركود", "سبب الرفض"],
    ...plan.errors.map((e) => {
      const r = plan.rows.find((x) => x.excelRow === e.row);
      return [String(e.row), r?.name ?? "", r?.sku ?? "", r?.barcode ?? "", e.message];
    }),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  // Explicit text cells: rejected names/codes cannot become Excel formulas.
  for (const address of Object.keys(sheet))
    if (!address.startsWith("!")) {
      sheet[address].t = "s";
      delete sheet[address].f;
    }
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "تفاصيل الرفض");
  return XLSX.write(book, { type: "array", bookType: "xlsx" });
}
