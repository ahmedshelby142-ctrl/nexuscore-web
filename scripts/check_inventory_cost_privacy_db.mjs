// Exact captured schema + released migrations; loopback disposable PG17.6 only.
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openBusinessDb,read,ROOT} from './helpers/business-db.mjs';
import {buildSaleLines} from '../src/lib/ledger/sales.ts';
import {buildOrderPlacedLines,buildReturnConfirmedLines,buildOrderDeliveredLines,buildOrderRTOLines} from '../src/lib/ledger/orders.ts';
import {uiHarness} from './helpers/ui-harness.mjs';
const migration='20261017093458_inventory_cost_privacy_authoritative_commands.sql';
let db,admin,product,box,baseline,legacyBox,legacyPart,legacySource;const clients={},evidence=[];
const q=async(c,name,args)=>(await c.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args.map(a=>Array.isArray(a)?JSON.stringify(a):a))).rows[0].r;
// PostgREST JSON numbers, not node-pg's standalone NUMERIC string parser.
const viewerOrder=async(c,id)=>(await c.query('select to_jsonb(v) r from orders_operational v where id=$1',[id])).rows[0].r;
const command=(c,name,input,id=crypto.randomUUID())=>q(c,'record_'+name,[id,db.store,db.device,name,input]);
const snapshot=async()=>(await db.admin.query(`select jsonb_build_object('products',(select jsonb_agg(to_jsonb(t) order by id) from products t),
 'events',(select jsonb_agg(to_jsonb(t) order by id) from ledger_events t),'lines',(select jsonb_agg(to_jsonb(t) order by id) from ledger_lines t),
 'orders',(select jsonb_agg(to_jsonb(t) order by id) from orders t),'returns',(select jsonb_agg(to_jsonb(t) order by id) from return_records t)) r`)).rows[0].r;
