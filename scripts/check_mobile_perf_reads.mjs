/**
 * What Mobile Home actually asks the server — measured, then trimmed.
 *
 * Measured on Production (c8b337c, Moderator Home, warm start): 11 requests in
 * four sequential steps, ≈1.7 s to complete:
 *   - `status=pending` was asked TWICE (a count and the «تحتاج إجراء» preview,
 *     the same filter);
 *   - three counters each downloaded a full order (36 columns, line items) to
 *     read one number;
 *   - `mobile_shortages` waited behind `auth/user` + a SECOND `store_members`
 *     read that session start had already made.
 * These tests pin the trimmed shape against a fake PostgREST that records
 * every query, with the real readers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");
const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem: () => "device-1", setItem() {} };

globalThis.__q = { role: "MODERATOR", log: [], auth: 0 };
const STUBS = {
  "@/lib/supabase": stub(`
    const Q = () => globalThis.__q;
    function from(source) {
      const entry = { source, select: null, head: false, filters: [], range: null };
      const q = {
        select(cols, opts) { entry.select = cols; entry.head = Boolean(opts && opts.head); return q; },
        is(c, v) { entry.filters.push(c + " is " + v); return q; },
        eq(c, v) { entry.filters.push(c + "=" + v); return q; },
        in(c, v) { entry.filters.push(c + " in " + v); return q; },
        gte(c, v) { entry.filters.push(c + ">=" + v); return q; },
        lt(c, v) { entry.filters.push(c + "<" + v); return q; },
        or() { return q; }, order() { return q; }, maybeSingle() { return q; },
        range(a, b) { entry.range = a + "-" + b; return q; },
        then(ok, ko) {
          Q().log.push(entry);
          const data = source === "store_members" ? { store_id: "33333333-4444-4555-8666-777777777777" } : entry.head ? null : [];
          return Promise.resolve({ data, count: 0, error: null }).then(ok, ko);
        },
      };
      return q;
    }
    export const getSupabaseClient = () => ({
      from,
      rpc: async (name) => { globalThis.__q.log.push({ source: "rpc:" + name }); return { data: [], error: null }; },
      auth: { getUser: async () => { globalThis.__q.auth++; return { data: { user: { id: "u1" } } }; } },
    });
    export const isCloudSyncMode = () => true;`),
  "@/store/useAuthStore": stub(`
    const state = () => ({ userRole: globalThis.__q.role, isAuthenticated: true });
    export const useAuthStore = Object.assign((sel) => sel(state()), { getState: state });`),
  "@/lib/ledger": stub(`export const balanceOf = async () => ({ qty: 0, amount: 0 });`),
};
const ts = (u) => (existsSync(fileURLToPath(u + ".ts")) ? u + ".ts" : u + "/index.ts");
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    if (specifier.startsWith("@/")) return next(ts(new URL(`src/${specifier.slice(2)}`, root).href), context);
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return next(ts(new URL(specifier, context.parentURL).href), context);
    return next(specifier, context);
  },
});

const store = await import(new URL("src/services/api/storeContext.ts", root).href);
const { readMobileHomeSnapshot } = await import(new URL("src/mobile/data/mobileHomeReader.ts", root).href);
const { countMobileOrders } = await import(new URL("src/mobile/data/mobileReaders.ts", root).href);
const { getMobileCapabilities } = await import(new URL("src/mobile/navigation/mobileCapabilities.ts", root).href);

const STORE = "33333333-4444-4555-8666-777777777777";
const reset = (role = "MODERATOR") => { globalThis.__q.log = []; globalThis.__q.auth = 0; globalThis.__q.role = role; };
const orderReads = () => globalThis.__q.log.filter((e) => e.source === "orders_operational");
const key = (e) => `${e.head ? "HEAD" : "GET"} ${e.filters.join("&")} ${e.range ?? ""}`;

test("store id: seeded from session start, it costs no `auth/user` and no second `store_members`", async () => {
  store.clearStoreIdCache(); reset();
  store.primeActiveStoreId(STORE);
  assert.equal(await store.getActiveStoreId(), STORE);
  assert.equal(globalThis.__q.auth, 0);
  assert.equal(globalThis.__q.log.length, 0);
});

test("store id: never replaced, never seeded with junk, and still resolved from the server when not seeded", async () => {
  store.clearStoreIdCache(); reset();
  store.primeActiveStoreId(STORE);
  store.primeActiveStoreId("44444444-4444-4555-8666-777777777777");
  assert.equal(await store.getActiveStoreId(), STORE, "a seed never overwrites");
  store.clearStoreIdCache();
  for (const junk of [null, undefined, "", "not-a-uuid", 42]) store.primeActiveStoreId(junk);
  assert.equal(await store.getActiveStoreId(), STORE, "fell through to the server");
  assert.equal(globalThis.__q.auth, 1, "the original path is intact");
  assert.equal(globalThis.__q.log.filter((e) => e.source === "store_members").length, 1);
});

test("session start seeds it from the membership row it already reads", () => {
  const src = read("src/lib/auth/useSessionReconciliation.ts");
  assert.match(src, /\.select\("role, store_id"\)/);
  assert.match(src, /if \(!membershipError\) primeActiveStoreId\(membership\?\.store_id\);/);
});

test("counters are count-only: HEAD, exact count, the list's own filters", async () => {
  reset();
  await countMobileOrders({ status: "pending", createdBefore: "2026-10-02T00:00:00.000Z" });
  const [e] = orderReads();
  assert.equal(e.head, true);
  assert.equal(e.select, "id");
  assert.deepEqual(e.filters, ["deleted_at is null", "status=pending", "createdAt<2026-10-02T00:00:00.000Z"]);
});

for (const role of ["MODERATOR", "ADMIN"]) {
  test(`${role} Home: no order query is asked twice, and only the previews download rows`, async () => {
    store.clearStoreIdCache(); store.primeActiveStoreId(STORE); reset(role);
    await readMobileHomeSnapshot(getMobileCapabilities(role), new Date("2026-10-03T12:00:00Z"));
    const reads = orderReads();
    const keys = reads.map(key);
    assert.equal(new Set(keys).size, keys.length, `duplicates: ${keys.join(" | ")}`);
    assert.equal(reads.filter((e) => e.head).length, 2, "today + aging are counts");
    assert.equal(reads.filter((e) => !e.head).length, 2, "the «تحتاج إجراء» and «الشحنات» previews");
    assert.ok(reads.filter((e) => !e.head).every((e) => e.range === "0-2"), "previews are 3 rows");
    assert.equal(globalThis.__q.auth, 0, "no auth/user round-trip before shortages");
    assert.equal(globalThis.__q.log.filter((e) => e.source === "store_members").length, 0);
    assert.equal(globalThis.__q.log.filter((e) => e.source === "rpc:mobile_shortages").length, 1);
  });
}

test("«قيد الانتظار» is the preview's own exact count — the same filter, asked once", () => {
  const src = read("src/mobile/data/mobileHomeReader.ts");
  assert.match(src, /pendingOrders: orders\.total \?\? 0,/);
  assert.match(src, /readMobileOrders\(\{ queue: "action", pageSize: 3 \}\)/);
  assert.match(read("src/mobile/data/mobileReaders.ts"), /if \(query\.queue === "action"\) next = next\.eq\("status", "pending"\);/);
});

test("rarely used, write-heavy screens load on demand; first-paint screens do not", () => {
  const router = read("src/mobile/router.tsx");
  assert.match(router, /const MobilePurchasingScreen = lazy\(/);
  assert.match(router, /const MobileQuickRestock = lazy\(/);
  for (const eager of ["MobileHomeScreen", "MobileOrdersScreen", "MobileOrderDetails", "MobileCustomersScreen", "MobileCustomerDetails", "MobileOwnerScreen", "MobileLogin"]) {
    assert.match(router, new RegExp(`import \\{ ${eager} \\} from`), `${eager} stays in the first bundle`);
  }
});
