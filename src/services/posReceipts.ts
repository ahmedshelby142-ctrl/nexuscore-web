import {getSupabaseClient} from "@/lib/supabase";
import {getActiveStoreId} from "@/services/api/storeContext";
import {pageAll} from "@/lib/pageAll";
import {posDocumentNumber} from "@/lib/documentIdentity";
import {groupPosHistory} from "@/lib/posHistory";
import {netProfitOf} from "@/lib/ledger/reports";
import type {LedgerEvent} from "@/lib/ledger/types";
export interface PosReceipt {
 id:string;number:string;kind:'sale'|'refund'|'exchange';sourceId?:string;sourceNumber?:string;
 customer:string;phone:string;at:string;eventIds:string[];items:any[];
 refundPiastres:number;replacementPiastres:number;netPiastres:number;cogsPiastres:number;profitPiastres:number;
 wallets:{id:string;piastres:number}[];
}
const columns='id,store_id,device_id,kind,occurred_at,created_at,actor,ref_type,ref_id,payload';
const header=(row:any):LedgerEvent=>({...row,id:row.id,storeId:row.store_id,deviceId:row.device_id,
 refType:row.ref_type,refId:row.ref_id,occurredAt:row.occurred_at,createdAt:row.created_at,
 payload:typeof row.payload==='string'?JSON.parse(row.payload):row.payload??{},syncStatus:'synced',reversedBy:null});
const integer=(value:unknown)=>{const n=Number(value);if(value==null||(typeof value!=='number'&&typeof value!=='string')||(typeof value==='string'&&!/^-?\d+$/.test(value))||!Number.isSafeInteger(n))throw new Error('تعذّر إثبات مبالغ الإيصال؛ راجع الدفتر.');return n;};
/** All reads pin the originating tenant. No RPC/insert/update or guessed financial amount. */
export async function readPosReceipt(eventId:string):Promise<PosReceipt> {
 const client=getSupabaseClient(),store=await getActiveStoreId();
 if(!client||!store)throw new Error('تعذّر تحديد متجر الفاتورة.');
 const current=async()=>{if(await getActiveStoreId()!==store)throw new Error('تغيّر المتجر أثناء قراءة الإيصال.');};
 const load=async(id:string)=>{
  const {data,error}=await client.from('ledger_events').select(columns).eq('store_id',store).eq('id',id).eq('kind','sale').eq('ref_type','pos_sale').maybeSingle();
  await current();if(error)throw new Error(error.message);if(!data)throw new Error('الفاتورة الأصلية غير متاحة في هذا المتجر.');return header(data);
 };
 const selected=await load(eventId),exchangeId=selected.payload.exchangeId;
 let legs=[selected],kind:PosReceipt['kind']=selected.payload.returnOfEventId?'refund':'sale';
 if(exchangeId){
  if(typeof exchangeId!=='string'||selected.refId!==exchangeId)throw new Error('روابط الاستبدال تحتاج مراجعة.');
  const rows=await pageAll<any>((from,to)=>client.from('ledger_events').select(columns).eq('store_id',store).eq('kind','sale').eq('ref_type','pos_sale').eq('ref_id',exchangeId).order('id').range(from,to));await current();
  const groups=groupPosHistory(rows.map(header));
  if(groups.length!==1||groups[0].incomplete||!groups[0].events.some(e=>e.id===selected.id))throw new Error('لم تكتمل قراءة طرفي الاستبدال؛ أعد المحاولة دون تسجيل عملية جديدة.');
  legs=groups[0].events;kind='exchange';
 }
 const returned=legs.find(e=>e.payload.returnOfEventId),sold=legs.find(e=>!e.payload.returnOfEventId);
 const source=returned?await load(String(returned.payload.returnOfEventId)):undefined;
 if(source?.payload.returnOfEventId)throw new Error('هوية فاتورة الأصل تحتاج مراجعة.');
 const ids=legs.map(e=>e.id),lines=await pageAll<any>((from,to)=>client.from('ledger_lines').select('id,event_id,account,subject_id,amount_delta').eq('store_id',store).in('event_id',ids).order('id').range(from,to));await current();
 const sum=(account:string,id?:string)=>integer(lines.filter(l=>l.account===account&&(!id||l.event_id===id)).reduce((n,l)=>integer(n+integer(l.amount_delta)),0));
 if(!lines.some(l=>l.account==='revenue')||legs.some(e=>!lines.some(l=>l.event_id===e.id&&l.account==='wallet')))throw new Error('حركات الإيصال غير مكتملة؛ أعد القراءة.');
 const refund=returned?-sum('revenue',returned.id):0,replacement=sold?sum('revenue',sold.id):0,net=sum('wallet'),revenue=sum('revenue'),cogs=sum('cogs');
 if(refund<0||replacement<0||net!==revenue||net!==replacement-refund||sum('stock')!==-cogs)throw new Error('مبالغ الإيصال لا تتطابق مع الدفتر؛ يلزم مراجعة.');
 const walletIds=[...new Set<string>(lines.filter(l=>l.account==='wallet').map(l=>l.subject_id))];
 const last=sold??selected;
 return {id:kind==='exchange'?String(exchangeId):selected.id,number:posDocumentNumber(kind==='refund'&&source?source:last),kind,sourceId:source?.id,sourceNumber:source?posDocumentNumber(source):undefined,
  customer:String((source??selected).payload.customerName??'عميل نقدي'),phone:String((source??selected).payload.customerPhone??''),at:last.occurredAt,eventIds:ids,
  items:legs.flatMap(e=>Array.isArray(e.payload.items)?e.payload.items as any[]:[]),refundPiastres:refund,replacementPiastres:replacement,netPiastres:net,cogsPiastres:cogs,profitPiastres:integer(netProfitOf({revenue,cogs,expenses:0})),
  wallets:walletIds.map(id=>({id,piastres:integer(lines.filter(l=>l.account==='wallet'&&l.subject_id===id).reduce((n,l)=>integer(n+integer(l.amount_delta)),0))}))};
}
