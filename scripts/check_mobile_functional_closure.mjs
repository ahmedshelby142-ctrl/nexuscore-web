/**
 * Mobile functional closure — regression tests for each real fix.
 *
 *     node --test scripts/check_mobile_functional_closure.mjs
 *
 * The three concurrency fixes are exercised BEHAVIOURALLY: the real hook
 * modules are imported with `react` swapped for a one-component hooks harness
 * (there is no DOM renderer in this repo), so the tests drive the actual
 * supersede / dedupe / retry logic rather than grepping for it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
/** Source with comments stripped — the prose names what the code refuses to do. */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\r\n]*/g, "$1");

// ── A one-component React ────────────────────────────────────────────────────
// Enough of the hooks contract for these modules: state persists by call
// order, callbacks/effects compare deps, effects run after each render.
const R = (globalThis.__R = (() => {
  let slots = [];
  let i = 0;
  let queued = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((v, k) => Object.is(v, b[k]));
  return {
    reset() { slots = []; },
    render(fn) { i = 0; queued = []; const out = fn(); for (const e of queued) e(); return out; },
    useState(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = typeof init === "function" ? init() : init;
      return [slots[k], (v) => { slots[k] = typeof v === "function" ? v(slots[k]) : v; }];
    },
    useRef(init) { const k = i++; if (!(k in slots)) slots[k] = { current: init }; return slots[k]; },
    useCallback(fn, deps) {
      const k = i++;
      if (slots[k] && same(slots[k].deps, deps)) return slots[k].fn;
      slots[k] = { fn, deps };
      return fn;
    },
    useEffect(fn, deps) {
      const k = i++;
      if (!slots[k] || !same(slots[k].deps, deps)) { slots[k] = { deps }; queued.push(fn); }
    },
  };
})());

const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
const STUBS = {
  react: stub(`const R = globalThis.__R;
    export const useState = (...a) => R.useState(...a);
    export const useRef = (...a) => R.useRef(...a);
    export const useCallback = (...a) => R.useCallback(...a);
    export const useEffect = (...a) => R.useEffect(...a);`),
  "./mobileReaders": stub(`export const MOBILE_PAGE_SIZE = 25;`),
  "./useMobileRealtime": stub(`export function useRealtimeTables() {}`),
  "./mobileHomeReader": stub(`
    export const readMobileHomeSnapshot = (...a) => globalThis.__home.read(...a);
    export const composeMobileHomeSnapshot = (s) => s;`),
};
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    if (specifier.startsWith("@/")) return next(new URL(`src/${specifier.slice(2)}.ts`, root).href, context);
    return next(specifier, context);
  },
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const settle = () => new Promise((r) => setImmediate(r));

// ═══ Paged lists: a new search supersedes the read in flight ════════════════

test("a new search is read even while the previous one is in flight, and wins", async () => {
  const { useMobilePagedQuery } = await import("../src/mobile/data/useMobilePagedQuery.ts");
  R.reset();
  const calls = [];
  const reader = (q) => { const d = deferred(); calls.push({ q, d }); return d.promise; };

  R.render(() => useMobilePagedQuery(reader, { search: "a" }));
  R.render(() => useMobilePagedQuery(reader, { search: "ab" }));

  assert.equal(calls.length, 2, "typing «ab» while «a» loads must still ask for «ab»");
  assert.equal(calls[1].q.search, "ab");

  calls[1].d.resolve({ rows: [{ id: "ab" }], total: 1, hasMore: false });
  await settle();
  calls[0].d.resolve({ rows: [{ id: "a" }], total: 1, hasMore: false });
  await settle();

  const state = R.render(() => useMobilePagedQuery(reader, { search: "ab" }));
  assert.deepEqual(state.rows.map((r) => r.id), ["ab"], "the late «a» answer must not repaint «ab»");
  assert.equal(state.loading, false);
});

test("refresh stays one read at a time, and is released afterwards", async () => {
  const { useMobilePagedQuery } = await import("../src/mobile/data/useMobilePagedQuery.ts");
  R.reset();
  const calls = [];
  const reader = (q) => { const d = deferred(); calls.push(d); return d.promise; };
  let page = R.render(() => useMobilePagedQuery(reader, {}));
  calls[0].resolve({ rows: [{ id: 1 }], total: 1, hasMore: false });
  await settle();

  page = R.render(() => useMobilePagedQuery(reader, {}));
  void page.refresh();
  void page.refresh();
  void page.refresh();
  assert.equal(calls.length, 2, "a held finger on تحديث is one query");
  calls[1].resolve({ rows: [{ id: 2 }], total: 1, hasMore: false });
  await settle();

  page = R.render(() => useMobilePagedQuery(reader, {}));
  void page.refresh();
  assert.equal(calls.length, 3, "and the next refresh is not locked out");
});

// ═══ Detail screens: a new record supersedes the read in flight ═════════════

