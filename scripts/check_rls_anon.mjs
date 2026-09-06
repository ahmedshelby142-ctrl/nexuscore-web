/**
 * What can a stranger do with the key that ships in the bundle?
 *
 *     node --test scripts/check_rls_anon.mjs
 *
 * This one talks to the REAL database, as `anon`, using only the publishable
 * key — the same key any visitor can read out of the JavaScript. It needs no
 * secret, so it runs anywhere `.env.local` exists and skips cleanly where it
 * does not.
 *
 * ## Why a behavioural test and not a policy audit
 *
 * The production audit on 2026-09-06 found this on `orders`:
 *
 *     CREATE POLICY "Allow full access to orders" ON orders
 *       FOR ALL USING (true) WITH CHECK (true);       -- granted to PUBLIC
 *
 * Postgres OR-s permissive policies, so it did not sit beside `select_orders`
 * and `write_orders` — it replaced them. An anonymous caller could create,
 * read, edit and delete any shop's orders, which carry customer names, phone
 * numbers and addresses. Verified at the time: INSERT 201, SELECT 200 with
 * rows, PATCH 204, DELETE 204.
 *
 * The policy was never in this repository. It was created directly against the
 * project, exactly like the `expenses` and `transactions` ones migration 013
 * had already cleaned up. So no amount of reading `docs/migrations/` could have
 * caught it, and a test that reads migration files would not catch the next
 * one either.
 *
 * This asks the database instead, and asserts the only thing that actually
 * matters: a caller with no session gets nothing.
 *
 * ## What "nothing" means for a read
 *
 * RLS does not error on a denied SELECT — it returns zero rows. That is
 * indistinguishable from an empty table, so a read returning `[]` is necessary
 * but not sufficient. The INSERT probes are the load-bearing ones: a denied
 * insert raises 42501, and an ALLOWED one is unambiguous proof the table is
 * open. Every insert below is shaped to satisfy NOT NULL constraints, so a
 * 23502 would mean the probe is wrong rather than the table safe — the
 * assertions reject that answer too.
 *
 * Nothing here writes: every insert is expected to fail. If one ever succeeds
 * the test fails loudly, and the row it created is deleted in the same run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

function readEnv() {
  const out = { ...process.env };
  for (const name of [".env.local", ".env"]) {
    const path = new URL(`../${name}`, import.meta.url);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !out[m[1]]) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

const env = readEnv();
const URL_ = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
const ANON = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;
const skip = !URL_ || !ANON ? "no VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY available" : false;

const REST = () => `${URL_.replace(/\/$/, "")}/rest/v1/`;
const headers = () => ({ "Content-Type": "application/json", apikey: ANON });

/**
 * Every table that holds one tenant's business data. A table added here without
 * a matching policy fails this test on its first run, which is the point.
 */
const TENANT_TABLES = [
  "orders", "products", "customers", "suppliers", "expenses", "transactions",
  "purchase_invoices", "wholesale_clients", "wholesale_invoices",
  "return_records", "discount_codes", "branches", "shipping_rates",
  "ledger_events", "ledger_lines", "stores", "store_members", "store_licenses",
];

/** A row shaped to pass NOT NULL, so only RLS can be what refuses it. */
const PROBE = {
  orders: { orderNumber: "RLS-PROBE", customerName: "RLS PROBE", customerPhone: "0" },
  products: { name: "RLS PROBE" },
  customers: { name: "RLS PROBE" },
  suppliers: { companyName: "RLS PROBE" },
  expenses: { category: "RLS PROBE", amount: 0 },
  transactions: { type: "expense", amount: 0 },
  purchase_invoices: { invoiceNumber: "RLS-PROBE" },
  wholesale_clients: { companyName: "RLS PROBE" },
  wholesale_invoices: { invoiceNumber: "RLS-PROBE", clientId: "x" },
  return_records: { type: "return" },
  discount_codes: { code: "RLS-PROBE", type: "fixed", value: 0 },
  branches: { name: "RLS PROBE" },
  shipping_rates: { governorate: "RLS PROBE" },
  ledger_events: { kind: "sale" },
  ledger_lines: { account: "stock" },
  stores: { name: "RLS PROBE" },
  store_members: { role: "ADMIN", user_id: "00000000-0000-0000-0000-0000000000fe" },
  store_licenses: { license_key: "RLS-PROBE", plan_type: "PRO", valid_until: "2099-01-01T00:00:00Z" },
};

