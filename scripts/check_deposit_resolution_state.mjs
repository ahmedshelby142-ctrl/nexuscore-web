/**
 * تسوية العميلة — the control follows the LEDGER, and the refund cannot repeat.
 *
 * Live finding (973d1fb): ECO-0002 (shop-caused, deposit 300) had been refunded
 * once — one `deposit_refunded` event, `deposit_pending_resolution` back at 0 —
 * yet the Orders screen still offered «تسوية العميلة», because the button was
 * rendered from the order row alone (confirmed return + shop/courier cause +
 * deposit > 0), and none of those change when the deposit goes back.
 *
 * The money was never at risk: `refund_order_deposit` derives the amount from
 * that same ledger balance under a per-order lock and refuses at zero. These
 * checks pin both halves — the server's guard and the screen reading it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { depositResolutionState } from "../src/lib/shippingRates.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const page = read("src/components/ecommerce/OrdersPage.tsx");
const driver = read("src/lib/ledger/driver.ts");
const m038 = read("docs/migrations/038_courier_return_deposit_resolution.sql");
const refundFn = m038.slice(m038.indexOf("CREATE OR REPLACE FUNCTION public.refund_order_deposit"), m038.indexOf("COMMENT ON FUNCTION public.refund_order_deposit"));

const returned = (cause, deposit = 300) => ({ returnConfirmedAt: "2026-10-03T10:00:00Z", return_cause: cause, depositAmount: deposit });

test("1. an unsettled shop/courier return with a held deposit offers تسوية العميلة", () => {
  assert.equal(depositResolutionState(returned("shop"), 300), "offer");
  assert.equal(depositResolutionState(returned("courier", 200), 200), "offer");
});

test("2–3. once refunded (held back at 0) it reads settled and is no longer offered", () => {
  // ECO-0002 exactly: deposit 300 on the row, 0 held in the ledger.
  assert.equal(depositResolutionState(returned("shop", 300), 0), "settled");
  assert.notEqual(depositResolutionState(returned("shop", 300), 0), "offer");
});

test("a deposit never held as pending is neither offered nor called settled", () => {
  // ECO-1789242567593 / ECO-1789345625365: no pending line at all — the server
  // would answer NEXUS_NOTHING_TO_REFUND, so there is nothing to offer.
  assert.equal(depositResolutionState(returned("shop", 400), "none"), "none");
});

test("9. the existing eligibility rule is unchanged: only a shop/courier-caused, confirmed return with a deposit", () => {
  assert.equal(depositResolutionState(returned("customer"), 300), "none", "Rule A — a customer's walk-away is not refundable");
  assert.equal(depositResolutionState(returned("unknown"), 300), "none");
  assert.equal(depositResolutionState({ ...returned("shop"), returnConfirmedAt: null }, 300), "none", "goods not back yet");
  assert.equal(depositResolutionState(returned("shop", 0), 300), "none", "no deposit on the order");
});

test("not read yet hides the control; a failed read offers it and lets the server decide", () => {
  assert.equal(depositResolutionState(returned("shop"), "loading"), "none");
  assert.equal(depositResolutionState(returned("shop"), "unknown"), "offer");
});

test("4 + 8. Desktop renders from the ledger read, re-reads it on mount and on every ledger change, and no longer from the row alone", () => {
  assert.match(page, /balancesByRef\(\{\s*account: "revenue",\s*refType: "ecommerce_order",\s*subjectId: "deposit_pending_resolution",/);
  assert.match(page, /resolutionStateOf\(order\) === "offer" && \(/);
  assert.match(page, /resolutionStateOf\(order\) === "settled" && \(/);
  assert.match(page, /تمت تسوية العميلة/);
  assert.match(page, /window\.addEventListener\("ledger-sync-pulled", onPulled\)/);
  assert.match(page, /void reloadHeldDeposits\(\);\n  \}, \[reloadHeldDeposits, eligibleForResolution\]\);/);
  // The old condition — order row only — must not come back.
  assert.doesNotMatch(page, /order\.returnConfirmedAt &&\s*depositRefundEligible\(toReturnCause\(order\.return_cause\)\) &&\s*\(order\.depositAmount \?\? 0\) > 0 && \(/);
  // A refusal (stale tab) re-reads the ledger.
  const resolve = page.slice(page.indexOf("const resolveDeposit = async"), page.indexOf("const confirmReturn = async"));
  assert.match(resolve, /catch \(e\) \{[\s\S]*void reloadHeldDeposits\(\);/);
});

test("the ledger driver narrows balancesByRef to one subject when asked", () => {
  assert.match(driver, /if \(query\.subjectId\) q = q\.eq\("subject_id", query\.subjectId\);/);
});

test("5. a second refund moves nothing: the server derives the amount from the held balance and refuses at zero", () => {
  assert.match(refundFn, /SELECT COALESCE\(SUM\(l\.amount_delta\), 0\) INTO v_pending/);
  assert.match(refundFn, /l\.subject_id = 'deposit_pending_resolution'/);
  assert.match(refundFn, /IF v_pending <= 0 THEN\s*RAISE EXCEPTION 'NEXUS_NOTHING_TO_REFUND';/);
  // …and the refund reverses that very subject, so the balance it reads is now 0.
  assert.match(refundFn, /'account', 'revenue',\s*'subject_id', 'deposit_pending_resolution',\s*'qty_delta', 0,\s*'amount_delta', -v_pending/);
  // No amount comes from the client.
  assert.doesNotMatch(refundFn, /p_amount/);
});

test("6. double-click: one refund — runOnce in the client, a per-order advisory lock in the server", () => {
  assert.match(page, /const resolveDeposit = async \(\) => runOnce\(async \(\) => \{/);
  assert.match(refundFn, /PERFORM pg_advisory_xact_lock\(hashtext\('refund_order_deposit:' \|\| p_order_id\)\);/);
});

test("10–11. a refund touches only the till, the held revenue and LTV — never a courier balance", () => {
  const accounts = [...refundFn.matchAll(/'account', '([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(accounts)].sort(), ["customer_ltv", "revenue", "wallet"]);
});

test("7. Mobile offers no refund action — the Moderator surface stays read-only", () => {
  for (const f of ["src/mobile/screens/MobileOrderDetails.tsx", "src/mobile/data/mobileReaders.ts"]) {
    assert.doesNotMatch(read(f), /refund_order_deposit|refundOrderDeposit/);
  }
});
