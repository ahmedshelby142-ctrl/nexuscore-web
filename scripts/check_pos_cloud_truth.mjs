/**
 * P0 — a committed POS sale/return must never be followed by
 *      «تعذّر حفظ التعديل على السحابة. لم يتم حفظ أي شيء».
 *
 *     node --test scripts/check_pos_cloud_truth.mjs
 *
 * Production, 2026-10-02 (edge logs, one POS_ECOMMERCE cashier, 7 times):
 *
 *     POST rpc/ledger_append                     200   ← the sale/return, committed
 *     POST return_records?on_conflict=id         201   ← (returns only)
 *     POST products?on_conflict=id              403   ← stock-mirror push → red toast
 *
 * The mirror push was `writeThrough("products", fullRow)`: an INSERT … ON
 * CONFLICT upsert. `write_products` (INSERT) admits only ADMIN/ACCOUNTANT, and
 * Postgres checks the INSERT policy on an upsert even when it resolves to an
 * update — so every cashier sale was refused, and `announce()` told the cashier
 * nothing had been saved, seconds after the ledger had saved everything.
 *
 * The real `cloudData` and `useBusinessStore` run here against a fake client
 * that enforces the LIVE policies on `products`:
 *   - INSERT/upsert: ADMIN, ACCOUNTANT                       (write_products)
 *   - UPDATE: + POS_ECOMMERCE, ECOMMERCE_ONLY                (update_products)
 *   - non-admins may not change definition columns  (products_guard_definition_columns)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");
const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.window ??= globalThis;

// ── a fake PostgREST that enforces the live `products` policies ─────────────
globalThis.__db = { role: "POS_ECOMMERCE", requests: [], toasts: [], rows: new Map(), fail: new Set(), rpc: [] };
const STUBS = {
  "@/lib/supabase": stub(`
    const db = () => globalThis.__db;
    const DEFINITION = ["name","sku","barcode","category","description","image_url","unitPrice",
      "wholesale_price","minStockLevel","maxStockLevel","isActive","isBundle","bundleItems","deleted_at"];
    const RLS = { code: "42501", message: 'new row violates row-level security policy for table "products"' };
    function from(table) {
      const q = { table, op: null, payload: null, id: null };
      const run = () => {
        const d = db();
        d.requests.push({ table, op: q.op, payload: q.payload, id: q.id });
        if (d.fail.has(table + ":" + q.op)) return { data: null, error: { message: "fetch failed" } };
        const admin = d.role === "ADMIN" || d.role === "ACCOUNTANT";
        if (table === "products" && q.op === "upsert" && !admin) return { data: null, error: RLS };
        if (table === "products" && q.op === "update") {
          const old = d.rows.get(q.id) ?? {};
          if (!admin && DEFINITION.some((c) => c in q.payload && JSON.stringify(q.payload[c]) !== JSON.stringify(old[c])))
            return { data: null, error: { code: "42501", message: "only ADMIN or ACCOUNTANT may change a product's definition" } };
          d.rows.set(q.id, { ...old, ...q.payload });
          return { data: null, error: null };
        }
        const row = { ...(d.rows.get(q.payload?.id) ?? {}), ...q.payload };
        if (q.payload?.id) d.rows.set(q.payload.id, row);
        return { data: row, error: null };
      };
      const chain = {
        upsert(p) { q.op = "upsert"; q.payload = p; return chain; },
        update(p) { q.op = "update"; q.payload = p; return chain; },
        eq(_c, v) { q.id = v; return chain; },
        select() { return chain; },
        single() { return Promise.resolve(run()); },
        then(ok, ko) { return Promise.resolve(run()).then(ok, ko); },
      };
      return chain;
    }
    export const getSupabaseClient = () => ({ from, rpc: async (n) => { db().rpc.push(n); return { data: null, error: null }; } });`),
  "@/services/api/storeContext": stub(`export const getSyncIdentity = async () => ({ storeId: "S1", deviceId: "11111111-1111-4111-8111-111111111111" });`),
  "@/lib/pageAll": stub(`export const pageAll = async () => [];`),
  sonner: stub(`
    const push = (level) => (message) => globalThis.__db.toasts.push({ level, message });
    export const toast = { error: push("error"), warning: push("warning"), success: push("success"), info: push("info") };`),
};
// Only the gate's `useRef` is replaced; zustand still needs the real React.
const GATE_REACT = stub(`export const useRef = (v) => ({ current: v });`);
const ts = (u) => (existsSync(fileURLToPath(u + ".ts")) ? u + ".ts" : u + "/index.ts");
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    if (/(^|\/)storeContext$/.test(specifier)) return { url: STUBS["@/services/api/storeContext"], shortCircuit: true };
    if (specifier === "react" && context.parentURL?.endsWith("/useSubmitGate.ts")) return { url: GATE_REACT, shortCircuit: true };
    if (specifier.startsWith("@/")) return next(ts(new URL(`src/${specifier.slice(2)}`, root).href), context);
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
      return next(ts(new URL(specifier, context.parentURL).href), context);
    return next(specifier, context);
  },
});

const { useBusinessStore } = await import(new URL("src/store/useBusinessStore.ts", root).href);
const cloud = await import(new URL("src/services/cloudData.ts", root).href);
const { useSubmitGate } = await import(new URL("src/hooks/useSubmitGate.ts", root).href);
const B = () => useBusinessStore.getState();
const NOTHING_SAVED = "لم يتم حفظ أي شيء";

const plain = { id: "P1", name: "قميص", unitPrice: 300, totalQuantity: 10, quantity: 0, isActive: true };
const varied = {
  id: "P2", name: "بنطلون", unitPrice: 500, totalQuantity: 5, isActive: true,
  metadata: { variants: [{ name: "M", stock: 3 }, { name: "L", stock: 2 }] },
};
function reset(role = "POS_ECOMMERCE") {
  const d = globalThis.__db;
  d.role = role; d.requests = []; d.toasts = []; d.fail = new Set(); d.rpc = [];
  d.rows = new Map([["P1", { ...plain, quantity: 10 }], ["P2", { ...varied, quantity: 5 }]]);
  useBusinessStore.setState({ products: [{ ...plain }, structuredClone(varied)], returnRecords: [] });
}
/** The mirror push is fire-and-forget; let it and its report settle. */
const settle = () => new Promise((r) => setTimeout(r, 20));
const said = (text) => globalThis.__db.toasts.filter((t) => String(t.message).includes(text));

