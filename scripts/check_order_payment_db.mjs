// Captured Production schema; synthetic loopback PostgreSQL ONLY.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openBusinessDb,read,ROOT} from './helpers/business-db.mjs';
import {buildOrderPlacedLines,buildOrderPaymentLines} from '../src/lib/ledger/orders.ts';
import {uiHarness} from './helpers/ui-harness.mjs';
let db,c;const evidence=[];
const migrations=['20261012080415_receipt_variant_stock','20261012082556_pos_atomic_exchange','20261012090535_courier_atomic_batch','20261012191715_authoritative_stock_commands','20261012194223_courier_writer_compatibility','20261012203014_catalog_return_compatibility','20261012204812_courier_obligation_compatibility','20261012213602_order_payment_atomic','20261013010850_exchange_credit_lifecycle','20261013015521_customer_trip_atomic_recovery','20261013022600_courier_claim_source_attribution','20261013031632_order_backorder_allocation','20261013111632_scoped_order_activity','20261013120155_store_branded_document_numbers'];
before(async()=>{db=await openBusinessDb();c=await db.client();for(const m of migrations)await db.admin.query(read('supabase/migrations/'+m+'.sql'))});
after(async()=>{if(db){fs.writeFileSync(path.join(ROOT,'logs/final-v1-sprint/order-payment-atomic-'+Date.now()+'.json'),JSON.stringify({version:db.version,scope:'isolated; NOT Production verified',migrations,evidence},null,2));await db.close()}});
async function order({deposit=2,shipping=2}={}){
 const product=crypto.randomUUID();
 await c.query("select record_product_catalog($1,$2,$3,'product_catalog',$4)",[crypto.randomUUID(),db.store,db.device,{action:'create',unitCost:2,product:{id:product,name:'Synthetic payment product',sku:product,quantity:5,unitPrice:10,metadata:{variants:[]}}}]);
 const id=crypto.randomUUID(),items=[{productId:product,quantity:1,unitPrice:10,unitCost:2}];
 const o={id,store_id:db.store,device_id:db.device,orderNumber:'SYN-'+id,customerName:'Synthetic buyer',customerPhone:'qa.invalid',items,stockItems:items,totalAmount:10,shippingFee:shipping,courierFee:0,courierId:crypto.randomUUID(),depositAmount:deposit,depositWallet:'inStoreSafe',expectedCod:10+shipping-deposit,paymentMethod:'partial_cod'};
 await c.query('select place_order($1,$2)',[o,db.event('order_placed','ecommerce_order',o.orderNumber,buildOrderPlacedLines({items,depositAmount:deposit,wallet:'inStoreSafe'}))]);return o;
}
const payment=async(o,amount=3,wallet='vodafoneCash',id=crypto.randomUUID(),client=c)=>(await client.query("select record_order_payment($1,$2,$3,'order_payment',$4) r",[id,db.store,db.device,{orderId:o.id,amount,wallet,expectedDeposit:o.depositAmount,expectedCod:o.expectedCod}])).rows[0].r;
const row=async(o)=>(await db.admin.query('select to_jsonb(o) r from orders o where id=$1',[o.id])).rows[0].r;
async function snapshot(){const result={};for(const t of ['orders','products','ledger_events','ledger_lines','financial_private.order_payment_commands','financial_private.order_payment_permits'])result[t]=(await db.admin.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') r from ${t} t`)).rows[0].r;return result}
async function unchanged(fn,pattern){const before=await snapshot();await assert.rejects(fn,pattern);assert.deepEqual(await snapshot(),before)}
test('top-up commits one wallet event and canonical deposit/COD document; replay retains original result',async()=>{
 const o=await order(),id=crypto.randomUUID(),r=await payment(o,3,'vodafoneCash',id);
 assert.equal(r.order.depositAmount,5);assert.equal(r.order.expectedCod,7);assert.equal(r.amountPiastres,300);assert.equal(r.replayed,false);assert.ok(r.order.updated_at>0);
 const lines=(await db.admin.query('select account,subject_id,amount_delta from ledger_lines where event_id=$1',[id])).rows;assert.deepEqual(lines,[{account:'wallet',subject_id:'vodafoneCash',amount_delta:300}]);
 const replay=await payment(o,3,'vodafoneCash',id);assert.equal(replay.replayed,true);assert.deepEqual(replay.order,r.order);assert.deepEqual(await row(o),r.order);
 await unchanged(()=>payment(o,4,'vodafoneCash',id),/NEXUS_OPERATION_PAYLOAD_MISMATCH/);
 evidence.push({case:'top-up replay',operation:id,order:o.id,deposit:5,cod:7,lines});
});
test('late order failure rolls back wallet, document, journal and consumed permit; same identity can retry',async()=>{
 const o=await order(),id=crypto.randomUUID();await db.admin.query(`create function qa_payment_late() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_PAYMENT_LATE';end$$;create trigger qa_payment_late after update on orders for each row execute function qa_payment_late()`);
 try{await unchanged(()=>payment(o,3,'inStoreSafe',id),/SYNTHETIC_PAYMENT_LATE/)}finally{await db.admin.query('drop trigger qa_payment_late on orders;drop function qa_payment_late()')}
 assert.equal((await payment(o,3,'inStoreSafe',id)).order.depositAmount,5);
});
test('suppressed required document cannot leave committed money',async()=>{
 const o=await order();await db.admin.query(`create function qa_payment_skip() returns trigger language plpgsql as $$begin return null;end$$;create trigger aaa_qa_payment_skip before update on orders for each row execute function qa_payment_skip()`);
 try{await unchanged(()=>payment(o),/NEXUS_ORDER_PAYMENT_DOCUMENT_REQUIRED/)}finally{await db.admin.query('drop trigger aaa_qa_payment_skip on orders;drop function qa_payment_skip()')}
});
test('zero, negative, sub-piastre, excess and wrong-wallet requests are rejected atomically',async()=>{
 const o=await order();for(const amount of [0,-1,0.001,10.01])await unchanged(()=>payment(o,amount),/NEXUS_ORDER_PAYMENT_(INVALID|EXCESS)/);
 await unchanged(()=>payment(o,3,'customer-wallet'),/NEXUS_ORDER_PAYMENT_INVALID/);
});
test('two distinct top-ups with same stale baseline cannot both commit',async()=>{
 const o=await order(),a=await db.client(),b=await db.client();const results=await Promise.allSettled([payment(o,3,'inStoreSafe',crypto.randomUUID(),a),payment(o,3,'inStoreSafe',crypto.randomUUID(),b)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.match(results.find(x=>x.status==='rejected').reason.message,/NEXUS_ORDER_PAYMENT_STALE/);assert.equal((await row(o)).depositAmount,5);
});
test('same-identity races apply one top-up and one replay',async()=>{
 const o=await order(),a=await db.client(),b=await db.client(),id=crypto.randomUUID();const results=await Promise.all([payment(o,3,'inStoreSafe',id,a),payment(o,3,'inStoreSafe',id,b)]);assert.equal(results.filter(r=>r.replayed).length,1);assert.equal((await row(o)).depositAmount,5);
});
test('open shipped order supports exact final payment and mixed wallets; delivery books no phantom cash',async()=>{
 const o=await order();await c.query("update orders set status='shipped' where id=$1",[o.id]);const first=await payment(o,3);const second=await payment(first.order,7,'bankAccount');assert.equal(second.order.expectedCod,0);assert.equal(second.order.depositAmount,12);
 await c.query("select record_order_delivery($1,$2,$3,'order_delivery',$4)",[crypto.randomUUID(),db.store,db.device,{orderId:o.id,settle:false}]);
 const paid=(await db.admin.query("select sum(l.amount_delta)::int n from ledger_events e join ledger_lines l on l.event_id=e.id where e.ref_id=$1 and l.account='wallet'",[o.orderNumber])).rows[0].n;assert.equal(paid,1200);
 await unchanged(()=>payment(second.order,1),/NEXUS_ORDER_PAYMENT_NOT_OPEN/);
 // Replay remains possible after delivery makes a new payment illegal.
 const entry=(await db.admin.query('select id,request from financial_private.order_payment_commands where id=$1',[second.eventId])).rows[0];assert.equal((await c.query("select record_order_payment($1,$2,$3,'order_payment',$4) r",[entry.id,db.store,db.device,entry.request.input])).rows[0].r.replayed,true);
});
test('existing ecommerce roles retain top-up access, accountant and foreign store cannot gain it',async()=>{
 for(const role of ['POS_ECOMMERCE','ECOMMERCE_ONLY']){const o=await order();assert.equal((await payment(o,3,'inStoreSafe',crypto.randomUUID(),await db.client(role))).amountPiastres,300)}
 const o=await order();await unchanged(()=>db.client('ACCOUNTANT').then(client=>payment(o,3,'inStoreSafe',crypto.randomUUID(),client)),/NEXUS_ORDER_PAYMENT_FORBIDDEN/);
 await unchanged(()=>c.query("select record_order_payment($1,$2,$3,'order_payment',$4)",[crypto.randomUUID(),crypto.randomUUID(),db.device,{orderId:o.id,amount:1,wallet:'inStoreSafe',expectedDeposit:2,expectedCod:10}]),/NEXUS_ORDER_PAYMENT_FORBIDDEN/);
 await unchanged(()=>c.query('select * from financial_private.order_payment_commands'),/permission denied/);
});
test('legacy split money append and standalone deposit/COD patches fail closed',async()=>{
 const o=await order(),event=db.event('client_payment','ecommerce_order',o.orderNumber,buildOrderPaymentLines({amount:3,wallet:'inStoreSafe'}));
 await unchanged(()=>c.query('select ledger_append($1)',[event]),/NEXUS_ORDER_PAYMENT_ATOMIC_REQUIRED/);
 await unchanged(()=>c.query('update orders set "depositAmount"=5,"expectedCod"=7 where id=$1',[o.id]),/NEXUS_ORDER_PAYMENT_ATOMIC_REQUIRED/);
 await unchanged(()=>c.query('update orders set "expectedCod"=7 where id=$1',[o.id]),/NEXUS_ORDER_PAYMENT_ATOMIC_REQUIRED/);
 await c.query('update orders set "customerName"=$1 where id=$2',['Legitimate description',o.id]);assert.equal((await row(o)).customerName,'Legitimate description');
});
test('historical document/ledger deposit drift rejects without rewriting either',async()=>{
 const o=await order();await db.admin.query('alter table orders disable trigger nexus_order_payment_document');try{await db.admin.query('update orders set "depositAmount"=3,"expectedCod"=9 where id=$1',[o.id])}finally{await db.admin.query('alter table orders enable trigger nexus_order_payment_document')}
 await unchanged(()=>payment({...o,depositAmount:3,expectedCod:9}),/NEXUS_ORDER_PAYMENT_HISTORY_REVIEW/);
});
test('actual client survives two lost committed responses and reload with one identity, one top-up and canonical row',async()=>{
 const o=await order(),storage={},calls=[];let losses=2,state={orders:[o]};
 globalThis.sessionStorage={getItem:k=>storage[k]??null,setItem:(k,v)=>storage[k]=v,removeItem:k=>delete storage[k]};
 const stubs={'@/lib/supabase':{getSupabaseClient:()=>({async rpc(name,args){assert.equal(name,'record_order_payment');calls.push(args.p_id);const data=(await c.query("select record_order_payment($1,$2,$3,$4,$5) r",[args.p_id,args.p_store,args.p_device,args.p_command,args.p_input])).rows[0].r;if(losses-->0)throw Error('SYNTHETIC_COMMITTED_RESPONSE_LOSS');return {data,error:null}}})},
 '@/services/api/storeContext':{getSyncIdentity:async()=>({storeId:db.store,deviceId:db.device})},'@/store/useOrderStore':{useOrderStore:{setState:fn=>state={...state,...fn(state)}}}};
 try{await assert.rejects(uiHarness(stubs).load('src/lib/orderPayment.ts').commitOrderPayment(o,3,'inStoreSafe'),/لم يصل تأكيد العملية/);assert.equal(state.orders[0].depositAmount,2);
 const recovered=await uiHarness(stubs).load('src/lib/orderPayment.ts').resolvePendingOrderPayment();assert.equal(recovered.replayed,true);assert.equal(state.orders[0].depositAmount,5);assert.equal(state.orders[0].expectedCod,7);assert.equal(new Set(calls).size,1);assert.equal(Object.keys(storage).length,0);
 evidence.push({case:'actual client committed response loss',order:o.id,operation:calls[0],attempts:calls.length});}finally{delete globalThis.sessionStorage}
});
test('actual client does not overwrite a newer reader or changed tenant; post-commit cache failure never becomes a second payment',async()=>{
 for(const mode of ['newer','tenant','failure']){
  const o=await order();let state={orders:[{...o,updated_at:Number.MAX_SAFE_INTEGER,customerName:'Newer read'}]},calls=0,identityReads=0;
  const stubs={'@/services/api/storeContext':{getSyncIdentity:async()=>({storeId:mode==='tenant'&&++identityReads>2?'another-store':db.store,deviceId:db.device})},
   '@/lib/supabase':{getSupabaseClient:()=>({async rpc(_name,args){calls++;return {data:(await c.query("select record_order_payment($1,$2,$3,$4,$5) r",[args.p_id,args.p_store,args.p_device,args.p_command,args.p_input])).rows[0].r,error:null}}})},
   '@/store/useOrderStore':{useOrderStore:{setState:fn=>{if(mode==='failure')throw Error('SYNTHETIC_CACHE_FAILURE');state={...state,...fn(state)}}}}};
  const r=await uiHarness(stubs).load('src/lib/orderPayment.ts').commitOrderPayment(o,3,'inStoreSafe');assert.equal(r.order.depositAmount,5);assert.equal(state.orders[0].depositAmount,2);assert.equal(calls,1);assert.equal((await row(o)).depositAmount,5);
 }
});
