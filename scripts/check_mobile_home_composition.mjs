/**
 * Mobile Home composition — what the deleted `homeComposer.ts` was meant to do,
 * proven on the composer Home actually renders.
 *
 *     node --test scripts/check_mobile_home_composition.mjs
 *
 * Forensics (2026-10-03):
 *   - `src/mobile/viewmodels/home/homeComposer.ts` (one file; it EXPORTED
 *     `composeHomeSections` — there was never a `composeHomeSections.ts`) was
 *     added in b354055 together with `data/mobileHomeReader.ts`, edited in
 *     e1025a3, and deleted in e1e8753 ("D1: delete dead homeComposer.ts").
 *   - From creation to deletion its only reference was a text-matching test;
 *     no screen or hook ever imported it. Home has always rendered
 *     `composeMobileHomeSnapshot`.
 *   - Its one piece of real logic the live composer never had: «الطلبات
 *     المتأخرة» — pending orders older than 24h. The live composer passed a
 *     hardcoded 0, later omitted it. It is now a server count.
 *
 * Everything below runs the REAL readers, composer, capabilities and alert
 * model against a fake PostgREST that answers exact counts by filter.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");
const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
globalThis.window ??= globalThis;

const NOW = new Date("2026-10-03T12:00:00Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600e3).toISOString();

// ── a fake PostgREST over in-memory orders ──────────────────────────────────
globalThis.__home = { role: "ADMIN", orders: [], shortages: [], fail: null, writes: [], reads: [] };
const STUBS = {
  "@/lib/supabase": stub(`
    const H = () => globalThis.__home;
    function from(source) {
      const filters = [];
      const q = {
        select() { return q; },
        is(c, v) { filters.push((r) => (r[c] ?? null) === v); return q; },
        eq(c, v) { filters.push((r) => r[c] === v); return q; },
        in(c, vs) { filters.push((r) => vs.includes(r[c])); return q; },
        gte(c, v) { filters.push((r) => String(r[c]) >= v); return q; },
        lt(c, v) { filters.push((r) => String(r[c]) < v); return q; },
        or() { return q; },
        order() { return q; },
        range(a, b) { q.from = a; q.to = b; return q; },
        insert() { H().writes.push(source); return q; },
        update() { H().writes.push(source); return q; },
        upsert() { H().writes.push(source); return q; },
        delete() { H().writes.push(source); return q; },
        then(ok, ko) {
          H().reads.push(source);
          if (H().fail === source) return Promise.resolve({ data: null, count: null, error: { message: "network down" } }).then(ok, ko);
          const rows = H().orders.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows.slice(q.from ?? 0, (q.to ?? rows.length) + 1), count: rows.length, error: null }).then(ok, ko);
        },
      };
      return q;
    }
    export const getSupabaseClient = () => ({
      from,
      rpc: async (name) => {
        H().reads.push("rpc:" + name);
        if (H().fail === "rpc:" + name) return { data: null, error: { message: "rpc down" } };
        return { data: H().shortages, error: null };
      },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      removeChannel() {},
    });
    export const isCloudSyncMode = () => true;`),
  "@/services/api/storeContext": stub(`export const getActiveStoreId = async () => "33333333-4444-4555-8666-777777777777";`),
  "@/store/useAuthStore": stub(`
    const state = () => ({ userRole: globalThis.__home.role, isAuthenticated: true });
    export const useAuthStore = Object.assign((sel) => sel(state()), { getState: state });`),
  "@/lib/ledger": stub(`export const balanceOf = async () => ({ qty: 0, amount: 0 });`),
};
const ts = (u) => (existsSync(fileURLToPath(u + ".ts")) ? u + ".ts" : u + "/index.ts");
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    if (specifier.startsWith("@/")) return next(ts(new URL(`src/${specifier.slice(2)}`, root).href), context);
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
      return next(ts(new URL(specifier, context.parentURL).href), context);
    return next(specifier, context);
  },
});

const { readMobileHomeSnapshot, composeMobileHomeSnapshot } = await import(new URL("src/mobile/data/mobileHomeReader.ts", root).href);
const { readSharedHomeSnapshot } = await import(new URL("src/mobile/data/useMobileHomeData.ts", root).href);
const { getMobileCapabilities } = await import(new URL("src/mobile/navigation/mobileCapabilities.ts", root).href);
const { AGING_ORDER_THRESHOLD_HOURS } = await import(new URL("src/mobile/viewmodels/alertModel.ts", root).href);

const ROLES = ["ADMIN", "ACCOUNTANT", "POS_ECOMMERCE", "ECOMMERCE_ONLY", "MODERATOR"];
const order = (id, status, createdAt, extra = {}) => ({
  id, orderNumber: `ORD-${id}`, customerName: `عميل ${id}`, status, createdAt, updatedAt: createdAt,
  totalAmount: 500, deleted_at: null, ...extra,
});
function fixture() {
  return [
    order("1", "pending", hoursAgo(1)),            // today, pending, fresh
    order("2", "pending", hoursAgo(30)),           // pending, AGING
    order("3", "pending", hoursAgo(72)),           // pending, AGING
    order("4", "pending", hoursAgo(80), { deleted_at: "2026-10-02T00:00:00Z" }), // deleted: never counts
    order("5", "shipped", hoursAgo(40)),           // in transit
    order("6", "delivered", hoursAgo(50)),         // done
    order("7", "pending", hoursAgo(25)),           // pending, AGING
  ];
}
const shortages = [
  { product_id: "p1", product_name: "قميص", sku: "S1", stock: 0, required: 3, deficit: 3, order_count: 2, waiting_orders: [] },
  { product_id: "p2", product_name: "بنطلون", sku: "S2", stock: 1, required: 2, deficit: 1, order_count: 0, waiting_orders: [] },
];
function setup(role, overrides = {}) {
  Object.assign(globalThis.__home, { role, orders: fixture(), shortages, fail: null, writes: [], reads: [] }, overrides);
}
async function home(role, { licenseAtRisk = false } = {}) {
  const caps = getMobileCapabilities(role);
  const snap = await readMobileHomeSnapshot(caps, NOW);
  return { caps, snap, composed: composeMobileHomeSnapshot(snap, caps, licenseAtRisk) };
}

/** The deleted composer's own rule, verbatim in substance (status + age). */
function originalAgingRule(orders, now) {
  return orders.filter((o) => {
    const age = now.getTime() - new Date(o.createdAt).getTime();
    return o.status === "pending" && Number.isFinite(age) && age > AGING_ORDER_THRESHOLD_HOURS * 3600e3;
  }).length;
}

