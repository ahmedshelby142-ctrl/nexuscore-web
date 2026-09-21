/**
 * One order-status vocabulary, everywhere.
 *
 *     node --test scripts/check_order_status_contract.mjs
 *
 * ## The drift this exists to stop
 *
 * `orders_status_check` on the live project accepts exactly five values. Mobile
 * filtered, labelled and counted a sixth — `processing` — that Postgres has
 * never accepted, and the wholesale invoice screen WROTE it. That write came
 * back 23514 every time, so "إنشاء طلب شحن" could not create an order at all,
 * and the mobile "جاهز للشحن" tab filtered on a value no row can hold, so it
 * was permanently empty.
 *
 * Nothing caught it because `EcommerceOrderStatus` is `any` (src/types/index.ts)
 * — the type system has no opinion here, so this file is the opinion.
 *
 * `processing` came from `supabase/migrations/20240608_database_schema.sql`, an
 * abandoned schema that also declares `completed`. Neither value was ever live:
 * migration 012 records the real lineage. Both are asserted against here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { ORDER_STATUS_TAXONOMY, UNKNOWN_ORDER_STATUS, resolveOrderStatus }
  from "../src/mobile/viewmodels/statusTaxonomies.ts";

/** The live `orders_status_check`, verified against the database 2026-09-21. */
const CANONICAL = ["pending", "shipped", "delivered", "returned", "cancelled"];

/** Values the abandoned 20240608 schema declared. Postgres rejects both. */
const NEVER_LIVE = ["processing", "completed"];

/**
 * Files that legitimately carry these words as their OWN vocabulary — neither
 * one writes or filters `orders.status`.
 */
const NOT_ORDER_STATUS = [
  // `ShippingInfo.status`, a shipping sub-state. Its own list also holds
  // `returned_partial` / `returned_full`, which are not order statuses either.
  "src/components/shipping/ShippingSelector.tsx",
  // `OnlineOrderPayload.status` for the `online_orders` table.
  "src/lib/api/integrations.server.ts",
];

