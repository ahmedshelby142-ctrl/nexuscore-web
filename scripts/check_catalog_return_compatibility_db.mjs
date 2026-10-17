// All writes are synthetic, against captured-schema disposable loopback PG17.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openBusinessDb,read,ROOT} from './helpers/business-db.mjs';
import {buildSaleLines} from '../src/lib/ledger/sales.ts';
import {buildOrderPlacedLines,buildReturnConfirmedLines,buildOrderRTOLines} from '../src/lib/ledger/orders.ts';
import {uiHarness} from './helpers/ui-harness.mjs';
import {ordinaryReturnValue,remainingUnits,returnUnitKey} from '../src/lib/exchange.ts';
let db,c;const evidence=[];
const migrations=['20261012080415_receipt_variant_stock','20261012082556_pos_atomic_exchange','20261012090535_courier_atomic_batch','20261012191715_authoritative_stock_commands','20261012194223_courier_writer_compatibility','20261012203014_catalog_return_compatibility','20261012204812_courier_obligation_compatibility','20261012213602_order_payment_atomic','20261013010850_exchange_credit_lifecycle','20261013015521_customer_trip_atomic_recovery','20261013022600_courier_claim_source_attribution','20261013031632_order_backorder_allocation','20261013111632_scoped_order_activity','20261013120155_store_branded_document_numbers'];
before(async()=>{db=await openBusinessDb();c=await db.client('ADMIN');for(const m of migrations)await db.admin.query(read('supabase/migrations/'+m+'.sql'))});
after(async()=>{if(db){fs.writeFileSync(path.join(ROOT,'logs/final-v1-sprint/catalog-return-compatibility-'+Date.now()+'.json'),JSON.stringify({version:db.version,scope:'isolated; NOT Production verified',migrations,evidence},null,2));await db.close()}});
const catalog=async(input,id=crypto.randomUUID(),client=c)=>(await client.query("select record_product_catalog($1,$2,$3,'product_catalog',$4) r",[id,db.store,db.device,input])).rows[0].r;
const draft=(variants=false)=>({action:'create',unitCost:2,product:{id:crypto.randomUUID(),name:'Synthetic catalog',sku:crypto.randomUUID(),quantity:10,unitPrice:5,metadata:{variants:variants?[{name:'RED',stock:6},{name:'BLUE',stock:4}]:[]}}});
const update=(r,patch)=>({action:'update',expectedUpdatedAt:r.product.updated_at,product:{id:r.product.id,...patch}});
const current=async(id)=>(await db.admin.query('select to_jsonb(p) r from products p where id=$1',[id])).rows[0].r;
const balance=async(id)=>(await db.admin.query("select coalesce(sum(qty_delta::numeric),0)::float8 qty,coalesce(sum(amount_delta),0)::int piastres from ledger_lines where store_id=$1 and account='stock' and subject_id=$2",[db.store,id])).rows[0];
async function snapshot(){const result={};for(const table of ['products','orders','ledger_events','ledger_lines','financial_private.catalog_commands','financial_private.catalog_creation_permits','financial_private.stock_applications','financial_private.stock_write_permits','financial_private.courier_commands','financial_private.courier_stamp_permits','return_records','courier_claims','financial_private.courier_claim_phases','financial_private.customer_trip_commands','financial_private.customer_trip_permits','financial_private.customer_trip_order_permits'])result[table]=(await db.admin.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') r from ${table} t`)).rows[0].r;return result}
async function unchanged(action,pattern){const prior=await snapshot();await assert.rejects(action,pattern);assert.deepEqual(await snapshot(),prior)}
test('catalog create+opening is atomic, exact variant persisted, stable retry',async()=>{
 const input=draft(true),id=crypto.randomUUID(),r=await catalog(input,id);assert.equal((await catalog(input,id)).replayed,true);
 assert.equal(Number(r.product.quantity),10);assert.deepEqual(r.product.metadata.variants,input.product.metadata.variants);assert.deepEqual(await balance(input.product.id),{qty:10,piastres:2000});
 evidence.push({case:'atomic opening',operation:id,product:r.product.id,balance:await balance(r.product.id)});
 await unchanged(()=>catalog({...input,unitCost:3},id),/NEXUS_OPERATION_PAYLOAD_MISMATCH/);
});
test('catalog opening late failure rolls back product, private permits, journal and ledger',async()=>{
 await db.admin.query(`create function qa_catalog_late() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_CATALOG_LATE';end$$;create trigger qa_catalog_late after insert on ledger_lines for each row execute function qa_catalog_late()`);
 try{await unchanged(()=>catalog(draft()),/SYNTHETIC_CATALOG_LATE/)}finally{await db.admin.query('drop trigger qa_catalog_late on ledger_lines;drop function qa_catalog_late()')}
});
test('plain counted increase/decrease preserves WAC and balances adjustment expense',async()=>{
 const r=await catalog(draft()),up=await catalog(update(r,{quantity:12}));assert.deepEqual(await balance(r.product.id),{qty:12,piastres:2400});
 const down=await catalog(update(up,{quantity:9}));assert.equal(Number(down.product.quantity),9);assert.deepEqual(await balance(r.product.id),{qty:9,piastres:1800});
 const expense=(await db.admin.query("select sum(amount_delta)::int n from ledger_lines where event_id=$1 and account='expense'",[down.eventId])).rows[0].n;assert.equal(expense,600);
});
test('variant count redistribution with zero aggregate delta, descriptive edits and zero choices',async()=>{
 const r=await catalog(draft(true));const updated=await catalog(update(r,{quantity:10,metadata:{variants:[{name:'RED',stock:5},{name:'BLUE',stock:5},{name:'GREEN',stock:0}]}}));
 assert.deepEqual(updated.product.metadata.variants,[{name:'RED',stock:5},{name:'BLUE',stock:5},{name:'GREEN',stock:0}]);assert.deepEqual(await balance(r.product.id),{qty:10,piastres:2000});
 const description=await catalog(update(updated,{name:'Revised synthetic'}));assert.equal(description.eventId,null);assert.equal(description.product.name,'Revised synthetic');
 await unchanged(()=>catalog(update(description,{quantity:10,metadata:{variants:[{name:'RENAMED',stock:5},{name:'BLUE',stock:5}]}})),/NEXUS_CATALOG_VARIANT_REVIEW/);
 await unchanged(()=>catalog(update(description,{quantity:12})),/NEXUS_CATALOG_EXPLICIT_VARIANT_COUNTS_REQUIRED/);
});

test('half-piastre WAC redistribution preserves total value; final counted depletion leaves neither residual value nor invented expense',async()=>{
 const input=draft(true);input.unitCost=0.005;input.product.quantity=2;input.product.metadata.variants=[{name:'RED',stock:1},{name:'BLUE',stock:1}];
 const r=await catalog(input);assert.deepEqual(await balance(r.product.id),{qty:2,piastres:1});
 const moved=await catalog(update(r,{quantity:2,metadata:{variants:[{name:'RED',stock:0},{name:'BLUE',stock:2}]}}));assert.deepEqual(await balance(r.product.id),{qty:2,piastres:1});
 assert.equal((await db.admin.query("select count(*)::int n from ledger_lines where event_id=$1 and account='expense'",[moved.eventId])).rows[0].n,0);
 const depleted=await catalog(update(moved,{quantity:0,metadata:{variants:[{name:'RED',stock:0},{name:'BLUE',stock:0}]}}));assert.deepEqual(await balance(r.product.id),{qty:0,piastres:0});
 assert.equal((await db.admin.query("select sum(amount_delta)::int n from ledger_lines where event_id=$1 and account='expense'",[depleted.eventId])).rows[0].n,1);
 evidence.push({case:'fractional WAC redistribution',opening:r.eventId,redistribution:moved.eventId,depletion:depleted.eventId,final:await balance(r.product.id)});
});
test('zero opening and later legitimate adjustment, stale edits cannot overwrite newer stock',async()=>{
 const input=draft();input.product.quantity=0;const r=await catalog(input);assert.equal(r.eventId,null);
 const next=await catalog({...update(r,{quantity:2}),unitCost:3});assert.deepEqual(await balance(r.product.id),{qty:2,piastres:600});
 await unchanged(()=>catalog(update(r,{quantity:4})),/NEXUS_CATALOG_STALE/);assert.equal(Number((await current(r.product.id)).quantity),2);
});
test('raw opening inserts and forged private permit are refused; zero catalog remains supported',async()=>{
 const input=draft();await unchanged(()=>c.query('insert into products(id,store_id,device_id,name,sku,quantity) values($1,$2,$3,$4,$5,$6)',[input.product.id,db.store,db.device,input.product.name,input.product.sku,10]),/NEXUS_CATALOG_ATOMIC_REQUIRED/);
 await unchanged(()=>c.query('insert into financial_private.catalog_creation_permits values(1,$1,$2,10,\'[]\')',[db.store,input.product.id]),/permission denied/);
 await c.query('insert into products(id,store_id,device_id,name,sku,quantity) values($1,$2,$3,$4,$5,0)',[input.product.id,db.store,db.device,input.product.name,input.product.sku]);
});
test('catalog roles, tenant spoof and duplicate codes preserve original permission boundary',async()=>{
 const r=await catalog(draft());const accountant=await db.client('ACCOUNTANT');await catalog(update(r,{name:'Accountant edit'}),crypto.randomUUID(),accountant);
 for(const role of ['POS_ECOMMERCE','ECOMMERCE_ONLY'])await unchanged(()=>db.client(role).then(client=>catalog(draft(),crypto.randomUUID(),client)),/NEXUS_CATALOG_FORBIDDEN/);
 await unchanged(()=>c.query("select record_product_catalog($1,$2,$3,'product_catalog',$4)",[crypto.randomUUID(),crypto.randomUUID(),db.device,draft()]),/NEXUS_CATALOG_FORBIDDEN/);
 const duplicate=draft();duplicate.product.sku=r.product.sku;await unchanged(()=>catalog(duplicate),/NEXUS_CATALOG_DUPLICATE_CODE/);
});
test('same operation races once; different operations with stale revision cannot both adjust',async()=>{
 const input=draft(),id=crypto.randomUUID(),a=await db.client(),b=await db.client();const results=await Promise.all([catalog(input,id,a),catalog(input,id,b)]);assert.equal(results.filter(r=>r.replayed).length,1);
 const request=update(results[0],{quantity:11});const race=await Promise.allSettled([catalog(request,crypto.randomUUID(),a),catalog(request,crypto.randomUUID(),b)]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.deepEqual(await balance(input.product.id),{qty:11,piastres:2200});
});
const pos=async(items,extra={},id=crypto.randomUUID())=>(await c.query("select record_pos_sale($1,$2,$3,'pos_sale',$4) r",[id,db.store,db.device,{kind:'sale',refType:'pos_sale',payload:{walletId:'inStoreSafe',items,...extra},lines:buildSaleLines({items,wallet:'inStoreSafe'})}])).rows[0].r;
const returnDoc=async(id)=>(await db.admin.query('select to_jsonb(r) r from return_records r where id=$1',['return:'+id])).rows[0]?.r;
async function order({bundle=false,quantity=2,courier,shipping=0,fee=0,prepaid=true,deliver=true,netTotal=quantity*5}={}){
 if(courier)await db.admin.query('insert into couriers(id,store_id,device_id,name) values($1,$2,$3,$4) on conflict(id) do nothing',[courier,db.store,db.device,'Synthetic '+courier]);
 const r=await catalog(draft(true));const id=crypto.randomUUID(),box=crypto.randomUUID();
 const items=[{productId:bundle?'':r.product.id,bundleId:bundle?box:undefined,variantName:bundle?undefined:'RED',productName:'Synthetic sold unit',quantity,unitPrice:5,unitCost:2}];
 const stockItems=[{productId:r.product.id,variantName:'RED',bundleId:bundle?box:undefined,productName:'Synthetic physical',quantity:quantity*(bundle?2:1),unitPrice:bundle?0:5,unitCost:2}];
 const o={id,store_id:db.store,device_id:db.device,orderNumber:'SYN-'+id,customerName:'Saved synthetic customer',customerPhone:'qa.invalid',items,stockItems,totalAmount:netTotal,discountAmount:quantity*5-netTotal,shippingFee:shipping,courierFee:fee,courierId:courier,depositAmount:prepaid?netTotal+shipping:0,expectedCod:prepaid?0:netTotal+shipping,paymentMethod:prepaid?'full_prepaid':'partial_cod'};
 await c.query('select place_order($1,$2)',[o,db.event('order_placed','ecommerce_order',o.orderNumber,buildOrderPlacedLines({items:stockItems,depositAmount:o.depositAmount,wallet:'inStoreSafe'}))]);
 await c.query("update orders set status='shipped' where id=$1",[id]);
 if(deliver)await c.query("select record_order_delivery($1,$2,$3,'order_delivery',$4)",[crypto.randomUUID(),db.store,db.device,{orderId:id,settle:false}]);
 return {o,r,box};
}
const ecommerceReturn=async(o,units,physical,id=crypto.randomUUID(),extra={})=>(await c.query("select record_stock_command($1,$2,$3,'stock_event',$4) r",[id,db.store,db.device,{kind:'return_confirmed',refType:'ecommerce_order',refId:o.orderNumber,payload:{stockItems:physical,returnUnits:units,return_cause:'customer',...extra},lines:buildReturnConfirmedLines({items:physical,refundAmount:units.reduce((n,x)=>n+x.quantity*x.unitPrice,0),revenueAmount:units.reduce((n,x)=>n+x.quantity*x.unitPrice,0),wallet:'inStoreSafe',returnFee:0,movement:'return'})}])).rows[0].r;
test('ordinary POS refund commits required source-linked document with stock and exact cash; replay once',async()=>{
 const r=await catalog(draft(true));const item={productId:r.product.id,productName:'Saved product',variantName:'RED',quantity:1,unitPrice:5,unitCost:2};
 const sale=await pos([item],{customerName:'Saved buyer',customerPhone:'qa.invalid'}),id=crypto.randomUUID();
 await pos([{...item,quantity:-1}],{returnOfEventId:sale.eventId,customerName:'Changed draft'},id);
 await pos([{...item,quantity:-1}],{returnOfEventId:sale.eventId,customerName:'Changed draft'},id);
 const doc=await returnDoc(id);assert.equal(doc.original_order_id,sale.eventId);assert.equal(doc.customer_name,'Saved buyer');assert.equal(Number(doc.financial_difference),-5);assert.equal(doc.returned_items[0].refund_amount,5);assert.equal(doc.returned_items[0].variantName,'RED');assert.deepEqual(await balance(r.product.id),{qty:10,piastres:2000});
 evidence.push({case:'ordinary POS atomic refund',sale:sale.eventId,refund:id,document:doc.id,balance:await balance(r.product.id)});
});
test('late required document failure rolls back POS refund ledger, physical stock and operation identity',async()=>{
 const r=await catalog(draft());const item={productId:r.product.id,quantity:1,unitPrice:5,unitCost:2},sale=await pos([item]);
 await db.admin.query(`create function qa_return_late() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_RETURN_DOCUMENT_LATE';end$$;create trigger qa_return_late after insert on return_records for each row execute function qa_return_late()`);
 try{await unchanged(()=>pos([{...item,quantity:-1}],{returnOfEventId:sale.eventId}),/SYNTHETIC_RETURN_DOCUMENT_LATE/)}finally{await db.admin.query('drop trigger qa_return_late on return_records;drop function qa_return_late()')}
});
test('individual ecommerce return commits human document, historic selected variant and cause atomically',async()=>{
 const {o,r}=await order(),id=crypto.randomUUID(),units=[{...o.items[0],quantity:1}],parts=[{...o.stockItems[0],quantity:1}];
 await ecommerceReturn(o,units,parts,id);await ecommerceReturn(o,units,parts,id);const doc=await returnDoc(id);
 assert.equal(doc.original_order_id,o.id);assert.equal(Number(doc.financial_difference),-5);assert.equal(doc.returned_items[0].quantity,1);assert.equal(doc.returned_items[0].variantName,'RED');assert.equal(doc.return_cause,'customer');assert.deepEqual(await balance(r.product.id),{qty:9,piastres:1800});
 assert.equal((await db.admin.query('select return_cause from orders where id=$1',[o.id])).rows[0].return_cause,'customer');
 await ecommerceReturn(o,units,parts);await unchanged(()=>ecommerceReturn(o,units,parts),/NEXUS_STOCK_RETURN_ALLOCATION_REQUIRED/);
});
test('partial bundle return stores one human box and exact historical components; forged unit rollback',async()=>{
 const {o,r,box}=await order({bundle:true}),units=[{productId:box,quantity:1,unitPrice:5}],parts=[{...o.stockItems[0],quantity:2}],id=crypto.randomUUID();
 await ecommerceReturn(o,units,parts,id);const doc=await returnDoc(id);assert.equal(doc.returned_items[0].product_id,box);assert.equal(doc.returned_items[0].quantity,1);assert.equal(doc.returned_items[0].refund_amount,5);assert.deepEqual(await balance(r.product.id),{qty:8,piastres:1600});
 await unchanged(()=>ecommerceReturn(o,[{...units[0],productId:crypto.randomUUID()}],parts),/NEXUS_RETURN_DOCUMENT_IDENTITY_REQUIRED/);
 await unchanged(()=>ecommerceReturn(o,[{...units[0],quantity:2}],parts),/NEXUS_RETURN_DOCUMENT_QUANTITY/);
});
const settle=async(o,net,allocations,id=crypto.randomUUID(),client=c)=>(await client.query("select record_courier_batch($1,$2,$3,'courier_batch',$4) r",[id,db.store,db.device,{courierId:o.courierId,courierName:'Synthetic courier',orderIds:[o.id],wallet:'inStoreSafe',netReceived:net,...(allocations?{allocations}: {})}])).rows[0].r;
const obligations=async()=>(await c.query('select read_courier_obligations($1) r',[db.store])).rows[0].r;
const orderRow=async(id)=>(await db.admin.query('select to_jsonb(o) r from orders o where id=$1',[id])).rows[0].r;
async function claimFor(o,amount=5000){const id=crypto.randomUUID();await c.query('insert into courier_claims(id,store_id,order_id,courier_id,amount_piastres) values($1,$2,$3,$4,$5)',[id,db.store,o.id,o.courierId,amount]);for(const status of ['submitted','approved'])await c.query('update courier_claims set status=$1 where id=$2',[status,id]);return id}
const claimRow=async id=>(await db.admin.query('select to_jsonb(c) r from courier_claims c where id=$1',[id])).rows[0].r;
const claimBatch=async(o,claimIds,net=0,id=crypto.randomUUID(),client=c)=>(await client.query("select record_courier_batch($1,$2,$3,'courier_batch',$4) r",[id,db.store,db.device,{courierId:o.courierId,courierName:'Synthetic',orderIds:[o.id],wallet:'inStoreSafe',netReceived:net,claimIds}])).rows[0].r;
async function courierReturn(o,{rto=false,returnFee=50,refundVia='courier',pendingDeposit=o.depositAmount}={}){
 await c.query("update orders set status='returned' where id=$1",[o.id]);
 const args={items:o.stockItems,courierId:o.courierId,returnFee,feeBorneBy:'courier',wallet:'inStoreSafe',refundVia,refundAmount:o.totalAmount,revenueAmount:o.totalAmount,movement:'return',pendingDeposit};
 const event=db.event(rto?'rto_confirmed':'return_confirmed','ecommerce_order',o.orderNumber,rto?buildOrderRTOLines(args):buildReturnConfirmedLines(args));
 await c.query('select confirm_order_return($1,$2,$3,$4,$5)',[o.id,'courier','return',JSON.stringify([event]),null]);return event.id;
}
test('returned courier50/50 obligations offset exactly without cash, stock or revenue replay',async()=>{
 const {o,r}=await order({courier:crypto.randomUUID(),prepaid:false});const returned=await courierReturn(o);const before=await balance(r.product.id),id=crypto.randomUUID();
 const open=(await obligations()).find(x=>x.orderId===o.id);assert.equal(open.codPiastres,5000);assert.equal(open.feePiastres,5000);
 const result=await settle(o,0,undefined,id);assert.equal(result.netPiastres,0);assert.deepEqual(result.closedOrderIds,[o.id]);assert.equal((await settle(o,0,undefined,id)).replayed,true);assert.deepEqual(await balance(r.product.id),before);
 assert.ok(await returnDoc(returned));assert.ok((await orderRow(o.id)).codSettledAt);assert.equal((await obligations()).some(x=>x.orderId===o.id),false);
 assert.equal((await db.admin.query("select count(*)::int n from ledger_lines where event_id=$1 and account='wallet'",[id])).rows[0].n,0);evidence.push({case:'returned50/50',returned,result});
});

test('source-covered returned50/50 claim closes atomically with zero offset and replays once',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),prepaid:false});await courierReturn(o);const claim=await claimFor(o),id=crypto.randomUUID();const r=await claimBatch(o,[claim],0,id);
 assert.deepEqual(r.closedClaimIds,[claim]);assert.equal((await claimRow(claim)).settlement_event_id,id);assert.equal((await claimRow(claim)).status,'settled');assert.equal((await claimBatch(o,[claim],0,id)).replayed,true);
 assert.equal((await db.admin.query("select count(*)::int n from ledger_lines where event_id=$1 and account='wallet'",[id])).rows[0].n,0);evidence.push({case:'atomic claim50/50 offset',claim,result:r});
});
test('late claim failure rolls back the entire transfer and stamps; no committed money without its selected note',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),prepaid:false});await courierReturn(o);const claim=await claimFor(o),id=crypto.randomUUID();
 await db.admin.query(`create function qa_claim_late() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_CLAIM_LATE';end$$;create trigger qa_claim_late after update on courier_claims for each row execute function qa_claim_late()`);
 try{await unchanged(()=>claimBatch(o,[claim],0,id),/SYNTHETIC_CLAIM_LATE/)}finally{await db.admin.query('drop trigger qa_claim_late on courier_claims;drop function qa_claim_late()')}
 assert.equal((await claimRow(claim)).status,'approved');assert.equal((await claimBatch(o,[claim],0,id)).closedClaimIds[0],claim);
});
test('another order on the same courier cannot close a claim, including manual status PATCH',async()=>{
 const courier=crypto.randomUUID(),{o}=await order({courier,prepaid:false});await courierReturn(o);const claim=await claimFor(o);const other=await order({courier,prepaid:false});
 await unchanged(()=>claimBatch(other.o,[claim],10),/NEXUS_CLAIM_NOT_COVERED/);const settled=await settle(other.o,10);
 await unchanged(()=>c.query("update courier_claims set status='settled',settlement_event_id=$1 where id=$2",[settled.eventId,claim]),/NEXUS_CLAIM_NOT_COVERED/);
});
test('shortfall write-off never proves claim collection, while an unselected claim does not block a legitimate transfer',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),prepaid:false,shipping:2});const claim=await claimFor(o,1000);
 await unchanged(()=>claimBatch(o,[claim],9),/NEXUS_CLAIM_NOT_COVERED/);const result=await settle(o,9);assert.equal(result.shortfallPiastres,100);assert.equal((await claimRow(claim)).status,'approved');
 await unchanged(()=>c.query("update courier_claims set status='settled',settlement_event_id=$1 where id=$2",[result.eventId,claim]),/NEXUS_CLAIM_NOT_COVERED/);
});
test('I an older delivery collection cannot inflate a later returned-fee claim: source50 cannot falsely close60',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),prepaid:false});await settle(o,10);await courierReturn(o,{refundVia:'wallet'});const claim=await claimFor(o,6000);await unchanged(()=>claimBatch(o,[claim],0),/NEXUS_CLAIM_NOT_COVERED/);assert.equal((await claimRow(claim)).status,'approved');
});
test('I original courier refund offsets the exact new compensation: negative and fee-only netting can close only source-proved claims',async()=>{
 for(const fee of [7,10]){const {o}=await order({courier:crypto.randomUUID(),prepaid:false});await settle(o,10);const returned=await courierReturn(o,{returnFee:fee});const claim=await claimFor(o,fee*100);assert.equal((await claimRow(claim)).source_event_id,returned);const result=await claimBatch(o,[claim],-10);assert.equal(result.codPiastres,fee*100-1000);assert.equal(result.feePiastres,fee*100);assert.equal((await claimRow(claim)).status,'settled');assert.equal((await claimBatch(o,[claim],-10,result.eventId)).replayed,true);evidence.push({case:'negative/fee-only source-proved compensation claim',returned,claim,result});}
});
test('I older write-off cannot inflate new claim coverage or block independent compensation from a new return phase',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),prepaid:false});await settle(o,9);const returned=await courierReturn(o,{refundVia:'wallet'});const claim=await claimFor(o);assert.equal((await claimRow(claim)).source_event_id,returned);assert.equal((await claimBatch(o,[claim],0)).closedClaimIds[0],claim);
});
test('I source-period single-order partial write-off is subtracted exactly; old collections cannot disguise the missing piastre',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),prepaid:false});await settle(o,10);await courierReturn(o,{refundVia:'wallet'});const claim=await claimFor(o);
 await settle(o,24.99,[{orderId:o.id,codPiastres:2500,feePiastres:0}]);await unchanged(()=>claimBatch(o,[claim],-25),/NEXUS_CLAIM_NOT_COVERED/);const final=await settle(o,-25);await unchanged(()=>c.query("update courier_claims set status='settled',settlement_event_id=$1 where id=$2",[final.eventId,claim]),/NEXUS_CLAIM_NOT_COVERED/);assert.equal((await claimRow(claim)).status,'approved');
});
test('I exact partially claimed compensation can be covered despite a separately quantified single-order write-off',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),prepaid:false});await settle(o,10);await courierReturn(o,{refundVia:'wallet'});const claim=await claimFor(o,3000);await settle(o,24,[{orderId:o.id,codPiastres:2500,feePiastres:0}]);assert.equal((await claimBatch(o,[claim],-25)).closedClaimIds[0],claim);
});
test('I canonical compensation source cannot be forged, rewritten or omitted after financial return',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),prepaid:false});const returned=await courierReturn(o,{refundVia:'wallet'});const claim=await claimFor(o);await unchanged(()=>c.query('update courier_claims set source_event_id=$1 where id=$2',[crypto.randomUUID(),claim]),/IDENTITY_IMMUTABLE|SOURCE_MISMATCH/);await unchanged(()=>c.query('select * from financial_private.courier_claim_phases'),/permission denied/);await assert.rejects(db.admin.query('delete from financial_private.courier_claim_phases where event_id=$1',[returned]),/SOURCE_IMMUTABLE/);
 const next=await order({courier:crypto.randomUUID(),prepaid:false});await db.admin.query(`create function qa_claim_source_skip() returns trigger language plpgsql as $$begin return null;end$$;create trigger aaa_qa_claim_source_skip before insert on financial_private.courier_claim_phases for each row execute function qa_claim_source_skip()`);await c.query("update orders set status='returned' where id=$1",[next.o.id]);const event=db.event('return_confirmed','ecommerce_order',next.o.orderNumber,buildReturnConfirmedLines({items:next.o.stockItems,refundAmount:10,revenueAmount:10,wallet:'inStoreSafe',courierId:next.o.courierId,returnFee:50,movement:'return',feeBorneBy:'courier'}));
 try{await unchanged(()=>c.query("select confirm_order_return($1,'courier','return',$2,null)",[next.o.id,JSON.stringify([event])]),/SOURCE_REQUIRED/);}finally{await db.admin.query('drop trigger aaa_qa_claim_source_skip on financial_private.courier_claim_phases;drop function qa_claim_source_skip()');}
});
test('I optional approved note can recover against its already committed source-proved fee-only settlement without another financial event',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),prepaid:false});await settle(o,10);await courierReturn(o,{returnFee:10});const claim=await claimFor(o,1000),result=await settle(o,-10),before=await balance(o.stockItems[0].productId),accountant=await db.client('ACCOUNTANT');const eventCount=(await db.admin.query('select count(*)::int n from ledger_events')).rows[0].n;
 for(let i=0;i<2;i++)await accountant.query("update courier_claims set status='settled',settlement_event_id=$1 where id=$2",[result.eventId,claim]);assert.equal((await claimRow(claim)).status,'settled');assert.equal((await db.admin.query('select count(*)::int n from ledger_events')).rows[0].n,eventCount);assert.deepEqual(await balance(o.stockItems[0].productId),before);evidence.push({case:'optional note recovery without money replay',claim,result});
});
test('I a multi-order write-off without a source-specific loss allocation cannot falsely close the affected compensation note',async()=>{
 const courier=crypto.randomUUID(),{o}=await order({courier,prepaid:false});await settle(o,10);await courierReturn(o,{refundVia:'wallet'});const claim=await claimFor(o,4000),{o:other}=await order({courier,prepaid:false});const input={courierId:courier,orderIds:[o.id,other.id],wallet:'inStoreSafe',netReceived:9};
 const result=(await c.query("select record_courier_batch($1,$2,$3,'courier_batch',$4) r",[crypto.randomUUID(),db.store,db.device,input])).rows[0].r;assert.equal(result.shortfallPiastres,100);await unchanged(()=>c.query("update courier_claims set status='settled',settlement_event_id=$1 where id=$2",[result.eventId,claim]),/NEXUS_CLAIM_NOT_COVERED/);assert.equal((await claimRow(claim)).status,'approved');
});
test('I canonical courier settlement accepts exact fractional EGP as integer piastres in both directions; sub-piastre amounts still roll back',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),prepaid:false});await unchanged(()=>settle(o,9.991),/NEXUS_COURIER_BATCH_INVALID/);const received=await settle(o,9.99);assert.equal(received.netPiastres,999);assert.equal(received.shortfallPiastres,1);
 const {o:prepaid}=await order({courier:crypto.randomUUID(),fee:3.01});const payout=await settle(prepaid,-3.01);assert.equal(payout.netPiastres,-301);assert.equal(payout.feePiastres,301);const line=(await db.admin.query("select amount_delta from ledger_lines where event_id=$1 and account='wallet'",[payout.eventId])).rows[0];assert.equal(line.amount_delta,-301);evidence.push({case:'exact fractional-EGP transfers',received,payout});
});
test('I courier identity remains editable before financial recognition and freezes once its immutable obligation exists',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),prepaid:false,deliver:false}),next=crypto.randomUUID();await db.insert('couriers',{id:next,store_id:db.store,device_id:db.device,name:'Synthetic next courier '+next});await c.query('update orders set "courierId"=$1 where id=$2',[next,o.id]);await c.query("select record_order_delivery($1,$2,$3,'order_delivery',$4)",[crypto.randomUUID(),db.store,db.device,{orderId:o.id,settle:false}]);await unchanged(()=>c.query('update orders set "courierId"=$1 where id=$2',[o.courierId,o.id]),/FINANCIAL_IDENTITY_IMMUTABLE/);assert.equal((await orderRow(o.id)).courierId,next);
});
test('fully covered final partial allocation can close original claim using exact prior covered amounts',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),prepaid:false});await courierReturn(o);const claim=await claimFor(o);
 const first=await settle(o,0,[{orderId:o.id,codPiastres:2500,feePiastres:2500}]);
 await unchanged(()=>c.query("update courier_claims set status='settled',settlement_event_id=$1 where id=$2",[first.eventId,claim]),/NEXUS_CLAIM_NOT_COVERED/);assert.equal((await claimRow(claim)).status,'approved');
 const final=await claimBatch(o,[claim]);assert.equal((await claimRow(claim)).settlement_event_id,final.eventId);assert.equal(final.codPiastres,2500);
});
test('claim amount, identity, tenant and original role boundaries remain enforced',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),prepaid:false});await courierReturn(o);const claim=await claimFor(o,5001);
 await unchanged(()=>claimBatch(o,[claim]),/NEXUS_CLAIM_NOT_COVERED/);
 await unchanged(()=>c.query('update courier_claims set amount_piastres=5000 where id=$1',[claim]),/NEXUS_CLAIM_IDENTITY_IMMUTABLE/);
 await unchanged(async()=>claimBatch(o,[claim],0,crypto.randomUUID(),await db.client('ECOMMERCE_ONLY')),/NEXUS_CLAIM_FORBIDDEN/);
 const foreign=crypto.randomUUID();await unchanged(()=>c.query('insert into courier_claims(id,store_id,order_id,courier_id,amount_piastres) values($1,$2,$3,$4,1)',[foreign,db.store,o.id,crypto.randomUUID()]),/NEXUS_CLAIM_SOURCE_MISMATCH|foreign key|unique constraint/);
 const {o:valid}=await order({courier:crypto.randomUUID(),prepaid:false});await courierReturn(valid);const validClaim=await claimFor(valid);assert.equal((await claimBatch(valid,[validClaim],0,crypto.randomUUID(),await db.client('ACCOUNTANT'))).closedClaimIds[0],validClaim);
});
test('RTO fee compensation50/50 and human return document remain atomic',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),prepaid:false,deliver:false});const returned=await courierReturn(o,{rto:true});assert.equal((await returnDoc(returned)).returned_items[0].quantity,2);
 const result=await settle(o,0);assert.equal(result.codPiastres,5000);assert.equal(result.feePiastres,5000);assert.equal(result.netPiastres,0);
});
test('prepaid fee-only pays courier once; negative net cannot be silently changed',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),fee:3});await unchanged(()=>settle(o,0),/NEXUS_COURIER_NET_MISMATCH/);
 const id=crypto.randomUUID(),result=await settle(o,-3,undefined,id);assert.equal(result.codPiastres,0);assert.equal(result.feePiastres,300);assert.equal(result.netPiastres,-300);assert.equal((await settle(o,-3,undefined,id)).replayed,true);
 const line=(await db.admin.query("select amount_delta from ledger_lines where event_id=$1 and account='wallet'",[id])).rows[0];assert.equal(line.amount_delta,-300);evidence.push({case:'prepaid fee-only payout',result});
});
test('partial allocation retains unsettled order and exact remaining read, final allocation closes',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),prepaid:false,shipping:2});
 const alloc=[{orderId:o.id,codPiastres:600,feePiastres:100,expectedCodPiastres:1200,expectedFeePiastres:200}];
 const result=await settle(o,5,alloc);assert.deepEqual(result.closedOrderIds,[]);assert.equal((await orderRow(o.id)).codSettledAt,null);
 const open=(await obligations()).find(x=>x.orderId===o.id);assert.equal(open.codPiastres,600);assert.equal(open.feePiastres,100);
 await unchanged(()=>settle(o,5,alloc),/NEXUS_COURIER_ALLOCATION_STALE/);
 const final=await settle(o,5);assert.deepEqual(final.closedOrderIds,[o.id]);assert.equal((await obligations()).some(x=>x.orderId===o.id),false);evidence.push({case:'partial then final',result,final});
});
test('fee-only partial payout leaves all customer cash open, bounded role compatibility unchanged',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),prepaid:false,shipping:2});const till=await db.client('POS_ECOMMERCE');
 await settle(o,-1,[{orderId:o.id,codPiastres:0,feePiastres:100}],crypto.randomUUID(),till);
 const open=(await obligations()).find(x=>x.orderId===o.id);assert.equal(open.codPiastres,1200);assert.equal(open.feePiastres,100);
 await settle(o,11,undefined,crypto.randomUUID(),await db.client('ECOMMERCE_ONLY'));
 const accountant=await db.client('ACCOUNTANT');const other=await order({courier:crypto.randomUUID(),prepaid:false});await settle(other.o,10,undefined,crypto.randomUUID(),accountant);
 await unchanged(()=>accountant.query("update orders set \"customerName\"='Forbidden edit' where id=$1 returning id",[other.o.id]).then(result=>{assert.equal(result.rowCount,0);throw Error('RLS preserved')}),/RLS preserved/);
});
test('late settlement stamp failure rolls back allocation receipt, ledger and order',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),fee:3});await db.admin.query(`create function qa_courier_late() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_COURIER_LATE';end$$;create trigger qa_courier_late after update on orders for each row execute function qa_courier_late()`);
 try{await unchanged(()=>settle(o,-3),/SYNTHETIC_COURIER_LATE/)}finally{await db.admin.query('drop trigger qa_courier_late on orders;drop function qa_courier_late()')}
});
test('negative receivable from an actual courier-funded refund is cleared by exact payout',async()=>{
 const {o}=await order({courier:crypto.randomUUID()});await courierReturn(o,{returnFee:0,pendingDeposit:0});
 const open=(await obligations()).find(x=>x.orderId===o.id);assert.equal(open.codPiastres,-1000);assert.equal(open.feePiastres,0);
 const result=await settle(o,-10);assert.equal(result.codPiastres,-1000);assert.equal(result.netPiastres,-1000);assert.equal((await obligations()).some(x=>x.orderId===o.id),false);
});
test('ordinary partial return financial forgery and late cause permission errors roll back all effects',async()=>{
 const {o}=await order(),units=[{...o.items[0],quantity:1,unitPrice:7}],parts=[{...o.stockItems[0],quantity:1}];
 await unchanged(()=>ecommerceReturn(o,units,parts),/NEXUS_RETURN_DOCUMENT_REFUND_MISMATCH/);
 const restricted=await db.client('ECOMMERCE_ONLY'),event={kind:'return_confirmed',refType:'ecommerce_order',refId:o.orderNumber,payload:{stockItems:parts,returnUnits:[{...o.items[0],quantity:1}],return_cause:'shop'},lines:buildReturnConfirmedLines({items:parts,refundAmount:5,revenueAmount:5,wallet:'inStoreSafe',returnFee:0,movement:'return'})};
 await unchanged(()=>restricted.query("select record_stock_command($1,$2,$3,'stock_event',$4)",[crypto.randomUUID(),db.store,db.device,event]),/NEXUS_CAUSE_NOT_AUTHORISED/);
});
test('courier allocation races, source/tenant forgery and excessive allocation cannot spend another order',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),prepaid:false,shipping:2}),a=await db.client(),b=await db.client(),id=crypto.randomUUID();
 const results=await Promise.all([settle(o,10,undefined,id,a),settle(o,10,undefined,id,b)]);assert.equal(results.filter(x=>x.replayed).length,1);
 await unchanged(()=>settle(o,10),/NEXUS_COURIER_ORDER_NOT_OPEN/);
 const other=await order({courier:crypto.randomUUID(),prepaid:false,shipping:2});
 await unchanged(()=>settle(other.o,20,[{orderId:other.o.id,codPiastres:2200,feePiastres:200}]),/NEXUS_COURIER_ALLOCATION_INVALID/);
 await unchanged(()=>c.query("select record_courier_batch($1,$2,$3,'courier_batch',$4)",[crypto.randomUUID(),crypto.randomUUID(),db.device,{courierId:other.o.courierId,orderIds:[other.o.id],wallet:'inStoreSafe',netReceived:10}]),/NEXUS_COURIER_FORBIDDEN/);
 const forged=db.event('courier_settlement','courier_batch','forged',[{account:'wallet',subjectId:'inStoreSafe',amount:-2},{account:'payable_courier',subjectId:other.o.courierId,amount:-2}]);
 await unchanged(()=>c.query('select ledger_append($1)',[forged]),/ledger: courier_settlement/);
 const race=await Promise.allSettled([settle(other.o,10,undefined,crypto.randomUUID(),a),settle(other.o,10,undefined,crypto.randomUUID(),b)]);assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
});
test('delivery plus fee-only settlement is atomic for existing ecommerce role, accountant cannot deliver',async()=>{
 const {o}=await order({courier:crypto.randomUUID(),fee:3,deliver:false}),role=await db.client('ECOMMERCE_ONLY');
 const r=(await role.query("select record_order_delivery($1,$2,$3,'order_delivery',$4) r",[crypto.randomUUID(),db.store,db.device,{orderId:o.id,settle:true,wallet:'inStoreSafe',netReceived:-3}])).rows[0].r;
 assert.ok(r.settlementEventId);assert.ok((await orderRow(o.id)).codSettledAt);
 const other=await order({courier:crypto.randomUUID(),deliver:false});await unchanged(()=>db.client('ACCOUNTANT').then(client=>client.query("select record_order_delivery($1,$2,$3,'order_delivery',$4)",[crypto.randomUUID(),db.store,db.device,{orderId:other.o.id,settle:false}])),/NEXUS_DELIVERY_FORBIDDEN/);
});
test('required return document cannot be removed/rewritten; missing document cannot commit',async()=>{
 const r=await catalog(draft()),item={productId:r.product.id,quantity:1,unitPrice:5,unitCost:2},sale=await pos([item]),returned=await pos([{...item,quantity:-1}],{returnOfEventId:sale.eventId});
 await unchanged(()=>c.query('delete from return_records where id=$1',['return:'+returned.eventId]),/NEXUS_RETURN_DOCUMENT_IMMUTABLE/);
 await unchanged(()=>c.query('update return_records set financial_difference=0 where id=$1',['return:'+returned.eventId]),/NEXUS_RETURN_DOCUMENT_IMMUTABLE/);
 const noStock=db.event('return_confirmed','ecommerce_order','synthetic-missing',[{account:'wallet',subjectId:'inStoreSafe',amount:-1},{account:'revenue',subjectId:'ecommerce',amount:-1}]);
 await unchanged(()=>c.query('select ledger_append($1)',[noStock]),/NEXUS_RETURN_DOCUMENT_REQUIRED/);
});
test('actual catalog client recovers committed response loss/reload without creating another product or opening',async()=>{
 const storage={},calls=[];let losses=2,state={products:[]};
 globalThis.sessionStorage={getItem:k=>storage[k]??null,setItem:(k,v)=>storage[k]=v,removeItem:k=>delete storage[k]};
 const stubs={'@/lib/supabase':{getSupabaseClient:()=>({async rpc(name,args){assert.equal(name,'record_product_catalog');calls.push(args.p_id);const data=await catalog(args.p_input,args.p_id);if(losses-->0)throw Error('SYNTHETIC_COMMITTED_RESPONSE_LOSS');return {data,error:null}}})},
  '@/services/api/storeContext':{getSyncIdentity:async()=>({storeId:db.store,deviceId:db.device})},
  '@/store/useBusinessStore':{useBusinessStore:{setState:fn=>state={...state,...fn(state)}}}};
 const fields={name:'Synthetic client product',sku:crypto.randomUUID(),unitPrice:5,wholesalePrice:4,metadata:{variants:[]}};
 const first=uiHarness(stubs);await assert.rejects(first.load('src/lib/catalogStockCommand.ts').saveCatalogProduct(fields,{quantity:10,unitCost:2}),/لم يصل تأكيد العملية/);
 assert.equal(state.products.length,0);assert.equal(new Set(calls).size,1);
 const reloaded=uiHarness(stubs);await assert.rejects(reloaded.load('src/lib/catalogStockCommand.ts').saveCatalogProduct({...fields,name:'Changed draft'},{quantity:12,unitCost:2}),/تم تأكيد حفظ المنتج السابق/);
 assert.equal(new Set(calls).size,1);assert.equal(Object.keys(storage).length,0);assert.equal(state.products.length,1);assert.equal(state.products[0].name,fields.name);assert.equal(state.products[0].totalQuantity,10);assert.deepEqual(await balance(state.products[0].id),{qty:10,piastres:2000});
 delete globalThis.sessionStorage;evidence.push({case:'actual catalog lost-response/reload',operation:calls[0],product:state.products[0].id});
});
test('optional return-document refresh failure cannot submit a second financial operation',async()=>{
 let writes=0;const harness=uiHarness({'@/store/useAuthStore':{useAuthStore:{getState:()=>({userRole:'ADMIN'})}},'@/lib/supabase':{getSupabaseClient:()=>({rpc(){writes++;throw Error('No financial RPC allowed')},from(table){assert.equal(table,'return_records');const q={select(){return q},eq(){return q},is(){return q},async order(){throw Error('SYNTHETIC_READ_FAILURE')}};return q}})},
  '@/services/api/storeContext':{getSyncIdentity:async()=>({storeId:db.store,deviceId:db.device})},'@/store/useBusinessStore':{useBusinessStore:{setState(){throw Error('No failed read may replace the cache')}}}});
 await harness.load('src/lib/returnDocuments.ts').refreshReturnDocuments();assert.equal(writes,0);
});

