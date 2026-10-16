// Real captured-schema PG17.6 + JavaScript JSON boundary, synthetic only.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {openBusinessDb,read,ROOT} from './helpers/business-db.mjs';
import {buildOrderPlacedLines} from '../src/lib/ledger/orders.ts';
const migrations=['20261012080415_receipt_variant_stock','20261012082556_pos_atomic_exchange','20261012090535_courier_atomic_batch','20261012191715_authoritative_stock_commands','20261012194223_courier_writer_compatibility','20261012203014_catalog_return_compatibility','20261012204812_courier_obligation_compatibility','20261012213602_order_payment_atomic','20261013010850_exchange_credit_lifecycle','20261013015521_customer_trip_atomic_recovery','20261013022600_courier_claim_source_attribution','20261013031632_order_backorder_allocation','20261013111632_scoped_order_activity','20261013120155_store_branded_document_numbers','20261014094740_courier_cod_service_fee','20261014095804_fixed_asset_accounting'];
const migration='20261016034354_order_edit_numeric_snapshot';
let db,c,baselineMetadata;const evidence=[];
const metadata=async()=> (await db.admin.query(`select jsonb_build_object('functions',(select jsonb_agg(jsonb_build_object('id',p.oid::regprocedure::text,'hash',md5(pg_get_functiondef(p.oid)),'acl',p.proacl,'owner',p.proowner,'definer',p.prosecdef,'config',p.proconfig) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','financial_private') and p.prokind='f'),'policies',(select jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname) from pg_policies p where schemaname in ('public','financial_private'))) r`)).rows[0].r;
before(async()=>{db=await openBusinessDb();c=await db.client();for(const name of migrations)await db.admin.query(read('supabase/migrations/'+name+'.sql'));baselineMetadata=await metadata();if(process.env.NEXUS_EDIT_BASELINE!=='1')await db.admin.query(read('supabase/migrations/'+migration+'.sql'));});
after(async()=>{if(db){fs.writeFileSync(path.join(ROOT,'logs/final-v1-sprint/order-edit-numeric-'+Date.now()+'.json'),JSON.stringify({scope:'isolated PG17.6 ONLY; not deployed',version:db.version,migrations,migration,baseline:process.env.NEXUS_EDIT_BASELINE==='1',evidence},null,2));await db.close();}});
const command=async(input,id=crypto.randomUUID(),client=c)=>(await client.query("select record_order_edit($1,$2,$3,'order_edit',$4) r",[id,db.store,db.device,input])).rows[0].r;
const current=async(id)=>(await db.admin.query('select to_jsonb(o) r from orders o where id=$1',[id])).rows[0].r;
const snapshot=async()=>JSON.stringify((await db.admin.query(`select jsonb_build_object('orders',(select jsonb_agg(to_jsonb(o) order by id) from orders o),'products',(select jsonb_agg(to_jsonb(o) order by id) from products o),'events',(select jsonb_agg(to_jsonb(o) order by id) from ledger_events o),'lines',(select jsonb_agg(to_jsonb(o) order by id) from ledger_lines o),'exchanges',(select jsonb_agg(to_jsonb(o) order by id) from financial_private.order_exchanges o)) r`)).rows[0].r);
const reject=async(fn,pattern)=>{const saved=await snapshot();await assert.rejects(fn,pattern);assert.equal(await snapshot(),saved);};
const beforeDoc=o=>({items:o.items,stockItems:o.stockItems,totalAmount:o.totalAmount,discountAmount:o.discountAmount,depositAmount:o.depositAmount});
const edit=o=>({orderId:o.id,before:beforeDoc(o),patch:{items:o.items.map(x=>({...x,quantity:1})),stockItems:o.stockItems.map(x=>({...x,quantity:x.quantity/2})),totalAmount:30,discountAmount:0}});
async function fixture(exchange=false){
 const product=crypto.randomUUID(),bundle=crypto.randomUUID(),supplier=crypto.randomUUID(),courier=crypto.randomUUID(),customer=crypto.randomUUID();
 await db.insert('suppliers',{id:supplier,store_id:db.store,device_id:db.device,companyName:'Synthetic precision supplier',contactPerson:'',phone:''});
 await db.insert('couriers',{id:courier,store_id:db.store,device_id:db.device,name:'Synthetic precision courier '+courier});
 await db.insert('customers',{id:customer,store_id:db.store,device_id:db.device,name:'Synthetic precision customer',phone:'qa.invalid-'+customer,address:''});
 await c.query("select record_product_catalog($1,$2,$3,'product_catalog',$4)",[crypto.randomUUID(),db.store,db.device,{action:'create',unitCost:1.02,product:{id:product,name:'Synthetic RED BLUE',sku:product,quantity:61,unitPrice:10,metadata:{variants:[{name:'RED',stock:40},{name:'BLUE',stock:21}]}}}]);
 await c.query("select record_financial_command($1,$2,$3,'receipt',$4)",[crypto.randomUUID(),db.store,db.device,{stockMirrorVersion:1,supplierId:supplier,paidAmount:0,wallet:'inStoreSafe',items:[{productId:product,variantName:'RED',quantity:1,unitCost:1.63}]}]);
 await db.insert('products',{id:bundle,store_id:db.store,device_id:db.device,name:'Synthetic box',sku:bundle,quantity:0,unitPrice:30,isBundle:true,bundleItems:[{productId:product,variantName:'RED',quantity:2},{productId:product,variantName:'BLUE',quantity:1}],metadata:{variants:[]}});
 const item={id:'box-line',productId:bundle,bundleId:bundle,productName:'Synthetic box',bundleName:'Synthetic box',quantity:2,unitPrice:30};
 const components=[{productId:product,variantName:'RED',bundleId:bundle,quantity:4,unitPrice:0,unitCost:6385/6200},{productId:product,variantName:'BLUE',bundleId:bundle,quantity:2,unitPrice:0,unitCost:6385/6200}];
 const make=(id,items,stockItems,total,deposit=0)=>({id,store_id:db.store,device_id:db.device,orderNumber:'PREC-'+id,customerId:customer,customerName:'Synthetic precision customer',customerPhone:'qa.invalid',courierId:courier,items,stockItems,totalAmount:total,discountAmount:0,shippingFee:0,courierFee:0,depositAmount:deposit,depositWallet:'inStoreSafe',expectedCod:total-deposit,paymentMethod:'partial_cod',fulfillment:{version:1,allowBackorder:true}});
 const id=crypto.randomUUID(),order=make(id,[item],components,60);
 if(exchange){
  const sourceId=crypto.randomUUID(),sourceLine={id:'source',productId:product,variantName:'RED',productName:'Original',quantity:1,unitPrice:10,unitCost:6385/6200};
  const original=make(sourceId,[sourceLine],[sourceLine],10,10);
  await c.query('select place_order($1,$2)',[original,db.event('order_placed','ecommerce_order',original.orderNumber,buildOrderPlacedLines({items:original.stockItems,depositAmount:10,wallet:'inStoreSafe'}))]);
  await c.query("update orders set status='shipped' where id=$1",[sourceId]);
  await c.query("select record_order_delivery($1,$2,$3,'order_delivery',$4)",[crypto.randomUUID(),db.store,db.device,{orderId:sourceId,settle:false}]);
  delete order.fulfillment;
  await c.query("select record_exchange_place($1,$2,$3,'exchange_place',$4)",[crypto.randomUUID(),db.store,db.device,{originalOrderId:sourceId,selections:[{lineId:'source',quantity:1}],cause:'shop',order,event:db.event('order_placed','ecommerce_order',order.orderNumber,[])}]);
 }else await c.query('select place_order($1,$2)',[order,db.event('order_placed','ecommerce_order',order.orderNumber,buildOrderPlacedLines({items:components}))]);
 return {id,product,bundle,order:await current(id)};
}

