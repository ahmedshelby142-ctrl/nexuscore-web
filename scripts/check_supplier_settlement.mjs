/**
 * تسوية المورد — paying a supplier down.
 *
 * `buildSupplierPaymentLines` had existed for a long time with NO caller, so
 * `payable_supplier` could only ever grow. These pin the allocator that decides
 * which invoices a payment settles, and the money rule it feeds.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  allocateSupplierPayment,
  openInvoicesFor,
  outstandingOn,
} from "../src/lib/supplierSettlement.ts";
import { buildSupplierPaymentLines } from "../src/lib/ledger/purchases.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const inv = (id, remaining, dueDate, supplierId = "s1") => ({
  id,
  invoiceNumber: id,
  supplierId,
  totalAmount: remaining,
  paidAmount: 0,
  remainingAmount: remaining,
  dueDate,
  createdAt: dueDate,
});

test("what is open on an invoice falls back to total − paid", () => {
  assert.equal(outstandingOn({ id: "a", remainingAmount: 400 }), 400);
  assert.equal(outstandingOn({ id: "a", totalAmount: 1000, paidAmount: 300 }), 700);
  // Never negative: an overpaid invoice is settled, not owed backwards.
  assert.equal(outstandingOn({ id: "a", totalAmount: 100, paidAmount: 300 }), 0);
  assert.equal(outstandingOn({ id: "a", remainingAmount: -50 }), 0);
});

test("only this supplier's still-open invoices are settleable, oldest first", () => {
  const all = [
    inv("FM-3", 100, "2026-03-01"),
    inv("FM-1", 200, "2026-01-01"),
    inv("OTHER", 900, "2025-01-01", "s2"),
    inv("FM-PAID", 0, "2024-01-01"),
    inv("FM-2", 300, "2026-02-01"),
  ];
  const open = openInvoicesFor(all, "s1");
  assert.deepEqual(
    open.map((i) => i.invoiceNumber),
    ["FM-1", "FM-2", "FM-3"],
    "another supplier's invoice and a settled one are both out",
  );
});

test("a payment settles the oldest debt first", () => {
  const open = openInvoicesFor([inv("FM-1", 200, "2026-01-01"), inv("FM-2", 300, "2026-02-01")], "s1");
  const plan = allocateSupplierPayment(open, 250);
  assert.deepEqual(
    plan.allocations.map((a) => [a.invoiceNumber, a.applied]),
    [["FM-1", 200], ["FM-2", 50]],
  );
  assert.equal(plan.applied, 250);
  assert.equal(plan.unapplied, 0);
});

test("a full payment clears every open invoice and nothing more", () => {
  const open = openInvoicesFor([inv("FM-1", 200, "2026-01-01"), inv("FM-2", 300, "2026-02-01")], "s1");
  const plan = allocateSupplierPayment(open, 500);
  assert.equal(plan.applied, 500);
  assert.equal(plan.unapplied, 0);
  assert.ok(plan.allocations.every((a) => a.applied === a.outstanding));
});

test("a partial payment leaves the rest of the invoice open", () => {
  const open = openInvoicesFor([inv("FM-1", 200, "2026-01-01")], "s1");
  const plan = allocateSupplierPayment(open, 75);
  assert.equal(plan.allocations.length, 1);
  assert.equal(plan.allocations[0].applied, 75);
  assert.equal(plan.allocations[0].outstanding, 200);
});

test("several payments in sequence settle exactly the debt, never more", () => {
  let remaining = 500;
  for (const paid of [100, 150, 250]) {
    const open = openInvoicesFor([inv("FM-1", remaining, "2026-01-01")], "s1");
    const plan = allocateSupplierPayment(open, paid);
    assert.equal(plan.applied, paid);
    assert.equal(plan.unapplied, 0);
    remaining -= paid;
  }
  assert.equal(remaining, 0);
});

test("overpaying is allowed and surfaced as a prepayment, not refused", () => {
  // The existing rule: it drives `payable_supplier` negative, which IS a credit
  // balance with a supplier. Refusing it would force a real payment to be
  // recorded as something it is not.
  const open = openInvoicesFor([inv("FM-1", 200, "2026-01-01")], "s1");
  const plan = allocateSupplierPayment(open, 500);
  assert.equal(plan.applied, 200, "only 200 can land on invoices");
  assert.equal(plan.unapplied, 300, "and the operator must be told about the rest");

  // …and the ledger books the WHOLE amount, so the balance goes to −300.
  const lines = buildSupplierPaymentLines({ supplierId: "s1", wallet: "inStoreSafe", amount: 500 });
  const payable = lines.find((l) => l.account === "payable_supplier");
  assert.equal(payable.amount, -500);
});

test("paying a supplier with no open invoices is a pure prepayment", () => {
  const plan = allocateSupplierPayment(openInvoicesFor([], "s1"), 400);
  assert.deepEqual(plan.allocations, []);
  assert.equal(plan.applied, 0);
  assert.equal(plan.unapplied, 400);
});

test("a non-positive payment is refused", () => {
  const open = openInvoicesFor([inv("FM-1", 200, "2026-01-01")], "s1");
  for (const bad of [0, -1, NaN, "abc"]) {
    assert.throws(() => allocateSupplierPayment(open, bad), /أكبر من صفر/);
  }
});

test("the money moves exactly once, in both directions", () => {
  const lines = buildSupplierPaymentLines({ supplierId: "s1", wallet: "inStoreSafe", amount: 300 });
  assert.equal(lines.filter((l) => l.account === "wallet").length, 1, "one till line");
  assert.equal(lines.filter((l) => l.account === "payable_supplier").length, 1, "one debt line");
  assert.equal(lines.find((l) => l.account === "wallet").amount, -300);
  assert.equal(lines.find((l) => l.account === "payable_supplier").amount, -300);
});

// ── the command's shape ─────────────────────────────────────────────────────

test("the ledger is written before the invoice documents", () => {
  // The balance is `payable_supplier`; `remainingAmount` is its per-invoice
  // breakdown. A failure after the money moved is stale, not wrong. The other
  // order would mark invoices paid with no money behind them.
  const src = read("../src/lib/supplierPaymentCommand.ts");
  const ledgerAt = src.indexOf("const eventId = await appendEvent");
  const docsAt = src.indexOf("recordSupplierPayment(");
  assert.ok(ledgerAt > 0 && docsAt > 0);
  assert.ok(ledgerAt < docsAt, "the money must be recorded first");
  assert.match(src, /staleInvoices\.push/, "a failed document update must be reported");
});

test("the payment carries an auditable reference allocated by Postgres", () => {
  const src = read("../src/lib/supplierPaymentCommand.ts");
  assert.match(src, /nextDocumentNumber\("supplier_payment", "SP-"\)/);
  assert.match(src, /refId: paymentRef/, "so the movement can be pointed at");
});

test("the settlement is behind a submit gate", () => {
  const src = read("../src/components/purchasing/PurchasingPage.tsx");
  assert.match(src, /const payGate = useSubmitGate\(\)/);
  assert.match(src, /payGate\.enter\(\)/, "a triple-click must create one payment");
  assert.match(src, /payGate\.exit\(\)/);
});

test("the supplier balance on screen comes from the ledger", () => {
  const src = read("../src/components/purchasing/PurchasingPage.tsx");
  assert.match(src, /const owed = debtOf\(selectedSupplier\.id\)/);
});