// ── POS sale ────────────────────────────────────────────────────────────────

test("POS SALE by a cashier: the stock mirror lands and no contradictory toast appears", async () => {
  reset("POS_ECOMMERCE");
  B().applyStockMoves([{ productId: "P1", delta: -2 }]); // exactly what CheckoutForm sends after the ledger
  await settle();

  const writes = globalThis.__db.requests.filter((r) => r.table === "products");
  assert.deepEqual(writes.map((w) => w.op), ["update"], "an UPDATE — never an INSERT the cashier's RLS refuses");
  assert.equal(writes[0].id, "P1");
  assert.equal(writes[0].payload.quantity, 8, "the shelf count, as an absolute value");
  assert.deepEqual(Object.keys(writes[0].payload).sort(), ["quantity", "updated_at"], "cache columns only");
  assert.deepEqual(globalThis.__db.toasts, [], "a committed sale shows no error at all");
  assert.equal(B().products.find((p) => p.id === "P1").totalQuantity, 8);
});

test("POS SALE of a variant: only quantity + metadata travel, and the guard trigger accepts it", async () => {
  reset("POS_ECOMMERCE");
  B().applyStockMoves([{ productId: "P2", delta: -1, variantName: "M" }]);
  await settle();
  const [w] = globalThis.__db.requests.filter((r) => r.table === "products");
  assert.equal(w.op, "update");
  assert.deepEqual(Object.keys(w.payload).sort(), ["metadata", "quantity", "updated_at"]);
  assert.equal(w.payload.quantity, 4);
  assert.equal(w.payload.metadata.variants.find((v) => v.name === "M").stock, 2);
  assert.deepEqual(globalThis.__db.toasts, []);
});

