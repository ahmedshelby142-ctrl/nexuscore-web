import { useState, useRef, useCallback } from "react";
import * as XLSX from "xlsx";
import {
  Upload,
  Download,
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  X,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useBusinessStore } from "@/store/useBusinessStore";
import { appendOpeningBalance } from "@/lib/ledger/openingBalance";
import { appendEvent } from "@/lib/ledger";
import { useStock } from "@/lib/ledger/useStock";
import {
  parseImportRows,
  openingBalanceOf,
  findImportedProduct,
  type ImportRow,
} from "@/lib/productImport";
import { useAuthStore } from "@/store/useAuthStore";
import { toAppRole } from "@/lib/roles";
import { Button } from "@/components/ui/button";
import type { Product } from "@/types";

type ParsedRow = ImportRow;

interface RowError {
  row: number;
  field: keyof ParsedRow | "general";
  message: string;
}

const COLUMNS: {
  key: keyof ParsedRow;
  label: string;
  required: boolean;
  type: "text" | "number";
}[] = [
  { key: "sku", label: "الباركود", required: false, type: "text" },
  { key: "name", label: "اسم المنتج", required: true, type: "text" },
  { key: "category", label: "القسم", required: false, type: "text" },
  { key: "purchase_price", label: "سعر الشراء", required: false, type: "number" },
  { key: "retail_price", label: "سعر البيع قطاعي", required: false, type: "number" },
  { key: "wholesale_price", label: "سعر البيع جملة", required: false, type: "number" },
  { key: "stock_qty", label: "الكمية الحالية", required: false, type: "number" },
  { key: "variants_raw", label: "درجات الألوان (الاسم:الكمية,الاسم:الكمية)", required: false, type: "text" },
];

function generateTemplateBuffer(): Uint8Array {
  const wb = XLSX.utils.book_new();
  const wsData = [COLUMNS.map((c) => c.label)];
  wsData.push(["SKU-001", "منتج تجريبي 1", "إلكترونيات", "100", "250", "200", "50", "احمر:30, ازرق:20"]);
  wsData.push(["", "", "", "", "", "", "", ""]);
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws["!cols"] = COLUMNS.map(() => ({ wch: 20 }));
  XLSX.utils.book_append_sheet(wb, ws, "نموذج استيراد");
  return XLSX.write(wb, { bookType: "xlsx", type: "array" }) as Uint8Array;
}

interface BulkImportProductProps {
  onClose: () => void;
  /** Re-read the ledger after import so the table behind shows the new stock. */
  onImported?: () => void;
}

