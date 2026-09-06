/**
 * A dialog that closes must actually leave the screen.
 *
 *     node --test scripts/check_overlay_unmount.mjs
 *
 * ## The bug this exists to prevent
 *
 * Found in the acceptance UAT on 2026-09-07. Every Radix overlay in the app —
 * dialogs, alert dialogs, sheets, selects, dropdowns, popovers — set
 * `data-state="closed"` when dismissed and then **stayed in the DOM, fully
 * visible, forever**. Cancel, save, and the X all behaved the same way.
 *
 * Observed on the product form: after a successful save the row was in the
 * database, but the dialog stayed open with the fields still filled, no toast,
 * no error, and the submit button re-enabled. To the user the save had done
 * nothing, and the obvious response — press it again — is exactly what you do
 * not want on a form that writes records.
 *
 * ## Why it happened
 *
 * Radix unmounts through `Presence`, which, when an exit animation is present,
 * waits for `animationend` before removing the node. These components carried
 * the v3-era `tailwindcss-animate` utilities:
 *
 *     data-[state=closed]:animate-out data-[state=closed]:fade-out-0 …
 *
 * Under Tailwind v4 with `tw-animate-css`, `@keyframes exit` compiles and the
 * `fade-out-0` / `zoom-out-95` utilities compile (they set `--tw-exit-*`), but
 * the `animate-out` utility that names and times the animation does not appear
 * in the output as a usable rule. The element was left claiming an animation
 * that never starts: no `animationstart`, no `animationend` — verified by
 * attaching listeners across a full open/close cycle and recording zero events.
 * `Presence` waited for an event that could not arrive.
 *
 * The fix was to drop the state-driven animation utilities. Nothing was lost
 * visually, because nothing was animating in the first place.
 *
 * ## What this asserts
 *
 * No overlay primitive may carry an exit-animation utility again. The rule is
 * narrow on purpose: an unconditional `animate-in` (the tooltip, the empty
 * state) is fine, because `Presence` only blocks on the way OUT.
 *
 * ponytail: a source check, not a browser test. The failure needs a real
 * layout engine to observe and cannot be reproduced in jsdom — but the single
 * line of CSS that causes it is right here and greppable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const UI = new URL("../src/components/ui/", import.meta.url);

/** Overlays whose content is mounted through Radix `Presence`. */
const OVERLAYS = [
  "dialog.tsx",
  "alert-dialog.tsx",
  "sheet.tsx",
  "select.tsx",
  "dropdown-menu.tsx",
  "popover.tsx",
  "context-menu.tsx",
  "menubar.tsx",
  "hover-card.tsx",
  "tooltip.tsx",
];

/** The utilities that make `Presence` wait for an animation that never runs. */
const EXIT_ANIMATION = /data-\[(?:state|side|motion)[^\]]*\]:(?:animate-out|fade-out-\d+|zoom-out-\d+|slide-out-to-[a-z-]+)/;

test("no overlay waits on an exit animation to unmount", () => {
  const offenders = [];
  for (const file of OVERLAYS) {
    const src = readFileSync(new URL(file, UI), "utf8");
    for (const [i, line] of src.split("\n").entries()) {
      const hit = line.match(EXIT_ANIMATION);
      if (hit) offenders.push(`${file}:${i + 1} → ${hit[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these overlays will stay on screen after closing:\n  " + offenders.join("\n  "),
  );
});

test("the whole ui/ directory is covered, not just the files listed here", () => {
  // If a new overlay primitive is added, this fails until it is either listed
  // above or shown not to use the exit utilities — so the guard cannot rot by
  // omission.
  const missed = [];
  for (const file of readdirSync(UI).filter((f) => f.endsWith(".tsx"))) {
    if (OVERLAYS.includes(file)) continue;
    const src = readFileSync(new URL(file, UI), "utf8");
    if (EXIT_ANIMATION.test(src)) missed.push(file);
  }
  assert.deepEqual(
    missed,
    [],
    "an overlay outside the reviewed list carries an exit animation:\n  " + missed.join("\n  "),
  );
});

test("the dialog still renders its own close control", () => {
  // The fix removed presentational classes only. If a future edit strips the
  // built-in Close button while removing animation classes, a dialog becomes
  // dismissible only by its footer buttons — and a dialog whose flow throws
  // before reaching them would trap the user again, differently.
  const dialog = readFileSync(new URL("dialog.tsx", UI), "utf8");
  assert.match(dialog, /DialogPrimitive\.Close/, "the dialog must keep a close control");
  const sheet = readFileSync(new URL("sheet.tsx", UI), "utf8");
  assert.match(sheet, /SheetPrimitive\.Close|DialogPrimitive\.Close/, "the sheet must keep a close control");
});
