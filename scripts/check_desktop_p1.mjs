/**
 * Desktop P1 Wave 1 — numbering, stock authority, realtime coverage.
 *
 *     node --test scripts/check_desktop_p1.mjs
 *
 * Static assertions against the source, which is the house style here: these
 * modules import through the `@/` alias and pull in React and the Supabase
 * client, none of which `node --test` can resolve. What each test pins is a
 * fact about the shipped code, not a rendering.
 *
 * Three defects, one theme — the desktop trusting something local for an
 * answer only the server has:
 *
 *   A  order numbers came from `Date.now()`, so the DEVICE CLOCK decided a
 *      business document's identity and two devices could mint the same one;
 *   B  the stock gate fell through to the `products.quantity` mirror before an
 *      aggregation had landed, so a cold till validated a sale against
 *      whatever it last saw itself;
 *   C  sixteen tables were published for realtime and five were listened to,
 *      so eleven writes were broadcast to every tab and dropped by all of them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/**
 * Comments stripped. Every file here EXPLAINS the defect it fixed, by name and
 * usually with the old expression quoted — so a test that grepped the raw text
 * would pass on the prose alone.
 */
const code = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");

const orderStore = code(read("../src/store/useOrderStore.ts"));
const orderForm = code(read("../src/routes/ecommerce-orders.tsx"));
const wholesale = code(read("../src/components/wholesale/WholesalePage.tsx"));
const checkout = code(read("../src/components/sales/CheckoutForm.tsx"));
const snapshot = code(read("../src/lib/ledger/stockSnapshot.ts"));
const product = code(read("../src/lib/product.ts"));
const realtime = code(read("../src/hooks/useRealtimeSync.ts"));
const migration = read("../docs/migrations/042_order_number_from_counter.sql");

// ── P1-A · ORDER NUMBERING ──────────────────────────────────────────────────

test("no order number is minted from the clock, anywhere in src", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(`${dir}/${entry.name}`);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const src = code(read(`${dir}/${entry.name}`));
      // The shape that was there: a document prefix immediately followed by an
      // interpolated clock reading. `pos_${Date.now()}` is deliberately NOT
      // matched — it is a synthetic foreign key for a walk-in return that has
      // no originating order, not a number anybody reads or sorts by.
      if (/["'`][A-Z]{2,6}-\$\{Date\.now\(\)\}/.test(src)) {
        offenders.push(`${dir}/${entry.name}`);
      }
    }
  };
  walk("../src");
  assert.deepEqual(offenders, [], "a business document number is being built from Date.now()");
});

