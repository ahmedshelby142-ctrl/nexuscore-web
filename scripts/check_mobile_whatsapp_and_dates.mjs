/**
 * Mobile: the WhatsApp quick icon beside a customer's phone, and the Orders
 * date filter (presets + an inclusive custom range).
 *
 *     node --test scripts/check_mobile_whatsapp_and_dates.mjs
 *
 * Real modules throughout. The `.tsx` component is compiled with TypeScript in
 * the loader hook and its React element is inspected directly. The process runs
 * in Africa/Cairo (UTC+3 in September, UTC+2 after DST ends on 2026-10-29).
 */

process.env.TZ = "Africa/Cairo";

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");
const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
globalThis.window ??= globalThis;

// ── a fake PostgREST over in-memory orders (same shape as the Home test) ────
globalThis.__q = { orders: [], writes: [], lastFilters: [] };
const STUBS = {
  "@/lib/supabase": stub(`
    function from(source) {
      const filters = []; const names = [];
      const q = {
        select() { return q; },
        is(c, v) { names.push("is:" + c); filters.push((r) => (r[c] ?? null) === v); return q; },
        eq(c, v) { names.push("eq:" + c + "=" + v); filters.push((r) => r[c] === v); return q; },
        in(c, vs) { filters.push((r) => vs.includes(r[c])); return q; },
        gte(c, v) { names.push("gte:" + c); filters.push((r) => new Date(r[c]).getTime() >= new Date(v).getTime()); return q; },
        lt(c, v) { names.push("lt:" + c); filters.push((r) => new Date(r[c]).getTime() < new Date(v).getTime()); return q; },
        or(expr) { names.push("or"); const term = /%(.*?)%/.exec(expr)?.[1] ?? ""; filters.push((r) => !term || String(r.orderNumber).includes(term) || String(r.customerName).includes(term)); return q; },
        order() { return q; },
        range(a, b) { q.from = a; q.to = b; return q; },
        update() { globalThis.__q.writes.push(source); return q; },
        insert() { globalThis.__q.writes.push(source); return q; },
        then(ok, ko) {
          globalThis.__q.lastFilters = names;
          const rows = globalThis.__q.orders.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows.slice(q.from, q.to + 1), count: rows.length, error: null }).then(ok, ko);
        },
      };
      return q;
    }
    export const getSupabaseClient = () => ({ from, rpc: async () => ({ data: [], error: null }) });
    export const isCloudSyncMode = () => true;`),
  "@/store/useAuthStore": stub(`
    const state = () => ({ userRole: "MODERATOR", isAuthenticated: true });
    export const useAuthStore = Object.assign((sel) => sel(state()), { getState: state });`),
  "@/lib/ledger": stub(`export const balanceOf = async () => ({ qty: 0, amount: 0 });`),
};
const ts_ = (u) => (existsSync(fileURLToPath(u + ".ts")) ? u + ".ts" : existsSync(fileURLToPath(u + ".tsx")) ? u + ".tsx" : u + "/index.ts");
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    if (specifier.startsWith("@/")) return next(ts_(new URL(`src/${specifier.slice(2)}`, root).href), context);
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier))
      return next(ts_(new URL(specifier, context.parentURL).href), context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.endsWith(".tsx")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const out = ts.transpileModule(source, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
      fileName: fileURLToPath(url),
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});

const { whatsAppTarget, whatsAppUrl, customerMessage } = await import(new URL("src/lib/whatsapp.ts", root).href);
const { WhatsAppIconLink } = await import(new URL("src/mobile/components/WhatsAppAction.tsx", root).href);
const { getMobileCapabilities } = await import(new URL("src/mobile/navigation/mobileCapabilities.ts", root).href);
const { resolveOrderDateFilter, orderDateFilterLabel, REVERSED_RANGE_AR } = await import(new URL("src/mobile/viewmodels/orderDateFilter.ts", root).href);
const { ordersInPeriod } = await import(new URL("src/lib/orderSearch.ts", root).href);
const { readMobileOrders } = await import(new URL("src/mobile/data/mobileReaders.ts", root).href);

// ═══ WhatsApp ═══════════════════════════════════════════════════════════════

