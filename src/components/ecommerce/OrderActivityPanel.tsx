import {useEffect,useState} from "react";
import {readOrderActivity,type OrderActivity} from "@/services/orderActivity";
import {Button} from "@/components/ui/button";
const labels:Record<string,string>={order_placed:"تسجيل الطلب",order_edited:"تحديث الطلب وحجزه",order_delivered:"تأكيد التسليم",order_returned_pending:"مرتجع في الطريق",return_confirmed:"تأكيد استلام مرتجع",rto_confirmed:"تأكيد رفض الاستلام",order_cancelled:"إلغاء الطلب",client_payment:"دفعة عميل",deposit_refunded:"رد العربون",courier_settlement:"تسوية مندوب",courier_settlement_stamp:"تسوية مندوب مسجلة",courier_fee_adjustment:"تصحيح رسوم تحصيل COD"};
export function OrderActivityPanel({orderId,revision}:{orderId:string;revision:unknown}) {
  const [rows,setRows]=useState<OrderActivity[]>([]),[error,setError]=useState(""),[loading,setLoading]=useState(true),[tick,setTick]=useState(0);
  useEffect(()=>{
    let active=true;setLoading(true);setError("");setRows([]);
    void readOrderActivity(orderId).then(value=>{if(active)setRows(value);})
      .catch(e=>{if(active)setError(e instanceof Error?e.message:String(e));})
      .finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[orderId,revision,tick]);
  if(loading)return <p role="status">جارٍ قراءة سجل الطلب…</p>;
  if(error)return <div><p role="alert">{error}</p><Button variant="outline" onClick={()=>setTick(n=>n+1)}>إعادة قراءة السجل</Button></div>;
  return rows.length?<ol aria-label="سجل حركة الطلب" className="space-y-3">{rows.map(row=><li key={row.id} className="flex flex-wrap justify-between gap-2 border-b pb-2 text-sm">
    <span>{row.label??labels[row.kind]??"حركة مرتبطة بالطلب"}</span><time dateTime={row.occurred_at}>{new Date(row.occurred_at).toLocaleString("ar-EG")}</time>
  </li>)}</ol>:<p>لا توجد حركات مرتبطة بهذا المرجع حتى الآن.</p>;
}