// ── 1–4: data loads and sections compose, in order, with their data ─────────

test("Home loads and composes alerts, metrics and the three queues in their fixed order", async () => {
  setup("ADMIN");
  const { snap, composed } = await home("ADMIN");
  assert.equal(snap.pendingOrders, 4, "server count of #1 #2 #3 #7; the deleted #4 never counts");
  assert.deepEqual(composed.metrics.map((m) => m.id), ["today_orders", "pending_orders", "shortage_products"]);
  assert.deepEqual(composed.queues.map((q) => q.id), ["orders", "stock", "shipments"]);
  const [orders, stock, shipments] = composed.queues;
  assert.equal(orders.count, 4);
  assert.ok(orders.rows.length <= 3 && orders.rows.every((r) => r.href.startsWith("/orders/")));
  assert.equal(stock.count, 2);
  assert.equal(stock.rows[0].href, "/inventory/p1");
  assert.equal(shipments.count, 1);
  assert.equal(shipments.rows[0].title, "ORD-5");
});

// ── 10/12: the historical calculation that never shipped, now real ──────────

test("REGRESSION: «الطلبات المتأخرة» counts pending orders older than 24h — the deleted composer's rule, on the server", async () => {
  setup("ADMIN");
  const { snap, composed } = await home("ADMIN");
  const live = fixture().filter((o) => o.deleted_at === null);
  assert.equal(snap.agingPendingOrders, originalAgingRule(live, NOW), "same answer as the original algorithm");
  assert.equal(snap.agingPendingOrders, 3);
  const aging = composed.alerts.find((a) => a.id === "aging_pending_orders");
  assert.ok(aging, "the alert is shown");
  assert.equal(aging.count, 3);
  assert.equal(aging.href, "/orders");
});

test("no aging orders is a real 0 (asked, none) and shows no alert", async () => {
  setup("ADMIN", { orders: [order("9", "pending", hoursAgo(2))] });
  const { snap, composed } = await home("ADMIN");
  assert.equal(snap.agingPendingOrders, 0);
  assert.equal(composed.alerts.some((a) => a.id === "aging_pending_orders"), false);
});

test("the still-unanswerable signals stay omitted, never a fake all-clear", async () => {
  setup("ADMIN");
  const { composed } = await home("ADMIN");
  assert.equal(composed.alerts.some((a) => a.id === "long_in_transit" || a.id === "unsettled_cod"), false);
  assert.doesNotMatch(read("src/mobile/data/mobileHomeReader.ts"), /longInTransitOrders:\s*0|unsettledCodOrders:\s*0|agingPendingOrders:\s*0/);
});

// ── 8/9: roles ───────────────────────────────────────────────────────────────

