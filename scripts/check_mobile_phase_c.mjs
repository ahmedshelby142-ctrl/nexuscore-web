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
const migration = read("../docs/migrations/028_mobile_shortages_real_demand.sql");
const router = read("../src/mobile/router.tsx");
const terminology = [
  read("../src/mobile/navigation/mobileNavigation.ts"),
  read("../src/mobile/viewmodels/metricDefinitions.ts"),
  read("../src/mobile/viewmodels/alertModel.ts"),
  read("../src/mobile/viewmodels/home/homeComposer.ts"),
  read("../src/mobile/screens/MobileHomePlaceholder.tsx"),
].join("\n");

test("Stock filters on stock state; shortages are their own screen", () => {
  assert.match(stock, /id: "all"/);
  assert.match(stock, /id: "low"/);
  assert.match(stock, /id: "out"/);
  assert.match(stock, /readMobileProducts/);

  // This test used to REQUIRE `id: "shortage"` and the string "حالة
  // النواقص تحتاج إلى مصدر تجميعي من دفتر الحسابات" — that is, it pinned
  // a filter whose predicate was `|| filter === "shortage"` (which passes
  // every row) and an empty state apologising that the aggregate source
  // did not exist. It did exist: `mobile_shortages`, which Home was
  // already calling. The filter is gone and the aggregate has a screen.
  assert.doesNotMatch(stock, /id: "shortage"/, "the sham filter must not come back");
  assert.doesNotMatch(stock, /حالة النواقص تحتاج إلى مصدر تجميعي/);
  assert.match(stock, /\/inventory\/shortages/, "and must link to the real one");
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
  // Migration 028 supersedes 025: the store is now an explicit validated
  // parameter rather than the caller's first membership, and the deficit is
  // real demand vs real ledger stock rather than a flag count.
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.mobile_shortages\(p_store uuid\)/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /SET search_path TO 'public', 'pg_temp'/);
  assert.match(migration, /has_role\(/, "membership and role are still checked inside the function");
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.mobile_shortages\(uuid\) FROM public/);
  // anon holds EXECUTE explicitly from Supabase's defaults, so revoking PUBLIC
  // does not cover it.
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.mobile_shortages\(uuid\) FROM anon/);
  assert.match(homeReader, /rpc\("mobile_shortages", \{ p_store: storeId \}\)/);
  assert.match(homeReader, /readMobileOrders/);
  assert.match(homeScreen, /useMobileHomeData/);
  assert.match(badgeHook, /useMobileHomeData/);
  assert.doesNotMatch(homeScreen, /useOrderStore|useBusinessStore|useStock/);
  assert.doesNotMatch(badgeHook, /useOrderStore|useBusinessStore|useStock/);
});