/**
 * Mobile realtime, the refresh controls, and the Owner's subject labels.
 *
 *     node --test scripts/check_mobile_realtime.mjs
 *
 * ## Why these are source assertions
 *
 * The modules under test import through the `@/` alias and reach Supabase on
 * import, so `node --test` cannot load them the way it loads `orderLifecycle`.
 * What is asserted here is therefore the SHAPE of the wiring — and the shapes
 * chosen are the ones whose absence caused a real, observed failure, not
 * whichever strings happened to be present.
 *
 * Three of those failures were found by driving the running app, and each has a
 * test below that would have caught the regression:
 *
 *   1. Realtime opened at root mount joined BEFORE the session was restored.
 *      Supabase applies RLS using the token the socket joined with, so the
 *      channel reported `state: "joined"` with every binding present and
 *      delivered nothing. A hand-made channel opened after login received the
 *      same events on the same socket. Hence the `authenticated` gate.
 *   2. Rejoining a FIXED topic after StrictMode's unmount/remount left the
 *      server bound to the discarded instance's binding ids. Hence the unique
 *      topic and the deferred close.
 *   3. The three refresh buttons rendered with no `onClick` at all, which a
 *      naive line grep could not see because the back button on the same
 *      minified JSX line does have one. Hence the element-level parse.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/**
 * Source with comments removed.
 *
 * Every "this must NOT appear" assertion below runs on this, not on the raw
 * file. The prose in these modules deliberately NAMES what they refuse to do —
 * `hydrateAll`, the payload, the stores — and an assertion that cannot tell an
 * explanation from an implementation fails on good documentation.
 */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\r\n]*/g, "$1");
}

const realtime = read("../src/mobile/data/useMobileRealtime.ts");
const app = read("../src/mobile/MobileApp.tsx");
const pagedQuery = read("../src/mobile/data/useMobilePagedQuery.ts");
const owner = read("../src/mobile/screens/MobileOwnerScreen.tsx");
const subjectNames = read("../src/mobile/data/useSubjectNames.ts");

const SCREENS = {
  orders: read("../src/mobile/screens/MobileOrdersScreen.tsx"),
  customers: read("../src/mobile/screens/MobileCustomersScreen.tsx"),
  shipments: read("../src/mobile/screens/MobileShipmentsScreen.tsx"),
  stock: read("../src/mobile/screens/MobileStockScreen.tsx"),
};