test("ADMIN and ACCOUNTANT keep working exactly as before", async () => {
  for (const role of ["ADMIN", "ACCOUNTANT"]) {
    reset(role);
    B().applyStockMoves([{ productId: "P1", delta: -1 }]);
    await settle();
    assert.deepEqual(globalThis.__db.toasts, [], role);
    assert.equal(globalThis.__db.rows.get("P1").quantity, 9, role);
  }
});

// ── POS return ──────────────────────────────────────────────────────────────

test("POS RETURN by a cashier: record saved, stock back, no contradictory toast", async () => {
  reset("POS_ECOMMERCE");
  // The order CheckoutForm uses after `ledger_append` answered 200.
  await B().addReturnRecord(
    { original_order_id: "pos_1", type: "return", customer_name: "عميل", customer_phone: "", governorate: "POS",
      returned_items: [{ product_id: "P1", product_name: "قميص", quantity: 1, refund_amount: 300 }],
      financial_difference: -300, processed_by: "POS", notes: "" },
    { afterCommit: true },
  );
  B().applyStockMoves([{ productId: "P1", delta: +1 }]);
  await settle();

  assert.deepEqual(globalThis.__db.requests.map((r) => `${r.table}:${r.op}`), ["return_records:upsert", "products:update"]);
  assert.equal(B().returnRecords.length, 1);
  assert.equal(globalThis.__db.rows.get("P1").quantity, 11);
  assert.deepEqual(globalThis.__db.toasts, []);
});

// ── the invariant ───────────────────────────────────────────────────────────

test("GENUINE failed write: «لم يتم حفظ أي شيء» and nothing committed — locally or remotely", async () => {
  reset("POS_ECOMMERCE");
  // A cashier editing a price: refused by RLS, and that refusal IS total.
  await assert.rejects(B().updateProduct("P1", { unitPrice: 1 }));
  assert.equal(said(NOTHING_SAVED).length, 1);
  assert.equal(B().products.find((p) => p.id === "P1").unitPrice, 300, "local store untouched");
  assert.equal(globalThis.__db.rows.get("P1").unitPrice, 300, "database untouched");
});

test("SECONDARY failure (mirror) after a committed operation: truthful, non-financial, once", async () => {
  reset("POS_ECOMMERCE");
  globalThis.__db.fail.add("products:update");
  B().applyStockMoves([{ productId: "P1", delta: -1 }, { productId: "P2", delta: -1, variantName: "L" }]);
  await settle();

  assert.equal(said(NOTHING_SAVED).length, 0, "the operation WAS saved — saying otherwise is false");
  assert.equal(globalThis.__db.toasts.length, 1, "one report per operation, not one per product");
  assert.equal(globalThis.__db.toasts[0].level, "warning");
  assert.equal(globalThis.__db.toasts[0].message, cloud.MIRROR_FAILED_MESSAGE);
  assert.match(cloud.MIRROR_FAILED_MESSAGE, /متعيدش العملية/, "and it tells the cashier NOT to redo it");
});

test("SECONDARY failure (document) after the ledger committed: truthful message, and it still throws", async () => {
  reset("POS_ECOMMERCE");
  globalThis.__db.fail.add("return_records:upsert");
  await assert.rejects(
    B().addReturnRecord(
      { original_order_id: "pos_2", type: "return", customer_name: "", customer_phone: "", governorate: "POS",
        returned_items: [], financial_difference: 0, processed_by: "POS", notes: "" },
      { afterCommit: true },
    ),
  );
  assert.equal(said(NOTHING_SAVED).length, 0);
  assert.deepEqual(globalThis.__db.toasts.map((t) => t.message), [cloud.AFTER_COMMIT_MESSAGE]);
  assert.equal(B().returnRecords.length, 0, "the document itself is not faked locally");
});