/** A store id nothing anonymous could ever belong to. */
const FOREIGN_STORE = "00000000-0000-0000-0000-0000000000ff";

/**
 * Tables keyed by something other than a text `id`. Sending `id` to these gets
 * PGRST204 ("could not find the 'id' column") from PostgREST before Postgres
 * ever evaluates a policy — a refusal that proves nothing. The assertions
 * below reject that answer rather than counting it as a pass.
 */
const NO_ID_COLUMN = new Set(["store_members", "store_licenses"]);

test("an anonymous caller cannot write to any tenant table", { skip }, async () => {
  const open = [];

  for (const table of TENANT_TABLES) {
    const body = {
      ...(NO_ID_COLUMN.has(table) ? {} : { id: `RLS-PROBE-${table}-${Date.now()}` }),
      ...(table === "stores" ? { id: FOREIGN_STORE } : { store_id: FOREIGN_STORE }),
      ...PROBE[table],
    };

    const res = await fetch(`${REST()}${table}`, {
      method: "POST",
      headers: { ...headers(), Prefer: "return=representation" },
      body: JSON.stringify(body),
    });

    if (res.status < 300) {
      // It let us in. Take the row straight back out, then fail.
      const rows = await res.json().catch(() => []);
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row?.id) {
          await fetch(`${REST()}${table}?id=eq.${encodeURIComponent(row.id)}`, {
            method: "DELETE",
            headers: headers(),
          });
        }
      }
      open.push(`${table} accepted an anonymous INSERT (${res.status})`);
      continue;
    }

    const text = await res.text();
    // 42501 is RLS refusing. Anything else means the probe never reached the
    // policy — a broken probe cannot stand in for a passing test.
    if (!text.includes("42501") && !/row-level security/i.test(text)) {
      open.push(`${table} refused for a reason that is not RLS: ${res.status} ${text.slice(0, 120)}`);
    }
  }

  assert.deepEqual(
    open,
    [],
    "tables reachable without a session:\n  " + open.join("\n  "),
  );
});

test("an anonymous caller reads no tenant rows", { skip }, async () => {
  // Weaker than the write test by nature — a denied SELECT and an empty table
  // look the same — but it is the assertion that would catch a table left
  // world-READABLE while writes stayed locked, which is the shape a leak takes.
  const leaking = [];

  for (const table of TENANT_TABLES) {
    const res = await fetch(`${REST()}${table}?select=id&limit=1`, { headers: headers() });
    if (res.status === 200) {
      const rows = await res.json().catch(() => []);
      if (Array.isArray(rows) && rows.length > 0) leaking.push(`${table} returned ${rows.length} row(s)`);
    }
  }

  assert.deepEqual(leaking, [], "tables readable without a session:\n  " + leaking.join("\n  "));
});

test("the licence admin functions are not callable without a session", { skip }, async () => {
  for (const fn of [
    "admin_list_stores",
    "admin_set_license",
    "admin_extend_license",
    "admin_suspend_license",
    "admin_reactivate_license",
    "admin_revoke_license",
  ]) {
    const res = await fetch(`${REST()}rpc/${fn}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ p_store_id: FOREIGN_STORE }),
    });
    assert.ok(
      res.status === 401 || res.status === 403 || res.status === 404,
      `${fn} answered ${res.status} to an anonymous caller`,
    );
  }
});
