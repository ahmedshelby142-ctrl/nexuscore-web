import {useEffect,useState} from "react";
import {readPosReceipt,type PosReceipt} from "@/services/posReceipts";
import {posCashLabel} from "@/lib/posHistory";
import {formatMoney} from "@/lib/math";
import {printTableAsPdf} from "@/lib/pdfGenerator";
import {WALLET_LABELS,type WalletType} from "@/types";
import {Button} from "@/components/ui/button";
const title=(r:PosReceipt)=>r.kind==='exchange'?'إيصال استبدال':r.kind==='refund'?'إيصال مرتجع':'فاتورة بيع';
export function printSavedPosReceipt(r:PosReceipt) {
 printTableAsPdf({title:title(r),subtitle:`${r.number} — ${r.customer}${r.sourceNumber?` — فاتورة الأصل: ${r.sourceNumber}`:''}`,
  columns:[{label:'الصنف',accessor:(i:any)=>`${i.productName}${i.variantName?` — ${i.variantName}`:''}`},{label:'الكمية',accessor:(i:any)=>i.quantity},{label:'سعر الوحدة',accessor:(i:any)=>formatMoney(i.unitPrice)}],rows:r.items,
  footer:`قيمة المرتجع بعد الخصم: ${formatMoney(r.refundPiastres/100)} — قيمة البيع/البديل بعد الخصم: ${formatMoney(r.replacementPiastres/100)} — ${posCashLabel(r.netPiastres)}${r.netPiastres?`: ${formatMoney(Math.abs(r.netPiastres)/100)}`:''}`});
}
/** Reopening/printing always reads committed evidence, never today's catalog or a draft. */
export function PosReceiptDetails({eventId}:{eventId:string}) {
 const [receipt,setReceipt]=useState<PosReceipt|null>(null),[error,setError]=useState(''),[tick,setTick]=useState(0);
 useEffect(()=>{let active=true;setReceipt(null);setError('');void readPosReceipt(eventId).then(r=>{if(active)setReceipt(r);}).catch(e=>{if(active)setError(e instanceof Error?e.message:String(e));});return()=>{active=false;};},[eventId,tick]);
 if(error)return <div><p role="alert">{error}</p><Button variant="outline" onClick={()=>setTick(n=>n+1)}>إعادة قراءة الإيصال</Button></div>;
 if(!receipt)return <p role="status">جارٍ قراءة الفاتورة من الدفتر…</p>;
 return <section aria-label="الإيصال المحفوظ" dir="rtl" className="space-y-3">
  <h3 className="font-semibold">{title(receipt)} — <bdi>{receipt.number}</bdi></h3>
  <p>{receipt.customer} {receipt.phone}</p>{receipt.sourceNumber&&<p>فاتورة الأصل: <bdi>{receipt.sourceNumber}</bdi></p>}
  <ul className="space-y-2">{receipt.items.map((i,index)=><li key={index} className={i.quantity<0?'text-red-700':'text-indigo-700'}>{i.productName}{i.variantName?` — ${i.variantName}`:''} × {i.quantity} — {formatMoney(i.unitPrice)}</li>)}</ul>
  {receipt.kind!=='sale'&&<p>قيمة المرتجع بعد الخصم: {formatMoney(receipt.refundPiastres/100)}</p>}
  {receipt.kind!=='refund'&&<p>قيمة {receipt.kind==='exchange'?'البديل':'البيع'} بعد الخصم: {formatMoney(receipt.replacementPiastres/100)}</p>}
  <p className="font-semibold">{posCashLabel(receipt.netPiastres)}{receipt.netPiastres?`: ${formatMoney(Math.abs(receipt.netPiastres)/100)}`:''}</p>
  {receipt.wallets.filter(w=>w.piastres!==0).map(w=><p key={w.id}>{WALLET_LABELS[w.id as WalletType]??w.id}: {formatMoney(w.piastres/100)}</p>)}
  <details><summary>أثر التكلفة والربح المسجل</summary><p>أثر COGS: {formatMoney(receipt.cogsPiastres/100)}</p><p>أثر الربح: {formatMoney(receipt.profitPiastres/100)}</p></details>
  <Button variant="outline" onClick={()=>printSavedPosReceipt(receipt)}>طباعة الإيصال المحفوظ</Button>
 </section>;
}
