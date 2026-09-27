/**
 * Mobile UX/UI polish — the defects that were visible, pinned.
 *
 *     node --test scripts/check_mobile_ux_polish.mjs
 *
 * Found by rendering every mobile screen against a stubbed backend at
 * 320–414px, light and dark:
 *
 * - Home's stockout alert was handed the ORDER count and printed «٩ منتجات»
 *   for three products; the same shortage set was re-announced as «مخزون
 *   منخفض» (a min-level claim Home never reads) and as a «بمخزون منخفض»
 *   metric; the action queue printed a raw `totalAmount` («250»).
 * - Product detail showed the ledger stock AMOUNT (cost of the whole shelf) as
 *   the unit cost, so stock value was qty × total and every margin negative.
 * - `--warning` / `--info` were never defined: status pills were bare text.
 * - Inline empty/error states inherited the full-page 100dvh.
 * - Quick restock's quantity/cost grid was overridden into a stacked row.
 * - Owner amounts were forced LTR, which moved the «.» of «ج.م.».
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");

const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
const STUBS = {
  "@/lib/supabase": stub(`export const getSupabaseClient = () => null;`),
  "@/services/api/storeContext": stub(`export const getActiveStoreId = async () => null;`),
  "./mobileReaders": stub(`export const readMobileOrders = () => { throw new Error("not read here"); };
    export const readMobileShipments = readMobileOrders;`),
};
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    if (specifier.startsWith("@/")) return next(new URL(`src/${specifier.slice(2)}.ts`, root).href, context);
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});

const { composeMobileHomeSnapshot } = await import(new URL("src/mobile/data/mobileHomeReader.ts", root).href);

const CAPS = new Set(["home", "orders", "stock", "shipments"]);
const shortage = (id, orderCount, deficit) => ({
  product_id: id, product_name: id, sku: id, stock: 0, required: deficit, deficit, order_count: orderCount, waiting_orders: [],
});
const snapshot = {
  todayOrders: 4,
  pendingOrders: 2,
  orders: [{ id: "o1", orderNumber: "ECO-1", customerName: "أحمد", status: "pending", totalAmount: 250 }],
  shipments: [],
  shipmentsTotal: 0,
  shortages: [shortage("p1", 2, 3), shortage("p2", 3, 4), shortage("p3", 0, 1)],
};

test("the stockout alert counts PRODUCTS, the orders alert counts ORDERS", () => {
  const { alerts } = composeMobileHomeSnapshot(snapshot, CAPS, false);
  const products = alerts.find((a) => a.id === "stockout_with_waiting_orders");
  const orders = alerts.find((a) => a.id === "orders_with_stockout");
  assert.equal(products.count, 2, "two products are short WITH orders waiting — not the five orders");
  assert.equal(orders.count, 5);
  assert.equal(products.href, "/inventory/shortages", "the alert opens the list that resolves it");
  assert.match(products.messageAr, /^٢ منتجات/, "counts read in the same digits as the rest of the app");
});

test("Home does not re-announce shortages as min-level low stock", () => {
  const { alerts, metrics } = composeMobileHomeSnapshot(snapshot, CAPS, false);
  assert.equal(alerts.find((a) => a.id === "low_stock"), undefined, "Home never reads min-level stock");
  assert.equal(metrics.find((m) => m.id === "low_stock_products"), undefined);
  const tile = metrics.find((m) => m.id === "shortage_products");
  assert.ok(tile, "the shortage figure is named for what it is");
  assert.equal(tile.value, "٣");
  assert.equal(tile.href, "/inventory/shortages");
});

test("queue money is formatted currency, never a raw number", () => {
  const { queues } = composeMobileHomeSnapshot(snapshot, CAPS, false);
  const row = queues.find((q) => q.id === "orders").rows[0];
  assert.match(row.primaryValue, /ج\.م\./);
  assert.notEqual(row.primaryValue, "250");
  assert.match(queues.find((q) => q.id === "stock").rows[0].primaryValue, /^عجز /);
});

test("product detail unit cost is the ledger average, not the shelf total", () => {
  const src = read("src/mobile/screens/MobileProductDetails.tsx");
  assert.match(src, /averageCost\(\{ qty: quantity, amount: Number\(\(product as any\)\.mobileCost \?\? 0\) \}\)/);
  assert.doesNotMatch(src, /const avgCost = Number\(\(product as any\)\.mobileCost/);
  // A waiting ORDER is labelled with its order status, not «نفد المخزون».
  assert.doesNotMatch(src, /deriveStockStatusKey\(0, 0\)/);
});

test("the semantic tones the mobile UI reads are defined, in the mobile stylesheet only", () => {
  const css = read("src/mobile/mobile.css");
  for (const token of ["--warning", "--info", "--critical"]) {
    assert.match(css, new RegExp(`:root \\{[^}]*${token}:`), `${token} must be defined`);
  }
  for (const tone of ["info", "success", "warning", "critical", "muted"]) {
    assert.match(css, new RegExp(`\\.mobile-status-pill--${tone} \\{`), `status pill tone ${tone} must be styled`);
  }
  assert.doesNotMatch(read("src/styles.css"), /--warning:/, "the desktop palette is untouched");
});

test("inline states are sized to content; only full-page states take the viewport", () => {
  const css = read("src/mobile/mobile.css");
  assert.match(css, /\.mobile-auth-page,\nmain\.mobile-state \{\n  min-block-size: 100dvh;/);
  assert.doesNotMatch(css, /\.mobile-auth-page,\n\.mobile-state \{\n  min-block-size: 100dvh;/);
  const states = read("src/mobile/components/States.tsx");
  assert.match(states, /mobile-error-state" role="alert"/, "a failed read is announced");
  assert.match(states, /mobile-skeleton-list" role="status" aria-busy="true"/);
});

test("quick restock keeps quantity and cost side by side", () => {
  const css = read("src/mobile/mobile.css");
  assert.match(css, /\.mobile-stock-card-main > \.mobile-restock-fields \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(read("src/mobile/screens/MobileQuickRestock.tsx"), /mobile-restock-fields/);
});

test("owner amounts are bidi-isolated, not forced LTR", () => {
  assert.doesNotMatch(read("src/mobile/screens/MobileOwnerScreen.tsx"), /mobile-owner-row-value[^>]*dir="ltr"/);
  assert.match(read("src/mobile/mobile.css"), /\.mobile-owner-row-value \{ unicode-bidi: isolate; \}/);
});

test("a pending order's shipment reads as ready, not unknown", async () => {
  const { resolveShipmentStatus } = await import(new URL("src/mobile/viewmodels/statusTaxonomies.ts", root).href);
  assert.equal(resolveShipmentStatus("pending").labelAr, "جاهز للشحن");
});
