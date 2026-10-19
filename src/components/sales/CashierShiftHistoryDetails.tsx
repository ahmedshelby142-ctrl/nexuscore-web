import { useEffect, useRef, useState } from "react";
import { readCashierShiftHistory, shiftError } from "@/lib/cashierShift";
import { Button } from "@/components/ui/button";
import { CashierShiftMovements } from "./CashierShiftMovements";

type HistoryResult = Awaited<ReturnType<typeof readCashierShiftHistory>>;
export function CashierShiftHistoryDetails({
  shiftId,
  authority = 0,
}: {
  shiftId: string;
  authority?: number;
}) {
  const [result, setResult] = useState<{ authority: number; value: HistoryResult } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const serial = useRef(0);
  useEffect(() => {
    setResult(null);
    setError("");
    setLoading(false);
    return () => {
      serial.current++;
    };
  }, [shiftId, authority]);
  const load = async () => {
    if (loading) return;
    const request = ++serial.current;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const value = await readCashierShiftHistory(shiftId);
      if (request === serial.current) setResult({ authority, value });
    } catch (e) {
      if (request === serial.current) setError(shiftError(e));
    } finally {
      if (request === serial.current) setLoading(false);
    }
  };
  const value = result?.authority === authority ? result.value : null;
  return (
    <div className="shift-action-card">
      <Button variant="outline" disabled={loading} onClick={() => void load()}>
        {loading ? "جارٍ قراءة السجل…" : "عرض حركات الوردية للقراءة فقط"}
      </Button>
      {error && <p role="alert">{error}</p>}
      {value && (
        <div aria-label="حركات الوردية السابقة">
          <p>سجل للقراءة فقط؛ لا يعيد فتح الوردية ولا يغيّر العهدة الحالية.</p>
          <p className="shift-audit-reason">
            الكاشير المسؤول: <bdi>{value.shift.cashier_id}</bdi>
          </p>
          <CashierShiftMovements shift={value.shift} />
          <details className="shift-disclosure">
            <summary>سجل إجراءات هذه الوردية</summary>
            <ul className="shift-records">
              {value.audit.map((a) => (
                <li className="shift-record" key={a.id}>
                  <p>
                    {{
                      open: "فتح الوردية واستلام العهدة",
                      close: "تسجيل العدّ وإغلاق البيع",
                      expense: "مصروف نقدي من العهدة",
                      report_handover: "تأكيد الكاشير للتسليم",
                      confirm_handover: "تأكيد المدير للاستلام",
                      review_discrepancy: "توثيق فرق النقدية",
                      reopen: "إعادة الفتح للعدّ",
                      pos_payment: "دفعة فاتورة",
                      admin_pos_override: "تدخل مدير في فاتورة",
                      attach_movement: "تخصيص حركة مسجلة للدرج",
                    }[a.action] ??
                      (a.action.startsWith("rejected_") ? "محاولة وردية مرفوضة" : "إجراء وردية")}
                  </p>
                  <time dateTime={a.recorded_at}>
                    {new Date(a.recorded_at).toLocaleString("ar-EG")}
                  </time>
                  {a.detail.input?.reason && <p>{a.detail.input.reason}</p>}
                  <span>
                    مرجع الإجراء: <bdi>{a.id}</bdi>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}