test("standalone writes keep the «nothing saved» wording — it is true for them", async () => {
  reset("POS_ECOMMERCE");
  globalThis.__db.fail.add("return_records:upsert");
  await assert.rejects(
    B().addReturnRecord({ original_order_id: "x", type: "return", customer_name: "", customer_phone: "", governorate: "",
      returned_items: [], financial_difference: 0, processed_by: "", notes: "" }),
  );
  assert.equal(said(NOTHING_SAVED).length, 1);
});

// ── no duplication ──────────────────────────────────────────────────────────

test("RETRY cannot duplicate stock: the mirror is never retried and carries an absolute count", async () => {
  reset("POS_ECOMMERCE");
  globalThis.__db.fail.add("products:update");
  B().applyStockMoves([{ productId: "P1", delta: -3 }]);
  await settle();
  assert.equal(globalThis.__db.requests.filter((r) => r.table === "products").length, 1, "no silent retry");
  assert.deepEqual(globalThis.__db.rpc, [], "the mirror never touches the ledger — money and stock movements are not re-sent");

  // Replaying the same push twice leaves the same number, never a double move.
  globalThis.__db.fail.clear();
  await cloud.updateMirror("products", "P1", { totalQuantity: 7 });
  await cloud.updateMirror("products", "P1", { totalQuantity: 7 });
  assert.equal(globalThis.__db.rows.get("P1").quantity, 7);
});

test("DOUBLE CLICK: the submit gate admits exactly one checkout", () => {
  const gate = useSubmitGate();
  assert.equal(gate.enter(), true);
  assert.equal(gate.enter(), false, "the second click in the same tick is dropped");
  gate.exit();
  assert.equal(gate.enter(), true);
});

// ── the POS screen itself ───────────────────────────────────────────────────

const pos = read("src/components/sales/CheckoutForm.tsx");
const handler = pos.slice(pos.indexOf("const handleCompleteSale = async"), pos.indexOf("\n  return (", pos.indexOf("const handleCompleteSale = async")));

test("POS: the operation counts as committed the moment the ledger accepts it", () => {
  const appends = [...handler.matchAll(/await appendEvent\(\{/g)].map((m) => m.index);
  assert.ok(appends.length >= 2, "retail and wholesale sale");
  for (const at of appends) {
    const close = "\n        });";
    const end = handler.indexOf(close, at) + close.length;
    // The next statement after the append, comment lines aside.
    const next = handler
      .slice(end)
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("//"));
    assert.equal(next, "saleCommitted = true;", "set right after each append");
  }
});

test("POS: documents written after the ledger say so, and their failure cannot invite a duplicate retry", () => {
  assert.match(handler, /addReturnRecord\([\s\S]*?\{ afterCommit: true \}\s*\)/);
  assert.match(handler, /addWholesaleInvoice\([\s\S]*?\{ afterCommit: true \}\s*\)/);
  // "nothing changed" is only ever said when nothing was committed…
  const nothingChanged = handler.indexOf("لم تُسجَّل العملية ولم يتغيّر أي رصيد");
  assert.ok(nothingChanged > 0);
  assert.match(handler.slice(Math.max(0, nothingChanged - 400), nothingChanged), /if \(!saleCommitted\)/);
  // …and a committed operation always clears the basket, so it cannot be re-run.
  assert.match(handler, /documentError/);
  assert.ok(handler.indexOf("setCart([])", handler.indexOf("documentError")) > 0);
});

test("POS: a claimed discount is released only when nothing was committed", () => {
  assert.match(handler, /if \(claimedDiscount && !saleCommitted\)/);
  assert.ok(handler.indexOf("if (!gate.enter()) return;") < handler.indexOf("await "), "gate before the first await");
});

test("no offline write queue was introduced", () => {
  const cloudSrc = read("src/services/cloudData.ts");
  assert.doesNotMatch(cloudSrc, /indexedDB|IDB|enqueue|retryQueue|outbox/i);
  assert.doesNotMatch(read("src/store/useBusinessStore.ts"), /indexedDB|enqueue|outbox/i);
});