const unchanged=async(fn,pattern)=>{const old=await snapshot();await assert.rejects(fn,pattern);assert.deepEqual(await snapshot(),old);};
const total=async(account,eventId)=>(await db.admin.query('select coalesce(sum(amount_delta),0)::int n from ledger_lines where store_id=$1 and account=$2 and ($3::text is null or event_id=$3)',[db.store,account,eventId??null])).rows[0].n;
const noCost=value=>{assert.doesNotMatch(JSON.stringify(value),/"(?:unitCost|unit_cost|costPiastres|cogsAmount|profitPiastres|command_request|command_result)"\s*:\s*(?!null)[^,}]+/);};
function sale(qty=1,{id=product,cost=0,extra={}}={}){
 const items=[{productId:id,productName:'Synthetic privacy item',quantity:qty,unitPrice:10,unitCost:cost,
  ...(id===box?{isBundle:true,bundleItems:[{productId:product,quantity:2,unitCost:cost}]}:{})}];
 return {kind:'sale',refType:'pos_sale',payload:{channel:'pos',walletId:'inStoreSafe',items,...extra},lines:buildSaleLines({items,wallet:'inStoreSafe',discountAmount:extra.discountAmount??0})};
}
before(async()=>{
 db=await openBusinessDb();admin=await db.client();clients.ADMIN=admin;
 // A supported pre-stock-authority receipt, created through the OLD command.
 // Only NEW synthetic fixture rows are inserted; no existing history altered.
 legacyPart=crypto.randomUUID();legacyBox=crypto.randomUUID();
 await db.insert('products',{id:legacyPart,store_id:db.store,device_id:db.device,name:'Synthetic legacy part',sku:legacyPart,quantity:10,unitPrice:10,isActive:true,metadata:{variants:[]}});
 await admin.query('select ledger_append($1)',[db.event('stock_adjustment','opening_balance',legacyPart,[{account:'stock',subjectId:legacyPart,qty:10,amount:71.3,unitCost:7.13}])]);
 await db.insert('products',{id:legacyBox,store_id:db.store,device_id:db.device,name:'Synthetic legacy box',sku:legacyBox,quantity:0,unitPrice:10,isActive:true,isBundle:true,bundleItems:[{productId:legacyPart,quantity:2}],metadata:{variants:[]}});
 const oldItem={productId:legacyBox,productName:'Saved legacy box',quantity:1,unitPrice:10,unitCost:0};
 legacySource=await command(admin,'pos_sale',{kind:'sale',refType:'pos_sale',payload:{walletId:'inStoreSafe',items:[oldItem]},lines:buildSaleLines({items:[{...oldItem,isBundle:true,bundleItems:[{productId:legacyPart,quantity:2,unitCost:7.13}]}],wallet:'inStoreSafe'})});
 await db.admin.query('update products set quantity=8 where id=$1',[legacyPart]);
 for(const f of fs.readdirSync(path.join(ROOT,'supabase/migrations')).filter(f=>f>='20261012000000'&&f<migration).sort())await db.admin.query(read('supabase/migrations/'+f));
 product=crypto.randomUUID();await command(admin,'product_catalog',{action:'create',unitCost:7.13,product:{id:product,name:'Synthetic privacy item',sku:product,quantity:60,unitPrice:10,metadata:{variants:[]}}});
 box=crypto.randomUUID();await db.insert('products',{id:box,store_id:db.store,device_id:db.device,name:'Synthetic privacy box',sku:box,quantity:0,unitPrice:10,isActive:true,isBundle:true,bundleItems:[{productId:product,quantity:2}],metadata:{variants:[]}});
 baseline=await snapshot();
 const fingerprint=async()=>(await db.admin.query(`select jsonb_build_object('functions',(select md5(string_agg(pg_get_functiondef(p.oid),'|' order by p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','financial_private')),
  'policies',(select jsonb_agg(to_jsonb(t) order by tablename,policyname) from pg_policies t where schemaname='public'),'tables',(select jsonb_agg(table_name order by table_name) from information_schema.tables where table_schema='financial_private')) r`)).rows[0].r;
 const old=await fingerprint();await db.admin.query('BEGIN');try{await db.admin.query(read('supabase/migrations/'+migration));}finally{await db.admin.query('ROLLBACK');}
 assert.deepEqual(await fingerprint(),old);assert.deepEqual(await snapshot(),baseline);
 await db.admin.query('BEGIN');try{await db.admin.query(read('supabase/migrations/'+migration));await db.admin.query('COMMIT');}catch(e){await db.admin.query('ROLLBACK');throw e;}
 for(const role of ['ACCOUNTANT','ECOMMERCE_ONLY','POS_ECOMMERCE'])clients[role]=await db.client(role);
 for(const role of ['CASHIER_ONLY','MODERATOR']){db.users[role]=crypto.randomUUID();await db.admin.query('insert into auth.users values($1,$2,now())',[db.users[role],role+'@qa.invalid']);await db.insert('store_members',{user_id:db.users[role],store_id:db.store,role});clients[role]=await db.client(role);}
 const functions=(await db.admin.query("select n.nspname schema,p.proname name,pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','financial_private') order by 1,2")).rows;
 fs.writeFileSync(path.join(ROOT,'logs/final-v1-sprint/inventory-privacy-functions.json'),JSON.stringify(functions,null,2));
 evidence.push({postgres:db.version,migration,atomicSchemaRollback:true});
});
after(async()=>{if(db){fs.writeFileSync(path.join(ROOT,'logs/final-v1-sprint/inventory-privacy-'+Date.now()+'.json'),JSON.stringify({scope:'isolated local only; NOT Production verification',evidence},null,2));await db.close();}});
test('privacy migration preserves every historical document, line, stock row and event',async()=>{assert.deepEqual(await snapshot(),baseline);assert.match(db.version,/PostgreSQL 17\.6/);});
for(const role of ['CASHIER_ONLY','POS_ECOMMERCE','ECOMMERCE_ONLY'])test(role+' reads exact quantities/price but no stock valuation or company balances',async()=>{
 const c=clients[role],r=(await c.query("select * from ledger_balances($1,'stock')",[db.store])).rows.find(x=>x.subject_id===product);
 assert.equal(Number(r.qty),60);assert.equal(r.amount,null);
 const p=(await c.query('select * from products where id=$1',[product])).rows[0];assert.equal(p.name,'Synthetic privacy item');assert.equal(Number(p.unitPrice),10);
 await assert.rejects(()=>c.query("select * from ledger_balances($1,'wallet')",[db.store]),/FORBIDDEN/);
 assert.equal((await c.query('select * from ledger_lines')).rows.length,0);
});
test('ADMIN and ACCOUNTANT retain exact stock valuation and full finance',async()=>{
 for(const role of ['ADMIN','ACCOUNTANT']){const r=(await clients[role].query("select * from ledger_balances($1,'stock')",[db.store])).rows.find(x=>x.subject_id===product);assert.equal(Number(r.amount),42780);}
});
test('Cashier zero-cost sale snapshots server WAC, replays once and rejects changed request without effects',async()=>{
 const c=clients.CASHIER_ONLY,input=sale(),id=crypto.randomUUID(),r=await command(c,'pos_sale',input,id);
 assert.equal(await total('stock',id),-713);assert.equal(await total('cogs',id),713);assert.equal(await total('wallet',id),1000);
 assert.equal((await command(c,'pos_sale',input,id)).replayed,true);
 await unchanged(()=>command(c,'pos_sale',sale(2),id),/PAYLOAD_MISMATCH/);
 const h=(await c.query('select * from read_pos_headers($1,$2)',[db.store,[id]])).rows[0];noCost(JSON.parse(h.payload));assert.equal(h.command_request,null);
 const lines=(await c.query('select * from read_pos_lines($1,$2)',[db.store,[id]])).rows;assert.ok(!lines.some(l=>l.account==='cogs'));assert.equal(lines.find(l=>l.account==='stock').amount_delta,null);assert.equal(lines.find(l=>l.account==='wallet').amount_delta,1000);
 evidence.push({kind:'pos_sale',eventId:id,stockPiastres:-713,cogsPiastres:713,paymentPiastres:1000});
});
test('restricted historical refund and box exchange do not require client costs or expose COGS',async()=>{
 const c=clients.CASHIER_ONLY,source=await command(c,'pos_sale',sale(2,{id:box}));
 const refund=sale(-1,{id:box,extra:{returnOfEventId:source.eventId}}),id=crypto.randomUUID();
 await command(c,'pos_sale',refund,id);assert.equal(await total('stock',id),1426);assert.equal(await total('cogs',id),-1426);assert.equal(await total('wallet',id),-1000);
 assert.equal((await command(c,'pos_sale',refund,id)).replayed,true);
 const ex=await command(c,'pos_exchange',{return:sale(-1,{id:box,extra:{returnOfEventId:source.eventId}}),replacement:sale()});
 assert.equal(ex.netPiastres,0);assert.equal(await total('stock',ex.eventId),1426);assert.equal(await total('cogs',ex.replacementEventId),713);
 await unchanged(()=>command(c,'pos_sale',refund),/RETURN_LIMIT/);
});
test('restricted single-box legacy refund recovers original immutable recipe, not the current catalog',async()=>{
 await db.admin.query('update products set "bundleItems"=$1 where id=$2',[JSON.stringify([{productId:legacyPart,quantity:3}]),legacyBox]);
 const id=crypto.randomUUID();await command(clients.CASHIER_ONLY,'pos_sale',sale(-1,{id:legacyBox,extra:{returnOfEventId:legacySource.eventId}}),id);
 assert.equal(await total('stock',id),1426);assert.equal(await total('cogs',id),-1426);assert.equal(Number((await db.admin.query('select quantity from products where id=$1',[legacyPart])).rows[0].quantity),10);
 assert.deepEqual((await db.admin.query('select to_jsonb(e) r from ledger_events e where id=$1',[legacySource.eventId])).rows[0].r,baseline.events.find(e=>e.id===legacySource.eventId));
});
test('late return-document failure rolls back stock, money, receipt and replay together',async()=>{
 const c=clients.CASHIER_ONLY,source=await command(c,'pos_sale',sale()),input=sale(-1,{extra:{returnOfEventId:source.eventId}});
 await db.admin.query("create function public.synthetic_privacy_failure() returns trigger language plpgsql as $$begin raise exception 'synthetic privacy rollback';end$$; create trigger synthetic_privacy_failure before insert on return_records for each row execute function public.synthetic_privacy_failure()");
 try{await unchanged(()=>command(c,'pos_sale',input),/synthetic privacy rollback/);}finally{await db.admin.query('drop trigger synthetic_privacy_failure on return_records;drop function public.synthetic_privacy_failure()');}
 assert.equal((await db.admin.query('select count(*)::int n from financial_private.inventory_api_depth')).rows[0].n,0);
});
for(const role of ['ECOMMERCE_ONLY','POS_ECOMMERCE'])test(role+' placement/payment/replay returns no costs; authoritative order and ledger retain costs',async()=>{
 const c=clients[role],id=crypto.randomUUID(),items=[{productId:product,quantity:1,unitPrice:10,unitCost:0}],order={id,store_id:db.store,device_id:db.device,orderNumber:'QA-PRIV-'+id,customerName:'Synthetic privacy customer',customerPhone:'qa.invalid',items,stockItems:items,totalAmount:10,shippingFee:2,courierFee:0,depositAmount:2,depositWallet:'inStoreSafe',expectedCod:10,paymentMethod:'partial_cod'};
 const ev=db.event('order_placed','ecommerce_order',order.orderNumber,buildOrderPlacedLines({items,depositAmount:2,wallet:'inStoreSafe'}));
 const result=await q(c,'place_order',[order,ev]);noCost(result);assert.equal(result.order.expectedCod,10);
 assert.equal(await total('stock',ev.id),-713);
 const saved=(await db.admin.query('select * from orders where id=$1',[id])).rows[0];assert.equal(Number(saved.stockItems[0].costPiastres),713);
 noCost(await q(c,'place_order',[order,ev]));
 const payment=await command(c,'order_payment',{orderId:id,amount:1,wallet:'inStoreSafe',expectedDeposit:2,expectedCod:10});noCost(payment);assert.equal(payment.order.expectedCod,9);
 assert.equal((await c.query('select * from orders where id=$1',[id])).rows.length,0);
 noCost((await c.query('select * from orders_operational where id=$1',[id])).rows[0]);
 await assert.rejects(()=>c.query('select financial_private.record_order_payment($1,$2,$3,$4,$5)',[crypto.randomUUID(),db.store,db.device,'order_payment',{}]),/permission/);
});

