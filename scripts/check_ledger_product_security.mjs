/**
 * I-2 / I-3 — the database, not the UI, refuses the two exploits.
 *
 *     node --test scripts/check_ledger_product_security.mjs
 *
 * I-2: a POS_ECOMMERCE session appended a `wallet +100,000,000` piastre line
 *      to an ADMIN's existing `purchase` event and it was accepted — money
 *      minted, and a posted event altered. Migration 043 lets a line in only
 *      for an event created in the SAME transaction (`ledger_append`).
 * I-3: the product guard refused price/definition changes but not `id`, so a
 *      POS session could re-key a product off its whole ledger history.
 *
 * The behaviour itself was proven against the live database, in rolled-back
 * transactions, with `scripts/security/043_security_matrix.sql` (30 rows, all
 * as expected, plus two mutants that let the attacks back in). These tests pin
 * the SQL that produces that behaviour, and mutation-test the pins: each
 * predicate is removed from a copy of the migration and the checker must fail.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// LF-normalised: a Windows checkout has CRLF, and the mutants below splice
// on `\n` — without this they silently fail to apply there.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
/** SQL with `--` comments removed, so prose cannot satisfy an assertion. */
const sql = (text) => text.replace(/--[^\n]*/g, "");

const MIGRATION = read("docs/migrations/043_ledger_line_event_integrity_and_product_id.sql");
const MATRIX = read("scripts/security/043_security_matrix.sql");

// ── The checkers. Each returns a list of problems; empty means the SQL holds. ─

function linesPolicyProblems(text) {
  const src = sql(text);
  const policy = src.match(/CREATE POLICY insert_ledger_lines ON public\.ledger_lines[\s\S]*?\);\s*$/m)?.[0];
  if (!policy) return ["no insert_ledger_lines policy"];
  const problems = [];
  if (!/FOR INSERT/.test(policy)) problems.push("not an INSERT policy");
  if (!/public\.has_role\(store_id, VARIADIC ARRAY\['ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT'\]\)/.test(policy)) {
    problems.push("role gate changed — the four writing roles, no more, no fewer");
  }
  if (!/AND EXISTS \(/.test(policy)) problems.push("no event requirement");
  if (!/e\.id = ledger_lines\.event_id/.test(policy)) problems.push("event not matched by id");
  if (!/e\.store_id = ledger_lines\.store_id/.test(policy)) problems.push("event not pinned to the line's store");
  if (!/e\.xmin = pg_current_xact_id\(\)::xid/.test(policy)) problems.push("event not required to be from THIS transaction");
  if (/\bOR\b/i.test(policy)) problems.push("an OR can re-open the policy");
  return problems;
}

const GUARDED_COLUMNS = [
  "name", "sku", "barcode", "category", "description", "image_url", '"unitPrice"',
  "wholesale_price", '"minStockLevel"', '"maxStockLevel"', '"isActive"', '"isBundle"',
  '"bundleItems"', "deleted_at", "store_id",
];

