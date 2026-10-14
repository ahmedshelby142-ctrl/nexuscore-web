// Actual React/Radix controls, readonly services and saved-order projections.
// Synthetic DOM/service boundaries only. No browser cloud session or writes.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {uiHarness} from './helpers/ui-harness.mjs';
import {orderManagementSummary} from '../src/lib/orderManagement.ts';
const entry=(id)=>({id,number:'BS-O00'+id,customer:'Synthetic '+id,location:'القاهرة',products:'RED × 1',quantity:1,total:'420.00',outstanding:'235.00',status:'انتظار',badges:['استبدال']});
function browser(width){Object.defineProperty(window,'innerWidth',{value:width,configurable:true});window.matchMedia=()=>({matches:width>=1280,addEventListener(){},removeEventListener(){}});globalThis.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};}
test('A queue shows gross420 and persisted235 once, distinguishes courier custody/refund due and does not invent money for invalid source',()=>{
 const o={status:'pending',totalAmount:300,shippingFee:120,wastedTripCompensation:0,depositAmount:100,expectedCod:235,isExchange:true,items:[{productName:'Saved',quantity:1,variantName:'RED'}],exchangeDetails:{credit:{allocatedPiastres:8500,status:'reserved'}}};
 const s=orderManagementSummary(o);assert.equal(s.total,420);assert.equal(s.outstanding,235);assert.match(s.products,/RED/);
 const cancelled=orderManagementSummary({...o,status:'cancelled',exchangeDetails:{credit:{status:'refund_due'}}});assert.equal(cancelled.outstanding,0);assert.ok(cancelled.badges.includes('رصيد مستحق للعميل'));
 assert.equal(orderManagementSummary({...o,totalAmount:NaN}).total,null);
});
test('A actual wide workspace has compact focusable rows, one selected detail and preserves filter/scroll/keyboard focus',async()=>{
 const h=uiHarness({});browser(1440);try{const {OrderQueueWorkspace}=h.load('src/components/ecommerce/OrderQueueWorkspace.tsx');
 function Harness(){const [selected,setSelected]=h.React.useState(null),[query,setQuery]=h.React.useState(''),[open,setOpen]=h.React.useState(false);return h.React.createElement(h.React.Fragment,null,h.React.createElement('input',{'aria-label':'Saved search',value:query,onChange:e=>setQuery(e.target.value)}),h.React.createElement(OrderQueueWorkspace,{entries:[entry('1'),entry('2')],selectedId:selected,detailsOpen:open,onSelect:id=>{setSelected(id);setOpen(true)},onClose:()=>setOpen(false),title:selected?'BS-O00'+selected:'',status:'انتظار',suspended:false,empty:null,detail:selected?h.React.createElement('section',{'aria-label':'Only selected'},'Detail '+selected):null}));}
 const user=await h.render(Harness);await h.perform(()=>user.type(h.getByRole(document.body,'textbox'),'Synthetic'));const rows=h.getAllByRole(document.body,'button',{name:/عرض الطلب/});assert.equal(rows.length,2);assert.equal(h.queryByRole(document.body,'dialog'),null);
 const list=document.querySelector('[aria-label="قائمة الطلبات"]');list.scrollTop=123;
 await h.perform(()=>user.click(rows[0]));assert.equal(h.getAllByRole(document.body,'region',{name:'Only selected'}).length,1);assert.match(document.body.textContent,/Detail 1/);
 await h.perform(()=>user.keyboard('{ArrowDown}{Enter}'));assert.match(document.body.textContent,/Detail 2/);await h.perform(()=>user.keyboard('{Escape}'));assert.equal(h.queryByRole(document.body,'region',{name:'Only selected'}),null);
 assert.equal(h.getByRole(document.body,'textbox').value,'Synthetic');assert.equal(list.scrollTop,123);assert.equal(rows[1].getAttribute('aria-pressed'),'true');await new Promise(r=>setTimeout(r,25));assert.equal(document.activeElement,rows[1]);
 }finally{await h.cleanup();}
});
test('A actual narrow workspace suspends under the existing financial dialog and returns to the same order',async()=>{
 const h=uiHarness({});browser(390);try{const {OrderQueueWorkspace}=h.load('src/components/ecommerce/OrderQueueWorkspace.tsx'),{Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription}=h.load('src/components/ui/dialog.tsx');
 function Harness(){const [selected,setSelected]=h.React.useState(null),[suspend,setSuspend]=h.React.useState(false);return h.React.createElement(h.React.Fragment,null,h.React.createElement(OrderQueueWorkspace,{entries:[entry('1')],selectedId:selected,onSelect:setSelected,onClose:()=>setSelected(null),title:'BS-O001',status:'انتظار',suspended:suspend,empty:null,detail:h.React.createElement('button',{onClick:()=>setSuspend(true)},'فتح العملية الموجودة')}),h.React.createElement(Dialog,{open:suspend,onOpenChange:setSuspend},h.React.createElement(DialogContent,null,h.React.createElement(DialogHeader,null,h.React.createElement(DialogTitle,null,'Existing operation'),h.React.createElement(DialogDescription,null,'Synthetic operation dialog')),h.React.createElement('button',{onClick:()=>setSuspend(false)},'إغلاق العملية'))));}
 const user=await h.render(Harness);await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:/عرض الطلب/})));assert.equal(h.getByRole(document.body,'dialog').dir,'rtl');assert.match(h.getByRole(document.body,'dialog').className,/100dvh/);
 await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'فتح العملية الموجودة'})));assert.equal(h.getAllByRole(document.body,'dialog').length,1);assert.match(h.getByRole(document.body,'dialog').textContent,/Existing operation/);
 await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'إغلاق العملية'})));assert.equal(h.getAllByRole(document.body,'dialog').length,1);assert.match(h.getByRole(document.body,'dialog').textContent,/BS-O001/);
 await h.perform(()=>user.keyboard('{Escape}'));assert.equal(h.queryByRole(document.body,'dialog'),null);
 }finally{await h.cleanup();}
});
test('A exchange operation is mounted only after explicit opening; Escape keeps the selected desktop workspace',async()=>{
 const h=uiHarness({});browser(1440);let mounted=0;try{const {OrderQueueWorkspace,OrderOperationPanel}=h.load('src/components/ecommerce/OrderQueueWorkspace.tsx');function Child(){h.React.useEffect(()=>{mounted++;},[]);return h.React.createElement('p',null,'Full exchange controls');}
 function Harness(){const [selected,setSelected]=h.React.useState('1');return h.React.createElement(OrderQueueWorkspace,{entries:[entry('1')],selectedId:selected,onSelect:setSelected,onClose:()=>setSelected(null),title:'BS-O001',status:'انتظار',suspended:false,empty:null,detail:h.React.createElement(OrderOperationPanel,{title:'إدارة الاستبدال',summary:'Original85 differs from final235'},h.React.createElement(Child))});}
 const user=await h.render(Harness);assert.equal(mounted,0);await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'إدارة الاستبدال'})));assert.equal(mounted,1);assert.match(h.getByRole(document.body,'dialog').textContent,/Full exchange controls/);
 await h.perform(()=>user.keyboard('{Escape}'));assert.equal(h.queryByRole(document.body,'dialog'),null);assert.ok(h.getByRole(document.body,'button',{name:'إدارة الاستبدال'}));
 }finally{await h.cleanup();}
});
test('A row mapper contains no financial forms or immediate command submission',()=>{
 const text=fs.readFileSync('src/components/ecommerce/OrdersPage.tsx','utf8');const sf=ts.createSourceFile('page.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let map;
 function walk(n){if(ts.isCallExpression(n)&&n.expression.getText(sf)==='filteredOrders.map')map=n;ts.forEachChild(n,walk);}walk(sf);assert.ok(map);assert.doesNotMatch(map.getText(sf),/ExchangeReturnPanel|OrderFulfillmentPanel|<Input|<Select|confirmDeliver|commitOrderPayment/);
});
test('A shared history reader pins the selected store/order and rejects delayed answers after tenant switch, with no writes',async()=>{
 let store='s1',args;const client={async rpc(name,input){assert.equal(name,'read_order_activity');args=input;return {data:[{id:'event',kind:'client_payment',label:'رد رصيد استبدال',occurred_at:'2026-10-13T00:00:00Z'}],error:null};}};
 const h=uiHarness({'@/lib/supabase':{getSupabaseClient:()=>client},'@/services/api/storeContext':{getActiveStoreId:async()=>store}});
 try{const {readOrderActivity}=h.load('src/services/orderActivity.ts');const rows=await readOrderActivity('order-1');assert.deepEqual(args,{p_store:'s1',p_order_id:'order-1'});assert.equal(rows[0].label,'رد رصيد استبدال');client.rpc=async()=>{store='s2';return {data:[],error:null};};await assert.rejects(()=>readOrderActivity('order-1'),/تغيّر المتجر/);
 }finally{await h.cleanup();}
});
test('A actual history panel retries a readonly failure and labels a credit refund as an outgoing refund',async()=>{
 let calls=0;const h=uiHarness({'@/services/orderActivity':{readOrderActivity:async()=>{calls++;if(calls===1)throw Error('Synthetic read failure');return [{id:'refund',kind:'client_payment',label:'رد رصيد استبدال',occurred_at:'2026-10-13T00:00:00Z'}];}}});
 try{const {OrderActivityPanel}=h.load('src/components/ecommerce/OrderActivityPanel.tsx');const user=await h.render(()=>h.React.createElement(OrderActivityPanel,{orderId:'o',revision:1}));assert.match(h.getByRole(document.body,'alert').textContent,/Synthetic/);await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'إعادة قراءة السجل'})));assert.match(h.getByRole(document.body,'list',{name:'سجل حركة الطلب'}).textContent,/رد رصيد استبدال/);assert.equal(calls,2);
 }finally{await h.cleanup();}
});