test('repeated ordinary partial returns allocate every original piastre exactly once, including zero-cash units',async()=>{
 for(const netTotal of [0.01,0.02,0.1,14.99]){
  const {o,r}=await order({quantity:3,netTotal}),docs=[],amounts=[];
  for(let n=0;n<3;n++){
   const units=[{...o.items[0],quantity:1}],parts=[{...o.stockItems[0],quantity:1}],id=crypto.randomUUID();
   const amount=ordinaryReturnValue(o,units,docs);amounts.push(amount);
   await c.query("select record_stock_command($1,$2,$3,'stock_event',$4)",[id,db.store,db.device,{kind:'return_confirmed',refType:'ecommerce_order',refId:o.orderNumber,payload:{stockItems:parts,returnUnits:units,return_cause:'customer'},lines:buildReturnConfirmedLines({items:parts,refundAmount:amount,revenueAmount:amount,wallet:'inStoreSafe',returnFee:0,movement:'return'})}]);
   const doc=await returnDoc(id);assert.deepEqual(doc.returned_items[0].unitNumbers,[n+1]);assert.equal(doc.returned_items[0].refund_amount,amount);docs.push(doc);
  }
  assert.equal(Math.round(amounts.reduce((n,x)=>n+x,0)*100),Math.round(netTotal*100));assert.deepEqual(await balance(r.product.id),{qty:10,piastres:2000});
  assert.equal(remainingUnits(o,docs).get(returnUnitKey(r.product.id,'RED')),0);
  evidence.push({case:'exact repeated partial refunds',netTotal,amounts,documents:docs.map(x=>x.id)});
 }
});

