import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveCustomerMetrics} from '../src/lib/customers.ts';
import {uiHarness} from './helpers/ui-harness.mjs';

const customer={id:'synthetic-customer',name:'Synthetic QA customer',phone:'01000000000'};
const event=(id,payload,refId)=>({id,kind:'sale',storeId:'synthetic-store',refType:'pos_sale',refId,occurredAt:'2026-10-14T00:00:00Z',payload:{customerId:customer.id,...payload}});
function exchange(id,source,oldPrice,newPrice,number){
 return [event(id,{exchangeId:id,exchangeLeg:'return',returnOfEventId:source,replacementEventId:id+':replacement',sourceDocumentNumber:'QA-P001',items:[{productId:'p',productName:'Synthetic product',quantity:-1,unitPrice:oldPrice}]},id),event(id+':replacement',{exchangeId:id,exchangeLeg:'replacement',returnEventId:id,exchangeSourceEventId:source,documentNumber:number,items:[{productId:'p',productName:'Synthetic product',quantity:1,unitPrice:newPrice}]},id)];
}
const history=()=>[event('original',{documentNumber:'QA-P001',items:[{productId:'p',productName:'Synthetic product',quantity:1,unitPrice:10}]}),...exchange('equal','original',10,10,'QA-P002'),...exchange('higher','equal:replacement',10,25,'QA-P003'),...exchange('lower','higher:replacement',25,10,'QA-P004')];

test('CRM counts one sale and three linked exchanges as four operations while retaining signed merchandise totals',()=>{
 const rows=history(),before=JSON.stringify(rows),metrics=deriveCustomerMetrics(customer,[],rows);
 assert.equal(rows.length,7);assert.equal(metrics.totalOrders,4);assert.equal(10/metrics.totalOrders,2.5);
 assert.equal(metrics.preferredProducts[0].quantity,1);assert.equal(metrics.preferredProducts[0].spent,10);assert.equal(JSON.stringify(rows),before,'reader cannot rewrite immutable source headers');
});
test('CRM count follows one review-required incomplete exchange and deduplicates replayed headers',()=>{
 const rows=history();assert.equal(deriveCustomerMetrics(customer,[],[...rows,rows[1]]).totalOrders,4);
 assert.equal(deriveCustomerMetrics(customer,[],[rows[1]]).totalOrders,1);
 assert.equal(deriveCustomerMetrics({...customer,id:'other',phone:'01099999999'},[],rows).totalOrders,0);
});
test('actual CRM component shows four timeline rows, four total operations and EGP2.50 average for the seven immutable legs',async()=>{
 const rows=history(),ltv={amountOf:()=>10,error:null,loading:false};
 const h=uiHarness({
  '@/hooks/useSubmitGate':{useRunOnce:()=>fn=>fn()},
  '@/store/useCustomerStore':{useCustomerStore:()=>({customers:[customer],addCustomer:async()=>{throw Error('Unexpected write');},updateCustomer:async()=>{throw Error('Unexpected write');},restoreCustomer:async()=>{throw Error('Unexpected write');}})},
  '@/store/useOrderStore':{useOrderStore:()=>({orders:[]})},
  '@/lib/ledger/useBalances':{useBalances:()=>ltv},
  '@/lib/ledger':{events:async()=>rows},
  '@/components/ecommerce/CustomerRemovalDialog':{CustomerRemovalDialog:()=>null},
  '@/components/ecommerce/OrdersPage':{STATUS_META:{}},
  '@/components/sales/PosReceiptDetails':{PosReceiptDetails:()=>null},
  '@/components/ui/collection-gate':{CollectionGate:({children})=>children},
 });
 try{
  const {CRMPage}=h.load('src/components/ecommerce/CRMPage.tsx');await h.render(CRMPage);
  const label=h.getByText(document.body,'إجمالي الطلبات');assert.equal(label.parentElement.querySelector('p').textContent,'4');
  const average=h.getByText(document.body,'متوسط قيمة الطلب').parentElement.querySelector('p').textContent;assert.match(average,/٢[٫.]٥|2\.5/);
  const timeline=[...document.querySelectorAll('table')].find(t=>t.textContent.includes('فرق الاستبدال'));assert.ok(timeline);assert.equal(timeline.querySelectorAll('tbody tr').length,4);
  assert.equal(JSON.stringify(rows),JSON.stringify(history()));
 }finally{await h.cleanup();}
});
