/**
 * A wholesale return is one transaction, from the operator's point of view.
 *
 *     node --test scripts/check_wholesale_return_txn.mjs
 *
 * ## The bug this closes
 *
 * Since `dccf949`, three committed screens called
 * `useBusinessStore.getState().recordWholesaleReturn(...)` to credit the source
 * invoice — AFTER `commitWholesaleReturn` had already appended the ledger
 * event — and the method existed only in uncommitted work. On committed `main`
 * it threw a TypeError after the money had moved, and the screen's catch told
 * the operator «لم يُسجَّل المرتجع ولم يتغيّر أي رصيد». Even with the method
 * present, the call was `.catch(() => {})`: a refused invoice write left the
 * ledger saying one thing and the invoice «متبقي» another, silently.
 *
 * ## The fix under test
 *
 * The credit moved INSIDE the command, before the ledger event, so the event
 * is the last step and nothing that can fail runs after it. A refusal at any
 * step puts back every document already written and rethrows. The ordering and
 * the undo live in `wholesaleReturnTxn.ts`, which has no imports so it can be
 * driven here with a fake world — ledger, invoices, records — failure by
 * failure.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  runWholesaleReturn,
  invoiceCredits,
  WholesaleReturnUndoError,
} from "../src/lib/wholesaleReturnTxn.ts";
import {
  resolveWholesaleReturn,
  wholesaleLineKey,
  WHOLESALE_RETURN_TYPE,
} from "../src/lib/ledger/wholesale.ts";
import { claimOrder, releaseOrder } from "../src/lib/orderLifecycle.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const code = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");

// ── A fake world ────────────────────────────────────────────────────────────

/**
 * The three things a wholesale return writes. `failOn` names a step to refuse,
 * so each failure direction can be forced deterministically.
 */
function world({ invoices, failOn = new Set() } = {}) {
  const w = {
    ledger: [],
    invoices: new Map(Object.entries(invoices ?? { a: 1000, b: 1400 })),
    records: new Map(),
    order: [],
  };
  let nextId = 0;
  w.steps = (resolved) => ({
    writeRecords: async () => {
      w.order.push("records");
      if (failOn.has("records")) throw new Error("records refused");
      const ids = [];
      for (const invoiceId of new Set(resolved.lines.map((l) => l.invoiceId))) {
        const id = `r${++nextId}`;
        // The shape `writeReturnRecords` writes, reduced to what the ceiling reads.
        w.records.set(id, {
          type: WHOLESALE_RETURN_TYPE,
          original_order_id: invoiceId,
          returned_items: resolved.lines
            .filter((l) => l.invoiceId === invoiceId)
            .map((l) => ({ line_id: l.lineKey, product_id: l.productId, quantity: l.quantity })),
        });
        ids.push(id);
      }
      return ids;
    },
    deleteRecord: async (id) => {
      if (failOn.has("deleteRecord")) throw new Error("delete refused");
      w.records.delete(id);
    },
    creditInvoice: async (invoiceId, amount) => {
      w.order.push(`credit:${invoiceId}`);
      if (failOn.has(`credit:${invoiceId}`)) throw new Error(`invoice ${invoiceId} refused`);
      const before = w.invoices.get(invoiceId);
      w.invoices.set(invoiceId, Math.max(0, before - amount));
      return before;
    },
    restoreInvoice: async (invoiceId, remaining) => {
      if (failOn.has("restore")) throw new Error("restore refused");
      w.invoices.set(invoiceId, remaining);
    },
    appendLedger: async () => {
      w.order.push("ledger");
      if (failOn.has("ledger")) throw new Error("ledger refused");
      w.ledger.push({ kind: "return_confirmed" });
    },
  });
  return w;
}

// The §5 fixture from `check_wholesale_returns`: one product, two invoices,
// two prices.
const INV_A = {
  id: "a", invoiceNumber: "FJ-A", clientId: "trader", goodsTotal: 1000, discountAmount: 0,
  items: [{ id: "a1", productId: "X", productName: "منتج X", quantity: 10, wholesalePrice: 100, unitCost: 60 }],
};
const INV_B = {
  id: "b", invoiceNumber: "FJ-B", clientId: "trader", goodsTotal: 1400, discountAmount: 0,
  items: [{ id: "b1", productId: "X", productName: "منتج X", quantity: 10, wholesalePrice: 140, unitCost: 90 }],
};
const resolve = (requests, priorReturns = []) =>
  resolveWholesaleReturn({ clientId: "trader", requests, invoices: [INV_A, INV_B], priorReturns, costOf: () => 999 });

/** The resolver's key for an invoice's only line — `wholesaleLineKey`, the same one it uses. */
const keyFor = (invoiceId) => wholesaleLineKey((invoiceId === "a" ? INV_A : INV_B).items[0]);

