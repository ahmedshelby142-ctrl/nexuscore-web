/**
 * MODERATOR = operations supervisor: sees orders, stock, shipments, customers
 * and every SELLING figure; never what the shop PAID.
 *
 *     node --test scripts/check_moderator_visibility.mjs
 *
 * What this pins (audit 2026-09-27):
 *
 * - Mobile order reads used `select("*")`, which sent every order's
 *   `cogsAmount` to every role; line `unitCost` rode inside `stockItems`.
 * - Mobile product reads handed the Moderator the shelf's cost, and Product
 *   Details printed unit cost, stock value and margin to it.
 * - Desktop hydrated EVERY business table — expenses, partner transactions,
 *   purchase invoices, supplier payables, order COGS — into a Moderator's
 *   browser whose only Desktop screen is `/preferences`, and realtime kept
 *   pushing rows to it.
 *
 * The readers and the hydrator run for real against stubbed Supabase/stores.
 * The database boundary itself (047/048) is pinned by
 * `check_read_security_048.mjs` and proven by the rolled-back SQL matrix in
 * `scripts/security/047_048_read_matrix.sql`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");
const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;

// ── Shared, settable fakes ──────────────────────────────────────────────────
globalThis.__auth = { isAuthenticated: true, userRole: "ADMIN" };
globalThis.__selects = [];
globalThis.__rpc = [];
globalThis.__balances = [];
globalThis.__cloudList = [];
globalThis.__rows = {
  orders: [{
    id: "o1", orderNumber: "ECO-1", customerName: "أحمد", customerPhone: "010", address: "الدقي",
    status: "pending", totalAmount: 250, expectedCod: 310, shippingFee: 60, courierName: "بوسطة", courierFee: 45,
    items: [{ productId: "p1", quantity: 1, unitPrice: 250, unitCost: 140 }],
    stockItems: [{ productId: "p1", quantity: 1, unitPrice: 250, unitCost: 140 }],
  }],
  products: [{ id: "p1", name: "بلوزة", sku: "S1", unitPrice: 250 }],
};

const STORE = (name, extra = "") => stub(`export const ${name} = { setState() {}, getState() { return { ${extra} }; } };`);
const STUBS = {
  "@/store/useAuthStore": stub(`export const useAuthStore = { getState: () => globalThis.__auth };`),
  "@/lib/supabase": stub(`
    const q = (table) => {
      const b = { table, cols: null,
        select(cols) { b.cols = cols; globalThis.__selects.push({ table, cols }); return b; },
        is() { return b; }, eq() { return b; }, in() { return b; }, gte() { return b; }, neq() { return b; },
        or() { return b; }, order() { return b; }, range() { return b; }, limit() { return b; }, maybeSingle() { b.single = true; return b; },
        then(res) {
          // orders_operational is served as migration 047 defines it: no
          // cogsAmount for anyone; courierFee and line unitCost only for a
          // finance role. (The SQL itself is proven by the 047/048 matrix.)
          const finance = globalThis.__auth.userRole !== "MODERATOR";
          const strip = (lines) => Array.isArray(lines) ? lines.map(({ unitCost, ...l }) => l) : lines;
          const rows = table === "orders_operational"
            ? (globalThis.__rows.orders ?? []).map(({ cogsAmount, ...o }) => finance ? o : { ...o, courierFee: null, items: strip(o.items), stockItems: strip(o.stockItems) })
            : (globalThis.__rows[table] ?? []);
          return Promise.resolve({ data: b.single ? rows[0] ?? null : rows, count: rows.length, error: null }).then(res);
        },
      };
      return b;
    };
    const rpc = async (name, args) => {
      globalThis.__rpc.push(name);
      if (name === "mobile_stock_quantities") return { data: args.p_product_ids.map((id) => ({ product_id: id, qty: 3 })), error: null };
      if (name === "mobile_order_timeline") return { data: [{ id: "e1", kind: "order_placed", occurred_at: "2026-09-27T00:00:00Z" }], error: null };
      return { data: null, error: { message: "unknown rpc " + name } };
    };
    export const getSupabaseClient = () => ({ from: q, rpc });
    export const isCloudSyncMode = () => true;`),
  "@/services/api/fieldMapping": stub(`export const fromRemoteRow = (_t, row) => ({ ...row });`),
  "@/lib/ledger": stub(`export const balanceOf = async (account) => { globalThis.__balances.push(account); return account === "customer_ltv" ? { qty: 0, amount: 999 } : { qty: 3, amount: 420 }; }; export const events = async () => [];`),
  "@/lib/product": stub(`export const buildableFromRecipe = () => 0; export const variantStockFrom = () => 0;`),
  // cloudHydrate's collaborators
  "@/lib/ledger/stockSnapshot": stub(`export const clearStockSnapshot = () => {};`),
  "@/store/useSyncStatus": stub(`export const useSyncStatus = { getState: () => ({ markTable() {}, markSyncing() {}, markSynced() {} }) };`),
  "./cloudData": stub(`export const cloudList = async (t) => { globalThis.__cloudList.push(t); return []; };
    export const cloudUpsert = async () => {}; export const cloudDelete = async () => {};`),
  "@/store/useBusinessStore": STORE("useBusinessStore"),
  "@/store/useCourierStore": STORE("useCourierStore"),
  "@/store/useCustomerStore": STORE("useCustomerStore"),
  "@/store/useBranchStore": STORE("useBranchStore"),
  "@/store/useOrderStore": STORE("useOrderStore"),
  "@/store/useFinancialStore": STORE("useFinancialStore"),
  "@/store/useSettingsStore": STORE("useSettingsStore", "pullSettings: async () => {}"),
  "@/store/useShippingRatesStore": STORE("useShippingRatesStore"),
};
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    if (specifier.startsWith("@/")) return next(new URL(`src/${specifier.slice(2)}.ts`, root).href, context);
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});

const roles = await import(new URL("src/lib/roles.ts", root).href);
const readers = await import(new URL("src/mobile/data/mobileReaders.ts", root).href);
const hydrate = await import(new URL("src/services/cloudHydrate.ts", root).href);
const { getMobileCapabilities } = await import(new URL("src/mobile/navigation/mobileCapabilities.ts", root).href);
const { realtimeTablesFor } = await import(new URL("src/mobile/data/useMobileRealtime.ts", root).href);

const as = (role, authenticated = true) => { globalThis.__auth = { isAuthenticated: authenticated, userRole: role }; };
const orderSelect = () => globalThis.__selects.filter((s) => s.table === "orders_operational").at(-1).cols;

// ── The role rule itself ────────────────────────────────────────────────────

test("only MODERATOR loses cost; every other role keeps it", () => {
  assert.equal(roles.canViewCost("MODERATOR"), false);
  for (const role of ["ADMIN", "ACCOUNTANT", "POS_ECOMMERCE", "ECOMMERCE_ONLY"]) {
    assert.equal(roles.canViewCost(role), true, `${role} is unchanged`);
    assert.equal(roles.readsDesktopBusinessData(role), true, `${role} still hydrates on Desktop`);
  }
  assert.equal(roles.readsDesktopBusinessData("MODERATOR"), false);
});

// ── Mobile readers: what the Moderator's app actually holds ─────────────────

test("a Moderator's order read never selects COGS or the courier fee, and drops line cost", async () => {
  as("MODERATOR");
  const page = await readers.readMobileOrders({ pageSize: 25 });
  const cols = orderSelect().split(",");
  assert.ok(!cols.includes("*"), "no select(*) on orders");
  assert.ok(!cols.includes("cogsAmount"), "COGS is never requested");
  assert.ok(!cols.includes("courierFee"), "delivery cost is not requested for a Moderator");
  const order = page.rows[0];
  for (const line of [...order.items, ...order.stockItems]) {
    assert.equal("unitCost" in line, false, "line cost does not reach the Moderator's app state");
    assert.equal(line.unitPrice, 250, "the SELLING price stays");
  }
});

test("a Moderator keeps every operational order field it supervises with", async () => {
  as("MODERATOR");
  await readers.readMobileOrders({});
  const cols = orderSelect().split(",");
  for (const field of ["orderNumber", "status", "customerName", "customerPhone", "address", "items",
    "totalAmount", "shippingFee", "expectedCod", "depositAmount", "courierName", "codSettledAt", "createdAt"]) {
    assert.ok(cols.includes(field), `${field} is still read`);
  }
  // Shipments and a customer's history go through the same projection.
  await readers.readMobileShipments({});
  assert.ok(!orderSelect().includes("cogsAmount"));
  await readers.readMobileCustomerOrderHistory("c1");
  assert.ok(!orderSelect().includes("cogsAmount"));
});

test("ADMIN still receives the courier fee and line cost; COGS stays out for everyone", async () => {
  as("ADMIN");
  const page = await readers.readMobileOrders({});
  const cols = orderSelect().split(",");
  assert.ok(cols.includes("courierFee"));
  assert.ok(!cols.includes("cogsAmount"), "no mobile screen shows COGS, so no role needs it here");
  assert.equal(page.rows[0].stockItems[0].unitCost, 140);
});

test("stock quantity reaches the Moderator; the shelf's cost does not", async () => {
  as("MODERATOR");
  globalThis.__rpc = []; globalThis.__balances = [];
  const product = await readers.readMobileProduct("p1");
  assert.equal(product.mobileStock, 3, "ledger quantity is operational");
  assert.equal(product.mobileCost, undefined, "cost is not held — not zero, absent");
  assert.deepEqual(globalThis.__rpc, ["mobile_stock_quantities"], "the no-money quantity path (047)");
  assert.deepEqual(globalThis.__balances, [], "a Moderator never asks the ledger (048 refuses it)");
  as("ADMIN");
  assert.equal((await readers.readMobileProduct("p1")).mobileCost, 420, "ADMIN unchanged");
  as("ACCOUNTANT");
  assert.equal((await readers.readMobileProduct("p1")).mobileCost, 420, "ACCOUNTANT unchanged");
});

test("every Mobile order read goes through the operational projection", async () => {
  for (const role of ["MODERATOR", "ADMIN"]) {
    as(role);
    globalThis.__selects = [];
    await readers.readMobileOrders({});
    await readers.readMobileShipments({});
    await readers.readMobileCustomerOrderHistory("c1");
    await readers.readMobileCustomers({});
    await readers.readMobileProductWaitingOrders("p1");
    await readers.readMobileCustomerFinancialSummary("c1");
    await readers.readMobileOrderTimeline("o1");
    const tables = new Set(globalThis.__selects.map((x) => x.table));
    assert.ok(!tables.has("orders"), `${role}: no Mobile read selects the orders TABLE (048 refuses it to a Moderator)`);
    assert.ok(tables.has("orders_operational"));
  }
});

test("the order timeline reads events without payload, for every role", async () => {
  as("MODERATOR");
  globalThis.__rpc = [];
  const timeline = await readers.readMobileOrderTimeline("o1");
  assert.deepEqual(globalThis.__rpc, ["mobile_order_timeline"]);
  assert.equal(timeline.find((e) => e.status === "order_placed")?.labelAr, "تم إنشاء الطلب");
});

test("a Moderator's customer summary carries no lifetime revenue — null, not 0", async () => {
  as("MODERATOR");
  globalThis.__balances = [];
  const summary = await readers.readMobileCustomerFinancialSummary("c1");
  assert.equal(summary.deliveredRevenue, null);
  assert.deepEqual(globalThis.__balances, [], "customer_ltv is not asked for");
  assert.equal(typeof summary.openExposure, "number", "operational COD exposure stays");
  as("ADMIN");
  assert.equal((await readers.readMobileCustomerFinancialSummary("c1")).deliveredRevenue, 999, "ADMIN unchanged");
  const screen = read("src/mobile/screens/MobileCustomerDetails.tsx");
  assert.match(screen, /financials\.deliveredRevenue !== null && \(/, "the tile is absent, not «٠»");
});

// ── Mobile screens ──────────────────────────────────────────────────────────

test("Product Details shows no cost, stock value or margin to a Moderator", () => {
  const src = read("src/mobile/screens/MobileProductDetails.tsx");
  assert.match(src, /const \{ cost: showCost, internal: showInternal \} = useMobileVisibility\(\);/);
  assert.match(read("src/mobile/navigation/mobileVisibility.ts"), /const cost = canViewCost\(role\);/, "the policy is the existing gate");
  assert.match(src, /\{showCost && \(\n\s*<>\n\s*<div>\n\s*<span>متوسط التكلفة \(المرجح\)<\/span>/);
  assert.match(src, /showCost && avgCost > 0 && retailPrice > 0/, "retail margin");
  assert.match(src, /showCost && avgCost > 0 && wholesalePrice > 0/, "wholesale margin");
  // Selling prices are operational and stay unconditional.
  assert.match(src, /<span>سعر البيع \(قطاعي\)<\/span>/);
});

test("Order Details shows no courier commission to a Moderator", () => {
  assert.match(read("src/mobile/screens/MobileOrderDetails.tsx"), /showCost && courierFee > 0 && <div className="mobile-detail-line"><span>عمولة المندوب<\/span>/);
});

test("the Moderator's Mobile surface is exactly the operational one", () => {
  assert.deepEqual([...getMobileCapabilities("MODERATOR")].sort(),
    ["customers", "home", "more", "orders", "preferences", "shipments", "stock"]);
  assert.ok(!getMobileCapabilities("MODERATOR").has("owner"), "no owner finance");
  assert.ok(!getMobileCapabilities("MODERATOR").has("purchasing"), "no purchasing / supplier finance / restock");
  // Other roles unchanged.
  assert.ok(getMobileCapabilities("ADMIN").has("owner"));
  assert.ok(getMobileCapabilities("ACCOUNTANT").has("purchasing"));
  assert.ok(!getMobileCapabilities("ACCOUNTANT").has("owner"));
  assert.ok(!getMobileCapabilities("ECOMMERCE_ONLY").has("owner"));
});

test("a Moderator's socket is not subscribed to supplier invoices", () => {
  // postgres_changes delivers the whole row: a subscription IS a read.
  assert.deepEqual(realtimeTablesFor("MODERATOR"), ["products", "customers", "store_activity"]);
  // No role subscribes to order or ledger ROWS on Mobile any more: they carry
  // cost, and 048 refuses them to a Moderator. store_activity (047) is the cue.
  for (const role of ["ADMIN", "ACCOUNTANT", "POS_ECOMMERCE", "ECOMMERCE_ONLY", "MODERATOR"]) {
    const tables = realtimeTablesFor(role);
    assert.ok(!tables.includes("orders") && !tables.includes("ledger_events"), `${role} is not sent order/ledger rows`);
    assert.ok(tables.includes("store_activity"), `${role} still hears orders and ledger changes`);
  }
  for (const role of ["ADMIN", "ACCOUNTANT"]) {
    assert.ok(realtimeTablesFor(role).includes("purchase_invoices"), `${role} keeps its purchasing refresh`);
  }
  for (const role of ["POS_ECOMMERCE", "ECOMMERCE_ONLY"]) {
    assert.ok(!realtimeTablesFor(role).includes("purchase_invoices"), `${role} has no purchasing screen either`);
  }
  // The table set follows the verified role, and a changed set is rebuilt.
  const src = read("src/mobile/data/useMobileRealtime.ts");
  assert.match(src, /openChannel\(realtimeTablesFor\(role\)\)/);
  assert.match(src, /if \(channel && channelTables === key\) return;/);
  assert.match(src, /if \(channel\) closeChannel\(\);/);
});

// ── Desktop ─────────────────────────────────────────────────────────────────

test("a Moderator's Desktop reads no business table at all", async () => {
  as("MODERATOR");
  globalThis.__cloudList = [];
  await hydrate.hydrateAll();
  await hydrate.hydrateTable("expenses");
  await hydrate.hydrateTable("transactions");
  assert.deepEqual(globalThis.__cloudList, [], "no expenses, partners, purchases, orders or products");
});

test("nothing is read before the membership role is resolved", async () => {
  as("ADMIN", false);
  globalThis.__cloudList = [];
  await hydrate.hydrateAll();
  assert.deepEqual(globalThis.__cloudList, []);
});

test("ADMIN and ACCOUNTANT Desktop hydration is unchanged", async () => {
  for (const role of ["ADMIN", "ACCOUNTANT", "POS_ECOMMERCE", "ECOMMERCE_ONLY"]) {
    as(role);
    globalThis.__cloudList = [];
    await hydrate.hydrateAll();
    for (const table of ["products", "orders", "customers", "expenses", "purchase_invoices", "transactions"]) {
      assert.ok(globalThis.__cloudList.includes(table), `${role} still hydrates ${table}`);
    }
  }
});

test("realtime is not subscribed for a role with no Desktop business surface", () => {
  const src = read("src/hooks/useRealtimeSync.ts");
  assert.match(src, /const receivesBusinessRows = useAuthStore\(\n\s*\(s\) => s\.isAuthenticated && readsDesktopBusinessData\(s\.userRole\),\n\s*\);/);
  assert.match(src, /if \(isCloudSyncMode\(\) && authenticated && receivesBusinessRows\) \{/);
  assert.match(src, /\}, \[authenticated, receivesBusinessRows\]\);/);
});

test("a typed URL cannot put a Moderator on a Desktop screen", () => {
  for (const path of ["/", "/owner", "/purchasing", "/partners", "/settings", "/users", "/backups", "/integrations",
    "/courier-ledger", "/inventory", "/products", "/orders", "/ecommerce-orders", "/crm", "/returns", "/wholesale",
    "/stock-audit", "/credit-invoices", "/system-admin/licenses"]) {
    assert.equal(roles.canAccess("MODERATOR", path), false, `MODERATOR must not reach ${path}`);
  }
  assert.equal(roles.canAccess("MODERATOR", "/preferences"), true);
  assert.equal(roles.homeFor("MODERATOR"), "/mobile-app");
  // Desktop access for the other roles is untouched.
  assert.equal(roles.canAccess("ADMIN", "/partners"), true);
  assert.equal(roles.canAccess("ACCOUNTANT", "/purchasing"), true);
  assert.equal(roles.canAccess("POS_ECOMMERCE", "/pos"), true);
  assert.equal(roles.canAccess("ECOMMERCE_ONLY", "/inventory"), true);
  assert.equal(roles.canAccess("ECOMMERCE_ONLY", "/purchasing"), false);
});

test("a typed URL cannot put a Moderator on a Mobile finance screen", () => {
  const router = read("src/mobile/router.tsx");
  assert.match(router, /<MobileRouteGuard capability="owner" \/>\}><Route path="owner"/);
  assert.match(router, /<MobileRouteGuard capability="purchasing" \/>\}><Route path="purchasing" element=\{onDemand\(<MobilePurchasingScreen \/>\)\} \/><Route path="restock"/);
});
