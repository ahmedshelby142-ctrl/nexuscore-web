import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const stock = read("../src/mobile/screens/MobileStockScreen.tsx");
const orders = read("../src/mobile/screens/MobileOrdersScreen.tsx");
const shipments = read("../src/mobile/screens/MobileShipmentsScreen.tsx");
const customers = read("../src/mobile/screens/MobileCustomersScreen.tsx");
const productDetails = read("../src/mobile/screens/MobileProductDetails.tsx");
const orderDetails = read("../src/mobile/screens/MobileOrderDetails.tsx");
const customerDetails = read("../src/mobile/screens/MobileCustomerDetails.tsx");
const readers = read("../src/mobile/data/mobileReaders.ts");
const pagedHook = read("../src/mobile/data/useMobilePagedQuery.ts");
const homeReader = read("../src/mobile/data/mobileHomeReader.ts");
const homeScreen = read("../src/mobile/screens/MobileHomePlaceholder.tsx");
const badgeHook = read("../src/mobile/shell/useAlertBadges.ts");
const migration = read("../docs/migrations/025_mobile_shortage_read.sql");
const router = read("../src/mobile/router.tsx");
const terminology = [
  read("../src/mobile/navigation/mobileNavigation.ts"),
  read("../src/mobile/viewmodels/metricDefinitions.ts"),
  read("../src/mobile/viewmodels/alertModel.ts"),
  read("../src/mobile/viewmodels/home/homeComposer.ts"),
  read("../src/mobile/screens/MobileHomePlaceholder.tsx"),
].join("\n");

test("Stock supports all, low, out, and shortage filters", () => {
  assert.match(stock, /id: "all"/);
  assert.match(stock, /id: "low"/);
  assert.match(stock, /id: "out"/);
  assert.match(stock, /id: "shortage"/);
  assert.match(stock, /readMobileProducts/);
  assert.match(stock, /حالة النواقص تحتاج إلى مصدر تجميعي/);
});

test("Orders is a queue with action, today, all, search, and status filter", () => {
  assert.match(orders, /تحتاج إجراء/);
  assert.match(orders, /اليوم/);
  assert.match(orders, /الكل/);
  assert.match(orders, /MobileSearch/);
  assert.match(orders, /FilterSheet/);
  assert.match(orders, /toMobileOrderQueue/);
});

test("Shipments uses the real processing and shipment statuses", () => {
  assert.match(shipments, /جاهز للشحن/);
  assert.match(shipments, /في الطريق/);
  assert.match(shipments, /تم التسليم/);
  assert.match(shipments, /status.*processing/);
  assert.match(shipments, /toMobileShipmentQueue/);
  assert.doesNotMatch(shipments, /updateOrderStatus|addOrder/);
});

test("Customers is a read-only lookup and omits invented lifetime revenue", () => {
  assert.match(customers, /MobileSearch/);
  assert.match(customers, /toMobileCustomerQueue/);
  assert.match(customers, /phone/);
  assert.doesNotMatch(customers, /customer_ltv|lifetime|إيرادات|إنفاق/);
  assert.doesNotMatch(customerDetails, /customer_ltv|lifetime|إيرادات|إنفاق/);
});

test("Details use route params and authoritative stored values", () => {
  assert.match(productDetails, /useParams/);
  assert.match(productDetails, /getActualStock/);
  assert.match(productDetails, /mobileCost/);
  assert.match(orderDetails, /useParams/);
  assert.match(orderDetails, /totalAmount/);
  assert.match(orderDetails, /revenueLogged/);
  assert.match(customerDetails, /useParams/);
});

test("Phase C routes remain guarded and mobile-only", () => {
  for (const capability of ["stock", "orders", "shipments", "customers"]) {
    assert.match(router, new RegExp(`MobileRouteGuard capability="${capability}"`));
  }
  assert.match(router, /orders\/:orderId/);
  assert.match(router, /inventory\/:productId/);
  assert.match(router, /customers\/:customerId/);
  assert.doesNotMatch(router, /window\.location/);
});

test("Mobile terminology uses the definite orders module label", () => {
  assert.match(terminology, /label: "الطلبات"/);
  assert.match(terminology, /titleAr: "الطلبات المتأخرة"/);
  assert.match(terminology, /titleAr: "الطلبات التي تحتاج إجراء"/);
  assert.doesNotMatch(terminology, /label: "طلبات"/);
});

test("mobile collection readers use bounded server pagination and stable ordering", () => {
  assert.match(readers, /count: "exact"/);
  assert.match(readers, /\.range\(from, to\)/);
  assert.match(readers, /orderNumber\.ilike/);
  assert.match(readers, /customerName\.ilike/);
  assert.match(readers, /name\.ilike/);
  assert.match(readers, /barcode\.ilike/);
  assert.match(readers, /order\("createdAt", \{ ascending: false \}\)\.order\("id", \{ ascending: false \}\)/);
  assert.match(readers, /order\("updatedAt", \{ ascending: false \}\)\.order\("id", \{ ascending: false \}\)/);
  assert.match(pagedHook, /filter\(\(next\) => !current\.rows\.some/);
});

test("mobile stock never treats products.quantity as authoritative", () => {
  assert.match(readers, /balanceOf\("stock"/);
  assert.doesNotMatch(readers, /products\.quantity/);
  assert.match(stock, /mobileStock/);
});

test("shortages use one tenant-scoped RPC and Home/badges use focused data", () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.mobile_shortages/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /SET search_path = public, pg_temp/);
  assert.match(migration, /auth\.uid\(\)/);
  assert.match(migration, /has_role/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.mobile_shortages\(\) FROM anon/);
  assert.match(homeReader, /rpc\("mobile_shortages"\)/);
  assert.match(homeReader, /readMobileOrders/);
  assert.match(homeScreen, /useMobileHomeData/);
  assert.match(badgeHook, /useMobileHomeData/);
  assert.doesNotMatch(homeScreen, /useOrderStore|useBusinessStore|useStock/);
  assert.doesNotMatch(badgeHook, /useOrderStore|useBusinessStore|useStock/);
});