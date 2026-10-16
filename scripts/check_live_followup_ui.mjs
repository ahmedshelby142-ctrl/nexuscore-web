// Actual edit JSX and Mobile detail component; synthetic readonly boundaries.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {uiHarness} from './helpers/ui-harness.mjs';
const source=fs.readFileSync('src/components/ecommerce/OrdersPage.tsx','utf8');
const sf=ts.createSourceFile('OrdersPage.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function snippet(predicate){let result;function walk(n){if(predicate(n))result=n;ts.forEachChild(n,walk);}walk(sf);assert.ok(result);return result.getText(sf);}
const rows=snippet(n=>ts.isCallExpression(n)&&n.expression.getText(sf)==='draft.map'&&n.getText(sf).includes('pendingOrderLineCeiling'));
const summary=snippet(n=>ts.isJsxElement(n)&&n.openingElement.tagName.getText(sf)==='div'&&n.openingElement.getText(sf).includes('rounded-xl border border-border p-4 space-y-1')&&n.getText(sf).includes('المتبقي على المندوب'));
const product={id:'p',quantity:56,metadata:{variants:[{name:'RED',stock:37},{name:'BLUE',stock:19}]}};
const bundle={id:'box',isBundle:true,bundleItems:[{productId:'p',variantName:'RED',quantity:99}]};
const base={id:'o',items:[{productId:'box',bundleId:'box',productName:'Synthetic BOX',quantity:2,unitPrice:30}],stockItems:[{productId:'p',bundleId:'box',variantName:'RED',quantity:4},{productId:'p',bundleId:'box',variantName:'BLUE',quantity:2}],shippingFee:0,depositAmount:0,exchangeDetails:{credit:{version:1,status:'reserved',eligiblePiastres:1000,allocatedPiastres:1000}}};
async function editHost(order=base,products=[product,bundle]){
 const h=uiHarness({}),helpers=h.load('src/lib/pendingOrderItems.ts'),ctx={exports:{},React:h.React,editingOrder:order,products,qtyOf:id=>products.find(p=>p.id===id)?.quantity??0,...helpers,formatMoney:n=>Number(n).toFixed(2),Input:'input',Button:'button',Badge:'span'};
 const code=`exports.Component=function(){const [draft,setDraft]=React.useState(editingOrder.items.map(x=>({...x})));const draftGoods=draft.reduce((s,l)=>s+l.quantity*l.unitPrice,0),draftDiscount=0,draftTotal=draftGoods,draftCredit=pendingOrderCod(editingOrder,draftTotal);return <div>{${rows}}${summary}</div>}`;
 vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 const user=await h.render(ctx.exports.Component);return {h,user};
}

test('actual pending edit uses owned BOX recipe and variant stock; decrease changes final COD50→20 without a financial call',async()=>{
 const {h,user}=await editHost();try{const input=h.getByRole(document.body,'spinbutton',{name:'كمية Synthetic BOX في الطلب'});assert.equal(input.max,'20');assert.match(document.body.textContent,/المتبقي على المندوب50\.00/);assert.match(document.body.textContent,/رصيد البضاعة الأصلية المستخدم− 10\.00/);
 await h.perform(()=>user.clear(input));assert.equal(input.value,'1');assert.match(document.body.textContent,/المتبقي على المندوب20\.00/);
 }finally{await h.cleanup();}
});
test('actual saved old RED1 BLUE2 recipe ceiling is10 despite current catalogue RED99 and aggregate61',async()=>{
 const order={...base,items:[{...base.items[0],quantity:1}],stockItems:[{...base.stockItems[0],quantity:1},{...base.stockItems[1],quantity:2}],shippingFee:120};
 const {h}=await editHost(order,[{...product,quantity:61,metadata:{variants:[{name:'RED',stock:42},{name:'BLUE',stock:19}]}},bundle]);try{assert.equal(h.getByRole(document.body,'spinbutton').max,'10');assert.match(document.body.textContent,/المتبقي على المندوب140\.00/);}finally{await h.cleanup();}
});
test('pending ceilings group duplicate shade components and plain products retain ledger quantity',async()=>{
 const h=uiHarness({});try{const {pendingOrderLineCeiling}=h.load('src/lib/pendingOrderItems.ts');const order={...base,stockItems:[base.stockItems[0],base.stockItems[0],base.stockItems[1]]};assert.equal(pendingOrderLineCeiling(base.items[0],order,[product,bundle],()=>56),11);
 assert.equal(pendingOrderLineCeiling({productId:'p',variantName:'BLUE'}, {items:[{productId:'p',variantName:'BLUE',quantity:1}]},[product],()=>56),20);
 assert.equal(pendingOrderLineCeiling({productId:'p'},{items:[]},[{id:'p',quantity:8}],()=>8),8);
 }finally{await h.cleanup();}
});
test('credit preview preserves new cash, shipping and reserved versus already earned refund rules to piastre',async()=>{
 const h=uiHarness({});try{const {pendingOrderCod}=h.load('src/lib/pendingOrderItems.ts');assert.equal(pendingOrderCod({...base,shippingFee:120,depositAmount:100,exchangeDetails:{credit:{version:1,status:'reserved',eligiblePiastres:8500,allocatedPiastres:8500}}},300).cod,235);
 const reserved=pendingOrderCod({...base,exchangeDetails:{credit:{version:1,status:'reserved',eligiblePiastres:8500,allocatedPiastres:8500}}},30);assert.equal(reserved.cod,0);assert.equal(reserved.excessPiastres,5500);
 assert.equal(pendingOrderCod({...base,exchangeDetails:{credit:{version:1,status:'earned',allocatedPiastres:8500}}},30).requiresCreditRefund,true);
 assert.equal(pendingOrderCod({...base,exchangeDetails:{credit:{version:1,status:'refunded',allocatedPiastres:0}}},30).cod,30);
 }finally{await h.cleanup();}
});

async function mobileHost(position,visibility={cost:true,internal:true}){
 const order={...base,status:'delivered',orderNumber:'SYN-1',createdAt:'2026-10-16T00:00:00Z',items:[{productId:'p',productName:'Synthetic product',quantity:1,unitPrice:10}],totalAmount:10,expectedCod:0,shippingFee:0,courierFee:120,codServiceFee:5.70,courierPosition:position};
 const h=uiHarness({'react-router-dom':{useNavigate:()=>()=>{},useParams:()=>({orderId:order.id})},'@/mobile/data/mobileReaders':{readMobileOrder:async()=>order,readMobileOrderTimeline:async()=>[],readMobileCouriers:async()=>new Map()},'@/mobile/data/useMobileEntity':{useMobileEntity:()=>({data:order,loading:false,error:null,reload:()=>{}})},'@/mobile/data/useIsOffline':{useIsOffline:()=>false},'@/mobile/navigation/mobileVisibility':{useMobileVisibility:()=>visibility},'@/mobile/data/useStoreName':{useStoreName:()=> 'Synthetic'},'@/mobile/components/WhatsAppAction':{WhatsAppIconLink:()=>null},'@/components/shipping/CodServiceFeeEditor':{CodServiceFeeEditor:()=>null},'@/components/ecommerce/ExchangeReturnPanel':{ExchangeReturnPanel:()=>null},'@/mobile/viewmodels/formatters':{formatArabicCount:String,formatArabicCurrency:n=>Number(n).toFixed(2),formatArabicDate:()=>'',formatArabicRelativeTime:()=>''}});
 const {MobileOrderDetails}=h.load('src/mobile/screens/MobileOrderDetails.tsx');await h.render(MobileOrderDetails);return h;
}
for(const [state,cod,fee] of [['pending',0,12000],['pending',1000,2500],['settled',0,0],['none',0,0],['unavailable',0,0]])test(`actual Mobile ${state} courier ${cod}/${fee} distinguishes customer paid from fee accrual/settlement`,async()=>{
 const h=await mobileHost({state,codPiastres:cod,feePiastres:fee,...(state==='unavailable'?{}:{servicePiastres:0})});try{assert.doesNotMatch(document.body.textContent,/غير مطلوب \(مدفوع بالكامل\)/);
 if(state==='pending'){assert.match(document.body.textContent,/تسوية معلقة/);assert.match(document.body.textContent,new RegExp('رسوم متبقية للمندوب'+(fee/100).toFixed(2)));}
 if(state==='settled')assert.match(document.body.textContent,/توريد المندوبمستلم/);
 if(state==='none')assert.match(document.body.textContent,/لا توجد مستحقات مفتوحة/);
 if(state==='unavailable')assert.match(document.body.textContent,/تعذّر التحقق/);else assert.match(document.body.textContent,/رسوم تحصيل COD المسجلة0\.00/);
 assert.match(document.body.textContent,/رسوم تحصيل COD المقررة5\.70/);
 }finally{await h.cleanup();}
});
test('actual Moderator detail retains customer information while cost/internal obligations remain hidden',async()=>{
 const h=await mobileHost({state:'pending',codPiastres:0,feePiastres:12000,servicePiastres:0},{cost:false,internal:false});try{assert.doesNotMatch(document.body.textContent,/رسوم متبقية للمندوب|رسوم تحصيل COD المسجلة|توريد المندوب/);}finally{await h.cleanup();}
});

test('real Mobile obligation reader pins tenant/order, sums only recorded COD expense and rejects late tenant changes',async()=>{
 for(const mode of ['fee','partial','settled','read-failed','changed']){
  let store='s',calls=[];const sb={async rpc(name,args){calls.push([name,args]);if(mode==='read-failed')return {error:Error('Synthetic read failure')};return {data:mode==='settled'?[]:[{orderId:'other',codPiastres:999,feePiastres:999},{orderId:'o',codPiastres:mode==='partial'?1000:0,feePiastres:mode==='partial'?2500:12000}],error:null};},from(table){const filters=[],q={select(){return q},eq(k,v){filters.push([k,v]);return q},async in(k,v){filters.push([k,v]);calls.push([table,filters]);if(mode==='changed')store='other';return {data:table==='ledger_events'?[{id:'e'}]:[{amount_delta:570},{amount_delta:-55}],error:null};}};return q;}};
  const h=uiHarness({'@/lib/supabase':{getSupabaseClient:()=>sb},'@/services/api/storeContext':{getActiveStoreId:async()=>store},'@/store/useAuthStore':{useAuthStore:{getState:()=>({userRole:'ADMIN'})}},'@/lib/ledger':{balanceOf:async()=>({qty:0,amount:0})}});
  try{const {readMobileOrderCourierPosition}=h.load('src/mobile/data/mobileReaders.ts'),order={id:'o',store_id:'s',status:'delivered',orderNumber:'SYN-O1',courierId:'c',codSettledAt:mode==='settled'?'2026-10-16':undefined};
   if(mode==='read-failed'||mode==='changed')await assert.rejects(()=>readMobileOrderCourierPosition(order));
   else{const result=await readMobileOrderCourierPosition(order);assert.equal(result.state,mode==='settled'?'settled':'pending');assert.equal(result.servicePiastres,515);assert.equal(result.feePiastres,mode==='partial'?2500:mode==='settled'?0:12000);}
   assert.deepEqual(calls[0],['read_courier_obligations',{p_store:'s',p_courier:'c'}]);for(const [table,filters] of calls.slice(1))assert.ok(filters.some(([k,v])=>k==='store_id'&&v==='s'),table);
  }finally{await h.cleanup();}
 }
});
