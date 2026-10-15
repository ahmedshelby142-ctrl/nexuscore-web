import test from 'node:test';import assert from 'node:assert/strict';
import {uiHarness} from './helpers/ui-harness.mjs';
import {accountingPnl,pnl} from '../src/lib/ledger/reports.ts';
import * as reportModel from '../src/lib/ledger/reports.ts';
import {courierFeeTotals} from '../src/lib/courierFees.ts';
import {courierSettlementAmounts} from '../src/lib/courierBatch.ts';
test('P&L capitalizes acquisition and deducts the same-period166.67 once, not historical4000',()=>{
 const p=pnl({revenueRows:[{subjectId:'pos',amount:10000}],expenseRows:[{subjectId:'rent',amount:2000},{subjectId:'assets',amount:5000}],cogs:6000,returnsRevenue:0,purchases:0});
 const a=accountingPnl(p,{capitalPurchasesReclassifiedPiastres:500000,periodDepreciationPiastres:16667});
 assert.equal(a.profitBeforeDepreciation,2000);assert.equal(Math.round(a.netProfit*100),183333);assert.equal(a.expenses,2000);assert.equal(p.expenses,7000);
});
test('opening asset carrying value enters equity once; paid acquisition is a conversion, depreciation reduces accumulated profit',async()=>{
 const h=uiHarness({});try{const {equityStatement}=h.load('src/lib/ledger/equity.ts');
 const base={capitalRows:[],contributionRows:[],drawRows:[],capitalCash:0,adjustmentStock:0,adjustmentWallet:20000,adjustmentExpense:0,revenue:0,cogs:0,expenses:0};
 assert.equal(equityStatement({...base,fixedAssetOpening:12000}).totalEquity,32000);
 assert.equal(equityStatement({...base,expenses:5000,capitalizedPurchases:5000,fixedAssetOpening:12000,depreciation:166.67}).totalEquity,31833.33);
 }finally{await h.cleanup();}
});
test('courier history splits recorded service from delivery once per event and retains signed statement correction',()=>{
 assert.deepEqual(courierSettlementAmounts({expectedCod:115,courierFee:120,shippingFee:0,codServiceFee:5.7,exchangeDetails:{cause:'courier'}}),{cod:235,fee:125.7});
 const ev={id:'delivered',kind:'order_delivered',ref_id:'QA-O001',payload:{codServiceFeePiastres:570}};
 const rows=[{subject_id:'courier',amount_delta:7000,ledger_events:ev},{subject_id:'courier',amount_delta:570,ledger_events:ev},
 {subject_id:'courier',amount_delta:114,ledger_events:{id:'up',kind:'courier_fee_adjustment',ref_id:'QA-O001',payload:{}}},
 {subject_id:'courier',amount_delta:-114,ledger_events:{id:'down',kind:'courier_fee_adjustment',ref_id:'QA-O001',payload:{}}}];
 assert.deepEqual(courierFeeTotals(rows,[]),{courier:{delivery:70,returns:0,exchange:0,codService:5.7}});
  assert.deepEqual(courierFeeTotals([{subject_id:'courier',amount_delta:5017,ledger_events:{id:'rto',kind:'rto_confirmed',ref_id:'QA-RTO',payload:{}}}],[]),{courier:{delivery:0,returns:50.17,exchange:0}});
});
test('actual existing asset-register component displays acquisition, history, NBV and opening date without creating money',async()=>{
 const h=uiHarness({});try{
  const {FixedAssetRegister}=h.load('src/components/finance/FixedAssetRegister.tsx');let deactivated=null;
  const a={id:'synthetic',name:'Synthetic Sharp',grossPiastres:1600000,residualPiastres:0,accumulatedDepreciationPiastres:400000,historicalDepreciationPiastres:400000,netBookPiastres:1200000,remainingDepreciablePiastres:1200000,monthlyEstimatePiastres:16667,usefulLifeMonths:96,usefulLifeEndsOn:'2032-10-14',purchaseDate:'2024-10-14',accountingStartDate:'2026-10-14',paymentSource:'prepaid',status:'active'};
  const user=await h.render(()=>h.React.createElement(FixedAssetRegister,{data:{rows:[a],grossCostPiastres:1600000,accumulatedDepreciationPiastres:400000,netBookPiastres:1200000,asOf:'2026-10-14'},loading:false,error:null,onDeactivate:id=>{deactivated=id;}}));
  assert.match(document.body.textContent,/١٢[٬,]٠٠٠/);assert.match(document.body.textContent,/٤[٬,]٠٠٠/);assert.match(document.body.textContent,/2024-10-14/);assert.match(document.body.textContent,/مدفوع مسبق/);
  await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:/إيقاف إهلاك الأصل/})));assert.equal(deactivated,'synthetic');
 }finally{await h.cleanup();}
});
test('actual COD editor validates cents/reason and submits one authoritative command, leaving customer COD unchanged',async()=>{
 let state={orders:[]},calls=[];const useOrderStore=Object.assign(selector=>selector(state),{setState:update=>{state={...state,...update(state)}}});
 const order={id:'synthetic-order',store_id:'synthetic-store',orderNumber:'QA-O001',status:'delivered',courierId:'synthetic-courier',codServiceFee:0,expectedCod:500,shippingFee:70};state.orders=[order];
 const h=uiHarness({'@/store/useAuthStore':{useAuthStore:selector=>selector({userRole:'ADMIN'})},'@/store/useOrderStore':{useOrderStore},
  '@/services/api/storeContext':{getActiveStoreId:async()=> 'synthetic-store'},
  '@/lib/financialCommand':{runFinancialCommand:async(...args)=>{calls.push(args);return {order:{...order,codServiceFee:5.7}};}},
  '@/services/api/fieldMapping':{fromRemoteRow:(_,row)=>row}});
 try{const {CodServiceFeeEditor}=h.load('src/components/shipping/CodServiceFeeEditor.tsx');const user=await h.render(()=>h.React.createElement(CodServiceFeeEditor,{order}));
  await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'تعديل رسوم تحصيل COD'})));
  const amount=h.getByLabelText(document.body,'رسوم خدمة تحصيل الدفع عند الاستلام (COD)'),reason=h.getByLabelText(document.body,'سبب التعديل / مرجع كشف المندوب');
  await h.perform(async()=>{await user.clear(amount);await user.type(amount,'5.701');await user.type(reason,'Synthetic statement');await user.click(h.getByRole(document.body,'button',{name:'حفظ رسوم التحصيل'}));});
  assert.equal(calls.length,0);assert.ok(h.getByRole(document.body,'alert'));
  await h.perform(async()=>{await user.clear(amount);await user.type(amount,'5.70');const submit=h.getByRole(document.body,'button',{name:'حفظ رسوم التحصيل'});submit.click();submit.click();});
  assert.equal(calls.length,1);assert.equal(calls[0][0],'cod_service_fee');assert.equal(calls[0][1].amount,5.7);assert.equal(calls[0][1].before,0);assert.equal(calls[0][3],'synthetic-store');assert.equal(state.orders[0].expectedCod,500);assert.equal(state.orders[0].codServiceFee,5.7);
 }finally{await h.cleanup();}
});
test('actual opening-asset correction form freezes its prior revision and preserves auditable owner date, without a ledger payload',async()=>{
 const calls=[],asset={id:'synthetic-asset',name:'Synthetic Sharp',revision:8,purchaseDate:'2026-08-14',accountingStartDate:'2026-10-14'};
 const h=uiHarness({'@/lib/financialCommand':{runFinancialCommand:async(...args)=>{calls.push(args);return {openingEquityDeltaPiastres:-366667};}}});
 try{const {OpeningAssetDateEditor}=h.load('src/components/finance/OpeningAssetDateEditor.tsx');
  const user=await h.render(()=>h.React.createElement(OpeningAssetDateEditor,{asset,storeId:'synthetic-store',onSaved:()=>{throw Error('SYNTHETIC_CACHE_REFRESH_FAILURE');}}));
  await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'تصحيح تاريخ الأصل الافتتاحي'})));
  const date=h.getByLabelText(document.body,'تاريخ الشراء الصحيح'),reason=h.getByLabelText(document.body,'سبب تصحيح تاريخ الأصل');
  await h.perform(async()=>{await user.clear(date);await user.type(date,'2024-10-14');await user.type(reason,'Owner confirmed original purchase date');});
  await h.perform(()=>{const submit=h.getByRole(document.body,'button',{name:'تأكيد تصحيح الرصيد الافتتاحي'});submit.click();submit.click();});
  assert.equal(calls.length,1);assert.equal(calls[0][0],'asset_opening_date');assert.equal(calls[0][1].beforeRevision,8);assert.equal(calls[0][1].beforePurchaseDate,'2026-08-14');assert.equal(calls[0][1].purchaseDate,'2024-10-14');assert.equal(calls[0][1].lines,undefined);assert.equal(calls[0][3],'synthetic-store');
  assert.equal(document.querySelector('[role="dialog"]'),null);assert.match(h.getByRole(document.body,'status').textContent,/دون حركة نقدية/);assert.match(document.body.textContent,/٣[٬,]٦٦٦٫٦٧/);
 }finally{await h.cleanup();}
});
test('actual correction-history component displays stored fee reason/actor/amounts even for a settled order',async()=>{
 const h=uiHarness({'@/lib/financialAudit':{readFinancialAudit:async()=>[{id:'synthetic-audit',actorId:'synthetic-owner',at:'2026-10-14T10:00:00Z',before:5.7,after:6.84,reason:'Synthetic courier statement'}]}});
 try{const {FinancialCorrectionHistory}=h.load('src/components/finance/FinancialCorrectionHistory.tsx');const user=await h.render(()=>h.React.createElement(FinancialCorrectionHistory,{kind:'cod',storeId:'synthetic-store',id:'settled-order'}));
  await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'سجل التصحيحات'})));assert.match(document.body.textContent,/Synthetic courier statement/);assert.match(document.body.textContent,/synthetic-owner/);assert.match(document.body.textContent,/٦٫٨٤/);assert.match(document.body.textContent,/٥٫٧/);
 }finally{await h.cleanup();}
});
test('financial draft guard keeps typed amount on Escape and explicit Cancel, then discards only on confirmation',async()=>{
 const h=uiHarness({});try{
  const {useFinancialDraftClose}=h.load('src/hooks/useFinancialDraftClose.tsx');
  const {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription}=h.load('src/components/ui/dialog.tsx');
  const {React}=h;let closed=0;
  function Harness(){const [open,setOpen]=React.useState(true),[amount,setAmount]=React.useState("");
   const guard=useFinancialDraftClose({open,draft:{amount},busy:false,onClose:()=>{closed++;setOpen(false);}});
   return React.createElement(React.Fragment,null,guard.confirmation,
    React.createElement(Dialog,{open,onOpenChange:next=>{if(!next)guard.close();}},
     React.createElement(DialogContent,null,React.createElement(DialogHeader,null,React.createElement(DialogTitle,null,'Synthetic payment'),React.createElement(DialogDescription,null,'No transactions')),
      React.createElement('label',{htmlFor:'amount'},'Synthetic amount'),React.createElement('input',{id:'amount',value:amount,onChange:e=>setAmount(e.target.value)}),
      React.createElement('button',{onClick:guard.close},'Cancel draft'))));}
  const user=await h.render(Harness),input=h.getByLabelText(document.body,'Synthetic amount');
  await h.perform(()=>user.type(input,'1.23'));assert.ok(document.querySelector('[data-pwa-unsaved="true"]'));
  await h.perform(()=>user.keyboard('{Escape}'));assert.ok(h.getByRole(document.body,'alertdialog'));assert.equal(closed,0);
  await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'الاحتفاظ بالمسودة'})));assert.equal(h.getByLabelText(document.body,'Synthetic amount').value,'1.23');
  const unload=new window.Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);
  await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'Cancel draft'})));
  await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'تجاهل المسودة'})));assert.equal(closed,1);assert.equal(document.querySelector('[data-pwa-unsaved="true"]'),null);
 }finally{await h.cleanup();}
});
test('acknowledged claim clears its saved draft warning while failures and later edits remain protected',async()=>{
 const h=uiHarness({});try{
  const {useFinancialDraftClose}=h.load('src/hooks/useFinancialDraftClose.tsx'),{React}=h;let closed=0;
  function Harness(){const [notes,setNotes]=React.useState(''),[savedRevision,setSavedRevision]=React.useState(null);
   const guard=useFinancialDraftClose({open:true,draft:{notes},savedRevision,busy:false,onClose:()=>{closed++;}});
   return React.createElement(React.Fragment,null,guard.confirmation,React.createElement('input',{'aria-label':'Claim notes',value:notes,onChange:e=>setNotes(e.target.value)}),React.createElement('button',{onClick:()=>setSavedRevision('saved-claim-id')},'Acknowledge saved claim'),React.createElement('button',{onClick:guard.close},'Close claim'));}
  const user=await h.render(Harness);await h.perform(()=>user.type(h.getByRole(document.body,'textbox',{name:'Claim notes'}),'Synthetic claim note'));
  assert.ok(document.querySelector('[data-pwa-unsaved="true"]'));
  await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'Close claim'})));assert.ok(h.getByRole(document.body,'alertdialog'));assert.equal(closed,0);
  await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'الاحتفاظ بالمسودة'})));
  await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'Acknowledge saved claim'})));
  assert.equal(document.querySelector('[data-pwa-unsaved="true"]'),null);const event=new window.Event('beforeunload',{cancelable:true});window.dispatchEvent(event);assert.equal(event.defaultPrevented,false);
  await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'Close claim'})));assert.equal(closed,1);assert.equal(h.queryByRole(document.body,'alertdialog'),null);
  await h.perform(()=>user.type(h.getByRole(document.body,'textbox',{name:'Claim notes'}),' later edit'));
  await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'Close claim'})));assert.ok(h.getByRole(document.body,'alertdialog'));assert.equal(closed,1);
 }finally{await h.cleanup();}
});