test("a detail screen shows the record its route names, not a late earlier one", async () => {
  const { useMobileEntity } = await import("../src/mobile/data/useMobileEntity.ts");
  R.reset();
  const a = deferred();
  const b = deferred();
  const readA = () => a.promise;
  const readB = () => b.promise;

  R.render(() => useMobileEntity(readA));
  R.render(() => useMobileEntity(readB));
  b.resolve({ id: "B" });
  await settle();
  a.resolve({ id: "A" });
  await settle();

  const state = R.render(() => useMobileEntity(readB));
  assert.equal(state.data?.id, "B");
});

test("a failed detail read is an error, and retry reads again and restores it", async () => {
  const { useMobileEntity } = await import("../src/mobile/data/useMobileEntity.ts");
  R.reset();
  let n = 0;
  const reader = async () => { n += 1; if (n === 1) throw new Error("network"); return { id: "X" }; };
  let s = R.render(() => useMobileEntity(reader));
  await settle();
  s = R.render(() => useMobileEntity(reader));
  assert.equal(s.error, "network");
  assert.equal(s.data, null, "an error is not an empty record");
  await s.reload();
  s = R.render(() => useMobileEntity(reader));
  assert.equal(s.error, null);
  assert.equal(s.data?.id, "X");
});

// ═══ Home: retry and refresh really re-read; nothing outlives a session ═════

test("Home: a failed read is retried for real, and a success is not served forever", async () => {
  const { readSharedHomeSnapshot } = await import("../src/mobile/data/useMobileHomeData.ts");
  const caps = new Set(["home", "orders"]);
  let reads = 0;
  globalThis.__home = {
    read: async () => {
      reads += 1;
      if (reads === 1) throw new Error("offline");
      return { store: `answer-${reads}` };
    },
  };

  await assert.rejects(readSharedHomeSnapshot(caps, false), /offline/);
  assert.equal((await readSharedHomeSnapshot(caps, false)).store, "answer-2", "retry must reach the server");
  // The next user on this phone with the same role, or تحديث, asks again.
  assert.equal((await readSharedHomeSnapshot(caps, false)).store, "answer-3");
  assert.equal(reads, 3);
});

test("Home: Home and the nav badges mounting together cost one read", async () => {
  const { readSharedHomeSnapshot } = await import("../src/mobile/data/useMobileHomeData.ts");
  const caps = new Set(["home", "stock"]);
  let reads = 0;
  const gate = deferred();
  globalThis.__home = { read: () => { reads += 1; return gate.promise; } };
  const one = readSharedHomeSnapshot(caps, false);
  const two = readSharedHomeSnapshot(caps, false);
  gate.resolve({ ok: true });
  assert.deepEqual(await one, await two);
  assert.equal(reads, 1);
});

test("Home watches the tables its numbers come from", () => {
  const hook = code("src/mobile/data/useMobileHomeData.ts");
  assert.match(hook, /useRealtimeTables\(\["orders", "products", "ledger_events"\]/);
  assert.doesNotMatch(hook, /cache\.set|cache\.get/, "no tab-lifetime result cache");
  const reader = code("src/mobile/data/mobileHomeReader.ts");
  assert.match(reader, /count: snapshot\.shipmentsTotal/, "the in-transit count is the server total, not the 3-row preview");
});

// ═══ Roles: Quick Restock is exactly the roles Postgres lets write it ═══════

test("Quick Restock is ADMIN + ACCOUNTANT only — the purchase_invoices write roles", async () => {
  const { getMobileCapabilities } = await import("../src/mobile/navigation/mobileCapabilities.ts");
  const matrix = Object.fromEntries(
    ["ADMIN", "ACCOUNTANT", "POS_ECOMMERCE", "ECOMMERCE_ONLY", "MODERATOR"].map((r) => [r, getMobileCapabilities(r).has("purchasing")]),
  );
  // Live policy `write_purchase_invoices` and the `purchase` branch of
  // `insert_ledger_events` are has_role(ADMIN, ACCOUNTANT). Nesting /restock
  // under `stock` instead would offer it to ECOMMERCE_ONLY and MODERATOR, whose
  // every attempt the database refuses.
  assert.deepEqual(matrix, { ADMIN: true, ACCOUNTANT: true, POS_ECOMMERCE: false, ECOMMERCE_ONLY: false, MODERATOR: false });
  assert.match(code("src/mobile/router.tsx"), /capability="purchasing" \/>}><Route path="purchasing"[^\n]*<Route path="restock"/);
});

// ═══ Stock authority ════════════════════════════════════════════════════════

