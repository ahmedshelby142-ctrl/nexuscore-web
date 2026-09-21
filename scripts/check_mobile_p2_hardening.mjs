/**
 * Mobile P2 — labels from the taxonomy, retries that retry, and an honest
 * connection state.
 *
 *     node --test scripts/check_mobile_p2_hardening.mjs
 *
 * None of these is a new capability. Each pins a way the app was quietly
 * lying: a queue row that invented its own status word, an error screen with
 * no way out, a list that looked live while the connection was gone, and a
 * توريد button that stayed enabled so the operator could discover offline by
 * filling in a receipt and pressing submit.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { ORDER_STATUS_TAXONOMY, resolveOrderStatus, UNKNOWN_ORDER_STATUS }
  from "../src/mobile/viewmodels/statusTaxonomies.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/** Source with comments stripped — the prose names what the code refuses to do. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\r\n]*/g, "$1");
}

const homeReader = read("../src/mobile/data/mobileHomeReader.ts");
const entityHook = read("../src/mobile/data/useMobileEntity.ts");
const offlineHook = read("../src/mobile/data/useIsOffline.ts");
const restock = read("../src/mobile/screens/MobileQuickRestock.tsx");
const persona = read("../docs/MOBILE_PERSONA_ARCHITECTURE.md");

const DETAIL_SCREENS = {
  order: read("../src/mobile/screens/MobileOrderDetails.tsx"),
  product: read("../src/mobile/screens/MobileProductDetails.tsx"),
  customer: read("../src/mobile/screens/MobileCustomerDetails.tsx"),
};
const owner = read("../src/mobile/screens/MobileOwnerScreen.tsx");

// ═══════════════════════════════════════════════════════════════════════════
// P2-1 · the home queue stops inventing status words
// ═══════════════════════════════════════════════════════════════════════════

test("P2-1 · the home queue labels orders from the taxonomy", () => {
  assert.match(homeReader, /statusLabelAr: resolveOrderStatus\(order\.status\)\.labelAr/);
  assert.match(homeReader, /statusTone: resolveOrderStatus\(order\.status\)\.tone/);
  // The shipments queue hardcoded its label too — same class of bug.
  assert.match(homeReader, /resolveShipmentStatus\(order\.status\)\.labelAr/);
});

test("P2-1 · the stale order label is gone from the whole mobile app", () => {
  // «قيد الإجراء» was the home queue's invention. The canonical word for
  // `pending` is «قيد الانتظار», and it lives in exactly one place.
  let hits = [];
  try {
    hits = execFileSync("git", ["grep", "-n", "قيد الإجراء", "--", "src/"], { encoding: "utf8" })
      .split("\n").filter(Boolean);
  } catch (e) {
    if (e.status !== 1) throw e; // 1 = no matches, the passing case
  }
  assert.deepEqual(hits, [], `the home queue's invented label is back:\n${hits.join("\n")}`);
});

test("P2-1 · the taxonomy still answers with the canonical word", () => {
  // Behavioural, so this cannot pass on a file that merely mentions the string.
  assert.equal(resolveOrderStatus("pending").labelAr, "قيد الانتظار");
  assert.equal(ORDER_STATUS_TAXONOMY.pending.labelAr, "قيد الانتظار");
  // And a status Postgres rejects is still not given a friendly name.
  assert.equal(resolveOrderStatus("processing"), UNKNOWN_ORDER_STATUS);
});

// ═══════════════════════════════════════════════════════════════════════════
// P2-2 · a failed read is no longer terminal
// ═══════════════════════════════════════════════════════════════════════════

test("P2-2 · the entity loader can be asked again", () => {
  assert.match(entityHook, /return \{ \.\.\.state, reload: run \};/);
  // Retry is the ORIGINAL reader, asked again — not a second fetch path.
  assert.match(entityHook, /const data = await reader\(\);/);
  assert.equal((code(entityHook).match(/await reader\(\)/g) ?? []).length, 1);
});

test("P2-2 · retry collapses a double tap and cannot repaint a stale record", () => {
  assert.match(entityHook, /if \(inFlight\.current\) return;/);
  assert.match(entityHook, /if \(mine === generation\.current\)/);
});

