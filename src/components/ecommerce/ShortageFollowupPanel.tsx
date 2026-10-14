import {SHORTAGE_FOLLOWUP_LABELS} from "@/lib/orderFulfillment";
import {useEffect,useRef,useState} from "react";
import {useAuthStore} from "@/store/useAuthStore";
import {getSyncIdentity} from "@/services/api/storeContext";
import {readShortageFollowup,saveShortageFollowup,type ShortageFollowupState} from "@/services/shortageFollowups";
import {Button} from "@/components/ui/button";
import {WhatsAppAction} from "@/mobile/components/WhatsAppAction";
import {useRunOnce} from "@/hooks/useSubmitGate";
const labels=SHORTAGE_FOLLOWUP_LABELS;
/** One on-demand nonfinancial note. Never changes an order or records money. */
export function ShortageFollowupPanel({orderId,orderNumber,demandSummary,customerName,customerPhone,onSaved}:{orderId:string;orderNumber:string;demandSummary?:string;customerName?:string;customerPhone?:string;onSaved?:()=>void|Promise<void>}) {
  const role=useAuthStore(s=>s.userRole),canWrite=role==="ADMIN"||role==="MODERATOR";
  const [state,setState]=useState<ShortageFollowupState>("waiting"),[notes,setNotes]=useState("");
  const [revision,setRevision]=useState(0),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  const [pending,setPending]=useState(false),[loaded,setLoaded]=useState(false);
  const context=useRef<string|null>(null),runOnce=useRunOnce();
  const intent=useRef<Parameters<typeof saveShortageFollowup>[0]|null>(null);
  useEffect(()=>{
    let active=true;
    setLoading(true);setLoaded(false);setMessage("");context.current=null;
    void (async()=>{
      try{
        const identity=await getSyncIdentity();if(!identity)throw new Error("لا يوجد متجر مسجل.");
        const row=await readShortageFollowup(orderId,identity.storeId);
        if(!active)return;
        context.current=identity.storeId;setState(row?.state??"waiting");setNotes(row?.notes??"");setRevision(Number(row?.revision??0));setLoaded(true);
      }catch(error){if(active)setMessage(error instanceof Error?error.message:String(error));}
      finally{if(active)setLoading(false);}
    })();
    return()=>{active=false;};
  },[orderId]);
  const save=()=>runOnce(async()=>{
    if(!loaded||!canWrite||!context.current)return;
    setBusy(true);setMessage("");let committed=false;
    try{
      if(!intent.current)intent.current={id:crypto.randomUUID(),storeId:context.current,orderId,expectedRevision:revision,state,notes};
      if(intent.current.orderId!==orderId)throw new Error("ارجع لمتابعة الطلب الأصلي قبل التحقق.");
      setPending(true);
      const result=await saveShortageFollowup(intent.current);committed=true;
      if((await getSyncIdentity())?.storeId!==intent.current.storeId)throw new Error("تم حفظ المتابعة في متجرها الأصلي؛ تغيّر المتجر الحالي.");
      intent.current=null;setPending(false);setRevision(Number(result.followup.revision));setState(result.followup.state);setNotes(result.followup.notes);
      setMessage("تم حفظ المتابعة دون تغيير مخزون أو حسابات.");
      await onSaved?.();
    }catch(error){
      if(!committed&&(error as {definite?:boolean})?.definite){intent.current=null;setPending(false);setLoaded(false);}
      setMessage(committed ? "تم حفظ المتابعة؛ أعد فتحها لقراءة النسخة الحالية." : (error instanceof Error?error.message:String(error)));
    }finally{setBusy(false);}
  });
  return <section aria-label={`متابعة نواقص ${orderNumber}`} className="space-y-3" dir="rtl">
    <p className="text-sm">{orderNumber} — المتابعة لا تلغي الطلب ولا تغيّر الكمية أو المبلغ.</p>
    {demandSummary&&<>
      <label className="block">رسالة جاهزة للإدارة<textarea readOnly aria-label="رسالة النواقص للإدارة" className="block w-full rounded border p-2" value={`يوجد نقص في الطلب ${orderNumber} للعميل ${customerName||"—"}: ${demandSummary}. مطلوب متابعة التوريد.`}/></label>
      <WhatsAppAction phone={customerPhone} message={`أهلاً ${customerName||""}، الطلب ${orderNumber}: ${demandSummary}. هل تفضل الانتظار لحين التوريد أم تغيير الصنف؟`} label="تحضير رسالة للعميل" fixWhere="من بيانات العميل"/>
      <p className="text-xs">الرسالة مسودة؛ لا تُرسل تلقائيًا. التواصل يتطلب إجراءك الصريح.</p>
    </>}
    {loading?<p role="status">جارٍ قراءة المتابعة…</p>:<>
      <label className="block">حالة المتابعة<select aria-label="حالة متابعة النواقص" className="block w-full rounded border p-2" value={state} onChange={e=>setState(e.target.value as ShortageFollowupState)} disabled={!canWrite||busy||pending||!loaded}>
        {Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select></label>
      <label className="block">ملاحظات المتابعة<textarea aria-label="ملاحظات النواقص" maxLength={1500} className="block w-full rounded border p-2" value={notes} onChange={e=>setNotes(e.target.value)} disabled={!canWrite||busy||pending||!loaded}/></label>
      {canWrite&&<Button onClick={save} disabled={busy||!loaded}>{pending?"تحقق من حفظ المتابعة الأصلية":"حفظ المتابعة"}</Button>}
    </>}
    {message&&<p role="status">{message}</p>}
  </section>;
}
