// Captured PostgreSQL schema, synthetic loopback data only. No cloud access.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {openBusinessDb,read,ROOT} from './helpers/business-db.mjs';
import {buildOpeningBalanceLines} from '../src/lib/ledger/audit.ts';
import {buildOrderPlacedLines,buildOrderDeliveredLines,buildReturnConfirmedLines} from '../src/lib/ledger/orders.ts';
let db,c;const evidence=[];
const migration='supabase/migrations/20261012090535_courier_atomic_batch.sql';
const candidateMigrations=['20261012080415_receipt_variant_stock','20261012082556_pos_atomic_exchange','20261012090535_courier_atomic_batch','20261012191715_authoritative_stock_commands','20261012194223_courier_writer_compatibility'];
before(async()=>{db=await openBusinessDb();c=await db.client('ADMIN');for(const name of candidateMigrations)await db.admin.query(read('supabase/migrations/'+name+'.sql'))});
after(async()=>{if(db){fs.writeFileSync(path.join(ROOT,'logs/final-v1-sprint/courier-writer-regression.json'),JSON.stringify({version:db.version,candidateMigrations,scope:'local only; full Task I not complete; NOT Production verified',evidence},null,2));await db.close()}});
async function seed({goods=100,shipping=20,courier,fee=shipping,deliver=true}={}){
 courier??=crypto.randomUUID();
 if(!(await db.admin.query('select 1 from couriers where id=$1',[courier])).rowCount)
  await db.insert('couriers',{id:courier,store_id:db.store,device_id:db.device,name:'Synthetic courier '+courier});
 const product=crypto.randomUUID(),id=crypto.randomUUID();
 await db.insert('products',{id:product,store_id:db.store,device_id:db.device,name:'Synthetic stock',sku:product,quantity:10});
 await c.query('select ledger_append($1)',[db.event('stock_adjustment','opening_balance',product,buildOpeningBalanceLines({productId:product,quantity:10,unitCost:2}))]);
 const items=[{id:crypto.randomUUID(),productId:product,productName:'Synthetic stock',quantity:1,unitPrice:goods,unitCost:2}];
 const order={id,store_id:db.store,device_id:db.device,orderNumber:'QA-'+id,customerName:'Synthetic',customerPhone:'qa.invalid',items,stockItems:items,
  totalAmount:goods,shippingFee:shipping,courierFee:fee,depositAmount:0,expectedCod:goods+shipping,paymentMethod:'partial_cod',courierId:courier};
 await c.query('select place_order($1,$2)',[order,db.event('order_placed','ecommerce_order',order.orderNumber,buildOrderPlacedLines({items}))]);
 await c.query("update orders set status='shipped' where id=$1",[id]);
 if(deliver)await delivery({orderId:id,settle:false,wallet:'inStoreSafe',netReceived:0});
 return order;
}
const input=(orders,net)=>({courierId:orders[0].courierId,courierName:'Synthetic courier',orderIds:orders.map(o=>o.id).sort(),wallet:'inStoreSafe',netReceived:net});
const settle=(req,id=crypto.randomUUID(),client=c)=>client.query('select record_courier_batch($1,$2,$3,$4,$5) r',[id,db.store,db.device,'courier_batch',req]).then(r=>r.rows[0].r);
const delivery=(req,id=crypto.randomUUID(),client=c)=>client.query('select record_order_delivery($1,$2,$3,$4,$5) r',[id,db.store,db.device,'order_delivery',req]).then(r=>r.rows[0].r);
const row=async(id)=>(await db.admin.query('select to_jsonb(o) r from orders o where id=$1',[id])).rows[0].r;
const total=async(account,courier)=>(await db.admin.query('select coalesce(sum(amount_delta),0)::int n from ledger_lines where store_id=$1 and account=$2 and subject_id=$3',[db.store,account,courier])).rows[0].n;
async function unchanged(action,pattern){
 const snapshot=async()=>{const out={};for(const table of ['orders','ledger_events','ledger_lines','products','financial_private.stock_applications','financial_private.stock_write_permits','financial_private.courier_commands','financial_private.courier_stamp_permits'])out[table]=(await db.admin.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') r from ${table} t where store_id=$1`,[db.store])).rows[0].r;return out};
 const prior=await snapshot();await assert.rejects(action,pattern);assert.deepEqual(await snapshot(),prior);
}
test('full transfer atomically clears receivable, payable and selected documents without touching stock/revenue/COGS',async()=>{
 const a=await seed(),b=await seed({goods:12.34,shipping:1.11,courier:a.courierId});
 const stock=(await db.admin.query("select jsonb_agg(to_jsonb(l) order by id) r from ledger_lines l where store_id=$1 and account in ('stock','revenue','cogs')",[db.store])).rows[0].r;
 const result=await settle(input([a,b],112.34));assert.equal(result.codPiastres,13345);assert.equal(result.feePiastres,2111);assert.equal(result.netPiastres,11234);assert.equal(result.shortfallPiastres,0);
 for(const o of [a,b])assert.ok((await row(o.id)).codSettledAt);
 assert.equal(await total('receivable_courier',a.courierId),0);assert.equal(await total('payable_courier',a.courierId),0);
 assert.deepEqual((await db.admin.query("select jsonb_agg(to_jsonb(l) order by id) r from ledger_lines l where store_id=$1 and account in ('stock','revenue','cogs')",[db.store])).rows[0].r,stock);
 evidence.push({scenario:'full transfer',result});
});
test('50 receivable /50 fee zero-net offset closes both obligations, creates NO wallet line and survives replay',async()=>{
 const o=await seed({goods:0,shipping:50}),req=input([o],0),id=crypto.randomUUID(),result=await settle(req,id);
 assert.equal(result.codPiastres,5000);assert.equal(result.feePiastres,5000);assert.equal(result.netPiastres,0);
 assert.equal((await db.admin.query("select count(*)::int n from ledger_lines where event_id=$1 and account='wallet'",[id])).rows[0].n,0);
 assert.equal(await total('receivable_courier',o.courierId),0);assert.equal(await total('payable_courier',o.courierId),0);
 assert.equal((await settle(req,id)).replayed,true);
 const payload=JSON.parse((await db.admin.query('select payload from ledger_events where id=$1',[id])).rows[0].payload);assert.equal(payload.settlementType,'offset');
 evidence.push({scenario:'zero offset',result,payload});
});
test('piastre shortfall is an explicit expense; fee is not expensed a second time',async()=>{
 const o=await seed({goods:1.99,shipping:.01}),r=await settle(input([o],1.98));assert.equal(r.shortfallPiastres,1);
 const expenses=(await db.admin.query("select subject_id,amount_delta from ledger_lines where event_id=$1 and account='expense'",[r.eventId])).rows;
 assert.deepEqual(expenses,[{subject_id:'courier_shortfall',amount_delta:1}]);assert.equal(await total('payable_courier',o.courierId),0);
});
test('selecting a subset preserves unticked order obligations and permits a later independent batch',async()=>{
 const a=await seed(),b=await seed({goods:30,courier:a.courierId});await settle(input([a],100));assert.equal((await row(b.id)).codSettledAt,null);
 assert.equal(await total('receivable_courier',a.courierId),5000);assert.equal(await total('payable_courier',a.courierId),2000);
 await settle(input([b],30));assert.equal(await total('receivable_courier',a.courierId),0);
});
test('late document failure rolls back the financial event and every selected order',async()=>{
 const a=await seed(),b=await seed({courier:a.courierId});
 await db.admin.query("create function public.qa_settlement_fail() returns trigger language plpgsql as $$ begin if NEW.\"codSettledAt\" is not null then raise exception 'SYNTHETIC_DOC_FAILURE'; end if; return NEW; end $$; create trigger qa_settlement_fail before update on orders for each row execute function public.qa_settlement_fail()");
 try{await unchanged(()=>settle(input([a,b],200)),/SYNTHETIC_DOC_FAILURE/)}finally{await db.admin.query('drop trigger qa_settlement_fail on orders; drop function public.qa_settlement_fail()')}
});
test('same operation parallel/retry is exact once; changed request and a different duplicate operation refuse',async()=>{
 const o=await seed(),req=input([o],100),id=crypto.randomUUID(),other=await db.client('ACCOUNTANT');
 const results=await Promise.all([settle(req,id),settle(req,id,other)]);assert.equal(results.filter(r=>r.replayed).length,1);
 await unchanged(()=>settle({...req,netReceived:99},id),/NEXUS_OPERATION_PAYLOAD_MISMATCH/);
 await unchanged(()=>settle(req),/NEXUS_COURIER_ORDER_NOT_OPEN/);
});
test('different operations on the same order serialize: exactly one commits',async()=>{
 const o=await seed(),other=await db.client('ACCOUNTANT');
 const results=await Promise.allSettled([settle(input([o],100)),settle(input([o],100),crypto.randomUUID(),other)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 assert.equal(await total('receivable_courier',o.courierId),0);
});
test('unbacked amounts, wrong courier/tenant, forbidden role and duplicate selection cannot consume another order balance',async()=>{
 const a=await seed(),b=await seed();const req=input([a],100);
 await unchanged(()=>settle({...req,courierId:b.courierId}),/NEXUS_COURIER_ORDER_NOT_OPEN/);
 await unchanged(()=>settle({...req,orderIds:[a.id,a.id]}),/NEXUS_COURIER_BATCH_INVALID/);
 for(const netReceived of [-1,100.001,101])await unchanged(()=>settle({...req,netReceived}),/NEXUS_COURIER_(BATCH_INVALID|PARTIAL_ALLOCATION_REQUIRED)/);
 const forbidden=await db.client('POS_ECOMMERCE');await unchanged(()=>settle(req,crypto.randomUUID(),forbidden),/NEXUS_COURIER_FORBIDDEN/);
 await unchanged(()=>c.query('select record_courier_batch($1,$2,$3,$4,$5)',[crypto.randomUUID(),crypto.randomUUID(),db.device,'courier_batch',req]),/NEXUS_COURIER_FORBIDDEN/);
 await db.admin.query('update orders set "expectedCod"="expectedCod"+1 where id=$1',[a.id]);
 await unchanged(()=>settle(req),/NEXUS_COURIER_SOURCE_REVIEW_REQUIRED/);
});
test('negative-net, fee-only and individual partial allocations stay blocked without erasing payable',async()=>{
 const o=await seed({goods:10,shipping:0,fee:50});
 await unchanged(()=>settle(input([o],0)),/NEXUS_COURIER_PARTIAL_ALLOCATION_REQUIRED/);
 assert.equal(await total('receivable_courier',o.courierId),1000);assert.equal(await total('payable_courier',o.courierId),5000);
});
test('actual partial exchange courier refund is attributed to its replacement once, not the original order twice',async()=>{
 const source=await seed({goods:10,shipping:0}),id=crypto.randomUUID();
 const items=source.items.map(i=>({...i,id:crypto.randomUUID(),unitPrice:15}));
 const replacement={...source,id,orderNumber:'QA-'+id,items,stockItems:[],totalAmount:15,shippingFee:120,courierFee:120,expectedCod:135};
 const operation=crypto.randomUUID();
 const placed=(await c.query('select record_exchange_place($1,$2,$3,$4,$5) r',[operation,db.store,db.device,'exchange_place',{
  order:replacement,event:db.event('order_placed','ecommerce_order',replacement.orderNumber,[]),originalOrderId:source.id,
  selections:[{lineId:source.items[0].id,quantity:1}],cause:'customer'}])).rows[0].r;
 const confirmation=(await c.query('select record_exchange_return($1,$2,$3,$4,$5) r',[crypto.randomUUID(),db.store,db.device,'exchange_return',{
  exchangeId:operation,refundVia:'courier',returnFee:0}])).rows[0].r;
 const o=confirmation.order;await c.query("update orders set status='shipped' where id=$1",[o.id]);
 await delivery({orderId:o.id,settle:false,wallet:'inStoreSafe',netReceived:0});
 const r=await settle(input([o],5));assert.equal(r.codPiastres,12500);assert.equal(r.feePiastres,12000);assert.equal(r.shortfallPiastres,0);
 // Original COD10 remains open until its OWN settlement. The refund already
 // reduced replacement obligations and may not consume the original twice.
 assert.equal(await total('receivable_courier',source.courierId),1000);
 await settle(input([source],10));assert.equal(await total('receivable_courier',source.courierId),0);
 evidence.push({scenario:'actual partial exchange attribution',placementId:operation,confirmationId:confirmation.eventId,result:r});
});
function load(file,stubs,cache=new Map()){
 const absolute=path.resolve(ROOT,file);if(cache.has(absolute))return cache.get(absolute);const exports={};cache.set(absolute,exports);const require=createRequire(import.meta.url);
 const local=id=>{if(Object.hasOwn(stubs,id))return stubs[id];if(id.startsWith('@/')||id.startsWith('.')){
  const base=id.startsWith('@/')?path.join(ROOT,'src',id.slice(2)):path.resolve(path.dirname(absolute),id);
  return load([base,base+'.ts',base+'.tsx'].find(p=>fs.existsSync(p)&&fs.statSync(p).isFile()),stubs,cache)}return require(id)};
 const js=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInThisContext(`(function(exports,require){${js}\n})`)(exports,local);return exports;
}
test('actual command/client: lost committed response/reload replays same identity; optional read failure never resubmits money',async()=>{
 const o=await seed(),req=input([o],100),calls=[],storage={};let lose=true,failRead=false,state={orders:[await row(o.id)]};
 globalThis.sessionStorage={getItem:k=>storage[k]??null,setItem:(k,v)=>storage[k]=v,removeItem:k=>delete storage[k]};
 const client={async rpc(name,args){assert.equal(name,'record_courier_batch');calls.push(args.p_id);const data=await settle(args.p_input,args.p_id);if(lose){lose=false;throw Error('SYNTHETIC_RESPONSE_LOSS')}return {data,error:null}},
  from(table){assert.equal(table,'orders');const q={select(){return q},eq(k,v){assert.equal(k,'store_id');assert.equal(v,db.store);return q},async in(k,ids){assert.equal(k,'id');if(failRead)throw Error('SYNTHETIC_READ_FAIL');return {data:await Promise.all(ids.map(row)),error:null}}};return q}};
 const stubs={'@/store/useAuthStore':{useAuthStore:{getState:()=>({userRole:'ADMIN'})}},'@/store/useCustomerStore':{useCustomerStore:{setState:()=>{}}},'@/lib/supabase':{getSupabaseClient:()=>client},'@/services/api/storeContext':{getSyncIdentity:async()=>({storeId:db.store,deviceId:db.device})},
  '@/services/api/fieldMapping':{fromRemoteRow:(_t,r)=>r},'@/store/useOrderStore':{useOrderStore:{setState:fn=>state={...state,...fn(state)}}}};
 const source=load('src/lib/courierSettlement.ts',stubs),result=await source.commitCourierBatch(req);
 assert.equal(result.replayed,true);assert.equal(new Set(calls).size,1);assert.ok(state.orders[0].codSettledAt);
 const saved=(await db.admin.query('select command_request from ledger_events where id=$1',[result.eventId])).rows[0].command_request;
 const key='nexus-financial-pending:'+db.store+':ledger:courier_settlement';storage[key]=JSON.stringify({id:result.eventId,command:'courier_batch',input:saved.input,uncertain:true});
 failRead=true;const replay=await load('src/lib/courierSettlement.ts',stubs).resolvePendingCourierBatch();assert.equal(replay.eventId,result.eventId);assert.equal(new Set(calls).size,1);assert.equal(Object.keys(storage).length,0);
 assert.equal((await db.admin.query('select count(*)::int n from ledger_events where id=$1',[result.eventId])).rows[0].n,1);
 delete globalThis.sessionStorage;evidence.push({scenario:'actual client lost response/reload',result,calls});
});

test('OrdersPage delivery+settlement: one transaction persists status, COGS, exact wallet and settlement stamp',async()=>{
 const o=await seed({goods:12.34,shipping:1.11,deliver:false}),id=crypto.randomUUID(),req={orderId:o.id,settle:true,wallet:'inStoreSafe',netReceived:12.34};
 const before=await total('wallet','inStoreSafe');const r=await delivery(req,id);await delivery(req,id);
 assert.equal(r.settlementEventId,id+':settlement');assert.equal((await row(o.id)).status,'delivered');assert.ok((await row(o.id)).codSettledAt);
 assert.equal(await total('wallet','inStoreSafe')-before,1234);assert.equal(await total('receivable_courier',o.courierId),0);assert.equal(await total('payable_courier',o.courierId),0);
 const events=(await db.admin.query('select kind from ledger_events where id=any($1) order by kind',[[id,id+':settlement']])).rows;
 assert.deepEqual(events.map(x=>x.kind),['courier_settlement','order_delivered']);
 evidence.push({scenario:'OrdersPage combined delivery/settlement',operation:r,order:await row(o.id)});
});
test('combined delivery zero-net offset has no wallet line and does not claim cash moved',async()=>{
 const o=await seed({goods:0,shipping:50,deliver:false}),r=await delivery({orderId:o.id,settle:true,wallet:'inStoreSafe',netReceived:0});
 assert.ok((await row(o.id)).codSettledAt);assert.equal((await db.admin.query("select count(*)::int n from ledger_lines where event_id=$1 and account='wallet'",[r.settlementEventId])).rows[0].n,0);
 assert.equal(await total('receivable_courier',o.courierId),0);assert.equal(await total('payable_courier',o.courierId),0);
});
test('actual courier-caused exchange surcharge clears its booked compensation exactly once',async()=>{
 const source=await seed({goods:10,shipping:0}),id=crypto.randomUUID(),operation=crypto.randomUUID();
 const items=source.items.map(i=>({...i,id:crypto.randomUUID(),unitPrice:15}));
 const replacement={...source,id,orderNumber:'QA-'+id,items,stockItems:[],totalAmount:15,shippingFee:0,courierFee:50,expectedCod:15};
 await c.query('select record_exchange_place($1,$2,$3,$4,$5)',[operation,db.store,db.device,'exchange_place',{
  order:replacement,event:db.event('order_placed','ecommerce_order',replacement.orderNumber,[]),originalOrderId:source.id,
  selections:[{lineId:source.items[0].id,quantity:1}],cause:'courier'}]);
 const confirmed=(await c.query('select record_exchange_return($1,$2,$3,$4,$5) r',[crypto.randomUUID(),db.store,db.device,'exchange_return',{
  exchangeId:operation,refundVia:'courier',returnFee:0}])).rows[0].r;
 const o=confirmed.order;await c.query("update orders set status='shipped' where id=$1",[o.id]);
 await delivery({orderId:o.id,settle:false,wallet:'inStoreSafe',netReceived:0});
 // Replacement R15 + courier compensation50 - refund10 =55, payable50.
 assert.equal(await total('receivable_courier',o.courierId),6500);
 const result=await settle(input([o],5));assert.equal(result.codPiastres,5500);assert.equal(result.feePiastres,5000);assert.equal(result.netPiastres,500);
 assert.equal(await total('receivable_courier',o.courierId),1000);assert.equal(await total('payable_courier',o.courierId),0);
 evidence.push({scenario:'courier compensation50 plus original refund10',exchangeId:operation,settlement:result,originalReceivablePiastres:1000});
});

async function implicitReturnFixture(){
 const o=await seed({deliver:false});await c.query("update orders set status='returned' where id=$1",[o.id]);
 const delivery=db.event('order_delivered','ecommerce_order',o.orderNumber,buildOrderDeliveredLines({items:o.stockItems,goodsTotal:o.totalAmount,shippingFee:o.shippingFee,courierFee:o.courierFee,depositAmount:0,codAmount:o.expectedCod,courierId:o.courierId,channel:'ecommerce'}));
 const returned=db.event('return_confirmed','ecommerce_order',o.orderNumber,buildReturnConfirmedLines({items:o.stockItems,refundAmount:o.totalAmount,revenueAmount:o.totalAmount,wallet:'inStoreSafe',returnFee:0,movement:'return'}));
 return {o,events:[delivery,returned]};
}
test('legacy implicit delivery plus return commits canonical delivery, stamp and exact stock in one transaction',async()=>{
 const {o,events}=await implicitReturnFixture();
 const saved=(await c.query("select confirm_order_return($1,'shop','return',$2,null) r",[o.id,JSON.stringify(events)])).rows[0].r.order;
 assert.equal(saved.revenueLogged,true);assert.ok(saved.returnConfirmedAt);assert.equal(saved.status,'returned');
 assert.equal(Number((await db.admin.query('select quantity from products where id=$1',[o.stockItems[0].productId])).rows[0].quantity),10);
 assert.equal(await total('receivable_courier',o.courierId),12000);assert.equal(await total('payable_courier',o.courierId),2000);
 assert.equal((await db.admin.query("select sum(amount_delta)::int n from ledger_lines where event_id=any($1) and account='cogs'",[events.map(e=>e.id)])).rows[0].n,0);
 await unchanged(()=>c.query("select confirm_order_return($1,'shop','return',$2,null)",[o.id,JSON.stringify(events)]),/NEXUS_RETURN_ALREADY_CONFIRMED/);
 evidence.push({scenario:'atomic implicit delivery before return',orderId:o.id,events:events.map(e=>e.id),quantity:10,receivablePiastres:12000,payablePiastres:2000});
});
test('implicit delivery altered amount refuses and a late return-stock fault rolls back both events/stamp',async()=>{
 const {o,events}=await implicitReturnFixture(),bad=structuredClone(events);bad[0].lines.find(l=>l.account==='revenue').amount_delta+=1;
 await unchanged(()=>c.query("select confirm_order_return($1,'shop','return',$2,null)",[o.id,JSON.stringify(bad)]),/NEXUS_RETURN_DELIVERY_AMOUNT_REVIEW/);
 await db.admin.query("create function public.qa_return_late() returns trigger language plpgsql as $$ begin raise exception 'SYNTHETIC_RETURN_LATE';end $$;create trigger qa_return_late after update on products for each row execute function public.qa_return_late()");
 try{await unchanged(()=>c.query("select confirm_order_return($1,'shop','return',$2,null)",[o.id,JSON.stringify(events)]),/SYNTHETIC_RETURN_LATE/)}finally{await db.admin.query('drop trigger qa_return_late on products;drop function public.qa_return_late()')}
 assert.equal((await row(o.id)).returnConfirmedAt,null);assert.equal((await row(o.id)).revenueLogged,false);
});

test('old courier append/stamp and old delivery writers fail before new financial effects',async()=>{
 const o=await seed();
 await unchanged(()=>c.query('select ledger_append($1)',[db.event('courier_settlement','ecommerce_order',o.orderNumber,[{account:'wallet',subjectId:'inStoreSafe',amount:100},{account:'receivable_courier',subjectId:o.courierId,amount:-120},{account:'payable_courier',subjectId:o.courierId,amount:-20}])]),/NEXUS_COURIER_ATOMIC_REQUIRED/);
 await unchanged(()=>c.query('update orders set "codSettledAt"=now() where id=$1',[o.id]),/NEXUS_COURIER_ATOMIC_REQUIRED/);
 await unchanged(()=>c.query('select ledger_append($1)',[db.event('order_delivered','ecommerce_order',o.orderNumber,buildOrderDeliveredLines({items:o.stockItems,goodsTotal:100,shippingFee:20,codAmount:120,courierId:o.courierId}))]),/NEXUS_COURIER_ATOMIC_REQUIRED/);
});
test('late settlement stamp failure rolls back combined delivery and keeps the reservation/status intact',async()=>{
 const o=await seed({deliver:false});await db.admin.query("create function public.qa_delivery_late() returns trigger language plpgsql as $$ begin if NEW.\"codSettledAt\" is not null then raise exception 'SYNTHETIC_DELIVERY_LATE';end if;return NEW;end $$;create trigger qa_delivery_late after update on orders for each row execute function public.qa_delivery_late()");
 try{await unchanged(()=>delivery({orderId:o.id,settle:true,wallet:'inStoreSafe',netReceived:100}),/SYNTHETIC_DELIVERY_LATE/)}finally{await db.admin.query('drop trigger qa_delivery_late on orders;drop function public.qa_delivery_late()')}
 assert.equal((await row(o.id)).status,'shipped');assert.equal(await total('receivable_courier',o.courierId),0);
});
test('competing combined deliveries commit once; different payload/replay and forbidden roles are safe',async()=>{
 const o=await seed({deliver:false}),req={orderId:o.id,settle:true,wallet:'inStoreSafe',netReceived:100},a=crypto.randomUUID(),b=crypto.randomUUID(),other=await db.client('ADMIN');
 const results=await Promise.allSettled([delivery(req,a),delivery(req,b,other)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 const won=results[0].status==='fulfilled'?a:b;await unchanged(()=>delivery({...req,netReceived:99},won),/NEXUS_OPERATION_PAYLOAD_MISMATCH/);
 const fresh=await seed({deliver:false}),accountant=await db.client('ACCOUNTANT');await unchanged(()=>delivery({...req,orderId:fresh.id},crypto.randomUUID(),accountant),/NEXUS_DELIVERY_FORBIDDEN/);
});
test('actual delivery client recovers lost response before checking a now-delivered document',async()=>{
 const o=await seed({deliver:false}),calls=[],storage={};let lose=true,state={orders:[await row(o.id)]};
 globalThis.sessionStorage={getItem:k=>storage[k]??null,setItem:(k,v)=>storage[k]=v,removeItem:k=>delete storage[k]};
 const client={async rpc(name,args){assert.equal(name,'record_order_delivery');calls.push(args.p_id);const data=await delivery(args.p_input,args.p_id);if(lose){lose=false;throw Error('SYNTHETIC_RESPONSE_LOSS')}return {data,error:null}},from(){const q={select(){return q},eq(){return q},async in(k,ids){return {data:await Promise.all(ids.map(row)),error:null}}};return q}};
 const stubs={'@/store/useAuthStore':{useAuthStore:{getState:()=>({userRole:'ADMIN'})}},'@/store/useCustomerStore':{useCustomerStore:{setState:()=>{}}},'@/lib/supabase':{getSupabaseClient:()=>client},'@/services/api/storeContext':{getSyncIdentity:async()=>({storeId:db.store,deviceId:db.device})},'@/services/api/fieldMapping':{fromRemoteRow:(_t,r)=>r},'@/store/useOrderStore':{useOrderStore:{setState:fn=>state={...state,...fn(state)}}}};
 const r=await load('src/lib/courierSettlement.ts',stubs).commitOrderDelivery({orderId:o.id,settle:true,wallet:'inStoreSafe',netReceived:100});
 assert.equal(r.replayed,true);assert.equal(new Set(calls).size,1);assert.equal(state.orders[0].status,'delivered');assert.ok(state.orders[0].codSettledAt);
 const saved=(await db.admin.query('select command_request from ledger_events where id=$1',[r.eventId])).rows[0].command_request;
 storage['nexus-financial-pending:'+db.store+':order_delivery']=JSON.stringify({id:r.eventId,command:'order_delivery',input:saved.input,uncertain:true});
 assert.equal((await load('src/lib/courierSettlement.ts',stubs).resolvePendingOrderDelivery()).eventId,r.eventId);assert.equal(new Set(calls).size,1);delete globalThis.sessionStorage;
});
