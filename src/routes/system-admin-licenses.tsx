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
  revokeLicense,
  generateLicenseKey,
  type AdminStoreRow,
} from "@/services/licenseAdmin";
import { toDateInput, plusMonths, endOfDayIso } from "@/lib/license/key";
import { RefreshCw, KeyRound, Ban, Search, ShieldCheck } from "lucide-react";

/**
 * The License Manager.
 *
 * Every button here calls an RPC that re-verifies ownership in Postgres, so
 * this file contains no secrets and enforces nothing — it is a control surface
 * over `008_license_admin_rpc.sql`.
 */

type Filter = "all" | "active" | "expired" | "none";

/** The verdict shown per row. Mirrors `evaluateLicense`, on the list's data. */
function rowState(r: AdminStoreRow): { label: string; tone: string; sortKey: number } {
  if (!r.license_key || !r.valid_until) {
    return { label: "بدون ترخيص", tone: "bg-slate-500/10 text-slate-400 border-slate-500/20", sortKey: 3 };
  }
  if (r.status === "expired") {
    return { label: "موقوف", tone: "bg-red-500/10 text-red-400 border-red-500/20", sortKey: 0 };
  }
  const days = Math.floor((Date.parse(r.valid_until) - Date.now()) / 86_400_000);
  if (days < 0) {
    return { label: "منتهي", tone: "bg-red-500/10 text-red-400 border-red-500/20", sortKey: 1 };
  }
  if (days <= 14) {
    return {
      label: `يقارب الانتهاء (${days} يوم)`,
      tone: "bg-amber-500/10 text-amber-400 border-amber-500/20",
      sortKey: 2,
    };
  }
  return { label: "ساري", tone: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20", sortKey: 4 };
}

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("ar-EG", { year: "numeric", month: "short", day: "numeric" })
    : "—";

export function SystemAdminLicenses() {
  const [rows, setRows] = useState<AdminStoreRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const [editing, setEditing] = useState<AdminStoreRow | null>(null);
  const [revoking, setRevoking] = useState<AdminStoreRow | null>(null);

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
    return rows.filter((r) => {
      if (q && !r.store_name?.toLowerCase().includes(q) && !r.license_key?.toLowerCase().includes(q)) {
        return false;
      }
      if (filter === "none") return !r.license_key;
      if (filter === "active") {
        return !!r.license_key && r.status === "active" && Date.parse(r.valid_until ?? "") > Date.now();
      }
      if (filter === "expired") {
        return !!r.license_key && (r.status === "expired" || Date.parse(r.valid_until ?? "") <= Date.now());
      }
      return true;
    });
  }, [rows, query, filter]);

  const stats = useMemo(() => {
    let active = 0;
    let expired = 0;
    let unlicensed = 0;
    for (const r of rows) {
      const s = rowState(r);
      if (s.label === "بدون ترخيص") unlicensed++;
      else if (s.label === "موقوف" || s.label === "منتهي") expired++;
      else active++;
    }
    return { active, expired, unlicensed, total: rows.length };
  }, [rows]);

  const handleRevoke = async () => {
    if (!revoking) return;
    const target = revoking;
    setRevoking(null);
    try {
      await revokeLicense(target.store_id);
      toast.success(`تم إيقاف ترخيص «${target.store_name}»`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر إيقاف الترخيص");
    }
  };

  return (
    <div dir="rtl" className="p-6 space-y-6 max-w-[1200px] mx-auto">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="size-11 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <ShieldCheck className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">إدارة التراخيص</h1>
            <p className="text-sm text-muted-foreground mt-1">
              إصدار وتجديد وإيقاف تراخيص المتاجر. هذه الشاشة متاحة لمالك النظام فقط.
            </p>
          </div>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`size-4 ml-2 ${loading ? "animate-spin" : ""}`} />
          تحديث
        </Button>
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "إجمالي المتاجر", value: stats.total, tone: "text-foreground" },
          { label: "تراخيص سارية", value: stats.active, tone: "text-emerald-500" },
          { label: "منتهية أو موقوفة", value: stats.expired, tone: "text-red-500" },
          { label: "بدون ترخيص", value: stats.unlicensed, tone: "text-muted-foreground" },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground mb-1.5">{c.label}</p>
            <p className={`text-2xl font-bold tabular-nums ${c.tone}`}>{c.value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث باسم المتجر أو مفتاح الترخيص…"
            className="pr-9"
          />
        </div>
        <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل الحالات</SelectItem>
            <SelectItem value="active">ساري</SelectItem>
            <SelectItem value="expired">منتهي أو موقوف</SelectItem>
            <SelectItem value="none">بدون ترخيص</SelectItem>
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
                <th className="text-right font-medium px-4 py-3">الحالة</th>
                <th className="text-right font-medium px-4 py-3">الباقة</th>
                <th className="text-right font-medium px-4 py-3">ينتهي في</th>
                <th className="text-right font-medium px-4 py-3">المفتاح</th>
                <th className="text-right font-medium px-4 py-3">المستخدمون</th>
                <th className="text-left font-medium px-4 py-3">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                    جارٍ التحميل…
                  </td>
                </tr>
              )}
              {!loading && visible.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                    لا توجد متاجر مطابقة.
                  </td>
                </tr>
              )}
              {visible.map((r) => {
                const st = rowState(r);
                return (
                  <tr key={r.store_id} className="border-t hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-medium">{r.store_name || "بدون اسم"}</p>
                      <p className="text-[11px] text-muted-foreground font-mono mt-0.5">
                        {r.store_id.slice(0, 8)}…
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={st.tone}>
                        {st.label}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">{r.plan_type ?? "—"}</td>
                    <td className="px-4 py-3 tabular-nums">{fmtDate(r.valid_until)}</td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-muted-foreground">
                        {r.license_key ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums">{r.member_count}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 justify-end">
                        <Button size="sm" variant="outline" onClick={() => setEditing(r)}>
                          <KeyRound className="size-3.5 ml-1.5" />
                          {r.license_key ? "تجديد" : "إصدار"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          disabled={!r.license_key || r.status === "expired"}
                          onClick={() => setRevoking(r)}
                        >
                          <Ban className="size-3.5 ml-1.5" />
                          إيقاف
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <LicenseDialog
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}

      <AlertDialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>إيقاف ترخيص «{revoking?.store_name}»؟</AlertDialogTitle>
            <AlertDialogDescription className="leading-relaxed">
              سيتم قفل واجهة البرنامج لدى هذا المتجر فوراً عند أول تحقق. بياناته
              لن تُحذف، والمزامنة ستظل تعمل حتى تُرفع أي عمليات بيع لم تُرسل بعد.
              يمكنك إعادة التفعيل في أي وقت بإصدار ترخيص جديد.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleRevoke()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              نعم، أوقف الترخيص
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function LicenseDialog({
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
      });
      toast.success(`تم حفظ ترخيص «${row.store_name}»`);
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
          <DialogTitle>{row.license_key ? "تجديد الترخيص" : "إصدار ترخيص جديد"}</DialogTitle>
          <DialogDescription>{row.store_name || row.store_id}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-2">
            <Label>الباقة</Label>
            <Select value={plan} onValueChange={(v) => setPlan(v as "BASIC" | "PRO")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BASIC">BASIC</SelectItem>
                <SelectItem value="PRO">PRO</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>مفتاح الترخيص</Label>
            <div className="flex gap-2">
              <Input
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
            <Label>صالح حتى</Label>
            {/* Native date input: the OS picker is already localised and
                keyboard-accessible, so a component would be strictly worse. */}
            <Input
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