for(const exchange of [false,true]) test(`actual ${exchange?'exchange':'forward fulfillment'} BOX2→1 edit survives binary64 JSON cost and preserves piastres/replay`,async()=>{
 const f=await fixture(exchange),input=edit(f.order),op=crypto.randomUUID();
 const exact=(await db.admin.query('select "stockItems"->0->>\'unitCost\' cost from orders where id=$1',[f.id])).rows[0].cost;
 assert.notEqual(exact,String(input.before.stockItems[0].unitCost));
 const result=await command(input,op),saved=await current(f.id);assert.equal(saved.items[0].quantity,1);assert.equal(saved.expectedCod,exchange?20:30);
 assert.equal(saved.stockItems.reduce((s,x)=>s+x.quantity,0),3);
 const stock=(await db.admin.query("select sum(qty_delta)::int qty,sum(amount_delta)::int value from ledger_lines where event_id=$1 and account='stock'",[op])).rows[0];
 assert.deepEqual(stock,{qty:3,value:309});assert.equal(Math.round(saved.cogsAmount*100),309);
 if(exchange)assert.equal(saved.exchangeDetails.credit.allocatedPiastres,1000);
 const after=await snapshot();assert.equal((await command(input,op)).replayed,true);assert.equal(await snapshot(),after);
 await reject(()=>command({...input,patch:{...input.patch,totalAmount:31}},op),/PAYLOAD_MISMATCH/);
 await reject(()=>command(input),/ORDER_EDIT_STALE/);
 evidence.push({exchange,id:f.id,operation:op,exactCost:exact,browserCost:input.before.stockItems[0].unitCost,saved,stock,replayed:result.replayed});
});