test("the repo's record of the live CHECK lists exactly the canonical five", () => {
  const sql = readFileSync("docs/migrations/012_orders_schema_drift.sql", "utf8");
  const clause = /orders_status_check"?\s*\n?\s*CHECK \(status = ANY \(ARRAY\[([^\]]+)\]\)\)/.exec(sql);
  assert.ok(clause, "012 must still declare orders_status_check");
  const listed = [...clause[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(listed, CANONICAL);
});

test("mobile renders every DB status, and only DB statuses", () => {
  // Both halves matter: a missing key renders a real order as "غير معروف",
  // and an extra key is a label for something that can never arrive.
  assert.deepEqual(Object.keys(ORDER_STATUS_TAXONOMY).sort(), [...CANONICAL].sort());
});

test("desktop renders every DB status, and only DB statuses", () => {
  const page = readFileSync("src/components/ecommerce/OrdersPage.tsx", "utf8");
  const block = /const STATUS_META[\s\S]*?\n> = \{([\s\S]*?)\n\};/.exec(page);
  assert.ok(block, "STATUS_META must still be a literal this test can read");
  const keys = [...block[1].matchAll(/^\s{2}(\w+):\s*\{/gm)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), [...CANONICAL].sort());
});

test("a status Postgres rejects resolves to UNKNOWN, not a friendly label", () => {
  for (const status of NEVER_LIVE) {
    assert.equal(resolveOrderStatus(status), UNKNOWN_ORDER_STATUS,
      `${status} must not have a mobile label — Postgres returns 23514 for it`);
  }
  for (const status of CANONICAL) {
    assert.notEqual(resolveOrderStatus(status), UNKNOWN_ORDER_STATUS,
      `${status} is a real DB value and must never render as "غير معروف"`);
  }
});

test("no source file quotes a status the database will reject", () => {
  // Quoted literals only: the English word "processing" in a comment about the
  // sync queue is not an order status and must not fail this.
  const pattern = NEVER_LIVE.map((s) => `["']${s}["']`).join("|");
  let hits = [];
  try {
    hits = execFileSync("git", ["grep", "-nE", pattern, "--", "src/"], { encoding: "utf8" })
      .split("\n").filter(Boolean);
  } catch (e) {
    if (e.status !== 1) throw e; // 1 = no matches, which is the passing case
  }
  const offenders = hits.filter((line) => !NOT_ORDER_STATUS.some((f) => line.startsWith(`${f}:`)));
  assert.deepEqual(offenders, [], `these quote a status Postgres rejects:\n${offenders.join("\n")}`);
});

// ── The database half: `mobile_shortages` (migration 037) ───────────────────
//
// The RPC filtered `o.status IN ('pending', 'processing')`. The CHECK made the
// second value inert, which is exactly why it survived the application sweep —
// and exactly why it was worth removing: a predicate that is harmless only
// because of a constraint somewhere else starts selecting again the day that
// constraint moves.
//
// 037 is a ONE-PREDICATE diff against 033. That is asserted here rather than
// described, because "I only changed one line" is the claim a reviewer of a
// 60-line SECURITY DEFINER body cannot check by eye.

const shortagesRpc = readFileSync("docs/migrations/037_mobile_shortages_status_contract.sql", "utf8");
const priorRpc = readFileSync("docs/migrations/033_moderator_role.sql", "utf8");

/** The function body only — the header prose discusses `processing` on purpose. */
function functionBlock(sql) {
  const m = /CREATE OR REPLACE FUNCTION public\.mobile_shortages[\s\S]*?\$function\$;/.exec(sql);
  assert.ok(m, "mobile_shortages must still be defined as a replaceable function");
  return m[0];
}

/** Executable text: comments stripped, whitespace collapsed. */
function executable(sql) {
  return functionBlock(sql).replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim().replace(/;$/, "");
}

test("the shortages RPC selects open orders by the canonical status, alone", () => {
  const code = executable(shortagesRpc);
  const filter = /o\.status IN \(([^)]*)\)/.exec(code);
  assert.ok(filter, "the open-order status filter must still exist");
  const listed = [...filter[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  // Exactly `pending`: not a superset that quietly re-admits a rejected value,
  // and not a subset or a different status that would empty the report.
  assert.deepEqual(listed, ["pending"]);
});

test("the shortages RPC body names no status the database rejects", () => {
  const code = executable(shortagesRpc);
  for (const status of NEVER_LIVE) {
    assert.doesNotMatch(code, new RegExp(`'${status}'`),
      `${status} is rejected by orders_status_check and must not appear in the RPC`);
  }
  // And no OTHER canonical status crept in alongside `pending` anywhere.
  for (const status of CANONICAL.filter((s) => s !== "pending")) {
    assert.doesNotMatch(code, new RegExp(`'${status}'`),
      `the shortages RPC must not start considering ${status} orders`);
  }
});

test("037 changes that one predicate and nothing else in the function", () => {
  // Migration 033 was verified byte-identical to the live definition before
  // 037 was written (normalised md5 9f244a14ca0a4b4f85811f26be8419fc), so
  // proving 037 == 033-with-one-substitution proves it against production.
  const rebuilt = executable(priorRpc).replace("o.status IN ('pending', 'processing')", "o.status IN ('pending')");
  assert.equal(executable(shortagesRpc), rebuilt,
    "037 must be 033 with the status predicate narrowed — nothing else");
});

test("the shortages RPC keeps its guard, its tenant scope and its shape", () => {
  const code = executable(shortagesRpc);
  // SECURITY DEFINER means the body runs as the owner, so every one of these is
  // load-bearing: they are the only thing standing between a caller and another
  // tenant's orders. A migration that "just" edits a predicate must not drop one.
  assert.match(code, /SECURITY DEFINER/);
  assert.match(code, /SET search_path TO 'public', 'pg_temp'/);
  assert.match(code, /IF NOT COALESCE\(public\.has_role\(/,
    "has_role returns NULL for a non-member; without COALESCE the guard inverts");
  assert.match(code, /ARRAY\['ADMIN', 'ACCOUNTANT', 'ECOMMERCE_ONLY', 'MODERATOR'\]::text\[\]/);
  assert.equal(code.match(/store_id = p_store/g).length, 3,
    "orders, ledger_lines and products must each stay scoped to the caller's store");
  // The eight columns the mobile reader destructures, in order.
  const shape = /RETURNS TABLE\(([^)]*\([^)]*\))*[^)]*\)/.exec(code)[0];
  assert.deepEqual(
    [...shape.matchAll(/(\w+) (?:text|numeric|bigint|jsonb)/g)].map((m) => m[1]),
    ["product_id", "product_name", "sku", "stock", "required", "deficit", "order_count", "waiting_orders"],
  );
});
