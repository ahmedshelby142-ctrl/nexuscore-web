import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {openBusinessDb,read,ROOT} from './helpers/business-db.mjs';
import {uiHarness} from './helpers/ui-harness.mjs';
import {buildOrderPlacedLines,buildOrderCancelledLines,buildOrderRTOLines,buildReturnConfirmedLines} from '../src/lib/ledger/orders.ts';
const migrations=['20261012080415_receipt_variant_stock','20261012082556_pos_atomic_exchange','20261012090535_courier_atomic_batch','20261012191715_authoritative_stock_commands','20261012194223_courier_writer_compatibility','20261012203014_catalog_return_compatibility','20261012204812_courier_obligation_compatibility','20261012213602_order_payment_atomic','20261013010850_exchange_credit_lifecycle','20261013015521_customer_trip_atomic_recovery','20261013022600_courier_claim_source_attribution','20261013031632_order_backorder_allocation','20261013111632_scoped_order_activity','20261013120155_store_branded_document_numbers'];
let db,c;const evidence=[];
before(async()=>{db=await openBusinessDb();c=await db.client();for(const m of [...migrations,'20261014094740_courier_cod_service_fee','20261014095804_fixed_asset_accounting'])await db.admin.query(read('supabase/migrations/'+m+'.sql'));});
after(async()=>{if(db){fs.writeFileSync(path.join(ROOT,'logs/final-v1-sprint/exchange-credit-acceptance-'+Date.now()+'.json'),JSON.stringify({scope:'Captured-schema isolated PG17.6 ONLY; not Production',version:db.version,migrations,evidence},null,2));await db.close();}});
const rpc=async(command,input,id=crypto.randomUUID(),client=c)=> (await client.query('select '+({exchange_place:'record_exchange_place',exchange_return:'record_exchange_return',order_delivery:'record_order_delivery',courier_batch:'record_courier_batch',cod_service_fee:'record_cod_service_fee',order_payment:'record_order_payment',order_edit:'record_order_edit',order_cancel:'record_order_cancel',exchange_credit_refund:'record_exchange_credit_refund'}[command])+'($1,$2,$3,$4,$5) r',[id,db.store,db.device,command,input])).rows[0].r;
const order=async(id)=>(await db.admin.query('select to_jsonb(o) r from orders o where id=$1',[id])).rows[0].r;
const effect=async(id,account)=>(await db.admin.query('select coalesce(sum(amount_delta),0)::int n from ledger_lines where event_id=$1 and account=$2',[id,account])).rows[0].n;
const snapshot=async()=>JSON.stringify((await db.admin.query(`select jsonb_build_object('orders',(select jsonb_agg(to_jsonb(o) order by id) from orders o),'products',(select jsonb_agg(to_jsonb(o) order by id) from products o),'events',(select jsonb_agg(to_jsonb(o) order by id) from ledger_events o),'lines',(select jsonb_agg(to_jsonb(o) order by id) from ledger_lines o),'exchanges',(select jsonb_agg(to_jsonb(o) order by id) from financial_private.order_exchanges o),'credits',(select jsonb_agg(to_jsonb(o) order by id) from financial_private.exchange_credit_commands o),'returns',(select jsonb_agg(to_jsonb(o) order by id) from return_records o)) r`)).rows[0].r);
const reject=async(fn,pattern)=>{const before=await snapshot();await assert.rejects(fn,pattern);assert.equal(await snapshot(),before);};
async function fixture({price=300,ship=120,deposit=100,originalQty=1,selectedQty=1,originalPrice=100,originalDiscount=15,bundle=false,replacementBundle=false,cause='customer',courierFee=ship,codServiceFee}={}){
 const catalog=async(price,cost)=>{const id=crypto.randomUUID();await c.query("select record_product_catalog($1,$2,$3,'product_catalog',$4)",[crypto.randomUUID(),db.store,db.device,{action:'create',unitCost:cost,product:{id,name:'H synthetic '+id,sku:id,quantity:10,unitPrice:price,metadata:{variants:[]}}}]);return id;};
 const courier=crypto.randomUUID();await db.insert('couriers',{id:courier,store_id:db.store,device_id:db.device,name:'H synthetic courier '+courier});
 const customer=crypto.randomUUID();await db.insert('customers',{id:customer,store_id:db.store,device_id:db.device,name:'Synthetic H customer',phone:'qa.invalid-'+customer,address:''});
 const source=await catalog(originalPrice,40),replacementProduct=await catalog(price,100);
 let sourceId=source;
 if(bundle){sourceId=crypto.randomUUID();await db.insert('products',{id:sourceId,store_id:db.store,device_id:db.device,name:'H original bundle',sku:sourceId,quantity:0,unitPrice:originalPrice,isBundle:true,bundleItems:[{productId:source,quantity:1}],metadata:{variants:[]}});}
 let replacementIdForItem=replacementProduct;
 if(replacementBundle){replacementIdForItem=crypto.randomUUID();await db.insert('products',{id:replacementIdForItem,store_id:db.store,device_id:db.device,name:'H replacement bundle',sku:replacementIdForItem,quantity:0,unitPrice:price,isBundle:true,bundleItems:[{productId:replacementProduct,quantity:2}],metadata:{variants:[]}});}
 const originalId=crypto.randomUUID(),replacementId=crypto.randomUUID();
 const sourceItem={productId:sourceId,productName:'Historical original',quantity:originalQty,unitPrice:originalPrice,unitCost:40,...(bundle?{bundleId:sourceId,bundleName:'Historical bundle',isBundle:true,bundleItems:[{productId:source,quantity:1,unitCost:40}]}:{})};
 const original={id:originalId,store_id:db.store,device_id:db.device,orderNumber:'H-ORIG-'+originalId,customerId:customer,customerName:'Synthetic H customer',customerPhone:'qa.invalid',items:[sourceItem],stockItems:[{productId:source,quantity:originalQty,unitPrice:originalPrice,unitCost:40,...(bundle?{bundleId:sourceId}: {})}],totalAmount:originalPrice*originalQty-originalDiscount,discountAmount:originalDiscount,shippingFee:0,courierFee:0,courierId:courier,depositAmount:originalPrice*originalQty-originalDiscount,depositWallet:'inStoreSafe',expectedCod:0,paymentMethod:'full_prepaid'};
 await c.query('select place_order($1,$2)',[original,db.event('order_placed','ecommerce_order',original.orderNumber,buildOrderPlacedLines({items:original.stockItems,depositAmount:original.depositAmount,wallet:'inStoreSafe'}))]);
 await c.query("update orders set status='shipped' where id=$1",[originalId]);await rpc('order_delivery',{orderId:originalId,settle:false});
 const replacement={id:replacementId,store_id:db.store,device_id:db.device,orderNumber:'H-REPL-'+replacementId,customerName:'Synthetic H customer',customerPhone:'qa.invalid',items:[{productId:replacementIdForItem,productName:'New replacement',quantity:1,unitPrice:price,unitCost:100,...(replacementBundle?{isBundle:true,bundleId:replacementIdForItem,bundleItems:[{productId:replacementProduct,quantity:2,unitCost:100}]}:{})}],totalAmount:price,discountAmount:0,shippingFee:ship,courierFee,...(codServiceFee===undefined?{}:{codServiceFee}),courierId:courier,depositAmount:deposit,depositWallet:'inStoreSafe',expectedCod:price+ship-deposit,paymentMethod:'partial_cod'};
 const exchangeId=crypto.randomUUID(),input={originalOrderId:originalId,selections:[{lineId:'line:1',quantity:selectedQty}],cause,order:replacement,event:db.event('order_placed','ecommerce_order',replacement.orderNumber,[])};
 const placed=await rpc('exchange_place',input,exchangeId);
 const f={originalId,replacementId,source,replacementProduct,courier,customer,exchangeId,input,placed};evidence.push(f);return f;
}
async function receive(f,{via='courier',fee=0}={}){const id=crypto.randomUUID();const input={exchangeId:f.exchangeId,refundVia:via,wallet:'inStoreSafe',returnFee:fee};const r=await rpc('exchange_return',input,id);return {id,input,r};}
async function deliver(f){await c.query("update orders set status='shipped' where id=$1",[f.replacementId]);const id=crypto.randomUUID();const r=await rpc('order_delivery',{orderId:f.replacementId,settle:false},id);return{id,r};}
async function cancel(f){const o=await order(f.replacementId),id=crypto.randomUUID();const input={orderId:o.id,cause:'shop',event:db.event('order_cancelled','ecommerce_order',o.orderNumber,buildOrderCancelledLines({items:o.stockItems,pendingDeposit:o.depositAmount,wallet:'inStoreSafe',customerId:o.customerId}))};return{id,input,r:await rpc('order_cancel',input,id)};}
const credit=(o)=>o.exchangeDetails.credit;

