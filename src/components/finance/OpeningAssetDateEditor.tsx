import {useState} from "react";
import type {AssetAccountingRow} from "@/lib/fixedAssetAccounting";
import {useFinancialDraftClose} from "@/hooks/useFinancialDraftClose";
import {useRunOnce} from "@/hooks/useSubmitGate";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from "@/components/ui/dialog";
import {formatMoney} from "@/lib/math";
export function OpeningAssetDateEditor({asset,storeId,onSaved}:{asset:AssetAccountingRow;storeId:string;onSaved?:()=>void}) {
 const [open,setOpen]=useState(false),[date,setDate]=useState(asset.purchaseDate),[reason,setReason]=useState("");
 const [baseline,setBaseline]=useState(asset);
 const [busy,setBusy]=useState(false),[error,setError]=useState(""),[result,setResult]=useState<number|null>(null);
 const guard=useFinancialDraftClose({open,draft:{date,reason},busy,onClose:()=>setOpen(false)});
 const runOnce=useRunOnce();
 const save=async()=>runOnce(async()=>{if(busy)return;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>baseline.accountingStartDate||!reason.trim()){
   setError("أدخل تاريخ شراء لا يتجاوز بدء المحاسبة وسببًا واضحًا للتصحيح.");return;}
  setBusy(true);setError("");let confirmed=false;
  try{const {runFinancialCommand}=await import("@/lib/financialCommand");
   const saved=await runFinancialCommand<{openingEquityDeltaPiastres:number}>("asset_opening_date",{
    assetId:baseline.id,beforeRevision:baseline.revision,beforePurchaseDate:baseline.purchaseDate,purchaseDate:date,reason:reason.trim(),
   },"asset_opening_date:"+baseline.id,storeId);
   confirmed=true;setResult(saved.openingEquityDeltaPiastres);setOpen(false);
   window.dispatchEvent(new CustomEvent("ledger-sync-pulled"));onSaved?.();
  }catch(e){if(!confirmed)setError(e instanceof Error?e.message:String(e));}
  finally{setBusy(false);}});
 return <><Button variant="outline" size="sm" onClick={()=>{setBaseline(asset);setDate(asset.purchaseDate);setReason("");setError("");setOpen(true);}}>تصحيح تاريخ الأصل الافتتاحي</Button>
  {result!==null&&<p role="status">تم التصحيح دون حركة نقدية. أثر حقوق الملكية الافتتاحية: {formatMoney(result/100)}</p>}{guard.confirmation}
  <Dialog open={open} onOpenChange={next=>{if(next)setOpen(true);else guard.close();}}><DialogContent dir="rtl">
   <DialogHeader><DialogTitle>تصحيح تاريخ شراء {asset.name}</DialogTitle><DialogDescription>للأصل المدفوع مسبقًا فقط. يُحفظ التاريخ السابق وسبب التصحيح، ويعاد احتساب الرصيد الافتتاحي والإهلاك؛ لا تُعدّل قيود النقدية السابقة.</DialogDescription></DialogHeader>
   <p>التاريخ المسجل: {asset.purchaseDate} — بدء المحاسبة: {asset.accountingStartDate}</p>
   <Label htmlFor="opening-asset-date">تاريخ الشراء الصحيح</Label><Input id="opening-asset-date" type="date" max={asset.accountingStartDate} value={date} onChange={e=>setDate(e.target.value)} disabled={busy}/>
   <Label htmlFor="opening-asset-reason">سبب تصحيح تاريخ الأصل</Label><Input id="opening-asset-reason" value={reason} onChange={e=>setReason(e.target.value)} disabled={busy}/>
   {error&&<p role="alert">{error}</p>}<Button disabled={busy||date===asset.purchaseDate||!reason.trim()} onClick={()=>void save()}>تأكيد تصحيح الرصيد الافتتاحي</Button>
  </DialogContent></Dialog>
 </>;
}
