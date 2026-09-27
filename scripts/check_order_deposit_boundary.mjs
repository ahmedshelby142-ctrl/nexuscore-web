/**
 * Order deposit boundary — 045 (place_order) + 046 (the deposit rule).
 *
 *     node --test scripts/check_order_deposit_boundary.mjs
 *
 * The P1: `/ecommerce-orders` appended `order_placed` — stock out AND the
 * deposit into a wallet — before the order row existed, so nothing could
 * bound the deposit. Proven on production before the fix (rolled back): a
 * POS_ECOMMERCE session banked a 1,000,000 EGP "deposit" on one unit.
 *
 * What is pinned here:
 *   1. 046 re-creates the validator as 044 + ONE block. Removing that block
 *      must give back 044's function byte for byte — no 044 rule weakened.
 *   2. Each predicate of the deposit rule is load-bearing (mutation).
 *   3. place_order is one transaction, idempotent, and adds no authority.
 *   4. The client's placeOrder, run for real against a stubbed Supabase:
 *      confirmed / refused / unknown outcomes and the replay are told apart,
 *      because the retry contract depends on it.
 *   5. The order screen has exactly one placement path and keeps the order
 *      number until the placement is confirmed.
 *
 * Behaviour against the live database: scripts/security/046_deposit_matrix.sql
 * (22/22 in a rolled-back transaction) — DESKTOP_PRODUCT_AUDIT.md §I-9.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");
const sql = (t) => t.replace(/--[^\n]*/g, "");
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const M044 = read("docs/migrations/044_ledger_event_semantic_integrity.sql");
const M045 = read("docs/migrations/045_place_order_atomic.sql");
const M046 = read("docs/migrations/046_order_deposit_boundary.sql");
const fnOf = (text, name) => text.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$function\\$;`))?.[0] ?? "";

// ═══ 1. 046 is 044 plus one block — nothing weakened ═══════════════════════

const BLOCK_046 = /    -- 046 — the deposit is bounded by the order it is paid on\.[\s\S]*?        USING ERRCODE = '23514';\n    END IF;\n(?=\n  ELSIF v_kind = 'order_cancelled')/;
const VARS_046 = "  -- 046: the order an order_placed reserves for\n  v_total numeric; v_ship numeric; v_dep numeric; v_cod numeric; v_disc numeric; v_goods numeric;\n";

test("046's validator is 044's, byte for byte, plus the deposit block", () => {
  const v046 = fnOf(M046, "ledger_validate_event");
  assert.ok(BLOCK_046.test(v046), "the 046 block is where it belongs");
  assert.ok(v046.includes(VARS_046));
  assert.equal(v046.replace(BLOCK_046, "").replace(VARS_046, ""), fnOf(M044, "ledger_validate_event"));
  assert.match(sql(M046), /REVOKE ALL ON FUNCTION public\.ledger_validate_event\(jsonb\) FROM public, anon;/);
  assert.doesNotMatch(sql(M046), /\bEXCEPTION\s+WHEN\b|SECURITY DEFINER|ALTER TABLE|DROP |DELETE FROM|UPDATE public\./i);
});

// ═══ 2. The deposit rule, and each predicate is load-bearing ═══════════════

const DEPOSIT_RULES = {
  "the order must exist in this store": /IF v_ref_type IS DISTINCT FROM 'ecommerce_order' OR v_ref_id IS NULL OR NOT FOUND THEN\n      RAISE EXCEPTION 'ledger: order_placed — must reserve/,
  "read from the store's own order row": /FROM public\.orders o\n     WHERE o\.store_id = v_store\n       AND o\."orderNumber" = v_ref_id\n       AND o\.deleted_at IS NULL;/,
  "one placement per order": /RAISE EXCEPTION 'ledger: order_placed — this order is already placed'/,
  "nothing negative": /IF v_total < 0 OR v_ship < 0 OR v_dep < 0 OR v_cod < 0/,
  "total = goods − discount": /OR abs\(v_goods - v_disc - v_total\) >= 0\.005/,
  "deposit + COD = total + shipping": /OR abs\(v_dep \+ v_cod - v_total - v_ship\) >= 0\.005 THEN/,
  "banked = the order's deposit": /IF abs\(w - v_dep \* 100\) >= 1 THEN/,
};

function depositProblems(text) {
  const fn = sql(fnOf(text, "ledger_validate_event"));
  return Object.entries(DEPOSIT_RULES).filter(([, re]) => !re.test(fn)).map(([n]) => n);
}

test("the deposit rule holds", () => {
  assert.deepEqual(depositProblems(M046), []);
});

test("removing any deposit predicate is caught", () => {
  for (const [name, re] of Object.entries(DEPOSIT_RULES)) {
    const mutant = M046.replace(re, "IF false THEN");
    assert.notEqual(mutant, M046, `mutant "${name}" did not apply`);
    assert.ok(depositProblems(mutant).includes(name), `mutant "${name}" survived`);
  }
});

// ═══ 3. place_order: one transaction, idempotent, no authority of its own ══

test("place_order inserts the row then appends, in one function, idempotently", () => {
  const fn = sql(fnOf(M045, "place_order"));
  assert.ok(fn, "place_order is defined");
  const lock = fn.indexOf("PERFORM pg_advisory_xact_lock(hashtext('place_order:'");
  const lookup = fn.indexOf("SELECT to_jsonb(o.*) INTO v_existing");
  const insert = fn.indexOf("INSERT INTO public.orders AS o");
  const append = fn.indexOf("PERFORM public.ledger_append(p_event);");
  assert.ok(lock > 0 && lock < lookup && lookup < insert && insert < append, "lock → look up → insert → append");
  assert.match(fn, /RETURN jsonb_build_object\('order', v_existing, 'replayed', true\);/, "a retry returns the placed order");
  assert.match(fn, /exists without its placement/, "a row without its event is refused, never patched");
  assert.match(fn, /p_event ->> 'ref_id' IS DISTINCT FROM v_number/, "the event must name this order");
  assert.match(fn, /\(p_event ->> 'store_id'\)::uuid IS DISTINCT FROM v_store/, "and this store");
  assert.doesNotMatch(fn, /SECURITY DEFINER/, "write_orders and the ledger policies still decide, as the caller");
  assert.doesNotMatch(fn, /\bEXCEPTION\s+WHEN\b/i, "043: no subtransaction around the append");
  assert.match(sql(M045), /REVOKE ALL ON FUNCTION public\.place_order\(jsonb, jsonb\) FROM public, anon;/);
});

// ═══ 4. The client's placeOrder, run against a stubbed Supabase ════════════

globalThis.__rpc = null;
const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
const STUBS = {
  "@/lib/supabase": stub(`export const getSupabaseClient = () => ({ rpc: (...a) => globalThis.__rpc(...a) }); export const isCloudSyncMode = () => true;`),
  "@/services/api/storeContext": stub(`export const getSyncIdentity = async () => ({ storeId: "S1", deviceId: "D1" }); export const getActiveStoreId = async () => "S1";`),
  "@/lib/ledger": stub(`export const prepareEvent = async (e) => ({ id: "EV", store_id: "S1", kind: e.kind, ref_type: e.refType, ref_id: e.refId, lines: e.lines });`),
  "@/services/cloudData": stub(`export const writeThrough = async (t, r) => r;`),
  "@/services/documentNumber": stub(`export const nextDocumentNumber = async () => "ECO-9999";`),
  "./useBusinessStore": stub(`export const useBusinessStore = { getState: () => ({ products: [] }) };`),
  "./useCustomerStore": stub(`export const useCustomerStore = { getState: () => ({ upsertCustomerFromOrder: async () => "C1" }) };`),
  "./useCourierStore": stub(`export const useCourierStore = { getState: () => ({}) };`),
  "./useFinancialStore": stub(`export const useFinancialStore = { getState: () => ({}) };`),
};
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    if (specifier.startsWith("@/")) {
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        const url = new URL(`src/${specifier.slice(2)}${ext}`, root);
        try { if (statSync(url).isFile()) return next(url.href, context); } catch {}
      }
    }
    return next(specifier, context);
  },
});
const { useOrderStore } = await import("../src/store/useOrderStore.ts");

const draft = () => ({
  orderNumber: "ECO-0042", customerName: "c", customerPhone: "01", address: "a", governorate: "g",
  paymentMethod: "partial_cod", shippingFee: 40, items: [{ productId: "p", productName: "P", quantity: 1, unitPrice: 300 }],
  stockItems: [], cogsAmount: 0, totalAmount: 300, depositAmount: 100, expectedCod: 240, courierFee: 40, status: "pending",
});
const placement = { kind: "order_placed", refType: "ecommerce_order", refId: "ECO-0042", lines: [] };
const reset = () => useOrderStore.setState({ orders: [] });

test("confirmed: the row and the event travel together in ONE rpc, and the order is committed", async () => {
  reset();
  const calls = [];
  globalThis.__rpc = async (name, args) => { calls.push([name, args]); return { data: { order: { ...args.p_order }, replayed: false }, error: null }; };
  const result = await useOrderStore.getState().placeOrder(draft(), placement);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "place_order");
  assert.equal(calls[0][1].p_order.orderNumber, "ECO-0042");
  assert.equal(calls[0][1].p_event.ref_id, "ECO-0042");
  assert.equal(calls[0][1].p_event.kind, "order_placed");
  assert.equal(result.success, true);
  assert.equal(result.replayed, false);
  assert.equal(useOrderStore.getState().orders.length, 1);
});

test("replayed: a retry that finds its order says so and commits it once", async () => {
  reset();
  globalThis.__rpc = async (name, args) => ({ data: { order: { ...args.p_order }, replayed: true }, error: null });
  const result = await useOrderStore.getState().placeOrder(draft(), placement);
  assert.equal(result.success && result.replayed, true);
  assert.equal(useOrderStore.getState().orders.length, 1);
});

test("refused: the database answered with a code — definite, nothing committed", async () => {
  reset();
  globalThis.__rpc = async () => ({ data: null, error: { code: "23514", message: "ledger: order_placed — the deposit banked must be the order's deposit" } });
  const result = await useOrderStore.getState().placeOrder(draft(), placement);
  assert.deepEqual([result.success, result.definite], [false, true]);
  assert.match(result.reason, /deposit/);
  assert.equal(useOrderStore.getState().orders.length, 0);
});

test("unknown: no code, or a throw — NOT definite, so the caller keeps the number", async () => {
  reset();
  globalThis.__rpc = async () => ({ data: null, error: { code: "", message: "TypeError: Failed to fetch" } });
  let result = await useOrderStore.getState().placeOrder(draft(), placement);
  assert.deepEqual([result.success, result.definite], [false, false]);
  globalThis.__rpc = async () => { throw new Error("socket hang up"); };
  result = await useOrderStore.getState().placeOrder(draft(), placement);
  assert.deepEqual([result.success, result.definite], [false, false]);
  assert.equal(useOrderStore.getState().orders.length, 0);
});

// ═══ 5. The order screen: one placement path, one number per placement ═════

test("the only order_placed in the app goes through placeOrder", () => {
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(new URL(dir, root))) {
      const rel = `${dir}${name}`;
      if (statSync(new URL(rel, root)).isDirectory()) walk(`${rel}/`);
      else if (/\.(ts|tsx)$/.test(name) && /kind: "order_placed"/.test(code(read(rel)))) hits.push(rel);
    }
  };
  walk("src/");
  assert.deepEqual(hits, ["src/routes/ecommerce-orders.tsx"]);
  const route = code(read("src/routes/ecommerce-orders.tsx"));
  const kind = route.indexOf('kind: "order_placed"');
  assert.ok(route.lastIndexOf("await placeOrder(", kind) > route.lastIndexOf("runOnce(async", kind), "inside the placeOrder call");
  assert.doesNotMatch(route, /appendEvent|addOrder\(/, "no ledger-first path, no separate document write");
  assert.doesNotMatch(route, /buildOrderCancelledLines/, "nothing to compensate: a refusal leaves nothing behind");
});

test("the number survives an unconfirmed attempt and is released only on confirmation", () => {
  const route = code(read("src/routes/ecommerce-orders.tsx"));
  assert.match(route, /if \(pendingPlacement\.current\) \{\s*orderNumber = pendingPlacement\.current\.orderNumber;/);
  assert.match(route, /pendingPlacement\.current = \{ orderNumber, claimed: claimedDiscount \};/);
  const cleared = [...route.matchAll(/pendingPlacement\.current = null;/g)];
  assert.equal(cleared.length, 1, "cleared in one place");
  assert.ok(route.indexOf("pendingPlacement.current = null;") > route.indexOf("if (!placed.success)"), "…after the failure branch returns");
  assert.match(route, /if \(placed\.definite\) \{[\s\S]*?releaseDiscountUse/, "a definite refusal gives the discount use back");
  assert.match(route, /placed\.replayed/, "a replay is reported, not placed twice");
  assert.match(route, /if \(depositVal < 0 \|\| remaining_balance < 0\) return false;/, "the form offers no over-deposit (UX only)");
});
