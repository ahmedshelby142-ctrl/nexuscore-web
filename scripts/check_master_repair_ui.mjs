// Synthetic actual React/readers regressions. No network, credentials or writes.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { exchangeShippingFrom } from "../src/lib/exchangeShipping.ts";
import { bundleComponentDetails } from "../src/lib/bundleDetails.ts";
import { originalPosCustomer } from "../src/lib/posReturn.ts";
import { findImportedProduct, openingBalanceOf } from "../src/lib/productImport.ts";
import { returnableUnits, remainingUnits, ordinaryReturnValue, returnUnitKey } from "../src/lib/exchange.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver"])
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url), React = require("react"), { act } = React;
const { createRoot } = require("react-dom/client");
const { getByRole, getByLabelText, queryByText, fireEvent, within } = require("@testing-library/dom");
const userEvent = require("@testing-library/user-event").default;
const rootPath = path.resolve(import.meta.dirname, "..");
const read = (name) => fs.readFileSync(path.join(rootPath, name), "utf8");
let roots = [];
async function render(element, existing) {
  const entry = existing ?? (() => {
    const host = document.createElement("div"); document.body.append(host);
    const result = { host, root: createRoot(host) }; roots.push(result); return result;
  })();
  await act(async () => entry.root.render(element));
  return entry;
}
afterEach(async () => { for (const entry of roots) await act(async () => entry.root.unmount()); roots = []; document.body.innerHTML = ""; });
function compile(source) {
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
}
function loader(stubs = {}) {
  const cache = new Map();
  const load = (name) => {
    const file = path.resolve(rootPath, name);
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    const localRequire = (id) => {
      if (Object.hasOwn(stubs, id)) return stubs[id];
      if (id.startsWith("@/") || id.startsWith(".")) {
        const base = id.startsWith("@/") ? path.join(rootPath, "src", id.slice(2)) : path.resolve(path.dirname(file), id);
        const resolved = [base, base + ".ts", base + ".tsx", path.join(base, "index.ts")].find(p => fs.existsSync(p) && fs.statSync(p).isFile());
        if (!resolved) throw new Error("Unresolved import " + id);
        return load(resolved);
      }
      return require(id);
    };
    vm.runInThisContext(`(function(exports,require){${compile(fs.readFileSync(file, "utf8"))}\n})`, { filename: file })(exports, localRequire);
    return exports;
  };
  return load;
}

const origin = { id: "order-a", customerId: "customer-a", customerName: "عميلة الأصل", customerPhone: "01000000000", governorate: "القاهرة", city: "مدينة نصر", address: "القاهرة - مدينة نصر - شارع 1-ب - الدور 2 — شقة 3" };

async function deliveryHost({pending=false,fail=false}={}) {
 const calls=[],o={id:'o',status:'shipped',shippingPenaltyApplied:true,customerId:'customer'};
 const ctx={exports:{},React,require,runOnce:fn=>fn(),resolvePendingOrderDelivery:async()=>{calls.push('resolve');return pending?{eventId:'prior'}:undefined},
 currentOrder:()=>o,soldOnWholesaleInvoice:()=>false,maySellWholesale:false,saleMode:'retail',deliverMode:'deliver',targetWallet:'inStoreSafe',
 claimOrder:()=>undefined,releaseOrder:()=>calls.push('release'),customerIdOf:()=>o.customerId,
 useCustomerStore:{getState:()=>({customers:[],settleWastedTrip:()=>{throw Error('Forbidden split counter writer')}})},
 courierSettlementAmounts:()=>({cod:14,fee:2}),round:v=>v,commitOrderDelivery:async()=>{calls.push('commit');if(fail)throw Error('SYNTHETIC_UNCERTAIN')},
 updateOrder:()=>{throw Error('Forbidden post-commit flag PATCH')},updateOrderStatus:()=>{throw Error('Forbidden retail status PATCH')},
 refreshStock:()=>calls.push('stockRead'),refreshWallets:()=>calls.push('walletRead'),refreshDebt:()=>calls.push('debtRead'),reconcileCourierOrder:()=>{},BUSY_MESSAGE:'busy'};
 vm.runInNewContext(compile(`const {useState}=React; exports.Harness=function(){
 const [isWorking,setIsWorking]=useState(false),[error,setActionError]=useState(null),[reconcileDialog,setReconcileDialog]=useState({orderId:'o',open:true});
 ${control('src/components/ecommerce/OrdersPage.tsx','confirmDeliver')}
 return <div><button disabled={isWorking} onClick={()=>void confirmDeliver()}>Confirm delivery</button><p role="alert">{error}</p><output>{String(reconcileDialog.open)}</output></div>;
 };`),ctx);
 const entry=await render(React.createElement(ctx.exports.Harness));await act(async()=>fireEvent.click(getByRole(entry.host,'button',{name:'Confirm delivery'})));return{entry,calls};
}
test('I actual delivery control commits one atomic command; recovery uses original operation and never a split trip/flag writer',async()=>{
 const normal=await deliveryHost();assert.equal(normal.calls.filter(x=>x==='commit').length,1);assert.equal(normal.entry.host.querySelector('output').textContent,'false');
 const replay=await deliveryHost({pending:true});assert.equal(replay.calls.filter(x=>x==='commit').length,0);assert.equal(replay.entry.host.querySelector('output').textContent,'false');
 const failed=await deliveryHost({fail:true});assert.match(getByRole(failed.entry.host,'alert').textContent,/نفس العملية دون تكرارها/);assert.equal(failed.entry.host.querySelector('output').textContent,'true');
});
test('I delivery reader publishes current exact-tenant customer debt with LWW; failed optional reads never retry money',async()=>{
 for(const mode of ['normal','newer','changedTenant','failedRead']) {
  let tenant='store',calls=0,state={orders:[{id:'o',updated_at:1}]},customers={customers:[{id:'c',returned_orders_count:9,updated_at:mode==='newer'?99:1}]};
  const result={eventId:'e',orderIds:['o'],customer:{id:'c',store_id:'store',returned_orders_count:1,updated_at:2}};
  const stubs={'@/lib/financialCommand':{runFinancialCommand:async(command,input,scope,storeId)=>{assert.equal(storeId,'store');calls++;if(mode==='changedTenant')tenant='other';return result},resolvePendingFinancialCommand:async()=>undefined},
   '@/services/api/storeContext':{getSyncIdentity:async()=>({storeId:tenant})},'@/services/api/fieldMapping':{fromRemoteRow:(_table,row)=>row},
   '@/store/useOrderStore':{useOrderStore:{setState:fn=>state={...state,...fn(state)}}},'@/store/useCustomerStore':{useCustomerStore:{setState:fn=>customers={...customers,...fn(customers)}}},
   '@/lib/supabase':{getSupabaseClient:()=>({from(table){const query={select(){return query},eq(){return query},async in(){if(mode==='failedRead')throw Error('SYNTHETIC_READ_FAILURE');return{data:[{id:'o',updated_at:3}],error:null}},async single(){return{data:{id:'c',store_id:'store',returned_orders_count:0,updated_at:3},error:null}}};return query}})}};
  const service=loader(stubs)('src/lib/courierSettlement.ts');assert.equal((await service.commitOrderDelivery({orderId:'o',settle:false,wallet:'inStoreSafe',netReceived:0})).eventId,'e');assert.equal(calls,1);assert.equal(customers.customers[0].returned_orders_count,mode==='normal'?0:9);
 }
});
test('I actual settlement print distinguishes zero offset, real courier payout and expensed shortfall without inventing receivables',async()=>{
 const {CourierSettlementReport}=loader({'@/lib/math':{formatMoney:v=>String(v)}})('src/components/ecommerce/CourierSettlementReport.tsx');
 for(const [net,shortfall,expected] of [[0,0,/دون تحويل نقدي أو حركة خزنة/],[-50,0,/دفعنا للمندوب فعليًا/],[40,10,/عجز مسجل كمصروف؛ ليس رصيدًا مفتوحًا/]]) {
  const entry=await render(React.createElement(CourierSettlementReport,{settlement:{id:'synthetic',courierName:'Synthetic',at:new Date('2026-10-13'),codTotal:50,expectedFees:net<0?100:50,expectedNet:net+shortfall,netReceived:net,shortfall},orders:[{orderNumber:'I-SYN',expectedCod:50,fee:50}]}));assert.match(entry.host.textContent,expected);assert.doesNotMatch(entry.host.textContent,/عجز مطلوب سداده/);
 }
});
test("E: snapshot strips only its persisted geographic prefix; no guessed address", () => {
  assert.equal(exchangeShippingFrom(origin).detailedAddress, "شارع 1-ب - الدور 2 — شقة 3");
  assert.equal(exchangeShippingFrom({ ...origin, address: "شارع مستقل 1-ب" }).detailedAddress, "شارع مستقل 1-ب");
  assert.equal(exchangeShippingFrom({ ...origin, address: undefined }).detailedAddress, "");
  assert.equal(exchangeShippingFrom({ ...origin, address: "القاهرة - مدينة نصر" }).detailedAddress, "");
});

