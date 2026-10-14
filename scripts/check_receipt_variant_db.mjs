// Synthetic loopback PostgreSQL only. Never reads cloud env or live sessions.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";
import { openBusinessDb, read, ROOT } from "./helpers/business-db.mjs";
import { buildOpeningBalanceLines } from "../src/lib/ledger/audit.ts";
const migration="supabase/migrations/20261012080415_receipt_variant_stock.sql";
let db,c,legacy;
const evidence=[];
const require=createRequire(import.meta.url);
function loadSource(file,stubs={},cache=new Map()) {
  const absolute=path.resolve(ROOT,file);
  if(cache.has(absolute))return cache.get(absolute);
  const exports={};cache.set(absolute,exports);
  const localRequire=(id)=>{
    if(Object.hasOwn(stubs,id))return stubs[id];
    if(id.startsWith("@/")||id.startsWith(".")){
      const base=id.startsWith("@/")?path.join(ROOT,"src",id.slice(2)):path.resolve(path.dirname(absolute),id);
      const resolved=[base,base+".ts",base+".tsx",path.join(base,"index.ts")].find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
      if(!resolved)throw Error(`Unresolved ${id}`);
      return loadSource(resolved,stubs,cache);
    }
    return require(id);
  };
  const source=ts.transpileModule(fs.readFileSync(absolute,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  vm.runInThisContext(`(function(exports,require){${source}\n})`,{filename:absolute})(exports,localRequire);
  return exports;
}
const row=async(id)=>(await db.admin.query("select to_jsonb(p) r from products p where store_id=$1 and id=$2",[db.store,id])).rows[0].r;
async function fixture(variants=[{name:"RED",stock:30},{name:"BLUE",stock:20}],supplierId=crypto.randomUUID()){
  const id=crypto.randomUUID(),qty=variants.length?variants.reduce((n,v)=>n+v.stock,0):50;
  await db.insert("products",{id,store_id:db.store,device_id:db.device,name:"Synthetic variant product",sku:id,quantity:qty,metadata:{note:"preserve metadata",variants}});
  await db.insert("suppliers",{id:supplierId,store_id:db.store,device_id:db.device,companyName:"Synthetic supplier",contactPerson:"",phone:""});
  if(qty)await c.query("select ledger_append($1)",[db.event("stock_adjustment","opening_balance",id,buildOpeningBalanceLines({productId:id,quantity:qty,unitCost:2}))]);
  return {id,supplierId};
}
const input=(f,extra={})=>({stockMirrorVersion:1,supplierId:f.supplierId,paidAmount:0,wallet:"inStoreSafe",items:[{productId:f.id,productName:"Synthetic",variantName:"RED",quantity:10,unitCost:2}],...extra});
const receipt=async(request,id=crypto.randomUUID(),client=c)=>(await client.query("select record_financial_command($1,$2,$3,'receipt',$4) r",[id,db.store,db.device,request])).rows[0].r;
const stock=async(id)=>(await db.admin.query("select coalesce(sum(qty_delta::numeric),0)::float8 qty,coalesce(sum(amount_delta),0)::int piastres from ledger_lines where store_id=$1 and account='stock' and subject_id=$2",[db.store,id])).rows[0];
const lines=async(id)=>(await db.admin.query("select account,subject_id,sum(amount_delta)::int piastres,sum(qty_delta::numeric)::float8 qty from ledger_lines where store_id=$1 and event_id=$2 group by account,subject_id order by account,subject_id",[db.store,id])).rows;
async function unchangedOnReject(action,pattern){
  const snapshot=async()=>{
    const result={};
    for(const table of ["products","suppliers","purchase_invoices","ledger_events","ledger_lines","store_counters"])
      result[table]=(await db.admin.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') r from ${table} t where store_id=$1`,[db.store])).rows[0].r;
    return result;
  };
  const before=await snapshot();await assert.rejects(action,pattern);assert.deepEqual(await snapshot(),before);
}
before(async()=>{
  db=await openBusinessDb();c=await db.client("ADMIN");
  const f=await fixture(),request=input(f);delete request.stockMirrorVersion;
  const id=crypto.randomUUID();legacy={id,request,result:await receipt(request,id),product:f.id,before:await row(f.id)};
  await db.admin.query(read(migration));
});
after(async()=>{
  if(db){fs.writeFileSync(path.join(ROOT,"logs/final-v1-sprint/receipt-variant-regression.json"),JSON.stringify({version:db.version,migration,scope:"isolated synthetic only; NOT Production verified",evidence},null,2));await db.close();}
});
test("RED30/BLUE20 +RED10 persists40/20/60, invoice identity and WAC/credit exact",async()=>{
  const f=await fixture(),request=input(f,{items:[{productId:f.id,productName:"Synthetic",variantName:"RED",quantity:10,unitCost:3}]}),r=await receipt(request),p=await row(f.id),s=await stock(f.id);
  assert.deepEqual(p.metadata.variants,[{name:"RED",stock:40},{name:"BLUE",stock:20}]);assert.equal(p.quantity,60);assert.equal(p.metadata.note,"preserve metadata");
  assert.deepEqual(s,{qty:60,piastres:13000});assert.equal(r.invoice.items[0].variantName,"RED");assert.equal(r.invoice.remainingAmount,30);
  assert.equal((await lines(r.eventId)).find(l=>l.account==="payable_supplier").piastres,3000);
  evidence.push({scenario:"RED+10 credit",product:p,stock:s,invoice:r.invoice,eventLines:await lines(r.eventId)});
});
test("successive, zero-stock, same-color different-size and same-size different-color exact identities",async()=>{
  const variants=[{name:"RED / S",stock:30},{name:"RED / L",stock:10},{name:"BLUE / S",stock:10},{name:"RED / XL",stock:0}],f=await fixture(variants);
  for(const [variantName,quantity] of [["RED / S",10],["RED / S",5],["BLUE / S",3],["RED / XL",2]])
    await receipt(input(f,{items:[{productId:f.id,productName:"Synthetic",variantName,quantity,unitCost:2}]}));
  const p=await row(f.id);assert.deepEqual(p.metadata.variants.map(v=>v.stock),[45,10,13,2]);assert.equal(p.quantity,70);assert.equal((await stock(f.id)).qty,70);
});
test("actual Quick Supply and invoice entrypoints: empty Mobile store, paid/partial/credit, DB-backed readers and no client increments",async()=>{
  const f=await fixture(),calls=[],refreshes=[];
  let state={products:[],purchaseInvoices:[],suppliers:[]};
  const store={setState(fn){state={...state,...(typeof fn==="function"?fn(state):fn)}},getState(){return {...state,applyStockMoves(){throw Error("client increment forbidden")}}}};
  const stubs={
    "@/lib/financialCommand":{runFinancialCommand:async(command,request)=>{assert.equal(command,"receipt");calls.push(request);return receipt(request)}},
    "@/store/useBusinessStore":{useBusinessStore:store},
    "@/services/featureStockMirror":{refreshFeatureStock:async(ids)=>{refreshes.push(ids);state.products=await Promise.all(ids.map(row));}},
  };
  const {commitReceipt}=loadSource("src/lib/receiving/commitReceipt.ts",stubs);
  const {executeQuickRestock}=loadSource("src/lib/receiving/command.ts",{...stubs,"./commitReceipt":{commitReceipt}});
  globalThis.window??={dispatchEvent(){}};globalThis.CustomEvent??=class{constructor(type){this.type=type}};
  await executeQuickRestock({supplier:{supplierId:f.supplierId},wallet:"inStoreSafe",lines:[{productId:f.id,productName:"Synthetic",sku:"S",variantName:"RED",quantity:10,unitCost:2}]});
  await commitReceipt({supplierId:f.supplierId,supplierName:"Synthetic",actor:"Synthetic",via:"purchasing_page",wallet:"inStoreSafe",paidAmount:5,items:[{productId:f.id,productName:"Synthetic",variantName:"BLUE",quantity:5,unitCost:3}]});
  await commitReceipt({supplierId:f.supplierId,supplierName:"Synthetic",actor:"Synthetic",via:"quick_restock",paidAmount:0,items:[{productId:f.id,productName:"Synthetic",variantName:"RED",quantity:1,unitCost:2}]});
  assert.deepEqual(calls.map(i=>i.items[0].variantName),["RED","BLUE","RED"]);assert.ok(calls.every(i=>i.stockMirrorVersion===1));assert.deepEqual(calls.map(i=>i.paidAmount),[null,5,0]);assert.equal(refreshes.length,3);
  const p=await row(f.id);assert.deepEqual(p.metadata.variants.map(v=>v.stock),[41,25]);assert.equal(p.quantity,66);assert.equal(state.products[0].quantity,66);
  const fakeClient={from(table){assert.equal(table,"products");let id;const q={select(){return q},is(){return q},order(){return q},or(){return q},eq(key,value){if(key==="id")id=value;return q},async range(){const saved=await row(id);return {data:[saved],count:1,error:null}}};return q}};
  const readers=loadSource("src/mobile/data/mobileReaders.ts",{"@/lib/supabase":{getSupabaseClient:()=>fakeClient},"@/lib/ledger":{balanceOf:async(_account,id)=>{const s=await stock(id);return {qty:s.qty,amount:s.piastres/100}}},"@/store/useAuthStore":{useAuthStore:{getState:()=>({userRole:"ADMIN"})}}});
  const mobile=await readers.readMobileProduct(f.id),{fromRemoteRow}=loadSource("src/services/api/fieldMapping.ts"),{getActualStock,getVariantStock}=loadSource("src/lib/product.ts");
  const desktop=fromRemoteRow("products",p);assert.equal(mobile.mobileStock,66);assert.equal(getActualStock(desktop),66);assert.equal(getVariantStock(desktop,"RED"),41);assert.equal(getVariantStock(mobile,"BLUE"),25);
  evidence.push({scenario:"actual entrypoints and readers",calls,mobileStock:mobile.mobileStock,desktopQuantity:getActualStock(desktop),product:p});
});
test("plain product, repeated invoice lines, partial payment and supplier settlement preserve exact allocations",async()=>{
  const f=await fixture([]),request=input(f,{paidAmount:5,items:[{productId:f.id,productName:"Plain",quantity:2,unitCost:2},{productId:f.id,productName:"Plain",quantity:3,unitCost:3}]}),r=await receipt(request);
  assert.equal((await row(f.id)).quantity,55);assert.deepEqual(await stock(f.id),{qty:55,piastres:11300});assert.equal(r.invoice.paidAmount,5);assert.equal(r.invoice.remainingAmount,8);
  const invoiceClock=Date.now()+10000;
  await db.admin.query('update purchase_invoices set updated_at=$1 where id=$2 and store_id=$3',[invoiceClock,r.invoiceId,db.store]);
  const id=crypto.randomUUID(),paid=(await c.query("select record_financial_command($1,$2,$3,'supplier_payment',$4) r",[id,db.store,db.device,{supplierId:f.supplierId,wallet:"inStoreSafe",amount:8}])).rows[0].r;
  assert.equal(paid.applied,8);assert.equal(paid.allocations[0].invoiceId,r.invoiceId);assert.equal((await row(f.id)).quantity,55);
  assert.equal(Number((await db.admin.query('select updated_at from purchase_invoices where id=$1 and store_id=$2',[r.invoiceId,db.store])).rows[0].updated_at),invoiceClock+1);
});
test("repeated exact-variant lines and fractional quantities accumulate once with a monotonic sync clock",async()=>{
  const f=await fixture([{name:"RED",stock:0.3},{name:"BLUE",stock:0}]);
  const clock=Date.now()+10000;
  await db.admin.query("update products set updated_at=$1 where id=$2 and store_id=$3",[clock,f.id,db.store]);
  await receipt(input(f,{items:[{productId:f.id,variantName:"RED",quantity:0.1,unitCost:2},{productId:f.id,variantName:"RED",quantity:0.2,unitCost:3}]}));
  const p=await row(f.id);assert.deepEqual(p.metadata.variants,[{name:"RED",stock:0.6},{name:"BLUE",stock:0}]);assert.equal(p.quantity,0.6);assert.equal(Number(p.updated_at),clock+1);
  assert.deepEqual(await stock(f.id),{qty:0.6,piastres:140});
});
test("inactive/virtual products and malformed/ambiguous variant definitions reject atomically; plain products cannot accept a variant",async()=>{
  for(const change of [{isActive:false},{metadata:{variants:{RED:30}}},{metadata:{variants:[{name:"RED",stock:30},{name:"RED",stock:20}]}},{metadata:{variants:[{name:"RED",stock:-1},{name:"BLUE",stock:51}]}}]){
    const f=await fixture();
    for(const [key,value] of Object.entries(change))await db.admin.query(`update products set "${key}"=$1 where id=$2 and store_id=$3`,[value,f.id,db.store]);
    await unchangedOnReject(()=>receipt(input(f)),/NEXUS_RECEIPT_(PRODUCT_INVALID|VARIANT_DATA_INVALID)/);
  }
  const component=await fixture(),boxId=crypto.randomUUID();
  await db.insert("products",{id:boxId,store_id:db.store,device_id:db.device,name:"Synthetic virtual box",sku:boxId,isBundle:true,unitPrice:10,bundleItems:[{productId:component.id,variantName:"RED",quantity:1}]});
  await unchangedOnReject(()=>receipt(input({...component,id:boxId},{items:[{productId:boxId,quantity:1,unitCost:2}]})),/NEXUS_RECEIPT_PRODUCT_INVALID/);
  const plain=await fixture([]);
  await unchangedOnReject(()=>receipt(input(plain)),/NEXUS_RECEIPT_VARIANT_INVALID/);
});
test("missing/unknown variant, legacy new client, invalid line and historical inconsistency reject without any mutation",async()=>{
  const f=await fixture();
  for(const variantName of [undefined,"UNKNOWN"])
    await unchangedOnReject(()=>receipt(input(f,{items:[{productId:f.id,productName:"Synthetic",variantName,quantity:1,unitCost:2}]})),/NEXUS_RECEIPT_VARIANT_INVALID/);
  const old=input(f);delete old.stockMirrorVersion;await unchangedOnReject(()=>receipt(old),/NEXUS_RECEIPT_CLIENT_UPDATE_REQUIRED/);
  await unchangedOnReject(()=>receipt(input(f,{items:[{productId:f.id,variantName:"RED",quantity:-1,unitCost:2}]})),/NEXUS_RECEIPT_LINE_INVALID/);
  await db.admin.query("update products set metadata=jsonb_set(metadata,'{variants,0,stock}','29') where id=$1",[f.id]);
  await unchangedOnReject(()=>receipt(input(f)),/NEXUS_RECEIPT_STOCK_RECONCILIATION_REQUIRED/);
});
test("archived/foreign/unknown references and unauthorized role rejected without stock or financial side effects",async()=>{
  const f=await fixture(),unauthorized=await db.client("POS_ECOMMERCE");
  await unchangedOnReject(()=>receipt(input(f),crypto.randomUUID(),unauthorized),/NEXUS_FINANCE_FORBIDDEN/);
  await unchangedOnReject(()=>receipt(input({...f,id:crypto.randomUUID()})),/NEXUS_RECEIPT_PRODUCT_INVALID/);
  await db.admin.query("update products set deleted_at=1 where id=$1",[f.id]);
  await unchangedOnReject(()=>receipt(input(f)),/NEXUS_RECEIPT_PRODUCT_INVALID/);
  const other=crypto.randomUUID();await db.admin.query("insert into stores(id,name) values($1,'Synthetic other tenant')",[other]);
  await db.insert("products",{id:other,name:"Foreign",sku:other,store_id:other,device_id:db.device});
  await unchangedOnReject(()=>receipt(input({...f,id:other})),/NEXUS_RECEIPT_PRODUCT_INVALID/);
});
test("same-operation retry/parallel response loss credits once; replay after archiving preserves recorded identity",async()=>{
  const f=await fixture(),id=crypto.randomUUID(),request=input(f),second=await db.client("ACCOUNTANT");
  const results=await Promise.all([receipt(request,id),receipt(request,id,second)]);assert.equal(results.filter(r=>r.replayed).length,1);assert.equal((await row(f.id)).quantity,60);
  await db.admin.query("update products set deleted_at=1 where id=$1",[f.id]);
  const before=await row(f.id),r=await receipt(request,id);assert.equal(r.replayed,true);assert.deepEqual(await row(f.id),before);
  await unchangedOnReject(()=>receipt({...request,paidAmount:1},id),/NEXUS_OPERATION_PAYLOAD_MISMATCH/);
});
test("parallel different receipts/suppliers and reversed product order serialize without lost variants or deadlock",async()=>{
  const f=await fixture(),g=await fixture(),other=await db.client("ACCOUNTANT");await other.query("set statement_timeout='5s'");await c.query("set statement_timeout='5s'");
  const a={productId:f.id,variantName:"RED",productName:"Synthetic",quantity:10,unitCost:2},b={productId:g.id,variantName:"BLUE",productName:"Synthetic",quantity:5,unitCost:3};
  await Promise.all([receipt(input(f,{items:[a,b]})),receipt(input(g,{items:[b,a]}),crypto.randomUUID(),other)]);
  assert.deepEqual((await row(f.id)).metadata.variants.map(v=>v.stock),[50,20]);assert.equal((await stock(f.id)).qty,70);
  assert.deepEqual((await row(g.id)).metadata.variants.map(v=>v.stock),[30,30]);assert.equal((await stock(g.id)).qty,60);
});
test("late product-write failure rolls back supplier/invoice/counter/ledger and every product together",async()=>{
  const f=await fixture(),g=await fixture(),last=[f.id,g.id].sort().at(-1);
  await db.admin.query(`create function public.qa_receipt_fail() returns trigger language plpgsql as $$ begin if new.id='${last}' then raise exception 'SYNTHETIC_LATE_MIRROR_FAILURE';end if;return new;end $$; create trigger qa_receipt_fail before update on products for each row execute function qa_receipt_fail();`);
  try{await unchangedOnReject(()=>receipt(input(f,{supplierId:"__new__",newSupplierName:"Rollback synthetic supplier",paidAmount:10,items:[{productId:f.id,variantName:"RED",quantity:1,unitCost:2},{productId:g.id,variantName:"BLUE",quantity:1,unitCost:2}]})),/SYNTHETIC_LATE_MIRROR_FAILURE/);}
  finally{await db.admin.query("drop trigger qa_receipt_fail on products;drop function public.qa_receipt_fail()");}
});
test("previously committed legacy request replays unchanged; migration never rewrites historical mirrors/events",async()=>{
  const r=await receipt(legacy.request,legacy.id);assert.equal(r.replayed,true);assert.equal(r.invoiceNumber,legacy.result.invoiceNumber);assert.deepEqual(await row(legacy.product),legacy.before);
});
