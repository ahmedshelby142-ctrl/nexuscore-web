/**
 * Two things a screen reader — and a keyboard-only owner — needs.
 *
 *     node --test scripts/check_control_names.mjs
 *
 * 1. EVERY `<Switch>` CARRIES A NAME.
 *
 *    A Radix switch renders `<button role="switch">` with no text inside it.
 *    Its label is the sibling `<h3>` a sighted user reads, and nothing ties
 *    the two together, so the control announces as "switch, unlabelled". An
 *    audit of the running app on 2026-09-05 found twelve of them like this —
 *    six on الإعدادات, five on التكاملات, one on الشحن — every one of which
 *    toggles a real business setting.
 *
 *    A name is `aria-label`, `aria-labelledby`, or an `id` paired with a
 *    `<Label htmlFor>`. Any of the three passes.
 *
 * 2. THE PLACEHOLDER SCREENS SAY THEY ARE PLACEHOLDERS.
 *
 *    `PlaceholderPage` used to render `{description || "…قيد التطوير"}`, and
 *    all eight placeholder routes pass a description — so the sentence saying
 *    the module is unbuilt rendered on exactly none of them. The owner saw a
 *    titled, empty screen and could not tell an absent feature from a broken
 *    one. The notice must not be behind a fallback.
 *
 * ponytail: a tag scanner, not a jsx-a11y setup. It checks the one component
 * that has no intrinsic label; native controls already fail loudly elsewhere.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * The full text of every `<Switch …>` tag, brace-aware so an attribute value
 * containing `>` (`onCheckedChange={(v) => …}`) does not end the tag early.
 */
function switchTags(raw) {
  // A `//` comment inside a tag can hold a `>` (this repo explains several of
  // its aria-labels in one), which would end the tag scan early and hide a
  // named switch. Blank them, keeping the newlines so line numbers hold.
  const src = raw.replace(/^\s*\/\/.*$/gm, "");
  const tags = [];
  const open = /<Switch(?=[\s/>])/g;
  let m;
  while ((m = open.exec(src))) {
    let depth = 0;
    for (let i = m.index; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) {
        tags.push({ text: src.slice(m.index, i + 1), line: src.slice(0, m.index).split("\n").length });
        break;
      }
    }
  }
  return tags;
}

const NAMED = /\baria-label\b|\baria-labelledby\b|\bid=/;

test("every Switch has an accessible name", () => {
  const unnamed = [];
  for (const file of sourceFiles(SRC)) {
    if (file.endsWith(join("ui", "switch.tsx"))) continue; // the primitive itself
    for (const tag of switchTags(readFileSync(file, "utf8"))) {
      // A wrapper that forwards its props (`{...props}`) is named by its caller.
      if (NAMED.test(tag.text) || /\{\.\.\./.test(tag.text)) continue;
      unnamed.push(`${relative(SRC, file).split(sep).join("/")}:${tag.line}`);
    }
  }
  assert.deepEqual(
    unnamed,
    [],
    `<Switch> with no aria-label / aria-labelledby / id:\n  ${unnamed.join("\n  ")}`,
  );
});

test("PlaceholderPage always says the module is under development", () => {
  // Comments stripped: the file's own header quotes the old broken shape.
  const src = readFileSync(join(SRC, "routes", "placeholder.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(src, /قيد التطوير/, "the notice is gone entirely");
  assert.doesNotMatch(
    src,
    /description\s*\|\|/,
    "the notice is a fallback for `description` again — every route passes one, so it would never render",
  );
});
