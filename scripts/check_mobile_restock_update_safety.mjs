import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createUpdateLifecycle, unsafeReloadReason } from "../src/mobile/pwa/updateLifecycle.ts";

// Execute the real screen and its event handlers. Only hooks, presentation
// components, and I/O are replaced; no draft/reset/submit logic is copied.
const source = readFileSync(new URL("../src/mobile/screens/MobileQuickRestock.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = (body) => `data:text/javascript,${encodeURIComponent(body)}`;
const mocks = {
  react: `export const useState = v => globalThis.__restock.useState(v);
    export const useEffect = () => {};
    export const useCallback = f => f;
    export const useMemo = f => f();`,
  "react/jsx-runtime": `export const jsx = (type, props) => ({type, props}); export const jsxs = jsx; export const Fragment = 'fragment';`,
  "react-router-dom": `export const useNavigate = () => n => globalThis.__restock.navigations.push(n);
    export const useSearchParams = () => [new URLSearchParams()];`,
  sonner: `export const toast = {success:()=>{}, error:()=>{}};`,
  "@/hooks/useSubmitGate": `export const useSubmitGate = () => globalThis.__restock.gate;`,
  "@/lib/receiving": `export const NEW_SUPPLIER = '__new__';
    export const readSuppliers = async () => [];
    export const formatQuickRestockSuccess = () => 'ok';
    export const executeQuickRestock = args => globalThis.__restock.submit(args);`,
  "@/mobile/data/useMobilePagedQuery": `export const useMobilePagedQuery = () => ({rows:[{id:'product', name:'Fixture', metadata:{variants:[{name:'blue'}]}}], loading:false});`,
  "@/mobile/data/useIsOffline": `export const useIsOffline = () => false;`,
  "@/mobile/data/useStoreName": `export const useStoreName = () => 'Fixture store';`,
  "@/mobile/viewmodels/formatters": `export const formatArabicCurrency = v => String(v);`,
  "@/lib/whatsapp": `export const parseRestockNeed = () => new Map(); export const restockRequestMessage = () => '';`,
  "@/types": `export const WALLET_LABELS = {inStoreSafe:'Safe', bank:'Bank'};`,
};
const executable = compiled.replace(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)";/g, (_, names, specifier) => {
  const stub = mocks[specifier] ?? names.split(",").filter(name => name.trim()).map(name => {
    const original = name.trim().split(/\s+as\s+/)[0];
    return `export const ${original} = '${original}';`;
  }).join("\n");
  return `import {${names}} from ${JSON.stringify(moduleUrl(stub))};`;
});
const { MobileQuickRestock } = await import(moduleUrl(executable));

function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  const p = tree.props ?? {};
  return [tree, ...nodes(p.children), ...nodes(p.leadingAction), ...nodes(p.trailingAction)];
}

function screen() {
  const h = {
    states: [], cursor: 0, tree: null, navigations: [], writes: [], reject: false,
    gate: {busy:false, enter() { if (this.busy) return false; this.busy = true; return true; }, exit() { this.busy = false; }},
    useState(initial) {
      const i = this.cursor++;
      if (!(i in this.states)) this.states[i] = initial;
      return [this.states[i], value => { this.states[i] = typeof value === "function" ? value(this.states[i]) : value; }];
    },
    submit(args) {
      this.writes.push(args);
      return new Promise((resolve, reject) => { this.finish = () => this.reject ? reject(new Error("offline")) : resolve({}); });
    },
    render() { this.cursor = 0; globalThis.__restock = this; this.tree = MobileQuickRestock(); return this.tree; },
    find(predicate) { const n = nodes(this.tree).find(predicate); assert.ok(n, "requested screen control exists"); return n.props; },
    input(id, value) { this.find(n => n.props?.id === id).onChange({target:{value}}); this.render(); },
    select(id, value) {
      this.find(n => n.type === "Select" && nodes(n).some(c => c.props?.id === id)).onValueChange(value);
      this.render();
    },
    pick() {
      this.find(n => n.props?.["aria-label"] === "إضافة صنف").onClick(); this.render();
      this.find(n => n.type === "button" && n.props?.className === "mobile-stock-card").onClick(); this.render();
    },
    cancel() { this.find(n => n.type === "Button" && n.props?.variant === "outline").onClick(); this.render(); },
    remove() { this.find(n => n.type === "button" && n.props?.children === "إزالة").onClick(); this.render(); },
    save() {
      const button = this.find(n => n.type === "Button" && n.props?.className === "flex-1");
      assert.equal(button.disabled, false); button.onClick(); this.render();
    },
  };
  h.doc = {
    activeElement: {tagName:"BUTTON"},
    querySelector(selector) {
      if (selector === '[data-pwa-unsaved="true"]') return nodes(h.tree).find(n => n.props?.["data-pwa-unsaved"] === true) ?? null;
      if (selector.includes('role="dialog"')) return nodes(h.tree).find(n => n.type === "Dialog") ?? null;
      return null;
    },
    querySelectorAll() {
      return nodes(h.tree).filter(n => n.type === "input" || n.type === "Input" || n.type === "MobileSearch").map(n => ({
        tagName:"INPUT", type:n.props.type ?? "text", value:n.props.value ?? "", readOnly:false, disabled:false,
      }));
    },
  };
  h.render();
  return h;
}

