import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openBusinessDb,read,ROOT} from './helpers/business-db.mjs';
import {buildOpeningBalanceLines} from '../src/lib/ledger/audit.ts';
import {buildOrderPlacedLines,buildOrderDeliveredLines} from '../src/lib/ledger/orders.ts';
import {courierSettlementAmounts,batchSummary} from '../src/lib/courierBatch.ts';
const versions=['20261012080415','20261012082556','20261012090535','20261012191715','20261012194223','20261012203014','20261012204812','20261012213602','20261013010850','20261013015521','20261013022600','20261013031632','20261013111632','20261013120155','20261014094740'];
let db,c;const evidence=[];
before(async()=>{db=await openBusinessDb();c=await db.client();for(const v of versions){const f=fs.readdirSync(path.join(ROOT,'supabase/migrations')).find(f=>f.startsWith(v+'_'));assert.ok(f);await db.admin.query(read('supabase/migrations/'+f));}});
after(async()=>{if(db){fs.writeFileSync(path.join(process.env.NEXUS_QA_TEST_LOG_ROOT||path.join(ROOT,'logs/final-v1-sprint'),'cod-service-regression.json'),JSON.stringify({version:db.version,scope:'disposable local only',versions,evidence},null,2));await db.close();}});
const row=async id=>(await db.admin.query('select to_jsonb(o) r from orders o where id=$1',[id])).rows[0].r;
const total=async(account,subject)=>(await db.admin.query('select coalesce(sum(amount_delta),0)::int n from ledger_lines where store_id=$1 and account=$2 and ($3::text is null or subject_id=$3)',[db.store,account,subject??null])).rows[0].n;
const delivery=async(order,id=crypto.randomUUID(),client=c)=>(await client.query("select record_order_delivery($1,$2,$3,'order_delivery',$4) r",[id,db.store,db.device,{orderId:order.id,settle:false}])).rows[0].r;
const correction=async(order,amount,before=order.codServiceFee??0,id=crypto.randomUUID(),client=c)=>(await client.query("select record_cod_service_fee($1,$2,$3,'cod_service_fee',$4) r",[id,db.store,db.device,{orderId:order.id,amount,before,reason:'Synthetic statement correction'}])).rows[0].r;
const settle=async(orders,net,id=crypto.randomUUID())=>(await c.query("select record_courier_batch($1,$2,$3,'courier_batch',$4) r",[id,db.store,db.device,{orderIds:orders.map(o=>o.id).sort(),courierId:orders[0].courierId,wallet:'inStoreSafe',netReceived:net}])).rows[0].r;
async function seed({goods=430,shipping=70,fee=70,service=5.7,courier,deposit=0}={}){
 courier??=crypto.randomUUID();
 if(!(await db.admin.query('select 1 from couriers where id=$1',[courier])).rowCount)await db.insert('couriers',{id:courier,store_id:db.store,device_id:db.device,name:'Synthetic no-contact courier '+courier});
 const product=crypto.randomUUID();await c.query("select record_product_catalog($1,$2,$3,'product_catalog',$4)",[crypto.randomUUID(),db.store,db.device,{action:'create',unitCost:2,product:{id:product,name:'Synthetic goods',sku:product,quantity:10,unitPrice:goods}}]);
 const item={id:crypto.randomUUID(),productId:product,productName:'Synthetic goods',quantity:1,unitPrice:goods,unitCost:2};
 const o={id:crypto.randomUUID(),store_id:db.store,device_id:db.device,orderNumber:'QA-'+crypto.randomUUID(),customerName:'Synthetic',customerPhone:'qa.invalid',items:[item],stockItems:[item],totalAmount:goods,shippingFee:shipping,courierFee:fee,codServiceFee:service,depositAmount:deposit,depositWallet:deposit?'inStoreSafe':null,expectedCod:goods+shipping-deposit,paymentMethod:'partial_cod',courierId:courier};
 await c.query('select place_order($1,$2)',[o,db.event('order_placed','ecommerce_order',o.orderNumber,buildOrderPlacedLines({items:[item],depositAmount:deposit,wallet:deposit?'inStoreSafe':undefined}))]);
 await c.query("update orders set status='shipped' where id=$1",[o.id]);return o;
}
test('500 COD /70 delivery /5.70 service persists unchanged COD and settles exactly424.30, no duplicate service expense',async()=>{
 const o=await seed(),base=await total('expense','courier_cod_service');await delivery(o);assert.equal((await row(o.id)).expectedCod,500);
 assert.equal(await total('receivable_courier',o.courierId),50000);assert.equal(await total('payable_courier',o.courierId),7570);
 assert.equal(await total('expense','courier_cod_service')-base,570);
 assert.deepEqual(courierSettlementAmounts(o),{cod:500,fee:75.7});
 const id=crypto.randomUUID(),r=await settle([o],424.3,id);assert.equal(r.netPiastres,42430);assert.equal(r.shortfallPiastres,0);
 assert.equal(await total('receivable_courier',o.courierId),0);assert.equal(await total('payable_courier',o.courierId),0);
 assert.equal((await settle([o],424.3,id)).replayed,true);assert.equal(await total('expense','courier_cod_service')-base,570);evidence.push({scenario:'positive',r});
});
test('negative20-120-5.70=-105.70 pays courier exactly, zero50-44.30-5.70 clears without wallet line',async()=>{
 for(const [goods,shipping,fee,net] of [[20,0,120,-105.7],[20,30,44.3,0]]){
  const o=await seed({goods,shipping,fee});await delivery(o);const r=await settle([o],net);assert.equal(r.netPiastres,Math.round(net*100));assert.equal(r.shortfallPiastres,0);
  assert.equal(await total('receivable_courier',o.courierId),0);assert.equal(await total('payable_courier',o.courierId),0);
  const w=(await db.admin.query("select coalesce(sum(amount_delta),0)::int n,count(*)::int c from ledger_lines where event_id=$1 and account='wallet'",[r.eventId])).rows[0];
  assert.equal(w.n,Math.round(net*100));if(net===0)assert.equal(w.c,0);evidence.push({scenario:'zero/negative',r});
 }
});
test('fully prepaid/no COD never accrues an entered COD fee; legacy missing field remains zero',async()=>{
 const o=await seed({goods:20,shipping:70,deposit:90});const base=await total('expense','courier_cod_service');await delivery(o);
 assert.equal(await total('payable_courier',o.courierId),7000);assert.equal(await total('expense','courier_cod_service'),base);
 await assert.rejects(correction(o,6.84),/NO_COLLECTION/);
 const old=await seed({service:0});assert.equal((await row(old.id)).codServiceFee,0);
});
test('pending estimate has no financial lines, actual correction accrues delta once and preserves COD/customer shipping',async()=>{
 const o=await seed({service:0}),id=crypto.randomUUID(),a=await correction(o,5.7,0,id);assert.equal(a.accruedDeltaPiastres,0);
 assert.equal((await db.admin.query('select count(*)::int n from ledger_lines where event_id=$1',[id])).rows[0].n,0);
 assert.equal((await correction(o,5.7,0,id)).replayed,true);await assert.rejects(correction(o,6.84,0,id),/PAYLOAD_MISMATCH/);
 await delivery(o);const b=await correction(o,6.84,5.7);assert.equal(b.accruedDeltaPiastres,114);
 assert.equal(b.order.expectedCod,500);assert.equal(b.order.shippingFee,70);assert.equal(await total('payable_courier',o.courierId),7684);
 const down=await correction(o,5.7,6.84);assert.equal(down.accruedDeltaPiastres,-114);assert.equal(await total('payable_courier',o.courierId),7570);
 await settle([o],424.3);await assert.rejects(correction(o,6.84,5.7),/NOT_OPEN/);evidence.push({scenario:'audited correction',a,b,down});
});
test('invalid precision, negative amount, stale request, raw update, forged ledger and cross-tenant/role are refused locally',async()=>{
 const o=await seed({service:0});await assert.rejects(correction(o,5.701),/INVALID/);await assert.rejects(correction(o,-.01),/INVALID/);
 await assert.rejects(correction(o,5.7,9),/STALE/);
 await assert.rejects(c.query('update orders set "codServiceFee"=5.7 where id=$1',[o.id]),/COMMAND_REQUIRED/);
 const raw=db.event('courier_fee_adjustment','ecommerce_order',o.orderNumber,[]);await assert.rejects(c.query('select ledger_append($1)',[raw]),/LEDGER_SOURCE/);
 const other=await db.client('ECOMMERCE_ONLY');await db.admin.query('delete from store_members where user_id=$1',[db.users.ECOMMERCE_ONLY]);
 await assert.rejects(correction(o,5.7,0,crypto.randomUUID(),other),/FORBIDDEN/);assert.equal((await row(o.id)).codServiceFee,0);
});
test('late failure rolls back fee, journal and financial event; concurrent stale changes commit only one',async()=>{
 const o=await seed({service:0}),id=crypto.randomUUID();await delivery(o);
 await db.admin.query("create function public.qa_cod_fail() returns trigger language plpgsql as $$begin if NEW.kind='courier_fee_adjustment' then raise exception 'SYNTHETIC_LATE_FAILURE';end if;return NEW;end$$;create trigger qa_cod_fail before insert on ledger_events for each row execute function public.qa_cod_fail()");
 try{await assert.rejects(correction(o,5.7,0,id),/SYNTHETIC_LATE_FAILURE/);assert.equal((await row(o.id)).codServiceFee,0);assert.equal((await db.admin.query('select count(*)::int n from financial_private.cod_fee_commands where event_id=$1',[id])).rows[0].n,0);}
 finally{await db.admin.query('drop trigger qa_cod_fail on ledger_events;drop function qa_cod_fail()');}
 const other=await db.client('ADMIN'),r=await Promise.allSettled([correction(o,5.7),correction(o,6.84,0,crypto.randomUUID(),other)]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.match(r.find(x=>x.status==='rejected').reason.message,/STALE/);
});
test('partial fee-inclusive allocation freezes correction and a later multi-order settlement closes exact remaining obligations once',async()=>{
 const a=await seed(),b=await seed({courier:a.courierId,goods:20,shipping:30,fee:44.3});await delivery(a);await delivery(b);
 const id=crypto.randomUUID(),input={orderIds:[a.id],courierId:a.courierId,wallet:'inStoreSafe',netReceived:62.15,allocations:[{orderId:a.id,codPiastres:10000,feePiastres:3785}]};
 const r=(await c.query("select record_courier_batch($1,$2,$3,'courier_batch',$4) r",[id,db.store,db.device,input])).rows[0].r;
 assert.equal(r.netPiastres,6215);assert.equal(r.closedOrderIds.length,0);assert.equal((await row(a.id)).codSettledAt,null);
 await assert.rejects(correction(a,6.84,5.7),/ALREADY_ALLOCATED/);
 const finalId=crypto.randomUUID(),last=await settle([a,b],362.15,finalId);assert.equal(last.codPiastres,45000);assert.equal(last.feePiastres,8785);assert.equal(last.netPiastres,36215);
 assert.equal(last.closedOrderIds.length,2);assert.equal((await settle([a,b],362.15,finalId)).replayed,true);
 assert.equal(await total('receivable_courier',a.courierId),0);assert.equal(await total('payable_courier',a.courierId),0);evidence.push({scenario:'partial then multi-order service settlement',r,last});
});
test('fee audit remains visible after settlement, is tenant/role protected and Mobile operational view withholds service cost from Moderator',async()=>{
 const a=await seed({service:0}),r=await correction(a,5.7);await delivery(a);await settle([a],424.3);
 const audit=(await c.query('select read_cod_fee_audit($1,$2) r',[db.store,a.id])).rows[0].r;assert.equal(audit.length,1);assert.equal(audit[0].id,r.eventId);assert.equal(audit[0].before,0);assert.equal(audit[0].after,5.7);assert.equal(audit[0].actorId,db.users.ADMIN);assert.ok(audit[0].at);
 assert.deepEqual((await c.query('select read_cod_fee_audit($1,$2) r',[db.store,crypto.randomUUID()])).rows[0].r,[]);
 assert.equal(Number((await c.query('select "codServiceFee" from orders_operational where id=$1',[a.id])).rows[0].codServiceFee),5.7);
 db.users.MODERATOR=crypto.randomUUID();await db.admin.query('insert into auth.users values($1,$2,now())',[db.users.MODERATOR,'moderator@qa.invalid']);await db.admin.query('insert into store_members(user_id,store_id,role) values($1,$2,$3)',[db.users.MODERATOR,db.store,'MODERATOR']);
 const moderator=await db.client('MODERATOR');assert.equal((await moderator.query('select "codServiceFee" from orders_operational where id=$1',[a.id])).rows[0].codServiceFee,null);await assert.rejects(moderator.query('select read_cod_fee_audit($1,$2)',[db.store,a.id]),/FORBIDDEN/);
 await assert.rejects(c.query('select * from financial_private.cod_fee_commands'),/permission denied/);evidence.push({scenario:'audit and cost-protected Mobile view',audit});
});
