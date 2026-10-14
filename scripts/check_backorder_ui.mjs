// Real React components/readers, synthetic service boundaries only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {uiHarness} from './helpers/ui-harness.mjs';
import {computeShortages} from '../src/lib/shortages.ts';
import {fulfillmentSummary} from '../src/lib/orderFulfillment.ts';
const model={version:1,allowBackorder:true,demands:[{id:'d:1',productId:'p',productName:'منتج',variantName:'RED',quantity:5,allocated:3,missing:2}]};
const order={id:'o',orderNumber:'BS-O1',status:'pending',customerName:'عميل تجريبي',customerPhone:'qa.invalid.42',fulfillment:model};
const product={id:'p',name:'منتج',sku:'P-SYN',quantity:4,metadata:{variants:[{name:'RED',stock:0},{name:'BLUE',stock:4}]}};
test('forward exact-variant shortage is saved missing2, not requested5 or BLUE4, and resolution is durable',()=>{
 const rows=computeShortages([order],[product]);assert.equal(rows.length,1);assert.equal(rows[0].deficit,2);assert.equal(rows[0].allocated,3);assert.equal(rows[0].stock,0);assert.equal(rows[0].waitingOrders[0].customerPhone,'qa.invalid.42');
 const supplied={...order,fulfillment:{...model,demands:[{...model.demands[0],allocated:5,missing:0}]}};assert.deepEqual(computeShortages([supplied],[{...product,metadata:{variants:[{name:'RED',stock:1},{name:'BLUE',stock:4}]}}]),[]);
 assert.deepEqual(computeShortages([{...order,deleted_at:1}],[product]),[]);
});
test('legacy shortage history keeps its separate arithmetic; forward missing is not reduced by free stock',()=>{
 const legacy={id:'old',status:'pending',items:[{productId:'p',quantity:5,shortfall:2}]};
 const rows=computeShortages([legacy,order],[product]);assert.equal(rows.length,1);assert.equal(rows[0].deficit,2);
 const plain={...order,fulfillment:{...model,demands:[{...model.demands[0],variantName:undefined}]}};assert.equal(computeShortages([plain],[product])[0].deficit,2);
});
test('incomplete or corrupt saved plan never projects ready; actual shared Desktop/Mobile panel shows exact allocation',async()=>{
 assert.equal(fulfillmentSummary({version:1,allowBackorder:true})?.ready,false);assert.equal(fulfillmentSummary({...model,demands:[{...model.demands[0],allocated:5,missing:2}]})?.valid,false);
 const h=uiHarness({});try{const {OrderFulfillmentPanel}=h.load('src/components/ecommerce/OrderFulfillmentPanel.tsx');await h.render(()=>h.React.createElement(OrderFulfillmentPanel,{fulfillment:model}));
 const panel=h.getByRole(document.body,'region',{name:'حجز الطلب والنواقص'});assert.match(panel.textContent,/مطلوب 5.*محجوز 3.*ناقص 2/);assert.match(panel.textContent,/RED/);assert.match(panel.textContent,/الشحن والتسليم متوقفان/);
 }finally{await h.cleanup();}
});
test('actual Desktop shortage table searches exact customer phone and exports allocated/current missing with original order identity',async()=>{
 const exports=[];const h=uiHarness({'@/services/shortageFollowups':{listShortageFollowups:async()=>[]},'@/components/ecommerce/ShortageFollowupPanel':{ShortageFollowupPanel:()=>null},'@/store/useBusinessStore':{useBusinessStore:fn=>fn({products:[product]})},'@/store/useOrderStore':{useOrderStore:fn=>fn({orders:[order]})},'@/lib/pdfGenerator':{printTableAsPdf:r=>exports.push(r)}});
 try{const {ShortagesReport}=h.load('src/components/inventory/ShortagesReport.tsx');const user=await h.render(ShortagesReport);assert.match(document.body.textContent,/BS-O1/);assert.match(document.body.textContent,/مخصص 3/);
 await h.perform(()=>user.type(h.getByRole(document.body,'textbox',{name:'بحث النواقص'}),'qa.invalid.42'));assert.match(document.body.textContent,/BS-O1/);
 await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'طباعة'})));assert.equal(exports.length,1);assert.equal(exports[0].rows[0].deficit,2);assert.equal(exports[0].rows[0].allocated,3);
 }finally{await h.cleanup();}
});
test('actual Mobile shortage screen preserves read-only Moderator, exact order/customer allocation and phone search',async()=>{
 const rows=[{product_id:'p',product_name:'منتج — RED',sku:'P-SYN',stock:0,required:5,deficit:2,order_count:1,waiting_orders:[{orderId:'o',orderNumber:'BS-O1',customerName:order.customerName,customerPhone:order.customerPhone,variantName:'RED',requested:5,allocated:3,missing:2}]}];const navigation=[];
 const h=uiHarness({'@/components/ecommerce/ShortageFollowupPanel':{ShortageFollowupPanel:()=>null},'react-router-dom':{useNavigate:()=>to=>navigation.push(to)},'@/mobile/data/useIsOffline':{useIsOffline:()=>false},'@/mobile/data/useMobileRealtime':{useRealtimeTables:()=>{}},'@/mobile/navigation/MobileRouteGuard':{useMobileCapabilities:()=>new Set(['stock'])},'@/mobile/data/mobileHomeReader':{readMobileShortages:async()=>rows}});
 try{const {MobileShortagesScreen}=h.load('src/mobile/screens/MobileShortagesScreen.tsx');const user=await h.render(MobileShortagesScreen);assert.match(document.body.textContent,/مخصص 3/);assert.equal(h.queryByRole(document.body,'button',{name:'توريد'}),null);
 await h.perform(()=>user.type(h.getByRole(document.body,'textbox'),order.customerPhone));assert.match(document.body.textContent,/BS-O1/);
 await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:/عميل تجريبي/})));assert.deepEqual(navigation,['/orders/o']);
 }finally{await h.cleanup();}
});

