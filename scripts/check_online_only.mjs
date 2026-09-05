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
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

/**
 * Every store action that ends in a Supabase write. Used by two guards: one
 * that they are awaited, and one that a handler calling them is gated against
 * a double click.
 */
const MUTATION_NAMES = [
  "addProduct", "updateProduct", "removeProduct", "archiveProduct", "restoreProduct",
  "addSupplier", "updateSupplier", "addPurchaseInvoice", "recordSupplierPayment",
  "addWholesaleClient", "updateWholesaleClient", "addWholesaleInvoice",
  "recordWholesalePayment", "archiveWholesaleClient",
  "addCustomer", "updateCustomer", "removeCustomer", "archiveCustomer",
  "addBranch", "updateBranch", "removeBranch",
  "addPromoDiscount", "updatePromoDiscount", "removePromoDiscount",
  "addOrder", "updateOrder", "addReturnRecord", "addExpense", "addTransaction",
];


/** Source lines with comments dropped — a comment naming a bug is not the bug. */
const codeLines = (src) => {
  // Also drops JSX `{/* ... */}` comment blocks. Without that, a comment
  // EXPLAINING why an element must be present satisfies the very assertion
  // checking for it — which is exactly how the <Toaster/> guard first passed
  // against a deliberately unmounted Toaster.
  let inJsxComment = false;
  return src.split(NL).filter((l) => {
    const t = l.trimStart();
    if (inJsxComment) {
      if (t.includes("*/")) inJsxComment = false;
      return false;
    }
    if (t.startsWith("{/*")) {
      if (!t.includes("*/")) inJsxComment = true;
      return false;
    }
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
};

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
    // Migration 016. Both were localStorage-only, which is why a wholesale
    // client added on the till did not exist in the office — and an invoice
    // cannot be raised without one, so شاشة الجملة was unusable there.
    "wholesaleClients:", "wholesaleInvoices:",
  ]) {
    assert.ok(!part.includes(cloudOwned), `${cloudOwned} is cloud-owned and must not be persisted`);
  }
  // …and it MUST keep the ones that exist nowhere else.
  for (const localOnly of ["partners:"]) {
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

test("no component fires a cloud mutation without awaiting it", () => {
  // THE most recurring defect in this codebase. Every store mutation that
  // reaches Supabase is async and commits only on success. Called bare, it
  // becomes an unhandled rejection while the surrounding code carries on to
  // clear the form and print "تم الحفظ" — the user is told a write succeeded
  // that the database refused.
  //
  // `void x().catch(...)` is accepted: that is a deliberate, handled decision.
  const CLOUD_MUTATIONS = [
    "addProduct", "updateProduct", "removeProduct", "archiveProduct", "restoreProduct",
    "addCustomer", "updateCustomer", "archiveCustomer", "restoreCustomer",
    "recordReturn", "settleWastedTrip",
    "addOrder", "updateOrder", "updateOrderStatus",
    "addSupplier", "addPurchaseInvoice", "recordSupplierPayment",
    // Cloud rows since migration 016. All four were synchronous local
    // writes, and all five call sites fired them without waiting.
    "addWholesaleClient", "updateWholesaleClient", "addWholesaleInvoice",
    "recordWholesalePayment", "archiveWholesaleClient",
    "addBranch", "updateBranch", "removeBranch",
    "addPromoDiscount", "updatePromoDiscount", "removePromoDiscount",
    "addReturnRecord",
  ];
  const PREFIXES = [
    "useOrderStore.getState().", "useCustomerStore.getState().",
    "useBusinessStore.getState().", "useBranchStore.getState().",
  ];
  // Plain string matching, deliberately: a regex here needs escaping that has
  // silently collapsed twice, producing a check that matched nothing and a
  // green test that guarded nothing.
  const isBareCall = (line) => {
    let t = line.trim();
    for (const p of PREFIXES) if (t.startsWith(p)) t = t.slice(p.length);
    return CLOUD_MUTATIONS.some((m) => t.startsWith(m + "("));
  };

  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = dir + "/" + entry.name;
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) continue;
      readFileSync(full, "utf8").split(NL).forEach((line, i) => {
        if (!isBareCall(line)) return;
        if (line.includes("await") || line.includes("void ") || line.includes(".catch")) return;
        const rel = "src" + full.split("src").pop().split(String.fromCharCode(92)).join("/");
        offenders.push(rel + ":" + (i + 1) + "  " + line.trim().slice(0, 50));
      });
    }
  };
  for (const d of ["components", "routes", "pages"]) {
    walk(fileURLToPath(new URL("../src/" + d, import.meta.url)));
  }

  assert.deepEqual(offenders, [], "these fire a cloud write and do not wait for it:" + NL + offenders.join(NL));
});