// Execute the actual route callback/effect and manual-select handler in React.
// Unrelated financial/network dependencies are not part of this harness.
const route = ts.createSourceFile("route.tsx", read("src/routes/ecommerce-orders.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let prefill, effect, manual;
function visit(node) {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(route) === "prefillExchangeShipping")) prefill = node.getText(route);
  if (ts.isCallExpression(node) && node.expression.getText(route) === "useEffect" && node.arguments[0]?.getText(route).includes("if (!exchangeOf) return;")) effect = node.getText(route);
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(route) === "select" && node.attributes.properties.some(a => a.name?.getText(route) === "value" && a.initializer?.getText(route) === "{originalOrderId}")) {
    const attr = node.attributes.properties.find(a => a.name?.getText(route) === "onChange");
    manual = attr.initializer.expression.getText(route);
  }
  ts.forEachChild(node, visit);
}
visit(route);
assert.ok(prefill && effect && manual, "test exercises the actual route prefill/effect/select");
const fields = ["customerId", "customerName", "customerPhone", "governorate", "city", "detailedAddress"];
const context = { exports: {}, require, React, exchangeShippingFrom, cleared: [] };
vm.runInNewContext(compile(`
const { useState, useCallback, useEffect } = React;
const setSearchParams = (value, options) => cleared.push({value, options});
exports.Harness = function Harness({allOrders, exchangeOf}) {
${fields.map(f => `const [${f}, set${f[0].toUpperCase()+f.slice(1)}] = useState("stale");`).join("\n")}
const [isExchange,setIsExchange]=useState(false), [originalOrderId,setOriginalOrderId]=useState("");
const [returningLines,setReturningLines]=useState(["stale"]), [exchangeCause,setExchangeCause]=useState("stale");
${prefill}
${effect};
const selectSource = ${manual};
return <div>
  ${fields.map(f => `<input aria-label="${f}" value={${f}} onChange={e=>set${f[0].toUpperCase()+f.slice(1)}(e.target.value)}/>`).join("\n")}
  <select aria-label="source" value={originalOrderId} onChange={selectSource}><option value="">None</option>{allOrders.map(o=><option key={o.id} value={o.id}>{o.id}</option>)}</select>
  <output>{JSON.stringify({isExchange,originalOrderId,returningLines,exchangeCause})}</output>
</div>;
};`), context);
const Harness = context.exports.Harness;
test("E actual route: cold hydration, complete prefill, edits survive refresh, switching clears stale fields", async () => {
  const saved = structuredClone(origin);
  const entry = await render(React.createElement(Harness, { allOrders: [], exchangeOf: origin.id }));
  assert.equal(getByLabelText(entry.host, "detailedAddress").value, "stale");
  await render(React.createElement(Harness, { allOrders: [origin], exchangeOf: origin.id }), entry);
  for (const [key,value] of Object.entries(exchangeShippingFrom(origin))) assert.equal(getByLabelText(entry.host,key).value,value);
  assert.match(entry.host.querySelector("output").textContent, /"returningLines":\[\]/);
  assert.ok(context.cleared.some(c=>c.options.replace === true));
  const input = getByLabelText(entry.host,"detailedAddress"), user = userEvent.setup({ document });
  await act(async () => { await user.clear(input); await user.type(input,"عنوان بديل 9-أ"); });
  await render(React.createElement(Harness,{allOrders:[{...origin,address:"changed in background"}],exchangeOf:null}),entry);
  assert.equal(input.value,"عنوان بديل 9-أ");
  const next = {id:"order-b",customerName:"أصل آخر",customerPhone:"",address:""};
  await render(React.createElement(Harness,{allOrders:[origin,next],exchangeOf:null}),entry);
  await act(async()=>fireEvent.change(getByLabelText(entry.host,"source"),{target:{value:next.id}}));
  assert.equal(getByLabelText(entry.host,"detailedAddress").value,"");
  assert.equal(getByLabelText(entry.host,"governorate").value,"");
  assert.equal(getByLabelText(entry.host,"city").value,"");
  assert.equal(getByLabelText(entry.host,"customerId").value,"");
  assert.deepEqual(origin,saved,"prefill/edit/cancel never mutates the original snapshot");
});

const STORE="store-a", product = {id:"p",store_id:STORE,name:"كريم طويل الاسم — النسخة الحالية",sku:"SKU-1",metadata:{variants:[{name:"RED / S",stock:3},{name:"BLUE / S",stock:20}]}};
const recipe=[{productId:"p",variantName:"RED / S",quantity:1},{productId:"p",variantName:"BLUE / S",quantity:2}];
test("G: exact product/variant identity, current name, historical recipe immutable, missing/cross-store metadata explicit", () => {
  const saved=structuredClone(recipe), map=new Map([["p",product]]);
  const rows=bundleComponentDetails(recipe,map,STORE);
  assert.deepEqual(rows.map(r=>[r.productName,r.variantName,r.quantity]),recipe.map(r=>[product.name,r.variantName,r.quantity]));
  assert.equal(rows[0].unavailable,false);
  assert.equal(bundleComponentDetails(recipe,new Map([["p",{...product,store_id:"other",name:"Foreign"}]]),STORE)[0].unavailable,true);
  assert.notEqual(bundleComponentDetails(recipe,new Map([["p",{...product,store_id:"other",name:"Foreign"}]]),STORE)[0].productName,"Foreign");
  assert.equal(bundleComponentDetails([{...recipe[0],variantName:"ARCHIVED"}],map,STORE)[0].variantUnavailable,true);
  assert.equal(bundleComponentDetails([{productId:"gone",productName:"Saved historical label",quantity:-1}],map,STORE)[0].quantity,null);
  assert.deepEqual(recipe,saved);
});
const loadUI=loader(), {MobileBundleContents}=loadUI("src/mobile/components/MobileBundleContents.tsx");
test("G actual Mobile component: named list, exact variants/quantities/SKU, empty and missing states", async () => {
  const entry=await render(React.createElement(MobileBundleContents,{components:bundleComponentDetails(recipe,new Map([["p",product]]),STORE)}));
  getByRole(entry.host,"heading",{name:"مكونات البوكس"});
  const list=getByRole(entry.host,"list",{name:"مكونات البوكس"}), items=within(list).getAllByRole("listitem");
  assert.equal(items.length,2);
  assert.match(items[0].textContent,/RED \/ S/); assert.match(items[1].textContent,/BLUE \/ S/);
  assert.match(items[0].textContent,/SKU-1/); assert.match(items[0].textContent,/عدد ١/); assert.match(items[1].textContent,/عدد ٢/);
  await render(React.createElement(MobileBundleContents,{components:[]}),entry);
  assert.ok(queryByText(entry.host,"لا توجد مكونات محفوظة لهذا البوكس."));
  await render(React.createElement(MobileBundleContents,{components:bundleComponentDetails(recipe,new Map(),STORE)}),entry);
  assert.match(entry.host.textContent,/تعذّر تحميل بيانات المنتج الحالية/);
  assert.match(entry.host.textContent,/RED \/ S/);
});

test("G actual reader: same-product variants deduplicated, tenant-scoped, refresh updates name and stock", async () => {
  let component=structuredClone(product), reads=[];
  const box={id:"box",store_id:STORE,name:"Box",isBundle:true,bundleItems:recipe};
  const client={from(table){
    const filters=[]; const q={select(){return q},order(){return q},is(k,v){filters.push([k,v]);return q},eq(k,v){filters.push([k,v]);return q},or(){return q},
      range(){reads.push({table,filters});return Promise.resolve({data:[box],count:1,error:null})},
      maybeSingle(){reads.push({table,filters});return Promise.resolve({data:structuredClone(component),error:null})}};
    return q;
  }};
  const actual=loader({"@/lib/supabase":{getSupabaseClient:()=>client},"@/lib/ledger":{balanceOf:async(_a,id)=>({qty:id==="box"?0:23,amount:0})},"@/store/useAuthStore":{useAuthStore:{getState:()=>({userRole:"ADMIN"})}}})("src/mobile/data/mobileReaders.ts");
  const first=await actual.readMobileProduct("box");
  assert.equal(first.mobileStock,3);
  assert.equal(first.mobileBundleComponents[0].productName,component.name);
  const scoped=reads.filter(r=>r.filters.some(([k,v])=>k==="store_id"&&v===STORE));
  assert.equal(scoped.length,1,"two variants of one component require only one scoped row lookup");
  component={...component,name:"اسم محدث",metadata:{variants:[{name:"RED / S",stock:1},{name:"BLUE / S",stock:20}]}};
  const second=await actual.readMobileProduct("box");
  assert.equal(second.mobileStock,1);
  assert.equal(second.mobileBundleComponents[0].productName,"اسم محدث");
  assert.deepEqual(box.bundleItems,recipe,"the reader never rewrites the saved recipe");
});

