import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/store/useAuthStore";
import { toAppRole } from "@/lib/roles";
import { getActiveStoreId } from "@/services/api/storeContext";
import { useOwnerBudget } from "@/hooks/useOwnerBudget";
import { balances, events, type LedgerEvent } from "@/lib/ledger";
import {
  ownerSpent,
  periodStart,
  budgetStatus,
  ownerSubjectFor,
  buildOwnerDrawLines,
  OWNER_SUBJECT,
} from "@/lib/ledger/ownerDraw";
import { buildOwnerCapitalLines, buildOwnerContributionLines } from "@/lib/ledger/equity";
import { appendFinancialEvent } from "@/lib/financialCommand";
import { commitSupplierPayment, formatSupplierPaymentSuccess } from "@/lib/supplierPaymentCommand";
import { recordFinanceDocument, type FinanceDocumentDraft } from "@/lib/financeDocument";
import { readSuppliers, type SupplierOption } from "@/lib/receiving/suppliers";
import { EXPENSE_CATEGORIES } from "@/lib/expenseCategories";
import { WALLET_LABELS, type WalletType } from "@/types";
import { formatMoney } from "@/lib/math";
import { useRealtimeTables } from "@/mobile/data/useMobileRealtime";
import { toast } from "sonner";
import { localDateInput } from "@/lib/localDateInput";

const ACTIONS = {
  expense: "مصروف تشغيل",
  payroll: "راتب / دفعة موظف",
  supplier: "دفعة مورد",
  draw: "مسحوب شخصي",
  capital: "رأس مال",
  contribution: "مساهمة إضافية",
  budget: "ضبط الميزانية الشخصية",
} as const;
type Action = keyof typeof ACTIONS;
const KINDS: Record<string, string> = {
  expense: "مصروف تشغيل",
  payroll: "دفعة موظف",
  supplier_payment: "دفعة مورد",
  owner_draw: "مسحوب شخصي",
  owner_capital: "رأس مال",
  owner_contribution: "مساهمة إضافية",
  purchase: "توريد",
};
const initial = () => ({
  amount: "",
  wallet: "inStoreSafe" as WalletType,
  category: "other",
  note: "",
  employeeName: "",
  paymentType: "salary" as FinanceDocumentDraft["paymentType"],
  supplierId: "",
  drawCategory: "",
  cashNow: false,
  periodType: "monthly" as "monthly" | "open",
  date: localDateInput(),
  startedAt: Date.now(),
});
type Form = ReturnType<typeof initial>;
type SavedDraft = { action: "expense" | "payroll"; form: Form; id: string };

export function MobileFinanceActions({
  supplierPayable,
  onSaved,
  offline = false,
}: {
  supplierPayable: { subjectId: string; amount: number }[] | null;
  onSaved: () => void;
  offline?: boolean;
}) {
  const role = toAppRole(useAuthStore((s) => s.userRole));
  return role === "ADMIN" ? (
    <FinanceActions supplierPayable={supplierPayable} onSaved={onSaved} offline={offline} />
  ) : null;
}

