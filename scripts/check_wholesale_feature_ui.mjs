import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsx from 'react/jsx-runtime';
import * as roles from '../src/lib/roles.ts';
import { create } from 'zustand';
import * as middleware from 'zustand/middleware';
import * as feature from '../src/lib/wholesaleFeature.ts';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
function load(file, mocks) {
  const source=ts.transpileModule(read(file),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};
  vm.runInNewContext(source,{exports:module.exports,module,require(id){if(id==='react')return React;if(id==='react/jsx-runtime')return jsx;if(id in mocks)return mocks[id];throw new Error('Unmocked dependency: '+id);}});
  return module.exports;
}
const Button=({children,onClick,...props})=>React.createElement('button',props,children);
test('actual settings persistence ignores a cached ON/status/store while restoring ordinary settings',()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{localStorage:{
    getItem:()=>JSON.stringify({state:{storeName:'Cached identity',wholesaleEnabled:true,wholesaleStatus:'ready',wholesaleStoreId:'old-store'},version:0}),
    setItem(){},removeItem(){},
  }}});
  try {
    const {useSettingsStore}=load('src/store/useSettingsStore.ts',{
      'zustand':{create},'zustand/middleware':middleware,
      '@/lib/supabase':{getSupabaseClient:()=>null},'@/services/api/storeContext':{getActiveStoreId:async()=>null},
      '@/lib/wholesaleFeature':feature,'@/lib/roles':roles,
      '@/store/useAuthStore':{useAuthStore:{subscribe(){},getState:()=>({isAuthenticated:true,userRole:'ADMIN'})}},
    });
    const state=useSettingsStore.getState();assert.equal(state.storeName,'Cached identity');
    assert.equal(state.wholesaleEnabled,false);assert.equal(state.wholesaleStatus,'idle');assert.equal(state.wholesaleStoreId,null);
    assert.equal(state.settingsStatus,'idle');
  } finally {if(previous)Object.defineProperty(globalThis,'window',previous);else delete globalThis.window;}
});
test('actual route renders no WholesalePage during idle/loading/error/OFF/saving and mounts only when ready ON',()=>{
  let enabled=false,status='idle',mounts=0;
  const {Wholesale}=load('src/routes/wholesale.tsx',{
    '@/components/wholesale/WholesalePage':{WholesalePage:()=>{mounts++;return React.createElement('span',null,'WHOLESALE_PAGE');}},
    '@/hooks/useWholesaleEnabled':{useWholesaleEnabled:()=>enabled},
    '@/store/useSettingsStore':{useSettingsStore:selector=>selector({wholesaleStatus:status,pullWholesaleFeature:()=>{}})},
    '@/components/ui/button':{Button},
  });
  for(status of ['idle','loading','failed','ready','saving']){
    const html=renderToStaticMarkup(React.createElement(Wholesale));assert.ok(!html.includes('WHOLESALE_PAGE'));assert.equal(mounts,0);
  }
  status='ready';enabled=true;assert.match(renderToStaticMarkup(React.createElement(Wholesale)),/WHOLESALE_PAGE/);assert.equal(mounts,1);
  enabled=false;renderToStaticMarkup(React.createElement(Wholesale));assert.equal(mounts,1);
});
test('actual settings row exposes required RTL copy, warning, accessible name and busy/error states',()=>{
  let state={wholesaleStatus:'ready',wholesaleError:null},enabled=false;
  const Switch=({checked,disabled,...props})=>React.createElement('button',{'role':'switch','aria-checked':checked,disabled,'aria-labelledby':props['aria-labelledby'],'aria-describedby':props['aria-describedby']});
  const {WholesaleFeatureSetting}=load('src/components/settings/WholesaleFeatureSetting.tsx',{
    '@/hooks/useWholesaleEnabled':{useWholesaleEnabled:()=>enabled},
    '@/store/useSettingsStore':{useSettingsStore:()=>({...state,pullWholesaleFeature:()=>{},saveWholesaleFeature:()=>Promise.resolve()})},
    '@/components/ui/switch':{Switch},'@/components/ui/button':{Button},
  });
  let html=renderToStaticMarkup(React.createElement(WholesaleFeatureSetting));
  for(const copy of ['مبيعات الجملة','التحكم في إظهار أو إخفاء قسم مبيعات الجملة من النظام.','إيقاف مبيعات الجملة','تنبيه: مبيعات الجملة قيد المراجعة الفنية،','ولا يُنصح باستخدامها في العمليات المالية','حتى اكتمال اختبارها واعتمادها.'])assert.ok(html.includes(copy));
  assert.match(html,/dir="rtl"/);assert.match(html,/aria-labelledby="wholesale-setting-title"/);
  enabled=true;assert.match(renderToStaticMarkup(React.createElement(WholesaleFeatureSetting)),/تفعيل مبيعات الجملة/);
  for(const status of ['idle','loading','saving','failed']){state={wholesaleStatus:status,wholesaleError:status==='failed'?'error':null};html=renderToStaticMarkup(React.createElement(WholesaleFeatureSetting));assert.match(html,/disabled=""/);if(status==='failed'){assert.match(html,/role="alert"/);assert.match(html,/إعادة المحاولة/);}}
});
test('actual desktop/drawer navigation removes only wholesale while OFF and retains the existing role map ON',()=>{
  const source=read('src/components/dashboard/Sidebar.tsx');
  const ast=ts.createSourceFile('Sidebar.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const nodes=ast.statements.filter(n=>(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)==='allNavItems'))||(ts.isFunctionDeclaration(n)&&n.name?.text==='useNavItems'));
  assert.equal(nodes.length,2);
  const extracted=nodes.map(n=>n.getText(ast)).join('\n');
  const code=ts.transpileModule(extracted,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  let enabled=false,role='ADMIN';
  const context={exports:{},...roles,useAuthStore:()=>({userRole:role,activeBusinessProfile:'omnichannel'}),useFeatureStore:()=>({returnsEnabled:true,ecommerceSyncEnabled:true}),useWholesaleEnabled:()=>enabled};
  // Navigation icons are presentation only; all filtering executes unchanged.
  for(const match of extracted.matchAll(/icon: (\w+)/g))context[match[1]]=()=>null;
  vm.runInNewContext(code,context);const items=()=>Array.from(context.exports.useNavItems(),item=>item.path);
  const off=items();assert.ok(!off.includes('/wholesale'));enabled=true;const on=items();assert.ok(on.includes('/wholesale'));assert.deepEqual(on.filter(p=>p!=='/wholesale'),off);
  for(role of ['ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY','MODERATOR'])assert.ok(!items().includes('/wholesale'));
});