test('actual nonfinancial follow-up survives a lost committed response with one note intent and has no financial writer',async()=>{
 let calls=[],store='store-a',saved=null;const h=uiHarness({'@/store/useAuthStore':{useAuthStore:fn=>fn({userRole:'MODERATOR'})},'@/services/api/storeContext':{getSyncIdentity:async()=>({storeId:store})},'@/services/shortageFollowups':{readShortageFollowup:async()=>null,saveShortageFollowup:async intent=>{calls.push({...intent});if(!saved){saved={order_id:'o',store_id:store,revision:1,state:intent.state,notes:intent.notes};throw Error('Synthetic lost response');}return {followup:saved,replayed:true};}}});
 try{const {ShortageFollowupPanel}=h.load('src/components/ecommerce/ShortageFollowupPanel.tsx');const user=await h.render(()=>h.React.createElement(ShortageFollowupPanel,{orderId:'o',orderNumber:'BS-O1',demandSummary:'RED: مطلوب5 مخصص3 ناقص2',customerName:'Synthetic',customerPhone:'qa.invalid'}));
 await h.perform(()=>user.type(h.getByRole(document.body,'textbox',{name:'ملاحظات النواقص'}),'Synthetic only'));
 await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'حفظ المتابعة'})));assert.equal(calls.length,1);assert.equal(h.getByRole(document.body,'textbox',{name:'ملاحظات النواقص'}).disabled,true);
 await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'تحقق من حفظ المتابعة الأصلية'})));assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0]);assert.match(document.body.textContent,/تم حفظ المتابعة دون تغيير مخزون/);assert.match(h.getByRole(document.body,'textbox',{name:'رسالة النواقص للإدارة'}).value,/BS-O1.*RED/);
 assert.equal(h.queryByRole(document.body,'link',{name:'تحضير رسالة للعميل'}),null,'Invalid synthetic phone never opens WhatsApp');
 }finally{await h.cleanup();}
});

