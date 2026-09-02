import { useRef, useState } from "react";
import {
  DatabaseBackup,
  Upload,
  Download,
  Trash2,
  AlertTriangle,
  ShieldCheck,
  RefreshCw,
  CheckCircle2,
  History,
  ScanSearch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useBackupStore,
  buildBackupBundle,
  downloadBundle,
  validateBundle,
  applyBundle,
  type BackupStoreKey,
} from "@/store/useBackupStore";
import type { BackupBundle } from "@/types";
import {
  APP_VERSION,
  checkBackupVersionCompat,
  type VersionCompatResult,
} from "@/lib/appVersion";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleString("ar-EG");
}

interface VerifyResult {
  ok: boolean;
  reason?: string;
  bundle?: BackupBundle;
  compat: VersionCompatResult;
}

export function BackupsPage() {
  const { backups, record, remove, markRestored } = useBackupStore();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ bundle: BackupBundle; stores: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const verifyInput = useRef<HTMLInputElement>(null);

  const handleCreateBackup = async (sanitized: boolean) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const bundle = await buildBackupBundle({ appName: "NexusCore", sanitized });
      const filename = `nexuscore-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      await downloadBundle(bundle, filename);

      // Index the backup so the admin can see it in the history table.
      record({
        id: crypto.randomUUID(),
        filename,
        size_bytes: JSON.stringify(bundle).length,
        created_at: new Date(),
        created_by: "owner",
        store_count: bundle.stores.length,
        sanitized,
      });
      setSuccess(
        sanitized
          ? "تم إنشاء نسخة احتياطية آمنة (مع إخفاء المفاتيح) وتنزيلها"
          : "تم إنشاء نسخة احتياطية كاملة وتنزيلها",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشل إنشاء النسخة الاحتياطية");
    } finally {
      setBusy(false);
    }
  };

  const handleRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text) as BackupBundle;
      const err = await validateBundle(bundle);
      if (err) {
        setError(err);
        return;
      }
      // Show a confirmation dialog with what will be overwritten.
      setConfirm({ bundle, stores: Object.keys(bundle.data) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر قراءة الملف");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  // Phase E: standalone verify — checks a file's integrity without
  // touching localStorage. Useful for confirming a backup is healthy
  // before committing to a restore.
  const handleVerifyFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text) as BackupBundle;
      const err = await validateBundle(bundle);
      const compat = checkBackupVersionCompat(bundle.version);
      if (err) {
        setVerifyResult({ ok: false, reason: err, compat });
        return;
      }
      setVerifyResult({ ok: true, bundle, compat });
    } catch (parseErr) {
      setVerifyResult({
        ok: false,
        reason: parseErr instanceof Error ? parseErr.message : "تعذّر قراءة الملف",
        compat: checkBackupVersionCompat(null),
      });
    } finally {
      setBusy(false);
      if (verifyInput.current) verifyInput.current.value = "";
    }
  };



  const performRestore = () => {
    if (!confirm) return;
    setBusy(true);
    try {
      const written = applyBundle(confirm.bundle);
      setSuccess(
        `تمت الاستعادة بنجاح (${written.length} متجر). سيتم إعادة تحميل الصفحة لتطبيق التغييرات.`,
      );
      // Reload after a short delay so the user can read the message.
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشل الاستعادة");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-display font-bold flex items-center gap-2">
            <DatabaseBackup className="size-7 text-primary" />
            النسخ الاحتياطي والاستعادة
          </h1>
          <p className="text-muted-foreground mt-1">
            صدّر كل بياناتك كملف JSON محلي، أو استعد من ملف نسخة احتياطية سابقة
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={handleRestoreFile}
          />
          <input
            ref={verifyInput}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={handleVerifyFile}
          />
          <Button
            variant="ghost"
            onClick={() => {
              verifyInput.current?.click();
            }}
            disabled={busy}
            title="تحقق من سلامة ملف نسخة احتياطية بدون استعادته"
          >
            <ScanSearch className="size-4 ml-2" />
            تحقق من ملف
          </Button>
          <Button 
            variant="outline" 
            onClick={() => {
              fileInput.current?.click();
            }} 
            disabled={busy}
          >
            <Upload className="size-4 ml-2" />
            استعادة من ملف
          </Button>
          <Button onClick={() => handleCreateBackup(false)} disabled={busy}>
            <Download className="size-4 ml-2" />
            إنشاء نسخة احتياطية كاملة
          </Button>
          <Button variant="secondary" onClick={() => handleCreateBackup(true)} disabled={busy}>
            <ShieldCheck className="size-4 ml-2" />
            نسخة آمنة (إخفاء المفاتيح)
          </Button>
        </div>
      </div>

      {/* Status messages */}
      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 flex items-start gap-3">
          <AlertTriangle className="size-5 text-destructive mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="font-semibold text-destructive text-sm">تعذّر إكمال العملية</p>
            <p className="text-sm text-muted-foreground mt-1">{error}</p>
          </div>
        </div>
      )}
      {success && (
        <div className="rounded-xl border border-green-200 dark:border-green-800 bg-green-50/60 dark:bg-green-950/30 p-4 flex items-start gap-3">
          <CheckCircle2 className="size-5 text-green-600 mt-0.5 shrink-0" />
          <p className="text-sm text-green-700 dark:text-green-300 font-medium">{success}</p>
        </div>
      )}

      {/* Phase E: standalone verify result */}
      {verifyResult && (
        <div
          className={`rounded-xl border p-4 flex items-start gap-3 ${
            verifyResult.ok
              ? "border-green-200 dark:border-green-800 bg-green-50/60 dark:bg-green-950/30"
              : "border-destructive/30 bg-destructive/5"
          }`}
        >
          {verifyResult.ok ? (
            <CheckCircle2 className="size-5 text-green-600 mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle className="size-5 text-destructive mt-0.5 shrink-0" />
          )}
          <div className="flex-1 space-y-1">
            <p
              className={`font-semibold text-sm ${
                verifyResult.ok ? "text-green-700 dark:text-green-300" : "text-destructive"
              }`}
            >
              {verifyResult.ok ? "الملف سليم — Checksum متطابق" : "الملف غير صالح"}
            </p>
            {verifyResult.reason && (
              <p className="text-sm text-muted-foreground">{verifyResult.reason}</p>
            )}
            {verifyResult.bundle && (
              <div className="text-xs text-muted-foreground grid grid-cols-2 md:grid-cols-4 gap-2 pt-2">
                <div>
                  <span className="block text-foreground/60">التاريخ</span>
                  {formatDate(verifyResult.bundle.created_at)}
                </div>
                <div>
                  <span className="block text-foreground/60">التطبيق</span>
                  {verifyResult.bundle.app_name}
                </div>
                <div>
                  <span className="block text-foreground/60">إصدار النسخة</span>
                  <code className="text-[10px]">{verifyResult.bundle.version}</code>
                </div>
                <div>
                  <span className="block text-foreground/60">عدد المتاجر</span>
                  {verifyResult.bundle.stores.length}
                </div>
                <div>
                  <span className="block text-foreground/60">المقاسات</span>
                  {verifyResult.bundle.sanitized ? "آمنة (مُخفية)" : "كاملة"}
                </div>
                <div>
                  <span className="block text-foreground/60">إصدار التطبيق الحالي</span>
                  <code className="text-[10px]">{APP_VERSION}</code>
                </div>
              </div>
            )}
            <p
              className={`text-xs pt-1 ${
                verifyResult.compat.kind === "incompatible_older" ||
                verifyResult.compat.kind === "incompatible_newer" ||
                verifyResult.compat.kind === "unknown"
                  ? "text-amber-700 dark:text-amber-300"
                  : "text-muted-foreground"
              }`}
            >
              {verifyResult.compat.message}
            </p>
            <div className="pt-2">
              <Button variant="ghost" size="sm" onClick={() => setVerifyResult(null)}>
                إغلاق
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Quick info */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-3 mb-2">
            <DatabaseBackup className="size-5 text-primary" />
            <p className="text-sm text-muted-foreground">النسخ المؤرشفة محلياً</p>
          </div>
          <p className="text-2xl font-bold">{backups.length}</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-3 mb-2">
            <ShieldCheck className="size-5 text-blue-600" />
            <p className="text-sm text-muted-foreground">حجم آخر نسخة</p>
          </div>
          <p className="text-2xl font-bold font-mono">
            {backups[0] ? formatBytes(backups[0].size_bytes) : "—"}
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-3 mb-2">
            <History className="size-5 text-green-600" />
            <p className="text-sm text-muted-foreground">آخر نسخة</p>
          </div>
          <p className="text-sm font-medium">
            {backups[0] ? formatDate(backups[0].created_at) : "لا يوجد"}
          </p>
        </div>
      </div>

      {/* Info banner */}
      <div className="rounded-2xl border border-blue-200 dark:border-blue-800 bg-blue-50/40 dark:bg-blue-950/20 p-4 flex items-start gap-3">
        <ShieldCheck className="size-5 text-blue-600 mt-0.5 shrink-0" />
        <div className="text-sm text-blue-900 dark:text-blue-200 leading-relaxed">
          <p className="font-semibold">كيف تعمل النسخ الاحتياطية؟</p>
          <ul className="list-disc pr-5 mt-1.5 space-y-0.5">
            <li>النسخة تُحمَّل كملف JSON واحد يحوي كل المتاجر في النظام.</li>
            <li>
              النسخة "الآمنة" تستبدل كلمات المرور والمفاتيح السرية بـ <code>***</code> قبل التنزيل.
            </li>
            <li>كل ملف يُولَّد بـ SHA-256 checksum لكشف التلف أو التلاعب.</li>
            <li>الاستعادة تتطلب تأكيداً صريحاً ولن تمس البيانات الحية قبل الموافقة.</li>
            <li>كل البيانات تبقى محلية — لا يوجد رفع إلى أي خادم.</li>
          </ul>
        </div>
      </div>

      {/* Backup history table */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h2 className="font-semibold">سجل النسخ الاحتياطية</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              الفهرس المحلي للنسخ المؤرشفة. الملف نفسه يُحفَظ على جهازك بعد التنزيل.
            </p>
          </div>
        </div>
        {backups.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            <DatabaseBackup className="size-10 mx-auto mb-2 opacity-40" />
            <p>لم يتم إنشاء أي نسخة احتياطية بعد</p>
            <p className="text-xs mt-1">اضغط "إنشاء نسخة احتياطية كاملة" لبدء النسخ</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">اسم الملف</TableHead>
                <TableHead className="text-center">الحجم</TableHead>
                <TableHead className="text-center">عدد المتاجر</TableHead>
                <TableHead className="text-center">النوع</TableHead>
                <TableHead className="text-center">التاريخ</TableHead>
                <TableHead className="text-center">إجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="font-mono text-xs">{b.filename}</TableCell>
                  <TableCell className="text-center font-mono text-xs">
                    {formatBytes(b.size_bytes)}
                  </TableCell>
                  <TableCell className="text-center font-mono text-xs">{b.store_count}</TableCell>
                  <TableCell className="text-center">
                    {b.sanitized ? (
                      <Badge variant="secondary" className="text-[10px]">
                        <ShieldCheck className="size-3 ml-1" /> آمنة
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">
                        كاملة
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-center text-xs">{formatDate(b.created_at)}</TableCell>
                  <TableCell className="text-center">
                    <Button aria-label="حذف النسخة الاحتياطية"
                      variant="ghost"
                      size="icon"
                      onClick={() => remove(b.id)}
                      className="size-8 text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Restore confirmation dialog */}
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="size-5" />
              تأكيد الاستعادة
            </DialogTitle>
            <DialogDescription>
              هذه العملية ستستبدل البيانات الحالية في المتاجر التالية. لن يمكن التراجع.
            </DialogDescription>
          </DialogHeader>
          {confirm && (
            <div className="space-y-3">
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
                <p className="font-semibold mb-1">سيتم استبدال البيانات في:</p>
                <ul className="list-disc pr-5 space-y-0.5 max-h-48 overflow-y-auto">
                  {confirm.stores.map((s: string) => (
                    <li key={s}>
                      <code className="text-[10px]">{s}</code>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-xs text-blue-900 space-y-1">
                <p>
                  <strong>تاريخ النسخة:</strong> {formatDate(confirm.bundle.created_at)}
                </p>
                <p>
                  <strong>عدد المتاجر:</strong> {confirm.bundle.stores.length}
                </p>
                <p>
                  <strong>إصدار النسخة:</strong>{" "}
                  <code className="text-[10px]">{confirm.bundle.version}</code>{" "}
                  (إصدار التطبيق الحالي: <code className="text-[10px]">{APP_VERSION}</code>)
                </p>
                <p>
                  <strong>Checksum:</strong>{" "}
                  <code className="text-[10px]">{confirm.bundle.checksum.slice(0, 16)}…</code>
                </p>
                {(() => {
                  const compat = checkBackupVersionCompat(confirm.bundle.version);
                  const strong =
                    compat.kind === "incompatible_older" ||
                    compat.kind === "incompatible_newer" ||
                    compat.kind === "unknown";
                  return (
                    <p
                      className={`pt-1 ${
                        strong
                          ? "text-amber-800 font-semibold"
                          : "text-blue-900"
                      }`}
                    >
                      {compat.message}
                    </p>
                  );
                })()}
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirm(null)} disabled={busy}>
              إلغاء
            </Button>
            <Button
              onClick={performRestore}
              disabled={busy}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {busy ? (
                <RefreshCw className="size-4 ml-2 animate-spin" />
              ) : (
                <AlertTriangle className="size-4 ml-2" />
              )}
              نعم، استبدل البيانات
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
