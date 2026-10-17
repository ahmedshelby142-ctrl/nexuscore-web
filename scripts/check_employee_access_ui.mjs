// Actual React components/hooks, synthetic identities/services only. No network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {uiHarness} from './helpers/ui-harness.mjs';
import {canAccess,canViewStoreFinance,homeFor,toAppRole} from '../src/lib/roles.ts';
const require=createRequire(import.meta.url);
test('three presets share the canonical role/route model, with no legacy grants or finance/admin widening',()=>{
 assert.equal(homeFor('CASHIER_ONLY'),'/pos');assert.equal(toAppRole('cashier'),'POS_ECOMMERCE');
 for(const path of ['/pos','/pos/receipt'])assert.equal(canAccess('CASHIER_ONLY',path),true);
 for(const path of ['/orders','/ecommerce-orders','/crm','/inventory','/purchasing','/partners','/users','/courier-ledger','/settings','/'])assert.equal(canAccess('CASHIER_ONLY',path),false,path);
 assert.equal(canAccess('ECOMMERCE_ONLY','/orders'),true);assert.equal(canAccess('ECOMMERCE_ONLY','/pos'),false);
 for(const path of ['/pos','/orders'])assert.equal(canAccess('POS_ECOMMERCE',path),true);
 for(const role of ['CASHIER_ONLY','POS_ECOMMERCE','ECOMMERCE_ONLY','MODERATOR'])assert.equal(canViewStoreFinance(role),false);
 for(const role of ['ADMIN','ACCOUNTANT'])assert.equal(canViewStoreFinance(role),true);
});
test('actual ADMIN invite/edit form displays and preserves all three selected presets; failed save keeps dialog open',async()=>{
 const invitations=[],saved=[],staff={id:'staff',userId:'staff',name:'Synthetic staff',email:'staff@qa.invalid',role:'ECOMMERCE_ONLY',status:'ACTIVE'};let saveOk=false;
 const state={staffMembers:[staff],isLoading:false,error:null,fetchStaffMembers:async()=>{},inviteStaff:async(email,role)=>{invitations.push({email,role});return{ok:true,message:'Synthetic local invite'};},updateUserRole:async(id,role)=>{saved.push({id,role});return saveOk;},removeUser:async()=>{throw Error('Unexpected removal');}};
 const h=uiHarness({'@/store/useUsersStore':{useUsersStore:()=>state},sonner:{toast:{success:()=>{}}}});
 try{
 HTMLElement.prototype.scrollIntoView=()=>{};HTMLElement.prototype.hasPointerCapture=()=>false;HTMLElement.prototype.setPointerCapture=()=>{};HTMLElement.prototype.releasePointerCapture=()=>{};
 const {UserManagementPanel}=h.load('src/components/auth/UserManagementPanel.tsx'),user=await h.render(UserManagementPanel);
 for(const label of ['كاشير فقط','أونلاين فقط','كاشير وأونلاين'])assert.match(document.body.textContent,new RegExp(label));
 await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'إضافة موظف',exact:true})));
 await h.perform(()=>user.type(h.getByLabelText(document.body,'البريد الإلكتروني'),'STAFF@qa.invalid'));
 await h.perform(()=>user.click(h.getByRole(document.body,'combobox')));
 for(const label of ['كاشير فقط','أونلاين فقط','كاشير وأونلاين'])assert.ok(h.getByRole(document.body,'option',{name:label,exact:true}));
 await h.perform(()=>user.click(h.getByRole(document.body,'option',{name:'كاشير فقط',exact:true})));
 assert.match(h.getByRole(document.body,'dialog').textContent,/بدون أرصدة الخزائن/);
 await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'إرسال الدعوة'})));assert.deepEqual(invitations,[{email:'staff@qa.invalid',role:'CASHIER_ONLY'}]);
 await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'تعديل صلاحية المستخدم'})));
 assert.match(h.getByRole(document.body,'combobox').textContent,/أونلاين فقط/);
 await h.perform(()=>user.click(h.getByRole(document.body,'combobox')));await h.perform(()=>user.click(h.getByRole(document.body,'option',{name:'كاشير وأونلاين',exact:true})));
 await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'حفظ الصلاحية'})));assert.ok(h.getByRole(document.body,'dialog'));assert.deepEqual(saved,[{id:'staff',role:'POS_ECOMMERCE'}]);
 saveOk=true;await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'حفظ الصلاحية'})));assert.equal(h.queryByRole(document.body,'dialog'),null);
 }finally{await h.cleanup();}
});
for(const role of ['CASHIER_ONLY','POS_ECOMMERCE','ECOMMERCE_ONLY','ADMIN','ACCOUNTANT'])test(role+' actual POS payment selector hides unauthorized balances without disabling wallet choice',async()=>{
 let currentRole=role;const reads=[],state={get userRole(){return currentRole;}};
 const auth=Object.assign(selector=>selector(state),{getState:()=>state});
 const h=uiHarness({'@/store/useAuthStore':{useAuthStore:auth},'./index':{balances:async query=>{reads.push(query);return[{subjectId:'vodafoneCash',amount:99630,qty:0}]}}});
 // The hook imports ./index, not an application ledger replacement.
 const file=fs.readFileSync('src/components/sales/CheckoutForm.tsx','utf8'),tree=ts.createSourceFile('checkout.tsx',file,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let select;
 function walk(n){if(ts.isJsxElement(n)&&n.openingElement.tagName.getText(tree)==='select'&&n.getText(tree).includes('showWalletBalances'))select=n.getText(tree);ts.forEachChild(n,walk);}walk(tree);assert.ok(select);
 try{
 const {useBalances}=h.load('src/lib/ledger/useBalances.ts');
 const {WALLET_LABELS}=h.load('src/types/index.ts'),ctx={exports:{},require,React:h.React,useBalances,WALLET_LABELS,canViewStoreFinance,readRole:()=>currentRole,moneyFigure:value=>String(value)};
 const jsx=`exports.View=function(){const [selectedWallet,setSelectedWallet]=React.useState('inStoreSafe'),[revision,setRevision]=React.useState(0);const wallets=useBalances('wallet'),walletBalance=wallets.amountOf,showWalletBalances=canViewStoreFinance(readRole());return <div>${select}<button onClick={()=>setRevision(revision+1)}>Refresh role</button></div>}`;
 vm.runInNewContext(ts.transpileModule(jsx,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 const user=await h.render(ctx.exports.View),picker=h.getByRole(document.body,'combobox',{name:'الخزينة المستهدفة'});
 if(canViewStoreFinance(role)){assert.match(picker.textContent,/99630/);assert.equal(reads.length,1);currentRole='CASHIER_ONLY';await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'Refresh role'})));assert.doesNotMatch(picker.textContent,/99630/);assert.equal(reads.length,1);}
 else {assert.equal(reads.length,0);assert.doesNotMatch(picker.textContent,/99630|\d/);}
 await h.perform(()=>user.selectOptions(picker,'vodafoneCash'));assert.equal(picker.value,'vodafoneCash');assert.match(picker.textContent,/فودافون كاش/);assert.match(picker.textContent,/حساب بنكي/);
 }finally{await h.cleanup();}
});
for(const date of [undefined,null,'','2026-08-01'])test('actual CRM caption retains matching/picking and LTV, date '+String(date),async()=>{
 const h=uiHarness({}),customer={id:'synthetic',name:'عميل تجريبي',phone:'01000000008',lastOrderAt:date},picked=[];
 try{const {CustomerPhoneMatch}=h.load('src/components/ecommerce/CustomerPhoneMatch.tsx'),user=await h.render(()=>h.React.createElement(CustomerPhoneMatch,{customers:[customer],phone:customer.phone,linkedId:'',ltvOf:()=>10,onPick:c=>picked.push(c.id),onUnlink:()=>{}}));assert.equal(picked.length,0);assert.doesNotMatch(document.body.textContent,/لسه مافيش طلبات/);assert.match(document.body.textContent,date?/آخر طلب:/:/تاريخ آخر طلب غير متاح/);await h.perform(()=>user.click(h.getByRole(document.body,'button',{name:'ده هو'})));assert.deepEqual(picked,['synthetic']);}finally{await h.cleanup();}
});
test('Mobile guards keep Cashier Only away from orders, owner finance and restock; other operational presets remain',()=>{
 const h=uiHarness({});try{const {getMobileCapabilities}=h.load('src/mobile/navigation/mobileCapabilities.ts');assert.deepEqual([...getMobileCapabilities('CASHIER_ONLY')],['home','more','preferences']);for(const role of ['POS_ECOMMERCE','ECOMMERCE_ONLY']){const c=getMobileCapabilities(role);assert.ok(c.has('orders')&&c.has('shipments'));assert.equal(c.has('owner'),false);assert.equal(c.has('purchasing'),false);}assert.ok(getMobileCapabilities('ADMIN').has('owner'));assert.ok(getMobileCapabilities('MODERATOR').has('orders'));}finally{h.cleanup();}
});
test('shared real session hook re-resolves only its authenticated membership after a realtime role change and cleans up',async()=>{
 const uid='10000000-0000-4000-8000-000000000001',storeId='20000000-0000-4000-8000-000000000001';let memberRole='POS_ECOMMERCE',changed=0,removed=0,callback;
 const auth={isAuthenticated:true,permissionsVerified:true,isSystemOwner:false,userRole:'POS_ECOMMERCE',beginVerification(){this.userRole='UNVERIFIED';this.permissionsVerified=false;this.isSystemOwner=false;},setSystemOwner(v){this.isSystemOwner=v;},logout(){this.isAuthenticated=false;this.permissionsVerified=false;},setSession(s){this.userRole=s.user.role;this.isAuthenticated=true;this.permissionsVerified=true;}};
 const session={access_token:'synthetic-local-only',user:{id:uid,email:'staff@qa.invalid'},expires_at:2000000000};
 const sb={auth:{getSession:async()=>({data:{session}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},rpc:async()=>({data:false,error:null}),from(table){assert.equal(table,'store_members');return {select(){return this;},eq(key,value){assert.equal(key,'user_id');assert.equal(value,uid);return this;},maybeSingle:async()=>({data:{role:memberRole,store_id:storeId},error:null})};},channel(name){assert.match(name,new RegExp(uid));const ch={on(type,filter,fn){assert.equal(type,'postgres_changes');assert.equal(filter.filter,'user_id=eq.'+uid);callback=fn;return this;},subscribe(){return this;}};return ch;},removeChannel(){removed++;return Promise.resolve();}};
 const h=uiHarness({'@/lib/supabase':{getSupabaseClient:()=>sb,isCloudSyncMode:()=>true},'@/store/useAuthStore':{useAuthStore:{getState:()=>auth}},'@/services/api/storeContext':{clearStoreIdCache(){},primeActiveStoreId:id=>assert.equal(id,storeId)}});
 try{window.addEventListener('nexus-membership-changed',()=>changed++);const {useSessionReconciliation}=h.load('src/lib/auth/useSessionReconciliation.ts');await h.render(()=>h.React.createElement('output',null,useSessionReconciliation()));assert.ok(callback);assert.equal(auth.userRole,'POS_ECOMMERCE');
 memberRole='CASHIER_ONLY';await h.perform(async()=>{callback();await new Promise(resolve=>setTimeout(resolve,10));});assert.equal(auth.userRole,'CASHIER_ONLY');assert.equal(changed,1);
 }finally{await h.cleanup();}assert.equal(removed,1);
});
test('actual Cashier receipt keeps its payment delta and printing but hides finance-only cost/profit display',async()=>{
 const h=uiHarness({'@/store/useAuthStore':{useAuthStore:selector=>selector({userRole:'CASHIER_ONLY'})},'@/services/posReceipts':{readPosReceipt:async()=>({kind:'sale',number:'QA-P001',customer:'Synthetic',items:[],refundPiastres:0,replacementPiastres:1000,netPiastres:1000,cogsPiastres:200,profitPiastres:800,wallets:[{id:'inStoreSafe',piastres:1000}]})},'@/lib/pdfGenerator':{printTableAsPdf:()=>{}}});
 try{await h.render(()=>h.React.createElement(h.load('src/components/sales/PosReceiptDetails.tsx').PosReceiptDetails,{eventId:'synthetic'}));const receipt=h.getByRole(document.body,'region',{name:'الإيصال المحفوظ'});assert.match(receipt.textContent,/QA-P001/);assert.match(receipt.textContent,/خزينة المحل/);assert.doesNotMatch(receipt.textContent,/COGS|أثر الربح|أثر التكلفة/);assert.ok(h.getByRole(document.body,'button',{name:'طباعة الإيصال المحفوظ'}));}finally{await h.cleanup();}
});
