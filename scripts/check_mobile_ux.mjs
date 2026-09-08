/**
 * Mobile behaviour that lives in the shared primitives.
 *
 *     node --test scripts/check_mobile_ux.mjs
 *
 * Both rules below were measured, not assumed, during the mobile UX pass of
 * 8 September 2026 — and both are fixed in ONE primitive rather than in the
 * dozens of screens that consume it, which is also why they need guarding: a
 * future edit to `ui/dialog.tsx` or `ui/input.tsx` silently changes every
 * screen in the product.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const dialog = read("../src/components/ui/dialog.tsx");
const input = read("../src/components/ui/input.tsx");
const alertDialog = read("../src/components/ui/alert-dialog.tsx");
const login = read("../src/pages/Login.tsx");
const tabs = read("../src/components/ui/tabs.tsx");
const dash = read("../src/components/dashboard/ExecutiveDashboard.tsx");
const pos = read("../src/components/sales/CheckoutForm.tsx");
const table = read("../src/components/ui/table.tsx");
const sheet = read("../src/components/ui/sheet.tsx");

test("a tall dialog is reachable on a phone", () => {
  // The dialog is `fixed` and centred by a -50% translate, so anything taller
  // than the viewport overflows both ends and cannot be scrolled by the page.
  // Measured at 320x720 with a twelve-field form BEFORE the fix: 1102px tall,
  // title clipped at y=-191, save button at y=806 — 86px below the fold and
  // unreachable. AFTER: 688px, fits, scrolls, button reachable.
  const content = dialog.match(/"fixed left-\[50%\][^"]*"/)[0];
  assert.match(content, /max-h-\[calc\(100dvh-2rem\)\]/, "must cap its height");
  assert.match(content, /overflow-y-auto/, "must scroll rather than clip");
  // dvh, not vh: mobile browser chrome and the keyboard shrink the visual
  // viewport and `vh` ignores both.
  assert.ok(!/max-h-\[calc\(100vh/.test(content), "vh would ignore the keyboard");
  // Desktop composition unchanged.
  assert.match(content, /max-w-lg/);
  assert.match(content, /translate-x-\[-50%\] translate-y-\[-50%\]/);
});

test("number fields open a numeric keypad", () => {
  assert.match(input, /inputMode=\{inputMode \?\? \(type === "number" \? "decimal" : undefined\)\}/);
  // A caller can still override — integers-only fields want "numeric".
  assert.match(input, /\(\{ className, type, inputMode, \.\.\.props \}, ref\)/);
});

test("inputs do not trigger iOS zoom-on-focus", () => {
  // Anything under 16px makes Safari zoom the page when the field is focused,
  // which leaves the user scrolled sideways into a form they cannot see.
  assert.match(input, /text-base/, "16px on mobile");
  assert.match(input, /md:text-sm/, "smaller only from md up");
});

test("wide tables scroll instead of breaking the page", () => {
  // 19 screens render <Table>. The primitive owns the overflow so none of them
  // has to remember — and so a new screen cannot forget.
  assert.match(table, /<div className="relative w-full overflow-auto">/);
});

test("the navigation drawer stays a Sheet with a named close", () => {
  // Sheet is the right primitive for a side panel (shadcn guidance), and Radix
  // owns the focus trap and restoration.
  assert.match(sheet, /closeLabel = "Close"/);
  assert.match(sheet, /aria-label=\{closeLabel\}/);
});

test("a confirmation dialog fits the phone, like the form dialog does", () => {
  // Same defect as DialogContent, found in the same audit: `fixed`, centred
  // with a -50% translate, no height cap. A long confirmation overflowed both
  // ends and a `fixed` element cannot be scrolled by the page. It matters more
  // here — this primitive is every destructive confirmation in the app, and a
  // delete you cannot cancel is worse than one you cannot confirm.
  assert.match(alertDialog, /max-h-\[calc\(100dvh-2rem\)\]/);
  assert.match(alertDialog, /overflow-y-auto/);
  // dvh, not vh: the keyboard and browser chrome shrink the visual viewport.
  assert.ok(!/max-h-\[calc\(100vh/.test(alertDialog), "vh ignores the keyboard");
});

test("the confirmation's buttons stay on screen while you read it", () => {
  // Measured at 320x720 before this: "إلغاء" sat at y=809 and only appeared
  // after scrolling 166px, by which point the sentence naming what was being
  // deleted had scrolled away. Sticky costs nothing when nothing scrolls, so
  // short dialogs and every desktop width are unchanged.
  const footer = alertDialog.match(/const AlertDialogFooter[\s\S]*?\n\);/)[0];
  assert.match(footer, /sticky bottom-0/);
  assert.match(footer, /bg-background/, "a transparent sticky bar shows text through it");
  // The form dialog is deliberately NOT sticky: you read a form downwards and
  // the save button belongs after the last field.
  const dialogFooter = dialog.match(/const DialogFooter[\s\S]*?\n\);/)[0];
  assert.ok(!/sticky/.test(dialogFooter), "form footers stay in flow, on purpose");
});

test("every field on the front door is actually labelled", () => {
  // The labels were visible but not associated, so each field announced as an
  // unlabelled box — and on a phone the placeholder that was carrying the
  // meaning disappears as soon as you type. Verified live: labels 0 → 1.
  for (const id of ["login-username", "login-password", "login-new-password"]) {
    assert.match(login, new RegExp(`htmlFor="${id}"`), `${id} needs its label`);
    assert.match(login, new RegExp(`id="${id}"`), `${id} needs its input`);
  }
});

test("the email field opens an email keyboard", () => {
  assert.match(login, /inputMode=\{opMode === "cloud_sync" \? "email" : "text"\}/);
});

test("the heading names the form you are actually on", () => {
  // It read تسجيل الدخول on the create-account form, contradicting the button
  // below it — worst on a phone, where the two are often all that is visible.
  assert.match(login, /authMode === "signup"\s*\n\s*\? "إنشاء حساب جديد"/);
});

test("no tab is stranded off the side of a phone", () => {
  // Measured live on الطلبات at 390px: the tab list was 578px wide, did not
  // scroll, and "مرتجع مع المندوب" and "ملغي" sat entirely off screen — two
  // order statuses unreachable, with nothing indicating they existed.
  assert.match(tabs, /flex-wrap/);
  // A fixed h-9 would clip the second row once it wraps.
  assert.match(tabs, /min-h-9/);
  assert.ok(!/"inline-flex h-9 /.test(tabs), "fixed single-row height is the bug");
});

test("the dashboard period filter reflows instead of running off the edge", () => {
  // 542px inside a 390px main, and because the app is RTL it overflowed the
  // START edge — the month picker sat at right:-5, off screen entirely.
  const row = dash.match(/<div className="flex flex-wrap items-center gap-1 rounded-lg border border-border p-1">/);
  assert.ok(row, "the period filter must wrap");
});

test("phones get two KPI columns, not seven stacked cards", () => {
  // Every phone is below Tailwind's `sm`, so `sm:grid-cols-2` never applied on
  // a phone: seven full-width cards, 2.66 screens before the chart. Two columns
  // measured 2048px -> 1743px with nothing clipped.
  assert.match(dash, /grid-cols-1 min-\[360px\]:grid-cols-2 lg:grid-cols-3/);
});

test("the till's total and checkout stay within thumb reach", () => {
  // Measured live at 390x844 with an EMPTY cart: "الإجمالي المطلوب" at y=818
  // and "إتمام البيع" at y=870 against a 771px fold — and every line added to
  // the cart pushed them further down.
  assert.match(pos, /sticky bottom-0 z-10 -mx-4 mt-2 space-y-4 border-t border-border bg-card\/95/);
  // `lg:contents` removes the wrapper from layout on desktop, so the desktop
  // composition is untouched rather than merely "probably fine".
  assert.match(pos, /lg:contents/);
});