test('actual creation preflight aggregates exact variants/components, requires authoritative stock and explicit bounded shortage confirmation',()=>{
 const route=fs.readFileSync(new URL('../src/routes/ecommerce-orders.tsx',import.meta.url),'utf8');const start=route.indexOf('    if (!stockIsAuthoritative()) {'),end=route.indexOf('    const cogsAmount',start);assert.ok(start>0&&end>start);
 const source=ts.transpileModule(`exports.preflight=()=>{${route.slice(start,end)}return {allowBackorder};}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 for(const scenario of ['accepted','refused','unloaded','exchange']){
  const prompts=[],errors=[],ctx={exports:{},stockItems:[{productId:'p',variantName:'RED',quantity:2,productName:'Component'},{productId:'p',variantName:'RED',quantity:3,productName:'Component'},{productId:'p',variantName:'BLUE',quantity:1,productName:'Other shade'}],products:[product],isExchange:scenario==='exchange',stockIsAuthoritative:()=>scenario!=='unloaded',getVariantStock:(p,v)=>p.metadata.variants.find(x=>x.name===v)?.stock??0,setResult:r=>errors.push(r),window:{confirm:text=>{prompts.push(text);return scenario==='accepted';}}};
  ctx.products=[{...product,metadata:{variants:[{name:'RED',stock:3},{name:'BLUE',stock:4}]}}];vm.runInNewContext(source,ctx);const result=ctx.exports.preflight();
  if(scenario==='accepted'){assert.equal(result.allowBackorder,true);assert.equal(prompts.length,1);assert.match(prompts[0],/RED.*مطلوب 5.*المتاح 3.*الناقص 2/);assert.doesNotMatch(prompts[0],/BLUE/);}
  else if(scenario==='refused'){assert.equal(result,undefined);assert.equal(prompts.length,1);}
  else {assert.equal(prompts.length,0);assert.equal(errors.length,1);assert.equal(errors[0].success,false);}
 }
});

test('actual Desktop follow-up filtering keeps only matching customer demand and refreshes saved note state',async()=>{
 const other={...order,id:'other',orderNumber:'BS-O2',customerName:'Other',fulfillment:{...model,demands:[{...model.demands[0],quantity:2,allocated:0,missing:2}]}};let currentState='procurement';
 const h=uiHarness({'@/components/ecommerce/ShortageFollowupPanel':{ShortageFollowupPanel:()=>null},'@/services/shortageFollowups':{listShortageFollowups:async()=>[{order_id:'o',state:currentState,revision:1,notes:'Synthetic'}]},'@/store/useBusinessStore':{useBusinessStore:fn=>fn({products:[product]})},'@/store/useOrderStore':{useOrderStore:fn=>fn({orders:[order,other]})},'@/lib/pdfGenerator':{printTableAsPdf:()=>{}}});
 try{const {ShortagesReport}=h.load('src/components/inventory/ShortagesReport.tsx');const user=await h.render(ShortagesReport);await h.perform(()=>user.selectOptions(h.getByRole(document.body,'combobox',{name:'تصفية حالة متابعة النواقص'}),'procurement'));assert.match(document.body.textContent,/BS-O1/);assert.doesNotMatch(document.body.textContent,/BS-O2/);assert.match(document.body.textContent,/مطلوب 5.*مخصص 3.*ناقص 2/);
 currentState='contacted';await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'تحديث المتابعة'})));assert.doesNotMatch(document.body.textContent,/BS-O1/);await h.perform(()=>user.selectOptions(h.getByRole(document.body,'combobox'),'contacted'));assert.match(document.body.textContent,/BS-O1/);
 }finally{await h.cleanup();}
});
test('actual Mobile follow-up filter uses saved per-order status and preserves exact visible requested/missing totals',async()=>{
 const waiting=[{orderId:'o',orderNumber:'BS-O1',customerName:'Synthetic',variantName:'RED',requested:5,allocated:3,missing:2,followupState:'procurement'},{orderId:'other',orderNumber:'BS-O2',customerName:'Other',variantName:'RED',requested:2,allocated:0,missing:2,followupState:'waiting'}];
 const h=uiHarness({'@/components/ecommerce/ShortageFollowupPanel':{ShortageFollowupPanel:()=>null},'react-router-dom':{useNavigate:()=>()=>{}},'@/mobile/data/useIsOffline':{useIsOffline:()=>false},'@/mobile/data/useMobileRealtime':{useRealtimeTables:()=>{}},'@/mobile/navigation/MobileRouteGuard':{useMobileCapabilities:()=>new Set(['stock'])},'@/mobile/data/mobileHomeReader':{readMobileShortages:async()=>[{product_id:'p',product_name:'Product — RED',sku:'SYN',stock:0,required:7,deficit:4,order_count:2,waiting_orders:waiting}]}});
 try{const {MobileShortagesScreen}=h.load('src/mobile/screens/MobileShortagesScreen.tsx');const user=await h.render(MobileShortagesScreen);await h.perform(()=>user.selectOptions(h.getByRole(document.body,'combobox',{name:'تصفية حالة متابعة النواقص'}),'procurement'));assert.match(document.body.textContent,/BS-O1/);assert.doesNotMatch(document.body.textContent,/BS-O2/);assert.match(document.body.textContent,/مطلوب 5.*مخصص 3.*ناقص 2/);
 }finally{await h.cleanup();}
});
test('bulk note reader always scopes the original tenant and refuses a delayed answer after store change',async()=>{
 let store='s1',reads=[];const client={from(table){assert.equal(table,'order_shortage_followups');const q={select(){return q},eq(k,v){reads.push([k,v]);return q},async in(k,ids){reads.push([k,ids]);return {data:[{order_id:'o',store_id:'s1',state:'waiting'}],error:null}}};return q;}};
 const h=uiHarness({'@/lib/supabase':{getSupabaseClient:()=>client},'@/services/api/storeContext':{getSyncIdentity:async()=>({storeId:store})}});
 try{const {listShortageFollowups}=h.load('src/services/shortageFollowups.ts');assert.equal((await listShortageFollowups(['o','o'])).length,1);assert.deepEqual(reads,[['store_id','s1'],['order_id',['o']]]);
 client.from=()=>{const q={select(){return q},eq(){return q},async in(){store='s2';return {data:[{store_id:'s1'}],error:null}}};return q;};await assert.rejects(()=>listShortageFollowups(['o']),/تغيّر المتجر/);
 }finally{await h.cleanup();}
});
