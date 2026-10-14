// A business diagnostic, NOT a passing acceptance test. Captured-schema PG17.6
// loopback only. No environment credentials or Production network access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openBusinessDb,read,ROOT} from './helpers/business-db.mjs';
import {buildOrderPlacedLines} from '../src/lib/ledger/orders.ts';
const migrations=['20261012080415_receipt_variant_stock','20261012082556_pos_atomic_exchange','20261012090535_courier_atomic_batch','20261012191715_authoritative_stock_commands','20261012194223_courier_writer_compatibility','20261012203014_catalog_return_compatibility','20261012204812_courier_obligation_compatibility','20261012213602_order_payment_atomic','20261013010850_exchange_credit_lifecycle','20261013015521_customer_trip_atomic_recovery','20261013022600_courier_claim_source_attribution'];
const db=await openBusinessDb(),evidence=[];
try {
 for(const migration of migrations)await db.admin.query(read('supabase/migrations/'+migration+'.sql'));
 const client=await db.client();
 for(const variant of [false,true]) {
  const product=crypto.randomUUID(),customer=crypto.randomUUID(),courier=crypto.randomUUID(),id=crypto.randomUUID();
  await db.insert('customers',{id:customer,store_id:db.store,device_id:db.device,name:'Synthetic J customer',phone:'qa.invalid-'+customer,address:''});
  await db.insert('couriers',{id:courier,store_id:db.store,device_id:db.device,name:'Synthetic J courier '+courier});
  await client.query("select record_product_catalog($1,$2,$3,'product_catalog',$4)",[crypto.randomUUID(),db.store,db.device,{action:'create',unitCost:2,product:{id:product,name:'Synthetic J product',sku:product,quantity:variant?7:3,unitPrice:10,metadata:{variants:variant?[{name:'RED',stock:3},{name:'BLUE',stock:4}]:[]}}}]);
  const item={productId:product,productName:'Synthetic J product',quantity:5,unitPrice:10,unitCost:2,variantName:variant?'RED':undefined,backorder:true,shortfall:2};
  const order={id,store_id:db.store,device_id:db.device,orderNumber:'J-'+id,customerId:customer,customerName:'Synthetic J customer',customerPhone:'qa.invalid',items:[item],stockItems:[item],totalAmount:50,discountAmount:0,shippingFee:2,courierFee:2,courierId:courier,depositAmount:0,expectedCod:52,paymentMethod:'partial_cod'};
  const stock=async()=>(await db.admin.query("select jsonb_build_object('product',(select to_jsonb(p) from products p where id=$1),'ledger',(select jsonb_agg(to_jsonb(l) order by id) from ledger_lines l where subject_id=$1 and account='stock'),'orders',(select count(*) from orders where id=$2),'events',(select count(*) from ledger_events where ref_id=$3)) r",[product,id,order.orderNumber])).rows[0].r;
  const before=await stock();let result,error;
  try{result=(await client.query('select place_order($1,$2) r',[order,db.event('order_placed','ecommerce_order',order.orderNumber,buildOrderPlacedLines({items:[item],depositAmount:0}))])).rows[0].r;}catch(caught){error={code:caught.code,message:caught.message};}
  const after=await stock();assert.deepEqual(after,before,'A refused backorder must not invent stock, cash, a document or a reservation');
  const row={variant:variant?'RED':'plain',requested:5,availableExactVariant:3,requiredShortage:2,aggregateBefore:variant?7:3,orderId:id,productId:product,customerId:customer,result,error,stockBefore:before,stockAfter:after,businessStatus:result?'REQUIRES_FULL_ALLOCATION_RECONCILIATION':'FAIL_J_BACKORDER_NOT_ACCEPTED'};evidence.push(row);
 }
 const report={scope:'isolated captured-schema PostgreSQL17.6 ONLY; not Production',version:db.version,migrations,status:'FAIL_J_BACKORDER_NOT_ACCEPTED',note:'Exit0 means diagnostic completed; this is NOT passing business acceptance. No backorder fix or allocation model implemented here.',evidence};
 const output=path.join(ROOT,'logs/final-v1-sprint/backorder-5-3-diagnostic-'+Date.now()+'.json');fs.writeFileSync(output,JSON.stringify(report,null,2));process.stdout.write(JSON.stringify({status:report.status,cases:evidence.map(({variant,error,businessStatus})=>({variant,error,businessStatus})),output},null,2)+'\n');
}finally{await db.close();}