test("no store persists a collection that has a cloud table", () => {
  // Generalises the per-store check below. Every table in CLOUD_SCHEMA is
  // hydrated on boot, so a persisted local copy is a stale cache by
  // definition — the exact failure this whole contract exists to prevent.
  // `transactions` and `expenses` were both being persisted after they gained
  // tables; this catches the next one automatically.
  const FIELD_FOR_TABLE = {
    products: "products", suppliers: "suppliers", discount_codes: "promoDiscounts",
    return_records: "returnRecords", purchase_invoices: "purchaseInvoices",
    transactions: "transactions", expenses: "expenses", customers: "customers",
    branches: "branches", orders: "orders",
  };
  const STORE_FILES = [
    ["useBusinessStore", business], ["useOrderStore", orders],
    ["useCustomerStore", customers], ["useBranchStore", branches],
    ["useFinancialStore", financial],
  ];
  for (const [name, src] of STORE_FILES) {
    const at = src.indexOf("partialize");
    if (at < 0) {
      assert.fail(name + " persists without a partialize — it would store every cloud-owned slice");
    }
    const block = code(src).slice(at, at + 900);
    for (const field of Object.values(FIELD_FOR_TABLE)) {
      assert.ok(
        !block.includes(field + ": state." + field),
        name + " persists `" + field + "`, which is cloud-owned and hydrated on boot",
      );
    }
  }
});

test("store settings are pulled from the cloud on boot", () => {
  // `pullSettings` was defined and had zero callers, so the settings screen
  // showed a stale localStorage copy or the hardcoded default ("محلي") and
  // never the row in `public.stores`. Pressing save then wrote that back —
  // silently replacing the real store name, phone, address and tax number.
  //
  // Settings are not one of the SINKS (they live in `stores`, not a synced
  // table), so the sink-coverage test above cannot catch this. Hence its own.
  assert.match(hydrate, /pullSettings\(\)/, "hydrateAll must pull store settings");
  const settings = read("../src/store/useSettingsStore.ts");
  assert.match(settings, /pullSettings: async/, "the action must still exist");
});

test("a Toaster is mounted, or every error message is invisible", () => {
  // sonner's `toast()` is a no-op unless a <Toaster /> exists in the tree.
  // This app had 34 toast calls and no Toaster, so every error and success
  // message it raised rendered nothing — including `cloudData.announce`, the
  // single place every failed write reports itself.
  //
  // The stores were behaving correctly the whole time (refuse the write, keep
  // the user's input, call toast.error) and the user still saw nothing. That
  // is the silent-failure class this file exists to prevent, one layer above
  // the database.
  const app = read("../src/App.tsx");
  // The boundary class matters: a bare /<Toaster/ also matches <ToasterFoo,
  // so the guard would pass on a renamed or disabled element.
  assert.match(code(app), /<Toaster[\s/>]/, "App must mount <Toaster /> or toasts are silent");

  // And the reporter every store write funnels through must still raise one.
  assert.match(cloudData, /toast\.error/, "announce() must still surface failures");
});