test('ordinary return and exchange share immutable original unit slots rather than overlapping after a reservation gap',async()=>{
 const {o}=await order({quantity:3,netTotal:0.02}),parts=[{...o.stockItems[0],quantity:1}];
 // A private pending exchange fixture reserves unit1; no cloud writes.
 await db.admin.query("insert into financial_private.order_exchanges(id,store_id,original_id,replacement_id,status,selections,details,placement_request,placement_result) values($1,$2,$3,$4,'pending',$5,'{}','{}','{}')",[crypto.randomUUID(),db.store,o.id,crypto.randomUUID(),JSON.stringify([{lineId:'line:1',productId:o.items[0].productId,quantity:1,unitNumbers:[1]}])]);
 const ex={exchangeDetails:{originalOrderId:o.id,status:'pending',selections:[{lineId:'line:1',unitNumbers:[1]}]}};
 const units=[{...o.items[0],quantity:1}],amount=ordinaryReturnValue(o,units,[],[ex]);assert.equal(amount,0);
 await unchanged(()=>c.query('select ledger_append($1)',[db.event('return_confirmed','ecommerce_order',o.orderNumber,buildReturnConfirmedLines({items:parts,refundAmount:amount,revenueAmount:amount,wallet:'inStoreSafe',returnFee:0,movement:'return'}),{stockItems:parts,returnUnits:units,return_cause:'customer'})]),/لا يمكن إرجاع وحدات محجوزة/);
 const id=crypto.randomUUID();await c.query("select record_stock_command($1,$2,$3,'stock_event',$4)",[id,db.store,db.device,{kind:'return_confirmed',refType:'ecommerce_order',refId:o.orderNumber,payload:{stockItems:parts,returnUnits:units,return_cause:'customer'},lines:buildReturnConfirmedLines({items:parts,refundAmount:amount,revenueAmount:amount,wallet:'inStoreSafe',returnFee:0,movement:'return'})}]);
 const doc=await returnDoc(id);assert.deepEqual(doc.returned_items[0].unitNumbers,[2]);
 const selected=(await db.admin.query('select financial_private.exchange_selection($1,o,$2) r from orders o where id=$3',[db.store,JSON.stringify([{lineId:'line:1',quantity:1}]),o.id])).rows[0].r;
 assert.deepEqual(selected[0].unitNumbers,[3]);assert.equal(selected[0].refundPiastres,1);assert.equal(ordinaryReturnValue(o,units,[doc],[ex]),0.01);
 const product=await catalog(draft(true)),replacementId=crypto.randomUUID(),op=crypto.randomUUID();
 const replacement={id:replacementId,store_id:db.store,device_id:db.device,orderNumber:'SYN-'+replacementId,customerName:o.customerName,customerPhone:o.customerPhone,items:[{productId:product.product.id,variantName:'RED',productName:'Replacement',quantity:1,unitPrice:5}],totalAmount:5,depositAmount:5,depositWallet:'inStoreSafe',expectedCod:0,shippingFee:0,courierFee:0,discountAmount:0,paymentMethod:'full_prepaid'};
 await c.query("select record_exchange_place($1,$2,$3,'exchange_place',$4)",[op,db.store,db.device,{originalOrderId:o.id,selections:[{lineId:'line:1',quantity:1}],cause:'customer',order:replacement,event:db.event('order_placed','ecommerce_order',replacement.orderNumber,[])}]);
 assert.deepEqual((await db.admin.query('select selections from financial_private.order_exchanges where id=$1',[op])).rows[0].selections[0].unitNumbers,[3]);
 await unchanged(()=>c.query("select record_stock_command($1,$2,$3,'stock_event',$4)",[crypto.randomUUID(),db.store,db.device,{kind:'return_confirmed',refType:'ecommerce_order',refId:o.orderNumber,payload:{stockItems:parts,returnUnits:units,return_cause:'customer'},lines:buildReturnConfirmedLines({items:parts,refundAmount:0.01,revenueAmount:0.01,wallet:'inStoreSafe',returnFee:0,movement:'return'})}]),/الكمية محجوزة/);
});
