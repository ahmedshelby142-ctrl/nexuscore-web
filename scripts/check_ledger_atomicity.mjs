/**
 * `ledger_append` — the atomicity guarantee, proven against a real database.
 *
 * ## What this is defending
 *
 * The ledger used to be written in two PostgREST calls: header, then lines. A
 * failure on the second left the first committed, and the compensating
 * `delete()` the client fired could never work — `no_delete_ledger_events` is
 * `USING (false)`, so it matched zero rows, returned 204, and was not checked.
 * Forcing that failure against QA-STORE left `ledger_events` row `382e5914…`
 * (`purchase`, ref `FM-0006`) standing with no lines. Migration 011 records an
 * earlier round of the same disease, when EVERY event was a line-less header.
 *
 * Migration 032 put both inserts inside one plpgsql function, so a failure
 * anywhere aborts the statement and Postgres rolls the header back too.
 *
 * ## Why the live tests are credential-gated
 *
 * Atomicity is a property of the DATABASE. Asserting it by reading source text
 * would prove nothing — the old code also *looked* like it cleaned up. So the
 * real cases below talk to Postgres, and skip (loudly) when there are no
 * credentials, in the same shape as `check_supabase_integrity.mjs`.
 *
 * The source guards at the bottom run unconditionally. They cannot prove
 * atomicity; they exist so the two-call pattern cannot quietly come back
 * between CI runs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const skipDatabaseTests = !SUPABASE_URL || !SERVICE_KEY || !ANON_KEY;

const DEVICE = "00000000-0000-0000-0000-00000000000a";
const PASSWORD = "TestPassword123!";

let admin;
let clientA;
let clientB;
let storeA;
let storeB;
const createdUsers = [];

/** An event payload in the exact wire shape `driver.append` sends. */
function eventPayload(storeId, id, lines, overrides = {}) {
  const now = new Date().toISOString();
  return {
    id,
    store_id: storeId,
    device_id: DEVICE,
    kind: "stock_adjustment",
    occurred_at: now,
    created_at: now,
    actor: "atomicity-test",
    ref_type: "qa_atomicity",
    ref_id: id,
    payload: "{}",
    lines,
    ...overrides,
  };
}

function line(id, extra = {}) {
  return { id, account: "stock", subject_id: "atomicity-probe", qty_delta: 1, amount_delta: 0, ...extra };
}

async function setup() {
  admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const mk = async () => {
    const email = `ledger-atomicity-${crypto.randomUUID()}@nexuscore.test`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error) throw new Error(`could not create test user: ${error.message}`);
    createdUsers.push(data.user.id);
    const client = createClient(SUPABASE_URL, ANON_KEY);
    const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    if (signInError) throw new Error(`could not sign in test user: ${signInError.message}`);
    return client;
  };

  clientA = await mk();
  clientB = await mk();

  storeA = crypto.randomUUID();
  storeB = crypto.randomUUID();
  await clientA.rpc("claim_store", { local_store_id: storeA });
  await clientB.rpc("claim_store", { local_store_id: storeB });
}

