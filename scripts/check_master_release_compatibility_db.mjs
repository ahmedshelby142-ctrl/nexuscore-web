// The captured deployed schema, synthetic rows and loopback PG only. No cloud access.
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openBusinessDb,read,ROOT} from './helpers/business-db.mjs';
import {buildOpeningBalanceLines} from '../src/lib/ledger/audit.ts';
import {buildSaleLines} from '../src/lib/ledger/sales.ts';
import {buildOrderPlacedLines} from '../src/lib/ledger/orders.ts';

const migrations=['20261012080415_receipt_variant_stock','20261012082556_pos_atomic_exchange','20261012090535_courier_atomic_batch','20261012191715_authoritative_stock_commands','20261012194223_courier_writer_compatibility','20261012203014_catalog_return_compatibility','20261012204812_courier_obligation_compatibility','20261012213602_order_payment_atomic','20261013010850_exchange_credit_lifecycle','20261013015521_customer_trip_atomic_recovery','20261013022600_courier_claim_source_attribution','20261013031632_order_backorder_allocation','20261013111632_scoped_order_activity','20261013120155_store_branded_document_numbers'];
const q=id=>'"'+id.replaceAll('"','""')+'"';
let db,c,product,saleId,orderId,receiptId,receiptInput,posInput,oldColumns,oldRows,oldPolicies;
const evidence=[];
async function rows() {
 const result={};
 for(const table of oldColumns){const name=q(table.schema)+'.'+q(table.name);result[name]=(await db.admin.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') r from (select ${table.columns.map(q).join(',')} from ${name}) t`)).rows[0].r;}
 return result;
}
async function definitions(){return (await db.admin.query("select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) definition,p.proacl,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','financial_private') and p.prokind='f' order by 1,2,3")).rows;}
const policies=async()=>(await db.admin.query("select * from pg_policies where schemaname='public' order by tablename,policyname")).rows;
async function batch(fail=false) {
 await db.admin.query('begin');
 try {
  await db.admin.query("set local lock_timeout='5s';set local statement_timeout='120s'");
  for(const migration of migrations)await db.admin.query(read('supabase/migrations/'+migration+'.sql'));
  if(fail)await db.admin.query('select 1/0');
  await db.admin.query('commit');
 }catch(error){await db.admin.query('rollback');throw error;}
}
before(async()=>{
 db=await openBusinessDb();c=await db.client();product=crypto.randomUUID();
 const customer=crypto.randomUUID(),supplier=crypto.randomUUID();
 await db.insert('products',{id:product,store_id:db.store,device_id:db.device,name:'Legacy synthetic product',sku:product,quantity:10,unitPrice:10});
 await db.insert('customers',{id:customer,store_id:db.store,device_id:db.device,name:'Legacy synthetic customer',phone:'qa.invalid',address:''});
 await db.insert('suppliers',{id:supplier,store_id:db.store,device_id:db.device,companyName:'Legacy synthetic supplier',contactPerson:'',phone:''});
 await c.query('select ledger_append($1)',[db.event('stock_adjustment','opening_balance',product,buildOpeningBalanceLines({productId:product,quantity:10,unitCost:2}))]);
 receiptId=crypto.randomUUID();receiptInput={supplierId:supplier,paidAmount:1,wallet:'inStoreSafe',items:[{productId:product,productName:'Legacy synthetic product',quantity:2,unitCost:2}]};
 await c.query("select record_financial_command($1,$2,$3,'receipt',$4)",[receiptId,db.store,db.device,receiptInput]);
 const item={productId:product,productName:'Legacy saved name',quantity:1,unitPrice:10,unitCost:2};
 saleId=crypto.randomUUID();posInput={kind:'sale',refType:'pos_sale',payload:{channel:'pos',walletId:'inStoreSafe',items:[item],customerId:customer,customerName:'Legacy synthetic customer',discountAmount:0.01},lines:buildSaleLines({items:[item],wallet:'inStoreSafe',customerId:customer,discountAmount:0.01})};
 await c.query("select record_pos_sale($1,$2,$3,'pos_sale',$4)",[saleId,db.store,db.device,posInput]);
 orderId=crypto.randomUUID();const number='ECO-LEGACY-'+orderId;
 await c.query('select place_order($1,$2)',[{id:orderId,store_id:db.store,device_id:db.device,orderNumber:number,customerName:'Legacy synthetic customer',customerPhone:'qa.invalid',items:[item],stockItems:[item],totalAmount:10,discountAmount:0,shippingFee:2,courierFee:0,depositAmount:3,expectedCod:9,paymentMethod:'partial_cod'},db.event('order_placed','ecommerce_order',number,buildOrderPlacedLines({items:[item],depositAmount:3,wallet:'inStoreSafe'}))]);
 // Reproduce the old UI's persisted stock mirror before installing any new guard.
 await db.admin.query('update products set quantity=10 where id=$1',[product]);
 oldColumns=(await db.admin.query("select table_schema schema,table_name name,array_agg(column_name::text order by ordinal_position) columns from information_schema.columns where table_schema in ('public','financial_private') and table_name in (select tablename from pg_tables where schemaname in ('public','financial_private')) group by 1,2 order by 1,2")).rows;
 oldRows=await rows();oldPolicies=await policies();
});
after(async()=>{if(db){fs.writeFileSync(path.join(ROOT,'logs/final-v1-sprint/master-batch-compatibility-'+Date.now()+'.json'),JSON.stringify({scope:'captured-schema isolated PG only; NOT Production verified',version:db.version,migrations:migrations.map(name=>({name,sha256:createHash('sha256').update(read('supabase/migrations/'+name+'.sql')).digest('hex')})),evidence},null,2));await db.close();}});

test('complete14 migration batch rolls back all DDL/functions and synthetic historical rows on a final failure',async()=>{
 const before=await definitions();await assert.rejects(()=>batch(true),/division by zero/);
 assert.deepEqual(await definitions(),before);assert.deepEqual(await rows(),oldRows);assert.deepEqual(await policies(),oldPolicies);
 assert.equal((await db.admin.query("select to_regclass('financial_private.document_numbers') r")).rows[0].r,null);
 evidence.push({case:'late batch failure',rollback:'all original columns/rows/functions/ACLs/policies unchanged; new final table absent'});
});
test('complete14 bounded atomic batch preserves every captured historical table row and public RLS policy',async()=>{
 await batch();assert.deepEqual(await rows(),oldRows);
 const actualPolicies=await policies(),oldTables=new Set(oldColumns.filter(x=>x.schema==='public').map(x=>x.name));
 assert.deepEqual(actualPolicies.filter(x=>oldTables.has(x.tablename)),oldPolicies);
 const addedPolicies=actualPolicies.filter(x=>!oldTables.has(x.tablename));
 assert.equal(addedPolicies.length,1);assert.equal(addedPolicies[0].tablename,'order_shortage_followups');assert.equal(addedPolicies[0].cmd,'SELECT');assert.equal(addedPolicies[0].roles,'{authenticated}');
 assert.equal(addedPolicies[0].qual,"COALESCE(has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text, 'ECOMMERCE_ONLY'::text, 'MODERATOR'::text]), false)");
 const stock=(await db.admin.query("select sum(qty_delta::numeric)::int quantity,sum(amount_delta)::int piastres from ledger_lines where account='stock' and subject_id=$1",[product])).rows[0];assert.deepEqual(stock,{quantity:10,piastres:2000});
 const metadata=(await db.admin.query("select n.nspname,p.proname,p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('record_product_catalog','record_pos_exchange','record_stock_command','record_courier_batch','record_order_delivery','record_order_payment','record_exchange_place','record_exchange_return','record_exchange_credit_refund','record_order_cancel','record_document_number','read_order_activity') order by 2")).rows;
 assert.equal(metadata.length,12);assert.ok(metadata.every(x=>x.authenticated&&!x.anon&&x.proconfig.some(v=>v.startsWith('search_path='))));
 const tables=(await db.admin.query("select c.relname,c.relrowsecurity,has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE') writable from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='financial_private' and c.relkind='r' order by 1")).rows;
 assert.ok(tables.length>10&&tables.every(x=>x.relrowsecurity&&!x.writable));
 assert.equal((await db.admin.query("select prosecdef from pg_proc where oid='public.ledger_append(jsonb)'::regprocedure")).rows[0].prosecdef,false);
 evidence.push({case:'successful atomic batch',historicalTables:oldColumns.map(x=>x.schema+'.'+x.name),stock,metadata,privateTables:tables});
});
test('old committed receipts/POS replay unchanged; legacy order accepts atomic top-up and historical refund keeps source identity',async()=>{
 assert.equal((await c.query("select record_financial_command($1,$2,$3,'receipt',$4) r",[receiptId,db.store,db.device,receiptInput])).rows[0].r.replayed,true);
 assert.equal((await c.query("select record_pos_sale($1,$2,$3,'pos_sale',$4) r",[saleId,db.store,db.device,posInput])).rows[0].r.replayed,true);
 assert.deepEqual(await rows(),oldRows);
 const id=crypto.randomUUID(),paid=(await c.query("select record_order_payment($1,$2,$3,'order_payment',$4) r",[id,db.store,db.device,{orderId,amount:1,wallet:'inStoreSafe',expectedDeposit:3,expectedCod:9}])).rows[0].r;
 assert.equal(paid.order.depositAmount,4);assert.equal(paid.order.expectedCod,8);assert.equal(paid.order.fulfillment,null);
 const original=posInput.payload.items[0],items=[{...original,quantity:-1,unitPrice:9.99}],refundId=crypto.randomUUID();
 const refund=(await c.query("select record_pos_sale($1,$2,$3,'pos_sale',$4) r",[refundId,db.store,db.device,{kind:'sale',refType:'pos_sale',payload:{channel:'pos',walletId:'inStoreSafe',items,returnOfEventId:saleId},lines:buildSaleLines({items,wallet:'inStoreSafe'})}])).rows[0].r;
 assert.equal((await db.admin.query('select original_order_id from return_records where id=$1',['return:'+refund.eventId])).rows[0].original_order_id,saleId);
 const originalRow=(await db.admin.query('select to_jsonb(e) r from ledger_events e where id=$1',[saleId])).rows[0].r;
 assert.deepEqual(originalRow,oldRows['"public"."ledger_events"'].find(x=>x.id===saleId));
 evidence.push({case:'legacy compatibility',receiptReplay:receiptId,posReplay:saleId,atomicTopup:id,refund:refund.eventId});
});