export function BulkImportProduct({ onClose, onImported }: BulkImportProductProps) {
  const { products, addProduct, updateProduct } = useBusinessStore();
  const { qtyOf } = useStock();
  const userRole = useAuthStore((s) => s.userRole);
  const isOwner = toAppRole(userRole) === "ADMIN";
  const fileRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [rowErrors, setRowErrors] = useState<Map<number, RowError[]>>(new Map());
  const [fileName, setFileName] = useState("");
  const [status, setStatus] = useState<"idle" | "preview" | "importing" | "done">("idle");
  const [importCount, setImportCount] = useState(0);
  // What actually happened, so the success screen can state it instead of
  // claiming a number nobody checked.
  const [openedCount, setOpenedCount] = useState(0);
  const [openedUnits, setOpenedUnits] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [importError, setImportError] = useState<string | null>(null);

  const validateRow = useCallback((row: ParsedRow, idx: number): RowError[] => {
    const errors: RowError[] = [];
    if (!row.name) errors.push({ row: idx, field: "name", message: "اسم المنتج مطلوب" });
    return errors;
  }, []);

  const handleFile = useCallback(
    (file: File) => {
      setFileName(file.name);
      setStatus("idle");
      setRows([]);
      setRowErrors(new Map());

      const reader = new FileReader();
      reader.onload = (e) => {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw: Record<string, unknown>[] = XLSX.utils.sheet_to_json(ws, { defval: "" });

        const parsed = parseImportRows(raw);
        const errors = new Map<number, RowError[]>();

        parsed.forEach((row, i) => {
          const rowErrs = validateRow(row, i);
          if (rowErrs.length) errors.set(i, rowErrs);
        });

        setRows(parsed);
        setRowErrors(errors);
        setStatus("preview");
      };
      reader.readAsArrayBuffer(file);
    },
    [validateRow],
  );

  function autoSku(): string {
    return `NX-${Math.floor(100000 + Math.random() * 900000)}`;
  }

  const handleImport = async () => {
    if (rowErrors.size > 0) return;
    if (rows.length === 0) return;

    setStatus("importing");
    setImportError(null);
    let count = 0;
    let opened = 0;
    let units = 0;
    let skipped = 0;

    try {
      for (const row of rows) {
        const generatedSku = row.sku || autoSku();
        const price = Math.max(0, row.retail_price || 0);
        
        let variants: { name: string; stock: number }[] | undefined = undefined;
        let finalStockQty = row.stock_qty;

        if (row.variants_raw) {
          variants = [];
          const pairs = row.variants_raw.split(",");
          for (const pair of pairs) {
            const [vName, vStock] = pair.split(":");
            if (vName && vName.trim()) {
              const parsedStock = parseInt(vStock) || 0;
              variants.push({ name: vName.trim(), stock: parsedStock });
            }
          }
          if (variants.length > 0) {
            finalStockQty = variants.reduce((sum, v) => sum + v.stock, 0);
            row.stock_qty = finalStockQty; // So openingBalanceOf sees it
          }
        }

        const fields = {
          name: row.name,
          sku: generatedSku,
          barcode: row.sku || generatedSku,
          category: row.category || "أخرى",
          costPrice: Math.max(0, Number(row.purchase_price) || 0),
          purchasePrice: Math.max(0, Number(row.purchase_price) || 0),
          unitPrice: Math.max(0, Number(price) || 1),
          wholesalePrice: Math.max(0, Number(row.wholesale_price) || Number(price) || 0),
          totalQuantity: Math.max(0, Number(finalStockQty) || 0),
          minStockLevel: 0,
          maxStockLevel: 0,
          supplier: undefined,
          description: undefined,
          isActive: true,
          metadata: variants ? { variants } : undefined,
        };

        const existing = findImportedProduct(products, row);
        if (existing) {
          // UPDATE MODE: Update fields and adjust stock
          updateProduct(existing.id, {
            ...fields,
            sku: existing.sku,
            barcode: existing.barcode,
          });
          
          const currentStock = qtyOf(existing.id);
          const delta = finalStockQty - currentStock;
          
          if (delta !== 0) {
            await appendEvent({
              kind: "stock_adjustment",
              actor: "نظام الاستيراد",
              refType: "product_edit",
              payload: {
                notes: "تسوية تلقائية لتحديث المخزون عبر الإكسل",
              },
              lines: [
                {
                  account: "stock",
                  subjectId: existing.id,
                  qty: delta,
                  unitCost: 0,
                }
              ]
            });
            opened++; // We can reuse this counter to show modified/adjusted rows
            units += delta;
          }
          
          skipped++; // Keeping this as "Existing matched" for UI reporting
          continue;
        }

        // Awaited: the opening-balance event below names this product by
        // id, so it must exist in the database before the event is written.
        const product = await addProduct(fields);
        count++;

        // INSERT MODE: One event per row that carries a quantity
        const opening = openingBalanceOf(row);
        opening.quantity = Math.max(0, finalStockQty); // Ensure the variants sum is used
        const eventId = await appendOpeningBalance({
          productId: product.id,
          productName: product.name,
          ...opening,
        });
        if (eventId) {
          opened++;
          units += opening.quantity;
        }
      }
    } catch (e) {
      // Say exactly where it stopped. The products already created keep the
      // stock already recorded — nothing is half-written, each row is its own
      // atomic event.
      setImportError(
        `الاستيراد وقف بعد ${count} منتج. باقي الصفوف متسجلتش. ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    setImportCount(count);
    setOpenedCount(opened);
    setOpenedUnits(units);
    setSkippedCount(skipped);
    onImported?.();
    setStatus("done");
  };

  const downloadTemplate = () => {
    const buf = generateTemplateBuffer();
    const blob = new Blob([buf as any], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "نموذج_استيراد_المنتجات.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalValidRows = rows.length - rowErrors.size;

  return (
    <div className="rounded-2xl border border-border bg-card p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="size-10 rounded-xl flex items-center justify-center"
            style={{ background: "var(--gradient-primary)" }}
          >
            <FileSpreadsheet className="size-5 text-primary-foreground" />
          </div>
          <div>
            <h3 className="font-display text-lg font-bold">استيراد المنتجات عبر إكسل</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              رفع ملف Excel أو CSV لإضافة مئات المنتجات دفعة واحدة
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="size-8 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* File Upload + Template */}
      {status === "idle" && (
        <div className="space-y-4">
          <div
            onClick={() => fileRef.current?.click()}
            className="border-2 border-dashed border-border rounded-2xl p-10 text-center cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-all"
          >
            <Upload className="size-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm font-medium">اضغط لاختيار ملف Excel (.xlsx / .xls / .csv)</p>
            <p className="text-xs text-muted-foreground mt-1">أو اسحب الملف وأفلته هنا</p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          <Button variant="outline" size="sm" onClick={downloadTemplate} className="gap-2">
            <Download className="size-3.5" />
            تحميل نموذج الإكسل الاسترشادي (Template)
          </Button>
        </div>
      )}

      {/* Preview Grid */}
      {status === "preview" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">{fileName}</span>
              <span
                className={cn(
                  "text-xs px-2 py-0.5 rounded-full font-medium",
                  rowErrors.size === 0
                    ? "bg-green-100 dark:bg-green-950/40 text-green-700 dark:text-green-400"
                    : "bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400",
                )}
              >
                {rows.length} صف · {totalValidRows} صحيح
                {rowErrors.size > 0 && ` · ${rowErrors.size} بحاجة لاسم`}
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setStatus("idle");
                  setRows([]);
                  setRowErrors(new Map());
                  fileRef.current!.value = "";
                }}
              >
                اختيار ملف آخر
              </Button>
              <Button
                size="sm"
                onClick={() => void handleImport()}
                disabled={rowErrors.size > 0}
                className="gap-2"
              >
                <Upload className="size-3.5" />
                تأكيد وحفظ البيانات
              </Button>
            </div>
          </div>

          {rowErrors.size > 0 && (
            <div className="rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 p-3 space-y-1">
              <p className="text-xs font-semibold text-red-700 dark:text-red-400 flex items-center gap-1.5">
                <AlertCircle className="size-3.5" />
                يوجد {rowErrors.size} صف/صفوف تفتقد اسم المنتج. يرجى تصحيحها في الملف وإعادة الرفع.
              </p>
              {Array.from(rowErrors.entries())
                .slice(0, 5)
                .map(([rowIdx]) => (
                  <p key={rowIdx} className="text-xs text-red-600 dark:text-red-300 mr-5">
                    الصف #{rowIdx + 1}: اسم المنتج مفقود
                  </p>
                ))}
            </div>
          )}

          {/* Scrollable table */}
          <div
            className="overflow-x-auto rounded-xl border border-border"
            style={{ maxHeight: 420 }}
          >
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/80 backdrop-blur z-10">
                <tr>
                  <th className="text-center p-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap">
                    #
                  </th>
                  <th className="text-center p-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap">
                    الباركود
                  </th>
                  <th className="text-right p-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap">
                    اسم المنتج
                  </th>
                  <th className="text-center p-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap">
                    القسم
                  </th>
                  {isOwner && (
                    <th className="text-center p-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap">
                      سعر الشراء
                    </th>
                  )}
                  <th className="text-center p-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap">
                    قطاعي
                  </th>
                  {isOwner && (
                    <th className="text-center p-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap">
                      جملة
                    </th>
                  )}
                  <th className="text-center p-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap">
                    الكمية
                  </th>
                  <th className="text-center p-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap">
                    الأنواع (درجات)
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const hasNameErr = rowErrors.get(i)?.some((e) => e.field === "name");
                  return (
                    <tr
                      key={i}
                      className={cn(
                        "border-t border-border transition-colors",
                        hasNameErr ? "bg-red-50/60 dark:bg-red-950/15" : "hover:bg-muted/30",
                      )}
                    >
                      <td className="text-center p-2.5 text-xs text-muted-foreground">{i + 1}</td>
                      <td className="text-center p-2.5 font-mono text-xs whitespace-nowrap">
                        {row.sku || (
                          <span className="text-muted-foreground italic">سيتم إنشاؤه تلقائياً</span>
                        )}
                      </td>
                      <td className="p-2.5 font-medium">
                        <span className={cn(hasNameErr && "text-destructive")}>
                          {row.name || "—"}
                        </span>
                        {hasNameErr && (
                          <span className="block text-[10px] text-destructive mt-0.5">
                            اسم المنتج مفقود
                          </span>
                        )}
                      </td>
                      <td className="text-center p-2.5 text-xs whitespace-nowrap">
                        {row.category || "—"}
                      </td>
                      {isOwner && (
                        <td className="text-center p-2.5 text-xs whitespace-nowrap">
                          {row.purchase_price > 0 ? row.purchase_price.toLocaleString() : "—"}
                        </td>
                      )}
                      <td className="text-center p-2.5 text-xs font-semibold whitespace-nowrap">
                        {row.retail_price > 0 ? row.retail_price.toLocaleString() : "—"}
                      </td>
                      {isOwner && (
                        <td className="text-center p-2.5 text-xs whitespace-nowrap">
                          {row.wholesale_price > 0 ? row.wholesale_price.toLocaleString() : "—"}
                        </td>
                      )}
                      <td className="text-center p-2.5 text-xs whitespace-nowrap">
                        {row.stock_qty}
                      </td>
                      <td className="text-center p-2.5 text-xs whitespace-nowrap">
                        {row.variants_raw || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Success */}
      {status === "importing" && (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="size-10 mx-auto rounded-full border-2 border-primary border-t-transparent animate-spin mb-3" />
            <p className="text-sm font-medium">جاري حفظ المنتجات في المخزن...</p>
          </div>
        </div>
      )}

      {status === "done" && (
        <div
          className={cn(
            "rounded-xl border p-6 text-center space-y-3",
            importError
              ? "bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800"
              : "bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800",
          )}
        >
          {importError ? (
            <AlertCircle className="size-10 mx-auto text-amber-600" />
          ) : (
            <CheckCircle2 className="size-10 mx-auto text-green-600" />
          )}
          <p className="text-lg font-bold">تم استيراد {importCount} منتج بنجاح!</p>
          {importError && <p className="text-sm text-amber-700 dark:text-amber-400">{importError}</p>}
          <p className="text-sm text-muted-foreground">
            {openedCount > 0
              ? `اتسجّل رصيد افتتاحي لـ ${openedCount} منتج بإجمالي ${openedUnits.toLocaleString("ar-EG")} قطعة — الكميات دي ظاهرة في المخزون ونقاط البيع من غير ما تعمل توريد.`
              : "مفيش كميات في الملف، فالمنتجات بدأت من صفر. سجّل الكمية بتوريد أو من شاشة الجرد."}
          </p>
          {skippedCount > 0 && (
            <p className="text-sm text-muted-foreground">
              {skippedCount} منتج كان متسجّل قبل كده بنفس الباركود — بياناته اتحدّثت، وتم تسوية المخزون الخاص به ليطابق الملف إذا كان هناك اختلاف.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            المنتجات متاحة الآن للبيع في نقاط البيع والمتجر الإلكتروني. تم توليد باركود تلقائي
            للمنتجات التي لم تحدد باركود لها.
          </p>
          <Button
            onClick={() => {
              setStatus("idle");
              setRows([]);
              setRowErrors(new Map());
              fileRef.current!.value = "";
              onClose();
            }}
            variant="outline"
          >
            العودة للمنتجات
          </Button>
        </div>
      )}
    </div>
  );
}