async function orderFixture({legacy=false,quantity=2,deliver=false,price=10,shipping=0,deposit=0,fee=0}={}){
 const c=clients.ECOMMERCE_ONLY,id=crypto.randomUUID(),courier=crypto.randomUUID();await db.insert('couriers',{id:courier,store_id:db.store,device_id:db.device,name:'Synthetic privacy courier '+courier});
 const items=[{id:'line:1',productId:product,productName:'Saved synthetic item',quantity,unitPrice:price,unitCost:legacy?7.13:0}];
 const input={id,store_id:db.store,device_id:db.device,orderNumber:'QA-PRIV-'+id,customerName:'Synthetic privacy buyer',customerPhone:'qa.invalid',items,stockItems:items,totalAmount:price*quantity,discountAmount:0,shippingFee:shipping,courierFee:fee,courierId:courier,depositAmount:deposit,depositWallet:'inStoreSafe',expectedCod:price*quantity+shipping-deposit,paymentMethod:'partial_cod'};
 await q(legacy?admin:c,'place_order',[input,db.event('order_placed','ecommerce_order',input.orderNumber,buildOrderPlacedLines({items,depositAmount:deposit,wallet:'inStoreSafe'}))]);
 if(deliver){await q(c,'patch_operational_order',[db.store,id,{status:'shipped'}]);await command(c,'order_delivery',{orderId:id,settle:false});}
 return (await db.admin.query('select * from orders where id=$1',[id])).rows[0];
}
test('operational PATCH and public readers retain state/customer fields without accepting financial or cross-tenant patches',async()=>{
 const o=await orderFixture(),c=clients.ECOMMERCE_ONLY;
 const r=await q(c,'patch_operational_order',[db.store,o.id,{status:'shipped',address:'Synthetic address'}]);assert.equal(r.status,'shipped');noCost(r);
 await unchanged(()=>q(c,'patch_operational_order',[db.store,o.id,{expectedCod:0}]),/PATCH_FIELDS/);
 await unchanged(()=>q(c,'patch_operational_order',[crypto.randomUUID(),o.id,{status:'returned'}]),/FORBIDDEN/);
 await unchanged(()=>q(clients.CASHIER_ONLY,'patch_operational_order',[db.store,o.id,{status:'returned'}]),/FORBIDDEN/);
 await unchanged(()=>q(c,'patch_operational_order',[db.store,o.id,{status:'delivered'}]),/COMMAND|DELIVERY|STAMP/);
});
test('COD fee correction and its replay preserve allowed per-order fees without exposing hidden inventory costs',async()=>{
 const c=clients.ECOMMERCE_ONLY,o=await orderFixture(),input={orderId:o.id,before:0,amount:0.23,reason:'Synthetic fee correction'},id=crypto.randomUUID();
 const r=await command(c,'cod_service_fee',input,id);noCost(r);assert.equal(r.order.codServiceFee,0.23);assert.equal(r.accruedDeltaPiastres,0);
 const replay=await command(c,'cod_service_fee',input,id);noCost(replay);assert.equal(replay.replayed,true);
});
for(const legacy of [false,true])test((legacy?'legacy':'forward')+' restricted pending edit preserves hidden authoritative cost, stale protection and exact retry',async()=>{
 const c=clients.ECOMMERCE_ONLY,o=await orderFixture({legacy}),view=await viewerOrder(c,o.id);
 const before=Object.fromEntries(['items','stockItems','totalAmount','discountAmount','depositAmount'].map(k=>[k,view[k]]));
 const input={orderId:o.id,before,patch:{items:view.items.map(i=>({...i,quantity:1})),stockItems:view.stockItems.map(i=>({...i,quantity:1})),totalAmount:10,discountAmount:0}},id=crypto.randomUUID();
 const r=await command(c,'order_edit',input,id);noCost(r);assert.equal(r.order.totalAmount,10);assert.equal(r.order.expectedCod,10);assert.equal(await total('stock',id),713);
 assert.equal((await command(c,'order_edit',input,id)).replayed,true);
 await unchanged(()=>command(c,'order_edit',input),/EDIT_STALE/);
});
for(const legacy of [false,true])test((legacy?'legacy':'forward')+' partial electronic return derives historical cost, required document and replay from hidden-cost source',async()=>{
 const c=clients.ECOMMERCE_ONLY,o=await orderFixture({legacy,deliver:true}),view=await viewerOrder(c,o.id);
 const units=[{...view.items[0],quantity:1,unitCost:0}],physical=[{...view.stockItems[0],quantity:1,unitCost:0}];
 const input={kind:'return_confirmed',refType:'ecommerce_order',refId:o.orderNumber,payload:{stockItems:physical,returnUnits:units,return_cause:'customer'},
  lines:buildReturnConfirmedLines({items:physical,refundAmount:10,revenueAmount:10,wallet:'inStoreSafe',returnFee:0,movement:'return'})};
 const id=crypto.randomUUID();await q(c,'record_stock_command',[id,db.store,db.device,'stock_event',input]);
 assert.equal(await total('stock',id),713);assert.equal(await total('cogs',id),-713);assert.equal(await total('wallet',id),-1000);
 const doc=(await db.admin.query('select * from return_records where id=$1',['return:'+id])).rows[0];assert.equal(doc.original_order_id,o.id);assert.equal(Number(doc.returned_items[0].quantity),1);
 assert.equal((await q(c,'record_stock_command',[id,db.store,db.device,'stock_event',input])).replayed,true);
 noCost((await c.query('select * from return_records_operational where id=$1',[doc.id])).rows[0]);assert.equal((await c.query('select * from return_records where id=$1',[doc.id])).rows.length,0);
});

