import { useEffect, useRef, useState } from "react";
import { FileSpreadsheet, Upload, Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRunOnce } from "@/hooks/useSubmitGate";
import { useAuthStore } from "@/store/useAuthStore";
import { cloudList } from "@/services/cloudData";
import { cloudErrorMessage } from "@/lib/cloudError";
import { getSyncIdentity } from "@/services/api/storeContext";
import { executeProductImport, type ImportResult } from "@/lib/productImportCommand";
import {
  IMPORT_LIMIT,
  checkImportDuplicates,
  importProductId,
  type ImportPlan,
} from "@/lib/productImportWorkflow";

interface BulkImportProductProps {
  onClose: () => void;
  onImported?: () => void;
}
export function BulkImportProduct({ onClose, onImported }: BulkImportProductProps) {
  const role = useAuthStore((s) => s.userRole);
  const authorityRevision = useAuthStore((s) => s.accessRevision);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [fileName, setFileName] = useState("");
  const [status, setStatus] = useState<"idle" | "reading" | "preview" | "importing" | "done">(
    "idle",
  );
  const [error, setError] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [progress, setProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const previewStore = useRef<string | undefined>(undefined);
  const runOnce = useRunOnce();
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    generation.current++;
    setPlan(null);
    setFileName("");
    setResult(null);
    setStatus("idle");
  }, [authorityRevision]);
  const busy = status === "reading" || status === "importing";
  const readFile = async (file: File) => {
    const current = ++generation.current;
    setStatus("reading");
    setError("");
    setPlan(null);
    setResult(null);
    setFileName(file.name);
    try {
      const { readProductFile } = await import("@/lib/productImportFile");
      const parsed = await readProductFile(file);
      if (current !== generation.current) return;
      let preview = parsed;
      if (!parsed.errors.length) {
        try {
          const identity = await getSyncIdentity();
          if (!identity) throw { status: 401 };
          const products = await cloudList("products");
          const ownIds = new Map(
            await Promise.all(
              parsed.rows.map(
                async (row) =>
                  [row.excelRow, await importProductId(identity.storeId, row)] as const,
              ),
            ),
          );
          preview = checkImportDuplicates(parsed, products, ownIds);
          previewStore.current = identity.storeId;
        } catch (e) {
          if (current !== generation.current) return;
          setError(
            cloudErrorMessage(e, "المنتجات") + " لم يبدأ الحفظ؛ أعد اختيار الملف بعد معالجة السبب.",
          );
          setStatus("idle");
          return;
        }
      }
      if (current !== generation.current) return;
      setPlan(preview);
      setStatus("preview");
    } catch (e) {
      if (current !== generation.current) return;
      setError(e instanceof Error ? e.message : "تعذّرت قراءة الملف. أعد المحاولة.");
      setStatus("idle");
    }
  };
  const confirm = () =>
    runOnce(async () => {
      if (!plan || plan.errors.length || !plan.rows.length || busy) return;
      setStatus("importing");
      setError("");
      setProgress(0);
      try {
        const saved = await executeProductImport(
          plan,
          (done) => setProgress(done),
          previewStore.current,
        );
        setResult(saved);
        setStatus("done");
        if (saved.created || saved.recovered) onImported?.();
      } catch {
        setError("تعذّر تأكيد الاستيراد. أعد محاولة نفس الملف للتحقق دون تكرار المخزون.");
        setStatus("preview");
      }
    });
  const template = async () => {
    try {
      const { productTemplate } = await import("@/lib/productImportFile");
      const bytes = productTemplate();
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "nexus-products-template.xlsx";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError("تعذّر تحميل النموذج. حاول مرة أخرى.");
    }
  };
  if (role !== "ADMIN") return null;
  const invalid = new Set(plan?.errors.map((e) => e.row));
  return (
    <section
      dir="rtl"
      aria-label="استيراد المنتجات"
      data-pwa-unsaved="true"
      className="rounded-2xl border border-border bg-card p-4 sm:p-6 space-y-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-bold flex items-center gap-2">
          <FileSpreadsheet className="size-5" />
          استيراد المنتجات عبر إكسل
        </h3>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          aria-label="إغلاق استيراد المنتجات"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        إضافة منتجات جديدة فقط؛ لن تتغير المنتجات الموجودة. حتى {IMPORT_LIMIT} منتج و5 MB لكل ملف.
        الأنواع والألوان والمقاسات: أحمر / M:2, أزرق / L:3.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {status === "idle" && (
        <>
          <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload className="size-4" />
            اختيار ملف Excel أو CSV
          </Button>
          <input
            ref={fileRef}
            aria-label="ملف المنتجات"
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void readFile(file);
            }}
          />
          <Button type="button" variant="outline" onClick={() => void template()}>
            <Download className="size-4" />
            تحميل نموذج الإكسل الاسترشادي (Template)
          </Button>
        </>
      )}
      {status === "reading" && <p role="status">جاري قراءة وفحص {fileName}…</p>}
      {status === "preview" && plan && (
        <>
          <p>
            {fileName} · {plan.rows.length} صف ·{" "}
            {plan.rows.filter((r) => !invalid.has(r.excelRow)).length} صالح مبدئيًا · {invalid.size}{" "}
            غير صالح · {plan.duplicates} مكرر · {plan.alreadyImported ?? 0} محفوظ من نفس الملف ·{" "}
            {plan.rows.filter((r) => !invalid.has(r.excelRow)).length - (plan.alreadyImported ?? 0)}{" "}
            جديد
          </p>
          <p className="text-sm">
            ستُفحص الباركودات مرة أخرى من المتجر قبل الحفظ. التكرار يوقف الدفعة قبل تعديل أي منتج.
          </p>
          {!!plan.errors.length && (
            <div role="alert" className="text-destructive">
              {plan.errors.slice(0, 30).map((e, i) => (
                <p key={i}>
                  الصف {e.row}: {e.message}
                </p>
              ))}
              {plan.errors.length > 30 && <p>وأخطاء إضافية؛ صحّح الملف كاملًا ثم أعد رفعه.</p>}
            </div>
          )}
          <div className="overflow-auto max-h-96 border rounded-xl">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {[
                    "صف Excel",
                    "المنتج",
                    "SKU / الباركود",
                    "الكمية",
                    "سعر الشراء",
                    "سعر البيع",
                    "الأنواع",
                  ].map((s) => (
                    <th key={s} className="p-2">
                      {s}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plan.rows.slice(0, 200).map((r) => (
                  <tr key={r.excelRow} className="border-t">
                    <td>{r.excelRow}</td>
                    <td>{r.name}</td>
                    <td>{r.sku || r.barcode || "تلقائي"}</td>
                    <td>{r.stock_qty}</td>
                    <td>{r.purchase_price}</td>
                    <td>{r.retail_price}</td>
                    <td>{r.variants_raw || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.rows.length > 200 && (
            <p>المعاينة لأول 200 صف؛ تم فحص جميع الصفوف ({plan.rows.length}).</p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              disabled={!!plan.errors.length || !plan.rows.length}
              onClick={() => void confirm()}
            >
              تأكيد وحفظ المنتجات الجديدة والتحقق من السابق
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setPlan(null);
                setStatus("idle");
                setError("");
              }}
            >
              اختيار ملف آخر
            </Button>
          </div>
        </>
      )}
      {status === "importing" && (
        <p role="status">
          جاري حفظ المنتجات في المخزن… {progress} / {plan?.rows.length} — لا تغلق الصفحة.
        </p>
      )}
      {status === "done" && result && (
        <div role="status" className="space-y-2">
          <p className="font-bold">{result.error ? "توقف الاستيراد" : "اكتمل الاستيراد"}</p>
          <p>
            تم إنشاء {result.created} منتج جديد. تأكد حفظ {result.recovered} منتج سابق من نفس الملف
            دون تكراره. رصيد افتتاحي جديد: {result.units} قطعة.
          </p>
          {result.error && (
            <p role="alert" className="text-destructive">
              {result.error}
            </p>
          )}
          <p>
            المتبقي غير المحفوظ: {(plan?.rows.length ?? 0) - result.created - result.recovered}. لا
            تتغير المنتجات الموجودة أو الأرصدة السابقة.
          </p>
          {result.error && (
            <Button type="button" onClick={() => void confirm()}>
              إعادة محاولة نفس الملف بأمان
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            العودة للمنتجات
          </Button>
        </div>
      )}
    </section>
  );
}