test("SYNC-002 actual hook: balance refresh resolves new names; obsolete requests cannot replace newer names", async () => {
  const pending=[];
  const {useSubjectNames}=loader({
    "@/lib/receiving":{readSuppliers:()=>new Promise(resolve=>pending.push(resolve))},
    "./mobileReaders":{readMobileCouriers:async()=>new Map([["courier",{id:"courier",name:"مندوب تجريبي"}]])},
  })("src/mobile/data/useSubjectNames.ts");
  const Harness=({enabled,revision})=>{
    const names=useSubjectNames(enabled,revision);
    return React.createElement("output",null,JSON.stringify({suppliers:[...names.suppliers],couriers:[...names.couriers]}));
  };
  const entry=await render(React.createElement(Harness,{enabled:false,revision:0}));
  assert.equal(pending.length,0,"denied/failed financial summary must not trigger registry reads");
  await render(React.createElement(Harness,{enabled:true,revision:1}),entry);
  await act(async()=>pending[0]([]));
  assert.doesNotMatch(entry.host.textContent,/مورد جديد/);
  await render(React.createElement(Harness,{enabled:true,revision:2}),entry);
  await render(React.createElement(Harness,{enabled:true,revision:3}),entry);
  await act(async()=>pending[2]([{id:"supplier",companyName:"مورد جديد",phone:""}]));
  assert.match(entry.host.textContent,/مورد جديد/);
  await act(async()=>pending[1]([{id:"supplier",companyName:"اسم قديم",phone:""}]));
  assert.doesNotMatch(entry.host.textContent,/اسم قديم/);
  await render(React.createElement(Harness,{enabled:false,revision:4}),entry);
  assert.equal(entry.host.textContent,'{"suppliers":[],"couriers":[]}');
  assert.match(read("src/mobile/screens/MobileOwnerScreen.tsx"),/useSubjectNames\(Boolean\(data\), data\)/);
  assert.match(read("src/mobile/screens/MobilePurchasingScreen.tsx"),/useSubjectNames\(true, rows\)/);
});

test("SYNC-001 actual dispatcher: server purchase updates keep creator device but merge once through LWW", () => {
  const makeStore = (initial) => {
    let state=initial;
    return {getState:()=>state,setState:patch=>{state={...state,...(typeof patch==="function"?patch(state):patch)}}};
  };
  const business=makeStore({products:[{id:"p",quantity:50,updated_at:100}],purchaseInvoices:[{id:"i",paidAmount:0,remainingAmount:20,updated_at:100}],suppliers:[]});
  const orderStore=makeStore({orders:[{id:"o",codSettledAt:null,updatedAt:"2030-10-12T09:00:00Z",updated_at:100}]});
  const stubs={
    "@/lib/auth/useSessionReconciliation":{},"@/store/useSyncStatus":{},react:React,
    "../store/useBusinessStore":{useBusinessStore:business},
    "../store/useOrderStore":{useOrderStore:orderStore},
    "../store/useFinancialStore":{useFinancialStore:makeStore({expenses:[]})},
    "../store/useCustomerStore":{useCustomerStore:makeStore({customers:[]})},
    "../store/useShippingRatesStore":{useShippingRatesStore:makeStore({rows:[]})},
    "../lib/supabase":{},"@/store/useAuthStore":{},"@/lib/roles":{},
    "../services/api/storeContext":{getDeviceId:()=>"creator"},
  };
  const exports={};
  vm.runInThisContext(`(function(exports,require){${compile(read("src/hooks/useRealtimeSync.ts")+"\nexport {handleChange};")}\n})`)(exports,id=>{
    assert.ok(Object.hasOwn(stubs,id),`unexpected dependency ${id}`);return stubs[id];
  });
  const send=(table,row,eventType="UPDATE")=>exports.handleChange(table,{eventType,new:{device_id:"creator",...row},old:row});
  send("products",{id:"p",quantity:60,metadata:{variants:[{name:"RED",stock:40},{name:"BLUE",stock:20}]},updated_at:101});
  send("purchase_invoices",{id:"i",paidAmount:20,remainingAmount:0,status:"paid",updated_at:101});
  send("orders",{id:"o",codSettledAt:"2026-10-12T09:00:01Z",updatedAt:"2026-10-12T09:00:01Z",updated_at:101});
  assert.ok(orderStore.getState().orders[0].codSettledAt);
  send("orders",{id:"o",codSettledAt:null,updatedAt:"2026-10-12T09:00:00Z",updated_at:100});
  assert.ok(orderStore.getState().orders[0].codSettledAt,"stale order cannot reopen a settled batch");
  assert.equal(business.getState().products[0].quantity,60);
  assert.deepEqual(business.getState().products[0].metadata.variants.map(v=>v.stock),[40,20]);
  assert.equal(business.getState().purchaseInvoices[0].remainingAmount,0);
  send("products",{id:"p",quantity:50,updated_at:100});
  send("purchase_invoices",{id:"i",remainingAmount:20,updated_at:100});
  assert.equal(business.getState().products[0].quantity,60);
  assert.equal(business.getState().purchaseInvoices[0].remainingAmount,0);
  send("products",{id:"p",quantity:99,updated_at:101});
  assert.equal(business.getState().products[0].quantity,60,"same update cannot increment twice");
  send("suppliers",{id:"s",updated_at:110});
  assert.equal(business.getState().suppliers.length,0,"unrelated own-echo policy preserved");
  send("products",{id:"p",updated_at:111},"DELETE");
  assert.equal(business.getState().products.length,1,"own DELETE policy preserved");
  exports.handleChange("products",{eventType:"UPDATE",new:{id:"p",device_id:"other",quantity:61,updated_at:102}});
  assert.equal(business.getState().products[0].quantity,61);
});
test("B/D2 actual stock refresh: tenant-scoped read only, delayed responses cannot overwrite newer rows or a changed store",async()=>{
 let identity={storeId:"a"},state={products:[{id:"p",quantity:50,updated_at:100}]},resolveRead;const filters=[];
 const client={from(table){assert.equal(table,"products");const q={select(){return q},eq(k,v){filters.push([k,v]);return q},in(k,v){filters.push([k,v]);return new Promise(resolve=>{resolveRead=resolve})}};return q}};
 const {refreshFeatureStock}=loader({
  "@/lib/supabase":{getSupabaseClient:()=>client},"@/services/api/storeContext":{getSyncIdentity:async()=>identity},
  "@/services/api/fieldMapping":{fromRemoteRow:(_table,row)=>row},
  "@/store/useBusinessStore":{useBusinessStore:{setState:fn=>{state={...state,...fn(state)}}}},
 })("src/services/featureStockMirror.ts");
 let pending=refreshFeatureStock(["p","p"]);await Promise.resolve();await Promise.resolve();
 state.products=[{id:"p",quantity:65,updated_at:102}];resolveRead({data:[{id:"p",quantity:60,updated_at:101}],error:null});await pending;
 assert.equal(state.products[0].quantity,65);assert.deepEqual(filters,[["store_id","a"],["id",["p"]]]);
 pending=refreshFeatureStock(["p"]);await Promise.resolve();await Promise.resolve();identity={storeId:"b"};
 resolveRead({data:[{id:"p",quantity:70,updated_at:103}],error:null});await pending;assert.equal(state.products[0].quantity,65);
 identity={storeId:"a"};pending=refreshFeatureStock(["p"]);await Promise.resolve();await Promise.resolve();
 resolveRead({data:[{id:"p",quantity:70,updated_at:103}],error:null});await pending;assert.equal(state.products[0].quantity,70);
});

test("D1: original customer identity is the receipt snapshot, including anonymous and malformed legacy data", () => {
  assert.deepEqual(originalPosCustomer({id:"sale",payload:{customerId:"archived",customerName:"Original",customerPhone:"010"}}),{id:"archived",name:"Original",phone:"010"});
  assert.deepEqual(originalPosCustomer({id:"sale",payload:{customerName:"Walk in",customerPhone:"010"}}),{id:"",name:"Walk in",phone:"010"});
  assert.deepEqual(originalPosCustomer({id:"sale",payload:{customerId:44,customerPhone:{value:"010"}}}),{id:"",name:"",phone:""});
});