for (const [name, source] of Object.entries(DETAIL_SCREENS)) {
  test(`P2-2 · ${name} details offers a retry, and a way back`, () => {
    assert.match(source, /useMobileEntity\(/);
    assert.match(source, /loading, error, reload \}/, "the screen must take reload");
    assert.match(source, /<ErrorState messageAr="[^"]+" onRetry=\{reload\} \/>/);
    // An error state you cannot leave is its own trap on a phone.
    assert.match(source, /leadingAction=\{back\}/);
  });
}

test("P2-2 · the owner screen's retry still runs its own reader", () => {
  assert.match(owner, /<ErrorState messageAr=\{error\} onRetry=\{reload\} \/>/);
});

// ═══════════════════════════════════════════════════════════════════════════
// P2-3 · the connection state is reactive, and shared
// ═══════════════════════════════════════════════════════════════════════════

test("P2-3 · connectivity is subscribed, not sampled during render", () => {
  assert.match(offlineHook, /window\.addEventListener\("online", goOnline\);/);
  assert.match(offlineHook, /window\.addEventListener\("offline", goOffline\);/);
  assert.match(offlineHook, /removeEventListener\("online", goOnline\)/);
  assert.match(offlineHook, /removeEventListener\("offline", goOffline\)/);
});

test("P2-3 · no screen reads navigator.onLine during render any more", () => {
  // The inline form only re-evaluates when something else re-renders, so a
  // connection lost while a list sat on screen was never announced.
  let hits = [];
  try {
    hits = execFileSync("git", ["grep", "-n", "navigator.onLine", "--", "src/mobile/screens/"], { encoding: "utf8" })
      .split("\n").filter(Boolean);
  } catch (e) {
    if (e.status !== 1) throw e;
  }
  assert.deepEqual(hits, [], `these still sample connectivity inline:\n${hits.join("\n")}`);
});

test("P2-3 · the four screens that had no connection state now have one", () => {
  for (const [name, source] of Object.entries({ ...DETAIL_SCREENS, owner })) {
    assert.match(source, /useIsOffline/, `${name} must subscribe to connectivity`);
    assert.match(source, /<OfflineState \/>/, `${name} must say when it cannot load`);
  }
});

