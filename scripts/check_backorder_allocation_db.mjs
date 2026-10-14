// Actual captured-schema loopback PG17.6. No cloud credentials or writes.
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openBusinessDb,read,ROOT} from './helpers/business-db.mjs';
import {buildSaleLines} from '../src/lib/ledger/sales.ts';
import {buildReturnConfirmedLines,buildOrderPlacedLines} from '../src/lib/ledger/orders.ts';
const migrations=['20261012080415_receipt_variant_stock','20261012082556_pos_atomic_exchange','20261012090535_courier_atomic_batch','20261012191715_authoritative_stock_commands','20261012194223_courier_writer_compatibility','20261012203014_catalog_return_compatibility','20261012204812_courier_obligation_compatibility','20261012213602_order_payment_atomic','20261013010850_exchange_credit_lifecycle','20261013015521_customer_trip_atomic_recovery','20261013022600_courier_claim_source_attribution','20261013031632_order_backorder_allocation','20261013111632_scoped_order_activity','20261013120155_store_branded_document_numbers'];
let db,c;const evidence=[];
before(async()=>{db=await openBusinessDb();c=await db.client();for(const m of migrations)await db.admin.query(read('supabase/migrations/'+m+'.sql'));});
after(async()=>{if(db){fs.writeFileSync(path.join(ROOT,'logs/final-v1-sprint/backorder-allocation-'+Date.now()+'.json'),JSON.stringify({scope:'isolated PostgreSQL17.6 only; NOT Production',version:db.version,migrations,evidence},null,2));await db.close();}});
const current=async(id)=>(await db.admin.query('select to_jsonb(o) r from orders o where id=$1',[id])).rows[0]?.r;
const stock=async(id)=>(await db.admin.query("select coalesce(sum(qty_delta::numeric),0)::float8 qty,coalesce(sum(amount_delta),0)::int piastres from ledger_lines where store_id=$1 and subject_id=$2 and account='stock'",[db.store,id])).rows[0];
const snap=async()=>JSON.stringify((await db.admin.query("select jsonb_build_object('orders',(select jsonb_agg(to_jsonb(x) order by id) from orders x),'products',(select jsonb_agg(to_jsonb(x) order by id) from products x),'events',(select jsonb_agg(to_jsonb(x) order by id) from ledger_events x),'lines',(select jsonb_agg(to_jsonb(x) order by id) from ledger_lines x),'actions',(select jsonb_agg(to_jsonb(x) order by event_id) from financial_private.fulfillment_actions x),'invoices',(select jsonb_agg(to_jsonb(x) order by id) from purchase_invoices x)) r")).rows[0].r);
async function reject(fn,pattern){const before=await snap();await assert.rejects(fn,pattern);assert.equal(await snap(),before);}
async function fixture({variant=false,quantity=3}={}){
 const product=crypto.randomUUID(),supplier=crypto.randomUUID(),courier=crypto.randomUUID(),customer=crypto.randomUUID();
 await db.insert('suppliers',{id:supplier,store_id:db.store,device_id:db.device,companyName:'Synthetic J supplier',contactPerson:'',phone:''});
 await db.insert('couriers',{id:courier,store_id:db.store,device_id:db.device,name:'Synthetic J courier '+courier});
 await db.insert('customers',{id:customer,store_id:db.store,device_id:db.device,name:'Synthetic J customer',phone:'qa.invalid-'+customer,address:''});
 await c.query("select record_product_catalog($1,$2,$3,'product_catalog',$4)",[crypto.randomUUID(),db.store,db.device,{action:'create',unitCost:2,product:{id:product,name:'J product',sku:product,quantity:quantity+(variant?4:0),unitPrice:10,metadata:{variants:variant?[{name:'RED',stock:quantity},{name:'BLUE',stock:4}]:[]}}}]);
 return {product,supplier,courier,customer,variant};
}
function draft(f,quantity=5,{deposit=0}={}){
 const id=crypto.randomUUID(),item={id:crypto.randomUUID(),productId:f.product,productName:'J product',quantity,unitPrice:10,unitCost:2,...(f.variant?{variantName:'RED'}:{})};
 const order={id,store_id:db.store,device_id:db.device,orderNumber:'J-'+id,customerId:f.customer,customerName:'Synthetic J customer',customerPhone:'qa.invalid',courierId:f.courier,items:[item],stockItems:[item],totalAmount:quantity*10,discountAmount:0,shippingFee:2,courierFee:2,depositAmount:deposit,depositWallet:'inStoreSafe',expectedCod:quantity*10+2-deposit,paymentMethod:'partial_cod',fulfillment:{version:1,allowBackorder:true}};
 return {order,event:db.event('order_placed','ecommerce_order',order.orderNumber,buildOrderPlacedLines({items:[item],depositAmount:deposit,wallet:'inStoreSafe'}))};
}
const place=async(d,client=c)=>(await client.query('select place_order($1,$2) r',[d.order,d.event])).rows[0].r;
const receipt=async(f,quantity=3,{cost=3,paid=0,variant=f.variant?'RED':undefined,id=crypto.randomUUID(),client=c}={})=>(await client.query("select record_financial_command($1,$2,$3,'receipt',$4) r",[id,db.store,db.device,{stockMirrorVersion:1,supplierId:f.supplier,paidAmount:paid,wallet:'inStoreSafe',items:[{productId:f.product,productName:'J product',variantName:variant,quantity,unitCost:cost}]}])).rows[0].r;
const allocation=(o)=>o.fulfillment.demands.map(d=>({requested:Number(d.quantity),allocated:Number(d.allocated),missing:Number(d.missing)}));
test('5 requested /3 ATP /2 missing persists exact plain and RED reservation, receipt3 allocates2 leaves1',async()=>{
 for(const variant of [false,true]){
  const f=await fixture({variant}),d=draft(f),r=await place(d);assert.equal(r.replayed,false);
  assert.deepEqual(allocation(r.order),[{requested:5,allocated:3,missing:2}]);assert.equal(r.order.items[0].quantity,5);assert.equal(r.order.stockItems[0].quantity,3);assert.equal(Number(r.order.expectedCod),52);
  assert.deepEqual(await stock(f.product),{qty:variant?4:0,piastres:variant?800:0});
  await reject(()=>c.query("update orders set status='shipped' where id=$1",[d.order.id]),/NEXUS_FULFILLMENT_INCOMPLETE/);
  const supplied=await receipt(f),o=await current(d.order.id);assert.deepEqual(allocation(o),[{requested:5,allocated:5,missing:0}]);assert.equal(o.status,'pending');assert.equal(Number(o.expectedCod),52);assert.equal(Number(o.cogsAmount),variant?10.86:12);
  assert.equal((await stock(f.product)).qty,variant?5:1);
  const changes=(await db.admin.query("select account,sum(amount_delta)::int piastres,sum(qty_delta::numeric)::float8 qty from ledger_lines where event_id=$1 group by account",['allocation:'+supplied.eventId+':'+o.id])).rows;
  assert.equal(changes.length,1);assert.equal(changes[0].account,'stock');assert.equal(changes[0].qty,-2);
  await c.query("update orders set status='shipped' where id=$1",[o.id]);
  const delivered=(await c.query("select record_order_delivery($1,$2,$3,'order_delivery',$4) r",[crypto.randomUUID(),db.store,db.device,{orderId:o.id,settle:false}])).rows[0].r;
  assert.equal((await current(o.id)).status,'delivered');evidence.push({case:'5/3/2 then+3',variant,...f,placement:r.order,receipt:supplied,allocated:o,delivered,changes,stock:await stock(f.product)});
 }
});
test('zero-stock accepted order contains demand without stock/revenue and cancellation/replay restores no phantom units',async()=>{
 const f=await fixture({quantity:0}),d=draft(f),r=await place(d);assert.deepEqual(allocation(r.order),[{requested:5,allocated:0,missing:5}]);assert.deepEqual(r.order.stockItems,[]);
 assert.equal((await c.query('select place_order($1,$2) r',[d.order,d.event])).rows[0].r.replayed,true);
 const id=crypto.randomUUID(),input={orderId:d.order.id,cause:'customer'};
 const cancelled=(await c.query("select record_order_cancel($1,$2,$3,'order_cancel',$4) r",[id,db.store,db.device,input])).rows[0].r;assert.equal(cancelled.order.status,'cancelled');assert.deepEqual(await stock(f.product),{qty:0,piastres:0});
 assert.equal((await c.query("select record_order_cancel($1,$2,$3,'order_cancel',$4) r",[id,db.store,db.device,input])).rows[0].r.replayed,true);
});
test('same-intent placement and receipt replay allocate once; changed intent refuses without writes',async()=>{
 const f=await fixture(),d=draft(f),r=await place(d);const before=await snap();assert.equal((await place(d)).replayed,true);assert.equal(await snap(),before);
 await reject(()=>place({...d,order:{...d.order,totalAmount:999}}),/NEXUS_OPERATION_PAYLOAD_MISMATCH/);
 const id=crypto.randomUUID();await receipt(f,3,{id});const after=await snap();assert.equal((await receipt(f,3,{id})).replayed,true);assert.equal(await snap(),after);
});
test('partial receipts allocate FIFO to distinct original customer orders; exact variant never consumes BLUE',async()=>{
 const f=await fixture({variant:true}),a=draft(f),b=draft(f);await place(a);await place(b);
 await receipt(f,1);assert.deepEqual(allocation(await current(a.order.id)),[{requested:5,allocated:4,missing:1}]);assert.deepEqual(allocation(await current(b.order.id)),[{requested:5,allocated:0,missing:5}]);
 await receipt(f,3,{variant:'BLUE'});assert.deepEqual(allocation(await current(a.order.id)),[{requested:5,allocated:4,missing:1}]);
 await receipt(f,3);assert.deepEqual(allocation(await current(a.order.id)),[{requested:5,allocated:5,missing:0}]);assert.deepEqual(allocation(await current(b.order.id)),[{requested:5,allocated:2,missing:3}]);
 evidence.push({case:'FIFO and exact RED',a:await current(a.order.id),b:await current(b.order.id),stock:await stock(f.product)});
});
test('forged allocation/document/private permit and wrong-role placement are refused',async()=>{
 const f=await fixture(),d=draft(f),r=await place(d);
 await reject(()=>c.query('update orders set fulfillment=$1 where id=$2',[{...r.order.fulfillment,demands:[]},d.order.id]),/NEXUS_FULFILLMENT_COMMAND_REQUIRED/);
 await reject(()=>c.query('insert into financial_private.fulfillment_permits values(1,$1,$2,$3,$4,$5)',[db.store,d.order.id,{},[],[]]),/permission denied/);
 const accountant=await db.client('ACCOUNTANT');await reject(()=>place(draft(f),accountant),/NEXUS_FULFILLMENT_FORBIDDEN/);
});