// Exercise the actual checkout cart/picker/removal handlers and CRM select.
// The mixed sale/exchange guard remains until a real atomic contract exists.
const checkout=ts.createSourceFile("checkout.tsx",read("src/components/sales/CheckoutForm.tsx"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const declarations={};let returnPick,customerSelect,actionButton,exchangeSummary;
function inspectCheckout(node){
  if(ts.isVariableStatement(node))for(const d of node.declarationList.declarations){const name=d.name.getText(checkout);if(["addItemToCart","removeFromCart","updateCartQuantity","returnCustomerLocked","isPosExchange"].includes(name))declarations[name]=node.getText(checkout)}
  if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(checkout)==="POSReturnModal")returnPick=node.attributes.properties.find(a=>a.name?.getText(checkout)==="onReturnItem").initializer.expression.getText(checkout);
  if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(checkout)==="select"&&node.openingElement.attributes.properties.some(a=>a.name?.getText(checkout)==="aria-label"&&a.initializer?.text==="عميل فاتورة نقاط البيع"))customerSelect=node.getText(checkout);
  if(ts.isCallExpression(node)&&node.getText(checkout).startsWith("(() =>")&&node.getText(checkout).includes('const isExchange = isPosExchange;'))actionButton=node.getText(checkout);
  if(ts.isJsxElement(node)&&node.openingElement.attributes.properties.some(a=>a.name?.getText(checkout)==="aria-label"&&a.initializer?.text==="ملخص الاستبدال"))exchangeSummary=node.getText(checkout);
  ts.forEachChild(node,inspectCheckout);
}
inspectCheckout(checkout);assert.ok(returnPick&&customerSelect&&actionButton&&exchangeSummary&&declarations.addItemToCart&&declarations.removeFromCart);
const posHelpers=loader({"@/lib/financialCommand":{},"@/services/featureStockMirror":{}})("src/lib/posExchange.ts");
const posContext={exports:{},require,React,window:{confirm:()=>false},...posHelpers};
vm.runInNewContext(compile(`
const {useState}=React;
exports.Harness=function({customers,initialCart=[],pick}){
 const [cart,setCart]=useState(initialCart),[selectedCustomerId,setSelectedCustomerId]=useState("stale"),[customerName,setCustomerName]=useState("Stale"),[customerPhone,setCustomerPhone]=useState("999"),[isReturnMode,setIsReturnMode]=useState(false),[result,setResult]=useState(null);
 const saleMode="retail",products=[],setPendingVariantSelection=()=>{},setAppliedDiscount=()=>{},setDiscountCodeInput=()=>{};
 const sellableStock=()=>50,posRefundValue=(line,q)=>line.unitPrice*q;
 ${declarations.returnCustomerLocked}
 ${declarations.isPosExchange}
 ${declarations.addItemToCart}
 ${declarations.removeFromCart}
 ${declarations.updateCartQuantity}
 const onPick=${returnPick};
 const isWholesaleReturn=false,resolvedWholesaleReturn={},isProcessing=false,handleCompleteSale=()=>{},cn=(...parts)=>parts.filter(Boolean).join(" "),Button=props=><button {...props}/>,discountAmount=0,selectedWallet="inStoreSafe",WALLET_LABELS={inStoreSafe:"خزينة المحل"},formatCurrency=String;
 const subtotal=cart.reduce((n,i)=>n+i.quantity*i.unitPrice,0),discountSubtotal=cart.filter(i=>i.quantity>0).reduce((n,i)=>n+i.quantity*i.unitPrice,0),calculateTotal=()=>subtotal;
 return <div>${customerSelect}<button onClick={()=>onPick(pick)}>Pick</button><button onClick={()=>{const row=cart.find(i=>i.returnOfEventId);if(row)removeFromCart(row.productId,row.variantName,row.returnOfEventId)}}>Remove</button><button onClick={()=>addItemToCart({id:pick.line.productId,name:"Replacement",unitPrice:12,quantity:50},1,pick.line.variantName)}>Replace</button><button onClick={()=>removeFromCart(pick.line.productId,pick.line.variantName)}>Remove replacement</button>{${actionButton}}{isPosExchange&&${exchangeSummary}}<output>{JSON.stringify({cart,selectedCustomerId,customerName,customerPhone,isReturnMode,isPosExchange,result,returnCustomerLocked})}</output></div>;
};`),posContext);
const line={productId:"p",productName:"Historical product",unitPrice:10,unitCost:2,sold:3,returned:0,remaining:3};
test("D1 actual checkout: source customer selected and locked, archived fallback, anonymous preserved, cancel resets, refused source leaves identity intact",async()=>{
  const customers=[{id:"same-name",name:"Original",phone:"010"},{id:"original",name:"Renamed",phone:"020"}],pick={line,sourceEventId:"sale",customer:{id:"original",name:"Original",phone:"010"}};
  let entry=await render(React.createElement(posContext.exports.Harness,{customers,pick}));
  const state=()=>JSON.parse(entry.host.querySelector("output").textContent);
  await act(async()=>fireEvent.click(getByRole(entry.host,"button",{name:"Pick"})));
  assert.equal(getByRole(entry.host,"combobox",{name:"عميل فاتورة نقاط البيع"}).value,"original");
  assert.equal(getByRole(entry.host,"combobox").disabled,true);
  assert.equal(state().customerName,"Original");assert.equal(state().customerPhone,"010");assert.equal(state().cart[0].quantity,-1);
  const before=state();
  await render(React.createElement(posContext.exports.Harness,{customers,pick:{...pick,sourceEventId:"other",customer:{id:"same-name",name:"Other",phone:"666"}}}),entry);
  await act(async()=>fireEvent.click(getByRole(entry.host,"button",{name:"Pick"})));
  assert.deepEqual(state().cart,before.cart);assert.equal(state().selectedCustomerId,"original");assert.equal(state().customerPhone,"010");
  await act(async()=>fireEvent.click(getByRole(entry.host,"button",{name:"Remove"})));
  assert.equal(state().cart.length,0);assert.equal(state().selectedCustomerId,"");assert.equal(state().customerPhone,"");assert.equal(state().isReturnMode,false);
  for(const customer of [{id:"archived",name:"Archived original",phone:"030"},{id:"",name:"Anonymous",phone:"010"}]){
    entry=await render(React.createElement(posContext.exports.Harness,{customers,pick:{...pick,customer}}));
    await act(async()=>fireEvent.click(getByRole(entry.host,"button",{name:"Pick"})));
    assert.equal(state().selectedCustomerId,customer.id);assert.equal(state().customerName,customer.name);
    assert.equal(getByRole(entry.host,"combobox").value,customer.id);
  }
  entry=await render(React.createElement(posContext.exports.Harness,{customers,pick,initialCart:[{productId:"sale-product",quantity:1}]}));
  await act(async()=>fireEvent.click(getByRole(entry.host,"button",{name:"Pick"})));
  assert.equal(state().selectedCustomerId,"stale");assert.equal(state().isReturnMode,false);assert.equal(state().cart.length,1);
  assert.match(read("src/components/sales/CheckoutForm.tsx"),/customerPhone && !finalCustomerId && !returnCustomerLocked/);
});

test("D1 changing receipt requires deliberate confirmation and resets old return/replacement draft and customer without a financial call",async()=>{
 const customers=[{id:"original",name:"Original"},{id:"second",name:"Second"}],pick={line,sourceEventId:"sale",customer:{id:"original",name:"Original",phone:"010"}};
 const entry=await render(React.createElement(posContext.exports.Harness,{customers,pick}));
 const state=()=>JSON.parse(entry.host.querySelector("output").textContent);
 await act(async()=>fireEvent.click(getByRole(entry.host,"button",{name:"Pick"})));
 await act(async()=>fireEvent.click(getByRole(entry.host,"button",{name:"Replace",exact:true})));
 assert.equal(state().cart.length,2);
 const second={...pick,sourceEventId:"second-sale",sourceDocumentNumber:"BS-P002",customer:{id:"second",name:"Second",phone:"020"}};
 await render(React.createElement(posContext.exports.Harness,{customers,pick:second}),entry);
 try {posContext.window.confirm=()=>true;await act(async()=>fireEvent.click(getByRole(entry.host,"button",{name:"Pick"})));}
 finally {posContext.window.confirm=()=>false;}
 assert.equal(state().cart.length,1);assert.equal(state().cart[0].quantity,-1);assert.equal(state().cart[0].returnOfEventId,"second-sale");assert.equal(state().cart[0].historicalCost.sourceDocumentNumber,"BS-P002");assert.equal(state().selectedCustomerId,"second");assert.equal(state().customerPhone,"020");assert.equal(state().isPosExchange,false);
});

test("D2 actual cart handlers: same-product return/replacement stay distinct, removing replacement restores return-only, customer never changes",async()=>{
 const pick={line,sourceEventId:"sale",customer:{id:"original",name:"Original",phone:"010"}},customers=[{id:"original",name:"Original"}];
 const entry=await render(React.createElement(posContext.exports.Harness,{customers,pick}));
 const state=()=>JSON.parse(entry.host.querySelector("output").textContent);
 await act(async()=>fireEvent.click(getByRole(entry.host,"button",{name:"Pick"})));
 assert.equal(state().isPosExchange,false);
  assert.match(getByRole(entry.host,"button",{name:"إتمام المرتجع"}).className,/bg-red-600/);
 await act(async()=>fireEvent.click(getByRole(entry.host,"button",{name:"Replace",exact:true})));
 assert.equal(state().isPosExchange,true);assert.deepEqual(state().cart.map(i=>i.quantity),[-1,1]);
  assert.match(getByRole(entry.host,"button",{name:"إتمام الاستبدال"}).className,/bg-indigo-600/);
  const summary=getByLabelText(entry.host,"ملخص الاستبدال").textContent;
  assert.match(summary,/فاتورة الأصل: sale/);assert.match(summary,/صافي قيمة المرتجع: 10/);assert.match(summary,/قيمة البديل بعد الخصم: 12/);assert.match(summary,/تحصيل من العميل: 2/);
 assert.equal(state().selectedCustomerId,"original");assert.equal(new Set(state().cart.map(posHelpers.posCartLineKey)).size,2);
 await act(async()=>fireEvent.click(getByRole(entry.host,"button",{name:"Remove replacement"})));
 assert.equal(state().isPosExchange,false);assert.equal(state().cart.length,1);assert.equal(state().cart[0].quantity,-1);assert.equal(state().returnCustomerLocked,true);
 await act(async()=>fireEvent.click(getByRole(entry.host,"button",{name:"Remove",exact:true})));
 assert.equal(state().cart.length,0);assert.equal(state().selectedCustomerId,"");
  await act(async()=>fireEvent.click(getByRole(entry.host,"button",{name:"Pick"})));
  await act(async()=>fireEvent.click(getByRole(entry.host,"button",{name:"Replace",exact:true})));
  await act(async()=>fireEvent.click(getByRole(entry.host,"button",{name:"Remove",exact:true})));
  assert.equal(state().cart.length,1);assert.equal(state().cart[0].quantity,1);assert.equal(state().isPosExchange,false);assert.equal(state().selectedCustomerId,"");assert.equal(state().returnCustomerLocked,false);
});
test("D2: current stock plus exact historical return credit allows a zero-stock shade and uses saved bundle components",()=>{
 const p={id:"p",quantity:0,metadata:{variants:[{name:"RED",stock:0},{name:"BLUE",stock:0}]}};
 const returned=[{productId:"p",variantName:"RED",quantity:-1,historicalCost:{unitCost:2}}];
 assert.equal(posHelpers.posStockAfterReturns(p,[p],returned,"RED"),1);assert.equal(posHelpers.posStockAfterReturns(p,[p],returned,"BLUE"),0);
 const box={id:"box",isBundle:true,bundleItems:[{productId:"p",variantName:"RED",quantity:2}]};
 const historical=[{productId:"old-box",quantity:-1,historicalCost:{isBundle:true,bundleItems:[{productId:"p",variantName:"RED",quantity:2,unitCost:2}]}}];
 assert.equal(posHelpers.posStockAfterReturns(box,[p,box],historical),1);assert.equal(posHelpers.posStockAfterReturns(p,[p],historical,"RED"),2);
 assert.equal(posHelpers.posStockAfterReturns(p,[p],historical,"BLUE"),0);
});

