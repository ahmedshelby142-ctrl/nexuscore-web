/**
 * MODERATOR — a fifth role that is read-only AT THE DATABASE.
 *
 *     node --test scripts/check_moderator_role.mjs
 *
 * ## What this is defending
 *
 * A "read-only" persona enforced by hiding buttons is not read-only; it is a
 * write path with the sign taken down. `docs/MOBILE_PERSONA_ARCHITECTURE.md` §4
 * says the property the Moderator actually needs is that Postgres refuses it,
 * and that this costs nothing because every write gate is already a
 * `has_role(...)` list the role is simply absent from.
 *
 * That was true of nine gates and NOT true of five, found by auditing the live
 * database rather than the migrations (which never carried them):
 * `insert_ledger_lines` and `update_products` were `is_store_member` only, and
 * so were the SECURITY DEFINER writers `claim_discount_use`,
 * `release_discount_use`, `adjust_discount_total` and `next_document_number`.
 * A Moderator would have inherited all of them — a direct line-append onto an
 * existing ledger event moves every balance that sums them. Migration 033
 * re-gates the five on the four roles that already held them.
 *
 * ## Why the interesting half is credential-gated
 *
 * Read-only-ness is a property of the DATABASE. Asserting it by reading source
 * would prove nothing: the UI looked read-only before the migration too. So the
 * real cases below talk to Postgres and skip (loudly) without credentials, in
 * the same shape as `check_ledger_atomicity.mjs`.
 *
 * The source guards run unconditionally. They cannot prove a refusal; they stop
 * the two shapes that would quietly undo one — `MODERATOR` appearing in a write
 * policy, and `MODERATOR` appearing in the DESKTOP route map.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { APP_ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS, canAccess, homeFor, toAppRole } from "../src/lib/roles.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const migration = read("../docs/migrations/033_moderator_role.sql");
const capabilities = read("../src/mobile/navigation/mobileCapabilities.ts");
const navigation = read("../src/mobile/navigation/mobileNavigation.ts");
const router = read("../src/mobile/router.tsx");
const stockScreen = read("../src/mobile/screens/MobileStockScreen.tsx");
const shortagesScreen = read("../src/mobile/screens/MobileShortagesScreen.tsx");
const inviteFn = read("../supabase/functions/invite-staff/index.ts");
const sessionWorkflow = read("../src/lib/auth/sessionWorkflow.ts");

// ═══════════════════════════════════════════════════════════════════════════
// 1 · The role exists, and it is a real member role — not a global identity
// ═══════════════════════════════════════════════════════════════════════════

test("MODERATOR is one of the fixed roles, named and described in Arabic", () => {
  assert.ok(APP_ROLES.includes("MODERATOR"), "the role must exist to be grantable");
  assert.equal(toAppRole("MODERATOR"), "MODERATOR", "the session must not downgrade it");
  assert.ok(ROLE_LABELS.MODERATOR && !/[A-Za-z]/.test(ROLE_LABELS.MODERATOR));
  assert.ok(ROLE_DESCRIPTIONS.MODERATOR, "the invite dropdown needs a description");
});

test("an ADMIN can actually grant it — the invite function accepts it", () => {
  const allowed = inviteFn.match(/const ROLES = \[([^\]]+)\]/)[1];
  assert.match(allowed, /"MODERATOR"/, "a role nobody can be invited to is not a role");
});

test("the session maps roles through toAppRole and nothing else", () => {
  // The System Owner bug was a second, parallel notion of who someone is. There
  // must be exactly one place a stored role string becomes an AppRole, so that
  // adding a fifth role needed no change here at all.
  assert.match(sessionWorkflow, /const role = toAppRole\(membership\?\.role \?\? null\)/);
  assert.doesNotMatch(sessionWorkflow, /MODERATOR/, "a store role needs no special case in the session");
  // …and global authority still travels separately from the store role.
  assert.match(sessionWorkflow, /rpc\("is_system_owner"\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · Desktop isolation — the shortcut the persona architecture forbids
// ═══════════════════════════════════════════════════════════════════════════

test("MODERATOR reaches no desktop business screen", () => {
  // `ROUTE_ACCESS` is read by the DESKTOP sidebar and router. Adding MODERATOR
  // to `/crm` or `/inventory` to reach a MOBILE screen is exactly the widening
  // §4 rules out: it would open those desktop screens to the role in every
  // store, full of write affordances Postgres then refuses one click later.
  for (const path of [
    "/", "/pos", "/orders", "/ecommerce-orders", "/crm", "/returns",
    "/inventory", "/stock-audit", "/purchasing", "/partners",
    "/products", "/wholesale", "/discounts", "/courier-ledger",
    "/settings", "/users", "/branches", "/backups", "/integrations",
    "/system-admin",
  ]) {
    assert.equal(canAccess("MODERATOR", path), false, `${path} must be shut on desktop`);
  }
  assert.ok(canAccess("MODERATOR", "/preferences"), "appearance is a preference, not a permission");
  assert.equal(homeFor("MODERATOR"), "/preferences");
});

test("MODERATOR is not an alias of any existing role", () => {
  for (const other of APP_ROLES.filter((r) => r !== "MODERATOR")) {
    const paths = ["/", "/pos", "/orders", "/crm", "/inventory", "/purchasing", "/partners", "/settings"];
    const same = paths.every((p) => canAccess(other, p) === canAccess("MODERATOR", p));
    assert.ok(!same, `MODERATOR resolves identically to ${other} — it has become an alias`);
  }
});

test("mobile capability resolution is SPLIT from desktop authorization for this role", () => {
  // The whole point. If this set were reached through `canAccess`, the desktop
  // map would have had to be widened to produce it.
  const stated = capabilities
    .match(/const MODERATOR_CAPABILITIES: readonly MobileCapability\[\] = \[([\s\S]*?)\]/)[1]
    .match(/"[a-z]+"/g)
    .map((s) => s.replaceAll('"', ""));

  assert.deepEqual(
    [...stated].sort(),
    ["customers", "home", "more", "orders", "preferences", "shipments", "stock"],
    "the Moderator's surfaces are Orders · Order Details · Customers · Inventory · Shortages · Shipments",
  );
  assert.ok(!stated.includes("purchasing"), "purchasing is the one capability with a WRITE behind it");
  assert.match(capabilities, /if \(role === "MODERATOR"\)/);
  // One resolver. `hasMobileCapability` must not re-derive from `canAccess`, or
  // the guard disagrees with the nav that just drew the screen.
  assert.match(
    capabilities,
    /export function hasMobileCapability[\s\S]*?return getMobileCapabilities\(role\)\.has\(capability\);/,
  );
});

test("the Moderator has a bottom nav, and المزيد is still on it", () => {
  const body = navigation.match(/case "MODERATOR":[\s\S]*?return \[(.*?)\];/)[1];
  assert.ok((body.match(/ALL_MODULES\./g) ?? []).length <= 4, "four destinations maximum");
  assert.match(body, /ALL_MODULES\.more/, "everything else is reached through المزيد");
  assert.doesNotMatch(body, /ALL_MODULES\.purchasing/, "the Moderator buys nothing");
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · No write affordance is reachable, by tap or by deep link
// ═══════════════════════════════════════════════════════════════════════════

test("/restock — the only mobile write — stays behind the purchasing capability", () => {
  assert.match(
    router,
    /MobileRouteGuard capability="purchasing"[\s\S]*?path="restock"/,
    "a deep link to /restock must hit the same guard the nav respects",
  );
  // Every mobile screen is behind a guard; none is reachable by URL alone.
  const unguarded = [...router.matchAll(/<Route path="([a-z/:]+)"/g)]
    .map((m) => m[1])
    .filter((p) => !["login", "set-password", "license-expired", "/"].includes(p));
  assert.ok(unguarded.length > 0);
});

test("the توريد buttons are drawn only for a role that can actually buy", () => {
  // Offering an action whose only possible outcome is a bounce back to home is
  // not a permission bug, but it is the surface a Moderator would tap first.
  for (const [name, src] of [["المخزون", stockScreen], ["النواقص", shortagesScreen]]) {
    assert.match(src, /useMobileCapabilities\(\)\.has\("purchasing"\)/, `${name} must ask`);
    assert.match(src, /\{canRestock && \(/, `${name} must hide the button when the answer is no`);
  }
});

test("mobile offers no System Owner surface to anybody", () => {
  for (const needle of ["system-admin", "admin_list_stores", "is_system_owner"]) {
    assert.ok(!router.includes(needle), `${needle} must not reach the mobile router`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · The migration says what it has to say — and does not say MODERATOR
// ═══════════════════════════════════════════════════════════════════════════

test("the constraint gains MODERATOR and keeps all four predecessors", () => {
  const check = migration.match(/ADD CONSTRAINT store_members_role_check[\s\S]*?\]::text\[\]\)\)/)[0];
  for (const role of ["ADMIN", "POS_ECOMMERCE", "ECOMMERCE_ONLY", "ACCOUNTANT", "MODERATOR"]) {
    assert.match(check, new RegExp(`'${role}'`), `${role} must remain assignable`);
  }
});

test("mobile_shortages is the ONE read gate that had to learn the role", () => {
  const gate = migration.match(/IF NOT COALESCE\(public\.has_role\([\s\S]*?\), false\) THEN/)[0];
  assert.match(gate, /'MODERATOR'/, "the shortages RPC is role-gated, not membership-gated");
  for (const role of ["ADMIN", "ACCOUNTANT", "ECOMMERCE_ONLY"]) {
    assert.match(gate, new RegExp(`'${role}'`), `${role} must not lose shortages`);
  }
  assert.doesNotMatch(gate, /'POS_ECOMMERCE'/, "POS was excluded before 033 and still is");
});

test("the five membership-only write paths are re-gated on the four roles", () => {
  for (const guarded of [
    "insert_ledger_lines",
    "update_products",
    "claim_discount_use",
    "release_discount_use",
    "adjust_discount_total",
    "next_document_number",
  ]) {
    assert.ok(migration.includes(guarded), `033 must re-gate ${guarded}`);
  }
  // Every gate it writes lists exactly the four that already held the write.
  const gates = migration.match(
    /ARRAY\['ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT'\]/g,
  ) ?? [];
  assert.ok(gates.length >= 6, `expected six re-gated writers, found ${gates.length}`);
});

test("no write gate anywhere in the migration names MODERATOR", () => {
  // The role is read-only because of what this file does NOT say. If a future
  // edit adds it to a has_role write list, that sentence stops being true.
  // Everything except the shortages READ gate, which is the only gate the role
  // is allowed to appear in at all.
  const shortages = migration.match(
    /CREATE OR REPLACE FUNCTION public\.mobile_shortages[\s\S]*?\$function\$;/,
  );
  assert.ok(shortages, "the shortages function must still be in 033");
  const writeGates = [
    ...migration.replace(shortages[0], "").matchAll(/has_role\([\s\S]{0,200}?\]/g),
  ].map((m) => m[0]);
  assert.ok(writeGates.length > 0, "033 must still re-gate the membership-only writers");
  for (const gate of writeGates) {
    assert.ok(!gate.includes("MODERATOR"), `a write gate now grants MODERATOR:\n${gate}`);
  }
  assert.ok(
    !/CREATE POLICY[\s\S]*?MODERATOR/.test(migration),
    "no policy may name the role at all — reads come from is_store_member",
  );
  assert.ok(
    !/(DROP|CREATE) POLICY (IF EXISTS )?select_/i.test(migration),
    "no SELECT policy is touched: read access comes with membership",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · The live database. The half that actually proves anything.
// ═══════════════════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const skipDatabaseTests = !SUPABASE_URL || !SERVICE_KEY || !ANON_KEY;

const PASSWORD = "TestPassword123!";
const DEVICE = "00000000-0000-0000-0000-00000000000a";

let admin;
let moderator;   // MODERATOR in store A
let seller;      // POS_ECOMMERCE in store A — the "existing roles unchanged" control
let outsider;    // ADMIN of store B
let storeA;
let storeB;
let productId;
const createdUsers = [];

async function signUp() {
  const email = `moderator-qa-${crypto.randomUUID()}@nexuscore.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw new Error(`could not create test user: ${error.message}`);
  createdUsers.push(data.user.id);
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw new Error(`could not sign in test user: ${signInError.message}`);
  client.userId = data.user.id;
  return client;
}

/** `has_role` requires a live licence, so an unlicensed QA store proves nothing. */
async function license(storeId) {
  await admin.from("store_licenses").insert({
    store_id: storeId,
    license_key: `QA-${storeId}`,
    plan_type: "BASIC",
    valid_until: new Date(Date.now() + 86400000).toISOString(),
    status: "active",
    notes: "moderator QA",
  });
}

