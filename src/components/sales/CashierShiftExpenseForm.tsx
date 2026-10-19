import { useRef, useState } from "react";
import { EXPENSE_CATEGORIES } from "@/lib/expenseCategories";
import { shiftMoneyInput } from "@/lib/cashierShift";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CashierShiftExpenseForm({
  availablePiastres,
  disabled,
  onRecord,
}: {
  availablePiastres: number;
  disabled: boolean;
  onRecord: (input: { category: string; amountPiastres: number; note: string }) => Promise<boolean>;
}) {
  const inFlight = useRef(false);
  const [category, setCategory] = useState("office_supplies"),
    [amount, setAmount] = useState(""),
    [note, setNote] = useState(""),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [sending, setSending] = useState(false);
  return (
    <details className="shift-disclosure">
      <summary>تسجيل مصروف من العهدة</summary>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (disabled || inFlight.current) return;
          setSaved(false);
          setError("");
          let amountPiastres: number;
          try {
            amountPiastres = shiftMoneyInput(amount);
            if (!amountPiastres) throw new Error("أدخل مبلغ المصروف أكبر من صفر.");
            if (amountPiastres > availablePiastres)
              throw new Error("نقدية ورديتك لا تكفي لهذا المصروف.");
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            return;
          }
          inFlight.current = true;
          setSending(true);
          try {
            if (await onRecord({ category, amountPiastres, note: note.trim() })) {
              setAmount("");
              setNote("");
              setSaved(true);
            }
          } catch {
            setError("تعذّر تأكيد المصروف. تحقّق من نتيجة المحاولة السابقة قبل تسجيله مجددًا.");
          } finally {
            inFlight.current = false;
            setSending(false);
          }
        }}
      >
        <fieldset disabled={disabled || sending} className="shift-action-card">
          <legend>مصروف نقدي من ورديتك الحالية</legend>
          <label>
            بند المصروف
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setSaved(false);
              }}
            >
              {EXPENSE_CATEGORIES.retail.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            مبلغ المصروف (جنيه)
            <Input
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setSaved(false);
              }}
              autoComplete="off"
            />
          </label>
          <label>
            الوصف أو رقم الإيصال الورقي (اختياري)
            <Input
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setSaved(false);
              }}
              maxLength={500}
              placeholder="مثل: فطار الموظفين — إيصال ١٢"
            />
          </label>
          <p className="shift-note">
            المصدر: نقدية العهدة الحالية فقط. احتفظ بالإيصال الورقي لعرضه على المدير.
          </p>
          {error && <p role="alert">{error}</p>}
          <Button type="submit" disabled={!amount.trim()} className="shift-primary-action">
            {sending ? "جارٍ تأكيد المصروف…" : "تسجيل المصروف من النقدية"}
          </Button>
        </fieldset>
        {saved && (
          <p role="status" className="shift-note">
            تم تسجيل المصروف وخصمه من العهدة مرة واحدة. يظهر في حركة الوردية.
          </p>
        )}
      </form>
    </details>
  );
}
