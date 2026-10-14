import { useRef, useState } from "react";
import { useRunOnce } from "@/hooks/useSubmitGate";
import { useAuthStore } from "@/store/useAuthStore";
import { getSyncIdentity } from "@/services/api/storeContext";
import { advanceClaim, claimForOrder, type CourierClaim } from "@/services/courierClaims";
import { Button } from "@/components/ui/button";

interface SavedSettlement { id: string; courierId: string; orderAmounts?: { orderNumber: string }[] }
/** Recover an optional workflow note against existing evidence. Never moves money. */
export function CourierClaimRecoveryPanel({ claims, history, orders, onRecovered }: {
  claims: CourierClaim[]; history: SavedSettlement[];
  orders: { id: string; orderNumber: string }[]; onRecovered: () => void | Promise<void>;
}) {
  const role = useAuthStore(state => state.userRole), runOnce = useRunOnce();
  const [claimId, setClaimId] = useState(""), [eventId, setEventId] = useState("");
  const [busy, setBusy] = useState(false), [pending, setPending] = useState(false), [message, setMessage] = useState("");
  const intent = useRef<{ claimId: string; orderId: string; eventId: string; storeId: string } | null>(null);
  if (role !== "ADMIN" && role !== "ACCOUNTANT") return null;
  const eligible = claims.filter(claim => claim.status === "approved" && claim.source_event_id);
  const claim = eligible.find(row => row.id === claimId);
  const order = orders.find(row => row.id === claim?.order_id);
  const candidates = history.filter(row => row.courierId === claim?.courier_id && row.orderAmounts?.some(item => item.orderNumber === order?.orderNumber));
  if (!claims.length) return null;
  const recover = () => runOnce(async () => {
    setBusy(true); setMessage(""); let committed = false;
    try {
      const identity = await getSyncIdentity();
      if (!identity) throw new Error("لا يوجد متجر مسجل");
      if (!intent.current) {
        if (!claim || !candidates.some(row => row.id === eventId)) throw new Error("اختر المطالبة ومرجع التسوية المحفوظ.");
        intent.current = { claimId: claim.id, orderId: claim.order_id, eventId, storeId: identity.storeId };
      }
      const original = intent.current;
      if (identity.storeId !== original.storeId) throw new Error("تغيّر المتجر؛ ارجع لمتجر المطالبة للتحقق من نفس المرجع.");
      setPending(true);
      const saved = await claimForOrder(original.orderId);
      if ((await getSyncIdentity())?.storeId !== original.storeId) throw new Error("تغيّر المتجر أثناء التحقق.");
      if (saved?.id === original.claimId && saved.status === "settled" && saved.settlement_event_id === original.eventId) committed = true;
      else {
        if (!saved || saved.id !== original.claimId || saved.status !== "approved") throw new Error("حالة المطالبة تغيرت؛ راجع السجل دون تسجيل حركة مالية.");
        await advanceClaim({ claimId: original.claimId, to: "settled", settlementEventId: original.eventId, expectedStoreId: original.storeId });
        committed = true;
      }
      intent.current = null; setPending(false);
      setMessage("اتربطت المطالبة بتحصيل محفوظ؛ دون أي حركة مالية جديدة.");
      if ((await getSyncIdentity())?.storeId === original.storeId) await onRecovered();
    } catch (error) {
      if (!committed && (error as { definite?: boolean })?.definite) { intent.current = null; setPending(false); }
      setMessage(committed ? "اتربطت المطالبة؛ تعذّر تحديث القائمة. حدّث العرض دون إعادة أي تسوية." : `تعذّر تأكيد ربط المطالبة؛ تحقق من نفس المرجع دون إعادة التسوية. ${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  });
  return <section className="rounded-xl border p-3 space-y-2" aria-label="استرداد ربط المطالبة">
    <p className="text-sm font-semibold">ربط مطالبة بتحصيل محفوظ — دون حركة مالية</p>
    <p className="text-xs text-muted-foreground">قاعدة البيانات تتحقق من مصدر التعويض والتحصيل الفعلي. المطالبات القديمة بلا مصدر موثق تحتاج مراجعة منفصلة.</p>
    <label className="block text-sm">المطالبة المعتمدة
      <select className="w-full rounded border p-2" value={claimId} disabled={busy || pending} onChange={event => { setClaimId(event.target.value); setEventId(""); }}>
        <option value="">اختر المطالبة</option>{eligible.map(row => <option key={row.id} value={row.id}>{orders.find(item => item.id === row.order_id)?.orderNumber ?? row.order_id}</option>)}
      </select>
    </label>
    <label className="block text-sm">مرجع التسوية المحفوظ
      <select className="w-full rounded border p-2" value={eventId} disabled={busy || pending} onChange={event => setEventId(event.target.value)}>
        <option value="">اختر المرجع للمراجعة</option>{candidates.map(row => <option key={row.id} value={row.id}>{row.id}</option>)}
      </select>
    </label>
    <Button type="button" disabled={busy || (!pending && (!claim || !eventId))} onClick={() => void recover()}>{pending ? "تحقق من ربط المطالبة بنفس المرجع" : "تحقق واربط المطالبة فقط"}</Button>
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