test("mobile stock quantities are the ledger's, never the products.quantity mirror", () => {
  const details = code("src/mobile/screens/MobileProductDetails.tsx");
  assert.match(details, /mobileStock/);
  assert.doesNotMatch(details, /getActualStock/, "its snapshot is never filled on mobile, so it reads the mirror");
  // Nothing under src/mobile may reach for the snapshot-backed helper.
  for (const file of ["src/mobile/viewmodels/stockViewModel.ts", "src/mobile/viewmodels/index.ts"]) {
    assert.doesNotMatch(code(file), /getActualStock|toMobileStockRow|toMobileStockQueue/);
  }
  assert.equal(existsSync(new URL("src/mobile/viewmodels/home/homeComposer.ts", root)), false, "dead fake-zero composer stays deleted");
});

// ═══ Failed reads are errors, not zeros ═════════════════════════════════════

test("no mobile reader turns a failed read into a zero or an empty answer", () => {
  const readers = code("src/mobile/data/mobileReaders.ts");
  assert.match(readers, /const \{ data, error \} = await clientOrThrow\(\)\s*\.from\("orders"\)\s*\.select\("customerId, createdAt"\)[\s\S]*?if \(error\) throw/, "customer order counts");
  assert.doesNotMatch(readers, /balanceOf\("customer_ltv", customerId\)\.catch/, "lifetime value");
  assert.match(readers, /if \(customerRead\.error\) throw/, "wasted-trip debt");
  assert.doesNotMatch(readers, /ledgerEvents\([^)]*\)[\s\S]{0,40}catch \{\s*return \[\]/, "order timeline");
  const home = code("src/mobile/data/mobileHomeReader.ts");
  assert.match(home, /if \(!storeId\) throw/, "shortages without a store");
  assert.doesNotMatch(home, /if \(!storeId\) return \[\]/);
});

test("deleted orders are not counted or listed as waiting", () => {
  const readers = code("src/mobile/data/mobileReaders.ts");
  const waiting = readers.slice(readers.indexOf("export async function readMobileProductWaitingOrders"));
  assert.match(waiting.slice(0, 600), /\.is\("deleted_at", null\)/);
  const summary = readers.slice(readers.indexOf("export async function readMobileCustomerFinancialSummary"));
  assert.match(summary.slice(0, 900), /\.is\("deleted_at", null\)/);
});

test("the order timeline failure is shown with a retry through the same reader", () => {
  const screen = code("src/mobile/screens/MobileOrderDetails.tsx");
  assert.match(screen, /timelineError \? \(\s*<ErrorState [^>]*onRetry=\{\(\) => void loadTimeline\(\)\}/);
  assert.match(screen, /setTimelineError\(null\)/, "a retry clears the previous failure");
});

test("shortages: an error clears the stale total, and the list follows realtime", () => {
  const screen = code("src/mobile/screens/MobileShortagesScreen.tsx");
  assert.match(screen, /catch \(e\) \{\s*setRows\(\[\]\);/);
  assert.match(screen, /useRealtimeTables\(\["orders", "ledger_events"\]/);
});

// ═══ Lists ══════════════════════════════════════════════════════════════════

test("Shipments trusts the server's search, which is the one that knows couriers", () => {
  const screen = code("src/mobile/screens/MobileShipmentsScreen.tsx");
  assert.doesNotMatch(screen, /matchesSearch|toLocaleLowerCase\(\)\.includes/);
  assert.match(code("src/mobile/data/mobileReaders.ts"), /courierName\.ilike/);
  assert.match(screen, /onClick=\{\(\) => void page\.refresh\(\)\}/, "D4: refresh re-runs the canonical reader");
});

test("a filtered stock list with more pages does not claim there is nothing", () => {
  assert.match(code("src/mobile/screens/MobileStockScreen.tsx"), /rows\.length === 0 && !page\.hasMore \?/);
});

test("customer order history pages from the rows it holds, through the reader that owns errors", () => {
  const screen = code("src/mobile/screens/MobileCustomerDetails.tsx");
  assert.doesNotMatch(screen, /pageNum|setPageNum/);
  assert.match(screen, /void loadOrders\(Math\.floor\(ordersPage\.rows\.length \/ 25\)\)/);
});

// ═══ Quick Restock deep link ════════════════════════════════════════════════

test("a restock deep link never spins forever", () => {
  const screen = code("src/mobile/screens/MobileQuickRestock.tsx");
  assert.doesNotMatch(screen, /\.catch\(\(\) => \{\s*\}\)/, "a failed read is not swallowed");
  assert.match(screen, /setLinkError\(/);
  assert.match(screen, /<ErrorState messageAr="تعذّر تحميل الأصناف المختارة\." onRetry=/);
  assert.match(screen, /setSelectedProductIds\(\(prev\) => prev\.filter\(\(id\) => !gone\.includes\(id\)\)\)/, "a missing product is dropped, not awaited");
  // Exactly-once is still the gate plus the disabled button.
  assert.match(screen, /if \(!canSave \|\| !gate\.enter\(\)\) return;/);
  assert.match(screen, /gate\.exit\(\)/);
});
