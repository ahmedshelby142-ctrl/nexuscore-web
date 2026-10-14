// Actual captured schema, synthetic loopback only. No cloud credentials.
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
let db,c;const evidence=[];
const migrations=['supabase/migrations/20261012080415_receipt_variant_stock.sql','supabase/migrations/20261012082556_pos_atomic_exchange.sql'];
before(async()=>{db=await openBusinessDb();c=await db.client('ADMIN');for(const m of migrations)await db.admin.query(read(m))});
after(async()=>{if(db){fs.writeFileSync(path.join(ROOT,'logs/final-v1-sprint/pos-exchange-regression.json'),JSON.stringify({version:db.version,migrations,scope:'isolated only; NOT deployed or Production verified',evidence},null,2));await db.close()}});
const saved=async(id)=>(await db.admin.query('select to_jsonb(p) r from products p where id=$1 and store_id=$2',[id,db.store])).rows[0].r;
const balances=async()=> (await db.admin.query('select account,subject_id,sum(amount_delta)::int piastres,sum(qty_delta::numeric)::float8 qty from ledger_lines where store_id=$1 group by account,subject_id order by account,subject_id',[db.store])).rows;
const eventLines=async(id)=>(await db.admin.query('select account,subject_id,sum(amount_delta)::int piastres,sum(qty_delta::numeric)::float8 qty from ledger_lines where store_id=$1 and event_id=$2 group by account,subject_id order by account,subject_id',[db.store,id])).rows;
async function product({quantity=10,cost=2,variants=[]}={}){
 const id=crypto.randomUUID();await db.insert('products',{id,store_id:db.store,device_id:db.device,name:'Synthetic '+id,sku:id,quantity,unitPrice:10,metadata:{variants}});
 await c.query('select ledger_append($1)',[db.event('stock_adjustment','opening_balance',id,buildOpeningBalanceLines({productId:id,quantity,unitCost:cost}))]);
 return {id,cost,variants};
}
const item=(p,quantity=1,price=10,extra={})=>({productId:p.id,productName:'Synthetic',quantity,unitPrice:price,unitCost:p.cost,...extra});
function sale(items,extra={}){const {customerId,discountAmount=0,...rest}=extra;return {kind:'sale',refType:'pos_sale',actor:'Synthetic',payload:{channel:'pos',walletId:'inStoreSafe',items,customerId,customerName:customerId?'Original':'Walk in',customerPhone:'010',discountAmount,...rest},lines:buildSaleLines({items,wallet:'inStoreSafe',customerId,discountAmount})}}
const pos=async(request,id=crypto.randomUUID())=>(await c.query("select record_pos_sale($1,$2,$3,'pos_sale',$4) r",[id,db.store,db.device,request])).rows[0].r;
const exchange=async(request,id=crypto.randomUUID(),client=c)=>(await client.query("select record_pos_exchange($1,$2,$3,'pos_exchange',$4) r",[id,db.store,db.device,request])).rows[0].r;
async function original({variant=false,customer=true,price=10,discountAmount=0}={}){
 const p=await product(variant?{variants:[{name:'RED',stock:5},{name:'BLUE',stock:5}]}:{});
 let customerId;if(customer){customerId=crypto.randomUUID();await db.insert('customers',{id:customerId,store_id:db.store,device_id:db.device,name:'Original',phone:'010',address:''})}
 const line=item(p,1,price,variant?{variantName:'RED'}:{}),r=await pos(sale([line],{customerId,discountAmount}));
 // Model the legacy UI mirror after its original sale; no Production writes.
 await db.admin.query('update products set quantity=9,metadata=$1 where id=$2',[{variants:variant?[{name:'RED',stock:4},{name:'BLUE',stock:5}]:[]},p.id]);
 return {p,line,r,customerId};
}
function request(o,replace,refund=o.line.unitPrice){
 return {return:sale([{...o.line,quantity:-1,unitPrice:refund}],{returnOfEventId:o.r.eventId}),replacement:sale(replace)};
}
async function unchanged(action,pattern){
 const snapshot=async()=>{const result={};for(const table of ['products','ledger_events','ledger_lines','return_records','financial_private.pos_exchange_commands','discount_codes'])result[table]=(await db.admin.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') r from ${table} t where store_id=$1`,[db.store])).rows[0].r;return result};
 const before=await snapshot();await assert.rejects(action,pattern);assert.deepEqual(await snapshot(),before);
}
for(const price of [15,10,5])test(`atomic higher/equal/lower replacement ${price}: exact cash, cost, customer and linked records`,async()=>{
 const o=await original(),p=await product({cost:3}),before=await balances(),r=await exchange(request(o,[item(p,1,price)]));
 assert.equal(r.netPiastres,(price-10)*100);assert.equal(r.returnEventId,r.eventId);assert.equal(r.replacementEventId,r.eventId+':replacement');
 const ret=await eventLines(r.returnEventId),rep=await eventLines(r.replacementEventId);
 assert.equal(ret.find(l=>l.account==='wallet').piastres,-1000);assert.equal(rep.find(l=>l.account==='wallet').piastres,price*100);
 assert.equal(ret.find(l=>l.account==='cogs').piastres,-200);assert.equal(rep.find(l=>l.account==='cogs').piastres,300);
 assert.equal(ret.find(l=>l.account==='customer_ltv').subject_id,o.customerId);assert.equal(rep.find(l=>l.account==='customer_ltv').subject_id,o.customerId);
 assert.equal((await saved(o.p.id)).quantity,10);assert.equal((await saved(p.id)).quantity,9);
 const record=(await db.admin.query('select * from return_records where id=$1 and store_id=$2',[r.returnRecordId,db.store])).rows[0];
 assert.equal(record.original_order_id,o.r.eventId);assert.equal(Number(record.financial_difference),price-10);assert.equal(record.exchanged_item.length,1);
 const after=await balances();assert.equal(after.find(l=>l.account==='wallet').piastres-before.find(l=>l.account==='wallet').piastres,(price-10)*100);
 evidence.push({scenario:`replacement ${price}`,result:r,returnLines:ret,replacementLines:rep,record});
});
test('exact RED return and BLUE replacement persist catalog mirrors and leave untouched variants unchanged',async()=>{
 const o=await original({variant:true}),r=await exchange(request(o,[item(o.p,1,12,{variantName:'BLUE'})]));
 const p=await saved(o.p.id);assert.equal(p.quantity,9);assert.deepEqual(p.metadata.variants,[{name:'RED',stock:5},{name:'BLUE',stock:4}]);assert.equal(r.netPiastres,200);
});
function loadSource(file,stubs,cache=new Map()){
 const absolute=path.resolve(ROOT,file);if(cache.has(absolute))return cache.get(absolute);
 const exports={};cache.set(absolute,exports);const require=createRequire(import.meta.url);
 const local=id=>{if(Object.hasOwn(stubs,id))return stubs[id];if(id.startsWith('@/')||id.startsWith('.')){
  const base=id.startsWith('@/')?path.join(ROOT,'src',id.slice(2)):path.resolve(path.dirname(absolute),id);
  const found=[base,base+'.ts',base+'.tsx',path.join(base,'index.ts')].find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
  if(!found)throw Error('Unresolved '+id);return loadSource(found,stubs,cache);
 }return require(id)};
 const js=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 vm.runInThisContext(`(function(exports,require){${js}\n})`)(exports,local);return exports;
}
test('actual client command/driver sends one stable exchange identity across lost response, reload replay and read-only refresh failure',async()=>{
 const o=await original(),p=await product(),calls=[],refreshes=[],cache=new Map(),storage=new Map();let loseResponse=true,failRefresh=false;
 globalThis.sessionStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
 const stubs={
  '@/lib/supabase':{getSupabaseClient:()=>({async rpc(name,args){assert.equal(name,'record_pos_exchange');calls.push(args.p_id);
   const result=(await c.query('select record_pos_exchange($1,$2,$3,$4,$5) r',[args.p_id,args.p_store,args.p_device,args.p_command,args.p_input])).rows[0].r;
   if(loseResponse){loseResponse=false;throw Error('SYNTHETIC_RESPONSE_LOSS')}return {data:result,error:null};}})},
  '@/services/api/storeContext':{getSyncIdentity:async()=>({storeId:db.store,deviceId:db.device})},
  '@/services/featureStockMirror':{refreshFeatureStock:async(ids)=>{refreshes.push(ids);if(failRefresh)throw Error('SYNTHETIC_READ_FAILURE')}},
 };
 const client=loadSource('src/lib/posExchange.ts',stubs,cache),input={wallet:'inStoreSafe',cart:[{...o.line,quantity:-1,returnOfEventId:o.r.eventId,historicalCost:{unitCost:2}},{...item(p,1,12)}]};
 const result=await client.commitPosExchange(input);assert.equal(result.replayed,true);assert.equal(result.netPiastres,200);assert.equal(calls.length,2);assert.equal(new Set(calls).size,1);assert.equal(refreshes.length,1);assert.equal(storage.size,0);
 const a=await original(),q=await product();failRefresh=true;
 const second=await client.commitPosExchange({wallet:'inStoreSafe',cart:[{...a.line,quantity:-1,returnOfEventId:a.r.eventId,historicalCost:{unitCost:2}},item(q)]});
 assert.equal(second.netPiastres,0);assert.equal(calls.length,3,'failed optional reader must never resubmit a committed command');
 // Simulate a saved envelope and a fresh module instance after reload.
 const key='nexus-financial-pending:'+db.store+':ledger:sale';
 const prior=(await db.admin.query('select request from financial_private.pos_exchange_commands where id=$1',[result.eventId])).rows[0].request;
 storage.set(key,JSON.stringify({id:result.eventId,command:'pos_exchange',input:prior.input,uncertain:true}));
 const reloaded=loadSource('src/lib/financialCommand.ts',stubs);
 const replay=await reloaded.resolvePendingFinancialCommand('ledger:sale');assert.equal(replay.eventId,result.eventId);assert.equal(replay.replayed,true);assert.equal(storage.size,0);
 assert.equal((await saved(p.id)).quantity,9);assert.equal((await saved(o.p.id)).quantity,10);
 delete globalThis.sessionStorage;
 evidence.push({scenario:'actual client response loss/reload/read-only failure',result,calls,refreshes});
});
test('same-product replacement derives WAC after original-cost restoration rather than stale client cost',async()=>{
 const o=await original();
 await c.query('select ledger_append($1)',[db.event('stock_adjustment','opening_balance',o.p.id,buildOpeningBalanceLines({productId:o.p.id,quantity:10,unitCost:4}))]);
 await db.admin.query('update products set quantity=19 where id=$1',[o.p.id]);
 const r=await exchange(request(o,[item(o.p,1,12,{unitCost:999})]));
 assert.equal((await eventLines(r.returnEventId)).find(l=>l.account==='stock').piastres,200);
 assert.equal((await eventLines(r.replacementEventId)).find(l=>l.account==='stock').piastres,-300);
 assert.equal((await saved(o.p.id)).quantity,19);
});
test('anonymous sale does not acquire a guessed customer',async()=>{
 const o=await original({price:8,customer:false}),p=await product(),r=await exchange(request(o,[item(p,1,10)]));
 assert.equal(r.refundPiastres,800);assert.equal(r.netPiastres,200);
 assert.ok((await eventLines(r.returnEventId)).every(l=>l.account!=='customer_ltv'));
 assert.ok((await eventLines(r.replacementEventId)).every(l=>l.account!=='customer_ltv'));
});
test('same operation parallel/retry commits two linked legs and one document exactly once; changed request refuses',async()=>{
 const o=await original(),p=await product(),req=request(o,[item(p)]),id=crypto.randomUUID(),other=await db.client('ACCOUNTANT');
 const results=await Promise.all([exchange(req,id),exchange(req,id,other)]);assert.equal(results.filter(r=>r.replayed).length,1);
 assert.equal((await db.admin.query('select count(*)::int n from ledger_events where store_id=$1 and id=any($2)',[db.store,[id,id+':replacement']])).rows[0].n,2);
 assert.equal((await db.admin.query('select count(*)::int n from return_records where store_id=$1 and id=$2',[db.store,'pos-exchange:'+id])).rows[0].n,1);
 const changed=structuredClone(req);changed.replacement.payload.items[0].unitPrice=11;
 await unchanged(()=>exchange(changed,id),/NEXUS_OPERATION_PAYLOAD_MISMATCH/);
 await db.admin.query('update products set deleted_at=1 where id=$1',[p.id]);
 assert.equal((await exchange(req,id)).replayed,true);
});
test('unknown source, wrong variant, variant-only shortage, fully returned source and forbidden role roll back every effect',async()=>{
 const o=await original({variant:true}),p=await product(),req=request(o,[item(p)]);
 const unknown=structuredClone(req);unknown.return.payload.returnOfEventId='absent';await unchanged(()=>exchange(unknown),/NEXUS_POS_RECEIPT_REQUIRED/);
 const bad=structuredClone(req);bad.replacement.payload.items[0].variantName='UNKNOWN';await unchanged(()=>exchange(bad),/NEXUS_POS_VARIANT_INVALID/);
 const forbidden=await db.client('ECOMMERCE_ONLY');await unchanged(()=>exchange(req,crypto.randomUUID(),forbidden),/NEXUS_POS_FORBIDDEN/);
 const duplicate=structuredClone(req);duplicate.replacement.payload.items.push(duplicate.replacement.payload.items[0]);await unchanged(()=>exchange(duplicate),/NEXUS_POS_EXCHANGE_INVALID/);
 const wrongWallet=structuredClone(req);wrongWallet.return.lines.find(l=>l.account==='wallet').subjectId='bankAccount';await unchanged(()=>exchange(wrongWallet),/NEXUS_POS_EXCHANGE_INVALID/);
 // Aggregate has stock, but BLUE individually does not have six units.
 await unchanged(()=>exchange(request(o,[item(o.p,6,12,{variantName:'BLUE'})])),/NEXUS_STOCK_SHORT/);
 await exchange(req);await unchanged(()=>exchange(req),/NEXUS_POS_RETURN_LIMIT/);
});
test('late return-document failure rolls back both financial legs, stock mirrors and command receipt',async()=>{
 const o=await original(),p=await product();
 await db.admin.query("create function public.qa_pos_exchange_fail() returns trigger language plpgsql as $$ begin if NEW.id like 'pos-exchange:%' then raise exception 'SYNTHETIC_LATE_FAILURE'; end if; return NEW; end $$; create trigger qa_pos_exchange_fail before insert on return_records for each row execute function public.qa_pos_exchange_fail()");
 try{await unchanged(()=>exchange(request(o,[item(p)])),/SYNTHETIC_LATE_FAILURE/)}finally{await db.admin.query('drop trigger qa_pos_exchange_fail on return_records; drop function public.qa_pos_exchange_fail()')}
});
test('different operations competing for the final replacement unit serialize; loser rolls back its return',async()=>{
 const a=await original(),b=await original(),p=await product({quantity:1}),other=await db.client('POS_ECOMMERCE');
 const results=await Promise.allSettled([exchange(request(a,[item(p)])),exchange(request(b,[item(p)]),crypto.randomUUID(),other)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal((await saved(p.id)).quantity,0);
 const qa=(await saved(a.p.id)).quantity,qb=(await saved(b.p.id)).quantity;assert.deepEqual([qa,qb].sort((a,b)=>a-b),[9,10]);
});
test('actual discounted original refunds its NET price; replacement discount usage commits once with both legs',async()=>{
 const p=await product(),q=await product(),code=crypto.randomUUID();
 await db.insert('discount_codes',{id:code,store_id:db.store,device_id:db.device,code:'QA'+code,type:'percentage',value:20,maxUses:5});
 const originalLine=item(p,1,10),initial=sale([originalLine],{discountAmount:2,discountCodeId:code}),receipt=await pos(initial);
 await db.admin.query('update products set quantity=9 where id=$1',[p.id]);
 const o={p,line:originalLine,r:receipt},req=request(o,[item(q,1,10)],8);
 req.replacement=sale([item(q,1,10)],{discountAmount:2,discountCodeId:code});
 const id=crypto.randomUUID(),r=await exchange(req,id);assert.equal(r.refundPiastres,800);assert.equal(r.replacementPiastres,800);assert.equal(r.netPiastres,0);
 await exchange(req,id);
 const usage=(await db.admin.query('select "usedCount","totalDiscount" from discount_codes where id=$1',[code])).rows[0];assert.equal(usage.usedCount,2);assert.equal(Number(usage.totalDiscount),4);
});
test('bundle return uses historical recipe after editing; replacement uses current exact components and historical-cost refund',async()=>{
 const p=await product({quantity:20,cost:2,variants:[{name:'RED',stock:10},{name:'BLUE',stock:10}]}),q=await product({cost:3}),box=crypto.randomUUID();
 await db.insert('products',{id:box,store_id:db.store,device_id:db.device,name:'Synthetic box',sku:box,isBundle:true,unitPrice:10,bundleItems:[{productId:p.id,variantName:'RED',quantity:2}]});
 const originalLine={productId:box,productName:'Old recipe',quantity:1,unitPrice:10,unitCost:0,isBundle:true,bundleItems:[{productId:p.id,variantName:'RED',quantity:2,unitCost:2}]};
 const receipt=await pos(sale([originalLine]));
 await db.admin.query('update products set quantity=18,metadata=$1 where id=$2',[{variants:[{name:'RED',stock:8},{name:'BLUE',stock:10}]},p.id]);
 await db.admin.query('update products set "bundleItems"=$1 where id=$2',[JSON.stringify([{productId:q.id,quantity:1}]),box]);
 const o={p,line:originalLine,r:receipt},r=await exchange(request(o,[{productId:box,productName:'New recipe',quantity:1,unitPrice:12,unitCost:0}]));
 const ret=await eventLines(r.returnEventId),rep=await eventLines(r.replacementEventId);
 assert.equal(ret.find(l=>l.account==='stock').subject_id,p.id);assert.equal(ret.find(l=>l.account==='stock').piastres,400);
 assert.equal(rep.find(l=>l.account==='stock').subject_id,q.id);assert.equal(rep.find(l=>l.account==='stock').piastres,-300);
 assert.deepEqual((await saved(p.id)).metadata.variants,[{name:'RED',stock:10},{name:'BLUE',stock:10}]);assert.equal((await saved(q.id)).quantity,9);
 evidence.push({scenario:'historical bundle return/current recipe replacement',result:r,returnLines:ret,replacementLines:rep});
});
test('two partial discounted exchanges allocate every original piastre once and retain previous source history',async()=>{
 const p=await product(),q=await product(),code=crypto.randomUUID();
 await db.insert('discount_codes',{id:code,store_id:db.store,device_id:db.device,code:'QA'+code,type:'fixed',value:0.01});
 const sold=item(p,2,1),initial=sale([sold],{discountAmount:0.01,discountCodeId:code}),r=await pos(initial);
 await db.admin.query('update products set quantity=8 where id=$1',[p.id]);
 const o={p,line:sold,r},first=await exchange(request(o,[item(q,1,1)],1)),second=await exchange(request(o,[item(q,1,1)],0.99));
 assert.equal(first.refundPiastres+second.refundPiastres,199);assert.equal(first.netPiastres+second.netPiastres,1);
 assert.equal((await saved(p.id)).quantity,10);assert.equal((await saved(q.id)).quantity,8);
 await unchanged(()=>exchange(request(o,[item(q,1,1)],1)),/NEXUS_POS_RETURN_LIMIT/);
 const original=(await db.admin.query('select payload from ledger_events where id=$1',[r.eventId])).rows[0].payload;assert.equal(JSON.parse(original).items[0].quantity,2);
});
test('private exchange receipts are inaccessible to authenticated SQL; schema and function grants do not broaden tenant roles',async()=>{
 const ec=await db.client('ECOMMERCE_ONLY');await assert.rejects(()=>ec.query('select * from financial_private.pos_exchange_commands'),/permission denied/);
 const otherStore=crypto.randomUUID();await db.insert('stores',{id:otherStore,name:'Isolated other synthetic store'});
 const o=await original(),p=await product(),req=request(o,[item(p)]);
 await unchanged(()=>c.query("select record_pos_exchange($1,$2,$3,'pos_exchange',$4)",[crypto.randomUUID(),otherStore,db.device,req]),/NEXUS_POS_FORBIDDEN/);
});
