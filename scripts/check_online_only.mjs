/**
 * The cloud-native contract, asserted against the real files.
 *
 *     node --test scripts/check_online_only.mjs
 *
 * Source-level, deliberately. The failures these guard are not logic errors —
 * they are writes that lose quietly and reads that overwrite good state with
 * stale state. Nothing throws, no unit test goes red, and the only symptom is a
 * product that was there a moment ago and is not there now.
 *
 * A test that RUNS the code cannot catch that without a live Supabase. A test
 * that checks the code does not reach for the shape that caused it can.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const exists = (p) => existsSync(new URL(p, import.meta.url));

const business = read("../src/store/useBusinessStore.ts");
const orders = read("../src/store/useOrderStore.ts");
const customers = read("../src/store/useCustomerStore.ts");
const branches = read("../src/store/useBranchStore.ts");
const financial = read("../src/store/useFinancialStore.ts");
const cloudData = read("../src/services/cloudData.ts");
const hydrate = read("../src/services/cloudHydrate.ts");
const boot = read("../src/hooks/useRealtimeSync.ts");
const driver = read("../src/lib/ledger/driver.ts");

const NL = String.fromCharCode(10);

/** Source lines with comments dropped — a comment naming a bug is not the bug. */
const codeLines = (src) =>
  src.split(NL).filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });

/**
 * The file with every comment removed.
 *
 * Every "must not appear" assertion below runs against THIS, not the raw text.
 * These files explain at length what they no longer do, and a docblock saying
 * "the `_client_id` check is gone" would otherwise fail the test asserting that
 * `_client_id` is gone.
 */
const code = (src) => codeLines(src).join(NL);

const STORES = [
  ["useBusinessStore", business],
  ["useOrderStore", orders],
  ["useCustomerStore", customers],
  ["useBranchStore", branches],
];

// ── The local database is gone ──────────────────────────────────────────────

test("no local database module survives", () => {
  for (const gone of [
    "../src-tauri",
    "../src/lib/db.ts",
    "../src/lib/tauri.ts",
    "../src/lib/ledger/idbDriver.ts",
    "../src/services/browserLedgerSync.ts",
    "../src/services/ledgerSyncEngine.ts",
    "../src/services/inboundSync.ts",
  ]) {
    assert.ok(!exists(gone), `${gone} must not exist in a cloud-native build`);
  }
});

test("nothing in src/ imports Tauri or opens an IndexedDB", () => {
  // One grep over the whole tree, because the failure is a single stray import
  // that pulls a desktop-only package into a web bundle.
  const all = [...STORES.map(([, s]) => s), cloudData, hydrate, boot, driver];
  for (const src of all) {
    for (const banned of ["@tauri-apps", "indexedDB.open", "idbDriver"]) {
      assert.ok(!code(src).includes(banned), `${banned} must not appear`);
    }
  }
});

test("the ledger driver reads and writes Supabase, not a local file", () => {
  assert.match(driver, /from\("ledger_events"\)/, "events must come from Supabase");
  assert.match(driver, /from\("ledger_lines"\)/, "lines must come from Supabase");
  // `ledger_append` was the Rust command behind the SQLite write path.
  assert.ok(!code(driver).includes("ledger_append"), "the Tauri append command is gone");
});