test("addOrder draws the number from the store counter", () => {
  assert.match(
    orderStore,
    /nextDocumentNumber\(\s*["']ecommerce_order["']\s*,\s*["']ECO-["']\s*\)/,
    "the counter is not being used — `addOrder` must allocate through next_document_number",
  );
  assert.ok(
    !/`ECO-\$\{/.test(orderStore),
    "a client-side ECO- fallback is back; a number two orders might share must never be minted locally",
  );
  // A failure has to REFUSE, and it has to refuse in the shape the callers
  // already handle: the جملة caller does not wrap `addOrder` in a try.
  const body = orderStore.slice(orderStore.indexOf("addOrder: async"));
  const alloc = body.indexOf("nextDocumentNumber");
  const guard = body.indexOf("success: false");
  assert.ok(alloc > -1 && guard > alloc && guard < body.indexOf("saveOrder"),
    "the allocation is not wrapped into a `{ success: false }` return before the save");
});

test("the order form allocates before the ledger event, and links them", () => {
  const alloc = orderForm.indexOf('nextDocumentNumber("ecommerce_order", "ECO-")');
  const placed = orderForm.indexOf('kind: "order_placed"');
  assert.ok(alloc > -1, "the order form does not draw a canonical number");
  assert.ok(placed > -1 && alloc < placed, "the number must exist BEFORE `order_placed` is appended");
  assert.match(
    orderForm.slice(placed, placed + 400),
    /refId: orderNumber/,
    "the opening ledger event must carry the order number, or the order is untraceable",
  );
  // A refused allocation must give the discount use back — it was claimed
  // above, atomically, and a burnt use on a one-use code is the only one.
  const failure = orderForm.slice(alloc, placed);
  assert.match(failure, /releaseDiscountUse\(/, "a failed allocation leaves the discount use burnt");
});

test("migration 042 protects the number and seeds without the clock", () => {
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS orders_number_per_store\s+ON public\.orders \(store_id, "orderNumber"\)/,
    "the unique index is the last line of defence and must exist",
  );
  assert.match(migration, /'ecommerce_order'/, "the counter must be seeded");
  // Seeding the way 016 does — MAX of every digit in the column — would read a
  // 13-digit millisecond timestamp and start the counter at 1.75 trillion.
  assert.ok(
    !/regexp_replace\([^)]*"orderNumber"/.test(migration),
    "seeding from all digits would swallow the legacy ECO-<ms> numbers and restart the clock",
  );
  assert.match(
    migration,
    /\^ECO-\[0-9\]\{1,9\}\$/,
    "the seed must read canonical numbers only, so historical ECO-<ms> orders are left alone",
  );
});

// ── P1-B · STOCK AUTHORITY ──────────────────────────────────────────────────

test("the ledger still wins, and the mirror is still there", () => {
  const fn = product.slice(product.indexOf("export function getActualStock"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /ledgerQty\(product\.id\)/, "the ledger must be consulted first");
  assert.ok(
    body.indexOf("ledgerQty") < body.indexOf("totalQuantity"),
    "the mirror is being read before the ledger",
  );
  // Position is not the contract — REACHABILITY is. Falsifying the condition
  // around the ledger read leaves it sitting above the mirror, in source order,
  // doing nothing: every product would silently answer from the cache again.
  // So pin the condition itself, and pin that a real answer returns.
  assert.match(
    body,
    /if \(product\?\.id && !\(product as any\)\.isBundle\)/,
    "the ledger branch is no longer entered for ordinary products",
  );
  assert.match(
    body,
    /if \(fromLedger !== null\) return Math\.max\(0, fromLedger\);/,
    "a ledger answer must be RETURNED; falling through to the mirror with one in hand is the bug",
  );
  // Deleting the mirror was explicitly out of scope: it is what lets a list of
  // 200 products render without 200 aggregations, and what the one frame
  // before the first read has to show.
  assert.match(body, /totalQuantity/, "the mirror fallback has been deleted — 200 rows now cost 200 reads");
});

test("`null` is still not zero", () => {
  assert.match(
    snapshot,
    /export function ledgerQty[\s\S]*?if \(!snapshot\) return null;/,
    "an unloaded snapshot must report null, never 0 — 0 paints a sold-out shop",
  );
  assert.match(
    snapshot,
    /export function stockIsAuthoritative\(\): boolean \{\s*return snapshot !== null;\s*\}/,
    "the commit paths have nothing to ask whether the number they hold is the ledger's",
  );
});

test("every path that COMMITS against stock refuses a mirror number", () => {
  for (const [name, src, compare] of [
    ["نقاط البيع", checkout, "const short = cart.find("],
    ["الجملة", wholesale, "const short = invoiceItems.find("],
    ["الطلبات أونلاين", orderForm, "if (quantity > onHand)"],
  ]) {
    const gate = src.indexOf("stockIsAuthoritative()");
    const check = src.indexOf(compare);
    assert.ok(gate > -1, `${name}: commits against stock without asking whether the ledger has landed`);
    assert.ok(check > -1, `${name}: the stock comparison this guards has moved — retarget the test`);
    assert.ok(
      gate < check,
      `${name}: the guard runs AFTER the comparison, so the mirror still decides the sale`,
    );
  }
});

test("display paths are left alone", () => {
  // The guard belongs at the three commits, not on the 48 callers drawing a
  // label. A products page that refuses to render until an aggregation lands
  // is a worse product than one that shows a cached number for a frame.
  for (const [name, file] of [
    ["InventoryTable", "../src/components/inventory/InventoryTable.tsx"],
    ["ProductSearch", "../src/components/products/ProductSearch.tsx"],
    ["BundlesPage", "../src/components/ecommerce/BundlesPage.tsx"],
  ]) {
    assert.ok(
      !/stockIsAuthoritative/.test(code(read(file))),
      `${name}: a rendering path is now blocked on the ledger — that is not what this guard is for`,
    );
  }
});

// ── P1-C · REALTIME COVERAGE ────────────────────────────────────────────────

/** The tables this desktop listens to, read off the handler map. */
const SUBSCRIBED = [
  "products", "orders", "transactions", "expenses",
  "customers", "suppliers", "purchase_invoices", "return_records",
  "discount_codes", "wholesale_clients", "wholesale_invoices", "shipping_rates",
];

test("every table with a desktop consumer is subscribed", () => {
  // The handlers must actually REACH the map. Naming a table inside a call
  // whose result is discarded reads exactly like a subscription and delivers
  // nothing — the whole defect this wave is closing, one level up.
  assert.match(
    realtime,
    /\n\s*\.\.\.reference\(\{/,
    "the reference handlers are no longer spread into TABLE_HANDLERS",
  );
  for (const table of SUBSCRIBED) {
    assert.match(
      realtime,
      new RegExp(`(^|[\\s{,])${table}:`, "m"),
      `${table} is published and read by a desktop screen, but nothing listens for it`,
    );
  }
});

test("nothing is subscribed blindly", () => {
  // Published, and deliberately not listened to. Each would be a cost with no
  // reader: `ledger_lines` re-fires the pulse `ledger_events` already sends,
  // once per line of every sale; `stores` is licence and identity, which
  // `useSessionReconciliation` owns; `branches` is structural.
  for (const table of ["ledger_lines", "stores", "branches"]) {
    assert.ok(
      !new RegExp(`table: ['"]${table}['"]`).test(realtime) &&
        !new RegExp(`(^|[\\s{,])${table}:`, "m").test(realtime),
      `${table} is now subscribed — say why here, or do not subscribe to it`,
    );
  }
});

test("the subscription is driven by the handler map, not a second list", () => {
  assert.match(
    realtime,
    /Object\.keys\(TABLE_HANDLERS\)[\s\S]{0,400}?'postgres_changes'/,
    "the listeners are enumerated by hand again — a handler nobody subscribes to looks identical to a working one",
  );
  assert.equal(
    (realtime.match(/\.channel\(/g) || []).length,
    1,
    "there must be exactly one channel; a second one is a second socket per tab",
  );
  assert.match(realtime, /\.channel\('global-sync'\)/, "the channel name changed");
});

test("realtime still waits for the reconciled session (1cb38ce)", () => {
  assert.match(
    realtime,
    /if \(isCloudSyncMode\(\) && authenticated\) \{/,
    "the channel is being opened before the session is restored — it would join as anon and deliver nothing, silently, for the rest of its life",
  );
  assert.match(
    realtime,
    /if \(!authenticated\) return;/,
    "the boot hydrate lost its gate — 14 reads before the session lands come back empty and CLEAR the stores",
  );
  assert.match(realtime, /return sessionState;/, "the verdict must still reach ProtectedRoute");
});

test("the new handlers compare a real clock and drop echoes", () => {
  const fn = realtime.slice(realtime.indexOf("function reference("));
  assert.match(
    fn,
    /Number\(existing\.updated_at\) >= Number\(incoming\.updated_at\)/,
    "Last Write Wins must compare the epoch-ms sync clock as numbers",
  );
  assert.match(
    realtime,
    /function isOwnEcho[\s\S]*?row\.device_id === getDeviceId\(\)/,
    "a tab's own writes must not be echoed back over the row it just wrote",
  );
});