function FinanceActions({
  supplierPayable,
  onSaved,
  offline = false,
}: {
  supplierPayable: { subjectId: string; amount: number }[] | null;
  onSaved: () => void;
  offline?: boolean;
}) {
  const budget = useOwnerBudget();
  const [action, setAction] = useState<Action | null>(null);
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const gate = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const documentId = useRef<string | null>(null);
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [supplierError, setSupplierError] = useState<string | null>(null);
  const [supplierLoading, setSupplierLoading] = useState(false);
  const [spent, setSpent] = useState<number | null>(null);
  const [activity, setActivity] = useState<LedgerEvent[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = () => {
    setTick((x) => x + 1);
    budget.reload();
    onSaved();
  };
  useRealtimeTables(["ledger_events"], () => setTick((x) => x + 1));
  useEffect(() => {
    let alive = true;
    void getActiveStoreId()
      .then((storeId) => {
        if (!alive || !storeId) return;
        const key = `nexus-mobile-finance-draft:${storeId}`;
        setDraftKey(key);
        const saved = sessionStorage.getItem(key);
        if (saved) {
          const draft: SavedDraft = JSON.parse(saved);
          documentId.current = draft.id;
          setAction(draft.action);
          setForm(draft.form);
          setUncertain(true);
          setError("في عملية محتاجة تأكيد. أعد المحاولة بنفس البيانات للتحقق منها.");
        }
      })
      .catch(() => {
        if (alive) setError("تعذّر استعادة مسودة العملية. أعد تحميل الصفحة قبل التسجيل.");
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    setReadError(null);
    setSpent(null);
    const b = budget.ownerBudget;
    void Promise.all([
      events({ limit: 30 }),
      b
        ? balances({ account: "owner_budget", from: periodStart(b), to: new Date() })
        : Promise.resolve(null),
    ])
      .then(([rows, draws]) => {
        if (alive) {
          setActivity(rows.filter((row) => KINDS[row.kind]));
          setSpent(draws ? ownerSpent(draws) : null);
        }
      })
      .catch((e) => {
        if (alive) {
          setActivity([]);
          setReadError(String(e.message ?? e));
        }
      });
    return () => {
      alive = false;
    };
  }, [
    tick,
    budget.ownerBudget?.limit,
    budget.ownerBudget?.periodType,
    budget.ownerBudget?.startedAt,
  ]);
  useEffect(() => {
    if (action !== "supplier") return;
    let alive = true;
    setSupplierLoading(true);
    const timer = setTimeout(() => {
      void readSuppliers({ search, limit: 50 })
        .then(
          (rows) => {
            if (alive) {
              setSuppliers(rows);
              setSupplierError(null);
            }
          },
          (e) => {
            if (alive) {
              setSuppliers([]);
              setSupplierError(String(e.message ?? e));
            }
          },
        )
        .finally(() => {
          if (alive) setSupplierLoading(false);
        });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [action, search]);

  const open = (next: Action) => {
    const b = budget.ownerBudget;
    setForm({
      ...initial(),
      ...(next === "budget" && b
        ? { amount: String(b.limit), periodType: b.periodType, startedAt: b.startedAt }
        : {}),
    });
    setError(null);
    setSearch("");
    documentId.current = null;
    setAction(next);
  };
  const close = () => {
    if (saving || uncertain) return;
    setAction(null);
    setForm(initial());
    setError(null);
  };
  const change = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  async function submit() {
    if (!action || gate.current || !draftKey || offline) return;
    const amount = Number(form.amount);
    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001
    ) {
      setError("أدخل مبلغاً أكبر من صفر بحد أقصى منزلتين عشريتين");
      return;
    }
    gate.current = true;
    setSaving(true);
    setError(null);
    try {
      if (action === "expense" || action === "payroll") {
        if (action === "payroll" && !form.employeeName.trim()) throw new Error("أدخل اسم الموظف");
        // The document ID belongs to the form, and survives navigation/reload
        // until the existing Desktop RPC confirms or definitely rejects it.
        documentId.current ??= crypto.randomUUID();
        sessionStorage.setItem(
          draftKey,
          JSON.stringify({ action, form, id: documentId.current } satisfies SavedDraft),
        );
        const wasUncertain = uncertain;
        setUncertain(true);
        const result = await recordFinanceDocument({
          id: documentId.current,
          kind: action,
          ...form,
          amount,
          date: `${form.date}T00:00:00`,
          employeeName: form.employeeName.trim(),
        });
        if (!result.success) {
          if (result.definite && !wasUncertain) {
            sessionStorage.removeItem(draftKey);
            documentId.current = null;
            setUncertain(false);
          } else setUncertain(true);
          throw new Error(result.reason);
        }
        sessionStorage.removeItem(draftKey);
        setUncertain(false);
        documentId.current = null;
      } else if (action === "supplier") {
        const supplier = suppliers.find((s) => s.id === form.supplierId);
        if (!supplier) throw new Error("اختر مورداً من القائمة");
        const result = await commitSupplierPayment({
          supplierId: supplier.id,
          supplierName: supplier.companyName,
          amount,
          wallet: form.wallet,
          note: form.note.trim(),
          invoices: [],
          actor: "ADMIN",
        });
        toast.success(formatSupplierPaymentSuccess(result));
      } else if (action === "budget") {
        await budget.setOwnerBudget({
          limit: amount,
          periodType: form.periodType,
          startedAt: form.startedAt,
        });
      } else {
        const kind =
          action === "draw"
            ? "owner_draw"
            : action === "capital"
              ? "owner_capital"
              : "owner_contribution";
        await appendFinancialEvent({
          kind,
          refType: kind,
          refId: OWNER_SUBJECT,
          occurredAt:
            action === "draw" ? new Date(form.startedAt) : new Date(`${form.date}T00:00:00`),
          actor: "ADMIN",
          payload: {
            note: form.note.trim(),
            category: form.drawCategory.trim(),
            wallet: action === "capital" && !form.cashNow ? undefined : form.wallet,
          },
          lines:
            action === "draw"
              ? buildOwnerDrawLines({
                  subjectId: ownerSubjectFor(form.drawCategory),
                  amount,
                  wallet: form.wallet,
                })
              : action === "capital"
                ? buildOwnerCapitalLines({
                    subjectId: OWNER_SUBJECT,
                    amount,
                    wallet: form.cashNow ? form.wallet : null,
                  })
                : buildOwnerContributionLines({
                    subjectId: OWNER_SUBJECT,
                    amount,
                    wallet: form.wallet,
                  }),
        });
      }
      toast.success("تم الحفظ في السجل المشترك");
      setAction(null);
      setForm(initial());
      refresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      gate.current = false;
      setSaving(false);
    }
  }
  const status =
    budget.ownerBudget && spent !== null ? budgetStatus(budget.ownerBudget.limit, spent) : null;
  const due = supplierPayable?.find((row) => row.subjectId === form.supplierId)?.amount ?? 0;
  return (
    <section
      className="mobile-finance"
      dir="rtl"
      data-pwa-unsaved={Boolean(action) || saving || uncertain}
    >
      <h2>إدارة المال</h2>
      {!action && (
        <div className="mobile-finance-actions">
          {Object.entries(ACTIONS).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => open(key as Action)}
              disabled={!draftKey || (key === "budget" && (budget.loading || !!budget.error))}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="mobile-finance-error">
          {error}
        </p>
      )}
      {action && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="mobile-finance-form"
        >
          <h3>{ACTIONS[action]}</h3>
          {uncertain && (
            <p>البيانات مقفولة لحد تأكيد نفس العملية. إعادة المحاولة لا تنشئ دفعة جديدة.</p>
          )}
          <fieldset disabled={saving || uncertain}>
            {action === "expense" && (
              <label>
                التصنيف
                <select value={form.category} onChange={(e) => change("category", e.target.value)}>
                  {EXPENSE_CATEGORIES.retail.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {action === "payroll" && (
              <>
                <label>
                  اسم الموظف
                  <input
                    required
                    value={form.employeeName}
                    onChange={(e) => change("employeeName", e.target.value)}
                  />
                </label>
                <label>
                  نوع الدفعة
                  <select
                    value={form.paymentType}
                    onChange={(e) => change("paymentType", e.target.value as Form["paymentType"])}
                  >
                    <option value="salary">راتب</option>
                    <option value="bonus">مكافأة</option>
                    <option value="advance">سلفة</option>
                  </select>
                </label>
              </>
            )}
            {action === "supplier" && (
              <>
                <label>
                  بحث المورد
                  <input
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      change("supplierId", "");
                    }}
                  />
                </label>
                <label>
                  المورد
                  <select
                    required
                    value={form.supplierId}
                    onChange={(e) => change("supplierId", e.target.value)}
                  >
                    <option value="">اختر المورد</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.companyName}
                      </option>
                    ))}
                  </select>
                </label>
                {supplierLoading ? (
                  <p>جاري تحميل الموردين…</p>
                ) : supplierError ? (
                  <p role="alert">{supplierError}</p>
                ) : (
                  form.supplierId && (
                    <p>
                      الرصيد المستحق:{" "}
                      {supplierPayable && !offline ? formatMoney(due) : "تعذّر تحميل الرصيد"}.
                      الدفعة تتوزع على الأقدم تلقائياً، والزيادة رصيد مقدّم.
                    </p>
                  )
                )}
              </>
            )}
            <label>
              {action === "budget" ? "حد الميزانية (ج.م)" : "المبلغ (ج.م)"}
              <input
                required
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={form.amount}
                onChange={(e) => change("amount", e.target.value)}
              />
            </label>
            {action === "budget" ? (
              <>
                <label>
                  الفترة
                  <select
                    value={form.periodType}
                    onChange={(e) => change("periodType", e.target.value as Form["periodType"])}
                  >
                    <option value="monthly">شهري — يبدأ أول كل شهر</option>
                    <option value="open">بدون مدة — من آخر تصفير</option>
                  </select>
                </label>
                {form.periodType === "open" && (
                  <label>
                    <input
                      type="checkbox"
                      checked={form.startedAt !== (budget.ownerBudget?.startedAt ?? form.startedAt)}
                      onChange={(e) =>
                        change(
                          "startedAt",
                          e.target.checked
                            ? Date.now()
                            : (budget.ownerBudget?.startedAt ?? form.startedAt),
                        )
                      }
                    />
                    ابدأ فترة جديدة عند الحفظ (المسحوبات القديمة تظل محفوظة)
                  </label>
                )}
              </>
            ) : (
              <>
                {action === "capital" && (
                  <label>
                    <input
                      type="checkbox"
                      checked={form.cashNow}
                      onChange={(e) => change("cashNow", e.target.checked)}
                    />
                    الفلوس دخلت الخزنة الآن
                  </label>
                )}
                {action === "capital" && !form.cashNow && (
                  <p>إثبات رأس مال تاريخي فقط، بدون زيادة نقدية في الخزنة.</p>
                )}
                {(action !== "capital" || form.cashNow) && (
                  <label>
                    الخزنة / المحفظة
                    <select
                      value={form.wallet}
                      onChange={(e) => change("wallet", e.target.value as WalletType)}
                    >
                      {Object.entries(WALLET_LABELS).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {action === "draw" && (
                  <>
                    <label>
                      تصنيف شخصي
                      <input
                        value={form.drawCategory}
                        onChange={(e) => change("drawCategory", e.target.value)}
                      />
                    </label>
                    <p>مسحوب من حقوق الملكية، لا يزيد مصروفات التشغيل.</p>
                  </>
                )}
                {action !== "supplier" && action !== "draw" && (
                  <label>
                    التاريخ
                    <input
                      required
                      type="date"
                      value={form.date}
                      onChange={(e) => change("date", e.target.value)}
                    />
                  </label>
                )}
                <label>
                  ملاحظات
                  <input value={form.note} onChange={(e) => change("note", e.target.value)} />
                </label>
              </>
            )}
          </fieldset>
          <div className="mobile-finance-actions">
            <button
              type="submit"
              disabled={
                saving ||
                offline ||
                !draftKey ||
                (action === "supplier" && (supplierLoading || !!supplierError))
              }
            >
              {saving ? "جاري التأكيد…" : uncertain ? "تأكيد نفس العملية" : "حفظ"}
            </button>
            <button type="button" disabled={saving || uncertain} onClick={close}>
              إلغاء
            </button>
          </div>
          {action === "budget" && budget.ownerBudget && (
            <button
              type="button"
              disabled={saving || offline}
              onClick={async () => {
                if (!window.confirm("إلغاء حد الميزانية المشتركة؟ المسحوبات تظل في الدفتر."))
                  return;
                if (gate.current) return;
                gate.current = true;
                setSaving(true);
                setError(null);
                try {
                  await budget.clearOwnerBudget();
                  setAction(null);
                  refresh();
                } catch (e) {
                  setError(String(e instanceof Error ? e.message : e));
                } finally {
                  gate.current = false;
                  setSaving(false);
                }
              }}
            >
              إلغاء حد الميزانية
            </button>
          )}
        </form>
      )}
      {!offline && (
        <>
          <div className="mobile-owner-card">
            <h3>ميزانيتي الشخصية</h3>
            {budget.loading ? (
              <p>جاري التحميل…</p>
            ) : budget.error ? (
              <p role="alert">تعذّر قراءة الميزانية: {budget.error}</p>
            ) : !budget.ownerBudget ? (
              <p>غير محددة — احفظ ميزانية مشتركة من «ضبط الميزانية الشخصية».</p>
            ) : (
              <>
                <p>
                  الحد: {formatMoney(budget.ownerBudget.limit)} ·{" "}
                  {budget.ownerBudget.periodType === "monthly" ? "شهري" : "بدون مدة"}
                </p>
                {status && (
                  <p>
                    المسحوبات: {formatMoney(status.spent)} · المتبقي:{" "}
                    {formatMoney(status.remaining)}
                  </p>
                )}
                {!status && !readError && <p>جاري حساب المسحوبات…</p>}
              </>
            )}
          </div>
          <div className="mobile-owner-card">
            <h3>آخر الحركات المالية</h3>
            {readError ? (
              <p role="alert">
                تعذّر تحميل الحركات: {readError}
                <button onClick={refresh}>إعادة المحاولة</button>
              </p>
            ) : activity.length ? (
              <ul>
                {activity.map((row) => (
                  <li key={row.id}>
                    <strong>{KINDS[row.kind]}</strong> ·{" "}
                    {new Date(row.occurredAt).toLocaleDateString("ar-EG")}
                    <br />
                    {String(row.payload.note ?? row.payload.description ?? row.refId ?? "")}
                  </li>
                ))}
              </ul>
            ) : (
              <p>لا حركات مالية ضمن آخر ٣٠ حركة للمتجر.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