test('A dirty operation requires explicit dismissal; refused Escape preserves the draft and save revision clears the warning',async()=>{
 const h=uiHarness({});browser(390);let confirms=0,discard=false;window.confirm=()=>{confirms++;return discard;};
 try{const {OrderOperationPanel}=h.load('src/components/ecommerce/OrderQueueWorkspace.tsx');
 function Harness(){const [value,setValue]=h.React.useState(''),[rev,setRev]=h.React.useState(1);return h.React.createElement(OrderOperationPanel,{title:'Draft operation',summary:'Synthetic only',revision:rev},h.React.createElement('input',{'aria-label':'Saved draft',value,onChange:e=>setValue(e.target.value)}),h.React.createElement('button',{onClick:()=>setRev(n=>n+1)},'Confirm saved revision'));}
 const user=await h.render(Harness);await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'Draft operation'})));await h.perform(()=>user.type(h.getByRole(document.body,'textbox',{name:'Saved draft'}),'12.34'));await h.perform(()=>user.keyboard('{Escape}'));assert.equal(confirms,1);assert.equal(h.getByRole(document.body,'textbox').value,'12.34');await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'Confirm saved revision'})));await h.perform(()=>user.keyboard('{Escape}'));assert.equal(h.queryByRole(document.body,'dialog'),null);assert.equal(confirms,1);
 }finally{await h.cleanup();}
});