/** The `<button …>` element carrying an aria-label, parsed as one element. */
function buttonWithLabel(source, label) {
  const at = source.indexOf(`aria-label="${label}"`);
  if (at < 0) return null;
  const open = source.lastIndexOf("<button", at);
  if (open < 0) return null;
  const close = source.indexOf(">", at);
  return source.slice(open, close + 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// A · Realtime is mounted, once, and only with a real session
// ═══════════════════════════════════════════════════════════════════════════

test("A · the mobile root mounts realtime", () => {
  assert.match(app, /import \{ useMobileRealtime \}/);
  assert.match(app, /useMobileRealtime\(/);
});

test("A · realtime is gated on the reconciled session, not mounted bare", () => {
  // The bug this pins: a socket joined before the session is restored carries
  // the anon key, passes no RLS predicate, and silently receives nothing while
  // looking perfectly healthy.
  assert.match(app, /useMobileRealtime\(sessionState === "authenticated"\)/);
  assert.match(realtime, /export function useMobileRealtime\(authenticated: boolean\)/);
  assert.match(realtime, /if \(!isCloudSyncMode\(\) \|\| !authenticated\) return;/);
  assert.match(realtime, /\}, \[authenticated\]\);/,
    "the effect must re-run when the session appears, or the gate never opens");
});

test("A · mobile does not mount the DESKTOP realtime hook", () => {
  // `useRealtimeSync` merges into Zustand stores mobile never reads, and
  // hydrates on boot. Mounting it here would be cost with no effect.
  for (const [name, source] of Object.entries(SCREENS)) {
    assert.doesNotMatch(code(source), /useRealtimeSync/, `${name} must not mount desktop realtime`);
  }
  assert.doesNotMatch(code(app), /useRealtimeSync/);
  assert.doesNotMatch(code(realtime), /hydrateAll/);
});

// ═══════════════════════════════════════════════════════════════════════════
// B · Exactly one subscription
// ═══════════════════════════════════════════════════════════════════════════

test("B · one module-level channel, reference counted", () => {
  assert.match(realtime, /let channel: RealtimeChannel \| null = null;/);
  assert.match(realtime, /let listeners = 0;/);
  assert.match(realtime, /if \(channel\) return;/, "a second open must be a no-op");
  assert.match(realtime, /listeners \+= 1;/);
  assert.match(realtime, /listeners -= 1;/);
});

test("B · the channel topic is unique per open, never a fixed string", () => {
  // A fixed topic rejoined after a leave binds the server to the discarded
  // instance: joined, bindings present, nothing delivered.
  const topic = /client\.channel\(([^)]*)\)/.exec(realtime);
  assert.ok(topic, "openChannel must create the channel");
  assert.match(topic[1], /`mobile-sync-\$\{/, "the topic must be interpolated, not literal");
  assert.doesNotMatch(code(realtime), /client\.channel\("mobile-sync"\)/);
});

test("B · closing is deferred so StrictMode's remount does not churn the socket", () => {
  assert.match(realtime, /closeTimer/);
  assert.match(realtime, /clearTimeout\(closeTimer\)/, "a remount must cancel the pending close");
  assert.match(realtime, /if \(listeners === 0\) closeChannel\(\);/,
    "the deferred close must re-check the count before tearing down");
});

test("B · realtime subscribes to what mobile reads, and nothing else", () => {
  const listed = /MOBILE_REALTIME_TABLES = \[([\s\S]*?)\] as const;/.exec(realtime);
  assert.ok(listed);
  const tables = [...listed[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  // `purchase_invoices` joined the list when المشتريات gained the read side of
  // a write `commitReceipt` had been performing from the phone all along.
  assert.deepEqual(tables, ["orders", "products", "customers", "ledger_events", "purchase_invoices"]);
  // Desktop watches these two; mobile reads neither table, so a subscription
  // would be delivery cost for a row no mobile screen can render.
  assert.ok(!tables.includes("transactions"));
  assert.ok(!tables.includes("expenses"));
  // The highest-volume table here: `ledger_events` already signals the same
  // movement with one row instead of several.
  assert.ok(!tables.includes("ledger_lines"));
});

// ═══════════════════════════════════════════════════════════════════════════
// H · The payload is never applied — RLS and the reader stay authoritative
// ═══════════════════════════════════════════════════════════════════════════

test("H · a realtime payload is a cue, never state and never arithmetic", () => {
  // Cross-tenant isolation rests on two independent checks: Realtime only
  // delivers rows the caller's RLS allows, and the reader that re-runs is
  // scoped again when it asks. Merging the payload would bypass the second.
  assert.match(realtime, /_payload/, "the payload argument must be unused");
  assert.doesNotMatch(code(realtime), /setState|useBusinessStore|useOrderStore|useFinancialStore/);
  assert.doesNotMatch(code(realtime), /payload\.(new|old)/);
  // No money maths anywhere near the socket.
  assert.doesNotMatch(code(realtime), /amount|qty_delta|revenue|cogs/i);
});

test("H · the paged query re-runs its reader rather than merging the row", () => {
  assert.match(pagedQuery, /useRealtimeTables\(watched, \(\) => \{ void run\("refresh"\); \}\);/);
  assert.doesNotMatch(code(pagedQuery), /payload/);
});

// ═══════════════════════════════════════════════════════════════════════════
// C · D · E — the three refresh controls that did nothing
// ═══════════════════════════════════════════════════════════════════════════

for (const [name, source] of Object.entries(SCREENS)) {
  test(`${name} · تحديث invokes the screen's own loader, and shows it is working`, () => {
    const button = buttonWithLabel(source, "تحديث");
    assert.ok(button, `${name} must have a تحديث control`);
    assert.match(button, /onClick=\{\(\) => void page\.refresh\(\)\}/,
      "the control must call the canonical loader, not a new fetch");
    assert.match(button, /disabled=\{page\.refreshing\}/, "a second press must not queue a second read");
    assert.match(button, /aria-busy=\{page\.refreshing\}/);
  });

  test(`${name} · refresh keeps the rows on screen`, () => {
    // `reload` blanks the list into a skeleton and loses the operator's place.
    const button = buttonWithLabel(source, "تحديث");
    assert.doesNotMatch(code(button), /page\.reload/, "refresh must not be wired to the blanking path");
  });

  test(`${name} · subscribes to the tables its own rows come from`, () => {
    assert.match(source, /\{ watch: \[[^\]]+\] \}/, `${name} must pass a watch list`);
  });
}