function productGuardProblems(text) {
  const src = sql(text);
  const fn = src.match(/CREATE OR REPLACE FUNCTION public\.products_guard_definition_columns\(\)[\s\S]*?\$function\$;/)?.[0];
  if (!fn) return ["no products_guard_definition_columns"];
  const problems = [];
  if (!/SECURITY DEFINER/.test(fn)) problems.push("lost SECURITY DEFINER");
  const serviceBypass = fn.indexOf("IF auth.uid() IS NULL THEN");
  const idCheck = fn.search(/IF NEW\.id IS DISTINCT FROM OLD\.id THEN\s*RAISE EXCEPTION '[^']+' USING ERRCODE = '42501';/);
  const roleBypass = fn.indexOf("IF public.has_role(NEW.store_id, VARIADIC ARRAY['ADMIN', 'ACCOUNTANT']) THEN");
  if (idCheck < 0) problems.push("id change is not refused");
  else {
    if (roleBypass < 0 || idCheck > roleBypass) problems.push("id check sits after the ADMIN/ACCOUNTANT bypass");
    if (serviceBypass < 0 || idCheck < serviceBypass) problems.push("id check must follow the service-role return, not replace it");
  }
  for (const column of GUARDED_COLUMNS) {
    const c = column.replace(/"/g, '\\"');
    if (!new RegExp(`NEW\\.${c}\\s+IS DISTINCT FROM OLD\\.${c}`).test(fn)) problems.push(`${column} is no longer guarded`);
  }
  if (/NEW\.quantity\s+IS DISTINCT|NEW\.metadata\s+IS DISTINCT/.test(fn)) problems.push("the stock mirror must stay writable by the selling roles");
  return problems;
}

// ── The migration holds ─────────────────────────────────────────────────────

test("I-2: a ledger line may attach only to an event created in the same transaction", () => {
  assert.deepEqual(linesPolicyProblems(MIGRATION), []);
  assert.match(sql(MIGRATION), /DROP POLICY IF EXISTS insert_ledger_lines ON public\.ledger_lines;/, "idempotent");
});

test("I-3: a product id is immutable for every session user; definitions stay guarded", () => {
  assert.deepEqual(productGuardProblems(MIGRATION), []);
});

test("043 is limited to I-2 and I-3 and rewrites no data", () => {
  const src = sql(MIGRATION);
  assert.doesNotMatch(src, /\b(INSERT INTO|UPDATE\s+public\.|DELETE FROM|TRUNCATE|ALTER TABLE|DROP TABLE)\b/i);
  const objects = [...src.matchAll(/CREATE (?:OR REPLACE )?(POLICY|FUNCTION) (\S+)/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(objects, ["POLICY insert_ledger_lines", "FUNCTION public.products_guard_definition_columns()"]);
});

// ── Mutation: every pinned predicate is load-bearing for its checker ────────

test("mutants of the lines policy are caught", () => {
  const mutants = {
    "no xmin (the exploit comes back)": MIGRATION.replace(/\n\s*AND e\.xmin = pg_current_xact_id\(\)::xid/, ""),
    "no store pin": MIGRATION.replace(/\n\s*AND e\.store_id = ledger_lines\.store_id/, ""),
    "no event requirement": MIGRATION.replace(/\n\s*AND EXISTS \([\s\S]*?\n    \)/, ""),
    "role widened to MODERATOR": MIGRATION.replace("'ACCOUNTANT'])\n    AND EXISTS", "'ACCOUNTANT', 'MODERATOR'])\n    AND EXISTS"),
    "OR-ed escape hatch": MIGRATION.replace("AND e.xmin = pg_current_xact_id()::xid", "AND (e.xmin = pg_current_xact_id()::xid OR true)"),
  };
  for (const [name, text] of Object.entries(mutants)) {
    assert.notEqual(text, MIGRATION, `mutant "${name}" did not apply`);
    assert.ok(linesPolicyProblems(text).length > 0, `mutant "${name}" survived`);
  }
});

test("mutants of the product guard are caught", () => {
  const fn = MIGRATION;
  const idBlock = /  -- Identity first[^\n]*\n  IF NEW\.id IS DISTINCT FROM OLD\.id THEN\n[^\n]*\n  END IF;\n\n/;
  const mutants = {
    "id check removed": fn.replace(idBlock, ""),
    "id check after the role bypass (ADMIN could re-key — proven live)": fn
      .replace(idBlock, "")
      .replace(/(  IF public\.has_role\(NEW\.store_id[\s\S]*?END IF;\n)/, "$1\n  IF NEW.id IS DISTINCT FROM OLD.id THEN\n    RAISE EXCEPTION 'x' USING ERRCODE = '42501';\n  END IF;\n"),
    "price unguarded": fn.replace(/  OR NEW\."unitPrice"[^\n]*\n/, ""),
    "store_id unguarded": fn.replace(/  OR NEW\.store_id[^\n]*\n/, ""),
    "stock mirror frozen": fn.replace("  OR NEW.store_id ", "  OR NEW.quantity IS DISTINCT FROM OLD.quantity\n  OR NEW.store_id "),
  };
  for (const [name, text] of Object.entries(mutants)) {
    assert.notEqual(text, fn, `mutant "${name}" did not apply`);
    assert.ok(productGuardProblems(text).length > 0, `mutant "${name}" survived`);
  }
});

// ── The xmin caveat: nothing may insert an event inside a subtransaction ─────

test("no ledger writer wraps the append in an exception handler (xmin would refuse it)", () => {
  const append = sql(read("docs/migrations/032_ledger_append_atomic.sql"));
  const fn = append.match(/CREATE OR REPLACE FUNCTION public\.ledger_append[\s\S]*?\$(function)?\$;/)?.[0];
  assert.ok(fn && /INSERT INTO public\.ledger_lines/.test(fn), "ledger_append is defined in 032");
  assert.doesNotMatch(fn, /\bEXCEPTION\s+WHEN\b/i, "ledger_append must not run its inserts in a subtransaction");
  const refund = sql(read("docs/migrations/038_courier_return_deposit_resolution.sql"));
  const refundFn = refund.match(/FUNCTION public\.refund_order_deposit[\s\S]*?\$(function)?\$;/)?.[0];
  assert.ok(refundFn, "refund_order_deposit is defined in 038");
  assert.match(refundFn, /PERFORM public\.ledger_append\(/);
  assert.doesNotMatch(refundFn, /\bEXCEPTION\s+WHEN\b/i);
  // The client has exactly one ledger write, and it is the RPC.
  const driver = read("src/lib/ledger/driver.ts");
  assert.match(driver, /rpc\("ledger_append"/);
  assert.doesNotMatch(driver, /from\("ledger_(lines|events)"\)\s*\.(insert|upsert)/);
});

// ── The runtime matrix that proved it stays complete ────────────────────────

test("the 043 runtime matrix still covers every required case", () => {
  for (const name of [
    "I2-A ADMIN purchase via ledger_append",
    "I2-B POS sale via ledger_append",
    "I2-B POS purchase (role matrix forbids)",
    "I2-C POS line on ADMIN''s old event",
    "I2-C ADMIN line on OLD event",
    "I2-D POS +1,000,000 EGP wallet line on old event",
    "I2-E foreign line tagged with victim store",
    "I2-E own-store line on victim event created THIS txn",
    "I2-E foreign ledger_append into victim store",
    "I2-F ADMIN expense",
    "I2-F POS courier_settlement",
    "I2-F nested PERFORM ledger_append",
    "I2-G no orphan event left behind",
    "I3-A POS stock-mirror update",
    "I3-B POS id change",
    "I3-C POS price change",
    "I3-E POS store_id change",
    "I3-F foreign ADMIN id change",
    "I3-G ADMIN normal product update",
    "I3-G ADMIN id change (new invariant)",
    "BALANCE old purchase event lines unchanged",
  ]) {
    assert.ok(MATRIX.includes(`'${name}`), `matrix lost case: ${name}`);
  }
  assert.doesNotMatch(sql(MATRIX), /\bcommit\b/i, "the matrix must never commit");
});
