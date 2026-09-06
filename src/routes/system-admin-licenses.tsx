import { useCallback, useEffect, useMemo, useState } from "react";
import { useSubmitGate } from "@/hooks/useSubmitGate";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  listStoresForAdmin,
  setLicense,
  extendLicense,
  suspendLicense,
  reactivateLicense,
  generateLicenseKey,
  licenseState,
  actionsFor,
  type AdminStoreRow,
  type LicenseState,
} from "@/services/licenseAdmin";
import { toDateInput, plusMonths, endOfDayIso } from "@/lib/license/key";
import { RefreshCw, KeyRound, Ban, Search, ShieldCheck, CalendarPlus, Play } from "lucide-react";

/**
 * The License Manager.
 *
 * The whole business model is on this screen: a customer pays in the real
 * world, the system owner turns the key, and a customer who stops paying is
 * suspended or allowed to lapse. There is no billing here and nothing runs on
 * a timer — every change is a deliberate press by the owner.
 *
 * Every button calls an RPC that re-verifies `is_system_owner()` in Postgres,
 * so this file contains no secrets and enforces nothing. It is a control
 * surface over `020_license_control.sql`, and the route guard in front of it
 * only stops the wrong person seeing a menu item. The lock is the database:
 * `store_licenses` has `false` for INSERT, UPDATE and DELETE on every client
 * role, so a shop admin cannot touch even their own licence.
 *
 * ## Actions are decided by state, never listed unconditionally
 *
 * `actionsFor()` returns what applies, and the row renders exactly that. Every
 * one of these RPCs raises for a nonsensical call — reactivating a licence
 * that was never suspended, extending a suspended one — and this is what stops
 * the owner discovering that by pressing the button.
 */

type Filter = "all" | "active" | "expired" | "suspended" | "unlicensed";