test('genuine stale identities, quantities, prices, totals, deposits and costs all refuse without any effect',async()=>{
 const f=await fixture(true),input=edit(f.order);
 const mutations=[x=>x.stockItems[0].quantity++,x=>x.stockItems[0].variantName='BLUE',x=>x.stockItems[0].productId='forged',x=>x.stockItems[0].unitCost+=0.0000001,x=>x.items[0].unitPrice++,x=>x.totalAmount++,x=>x.discountAmount++,x=>x.depositAmount++,x=>x.stockItems.reverse(),x=>delete x.stockItems[0].unitCost,x=>x.stockItems[0].unitCost=String(x.stockItems[0].unitCost)];
 for(const mutate of mutations){const before=structuredClone(input.before);mutate(before);await reject(()=>command({...input,before}),/ORDER_EDIT_STALE/);}
});

test('same float is never a tolerance for changed row/group piastres, shape or out-of-range cost',async()=>{
 const compare=async(a,b)=>(await db.admin.query('select financial_private.order_edit_snapshot_matches($1::jsonb,$2::jsonb) r',[a,b])).rows[0].r;
 const doc=rows=>({items:[],stockItems:rows,totalAmount:0,discountAmount:0,depositAmount:0});
 // Two decimal values round to the same float but opposite sides of 0.5 piastre.
 const a='{"productId":"p","quantity":1,"unitCost":0.0049999999999999999}',b='{"productId":"p","quantity":1,"unitCost":0.005}';
 assert.equal(await compare('{"stockItems":['+a+']}','{"stockItems":['+b+']}'),false);
 const ga='{"productId":"p","quantity":1,"unitCost":0.0024999999999999999}',gb='{"productId":"p","quantity":1,"unitCost":0.0025}';
 assert.equal(await compare('{"stockItems":['+ga+']}','{"stockItems":['+gb+']}'),true);
 const groupA='{"stockItems":['+ga+','+ga+']}',groupB='{"stockItems":['+gb+','+gb+']}';assert.equal(await compare(groupA,groupB),false);
 assert.equal(await compare(doc([{productId:'p',quantity:1,unitCost:1}]),doc([{productId:'p',quantity:1,unitCost:2}])),false);
 assert.equal(await compare('{"stockItems":[{"quantity":1,"unitCost":1e1000}]}','{"stockItems":[{"quantity":1,"unitCost":1e999}]}'),false);
 assert.equal(await compare(null,doc([])),false);
});

