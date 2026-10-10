import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
const read = p => fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
let server, admin, port, dir, ctl; const clients=[];
const A=crypto.randomUUID(), B=crypto.randomUUID(), OWNER=crypto.randomUUID(), OTHER=crypto.randomUUID(), ACCOUNTANT=crypto.randomUUID(), STAFF=crypto.randomUUID(), MOD=crypto.randomUUID(), DEVICE=crypto.randomUUID();
before(async () => {
  port=await new Promise(resolve=>{ const s=net.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  fs.mkdirSync('logs',{recursive:true}); dir=fs.mkdtempSync(path.resolve('logs','wholesale-toggle-db-'));
  if(process.platform==='win32') {
    const bins=await import('@embedded-postgres/windows-x64'); ctl=bins.pg_ctl;
    const init=spawnSync(bins.initdb,['-D',dir,'-U','postgres','-A','trust','--encoding=UTF8','--locale=C'],{windowsHide:true,encoding:'utf8'}); assert.equal(init.status,0,init.stderr);
    server=spawn(bins.postgres,['-D',dir,'-p',String(port),'-h','127.0.0.1'],{windowsHide:true,stdio:'ignore'});
  } else { server=new EmbeddedPostgres({databaseDir:dir,port,user:'postgres',password:'test-only',persistent:true,onLog:()=>{},onError:()=>{}});await server.initialise();await server.start(); }
  for(let i=0;i<60;i++){admin=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});try{await admin.connect();break;}catch(e){await admin.end().catch(()=>{});if(i===59)throw e;await new Promise(r=>setTimeout(r,100));}}
  fs.mkdirSync('logs/wholesale-toggle',{recursive:true});
  fs.writeFileSync('logs/wholesale-toggle/local-db-version.txt',(await admin.query('select version()')).rows[0].version);
  await admin.query(read('scripts/fixtures/financial-schema.sql'));
  await admin.query(read('docs/migrations/049_owner_equity.sql').match(/CREATE OR REPLACE FUNCTION public\.ledger_validate_event[\s\S]*?\$function\$;/)[0]);
  await admin.query(read('supabase/migrations/20261005115027_financial_write_safety.sql'));
  // Actual wholesale table declarations plus captured deployed RLS below.
  const wholesale=read('docs/migrations/016_wholesale_documents.sql');
  for(const name of ['wholesale_clients','wholesale_invoices']) await admin.query(wholesale.match(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${name} \\([\\s\\S]*?\\n\\);`))[0]);
  await admin.query(`
    CREATE TABLE stores(id uuid PRIMARY KEY,name text);
    ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
    CREATE POLICY select_stores ON stores FOR SELECT USING(is_store_member(id));
    CREATE POLICY update_stores ON stores FOR UPDATE USING(has_role(id,VARIADIC ARRAY['ADMIN'])) WITH CHECK(has_role(id,VARIADIC ARRAY['ADMIN']));
    CREATE TABLE orders(id text PRIMARY KEY,store_id uuid,"orderNumber" text,"wholesaleClientId" text,"stockItems" jsonb);
    CREATE TABLE return_records(id text PRIMARY KEY,store_id uuid,original_order_id text,type text);
    ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
    ALTER TABLE return_records ENABLE ROW LEVEL SECURITY;
    CREATE POLICY read_orders ON orders FOR SELECT USING(can_read_store_finance(store_id));
    CREATE POLICY write_orders ON orders FOR ALL USING(has_role(store_id,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY'])) WITH CHECK(has_role(store_id,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']));
    CREATE POLICY read_returns ON return_records FOR SELECT USING(can_read_store_finance(store_id));
    CREATE POLICY write_returns ON return_records FOR ALL USING(has_role(store_id,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY'])) WITH CHECK(has_role(store_id,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']));
    ALTER TABLE wholesale_clients ENABLE ROW LEVEL SECURITY;
    ALTER TABLE wholesale_invoices ENABLE ROW LEVEL SECURITY;
    CREATE POLICY read_clients ON wholesale_clients FOR SELECT USING(can_read_store_finance(store_id));
    CREATE POLICY write_clients ON wholesale_clients FOR ALL USING(has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT'])) WITH CHECK(has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT']));
    CREATE POLICY read_invoices ON wholesale_invoices FOR SELECT USING(can_read_store_finance(store_id));
    CREATE POLICY write_invoices ON wholesale_invoices FOR ALL USING(has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT'])) WITH CHECK(has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT']));
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
    DROP POLICY events_write ON ledger_events;
    CREATE POLICY events_write ON ledger_events FOR INSERT WITH CHECK(is_store_member(store_id) AND CASE WHEN kind IN ('owner_capital','owner_contribution') THEN has_role(store_id,VARIADIC ARRAY['ADMIN']) WHEN kind IN ('stock_adjustment','purchase','supplier_payment','expense','payroll','owner_draw','wallet_transfer','deposit_refunded') THEN has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT']) ELSE has_role(store_id,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY','ACCOUNTANT']) END);
    DROP POLICY lines_write ON ledger_lines;
    CREATE POLICY lines_write ON ledger_lines FOR INSERT WITH CHECK(has_role(store_id,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY','ACCOUNTANT']) AND EXISTS(SELECT 1 FROM ledger_events e WHERE e.id=ledger_lines.event_id AND e.store_id=ledger_lines.store_id AND e.xmin=pg_current_xact_id()::xid));
  `);
  await admin.query('insert into stores values($1,$3),($2,$4)',[A,B,'A','B']);
  await admin.query("insert into store_members values($1,$6,'ADMIN'),($2,$7,'ADMIN'),($3,$6,'ACCOUNTANT'),($4,$6,'POS_ECOMMERCE'),($5,$6,'MODERATOR')",[OWNER,OTHER,ACCOUNTANT,STAFF,MOD,A,B]);
  await admin.query('insert into wholesale_clients(id,store_id,device_id,"companyName") values($1,$2,$3,$4)',['client-A',A,DEVICE,'Trader']);
  await admin.query('insert into wholesale_invoices(id,store_id,device_id,"invoiceNumber","clientId",items,"remainingAmount") values($1,$2,$3,$4,$5,$6,100)',['invoice-A',A,DEVICE,'FJ-A','client-A','[{"quantity":2}]']);
  await admin.query('insert into orders values($1,$2,$3,$4,$5)',['order-A',A,'ECO-A','client-A','[{"wholesaleInvoiceId":"invoice-A"}]']);
  await admin.query(read('supabase/migrations/20261010183049_wholesale_feature_toggle.sql'));
  await admin.query('GRANT SELECT,UPDATE ON stores TO authenticated');
});
after(async()=>{for(const c of clients)await c.end();await admin?.end();if(ctl)spawnSync(ctl,['-D',dir,'stop','-m','fast'],{windowsHide:true,stdio:'ignore'});else if(server)await server.stop();});
async function client(user=OWNER){const c=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});await c.connect();clients.push(c);await c.query('set role authenticated');await c.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);return c;}
async function toggle(c,value,store=A){return c.query('update stores set wholesale_enabled=$1 where id=$2 returning wholesale_enabled',[value,store]);}
const disabled= /NEXUS_WHOLESALE_DISABLED/;
function event({refType='wholesale_invoice',refId='FJ-A',payload={},lines,kind='sale'}={}){return {id:crypto.randomUUID(),store_id:A,device_id:DEVICE,kind,ref_type:refType,ref_id:refId,payload:JSON.stringify(payload),occurred_at:new Date().toISOString(),created_at:new Date().toISOString(),lines:lines??[{id:crypto.randomUUID(),account:'wallet',subject_id:'inStoreSafe',amount_delta:100},{id:crypto.randomUUID(),account:'revenue',subject_id:'wholesale',amount_delta:100}]};}
const append=(c,e)=>c.query('select ledger_append($1)',[e]);
test('existing/new default OFF, only ADMIN changes, isolated members see their store',async()=>{
  const owner=await client(),accountant=await client(ACCOUNTANT),staff=await client(STAFF),other=await client(OTHER),anonymous=await client(crypto.randomUUID());
  assert.equal((await owner.query('select wholesale_enabled from stores')).rows[0].wholesale_enabled,false);
  for(const c of [accountant,staff,anonymous])assert.equal((await toggle(c,true)).rowCount,0);
  assert.equal((await toggle(owner,true,B)).rowCount,0);
  await toggle(owner,true);assert.equal((await accountant.query('select wholesale_enabled from stores')).rows[0].wholesale_enabled,true);
  assert.equal((await other.query('select wholesale_enabled from stores')).rows[0].wholesale_enabled,false);
  await admin.query("insert into stores(id) values($1)",[crypto.randomUUID()]);
  assert.equal((await admin.query('select count(*)::int n from stores where wholesale_enabled=false')).rows[0].n,2);
  await toggle(owner,false);
});
test('OFF rejects clients, invoices, payments, returns, wholesale orders, marker removal and ledger RPCs',async()=>{
  const c=await client();await toggle(c,false);
  for(const sql of [
    `insert into wholesale_clients(id,store_id,device_id,"companyName") values('new','${A}','${DEVICE}','New')`,
    `insert into wholesale_invoices(id,store_id,device_id,"invoiceNumber","clientId") values('new','${A}','${DEVICE}','FJ-new','client-A')`,
    `update wholesale_invoices set "paidAmount"=10,"remainingAmount"=90 where id='invoice-A'`,
    `delete from wholesale_clients where id='client-A'`,
    `insert into return_records values('return-A','${A}','invoice-A','wholesale_return')`,
    `insert into return_records values('return-hidden','${A}','invoice-A','refund')`,
    `insert into orders values('new','${A}','ECO-new','client-A','[]')`,
    `update orders set "wholesaleClientId"=null,"stockItems"='[]' where id='order-A'`,
  ]) await assert.rejects(c.query(sql),disabled);
  const variants=[event(),event({refType:'ecommerce_order',refId:'ECO-A'}),event({refType:null,refId:null,payload:{channel:'wholesale'}}),event({refType:null,refId:null,payload:{type:'wholesale_return'}}),event({refType:null,refId:null})];
  for(const e of variants){await assert.rejects(append(c,e),disabled);assert.equal((await admin.query('select count(*)::int n from ledger_events where id=$1',[e.id])).rows[0].n,0);}
  const payment=event({kind:'client_payment',refType:null,refId:null,lines:[{id:crypto.randomUUID(),account:'wallet',subject_id:'inStoreSafe',amount_delta:100},{id:crypto.randomUUID(),account:'receivable_client',subject_id:'client-A',amount_delta:-100}]});
  await assert.rejects(append(c,payment),disabled);
});
test('direct table inserts and financial command wrapper cannot bypass OFF',async()=>{
  const c=await client();await toggle(c,false);
  const e=event();await assert.rejects(c.query('insert into ledger_events(id,store_id,device_id,kind,occurred_at,created_at,ref_type,payload) values($1,$2,$3,$4,$5,$6,$7,$8)',[e.id,A,DEVICE,'sale',e.occurred_at,e.created_at,'wholesale_invoice','{}']),disabled);
  await assert.rejects(c.query('select record_financial_command($1,$2,$3,$4,$5)',[crypto.randomUUID(),A,DEVICE,'ledger',{kind:'owner_draw',refType:'wholesale_invoice',lines:[{account:'wallet',subjectId:'inStoreSafe',amount:-1},{account:'owner_budget',subjectId:'owner',amount:1}]}]),disabled);
  await assert.rejects(c.query('select wholesale_private.assert_enabled($1)',[A]),/permission denied/);
});
test('ON restores permitted wholesale operations; disable/reenable preserves history byte-for-byte',async()=>{
  const c=await client();const snapshot=async()=>JSON.stringify((await admin.query("select jsonb_build_object('clients',(select jsonb_agg(t) from wholesale_clients t),'invoices',(select jsonb_agg(t) from wholesale_invoices t),'orders',(select jsonb_agg(t) from orders t),'returns',(select jsonb_agg(t) from return_records t),'events',(select jsonb_agg(t) from ledger_events t),'lines',(select jsonb_agg(t) from ledger_lines t)) data")).rows[0]);
  const before=await snapshot();await toggle(c,true);await toggle(c,false);await toggle(c,true);assert.equal(await snapshot(),before);
  await append(c,event());await c.query('update wholesale_invoices set "paidAmount"=1 where id=$1',['invoice-A']);
  const withLedger=await snapshot();await toggle(c,false);await toggle(c,true);assert.equal(await snapshot(),withLedger);
  const accountant=await client(ACCOUNTANT);
  assert.equal((await accountant.query('update wholesale_invoices set "paidAmount"=2 where id=$1 returning id',['invoice-A'])).rowCount,1);
  const staff=await client(STAFF);
  assert.equal((await staff.query('update stores set wholesale_enabled=false where id=$1 returning *',[A])).rowCount,0);
  await toggle(c,false);assert.equal((await c.query('select count(*)::int n from wholesale_invoices')).rows[0].n,1);
});
test('OFF preserves retail/ecommerce, retail returns and unrelated finance permissions',async()=>{
  const c=await client(), accountant=await client(ACCOUNTANT), staff=await client(STAFF), mod=await client(MOD);await toggle(c,false);
  for(const channel of ['pos','ecommerce'])await append(c,event({refType:channel==='pos'?'pos_sale':'ecommerce_order',refId:crypto.randomUUID(),payload:{channel},lines:[{id:crypto.randomUUID(),account:'wallet',subject_id:'inStoreSafe',amount_delta:100},{id:crypto.randomUUID(),account:'revenue',subject_id:channel,amount_delta:100}]}));
  await c.query(`insert into orders values('retail','${A}','ECO-retail',null,'[]')`);await c.query(`insert into return_records values('retail','${A}','retail','refund')`);
  const draw=()=>[crypto.randomUUID(),A,DEVICE,'ledger',{kind:'owner_draw',refType:'owner_draw',lines:[{account:'wallet',subjectId:'inStoreSafe',amount:-1},{account:'owner_budget',subjectId:'owner',amount:1}]}];
  await accountant.query('select record_financial_command($1,$2,$3,$4,$5)',draw());
  for(const denied of [staff,mod])await assert.rejects(denied.query('select record_financial_command($1,$2,$3,$4,$5)',draw()),/NEXUS_FINANCE_FORBIDDEN/);
});
test('a disable serializes with in-flight wholesale writes; later writes are refused',async()=>{
  const writer=await client(), owner=await client();await toggle(owner,true);
  await writer.query('begin');await append(writer,event());
  let finished=false;const disabling=toggle(owner,false).then(()=>{finished=true;});
  await new Promise(r=>setTimeout(r,80));assert.equal(finished,false);
  await writer.query('commit');await disabling;
  await assert.rejects(append(writer,event()),disabled);
});
