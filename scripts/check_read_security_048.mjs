/**
 * Database read security — S-1 / S-2 / S-3 / S-5 (migrations 047 + 048).
 *
 *     node --test scripts/check_read_security_048.mjs
 *
 * Every SELECT policy was `is_store_member(store_id)`. Measured 2026-09-27 in a
 * rolled-back transaction, a MODERATOR's own JWT read 500 ledger lines (111
 * with unit_cost), the wallet total, `cogsAmount` and line `unitCost` on every
 * order, expenses, purchase invoices, suppliers, wholesale invoices, return
 * records, discount codes and every colleague's email.
 *
 * The behaviour is proven against the live schema by
 * `scripts/security/047_048_read_matrix.sql` (run inside begin … rollback).
 * This file pins the SQL that proof depends on, so a later edit that quietly
 * re-widens a policy, re-couples the predicate to the licence, or puts cost
 * back into the projection fails here first.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const sql = (p) => read(p).replace(/--[^\n]*/g, ""); // statements, not the prose about them
const m047 = sql("../docs/migrations/047_operational_read_projection.sql");
const m048 = sql("../docs/migrations/048_moderator_read_restrictions.sql");

const FINANCE_TABLES = [
  ["ledger_lines", "S-1"], ["ledger_events", "S-1"], ["orders", "S-2"],
  ["expenses", "S-3"], ["transactions", "S-3"], ["purchase_invoices", "S-3"], ["suppliers", "S-3"],
  ["wholesale_invoices", "S-3"], ["wholesale_clients", "S-3"], ["courier_claims", "S-3"],
  ["return_records", "S-3"], ["discount_codes", "S-3"],
];

test("the finance predicate is an explicit allow-list without MODERATOR", () => {
  const fn = m047.slice(m047.indexOf("FUNCTION public.can_read_store_finance"), m047.indexOf("$function$;", m047.indexOf("FUNCTION public.can_read_store_finance")));
  assert.match(fn, /public\.member_role\(p_store_id\) = ANY \(ARRAY\['ADMIN', 'ACCOUNTANT', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY'\]\)/);
  assert.doesNotMatch(fn, /MODERATOR/, "fail closed: not a deny-list");
  // has_role ANDs a licence check: `NOT has_role(…, 'MODERATOR')` would open
  // the ledger to a Moderator the day the licence lapses.
  assert.doesNotMatch(fn, /has_role/);
  assert.match(fn, /COALESCE\(/, "a non-member is false, never NULL");
  assert.match(fn, /SECURITY DEFINER/);
});

for (const [table, finding] of FINANCE_TABLES) {
  test(`${finding}: select on ${table} requires can_read_store_finance`, () => {
    assert.match(
      m048,
      new RegExp(`ALTER POLICY select_${table} ON public\\.${table}\\s+USING \\(public\\.can_read_store_finance\\(store_id\\)\\);`),
    );
  });
}

test("no read policy is widened: nothing becomes USING (true) or loses its store", () => {
  assert.doesNotMatch(m047 + m048, /USING \(\s*true\s*\)/i);
  for (const using of (m047 + m048).match(/USING \([^;]*\);/g) ?? []) {
    assert.match(using, /store_id|auth\.uid\(\)/, `every policy stays tied to the caller's store: ${using}`);
  }
});

test("S-2: orders_operational never carries COGS, and gates the rest of the cost", () => {
  const view = m047.slice(m047.indexOf("CREATE OR REPLACE VIEW public.orders_operational"), m047.indexOf("REVOKE ALL ON public.orders_operational"));
  assert.doesNotMatch(view, /cogsAmount/, "COGS is not in the projection at all");
  assert.match(view, /CASE WHEN public\.can_read_store_finance\(o\.store_id\) THEN o\."courierFee" END AS "courierFee"/);
  assert.match(view, /THEN o\.items ELSE public\.strip_line_cost\(o\.items\) END AS items/);
  assert.match(view, /THEN o\."stockItems" ELSE public\.strip_line_cost\(o\."stockItems"\) END AS "stockItems"/);
  assert.match(view, /WHERE public\.is_store_member\(o\.store_id\);/, "tenant isolation is the view's own WHERE");
  assert.match(view, /security_barrier = true/, "a caller's filter cannot run before that WHERE");
  assert.match(m047, /REVOKE ALL ON public\.orders_operational FROM PUBLIC, anon;/);
  assert.match(m047, /e - 'unitCost'/, "the line key is dropped on the way out; history is not rewritten");
  assert.doesNotMatch(m047 + m048, /UPDATE public\.orders|UPDATE orders/, "no historical order is modified");
});

test("S-1: the operational ledger reads take no store id and return no money", () => {
  for (const name of ["mobile_stock_quantities", "mobile_order_timeline"]) {
    const at = m047.indexOf(`FUNCTION public.${name}(`);
    const fn = m047.slice(at, m047.indexOf("$function$;", at));
    assert.doesNotMatch(fn.slice(0, fn.indexOf(")")), /p_store/, `${name}: the caller cannot name a store`);
    assert.match(fn, /WHERE m\.user_id = auth\.uid\(\)/, `${name}: the store is the caller's own membership`);
    assert.doesNotMatch(fn, /amount|unit_cost|payload/, `${name}: no money, no payload`);
    assert.match(m047, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon;`));
  }
  const qty = m047.slice(m047.indexOf("FUNCTION public.mobile_stock_quantities("));
  assert.match(qty, /RETURNS TABLE\(product_id text, qty numeric\)/);
  assert.match(qty, /l\.account = 'stock'/);
});

test("S-1: realtime is a signal table clients cannot write", () => {
  assert.match(m047, /source text NOT NULL CHECK \(source IN \('orders', 'ledger_events'\)\)/);
  assert.match(m047, /CREATE POLICY select_store_activity ON public\.store_activity\s+FOR SELECT USING \(public\.is_store_member\(store_id\)\);/);
  assert.doesNotMatch(m047, /CREATE POLICY \w+ ON public\.store_activity\s+FOR (INSERT|UPDATE|DELETE|ALL)/);
  assert.match(m047, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.store_activity FROM PUBLIC, anon, authenticated;/);
  const trig = m047.slice(m047.indexOf("FUNCTION public.signal_store_activity()"), m047.indexOf("$function$;", m047.indexOf("FUNCTION public.signal_store_activity()")));
  // 043: nothing may wrap ledger_append's writes in a subtransaction.
  assert.doesNotMatch(trig, /EXCEPTION/);
  assert.match(m047, /ALTER PUBLICATION supabase_realtime ADD TABLE public\.store_activity;/);
});

test("S-5: the staff directory is ADMIN-only; a member still reads its own row", () => {
  assert.match(m048, /ALTER POLICY select_store_members ON public\.store_members\s+USING \(user_id = auth\.uid\(\) OR public\.member_role\(store_id\) = 'ADMIN'\);/);
  const fn = m048.slice(m048.indexOf("FUNCTION public.list_store_members()"));
  assert.match(fn, /WHERE public\.member_role\(sm\.store_id\) = 'ADMIN';/);
  assert.doesNotMatch(fn, /is_store_member/);
  assert.match(m048, /REVOKE ALL ON FUNCTION public\.list_store_members\(\) FROM PUBLIC, anon;/);
});

test("writes and the earlier boundary migrations are untouched", () => {
  assert.doesNotMatch(m047 + m048, /ALTER POLICY (write|insert|update|no_)\w*/, "no write policy is changed");
  assert.doesNotMatch(m047 + m048, /ledger_validate_event|FUNCTION public\.place_order|FUNCTION public\.ledger_append/, "043–046 are not redefined");
});