test("icon-only buttons carry an accessible name", () => {
  // A `size="icon"` Button renders a glyph and nothing else, so with no
  // aria-label or title a screen reader announces "button" and a row's delete
  // and edit actions are indistinguishable. Library primitives under
  // components/ui own their own semantics and are excluded.
  //
  // The opening tag is found by tracking brace depth, NOT by a regex ending at
  // the first ">". Handlers like `onClick={() => onChange("")}` contain a ">"
  // inside the arrow, so a naive match ends early and reports buttons whose
  // aria-label simply sits on a later line — which is exactly what the first
  // version of this check did.
  const openingTag = (src, at) => {
    let depth = 0;
    for (let i = at; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) return src.slice(at, i + 1);
    }
    return src.slice(at, at + 400);
  };

  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = dir + "/" + e.name;
      if (e.isDirectory()) { if (e.name !== "ui") walk(full); continue; }
      if (!e.name.endsWith(".tsx")) continue;
      const src = readFileSync(full, "utf8");
      let at = src.indexOf("<Button");
      while (at !== -1) {
        const tag = openingTag(src, at);
        if (tag.includes('size="icon"') && !tag.includes("aria-label") && !tag.includes("title=")) {
          const line = src.slice(0, at).split(NL).length;
          offenders.push("src" + full.split("src").pop().split(String.fromCharCode(92)).join("/") + ":" + line);
        }
        at = src.indexOf("<Button", at + 7);
      }
    }
  };
  for (const d of ["components", "routes", "pages"]) {
    walk(fileURLToPath(new URL("../src/" + d, import.meta.url)));
  }
  assert.deepEqual(offenders, [], "icon buttons with no accessible name:" + NL + offenders.join(NL));
});

test("a stale code-split chunk recovers instead of killing the route", () => {
  // Lazy routes (POS and friends) hold hashed chunk names. After a deploy those
  // files are gone, so a tab still running the old shell fails the dynamic
  // import and the route dies behind its error boundary. The service worker
  // makes this MORE likely, because caching a shell is its whole job.
  const main = read("../src/main.tsx");
  assert.match(main, /vite:preloadError/, "must handle Vite's preload failure");
  // And it must not be able to loop: a chunk missing for any reason other than
  // a deploy would otherwise reload forever.
  assert.match(main, /sessionStorage/, "the reload must be one-shot per tab");
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

test("every cloud submit is gated against a double click", () => {
  // `if (saving) return; setSaving(true)` does not stop two clicks in the same
  // tick: React state updates asynchronously, so both handlers read
  // `saving === false` and both fire the write. Proven live on شاشة المشتريات
  // — three presses of "حفظ الفاتورة" produced three POSTs to `ledger_events`,
  // i.e. three purchases, three stock receipts, three debits of the till. It
  // is almost certainly what put the duplicate FM-0001 in this database.
  //
  // Login is exempt (signing in twice costs nothing and the server rate-limits
  // it) and so is `routes/backups.tsx`, which writes no cloud row.
  const EXEMPT = ["Login.tsx", "backups.tsx"];
  const BUSY = /set(?:Is)?(?:Saving|Submitting|Returning|Paying|Busy|Processing)\(true\)/;

  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = dir + "/" + e.name;
      if (e.isDirectory()) { if (e.name !== "ui") walk(full); continue; }
      if (!e.name.endsWith(".tsx") || EXEMPT.includes(e.name)) continue;
      const src = readFileSync(full, "utf8");
      const lines = codeLines(src);
      for (let i = 0; i < lines.length; i++) {
        if (!BUSY.test(lines[i])) continue;
        // The gate must be claimed on one of the few lines above the flag.
        const near = lines.slice(Math.max(0, i - 6), i + 1).join(NL);
        if (!near.includes(".enter()")) {
          offenders.push(e.name + ":" + lines[i].trim());
        }
      }
    }
  };
  for (const d of ["components", "routes", "pages"]) {
    walk(fileURLToPath(new URL("../src/" + d, import.meta.url)));
  }
  assert.deepEqual(
    offenders,
    [],
    "these submits can fire twice from two clicks in one tick:" + NL + offenders.join(NL),
  );
});

test("the submit gate is a ref, not state", () => {
  // A gate built on useState would have exactly the bug it exists to fix.
  const gate = read("../src/hooks/useSubmitGate.ts");
  assert.match(gate, /useRef/, "the gate must flip synchronously");
  assert.ok(!code(gate).includes("useState"), "state cannot close a same-tick window");
});