const STATE_STYLE: Record<LicenseState, { label: string; tone: string; sort: number }> = {
  SUSPENDED: { label: "موقوف", tone: "bg-orange-500/10 text-orange-400 border-orange-500/20", sort: 0 },
  EXPIRED: { label: "منتهي", tone: "bg-red-500/10 text-red-400 border-red-500/20", sort: 1 },
  UNLICENSED: { label: "بدون ترخيص", tone: "bg-slate-500/10 text-slate-400 border-slate-500/20", sort: 2 },
  ACTIVE: { label: "ساري", tone: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20", sort: 4 },
};

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("ar-EG", { year: "numeric", month: "short", day: "numeric" })
    : "—";

const daysLeft = (iso: string | null) =>
  iso ? Math.floor((Date.parse(iso) - Date.now()) / 86_400_000) : null;

export function SystemAdminLicenses() {
  const [rows, setRows] = useState<AdminStoreRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const [activating, setActivating] = useState<AdminStoreRow | null>(null);
  const [extending, setExtending] = useState<AdminStoreRow | null>(null);
  const [suspending, setSuspending] = useState<AdminStoreRow | null>(null);
  const [reactivating, setReactivating] = useState<AdminStoreRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listStoresForAdmin());
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر تحميل المتاجر");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (r: AdminStoreRow) =>
      !q ||
      r.store_name?.toLowerCase().includes(q) ||
      r.owner_email?.toLowerCase().includes(q) ||
      r.license_key?.toLowerCase().includes(q) ||
      r.store_id.toLowerCase().includes(q);

    return rows
      .filter((r) => match(r) && (filter === "all" || licenseState(r).toLowerCase() === filter))
      .sort((a, b) => STATE_STYLE[licenseState(a)].sort - STATE_STYLE[licenseState(b)].sort);
  }, [rows, query, filter]);

  const stats = useMemo(() => {
    const c = { ACTIVE: 0, EXPIRED: 0, SUSPENDED: 0, UNLICENSED: 0 };
    for (const r of rows) c[licenseState(r)]++;
    return { ...c, total: rows.length };
  }, [rows]);

  /** Every action ends the same way: tell the owner, then re-read the truth. */
  const run = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
      toast.success(label);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تنفيذ الإجراء");
    }
  };

  return (
    <div dir="rtl" className="p-6 space-y-6 max-w-[1280px] mx-auto">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="size-11 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <ShieldCheck className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">إدارة التراخيص</h1>
            <p className="text-sm text-muted-foreground mt-1">
              تفعيل وتمديد وإيقاف وصول المتاجر. هذه الشاشة متاحة لمالك النظام فقط.
            </p>
          </div>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`size-4 ml-2 ${loading ? "animate-spin" : ""}`} />
          تحديث
        </Button>
      </header>

      {/* Four counts for four states. Clicking one filters to it, so the owner
          goes from "who is suspended?" to the list in one press. */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {(
          [
            { key: "all" as const, label: "إجمالي المتاجر", value: stats.total, tone: "text-foreground" },
            { key: "active" as const, label: "ساري", value: stats.ACTIVE, tone: "text-emerald-500" },
            { key: "expired" as const, label: "منتهي", value: stats.EXPIRED, tone: "text-red-500" },
            { key: "suspended" as const, label: "موقوف", value: stats.SUSPENDED, tone: "text-orange-500" },
            { key: "unlicensed" as const, label: "بدون ترخيص", value: stats.UNLICENSED, tone: "text-muted-foreground" },
          ]
        ).map((c) => (
          <button
            key={c.key}
            onClick={() => setFilter(c.key)}
            className={`rounded-xl border bg-card p-4 text-right transition-colors hover:bg-muted/40 ${
              filter === c.key ? "border-primary/50 ring-1 ring-primary/20" : ""
            }`}
          >
            <p className="text-xs text-muted-foreground mb-1.5">{c.label}</p>
            <p className={`text-2xl font-bold tabular-nums ${c.tone}`}>{c.value}</p>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث باسم المتجر أو بريد المالك أو مفتاح الترخيص أو معرّف المتجر…"
            className="pr-9"
            aria-label="بحث في المتاجر"
          />
        </div>
        <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <SelectTrigger className="w-[180px]" aria-label="تصفية حسب الحالة">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل الحالات</SelectItem>
            <SelectItem value="active">ساري</SelectItem>
            <SelectItem value="expired">منتهي</SelectItem>
            <SelectItem value="suspended">موقوف</SelectItem>
            <SelectItem value="unlicensed">بدون ترخيص</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="text-right font-medium px-4 py-3">المتجر</th>
                <th className="text-right font-medium px-4 py-3">المالك</th>
                <th className="text-right font-medium px-4 py-3">الحالة</th>
                <th className="text-right font-medium px-4 py-3">الباقة</th>
                <th className="text-right font-medium px-4 py-3">صالح حتى</th>
                <th className="text-right font-medium px-4 py-3">آخر تغيير</th>
                <th className="text-right font-medium px-4 py-3">المفتاح</th>
                <th className="text-left font-medium px-4 py-3">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                    جارٍ التحميل…
                  </td>
                </tr>
              )}
              {!loading && visible.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                    لا توجد متاجر مطابقة.
                  </td>
                </tr>
              )}
              {visible.map((r) => {
                const state = licenseState(r);
                const style = STATE_STYLE[state];
                const actions = actionsFor(state);
                const left = daysLeft(r.valid_until);

                return (
                  <tr key={r.store_id} className="border-t hover:bg-muted/20 transition-colors align-top">
                    <td className="px-4 py-3">
                      <p className="font-medium">{r.store_name || "بدون اسم"}</p>
                      <p className="text-[11px] text-muted-foreground font-mono mt-0.5">
                        {r.store_id.slice(0, 8)}…
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {r.member_count} مستخدم · أُنشئ {fmtDate(r.created_at)}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs break-all">{r.owner_email ?? "—"}</span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={style.tone}>
                        {style.label}
                      </Badge>
                      {/* The near-expiry warning belongs beside the state, not
                          instead of it: "ساري" and "8 days left" are both true. */}
                      {state === "ACTIVE" && left !== null && left <= 14 && (
                        <p className="text-[11px] text-amber-500 mt-1">يتبقى {left} يوم</p>
                      )}
                      {state === "SUSPENDED" && r.suspended_at && (
                        <p className="text-[11px] text-muted-foreground mt-1">
                          منذ {fmtDate(r.suspended_at)}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">{r.plan_type ?? "—"}</td>
                    <td className="px-4 py-3 tabular-nums whitespace-nowrap">
                      {fmtDate(r.valid_until)}
                    </td>
                    <td className="px-4 py-3 tabular-nums whitespace-nowrap text-xs text-muted-foreground">
                      {fmtDate(r.license_updated_at)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-[11px] text-muted-foreground break-all">
                        {r.license_key ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 justify-end flex-wrap">
                        {actions.includes("extend") && (
                          <Button size="sm" variant="outline" onClick={() => setExtending(r)}>
                            <CalendarPlus className="size-3.5 ml-1.5" />
                            تمديد
                          </Button>
                        )}
                        {actions.includes("activate") && (
                          <Button size="sm" variant="outline" onClick={() => setActivating(r)}>
                            <KeyRound className="size-3.5 ml-1.5" />
                            {r.license_key ? "إصدار جديد" : "تفعيل"}
                          </Button>
                        )}
                        {actions.includes("reactivate") && (
                          <Button size="sm" onClick={() => setReactivating(r)}>
                            <Play className="size-3.5 ml-1.5" />
                            إعادة تفعيل
                          </Button>
                        )}
                        {actions.includes("suspend") && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => setSuspending(r)}
                          >
                            <Ban className="size-3.5 ml-1.5" />
                            إيقاف
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {activating && (
        <ActivateDialog
          row={activating}
          onClose={() => setActivating(null)}
          onSaved={async () => {
            setActivating(null);
            await load();
          }}
        />
      )}

      {extending && (
        <ExtendDialog
          row={extending}
          onClose={() => setExtending(null)}
          onSaved={async () => {
            setExtending(null);
            await load();
          }}
        />
      )}

      <SuspendDialog
        row={suspending}
        onClose={() => setSuspending(null)}
        onConfirm={async (note) => {
          const target = suspending!;
          setSuspending(null);
          await run(`تم إيقاف وصول «${target.store_name}»`, () =>
            suspendLicense(target.store_id, note),
          );
        }}
      />

      <AlertDialog open={!!reactivating} onOpenChange={(o) => !o && setReactivating(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>إعادة تفعيل «{reactivating?.store_name}»؟</AlertDialogTitle>
            <AlertDialogDescription className="leading-relaxed">
              سيعود المتجر للعمل فوراً بنفس الترخيص وتاريخ الانتهاء الحالي
              {reactivating?.valid_until ? ` (${fmtDate(reactivating.valid_until)})` : ""}. لو
              الترخيص كان منتهياً كمان، استخدم «تمديد» بدلاً من ده.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = reactivating!;
                setReactivating(null);
                void run(`تم إعادة تفعيل «${target.store_name}»`, () =>
                  reactivateLicense(target.store_id),
                );
              }}
            >
              نعم، أعد التفعيل
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Suspend, with a note.
 *
 * Its own component because the note is state, and an `AlertDialog` that holds
 * state has to be mounted permanently or it loses what was typed on the frame
 * it opens. The copy is the point: an owner reading this must be certain that
 * nothing is being deleted.
 */
function SuspendDialog({
  row,
  onClose,
  onConfirm,
}: {
  row: AdminStoreRow | null;
  onClose: () => void;
  onConfirm: (note: string | null) => void | Promise<void>;
}) {
  const [note, setNote] = useState("");

  useEffect(() => {
    if (row) setNote("");
  }, [row]);

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>إيقاف وصول «{row?.store_name}»؟</DialogTitle>
          <DialogDescription className="leading-relaxed">
            سيُقفل التطبيق لدى هذا المتجر عند أول تحقق، وستظهر لهم رسالة تقول إن
            الوصول موقوف من إدارة النظام وإن بياناتهم سليمة. لا يُحذف أي سجل،
            والمزامنة تظل تعمل حتى تُرفع أي عمليات بيع لم تُرسل بعد. يمكنك إعادة
            التفعيل في أي وقت بضغطة واحدة.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-1">
          <Label htmlFor="suspend-note">ملاحظة داخلية (اختياري)</Label>
          <Input
            id="suspend-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="مثال: لم يُسدَّد اشتراك سبتمبر"
          />
          <p className="text-[11px] text-muted-foreground">
            تُحفظ مع الترخيص ولا تظهر للعميل.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => void onConfirm(note.trim() || null)}
          >
            نعم، أوقف الوصول
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Extend an existing licence.
 *
 * The presets add days on the SERVER, from `GREATEST(now(), valid_until)` —
 * not from a date computed in this browser. A licence that lapsed in June,
 * extended by 90 days, must run 90 days from today; and the machine issuing
 * the licence is not necessarily the one with the right clock.
 */
function ExtendDialog({
  row,
  onClose,
  onSaved,
}: {
  row: AdminStoreRow;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [mode, setMode] = useState<"days" | "date">("days");
  const [days, setDays] = useState(30);
  const [until, setUntil] = useState(() => plusMonths(12));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const gate = useSubmitGate();

  const handleSave = async () => {
    let untilIso: string | undefined;
    if (mode === "date") {
      const iso = endOfDayIso(until);
      if (!iso) return toast.error("تاريخ غير صالح");
      if (Date.parse(iso) <= Date.now()) {
        return toast.error("تاريخ الانتهاء يجب أن يكون في المستقبل");
      }
      untilIso = iso;
    }

    if (!gate.enter()) return;
    setSaving(true);
    try {
      await extendLicense({
        storeId: row.store_id,
        days: mode === "days" ? days : undefined,
        until: untilIso,
        note: note.trim() || null,
      });
      toast.success(`تم تمديد ترخيص «${row.store_name}»`);
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر التمديد");
    } finally {
      setSaving(false);
      gate.exit();
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>تمديد الترخيص</DialogTitle>
          <DialogDescription>
            {row.store_name || row.store_id} — صالح حتى {fmtDate(row.valid_until)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-2">
            <Label>مدة التمديد</Label>
            <div className="grid grid-cols-4 gap-2">
              {[30, 90, 180, 365].map((d) => (
                <Button
                  key={d}
                  type="button"
                  variant={mode === "days" && days === d ? "default" : "outline"}
                  onClick={() => {
                    setMode("days");
                    setDays(d);
                  }}
                >
                  {d} يوم
                </Button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              تُضاف من تاريخ الانتهاء الحالي، أو من اليوم لو كان الترخيص منتهياً.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="extend-until">أو تاريخ انتهاء محدد</Label>
            <Input
              id="extend-until"
              type="date"
              value={until}
              min={toDateInput(new Date())}
              onChange={(e) => {
                setUntil(e.target.value);
                setMode("date");
              }}
              className={mode === "date" ? "border-primary" : ""}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="extend-note">ملاحظة داخلية (اختياري)</Label>
            <Input
              id="extend-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="مثال: سدّد اشتراك سنة"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            إلغاء
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? "جارٍ التمديد…" : "تمديد"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Issue a licence, or replace the one a store has. The only path that mints a key. */
function ActivateDialog({
  row,
  onClose,
  onSaved,
}: {
  row: AdminStoreRow;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [plan, setPlan] = useState<"BASIC" | "PRO">(row.plan_type ?? "PRO");
  const [key, setKey] = useState(row.license_key ?? "");
  // Renewing a licence that already lapsed should default to a year from TODAY,
  // not a year from a date in the past.
  const [until, setUntil] = useState(() => {
    const cur = row.valid_until ? new Date(row.valid_until) : null;
    return cur && cur.getTime() > Date.now() ? toDateInput(cur) : plusMonths(12);
  });
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  // One submit at a time; `saving` state cannot close the same-tick window.
  const gate = useSubmitGate();

  const handleSave = async () => {
    if (!key.trim()) return toast.error("مفتاح الترخيص مطلوب");
    if (!until) return toast.error("تاريخ الانتهاء مطلوب");

    // End of the chosen day, local time — see `endOfDayIso`.
    const validUntil = endOfDayIso(until);
    if (!validUntil) return toast.error("تاريخ غير صالح");
    if (Date.parse(validUntil) <= Date.now()) {
      return toast.error("تاريخ الانتهاء يجب أن يكون في المستقبل");
    }

    if (!gate.enter()) return;
    setSaving(true);
    try {
      await setLicense({
        storeId: row.store_id,
        licenseKey: key.trim(),
        planType: plan,
        validUntil,
        status: "active",
        note: note.trim() || null,
      });
      toast.success(`تم تفعيل «${row.store_name}»`);
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر حفظ الترخيص");
    } finally {
      setSaving(false);
      gate.exit();
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{row.license_key ? "إصدار ترخيص جديد" : "تفعيل المتجر"}</DialogTitle>
          <DialogDescription>{row.store_name || row.store_id}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-2">
            <Label htmlFor="activate-plan">الباقة</Label>
            <Select value={plan} onValueChange={(v) => setPlan(v as "BASIC" | "PRO")}>
              <SelectTrigger id="activate-plan">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BASIC">BASIC</SelectItem>
                <SelectItem value="PRO">PRO</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="activate-key">مفتاح الترخيص</Label>
            <div className="flex gap-2">
              <Input
                id="activate-key"
                value={key}
                onChange={(e) => setKey(e.target.value.toUpperCase())}
                placeholder="NEXUS-PRO-XXXX-XXXX-XXXX-XXXX"
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => setKey(generateLicenseKey(plan))}
                className="shrink-0"
              >
                توليد مفتاح
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="activate-until">صالح حتى</Label>
            {/* Native date input: the OS picker is already localised and
                keyboard-accessible, so a component would be strictly worse. */}
            <Input
              id="activate-until"
              type="date"
              value={until}
              min={toDateInput(new Date())}
              onChange={(e) => setUntil(e.target.value)}
            />
            <div className="flex gap-2 pt-1">
              {[
                { label: "شهر", m: 1 },
                { label: "3 شهور", m: 3 },
                { label: "6 شهور", m: 6 },
                { label: "سنة", m: 12 },
              ].map((p) => (
                <Button
                  key={p.m}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setUntil(plusMonths(p.m))}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="activate-note">ملاحظة داخلية (اختياري)</Label>
            <Input
              id="activate-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="مثال: دفع نقداً — فاتورة ٢٣"
            />
          </div>

          {/* Read-only history. The owner asked "when did this start" often
              enough that hiding it behind the database is unhelpful. */}
          {(row.activated_at || row.reactivated_at) && (
            <dl className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground pt-1">
              {row.activated_at && (
                <div>
                  <dt>فُعّل في</dt>
                  <dd className="text-foreground/80">{fmtDate(row.activated_at)}</dd>
                </div>
              )}
              {row.reactivated_at && (
                <div>
                  <dt>أُعيد تفعيله في</dt>
                  <dd className="text-foreground/80">{fmtDate(row.reactivated_at)}</dd>
                </div>
              )}
            </dl>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            إلغاء
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? "جارٍ الحفظ…" : "حفظ الترخيص"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
