/**
 * A custom date range from the URL is either applied or gone — never shown
 * without being applied.
 *
 * Live finding (c8b337c, Production, Moderator): `/orders?seg=all&date=custom&
 * from=2026-99-99&to=x` drew the trigger as «٧/٦/٢٠٣٤ – Invalid Date» and
 * listed every order; a reversed pair and a missing `to` did the same with a
 * plausible label. The label read the raw URL; the query dropped what did not
 * resolve. Both now read `readUrlFilters` → `canonicalDateFilters` →
 * `parseOrderDateSelection`, and the URL is rewritten to match.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "react" || specifier === "react-router-dom") return { url: `data:text/javascript,export const useCallback=()=>{};export const useEffect=()=>{};export const useMemo=()=>{};export const useSearchParams=()=>[];`, shortCircuit: true };
    if (specifier.startsWith("@/")) return next(new URL(`src/${specifier.slice(2)}.ts`, root).href, context);
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { parseOrderDateSelection, resolveOrderDateFilter, orderDateFilterLabel } = await import(new URL("src/mobile/viewmodels/orderDateFilter.ts", root).href);
const { readUrlFilters } = await import(new URL("src/mobile/data/useUrlFilters.ts", root).href);

const NONE = { preset: "all" };
const custom = (from, to) => parseOrderDateSelection({ date: "custom", from, to });

test("rejected custom ranges become «no date filter»", () => {
  assert.deepEqual(custom("2026-99-99", "x"), NONE, "malformed (the Production URL)");
  assert.deepEqual(custom("2026-13-01", "2026-10-02"), NONE, "invalid from");
  assert.deepEqual(custom("2026-10-01", "2026-10-32"), NONE, "invalid to");
  assert.deepEqual(custom("2026-02-30", "2026-03-01"), NONE, "impossible day (rolls over)");
  assert.deepEqual(custom(undefined, "2026-10-02"), NONE, "missing from");
  assert.deepEqual(custom("2026-10-03", undefined), NONE, "missing to (the Production URL)");
  assert.deepEqual(custom("2026-10-05", "2026-10-01"), NONE, "reversed (the Production URL)");
  assert.deepEqual(custom("10/02/2026", "10/03/2026"), NONE, "not ISO");
  assert.deepEqual(parseOrderDateSelection({ date: "evil", from: "2026-10-01", to: "2026-10-02" }), NONE, "unknown preset");
});

test("accepted custom ranges are kept exactly", () => {
  assert.deepEqual(custom("2026-10-02", "2026-10-02"), { preset: "custom", from: "2026-10-02", to: "2026-10-02" }, "start = end");
  assert.deepEqual(custom("2026-09-15", "2026-10-15"), { preset: "custom", from: "2026-09-15", to: "2026-10-15" }, "month crossing");
  assert.deepEqual(custom("2025-12-31", "2026-01-01"), { preset: "custom", from: "2025-12-31", to: "2026-01-01" }, "year crossing");
  assert.deepEqual(parseOrderDateSelection({ date: "week", from: "2026-99-99", to: "x" }), { preset: "week" }, "a preset carries no days");
});

test("whatever the URL said, the label and the query agree", () => {
  const urls = [
    "seg=all&date=custom&from=2026-99-99&to=x",
    "seg=all&date=custom&from=2026-10-05&to=2026-10-01",
    "seg=all&date=custom&from=2026-10-03",
    "seg=all&date=custom&to=2026-10-03",
    "seg=all&date=custom&from=2026-02-30&to=2026-03-01",
    "seg=all&date=custom&from=2026-10-02&to=2026-10-02",
    "seg=all&date=evil&from=2026-99-99&to=x",
  ];
  for (const search of urls) {
    const selection = parseOrderDateSelection(Object.fromEntries(new URLSearchParams(search)));
    const resolved = resolveOrderDateFilter(selection);
    assert.equal(resolved.status, "ok", `${search}: the query applies exactly what is selected`);
    const label = orderDateFilterLabel(selection);
    assert.doesNotMatch(label, /Invalid|NaN/, search);
    if (selection.preset === "all") {
      assert.equal(label, "كل التواريخ", `${search}: no fake active range`);
      assert.deepEqual(resolved.bounds, {}, search);
    } else {
      assert.ok(resolved.bounds.createdFrom && resolved.bounds.createdBefore, search);
    }
  }
});

// The screen's own canonicalizer, as written in MobileOrdersScreen.
const canonicalDateFilters = (values) => { const s = parseOrderDateSelection(values); return { ...values, date: s.preset, from: s.from ?? "", to: s.to ?? "" }; };
const DEFAULTS = { q: "", seg: "action", status: "all", date: "all", from: "", to: "" };
const ALLOWED = { seg: ["action", "today", "all"], status: ["all", "pending", "shipped", "delivered", "returned", "cancelled"], date: ["all", "today", "week", "thisMonth", "custom"] };
const parse = (search) => readUrlFilters(new URLSearchParams(search), DEFAULTS, ALLOWED, canonicalDateFilters);

test("the exact Production URLs are parsed to «no date filter» and the URL is rewritten", () => {
  for (const [search, expected] of [
    ["seg=all&date=custom&from=2026-99-99&to=x", "seg=all"],
    ["seg=all&date=custom&from=2026-10-05&to=2026-10-01", "seg=all"],
    ["seg=all&date=custom&from=2026-10-03", "seg=all"],
    ["seg=hacked&status=%3Cscript%3E&date=evil&from=2026-99-99&to=x", ""],
  ]) {
    const { values, canonicalSearch } = parse(search);
    assert.equal(values.date, "all", search);
    assert.equal(values.from, "", search);
    assert.equal(values.to, "", search);
    assert.equal(canonicalSearch, expected, `${search} → ?${expected}`);
  }
});

test("a valid URL is left alone — refresh and back/forward read it back unchanged", () => {
  const search = "seg=all&status=returned&date=custom&from=2026-10-02&to=2026-10-02";
  const { values, canonicalSearch } = parse(search);
  assert.equal(canonicalSearch, null, "no rewrite, so no history churn");
  assert.deepEqual(values, { q: "", seg: "all", status: "returned", date: "custom", from: "2026-10-02", to: "2026-10-02" });
  assert.equal(parse("").canonicalSearch, null, "the clean list stays clean");
  assert.equal(parse("seg=all&date=week").canonicalSearch, null);
});

test("clearing: defaults leave the URL, unrelated keys stay", () => {
  assert.equal(parse("seg=action&status=all&date=all&from=&to=").canonicalSearch, "");
  assert.equal(parse("seg=all&date=week&from=2026-10-01").canonicalSearch, "seg=all&date=week", "a preset drops stray days");
  assert.equal(parse("utm=x&seg=all").canonicalSearch, null, "not ours, not touched");
});

test("the screen wires the canonicalizer into the one hook, and the hook rewrites with replace", () => {
  const screen = read("src/mobile/screens/MobileOrdersScreen.tsx");
  assert.match(screen, /ORDER_DATE_PRESETS\.map\(\(p\) => p\.id\) \},\n\s*canonicalDateFilters,\n\s*\);/);
  assert.match(screen, /const selection = parseOrderDateSelection\(values\);/);
  const hook = read("src/mobile/data/useUrlFilters.ts");
  assert.match(hook, /if \(canonicalSearch === null\) return;\n\s*setParams\(new URLSearchParams\(canonicalSearch\), \{ replace: true \}\);/);
});