test('cancel partially reserved order releases only actual3, then allocates to next waiting customer',async()=>{
 const f=await fixture(),a=draft(f),b=draft(f);await place(a);await place(b);
 const id=crypto.randomUUID();await c.query("select record_order_cancel($1,$2,$3,'order_cancel',$4)",[id,db.store,db.device,{orderId:a.order.id,cause:'customer'}]);
 assert.equal((await current(a.order.id)).status,'cancelled');assert.deepEqual(allocation(await current(b.order.id)),[{requested:5,allocated:3,missing:2}]);assert.deepEqual(await stock(f.product),{qty:0,piastres:0});
 const qty=(await db.admin.query("select sum(qty_delta::numeric)::float8 qty from ledger_lines where event_id=$1 and account='stock'",[id])).rows[0].qty;assert.equal(qty,3);
});
test('pending quantity edits preserve retained cost, exact demand and deposit/COD; zero allocations remain editable',async()=>{
 for(const available of [0,3]){
  const f=await fixture({quantity:available}),d=draft(f);await place(d);const old=await current(d.order.id);
  const item={...old.items[0],quantity:7};const patch={items:[item],stockItems:[item],totalAmount:70,discountAmount:0};
  const input={orderId:old.id,before:{items:old.items,stockItems:old.stockItems,totalAmount:old.totalAmount,discountAmount:old.discountAmount,depositAmount:old.depositAmount},patch};
  const id=crypto.randomUUID();const r=(await c.query("select record_order_edit($1,$2,$3,'order_edit',$4) r",[id,db.store,db.device,input])).rows[0].r;
  assert.deepEqual(allocation(r.order),[{requested:7,allocated:available,missing:7-available}]);assert.equal(Number(r.order.expectedCod),72);
  assert.equal((await c.query("select record_order_edit($1,$2,$3,'order_edit',$4) r",[id,db.store,db.device,input])).rows[0].r.replayed,true);
  await receipt(f,8);assert.deepEqual(allocation(await current(old.id)),[{requested:7,allocated:7,missing:0}]);
 }
});
test('required allocation journal/document or late receipt failure rolls back invoice, money, stock and all reservations',async()=>{
 const f=await fixture(),d=draft(f);await place(d);
 await db.admin.query(`create function public.qa_skip_fulfillment() returns trigger language plpgsql as $$ begin if NEW.action='allocation' then return null;end if;return NEW;end $$; create trigger qa_skip_fulfillment before insert on financial_private.fulfillment_actions for each row execute function public.qa_skip_fulfillment()`);
 try{await reject(()=>receipt(f),/NEXUS_FULFILLMENT_ACTION_REQUIRED/);}finally{await db.admin.query('drop trigger qa_skip_fulfillment on financial_private.fulfillment_actions;drop function public.qa_skip_fulfillment()');}
 await db.admin.query(`create function public.qa_fail_fulfillment() returns trigger language plpgsql as $$ begin if NEW.fulfillment is distinct from OLD.fulfillment then raise exception 'QA_LATE_ALLOCATION';end if;return NEW;end $$;create trigger zz_qa_fail_fulfillment after update on orders for each row execute function public.qa_fail_fulfillment()`);
 try{await reject(()=>receipt(f),/QA_LATE_ALLOCATION/);}finally{await db.admin.query('drop trigger zz_qa_fail_fulfillment on orders;drop function public.qa_fail_fulfillment()');}
 assert.deepEqual(allocation(await current(d.order.id)),[{requested:5,allocated:3,missing:2}]);
});
test('concurrent receipts and concurrent new demands cannot double allocate the same exact stock',async()=>{
 const f=await fixture(),a=draft(f),b=draft(f),ca=await db.client(),cb=await db.client();
 await Promise.all([place(a,ca),place(b,cb)]);const totals=async()=>[await current(a.order.id),await current(b.order.id)].reduce((n,o)=>n+Number(o.fulfillment.demands[0].allocated),0);
 assert.equal(await totals(),3);await Promise.all([receipt(f,2,{client:ca}),receipt(f,2,{client:cb})]);assert.equal(await totals(),7);assert.equal((await stock(f.product)).qty,0);
 const [oa,ob]=[await current(a.order.id),await current(b.order.id)];assert.equal(oa.customerId,a.order.customerId);assert.equal(ob.customerId,b.order.customerId);
 evidence.push({case:'concurrent placement/supply',a:oa,b:ob,stock:await stock(f.product)});
});
test('bundle shortage uses saved exact component recipe despite later catalog recipe edit',async()=>{
 const f=await fixture({variant:true}),box=crypto.randomUUID();
 await db.insert('products',{id:box,store_id:db.store,device_id:db.device,name:'J box',sku:box,quantity:0,unitPrice:10,isBundle:true,bundleItems:[{productId:f.product,variantName:'RED',quantity:2}],metadata:{variants:[]}});
 const d=draft(f,3);d.order.items=[{id:crypto.randomUUID(),productId:'',bundleId:box,productName:'J box',quantity:3,unitPrice:10}];
 const r=await place(d);assert.equal(r.order.fulfillment.demands[0].quantity,6);assert.equal(r.order.fulfillment.demands[0].allocated,3);assert.equal(r.order.fulfillment.demands[0].variantName,'RED');
 await c.query('update products set "bundleItems"=$1 where id=$2',[JSON.stringify([{productId:f.product,variantName:'BLUE',quantity:1}]),box]);
 await receipt(f,4);const o=await current(d.order.id);assert.deepEqual(allocation(o),[{requested:6,allocated:6,missing:0}]);assert.equal(o.stockItems[0].variantName,'RED');assert.equal(o.stockItems[0].bundleId,box);
});
test('positive count correction allocates and ordinary POS remains strict on ATP',async()=>{
 const f=await fixture(),d=draft(f);await place(d);
 const p=(await db.admin.query('select to_jsonb(p) r from products p where id=$1',[f.product])).rows[0].r;
 await c.query("select record_product_catalog($1,$2,$3,'product_catalog',$4)",[crypto.randomUUID(),db.store,db.device,{action:'update',expectedUpdatedAt:p.updated_at,unitCost:3,product:{...p,quantity:3}}]);
 assert.deepEqual(allocation(await current(d.order.id)),[{requested:5,allocated:5,missing:0}]);assert.equal((await stock(f.product)).qty,1);
 const items=[{productId:f.product,quantity:2,unitPrice:10,unitCost:3}];await reject(()=>c.query("select record_pos_sale($1,$2,$3,'pos_sale',$4)",[crypto.randomUUID(),db.store,db.device,{kind:'sale',refType:'pos_sale',payload:{walletId:'inStoreSafe',items},lines:buildSaleLines({items,wallet:'inStoreSafe'})}]),/NEXUS_STOCK_SHORT/);
});

