import Decimal from "decimal.js";
import {posDocumentNumber} from "./documentIdentity.ts";
import type {LedgerEvent} from "./ledger/types";

/** Header projection only. Detailed cash/COGS are read from immutable ledger lines. */
export interface PosHistoryEntry {
 id:string;event:LedgerEvent;events:LedgerEvent[];number:string;
 label:string;amount:number|null;incomplete:boolean;
}
export function posHeaderNet(event:LedgerEvent):number|null {
 try {
  const p=event.payload,items=p.items as any[];
  if(!Array.isArray(items)||!items.length)return null;
  let sum=new Decimal(0);
  for(const item of items){const q=new Decimal(item.quantity),price=new Decimal(item.unitPrice);if(!q.isFinite()||!price.isFinite()||q.isZero()||price.isNegative()||(p.returnOfEventId?!q.isNegative():q.isNegative()))return null;sum=sum.plus(q.times(price));}
  if(!p.returnOfEventId){const discount=new Decimal((p.discountAmount as any)??0);if(!discount.isFinite()||discount.isNegative()||discount.greaterThan(sum))return null;sum=sum.minus(discount);}
  const value=sum.toDecimalPlaces(2);return value.isFinite()?value.toNumber():null;
 }catch{return null;}
}
export function groupPosHistory(events:readonly LedgerEvent[]):PosHistoryEntry[] {
 const unique=[...new Map(events.map(e=>[e.id,e])).values()],used=new Set<string>(),result:PosHistoryEntry[]=[];
 for(const event of unique){
  if(used.has(event.id))continue;
  const p=event.payload,exchangeId=p.exchangeId;
  if(event.refType==='pos_sale'&&typeof exchangeId==='string'&&exchangeId){
   const legs=unique.filter(e=>e.refType==='pos_sale'&&e.storeId===event.storeId&&e.refId===exchangeId&&e.payload.exchangeId===exchangeId);
   const returned=legs.filter(e=>e.payload.exchangeLeg==='return'),replacement=legs.filter(e=>e.payload.exchangeLeg==='replacement');
   const r=returned[0],s=replacement[0];
   const complete=returned.length===1&&replacement.length===1&&r.id===exchangeId&&r.payload.replacementEventId===s.id&&s.payload.returnEventId===r.id&&r.payload.returnOfEventId===s.payload.exchangeSourceEventId;
   const group=complete?[r,s]:legs.length?legs:[event];group.forEach(e=>used.add(e.id));
   const a=complete?posHeaderNet(r):null,b=complete?posHeaderNet(s):null;
   result.push({id:exchangeId,event:complete?r:event,events:group,number:posDocumentNumber(complete?s:event),label:complete?'استبدال POS':'استبدال — استكمل قراءة السجل',amount:a!=null&&b!=null?new Decimal(a).plus(b).toNumber():null,incomplete:!complete});
  }else{used.add(event.id);result.push({id:event.id,event,events:[event],number:posDocumentNumber(event),label:p.returnOfEventId?'مرتجع POS':'بيع POS',amount:posHeaderNet(event),incomplete:false});}
 }
 return result;
}
export function posCashLabel(piastres:number):string {
 return piastres>0?'تحصيل من العميل':piastres<0?'رد للعميل':'فرق السعر صفر — دون حركة خزنة صافية';
}