test("WA 1 — a local Egyptian mobile opens 20 + the number without its trunk 0", () => {
  assert.deepEqual(whatsAppTarget("01012345678"), { status: "ok", number: "201012345678" });
  const el = WhatsAppIconLink({ phone: "01012345678", message: customerMessage({ customerName: "منى", storeName: "متجر" }) });
  assert.ok(el.props.href.startsWith("https://wa.me/201012345678?text="));
  assert.match(decodeURIComponent(el.props.href), /أهلاً منى،/);
});

test("WA 2 — international and decorated forms normalise; other countries keep their code", () => {
  for (const raw of ["+20 101 234 5678", "0020 101-234-5678", "(+20) 1012345678", "+20 0 101 234 5678", "٠١٠١٢٣٤٥٦٧٨"]) {
    assert.deepEqual(whatsAppTarget(raw), { status: "ok", number: "201012345678" }, raw);
  }
  assert.deepEqual(whatsAppTarget("+44 7911 123456"), { status: "ok", number: "447911123456" });
  assert.deepEqual(whatsAppTarget("+1 (415) 555-2671"), { status: "ok", number: "14155552671" });
  assert.equal(whatsAppUrl("201012345678", "x"), "https://wa.me/201012345678?text=x");
});

test("WA 3/4 — no phone, or one WhatsApp cannot open, renders NO action and no link", () => {
  for (const phone of [null, undefined, "", "   "]) assert.equal(WhatsAppIconLink({ phone, message: "m" }), null, `missing: ${phone}`);
  // a landline, a short typo, an Egyptian mobile typed without its 0, letters
  for (const phone of ["0223456789", "0101234", "1012345678", "abc"]) {
    assert.equal(WhatsAppIconLink({ phone, message: "m" }), null, `invalid: ${phone}`);
  }
});

