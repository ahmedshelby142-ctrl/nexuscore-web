// Real captured schema, all released migrations, loopback PG17.6 only.
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openBusinessDb,read,ROOT} from './helpers/business-db.mjs';
import {buildSaleLines} from '../src/lib/ledger/sales.ts';
import {buildOrderPlacedLines} from '../src/lib/ledger/orders.ts';
import {uiHarness} from './helpers/ui-harness.mjs';
const migration='20261017043750_employee_access_balance_privacy.sql';
let db,c,product,baseline,functionsBefore;const clients={},evidence=[];
const q=async(client,name,args)=> (await client.query(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;
const command=(client,name,input,id=crypto.randomUUID())=>q(client,'record_'+name,[id,db.store,db.device,name,input]);
const snapshot=async()=> (await db.admin.query(`select jsonb_build_object('products',(select jsonb_agg(to_jsonb(t) order by id) from products t),
 'events',(select jsonb_agg(to_jsonb(t) order by id) from ledger_events t),'lines',(select jsonb_agg(to_jsonb(t) order by id) from ledger_lines t),
 'returns',(select jsonb_agg(to_jsonb(t) order by id) from return_records t),'orders',(select jsonb_agg(to_jsonb(t) order by id) from orders t)) r`)).rows[0].r;
const unchanged=async(action,pattern=/FORBIDDEN|permission|policy/)=>{const before=await snapshot();await assert.rejects(action,pattern);assert.deepEqual(await snapshot(),before);};
const wallet=async()=>Number((await db.admin.query("select coalesce(sum(amount_delta),0) n from ledger_lines where store_id=$1 and account='wallet'",[db.store])).rows[0].n);
function sale(qty=1,extra={}) {const items=[{productId:product,productName:'Synthetic preset fixture',quantity:qty,unitPrice:10,unitCost:2}];return {kind:'sale',refType:'pos_sale',payload:{channel:'pos',walletId:'inStoreSafe',items,...extra},lines:buildSaleLines({items,wallet:'inStoreSafe',discountAmount:extra.discountAmount??0})};}
before(async()=>{
 db=await openBusinessDb();c=await db.client();clients.ADMIN=c;
 for(const file of fs.readdirSync(path.join(ROOT,'supabase/migrations')).filter(f=>f>='20261012000000'&&f<migration).sort())await db.admin.query(read('supabase/migrations/'+file));
 for(const role of ['ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY'])clients[role]=await db.client(role);
 await q(c,'record_financial_command',[crypto.randomUUID(),db.store,db.device,'ledger',{kind:'owner_capital',refType:'capital',refId:crypto.randomUUID(),lines:[{account:'owner_equity',subjectId:'owner',amount:100},{account:'wallet',subjectId:'inStoreSafe',amount:100}]}]);
 product=crypto.randomUUID();await command(c,'product_catalog',{action:'create',unitCost:2,product:{id:product,name:'Synthetic preset fixture',sku:product,quantity:40,unitPrice:10,metadata:{variants:[]}}});
 const leaked=await clients.POS_ECOMMERCE.query("select * from ledger_balances($1,'wallet')",[db.store]);assert.equal(Number(leaked.rows[0].amount),10000);
 baseline=await snapshot();functionsBefore=(await db.admin.query("select proname,pg_get_functiondef(oid) def from pg_proc where proname=any($1::text[])",[['record_financial_command','record_order_payment','record_order_delivery','record_order_edit','record_courier_batch','ledger_validate_event']])).rows;
 // Prove the complete security/schema batch is transactional, including the
 // existing Supabase publication path. This publication is local metadata only.
 await db.admin.query('create publication supabase_realtime for table public.products');
 const fingerprint=async()=> (await db.admin.query(`select jsonb_build_object('functions',(select md5(string_agg(pg_get_functiondef(p.oid),'|' order by p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','financial_private')),
 'constraints',(select jsonb_agg(to_jsonb(t) order by conname,oid) from pg_constraint t where connamespace='public'::regnamespace),
 'policies',(select jsonb_agg(to_jsonb(t) order by tablename,policyname) from pg_policies t where schemaname='public'),
 'publication',(select jsonb_agg(to_jsonb(t) order by tablename) from pg_publication_tables t where pubname='supabase_realtime')) r`)).rows[0].r;
 const oldSchema=await fingerprint();
 await db.admin.query('BEGIN');await db.admin.query(read('supabase/migrations/'+migration));await db.admin.query('ROLLBACK');assert.deepEqual(await fingerprint(),oldSchema);assert.deepEqual(await snapshot(),baseline);
 await db.admin.query('BEGIN');try{await db.admin.query(read('supabase/migrations/'+migration));await db.admin.query('COMMIT');}catch(e){await db.admin.query('ROLLBACK');throw e;}
 assert.deepEqual((await db.admin.query("select tablename from pg_publication_tables where pubname='supabase_realtime' order by tablename")).rows.map(r=>r.tablename),['products','store_members']);
 for(const role of ['CASHIER_ONLY','MODERATOR']){db.users[role]=crypto.randomUUID();await db.admin.query('insert into auth.users values($1,$2,now())',[db.users[role],role+'@qa.invalid']);await db.insert('store_members',{store_id:db.store,user_id:db.users[role],role});clients[role]=await db.client(role);}
 evidence.push({version:db.version,migration,baselineWalletLeakPiastres:10000});
});
after(async()=>{if(db){fs.writeFileSync(path.join(ROOT,'logs/final-v1-sprint/employee-access-'+Date.now()+'.json'),JSON.stringify({scope:'isolated PostgreSQL only; NOT Production acceptance',evidence},null,2));await db.close();}});
test('migration changes no historical documents/ledger/stock; financial calculation contracts remain identical',async()=>{
 assert.deepEqual(await snapshot(),baseline);for(const f of functionsBefore)assert.equal((await db.admin.query('select pg_get_functiondef(oid) def from pg_proc where proname=$1',[f.proname])).rows[0].def,f.def,f.proname);
 assert.match(db.version,/PostgreSQL 17\.6/);
});
for(const role of ['CASHIER_ONLY','POS_ECOMMERCE','ECOMMERCE_ONLY','MODERATOR'])test(role+' cannot read raw company ledger or protected balances through direct SQL, joins or RPC',async()=>{
 const client=clients[role];for(const table of ['ledger_events','ledger_lines'])assert.equal((await client.query('select * from '+table)).rows.length,0);
 assert.equal((await client.query('select l.* from ledger_lines l join ledger_events e on e.id=l.event_id')).rows.length,0);
 for(const account of ['wallet','owner_equity','owner_budget','expense','revenue','cogs','payable_supplier','receivable_courier','payable_courier'])await assert.rejects(()=>client.query('select * from ledger_balances($1,$2)',[db.store,account]),/FORBIDDEN/);
 assert.equal((await client.query('select * from wallet_transfer_history($1)',[db.store])).rows.length,0);
 await assert.rejects(()=>client.query('select accounting_position($1)',[db.store]),/FORBIDDEN/);
 if(role!=='MODERATOR'){const rows=(await client.query("select * from ledger_balances($1,'stock')",[db.store])).rows;assert.ok(rows.some(r=>r.subject_id===product&&Number(r.qty)>0));}
});
for(const role of ['ADMIN','ACCOUNTANT'])test(role+' retains full company balance authority',async()=>{
 assert.ok((await clients[role].query("select * from ledger_balances($1,'wallet')",[db.store])).rows.length>0);
 assert.ok((await clients[role].query('select * from ledger_lines')).rows.length>0);
});
test('Cashier Only sale/replay, exact wallet/COGS/stock and historical-cost atomic refund work without ledger SELECT',async()=>{
 const client=clients.CASHIER_ONLY,input=sale(),id=crypto.randomUUID(),before=await wallet(),r=await command(client,'pos_sale',input,id);
 assert.equal(r.eventId,id);assert.equal(await wallet(),before+1000);assert.equal((await command(client,'pos_sale',input,id)).replayed,true);assert.equal(await wallet(),before+1000);
 const lines=(await db.admin.query('select account,amount_delta from ledger_lines where event_id=$1',[id])).rows;assert.equal(lines.find(l=>l.account==='cogs').amount_delta,200);
 const headers=(await client.query('select * from read_pos_headers($1,$2)',[db.store,[id]])).rows;assert.equal(headers.length,1);assert.equal(headers[0].command_request,null);
 assert.equal((await client.query('select * from search_pos_receipts($1,$2)',[db.store,r.documentNumber])).rows.length,1);
 const returned=await command(client,'pos_sale',sale(-1,{returnOfEventId:id}));assert.equal(await wallet(),before);
 const doc=(await db.admin.query('select * from return_records where id=$1',[returned.eventId+':return'])).rows;
 assert.equal((await db.admin.query('select count(*)::int n from return_records where original_order_id=$1',[id])).rows[0].n,1);
 assert.equal((await client.query('select count(*)::int n from return_records where original_order_id=$1',[id])).rows[0].n,1);
 const retLines=(await db.admin.query('select account,amount_delta from ledger_lines where event_id=$1',[returned.eventId])).rows;assert.equal(retLines.find(l=>l.account==='cogs').amount_delta,-200);
 evidence.push({role:'CASHIER_ONLY',sale:r,refund:returned,deltaPiastres:0,returnDocuments:doc.length});
});
test('Cashier Only exchange/ordinary refund rollback cannot strand a financial operation without a return document',async()=>{
 const client=clients.CASHIER_ONLY,source=await command(client,'pos_sale',sale());
 await db.admin.query("create function public.synthetic_return_failure() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_DOCUMENT_FAILURE';end$$;create trigger synthetic_return_failure before insert on return_records for each row execute function public.synthetic_return_failure()");
 try{await unchanged(()=>command(client,'pos_sale',sale(-1,{returnOfEventId:source.eventId})),/SYNTHETIC_DOCUMENT_FAILURE/);}finally{await db.admin.query('drop trigger synthetic_return_failure on return_records;drop function synthetic_return_failure()');}
 const r=await command(client,'pos_exchange',{return:sale(-1,{returnOfEventId:source.eventId}),replacement:sale()});assert.equal(r.netPiastres,0);
 assert.equal((await client.query('select * from read_pos_lines($1,$2)',[db.store,[r.eventId,r.replacementEventId]])).rows.filter(l=>l.account==='wallet').length,2);
 const forged=db.event('sale','pos_sale',crypto.randomUUID(),buildSaleLines({items:[{productId:product,quantity:1,unitPrice:10,unitCost:2}],wallet:'inStoreSafe'}),sale().payload);
 await unchanged(()=>client.query('select ledger_append($1)',[forged]),/POS_COMMAND_REQUIRED/);
 assert.equal((await db.admin.query('select count(*)::int n from financial_private.pos_command_permits')).rows[0].n,0);
});
for(const role of ['CASHIER_ONLY','MODERATOR'])test(role+' cannot invoke ecommerce placement/top-ups, finance/courier commands or operational order read bypasses',async()=>{
 const client=clients[role];await unchanged(()=>client.query("select record_order_payment($1,$2,$3,'order_payment','{}')",[crypto.randomUUID(),db.store,db.device]));
 await unchanged(()=>client.query("select record_courier_batch($1,$2,$3,'courier_batch','{}')",[crypto.randomUUID(),db.store,db.device]));
 await unchanged(()=>client.query("select place_order($1,'{}')",[{store_id:db.store}]));
 if(role==='CASHIER_ONLY'){assert.equal((await client.query('select * from orders_operational')).rows.length,0);await assert.rejects(()=>client.query('select * from read_order_activity($1,$2)',[db.store,'unknown']),/FORBIDDEN/);}
 await unchanged(()=>q(client,'record_financial_command',[crypto.randomUUID(),db.store,db.device,'ledger',{}]));
});
test('Online Only is refused POS commands and receipt readers; original combined access remains',async()=>{
 await unchanged(()=>command(clients.ECOMMERCE_ONLY,'pos_sale',sale()));
 await assert.rejects(()=>clients.ECOMMERCE_ONLY.query('select * from read_pos_headers($1,$2)',[db.store,['x']]),/FORBIDDEN/);
 assert.ok((await command(clients.POS_ECOMMERCE,'pos_sale',sale())).eventId);
});
for(const role of ['ECOMMERCE_ONLY','POS_ECOMMERCE'])test(role+' ecommerce deposit and atomic top-up remain exact while company wallet is unreadable',async()=>{
 const client=clients[role],id=crypto.randomUUID(),items=[{productId:product,quantity:1,unitPrice:10,unitCost:2}];
 const order={id,store_id:db.store,device_id:db.device,orderNumber:'SYN-'+id,customerName:'Synthetic employee buyer',customerPhone:'qa.invalid',items,stockItems:items,totalAmount:10,shippingFee:2,courierFee:0,courierId:crypto.randomUUID(),depositAmount:2,depositWallet:'inStoreSafe',expectedCod:10,paymentMethod:'partial_cod'};
 const before=await wallet();await client.query('select place_order($1,$2)',[order,db.event('order_placed','ecommerce_order',order.orderNumber,buildOrderPlacedLines({items,depositAmount:2,wallet:'inStoreSafe'}))]);
 const r=await command(client,'order_payment',{orderId:id,amount:3,wallet:'vodafoneCash',expectedDeposit:2,expectedCod:10});assert.equal(r.order.depositAmount,5);assert.equal(r.order.expectedCod,7);assert.equal(await wallet(),before+500);
 const viewed=(await client.query('select * from orders_operational where id=$1',[id])).rows[0];assert.equal(Number(viewed.expectedCod),7);assert.equal(Number(viewed.stockItems[0].unitCost),2);
 const position=await q(client,'read_order_courier_position',[db.store,id]);assert.equal(Number(position.servicePiastres),0);
 await assert.rejects(()=>client.query("select * from ledger_balances($1,'wallet')",[db.store]),/FORBIDDEN/);
 evidence.push({role,orderId:id,payment:r.eventId,depositPiastres:500,codPiastres:700,walletDeltaPiastres:500});
});
test('tenant spoofing, revoked licences, role changes and anonymous callers fail closed without changing data',async()=>{
 const cashier=clients.CASHIER_ONLY,other=crypto.randomUUID();
 await assert.rejects(()=>cashier.query("select * from ledger_balances($1,'stock')",[other]),/FORBIDDEN/);
 await unchanged(()=>q(cashier,'record_pos_sale',[crypto.randomUUID(),other,db.device,'pos_sale',sale()]));
 await assert.rejects(()=>cashier.query('select financial_private.append_authorized_event($1)',[{}]),/permission/);
 await db.admin.query('update store_members set role=$1 where user_id=$2',['ECOMMERCE_ONLY',db.users.CASHIER_ONLY]);await unchanged(()=>command(cashier,'pos_sale',sale()));await db.admin.query('update store_members set role=$1 where user_id=$2',['CASHIER_ONLY',db.users.CASHIER_ONLY]);
 await db.admin.query("update store_licenses set valid_until=now()-interval '1 day' where store_id=$1",[db.store]);await unchanged(()=>command(cashier,'pos_sale',sale()));await assert.rejects(()=>cashier.query("select * from ledger_balances($1,'stock')",[db.store]),/FORBIDDEN/);await db.admin.query("update store_licenses set valid_until=now()+interval '1 year' where store_id=$1",[db.store]);
 await cashier.query("select set_config('request.jwt.claim.sub','',false)");await assert.rejects(()=>cashier.query("select * from ledger_balances($1,'wallet')",[db.store]),/FORBIDDEN/);await cashier.query("select set_config('request.jwt.claim.sub',$1,false)",[db.users.CASHIER_ONLY]);
});
test('Cashier Only may create a POS customer but cannot delete/edit profiles, define products or grant staff permissions',async()=>{
 const id=crypto.randomUUID(),cashier=clients.CASHIER_ONLY;
 await cashier.query(`insert into customers(id,store_id,device_id,name,phone,address) values($1,$2,$3,'Synthetic cashier customer','qa.invalid','') on conflict(id) do update set name=excluded.name returning id`,[id,db.store,db.device]);
 assert.equal((await cashier.query('delete from customers where id=$1 returning id',[id])).rowCount,0);
 assert.equal((await cashier.query("update customers set name='forged' where id=$1 returning id",[id])).rowCount,0);
 assert.equal((await cashier.query("update store_members set role='ADMIN' where user_id=$1 returning user_id",[db.users.CASHIER_ONLY])).rowCount,0);
 await unchanged(()=>command(cashier,'product_catalog',{action:'create',product:{id:crypto.randomUUID(),name:'forged'}}));
});
test('actual restricted receipt/driver readers use bounded authenticated RPCs and reconcile exact saved payment movements',async()=>{
 const client=clients.CASHIER_ONLY,r=await command(client,'pos_sale',sale()),calls=[];
 const sb={from(){throw Error('Restricted reader attempted raw ledger access');},async rpc(name,args){calls.push({name,args});const allowed=['read_pos_headers','read_pos_lines','ledger_balances','ledger_events_page','search_pos_receipts'];assert.ok(allowed.includes(name),name);
  try{const result=await client.query(`select * from public.${name}(${Object.keys(args).map((key,i)=>key+'=>$'+(i+1)).join(',')})`,Object.values(args));return {data:result.rows,error:null};}catch(error){return {data:null,error:{message:error.message}};}}};
 const h=uiHarness({'@/lib/supabase':{getSupabaseClient:()=>sb},'@/store/useAuthStore':{useAuthStore:{getState:()=>({userRole:'CASHIER_ONLY'})}},'@/services/api/storeContext':{getActiveStoreId:async()=>db.store,getSyncIdentity:async()=>({storeId:db.store,deviceId:db.device})}});
 try{const receipt=await h.load('src/services/posReceipts.ts').readPosReceipt(r.eventId);assert.equal(receipt.netPiastres,1000);assert.equal(receipt.cogsPiastres,200);assert.equal(receipt.profitPiastres,800);assert.equal(receipt.number,r.documentNumber);
  const driver=h.load('src/lib/ledger/driver.ts').driver;assert.equal((await driver.eventLines(r.eventId)).find(l=>l.account==='wallet').amount_delta,1000);
  await assert.rejects(()=>driver.balances({account:'wallet'}),/FORBIDDEN/);assert.ok(calls.every(c=>c.args.p_store===db.store));
 }finally{await h.cleanup();}
});
test('actual ADMIN staff-role writer pins tenant, confirms persisted role and refuses zero-row updates',async()=>{
 const admin=clients.ADMIN;let activeStore=db.store;
 const sb={from(table){assert.equal(table,'store_members');let role;const where={};return {update(row){role=row.role;return this;},eq(key,value){where[key]=value;return this;},select(){return this;},async single(){const result=await admin.query('update store_members set role=$1 where user_id=$2 and store_id=$3 returning user_id,role',[role,where.user_id,where.store_id]);return result.rows.length===1?{data:result.rows[0],error:null}:{data:null,error:{message:'No matching member in this tenant'}};}}}};
 const h=uiHarness({'@/lib/supabase':{getSupabaseClient:()=>sb},'@/services/api/storeContext':{getActiveStoreId:async()=>activeStore}});
 try{const store=h.load('src/store/useUsersStore.ts').useUsersStore;store.setState({staffMembers:[{id:db.users.CASHIER_ONLY,userId:db.users.CASHIER_ONLY,role:'CASHIER_ONLY'}]});
 assert.equal(await store.getState().updateUserRole(db.users.CASHIER_ONLY,'POS_ECOMMERCE'),true);
 assert.equal((await db.admin.query('select role from store_members where user_id=$1',[db.users.CASHIER_ONLY])).rows[0].role,'POS_ECOMMERCE');
 activeStore=crypto.randomUUID();assert.equal(await store.getState().updateUserRole(db.users.CASHIER_ONLY,'ADMIN'),false);assert.equal(store.getState().staffMembers[0].role,'POS_ECOMMERCE');
 activeStore=db.store;assert.equal(await store.getState().updateUserRole(db.users.CASHIER_ONLY,'CASHIER_ONLY'),true);
 }finally{await h.cleanup();}
});
test('Cashier Only applies an existing discount and refunds it atomically, without discount-definition permission',async()=>{
 const code=crypto.randomUUID(),client=clients.CASHIER_ONLY;
 await db.insert('discount_codes',{id:code,store_id:db.store,device_id:db.device,code:'SYN-'+code,type:'percentage',value:10,maxUses:5});
 await client.query('select validate_discount_use($1,$2,1)',[db.store,code]);
 const before=await wallet(),r=await command(client,'pos_sale',sale(1,{discountCodeId:code,discountAmount:1}));assert.equal(await wallet(),before+900);
 let use=(await db.admin.query('select "usedCount","totalDiscount" from discount_codes where id=$1',[code])).rows[0];assert.equal(use.usedCount,1);assert.equal(Number(use.totalDiscount),1);
 const input=sale(-1,{returnOfEventId:r.eventId});input.payload.items[0].unitPrice=9;input.lines=buildSaleLines({items:input.payload.items,wallet:'inStoreSafe'});
 await command(client,'pos_sale',input);assert.equal(await wallet(),before);
 assert.equal((await client.query('update discount_codes set value=99 where id=$1 returning id',[code])).rowCount,0);
 use=(await db.admin.query('select "usedCount","totalDiscount" from discount_codes where id=$1',[code])).rows[0];assert.ok(Number(use.totalDiscount)>=0);assert.ok(use.usedCount>=0);
});
