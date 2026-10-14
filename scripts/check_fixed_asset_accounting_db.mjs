import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {openBusinessDb,read,ROOT} from './helpers/business-db.mjs';
import {buildWalletOpeningLines} from '../src/lib/ledger/audit.ts';
const versions=['20261012080415','20261012082556','20261012090535','20261012191715','20261012194223','20261012203014','20261012204812','20261012213602','20261013010850','20261013015521','20261013022600','20261013031632','20261013111632','20261013120155','20261014094740'];
let db,c,legacy,today,original;const evidence=[];
const total=async acc=>(await db.admin.query('select coalesce(sum(amount_delta),0)::int n from ledger_lines where store_id=$1 and account=$2',[db.store,acc])).rows[0].n;
before(async()=>{db=await openBusinessDb();c=await db.client();for(const v of versions){const f=fs.readdirSync(path.join(ROOT,'supabase/migrations')).find(f=>f.startsWith(v+'_'));await db.admin.query(read('supabase/migrations/'+f));}
 today=(await db.admin.query("select to_char(now() at time zone 'Africa/Cairo','YYYY-MM-DD') d")).rows[0].d;
 legacy={id:crypto.randomUUID(),store_id:db.store,device_id:db.device,name:'Synthetic historic Sharp',purchaseValue:16000,salvageValue:0,usefulLifeYears:8,purchaseDate:'2024-10-14',createdAt:'2026-10-14T00:00:00Z',paymentSource:'prepaid',monthlyDepreciation:166.66666666666666,isActive:true};
 await db.insert('fixed_assets',legacy);await c.query('select ledger_append($1)',[db.event('stock_adjustment','opening_balance','inStoreSafe',buildWalletOpeningLines({wallet:'inStoreSafe',amount:20000}))]);
 original=(await db.admin.query('select to_jsonb(a) r from fixed_assets a where id=$1',[legacy.id])).rows[0].r;
 await db.admin.query(read('supabase/migrations/20261014095804_fixed_asset_accounting.sql'));
});
after(async()=>{if(db){fs.writeFileSync(path.join(process.env.NEXUS_QA_TEST_LOG_ROOT||path.join(ROOT,'logs/final-v1-sprint'),'asset-accounting-regression-'+Date.now()+'.json'),JSON.stringify({version:db.version,scope:'isolated synthetic only; not Production verified',evidence},null,2));await db.close();}});
async function summary(asof='2026-10-14',from=null,to=null,client=c){return (await client.query('select fixed_asset_accounting($1,$2,$3,$4) r',[db.store,asof,from,to])).rows[0].r;}
const doc=(patch={})=>({id:crypto.randomUUID(),store_id:db.store,device_id:db.device,name:'Synthetic asset',purchaseValue:100,salvageValue:0,usefulLifeYears:8,purchaseDate:today,paymentSource:'prepaid',isActive:true,...patch});
const record=async(a,client=c)=>(await client.query('select record_fixed_asset($1,$2) r',[a,a.paymentSource==='prepaid'?null:db.event('expense','fixed_asset',a.id,[{account:'expense',subjectId:'assets',amount:a.purchaseValue},{account:'wallet',subjectId:a.paymentSource,amount:-a.purchaseValue}])])).rows[0].r;
test('historic16000 at24 months: accumulated4000, book12000, opening equity12000, current P&L0, no wallet debit',async()=>{
 const r=await summary(),a=r.rows.find(x=>x.id===legacy.id);assert.equal(a.grossPiastres,1600000);assert.equal(a.accumulatedDepreciationPiastres,400000);assert.equal(a.netBookPiastres,1200000);assert.equal(a.historicalDepreciationPiastres,400000);assert.equal(a.periodDepreciationPiastres,0);assert.equal(r.openingEquityAdjustmentPiastres,1200000);assert.equal(a.monthlyEstimatePiastres,16667);assert.equal(await total('wallet'),2000000);assert.equal(await total('expense'),0);
 const now=(await db.admin.query('select to_jsonb(a) r from fixed_assets a where id=$1',[legacy.id])).rows[0].r;delete now.accountingStartDate;delete now.deactivatedAt;assert.deepEqual(now,original);evidence.push({scenario:'historic2year',r});
});
test('anniversary cumulative rounding telescopes, period clipping excludes pre-adoption history, life ends at residual',async()=>{
 const a=(await summary('2026-11-14')).rows.find(x=>x.id===legacy.id),b=(await summary('2026-12-14')).rows.find(x=>x.id===legacy.id);
 assert.equal(a.lifetimeDepreciationPiastres,16667);assert.equal(b.lifetimeDepreciationPiastres,33333);
 const r=await summary('2026-11-01','2026-10-01T00:00:00+03:00','2026-11-01T00:00:00+02:00');assert.equal(r.rows[0].periodDepreciationPiastres,9677);
 const end=(await summary('2032-10-14')).rows.find(x=>x.id===legacy.id);assert.equal(end.netBookPiastres,0);assert.equal(end.accumulatedDepreciationPiastres,1600000);assert.equal(end.monthlyEstimatePiastres,0);
 assert.equal((await summary('2036-10-14')).rows.find(x=>x.id===legacy.id).netBookPiastres,0);evidence.push({scenario:'calendarperiod/life',a,b,r,end});
});
test('leap dates, partial month, residual and date validation are deterministic in actual PostgreSQL',async()=>{
 const dep=async(cost,salvage,months,start,end)=>Number((await db.admin.query('select financial_private.asset_depreciation($1,$2,$3,$4,$5) n',[cost,salvage,months,start,end])).rows[0].n);
 assert.equal(await dep(12000,0,12,'2024-01-31','2024-02-29'),1000);
 assert.equal(await dep(12000,0,12,'2024-01-31','2024-02-14'),483);
 assert.equal(await dep(12000,2000,12,'2024-01-31','2030-01-01'),10000);
 assert.equal(await dep(12000,0,12,'2024-01-31','2024-01-01'),0);
 await assert.rejects(dep(100,101,12,'2024-01-31','2026-10-14'),/INVALID/);
});
test('paid capital acquisition transfers100 from cash into asset and reclassifies expense, without artificial loss/equity increase',async()=>{
 const a=doc({paymentSource:'inStoreSafe'}),cash=await total('wallet'),r=await record(a);assert.equal(await total('wallet'),cash-10000);assert.equal(r.asset.ledger_event_id,'asset:'+a.id);
 const acct=await summary(today);assert.equal(acct.capitalPurchasesReclassifiedPiastres,10000);assert.equal(acct.rows.find(x=>x.id===a.id).netBookPiastres,10000);
 const position=(await c.query('select accounting_position($1) r',[db.store])).rows[0].r;
 assert.equal(position.totalAssets,3200000);assert.equal(position.equity,3200000);assert.equal(position.reconciliationDifference,0);assert.equal(position.reviewRequired,false);
 const p=(await c.query('select owner_financial_summary($1) r',[db.store])).rows[0].r;assert.equal(p.rawLedgerExpenses,10000);assert.equal(p.expenses,0);assert.equal(p.profitBeforeDepreciation,0);assert.equal(p.netProfit,0);
 assert.equal((await record(a)).replayed,true);assert.equal(await total('wallet'),cash-10000);await assert.rejects(record({...a,purchaseValue:101}),/PAYLOAD_MISMATCH/);evidence.push({scenario:'capitalized100',r,acct,p});
});
test('prepaid recognition, invalid residual/life/precision, immutable history, permitted accountant and denied ecommerce',async()=>{
 const a=doc(),cash=await total('wallet'),r=await record(a);assert.equal(await total('wallet'),cash);assert.equal(r.asset.ledger_event_id,null);
 for(const patch of [{salvageValue:101},{salvageValue:-1},{usefulLifeYears:0},{usefulLifeYears:.1},{purchaseValue:100.001}])await assert.rejects(record(doc(patch)),/INVALID/);
 await assert.rejects(c.query('update fixed_assets set "purchaseValue"=101 where id=$1',[a.id]),/COMMAND_REQUIRED/);await assert.rejects(c.query('delete from fixed_assets where id=$1',[a.id]),/HISTORY_IMMUTABLE/);
 await record(doc(),await db.client('ACCOUNTANT'));await assert.rejects(record(doc(),await db.client('ECOMMERCE_ONLY')),/FORBIDDEN/);
});
test('deactivation freezes future depreciation at an auditable date without erasing net book value or historical period',async()=>{
 const id=crypto.randomUUID(),req={assetId:legacy.id,reason:'Synthetic retirement'};
 const call=async()=>(await c.query("select deactivate_fixed_asset($1,$2,$3,'asset_deactivate',$4) r",[id,db.store,db.device,req])).rows[0].r;
 const r=await call();assert.equal(r.asset.isActive,false);assert.equal(r.asset.deactivatedAt,today);assert.equal((await call()).replayed,true);
 const a=(await summary('2032-10-14')).rows.find(x=>x.id===legacy.id);assert.equal(a.status,'inactive');assert.equal(a.netBookPiastres,1200000);assert.equal(a.monthlyEstimatePiastres,0);
 assert.equal((await summary('2026-10-14')).rows.find(x=>x.id===legacy.id).accumulatedDepreciationPiastres,400000);evidence.push({scenario:'retirement',r,a});
});
test('late journal refusal rolls back asset and canonical wallet event; foreign store and raw inserts cannot bypass contract',async()=>{
 const a=doc({paymentSource:'inStoreSafe'}),cash=await total('wallet');
 await db.admin.query("create function public.qa_asset_fail() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_ASSET_LATE_FAILURE';end$$;create trigger qa_asset_fail before insert on financial_private.asset_commands for each row execute function public.qa_asset_fail()");
 try{await assert.rejects(record(a),/SYNTHETIC_ASSET_LATE_FAILURE/);assert.equal(await total('wallet'),cash);assert.equal((await db.admin.query('select count(*)::int n from fixed_assets where id=$1',[a.id])).rows[0].n,0);assert.equal((await db.admin.query('select count(*)::int n from ledger_events where id=$1',['asset:'+a.id])).rows[0].n,0);}
 finally{await db.admin.query('drop trigger qa_asset_fail on financial_private.asset_commands;drop function qa_asset_fail()');}
 await assert.rejects(record({...doc(),store_id:crypto.randomUUID()}),/FORBIDDEN/);
 await assert.rejects(c.query('insert into fixed_assets(id,store_id,name,"purchaseValue","usefulLifeYears","purchaseDate") values($1,$2,$3,100,8,now())',[crypto.randomUUID(),db.store,'Forged isolated']),/COMMAND_REQUIRED/);
});
test('durable five-argument asset command derives one acquisition, rejects a changed replay and serializes concurrent retry',async()=>{
 const id=crypto.randomUUID(),input={asset:{name:'Synthetic durable equipment',purchaseValue:100,salvageValue:0,usefulLifeYears:8,purchaseDate:today,paymentSource:'inStoreSafe'}},cash=await total('wallet');
 const call=async(client=c,body=input)=>(await client.query("select record_asset_command($1,$2,$3,'asset_record',$4) r",[id,db.store,db.device,body])).rows[0].r;
 const results=await Promise.all([call(),call(await db.client())]);assert.equal(results.filter(r=>r.replayed).length,1);
 assert.equal(await total('wallet'),cash-10000);assert.equal(results[0].asset.id,id);assert.equal(results[0].asset.ledger_event_id,'asset:'+id);
 await assert.rejects(call(c,{asset:{...input.asset,purchaseValue:101}}),/PAYLOAD_MISMATCH/);
 assert.equal((await db.admin.query('select count(*)::int n from ledger_events where id=$1',['asset:'+id])).rows[0].n,1);
});
test('owner-confirmed opening date correction preserves cash/ledger and retains exact before/after equity delta and actor',async()=>{
 const a=(await record(doc({name:'Synthetic wrongly dated Sharp',purchaseValue:16000,purchaseDate:'2026-08-14'}))).asset;
 const fingerprint=async()=>(await db.admin.query("select md5(coalesce(string_agg(to_jsonb(l)::text,'' order by id),'')) hash from ledger_lines l")).rows[0].hash;
 const hash=await fingerprint(),cash=await total('wallet'),id=crypto.randomUUID();
 const req={assetId:a.id,beforeRevision:a.updated_at??0,beforePurchaseDate:'2026-08-14',purchaseDate:'2024-10-14',reason:'Owner confirmed original purchase date; synthetic isolated test'};
 const call=async(client=c,body=req,operation=id)=>(await client.query("select correct_opening_asset_date($1,$2,$3,'asset_opening_date',$4) r",[operation,db.store,db.device,body])).rows[0].r;
 await assert.rejects(call(await db.client('ACCOUNTANT')),/OWNER_ONLY/);
 const r=await call();assert.equal(r.beforePosition.accumulatedDepreciationPiastres,33333);assert.equal(r.afterPosition.accumulatedDepreciationPiastres,400000);
 assert.equal(r.afterPosition.netBookPiastres,1200000);assert.equal(r.openingEquityDeltaPiastres,-366667);
 assert.equal(await fingerprint(),hash);assert.equal(await total('wallet'),cash);assert.equal((await call()).replayed,true);
 await assert.rejects(call(c,{...req,purchaseDate:'2024-10-13'}),/PAYLOAD_MISMATCH/);
 await assert.rejects(call(c,req,crypto.randomUUID()),/STALE/);
 const audit=(await c.query('select read_asset_audit($1,$2) r',[db.store,a.id])).rows[0].r;
 assert.equal(audit.length,2);const correction=audit.find(x=>x.id===id);assert.equal(correction.actorId,db.users.ADMIN);assert.ok(correction.at);assert.equal(correction.result.openingEquityDeltaPiastres,-366667);assert.equal(correction.request.input.reason,req.reason);
 const other=await db.client('ECOMMERCE_ONLY');await assert.rejects(other.query('select read_asset_audit($1,$2)',[db.store,a.id]),/FORBIDDEN/);
 const account=(await summary()).rows.find(x=>x.id===a.id);assert.equal(account.periodDepreciationPiastres,0);
 evidence.push({scenario:'audited Sharp date correction ONLY local, owner confirmation 2024-10-14',r,audit});
});
test('opening correction late audit failure rolls back date and revision; concurrent corrections use the original revision once',async()=>{
 const a=(await record(doc({purchaseDate:'2026-08-14'}))).asset;
 const req={assetId:a.id,beforeRevision:a.updated_at??0,beforePurchaseDate:'2026-08-14',purchaseDate:'2024-10-14',reason:'Synthetic correction'};
 const call=async(client=c,input=req)=>(await client.query("select correct_opening_asset_date($1,$2,$3,'asset_opening_date',$4) r",[crypto.randomUUID(),db.store,db.device,input])).rows[0].r;
 await db.admin.query("create function public.qa_asset_correction_fail() returns trigger language plpgsql as $$begin if NEW.request->>'command'='asset_opening_date' then raise exception 'SYNTHETIC_CORRECTION_FAILURE';end if;return NEW;end$$;create trigger qa_asset_correction_fail before insert on financial_private.asset_commands for each row execute function public.qa_asset_correction_fail()");
 try{await assert.rejects(call(),/SYNTHETIC_CORRECTION_FAILURE/);assert.deepEqual((await db.admin.query('select to_jsonb(a) r from fixed_assets a where id=$1',[a.id])).rows[0].r,a);}
 finally{await db.admin.query('drop trigger qa_asset_correction_fail on financial_private.asset_commands;drop function qa_asset_correction_fail()');}
 const results=await Promise.allSettled([call(),call(await db.client(),{...req,purchaseDate:'2024-10-13'})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/STALE/);
});
test('five historical prepaid assets reconcile cumulative rounding and opening equity independently of current cash and P&L',async()=>{
 const specs=[[16000,0,8,'2026-08-14'],[12000,0,8,'2025-10-15'],[9000,0,5,'2025-10-15'],[10000,1000,10,'2026-10-14'],[6000,0,6,'2025-10-15']];
 const cash=await total('wallet'),expense=await total('expense'),ids=[];
 for(const [purchaseValue,salvageValue,usefulLifeYears,purchaseDate] of specs)ids.push((await record(doc({purchaseValue,salvageValue,usefulLifeYears,purchaseDate}))).asset.id);
 const rows=(await summary()).rows.filter(a=>ids.includes(a.id));const sum=key=>rows.reduce((n,a)=>n+a[key],0);
 assert.equal(sum('grossPiastres'),5300000);assert.equal(sum('historicalDepreciationPiastres'),462138);assert.equal(sum('netBookPiastres'),4837862);assert.equal(sum('openingCarryingPiastres'),4837862);assert.equal(sum('periodDepreciationPiastres'),0);assert.equal(sum('monthlyEstimatePiastres'),60000);assert.equal(await total('wallet'),cash);assert.equal(await total('expense'),expense);
});
