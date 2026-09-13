import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const navigation = read("../src/mobile/navigation/mobileNavigation.ts");
const capabilities = read("../src/mobile/navigation/mobileCapabilities.ts");
const home = read("../src/mobile/viewmodels/home/homeComposer.ts");
const alerts = read("../src/mobile/viewmodels/alertModel.ts");
const metrics = read("../src/mobile/viewmodels/metricDefinitions.ts");
const router = read("../src/mobile/router.tsx");
const bottomNav = read("../src/mobile/shell/MobileBottomNav.tsx");
const badges = read("../src/mobile/shell/useAlertBadges.ts");
const more = read("../src/mobile/shell/MobileMoreSheet.tsx");

test("each role has at most four bottom destinations and More", () => {
  for (const role of ["ADMIN", "ACCOUNTANT", "POS_ECOMMERCE", "ECOMMERCE_ONLY"]) {
    const body = navigation.match(new RegExp(`case "${role}"[\\s\\S]*?return \\[(.*?)\\];`))?.[1] ?? "";
    assert.ok(body, `${role} must have a defined mobile navigation model`);
    assert.ok((body.match(/ALL_MODULES\./g) ?? []).length <= 4);
    assert.match(body, /ALL_MODULES\.more/);
  }
});

test("mobile navigation delegates access to canonical capabilities", () => {
  assert.match(bottomNav, /getMobileCapabilities\(role\)/);
  assert.match(bottomNav, /filter\(\(item\) =>[\s\S]*?capabilities\.has\(item\.id\)/);
  assert.match(router, /MobileRouteGuard capability="orders"/);
  assert.match(router, /MobileRouteGuard capability="preferences"/);
  assert.match(capabilities, /return canAccess\(role, desktopPath\)/);
});

test("home is composed from pure view models and omits unsupported revenue claims", () => {
  assert.match(home, /export function composeHomeSections/);
  assert.match(home, /deriveAlerts\(buildAlertInput/);
  assert.match(home, /toMobileOrderQueue/);
  assert.match(home, /toMobileStockQueue/);
  assert.doesNotMatch(home, /بطاقة/);
  assert.doesNotMatch(metrics, /today_revenue|بطاقة/);
});

test("alerts are priority-sorted and badges include only critical/action", () => {
  assert.match(alerts, /pa - pb/);
  assert.match(alerts, /return b\.count - a\.count/);
  assert.match(badges, /alert\.level !== "CRITICAL" && alert\.level !== "ACTION"/);
});

test("More is capability-filtered and does not expose administration", () => {
  assert.match(more, /getMoreModulesForRole/);
  for (const forbidden of ["System Owner", "إدارة الترخيص", "إدارة المستخدمين", "الفروع"]) {
    assert.doesNotMatch(more, new RegExp(forbidden));
  }
  assert.match(more, /قريباً/);
});

test("deferred destinations are real mobile routes, not hash links", () => {
  assert.doesNotMatch(bottomNav, /to=\{?"#"/);
  assert.match(router, /MobileDeferredScreen/);
  assert.match(router, /path="inventory"/);
  assert.match(router, /path="shipments"/);
  assert.match(router, /path="orders\/:orderId"/);
  assert.match(router, /path="inventory\/:productId"/);
  assert.match(alerts, /href: "\/shipments"/);
});

test("mobile CSS keeps the four-item bar and home usable at 320px", () => {
  const css = read("../src/mobile/mobile.css");
  assert.match(css, /min-width: 320px/);
  assert.match(css, /@media \(max-width: 359px\)/);
  assert.match(css, /\.mobile-nav-item[^{]*\{[\s\S]*?min-inline-size: 0/);
  assert.match(css, /min-block-size: 44px|inline-size: 100%/);
});

test("More supports Escape dismissal and focus management", () => {
  assert.match(more, /event\.key === "Escape"/);
  assert.match(more, /document\.addEventListener\("keydown"/);
  assert.match(more, /previouslyFocused\?\.focus\(\)/);
  assert.match(more, /event\.key !== "Tab"/);
});