test("the paged query separates refreshing from loading, and guards both", () => {
  assert.match(pagedQuery, /refreshing: boolean/);
  assert.match(pagedQuery, /loading: mode === "initial"/);
  assert.match(pagedQuery, /refreshing: mode === "refresh"/);
  // Rapid presses and event bursts collapse to one request.
  // Refresh only: a NEW query (search/filter) supersedes the read in flight
  // instead of being dropped — behaviour covered in check_mobile_functional_closure.
  assert.match(pagedQuery, /if \(mode === "refresh" && inFlight\.current !== null\) return;/);
  // A late answer for a filter the user already left must not repaint.
  assert.match(pagedQuery, /if \(mine !== generation\.current\) return;/);
});

// ═══════════════════════════════════════════════════════════════════════════
// F · G — the Owner's subject labels
// ═══════════════════════════════════════════════════════════════════════════

test("F · every SubjectList that renders an entity id resolves it to a name", () => {
  const calls = [...owner.matchAll(/<SubjectList[\s\S]*?\/>/g)].map((m) => m[0]);
  assert.equal(calls.length, 5, "channels, wallets, suppliers, courier receivable, courier payable");
  for (const call of calls) {
    assert.match(call, /labelOf=/, `a SubjectList without labelOf renders raw ids:\n${call}`);
  }
  // The three that used to print UUIDs, each through the right registry.
  const supplier = calls.find((c) => c.includes("supplierPayable"));
  assert.match(supplier, /labelOf=\{\(id\) => names\.suppliers\.get\(id\)\}/);
  for (const key of ["courierReceivable", "courierPayable"]) {
    assert.match(calls.find((c) => c.includes(key)), /labelOf=\{\(id\) => names\.couriers\.get\(id\)\}/);
  }
});

test("F · the names come from the canonical readers, not a new lookup", () => {
  assert.match(subjectNames, /import \{ readSuppliers \} from "@\/lib\/receiving";/);
  assert.match(subjectNames, /import \{ readMobileCouriers \} from "\.\/mobileReaders";/);
  // No second query against these tables.
  assert.doesNotMatch(code(subjectNames), /\.from\(/);
});

test("G · an id that resolves to nothing is labelled deliberately, and kept", () => {
  assert.match(owner, /const UNRESOLVED_SUBJECT = "غير معروف";/);
  // The fallback is only reached when the registry genuinely has no entry…
  assert.match(owner, /const resolved = labelOf\?\.\(row\.subjectId\);/);
  assert.match(owner, /label=\{resolved \?\? UNRESOLVED_SUBJECT\}/);
  // …and the raw id survives as the hint, because an orphaned balance is money
  // someone still has to chase and the id is the only handle left on it.
  assert.match(owner, /hint=\{resolved \? undefined : row\.subjectId\}/);
  assert.match(owner, /labelOf\?: \(subjectId: string\) => string \| undefined;/,
    "labelOf must be allowed to say 'unknown' rather than inventing a name");
});

test("G · a failed label lookup never withholds or fakes a balance", () => {
  // Labels are a nicety; the figure is not. The readers swallow their errors
  // and the row falls back to the id rather than disappearing.
  assert.match(subjectNames, /\.catch\(\(\) => \[\]\)/);
  assert.match(subjectNames, /\.catch\(\(\) => new Map\(\)\)/);
  assert.doesNotMatch(code(subjectNames), /throw/);
});
