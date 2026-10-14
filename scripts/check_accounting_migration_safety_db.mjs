import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {openBusinessDb,read,ROOT} from './helpers/business-db.mjs';
const base=['20261012080415','20261012082556','20261012090535','20261012191715','20261012194223','20261012203014','20261012204812','20261012213602','20261013010850','20261013015521','20261013022600','20261013031632','20261013111632','20261013120155'];
const batch=['supabase/migrations/20261014094740_courier_cod_service_fee.sql','supabase/migrations/20261014095804_fixed_asset_accounting.sql'];
test('new two-migration batch rolls back as a unit, preserves all public records/ACLs and adds only the required realtime membership',async()=>{
 let db;try{db=await openBusinessDb();for(const v of base){const file=fs.readdirSync(path.join(ROOT,'supabase/migrations')).find(f=>f.startsWith(v+'_'));await db.admin.query(read('supabase/migrations/'+file));}
  await db.insert('fixed_assets',{id:crypto.randomUUID(),store_id:db.store,device_id:db.device,name:'Synthetic legacy prepaid',purchaseValue:16000,salvageValue:0,usefulLifeYears:8,purchaseDate:'2024-10-14',createdAt:'2026-10-14',paymentSource:'prepaid',monthlyDepreciation:166.6666666667,isActive:true});
  const tables=(await db.admin.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows.map(r=>r.tablename);
  const hashes=async()=>{const result={};for(const table of tables){const quoted='"'+table.replaceAll('"','""')+'"';result[table]=(await db.admin.query("select md5(coalesce(string_agg(r::text,'' order by r::text),'')) hash from (select to_jsonb(x)-'codServiceFee'-'accountingStartDate'-'deactivatedAt' r from public."+quoted+' x) t')).rows[0].hash;}return result;};
  const before=await hashes();const view=(await db.admin.query("select relacl,reloptions from pg_class where oid='public.orders_operational'::regclass")).rows[0];
  await db.admin.query("create publication supabase_realtime for table public.orders");
  await db.admin.query('create function public.accounting_position(uuid) returns jsonb language sql as $$select null::jsonb$$');
  await db.admin.query('begin');try{for(const file of batch)await db.admin.query(read(file));assert.fail('Expected conflict in second migration');}catch(e){assert.match(e.message,/already exists/);}finally{await db.admin.query('rollback');}
  assert.equal((await db.admin.query("select count(*)::int n from information_schema.columns where table_schema='public' and column_name in ('codServiceFee','accountingStartDate','deactivatedAt')")).rows[0].n,0);
  assert.equal((await db.admin.query("select to_regclass('financial_private.cod_fee_commands') r")).rows[0].r,null);assert.deepEqual(await hashes(),before);
  await db.admin.query('drop function public.accounting_position(uuid)');
  await db.admin.query('begin');try{await db.admin.query("set local lock_timeout='5s';set local statement_timeout='60s'");for(const file of batch)await db.admin.query(read(file));await db.admin.query('commit');}catch(e){await db.admin.query('rollback');throw e;}
  assert.deepEqual(await hashes(),before);assert.deepEqual((await db.admin.query("select relacl,reloptions from pg_class where oid='public.orders_operational'::regclass")).rows[0],view);
  assert.deepEqual((await db.admin.query("select tablename from pg_publication_tables where pubname='supabase_realtime' order by tablename")).rows.map(r=>r.tablename),['fixed_assets','orders']);
  assert.equal((await db.admin.query("select has_table_privilege('authenticated','public.fixed_assets','TRUNCATE') p")).rows[0].p,false);
  for(const table of ['cod_fee_commands','cod_fee_permits','asset_commands','asset_write_permits']){
   const info=(await db.admin.query("select relrowsecurity,has_table_privilege('authenticated',oid,'SELECT') readable from pg_class where oid=$1::regclass",['financial_private.'+table])).rows[0];assert.equal(info.relrowsecurity,true);assert.equal(info.readable,false);
  }
  for(const signature of ['public.read_cod_fee_audit(uuid,text)','public.read_asset_audit(uuid,text)','public.correct_opening_asset_date(text,uuid,uuid,text,jsonb)','public.record_asset_command(text,uuid,uuid,text,jsonb)']){
   const r=(await db.admin.query("select has_function_privilege('anon',$1,'EXECUTE') anon,has_function_privilege('authenticated',$1,'EXECUTE') authenticated",[signature])).rows[0];assert.equal(r.anon,false);assert.equal(r.authenticated,true);
  }
 }finally{if(db)await db.close();}
});
