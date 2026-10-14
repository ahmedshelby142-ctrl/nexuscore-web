// Captured schema, PostgreSQL17.6 loopback ONLY; no cloud environment access.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openBusinessDb,read,ROOT} from './helpers/business-db.mjs';
import {buildOrderPlacedLines,buildOrderRTOLines,buildOrderDeliveredLines,buildReturnConfirmedLines} from '../src/lib/ledger/orders.ts';
import {uiHarness} from './helpers/ui-harness.mjs';
const migrations=['20261012080415_receipt_variant_stock','20261012082556_pos_atomic_exchange','20261012090535_courier_atomic_batch','20261012191715_authoritative_stock_commands','20261012194223_courier_writer_compatibility','20261012203014_catalog_return_compatibility','20261012204812_courier_obligation_compatibility','20261012213602_order_payment_atomic','20261013010850_exchange_credit_lifecycle','20261013015521_customer_trip_atomic_recovery','20261013022600_courier_claim_source_attribution','20261013031632_order_backorder_allocation','20261013111632_scoped_order_activity','20261013120155_store_branded_document_numbers'];
let db,c;const evidence=[];
before(async()=>{db=await openBusinessDb();c=await db.client();for(const m of migrations)await db.admin.query(read('supabase/migrations/'+m+'.sql'));});
after(async()=>{if(db){fs.writeFileSync(path.join(ROOT,'logs/final-v1-sprint/customer-trip-atomic-'+Date.now()+'.json'),JSON.stringify({scope:'isolated PG17.6 ONLY; not Production',version:db.version,migrations,evidence},null,2));await db.close();}});
const row=async(table,id)=>(await db.admin.query('select to_jsonb(t) r from '+table+' t where id=$1',[id])).rows[0]?.r;
async function customer(count=0,archived=false){const id=crypto.randomUUID();await db.insert('customers',{id,store_id:db.store,device_id:db.device,name:'Synthetic I customer',phone:'qa.invalid-'+id,address:'',deleted_at:archived?new Date().toISOString():null});if(count){await db.admin.query('begin');try{await db.admin.query('set local session_replication_role=replica');await db.admin.query('update customers set returned_orders_count=$1 where id=$2',[count,id]);await db.admin.query('commit');}catch(e){await db.admin.query('rollback');throw e;}}return id;}
async function order({customerId,penalty=true}={}){
 const product=crypto.randomUUID();await c.query("select record_product_catalog($1,$2,$3,'product_catalog',$4)",[crypto.randomUUID(),db.store,db.device,{action:'create',unitCost:2,product:{id:product,name:'Synthetic trip product',sku:product,quantity:5,unitPrice:10,metadata:{variants:[]}}}]);
 const courier=crypto.randomUUID();await db.insert('couriers',{id:courier,store_id:db.store,device_id:db.device,name:'Synthetic I courier '+courier});
 const id=crypto.randomUUID(),items=[{productId:product,quantity:1,unitPrice:10,unitCost:2}];const o={id,store_id:db.store,device_id:db.device,orderNumber:'I-'+id,customerId,customerName:'Synthetic customer',customerPhone:'qa.invalid',items,stockItems:items,totalAmount:10,shippingFee:2,courierFee:2,courierId:courier,depositAmount:0,expectedCod:penalty?14:12,paymentMethod:'partial_cod',wastedTripCompensation:penalty?2:0,shippingPenaltyApplied:penalty};
 await c.query('select place_order($1,$2)',[o,db.event('order_placed','ecommerce_order',o.orderNumber,buildOrderPlacedLines({items,depositAmount:0}))]);await c.query("update orders set status='shipped' where id=$1",[o.id]);return o;
}
const delivery=async(o,id=crypto.randomUUID(),client=c,extra={})=>(await client.query("select record_order_delivery($1,$2,$3,'order_delivery',$4) r",[id,db.store,db.device,{orderId:o.id,settle:false,...extra}])).rows[0].r;
async function snapshot(){const s={};for(const t of ['orders','customers','products','ledger_events','ledger_lines','financial_private.courier_commands','financial_private.customer_trip_commands','financial_private.customer_trip_permits','financial_private.customer_trip_order_permits'])s[t]=(await db.admin.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') r from ${t} t`)).rows[0].r;return s;}
async function unchanged(fn,re){const s=await snapshot();await assert.rejects(fn,re);assert.deepEqual(await snapshot(),s);}
async function rto(o,identity=o.customerId,client=c){await client.query("update orders set status='returned' where id=$1",[o.id]);const event=db.event('rto_confirmed','ecommerce_order',o.orderNumber,buildOrderRTOLines({items:o.stockItems,courierId:o.courierId,returnFee:0}));return {event,invoke:()=>client.query("select confirm_order_return($1,'customer','return',$2,$3) r",[o.id,JSON.stringify([event]),identity??null])};}
test('I atomic recovery consumes ONE customer trip and flag with the immutable delivery; same-request replay cannot decrement again',async()=>{
 const cid=await customer(3),o=await order({customerId:cid}),id=crypto.randomUUID();const result=await delivery(o,id);assert.equal(result.customer.returned_orders_count,2);assert.equal((await row('customers',cid)).returned_orders_count,2);assert.equal((await row('orders',o.id)).shippingPenaltyApplied,false);assert.equal((await delivery(o,id)).replayed,true);assert.equal((await row('customers',cid)).returned_orders_count,2);
 const lines=(await db.admin.query('select account,subject_id,amount_delta from ledger_lines where event_id=$1',[id])).rows;assert.equal(lines.filter(x=>x.account==='receivable_courier').reduce((a,x)=>a+x.amount_delta,0),1400);assert.equal(lines.find(x=>x.account==='revenue'&&x.subject_id==='wasted_trip_compensation').amount_delta,200);assert.equal(lines.find(x=>x.account==='payable_courier').amount_delta,200);
 evidence.push({order:o.id,event:id,customer:cid,result,lines});
});
test('I suppressed required customer write rolls back delivery, counter, flag, ledger and journal, then same identity safely retries',async()=>{
 const cid=await customer(1),o=await order({customerId:cid}),id=crypto.randomUUID();await db.admin.query(`create function qa_trip_skip() returns trigger language plpgsql as $$begin return null;end$$;create trigger aaa_qa_trip_skip before update on customers for each row execute function qa_trip_skip()`);
 try{await unchanged(()=>delivery(o,id),/NEXUS_TRIP_CUSTOMER_WRITE_REQUIRED/);}finally{await db.admin.query('drop trigger aaa_qa_trip_skip on customers;drop function qa_trip_skip()');}assert.equal((await delivery(o,id)).customer.returned_orders_count,0);
});
test('I late order-flag failure rolls back the complete financial operation, including customer counter',async()=>{
 const cid=await customer(1),o=await order({customerId:cid});await db.admin.query(`create function qa_trip_late() returns trigger language plpgsql as $$begin if OLD."shippingPenaltyApplied" and not NEW."shippingPenaltyApplied" then raise exception 'SYNTHETIC_TRIP_LATE';end if;return NEW;end$$;create trigger aaa_qa_trip_late before update on orders for each row execute function qa_trip_late()`);
 try{await unchanged(()=>delivery(o),/SYNTHETIC_TRIP_LATE/);}finally{await db.admin.query('drop trigger aaa_qa_trip_late on orders;drop function qa_trip_late()');}
});
test('I simultaneous distinct deliveries serialize customer debt; two owed trips become zero without stale overwrite',async()=>{
 const cid=await customer(2),a=await order({customerId:cid}),b=await order({customerId:cid}),other=await db.client();await Promise.all([delivery(a),delivery(b,crypto.randomUUID(),other)]);assert.equal((await row('customers',cid)).returned_orders_count,0);assert.equal((await row('orders',a.id)).shippingPenaltyApplied,false);assert.equal((await row('orders',b.id)).shippingPenaltyApplied,false);
});
test('I last trip cannot be forgiven twice by two orders; zero debt requires review and preserves the losing order',async()=>{
 const cid=await customer(1),a=await order({customerId:cid}),b=await order({customerId:cid}),other=await db.client();const results=await Promise.allSettled([delivery(a),delivery(b,crypto.randomUUID(),other)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.match(results.find(x=>x.status==='rejected').reason.message,/CUSTOMER_DEBT_REVIEW/);assert.equal((await row('customers',cid)).returned_orders_count,0);
 const statuses=[await row('orders',a.id),await row('orders',b.id)];assert.equal(statuses.filter(x=>x.status==='shipped'&&x.shippingPenaltyApplied).length,1);
});
test('I same-request concurrent recovery applies one decrement and returns one stable replay',async()=>{
 const cid=await customer(2),o=await order({customerId:cid}),id=crypto.randomUUID(),other=await db.client();const results=await Promise.all([delivery(o,id),delivery(o,id,other)]);assert.equal(results.filter(x=>x.replayed).length,1);assert.equal((await row('customers',cid)).returned_orders_count,1);
});
test('I CRM edits and archives preserve the server-owned counter despite stale full-row values; archived exact customer remains attributable',async()=>{
 const cid=await customer(2,true);await c.query('update customers set name=$1,returned_orders_count=0 where id=$2',['Corrected synthetic name',cid]);assert.equal((await row('customers',cid)).returned_orders_count,2);assert.equal((await row('customers',cid)).name,'Corrected synthetic name');const o=await order({customerId:cid});await delivery(o);assert.equal((await row('customers',cid)).returned_orders_count,1);
});
test('I missing exact customer and standalone flag/journal mutations cannot manufacture a recovered trip; ordinary guest delivery remains supported',async()=>{
 const o=await order();await unchanged(()=>delivery(o),/CUSTOMER_DEBT_REVIEW/);await unchanged(()=>c.query('update orders set "shippingPenaltyApplied"=false where id=$1',[o.id]),/FLAG_SERVER_OWNED/);await unchanged(()=>c.query("select financial_private.apply_customer_trip($1,$2,$3,'recover')",[crypto.randomUUID(),o.id,db.store]),/DELIVERY_REVIEW/);const guest=await order({penalty:false});assert.equal((await delivery(guest)).customer,null);
 const acct=await db.client('ACCOUNTANT');await unchanged(()=>delivery(o,crypto.randomUUID(),acct),/DELIVERY_FORBIDDEN/);
});
test('I actual RTO increments the persisted customer atomically even when UI omits the ID; forged different customer rejected without return effects',async()=>{
 const cid=await customer(),o=await order({customerId:cid,penalty:false}),r=await rto(o,null);const saved=(await r.invoke()).rows[0].r;assert.equal(saved.customer.returned_orders_count,1);assert.equal((await row('customers',cid)).returned_orders_count,1);
 const next=await order({customerId:cid,penalty:false}),foreign=await customer(),forged=await rto(next,foreign);await unchanged(()=>forged.invoke(),/CUSTOMER_IDENTITY_REVIEW/);assert.equal((await row('customers',foreign)).returned_orders_count,0);
});
test('I delivery plus immediate full return recovers an old trip and earns exactly one new trip in the same return transaction',async()=>{
 const cid=await customer(1),o=await order({customerId:cid});await c.query("update orders set status='returned' where id=$1",[o.id]);const del=db.event('order_delivered','ecommerce_order',o.orderNumber,buildOrderDeliveredLines({items:o.stockItems,goodsTotal:10,courierId:o.courierId,customerId:cid,codAmount:14,depositAmount:0,shippingFee:2,courierFee:2,wastedTripCompensation:2}));const ret=db.event('return_confirmed','ecommerce_order',o.orderNumber,buildReturnConfirmedLines({items:o.stockItems,refundAmount:10,revenueAmount:10,wallet:'inStoreSafe',courierId:o.courierId,customerId:cid,returnFee:0}));
 const result=(await c.query("select confirm_order_return($1,'customer','return',$2,$3) r",[o.id,JSON.stringify([del,ret]),cid])).rows[0].r;assert.equal(result.customer.returned_orders_count,1);assert.equal((await row('orders',o.id)).shippingPenaltyApplied,false);assert.equal((await db.admin.query('select count(*)::int n from financial_private.customer_trip_commands where order_id=$1',[o.id])).rows[0].n,2);
});
test('I delivery+settlement failure rolls back required trip recovery and cash, rather than partially forgiving debt',async()=>{
 const cid=await customer(1),o=await order({customerId:cid});await unchanged(()=>delivery(o,crypto.randomUUID(),c,{settle:true,wallet:'invalid',netReceived:12}),/INVALID|wallet|WALLET/);assert.equal((await row('customers',cid)).returned_orders_count,1);
});
test('I real CRM ON CONFLICT full-row upsert preserves current debt despite a stale counter snapshot',async()=>{
 const cid=await customer(3),stale=await row('customers',cid),o=await order({customerId:cid});await delivery(o);await c.query('insert into customers(id,store_id,device_id,name,phone,address,returned_orders_count) values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do update set name=excluded.name,returned_orders_count=excluded.returned_orders_count',[cid,db.store,db.device,'Renamed CRM',stale.phone,'',stale.returned_orders_count]);assert.equal((await row('customers',cid)).returned_orders_count,2);assert.equal((await row('customers',cid)).name,'Renamed CRM');
});
test('I omitted required journal and suppressed return-counter write cannot leave committed financial documents',async()=>{
 const cid=await customer(1),o=await order({customerId:cid});await db.admin.query(`create function qa_trip_no_journal() returns trigger language plpgsql as $$begin return null;end$$;create trigger aaa_qa_trip_no_journal before insert on financial_private.customer_trip_commands for each row execute function qa_trip_no_journal()`);
 try{await unchanged(()=>delivery(o),/JOURNAL_REQUIRED/);}finally{await db.admin.query('drop trigger aaa_qa_trip_no_journal on financial_private.customer_trip_commands;drop function qa_trip_no_journal()');}
 const returned=await order({customerId:cid,penalty:false}),r=await rto(returned);await db.admin.query(`create function qa_trip_no_return_count() returns trigger language plpgsql as $$begin return null;end$$;create trigger aaa_qa_trip_no_return_count before update on customers for each row execute function qa_trip_no_return_count()`);
 try{await unchanged(()=>r.invoke(),/CUSTOMER_WRITE_REQUIRED/);}finally{await db.admin.query('drop trigger aaa_qa_trip_no_return_count on customers;drop function qa_trip_no_return_count()');}assert.equal((await row('orders',returned.id)).returnConfirmedAt,null);
});
test('I concurrent return earning and delivery recovery preserve both changes on the exact customer',async()=>{
 const cid=await customer(1),out=await order({customerId:cid}),back=await order({customerId:cid,penalty:false}),other=await db.client(),r=await rto(back,cid,other);await Promise.all([delivery(out),r.invoke()]);assert.equal((await row('customers',cid)).returned_orders_count,1);
});
test('I actual financial client lost committed delivery response and reload reuse one event, counter and flag disposition',async()=>{
 const cid=await customer(2),o=await order({customerId:cid}),calls=[],storage={};let losses=2;globalThis.sessionStorage={getItem:k=>storage[k]??null,setItem:(k,v)=>storage[k]=v,removeItem:k=>delete storage[k]};
 const stubs={'@/lib/supabase':{getSupabaseClient:()=>({async rpc(name,args){assert.equal(name,'record_order_delivery');calls.push(args.p_id);const data=await delivery(o,args.p_id,c,args.p_input);if(losses-->0)throw Error('SYNTHETIC_DELIVERY_RESPONSE_LOSS');return{data,error:null}}})},'@/services/api/storeContext':{getSyncIdentity:async()=>({storeId:db.store,deviceId:db.device})}};
 try{await assert.rejects(uiHarness(stubs).load('src/lib/financialCommand.ts').runFinancialCommand('order_delivery',{orderId:o.id,settle:false},'order_delivery'),/لم يصل تأكيد العملية/);const recovered=await uiHarness(stubs).load('src/lib/financialCommand.ts').resolvePendingFinancialCommand('order_delivery');assert.equal(recovered.replayed,true);assert.equal(new Set(calls).size,1);assert.equal((await row('customers',cid)).returned_orders_count,1);assert.equal((await row('orders',o.id)).shippingPenaltyApplied,false);assert.equal(Object.keys(storage).length,0);evidence.push({case:'committed delivery response lost and recovered',event:calls[0],order:o.id,customer:cid,attempts:calls.length});}finally{delete globalThis.sessionStorage;}
});
test('I a later returned-trip fee remains collectible after earlier delivery settlement; customer/courier zero offsets and shop payout preserve historical amounts',async()=>{
 for(const cause of ['customer','courier','shop']) {
  const cid=await customer(1),o=await order({customerId:cid});await delivery(o);const settle=async(input)=>(await c.query("select record_courier_batch($1,$2,$3,'courier_batch',$4) r",[crypto.randomUUID(),db.store,db.device,{courierId:o.courierId,orderIds:[o.id],wallet:'inStoreSafe',...input}])).rows[0].r;
  await settle({netReceived:12});const oldStamp=(await row('orders',o.id)).codSettledAt;assert.ok(oldStamp);await c.query("update orders set status='returned' where id=$1",[o.id]);
  const returned=db.event('return_confirmed','ecommerce_order',o.orderNumber,buildReturnConfirmedLines({items:o.stockItems,refundAmount:10,revenueAmount:10,wallet:'inStoreSafe',refundVia:'wallet',courierId:o.courierId,customerId:cid,returnFee:50,movement:'return',feeBorneBy:cause}));await c.query('select confirm_order_return($1,$2,\'return\',$3,$4)',[o.id,cause,JSON.stringify([returned]),cid]);
  const read=async()=>(await c.query('select read_courier_obligations($1,$2) r',[db.store,o.courierId])).rows[0].r;const open=await read();assert.equal(open.length,1);assert.equal(open[0].codPiastres,cause==='shop'?0:5000);assert.equal(open[0].feePiastres,5000);assert.equal(open[0].reviewReason,null);
  const result=await settle({netReceived:cause==='shop'?-50:0});assert.equal(result.feePiastres,5000);assert.equal((await read()).length,0);const lines=(await db.admin.query('select account,amount_delta from ledger_lines where event_id=$1',[result.eventId])).rows;assert.equal(lines.filter(x=>x.account==='wallet').reduce((a,x)=>a+x.amount_delta,0),cause==='shop'?-5000:0);
  assert.equal((await row('customers',cid)).returned_orders_count,cause==='customer'?1:0);assert.equal((await db.admin.query("select sum(amount_delta)::int n from ledger_lines where event_id=$1 and account='payable_courier'",[returned.id])).rows[0].n,5000);evidence.push({case:'late return fee after delivery settlement',cause,order:o.id,returnEvent:returned.id,oldStamp,settlement:result,lines});
 }
});
