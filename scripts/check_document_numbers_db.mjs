// Captured schema + complete local batch. Synthetic loopback PostgreSQL only.
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openBusinessDb,read,ROOT} from './helpers/business-db.mjs';
import {buildSaleLines} from '../src/lib/ledger/sales.ts';
import {buildOrderPlacedLines} from '../src/lib/ledger/orders.ts';
import {uiHarness as realUiHarness} from './helpers/ui-harness.mjs';
// Keep this historical receipt reader's UI identity explicit. Its backend
// client still changes role/tenant to prove a stale UI cannot bypass RLS.
const uiHarness=stubs=>realUiHarness({'@/store/useAuthStore':{useAuthStore:Object.assign(s=>s({userRole:'ADMIN'}),{getState:()=>({userRole:'ADMIN'})})},...stubs});
import {pgReadSdk} from './helpers/pg-read-sdk.mjs';
const migrations=['20261012080415_receipt_variant_stock','20261012082556_pos_atomic_exchange','20261012090535_courier_atomic_batch','20261012191715_authoritative_stock_commands','20261012194223_courier_writer_compatibility','20261012203014_catalog_return_compatibility','20261012204812_courier_obligation_compatibility','20261012213602_order_payment_atomic','20261013010850_exchange_credit_lifecycle','20261013015521_customer_trip_atomic_recovery','20261013022600_courier_claim_source_attribution','20261013031632_order_backorder_allocation','20261013111632_scoped_order_activity','20261013120155_store_branded_document_numbers'];
let db,c;const evidence=[];
before(async()=>{db=await openBusinessDb();c=await db.client();for(const m of migrations)await db.admin.query(read('supabase/migrations/'+m+'.sql'));await db.admin.query('update stores set name=$1 where id=$2',['Best Solution',db.store]);});
after(async()=>{if(db){fs.writeFileSync(path.join(ROOT,'logs/final-v1-sprint/document-numbers-'+Date.now()+'.json'),JSON.stringify({version:db.version,scope:'isolated only; NOT Production',migrations,evidence},null,2));await db.close();}});
async function product(quantity=20,cost=2){const id=crypto.randomUUID();await c.query("select record_product_catalog($1,$2,$3,'product_catalog',$4)",[crypto.randomUUID(),db.store,db.device,{action:'create',unitCost:cost,product:{id,name:'Synthetic numbering',sku:id,quantity,unitPrice:10}}]);return id;}
function sale(product,quantity=1,extra={},price=10){const items=[{productId:product,productName:'Synthetic numbering',quantity,unitPrice:price,unitCost:2}];return {kind:'sale',refType:'pos_sale',actor:'Synthetic',payload:{channel:'pos',walletId:'inStoreSafe',items,...extra},lines:buildSaleLines({items,wallet:'inStoreSafe',discountAmount:extra.discountAmount??0})};}
const pos=async(input,id=crypto.randomUUID(),client=c)=>(await client.query("select record_pos_sale($1,$2,$3,'pos_sale',$4) r",[id,db.store,db.device,input])).rows[0].r;
const number=async(id=crypto.randomUUID(),client=c,store=db.store)=>(await client.query("select record_document_number($1,$2,$3,'document_number','{\"kind\":\"order\"}') r",[id,store,db.device])).rows[0].r;
const event=async(id)=>{const row=(await db.admin.query('select * from ledger_events where id=$1',[id])).rows[0];return {...row,payload:typeof row.payload==='string'?JSON.parse(row.payload):row.payload};};
const state=async()=>JSON.stringify((await db.admin.query("select jsonb_build_object('numbers',(select jsonb_agg(to_jsonb(t) order by request_id) from financial_private.document_numbers t),'counters',(select jsonb_agg(to_jsonb(t) order by store_id,name) from store_counters t),'events',(select jsonb_agg(to_jsonb(t) order by id) from ledger_events t),'lines',(select jsonb_agg(to_jsonb(t) order by id) from ledger_lines t),'products',(select jsonb_agg(to_jsonb(t) order by id) from products t)) r")).rows[0].r);
test('C first POS P001/P002 and order O001 are independent; UUID, command and amounts remain authoritative',async()=>{
 const p=await product(),input=sale(p,1,{documentNumber:'FORGED-P999'}),a=await pos(input),b=await pos(sale(p)),o=await number();
 assert.equal(a.documentNumber,'BS-P001');assert.equal(b.documentNumber,'BS-P002');assert.equal(o.documentNumber,'BS-O001');
 const saved=await event(a.eventId);assert.equal(saved.payload.documentNumber,a.documentNumber);assert.deepEqual(saved.command_request.input,input);assert.equal(saved.ref_id,null);
 const lines=(await db.admin.query('select account,sum(amount_delta)::int amount from ledger_lines where event_id=$1 group by account',[a.eventId])).rows;
 assert.equal(lines.find(x=>x.account==='wallet').amount,1000);assert.equal(lines.find(x=>x.account==='cogs').amount,200);evidence.push({case:'first numbers, unchanged identity and money',a,b,o,lines});
});
test('C same request replay/concurrency consumes one number; independent simultaneous sales get distinct numbers',async()=>{
 const p=await product(),input=sale(p),id=crypto.randomUUID(),other=await db.client();const [a,b]=await Promise.all([pos(input,id),pos(input,id,other)]);assert.equal(a.documentNumber,b.documentNumber);assert.equal(a.eventId,b.eventId);assert.equal([a,b].filter(x=>x.replayed).length,1);
 const [x,y]=await Promise.all([pos(input),pos(input,crypto.randomUUID(),other)]);assert.notEqual(x.documentNumber,y.documentNumber);
 const rid=crypto.randomUUID(),[n1,n2]=await Promise.all([number(rid),number(rid,other)]);assert.deepEqual(n1,n2);
 assert.equal((await db.admin.query('select count(*)::int n from financial_private.document_numbers where request_id=$1',[rid])).rows[0].n,1);
});
test('C store rename does not alter issued/replayed numbers; Arabic and deterministic fallback are readable',async()=>{
 const id=crypto.randomUUID(),a=await number(id);await db.admin.query('update stores set name=$1 where id=$2',['بيست سوليوشن',db.store]);assert.deepEqual(await number(id),a);
 assert.equal((await db.admin.query("select financial_private.store_abbreviation('بيست سوليوشن') v")).rows[0].v,'BS');
 await db.admin.query('update stores set name=$1 where id=$2',['New Shop',db.store]);assert.match((await number()).documentNumber,/^NS-O\d+$/);assert.deepEqual(await number(id),a);
 assert.equal((await db.admin.query("select financial_private.store_abbreviation('123 🛍️') v")).rows[0].v,'NC');await db.admin.query('update stores set name=$1 where id=$2',['Best Solution',db.store]);
});
test('C full transaction failure rolls back number, event and stock; retry uses one canonical number',async()=>{
 const p=await product(),id=crypto.randomUUID(),input=sale(p),before=await state();
 await db.admin.query("create function public.qa_number_fail() returns trigger language plpgsql as $$ begin if NEW.id='"+id+"' then raise exception 'QA_NUMBER_LATE_FAILURE';end if;return NEW;end $$;create constraint trigger qa_number_fail after insert on ledger_events deferrable initially deferred for each row execute function qa_number_fail()");
 try{await assert.rejects(()=>pos(input,id),/QA_NUMBER_LATE_FAILURE/);assert.equal(await state(),before);}finally{await db.admin.query('drop trigger qa_number_fail on ledger_events;drop function public.qa_number_fail()');}
 const a=await pos(input,id);assert.deepEqual(await pos(input,id),{...a,replayed:true});
});
test('C ordinary refund and atomic exchange preserve source number and issue only replacement number',async()=>{
 const p=await product(),a=await pos(sale(p));const refund=await pos(sale(p,-1,{returnOfEventId:a.eventId}));assert.equal(refund.sourceDocumentNumber,a.documentNumber);assert.equal(refund.documentNumber,undefined);assert.equal((await event(a.eventId)).payload.documentNumber,a.documentNumber);
 const b=await pos(sale(p)),xid=crypto.randomUUID(),input={return:sale(p,-1,{returnOfEventId:b.eventId}),replacement:sale(p)};
 const x=(await c.query("select record_pos_exchange($1,$2,$3,'pos_exchange',$4) r",[xid,db.store,db.device,input])).rows[0].r;
 assert.equal(x.sourceDocumentNumber,b.documentNumber);assert.match(x.replacementDocumentNumber,/^BS-P\d+$/);assert.notEqual(x.replacementDocumentNumber,b.documentNumber);assert.equal((await event(x.replacementEventId)).payload.documentNumber,x.replacementDocumentNumber);
 assert.equal(x.netPiastres,0);const doc=(await db.admin.query('select original_order_id from return_records where id=$1',[x.returnRecordId])).rows[0];assert.equal(doc.original_order_id,b.eventId);evidence.push({case:'refund/exchange numbers',refund,x});
});
test('C two stores are isolated even with same brand; foreign tenant and ineligible roles are refused',async()=>{
 const store=crypto.randomUUID(),user=crypto.randomUUID();await db.admin.query('insert into stores(id,name) values($1,$2)',[store,'Best Solution']);await db.admin.query("insert into store_licenses(store_id,license_key,valid_until) values($1,$2,now()+interval '1 year')",[store,store]);await db.admin.query('insert into auth.users values($1,$2,now())',[user,user+'@qa.invalid']);await db.insert('store_members',{store_id:store,user_id:user,role:'ADMIN'});const other=await db.client();await other.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);assert.equal((await number(crypto.randomUUID(),other,store)).documentNumber,'BS-O001');
 await assert.rejects(()=>number(crypto.randomUUID(),c,store),/FORBIDDEN/);const ec=await db.client('ECOMMERCE_ONLY');await assert.rejects(()=>ec.query("select financial_private.allocate_document_number($1,'pos',$2)",[db.store,crypto.randomUUID()]),/FORBIDDEN/);assert.match((await number(crypto.randomUUID(),ec)).documentNumber,/^BS-O/);
 await assert.rejects(()=>c.query('select * from financial_private.document_numbers'),/permission denied/);await assert.rejects(()=>c.query("select next_document_number($1,'branded_order','ECO-')",[db.store]),/RESERVED_COUNTER/);
});
test('C padding never truncates at1000/10000, legacy callers and issued historical references stay unchanged',async()=>{
 await db.admin.query("update store_counters set value=999 where store_id=$1 and name='branded_order'",[db.store]);assert.equal((await number()).documentNumber,'BS-O1000');
 await db.admin.query("insert into store_counters values($1,'ecommerce_order',9999)",[db.store]);assert.equal((await c.query("select next_document_number($1,'ecommerce_order','ECO-') n",[db.store])).rows[0].n,'ECO-10000');
 const before=await state();await assert.rejects(()=>db.admin.query("update financial_private.document_numbers set number='REWRITE' where store_id=$1",[db.store]),/IMMUTABLE/);assert.equal(await state(),before);
});

