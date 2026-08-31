/**
 * تسوية مرتجع تاجر — the one reconciliation panel, for every screen.
 *
 * A trader almost never gets cash back: they owe us money, so returned goods
 * pay down the debt first and only a surplus crosses the counter. That rule is
 * the same whether the return starts at نقطة البيع, in الطلبات, or on the
 * الجملة screen — so the panel that explains it is shared too, and the numbers
 * come from `reconcileWholesaleReturn` rather than each screen's own arithmetic.
 *
 * Presentational on purpose: it takes the debt and the returned value, and
 * hands back what the cashier typed. The events are the caller's business.
 */

import { formatQty } from "@/lib/math";
import { reconcileWholesaleReturn } from "@/lib/ledger/wholesale";

/**
 * Which side of the counter the debt sits on.
 *
 *   "client"    a trader owes US   → surplus leaves the till
 *   "supplier"  WE owe a supplier  → surplus comes back INTO the till
 *
 * The arithmetic is identical; only the direction of the leftover cash and the
 * words describing it differ, so one panel serves both rather than two files
 * drifting apart the way POS and المرتجعات did.
 */
export type ReconcileVariant = "client" | "supplier";

const COPY: Record<ReconcileVariant, { title: string; debt: string; surplus: string; missing: string }> = {
  client: {
    title: "تسوية مرتجع تاجر",
    debt: "المديونية السابقة",
    surplus: "مسترد للتاجر نقداً",
    missing: "اختر التاجر أولاً عشان نحسب المديونية.",
  },
  supplier: {
    title: "تسوية مرتجع مورد",
    debt: "مديونيتنا للمورد",
    surplus: "مسترد لنا من المورد نقداً",
    missing: "اختر المورد أولاً عشان نحسب المديونية.",
  },
};

export interface WholesaleReturnPanelProps {
  /** What the client owes right now, EGP — `receivable_client` for them. */
  debt: number;
  /** What is coming back, EGP. */
  returnValue: number;
  /** The raw contents of المبلغ المدفوع, kept by the caller. */
  paidInput: string;
  onPaidChange: (value: string) => void;
  /** Shown instead of the maths when no party has been chosen yet. */
  clientMissing?: boolean;
  /** Whose debt this is. Defaults to a trader's. */
  variant?: ReconcileVariant;
}

export function WholesaleReturnPanel({
  debt,
  returnValue,
  paidInput,
  onPaidChange,
  clientMissing = false,
  variant = "client",
}: WholesaleReturnPanelProps) {
  const copy = COPY[variant];
  const { remainingDebt, cashBack, newDebt } = reconcileWholesaleReturn(
    returnValue,
    debt,
    paidInput,
  );

  return (
    <div className="space-y-3 rounded-xl bg-amber-50/60 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 p-4">
      <p className="text-base font-bold text-amber-900 dark:text-amber-200">{copy.title}</p>

      {clientMissing ? (
        <p className="text-sm text-amber-800 dark:text-amber-300">{copy.missing}</p>
      ) : (
        <>
          <div className="flex items-center justify-between text-base">
            <span className="text-muted-foreground">{copy.debt}</span>
            <span className="font-bold">{formatQty(debt)} ج.م</span>
          </div>
          <div className="flex items-center justify-between text-base text-green-700 dark:text-green-400">
            <span>قيمة المرتجع</span>
            <span className="font-bold">− {formatQty(returnValue)} ج.م</span>
          </div>

          <div className="flex items-center justify-between text-base border-t border-amber-200 dark:border-amber-900 pt-2">
            <span className="font-semibold">المتبقي</span>
            <span className="text-xl font-black">{formatQty(remainingDebt)} ج.م</span>
          </div>

          {remainingDebt > 0 ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <label className="text-base font-semibold">المبلغ المدفوع</label>
                <input
                  type="number"
                  min={0}
                  max={remainingDebt}
                  value={paidInput}
                  onChange={(e) => onPaidChange(e.target.value)}
                  placeholder="0"
                  className="h-10 w-36 rounded-lg border border-input bg-background px-3 text-lg font-bold text-left"
                />
              </div>
              <div className="flex items-center justify-between text-base border-t border-amber-200 dark:border-amber-900 pt-2">
                <span className="font-bold">المديونية بعد التسوية</span>
                <span className="text-2xl font-black text-primary">{formatQty(newDebt)} ج.م</span>
              </div>
            </>
          ) : (
            /* R >= D: nothing is left to pay down, so no input at all — the
               surplus is money going back to the trader. */
            <div className="flex items-center justify-between text-base border-t border-amber-200 dark:border-amber-900 pt-2">
              <span className="font-bold text-red-700 dark:text-red-400">{copy.surplus}</span>
              <span className="text-2xl font-black text-red-700 dark:text-red-400">
                {formatQty(cashBack)} ج.م
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
