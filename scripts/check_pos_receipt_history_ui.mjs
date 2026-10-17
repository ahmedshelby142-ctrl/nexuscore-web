import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
import {uiHarness as realUiHarness} from './helpers/ui-harness.mjs';
// Historical ADMIN receipt tests supply an explicit UI identity. Database
// authorization is tested separately with real authenticated local clients.
const uiHarness=stubs=>realUiHarness({'@/store/useAuthStore':{useAuthStore:Object.assign(s=>s({userRole:'ADMIN'}),{getState:()=>({userRole:'ADMIN'})})},...stubs});
import {groupPosHistory,posHeaderNet} from '../src/lib/posHistory.ts';
const event=(id,payload,extra={})=>({id,storeId:'s',kind:'sale',refType:'pos_sale',occurredAt:'2026-10-14T00:00:00Z',payload,...extra});
const legs=(price=320)=>[event('x',{exchangeId:'x',exchangeLeg:'return',returnOfEventId:'original',replacementEventId:'x:replacement',items:[{productName:'Saved original',quantity:-1,unitPrice:270}],sourceDocumentNumber:'BS-P001'},{refId:'x'}),event('x:replacement',{exchangeId:'x',exchangeLeg:'replacement',returnEventId:'x',exchangeSourceEventId:'original',documentNumber:'BS-P002',items:[{productName:'Saved replacement',quantity:1,unitPrice:price}]},{refId:'x'})];
for(const price of [320,270,200])test(`D2 history groups two immutable exchange legs once at difference${price-270}; gross discounted receipt stays distinct`,()=>{
 const original=event('original',{documentNumber:'BS-P001',discountAmount:30,items:[{quantity:1,unitPrice:300}]}),pair=legs(price);
 const rows=groupPosHistory([pair[1],original,pair[0],pair[1]]);assert.equal(rows.length,2);assert.equal(rows[0].number,'BS-P002');assert.equal(rows[0].amount,price-270);assert.equal(rows[0].incomplete,false);assert.equal(rows[1].amount,270);assert.equal(rows[0].events.length,2);
 const missing=groupPosHistory([pair[0]])[0];assert.equal(missing.incomplete,true);assert.equal(missing.amount,null);
 assert.equal(groupPosHistory([pair[0],{...pair[1],storeId:'foreign'}]).some(g=>!g.incomplete),false);
 assert.equal(posHeaderNet(event('bad',{items:[{quantity:NaN,unitPrice:1}]})),null);assert.equal(posHeaderNet(event('negative-discount',{discountAmount:-1,items:[{quantity:1,unitPrice:10}]})),null);
});
test('D2 actual saved receipt reopens from a readonly failure, preserves source/return/replacement distinction and prints exact saved numbers/net cash',async()=>{
 const printed=[];let calls=0;const receipt={id:'x',number:'BS-P002',sourceNumber:'BS-P001',kind:'exchange',customer:'Historical name',phone:'010',items:[{productName:'Historical RED',quantity:-1,unitPrice:270},{productName:'Replacement BLUE',quantity:1,unitPrice:320}],refundPiastres:27000,replacementPiastres:32000,netPiastres:5000,cogsPiastres:100,profitPiastres:4900,wallets:[{id:'inStoreSafe',piastres:5000}]};
 const h=uiHarness({'@/services/posReceipts':{readPosReceipt:async id=>{assert.equal(id,'x');if(++calls===1)throw Error('Synthetic read failure');return receipt;}},'@/lib/pdfGenerator':{printTableAsPdf:r=>printed.push(r)}});
 try{const {PosReceiptDetails}=h.load('src/components/sales/PosReceiptDetails.tsx');const user=await h.render(()=>h.React.createElement(PosReceiptDetails,{eventId:'x'}));assert.match(h.getByRole(document.body,'alert').textContent,/read failure/);assert.equal(h.queryByRole(document.body,'button',{name:'طباعة الإيصال المحفوظ'}),null);await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'إعادة قراءة الإيصال'})));const view=h.getByRole(document.body,'region',{name:'الإيصال المحفوظ'});assert.match(view.textContent,/BS-P001/);assert.match(view.textContent,/BS-P002/);assert.match(view.textContent,/تحصيل من العميل/);assert.match(view.textContent,/٥٠|50/);assert.match(view.textContent,/Historical RED/);await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'طباعة الإيصال المحفوظ'})));assert.equal(calls,2);assert.equal(printed.length,1);assert.match(printed[0].subtitle,/BS-P002.*BS-P001/);assert.match(printed[0].footer,/تحصيل من العميل/);assert.equal(printed[0].rows[0].unitPrice,270);
 }finally{await h.cleanup();}
});
test('D2 saved zero/negative print never invents a payment',async()=>{
 const prints=[],h=uiHarness({'@/services/posReceipts':{readPosReceipt:async()=>{throw Error('Unexpected read');}},'@/lib/pdfGenerator':{printTableAsPdf:r=>prints.push(r)}});
 try{const {printSavedPosReceipt}=h.load('src/components/sales/PosReceiptDetails.tsx');for(const net of [0,-7000])printSavedPosReceipt({kind:'exchange',number:'BS-P002',sourceNumber:'BS-P001',customer:'Saved',items:[],refundPiastres:27000,replacementPiastres:27000+net,netPiastres:net});assert.match(prints[0].footer,/دون حركة خزنة صافية/);assert.doesNotMatch(prints[0].footer,/تحصيل من العميل/);assert.match(prints[1].footer,/رد للعميل/);assert.match(prints[1].footer,/٧٠|70/);}finally{await h.cleanup();}
});
test('D2 actual CRM history projection groups exchange legs and retains ordinary/refund/ecommerce references',()=>{
 const source=fs.readFileSync('src/components/ecommerce/CRMPage.tsx','utf8'),tree=ts.createSourceFile('crm.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let expression;
 function walk(n){if(ts.isVariableDeclaration(n)&&n.name.getText(tree)==='timelineEvents')expression=n.initializer.arguments[0].getText(tree);ts.forEachChild(n,walk);}walk(tree);assert.ok(expression);
 const ctx={groupPosHistory,selectedCustomer:{id:'c'},saleBelongsTo:()=>true,orderBelongsTo:()=>true,codState:()=> 'due',orders:[{id:'order',orderNumber:'BS-O001',createdAt:'2026-10-14T00:00:00Z',status:'pending',totalAmount:300,expectedCod:235}],posSales:legs()};
 ctx.exports={};vm.runInNewContext(ts.transpileModule('exports.value=('+expression+')();',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);const value=ctx.exports.value;assert.equal(value.length,2);assert.equal(value.find(r=>r.type==='pos').totalAmount,50);assert.equal(value.find(r=>r.type==='pos').displayId,'BS-P002');assert.equal(value.find(r=>r.type==='ecommerce').expectedCod,235);
});
test('D2 actual receipt reader rejects a tenant change during source lookup without making a second read',async()=>{
 let store='s1',reads=0;const client={from(){reads++;return {select(){return this},eq(){return this},async maybeSingle(){store='s2';return {data:{id:'x',payload:{}},error:null}}}}};const h=uiHarness({'@/lib/supabase':{getSupabaseClient:()=>client},'@/services/api/storeContext':{getActiveStoreId:async()=>store}});
 try{await assert.rejects(()=>h.load('src/services/posReceipts.ts').readPosReceipt('x'),/تغيّر المتجر/);assert.equal(reads,1);}finally{await h.cleanup();}
});
