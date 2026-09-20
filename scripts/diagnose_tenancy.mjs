/**
 * Tenancy diagnostic — READ ONLY. It reports; it never repairs.
 *
 *     SUPABASE_SERVICE_ROLE_KEY=... node scripts/diagnose_tenancy.mjs
 *
 * ## Why this exists and why it writes nothing
 *
 * Two historical bugs left the store table in a state no screen can explain:
 *
 *   1. `claim_store` used to run on ANY login that found no membership — so a
 *      sign-in MINTED a store as a side effect. Migration-era logins therefore
 *      produced a trail of empty «متجري» shops, one per person per occasion.
 *      `establishSupabaseSession` no longer does this for a System Owner, and
 *      `check_system_owner_access.mjs` holds that shut.
 *
 *   2. Separately, a store that holds REAL business data ended up with zero
 *      members, so nobody can sign in and reach it. It is not deleted, not
 *      corrupted, and still licensed — it is simply unreachable.
 *
 * The temptation is to "fix" the second by inserting a membership. Resist it
 * until a human names the owner, because THE DATABASE CANNOT ANSWER WHO THAT
 * IS. Nothing in `stores`, `products`, `orders`, `ledger_events` or
 * `store_licenses` records an auth user: `ledger_events.actor` is a free-text
 * Arabic label ("POS", "المشتريات"), `device_id` is a browser-local id from
 * localStorage, and `store_licenses.updated_by` is null on the affected row.
 * Creation dates narrow the field; they do not prove membership.
 *
 * Granting a membership to the wrong person hands them another shop's
 * customers, costs and ledger. That is not a repair, it is a breach. So this
 * script prints the facts and stops.
 */

import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_ || !SERVICE_KEY) {
  console.error("needs VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (service role: this reads across tenants)");
  process.exit(1);
}

// Service role, because the whole point is to see ACROSS tenants — which is
// exactly why this file must never gain a write.
const db = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false } });

const DATA_TABLES = ["products", "orders", "customers", "ledger_events", "ledger_lines", "purchase_invoices"];

async function countFor(table, storeId) {
  const { count, error } = await db.from(table).select("*", { count: "exact", head: true }).eq("store_id", storeId);
  return error ? `err:${error.code ?? "?"}` : (count ?? 0);
}

const { data: stores, error: storeErr } = await db.from("stores").select("id, name, created_at").order("created_at");
if (storeErr) throw new Error(`[stores] ${storeErr.message}`);

const { data: members } = await db.from("store_members").select("user_id, store_id, role");
const { data: licences } = await db.from("store_licenses").select("store_id, status, valid_until, updated_by");
const { data: authUsers } = await db.auth.admin.listUsers({ perPage: 1000 });

const emailOf = new Map((authUsers?.users ?? []).map((u) => [u.id, u.email]));

const rows = [];
for (const store of stores ?? []) {
  const counts = {};
  for (const table of DATA_TABLES) counts[table] = await countFor(table, store.id);
  const mine = (members ?? []).filter((m) => m.store_id === store.id);
  const licence = (licences ?? []).find((l) => l.store_id === store.id);
  rows.push({
    id: store.id,
    name: store.name,
    created: String(store.created_at).slice(0, 10),
    members: mine.map((m) => `${emailOf.get(m.user_id) ?? m.user_id}:${m.role}`).join(", ") || "(none)",
    ...counts,
    licence: licence ? `${licence.status} → ${String(licence.valid_until).slice(0, 10)}` : "(none)",
    licenceSetBy: licence?.updated_by ? (emailOf.get(licence.updated_by) ?? licence.updated_by) : "(no audit trail)",
  });
}

console.log("\n=== STORES ===");
console.table(rows);

const hasData = (r) => DATA_TABLES.some((t) => typeof r[t] === "number" && r[t] > 0);

const orphanedData = rows.filter((r) => r.members === "(none)" && hasData(r));
const emptyClaimed = rows.filter((r) => r.members !== "(none)" && !hasData(r));
const orphanUsers = (authUsers?.users ?? []).filter((u) => !(members ?? []).some((m) => m.user_id === u.id));

console.log("\n=== ANOMALY 1: data with nobody who can reach it ===");
if (orphanedData.length === 0) console.log("none");
for (const r of orphanedData) {
  console.log(`  ${r.name} (${r.id}) created ${r.created}`);
  console.log(`    ${DATA_TABLES.map((t) => `${t}=${r[t]}`).join("  ")}`);
  console.log(`    licence: ${r.licence}   set by: ${r.licenceSetBy}`);
  const candidates = (authUsers?.users ?? [])
    .filter((u) => u.created_at <= `${r.created}T23:59:59Z`)
    .map((u) => `${u.email} (joined ${String(u.created_at).slice(0, 10)})`);
  console.log(`    accounts that existed by then — CANDIDATES, NOT PROOF:`);
  for (const c of candidates) console.log(`      · ${c}`);
  console.log(`    the database records no auth user on any row of this store.`);
}

console.log("\n=== ANOMALY 2: claimed-but-empty stores (the claim_store-on-login trail) ===");
if (emptyClaimed.length === 0) console.log("none");
for (const r of emptyClaimed) console.log(`  ${r.name} (${r.id}) created ${r.created} — ${r.members}`);

console.log("\n=== ANOMALY 3: accounts with no membership ===");
if (orphanUsers.length === 0) console.log("none");
for (const u of orphanUsers) console.log(`  ${u.email} (joined ${String(u.created_at).slice(0, 10)})`);

console.log(`
=== NOT EXECUTED ===
This script changed nothing and is not able to. Recovery of ANOMALY 1 needs a
human to name the owner; the data cannot. Once named, the minimal, reversible
step is ONE row:

  insert into public.store_members(user_id, store_id, role)
  values ('<the named user>', '<the orphaned store>', 'ADMIN');

Nothing else. Do not move products, orders or ledger rows between stores: the
ledger is append-only and every balance is a SUM over it, so relocating lines
rewrites financial history in both shops at once.

ANOMALY 2 is cosmetic — empty stores hurt nobody, and deleting one cascades to
its members. Leave them unless a person asks for their list to be tidied.
`);