/** 3 units off FJ-A (at 100) and 2 off FJ-B (at 140). */
const twoInvoiceReturn = (priorReturns = []) =>
  resolve(
    [
      { invoiceId: "a", lineKey: keyFor("a"), quantity: 3 },
      { invoiceId: "b", lineKey: keyFor("b"), quantity: 2 },
    ],
    priorReturns,
  );

// ── 1–3 · success ───────────────────────────────────────────────────────────

test("a return writes records, credits each invoice, then the ledger — in that order", async () => {
  const resolved = twoInvoiceReturn();
  const w = world();
  await runWholesaleReturn(invoiceCredits(resolved.lines), w.steps(resolved));
  assert.deepEqual(w.order, ["records", "credit:a", "credit:b", "ledger"]);
  assert.ok(
    w.order.indexOf("ledger") === w.order.length - 1,
    "the ledger event must be the LAST step — nothing that can fail may follow an append-only write",
  );
});

test("the ledger moves exactly once", async () => {
  const resolved = twoInvoiceReturn();
  const w = world();
  await runWholesaleReturn(invoiceCredits(resolved.lines), w.steps(resolved));
  assert.equal(w.ledger.length, 1);
});

test("each invoice's open balance drops by what came back from IT, at the price paid", async () => {
  const resolved = twoInvoiceReturn();
  assert.deepEqual(invoiceCredits(resolved.lines), [
    { invoiceId: "a", amount: 300 },
    { invoiceId: "b", amount: 280 },
  ]);
  const w = world();
  await runWholesaleReturn(invoiceCredits(resolved.lines), w.steps(resolved));
  assert.equal(w.invoices.get("a"), 700);
  assert.equal(w.invoices.get("b"), 1120);
});

// ── 4 · rapid resubmission ──────────────────────────────────────────────────

test("a second submission of the same goods is refused by the ceiling the first one wrote", async () => {
  // Every screen gates the click (below). This is the case the gate cannot
  // see — a second tab, a second device — and it must still be refused.
  const w = world();
  const all = resolve([{ invoiceId: "a", lineKey: keyFor("a"), quantity: 10 }]);
  await runWholesaleReturn(invoiceCredits(all.lines), w.steps(all));
  assert.throws(
    () => resolve([{ invoiceId: "a", lineKey: keyFor("a"), quantity: 1 }], [...w.records.values()]),
    "the same units must not come back twice",
  );
  assert.equal(w.ledger.length, 1);
  assert.equal(w.invoices.get("a"), 0);
});

test("a double click is stopped before the command runs twice", () => {
  const screens = [
    ["../src/components/wholesale/WholesalePage.tsx", "if (!returnGate.enter()) return;"],
    ["../src/components/sales/CheckoutForm.tsx", "if (!gate.enter()) return;"],
    ["../src/components/ecommerce/OrdersPage.tsx", 'claimOrder(order.id, order.status, "confirmReturn")'],
  ];
  for (const [file, guard] of screens) {
    const s = code(read(file));
    const g = s.indexOf(guard);
    const c = s.indexOf("await commitWholesaleReturn(", g);
    assert.ok(g > -1 && c > g, `${file}: the command must run behind ${guard}`);
  }
  // And the order claim, driven: the second claim of the same order is busy.
  assert.equal(claimOrder("ord-1", "returned", "confirmReturn"), "ok");
  assert.equal(claimOrder("ord-1", "returned", "confirmReturn"), "busy");
  releaseOrder("ord-1");
});

// ── 5 · failure: every document undone, no orphan ledger movement ───────────

test("a refused ledger event leaves NOTHING behind", async () => {
  const resolved = twoInvoiceReturn();
  const w = world({ failOn: new Set(["ledger"]) });
  await assert.rejects(runWholesaleReturn(invoiceCredits(resolved.lines), w.steps(resolved)), /ledger refused/);
  assert.equal(w.ledger.length, 0, "no money moved");
  assert.equal(w.invoices.get("a"), 1000, "invoice A put back exactly");
  assert.equal(w.invoices.get("b"), 1400, "invoice B put back exactly");
  assert.equal(w.records.size, 0, "the ceiling put back — the goods are returnable again");
});

test("a refused invoice credit stops the return BEFORE any money moves", async () => {
  const resolved = twoInvoiceReturn();
  const w = world({ failOn: new Set(["credit:b"]) });
  await assert.rejects(runWholesaleReturn(invoiceCredits(resolved.lines), w.steps(resolved)), /invoice b refused/);
  assert.ok(!w.order.includes("ledger"), "the ledger must not even be attempted");
  assert.equal(w.ledger.length, 0);
  assert.equal(w.invoices.get("a"), 1000, "the invoice credited before the refusal is put back");
  assert.equal(w.records.size, 0);
});