test("untouched Quick Restock is safe", () => {
  assert.equal(unsafeReloadReason(screen().doc), null);
});

test("regression: selecting a product with every text input empty blocks reload", () => {
  const h = screen(); h.pick();
  assert.ok(h.doc.querySelectorAll().every(f => f.value === ""));
  assert.notEqual(unsafeReloadReason(h.doc), null);
});

test("supplier remains meaningful after the last product is removed", () => {
  const h = screen(); h.pick(); h.select("restock-supplier", "supplier"); h.remove();
  assert.ok(h.doc.querySelectorAll().every(f => f.value === ""));
  assert.notEqual(unsafeReloadReason(h.doc), null);
});

test("product plus supplier choices block without typed values", () => {
  const h = screen(); h.pick(); h.select("restock-supplier", "supplier");
  assert.notEqual(unsafeReloadReason(h.doc), null);
  h.select("restock-wallet", "bank"); h.remove();
  assert.notEqual(unsafeReloadReason(h.doc), null);
});

test("a changed wallet alone remains protected after removing the product", () => {
  const h = screen(); h.pick(); h.select("restock-wallet", "bank"); h.remove();
  assert.notEqual(unsafeReloadReason(h.doc), null);
  h.cancel(); h.pick();
  const wallet = h.find(n => n.type === "Select" && nodes(n).some(c => c.props?.id === "restock-wallet"));
  assert.equal(wallet.value, "inStoreSafe", "reset really restores the selector");
  h.remove(); assert.equal(unsafeReloadReason(h.doc), null);
});

test("variant-only choice is protected while quantity and cost are empty", () => {
  const h = screen(); h.pick();
  h.find(n => n.type === "Select" && n.props?.value === "").onValueChange("blue"); h.render();
  assert.ok(h.doc.querySelectorAll().every(f => f.value === ""));
  assert.notEqual(unsafeReloadReason(h.doc), null);
  h.remove(); assert.equal(unsafeReloadReason(h.doc), null, "removed variant does not leave a blocker behind");
});

test("cancel clears selections and the changed wallet; no permanent dirty state", () => {
  const h = screen(); h.pick(); h.select("restock-supplier", "supplier"); h.select("restock-wallet", "bank");
  h.cancel();
  assert.equal(unsafeReloadReason(h.doc), null);
  assert.deepEqual(h.navigations, [-1]);
  h.pick(); h.remove();
  assert.equal(unsafeReloadReason(h.doc), null, "reusing the cleared screen stays safe");
});

test("quantity, cost, and supplier text remain protected", () => {
  const h = screen(); h.pick(); h.input("restock-qty-product", "2"); h.input("restock-cost-product", "10");
  h.select("restock-supplier", "__new__"); h.input("new-supplier-name", "Draft supplier");
  assert.notEqual(unsafeReloadReason(h.doc), null);
  h.cancel(); assert.equal(unsafeReloadReason(h.doc), null);
});

function pendingUpdate(h) {
  const clock = {reloads:0, checks:0, retries:[], intervals:[]};
  clock.life = createUpdateLifecycle({
    checkForUpdate:()=>{clock.checks++;}, reload:()=>{clock.reloads++;},
    isSafe:()=>unsafeReloadReason(h.doc) === null, isVisible:()=>true, now:()=>0,
    setInterval:fn=>clock.intervals.push(fn), setTimeout:fn=>clock.retries.push(fn),
  });
  clock.retry = () => clock.retries.splice(0).forEach(fn => fn());
  clock.intervals.forEach(fn=>fn());
  clock.life.updateActivated();
  return clock;
}

test("real guard: update waits for state-only draft, survives retries, then reloads once after cancel", () => {
  const h = screen(); h.pick(); h.select("restock-supplier", "supplier");
  const before = structuredClone(h.states);
  const clock = pendingUpdate(h);
  clock.retry(); clock.life.visibilityChanged();
  assert.equal(clock.checks, 1); assert.equal(clock.reloads, 0);
  assert.deepEqual(h.states, before, "update did not alter the draft");
  assert.equal(clock.life.state().pendingReload, true);
  h.cancel(); clock.retry(); clock.life.navigated(); clock.retry();
  assert.equal(clock.reloads, 1); assert.equal(h.writes.length, 0);
});

for (const failure of [false, true]) {
  test(`submission ${failure ? "failure preserves draft" : "success clears draft and releases pending update"}`, async () => {
    const h = screen(); h.reject = failure; h.pick();
    // This fixture has a variant: use the actual selector's change handler.
    h.find(n => n.type === "Select" && n.props?.value === "").onValueChange("blue"); h.render();
    h.input("restock-qty-product", "2"); h.input("restock-cost-product", "10");
    h.select("restock-supplier", "supplier"); h.select("restock-wallet", "bank");
    h.save();
    const clock = pendingUpdate(h);
    assert.equal(clock.reloads, 0, "never reload during a write");
    h.finish(); await new Promise(resolve=>setImmediate(resolve)); h.render(); clock.retry();
    assert.equal(h.writes.length, 1);
    assert.equal(clock.reloads, failure ? 0 : 1);
    assert.equal(unsafeReloadReason(h.doc) === null, !failure);
  });
}
