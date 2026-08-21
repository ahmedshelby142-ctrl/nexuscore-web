/**
 * A zustand selector must return something referentially STABLE.
 *
 *     node --test scripts/check_selectors.mjs
 *
 * Why this file exists: on 2026-08-19 a one-line change to نقطة البيع took
 * down every sale in the app.
 *
 *     const customers = useCustomerStore((s) => activeCustomers(s.customers));
 *
 * It reads correctly and it is a fatal bug. zustand v5 is built on
 * `useSyncExternalStore`, which compares each snapshot with `Object.is`.
 * `activeCustomers` returns `customers.filter(...)` — a NEW array every call —
 * so every render produced a "changed" snapshot, React re-rendered to catch
 * up, and the screen died with "Maximum update depth exceeded" behind the
 * warning "The result of getSnapshot should be cached to avoid an infinite
 * loop".
 *
 * The rule: a selector returns a stored field or a primitive. Derive with
 * `useMemo` on the component side, never inside the selector.
 *
 * ponytail: a grep, not an ESLint plugin. It catches the exact shape that
 * broke POS with no false positives on this repo, and it costs 40 lines
 * instead of a custom rule package. If selectors ever get complex enough that
 * this misses one, THEN write the rule.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { activeCustomers } from "../src/lib/customers.ts";

const SRC = new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Every selector call written on one line: `useXStore((s) => …)`. */
const SELECTOR = /use\w*Store\(\s*\(\s*\w+\s*\)\s*=>\s*(.+?)\)\s*[;,)]/g;

/**
 * Shapes that MUST allocate a new value each call. A bare method call
 * (`s.currentPlan()`) is not listed: those return primitives here, and
 * flagging them would make the check noise rather than a signal.
 */
const UNSTABLE = [
  { pattern: /^\s*[[{]/, why: "returns a new array/object literal" },
  { pattern: /\.filter\(/, why: "`.filter()` allocates a new array" },
  { pattern: /\.map\(/, why: "`.map()` allocates a new array" },
  { pattern: /\.sort\(/, why: "`.sort()` returns a (mutated) array" },
  { pattern: /\.slice\(/, why: "`.slice()` allocates a new array" },
  { pattern: /\.concat\(/, why: "`.concat()` allocates a new array" },
  { pattern: /Object\.(keys|values|entries)\(/, why: "`Object.*` allocates a new array" },
  { pattern: /\bactive(Customers|Products|Partners)\(/, why: "the `active*` helpers filter" },
];

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

test("no zustand selector returns a freshly allocated value", () => {
  const offences = [];

  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
      for (const [, body] of line.matchAll(SELECTOR)) {
        const hit = UNSTABLE.find((u) => u.pattern.test(body));
        if (hit) {
          offences.push(`${file}:${i + 1} — ${hit.why}\n      ${line.trim()}`);
        }
      }
    });
  }

  assert.deepEqual(
    offences,
    [],
    `A selector that allocates makes every render a "new" snapshot and loops React forever.\n` +
      `Subscribe to the stored field and derive with useMemo instead:\n` +
      `    const all = useStore((s) => s.things);\n` +
      `    const shown = useMemo(() => activeThings(all), [all]);\n\n` +
      offences.join("\n"),
  );
});

test("the check actually catches the line that broke POS", () => {
  // A guard whose regex silently stops matching is worse than no guard, so the
  // real offending line is asserted against the same matcher.
  const broken = `  const customers = useCustomerStore((s) => activeCustomers(s.customers));`;
  const bodies = [...broken.matchAll(SELECTOR)].map(([, body]) => body);

  assert.equal(bodies.length, 1, "the selector regex still matches a real call");
  assert.ok(
    UNSTABLE.some((u) => u.pattern.test(bodies[0])),
    "the 2026-08-19 POS regression would be caught",
  );

  // And the fixed shape passes.
  const fixed = `  const allCustomers = useCustomerStore((s) => s.customers);`;
  const fixedBodies = [...fixed.matchAll(SELECTOR)].map(([, body]) => body);
  assert.equal(fixedBodies.length, 1);
  assert.ok(!UNSTABLE.some((u) => u.pattern.test(fixedBodies[0])));
});

test("the mechanism: `activeCustomers` cannot survive an Object.is snapshot check", () => {
  // This is the whole bug in three lines. `useSyncExternalStore` calls the
  // selector on every render and keeps re-rendering while the result differs
  // by `Object.is`. A helper that allocates can never satisfy it.
  const book = [{ id: "c1", name: "أحمد", phone: "01012345678", deleted_at: null }];

  assert.deepEqual(activeCustomers(book), activeCustomers(book), "same VALUE every call");
  assert.equal(
    Object.is(activeCustomers(book), activeCustomers(book)),
    false,
    "but never the same REFERENCE — which is what the snapshot check compares",
  );

  // The shape the component uses instead: the stored array itself, which the
  // store hands back unchanged until something actually writes to it.
  assert.equal(Object.is(book, book), true);
});
