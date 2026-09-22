/**
 * PHASE 2 — the sync layer, re-audited.
 *
 *     node --test scripts/check_sync_layer.mjs
 *
 * ## The bug this exists to stop coming back
 *
 * `useRealtimeSync` opened one channel with five `postgres_changes` listeners.
 * Postgres only streams a table to Realtime if that table is in the
 * `supabase_realtime` publication — and three of the five were not in it:
 * `orders`, `transactions` and `expenses`. The subscription was created, the
 * callback was wired, and **nothing was ever delivered**. A second browser
 * never learned the first had taken an order; the row appeared only after a
 * manual refresh or a reload.
 *
 * It fails SILENTLY in both directions, which is what makes it worth a test:
 * subscribing to an unpublished table throws nothing, and publishing a table
 * nobody subscribes to costs nothing. Only a machine notices the mismatch.
 *
 * So the invariant is an EQUALITY, not a subset: every table the client
 * listens to must be published, and the publication is the repo's own
 * `full_supabase_init.sql` plus migration 036.
 *
 * The rest of the file pins the other PHASE 2 items that are satisfiable from
 * source. Tenancy, RLS and the column set are properties of the DATABASE and
 * are proven in `check_supabase_integrity.mjs` and in the phase report, not
 * guessed at here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(new RegExp("//[^\\n]*", "g"), "");

const realtime = read("../src/hooks/useRealtimeSync.ts");
const realtimeCode = strip(realtime);
const sidebar = read("../src/components/dashboard/Sidebar.tsx");
const sidebarCode = strip(sidebar);
const syncStatus = read("../src/store/useSyncStatus.ts");
const initSql = read("../docs/full_supabase_init.sql");
const migration036 = read("../docs/migrations/036_realtime_publication_gap.sql");
/** Every migration, concatenated — the publication is built across all of them. */
const allMigrations = readdirSync(new URL("../docs/migrations", import.meta.url))
  .filter((f) => f.endsWith(".sql"))
  .map((f) => read(`../docs/migrations/${f}`))
  .join("\n");

/**
 * Tables the client actually opens a postgres_changes listener on.
 *
 * The listeners are no longer written out one by one — the channel is built by
 * reducing over `TABLE_HANDLERS`, so a table is subscribed exactly when it has
 * a handler. Reading the handler map IS reading the subscription list, and
 * that is the point: the old hand-written list is how four listeners stayed
 * the whole of realtime while the publication grew to sixteen.
 *
 * `ledger_events` is matched separately — it is a pulse with no handler, not a
 * merge.
 */
const HANDLERS_AT = realtimeCode.indexOf("const TABLE_HANDLERS");
// From the object LITERAL, not from the declaration: the inline
// `Record<string, { getAll; merge; remove }>` annotation above it has keys at
// the same indentation, and they are not tables.
const HANDLER_BLOCK = realtimeCode.slice(
  realtimeCode.indexOf("}> = {", HANDLERS_AT),
  realtimeCode.indexOf("\n};", HANDLERS_AT),
);
const REFERENCE_BLOCK = HANDLER_BLOCK.slice(HANDLER_BLOCK.indexOf("...reference({"));
const SUBSCRIBED = [
  ...new Set([
    // The four hand-written handlers, at two spaces of indentation.
    ...[...HANDLER_BLOCK.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]),
    // The reference tables, at four, inside `reference({ … })`.
    ...[...REFERENCE_BLOCK.matchAll(/^ {4}([a-z_]+): \[/gm)].map((m) => m[1]),
    // Anything still named as a literal — today just the ledger pulse.
    ...[...realtimeCode.matchAll(/table:\s*'([a-z_]+)'/g)].map((m) => m[1]),
  ]),
].sort();

/**
 * Tables the repo's SQL puts in the realtime publication.
 *
 * Every migration, not just the init file and 036: `wholesale_clients` and
 * `wholesale_invoices` are published by 016, and a check that only reads two
 * files would call them unpublished and fail a subscription that is correct.
 */
const PUBLISHED = [
  ...new Set(
    [
      ...(initSql + migration036 + allMigrations).matchAll(
        /ALTER PUBLICATION supabase_realtime ADD TABLE public\.([a-z_]+)/g,
      ),
    ].map((m) => m[1]),
  ),
].sort();

// ═══════════════════════════════════════════════════════════════════════════
// Item: "Wire pull — on boot + on `online` + every 5 min"
// ═══════════════════════════════════════════════════════════════════════════

