import test from 'node:test';
import assert from 'node:assert/strict';
import {uiHarness} from './helpers/ui-harness.mjs';
import {buildSaleLines} from '../src/lib/ledger/sales.ts';
import {returnStockFields} from '../src/lib/posReturn.ts';
for(const role of ['CASHIER_ONLY','ECOMMERCE_ONLY','POS_ECOMMERCE','UNVERIFIED'])test(role+' stock summary preserves counts/filters but never reads or renders monetary valuation',async()=>{
 let costReads=0;const filters=[];
 const h=uiHarness({'@/store/useAuthStore':{useAuthStore:select=>select({userRole:role})},'@/components/ui/collection-gate':{useCollectionStatus:()=>({read:{loading:false,error:null}})}});
 const products=[{id:'synthetic',name:'Synthetic RED/BLUE',quantity:5,minStockLevel:6,metadata:{variants:[{name:'RED',stock:3},{name:'BLUE',stock:2}]}}];
 try{const Component=h.load('src/components/inventory/StockSummaryCards.tsx').StockSummaryCards,user=await h.render(()=>h.React.createElement(Component,{products,value:'all',onChange:x=>filters.push(x),costOf(){costReads++;throw Error('Unauthorized cost read');},read:{loading:false,error:null}}));assert.equal(costReads,0);assert.match(document.body.textContent,/إجمالي المنتجات|منتجات منخفضة|منتجات نافدة/);assert.match(document.body.textContent,/للمصرّح لهم ماليًا فقط/);assert.doesNotMatch(document.body.textContent,/ج\.م/);await h.perform(()=>user.click(h.getByText(document.body,'منتجات منخفضة')));assert.deepEqual(filters,['low']);}finally{await h.cleanup();}
});
for(const role of ['ADMIN','ACCOUNTANT'])test(role+' preserves the actual stock valuation card',async()=>{
 let reads=0;const h=uiHarness({'@/store/useAuthStore':{useAuthStore:select=>select({userRole:role})},'@/components/ui/collection-gate':{useCollectionStatus:()=>({read:{loading:false,error:null}})}});
 try{const Component=h.load('src/components/inventory/StockSummaryCards.tsx').StockSummaryCards;await h.render(()=>h.React.createElement(Component,{products:[{id:'synthetic',name:'Synthetic',quantity:5,minStockLevel:2}],value:'all',onChange(){},costOf(){reads++;return 7;},read:{loading:false,error:null}}));assert.equal(reads,1);assert.match(document.body.textContent,/ج\.م/);assert.doesNotMatch(document.body.textContent,/للمصرّح لهم ماليًا فقط/);}finally{await h.cleanup();}
});
for(const role of ['CASHIER_ONLY','POS_ECOMMERCE'])for(const box of [false,true])test(role+' actual '+(box?'box':'product')+' receipt picker works without requesting historical cost',async()=>{
 let picked,costCalls=0;const auth={userRole:role},receipt={id:'synthetic-receipt',occurredAt:'2026-10-17T00:00:00Z',payload:{documentNumber:'QA-P001',customerId:'historical',customerName:'Synthetic original',items:[{productId:'p',productName:'Saved RED',variantName:'RED',quantity:2,unitPrice:10,...(box?{isBundle:true,bundleItems:[{productId:'part',quantity:2,variantName:'RED'}]}:{})}]}};
 const h=uiHarness({'@/store/useAuthStore':{useAuthStore:Object.assign(s=>s(auth),{getState:()=>auth})},'@/store/useBusinessStore':{useBusinessStore:s=>s({products:[]})},'@/lib/ledger':{events:async()=>[receipt],eventLines:async()=>{costCalls++;throw Error('Cost must not be requested');}},'@/services/posReceipts':{readPosReceipt:async()=>{throw Error('Unexpected receipt open');}},'@/lib/pdfGenerator':{printTableAsPdf(){throw Error('Unexpected print');}}});
 try{const Component=h.load('src/components/sales/POSReturnModal.tsx').POSReturnModal,user=await h.render(()=>h.React.createElement(Component,{onReturnItem:p=>picked=p}));await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'استرجاع بفاتورة'})));await h.perform(()=>user.type(h.getByRole(document.body,'textbox',{name:'رقم الفاتورة أو هاتف العميل'}),'QA-P001'));await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'بحث'})));await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:/إرجاع 1/})));assert.equal(costCalls,0);assert.equal(picked.sourceEventId,'synthetic-receipt');assert.equal(picked.line.unitPrice,10);assert.equal(picked.line.remaining,2);assert.equal(picked.customer.id,'historical');assert.equal(picked.line.unitCost,0);const lines=buildSaleLines({items:[{...picked.line,...returnStockFields(picked.line),quantity:-1}],wallet:'inStoreSafe'});assert.ok(lines.every(l=>l.amount==null||Number.isFinite(l.amount)));assert.equal(lines.find(l=>l.account==='wallet').amount,-10);}finally{await h.cleanup();}
});
for(const role of ['CASHIER_ONLY','ECOMMERCE_ONLY','POS_ECOMMERCE','MODERATOR','UNVERIFIED','ADMIN','ACCOUNTANT'])test(role+' selects the authoritative server projection for order/return refresh',async()=>{
 const h=uiHarness({'@/store/useAuthStore':{useAuthStore:{getState:()=>({userRole:role})}}});try{const {operationalSource}=h.load('src/services/operationalSource.ts');assert.equal(operationalSource('orders'),['ADMIN','ACCOUNTANT'].includes(role)?'orders':'orders_operational');assert.equal(operationalSource('return_records'),['ADMIN','ACCOUNTANT'].includes(role)?'return_records':'return_records_operational');assert.equal(operationalSource('products'),'products');}finally{await h.cleanup();}
});
for(const scenario of ['different-account','demotion','same-role-new-verification'])test('late ADMIN cloud response is discarded after '+scenario,async()=>{
 let release,started;const waiting=new Promise(r=>started=r);
 const h=uiHarness({'@/lib/supabase':{getOperationMode:()=> 'online_cloud',getSupabaseClient:()=>({})},'@/lib/pageAll':{pageAll:()=>{started();return new Promise(r=>release=r);}}});
 try{const auth=h.load('src/store/useAuthStore.ts').useAuthStore;const session=(id,role)=>({token:'synthetic-only',user:{id,username:'synthetic@qa.invalid',role}});auth.getState().setSession(session('a','ADMIN'));const pending=h.load('src/services/cloudData.ts').cloudList('orders');await waiting;
  auth.getState().beginVerification();auth.getState().setSession(session(scenario==='different-account'?'b':'a',scenario==='demotion'?'CASHIER_ONLY':'ADMIN'));
  release([{id:'old',store_id:'synthetic',items:[{unitCost:9999}]}]);await assert.rejects(pending,/تغيّرت صلاحيات الجلسة/);
 }finally{await h.cleanup();}
});
