/** Recorded courier fees, split by business purpose; settlements never erase history. */
export function courierFeeTotals(
 rows:readonly {subject_id:string;amount_delta:number|string;ledger_events:{id?:string;kind:string;ref_id:string|null;payload:string|Record<string,unknown>}}[],
 orders:readonly {id:string;orderNumber:string;original_order_id?:string|null;isExchange?:boolean}[],
) {
 const result:Record<string,{delivery:number;returns:number;exchange:number;codService?:number}>={};
 const byNumber=new Map(orders.map(o=>[o.orderNumber,o]));
 const exchanged=new Set(orders.filter(o=>o.isExchange).map(o=>o.original_order_id));
 const grouped=new Map<string,{row:typeof rows[number];piastres:number}>();
 rows.forEach((row,index)=>{
  const value=Number(row.amount_delta);if(!Number.isFinite(value))throw Error("Invalid courier fee amount");
  const key=JSON.stringify([row.subject_id,row.ledger_events.id??index]);
  const group=grouped.get(key)??{row,piastres:0};group.piastres+=value;grouped.set(key,group);
 });
 for(const {row,piastres} of grouped.values()) {
  const e=row.ledger_events,payload=typeof e.payload==="string"?JSON.parse(e.payload):e.payload;
  if(!["order_delivered","return_confirmed","rto_confirmed","courier_fee_adjustment"].includes(e.kind)||piastres===0)continue;
  if(e.kind!=="courier_fee_adjustment"&&piastres<0)continue;
  const totals=result[row.subject_id]??={delivery:0,returns:0,exchange:0};
  if(e.kind==="courier_fee_adjustment") {totals.codService=Math.round((totals.codService??0)*100+piastres)/100;continue;}
  const service=e.kind==="order_delivered"?Number(payload.codServiceFeePiastres??0):0;
  if(!Number.isSafeInteger(service)||service<0||service>piastres)throw Error("Invalid saved COD service charge");
  if(service)totals.codService=Math.round((totals.codService??0)*100+service)/100;
  const original=e.ref_id?byNumber.get(e.ref_id):undefined;
  const swap=payload.movement==="exchange"||(!payload.movement&&original&&exchanged.has(original.id));
  const type=e.kind==="order_delivered"?"delivery":swap?"exchange":"returns";
  totals[type]=Math.round(totals[type]*100+piastres-service)/100;
 }
 return result;
}
