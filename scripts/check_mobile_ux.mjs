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
