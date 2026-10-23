// Actual auth store/reconciler/React gates; synthetic SDK boundaries only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {uiHarness} from './helpers/ui-harness.mjs';
import {APP_ROLES,toAppRole,canAccess,canViewStoreFinance,canViewCost,readsDesktopBusinessData} from '../src/lib/roles.ts';
const uid='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',store='20000000-0000-4000-8000-000000000001';
function fixture({role='CASHIER_ONLY',memberError=null,throwMember=false,systemOwner=false,missingMember=false}={}){
 let currentUid=uid,answer=missingMember?null:{role,store_id:store},callback,claims=0,queryOverride;
 const session=()=>({access_token:'synthetic-local-session',user:{id:currentUid,email:'employee@qa.invalid'},expires_at:2000000000});
 const auth={isAuthenticated:true,permissionsVerified:true,isSystemOwner:false,userRole:'ADMIN',session:{user:{id:uid,role:'ADMIN'}},beginVerification(){this.permissionsVerified=false;this.userRole='UNVERIFIED';this.isSystemOwner=false;},setSystemOwner(v){this.isSystemOwner=v;},setBusinessType(v){this.businessType=v;},setOperationMode(v){this.operationMode=v;},setBusinessProfile(v){this.activeBusinessProfile=v;},logout(){this.isAuthenticated=false;this.permissionsVerified=false;this.userRole='UNVERIFIED';this.session=null;},setSession(s){this.session=s;this.userRole=s.user.role;this.isAuthenticated=true;this.permissionsVerified=true;}};
 const sb={auth:{getSession:async()=>({data:{session:session()},error:null}),onAuthStateChange(fn){callback=fn;return {data:{subscription:{unsubscribe(){callback=undefined;}}}};}},rpc:async(name)=>{if(name==='claim_store'){claims++;return {data:null,error:null};}return {data:systemOwner,error:null};},from(table){assert.equal(table,'store_members');let selectedUid;return {select(){return this;},eq(key,value){assert.equal(key,'user_id');selectedUid=value;return this;},async maybeSingle(){if(queryOverride)return queryOverride(selectedUid);if(throwMember)throw Error('Synthetic transport failure');return {data:memberError?null:answer,error:memberError};}};},channel(){return {on(){return this;},subscribe(){return this;}};},removeChannel:async()=>{}};
 const h=uiHarness({'@/lib/supabase':{getSupabaseClient:()=>sb,isCloudSyncMode:()=>true,getOperationMode:()=> 'online_cloud'},'@/store/useAuthStore':{useAuthStore:Object.assign(selector=>selector(auth),{getState:()=>auth})},'@/store/useBusinessStore':{useBusinessStore:{getState:()=>({setBusinessMode(){}})}},'@/services/api/storeContext':{clearStoreIdCache(){},primeActiveStoreId(id){if(id!=null)assert.equal(id,store);}}});
 return {h,auth,sb,run:options=>h.load('src/lib/auth/useSessionReconciliation.ts').reconcileSupabaseSession(options),setUid(v){currentUid=v;},setRole(v){answer={role:v,store_id:store};},setQuery(fn){queryOverride=fn;},get callback(){return callback;},get claims(){return claims;}};
}
test('unverified/unknown roles never become Online Only or acquire operational/financial access',()=>{
 assert.equal(APP_ROLES.length,6);assert.ok(!APP_ROLES.includes('UNVERIFIED'));
 for(const role of [null,undefined,'','UNVERIFIED','unknown-role']){assert.equal(toAppRole(role),'UNVERIFIED');for(const path of ['/pos','/orders','/ecommerce-orders','/inventory','/partners','/users','/'])assert.equal(canAccess(role,path),false);assert.equal(canViewStoreFinance(role),false);assert.equal(canViewCost(role),false);assert.equal(readsDesktopBusinessData(role),false);}
 assert.equal(toAppRole('cashier'),'POS_ECOMMERCE');assert.equal(toAppRole('CASHIER_ONLY'),'CASHIER_ONLY');
});
for(const role of ['CASHIER_ONLY','ECOMMERCE_ONLY','POS_ECOMMERCE','ADMIN','ACCOUNTANT'])test('actual reconciler restores only the verified '+role+' membership',async()=>{
 const f=fixture({role});try{assert.equal(await f.run(),'authenticated');assert.equal(f.auth.userRole,role);assert.equal(f.auth.permissionsVerified,true);assert.equal(f.auth.session.user.id,uid);assert.equal(canAccess(f.auth.userRole,'/pos'),['CASHIER_ONLY','POS_ECOMMERCE','ADMIN'].includes(role));}finally{await f.h.cleanup();}
});
for(const input of [{memberError:{message:'Synthetic network error'}},{throwMember:true},{role:'unexpected-role'}])test('membership failure/unknown value with cached ADMIN cannot grant any broader role: '+JSON.stringify(input),async()=>{
 const f=fixture(input);try{assert.equal(await f.run(),'unavailable');assert.equal(f.auth.permissionsVerified,false);assert.equal(f.auth.userRole,'UNVERIFIED');assert.equal(canAccess(f.auth.userRole,'/orders'),false);assert.equal(canViewStoreFinance(f.auth.userRole),false);}finally{await f.h.cleanup();}
});
test('late previous-account membership cannot overwrite a newer verified Cashier Only session',async()=>{
 const f=fixture();let release,entered;const started=new Promise(r=>entered=r);f.setQuery(async id=>{if(id===uid){entered();return new Promise(r=>release=r);}return {data:{role:'CASHIER_ONLY',store_id:store},error:null};});
 try{const first=f.run();await started;f.setUid(other);assert.equal(await f.run(),'authenticated');release({data:{role:'ADMIN',store_id:store},error:null});await first;assert.equal(f.auth.userRole,'CASHIER_ONLY');assert.equal(f.auth.session.user.id,other);assert.equal(canAccess(f.auth.userRole,'/orders'),false);}finally{await f.h.cleanup();}
});
test('auth event alone suspends cached ADMIN until server membership resolves outside the callback',async()=>{
 const f=fixture();try{const {useSessionReconciliation}=f.h.load('src/lib/auth/useSessionReconciliation.ts');await f.h.render(()=>f.h.React.createElement('output',null,useSessionReconciliation()));assert.equal(f.auth.userRole,'CASHIER_ONLY');assert.ok(f.callback);
 let release;f.setUid(other);f.setQuery(()=>new Promise(r=>release=r));await f.h.perform(()=>f.callback('SIGNED_IN',{user:{id:other,app_metadata:{role:'ADMIN'}}}));assert.equal(f.auth.permissionsVerified,false);assert.equal(f.auth.userRole,'UNVERIFIED');assert.match(document.body.textContent,/checking/);
 await f.h.perform(async()=>{await new Promise(r=>setTimeout(r,5));release({data:{role:'CASHIER_ONLY',store_id:store},error:null});await new Promise(r=>setTimeout(r,5));});assert.equal(f.auth.userRole,'CASHIER_ONLY');assert.match(document.body.textContent,/authenticated/);
 }finally{await f.h.cleanup();}
});
test('real persisted auth mirror discards old ADMIN/session flags on every boot and clears authority on logout',async()=>{
 const h=uiHarness({'@/lib/supabase':{getOperationMode:()=> 'online_cloud'}});Object.defineProperty(globalThis,'localStorage',{value:window.localStorage,configurable:true});
 window.localStorage.setItem('auth-storage-v2',JSON.stringify({state:{userRole:'ADMIN',isAuthenticated:true,permissionsVerified:true,isSystemOwner:true,session:{user:{id:uid,role:'ADMIN'}},sessionToken:'synthetic-old-session'},version:0}));
 try{const {useAuthStore}=h.load('src/store/useAuthStore.ts');assert.equal(useAuthStore.getState().userRole,'UNVERIFIED');assert.equal(useAuthStore.getState().permissionsVerified,false);assert.equal(useAuthStore.getState().isAuthenticated,false);assert.equal(useAuthStore.getState().session,null);useAuthStore.getState().setSession({token:'synthetic-current',user:{id:uid,role:'CASHIER_ONLY',username:'employee@qa.invalid'}});assert.equal(useAuthStore.getState().permissionsVerified,true);const saved=JSON.parse(window.localStorage.getItem('auth-storage-v2')).state;for(const k of ['userRole','session','sessionToken','isAuthenticated','permissionsVerified','isSystemOwner'])assert.equal(Object.hasOwn(saved,k),false,k);useAuthStore.getState().logout();assert.equal(useAuthStore.getState().userRole,'UNVERIFIED');assert.equal(useAuthStore.getState().permissionsVerified,false);}finally{await h.cleanup();delete globalThis.localStorage;}
});
for(const mobile of [false,true])test((mobile?'Mobile':'Desktop')+' actual route gate refuses an authenticated but unverified mirror',async()=>{
 const f=fixture();f.auth.isAuthenticated=true;f.auth.permissionsVerified=false;
 const h=uiHarness({'@/store/useAuthStore':{useAuthStore:selector=>selector(f.auth)},'@/store/useStoreLicense':{useStoreLicense:()=>({resolved:true,decision:{verdict:'active'},hydrate(){},refresh:async()=>{}})}});
 try{const {MemoryRouter,Routes,Route}=await import('react-router-dom');const Gate=h.load(mobile?'src/mobile/shell/MobileSessionGate.tsx':'src/components/auth/ProtectedRoute.tsx')[mobile?'MobileSessionGate':'ProtectedRoute'];await h.render(()=>h.React.createElement(MemoryRouter,null,h.React.createElement(Routes,null,h.React.createElement(Route,{element:h.React.createElement(Gate,{sessionState:'authenticated'})},h.React.createElement(Route,{path:'/',element:h.React.createElement('p',null,'FORBIDDEN_OPERATIONAL_CONTENT')})))));assert.doesNotMatch(document.body.textContent,/FORBIDDEN_OPERATIONAL_CONTENT/);assert.match(document.body.textContent,/جارٍ التحقق/);}finally{await h.cleanup();await f.h.cleanup();}
});
test('verified store-less System Owner keeps global identity with zero store business permissions',async()=>{
 const f=fixture({systemOwner:true,missingMember:true});try{assert.equal(await f.run(),'authenticated');assert.equal(f.auth.isSystemOwner,true);assert.equal(f.auth.userRole,'UNVERIFIED');assert.equal(canAccess(f.auth.userRole,'/pos'),false);assert.equal(canViewStoreFinance(f.auth.userRole),false);}finally{await f.h.cleanup();}
});
test('actual login workflow does not claim a new tenant after a failed membership read',async()=>{
 const f=fixture({memberError:{message:'Synthetic transport error'}});try{const {establishSupabaseSession}=f.h.load('src/lib/auth/sessionWorkflow.ts');const r=await establishSupabaseSession({accessToken:'synthetic-only',userId:uid,username:'employee@qa.invalid',businessProfile:'omnichannel',missingMembership:'claim',hydrateCloudData:false});assert.equal(r.success,false);assert.equal(f.claims,0);assert.equal(f.auth.permissionsVerified,false);assert.equal(f.auth.userRole,'UNVERIFIED');}finally{await f.h.cleanup();}
});
test('clearing store identity invalidates late old-account resolution rather than overwriting the new store cache',async()=>{
 let release,entered;const started=new Promise(r=>entered=r);const h=uiHarness({'@/lib/supabase':{getSupabaseClient:()=>({auth:{getUser:async()=>({data:{user:{id:uid}}})},from(){return {select(){return this;},eq(){return this;},maybeSingle(){entered();return new Promise(r=>release=r);}};}})}});
 try{const context=h.load('src/services/api/storeContext.ts'),pending=context.getSyncIdentity();await started;context.clearStoreIdCache();const nextStore='20000000-0000-4000-8000-000000000002';context.primeActiveStoreId(nextStore);release({data:{store_id:store},error:null});assert.equal(await pending,null);assert.equal(await context.getActiveStoreId(),nextStore);}finally{await h.cleanup();}
});
for(const role of ['CASHIER_ONLY','ECOMMERCE_ONLY','POS_ECOMMERCE','ADMIN'])test('actual password-session establishment and refresh share one authoritative '+role+' resolver',async()=>{
 const f=fixture({role});try{const {establishSupabaseSession}=f.h.load('src/lib/auth/sessionWorkflow.ts');const r=await establishSupabaseSession({accessToken:'synthetic-only',userId:uid,username:'employee@qa.invalid',businessProfile:'omnichannel',missingMembership:'reject',hydrateCloudData:false});assert.deepEqual(r,{success:true,role});assert.equal(f.auth.userRole,role);assert.equal(f.auth.permissionsVerified,true);assert.equal(f.claims,0);assert.equal(f.auth.activeBusinessProfile,'omnichannel');}finally{await f.h.cleanup();}
});
test('routine proof renewal preserves an already verified Cashier cart, but failure suspends its access',async()=>{
 const f=fixture();try{await f.run();let release,entered;const started=new Promise(r=>entered=r);f.setQuery(()=>{entered();return new Promise(r=>release=r);});const pending=f.run({background:true});await started;assert.equal(f.auth.userRole,'CASHIER_ONLY');assert.equal(f.auth.permissionsVerified,true);release({data:null,error:{message:'Synthetic background transport error'}});assert.equal(await pending,'unavailable');assert.equal(f.auth.permissionsVerified,false);assert.equal(f.auth.userRole,'UNVERIFIED');assert.equal(canAccess(f.auth.userRole,'/orders'),false);}finally{await f.h.cleanup();}
});

