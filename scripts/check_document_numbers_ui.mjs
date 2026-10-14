import {test} from 'node:test';
import assert from 'node:assert/strict';
import {uiHarness} from './helpers/ui-harness.mjs';
import {posDocumentNumber} from '../src/lib/documentIdentity.ts';
test('C saved POS and source refund numbers take precedence; historical identity is never regenerated',()=>{
 assert.equal(posDocumentNumber({id:'internal',payload:{documentNumber:'BS-P001'}}),'BS-P001');
 assert.equal(posDocumentNumber({id:'refund',payload:{sourceDocumentNumber:'BS-P001'}}),'BS-P001');
 assert.equal(posDocumentNumber({id:'historical-full-id'}),'historical-full-id');
});
test('C actual POS receipt search shows the persisted number, searches case-insensitively and retains original event ID/customer/cost',async()=>{
 let request,pick;const receipt={id:'internal-source',occurredAt:'2026-10-13T00:00:00Z',payload:{documentNumber:'BS-P001',customerId:'original',customerName:'Synthetic',customerPhone:'010',items:[{productId:'p',productName:'Saved item',quantity:2,unitPrice:10,unitCost:2}]}};
 const h=uiHarness({'@/services/posReceipts':{readPosReceipt:async()=>{throw Error('Unexpected readonly receipt open');}},'@/lib/pdfGenerator':{printTableAsPdf:()=>{throw Error('Unexpected print');}},'@/lib/ledger':{events:async q=>{request=q;return [receipt];},eventLines:async()=>[{account:'stock',subject_id:'p',qty_delta:-2,amount_delta:-400}]},'@/store/useBusinessStore':{useBusinessStore:fn=>fn({products:[]})}});
 try{const {POSReturnModal}=h.load('src/components/sales/POSReturnModal.tsx');const user=await h.render(()=>h.React.createElement(POSReturnModal,{onReturnItem:p=>{pick=p;}}));await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'استرجاع بفاتورة'})));await h.perform(()=>user.type(h.getByRole(document.body,'textbox',{name:'رقم الفاتورة أو هاتف العميل'}),'bs-p001'));await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'بحث'})));assert.equal(request.receiptSearch,'bs-p001');assert.match(h.getByRole(document.body,'dialog').textContent,/BS-P001/);assert.doesNotMatch(h.getByRole(document.body,'dialog').textContent,/internal-source/);await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:/إرجاع 1/})));assert.equal(pick.sourceEventId,'internal-source');assert.equal(pick.sourceDocumentNumber,'BS-P001');assert.equal(pick.customer.id,'original');assert.equal(pick.line.unitCost,2);
 }finally{await h.cleanup();}
});
test('C actual ledger reader searches before limiting, parses the persisted payload and rejects a changed tenant',async()=>{
 let store='store',called,change=false;const h=uiHarness({'@/lib/supabase':{getSupabaseClient:()=>({rpc:async(name,args)=>{called={name,args};if(change)store='other';return {data:[{id:'event',store_id:'store',payload:JSON.stringify({documentNumber:'BS-P001'}),kind:'sale'}],error:null};}})},'@/services/api/storeContext':{getSyncIdentity:async()=>({storeId:store,deviceId:'device'})}});
 try{const {driver}=h.load('src/lib/ledger/driver.ts');const rows=await driver.events({receiptSearch:'BS-P001',refType:'pos_sale'});assert.deepEqual(called,{name:'search_pos_receipts',args:{p_store:'store',p_search:'BS-P001'}});assert.equal(posDocumentNumber(rows[0]),'BS-P001');change=true;await assert.rejects(()=>driver.events({receiptSearch:'BS-P001'}),/تغيّر المتجر/);}finally{await h.cleanup();}
});
