// Actual Zustand order writer with synthetic SDK boundaries. No cloud session.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {uiHarness} from './helpers/ui-harness.mjs';

function setup() {
  let finish; const wait=new Promise(resolve=>{finish=resolve;});
  const patches=[],upserts=[],receivables=[],warnings=[];
  const identity={storeId:'synthetic-store',deviceId:'synthetic-device'};
  const query={eq(k,v){patches.at(-1).filters.push([k,v]);return this;},select(){return this;},single(){return wait;}};
  const h=uiHarness({
    'zustand/middleware':{persist:creator=>creator},
    './useBusinessStore':{useBusinessStore:{getState:()=>({})}},
    './useCustomerStore':{useCustomerStore:{getState:()=>({})}},
    './useCourierStore':{useCourierStore:{getState:()=>({})}},
    './useFinancialStore':{useFinancialStore:{getState:()=>({createCourierReceivable:r=>receivables.push(r)})}},
    '@/services/cloudData':{writeThrough:async(...args)=>{upserts.push(args);return wait;},AFTER_COMMIT_MESSAGE:'Already committed'},
    '@/services/documentNumber':{nextDocumentNumber:()=>{throw Error('No numbering allowed');}},
    '@/services/api/storeContext':{getSyncIdentity:async()=>({...identity})},
    '@/lib/supabase':{getSupabaseClient:()=>({from(table){assert.equal(table,'orders');return {update(payload){patches.push({payload,filters:[]});return query;}};}})},
    '@/lib/ledger':{prepareEvent:()=>{throw Error('No ledger writes allowed');}},
    '@/lib/financialCommand':{runFinancialCommand:()=>{throw Error('No financial command allowed');},resolvePendingFinancialCommand:()=>null},
    sonner:{toast:{error:m=>warnings.push(m)}},
  });
  const {useOrderStore}=h.load('src/store/useOrderStore.ts');
  const original={id:'synthetic-order',store_id:identity.storeId,status:'pending',items:[{quantity:5}],stockItems:[{quantity:5,costPiastres:500}],fulfillment:{version:1,demands:[{quantity:5,allocated:5,missing:0}]},totalAmount:50,courierFee:70};
  useOrderStore.setState({orders:[original]});
  return {h,useOrderStore,original,identity,patches,upserts,receivables,warnings,finish};
}

test('backorder handoff awaits a tenant-scoped existing-row patch and keeps canonical allocation, with one in-flight request',async()=>{
  const x=setup(); let pending;
  try {
    pending=x.useOrderStore.getState().updateOrderStatus(x.original.id,'shipped');
    assert.equal(x.useOrderStore.getState().orders[0].status,'pending','Never show shipped before server confirmation');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(x.receivables.length,0);
    assert.equal(x.upserts.length,0,'Existing guarded orders must never take the INSERT path');
    assert.equal(x.patches.length,1);
    assert.equal(x.patches[0].payload.status,'shipped');
    for(const field of ['items','stockItems','fulfillment','totalAmount','depositAmount','expectedCod'])assert.equal(field in x.patches[0].payload,false,'Status change must preserve authoritative '+field);
    assert.ok(x.patches[0].filters.some(([k,v])=>k==='id'&&v===x.original.id));
    assert.ok(x.patches[0].filters.some(([k,v])=>k==='store_id'&&v===x.original.store_id));
    await x.useOrderStore.getState().updateOrderStatus(x.original.id,'shipped');
    assert.equal(x.patches.length,1);
    const canonical={...x.original,status:'shipped',serverNote:'canonical response'};
    x.finish({data:canonical,error:null}); await pending;
    assert.equal(x.useOrderStore.getState().orders[0].status,'shipped');
    assert.equal(x.useOrderStore.getState().orders[0].serverNote,'canonical response');
    assert.deepEqual(x.useOrderStore.getState().orders[0].fulfillment,x.original.fulfillment);
    assert.equal(x.receivables.length,1);
  } finally {x.finish({data:x.original,error:null});await pending?.catch(()=>{});await x.h.cleanup();}
});

test('refused handoff keeps the persisted pending state and creates no legacy courier document',async()=>{
  const x=setup();try{
    const pending=x.useOrderStore.getState().updateOrderStatus(x.original.id,'shipped');
    x.finish({data:null,error:{message:'NEXUS_FULFILLMENT_INCOMPLETE'}});
    await assert.rejects(pending,/NEXUS_FULFILLMENT_INCOMPLETE/);
    assert.equal(x.useOrderStore.getState().orders[0].status,'pending');
    assert.equal(x.receivables.length,0);assert.equal(x.upserts.length,0);
  }finally{await x.h.cleanup();}
});

test('supported descriptive order update patches only supplied fields, preserving newer server fulfillment',async()=>{
  const x=setup();try{
    const pending=x.useOrderStore.getState().updateOrder(x.original.id,{customerName:'Synthetic edited name'});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(x.upserts.length,0);assert.equal(x.patches.length,1);
    assert.equal(x.patches[0].payload.customerName,'Synthetic edited name');
    assert.equal('fulfillment' in x.patches[0].payload,false);assert.equal('stockItems' in x.patches[0].payload,false);
    const newer={...x.original,customerName:'Synthetic edited name',fulfillment:{version:1,demands:[{quantity:6,allocated:6,missing:0}]}};
    x.finish({data:newer,error:null});await pending;
    assert.deepEqual(x.useOrderStore.getState().orders[0].fulfillment,newer.fulfillment);
    assert.equal(x.receivables.length,0);
  }finally{await x.h.cleanup();}
});

test('a store switch during an acknowledged patch cannot commit the old tenant response into the new local context',async()=>{
 const x=setup();try{
  const pending=x.useOrderStore.getState().updateOrderStatus(x.original.id,'shipped');
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(x.patches[0].filters.some(([k,v])=>k==='store_id'&&v==='synthetic-store'));
  x.identity.storeId='another-synthetic-store';
  x.finish({data:{...x.original,status:'shipped'},error:null});
  await assert.rejects(pending,/تغيّر المتجر/);
  assert.equal(x.useOrderStore.getState().orders[0].status,'pending');assert.equal(x.receivables.length,0);
 }finally{await x.h.cleanup();}
});