test('Desktop model and Mobile SQL reader agree on exact RED customer demand without counting BLUE or subtracting ATP twice',async()=>{
 const f=await fixture({variant:true}),d=draft(f);await place(d);
 const mobile=(await c.query('select * from mobile_shortages($1)',[db.store])).rows.filter(r=>r.product_id===f.product);
 assert.equal(mobile.length,1);assert.equal(Number(mobile[0].required),5);assert.equal(Number(mobile[0].deficit),2);assert.equal(Number(mobile[0].stock),0);
 assert.equal(mobile[0].waiting_orders[0].allocated,3);assert.equal(mobile[0].waiting_orders[0].variantName,'RED');assert.equal(mobile[0].waiting_orders[0].customerPhone,'qa.invalid');
 const operational=(await c.query('select fulfillment from orders_operational where id=$1',[d.order.id])).rows[0];assert.deepEqual(operational.fulfillment,(await current(d.order.id)).fulfillment);
 await receipt(f);assert.equal((await c.query('select * from mobile_shortages($1)',[db.store])).rows.filter(r=>r.product_id===f.product).length,0);
});

test('Admin and Moderator follow-up writes change no financial/order/stock state, replay once and preserve revision conflicts',async()=>{
 const f=await fixture(),d=draft(f);await place(d);const moderator=crypto.randomUUID();await db.admin.query('insert into auth.users values($1,$2,now())',[moderator,moderator+'@qa.invalid']);await db.insert('store_members',{user_id:moderator,store_id:db.store,role:'MODERATOR'});
 const mod=await db.client();await mod.query("select set_config('request.jwt.claim.sub',$1,false)",[moderator]);const before=await snap();
 const id=crypto.randomUUID(),save=async(client,op=id,expected=0,notes='Synthetic procurement note')=>(await client.query('select save_shortage_followup($1,$2,$3,$4,$5,$6) r',[op,db.store,d.order.id,expected,'procurement',notes])).rows[0].r;
 const first=await save(mod);assert.equal(first.followup.revision,1);assert.equal((await save(mod)).replayed,true);assert.equal(await snap(),before,'Notes never write orders, money or stock');
 const note=(await mod.query('select * from order_shortage_followups where store_id=$1 and order_id=$2',[db.store,d.order.id])).rows[0];assert.equal(note.notes,'Synthetic procurement note');
 const reported=(await mod.query('select * from mobile_shortages($1)',[db.store])).rows.find(r=>r.product_id===f.product);assert.equal(reported.waiting_orders[0].followupState,'procurement');assert.equal(reported.waiting_orders[0].followupNotes,note.notes);
 await assert.rejects(()=>save(mod,crypto.randomUUID(),0,'Stale note'),/NEXUS_SHORTAGE_NOTE_STALE/);
 const accountant=await db.client('ACCOUNTANT');await assert.rejects(()=>save(accountant,crypto.randomUUID(),1),/NEXUS_SHORTAGE_FOLLOWUP_FORBIDDEN/);
 await assert.rejects(()=>mod.query('update order_shortage_followups set notes=$1 where order_id=$2',['Raw override',d.order.id]),/permission denied/);
 await assert.rejects(()=>mod.query("select record_financial_command($1,$2,$3,'receipt',$4)",[crypto.randomUUID(),db.store,db.device,{}]),/NEXUS_FINANCE_FORBIDDEN/);
 evidence.push({case:'Moderator nonfinancial note only',orderId:d.order.id,commandId:id,note});
});
test('procurement association retains customer source but never skips an older reservation; unrelated source refuses atomically',async()=>{
 const f=await fixture(),a=draft(f),b=draft(f);await place(a);await place(b);const id=crypto.randomUUID();
 const request={stockMirrorVersion:1,supplierId:f.supplier,paidAmount:0,wallet:'inStoreSafe',items:[{productId:f.product,quantity:2,unitCost:3}],payloadExtra:{shortageOrderId:b.order.id}};
 await c.query("select record_financial_command($1,$2,$3,'receipt',$4)",[id,db.store,db.device,request]);
 assert.deepEqual(allocation(await current(a.order.id)),[{requested:5,allocated:5,missing:0}]);assert.deepEqual(allocation(await current(b.order.id)),[{requested:5,allocated:0,missing:5}]);
 const payload=(await db.admin.query('select payload from ledger_events where id=$1',[id])).rows[0].payload;assert.equal(JSON.parse(payload).shortageOrderId,b.order.id);
 await reject(()=>c.query("select record_financial_command($1,$2,$3,'receipt',$4)",[crypto.randomUUID(),db.store,db.device,{...request,payloadExtra:{shortageOrderId:crypto.randomUUID()}}]),/NEXUS_SHORTAGE_PROCUREMENT_SOURCE_REQUIRED/);
});
test('cash and partial/credit receipts allocate once without charging the customer again or changing the already paid deposit',async()=>{
 for(const paid of [0,3,9]){
  const f=await fixture(),d=draft(f,5,{deposit:10});await place(d);const r=await receipt(f,3,{paid});const o=await current(d.order.id);
  assert.equal(Number(o.depositAmount),10);assert.equal(Number(o.expectedCod),42);assert.deepEqual(allocation(o),[{requested:5,allocated:5,missing:0}]);
  const effects=(await db.admin.query("select account,sum(amount_delta)::int piastres from ledger_lines where event_id=$1 group by account order by account",[r.eventId])).rows;
  assert.equal(effects.find(x=>x.account==='stock').piastres,900);assert.equal(effects.find(x=>x.account==='wallet')?.piastres??0,paid ? -paid*100 : 0);assert.equal(effects.find(x=>x.account==='payable_supplier')?.piastres??0,900-paid*100);
  assert.equal((await db.admin.query("select count(*)::int n from ledger_lines where event_id=$1 and account in ('wallet','revenue','receivable_client','receivable_courier')",['allocation:'+r.eventId+':'+o.id])).rows[0].n,0);
 }
});