test("a collapsed sidebar link still has a name", () => {
  // Collapsed, the label span is not rendered and a Radix tooltip is the only
  // thing naming each link — but a tooltip is painted, not announced, and does
  // not exist in the DOM until it opens. Found live: sixteen nav links and the
  // logout button all announced as bare "link"/"button", i.e. the whole primary
  // navigation was unusable without sight of it.
  const sidebar = read("../src/components/dashboard/Sidebar.tsx");
  assert.match(
    code(sidebar),
    /aria-label=\{collapsed \? item\.label : undefined\}/,
    "collapsed nav links need an aria-label",
  );
  assert.match(
    code(sidebar),
    /aria-label=\{collapsed \? "تسجيل الخروج" : undefined\}/,
    "the collapsed logout button needs an aria-label",
  );
});

test("a typed quantity of zero is never coerced to one", () => {
  // `parseInt(e.target.value) || 1` reads 0 as 1, so typing a quantity of zero
  // silently received ONE unit and billed for it — and the field could not be
  // cleared to retype, it snapped back to 1 mid-edit. Validation, not
  // coercion, is what refuses a zero.
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = dir + "/" + e.name;
      if (e.isDirectory()) { if (e.name !== "ui") walk(full); continue; }
      if (!e.name.endsWith(".tsx")) continue;
      for (const l of codeLines(readFileSync(full, "utf8"))) {
        if (/parse(?:Int|Float)\([^)]*\)\s*\|\|\s*1\b/.test(l) && /quantity|qty/i.test(l)) {
          offenders.push(e.name + ":" + l.trim().slice(0, 110));
        }
      }
    }
  };
  for (const d of ["components", "routes", "pages"]) {
    walk(fileURLToPath(new URL("../src/" + d, import.meta.url)));
  }
  assert.deepEqual(offenders, [], "these read a typed 0 as 1:" + NL + offenders.join(NL));
});

test("the integrations card does not claim a verification it never did", () => {
  // The button is "حفظ وتحقق من اكتمال الحقول" — it checks the fields are
  // non-empty and nothing else. Nothing contacts Paymob or the courier. The
  // badge said "تم التحقق" with a green check, which a reader takes as "the
  // provider confirmed these credentials".
  const card = read("../src/components/integrations/IntegrationConfigCards.tsx");
  assert.ok(
    !code(card).includes("تم التحقق"),
    "the badge must not claim the provider verified anything",
  );
});

test("no integration secret is written to localStorage", () => {
  // Paymob's live secret key, the HMAC key that authenticates its webhooks and
  // the courier's API secret were all persisted in clear text under
  // `integrations-storage` — readable by any script that ever runs on this
  // origin, and by anyone with the machine.
  //
  // There is nowhere safe to put them in this deployment: `createServerFn` is
  // a shim that runs "server" functions in the BROWSER. And nothing needs
  // them — every provider client in lib/api/integrations is a scaffold with no
  // network call — so the right amount to keep is none.
  // Offsets must be taken on the SAME string the slice comes from — `code()`
  // drops comment lines, so indexing the raw source and slicing the stripped
  // one lands in a different place entirely.
  const store = code(read("../src/store/useIntegrationsStore.ts"));
  const at = store.indexOf("partialize");
  assert.ok(at > 0, "the integrations store must declare partialize");
  const block = store.slice(at, at + 700);
  for (const secret of ["stripSecrets"]) {
    assert.ok(block.includes(secret), "partialize must strip secrets before persisting");
  }
  // …and scrub what an older build already wrote, rather than waiting for the
  // user to press إعادة التعيين.
  assert.match(store, /merge:/, "merge must scrub secrets already on disk");
  for (const field of ["apiKey", "hmacSecret", "apiSecret", "webhookSecret"]) {
    assert.ok(
      store.includes(`"${field}"`),
      `${field} must be named in a secret list so it is stripped`,
    );
  }
});

