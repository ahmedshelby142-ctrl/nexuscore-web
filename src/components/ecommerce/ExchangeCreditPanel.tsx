import { useState } from "react";
import { useOrderStore } from "@/store/useOrderStore";
import type { EcommerceOrder } from "@/types";
import { formatMoney } from "@/lib/math";
import { runFinancialCommand, resolvePendingFinancialCommand } from "@/lib/financialCommand";
import { getSyncIdentity } from "@/services/api/storeContext";
import { fromRemoteRow } from "@/services/api/fieldMapping";
import { useRunOnce } from "@/hooks/useSubmitGate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** The same disposition and recovery controls in Desktop and Mobile. */
export function ExchangeCreditPanel({ order, onSaved, readOnly = false }: {
  order: EcommerceOrder; onSaved: (order: EcommerceOrder) => void | Promise<void>; readOnly?: boolean;
}) {
  const credit = order.exchangeDetails?.credit;
  const [amount, setAmount] = useState("");
  const [wallet, setWallet] = useState("inStoreSafe");
  const [handedBack, setHandedBack] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const runOnce = useRunOnce();
  if (!credit || credit.version !== 1) return null;
  const refundable = credit.allocatedPiastres > 0 && !order.revenueLogged &&
    (credit.status === "applied" || credit.status === "refund_due");
  const refund = (recoveryOnly = false) => runOnce(async () => {
    setBusy(true); setMessage("");
    let committed = false;
    try {
      const identity = await getSyncIdentity();
      if (!identity) throw new Error("لا يوجد متجر مسجل");
      const scope = "exchange_credit_refund:" + order.id;
      const pending = await resolvePendingFinancialCommand<{ order: any }>(scope);
      if (!pending && recoveryOnly) { setMessage("لا توجد عملية رد غير محسومة."); return; }
      if (!pending && (!handedBack || !Number.isFinite(Number(amount)) || Number(amount) <= 0))
        throw new Error("حدد المبلغ وأكد ردّه فعليًا للعميل.");
      const result = pending ?? await runFinancialCommand<{ order: any }>("exchange_credit_refund", {
        orderId: order.id, amount: Number(amount), wallet, expectedAllocatedPiastres: credit.allocatedPiastres,
      }, scope, identity.storeId);
      committed = true;
      const current = useOrderStore.getState().orders.find(o => o.id === result.order.id);
      if (result.order.store_id === identity.storeId && (await getSyncIdentity())?.storeId === identity.storeId &&
        (!current || Number(current.updated_at ?? 0) <= Number(result.order.updated_at ?? 0)))
        await onSaved(fromRemoteRow("orders", result.order) as EcommerceOrder);
      setHandedBack(false); setAmount("");
      setMessage("تم تأكيد رد الرصيد مرة واحدة. حدّث الأرصدة للاطلاع على الحركة.");
      window.dispatchEvent(new Event("ledger-sync-pulled"));
    } catch (error) {
      setMessage(committed ? "تم تسجيل رد الرصيد؛ حدّث الصفحة لقراءة النتيجة. لا تسجل ردًا آخر." :
        `تعذّر التأكيد؛ استخدم التحقق من العملية السابقة قبل أي رد آخر. ${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  });
  return <section aria-label="رصيد الاستبدال" className="rounded border p-3 space-y-2">
    <p>رصيد الأصل المؤهل: <strong>{formatMoney(credit.eligiblePiastres / 100)}</strong></p>
    <p>رصيد مخصص للبديل: <strong>{formatMoney(credit.allocatedPiastres / 100)}</strong></p>
    <p>عربون نقدي جديد: <strong>{formatMoney(order.depositAmount)}</strong></p>
    <p>المتبقي المسجل للبديل: <strong>{formatMoney(order.status === "cancelled" || order.status === "returned" ? 0 : order.expectedCod)}</strong></p>
    {order.exchangeDetails?.returnFee ? <p>رحلة رجوع إضافية منفصلة: {formatMoney(order.exchangeDetails.returnFee)} — {order.exchangeDetails.cause === "customer" ? "تحصيل إضافي من العميل" : order.exchangeDetails.cause === "courier" ? "تعويض على شركة الشحن" : "على المتجر"}</p> : null}
    {credit.excessPiastres > 0 && <p>فائض الرصيد: {formatMoney(credit.excessPiastres / 100)} — {credit.status === "reserved" ? "ينتظر استلام الأصل" : credit.excessDisposition === "wallet" ? "رد نقدي من الخزينة" : "رد من حساب شركة الشحن"}</p>}
    {credit.refundedAllocationPiastres > 0 && <p>رد نقدي من الرصيد المخصص: {formatMoney(credit.refundedAllocationPiastres / 100)}</p>}
    {credit.status === "reserved" && <p>الرصيد محجوز بشرط استلام وحدات الأصل؛ التسليم متوقف حتى تأكيد استلامها.</p>}
    {credit.status === "refund_due" && <p role="status">رصيد مستحق الرد للعميل؛ الإلغاء لا يعني رد المال. الوحدات الأصلية المستلمة محفوظة.</p>}
    {credit.status === "released" && <p>أُفرج عن الرصيد المشروط دون رد نقدي؛ لم يُستلم الأصل.</p>}
    {credit.status === "refunded" && <p>تمت تصفية الرصيد المستحق.</p>}
    {refundable && !readOnly && <>
      <p>رد رصيد مخصص قبل تخفيض سعر البديل يزيد المتبقي مؤقتًا بنفس المبلغ. العربون النقدي مستقل.</p>
      <label>مبلغ رد الرصيد (ج.م)<Input aria-label="مبلغ رد رصيد الاستبدال" type="number" min="0.01" step="0.01" max={credit.allocatedPiastres / 100} value={amount} onChange={e => setAmount(e.target.value)} disabled={busy} /></label>
      <label>خزينة الرد<select aria-label="خزينة رد الرصيد" value={wallet} onChange={e => setWallet(e.target.value)} disabled={busy}>
        <option value="inStoreSafe">خزينة المحل</option><option value="vodafoneCash">فودافون كاش</option><option value="instaPay">انستا باي</option><option value="bankAccount">البنك</option>
      </select></label>
      <label><input type="checkbox" checked={handedBack} onChange={e => setHandedBack(e.target.checked)} disabled={busy} />رددت هذا المبلغ فعليًا للعميل</label>
      <Button onClick={() => void refund()} disabled={busy || !handedBack}>تسجيل رد رصيد الاستبدال</Button>
    </>}
    {!readOnly && <Button onClick={() => void refund(true)} disabled={busy}>التحقق من رد رصيد سابق</Button>}
    {message && <p role="status">{message}</p>}
  </section>;
}