async function teardown() {
  for (const id of createdUsers) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

/** How many of each survived, read with service-role so RLS cannot hide a leak. */
async function survivors(eventId, lineIds) {
  const { count: events } = await admin
    .from("ledger_events").select("id", { count: "exact", head: true }).eq("id", eventId);
  const { count: lines } = await admin
    .from("ledger_lines").select("id", { count: "exact", head: true }).in("id", lineIds);
  return { events: events ?? 0, lines: lines ?? 0 };
}

test("ledger_append atomicity (live database)", { skip: skipDatabaseTests && "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_ANON_KEY missing" }, async (t) => {
  await setup();

  await t.test("A — a good append commits the event AND its lines", async () => {
    const id = `atom-A-${crypto.randomUUID()}`;
    const lineIds = [`${id}-L1`, `${id}-L2`];
    const { error } = await clientA.rpc("ledger_append", {
      p_event: eventPayload(storeA, id, [line(lineIds[0]), line(lineIds[1])]),
    });
    assert.equal(error, null, "a valid append must succeed");
    assert.deepEqual(await survivors(id, lineIds), { events: 1, lines: 2 });
  });

  await t.test("B — a LINE failure leaves no event behind", async () => {
    // `ledger_lines.account` is NOT NULL. Omitting it is the controlled
    // failure; before migration 032 the header survived this exact shape.
    const id = `atom-B-${crypto.randomUUID()}`;
    const lineIds = [`${id}-L1`];
    const bad = { id: lineIds[0], subject_id: "atomicity-probe", qty_delta: 1, amount_delta: 0 };
    const { error } = await clientA.rpc("ledger_append", { p_event: eventPayload(storeA, id, [bad]) });
    assert.notEqual(error, null, "the append must fail");
    assert.deepEqual(await survivors(id, lineIds), { events: 0, lines: 0 }, "NO ORPHAN EVENT");
  });

  await t.test("C — an EVENT failure leaves no lines behind", async () => {
    const id = `atom-C-${crypto.randomUUID()}`;
    const first = [`${id}-L1`];
    const { error: ok } = await clientA.rpc("ledger_append", { p_event: eventPayload(storeA, id, [line(first[0])]) });
    assert.equal(ok, null);

    // Same id again: the header insert conflicts on the primary key.
    const second = [`${id}-L2`];
    const { error } = await clientA.rpc("ledger_append", { p_event: eventPayload(storeA, id, [line(second[0])]) });
    assert.notEqual(error, null, "a duplicate event id must fail");
    assert.deepEqual(await survivors(id, second), { events: 1, lines: 0 }, "the retry wrote no lines");
  });

  await t.test("D — one bad line among several rolls back all of them", async () => {
    const id = `atom-D-${crypto.randomUUID()}`;
    const lineIds = [`${id}-L1`, `${id}-L2`, `${id}-L3`];
    const lines = [
      line(lineIds[0]),
      { id: lineIds[1], subject_id: "atomicity-probe", qty_delta: 1, amount_delta: 0 }, // no account
      line(lineIds[2]),
    ];
    const { error } = await clientA.rpc("ledger_append", { p_event: eventPayload(storeA, id, lines) });
    assert.notEqual(error, null, "the append must fail");
    assert.deepEqual(await survivors(id, lineIds), { events: 0, lines: 0 }, "no partial lines");
  });

  await t.test("G — a failed attempt can be retried cleanly", async () => {
    const id = `atom-G-${crypto.randomUUID()}`;
    const lineIds = [`${id}-L1`];

    const bad = { id: lineIds[0], subject_id: "atomicity-probe", qty_delta: 5, amount_delta: 0 };
    const { error: failed } = await clientA.rpc("ledger_append", { p_event: eventPayload(storeA, id, [bad]) });
    assert.notEqual(failed, null, "attempt 1 must fail");
    assert.deepEqual(await survivors(id, lineIds), { events: 0, lines: 0 }, "attempt 1 left no residue");

    // The SAME id is reusable precisely because attempt 1 committed nothing.
    const { error: retried } = await clientA.rpc("ledger_append", { p_event: eventPayload(storeA, id, [line(lineIds[0], { qty_delta: 5 })]) });
    assert.equal(retried, null, "attempt 2 must succeed");
    assert.deepEqual(await survivors(id, lineIds), { events: 1, lines: 1 }, "exactly one final result");
  });

  await t.test("H — one store cannot write another store's ledger", async () => {
    const id = `atom-H-${crypto.randomUUID()}`;
    const lineIds = [`${id}-L1`];
    const { error } = await clientA.rpc("ledger_append", { p_event: eventPayload(storeB, id, [line(lineIds[0])]) });
    assert.notEqual(error, null, "a cross-tenant append must be refused");
    assert.deepEqual(await survivors(id, lineIds), { events: 0, lines: 0 });
  });

  await t.test("I — an anonymous caller cannot invoke the function at all", async () => {
    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const id = `atom-I-${crypto.randomUUID()}`;
    const { error } = await anon.rpc("ledger_append", { p_event: eventPayload(storeA, id, [line(`${id}-L1`)]) });
    assert.notEqual(error, null, "anon must be refused");
    assert.match(String(error.message), /permission denied/i, "refused at the grant, before RLS");
  });

  await teardown();
});

// ── Source guards. These cannot prove atomicity; they stop the old shape ─────
// ── coming back between CI runs. ─────────────────────────────────────────────

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("the driver's write path is the atomic function, not two calls", () => {
  const driver = strip(read("../src/lib/ledger/driver.ts"));
  assert.match(driver, /rpc\("ledger_append", \{ p_event: event \}\)/, "one call, whole event");
  assert.ok(!driver.includes('from("ledger_events").insert'), "no direct header insert");
  assert.ok(!driver.includes('from("ledger_lines").insert'), "no direct line insert");
  assert.ok(
    !driver.includes('from("ledger_events").delete'),
    "and no compensating delete — the ledger is append-only, so it can only ever be a no-op",
  );
});

test("nothing outside the driver writes the ledger tables directly", () => {
  // The whole guarantee rests on there being ONE writer. A second one could
  // reintroduce the two-call shape somewhere the test above does not look, so
  // this walks the tree rather than trusting a list.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(child);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        if (child.endsWith("/ledger/driver.ts")) continue;
        const src = strip(readFileSync(new URL(child, import.meta.url), "utf8"));
        if (/from\(\s*["'`]ledger_(events|lines)["'`]\s*\)\s*\.\s*(insert|upsert|update|delete)/.test(src)) {
          offenders.push(child);
        }
      }
    }
  };
  walk("../src");
  assert.deepEqual(offenders, [], "every ledger write must go through driver.append");
});

test("the migration inserts the columns the deployed tables actually have", () => {
  const raw = read("../docs/migrations/032_ledger_append_atomic.sql");
  // `--` comments stripped: the migration's header explains at length why it is
  // NOT definer, and that prose would otherwise trip the check below.
  const sql = raw.replace(/^\s*--.*$/gm, "");
  assert.match(sql, /SECURITY INVOKER/, "authorisation stays with the existing policies");
  assert.ok(!/SECURITY DEFINER/.test(sql), "no privilege elevation");
  assert.match(sql, /SET search_path TO 'public', 'pg_temp'/, "search_path pinned");
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.ledger_append\(jsonb\) FROM anon/, "anon is not granted");
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.ledger_append\(jsonb\) TO authenticated/);
  for (const column of ["qty_delta", "amount_delta", "unit_cost", "device_id", "event_id"]) {
    assert.ok(sql.includes(column), `the insert must name ${column}`);
  }
});