for(const rto of [false,true])test((rto?'RTO':'full return with implicit delivery')+' zero-cost client request restores exact original inventory and accounting atomically',async()=>{
 const c=clients.ECOMMERCE_ONLY,o=await orderFixture(),view=await viewerOrder(c,o.id),items=view.stockItems.map(i=>({...i,unitCost:0}));
 await q(c,'patch_operational_order',[db.store,o.id,{status:'shipped'}]);await q(c,'patch_operational_order',[db.store,o.id,{status:'returned'}]);
 const ret=db.event(rto?'rto_confirmed':'return_confirmed','ecommerce_order',o.orderNumber,rto?buildOrderRTOLines({items,courierId:o.courierId,returnFee:0})
  :buildReturnConfirmedLines({items,refundAmount:20,revenueAmount:20,wallet:'inStoreSafe',returnFee:0,movement:'return'}));
 const delivery=db.event('order_delivered','ecommerce_order',o.orderNumber,buildOrderDeliveredLines({items,goodsTotal:20,shippingFee:0,courierFee:0,depositAmount:0,codAmount:20,courierId:o.courierId,channel:'ecommerce'}));
 const events=rto?[ret]:[delivery,ret],r=await q(c,'confirm_order_return',[o.id,'customer','return',events,null]);noCost(r);assert.ok(r.order.returnConfirmedAt);
 assert.equal(await total('stock',ret.id),1426);assert.equal(await total('cogs',ret.id),rto?0:-1426);
 if(!rto)assert.equal(await total('cogs',delivery.id),1426);
 await unchanged(()=>q(c,'confirm_order_return',[o.id,'customer','return',events,null]),/ALREADY_CONFIRMED/);
});
test('real restricted receipt reader reconciles payments and explicitly withholds COGS/profit',async()=>{
 const c=clients.CASHIER_ONLY,r=await command(c,'pos_sale',sale()),sb={from(){throw Error('Raw finance read forbidden');},async rpc(name,args){try{const rows=(await c.query(`select * from public.${name}(${Object.keys(args).map((k,i)=>k+'=>$'+(i+1)).join(',')})`,Object.values(args))).rows;return {data:rows,error:null};}catch(error){return {data:null,error:{message:error.message}};}}};
 const h=uiHarness({'@/lib/supabase':{getSupabaseClient:()=>sb},'@/store/useAuthStore':{useAuthStore:{getState:()=>({userRole:'CASHIER_ONLY'})}},'@/services/api/storeContext':{getActiveStoreId:async()=>db.store}});
 try{const receipt=await h.load('src/services/posReceipts.ts').readPosReceipt(r.eventId);assert.equal(receipt.netPiastres,1000);assert.equal(receipt.cogsPiastres,null);assert.equal(receipt.profitPiastres,null);noCost(receipt.items);}finally{await h.cleanup();}
});
test('concurrent cashier commands serialize last unit and same-request retries with exact COGS once',async()=>{
 const p=crypto.randomUUID();await command(admin,'product_catalog',{action:'create',unitCost:7.13,product:{id:p,name:'Synthetic last unit',sku:p,quantity:1,unitPrice:10,metadata:{variants:[]}}});
 const a=await db.client('CASHIER_ONLY'),b=await db.client('CASHIER_ONLY'),input=sale(1,{id:p});
 const results=await Promise.allSettled([command(a,'pos_sale',input),command(b,'pos_sale',input)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.match(results.find(x=>x.status==='rejected').reason.message,/STOCK_SHORT/);
 assert.equal(Number((await db.admin.query('select quantity from products where id=$1',[p])).rows[0].quantity),0);
 const id=crypto.randomUUID(),again=sale();const replay=await Promise.all([command(a,'pos_sale',again,id),command(b,'pos_sale',again,id)]);assert.equal(replay.filter(x=>x.replayed).length,1);assert.equal(await total('cogs',id),713);
});
test('restricted H235 exchange retains original 85 credit, 300 gross, 120 shipping, 100 deposit and COD235 through delivery/settlement',async()=>{
 const c=clients.ECOMMERCE_ONLY,courier=crypto.randomUUID(),source=crypto.randomUUID(),replacementProduct=crypto.randomUUID();
 await db.insert('couriers',{id:courier,store_id:db.store,device_id:db.device,name:'Synthetic private H235'});
 for(const [id,price,cost] of [[source,100,40],[replacementProduct,300,100]])await command(admin,'product_catalog',{action:'create',unitCost:cost,product:{id,name:'Synthetic H235',sku:id,quantity:10,unitPrice:price,metadata:{variants:[]}}});
 const originalId=crypto.randomUUID(),originalItems=[{productId:source,quantity:1,unitPrice:100,unitCost:40}],original={id:originalId,store_id:db.store,device_id:db.device,orderNumber:'PRIV-H-ORIG-'+originalId,customerName:'Synthetic H buyer',customerPhone:'qa.invalid',items:originalItems,stockItems:originalItems,totalAmount:85,discountAmount:15,shippingFee:0,courierFee:0,courierId:courier,depositAmount:85,depositWallet:'inStoreSafe',expectedCod:0,paymentMethod:'full_prepaid'};
 await q(admin,'place_order',[original,db.event('order_placed','ecommerce_order',original.orderNumber,buildOrderPlacedLines({items:originalItems,depositAmount:85,wallet:'inStoreSafe'}))]);
 await q(c,'patch_operational_order',[db.store,originalId,{status:'shipped'}]);await command(c,'order_delivery',{orderId:originalId,settle:false});
 const replacementId=crypto.randomUUID(),exchangeId=crypto.randomUUID(),replacement={id:replacementId,store_id:db.store,device_id:db.device,orderNumber:'PRIV-H-REPL-'+replacementId,customerName:'Synthetic H buyer',customerPhone:'qa.invalid',items:[{productId:replacementProduct,quantity:1,unitPrice:300,unitCost:0}],totalAmount:300,discountAmount:0,shippingFee:120,courierFee:120,codServiceFee:5.7,courierId:courier,depositAmount:100,depositWallet:'inStoreSafe',expectedCod:320,paymentMethod:'partial_cod'};
 const input={originalOrderId:originalId,selections:[{lineId:'line:1',quantity:1}],cause:'customer',order:replacement,event:db.event('order_placed','ecommerce_order',replacement.orderNumber,[])};
 const placed=await command(c,'exchange_place',input,exchangeId);noCost(placed);assert.equal(placed.order.expectedCod,235);assert.equal(placed.order.exchangeDetails.credit.allocatedPiastres,8500);assert.equal(await total('wallet',exchangeId),10000);
 const returned=await command(c,'exchange_return',{exchangeId,refundVia:'courier',wallet:'inStoreSafe',returnFee:0});noCost(returned);assert.equal(await total('revenue',returned.eventId),-8500);assert.equal(await total('cogs',returned.eventId),-4000);assert.equal(await total('receivable_client',returned.eventId),-8500);assert.equal(await total('receivable_courier',returned.eventId),0);
 await q(c,'patch_operational_order',[db.store,replacementId,{status:'shipped'}]);const delivered=await command(c,'order_delivery',{orderId:replacementId,settle:false});assert.equal(await total('receivable_courier',delivered.eventId),23500);assert.equal(await total('cogs',delivered.eventId),10000);assert.equal(await total('receivable_client',delivered.eventId),8500);
 const settled=await command(c,'courier_batch',{courierId:courier,orderIds:[replacementId],wallet:'inStoreSafe',netReceived:109.3});assert.equal(await total('wallet',settled.eventId),10930);assert.equal(await total('payable_courier',settled.eventId),-12570);
 assert.equal(Number((await db.admin.query('select "expectedCod" from orders where id=$1',[replacementId])).rows[0].expectedCod),235);
 evidence.push({kind:'restricted H235',exchangeId,creditPiastres:8500,merchandisePiastres:30000,shippingPiastres:12000,depositPiastres:10000,codPiastres:23500,settlementPiastres:10930});
});
test('several partial POS refunds conserve a fractional historical cost to the final piastre',async()=>{
 const p=crypto.randomUUID(),supplier=crypto.randomUUID(),c=clients.CASHIER_ONLY;
 await command(admin,'product_catalog',{action:'create',unitCost:0.01,product:{id:p,name:'Synthetic fractional cost',sku:p,quantity:1,unitPrice:10,metadata:{variants:[]}}});
 await db.insert('suppliers',{id:supplier,store_id:db.store,device_id:db.device,companyName:'Synthetic fractional supplier',contactPerson:'',phone:''});
 await q(admin,'record_financial_command',[crypto.randomUUID(),db.store,db.device,'receipt',{stockMirrorVersion:1,supplierId:supplier,paidAmount:0,wallet:'inStoreSafe',items:[{productId:p,productName:'Synthetic fractional cost',quantity:1,unitCost:0.02}]}]);
 const source=await command(c,'pos_sale',sale(2,{id:p}));assert.equal(await total('stock',source.eventId),-3);
 const r1=await command(c,'pos_sale',sale(-1,{id:p,extra:{returnOfEventId:source.eventId}})),r2=await command(c,'pos_sale',sale(-1,{id:p,extra:{returnOfEventId:source.eventId}}));
 assert.equal(await total('stock',r1.eventId)+await total('stock',r2.eventId),3);
 assert.equal(await total('cogs',source.eventId)+await total('cogs',r1.eventId)+await total('cogs',r2.eventId),0);
});
test('private API/replay machinery, company finance, anonymous callers and other tenants remain inaccessible',async()=>{
 for(const role of ['CASHIER_ONLY','POS_ECOMMERCE','ECOMMERCE_ONLY','MODERATOR']){
  const c=clients[role];for(const name of ['owner_financial_summary','accounting_position'])await assert.rejects(()=>q(c,name,[db.store]),/FORBIDDEN|permission|ADMIN only|صلاحية|مسموح|مالية|مصرح/);
  assert.equal((await c.query('select * from wallet_transfer_history($1)',[db.store])).rows.length,0);
  assert.equal((await c.query('select * from ledger_lines')).rows.length,0);assert.equal((await c.query('select * from ledger_events')).rows.length,0);
  await assert.rejects(()=>c.query('select * from financial_private.inventory_api_depth'),/permission/);
  await assert.rejects(()=>q(c,'ledger_balances',[crypto.randomUUID(),'stock']),/FORBIDDEN/);
 }
 const metadata=(await db.admin.query("select n.nspname,p.proname,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='public' and p.proname in ('patch_operational_order','record_cod_service_fee','record_order_payment','record_order_edit','place_order')) or (n.nspname='financial_private' and p.proname in ('inventory_return_event','pos_cost_input','validate_pos_bundle','record_cod_service_fee','record_order_payment','record_order_edit','place_order'))")).rows;
 assert.ok(metadata.every(x=>!x.anon&&(x.nspname==='public'?x.authenticated:!x.authenticated)));assert.equal((await db.admin.query('select count(*)::int n from financial_private.inventory_api_depth')).rows[0].n,0);
 const anonymous=await db.client();await anonymous.query("select set_config('request.jwt.claim.sub','',false)");await assert.rejects(()=>q(anonymous,'ledger_balances',[db.store,'stock']),/FORBIDDEN/);
});