test("every table the client subscribes to is actually published", () => {
  // A floor, not a count. It was five; P1-C raised it to thirteen — the twelve
  // merged tables plus the `ledger_events` pulse — by subscribing every
  // published table that a desktop screen actually reads. Adding another is
  // fine; silently losing them is not.
  assert.ok(
    SUBSCRIBED.length >= 13,
    `realtime coverage went backwards: expected at least 13 tables, found ${SUBSCRIBED.length} (${SUBSCRIBED.join(", ")})`,
  );
  const silent = SUBSCRIBED.filter((t) => !PUBLISHED.includes(t));
  assert.deepEqual(
    silent,
    [],
    `these tables are subscribed but NOT in the publication, so their listeners receive nothing:\n  ${silent.join("\n  ")}`,
  );
  // The three that were missing, named so the regression is unmistakable.
  for (const table of ["orders", "transactions", "expenses"]) {
    assert.ok(SUBSCRIBED.includes(table), `${table} must stay subscribed`);
    assert.ok(PUBLISHED.includes(table), `${table} must stay published`);
  }
});

test("the pull legs the plan asked for are wired: boot and reconnect", () => {
  // "every 5 min" is served by the realtime channel above rather than a timer —
  // continuous beats polling, and it is the same rows either way.
  assert.match(realtimeCode, /useEffect\(\(\) => \{[\s\S]{0,400}hydrateAll\(\)/, "boot hydration");
  assert.match(realtimeCode, /addEventListener\('online', handleOnline\)/, "reconnect hydration");
  assert.match(realtimeCode, /removeEventListener\('online', handleOnline\)/, "and it is cleaned up");
  assert.ok(!/setInterval/.test(realtimeCode), "no polling timer — the channel is the continuous leg");
});

// ═══════════════════════════════════════════════════════════════════════════
// Item: "Fix echo guard (compare `device_id`, not the missing `_client_id`)"
// ═══════════════════════════════════════════════════════════════════════════

test("the echo guard compares a column that exists", () => {
  assert.match(realtimeCode, /function isOwnEcho/);
  assert.match(realtimeCode, /row\.device_id === getDeviceId\(\)/, "device_id is a real column");
  assert.ok(
    !/_client_id/.test(realtimeCode),
    "`_client_id` is a field no table has — comparing it never matched, so every write echoed back",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Item: "Sidebar status = real (online/offline + pending count + last-sync +
//        'sync now' button)"
// ═══════════════════════════════════════════════════════════════════════════

test("the sidebar reports the real connection, not a painted-on green dot", () => {
  assert.match(sidebarCode, /const online = useOnline\(\)/, "from navigator.onLine");
  assert.match(sidebarCode, /online\s*\?\s*"سحابي متصل"\s*:\s*"غير متصل بالإنترنت"/);
  // The old block hardcoded both the dot colour and the caption.
  assert.ok(
    !/bg-green-500[\s\S]{0,200}سحابي متصل/.test(sidebarCode.replace(/online[\s\S]{0,40}\?/g, "")),
    "the dot must be conditional, not always green",
  );
});

test("«آخر مزامنة» comes from a read that actually returned", () => {
  assert.match(sidebarCode, /lastSyncLabel\(lastSyncAt\)/);
  // markSynced is called only AFTER hydrateAll resolves, never before it.
  const boot = realtimeCode.slice(realtimeCode.indexOf("hydrateAll()"));
  assert.match(boot, /markSynced\(\)/, "boot records a successful sync");
  assert.match(realtimeCode, /markSyncing\(false\)[\s\S]{0,200}catch-up hydrate failed|catch[\s\S]{0,120}markSyncing\(false\)/,
    "a failed catch-up must not stamp a fresh timestamp");
  assert.ok(
    !/markSynced\(\)[\s\S]{0,60}await hydrateAll/.test(realtimeCode),
    "the timestamp must never be written before the read resolves",
  );
  // The CODE must not wrap the store in zustand's `persist` middleware — a
  // restored "last synced" would claim a read that never happened. (The file's
  // comment says so too, which is why this reads the stripped source.)
  assert.ok(!/persist\(/.test(strip(syncStatus)), "the store must not be persisted");
});

test("«مزامنة الآن» calls the same hydrate the automatic legs call", () => {
  assert.match(sidebarCode, /const syncNow = async \(\)/);
  assert.match(sidebarCode, /await hydrateAll\(\)/, "one read path, not a second one");
  assert.match(sidebarCode, /onClick=\{syncNow\}/);
  assert.match(sidebarCode, /disabled=\{syncing \|\| !online\}/, "no offline sync button that cannot work");
});

test("no pending count is invented, because the queue it counted is gone", () => {
  // The offline-first queue was removed: every write awaits the server, which
  // `useRealtimeSync` states outright. A badge reading 0 forever is the
  // fabricated number `alertModel` already refuses for counts.
  assert.ok(!/pendingCount|pending_count/.test(sidebarCode), "no fabricated pending badge");
  assert.ok(!/pendingCount|pending_count/.test(syncStatus));
  assert.match(
    syncStatus,
    /pending count/,
    "and the omission is written down where the next reader will look",
  );
  // The reason is recorded in the hook's own prose, so the next reader does
  // not re-add a queue counter — hence the RAW source, not the stripped one.
  assert.match(realtime, /every write was awaited when it was made/, "the reason, written down");
});
