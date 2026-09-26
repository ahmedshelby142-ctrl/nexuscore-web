/**
 * Desktop P1 closure — the defects this phase found and fixed.
 *
 *     node --test scripts/check_p1_closure.mjs
 *
 * G-14 (trader-return authorization) is pinned in `check_wholesale_return_txn`.
 * This file holds the rest: the P1-6 type hardening and the bugs it exposed,
 * and the failed-read / partial-commit sweep.
 *
 * Pure helpers are driven for real; screen wiring is asserted on
 * comment-stripped source, the house style (the screens import through `@/`).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

import { soldOnWholesaleInvoice, claimOrder, releaseOrder } from "../src/lib/orderLifecycle.ts";
import { returnedValue, discountFactor } from "../src/lib/exchange.ts";
import { rateFor } from "../src/lib/shippingRates.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const code = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
const src = (p) => code(read(p));

// ── A wholesale shipment is not a second sale ───────────────────────────────

test("an order whose lines point at a wholesale invoice was already sold", () => {
  assert.equal(soldOnWholesaleInvoice({ stockItems: [{ wholesaleInvoiceId: "inv-1" }] }), true);
  assert.equal(soldOnWholesaleInvoice({ stockItems: [{}, { wholesaleInvoiceId: "inv-1" }] }), true);
  assert.equal(soldOnWholesaleInvoice({ stockItems: [{}] }), false);
  assert.equal(soldOnWholesaleInvoice({ stockItems: [] }), false);
  assert.equal(soldOnWholesaleInvoice({ stockItems: null }), false);
  assert.equal(soldOnWholesaleInvoice({}), false);
});

test("delivering it books nothing — no second sale, no second invoice", () => {
  const s = src("../src/components/ecommerce/OrdersPage.tsx");
  const fn = s.slice(s.indexOf("const confirmDeliver = async"));
  const guard = fn.indexOf("if (soldOnWholesaleInvoice(order)) {");
  const firstEvent = fn.indexOf("await appendEvent(");
  const firstInvoice = fn.indexOf("addWholesaleInvoice(");
  assert.ok(guard > -1, "the delivery run of an invoiced sale is not recognised");
  assert.ok(guard < firstEvent && guard < firstInvoice, "the guard must come before any money or invoice is written");
  const branch = fn.slice(guard, fn.indexOf("return;", guard));
  assert.ok(!/appendEvent|addWholesaleInvoice/.test(branch), "the branch must move the document only");
  assert.match(branch, /updateOrderStatus\(reconcileDialog\.orderId, "delivered"\)/);
});

test("the Wholesale screen links its shipment to the invoice and keeps the address", () => {
  const s = src("../src/components/wholesale/WholesalePage.tsx");
  const call = s.slice(s.indexOf("const shipment = await useOrderStore.getState().addOrder({"));
  const body = call.slice(0, call.indexOf("});"));
  assert.match(body, /address: fullAddress,/, "`address` is the column");
  assert.ok(!/customerAddress/.test(body), "`customerAddress` is dropped by the sync whitelist — the address is lost");
  assert.match(body, /wholesaleClientId: client\.id,/);
  assert.match(body, /wholesaleInvoiceId: savedInvoice\.id,/, "each line must carry the invoice it was sold on");
  assert.match(body, /id: i\.id,/, "line ids must match the invoice's, or a return cannot key its ceiling");
  assert.match(s, /const savedInvoice = await addWholesaleInvoice\(\{/);
  assert.match(s, /if \(shipment\.success\) \{\s*toast\.success/, "a failed shipment must not be announced as created");
});

// ── An item added while editing is priced and costed ────────────────────────

test("an edited-in order line is priced with productPrice and costed from the ledger", () => {
  const s = src("../src/components/ecommerce/OrdersPage.tsx");
  const fn = s.slice(s.indexOf("const addItemToDraft ="), s.indexOf("const addItemToDraft =") + 1500);
  assert.match(fn, /unitPrice: productPrice\(product\),/);
  assert.match(fn, /unitCost: costOf\(product\.id\),/);
});

test("nothing reads a product field that does not exist", () => {
  // `Product` stays `any` (see src/types/index.ts), so TypeScript cannot catch
  // this class. The table has `unitPrice`, no `price`, and no `cost` at all.
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "mobile") walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(e.name)) continue;
      const s = src(path);
      // The OrdersPage bug read `product.price` / `product.cost`. Purchasing's
      // receipt draft still PREFILLS an editable, visible cost from
      // `product.cost ?? 0` — an input the operator types, not a hidden figure.
      for (const m of s.matchAll(/\b(product|prod)\.(price|cost)\b/g)) {
        if (path.endsWith("purchasing/PurchasingPage.tsx") && m[0] === "product.cost") continue;
        offenders.push(`${path}: ${m[0]}`);
      }
    }
  };
  walk("../src");
  assert.deepEqual(offenders, []);
});

// ── A reprinted courier statement lists its orders ─────────────────────────

test("a courier settlement reprint reads its orders from the ledger event", () => {
  const s = src("../src/components/ecommerce/CourierLedgerPage.tsx");
  assert.match(s, /printSettlement\.orderNumbers\.includes\(o\.orderNumber\)/);
  const all = readdirSync(new URL("../src/components/ecommerce", import.meta.url))
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => src(`../src/components/ecommerce/${f}`))
    .join("\n");
  assert.ok(!/codSettlementId/.test(all), "`codSettlementId` has no column; every write of it is dropped");
});

// ── The expense budget is asked before any money moves ──────────────────────

test("an expense is checked against its cap BEFORE the ledger event", () => {
  const s = src("../src/components/finance/PartnersFinancePage.tsx");
  const fn = s.slice(s.indexOf("const handleAddExpense = async"), s.indexOf("const handleAddPayroll = async"));
  const check = fn.indexOf("checkExpenseBudget(expenseForm.category, amount)");
  const event = fn.indexOf("await appendEvent(");
  assert.ok(check > -1 && check < event, "an over-cap expense would be paid, then 'refused'");
  const refusal = fn.slice(check, event);
  assert.match(refusal, /expenseGate\.exit\(\);\s*return;/, "a refusal must release the gate");
  // The catch that follows the DOCUMENT write specifically — the ledger write
  // above has its own catch of the same shape, which must not satisfy this.
  const afterDoc = fn.slice(fn.indexOf("await addExpense("));
  assert.match(
    afterDoc,
    /^await addExpense\(\{[\s\S]*?\}\);\s*\} catch \(e\) \{\s*setSpendError\([\s\S]{0,300}expenseGate\.exit\(\);\s*return;/,
    "a document failure after the ledger must be reported, not left unhandled",
  );
});

test("unknown spending is not 'within budget'", () => {
  const store = src("../src/store/useFinancialStore.ts");
  const fn = store.slice(store.indexOf("checkExpenseBudget: (category, amount) => {"));
  assert.match(fn.slice(0, 600), /if \(useSyncStatus\.getState\(\)\.tables\.expenses !== "ready"\) \{\s*return \{ ok: false, reason: "spending_unknown" \};/);
  const add = store.slice(store.indexOf("addExpense: async"), store.indexOf("removeExpense:"));
  assert.ok(!/over_budget|capAmount/.test(add), "the document write must not refuse after the money moved");
});

test("the owner's budget card does not show a failed read as a full budget", () => {
  const s = src("../src/components/finance/OwnerBudgetCard.tsx");
  assert.match(s, /moneyFigure\(status\.spent, spentRead\)/);
  assert.match(s, /moneyFigure\(status\.remaining, spentRead\)/);
  assert.match(s, /\{spentKnown && status\.level !== "ok" && \(/);
  assert.match(s, /ownerDraw && amount > 0 && spentKnown && after\.level !== "ok"/);
});

// ── P1-6: the types that replaced `any` are the schema's ────────────────────

const types = read("../src/types/index.ts");

test("the ledger's own types are re-exported, not shadowed as any", () => {
  for (const t of ["Account", "Balance", "BalanceQuery", "EventKind", "EventQuery", "Identity", "LedgerEvent", "NewEvent", "NewLine", "SyncStatus"]) {
    assert.ok(!new RegExp(`^export type ${t} = any;`, "m").test(types), `${t} is shadowed as any again`);
  }
  assert.match(types, /export type \{[\s\S]*?LedgerEvent,[\s\S]*?\} from "@\/lib\/ledger\/types";/);
});

test("the order status is exactly orders_status_check, and the lifecycle covers it", () => {
  assert.match(types, /export type EcommerceOrderStatus = "pending" \| "shipped" \| "delivered" \| "returned" \| "cancelled";/);
  const life = src("../src/lib/orderLifecycle.ts");
  const table = life.slice(life.indexOf("const ACTIONS_BY_STATUS"), life.indexOf("};", life.indexOf("const ACTIONS_BY_STATUS")));
  for (const s of ["pending", "shipped", "delivered", "returned", "cancelled"]) {
    assert.match(table, new RegExp(`\\b${s}:`), `the transition table has no entry for ${s}`);
  }
  // And driven: a delivered order cannot be delivered again.
  assert.equal(claimOrder("x", "delivered", "deliver"), "illegal");
  releaseOrder("x");
});

test("the any count only goes down", () => {
  const n = (types.match(/^export type [A-Za-z]+ = any;/gm) ?? []).length;
  assert.ok(n <= 45, `${n} any-typed domain types — it was 45 after P1-6; a new one needs a reason`);
});

test("a stored order's defaulted money fields are required, a new one's are not", () => {
  const order = types.slice(types.indexOf("export interface EcommerceOrder {"), types.indexOf("\n}", types.indexOf("export interface EcommerceOrder {")));
  for (const f of ["expectedCod: number;", "depositAmount: number;", "courierFee: number;", "paymentMethod: OrderPaymentMethod;"]) {
    assert.ok(order.includes(f), `stored orders always carry ${f.split(":")[0]} (NOT NULL DEFAULT)`);
  }
  assert.match(types, /export type NewEcommerceOrder = Omit<EcommerceOrder, DbDefaultedOrderField> &/);
});

// ── Helpers widened to what they already handled ────────────────────────────

test("nullable columns reach helpers that treat them as missing", () => {
  assert.equal(rateFor([{ governorate: "القاهرة", delivery: 50, return: 40 }], null, "delivery"), 0);
  assert.equal(discountFactor({}), 1, "no order selected values at list price");
  assert.equal(returnedValue({}, [{ productId: "p", quantity: 2, unitPrice: 10 }]), 20);
  const cust = src("../src/store/useCustomerStore.ts");
  assert.match(cust, /address: order\.address \?\? "",/, "customers.address is NOT NULL with no default");
});

// ── O-2: the committed tree is checked ──────────────────────────────────────

test("CI verifies the committed tree, without secrets", () => {
  const p = new URL("../.github/workflows/ci.yml", import.meta.url);
  assert.ok(existsSync(p), "no workflow checks what is committed");
  const ci = readFileSync(p, "utf8");
  for (const step of ["npm ci", "npx tsc --noEmit", "npm test", "npm run build"]) {
    assert.ok(ci.includes(step), `CI is missing: ${step}`);
  }
  assert.ok(!/secrets\.|SERVICE_ROLE/.test(ci.replace(/#.*$/gm, "")), "no secret may be handed to CI for the production project");
});