test('late edit failure rolls back financial, stock, document and retry receipt together',async()=>{
 const f=await fixture(true),input=edit(f.order);
 await db.admin.query(`create function public.precision_fail() returns trigger language plpgsql as $$begin if NEW.kind='order_edited' then raise exception 'SYNTHETIC_PRECISION_LATE';end if;return NEW;end$$;create trigger precision_fail before insert on ledger_events for each row execute function public.precision_fail()`);
 try{await reject(()=>command(input),/SYNTHETIC_PRECISION_LATE/);}finally{await db.admin.query('drop trigger precision_fail on ledger_events;drop function public.precision_fail()');}
 assert.equal((await command(input)).order.items[0].quantity,1);
});

test('two different edits serialize: one commits, the stale loser cannot release stock twice',async()=>{
 const f=await fixture(true),input=edit(f.order),other=await db.client();
 const outcomes=await Promise.allSettled([command(input),command(input,crypto.randomUUID(),other)]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.match(outcomes.find(x=>x.status==='rejected').reason.message,/ORDER_EDIT_STALE/);
 assert.equal((await current(f.id)).items[0].quantity,1);
});

test('same operation concurrent replay releases inventory once and authorized ecommerce role can still edit',async()=>{
 const f=await fixture(true),input=edit(f.order),op=crypto.randomUUID(),other=await db.client('ECOMMERCE_ONLY');
 const results=await Promise.all([command(input,op),command(input,op,other)]);
 assert.equal(results.filter(x=>x.replayed).length,1);assert.equal((await current(f.id)).items[0].quantity,1);
 assert.equal((await db.admin.query("select sum(qty_delta)::int qty from ledger_lines where event_id=$1 and account='stock'",[op])).rows[0].qty,3);
});

test('ACLs and legitimate role behavior remain bounded; private comparator is not an authenticated API',async()=>{
 const f=await fixture(true),input=edit(f.order),accountant=await db.client('ACCOUNTANT');
 await reject(()=>command(input,crypto.randomUUID(),accountant),/ORDER_FORBIDDEN/);
 await assert.rejects(()=>c.query('select financial_private.order_edit_snapshot_matches($1,$1)',[input.before]),/permission denied/);
 const grants=(await db.admin.query("select has_function_privilege('anon','public.record_order_edit(text,uuid,uuid,text,jsonb)','EXECUTE') anon,has_function_privilege('authenticated','public.record_order_edit(text,uuid,uuid,text,jsonb)','EXECUTE') authenticated,has_function_privilege('authenticated','financial_private.record_fulfillment_edit(text,uuid,uuid,text,jsonb)','EXECUTE') private")).rows[0];assert.deepEqual(grants,{anon:false,authenticated:true,private:false});
});

test('migration changes exactly two predicate functions plus the private helper, preserving every existing ACL/owner/config and RLS policy',async()=>{
 const after=await metadata(),changed=[];
 assert.deepEqual(after.policies,baselineMetadata.policies);
 for(const old of baselineMetadata.functions){const next=after.functions.find(x=>x.id===old.id);assert.ok(next,old.id);assert.deepEqual({...next,hash:old.hash},old);if(next.hash!==old.hash)changed.push(old.id);}
 assert.deepEqual(changed.sort(),['public.record_order_edit(text,uuid,uuid,text,jsonb)','financial_private.record_fulfillment_edit(text,uuid,uuid,text,jsonb)'].map(x=>x.replace(/^public\./,'')).sort());
 const added=after.functions.filter(x=>!baselineMetadata.functions.some(o=>o.id===x.id));assert.equal(added.length,1);assert.equal(added[0].id,'financial_private.order_edit_snapshot_matches(jsonb,jsonb)');
 evidence.push({schemaIntegrity:{changed,added:added.map(x=>x.id),allExistingACLsOwnersAndSettingsPreserved:true,rlsUnchanged:true}});
});
