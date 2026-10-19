import type { CashierShift } from "@/lib/cashierShift";
import { EXPENSE_CATEGORIES } from "@/lib/expenseCategories";
import { WALLET_LABELS, type WalletType } from "@/types";

export function CashierShiftMovements({ shift }: { shift: CashierShift }) {
  return (
    <>
      <ul className="shift-records">
        {shift.movements.map((x, i) => (
          <li className="shift-record" key={x.event_id + ":" + i}>
            <div className="shift-record-top">
              <div>
                <span className="shift-record-kind">
                  {{ sale: "بيع", refund: "مرتجع", expense: "مصروف", other: "حركة نقدية" }[
                    x.category
                  ] ?? x.category}
                </span>
                <p className="shift-record-title">
                  <bdi>{x.document_number}</bdi>
                </p>
              </div>
              <strong className="shift-record-amount">
                <bdi>
                  {(x.payment_piastre / 100).toLocaleString("ar-EG", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{" "}
                  ج.م
                </bdi>
              </strong>
            </div>
            <div className="shift-record-meta">
              <span>{WALLET_LABELS[x.wallet_id as WalletType] ?? x.wallet_id}</span>
              <time dateTime={x.recorded_at}>
                {new Date(x.recorded_at).toLocaleString("ar-EG")}
              </time>
            </div>
            {x.expense_category && (
              <p>
                البند:{" "}
                {EXPENSE_CATEGORIES.retail.find((c) => c.value === x.expense_category)?.label ??
                  x.expense_category}
              </p>
            )}
            {x.expense_description && <p>{x.expense_description} — تم الصرف من العهدة</p>}
            <details className="shift-reference">
              <summary>المرجع الكامل</summary>
              <code dir="ltr">{x.event_id}</code>
            </details>
          </li>
        ))}
      </ul>
      {!shift.movements.length && (
        <p className="shift-caption">لا توجد حركات مسجلة في هذه الوردية.</p>
      )}
    </>
  );
}