test("WA 5/6 — accessible name in Arabic, opens externally, and never triggers the row", () => {
  const el = WhatsAppIconLink({ phone: "01012345678", message: "m" });
  assert.equal(el.type, "a");
  assert.equal(el.props["aria-label"], "فتح واتساب");
  assert.equal(el.props.title, "فتح واتساب");
  assert.equal(el.props.target, "_blank");
  assert.equal(el.props.rel, "noopener noreferrer");
  let stopped = false;
  el.props.onClick({ stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true, "the click stops at the icon");
  // …and in the list it is the row button's SIBLING, never inside it.
  const list = read("src/mobile/screens/MobileCustomersScreen.tsx");
  assert.match(list, /<div className="mobile-customer-row" key=\{row\.id\}><button type="button" className="mobile-customer-card"[\s\S]*?<\/button><WhatsAppIconLink phone=\{row\.phone\}/);
  assert.match(read("src/mobile/screens/MobileOrderDetails.tsx"), /<WhatsAppIconLink phone=\{order\.customerPhone\}/);
});

test("WA 7/8 — shown wherever the role already sees the customer; adds no permission, writes nothing", () => {
  const mod = getMobileCapabilities("MODERATOR");
  assert.ok(mod.has("customers") && mod.has("orders"), "MODERATOR reaches both places the icon appears");
  for (const f of ["src/mobile/components/WhatsAppAction.tsx", "src/lib/whatsapp.ts"]) {
    const src = read(f);
    assert.doesNotMatch(src, /getSupabaseClient|\.rpc\(|\.from\(|fetch\(|console\.(log|info)/, `${f}: no backend, no logging of numbers`);
    assert.doesNotMatch(src, /userRole|canAccess|MODERATOR/, `${f}: no new role policy`);
  }
  // Moderator stays read-only: nothing in this feature writes, and the
  // moderator still has no purchasing/owner capability.
  assert.equal(mod.has("purchasing"), false);
  assert.equal(mod.has("owner"), false);
});

// ═══ Orders date filter ═════════════════════════════════════════════════════

const NOW = new Date("2026-10-03T09:15:00Z"); // 12:15 Cairo, Saturday

test("DATE 1–3 — presets keep the app's definitions (windowFor)", () => {
  const today = resolveOrderDateFilter({ preset: "today" }, NOW);
  assert.deepEqual(today, { status: "ok", bounds: { createdFrom: "2026-10-02T21:00:00.000Z" } }, "Cairo midnight, 3 Oct");
  const week = resolveOrderDateFilter({ preset: "week" }, NOW);
  assert.equal(week.bounds.createdFrom, "2026-09-26T21:00:00.000Z", "today and the six days before it");
  const month = resolveOrderDateFilter({ preset: "thisMonth" }, NOW);
  assert.equal(month.bounds.createdFrom, "2026-09-30T21:00:00.000Z", "1 October, Cairo midnight");
  assert.deepEqual(resolveOrderDateFilter({ preset: "all" }, NOW), { status: "ok", bounds: {} });
});

test("DATE 4/9/15 — a custom range becomes [Cairo midnight of FROM, Cairo midnight after TO)", () => {
  assert.deepEqual(resolveOrderDateFilter({ preset: "custom", from: "2026-09-01", to: "2026-09-30" }), {
    status: "ok",
    bounds: { createdFrom: "2026-08-31T21:00:00.000Z", createdBefore: "2026-09-30T21:00:00.000Z" },
  });
  // Across the DST change (29 Oct): the end is local midnight on the 31st at UTC+2.
  assert.deepEqual(resolveOrderDateFilter({ preset: "custom", from: "2026-10-29", to: "2026-10-30" }).bounds, {
    createdFrom: "2026-10-28T21:00:00.000Z",
    createdBefore: "2026-10-30T22:00:00.000Z",
  });
  // A single day.
  assert.deepEqual(resolveOrderDateFilter({ preset: "custom", from: "2026-09-15", to: "2026-09-15" }).bounds, {
    createdFrom: "2026-09-14T21:00:00.000Z",
    createdBefore: "2026-09-15T21:00:00.000Z",
  });
  assert.match(orderDateFilterLabel({ preset: "custom", from: "2026-09-01", to: "2026-09-30" }), /–/);
});

test("DATE 7/8 — reversed is refused with a message; one date alone is incomplete; nonsense is invalid", () => {
  assert.deepEqual(resolveOrderDateFilter({ preset: "custom", from: "2026-09-30", to: "2026-09-01" }), { status: "reversed", messageAr: REVERSED_RANGE_AR });
  assert.deepEqual(resolveOrderDateFilter({ preset: "custom", from: "2026-09-01" }), { status: "incomplete" });
  assert.deepEqual(resolveOrderDateFilter({ preset: "custom", to: "2026-09-30" }), { status: "incomplete" });
  assert.equal(resolveOrderDateFilter({ preset: "custom", from: "2026-02-31", to: "2026-03-01" }).status, "invalid");
  // The sheet applies only a complete, ordered range; the screen never queries anything else.
  const sheet = read("src/mobile/components/OrderDateFilter.tsx");
  assert.match(sheet, /disabled=\{resolution\.status !== "ok"\}/);
  assert.match(sheet, /role="alert">\{resolution\.messageAr\}/);
  const screen = read("src/mobile/screens/MobileOrdersScreen.tsx");
  assert.match(screen, /return resolved\.status === "ok" \? resolved\.bounds : \{\};/);
});

const order = (id, createdAt, extra = {}) => ({ id, orderNumber: `ORD-${id}`, customerName: `عميل ${id}`, status: "pending", createdAt, updatedAt: createdAt, deleted_at: null, ...extra });

test("DATE 5/6/9 — near midnight: first and last instants in, one millisecond outside out (server path)", async () => {
  globalThis.__q.orders = [
    order("before-start", "2026-08-31T20:59:59.999Z"), // 31 Aug 23:59:59.999 Cairo — OUT
    order("start", "2026-08-31T21:00:00.000Z"),        // 1 Sep 00:00 Cairo — IN
    order("late-end", "2026-09-30T20:59:59.999Z"),     // 30 Sep 23:59:59.999 Cairo — IN
    order("after-end", "2026-09-30T21:00:00.000Z"),    // 1 Oct 00:00 Cairo — OUT
    order("evening-end", "2026-09-30T18:30:00.000Z"),  // 30 Sep 21:30 Cairo — IN (end day, evening)
  ];
  const { bounds } = resolveOrderDateFilter({ preset: "custom", from: "2026-09-01", to: "2026-09-30" });
  const page = await readMobileOrders({ ...bounds, pageSize: 50 });
  assert.deepEqual(page.rows.map((r) => r.id).sort(), ["evening-end", "late-end", "start"]);
  assert.deepEqual(globalThis.__q.lastFilters.filter((f) => /createdAt/.test(f)), ["gte:createdAt", "lt:createdAt"], "server-side constraints");
});

test("DATE 10/11 — soft-deleted orders stay out, and pagination counts within the range", async () => {
  globalThis.__q.orders = [
    ...Array.from({ length: 5 }, (_, i) => order(`in-${i}`, `2026-09-1${i}T10:00:00.000Z`)),
    order("deleted", "2026-09-12T10:00:00.000Z", { deleted_at: "2026-09-20T00:00:00Z" }),
    order("outside", "2026-10-02T10:00:00.000Z"),
  ];
  const { bounds } = resolveOrderDateFilter({ preset: "custom", from: "2026-09-01", to: "2026-09-30" });
  const first = await readMobileOrders({ ...bounds, pageSize: 2, page: 0 });
  assert.equal(first.total, 5, "deleted and out-of-range excluded from the count");
  assert.equal(first.rows.length, 2);
  assert.equal(first.hasMore, true);
  const last = await readMobileOrders({ ...bounds, pageSize: 2, page: 2 });
  assert.equal(last.rows.length, 1);
  assert.equal(last.hasMore, false);
});

test("DATE 12 — composes with status, the action/today tabs and search", async () => {
  globalThis.__q.orders = [
    order("a", "2026-09-10T10:00:00.000Z", { status: "pending" }),
    order("b", "2026-09-11T10:00:00.000Z", { status: "shipped" }),
    order("c", "2026-09-12T10:00:00.000Z", { status: "pending", customerName: "منى" }),
  ];
  const { bounds } = resolveOrderDateFilter({ preset: "custom", from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual((await readMobileOrders({ ...bounds, status: "shipped" })).rows.map((r) => r.id), ["b"]);
  assert.deepEqual((await readMobileOrders({ ...bounds, queue: "action" })).rows.map((r) => r.id).sort(), ["a", "c"]);
  assert.deepEqual((await readMobileOrders({ ...bounds, search: "منى" })).rows.map((r) => r.id), ["c"]);
  assert.deepEqual(globalThis.__q.writes, [], "reading never writes");
});

test("DATE 13/14 — changing or clearing the range re-reads; the filter row keeps the other filters", () => {
  const hook = read("src/mobile/data/useMobilePagedQuery.ts");
  assert.match(hook, /const key = JSON\.stringify\(\{ \.\.\.query, page: undefined, pageSize: undefined \}\);/, "bounds are part of the key");
  const screen = read("src/mobile/screens/MobileOrdersScreen.tsx");
  assert.match(screen, /\{ search: query, queue: segment as "action" \| "today" \| "all", status, \.\.\.dateBounds \}/);
  assert.match(screen, /<FilterSheet label="حالة الطلب"[^>]*\/><OrderDateFilter value=\{dateFilter\} onChange=\{setDateFilter\} \/>/);
  assert.match(read("src/mobile/components/OrderDateFilter.tsx"), /pick\(\{ preset: "all" \}\)\}>مسح التاريخ/);
  assert.deepEqual(resolveOrderDateFilter({ preset: "all" }).bounds, {}, "cleared = no date constraint at all");
  // Today/الكل tabs untouched.
  assert.match(screen, /\{ id: "action", label: "تحتاج إجراء" \}, \{ id: "today", label: "اليوم" \}, \{ id: "all", label: "الكل" \}/);
});

test("Desktop's ordersInPeriod keeps its semantics through the shared boundary rule", () => {
  const list = [
    { id: "x", createdAt: "2026-09-30T20:59:59.999Z" },
    { id: "y", createdAt: "2026-09-30T21:00:00.000Z" },
    { id: "z", createdAt: "not a date" },
  ];
  assert.deepEqual(ordersInPeriod(list, "2026-09-01", "2026-09-30").map((o) => o.id), ["x", "z"], "end day whole, next midnight out, unparseable shown");
  assert.deepEqual(ordersInPeriod(list, "2026-09-30", "2026-09-01").map((o) => o.id), ["z"], "reversed matches no dated order; unparseable still shown, as before");
  assert.equal(ordersInPeriod(list, "", "").length, 3);
  assert.equal(ordersInPeriod(list, "garbage", "").length, 3, "an invalid bound filters nothing, as before");
});