test('fully supplied backorder refunds all original units at historical blended piastres without rounding loss',async()=>{
 const f=await fixture({variant:true}),d=draft(f,5,{deposit:52});d.order.paymentMethod='full_prepaid';await place(d);await receipt(f,3);const o=await current(d.order.id);
 await c.query("update orders set status='shipped' where id=$1",[o.id]);await c.query("select record_order_delivery($1,$2,$3,'order_delivery',$4)",[crypto.randomUUID(),db.store,db.device,{orderId:o.id,settle:false}]);
 const returned=[];for(let n=0;n<5;n++){
  const units=[{...o.items[0],quantity:1}],parts=[{...o.stockItems[0],quantity:1,costPiastres:undefined}],id=crypto.randomUUID();
  await c.query("select record_stock_command($1,$2,$3,'stock_event',$4)",[id,db.store,db.device,{kind:'return_confirmed',refType:'ecommerce_order',refId:o.orderNumber,payload:{returnUnits:units,stockItems:parts,return_cause:'customer'},lines:buildReturnConfirmedLines({items:parts,refundAmount:10,revenueAmount:10,wallet:'inStoreSafe',returnFee:0,movement:'return'})}]);
  const effects=(await db.admin.query("select account,sum(amount_delta)::int piastres from ledger_lines where event_id=$1 group by account",[id])).rows;
  returned.push({id,effects});
 }
 const costs=returned.map(r=>r.effects.find(x=>x.account==='stock').piastres);assert.deepEqual(costs,[217,217,218,217,217]);assert.equal(costs.reduce((n,x)=>n+x,0),1086);
 const cogs=(await db.admin.query("select coalesce(sum(l.amount_delta),0)::int n from ledger_lines l join ledger_events e on e.id=l.event_id where e.ref_id=$1 and l.account='cogs'",[o.orderNumber])).rows[0].n;assert.equal(cogs,0);
 evidence.push({case:'five exact blended historical unit refunds',orderId:o.id,returned,cogs,stock:await stock(f.product)});
});

