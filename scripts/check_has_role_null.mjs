/**
 * `has_role` must answer TRUE or FALSE. Never NULL.
 *
 *     node --test scripts/check_has_role_null.mjs
 *
 * ## The bug this exists to prevent
 *
 * `has_role(store, VARIADIC roles)` is
 *
 *     member_role(store) = ANY(roles) AND store_licensed(store)
 *
 * `member_role` is a scalar SELECT that matches no row for a NON-MEMBER, so it
 * returns NULL, and `NULL = ANY(...)` is NULL. `store_licensed` is an EXISTS
 * and is never NULL, so exactly one cell of the truth table is NULL — the
 * non-member of a LICENSED store, which is the most security-sensitive input
 * the function takes.
 *
 * RLS survives that: a NULL `USING` / `WITH CHECK` is not TRUE, so the row is
 * filtered. PL/pgSQL does not:
 *
 *     IF NOT has_role(...) THEN RETURN; END IF;   -- NOT NULL is NULL
 *                                                 -- IF NULL does not fire
 *
 * so the guard is skipped for precisely the caller it exists to stop. This is
 * not hypothetical — it shipped in `mobile_shortages` (migration 028) and let
 * an ADMIN of a different shop read QA-STORE's rows until the call site was
 * wrapped in COALESCE. Migration 031 moves the fix into the function.
 *
 * ## Why this guard is source-level
 *
 * The function lives in Postgres and these tests run without a database, so
 * they pin the SQL we ship: the migration that hardens it, the master schema
 * that bootstraps it, and the absence of the dangerous call shape anywhere in
 * the repository's SQL. The live behaviour is verified separately against
 * QA-STORE and recorded in the session report.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const MIGRATIONS = new URL("../docs/migrations/", import.meta.url);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const migration = (name) => readFileSync(new URL(name, MIGRATIONS), "utf8");

/**
 * SQL with its comments removed.
 *
 * These assertions are about CODE. The migrations carry long prose explaining
 * the very shapes being forbidden, so matching raw text would fail on the
 * explanation rather than on an actual occurrence.
 */
const code = (sql) =>
  sql
    // CRLF first. In a JS regex `.` excludes CR as a line terminator, so on a
    // CRLF file `/--.*$/` matches up to the CR, finds `$` is not there yet, and
    // strips NOTHING — every comment survives and every assertion below reads
    // the prose instead of the code.
    .replace(/\r/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, "");

/** Every .sql we ship, so a new one cannot quietly reintroduce the shape. */
const allSql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => ({ name: f, body: migration(f) }));

test("the hardening migration exists and COALESCEs to false", () => {
  const sql = code(migration("031_has_role_never_null.sql"));
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.has_role\(p_store_id uuid, VARIADIC p_roles text\[\]\)/);
  assert.match(sql, /COALESCE\(/);
  assert.match(sql, /false\s*\)/, "the fallback must be false, never true");
  assert.doesNotMatch(sql, /COALESCE\([^)]*,\s*true\s*\)/i, "a true fallback would grant access to everyone");
});

test("the hardening does not touch the permission model", () => {
  const sql = code(migration("031_has_role_never_null.sql"));
  // Same membership lookup, same licence term, same signature.
  assert.match(sql, /public\.member_role\(p_store_id\) = ANY\(p_roles\)/);
  assert.match(sql, /public\.store_licensed\(p_store_id\)/, "the licence check must survive");
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /SET search_path TO 'public', 'pg_temp'/, "search_path must stay pinned");
  // No role list, no policy, no grant may appear in a pure hardening migration.
  assert.doesNotMatch(sql, /CREATE POLICY|DROP POLICY|ALTER POLICY/i);
  assert.doesNotMatch(sql, /\bGRANT\b/i);
  assert.doesNotMatch(sql, /ADMIN|ACCOUNTANT|POS_ECOMMERCE|ECOMMERCE_ONLY/);
});

test("the master schema bootstraps a non-NULL has_role too", () => {
  // A fresh bootstrap must not start life with the footgun. It carries no
  // licence term because `store_licensed` does not exist until migration 024.
  const sql = code(migration("000_master_schema.sql"));
  const at = sql.indexOf("FUNCTION public.has_role");
  assert.ok(at > 0, "master schema must define has_role");
  const body = sql.slice(at, at + 400);
  assert.match(body, /COALESCE\(public\.member_role\(p_store_id\) = ANY\(p_roles\), false\)/);
});

test("no shipped SQL uses the dangerous `IF NOT has_role(...)` shape", () => {
  // The call-site fix stays belt-and-braces: even with the function hardened,
  // writing this shape means relying on a guarantee that is easy to lose.
  for (const { name, body: raw } of allSql) {
    const body = code(raw);
    const bare = /IF\s+NOT\s+(public\.)?has_role\s*\(/i.test(body);
    if (!bare) continue;
    // Allowed only when wrapped in COALESCE at the call site as well.
    assert.match(
      body,
      /IF\s+NOT\s+COALESCE\s*\(\s*(public\.)?has_role/i,
      `${name}: \`IF NOT has_role(...)\` must be COALESCE-wrapped`,
    );
  }
});

test("mobile_shortages keeps its own fail-closed guard", () => {
  // Defence in depth: 028 wrapped the call site, 031 hardened the function.
  // Neither is allowed to be removed on the strength of the other.
  const sql = code(migration("028_mobile_shortages_real_demand.sql"));
  assert.match(sql, /IF NOT COALESCE\(public\.has_role\(/);
});

// ── the legacy courier bucket ───────────────────────────────────────────────

test("the legacy courier subject is named as history, not as a company", () => {
  const src = read("../src/lib/courierBatch.ts");
  assert.match(src, /LEGACY_COURIER_SUBJECT = "default"/);
  // Audited 2026-09-14: 2,340 of QA-STORE's 2,520 EGP under this subject sits
  // on orders naming NO courier at all, so it cannot be attributed to anyone.
  assert.match(src, /LEGACY_COURIER_LABEL/);
  assert.doesNotMatch(
    read("../src/components/ecommerce/CourierLedgerPage.tsx"),
    /"شركة الشحن الافتراضية"/,
    "calling the unassigned bucket a default COMPANY reads as a real account",
  );
});

test("a shipped order may not land in the legacy bucket", () => {
  const src = read("../src/lib/courierBatch.ts");
  assert.match(src, /export function requiresCourierAssignment/);
  // The order form must actually enforce it, at the last point before a write.
  assert.match(
    read("../src/routes/ecommerce-orders.tsx"),
    /requiresCourierAssignment\(\{/,
    "the guard must be called before the ledger write",
  );
});

test("an order with no shipping is not forced to invent a courier", () => {
  const src = read("../src/lib/courierBatch.ts");
  const at = src.indexOf("export function requiresCourierAssignment");
  const body = src.slice(at);
  assert.match(body, /return shipping && isLegacyCourier/, "the guard is conditional on shipping");
});