async function setup() {
  admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const owner = await signUp();
  storeA = crypto.randomUUID();
  await owner.rpc("claim_store", { local_store_id: storeA });
  await license(storeA);

  outsider = await signUp();
  storeB = crypto.randomUUID();
  await outsider.rpc("claim_store", { local_store_id: storeB });
  await license(storeB);

  moderator = await signUp();
  seller = await signUp();
  await admin.from("store_members").insert([
    { user_id: moderator.userId, store_id: storeA, role: "MODERATOR" },
    { user_id: seller.userId, store_id: storeA, role: "POS_ECOMMERCE" },
  ]);

  // One product and one open order that demands more of it than exists, so a
  // shortages result of zero cannot be mistaken for a refused role gate.
  productId = `qa-prod-${crypto.randomUUID()}`;
  await admin.from("products").insert({
    id: productId, store_id: storeA, device_id: DEVICE, name: "QA", sku: "QA-1", quantity: 0,
  });
  await admin.from("orders").insert({
    id: `qa-order-${crypto.randomUUID()}`,
    store_id: storeA, device_id: DEVICE,
    orderNumber: "QA-1", customerName: "QA", customerPhone: "0100", status: "pending",
    stockItems: [{ productId, quantity: "5" }],
  });
}

async function teardown() {
  await admin.from("orders").delete().eq("store_id", storeA);
  await admin.from("products").delete().eq("store_id", storeA);
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id).catch(() => {});
}