test('A actual Mobile timeline rejects a changed store during source lookup or history and keeps the saved reference on a stable read',async()=>{
 for(const phase of ['stable','source','history']) {
  let store='s1',rpcCalls=0;const filters=[];
  const client={from:()=>({select(){return this},eq(key,value){filters.push([key,value]);return this},async maybeSingle(){if(phase==='source')store='s2';return {data:{id:'o',orderNumber:'BS-O001',depositAmount:0},error:null}}}),async rpc(name,args){rpcCalls++;assert.equal(name,'read_order_activity');assert.deepEqual(args,{p_store:'s1',p_order_id:'o'});if(phase==='history')store='s2';return {data:[{id:'event',kind:'order_placed',occurred_at:'2026-10-14T00:00:00Z'}],error:null};}};
  const h=uiHarness({'@/lib/supabase':{getSupabaseClient:()=>client},'@/services/api/storeContext':{getActiveStoreId:async()=>store},'@/store/useAuthStore':{useAuthStore:{getState:()=>({userRole:'ADMIN'})}},'@/lib/ledger':{balanceOf:async()=>({qty:0,amount:0})}});
  try {const {readMobileOrderTimeline}=h.load('src/mobile/data/mobileReaders.ts');if(phase==='stable'){const rows=await readMobileOrderTimeline('o');assert.equal(rows[0].labelAr,'تم إنشاء الطلب');}else await assert.rejects(()=>readMobileOrderTimeline('o'),/تغيّر المتجر/);assert.ok(filters.some(([k,v])=>k==='store_id'&&v==='s1'));assert.equal(rpcCalls,phase==='source'?0:1);}
  finally {await h.cleanup();}
 }
});
