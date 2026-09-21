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