test('C real numbered ecommerce placement/cancellation preserves the exact document and ledger reference; number edits/deletion refuse',async()=>{
 const p=await product(),n=await number(),id=crypto.randomUUID(),item={id:crypto.randomUUID(),productId:p,productName:'Synthetic',quantity:1,unitPrice:10,unitCost:2};
 const o={id,store_id:db.store,device_id:db.device,orderNumber:n.documentNumber,customerName:'Synthetic',customerPhone:'qa.invalid',items:[item],stockItems:[item],totalAmount:10,discountAmount:0,shippingFee:0,courierFee:0,depositAmount:0,expectedCod:10,paymentMethod:'partial_cod',fulfillment:{version:1,allowBackorder:true}};
 const e=db.event('order_placed','ecommerce_order',n.documentNumber,buildOrderPlacedLines({items:[item],depositAmount:0,wallet:'inStoreSafe'}));
 const placed=(await c.query('select place_order($1,$2) r',[o,e])).rows[0].r;assert.equal(placed.order.orderNumber,n.documentNumber);assert.equal((await event(e.id)).ref_id,n.documentNumber);
 for(const sql of ['update orders set "orderNumber"=\'FORGED\' where id=$1','delete from orders where id=$1'])await assert.rejects(()=>c.query(sql,[id]),/NEXUS_DOCUMENT_NUMBER_IMMUTABLE|NEXUS_FULFILLMENT/);
 await c.query("select record_order_cancel($1,$2,$3,'order_cancel',$4)",[crypto.randomUUID(),db.store,db.device,{orderId:id,cause:'shop'}]);
 const saved=(await db.admin.query('select "orderNumber",status from orders where id=$1',[id])).rows[0];assert.equal(saved.orderNumber,n.documentNumber);assert.equal(saved.status,'cancelled');
 assert.notEqual((await number()).documentNumber,n.documentNumber);evidence.push({case:'numbered order placement/cancel',order:id,number:n.documentNumber,event:e.id});
});
test('C actual client numbering recovers two lost replies after module reload without a second counter allocation',async()=>{
 const values=new Map(),requests=[];let losses=2;globalThis.sessionStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const stubs={'@/lib/supabase':{getSupabaseClient:()=>({async rpc(name,args){assert.equal(name,'record_document_number');requests.push(args.p_id);const r=await number(args.p_id);if(losses-->0)throw Error('SYNTHETIC_RESPONSE_LOSS');return {data:r,error:null};}})},'@/services/api/storeContext':{getSyncIdentity:async()=>({storeId:db.store,deviceId:db.device})}};
 let h=uiHarness(stubs);try{await assert.rejects(()=>h.load('src/services/documentNumber.ts').nextOrderDocumentNumber(),/لم يصل تأكيد/);assert.equal(values.size,1);}finally{await h.cleanup();}
 h=uiHarness(stubs);try{const n=await h.load('src/services/documentNumber.ts').nextOrderDocumentNumber();assert.match(n,/^BS-O/);assert.equal(new Set(requests).size,1);assert.equal(values.size,0);assert.equal((await db.admin.query('select count(*)::int n from financial_private.document_numbers where request_id=$1',[requests[0]])).rows[0].n,1);}finally{await h.cleanup();delete globalThis.sessionStorage;}
});
test('C saved-number search finds receipts beyond200 and includes all original returns without exposing another store',async()=>{
 const p=await product(230),old=await pos(sale(p)),ret=await pos(sale(p,-1,{returnOfEventId:old.eventId}));
 for(let i=0;i<201;i++)await pos(sale(p));
 const rows=(await c.query('select id from search_pos_receipts($1,$2)',[db.store,old.documentNumber.toLowerCase()])).rows;assert.deepEqual(rows.map(x=>x.id).sort(),[old.eventId,ret.eventId].sort());
 const legacy=(await c.query('select id from search_pos_receipts($1,$2)',[db.store,old.eventId])).rows;assert.deepEqual(legacy.map(x=>x.id).sort(),rows.map(x=>x.id).sort());
 await assert.rejects(()=>c.query('select * from search_pos_receipts($1,$2)',[crypto.randomUUID(),old.documentNumber]),/FORBIDDEN/);
});