test("D1 actual receipt picker passes persisted customer ID and snapshot with the historical line",async()=>{
  let selected;
  const container=({children})=>React.createElement("div",null,children);
  const modal=loader({
    "@/components/ui/dialog":Object.fromEntries(["Dialog","DialogContent","DialogHeader","DialogTitle","DialogDescription","DialogTrigger"].map(k=>[k,container])),
    "@/components/ui/button":{Button:({children,variant,size,...p})=>React.createElement("button",p,children)},
    "@/components/ui/input":{Input:p=>React.createElement("input",p)},
    "@/services/posReceipts":{readPosReceipt:async()=>{throw Error("Unexpected receipt open");}},
    "@/lib/pdfGenerator":{printTableAsPdf:()=>{throw Error("Unexpected print");}},
    "@/store/useBusinessStore":{useBusinessStore:selector=>selector({products:[]})},
    "@/lib/ledger":{events:async()=>[{id:"sale",occurredAt:new Date().toISOString(),payload:{customerId:"archived",customerName:"Original",customerPhone:"010",items:[{...line,quantity:3}]}}],eventLines:async()=>[{account:"stock",subject_id:"p",qty_delta:-3,amount_delta:-600}]},
  })("src/components/sales/POSReturnModal.tsx");
  const entry=await render(React.createElement(modal.POSReturnModal,{onReturnItem:p=>{selected=p}}));
  await act(async()=>fireEvent.change(getByLabelText(entry.host,"رقم الفاتورة أو هاتف العميل"),{target:{value:"sale"}}));
  await act(async()=>fireEvent.click(getByRole(entry.host,"button",{name:"بحث"})));
  await act(async()=>fireEvent.click(getByRole(entry.host,"button",{name:/إرجاع 1/})));
  assert.deepEqual(selected.customer,{id:"archived",name:"Original",phone:"010"});assert.equal(selected.sourceEventId,"sale");assert.equal(selected.line.productName,line.productName);assert.equal(selected.line.unitCost,2);
});

