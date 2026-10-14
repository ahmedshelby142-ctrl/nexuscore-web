import test from 'node:test';import assert from 'node:assert/strict';
import {uiHarness} from './helpers/ui-harness.mjs';
const draft={name:'Synthetic equipment',purchaseValue:100,salvageValue:0,usefulLifeYears:8,purchaseDate:'2026-10-14T00:00:00Z',paymentSource:'inStoreSafe'};
function memory(){const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),clear:()=>m.clear(),get length(){return m.size;}};}
function harness(server,state){
 const useFinancialStore={setState:fn=>Object.assign(state,fn(state))};
 return uiHarness({'./supabase':{getSupabaseClient:()=>({rpc:server})},'@/lib/supabase':{getSupabaseClient:()=>({rpc:server})},
 '@/services/api/storeContext':{getActiveStoreId:async()=> 'synthetic-store',getSyncIdentity:async()=>({storeId:'synthetic-store',deviceId:'synthetic-device'})},
 '@/services/api/fieldMapping':{fromRemoteRow:(_,r)=>r},'@/store/useFinancialStore':{useFinancialStore}});
}
test('asset canonical command replays one committed document after lost responses and module/page reload',async()=>{
 const storage=memory();Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:storage});
 let lose=true,writes=0,calls=[],saved;const state={assets:[]};
 const server=async(name,args)=>{assert.equal(name,'record_asset_command');calls.push(args);
  if(!saved){writes++;saved={...args.p_input.asset,id:args.p_id,store_id:args.p_store,ledger_event_id:'asset:'+args.p_id};}
  if(lose)throw Error('SYNTHETIC_RESPONSE_LOSS');
  return {data:{asset:saved,replayed:true},error:null};};
 const first=harness(server,state);let second;
 try{
  const commit1=first.load('src/lib/fixedAssetAccounting.ts').commitFixedAsset;
  const lost=await commit1(draft);assert.equal(lost.success,false);assert.equal(lost.definite,false);assert.equal(writes,1);assert.equal(calls.length,2);assert.equal(state.assets.length,0);assert.equal(storage.length,1);
  lose=false;second=harness(server,state);
  const recovered=await second.load('src/lib/fixedAssetAccounting.ts').commitFixedAsset({...draft});
  assert.equal(recovered.success,true);assert.equal(recovered.replayed,true);assert.equal(writes,1);assert.equal(new Set(calls.map(x=>x.p_id)).size,1);assert.equal(state.assets.length,1);assert.equal(storage.length,0);
  assert.equal(calls[0].p_command,'asset_record');assert.deepEqual(calls[0].p_input,{asset:draft});assert.equal(calls[0].p_input.lines,undefined);
 }finally{if(second)await second.cleanup();await first.cleanup();delete globalThis.sessionStorage;}
});
test('changed asset draft first resolves an uncertain original instead of silently creating or charging a second asset',async()=>{
 const storage=memory();Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:storage});
 let lose=true,writes=0,saved;const state={assets:[]},calls=[];
 const server=async(name,args)=>{calls.push(args);if(!saved){writes++;saved={...args.p_input.asset,id:args.p_id,store_id:args.p_store};}if(lose)throw Error('SYNTHETIC_RESPONSE_LOSS');return {data:{asset:saved,replayed:true},error:null};};
 const first=harness(server,state);let second;
 try{
  await first.load('src/lib/fixedAssetAccounting.ts').commitFixedAsset(draft);
  lose=false;second=harness(server,state);const changed=await second.load('src/lib/fixedAssetAccounting.ts').commitFixedAsset({...draft,purchaseValue:101});
  assert.equal(changed.success,false);assert.equal(changed.resolved,true);assert.match(changed.reason,/العملية السابقة/);assert.equal(writes,1);
  assert.equal(calls.at(-1).p_input.asset.purchaseValue,100);assert.equal(new Set(calls.map(x=>x.p_id)).size,1);
 }finally{if(second)await second.cleanup();await first.cleanup();delete globalThis.sessionStorage;}
});
test('confirmed acquisition remains successful if a UI/cache update fails; malformed confirmation retains the same request identity',async()=>{
 const storage=memory();Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:storage});let malformed=true,writes=0;const calls=[],state={assets:[]};
 const server=async(name,args)=>{calls.push(args);if(!writes)writes++;return {data:{asset:malformed?{id:'wrong-id',store_id:args.p_store}:{...args.p_input.asset,id:args.p_id,store_id:args.p_store}},error:null};};
 const h=harness(server,state);try{
  const commit=h.load('src/lib/fixedAssetAccounting.ts').commitFixedAsset;
  const unconfirmed=await commit(draft);assert.equal(unconfirmed.success,false);assert.equal(unconfirmed.definite,false);assert.equal(storage.length,1);
  malformed=false;Object.defineProperty(state,'assets',{get:()=>[],set:()=>{throw Error('SYNTHETIC_UI_CACHE_FAILURE');},configurable:true});
  const recovered=await commit(draft);assert.equal(recovered.success,true);assert.equal(writes,1);assert.equal(storage.length,0);assert.equal(new Set(calls.map(x=>x.p_id)).size,1);
 }finally{await h.cleanup();delete globalThis.sessionStorage;}
});
test('late asset acquisition confirmation cannot overwrite a newer authoritative asset reader',async()=>{
 const state={assets:[]};const server=async(name,args)=>{const row={...args.p_input.asset,id:args.p_id,store_id:args.p_store,updated_at:100};state.assets=[{...row,updated_at:200,name:'Newer authoritative name'}];return {data:{asset:row},error:null};};
 const h=harness(server,state);try{const result=await h.load('src/lib/fixedAssetAccounting.ts').commitFixedAsset(draft);assert.equal(result.success,true);assert.equal(state.assets[0].updated_at,200);assert.equal(state.assets[0].name,'Newer authoritative name');}
 finally{await h.cleanup();}
});
