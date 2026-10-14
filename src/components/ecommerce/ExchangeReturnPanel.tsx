import { useAuthStore } from "@/store/useAuthStore";
import { useOrderStore } from "@/store/useOrderStore";
import { getSyncIdentity } from "@/services/api/storeContext";
import { ExchangeCreditPanel } from "./ExchangeCreditPanel";
import { useState } from "react";
import { runFinancialCommand, resolvePendingFinancialCommand } from "@/lib/financialCommand";
import { fromRemoteRow } from "@/services/api/fieldMapping";
import { refreshFeatureStock } from "@/services/featureStockMirror";
import { formatMoney } from "@/lib/math";
import type { EcommerceOrder } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRunOnce } from "@/hooks/useSubmitGate";
/** Shared Desktop/Mobile confirmation. Receiving old units is a separate fact
 * from delivering the replacement: neither action implies the other happened. */
export function ExchangeReturnPanel({
  order,
  onSaved,
  readOnly = false,
}: {
  order: EcommerceOrder;
  onSaved: (order: EcommerceOrder) => void | Promise<void>;
  readOnly?: boolean;
}) {
  const [physical, setPhysical] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [refundVia, setRefundVia] = useState(order.courierId ? "courier" : "wallet"),
    [wallet, setWallet] = useState("inStoreSafe"),
    [fee, setFee] = useState("0");
  const role = useAuthStore(state => state.userRole);
  const canChange = !readOnly && ["ADMIN", "POS_ECOMMERCE", "ECOMMERCE_ONLY"].includes(role ?? "");
  const details = order.exchangeDetails;
  const runOnce = useRunOnce();
  if (!details) return null;
  const confirm = async () =>
    runOnce(async () => {
      setBusy(true);
      setError("");
      let committed = false;
      try {
        const identity = await getSyncIdentity();
        if (!identity) throw new Error("لا يوجد متجر مسجل");
        const scope = "exchange_return:" + details.id;
        const recovered = await resolvePendingFinancialCommand<{
          order: any;
          affectedProductIds?: string[];
        }>(scope);
        if (!recovered && !physical)
          throw new Error("أكد استلام الوحدات المحددة فعليًا قبل إعادة المخزون أو رد المبلغ.");
        const result =
          recovered ??
          (await runFinancialCommand<{ order: any; affectedProductIds?: string[] }>(
            "exchange_return",
            {
              exchangeId: details.id,
              refundVia,
              wallet: refundVia === "wallet" ? wallet : undefined,
              returnFee: Number(fee),
            },
            scope,
            identity.storeId,
          ));
        committed = true;
        const saved = fromRemoteRow("orders", result.order) as EcommerceOrder;
        const current = useOrderStore.getState().orders.find(o => o.id === saved.id);
        if (result.order.store_id === identity.storeId && (await getSyncIdentity())?.storeId === identity.storeId) {
          if (!current || Number(current.updated_at ?? 0) <= Number(saved.updated_at ?? 0)) await onSaved(saved);
          await refreshFeatureStock(result.affectedProductIds ?? []);
        }
        setPhysical(false);
        window.dispatchEvent(new Event("ledger-sync-pulled"));
      } catch (e) {
        setError(committed ? "تم تأكيد استلام الأصل وتسوية رصيده؛ حدّث الصفحة لقراءة النتيجة، ولا تسجل استلامًا آخر." : e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    });
  return (
    <section
      className="rounded-xl border p-3 space-y-3 text-sm"
      aria-label={`وحدات استبدال ${order.orderNumber}`}
    >
      <ExchangeCreditPanel order={order} onSaved={onSaved} readOnly={!canChange} />
      <p>
        الطلب الأصلي: <strong>{details.originalOrderNumber}</strong>
      </p>
      <ul>
        {details.selections.map((s) => (
          <li key={s.lineId}>
            {s.productName}
            {s.variantName ? ` — ${s.variantName}` : ""} × {s.quantity}
          </li>
        ))}
      </ul>
      <p>
        قيمة الوحدات المرتجعة بعد الخصم:{" "}
        <strong>{formatMoney(details.refundPiastres / 100)}</strong>
      </p>
      <p>
        فرق سعر البضاعة:{" "}
        <strong>{formatMoney(order.totalAmount - details.refundPiastres / 100)}</strong>
      </p>
      <p className="text-xs text-muted-foreground">
        لا يوجد قيد مستقل لفرق السعر. رد الأصل وتسليم البديل يسجلان كل حركة مرة واحدة؛ العربون
        السابق لا يُصادر في الاستبدال.
      </p>
      {details.status === "confirmed" ? (
        <p role="status">تم تأكيد استلام الوحدات وتسوية رصيدها حسب التفاصيل. تسليم البديل له إجراء مستقل.</p>
      ) : details.status === "cancelled" || order.status === "cancelled" ? (
        <p role="status">الاستبدال ملغي؛ حجز الوحدات الأصلية أُفرج عنه.</p>
      ) : (
        canChange && (
          <>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={physical}
                onChange={(e) => setPhysical(e.target.checked)}
                disabled={busy}
              />
              استلمت الوحدات المحددة فعليًا
            </label>
            <label className="block">
              {details.credit ? "طريقة رد فائض الرصيد فقط" : "طريقة رد قيمة الوحدات"}
              <select
                aria-label="طريقة رد قيمة الاستبدال"
                value={refundVia}
                onChange={(e) => setRefundVia(e.target.value)}
                disabled={busy}
                className="border rounded p-2 w-full"
              >
                <option value="courier">من حساب شركة الشحن</option>
                <option value="wallet">رد فعلي من الخزينة</option>
              </select>
            </label>
            {refundVia === "wallet" && (
              <select
                aria-label="خزينة رد الاستبدال"
                value={wallet}
                onChange={(e) => setWallet(e.target.value)}
                disabled={busy}
                className="border rounded p-2 w-full"
              >
                <option value="inStoreSafe">خزينة المحل</option>
                <option value="vodafoneCash">فودافون كاش</option>
                <option value="instaPay">انستا باي</option>
                <option value="bankAccount">البنك</option>
              </select>
            )}
            <label>
              تكلفة رحلة رجوع إضافية منفصلة (ج.م)
              <Input
                aria-label="تكلفة رحلة رجوع الاستبدال"
                type="number"
                min="0"
                step="0.01"
                value={fee}
                onChange={(e) => setFee(e.target.value)}
                disabled={busy}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              رحلة الاستبدال الأساسية مسجلة في البديل؛ لا تضف نفس الرحلة مرة ثانية. التكلفة الإضافية
              على{" "}
              {details.cause === "customer"
                ? "العميل"
                : details.cause === "courier"
                  ? "شركة الشحن كتعويض"
                  : "المتجر"}
              .
            </p>
            <Button onClick={() => void confirm()} disabled={busy || !physical}>
              {busy ? "جارٍ التحقق…" : "تأكيد استلام وحدات الاستبدال"}
            </Button>
          </>
        )
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