// Actual settlement callback/button in a minimal React host. Database money
// and retries are independently covered by the actual-schema PG17.6 suite.
const courierPage=ts.createSourceFile('courier.tsx',read('src/components/ecommerce/CourierLedgerPage.tsx'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let courierConfirm,courierButton;
function courierVisit(node){
 if(ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(courierPage)==='confirmBatch'))courierConfirm=node.getText(courierPage);
 if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(courierPage)==='Button'&&node.openingElement.attributes.properties.some(a=>a.name?.getText(courierPage)==='onClick'&&a.initializer?.getText(courierPage).includes('confirmBatch()')))courierButton=node.getText(courierPage);
 ts.forEachChild(node,courierVisit);
}courierVisit(courierPage);assert.ok(courierConfirm&&courierButton);
async function courierHost({pending=null,failure=false,empty=false,payout=false,partial=false,unrelated=false,shortfall=false,canCloseClaims=true,sourceClaim=false}={}){
 const calls=[],o={id:'o',courierId:'c',status:'delivered',expectedCod:50,courierFee:50,courierObligation:{codPiastres:payout?0:5000,feePiastres:payout?300:shortfall?0:5000}},result={eventId:'settlement',orderIds:['o'],closedOrderIds:partial?[]:['o'],closedClaimIds:[],netPiastres:payout?-300:shortfall?4900:0,shortfallPiastres:shortfall?100:0,replayed:false};
 const ctx={exports:{},require,React,calls,window,o,canCloseClaims,formatMoney:n=>String(n),props:{pending,failure,empty,payout,partial,unrelated,shortfall,sourceClaim},
  commitCourierBatch:async input=>{calls.push(['commit',input]);if(failure)throw Error('SYNTHETIC_UNCERTAIN_RESPONSE');result.closedClaimIds=input.claimIds;return result},
  resolvePendingCourierBatch:async()=>{calls.push(['resolve']);return pending},
  useOrderStore:{getState:()=>({orders:empty?[]:[o]})},unsettledDeliveries:orders=>orders,
  advanceClaim:async()=>{throw Error('No post-commit claim writer allowed')},
  Button:({children,...attrs})=>React.createElement('button',attrs,children),Wallet:()=>null};
 vm.runInNewContext(compile(`const {useState,useRef}=React;
 exports.Harness=function(){
 const [batchCourier,setBatchCourier]=useState({id:'c',name:'Courier'}),[isWorking,setIsWorking]=useState(false),[batchError,setBatchError]=useState(null),[notice,setBatchNotice]=useState(null),[claimNote,setClaimNote]=useState(null),[historyTick,setHistoryTick]=useState(0);
 const writing=useRef(false),runOnce=fn=>fn(),ticked={o:true},received=props.payout?'-3':props.shortfall?'49':'0',wallet='inStoreSafe',claims=[{id:'claim',order_id:props.unrelated?'another-order':'o',source_event_id:props.sourceClaim?'canonical-source':null}],claimTicked={claim:true},tickedOrders=[],obligationsReady=true,obligationError=null,openOrders=props.empty?[]:[o],allocatedOrders=props.partial?openOrders.map(order=>({...order,courierObligation:{codPiastres:2500,feePiastres:2500}})):openOrders;
 const refresh=()=>calls.push(['refresh']);const owedToUs={refresh},owedToThem={refresh},feeDelivery={refresh},feeReturnish={refresh},feeExchange={refresh},refreshExpense=refresh;
 ${courierConfirm}
 return <div>${courierButton}<p role="status">{notice}</p><p role="alert">{batchError}</p><p>{claimNote}</p><output role="note">{String(batchCourier===null)}</output></div>;
 };`),ctx);
 const entry=await render(React.createElement(ctx.exports.Harness));return {entry,calls,result};
}
test('I actual settlement callback/button: zero offset is honest; covered claim IDs go into the one atomic command',async()=>{
 const {entry,calls,result}=await courierHost();
 await act(async()=>fireEvent.click(getByRole(entry.host,'button',{name:'تحقق وسجّل التسوية'})));
 assert.match(getByRole(entry.host,'status').textContent,/صافي التحويل 0.*دون حركة خزنة/);
 assert.deepEqual(Array.from(calls.find(c=>c[0]==='commit')[1].claimIds),['claim']);assert.deepEqual(Array.from(result.closedClaimIds),['claim']);
 assert.equal(calls.filter(c=>c[0]==='commit').length,1);
 assert.equal(getByRole(entry.host,'alert').textContent,'');
});
test('I actual callback leaves unrelated and written-off claims approved, without a second write',async()=>{
 for(const options of [{unrelated:true},{shortfall:true},{canCloseClaims:false}]){
  const {entry,calls}=await courierHost(options);await act(async()=>fireEvent.click(getByRole(entry.host,'button',{name:'تحقق وسجّل التسوية'})));
  assert.deepEqual(Array.from(calls.find(c=>c[0]==='commit')[1].claimIds),[]);assert.match(entry.host.textContent,/المطالبات غير المغطاة ما زالت معتمدة/);
 }
});
test('I actual callback: uncertain financial response neither clears the dialog nor closes claims or says nothing changed',async()=>{
 const {entry,calls}=await courierHost({failure:true});await act(async()=>fireEvent.click(getByRole(entry.host,'button',{name:'تحقق وسجّل التسوية'})));
 assert.match(getByRole(entry.host,'alert').textContent,/تعذّر تأكيد التسوية.*نفس العملية/);assert.doesNotMatch(entry.host.textContent,/مفيش رصيد اتغيّر/);
 assert.equal(calls.filter(c=>c[0]==='claim').length,0);assert.equal(getByRole(entry.host,'status').textContent,'');
 assert.equal(entry.host.querySelector('output').textContent,'false');
});
test('I actual callback/button: pending replay is reachable with no open rows, cannot submit a new transfer or attach edited claims',async()=>{
 const {entry,calls}=await courierHost({empty:true,pending:{eventId:'prior',orderIds:['previous'],netPiastres:0,shortfallPiastres:0,replayed:true}});
 const button=getByRole(entry.host,'button',{name:'تحقق وسجّل التسوية'});assert.equal(button.disabled,false);
 await act(async()=>fireEvent.click(button));assert.equal(calls.filter(c=>c[0]==='commit'||c[0]==='claim').length,0);
 assert.match(getByRole(entry.host,'status').textContent,/دون حركة خزنة/);
});
test('I actual callback: negative net explicitly says courier payout, partial allocation does not close claims',async()=>{
 const payout=await courierHost({payout:true});await act(async()=>fireEvent.click(getByRole(payout.entry.host,'button',{name:'تحقق وسجّل التسوية'})));
 assert.match(getByRole(payout.entry.host,'status').textContent,/دفع 3 للمندوب/);assert.equal(payout.calls.find(x=>x[0]==='commit')[1].netReceived,-3);
 const partial=await courierHost({partial:true});await act(async()=>fireEvent.click(getByRole(partial.entry.host,'button',{name:'تحقق وسجّل التسوية'})));
 assert.match(getByRole(partial.entry.host,'status').textContent,/تسوية جزئية.*مفتوحة/);assert.equal(partial.calls.filter(x=>x[0]==='claim').length,0);
 assert.match(partial.entry.host.textContent,/لم تُغلق تلقائيًا مع تسوية جزئية/);
});
test('I actual fee-only callback sends an approved source-proved claim for canonical offset, preserving unproved legacy notes',async()=>{
 const source=await courierHost({payout:true,sourceClaim:true});await act(async()=>fireEvent.click(getByRole(source.entry.host,'button',{name:'تحقق وسجّل التسوية'})));assert.deepEqual(Array.from(source.calls.find(x=>x[0]==='commit')[1].claimIds),['claim']);
 const legacy=await courierHost({payout:true});await act(async()=>fireEvent.click(getByRole(legacy.entry.host,'button',{name:'تحقق وسجّل التسوية'})));assert.deepEqual(Array.from(legacy.calls.find(x=>x[0]==='commit')[1].claimIds),[]);
});
async function claimRecoveryHost({lost=false,refused=false,changedTenant=false,cacheFailure=false,role='ADMIN',legacy=false}={}) {
 const calls=[];let current={id:'claim',store_id:'store',order_id:'o',courier_id:'courier',status:'approved',source_event_id:legacy?null:'source'},tenant='store';
 const {CourierClaimRecoveryPanel}=loader({'@/hooks/useSubmitGate':{useRunOnce:()=>fn=>fn()},'@/store/useAuthStore':{useAuthStore:selector=>selector({userRole:role})},
  '@/services/api/storeContext':{getSyncIdentity:async()=>({storeId:tenant})},'@/components/ui/button':{Button:({children,...props})=>React.createElement('button',props,children)},
  '@/services/courierClaims':{claimForOrder:async()=>{calls.push(['read']);if(changedTenant)tenant='other';return current},advanceClaim:async input=>{calls.push(['note',input]);if(refused)throw Object.assign(Error('SYNTHETIC_SOURCE_REFUSAL'),{definite:true});current={...current,status:'settled',settlement_event_id:input.settlementEventId};if(lost){lost=false;throw Error('SYNTHETIC_NOTE_RESPONSE_LOSS')}return current}}})('src/components/ecommerce/CourierClaimRecoveryPanel.tsx');
 const entry=await render(React.createElement(CourierClaimRecoveryPanel,{claims:[current],history:[{id:'settlement',courierId:'courier',orderAmounts:[{orderNumber:'BS-O001'}]}],orders:[{id:'o',orderNumber:'BS-O001'}],onRecovered:()=>{calls.push(['refresh']);if(cacheFailure)throw Error('SYNTHETIC_REFRESH_FAILURE')}}));
 if(role==='ADMIN'||role==='ACCOUNTANT') {if(!legacy){await act(async()=>fireEvent.change(getByLabelText(entry.host,'المطالبة المعتمدة'),{target:{value:'claim'}}));await act(async()=>fireEvent.change(getByLabelText(entry.host,'مرجع التسوية المحفوظ'),{target:{value:'settlement'}}));}}
 return{entry,calls};
}
test('I actual optional claim recovery links existing evidence with a tenant-pinned note update and never a financial command',async()=>{
 const {entry,calls}=await claimRecoveryHost();await act(async()=>fireEvent.click(getByRole(entry.host,'button',{name:'تحقق واربط المطالبة فقط'})));assert.equal(calls.filter(x=>x[0]==='note').length,1);assert.equal(calls.find(x=>x[0]==='note')[1].expectedStoreId,'store');assert.match(getByRole(entry.host,'status').textContent,/دون أي حركة مالية جديدة/);
 const hidden=await claimRecoveryHost({role:'ECOMMERCE_ONLY'});assert.equal(hidden.entry.host.textContent,'');const legacy=await claimRecoveryHost({legacy:true});assert.equal(getByRole(legacy.entry.host,'button').disabled,true);
});
test('I actual optional recovery resolves lost committed note response using the same saved event without another note or transfer',async()=>{
 const {entry,calls}=await claimRecoveryHost({lost:true});await act(async()=>fireEvent.click(getByRole(entry.host,'button',{name:'تحقق واربط المطالبة فقط'})));assert.equal(getByLabelText(entry.host,'مرجع التسوية المحفوظ').disabled,true);await act(async()=>fireEvent.click(getByRole(entry.host,'button',{name:'تحقق من ربط المطالبة بنفس المرجع'})));assert.equal(calls.filter(x=>x[0]==='note').length,1);assert.match(getByRole(entry.host,'status').textContent,/اتربطت المطالبة بتحصيل محفوظ/);
});
test('I optional claim recovery retains uncertain identity on tenant change, permits a refused reference to be corrected, and reports proven note commitment honestly',async()=>{
 const changed=await claimRecoveryHost({changedTenant:true});await act(async()=>fireEvent.click(getByRole(changed.entry.host,'button',{name:'تحقق واربط المطالبة فقط'})));assert.equal(changed.calls.filter(x=>x[0]==='note').length,0);assert.match(getByRole(changed.entry.host,'status').textContent,/تغيّر المتجر/);
 const refused=await claimRecoveryHost({refused:true});await act(async()=>fireEvent.click(getByRole(refused.entry.host,'button',{name:'تحقق واربط المطالبة فقط'})));assert.equal(getByLabelText(refused.entry.host,'مرجع التسوية المحفوظ').disabled,false);
 const committed=await claimRecoveryHost({cacheFailure:true});await act(async()=>fireEvent.click(getByRole(committed.entry.host,'button',{name:'تحقق واربط المطالبة فقط'})));assert.match(getByRole(committed.entry.host,'status').textContent,/اتربطت المطالبة؛ تعذّر تحديث القائمة/);assert.equal(committed.calls.filter(x=>x[0]==='note').length,1);
});

function control(file,name){
 const source=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let result;
 function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.getText(source)===name)result=node.getText(source);
  if(ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(source)===name))result=node.getText(source);
  ts.forEachChild(node,visit)}visit(source);assert.ok(result,'Actual control '+name);return result;
}
function productSubmit({existing,variant=false,refuse=false}={}){
 const calls=[],form={name:'Synthetic',sku:'SYN',barcode:'',category:'QA',unitPrice:5,wholesalePrice:4,metadata:{variants:variant?[{name:'RED',stock:5},{name:'BLUE',stock:5}]:[]}};
 const ctx={exports:{},form,editingProduct:existing??null,openingQty:'4',openingCost:'2',validate:()=>true,
  gate:{enter:()=>true,exit:()=>calls.push(['release'])},setIsSubmitting:v=>calls.push(['busy',v]),
  saveCatalogProduct:async(fields,options)=>{calls.push(['catalog',fields,options]);if(refuse)throw Error('Synthetic refusal')},
  qtyOf:()=>10,refreshStock:()=>calls.push(['read']),clearDrafts:()=>calls.push(['clear']),setIsDialogOpen:v=>calls.push(['dialog',v]),toast:{error:v=>calls.push(['error',v])}};
 vm.runInNewContext(compile(control('src/components/products/ProductsPage.tsx','handleSubmit')+'\nexports.invoke=handleSubmit;'),ctx);
 return {invoke:()=>ctx.exports.invoke({preventDefault(){}}),calls};
}