test('fractional WAC shared by exact demands conserves every piastre at reservation, cancellation and supply boundaries',async()=>{
 const f=await fixture({quantity:0});const p=(await db.admin.query('select to_jsonb(p) r from products p where id=$1',[f.product])).rows[0].r;
 await c.query("select record_product_catalog($1,$2,$3,'product_catalog',$4)",[crypto.randomUUID(),db.store,db.device,{action:'update',expectedUpdatedAt:p.updated_at,unitCost:0.005,product:{id:f.product,quantity:2}}]);assert.deepEqual(await stock(f.product),{qty:2,piastres:1});
 const d=draft(f,3);const r=await place(d);assert.equal(Number(r.order.cogsAmount),0.01);assert.deepEqual(await stock(f.product),{qty:0,piastres:0});
 const id=crypto.randomUUID();await c.query("select record_order_cancel($1,$2,$3,'order_cancel',$4)",[id,db.store,db.device,{orderId:r.order.id,cause:'customer'}]);assert.deepEqual(await stock(f.product),{qty:2,piastres:1});
 const partial=draft(f,1);const one=await place(partial);assert.deepEqual(await stock(f.product),{qty:1,piastres:0});assert.equal(Number(one.order.cogsAmount),0.01);
 const last=await place(draft(f,1));assert.equal(Number(last.order.cogsAmount),0);assert.deepEqual(await stock(f.product),{qty:0,piastres:0});
});
test('pending exact shade edit releases only this reservation, retains amounts and can shrink a shortage to ready',async()=>{
 const f=await fixture({variant:true}),d=draft(f);await place(d);let o=await current(d.order.id);
 async function edit(quantity,variant){const item={...o.items[0],quantity,variantName:variant};const input={orderId:o.id,before:{items:o.items,stockItems:o.stockItems,totalAmount:o.totalAmount,discountAmount:o.discountAmount,depositAmount:o.depositAmount},patch:{items:[item],stockItems:[item],totalAmount:quantity*10,discountAmount:0}};
  o=(await c.query("select record_order_edit($1,$2,$3,'order_edit',$4) r",[crypto.randomUUID(),db.store,db.device,input])).rows[0].r.order;}
 await edit(5,'BLUE');assert.deepEqual(allocation(o),[{requested:5,allocated:4,missing:1}]);let p=(await db.admin.query('select metadata from products where id=$1',[f.product])).rows[0];assert.deepEqual(p.metadata.variants.map(v=>v.stock),[3,0]);
 await edit(2,'BLUE');assert.deepEqual(allocation(o),[{requested:2,allocated:2,missing:0}]);assert.equal(Number(o.expectedCod),22);p=(await db.admin.query('select metadata from products where id=$1',[f.product])).rows[0];assert.deepEqual(p.metadata.variants.map(v=>v.stock),[3,2]);
});
test('an archived waiting identity cannot absorb supply or block unrelated receipts; old reservations remain attributable',async()=>{
 const f=await fixture(),d=draft(f);await place(d);await c.query('update products set deleted_at=$1 where id=$2',[Date.now(),f.product]);
 const other=await fixture();await receipt(other);assert.deepEqual(allocation(await current(d.order.id)),[{requested:5,allocated:3,missing:2}]);
 await reject(()=>receipt(f),/PRODUCT|منتج|NEXUS_RECEIPT/);
 await c.query("select record_order_cancel($1,$2,$3,'order_cancel',$4)",[crypto.randomUUID(),db.store,db.device,{orderId:d.order.id,cause:'customer'}]);assert.deepEqual(await stock(f.product),{qty:3,piastres:600});
});
test('top-up before procurement stays atomic and delivery/return of an incomplete plan cannot bypass reservation gates',async()=>{
 const f=await fixture(),d=draft(f,5,{deposit:10});await place(d);const old=await current(d.order.id);
 const payment=(await c.query("select record_order_payment($1,$2,$3,'order_payment',$4) r",[crypto.randomUUID(),db.store,db.device,{orderId:old.id,amount:2,wallet:'inStoreSafe',expectedDeposit:10,expectedCod:42}])).rows[0].r;
 assert.equal(Number(payment.order.depositAmount),12);assert.equal(Number(payment.order.expectedCod),40);
 await reject(()=>c.query("update orders set status='returned' where id=$1",[old.id]),/NEXUS_FULFILLMENT_INCOMPLETE/);
 await reject(()=>c.query("select record_order_delivery($1,$2,$3,'order_delivery',$4)",[crypto.randomUUID(),db.store,db.device,{orderId:old.id,settle:false}]),/NEXUS_DELIVERY|NEXUS_ORDER|NEXUS_FULFILLMENT/);
 await receipt(f);assert.equal(Number((await current(old.id)).depositAmount),12);assert.equal(Number((await current(old.id)).expectedCod),40);
 assert.equal((await place(d)).order.stockItems[0].quantity,5,'Replay returns the current saved allocation, never stale3');
});