test("the ledger uses the column names the DEPLOYED table actually has", () => {
  // Verified against the live database, not against
  // docs/migrations/000_master_schema.sql — the two have drifted. The schema
  // file declares `qty` and `amount`; the deployed `ledger_lines` has
  // `qty_delta` and `amount_delta`.
  //
  // This is not pedantry. The sync layer this replaced sent `qty` / `amount`,
  // so PostgREST rejected every line it ever pushed, and the failure was
  // swallowed by a catch. Stock and money silently stopped agreeing across
  // devices. If someone "fixes" these names back to match the schema file,
  // that breaks again with no test to catch it — so this is the test.
  // Scoped to `append`, because that is the block whose keys become column
  // names on the wire. Elsewhere in the file `qty:` is a legitimate field of
  // the Balance shape this module returns.
  const append = code(driver).slice(
    code(driver).indexOf("async append("),
    code(driver).indexOf("async balances("),
  );
  for (const real of ["qty_delta:", "amount_delta:", "unit_cost:"]) {
    assert.ok(append.includes(real), `append must write ${real}`);
  }
  for (const wrong of ["qty:", "amount:"]) {
    assert.ok(!append.includes(wrong), `${wrong} is not a column on ledger_lines`);
  }

  // And the read side must sum the same columns it wrote.
  const balances = code(driver).slice(code(driver).indexOf("async balances("));
  assert.ok(balances.includes("qty_delta"), "balances must sum qty_delta");
  assert.ok(balances.includes("amount_delta"), "balances must sum amount_delta");
});