function paymentControl({pending=null,missing=false,fail=false,amount=3}={}){
 const calls=[],o={id:'o',depositAmount:2,expectedCod:10};
 const ctx={exports:{},runOnce:fn=>fn(),resolvePendingOrderPayment:async()=>{calls.push(['resolve']);return pending},
  currentOrder:()=>{calls.push(['read']);return missing?undefined:o},payOrderId:'o',payValue:amount,payWallet:'vodafoneCash',
  commitOrderPayment:async(...args)=>{calls.push(['commit',...args]);if(fail)throw Error('SYNTHETIC_UNCERTAIN')},
  refreshWallets:()=>calls.push(['walletRead']),setPayOrderId:v=>calls.push(['close',v]),setActionError:v=>calls.push(['error',v]),setIsWorking:v=>calls.push(['busy',v])};
 vm.runInNewContext(compile(control('src/components/ecommerce/OrdersPage.tsx','confirmPayment')+'\nexports.invoke=confirmPayment;'),ctx);
 return {invoke:()=>ctx.exports.invoke(),calls};
}
test('H actual top-up callback uses one canonical boundary; pending recovery precedes stale/missing order checks',async()=>{
 const normal=paymentControl();await normal.invoke();assert.equal(normal.calls.filter(x=>x[0]==='commit').length,1);assert.equal(normal.calls.find(x=>x[0]==='commit')[3],'vodafoneCash');assert.ok(normal.calls.some(x=>x[0]==='close'));
 const replay=paymentControl({pending:{eventId:'prior'},missing:true,amount:999});await replay.invoke();assert.deepEqual(replay.calls.map(x=>x[0]),['resolve','walletRead','close']);
});
test('H actual top-up callback preserves uncertain dialog and refuses invalid draft before any financial call',async()=>{
 const failed=paymentControl({fail:true});await failed.invoke();assert.equal(failed.calls.filter(x=>x[0]==='close'||x[0]==='walletRead').length,0);assert.match(failed.calls.find(x=>x[0]==='error'&&x[1])[1],/نفس العملية دون تكرارها/);
 for(const amount of [0,-1,11]){const bad=paymentControl({amount});await bad.invoke();assert.equal(bad.calls.filter(x=>x[0]==='commit').length,0)}
});
test('catalog actual product control uses one atomic create/opening; selected variant edit retains exact revision',async()=>{
 const creating=productSubmit();await creating.invoke();const create=creating.calls.find(x=>x[0]==='catalog');assert.equal(create[2].quantity,4);assert.equal(create[2].unitCost,2);assert.equal(creating.calls.filter(x=>x[0]==='catalog').length,1);
 const existing={id:'p',updated_at:123};const editing=productSubmit({existing,variant:true});await editing.invoke();const edit=editing.calls.find(x=>x[0]==='catalog');assert.equal(edit[2].existing,existing);assert.equal(edit[2].quantity,10);assert.equal(edit[1].metadata.variants[0].stock,5);assert.ok(editing.calls.some(x=>x[0]==='clear'));
});
test('catalog actual product control retains draft on rejected/uncertain command; no success close or stock refresh',async()=>{
 const refused=productSubmit({refuse:true});await refused.invoke();assert.ok(refused.calls.some(x=>x[0]==='error'));assert.equal(refused.calls.filter(x=>['clear','dialog','read'].includes(x[0])).length,0);assert.ok(refused.calls.some(x=>x[0]==='release'));
});
test('catalog actual import control performs atomic matched adjustment and new opening, preserving prior successes on failure',async()=>{
 const calls=[],products=[{id:'existing',sku:'EX',barcode:'EX',name:'Existing',updated_at:1}],rows=[{sku:'EX',name:'Updated',stock_qty:12,purchase_price:2,retail_price:5},{sku:'NEW',name:'New',stock_qty:4,purchase_price:3,retail_price:6}];
 const ctx={exports:{},rows,products,rowErrors:new Map(),runOnce:fn=>fn(),autoSku:()=>{throw Error('Unexpected auto SKU')},findImportedProduct,openingBalanceOf,
  qtyOf:()=>9,resolvePendingCatalog:async()=>{},saveCatalogProduct:async(fields,opts)=>{calls.push(['catalog',fields,opts])},onImported:()=>calls.push(['read']),
  ...Object.fromEntries(['setStatus','setImportError','setImportCount','setOpenedCount','setOpenedUnits','setSkippedCount'].map(name=>[name,v=>calls.push([name,v])]))};
 vm.runInNewContext(compile(control('src/components/products/BulkImportProduct.tsx','handleImport')+'\nexports.invoke=handleImport;'),ctx);
 await ctx.exports.invoke();assert.deepEqual(calls.filter(x=>x[0]==='catalog').map(x=>x[2].quantity),[12,4]);assert.equal(calls.find(x=>x[0]==='setOpenedUnits')[1],7);assert.equal(calls.find(x=>x[0]==='setSkippedCount')[1],1);
 calls.length=0;ctx.saveCatalogProduct=async(fields,opts)=>{calls.push(['catalog',fields,opts]);if(fields.sku==='NEW')throw Error('Synthetic row failure')};await ctx.exports.invoke();
 assert.match(calls.find(x=>x[0]==='setImportError'&&x[1])[1],/Synthetic row failure/);assert.equal(calls.find(x=>x[0]==='setSkippedCount')[1],1);assert.equal(calls.find(x=>x[0]==='setOpenedUnits')[1],3);
});

test('ordinary return actual selection/quantity controls separate shades and exact discounted original-unit refunds',()=>{
 const order={id:'o',totalAmount:0.03,items:[{productId:'p',variantName:'RED',quantity:2,unitPrice:1},{productId:'p',variantName:'BLUE',quantity:1,unitPrice:1}],stockItems:[{productId:'p',variantName:'RED',quantity:2,unitPrice:1,unitCost:0.1},{productId:'p',variantName:'BLUE',quantity:1,unitPrice:1,unitCost:0.1}]};
 const returnRecords=[{id:'return:old',original_order_id:'o',returned_items:[{product_id:'p',variantName:'RED',quantity:1,lineId:'line:1',unitNumbers:[1]}]}];
 let entries;const ctx={exports:{},remainingUnits,returnableUnits,returnRecords,orders:[],setSelectedOrder:()=>{},setReturnEntries:value=>{entries=typeof value==='function'?value(entries):value}};
 vm.runInNewContext(compile(control('src/routes/returns.tsx','selectOrder')+'\n'+control('src/routes/returns.tsx','updateReturnQty')+'\nexports.select=selectOrder;exports.update=updateReturnQty;'),ctx);
 ctx.exports.select(order);assert.deepEqual(Array.from(entries,e=>e.ordered),[1,1]);assert.notEqual(entries[0].line_key,entries[1].line_key);
 ctx.exports.update(returnUnitKey('p','BLUE'),1);assert.deepEqual(Array.from(entries,e=>e.quantity),[0,1]);assert.equal(entries[1].product_id,'p');
 assert.equal(ordinaryReturnValue(order,[{productId:'p',variantName:'BLUE',quantity:1}],returnRecords),0.01);
 ctx.exports.update(returnUnitKey('p','RED'),99);assert.deepEqual(Array.from(entries,e=>e.quantity),[1,1]);
 assert.throws(()=>ordinaryReturnValue(order,[{productId:'p',variantName:'RED',quantity:1}],[{original_order_id:'o',returned_items:[{product_id:'p',quantity:1}]}]),/متغير المرتجع القديم/);
});

test('D2 actual POS print control shows server exchange legs, source and real signed cash; zero never claims a payment',()=>{
 const printed=[],ctx={exports:{},formatCurrency:n=>String(n),includedVat:()=>0,storeIdentity:()=>({vatRate:0}),WALLET_LABELS:{inStoreSafe:'خزينة المحل'},printTableAsPdf:v=>printed.push(v)};
 vm.runInNewContext(compile(control('src/components/sales/CheckoutForm.tsx','exchangeCashText')+'\n'+control('src/components/sales/CheckoutForm.tsx','printPosInvoice')+'\nexports.print=printPosInvoice;'),ctx);
 for(const replacement of [32000,27000,20000]){
  const net=replacement-27000;ctx.exports.print({lines:[{productName:'Source',quantity:-1,unitPrice:270},{productName:'Replacement',quantity:1,unitPrice:replacement/100}],total:net/100,paid:net/100,customer:'Synthetic',receiptId:'operation',documentNumber:'BS-P002',exchange:{sourceDocumentNumber:'BS-P001',replacementDocumentNumber:'BS-P002',sourceEventId:'original',refundPiastres:27000,replacementPiastres:replacement,netPiastres:net,wallet:'inStoreSafe'}});
  const receipt=printed.at(-1);assert.equal(receipt.title,'فاتورة استبدال');assert.match(receipt.footer,/الفاتورة الأصلية: BS-P001/);assert.match(receipt.subtitle,/BS-P002/);assert.doesNotMatch(receipt.subtitle+receipt.footer,/original|operation/);assert.match(receipt.footer,/قيمة المرتجع بعد الخصم: 270/);assert.match(receipt.footer,new RegExp('قيمة البديل بعد الخصم: '+replacement/100));
  assert.match(receipt.footer,net>0?/استلمنا من العميل: 50/:net<0?/رددنا للعميل: 70/:/فرق السعر صفر — دون حركة خزنة/);
  assert.doesNotMatch(receipt.footer,/المدفوع: -|فاتورة بيع/);assert.equal(receipt.footer.includes('الخزينة:'),net!==0);
 }
});