for(const price of [320,270,200])test(`D2 saved exchange reader groups original discounted270 and replacement${price} with exact signed wallet/COGS/history and no writes`,async()=>{
 const p=await product(),q=await product(20,3),original=await pos(sale(p,1,{discountAmount:30,customerName:'Saved original'},300)),id=crypto.randomUUID();
 const exchanged=(await c.query("select record_pos_exchange($1,$2,$3,'pos_exchange',$4) r",[id,db.store,db.device,{return:sale(p,-1,{returnOfEventId:original.eventId},270),replacement:sale(q,1,{},price)}])).rows[0].r;
 const calls=[],h=uiHarness({'@/lib/supabase':{getSupabaseClient:()=>pgReadSdk(c,calls)},'@/services/api/storeContext':{getActiveStoreId:async()=>db.store}});
 try{const {readPosReceipt}=h.load('src/services/posReceipts.ts'),before=await state(),view=await readPosReceipt(exchanged.replacementEventId);assert.equal(view.kind,'exchange');assert.equal(view.number,exchanged.replacementDocumentNumber);assert.equal(view.sourceNumber,original.documentNumber);assert.equal(view.sourceId,original.eventId);assert.equal(view.customer,'Saved original');assert.equal(view.refundPiastres,27000);assert.equal(view.replacementPiastres,price*100);assert.equal(view.netPiastres,(price-270)*100);assert.equal(view.cogsPiastres,100);assert.equal(view.profitPiastres,(price-270)*100-100);assert.deepEqual(view.items.map(i=>Number(i.quantity)),[-1,1]);assert.deepEqual(view.eventIds,[id,id+':replacement']);assert.deepEqual(await readPosReceipt(id),view);assert.equal(await state(),before);assert.ok(calls.every(x=>x.filters.some(f=>f.includes('store_id'))));evidence.push({case:'saved receipt exact ledger '+price,view});}
 finally{await h.cleanup();}
});
test('D2 ordinary saved refund uses original friendly identity and historical COGS; foreign tenant and MOD cannot read financial receipt',async()=>{
 const p=await product(),a=await pos(sale(p)),r=await pos(sale(p,-1,{returnOfEventId:a.eventId}));let store=db.store;let client=c;
 const h=uiHarness({'@/lib/supabase':{getSupabaseClient:()=>pgReadSdk(client)},'@/services/api/storeContext':{getActiveStoreId:async()=>store}});
 try{const {readPosReceipt}=h.load('src/services/posReceipts.ts');const before=await state(),view=await readPosReceipt(r.eventId);assert.equal(view.number,a.documentNumber);assert.equal(view.netPiastres,-1000);assert.equal(view.cogsPiastres,-200);store=crypto.randomUUID();await assert.rejects(()=>readPosReceipt(r.eventId),/غير متاحة|permission/);store=db.store;const modUser=crypto.randomUUID();await db.admin.query('insert into auth.users values($1,$2,now())',[modUser,modUser+'@qa.invalid']);await db.insert('store_members',{user_id:modUser,store_id:db.store,role:'MODERATOR'});client=await db.client();await client.query("select set_config('request.jwt.claim.sub',$1,false)",[modUser]);await assert.rejects(()=>readPosReceipt(r.eventId),/غير متاحة|permission/);assert.equal(await state(),before);}
 finally{await h.cleanup();}
});