test("P2-3 · a money screen with no connection shows no figures at all", () => {
  // Stale balances under a live heading are the one lie a money screen must
  // never tell — every render branch is gated on the connection.
  assert.match(owner, /\{offline && <OfflineState \/>\}/);
  assert.match(owner, /\{!offline && loading &&/);
  assert.match(owner, /\{!offline && !loading && error &&/);
  assert.match(owner, /\{!offline && !loading && !error && data &&/);
});

// ═══════════════════════════════════════════════════════════════════════════
// P2-4 · restock refuses before the tap — and still has only one write path
// ═══════════════════════════════════════════════════════════════════════════

test("P2-4 · توريد is unavailable while the connection is gone", () => {
  // `\b` not `;` — the expression legitimately grew a `&& !suppliersError`
  // term in P2-8, and pinning the tail makes the guard brittle to its own
  // reinforcement.
  assert.match(restock, /const canSave = [^;]*&& !offline\b/);
  assert.match(restock, /disabled=\{!canSave\}/);
  // Disabled with no reason given is its own bug.
  assert.match(restock, /title=\{offline \? "لا يوجد اتصال بالسحابة" : undefined\}/);
});

test("P2-4 · offline changes the UX and nothing else — no queue, no local write", () => {
  const body = code(restock);
  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "syncQueue", "enqueue", "pending write"]) {
    assert.ok(!body.includes(forbidden), `restock must not ${forbidden}`);
  }
  // `commitReceipt` stays the only way a receipt reaches the database, reached
  // through the same command the desktop invoice form uses.
  assert.match(restock, /executeQuickRestock/);
  assert.ok(!body.includes("commitReceipt"), "the screen must not call the writer directly");
});

test("P2-4 · a failed receipt still throws rather than reporting success", () => {
  const commit = read("../src/lib/receiving/commitReceipt.ts");
  assert.match(commit, /throw new Error/);
  assert.ok(!code(commit).includes("localStorage"), "no local fallback may exist");
  assert.match(restock, /toast\.error\(e instanceof Error \? e\.message : String\(e\)\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// P2-5 · P2-6 · P2-7
// ═══════════════════════════════════════════════════════════════════════════

test("P2-5 · the touched screens carry no dead imports", () => {
  // The two store imports were the named finding; `tsc --noUnusedLocals` over
  // the same files found forty more. Spot-checked here rather than re-running
  // the compiler in a unit test — one per file, so a whole file regressing is
  // caught without a thirty-second type-check.
  const spot = {
    "../src/mobile/screens/MobileOrderDetails.tsx": ["Clock", "MapPin", "useMemo"],
    "../src/mobile/screens/MobileProductDetails.tsx": ["TrendingUp", "formatArabicRelativeTime"],
    "../src/mobile/screens/MobileCustomerDetails.tsx": ["DollarSign", "XCircle"],
    "../src/mobile/screens/MobileQuickRestock.tsx": ["useRef", "FilterSheet"],
    "../src/mobile/screens/MobileOrdersScreen.tsx": ["ClipboardList"],
    "../src/mobile/screens/MobileShipmentsScreen.tsx": ["Truck"],
    "../src/mobile/screens/MobileHomeScreen.tsx": ["useState", "useEffect"],
  };
  for (const [file, names] of Object.entries(spot)) {
    const source = read(file);
    const imports = source.split("\n").filter((l) => l.trimStart().startsWith("import")).join("\n");
    for (const name of names) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(imports), `${file} still imports unused ${name}`);
    }
  }
});

test("P2-5 · the two dead store imports are gone, and nothing replaced them", () => {
  const customers = read("../src/mobile/screens/MobileCustomersScreen.tsx");
  assert.ok(!customers.includes("useCustomerStore"));
  assert.ok(!code(restock).includes("useBusinessStore"));
  // Mobile never hydrates, so a store collection there is permanently empty —
  // the trap `lib/receiving/suppliers.ts` documents.
  for (const [name, source] of Object.entries({ customers, restock })) {
    const body = code(source);
    assert.ok(!/useBusinessStore\.|useCustomerStore\./.test(body), `${name} must not read a store`);
  }
});

test("P2-6 · the home screen is no longer named a placeholder", () => {
  assert.ok(existsSync(new URL("../src/mobile/screens/MobileHomeScreen.tsx", import.meta.url)));
  assert.ok(!existsSync(new URL("../src/mobile/screens/MobileHomePlaceholder.tsx", import.meta.url)));
  let hits = [];
  try {
    // `:!` excludes this file and the changelog: both NAME the old component
    // in order to explain the rename, which is not a stale reference to it.
    hits = execFileSync("git", ["grep", "-nl", "MobileHomePlaceholder", "--", ".",
      ":!scripts/check_mobile_p2_hardening.mjs", ":!docs/NEXUSCORE_CHANGELOG.md"], { encoding: "utf8" })
      .split("\n").filter(Boolean);
  } catch (e) {
    if (e.status !== 1) throw e;
  }
  assert.deepEqual(hits, [], `stale references remain:\n${hits.join("\n")}`);
  const router = read("../src/mobile/router.tsx");
  assert.match(router, /<Route index element=\{<MobileHomeScreen \/>\} \/>/);
});

test("P2-7 · the persona doc no longer describes a status Postgres rejects", () => {
  assert.ok(!persona.includes("pending/processing"));
  assert.match(persona, /`pending` count, three most urgent/);
  // The correction names the constraint rather than just deleting the word.
  assert.match(persona, /orders_status_check/);
});

test("P2-7 · the abandoned historical migration is left alone", () => {
  // It documents a schema that was never live. Editing history to match the
  // present is how the next audit loses the evidence.
  const legacy = read("../supabase/migrations/20240608_database_schema.sql");
  assert.match(legacy, /CHECK \(status IN \('pending', 'processing', 'completed', 'cancelled'\)\)/);
});