test('Mobile historical bundle component shows saved exact units, variant and SKU without consulting a changed catalog recipe',async()=>{
 const h=uiHarness({});try{
  const {savedOrderBundleComponents}=h.load('src/lib/bundleDetails.ts');
  const {MobileBundleContents}=h.load('src/mobile/components/MobileBundleContents.tsx');
  const stock=[{productId:'component',productName:'Saved red shade',sku:'SAVED-SKU',variantName:'RED',quantity:2,bundleId:'bundle',unitCost:1},
   {productId:'component',productName:'Saved blue shade',sku:'SAVED-SKU',variantName:'BLUE',quantity:1,bundleId:'bundle',unitCost:1},
   {productId:'other',quantity:99,bundleId:'unrelated'}];
  const before=JSON.stringify(stock),components=savedOrderBundleComponents({bundleId:'bundle'},stock);
  assert.equal(components.length,2);assert.deepEqual(components.map(x=>[x.variantName,x.quantity]),[['RED',2],['BLUE',1]]);
  await h.render(()=>h.React.createElement(MobileBundleContents,{components,titleAr:'مكونات البوكس المحفوظة في الطلب',captionAr:'إجمالي الكميات المحفوظة لهذا البند'}));
  assert.match(document.body.textContent,/Saved red shade/);assert.match(document.body.textContent,/SAVED-SKU/);assert.match(document.body.textContent,/RED/);assert.match(document.body.textContent,/BLUE/);assert.equal(JSON.stringify(stock),before);
  assert.match(document.body.textContent,/بنود المكونات: ٢/);assert.doesNotMatch(document.body.textContent,/٢ قطعة مكونات/);
 }finally{await h.cleanup();}
});
test('actual MobileOrderDetails reopens the saved bundle composition and distinguishes goods from shipping-inclusive obligation',async()=>{
 for(const cost of [true,false]){let React;
  const order={id:'synthetic-order',orderNumber:'QA-O001',status:'delivered',createdAt:'2026-10-14T08:00:00Z',customerName:'Synthetic customer',customerPhone:'qa.invalid',address:'Synthetic no-contact address',courierId:'synthetic-courier',totalAmount:30,shippingFee:70,expectedCod:100,codServiceFee:5.7,depositAmount:0,items:[{id:'line',bundleId:'saved-bundle',isBundle:true,productId:'saved-bundle',productName:'Saved bundle',quantity:1,unitPrice:30}],stockItems:[{bundleId:'saved-bundle',productId:'component',productName:'Historical RED component',sku:'SAVED-SKU',variantName:'RED',quantity:2}]};
  const h=uiHarness({'react-router-dom':{useNavigate:()=>()=>{},useParams:()=>({orderId:order.id})},
   '@/mobile/data/useMobileEntity':{useMobileEntity:()=>({data:order,loading:false,error:null,reload:()=>{}})},
   '@/mobile/data/useIsOffline':{useIsOffline:()=>false},'@/mobile/navigation/mobileVisibility':{useMobileVisibility:()=>({cost,internal:cost})},
   '@/mobile/data/useStoreName':{useStoreName:()=> 'Synthetic store'},
   '@/mobile/data/mobileReaders':{readMobileOrder:async()=>order,readMobileOrderTimeline:async()=>[],readMobileCouriers:async()=>new Map()},
   '@/mobile/components/MobileAppBar':{MobileAppBar:({title,leadingAction})=>React.createElement('header',null,title,leadingAction)},
   '@/mobile/components/WhatsAppAction':{WhatsAppIconLink:()=>null},'@/components/shipping/CodServiceFeeEditor':{CodServiceFeeEditor:()=>null},
   '@/components/ecommerce/OrderFulfillmentPanel':{OrderFulfillmentPanel:()=>null}});React=h.React;
  try{const {MobileOrderDetails}=h.load('src/mobile/screens/MobileOrderDetails.tsx');await h.render(MobileOrderDetails);
   assert.match(document.body.textContent,/مكونات البوكس المحفوظة في الطلب/);assert.match(document.body.textContent,/Historical RED component/);assert.match(document.body.textContent,/SAVED-SKU/);assert.match(document.body.textContent,/قيمة البضاعة بعد الخصم/);assert.match(document.body.textContent,/المجموع المستحق/);
   const text=document.body.textContent;assert.equal(text.includes('رسوم تحصيل COD'),cost);if(cost)assert.match(text,/✓ متطابق/);
  }finally{await h.cleanup();}
 }
});
test('actual financial report refreshes after an asset/ledger cue and exports the same before/after-depreciation figures',async()=>{
 let depreciation=166.67,calls=0,printed;
 const h=uiHarness({'@/lib/ledger':{balances:async()=>[]},'@/lib/ledger/reports':{...reportModel,fetchPnl:async()=>{calls++;return {...pnl({revenueRows:[{subjectId:'pos',amount:10000}],expenseRows:[{subjectId:'rent',amount:2000}],cogs:6000,returnsRevenue:0,purchases:0}),profitBeforeDepreciation:2000,depreciation,netProfit:(200000-Math.round(depreciation*100))/100};}},
  '@/lib/fixedAssetAccounting':{readFixedAssetAccounting:async()=>({})},'@/lib/pdfGenerator':{printTableAsPdf:args=>{printed=args;}}});
 try{const {FinancialReportsPage}=h.load('src/components/finance/FinancialReportsPage.tsx');const user=await h.render(FinancialReportsPage);
  const initial=calls;assert.ok(initial>0);assert.match(document.body.textContent,/الربح قبل الإهلاك/);assert.match(document.body.textContent,/صافي الربح بعد الإهلاك/);
  depreciation=200;await h.perform(()=>window.dispatchEvent(new CustomEvent('ledger-sync-pulled')));assert.ok(calls>initial);
  await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'تصدير PDF'})));assert.ok(printed);assert.ok(printed.columns.some(c=>c.label==='الربح قبل الإهلاك'));assert.ok(printed.columns.some(c=>c.label==='صافي الربح بعد الإهلاك'));
  assert.ok(printed.rows.length>0);assert.ok(printed.rows.every(r=>r.depreciation===200&&r.netProfit===1800));
 }finally{await h.cleanup();}
});
