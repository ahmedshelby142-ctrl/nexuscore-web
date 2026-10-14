import {useState} from "react";
import {Button} from "@/components/ui/button";
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from "@/components/ui/dialog";
import {formatMoney} from "@/lib/math";
import type {FinancialAuditRow} from "@/lib/financialAudit";
export function FinancialCorrectionHistory({kind,storeId,id}:{kind:"asset"|"cod";storeId:string;id:string}) {
 const [open,setOpen]=useState(false),[rows,setRows]=useState<FinancialAuditRow[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState("");
 async function show(){setOpen(true);setLoading(true);setError("");setRows([]);
  try{const {readFinancialAudit}=await import("@/lib/financialAudit");setRows(await readFinancialAudit(kind,storeId,id));}
  catch(e){setError(e instanceof Error?e.message:String(e));}finally{setLoading(false);}}
 return <><Button variant="ghost" size="sm" onClick={()=>void show()}>سجل التصحيحات</Button>
  <Dialog open={open} onOpenChange={setOpen}><DialogContent dir="rtl" className="max-h-[85dvh] overflow-y-auto">
   <DialogHeader><DialogTitle>سجل التصحيحات المعتمدة</DialogTitle><DialogDescription>القيمة السابقة والجديدة وسبب التعديل. لا تُحذف القيود أو التسويات السابقة.</DialogDescription></DialogHeader>
   {loading?<p role="status">جارٍ قراءة السجل…</p>:error?<p role="alert">{error}</p>:<ul className="space-y-3">{rows.map(r=><li key={r.id} className="rounded border p-3 text-sm">
    <p>{r.at} — المنفّذ: {r.actorId}</p>
    {kind==="cod"?<p>السابق: {formatMoney(r.before??0)} — الجديد: {formatMoney(r.after??0)}</p>:
     r.result?.beforePosition&&r.result.afterPosition?<><p>تاريخ الشراء السابق: {r.result.beforePosition.purchaseDate} — الجديد: {r.result.afterPosition.purchaseDate}</p>
     <p>أثر التصحيح على حقوق الملكية الافتتاحية: {formatMoney((r.result.openingEquityDeltaPiastres??0)/100)} — دون حركة نقدية</p></>:<p>{r.request?.command==="asset_deactivate"?"إيقاف الإهلاك مع حفظ القيمة":"تسجيل الأصل"}</p>}
    <p>السبب: {r.reason??r.request?.input?.reason??"تسجيل الأصل"}</p><p className="break-all text-xs">مرجع العملية: {r.id}</p>
   </li>)}{!rows.length&&<li>لا توجد تصحيحات مسجلة.</li>}</ul>}
  </DialogContent></Dialog>
 </>;
}