test("every role sees exactly the sections its capabilities allow", async () => {
  for (const role of ROLES) {
    setup(role);
    const { caps, snap, composed } = await home(role);
    for (const q of composed.queues) assert.ok(caps.has(q.id === "orders" ? "orders" : q.id), `${role}: queue ${q.id}`);
    for (const m of composed.metrics) assert.ok(caps.has(m.capability), `${role}: metric ${m.id}`);
    for (const a of composed.alerts) assert.ok(caps.has(a.capability), `${role}: alert ${a.id}`);
    // Without `orders` nothing about orders is even asked.
    if (!caps.has("orders")) assert.equal(snap.agingPendingOrders, undefined, `${role}: not asked`);
  }
});

test("MODERATOR: full read-only Home — orders, shortages, shipments and the aging alert; no write, no restock", async () => {
  setup("MODERATOR");
  const { composed } = await home("MODERATOR");
  assert.deepEqual(composed.queues.map((q) => q.id), ["orders", "stock", "shipments"]);
  assert.ok(composed.alerts.some((a) => a.id === "aging_pending_orders"));
  assert.deepEqual(globalThis.__home.writes, [], "Home never writes");
  const screen = read("src/mobile/screens/MobileHomeScreen.tsx");
  assert.match(screen, /capabilities\.has\("purchasing"\) && <Link to="\/restock">/, "restock only behind purchasing");
  assert.equal(getMobileCapabilities("MODERATOR").has("purchasing"), false);
});

// ── 5–7: loading, empty, error ──────────────────────────────────────────────

test("EMPTY: a quiet store composes no alerts and no queues, zeros in the metrics", async () => {
  setup("ADMIN", { orders: [], shortages: [] });
  const { composed } = await home("ADMIN");
  assert.deepEqual(composed.alerts, []);
  assert.deepEqual(composed.queues, []);
  assert.deepEqual(composed.metrics.map((m) => m.value), ["٠", "٠", "٠"]);
});

test("ERROR: a failed read rejects Home — and is NOT cached, so retry asks again", async () => {
  for (const fail of ["orders_operational", "rpc:mobile_shortages"]) {
    setup("ADMIN", { fail });
    const caps = getMobileCapabilities("ADMIN");
    await assert.rejects(readSharedHomeSnapshot(caps, false), `${fail} must surface`);
    globalThis.__home.fail = null;
    const composed = await readSharedHomeSnapshot(caps, false);
    assert.ok(composed.queues.length > 0, `${fail}: retry recovered`);
  }
});

test("the license-at-risk alert still composes alongside the others", async () => {
  setup("ADMIN");
  const { composed } = await home("ADMIN", { licenseAtRisk: true });
  assert.ok(composed.alerts.some((a) => /license/.test(a.id)));
});

test("SCREEN: offline → skeleton → error with retry → alerts or empty; quick actions gated", () => {
  const screen = read("src/mobile/screens/MobileHomeScreen.tsx");
  const order = ["<OfflineState />", "<SkeletonState count={3} />", "<ErrorState", "home.alerts.map", "<EmptyState"];
  const at = order.map((s) => screen.indexOf(s));
  assert.ok(at.every((i) => i > 0) && at.every((i, k) => k === 0 || i > at[k - 1]), "state precedence");
  assert.match(screen, /onRetry=\{homeData\.reload\}/);
  for (const [cap, to] of [["orders", "/orders"], ["stock", "/inventory"], ["customers", "/customers"], ["purchasing", "/restock"]]) {
    assert.match(screen, new RegExp(`capabilities\\.has\\("${cap}"\\) && <Link to="${to}">`));
  }
  const hook = read("src/mobile/data/useMobileHomeData.ts");
  assert.match(hook, /loading: current\.data === null/, "skeleton only when nothing is on screen");
});

// ── 8 (static): one composer, no dangling remains ───────────────────────────

test("one Home composer: the dead file stays deleted and nothing references its names", () => {
  assert.equal(existsSync(new URL("src/mobile/viewmodels/home/homeComposer.ts", root)), false);
  assert.equal(existsSync(new URL("src/mobile/viewmodels/composeHomeSections.ts", root)), false);
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = `${dir}/${n}`;
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
  const offenders = walk(fileURLToPath(new URL("src", root)))
    .filter((p) => /import[^;]*(homeComposer|composeHomeSections)|composeHomeSections\(/.test(readFileSync(p, "utf8")));
  assert.deepEqual(offenders, []);
  assert.match(read("src/mobile/data/useMobileHomeData.ts"), /composeMobileHomeSnapshot\(snapshot, capabilities, licenseAtRisk\)/);
});