test("the undo restores the exact balance, even where the credit clamped at zero", async () => {
  // 300 open, 1000 returned: the credit clamps to 0. Adding 1000 back would
  // leave 1000 open; the undo must restore 300.
  const resolved = resolve([{ invoiceId: "a", lineKey: keyFor("a"), quantity: 10 }]);
  const w = world({ invoices: { a: 300, b: 1400 }, failOn: new Set(["ledger"]) });
  await assert.rejects(runWholesaleReturn(invoiceCredits(resolved.lines), w.steps(resolved)));
  assert.equal(w.invoices.get("a"), 300);
});

test("a failed undo is reported, never folded into success or a plain error", async () => {
  const resolved = twoInvoiceReturn();
  const w = world({ failOn: new Set(["ledger", "restore"]) });
  const err = await runWholesaleReturn(invoiceCredits(resolved.lines), w.steps(resolved)).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof WholesaleReturnUndoError, "the operator must be told something was left behind");
  assert.match(err.message, /ledger refused/, "and why the return failed in the first place");
  assert.equal(err.leftBehind.length, 2, "both invoices named");
  assert.equal(w.ledger.length, 0, "still no orphan money");
});

test("a refused record write moves nothing at all", async () => {
  const resolved = twoInvoiceReturn();
  const w = world({ failOn: new Set(["records"]) });
  await assert.rejects(runWholesaleReturn(invoiceCredits(resolved.lines), w.steps(resolved)), /records refused/);
  assert.deepEqual(w.order, ["records"]);
  assert.equal(w.invoices.get("a"), 1000);
});

// ── The committed code path ─────────────────────────────────────────────────

const store = code(read("../src/store/useBusinessStore.ts"));
const cmd = code(read("../src/lib/wholesaleReturnDoc.ts"));

test("the store method the screens used to call now exists in committed code", () => {
  assert.match(store, /recordWholesaleReturn: \(invoiceId: string, amount: number\) => Promise<number>;/);
  assert.match(store, /restoreWholesaleInvoiceRemaining: \(invoiceId: string, remaining: number\) => Promise<void>;/);
  const body = store.slice(store.indexOf("recordWholesaleReturn: async"), store.indexOf("restoreWholesaleInvoiceRemaining: async"));
  assert.match(body, /if \(!invoice\) throw new Error/, "a credit that silently did nothing is the original bug");
  assert.match(body, /return before;/, "the undo needs the balance it replaced");
  assert.doesNotMatch(body, /paidAmount/, "a return is not a payment");
});

test("the command runs the credit inside the transaction, through the real store", () => {
  assert.match(cmd, /await runWholesaleReturn\(invoiceCredits\(resolved\.lines\), \{/);
  assert.match(cmd, /creditInvoice: \(invoiceId, amount\) => store\(\)\.recordWholesaleReturn\(invoiceId, amount\)/);
  assert.match(cmd, /restoreWholesaleInvoiceRemaining\(invoiceId, remaining\)/);
  assert.match(cmd, /appendLedger,/);
});

test("no screen credits an invoice after the ledger, or swallows the failure", () => {
  for (const file of [
    "../src/components/wholesale/WholesalePage.tsx",
    "../src/components/sales/CheckoutForm.tsx",
    "../src/components/ecommerce/OrdersPage.tsx",
  ]) {
    const s = code(read(file));
    assert.ok(!/\.recordWholesaleReturn\(/.test(s), `${file}: the post-ledger credit is back`);
    assert.match(s, /await commitWholesaleReturn\(/);
  }
});

test("a failed order-status write after a completed return is not reported as 'nothing changed'", () => {
  const s = code(read("../src/components/ecommerce/OrdersPage.tsx"));
  const at = s.indexOf('await updateOrderStatus(order.id, "returned");');
  const block = s.slice(s.lastIndexOf("try {", at), s.indexOf("refreshStock();", at));
  assert.match(block, /catch \(e\) \{\s*setActionError\(\s*`المرتجع اتسجّل/, "the money and invoice moved; say so");
});

// ── 6 · the retail POS return/exchange path is untouched ────────────────────

test("the retail return and exchange path does not go through the wholesale command", () => {
  const s = code(read("../src/components/sales/CheckoutForm.tsx"));
  // The retail branch (negative cart lines) records a `pos_…` return record
  // and never names an invoice.
  assert.match(s, /original_order_id: `pos_\$\{Date\.now\(\)\}`/);
  const retail = s.slice(s.indexOf("const negativeItems = cart.filter"));
  assert.ok(!/commitWholesaleReturn|recordWholesaleReturn/.test(retail.slice(0, 3000)));
});