test('focus, same-account SIGNED_IN and TOKEN_REFRESHED renew without destroying a selected file; sign-out still fails closed',async()=>{
 const f=fixture({role:'ADMIN'});try{
  const {useSessionReconciliation}=f.h.load('src/lib/auth/useSessionReconciliation.ts');
  let mounts=0;
  function Draft(){f.h.React.useEffect(()=>{mounts++;},[]);return f.h.React.createElement('input',{type:'file','aria-label':'preserved-file'});}
  function Shell(){const state=useSessionReconciliation();return state==='authenticated'?f.h.React.createElement(Draft):f.h.React.createElement('output',null,state);}
  await f.h.render(Shell);const original=document.querySelector('input');assert.ok(original);assert.equal(mounts,1);
  for(const action of [()=>window.dispatchEvent(new window.Event('focus')),()=>f.callback('SIGNED_IN',{user:{id:uid}}),()=>f.callback('TOKEN_REFRESHED',{user:{id:uid}})]){
   await f.h.perform(async()=>{action();await new Promise(r=>setTimeout(r,15));});
   assert.equal(document.querySelector('input'),original);assert.equal(mounts,1);assert.equal(f.auth.permissionsVerified,true);
  }
  await f.h.perform(()=>f.callback('SIGNED_OUT',null));assert.equal(document.querySelector('input'),null);assert.equal(f.auth.permissionsVerified,false);
 }finally{await f.h.cleanup();}
});

test('same-identity background renewal failure blocks access; recovery revalidates role instead of falling back',async()=>{
 const f=fixture({role:'CASHIER_ONLY'});try{
  const {useSessionReconciliation}=f.h.load('src/lib/auth/useSessionReconciliation.ts');
  await f.h.render(()=>f.h.React.createElement('output',null,useSessionReconciliation()));
  f.setQuery(async()=>({data:null,error:{message:'synthetic network failure'}}));
  await f.h.perform(async()=>{window.dispatchEvent(new window.Event('focus'));await new Promise(r=>setTimeout(r,10));});
  assert.equal(f.auth.permissionsVerified,false);assert.equal(f.auth.userRole,'UNVERIFIED');assert.match(document.body.textContent,/unavailable/);
  f.setQuery(async()=>({data:{role:'CASHIER_ONLY',store_id:store},error:null}));
  await f.h.perform(async()=>{window.dispatchEvent(new window.Event('focus'));await new Promise(r=>setTimeout(r,10));});
  assert.equal(f.auth.userRole,'CASHIER_ONLY');assert.match(document.body.textContent,/authenticated/);
 }finally{await f.h.cleanup();}
});