test('H acceptance: exact 8500 credit /30000 goods /12000 shipping /10000 NEW cash /23500 persisted COD, ledger and settlement',async()=>{
 const f=await fixture();assert.equal(f.placed.order.expectedCod,235);assert.equal(f.placed.order.depositAmount,100);assert.equal(credit(f.placed.order).eligiblePiastres,8500);assert.equal(credit(f.placed.order).allocatedPiastres,8500);assert.equal(await effect(f.exchangeId,'wallet'),10000);
 const ret=await receive(f);assert.equal(await effect(ret.id,'wallet'),0);assert.equal(await effect(ret.id,'receivable_courier'),0);assert.equal(await effect(ret.id,'receivable_client'),-8500);assert.equal(await effect(ret.id,'revenue'),-8500);assert.equal(await effect(ret.id,'cogs'),-4000);assert.equal(await effect(ret.id,'customer_ltv'),-8500);
 const del=await deliver(f);assert.equal(await effect(del.id,'receivable_courier'),23500);assert.equal(await effect(del.id,'receivable_client'),8500);assert.equal(await effect(del.id,'revenue'),30000);assert.equal(await effect(del.id,'payable_courier'),12000);assert.equal(await effect(del.id,'cogs'),10000);assert.equal(credit(await order(f.replacementId)).status,'consumed');
 const obligations=(await c.query('select read_courier_obligations($1,$2) r',[db.store,f.courier])).rows[0].r;assert.equal(obligations.length,1);assert.equal(obligations[0].codPiastres,23500);assert.equal(obligations[0].feePiastres,12000);
 const sid=crypto.randomUUID(),input={courierId:f.courier,orderIds:[f.replacementId],wallet:'inStoreSafe',netReceived:115};const settled=await rpc('courier_batch',input,sid);assert.equal(await effect(sid,'wallet'),11500);assert.equal(await effect(sid,'receivable_courier'),-23500);assert.equal(await effect(sid,'payable_courier'),-12000);assert.ok((await order(f.replacementId)).codSettledAt);assert.equal((await rpc('courier_batch',input,sid)).replayed,true);
 assert.equal((await db.admin.query("select sum(l.amount_delta)::int n from ledger_lines l where store_id=$1 and subject_id=$2 and account='receivable_courier'",[db.store,f.courier])).rows[0].n,0);
 assert.equal((await order(f.replacementId)).expectedCod,235);assert.equal((await order(f.replacementId)).depositAmount,100);const balances=(await db.admin.query("select account,sum(amount_delta)::int amount from ledger_lines where store_id=$1 and event_id in (select id from ledger_events where store_id=$1 and (ref_id=any($2::text[]) or id=$3)) group by account",[db.store,[(await order(f.originalId)).orderNumber,(await order(f.replacementId)).orderNumber],sid])).rows;const b=Object.fromEntries(balances.map(x=>[x.account,x.amount]));assert.equal(b.revenue,30000);assert.equal(b.cogs,10000);assert.equal(b.wallet,30000);assert.equal(b.receivable_courier,0);assert.equal(b.payable_courier,0);assert.equal(b.receivable_client,0);assert.equal(b.revenue-b.cogs,20000);
 const stocks=(await db.admin.query('select id,quantity from products where id=any($1::text[])',[[f.source,f.replacementProduct]])).rows;assert.equal(Number(stocks.find(x=>x.id===f.source).quantity),10);assert.equal(Number(stocks.find(x=>x.id===f.replacementProduct).quantity),9);
 f.reconciliation={returnId:ret.id,deliveryId:del.id,settlementId:sid,settled,balances,stocks,profitPiastres:b.revenue-b.cogs};
});
test('H shipment cannot earn or collect an unreceived original credit; physical confirmation and placement replay are exact',async()=>{
 const f=await fixture();await c.query("update orders set status='shipped' where id=$1",[f.replacementId]);await reject(()=>rpc('order_delivery',{orderId:f.replacementId,settle:false}),/PHYSICAL_RETURN_REQUIRED/);
 assert.equal((await rpc('exchange_place',f.input,f.exchangeId)).replayed,true);const ret=await receive(f);assert.equal((await rpc('exchange_return',ret.input,ret.id)).replayed,true);await reject(()=>receive(f),/تم تأكيد/);assert.equal(credit(await order(f.replacementId)).allocatedPiastres,8500);
});
test('H cheaper and equal replacement: cap allocation; cash excess is separate and never double deducted',async()=>{
 for(const via of ['wallet','courier']){const f=await fixture({price:50,ship:0,deposit:0});assert.equal(f.placed.order.expectedCod,0);assert.equal(credit(f.placed.order).allocatedPiastres,5000);assert.equal(credit(f.placed.order).excessPiastres,3500);const ret=await receive(f,{via});assert.equal(await effect(ret.id,'wallet'),via==='wallet'?-3500:0);assert.equal(await effect(ret.id,'receivable_courier'),via==='wallet'?0:-3500);await deliver(f);const obs=(await c.query('select read_courier_obligations($1,$2) r',[db.store,f.courier])).rows[0].r;assert.equal(obs.length,via==='wallet'?0:1);if(obs.length)assert.equal(obs[0].codPiastres,-3500);}
 const equal=await fixture({price:85,ship:0,deposit:0});assert.equal(equal.placed.order.expectedCod,0);assert.equal(credit(equal.placed.order).excessPiastres,0);await receive(equal,{via:'wallet'});await deliver(equal);
});
test('H cancellation BEFORE physical receipt releases original unit ownership without refunding unearned credit',async()=>{
 const f=await fixture();const result=await cancel(f);assert.equal(credit(result.r.order).status,'released');assert.equal(credit(result.r.order).allocatedPiastres,0);assert.equal((await rpc('order_cancel',result.input,result.id)).replayed,true);await reject(()=>receive(f),/ملغي/);
 const retryInput=structuredClone(f.input);retryInput.order.id=crypto.randomUUID();retryInput.order.orderNumber='H-RETRY-'+crypto.randomUUID();const repl=await rpc('exchange_place',retryInput);assert.equal(credit(repl.order).allocatedPiastres,8500);
});
test('H cancellation AFTER physical receipt retains exact earned credit as recoverable refund due; atomic wallet disposition and replay',async()=>{
 const f=await fixture();await receive(f);const result=await cancel(f);assert.equal(credit(result.r.order).status,'refund_due');assert.equal((await db.admin.query('select status from financial_private.order_exchanges where id=$1',[f.exchangeId])).rows[0].status,'confirmed');
 const id=crypto.randomUUID(),input={orderId:f.replacementId,amount:85,wallet:'inStoreSafe',expectedAllocatedPiastres:8500};const r=await rpc('exchange_credit_refund',input,id);assert.equal(credit(r.order).status,'refunded');assert.equal(credit(r.order).allocatedPiastres,0);assert.equal(await effect(id,'wallet'),-8500);assert.equal(await effect(id,'receivable_client'),8500);assert.equal((await rpc('exchange_credit_refund',input,id)).replayed,true);await reject(()=>rpc('exchange_credit_refund',input),/NOT_OPEN/);
 const again=structuredClone(f.input);again.order.id=crypto.randomUUID();again.order.orderNumber='H-DOUBLE-'+crypto.randomUUID();await reject(()=>rpc('exchange_place',again),/وحدات|متاح|كمية|استبدال/);
});
test('H new top-ups preserve atomic payment journal, cash deposit and allocated original credit independently',async()=>{
 const f=await fixture();await receive(f);const id=crypto.randomUUID(),input={orderId:f.replacementId,amount:35,wallet:'vodafoneCash',expectedDeposit:100,expectedCod:235};const paid=await rpc('order_payment',input,id);assert.equal(paid.order.depositAmount,135);assert.equal(paid.order.expectedCod,200);assert.equal(credit(paid.order).allocatedPiastres,8500);await deliver(f);assert.equal((await rpc('order_payment',input,id)).replayed,true);
 const obs=(await c.query('select read_courier_obligations($1,$2) r',[db.store,f.courier])).rows[0].r;assert.equal(obs[0].codPiastres,20000);
});
test('H partial allocation refund increases only outstanding COD, preserves cash deposit, and prevents double credit',async()=>{
 const f=await fixture();await receive(f);const id=crypto.randomUUID(),input={orderId:f.replacementId,amount:20.01,wallet:'bankAccount',expectedAllocatedPiastres:8500};const refunded=await rpc('exchange_credit_refund',input,id);assert.equal(refunded.order.expectedCod,255.01);assert.equal(refunded.order.depositAmount,100);assert.equal(credit(refunded.order).allocatedPiastres,6499);assert.equal(credit(refunded.order).refundedAllocationPiastres,2001);assert.equal((await rpc('exchange_credit_refund',input,id)).replayed,true);await reject(()=>rpc('exchange_credit_refund',input),/STALE_OR_EXCESS/);await deliver(f);assert.equal((await c.query('select read_courier_obligations($1,$2) r',[db.store,f.courier])).rows[0].r[0].codPiastres,25501);
});
test('H editing pending replacement recomputes reserved credit; confirmed credit is preserved or explicitly refunded first',async()=>{
 const f=await fixture({price:300,ship:0,deposit:0});
 const edit=async(price)=>{const o=await order(f.replacementId),items=o.items.map(x=>({...x,unitPrice:price}));return rpc('order_edit',{orderId:o.id,before:{items:o.items,stockItems:o.stockItems,totalAmount:o.totalAmount,discountAmount:o.discountAmount,depositAmount:o.depositAmount},patch:{items,stockItems:o.stockItems,totalAmount:price,discountAmount:0}});};
 const edited=await edit(50);assert.equal(edited.order.expectedCod,0);assert.equal(credit(edited.order).allocatedPiastres,5000);await receive(f,{via:'wallet'});await reject(()=>edit(40),/REFUND_CREDIT_BEFORE_EDIT/);
 await rpc('exchange_credit_refund',{orderId:f.replacementId,amount:10,wallet:'inStoreSafe',expectedAllocatedPiastres:5000});const cheap=await edit(40);assert.equal(cheap.order.expectedCod,0);assert.equal(credit(cheap.order).allocatedPiastres,4000);await deliver(f);
});
test('H partial original units, historical discounted piastres and concurrent ownership remain exact',async()=>{
 const f=await fixture({originalQty:2,originalPrice:1,originalDiscount:0.01,selectedQty:1,price:10,ship:0,deposit:0});assert.equal(credit(f.placed.order).eligiblePiastres,100);
 const input=structuredClone(f.input);input.order.id=crypto.randomUUID();input.order.orderNumber='H-LAST-'+crypto.randomUUID();const remaining=await rpc('exchange_place',input);assert.equal(credit(remaining.order).eligiblePiastres,99);
 const third=structuredClone(input);third.order.id=crypto.randomUUID();third.order.orderNumber='H-EXCESS-'+crypto.randomUUID();await reject(()=>rpc('exchange_place',third),/وحدات|كمية|استبدال/);await receive(f);await deliver(f);
});
test('H late required document failure rolls back returned credit, stock, ledger and retry identity',async()=>{
 const f=await fixture();await db.admin.query(`create function public.synthetic_h_fail() returns trigger language plpgsql as $$begin if NEW.id='${f.replacementId}' then raise exception 'SYNTHETIC_H_LATE_FAILURE';end if;return NEW;end$$;create trigger synthetic_h_fail before update on orders for each row execute function synthetic_h_fail()`);
 try{await reject(()=>receive(f),/SYNTHETIC_H_LATE_FAILURE/);}finally{await db.admin.query('drop trigger synthetic_h_fail on orders;drop function synthetic_h_fail()');}
 await receive(f);const before=await order(f.replacementId);assert.equal(credit(before).status,'applied');
});
test('H concurrent credit refunds cannot exceed the original earned credit; one expected baseline wins',async()=>{
 const f=await fixture();await receive(f);const other=await db.client();const input={orderId:f.replacementId,amount:85,wallet:'inStoreSafe',expectedAllocatedPiastres:8500};const results=await Promise.allSettled([rpc('exchange_credit_refund',input,crypto.randomUUID(),c),rpc('exchange_credit_refund',input,crypto.randomUUID(),other)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(credit(await order(f.replacementId)).refundedAllocationPiastres,8500);
});
test('H forged credit documents, counterparties, foreign tenant and accountant-only callers fail without side effects',async()=>{
 const f=await fixture();await receive(f);await reject(()=>c.query('update orders set "exchangeDetails"=jsonb_set("exchangeDetails",\'{credit,allocatedPiastres}\',\'0\') where id=$1',[f.replacementId]),/تفاصيل|SOURCE_REVIEW/);await reject(()=>c.query('update orders set "courierId"=$1 where id=$2',[crypto.randomUUID(),f.replacementId]),/COURIER_IMMUTABLE/);
 const accountant=await db.client('ACCOUNTANT');await reject(()=>rpc('exchange_credit_refund',{orderId:f.replacementId,amount:1,wallet:'inStoreSafe',expectedAllocatedPiastres:8500},crypto.randomUUID(),accountant),/FORBIDDEN/);
});

test('H historical bundle credit restores original components and COGS after current recipe changes',async()=>{
 const f=await fixture({bundle:true});const original=await order(f.originalId);await db.admin.query('update products set "bundleItems"=$1 where id=$2',[JSON.stringify([{productId:f.replacementProduct,quantity:3}]),original.items[0].bundleId]);
 const ret=await receive(f);assert.equal(await effect(ret.id,'stock'),4000);assert.equal(await effect(ret.id,'cogs'),-4000);assert.equal(Number((await db.admin.query('select quantity from products where id=$1',[f.source])).rows[0].quantity),10);await deliver(f);assert.equal((await order(f.replacementId)).expectedCod,235);
});
test('H repeated exchange values the delivered replacement gross sale, not its original cash deposit or reused old credit',async()=>{
 const f=await fixture();await receive(f);await deliver(f);const input=structuredClone(f.input);input.originalOrderId=f.replacementId;input.order.id=crypto.randomUUID();input.order.orderNumber='H-REPEATED-'+crypto.randomUUID();const second=await rpc('exchange_place',input);assert.equal(credit(second.order).eligiblePiastres,30000);assert.equal(credit(second.order).allocatedPiastres,30000);assert.equal(second.order.depositAmount,100);assert.equal(second.order.expectedCod,20);
});
test('H RTO retains earned original credit as refund due, keeps courier money independent, and restores replacement stock',async()=>{
 const f=await fixture({codServiceFee:5.7});await receive(f);await c.query("update orders set status='shipped' where id=$1",[f.replacementId]);await c.query("update orders set status='returned' where id=$1",[f.replacementId]);const o=await order(f.replacementId);
 const event=db.event('rto_confirmed','ecommerce_order',o.orderNumber,buildOrderRTOLines({items:o.stockItems,courierId:o.courierId,returnFee:0}));
 await c.query("select confirm_order_return($1,'shop','return',$2,null)",[o.id,JSON.stringify([event])]);assert.equal(credit(await order(o.id)).status,'refund_due');
 const obligations=(await c.query('select read_courier_obligations($1,$2) r',[db.store,f.courier])).rows[0].r;assert.equal(obligations.length,0);
 assert.equal((await db.admin.query("select sum(amount_delta)::int n from ledger_lines where store_id=$1 and account='receivable_client' and subject_id=$2",[db.store,'exchange-credit:'+f.exchangeId])).rows[0].n,-8500);
 await rpc('exchange_credit_refund',{orderId:o.id,amount:85,wallet:'inStoreSafe',expectedAllocatedPiastres:8500});assert.equal(credit(await order(o.id)).status,'refunded');assert.equal(Number((await db.admin.query('select quantity from products where id=$1',[f.replacementProduct])).rows[0].quantity),10);
});
test('H required refund-document suppression rolls back wallet, ledger and private disposition',async()=>{
 const f=await fixture();await receive(f);await db.admin.query(`create function public.synthetic_h_suppress() returns trigger language plpgsql as $$begin if NEW.id='${f.replacementId}' then return null;end if;return NEW;end$$;create trigger a_synthetic_h_suppress before update on orders for each row execute function synthetic_h_suppress()`);
 try{await reject(()=>rpc('exchange_credit_refund',{orderId:f.replacementId,amount:85,wallet:'inStoreSafe',expectedAllocatedPiastres:8500}),/DOCUMENT_REQUIRED/);}finally{await db.admin.query('drop trigger a_synthetic_h_suppress on orders;drop function synthetic_h_suppress()');}
});
test('H same-intent concurrent refund replay commits one wallet movement and returns the original result',async()=>{
 const f=await fixture();await receive(f);const other=await db.client(),id=crypto.randomUUID(),input={orderId:f.replacementId,amount:85,wallet:'inStoreSafe',expectedAllocatedPiastres:8500};const results=await Promise.all([rpc('exchange_credit_refund',input,id),rpc('exchange_credit_refund',input,id,other)]);assert.equal(results.filter(x=>x.replayed).length,1);assert.equal(await effect(id,'wallet'),-8500);assert.equal(credit(await order(f.replacementId)).refundedAllocationPiastres,8500);
});

test('H earned pending credit is customer-owned and cannot reduce another order courier collection',async()=>{
 const f=await fixture();await receive(f);const other={...f.input.order,id:crypto.randomUUID(),orderNumber:'H-OTHER-'+crypto.randomUUID(),depositAmount:0,expectedCod:420,stockItems:f.input.order.items};
 await c.query('select place_order($1,$2)',[other,db.event('order_placed','ecommerce_order',other.orderNumber,buildOrderPlacedLines({items:other.items,depositAmount:0}))]);await c.query("update orders set status='shipped' where id=$1",[other.id]);await rpc('order_delivery',{orderId:other.id,settle:false});
 const obs=(await c.query('select read_courier_obligations($1,$2) r',[db.store,f.courier])).rows[0].r;assert.equal(obs.length,1);assert.equal(obs[0].codPiastres,42000);
 await rpc('courier_batch',{courierId:f.courier,orderIds:[other.id],wallet:'inStoreSafe',netReceived:300});assert.equal(credit(await order(f.replacementId)).allocatedPiastres,8500);
});
test('H cancelling a cheaper replacement keeps actual excess courier refund independent of remaining customer credit',async()=>{
 const f=await fixture({price:50,ship:0,deposit:0});await receive(f);await cancel(f);const obs=(await c.query('select read_courier_obligations($1,$2) r',[db.store,f.courier])).rows[0].r;assert.equal(obs[0].codPiastres,-3500);
 await rpc('courier_batch',{courierId:f.courier,orderIds:[f.replacementId],wallet:'inStoreSafe',netReceived:-35});assert.equal(credit(await order(f.replacementId)).status,'refund_due');
 await rpc('exchange_credit_refund',{orderId:f.replacementId,amount:50,wallet:'inStoreSafe',expectedAllocatedPiastres:5000});assert.equal(credit(await order(f.replacementId)).status,'refunded');
});
test('H altered credit line fails deferred reconciliation and rolls back the entire physical return',async()=>{
 const f=await fixture();await db.admin.query(`create function synthetic_h_credit_line() returns trigger language plpgsql as $$begin if NEW.subject_id='exchange-credit:${f.exchangeId}' then NEW.amount_delta:=-1;end if;return NEW;end$$;create trigger synthetic_h_credit_line before insert on ledger_lines for each row execute function synthetic_h_credit_line()`);
 try{await reject(()=>receive(f),/CREDIT_LEDGER_REQUIRED/);}finally{await db.admin.query('drop trigger synthetic_h_credit_line on ledger_lines;drop function synthetic_h_credit_line()');}
});
test('H actual financial client resolves committed refund response loss after reload using one stable identity',async()=>{
 const f=await fixture();await receive(f);let losses=2;const storage={},calls=[];globalThis.sessionStorage={getItem:k=>storage[k]??null,setItem:(k,v)=>storage[k]=v,removeItem:k=>delete storage[k]};
 const stubs={'@/lib/supabase':{getSupabaseClient:()=>({async rpc(name,args){assert.equal(name,'record_exchange_credit_refund');calls.push(args.p_id);const data=await rpc('exchange_credit_refund',args.p_input,args.p_id);if(losses-->0)throw Error('SYNTHETIC_COMMITTED_RESPONSE_LOSS');return {data,error:null};}})},'@/services/api/storeContext':{getSyncIdentity:async()=>({storeId:db.store,deviceId:db.device})}};
 const scope='exchange_credit_refund:'+f.replacementId;
 try{await assert.rejects(uiHarness(stubs).load('src/lib/financialCommand.ts').runFinancialCommand('exchange_credit_refund',{orderId:f.replacementId,amount:85,wallet:'inStoreSafe',expectedAllocatedPiastres:8500},scope),/لم يصل تأكيد العملية/);const recovered=await uiHarness(stubs).load('src/lib/financialCommand.ts').resolvePendingFinancialCommand(scope);assert.equal(recovered.replayed,true);assert.equal(new Set(calls).size,1);assert.equal(await effect(calls[0],'wallet'),-8500);assert.equal(Object.keys(storage).length,0);evidence.push({case:'actual client committed refund loss/reload',order:f.replacementId,operation:calls[0],attempts:calls.length});}finally{delete globalThis.sessionStorage;}
});

test('H product-to-bundle replacement reserves components, consumes credit once and keeps historical COGS on delivery',async()=>{
 const f=await fixture({replacementBundle:true});assert.equal(f.placed.order.expectedCod,235);assert.equal(f.placed.order.stockItems[0].productId,f.replacementProduct);assert.equal(f.placed.order.stockItems[0].quantity,2);await receive(f);const d=await deliver(f);assert.equal(await effect(d.id,'cogs'),20000);assert.equal(await effect(d.id,'receivable_courier'),23500);assert.equal(Number((await db.admin.query('select quantity from products where id=$1',[f.replacementProduct])).rows[0].quantity),8);
});
test('H deposits0/50/100 and final atomic top-up keep original credit separate; zero customer COD leaves only true courier fee',async()=>{
 for(const deposit of [0,50,100]){const f=await fixture({deposit});assert.equal(f.placed.order.expectedCod,335-deposit);await receive(f);const paid=await rpc('order_payment',{orderId:f.replacementId,amount:335-deposit,wallet:'instaPay',expectedDeposit:deposit,expectedCod:335-deposit});assert.equal(paid.order.depositAmount,335);assert.equal(paid.order.expectedCod,0);const d=await deliver(f);assert.equal(await effect(d.id,'receivable_courier'),0);assert.equal(await effect(d.id,'receivable_client'),8500);const obs=(await c.query('select read_courier_obligations($1,$2) r',[db.store,f.courier])).rows[0].r;assert.equal(obs[0].codPiastres,0);assert.equal(obs[0].feePiastres,12000);await rpc('courier_batch',{courierId:f.courier,orderIds:[f.replacementId],wallet:'inStoreSafe',netReceived:-120});}
});
test('H shop/courier responsibility preserves zero customer shipping and distinguishes true customer COD from courier compensation',async()=>{
 for(const cause of ['shop','courier']){const f=await fixture({ship:0,courierFee:120,cause,codServiceFee:5.7});assert.equal(f.placed.order.expectedCod,115);await receive(f);const d=await deliver(f);assert.equal(await effect(d.id,'receivable_client'),8500);assert.equal(await effect(d.id,'receivable_courier'),cause==='shop'?11500:23500);assert.equal(await effect(d.id,'payable_courier'),12570);assert.equal(await effect(d.id,'expense'),cause==='shop'?12570:570);assert.equal((await order(f.replacementId)).expectedCod,115);await rpc('courier_batch',{courierId:f.courier,orderIds:[f.replacementId],wallet:'inStoreSafe',netReceived:cause==='shop'?-10.7:109.3});}
});
test('H full delivered replacement return restores its historical cost without refunding the consumed original credit twice',async()=>{
 const f=await fixture({replacementBundle:true});await receive(f);await deliver(f);await c.query("update orders set status='returned' where id=$1",[f.replacementId]);const o=await order(f.replacementId),id=crypto.randomUUID();const lines=buildReturnConfirmedLines({items:o.stockItems,refundAmount:300,revenueAmount:300,wallet:'inStoreSafe',returnFee:0,movement:'return',customerId:o.customerId});await c.query("select confirm_order_return($1,'shop','return',$2,$3)",[o.id,JSON.stringify([{...db.event('return_confirmed','ecommerce_order',o.orderNumber,lines),id}]),o.customerId]);assert.equal(credit(await order(o.id)).status,'consumed');assert.equal(await effect(id,'wallet'),-30000);assert.equal(await effect(id,'cogs'),-20000);assert.equal(Number((await db.admin.query('select quantity from products where id=$1',[f.replacementProduct])).rows[0].quantity),10);await reject(()=>rpc('exchange_credit_refund',{orderId:o.id,amount:85,wallet:'inStoreSafe',expectedAllocatedPiastres:8500}),/NOT_OPEN/);
});
test('H courier compensation without customer COD never becomes collection-service eligibility',async()=>{
 const f=await fixture({ship:0,courierFee:120,cause:'courier',deposit:215,codServiceFee:5.7});await receive(f);assert.equal((await order(f.replacementId)).expectedCod,0);
 const delivered=await deliver(f);assert.equal(await effect(delivered.id,'receivable_courier'),12000);assert.equal(await effect(delivered.id,'payable_courier'),12000);assert.equal(await effect(delivered.id,'expense'),0);
 await assert.rejects(rpc('cod_service_fee',{orderId:f.replacementId,before:5.7,amount:6.84,reason:'Synthetic statement'}),/NO_COLLECTION/);
 const settled=await rpc('courier_batch',{courierId:f.courier,orderIds:[f.replacementId],wallet:'inStoreSafe',netReceived:0});assert.equal(await effect(settled.eventId,'wallet'),0);
});

test('A/H actual scoped history includes physical credit return, real credit refund and batch settlement once without money/cost exposure',async()=>{
 const f=await fixture(),ret=await receive(f),rid=crypto.randomUUID(),rid2=crypto.randomUUID();await rpc('exchange_credit_refund',{orderId:f.replacementId,amount:10,wallet:'inStoreSafe',expectedAllocatedPiastres:8500},rid);await rpc('exchange_credit_refund',{orderId:f.replacementId,amount:10.01,wallet:'inStoreSafe',expectedAllocatedPiastres:7500},rid2);
 const del=await deliver(f),sid=crypto.randomUUID();await rpc('courier_batch',{courierId:f.courier,orderIds:[f.replacementId],wallet:'inStoreSafe',netReceived:135.01},sid);
 const before=await snapshot(),rows=(await c.query('select * from read_order_activity($1,$2)',[db.store,f.replacementId])).rows;
 evidence.push({case:'scoped activity diagnostic',expected:{placement:f.exchangeId,physicalReturn:ret.id,creditRefund:rid,secondCreditRefund:rid2,delivery:del.id,settlement:sid},document:await order(f.replacementId),rows,events:(await db.admin.query('select id,kind,ref_type,ref_id,payload from ledger_events where id=any($1::text[])',[[f.exchangeId,ret.id,rid,rid2,del.id,sid]])).rows});
 for(const [name,id] of Object.entries({placement:f.exchangeId,physicalReturn:ret.id,creditRefund:rid,secondCreditRefund:rid2,delivery:del.id,settlement:sid}))assert.equal(rows.filter(r=>r.id===id).length,1,name+' '+id);
 assert.equal(rows.find(r=>r.id===rid).label,'رد رصيد استبدال');assert.equal(rows.find(r=>r.id===rid2).label,'رد رصيد استبدال');assert.equal(rows.find(r=>r.id===sid).label,'تسوية مع المندوب');assert.equal(await snapshot(),before);
 const user=crypto.randomUUID();await db.admin.query('insert into auth.users values($1,$2,now())',[user,user+'@qa.invalid']);await db.insert('store_members',{user_id:user,store_id:db.store,role:'MODERATOR'});const mod=await db.client();await mod.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
 const projected=(await mod.query('select * from read_order_activity($1,$2)',[db.store,f.replacementId])).rows;assert.deepEqual(projected,rows);assert.deepEqual(Object.keys(projected[0]).sort(),['id','kind','label','occurred_at']);
 await assert.rejects(()=>mod.query('select * from read_order_activity($1,$2)',[crypto.randomUUID(),f.replacementId]),/NEXUS_ORDER_ACTIVITY_FORBIDDEN/);
 evidence.push({case:'scoped shared history, no money fields',orderId:f.replacementId,eventIds:rows.map(r=>r.id),refundId:rid,settlementId:sid});
});
test('H235 with5.70 collection service keeps original credit/deposit/COD distinct and settles109.30 exactly',async()=>{
 const f=await fixture({codServiceFee:5.7});assert.equal((await order(f.replacementId)).expectedCod,235);
 await receive(f);await c.query("update orders set status='shipped' where id=$1",[f.replacementId]);
 const delivered=await rpc('order_delivery',{orderId:f.replacementId,settle:false});
 assert.equal(await effect(delivered.eventId,'receivable_courier'),23500);
 assert.equal(await effect(delivered.eventId,'payable_courier'),12570);
 assert.equal(await effect(delivered.eventId,'expense'),570);
 const result=await rpc('courier_batch',{courierId:f.courier,orderIds:[f.replacementId],wallet:'inStoreSafe',netReceived:109.3});
 assert.equal(result.netPiastres,10930);assert.equal(result.shortfallPiastres,0);
 assert.equal((await order(f.replacementId)).expectedCod,235);
 assert.equal((await order(f.replacementId)).exchangeDetails.credit.allocatedPiastres,8500);
 assert.equal((await order(f.replacementId)).depositAmount,100);
 evidence.push({scenario:'H235 with service fee',f,delivered,result});
});