function creditPanel({pending,fail,cacheFail,order:inputOrder,readOnly=false}={}) {
 const calls=[];const order=inputOrder??{id:'credit-order',store_id:'credit-store',updated_at:1,totalAmount:300,depositAmount:100,expectedCod:235,revenueLogged:false,status:'pending',exchangeDetails:{credit:{version:1,eligiblePiastres:8500,allocatedPiastres:8500,excessPiastres:0,refundedAllocationPiastres:0,status:'applied',courierId:'courier'}}};
 const result={order:{...order,updated_at:2,expectedCod:255.01,exchangeDetails:{...order.exchangeDetails,credit:{...order.exchangeDetails.credit,allocatedPiastres:6499,refundedAllocationPiastres:2001}}}};
 const load=loader({'@/store/useOrderStore':{useOrderStore:{getState:()=>({orders:[]})}},'@/lib/financialCommand':{resolvePendingFinancialCommand:async scope=>{calls.push(['resolve',scope]);return pending?result:undefined;},runFinancialCommand:async(...args)=>{calls.push(['command',...args]);if(fail)throw new Error('uncertain');return result;}},'@/services/api/storeContext':{getSyncIdentity:async()=>({storeId:'credit-store'})},'@/services/api/fieldMapping':{fromRemoteRow:(_t,o)=>o},'@/hooks/useSubmitGate':{useRunOnce:()=>fn=>fn()},'@/lib/math':{formatMoney:n=>Number(n).toFixed(2)},'@/components/ui/button':{Button:props=>React.createElement('button',props)},'@/components/ui/input':{Input:props=>React.createElement('input',props)}});
 const Panel=load('src/components/ecommerce/ExchangeCreditPanel.tsx').ExchangeCreditPanel;
 return {calls,element:React.createElement(Panel,{order,readOnly,onSaved:async o=>{calls.push(['saved',o]);if(cacheFail)throw new Error('cache failed');}})};
}
test('H actual shared Desktop/Mobile credit panel shows gross credit, cash deposit and persisted235 independently',async()=>{
 const h=creditPanel();const {host}=await render(h.element);assert.match(host.textContent,/8500|85\.00/);assert.match(host.textContent,/عربون نقدي جديد: 100\.00/);assert.match(host.textContent,/المتبقي المسجل للبديل: 235\.00/);assert.equal(h.calls.length,0);
});
test('H actual shared refund control confirms the cash action and invokes one atomic contract with piastre baseline',async()=>{
 const h=creditPanel(),{host}=await render(h.element);await act(async()=>{fireEvent.change(getByLabelText(host,'مبلغ رد رصيد الاستبدال'),{target:{value:'20.01'}});fireEvent.click(getByRole(host,'checkbox'));});await act(async()=>fireEvent.click(getByRole(host,'button',{name:'تسجيل رد رصيد الاستبدال'})));
 const command=h.calls.find(x=>x[0]==='command');assert.equal(command[1],'exchange_credit_refund');assert.deepEqual(command[2],{orderId:'credit-order',amount:20.01,wallet:'inStoreSafe',expectedAllocatedPiastres:8500});assert.equal(command[3],'exchange_credit_refund:credit-order');assert.equal(command[4],'credit-store');assert.equal(h.calls.filter(x=>x[0]==='saved').length,1);
});
test('H shared recovery resolves original refund before edited draft and never creates money from a verify-only click',async()=>{
 const h=creditPanel({pending:true}),{host}=await render(h.element);await act(async()=>fireEvent.click(getByRole(host,'button',{name:'التحقق من رد رصيد سابق'})));assert.equal(h.calls.filter(x=>x[0]==='command').length,0);assert.equal(h.calls.filter(x=>x[0]==='saved').length,1);
 const clean=creditPanel(),second=await render(clean.element);await act(async()=>fireEvent.click(getByRole(second.host,'button',{name:'التحقق من رد رصيد سابق'})));assert.equal(clean.calls.filter(x=>x[0]==='command').length,0);assert.match(second.host.textContent,/لا توجد عملية رد غير محسومة/);
});
test('H proven refund with failed UI cache is stated as committed and never invites a new refund identity',async()=>{
 const h=creditPanel({pending:true,cacheFail:true}),{host}=await render(h.element);await act(async()=>fireEvent.click(getByRole(host,'button',{name:'التحقق من رد رصيد سابق'})));assert.match(host.textContent,/تم تسجيل رد الرصيد/);assert.equal(h.calls.filter(x=>x[0]==='command').length,0);
});
test('H read-only shared view exposes recoverable credit due without financial mutation controls',async()=>{
 const h=creditPanel({readOnly:true,order:{id:'o',depositAmount:100,expectedCod:235,revenueLogged:false,exchangeDetails:{credit:{version:1,eligiblePiastres:8500,allocatedPiastres:8500,excessPiastres:0,refundedAllocationPiastres:0,status:'refund_due'}}}}),{host}=await render(h.element);assert.match(host.textContent,/رصيد مستحق الرد للعميل/);assert.equal(host.querySelectorAll('button,input,select').length,0);
});
test('H actual courier reader never subtracts allocated85 twice; legacy documents retain historical separate refund semantics',()=>{
 const {courierSettlementAmounts}=loader()('src/lib/courierBatch.ts');const base={expectedCod:235,shippingFee:120,courierFee:120,exchangeDetails:{status:'confirmed',cause:'customer',refundPiastres:8500,refundVia:'courier',returnFee:0,credit:{version:1,allocatedPiastres:8500,excessPiastres:0,excessDisposition:'courier'}}};assert.deepEqual(courierSettlementAmounts(base),{cod:235,fee:120});assert.deepEqual(courierSettlementAmounts({...base,expectedCod:320,exchangeDetails:{...base.exchangeDetails,credit:undefined}}),{cod:235,fee:120});
 const {exchangeCreditDraft}=loader()('src/lib/exchangeCredit.ts');assert.deepEqual(exchangeCreditDraft(300,120,0,100,85),{allocatedPiastres:8500,excessPiastres:0,cod:235});assert.deepEqual(exchangeCreditDraft(50,0,0,0,85),{allocatedPiastres:5000,excessPiastres:3500,cod:0});
 const {fromRemoteRow}=loader()('src/services/api/fieldMapping.ts');const mapped=fromRemoteRow('orders',{...base,id:'o',store_id:'s'});assert.equal(mapped.expectedCod,235);assert.equal(mapped.exchangeDetails.credit.allocatedPiastres,8500);
});

test('H actual Mobile order screen reconciles cash100 + original credit85 + persisted COD235 against gross300 + shipping120',async()=>{
 const order={id:'mobile-h',orderNumber:'H-235',customerName:'Synthetic',customerPhone:'qa.invalid',status:'pending',createdAt:'2026-10-13T00:00:00Z',items:[{productId:'p',productName:'Replacement',quantity:1,unitPrice:300}],stockItems:[],totalAmount:300,discountAmount:0,shippingFee:120,depositAmount:100,depositWallet:'inStoreSafe',expectedCod:235,courierFee:120,exchangeDetails:{id:'exchange',status:'confirmed',credit:{version:1,allocatedPiastres:8500}}};
 const section=({children,titleAr})=>React.createElement('section',null,React.createElement('h3',null,titleAr),children);
 const load=loader({'react-router-dom':{useNavigate:()=>()=>{},useParams:()=>({orderId:order.id})},'@/mobile/data/mobileReaders':{readMobileOrder:async()=>order,readMobileOrderTimeline:async()=>[],readMobileCouriers:async()=>new Map()},'@/mobile/data/useMobileEntity':{useMobileEntity:()=>({data:order,loading:false,error:null,reload:()=>{}})},'@/mobile/data/useIsOffline':{useIsOffline:()=>false},'@/mobile/navigation/mobileVisibility':{useMobileVisibility:()=>({cost:true,internal:true})},'@/mobile/data/useStoreName':{useStoreName:()=> 'Synthetic'},'@/mobile/components/MobileAppBar':{MobileAppBar:()=>null},'@/mobile/components/MobileSection':{MobileSection:section},'@/mobile/components/StatusPill':{StatusPill:({labelAr})=>React.createElement('span',null,labelAr)},'@/mobile/components/WhatsAppAction':{WhatsAppIconLink:()=>null},'@/lib/whatsapp':{customerMessage:()=>''},'@/components/ecommerce/ExchangeReturnPanel':{ExchangeReturnPanel:()=>null},'@/components/shipping/CodServiceFeeEditor':{CodServiceFeeEditor:()=>null},'@/mobile/viewmodels/formatters':{formatArabicCount:n=>String(n),formatArabicCurrency:n=>Number(n).toFixed(2),formatArabicDate:()=>'',formatArabicRelativeTime:()=>''}});
 const {MobileOrderDetails}=load('src/mobile/screens/MobileOrderDetails.tsx');const {host}=await render(React.createElement(MobileOrderDetails));assert.match(host.textContent,/النقدي \+ رصيد الأصل \+ المتبقي420\.00/);assert.match(host.textContent,/✓ متطابق/);assert.doesNotMatch(host.textContent,/✗ اختلاف/);assert.match(host.textContent,/COD\)235\.00/);
});

test('H actual creation controls apply credit only in exchange mode and full prepaid collects net cash once',()=>{
 const {exchangeCreditDraft}=loader()('src/lib/exchangeCredit.ts');
 for(const exchange of [false,true])for(const payment of ['partial_cod','full_prepaid']){
  const context={exports:{},exchangeCreditDraft,useMemo:fn=>fn(),total_price:300,shipping_fee:120,wastedTripCompensation:0,returningValue:85,isExchange:exchange,paymentMethod:payment,deposit_amount:'100'};
  vm.runInNewContext(compile(control('src/routes/ecommerce-orders.tsx','depositVal')+'\n'+control('src/routes/ecommerce-orders.tsx','remaining_balance')+'\nexports.values={depositVal,remaining_balance};'),context);
  assert.equal(context.exports.values.depositVal,payment==='full_prepaid'?(exchange?335:420):100);assert.equal(context.exports.values.remaining_balance,payment==='full_prepaid'?0:(exchange?235:320));
 }
});