test('new source identities are tenant-bounded, while replay remains recoverable after a legitimate customer archive',async()=>{
 const f=await fixture(),d=draft(f);await reject(()=>place({...d,order:{...d.order,customerId:crypto.randomUUID()}}),/NEXUS_FULFILLMENT_COUNTERPARTY_INVALID/);
 await reject(()=>place({...d,order:{...d.order,courierId:crypto.randomUUID()}}),/NEXUS_FULFILLMENT_COUNTERPARTY_INVALID/);
 await place(d);await c.query('update customers set deleted_at=$1 where id=$2',[new Date().toISOString(),f.customer]);assert.equal((await place(d)).replayed,true);
});

test('two sold bundles sharing a component produce one waiting customer/variant row with exact combined demand',async()=>{
 const f=await fixture({variant:true}),a=crypto.randomUUID(),b=crypto.randomUUID();
 for(const id of [a,b])await db.insert('products',{id,store_id:db.store,device_id:db.device,name:'J shared box '+id,sku:id,quantity:0,unitPrice:10,isBundle:true,bundleItems:[{productId:f.product,variantName:'RED',quantity:1}],metadata:{variants:[]}});
 const d=draft(f);d.order.items=[{id:crypto.randomUUID(),productId:'',bundleId:a,productName:'Box A',quantity:2,unitPrice:10},{id:crypto.randomUUID(),productId:'',bundleId:b,productName:'Box B',quantity:3,unitPrice:10}];
 const r=await place(d);assert.equal(r.order.fulfillment.demands.reduce((n,d)=>n+d.allocated,0),3);
 const row=(await c.query('select * from mobile_shortages($1)',[db.store])).rows.find(r=>r.product_id===f.product);assert.equal(Number(row.required),5);assert.equal(Number(row.deficit),2);assert.equal(Number(row.order_count),1);assert.equal(row.waiting_orders.length,1);assert.equal(row.waiting_orders[0].allocated,3);
});