/** Rows of `table` matching `match`, read with service-role so RLS cannot hide one. */
async function rows(table, match) {
  const { count } = await admin.from(table).select("*", { count: "exact", head: true }).match(match);
  return count ?? 0;
}

test("MODERATOR against a real database", { skip: skipDatabaseTests && "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_ANON_KEY missing" }, async (t) => {
  await setup();

  await t.test("A — every intended Mobile read surface answers", async () => {
    for (const table of ["orders", "products", "customers", "couriers", "ledger_lines", "ledger_events"]) {
      const { error } = await moderator.from(table).select("id").eq("store_id", storeA).limit(1);
      assert.equal(error, null, `${table} must be readable: ${error?.message}`);
    }
    const { data, error } = await moderator.rpc("mobile_shortages", { p_store: storeA });
    assert.equal(error, null, `shortages must answer: ${error?.message}`);
    assert.ok((data ?? []).length > 0, "the planted shortage must be visible — otherwise the gate refused");
  });

  await t.test("B — receiving is refused", async () => {
    const id = `qa-pi-${crypto.randomUUID()}`;
    const { error } = await moderator.from("purchase_invoices").insert({
      id, store_id: storeA, device_id: DEVICE, invoiceNumber: "QA-1", supplierId: "qa", totalAmount: 1,
    });
    assert.notEqual(error, null, "a Moderator must not raise a purchase invoice");
    assert.equal(error.code, "42501");
    assert.equal(await rows("purchase_invoices", { id }), 0, "0 mutated rows");
  });

  await t.test("C — the ledger refuses both the RPC and a direct line append", async () => {
    const id = `qa-ev-${crypto.randomUUID()}`;
    const { error: viaRpc } = await moderator.rpc("ledger_append", {
      p_event: {
        id, store_id: storeA, device_id: DEVICE, kind: "stock_adjustment",
        occurred_at: new Date().toISOString(), created_at: new Date().toISOString(),
        actor: "qa", ref_type: "qa_moderator", ref_id: id, payload: "{}",
        lines: [{ id: `${id}-L1`, account: "stock", subject_id: productId, qty_delta: 5, amount_delta: 0 }],
      },
    });
    assert.notEqual(viaRpc, null, "ledger_append must refuse");
    assert.equal(viaRpc.code, "42501");
    assert.equal(await rows("ledger_events", { id }), 0, "0 mutated rows");

    // The hole 033 closed: lines onto an event that already exists.
    const { data: existing } = await admin.from("ledger_events").select("id").eq("store_id", storeA).limit(1);
    if (existing?.length) {
      const lineId = `qa-line-${crypto.randomUUID()}`;
      const { error } = await moderator.from("ledger_lines").insert({
        id: lineId, event_id: existing[0].id, store_id: storeA, device_id: DEVICE,
        account: "stock", subject_id: productId, qty_delta: 999, amount_delta: 0,
      });
      assert.notEqual(error, null, "a bare line append must be refused too");
      assert.equal(await rows("ledger_lines", { id: lineId }), 0, "0 mutated rows");
    }
  });

  await t.test("D — stock, orders and customers cannot be mutated", async () => {
    const { data: updated } = await moderator
      .from("products").update({ quantity: 999 }).eq("id", productId).select();
    assert.deepEqual(updated ?? [], [], "the stock mirror must not move");
    const { data: after } = await admin.from("products").select("quantity").eq("id", productId).single();
    assert.equal(Number(after.quantity), 0, "0 mutated rows");

    const { data: reordered } = await moderator
      .from("orders").update({ status: "processing" }).eq("store_id", storeA).select();
    assert.deepEqual(reordered ?? [], [], "orders must not move");

    const custId = `qa-cust-${crypto.randomUUID()}`;
    const { error } = await moderator.from("customers").insert({ id: custId, store_id: storeA, name: "QA" });
    assert.notEqual(error, null);
    assert.equal(await rows("customers", { id: custId }), 0, "0 mutated rows");
  });

  await t.test("E — supplier and courier settlement are refused", async () => {
    const supId = `qa-sup-${crypto.randomUUID()}`;
    const { error: supplier } = await moderator.from("suppliers").insert({
      id: supId, store_id: storeA, device_id: DEVICE, companyName: "QA", contactPerson: "QA", phone: "0100",
    });
    assert.notEqual(supplier, null, "a Moderator must not create a supplier");
    assert.equal(await rows("suppliers", { id: supId }), 0, "0 mutated rows");

    const txId = `qa-tx-${crypto.randomUUID()}`;
    const { error: payment } = await moderator.from("transactions").insert({
      id: txId, store_id: storeA, type: "expense", amount: 1,
    });
    assert.notEqual(payment, null, "a Moderator must not move money");
    assert.equal(await rows("transactions", { id: txId }), 0, "0 mutated rows");

    const { data: couriers } = await moderator.from("couriers").update({ name: "QA" }).eq("store_id", storeA).select();
    assert.deepEqual(couriers ?? [], [], "the courier registry must not move");
  });

  await t.test("F — member management and the Licence Manager are refused", async () => {
    const { data: promoted } = await moderator
      .from("store_members").update({ role: "ADMIN" })
      .eq("store_id", storeA).eq("user_id", moderator.userId).select();
    assert.deepEqual(promoted ?? [], [], "a Moderator must not promote itself");
    const { data: stillModerator } = await admin
      .from("store_members").select("role").eq("store_id", storeA).eq("user_id", moderator.userId).single();
    assert.equal(stillModerator.role, "MODERATOR", "0 mutated rows");

    const { error: invited } = await moderator
      .from("store_members").insert({ user_id: seller.userId, store_id: storeB, role: "ADMIN" });
    assert.notEqual(invited, null, "a Moderator must not add members");

    const { data: relicensed } = await moderator
      .from("store_licenses").update({ valid_until: "2099-01-01" }).eq("store_id", storeA).select();
    assert.deepEqual(relicensed ?? [], [], "a Moderator must not extend a licence");
    for (const rpc of ["admin_list_stores"]) {
      const { error } = await moderator.rpc(rpc);
      assert.notEqual(error, null, `${rpc} is System Owner only`);
    }
    const { error: extend } = await moderator.rpc("admin_extend_license", {
      p_store_id: storeA, p_days: 30, p_until: null, p_note: "qa",
    });
    assert.notEqual(extend, null, "license administration is System Owner only");
  });

  await t.test("G — the System Owner remains a separate, global identity", async () => {
    const { data: isOwner } = await moderator.rpc("is_system_owner");
    assert.equal(isOwner, false, "a store role must never confer global authority");
  });

  await t.test("H — the definer writers refuse it too", async () => {
    const { error: counter } = await moderator.rpc("next_document_number", {
      p_store: storeA, p_name: "qa_counter", p_prefix: "QA-",
    });
    assert.notEqual(counter, null, "document numbering is a write");
    const { error: discount } = await moderator.rpc("claim_discount_use", {
      p_store: storeA, p_code_id: "qa", p_amount: 1,
    });
    assert.notEqual(discount, null, "discount usage is a financial mutation");
    assert.match(String(discount.message), /NEXUS_NOT_A_MEMBER|permission/i);
  });

  await t.test("I — store A cannot see or touch store B", async () => {
    const { data: orders } = await moderator.from("orders").select("id").eq("store_id", storeB);
    assert.deepEqual(orders ?? [], [], "cross-tenant read must return nothing");
    const { data: stores } = await moderator.from("stores").select("id").eq("id", storeB);
    assert.deepEqual(stores ?? [], [], "the other tenant must not exist for this session");
    const { data: shortages } = await moderator.rpc("mobile_shortages", { p_store: storeB });
    assert.deepEqual(shortages ?? [], [], "the RPC is store-scoped by has_role, not by argument");
    const id = `qa-cust-b-${crypto.randomUUID()}`;
    const { error } = await moderator.from("customers").insert({ id, store_id: storeB, name: "QA" });
    assert.notEqual(error, null, "cross-tenant write must be refused");
    assert.equal(await rows("customers", { id }), 0, "0 mutated rows");
  });

  await t.test("J — the roles that came before are untouched by 033", async () => {
    // The tightened gates list the four; a seller must still do a seller's job.
    const { data: moved } = await seller
      .from("products").update({ quantity: 3 }).eq("id", productId).select();
    assert.equal((moved ?? []).length, 1, "POS_ECOMMERCE still writes the stock mirror");

    const id = `qa-sale-${crypto.randomUUID()}`;
    const { error } = await seller.rpc("ledger_append", {
      p_event: {
        id, store_id: storeA, device_id: DEVICE, kind: "sale",
        occurred_at: new Date().toISOString(), created_at: new Date().toISOString(),
        actor: "qa", ref_type: "qa_regression", ref_id: id, payload: "{}",
        lines: [{ id: `${id}-L1`, account: "stock", subject_id: productId, qty_delta: -1, amount_delta: 0 }],
      },
    });
    assert.equal(error, null, `POS_ECOMMERCE still appends to the ledger: ${error?.message}`);
    assert.equal(await rows("ledger_lines", { id: `${id}-L1` }), 1, "and the line landed");

    const { error: counter } = await seller.rpc("next_document_number", {
      p_store: storeA, p_name: "qa_counter", p_prefix: "QA-",
    });
    assert.equal(counter, null, "POS_ECOMMERCE still draws document numbers");
  });

  await teardown();
});
