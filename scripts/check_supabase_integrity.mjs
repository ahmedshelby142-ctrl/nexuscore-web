import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

// Load environment variables manually or rely on the caller to inject them
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

// Skip if we don't have credentials
const skipDatabaseTests = !SUPABASE_URL || !SUPABASE_SERVICE_KEY;

let adminClient;
let userAClient;
let userBClient;
let userA, userB;
let storeA, storeB;

async function setupTestUsers() {
  adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  
  // 1. Create two test users via Admin API
  const emailA = `test-usera-${Date.now()}@nexuscore.test`;
  const emailB = `test-userb-${Date.now()}@nexuscore.test`;
  const password = "TestPassword123!";
  
  const { data: dataA, error: errA } = await adminClient.auth.admin.createUser({ email: emailA, password, email_confirm: true });
  const { data: dataB, error: errB } = await adminClient.auth.admin.createUser({ email: emailB, password, email_confirm: true });
  
  if (errA || errB) throw new Error(`Failed to create test users: ${errA?.message || errB?.message}`);
  userA = dataA.user;
  userB = dataB.user;

  // 2. Initialize authenticated clients for User A and B
  userAClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  await userAClient.auth.signInWithPassword({ email: emailA, password });
  
  userBClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  await userBClient.auth.signInWithPassword({ email: emailB, password });

  // 3. Claim stores for both users via RPC
  storeA = crypto.randomUUID();
  storeB = crypto.randomUUID();
  
  await userAClient.rpc("claim_store", { local_store_id: storeA });
  await userBClient.rpc("claim_store", { local_store_id: storeB });
}

async function cleanupTestUsers() {
  if (userA) await adminClient.auth.admin.deleteUser(userA.id);
  if (userB) await adminClient.auth.admin.deleteUser(userB.id);
}

test("Supabase Environment Configuration", { skip: skipDatabaseTests }, async (t) => {
  await t.test("Setup test users and stores", async () => {
    await setupTestUsers();
  });

  await t.test("RPC Logic: claim_store resolves tenancy correctly", async () => {
    // Scenario A: User B already has a store (storeB), tries to claim a new one
    const newStoreId = crypto.randomUUID();
    const { data: claimData, error: claimErr } = await userBClient.rpc("claim_store", { local_store_id: newStoreId });
    
    assert.ifError(claimErr);
    assert.equal(claimData.canonical, storeB, "Should return existing canonical store");
    assert.equal(claimData.rekey, true, "Should require rekeying to canonical store");
  });

  await t.test("RLS: Tenancy isolation prevents cross-store inserts", async () => {
    // User A attempts to insert a product into User B's store
    const { error: insertErr } = await userAClient
      .from("products")
      .insert({
        id: crypto.randomUUID(),
        store_id: storeB, // ILLEGAL: Belongs to user B
        device_id: crypto.randomUUID(),
        name: "Test Malicious Product",
        price: 100,
        cost: 50
      });
      
    assert.ok(insertErr, "Expected insert to fail due to RLS violation");
    // Depending on the exact Postgres version and RLS mode, this might be a 403 or 401.
  });

  await t.test("Constraints: ledger_events is strictly append-only", async () => {
    const eventId = crypto.randomUUID();
    
    // 1. Insert valid event
    const { error: insertErr } = await userAClient.from("ledger_events").insert({
      id: eventId,
      store_id: storeA,
      device_id: crypto.randomUUID(),
      kind: "test_event",
      actor: "test",
      ref_type: "test",
      ref_id: "test",
      payload: {}
    });
    assert.ifError(insertErr);

    // 2. Attempt to UPDATE the event
    const { error: updateErr } = await userAClient
      .from("ledger_events")
      .update({ payload: { modified: true } })
      .eq("id", eventId);
      
    assert.ok(updateErr, "Expected UPDATE to fail on append-only table");
    
    // 3. Attempt to DELETE the event
    const { error: deleteErr } = await userAClient
      .from("ledger_events")
      .delete()
      .eq("id", eventId);
      
    assert.ok(deleteErr, "Expected DELETE to fail on append-only table");
  });

  await t.test("Constraints: Money types reject floats/decimals", async () => {
    // Attempt to insert a fractional value into amount_delta (which should be integer Piastres)
    const { error: floatErr } = await userAClient.from("ledger_lines").insert({
      id: crypto.randomUUID(),
      store_id: storeA,
      device_id: crypto.randomUUID(),
      event_id: crypto.randomUUID(),
      account: "wallet",
      amount_delta: 100.50 // ILLEGAL: Not an integer
    });

    assert.ok(floatErr, "Expected float insertion into money column to fail");
    assert.match(floatErr.message.toLowerCase(), /integer|invalid input syntax/, "Database must enforce integer type constraint");
  });

  await t.test("Cleanup", async () => {
    await cleanupTestUsers();
  });
});

if (skipDatabaseTests) {
  console.log("⚠️ Skipping Database Tests: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing.");
}
