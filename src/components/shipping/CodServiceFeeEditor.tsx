import { useState } from "react";
import {useFinancialDraftClose} from "@/hooks/useFinancialDraftClose";
import {useRunOnce} from "@/hooks/useSubmitGate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useAuthStore } from "@/store/useAuthStore";
import { useOrderStore } from "@/store/useOrderStore";
import { runFinancialCommand } from "@/lib/financialCommand";
import { fromRemoteRow } from "@/services/api/fieldMapping";
import { formatMoney } from "@/lib/math";
import {FinancialCorrectionHistory} from "@/components/finance/FinancialCorrectionHistory";

/** The server derives any accrued adjustment; this form never writes ledger lines. */
export function CodServiceFeeEditor({ order, onSaved }: { order: any; onSaved?: () => void }) {
  const role = useAuthStore(s => s.userRole);
  const [open, setOpen] = useState(false), [amount, setAmount] = useState(""), [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const draftClose=useFinancialDraftClose({open,draft:{amount,reason},busy,onClose:()=>setOpen(false)});
  const runOnce=useRunOnce();
  if (!["ADMIN", "ACCOUNTANT", "POS_ECOMMERCE", "ECOMMERCE_ONLY"].includes(String(role))) return null;
  const editable=order.courierId&&!order.codSettledAt&&["pending", "shipped", "delivered", "returned"].includes(order.status);
  const dirty = amount !== String(order.codServiceFee ?? 0) || reason.trim() !== "";
  const save=async()=>runOnce(async()=>{
    if (busy) return;
    const value = Number(amount);
    if (!amount.trim() || !Number.isFinite(value) || value < 0 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7 || !reason.trim()) {
      setError("أدخل مبلغًا بصفر أو أكثر بدقة قرش وسببًا للتعديل."); return;
    }
    setBusy(true); setError("");
    let confirmed=false;
    try {
      const result = await runFinancialCommand<{order: any}>("cod_service_fee", {
        orderId: order.id, before: order.codServiceFee ?? 0, amount: value, reason: reason.trim(),
      }, "cod_service_fee:" + order.id, order.store_id);
      confirmed=true;setOpen(false);
      const {getActiveStoreId}=await import("@/services/api/storeContext");
      if(await getActiveStoreId()!==order.store_id)return;
      const saved = fromRemoteRow("orders", result.order);
      useOrderStore.setState(s => ({orders: s.orders.map(o => o.id === saved.id && Number(o.updated_at??0)<=Number(saved.updated_at??0) ? saved : o)}));
      window.dispatchEvent(new CustomEvent("ledger-sync-pulled"));
      onSaved?.();
    } catch (e) {
      if(confirmed)return;
      const message=e instanceof Error?e.message:String(e);
      setError(/ALREADY_ALLOCATED|NOT_OPEN/.test(message)?"لا يمكن تعديل رسوم طلب سُويت مستحقاته كليًا أو جزئيًا. يبقى سجل التسوية محفوظًا.":
        /STALE/.test(message)?"تغيّرت الرسوم منذ فتح النافذة. حدّث الطلب وراجع القيمة قبل التعديل.":
        /NO_COLLECTION/.test(message)?"لا يوجد تحصيل COD مؤهل لهذا الطلب لتسجيل رسوم تحصيل عليه.":message);
    }
    finally { setBusy(false); }
  });
  return <>
    {editable&&<Button variant="outline" size="sm" onClick={() => {
      setAmount(String(order.codServiceFee ?? 0)); setReason(""); setError(""); setOpen(true);
    }}>تعديل رسوم تحصيل COD</Button>}
    <FinancialCorrectionHistory kind="cod" storeId={order.store_id} id={order.id}/>
    {draftClose.confirmation}
    <Dialog open={open} onOpenChange={next => {if(!next)draftClose.close();else setOpen(true);}}>
      <DialogContent dir="rtl" data-pwa-unsaved={open && dirty ? "true" : undefined}>
        <DialogHeader><DialogTitle>رسوم تحصيل COD — {order.orderNumber}</DialogTitle>
          <DialogDescription>التعديل مسجل بسبب واضح ولا يغيّر تحصيل العميل. تُمنع الطلبات التي تمت تسويتها أو تخصيص جزء من مستحقاتها.</DialogDescription></DialogHeader>
        <p>القيمة الحالية: {formatMoney(order.codServiceFee ?? 0)}</p>
        <Label htmlFor="cod-fee-correction">رسوم خدمة تحصيل الدفع عند الاستلام (COD)</Label>
        <Input id="cod-fee-correction" type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} disabled={busy} />
        <Label htmlFor="cod-fee-reason">سبب التعديل / مرجع كشف المندوب</Label>
        <Input id="cod-fee-reason" value={reason} onChange={e => setReason(e.target.value)} disabled={busy} />
        {error && <p role="alert">{error}</p>}
        <Button disabled={busy || !reason.trim()} onClick={() => void save()}>{busy ? "جارٍ التأكيد…" : "حفظ رسوم التحصيل"}</Button>
      </DialogContent>
    </Dialog>
  </>;
}
