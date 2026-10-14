// Captured schema, synthetic loopback PostgreSQL only. No cloud credentials.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {openBusinessDb,read,ROOT} from './helpers/business-db.mjs';
import {buildOpeningBalanceLines} from '../src/lib/ledger/audit.ts';
import {buildSaleLines} from '../src/lib/ledger/sales.ts';
import {buildSupplierReturnLines} from '../src/lib/ledger/purchases.ts';
import {buildOrderPlacedLines,buildOrderCancelledLines,buildReturnConfirmedLines} from '../src/lib/ledger/orders.ts';
import {buildStockAdjustmentLines} from '../src/lib/ledger/audit.ts';
import {applyMovesToProducts,stockMirrorPatch} from '../src/lib/stockMirror.ts';
let db,c; const evidence=[];
const require=createRequire(import.meta.url);
function loadSource(file,stubs={},cache=new Map()){
 const absolute=path.resolve(ROOT,file);if(cache.has(absolute))return cache.get(absolute);
 const exports={};cache.set(absolute,exports);
 const localRequire=id=>{
  if(Object.hasOwn(stubs,id))return stubs[id];
  if(id.startsWith('@/')||id.startsWith('.')){
   const base=id.startsWith('@/')?path.join(ROOT,'src',id.slice(2)):path.resolve(path.dirname(absolute),id);
   const resolved=[base,base+'.ts',base+'.tsx',path.join(base,'index.ts')].find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
   if(!resolved)throw Error('Unresolved '+id);return loadSource(resolved,stubs,cache);
  }return require(id);
 };
 const source=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 vm.runInThisContext(`(function(exports,require){${source}\n})`,{filename:absolute})(exports,localRequire);return exports;
}
const migrations=['20261012080415_receipt_variant_stock','20261012082556_pos_atomic_exchange','20261012090535_courier_atomic_batch','20261012191715_authoritative_stock_commands'];
before(async()=>{db=await openBusinessDb();c=await db.client('ADMIN');for(const m of migrations)await db.admin.query(read('supabase/migrations/'+m+'.sql'))});
after(async()=>{if(db){fs.writeFileSync(path.join(ROOT,'logs/final-v1-sprint/authoritative-stock-regression.json'),JSON.stringify({version:db.version,scope:'isolated only; NOT deployed or Production verified',migrations,evidence},null,2));await db.close()}});
async function fixture(variant=true){
 const id=crypto.randomUUID(),supplier=crypto.randomUUID();
 await db.insert('products',{id,store_id:db.store,device_id:db.device,name:'Synthetic stock authority',sku:id,quantity:50,metadata:{variants:variant?[{name:'RED',stock:30},{name:'BLUE',stock:20}]:[]}});
 await db.insert('suppliers',{id:supplier,store_id:db.store,device_id:db.device,companyName:'Synthetic supplier',contactPerson:'',phone:''});
 await c.query('select ledger_append($1)',[db.event('stock_adjustment','opening_balance',id,buildOpeningBalanceLines({productId:id,quantity:50,unitCost:2}))]);
 return {id,supplier,variant};
}
const row=async(f)=>(await db.admin.query('select to_jsonb(p) r from products p where id=$1 and store_id=$2',[f.id,db.store])).rows[0].r;
const stock=async(f)=>(await db.admin.query("select sum(qty_delta::numeric)::float8 quantity,sum(amount_delta)::int piastres from ledger_lines where store_id=$1 and account='stock' and subject_id=$2",[db.store,f.id])).rows[0];
const receipt=async(f,id=crypto.randomUUID(),client=c)=>(await client.query("select record_financial_command($1,$2,$3,'receipt',$4) r",[id,db.store,db.device,{stockMirrorVersion:1,supplierId:f.supplier,paidAmount:0,wallet:'inStoreSafe',items:[{productId:f.id,variantName:f.variant?'RED':undefined,quantity:10,unitCost:2}]}])).rows[0].r;
function saleInput(f,quantity=1,extra={}){const items=[{productId:f.id,productName:'Synthetic',variantName:f.variant?'RED':undefined,quantity,unitPrice:5,unitCost:2}];return {kind:'sale',refType:'pos_sale',payload:{walletId:'inStoreSafe',items,...extra},lines:buildSaleLines({items,wallet:'inStoreSafe'})}}
const pos=async(f,id=crypto.randomUUID(),client=c,quantity=1,extra={})=>(await client.query("select record_pos_sale($1,$2,$3,'pos_sale',$4) r",[id,db.store,db.device,saleInput(f,quantity,extra)])).rows[0].r;
const command=async(input,id=crypto.randomUUID(),client=c)=>(await client.query("select record_stock_command($1,$2,$3,'stock_event',$4) r",[id,db.store,db.device,input])).rows[0].r;
async function unchanged(action,pattern){
 const snapshot=async()=>{const out={};for(const table of ['products','purchase_invoices','ledger_events','ledger_lines','financial_private.stock_applications','financial_private.stock_write_permits'])out[table]=(await db.admin.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') r from ${table} t`)).rows[0].r;return out};
 const prior=await snapshot();await assert.rejects(action,pattern);assert.deepEqual(await snapshot(),prior);
}
async function supplierReturn(f,r,quantity=2,paidNow=0){
 const line=r.invoice.items[0],debt=Number((await db.admin.query("select sum(amount_delta)::float8/100 n from ledger_lines where store_id=$1 and account='payable_supplier' and subject_id=$2",[db.store,f.supplier])).rows[0].n);
 const resolved={supplierId:f.supplier,returnValue:quantity*line.unitCost,lines:[{productId:f.id,variantName:f.variant?'RED':undefined,quantity,unitCost:line.unitCost}]};
 return {kind:'purchase',refType:'supplier_return',refId:r.invoiceNumber,payload:{supplierId:f.supplier,previousDebt:debt,paidNow,items:[{...resolved.lines[0],lineKey:line.id}]},lines:buildSupplierReturnLines({resolved,wallet:'inStoreSafe',currentDebt:debt,paidNow})};
}
test('QA-STOCK-002: receipt RED+10 then POS RED-1 persists39/20/59 and rejects delayed49',async()=>{
 const f=await fixture(),stale=await row(f);stale.totalQuantity=stale.quantity;
 const received=await receipt(f),sold=await pos(f),p=await row(f),ledger=await stock(f);
 assert.equal(Number(p.quantity),59);assert.deepEqual(p.metadata.variants,[{name:'RED',stock:39},{name:'BLUE',stock:20}]);
 assert.deepEqual(ledger,{quantity:59,piastres:11800});
 const old=stockMirrorPatch(applyMovesToProducts([stale],[{productId:f.id,variantName:'RED',delta:-1}]).products[0]);
 assert.equal(old.totalQuantity,49);
 await assert.rejects(c.query('update products set quantity=$1,metadata=$2 where id=$3 and store_id=$4',[old.totalQuantity,old.metadata,f.id,db.store]),/NEXUS_STOCK_ATOMIC_REQUIRED/);
 assert.deepEqual(await row(f),p);evidence.push({case:'59 versus49',receipt:received.eventId,sale:sold.eventId,ledger,persisted:p.metadata.variants,stale49:'REJECTED'});
 const fakeClient={from(table){assert.equal(table,'products');let id;const q={select(){return q},is(){return q},order(){return q},or(){return q},eq(key,value){if(key==='id')id=value;return q},async range(){assert.equal(id,f.id);return {data:[await row(f)],count:1,error:null}}};return q}};
 const readers=loadSource('src/mobile/data/mobileReaders.ts',{'@/lib/supabase':{getSupabaseClient:()=>fakeClient},'@/lib/ledger':{balanceOf:async(_account,id)=>{assert.equal(id,f.id);const s=await stock(f);return {qty:s.quantity,amount:s.piastres/100}}},'@/store/useAuthStore':{useAuthStore:{getState:()=>({userRole:'ADMIN'})}}});
 const mobile=await readers.readMobileProduct(f.id),{fromRemoteRow}=loadSource('src/services/api/fieldMapping.ts'),{getActualStock,getVariantStock}=loadSource('src/lib/product.ts');
 const desktop=fromRemoteRow('products',await row(f));assert.equal(mobile.mobileStock,59);assert.equal(getActualStock(desktop),59);assert.equal(getVariantStock(desktop,'RED'),39);assert.equal(getVariantStock(mobile,'BLUE'),20);
 evidence.push({case:'actual Desktop field mapping and Mobile reader after refresh',desktop:getActualStock(desktop),mobile:mobile.mobileStock,RED:getVariantStock(desktop,'RED'),BLUE:getVariantStock(mobile,'BLUE')});
});
test('POS then receipt; receipt then historical POS refund; replay never doubles',async()=>{
 const f=await fixture(),id=crypto.randomUUID(),s=await pos(f,id);await receipt(f);await pos(f,id);
 assert.equal(Number((await row(f)).quantity),59);
 await pos(f,crypto.randomUUID(),c,-1,{returnOfEventId:s.eventId});
 assert.equal(Number((await row(f)).quantity),60);assert.deepEqual(await stock(f),{quantity:60,piastres:12000});
});
test('plain product and concurrent receipt/POS preserve both legitimate movements',async()=>{
 const f=await fixture(false),a=await db.client('ADMIN'),b=await db.client('ADMIN');
 await Promise.all([receipt(f,crypto.randomUUID(),a),pos(f,crypto.randomUUID(),b)]);
 assert.equal(Number((await row(f)).quantity),59);assert.deepEqual(await stock(f),{quantity:59,piastres:11800});
});
test('supplier return then POS: exact variant, source document/debt/valuation, stable retry',async()=>{
 const f=await fixture(),r=await receipt(f),req=await supplierReturn(f,r),id=crypto.randomUUID();
 await command(req,id);await command(req,id);await pos(f);
 const p=await row(f);assert.equal(Number(p.quantity),57);assert.deepEqual(p.metadata.variants,[{name:'RED',stock:37},{name:'BLUE',stock:20}]);assert.deepEqual(await stock(f),{quantity:57,piastres:11400});
 const invoice=(await db.admin.query('select items,"remainingAmount" from purchase_invoices where id=$1',[r.invoiceId])).rows[0];
 assert.equal(invoice.items[0].returnedQuantity,2);assert.equal(Number(invoice.remainingAmount),16);
 await unchanged(()=>command(req),/NEXUS_STOCK_SUPPLIER_BALANCE_CHANGED/);
 const old=structuredClone(await supplierReturn(f,r));delete old.payload.items[0].variantName;
 await unchanged(()=>command(old),/NEXUS_STOCK_RETURN_SOURCE_REQUIRED/);
});
test('supplier return with cash payment records real paid amount without treating credit as cash',async()=>{
 const f=await fixture(false),r=await receipt(f);await command(await supplierReturn(f,r,2,3));
 const invoice=(await db.admin.query('select "paidAmount","remainingAmount" from purchase_invoices where id=$1',[r.invoiceId])).rows[0];
 assert.equal(Number(invoice.paidAmount),3);assert.equal(Number(invoice.remainingAmount),13);
});
test('variant receipt/POS concurrency and same-ID retry retain exact identities',async()=>{
 const f=await fixture(),a=await db.client('ADMIN'),b=await db.client('ADMIN');
 await Promise.all([receipt(f,crypto.randomUUID(),a),pos(f,crypto.randomUUID(),b)]);
 assert.deepEqual((await row(f)).metadata.variants,[{name:'RED',stock:39},{name:'BLUE',stock:20}]);
 const id=crypto.randomUUID();const results=await Promise.all([pos(f,id,a),pos(f,id,b)]);assert.equal(results.filter(x=>x.replayed).length,1);
 assert.equal(Number((await row(f)).quantity),58);
});
test('two tills competing for last RED cannot consume BLUE or lose the winning sale',async()=>{
 const f=await fixture();await pos(f,crypto.randomUUID(),c,29);
 const a=await db.client('ADMIN'),b=await db.client('POS_ECOMMERCE');
 const results=await Promise.allSettled([pos(f,crypto.randomUUID(),a),pos(f,crypto.randomUUID(),b)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected').length,1);
 assert.deepEqual((await row(f)).metadata.variants,[{name:'RED',stock:0},{name:'BLUE',stock:20}]);assert.deepEqual(await stock(f),{quantity:20,piastres:4000});
});
test('catalog description/zero-stock variant edits remain supported; nonzero identity cannot be renamed',async()=>{
 const f=await fixture();await c.query("update products set metadata=jsonb_set(metadata,'{variants}',metadata->'variants'||$1::jsonb) where id=$2",[JSON.stringify([{name:'GREEN',stock:0,barcode:'QA'}]),f.id]);
 assert.equal((await row(f)).metadata.variants[2].name,'GREEN');
 await unchanged(()=>c.query("update products set metadata=jsonb_set(metadata,'{variants,0,name}','\"RENAMED\"') where id=$1",[f.id]),/NEXUS_STOCK_ATOMIC_REQUIRED/);
});
test('ledger-backed product cannot be deleted; archiving preserves historical returns',async()=>{
 const f=await fixture(),s=await pos(f);
 await unchanged(()=>db.admin.query('delete from products where id=$1 and store_id=$2',[f.id,db.store]),/NEXUS_STOCK_IDENTITY_IMMUTABLE/);
 await c.query('update products set deleted_at=$1 where id=$2 and store_id=$3',[Date.now(),f.id,db.store]);
 await pos(f,crypto.randomUUID(),c,-1,{returnOfEventId:s.eventId});
 assert.equal(Number((await row(f)).quantity),50);assert.deepEqual(await stock(f),{quantity:50,piastres:10000});
});

test('late product-update error rolls back event, invoice, supplier allocation and stock application',async()=>{
 const f=await fixture();await db.admin.query(`create function public.qa_stock_late() returns trigger language plpgsql as $$ begin raise exception 'SYNTHETIC_LATE_STOCK_FAILURE'; end $$;create trigger qa_stock_late after update on products for each row execute function public.qa_stock_late()`);
 try{await unchanged(()=>receipt(f),/SYNTHETIC_LATE_STOCK_FAILURE/)}finally{await db.admin.query('drop trigger qa_stock_late on products;drop function public.qa_stock_late()')}
 assert.equal(Number((await row(f)).quantity),50);
});
test('legacy receipt, unsupported stock writer, public helper and private permits fail closed',async()=>{
 const f=await fixture();const req={supplierId:f.supplier,items:[{productId:f.id,variantName:'RED',quantity:1,unitCost:2}]};
 await unchanged(()=>c.query("select record_financial_command($1,$2,$3,'receipt',$4)",[crypto.randomUUID(),db.store,db.device,req]),/NEXUS_RECEIPT_CLIENT_UPDATE_REQUIRED/);
 await unchanged(()=>c.query('select ledger_append($1)',[db.event('stock_adjustment','legacy_absolute',f.id,[{account:'stock',subjectId:f.id,qty:1,amount:2}])]),/NEXUS_STOCK_CLIENT_UPDATE_REQUIRED/);
 await assert.rejects(c.query('select public.apply_stock_event($1)',[crypto.randomUUID()]),/does not exist/);
 await assert.rejects(c.query('insert into financial_private.stock_write_permits values(txid_current(),$1,$2,1,$3)',[db.store,f.id,[]]),/permission denied/);
});
test('stock count is atomic, exact-variant and rejects stale quantity or WAC',async()=>{
 const f=await fixture(),req={kind:'stock_adjustment',refType:'stock_audit',payload:{stockCounts:[{productId:f.id,variantName:'RED',systemQty:30,countedQty:29}]},lines:buildStockAdjustmentLines({items:[{productId:f.id,systemQty:50,countedQty:49,unitCost:2}]})};
 await command(req);assert.deepEqual((await row(f)).metadata.variants,[{name:'RED',stock:29},{name:'BLUE',stock:20}]);
 await unchanged(()=>command(req),/NEXUS_STOCK_COUNT_STALE/);
});
async function order(f,quantity=2){
 const id=crypto.randomUUID(),items=[{id:crypto.randomUUID(),productId:f.id,productName:'Synthetic',variantName:f.variant?'RED':undefined,quantity,unitPrice:5,unitCost:2}];
 const o={id,store_id:db.store,device_id:db.device,orderNumber:id,customerName:'Synthetic',customerPhone:'qa.invalid',items,stockItems:items,totalAmount:quantity*5,shippingFee:0,depositAmount:0,expectedCod:quantity*5,paymentMethod:'partial_cod'};
 await c.query('select place_order($1,$2)',[o,db.event('order_placed','ecommerce_order',id,buildOrderPlacedLines({items}))]);return o;
}
test('ordinary ecommerce reservation/cancellation returns the exact selected variant once',async()=>{
 const f=await fixture(),o=await order(f);assert.equal(Number((await row(f)).quantity),48);
 await c.query('select cancel_order($1,$2,$3)',[o.id,'customer',db.event('order_cancelled','ecommerce_order',o.orderNumber,buildOrderCancelledLines({items:o.stockItems}))]);
 assert.deepEqual((await row(f)).metadata.variants,[{name:'RED',stock:30},{name:'BLUE',stock:20}]);assert.deepEqual(await stock(f),{quantity:50,piastres:10000});
});
test('partial ecommerce returns use persisted historical cost and per-variant cumulative ceiling',async()=>{
 const f=await fixture(),o=await order(f,2),items=[{...o.stockItems[0],quantity:1}];
 const req={kind:'return_confirmed',refType:'ecommerce_order',refId:o.orderNumber,payload:{stockItems:items},lines:buildReturnConfirmedLines({items,refundAmount:5,revenueAmount:5,wallet:'inStoreSafe',returnFee:0,movement:'return'})};
 await command(req);await command(req);await unchanged(()=>command(req),/NEXUS_STOCK_RETURN_ALLOCATION_REQUIRED/);
 assert.equal(Number((await row(f)).quantity),50);
});
test('bundle POS and historical refund after recipe edit move components exactly once',async()=>{
 const f=await fixture(),g=await fixture(false),box=crypto.randomUUID();await db.insert('products',{id:box,store_id:db.store,device_id:db.device,name:'Synthetic box',sku:box,isBundle:true,unitPrice:10,bundleItems:[{productId:f.id,variantName:'RED',quantity:2}]});
 const item={productId:box,quantity:1,unitPrice:10,unitCost:0,isBundle:true,bundleItems:[{productId:f.id,variantName:'RED',quantity:2,unitCost:2}]};
 const input={kind:'sale',refType:'pos_sale',payload:{walletId:'inStoreSafe',items:[item]},lines:buildSaleLines({items:[item],wallet:'inStoreSafe'})};
 const sold=(await c.query("select record_pos_sale($1,$2,$3,'pos_sale',$4) r",[crypto.randomUUID(),db.store,db.device,input])).rows[0].r;
 assert.equal(Number((await row(f)).quantity),48);
 await db.admin.query('update products set "bundleItems"=$1 where id=$2',[JSON.stringify([{productId:g.id,quantity:1}]),box]);
 const returned={...item,quantity:-1},request={return:{...input,payload:{...input.payload,items:[returned],returnOfEventId:sold.eventId},lines:buildSaleLines({items:[returned],wallet:'inStoreSafe'})},replacement:saleInput(g)};
 await c.query("select record_pos_exchange($1,$2,$3,'pos_exchange',$4)",[crypto.randomUUID(),db.store,db.device,request]);
 assert.deepEqual((await row(f)).metadata.variants,[{name:'RED',stock:30},{name:'BLUE',stock:20}]);assert.equal(Number((await row(g)).quantity),49);
 assert.deepEqual(await stock(f),{quantity:50,piastres:10000});assert.deepEqual(await stock(g),{quantity:49,piastres:9800});
});