test("a balance pages past PostgREST's 1000-row cap", () => {
  // A balance is a SUM over every line ever written. A silently truncated first
  // page reads on screen as stock that vanished — the exact class of bug this
  // whole rewrite is about.
  assert.match(driver, /\.range\(/, "balances must paginate");
});

// ── Writes confirm before they commit ───────────────────────────────────────

test("no store commits a row before Supabase confirms it", () => {
  // The disappearing-product bug in one assertion. `writeThrough` used to take
  // a refetch callback and fire the write with `void`; local state was updated
  // first, and a failed write "undid" itself by re-reading the whole table.
  assert.ok(
    !cloudData.includes("void cloudUpsert"),
    "cloudUpsert must be awaited, never fired and forgotten",
  );
  assert.match(
    cloudData,
    /export async function writeThrough/,
    "writeThrough must be async so callers can await it",
  );
  assert.match(
    cloudData,
    /\.select\(\)[\s\S]{0,40}\.single\(\)/,
    "an upsert must read back the row it stored",
  );
});

test("a failed write does NOT re-read the table to undo itself", () => {
  // Re-reading on failure is what removed rows the user had just created, and
  // it raced writes that were perfectly healthy.
  assert.ok(!code(cloudData).includes("refetch"), "no refetch-on-failure path may remain");
  assert.ok(
    !hydrate.includes("export function refetcher"),
    "the per-table refetcher existed only to serve that path",
  );
});

test("writeThrough rethrows so a caller cannot commit after a failure", () => {
  const fn = cloudData.slice(
    cloudData.indexOf("export async function writeThrough"),
    cloudData.indexOf("export async function deleteThrough"),
  );
  assert.match(fn, /throw/, "writeThrough must rethrow");
});

test("every reference mutation goes through the awaited write layer", () => {
  assert.match(business, /writeThrough|deleteThrough/);
  assert.match(orders, /writeThrough/);
  assert.match(customers, /writeThrough|deleteThrough/);
  assert.match(branches, /writeThrough/);
});

test("no offline queue survives in any store", () => {
  // `pushOrQueue` held a write locally when the push failed and drained it on a
  // later reconnect — which made a rejected write look exactly like an accepted
  // one until the reconnect never came.
  for (const [name, src] of [...STORES, ["useFinancialStore", financial]]) {
    const calls = codeLines(src).filter((l) => l.includes("pushOrQueue"));
    assert.equal(calls.length, 0, `${name} still uses pushOrQueue: ${calls.join(" | ")}`);
  }
});

// ── Hydration is boot-only ──────────────────────────────────────────────────

test("hydrateAll clears state before it fetches", () => {
  // `partialize` governs what zustand WRITES, not what it reads back, so the
  // first boot after upgrading still rehydrates the old blob. Without an
  // explicit clear the device shows its stale cache one last time.
  assert.match(hydrate, /export function clearCloudOwnedState/);
  const fn = hydrate.slice(hydrate.indexOf("export async function hydrateAll"));
  const clearAt = fn.indexOf("clearCloudOwnedState()");
  const fetchAt = fn.indexOf("cloudList(");
  assert.ok(clearAt > 0, "hydrateAll must clear");
  assert.ok(clearAt < fetchAt, "the clear must happen BEFORE the first fetch");
});

test("nothing triggers a hydrate after a mutation", () => {
  // Because hydrateAll EMPTIES every collection before re-reading, running it
  // alongside a write clears the new row locally before the answer that
  // contains it arrives. That is a second, independent way for a product to
  // disappear, and it is why no store may reach for it.
  for (const [name, src] of [...STORES, ["useFinancialStore", financial]]) {
    assert.ok(!code(src).includes("hydrateAll"), `${name} must not trigger a hydrate`);
    assert.ok(!code(src).includes("cloudHydrate"), `${name} must not import cloudHydrate`);
  }
});

test("the legacy offline queue is drained before hydration overwrites it", () => {
  // Upgrading stops persisting `syncQueue`. Reading the cloud first would
  // overwrite unsent rows from the OLD build with the server's older copy.
  assert.match(hydrate, /drainLegacyQueue/);
  const bootCode = code(boot);
  const drainAt = bootCode.indexOf("drainLegacyQueue()");
  const hydrateAt = bootCode.indexOf("hydrateAll()");
  assert.ok(drainAt > 0 && hydrateAt > 0, "boot must do both");
  assert.ok(drainAt < hydrateAt, "the drain must run BEFORE the hydrate");
});

// ── State comes from the cloud, not from this machine ───────────────────────

test("cloud-owned collections are not persisted to localStorage", () => {
  // The stale-cache bug in one assertion: if `products` is persisted, a device
  // shows what it cached rather than what the database holds.
  for (const [name, src] of STORES) {
    assert.match(src, /partialize/, `${name} must declare partialize`);
  }

  const part = business.slice(business.indexOf("partialize:"), business.indexOf("},\n  ),"));
  for (const cloudOwned of [
    "products:", "suppliers:", "promoDiscounts:", "returnRecords:",
    // `purchase_invoices` now exists as a table, so a local copy would be
    // exactly the stale cache this whole contract exists to prevent.
    "purchaseInvoices:",
  ]) {
    assert.ok(!part.includes(cloudOwned), `${cloudOwned} is cloud-owned and must not be persisted`);
  }
  // …and it MUST keep the ones that exist nowhere else.
  for (const localOnly of ["partners:", "wholesaleInvoices:"]) {
    assert.ok(part.includes(localOnly), `${localOnly} has no cloud table — dropping it deletes it`);
  }
});

test("every hydrated table is described in the cloud schema", () => {
  // A sink with no schema entry means `toRemoteRow` passes the row through
  // verbatim, so a local-only field names a column that does not exist and
  // PostgREST rejects the WHOLE upsert. That is how `purchase_invoices` would
  // have failed the moment it was wired up.
  const schema = read("../src/services/api/cloudSchema.ts");
  const start = hydrate.indexOf("const SINKS");
  const sinkBlock = hydrate.slice(start, hydrate.indexOf("};", start));
  for (const line of sinkBlock.split(NL)) {
    const hit = /^ {2}([a-z_]+):/.exec(line);
    if (hit) {
      assert.ok(schema.includes(hit[1] + ": {"), hit[1] + " has a sink but no CLOUD_SCHEMA entry");
    }
  }
});

test("realtime is kept — it is a push, not a poll", () => {
  // Removing it would mean a change on one machine never appears on the other
  // without a manual refresh.
  assert.match(boot, /postgres_changes/);
  assert.match(boot, /\.subscribe\(\)/);
});

test("no background polling loop remains", () => {
  const intervals = codeLines(boot).filter((l) => l.includes("setInterval"));
  assert.equal(intervals.length, 0, "no background polling loop may remain");
});

test("realtime skips this client's own echoes by a column that exists", () => {
  // The old check compared `payload.new._client_id` against a per-tab UUID.
  // No table has a `_client_id` column, so the check never matched and every
  // write was echoed back into the store it came from.
  assert.ok(!code(boot).includes("_client_id"), "_client_id is not a real column");
  assert.match(code(boot), /device_id/, "the echo check must use device_id");
});
