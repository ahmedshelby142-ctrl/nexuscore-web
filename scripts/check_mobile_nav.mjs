/**
 * Phones must have a way off the current screen — and it must be the SAME
 * navigation the desktop uses.
 *
 *     node --test scripts/check_mobile_nav.mjs
 *
 * ## The defect
 *
 * The sidebar is `hidden lg:flex`: below 1024px it does not render at all. The
 * header nevertheless showed a hamburger, labelled فتح القائمة, wired to
 * `toggleSidebar()` — which flips `sidebarCollapsed`, a value only the desktop
 * `<aside>` reads. So on a phone the control was present, labelled, focusable,
 * and did nothing. A real user could reach a screen and have no way to leave
 * it. By this project's own UAT rule ("a control that appears clickable but
 * does nothing is a FAIL") that is a defect, not a gap.
 *
 * ## The two ways the fix could rot
 *
 *   1. **A second route list.** If the drawer ever enumerates paths itself,
 *      it stops agreeing with `canAccess` — and the first symptom is a till
 *      operator being shown an ADMIN screen. RLS would still refuse the write,
 *      but the menu would be lying. `useNavItems()` is the single source and
 *      these tests fail if the drawer grows its own.
 *   2. **The desktop sidebar being "simplified" into the drawer.** The aside
 *      must stay `hidden lg:flex`, and the drawer must stay `lg:hidden`, or one
 *      viewport ends up with two navigations or none.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (src) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const mobile = strip(read("../src/components/layout/MobileNav.tsx"));
const sidebar = strip(read("../src/components/dashboard/Sidebar.tsx"));
const layout = strip(read("../src/components/layout/Layout.tsx"));
const roles = read("../src/lib/roles.ts");

test("the mobile drawer reuses the sidebar's navigation, not a copy of it", () => {
  assert.match(mobile, /useNavItems/, "the drawer must read the shared nav");
  assert.match(sidebar, /export function useNavItems/);
  assert.match(sidebar, /const navItems = useNavItems\(\)/, "the desktop sidebar must use it too");

  // No second permission matrix, and no hand-listed routes.
  assert.ok(!/canAccess/.test(mobile), "permission filtering belongs in useNavItems, not the drawer");
  assert.ok(!/ROUTE_ACCESS/.test(mobile));
  const literalPaths = mobile.match(/"\/[a-z-]+"/g) ?? [];
  assert.deepEqual(literalPaths, [], `the drawer must not name routes itself: ${literalPaths}`);
});

test("the shared filter is the same function the router enforces with", () => {
  const hook = sidebar.match(/export function useNavItems[\s\S]*?\n\}/)[0];
  assert.match(hook, /canAccess\(userRole, item\.path\)/);
  assert.match(hook, /item\.profiles\.includes\(activeBusinessProfile\)/);
  assert.match(hook, /!item\.featureKey \|\| featureFlags\[item\.featureKey\]/);
  // canAccess must still short-circuit ADMIN and default unknown roles down.
  assert.match(roles, /if \(app === "ADMIN"\) return true;/);
  assert.match(roles, /if \(!role\) return "ECOMMERCE_ONLY";/);
});

test("no route reaches the menu that is not in the navigation data", () => {
  // System Owner and the admin-only screens that were never in the sidebar
  // must not appear in the drawer either.
  for (const path of ["/system-admin", "/users", "/branches", "/backups"]) {
    assert.ok(!mobile.includes(path), `${path} must not be listed in the drawer`);
    assert.ok(!sidebar.includes(`path: "${path}"`), `${path} must not be in the nav data`);
  }
});

test("the drawer closes on navigation, by tap and by route change", () => {
  assert.match(mobile, /onClick=\{\(\) => setOpen\(false\)\}/, "a tapped item closes it");
  // The effect also catches back/forward and a guard's redirect.
  assert.match(mobile, /useEffect\(\(\) => \{\s*setOpen\(false\);\s*\}, \[location\.pathname\]\)/);
});

test("the trigger is a real Radix trigger, so focus comes back", () => {
  // Wired by hand, Radix never learns which element opened the dialog and
  // closing drops focus onto <body>. Measured before and after.
  assert.match(mobile, /<SheetTrigger/);
  assert.ok(!/onClick=\{\(\) => setOpen\(true\)\}/.test(mobile));
});

test("both menus are accessibly named, in Arabic", () => {
  assert.match(mobile, /aria-label="فتح القائمة"/);
  assert.match(mobile, /closeLabel="إغلاق القائمة"/);
  // The sheet primitive must actually apply the label it is given.
  const sheet = strip(read("../src/components/ui/sheet.tsx"));
  assert.match(sheet, /closeLabel = "Close"/);
  assert.match(sheet, /aria-label=\{closeLabel\}/);
  assert.match(sheet, /<span className="sr-only">\{closeLabel\}<\/span>/);
});

test("the two navigations never appear at the same breakpoint", () => {
  assert.match(sidebar, /"hidden lg:flex/, "the desktop aside stays desktop-only");
  assert.match(mobile, /lg:hidden/, "the hamburger stays mobile-only");
});

test("the dead header toggle is gone", () => {
  // It called toggleSidebar() below `lg`, where nothing renders it.
  assert.ok(!/toggleSidebar/.test(layout), "Layout must not still wire a mobile sidebar toggle");
  assert.match(layout, /<MobileNav \/>/);
});