test("no integration claims a connection it never made", () => {
  // `testConnection` answered "تم الاتصال بخوادم Paymob بنجاح!" after a
  // setTimeout and a string check. None of the three clients contains a single
  // fetch; announcing a successful connection is a fake success.
  for (const provider of ["paymob", "bosta", "shopify"]) {
    const src = read(`../src/lib/api/integrations/${provider}.ts`);
    assert.ok(
      !/تم الاتصال[^"]*بنجاح/.test(code(src)),
      `${provider} must not report a successful connection — it makes no request`,
    );
  }
});

test("document numbers are allocated by the database", () => {
  // Three different client-side schemes issued FJ- numbers for one store:
  // `wholesaleInvoices.length + 1` in شاشة الجملة, the same in the POS, and
  // `Date.now().slice(-4)` in الطلبات. Two tills billing at once reached the
  // same number, and a browser that had not hydrated started again at 0001.
  const OFFENDERS = [
    "../src/components/wholesale/WholesalePage.tsx",
    "../src/components/sales/CheckoutForm.tsx",
    "../src/components/ecommerce/OrdersPage.tsx",
  ];
  for (const f of OFFENDERS) {
    const src = code(read(f));
    assert.ok(
      !/"FJ-" \+ String\(/.test(src) && !/`FJ-\$\{Date\.now/.test(src),
      `${f} must not mint its own invoice number`,
    );
    assert.match(src, /nextDocumentNumber\(/, `${f} must draw its number from the database`);
  }
  // And the allocator must be atomic, not a read-then-write.
  const alloc = read("../src/services/documentNumber.ts");
  assert.match(alloc, /next_document_number/, "must call the SECURITY DEFINER function");
  assert.ok(!/\|\|\s*["'`]FJ-/.test(code(alloc)), "no local fallback — a shared number is worse than none");
});

test("a plain <button> whose only child is an icon has an accessible name", () => {
  // Third time for this class. The existing guard covers `<Button size="icon">`
  // from components/ui; it could not see the sixteen collapsed sidebar <Link>s,
  // and it could not see this: a bare <button> wrapping a single lucide glyph.
  // The one on /login toggled password visibility and announced as "button" —
  // on the first screen every user meets.
  const NAMED = ["aria-label", "aria-labelledby", "title="];
  const offenders = [];

  const openingTag = (src, at) => {
    let depth = 0;
    for (let i = at; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) return src.slice(at, i + 1);
    }
    return src.slice(at, at + 600);
  };

  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = dir + "/" + e.name;
      if (e.isDirectory()) { if (e.name !== "ui") walk(full); continue; }
      if (!e.name.endsWith(".tsx")) continue;
      const src = readFileSync(full, "utf8");
      let at = src.indexOf("<button");
      while (at !== -1) {
        const tag = openingTag(src, at);
        const close = src.indexOf("</button>", at);
        const body = close > at ? src.slice(at + tag.length, close) : "";
        // Text content = anything outside JSX tags and expressions. An icon-only
        // button's body is just <Icon … /> and whitespace.
        const text = body.replace(/<[^>]*>/g, "").replace(/\{[^}]*\}/g, "").trim();
        const named = NAMED.some((n) => tag.includes(n));
        // The length ceiling is what keeps this honest. Stripping `{...}` also
        // erases a label rendered as `{item.label}`, so a big content-bearing
        // button (a dashboard card, a profile picker) looks textless. An
        // icon-only button's body is a glyph and nothing else — short.
        const iconOnly = body.trim().length < 240 && /<[A-Z]\w*|<svg/.test(body);
        if (!named && !text && iconOnly) {
          offenders.push("src" + full.split("src").pop().split(String.fromCharCode(92)).join("/")
            + ":" + src.slice(0, at).split(NL).length);
        }
        at = src.indexOf("<button", at + 7);
      }
    }
  };
  for (const d of ["components", "routes", "pages"]) {
    walk(fileURLToPath(new URL("../src/" + d, import.meta.url)));
  }
  assert.deepEqual(offenders, [], "icon-only <button>s with no accessible name:" + NL + offenders.join(NL));
});