test('Moderator operational readers expose demand and allocation but neither unit cost nor integer historical reservation value',async()=>{
 const f=await fixture(),d=draft(f);await place(d);const id=crypto.randomUUID();await db.admin.query('insert into auth.users values($1,$2,now())',[id,id+'@qa.invalid']);await db.insert('store_members',{user_id:id,store_id:db.store,role:'MODERATOR'});
 const mod=await db.client();await mod.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
 const o=(await mod.query('select * from orders_operational where id=$1',[d.order.id])).rows[0];assert.equal(o.stockItems[0].quantity,3);assert.equal(o.fulfillment.demands[0].missing,2);assert.equal(o.stockItems[0].unitCost,undefined);assert.equal(o.stockItems[0].costPiastres,undefined);
 assert.doesNotMatch(JSON.stringify(o.fulfillment),/unitCost|costPiastres/);await assert.rejects(()=>mod.query('select * from financial_private.fulfillment_actions'),/permission denied/);
});

test('A scoped history separates identical document numbers in two independent authorized tenants and derives each original reference',async()=>{
 const f=await fixture(),d=draft(f);await place(d);const otherStore=crypto.randomUUID(),otherDevice=crypto.randomUUID(),p=crypto.randomUUID(),otherId=crypto.randomUUID(),otherUser=crypto.randomUUID();
 await db.insert('stores',{id:otherStore,name:'Synthetic second tenant'});await db.admin.query("insert into store_licenses(store_id,license_key,valid_until) values($1,$2,now()+interval '1 year')",[otherStore,otherStore]);await db.admin.query('insert into auth.users values($1,$2,now())',[otherUser,otherUser+'@qa.invalid']);await db.insert('store_members',{user_id:otherUser,store_id:otherStore,role:'ADMIN'});const otherClient=await db.client();await otherClient.query("select set_config('request.jwt.claim.sub',$1,false)",[otherUser]);
 await otherClient.query("select record_product_catalog($1,$2,$3,'product_catalog',$4)",[crypto.randomUUID(),otherStore,otherDevice,{action:'create',unitCost:2,product:{id:p,name:'Synthetic second product',sku:p,quantity:3,unitPrice:10,metadata:{variants:[]}}}]);
 const item={productId:p,productName:'Synthetic second product',quantity:1,unitPrice:10,unitCost:2};const o={id:otherId,store_id:otherStore,device_id:otherDevice,orderNumber:d.order.orderNumber,customerName:'Synthetic guest',customerPhone:'qa.invalid',items:[item],stockItems:[item],totalAmount:10,discountAmount:0,shippingFee:0,courierFee:0,depositAmount:0,expectedCod:10,paymentMethod:'partial_cod'};
 const e={...db.event('order_placed','ecommerce_order',o.orderNumber,buildOrderPlacedLines({items:[item]})),store_id:otherStore,device_id:otherDevice};await otherClient.query('select place_order($1,$2)',[o,e]);
 const a=(await c.query('select * from read_order_activity($1,$2)',[db.store,d.order.id])).rows,b=(await otherClient.query('select * from read_order_activity($1,$2)',[otherStore,otherId])).rows;assert.deepEqual(a.map(r=>r.id),[d.event.id]);assert.deepEqual(b.map(r=>r.id),[e.id]);
 await assert.rejects(()=>c.query('select * from read_order_activity($1,$2)',[db.store,otherId]),/NEXUS_ORDER_ACTIVITY_SOURCE_REQUIRED/);
});