test("signup sends the confirmation link back to the origin it came from", () => {
  // The project requires email confirmation (`mailer_autoconfirm: false`), so
  // `signUp` returns no session and the account is created unconfirmed. The
  // confirmation link's destination comes from the project's single Site URL
  // unless the call names one — so signing up from localhost, a preview
  // deployment or production sends everyone to the same fixed origin, and two
  // of those three land the user somewhere that is not the app they used.
  const login = code(read("../src/pages/Login.tsx"));
  assert.match(login, /emailRedirectTo: window\.location\.origin/,
    "signUp must return the user to the origin they signed up from");
  // And the "no session" branch must not tell the user to try again — the
  // account already exists, so a retry fails as already-registered.
  assert.ok(!/تم إنشاء الحساب[^"]*المحاولة مجدداً/.test(login),
    "the confirmation notice must not invite a duplicate signup");
});

test("the local auth flag is reconciled against the real Supabase session", () => {
  // `ProtectedRoute` gates on `useAuthStore.isAuthenticated`, a boolean in
  // localStorage. Nothing ever asked Supabase whether it was still true, so a
  // session that expired hours ago left every business screen rendering while
  // every read and write failed 401 — observed live in this project.
  //
  // The reconciliation may only ever sign the user OUT, never in.
  assert.match(boot, /auth\.getSession\(\)/, "boot must ask Supabase for the real session");
  assert.match(boot, /onAuthStateChange/, "a revoked or unrefreshable session must be noticed");
  assert.match(boot, /logout\(\)/, "the only action taken is a local sign-out");
});

test("an async handler that appends a ledger event is gated", () => {
  // The earlier duplicate-submit guard only looked at handlers that SET a busy
  // flag (`setSaving(true)` and friends). A handler with no busy flag at all is
  // strictly worse and was invisible to it — which is how the expense, payroll
  // and fixed-asset handlers in PartnersFinancePage kept booking one ledger
  // event per click. Reproduced on the QA tenant: three presses of تسجيل filed
  // 3 × 75 EGP, three `expenses` rows and three events.
  //
  // Any `async` handler that calls `appendEvent` must claim a submit gate.
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = dir + "/" + e.name;
      if (e.isDirectory()) { if (e.name !== "ui") walk(full); continue; }
      if (!e.name.endsWith(".tsx")) continue;
      const src = readFileSync(full, "utf8");
      // Not just ledger writers: a branch, a customer, a discount code all
      // reach Supabase through the store without an event of their own.
      if (!src.includes("appendEvent") && !MUTATION_NAMES.some((m) => src.includes(m + "("))) continue;
      const lines = code(src).split(NL);
      for (let i = 0; i < lines.length; i++) {
        // an async arrow/function handler declaration
        // `useCallback(async () => {` is a handler too — that shape is how the
        // e-commerce order submit escaped this check and filed three orders
        // from three clicks.
        const isHandler =
          /(const|function)\s+\w+\s*(=\s*async\s*\(|\().*=>?\s*\{?\s*$/.test(lines[i]) ||
          /=\s*async\s*\(\s*\)\s*=>\s*\{/.test(lines[i]) ||
          /=\s*use(Callback|Memo)\(async\s*\(/.test(lines[i]);
        if (!isHandler) continue;
        // its body, to the next top-level `};`
        let body = "";
        for (let j = i + 1; j < lines.length && j < i + 140; j++) {
          if (/^\s{0,2}\};?\s*$/.test(lines[j])) break;
          body += lines[j] + NL;
        }
        // `runOnce(` wraps the whole body and releases in a finally;
        // `.enter()` is the explicit pair. Either counts.
        const gated = body.includes(".enter()") || lines[i].includes("runOnce(");
        const writesCloud =
          body.includes("appendEvent(") ||
          MUTATION_NAMES.some((m) => body.includes(m + "("));
        if (writesCloud && !gated) {
          offenders.push(e.name + ":" + (i + 1) + "  " + lines[i].trim().slice(0, 60));
        }
      }
    }
  };
  for (const d of ["components", "routes", "pages"]) {
    walk(fileURLToPath(new URL("../src/" + d, import.meta.url)));
  }
  assert.deepEqual(
    offenders,
    [],
    "these write a ledger event once per click, with no gate:" + NL + offenders.join(NL),
  );
});

test("a shop that was never licensed is not told its licence expired", () => {
  // `LicenseVerdict` has carried `unlicensed` separately from `expired` all
  // along, but the screen collapsed the two and told every brand-new signup
  // "انتهت صلاحية الترخيص". `claim_store` creates a store with no licence row,
  // so that is what EVERY new customer saw — and an owner told their licence
  // expired reasonably reaches for a reinstall or a backup restore to get
  // their data "back", when nothing was lost and nothing ran out.
  const page = code(read("../src/pages/LicenseExpired.tsx"));
  assert.match(page, /verdict === "unlicensed"/, "the screen must read the unlicensed verdict");
  // The expiry wording must be reachable ONLY when it is not the unlicensed case.
  const at = page.indexOf("انتهت صلاحية الترخيص");
  assert.ok(at > 0, "the expiry wording should still exist for a real expiry");
  assert.ok(
    page.slice(Math.max(0, at - 260), at).includes("unlicensed"),
    "the expiry wording must sit behind an unlicensed check",
  );
});

test("the shipping tariff is cloud data, not a localStorage file", () => {
  // It was the last piece of business data only one browser could see — and
  // not cosmetically: /ecommerce-orders builds its governorate dropdown from
  // these rows, so a browser without them could not raise an online order at
  // all. The dropdown was empty, submit disabled, and nothing said why.
  const store = read("../src/store/useShippingRatesStore.ts");
  assert.ok(!code(store).includes("persist("), "shipping rates must not be persisted locally");
  assert.match(code(store), /writeThrough\("shipping_rates"/, "writes must reach Supabase");
  assert.match(code(store), /deleteThrough\("shipping_rates"/, "deletes must reach Supabase");
  // …and hydrated on boot like every other cloud-owned collection.
  assert.match(hydrate, /shipping_rates:/, "shipping_rates must be a hydration sink");

  // The empty state must be explained, not left as a dead form.
  const orders = code(read("../src/routes/ecommerce-orders.tsx"));
  assert.match(orders, /shippingRates\.length === 0/, "an unconfigured tariff must be announced");
});

test("the backup screen does not promise data it cannot restore", () => {
  // `applyBundle` writes localStorage keys and nothing else — it never touches
  // Supabase. Since the business tables moved to the cloud, `hydrateAll`
  // clears and refetches every cloud-owned collection on the next boot, so a
  // "restored" copy of them is discarded seconds later.
  //
  // The screen used to say "صدّر كل بياناتك" and that the file "يحوي كل
  // المتاجر في النظام". An owner who lost their machine would restore their
  // theme and none of their shop, believing they were covered.
  const page = code(read("../src/routes/backups.tsx"));
  assert.ok(!page.includes("صدّر كل بياناتك"), "the export must not claim to carry all data");
  assert.ok(
    !page.includes("يحوي كل المتاجر في النظام"),
    "the bundle does not contain the stores' business data",
  );
  // …and it must say where the business data actually lives.
  assert.match(page, /السحابة/, "the screen must point at the cloud as the real store of record");

  // The restore path must still be localStorage-only — if it ever gains a
  // Supabase write, this test should fail so the claim gets re-examined.
  const store = code(read("../src/store/useBackupStore.ts"));
  assert.ok(
    !/writeThrough|cloudUpsert|from\(["'`]/.test(store),
    "applyBundle writes localStorage only; a cloud write here changes the contract",
  );
});

test("a shop provisioned at signup gets a name", () => {
  // `claim_store` created the store with `INSERT INTO public.stores (id)` and
  // no name, so every shop a signup provisioned had `name = NULL`. The settings
  // screen then showed its hardcoded default ("محلي") over a row holding
  // nothing, and any invoice or header printing the shop name printed blank.
  //
  // The name is a neutral placeholder on purpose — NOT the email local-part.
  // The shop name is printed on invoices and shown to customers, and turning
  // someone's personal address into their public shop name is a privacy leak
  // they never agreed to.
  const m = read("../docs/migrations/019_claim_store_onboarding.sql");
  assert.match(m, /INSERT INTO public\.stores \(id, name\)/, "the new store must be named");
  assert.ok(!/split_part\(.*email|auth\.email|users\.email/.test(m),
    "the shop name must not be derived from the owner's email");

  // The activation switch must stay a switch — and must stay at the CURRENT
  // behaviour unless someone deliberately changes it. Flipping it silently
  // would either give the product away or lock every new customer out.
  assert.match(m, /TRIAL_DAYS CONSTANT INT := 0/,
    "TRIAL_DAYS is a commercial decision; it stays at today's behaviour until changed on purpose");
});
