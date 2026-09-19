/**
 * The five M2 blockers, each pinned so it cannot come back.
 *
 * Every test here corresponds to a defect that was reproduced in an
 * authenticated session against the live QA store — not to a hypothetical.
 * Where a defect was a shape rather than a value (a hook below a return, a
 * column that does not exist), the guard is source-level, because that is the
 * only level at which the shape is visible.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const capabilities = read("../src/mobile/navigation/mobileCapabilities.ts");
const readers = read("../src/mobile/data/mobileReaders.ts");
const shipmentVm = read("../src/mobile/viewmodels/shipmentViewModel.ts");
const customerDetails = read("../src/mobile/screens/MobileCustomerDetails.tsx");
const restock = read("../src/mobile/screens/MobileQuickRestock.tsx");
const shortages = read("../src/mobile/screens/MobileShortagesScreen.tsx");
const router = read("../src/mobile/router.tsx");
const product = read("../src/lib/product.ts");

// ── F1: the shell-wide render loop ──────────────────────────────────────────

test("F1: capabilities are one Set per role, not a new Set per render", () => {
  // `getMobileCapabilities` is called during render by the home screen and by
  // `useAlertBadges`, which the bottom nav mounts on EVERY screen. A fresh Set
  // each time gave `useMobileHomeData`'s useCallback a new identity every
  // render, so its effect re-fired forever: ~900 "Maximum update depth
  // exceeded" errors in seconds and a restock screen that stopped taking taps.
  assert.match(capabilities, /CAPABILITIES_BY_ROLE/, "must memoise by role");
  assert.match(
    capabilities,
    /const cached = CAPABILITIES_BY_ROLE\.get\(role\);\s*\r?\n\s*if \(cached\) return cached;/,
    "and must return the cached Set before building a new one",
  );
});

// ── F2: columns that do not exist on `orders` ───────────────────────────────

const PHANTOM_COLUMNS = ["shippedAt", "deliveredAt", "returnedAt", "cancelledAt"];

test("F2: no mobile reader selects a column `orders` does not have", () => {
  // The live table has: createdAt, updatedAt, codSettledAt, returnConfirmedAt,
  // returnType, isExchange, expectedCod, courierId, courierName … and none of
  // the four below. Selecting one 400s the WHOLE request — the order timeline
  // rendered "column orders.shippedAt does not exist" on every order.
  for (const column of PHANTOM_COLUMNS) {
    assert.doesNotMatch(
      readers,
      new RegExp(`\\.select\\([^)]*\\b${column}\\b`, "s"),
      `mobileReaders must not select orders.${column}`,
    );
    assert.doesNotMatch(
      shipmentVm,
      new RegExp(`order\\?\\.${column}\\b`),
      `the shipment view model must not read orders.${column}`,
    );
  }
});

test("F2: the order timeline is read from the ledger, the only place it exists", () => {
  assert.match(readers, /refType: "ecommerce_order"/, "the ledger ref type the order writers stamp");
  assert.match(readers, /ledgerEvents\(/, "must go through the shared ledger reader");
  assert.match(readers, /order_delivered/, "delivered is an event, not a column");
  assert.match(readers, /rto_confirmed/, "so is a refused delivery");
});

test("F2: shipment COD comes from expectedCod, the desktop authority", () => {
  assert.match(shipmentVm, /order\?\.expectedCod/, "must read the real column");
  assert.doesNotMatch(
    shipmentVm,
    /order\?\.cod\b|order\?\.codAmount/,
    "`cod` and `codAmount` are not columns; reading them made every بدل zero",
  );
});

// ── F3: hooks below a conditional return ────────────────────────────────────

test("F3: no mobile screen calls a hook after an early return", () => {
  // `MobileCustomerDetails` called useMemo below three early returns: 21 hooks
  // on the loading render, 22 on the loaded one, and React tore the screen
  // down into the error boundary every single time.
  const screens = [
    ["MobileCustomerDetails", customerDetails],
    ["MobileQuickRestock", restock],
    ["MobileShortagesScreen", shortages],
  ];
  for (const [name, src] of screens) {
    const firstReturn = src.search(/\n {2}if \([^\n]*\) return /);
    if (firstReturn === -1) continue;
    const tail = src.slice(firstReturn);
    for (const hook of ["useMemo(", "useState(", "useEffect(", "useCallback(", "useRef("]) {
      assert.ok(
        !tail.includes(hook),
        `${name} calls ${hook} after a conditional return — hook order is not stable`,
      );
    }
  }
});

// ── F4: the draft list is not the submit list ───────────────────────────────

test("F4: restock renders draft rows and submits the filtered ones", () => {
  // Rendering from `received` — which drops quantity <= 0 — meant a freshly
  // picked product was filtered out before the quantity input that would have
  // lifted it above zero could be drawn. Nothing could ever be received.
  assert.match(restock, /const draftRows =/, "there must be a draft list");
  assert.match(restock, /draftRows\.map\(/, "and the rows must render from it");
  assert.match(
    restock,
    /const received: QuickRestockLineInput\[\] = draftRows\s*\r?\n?\s*\.filter\(\(r\) => r\.quantity > 0\)/,
    "while the submit list stays the filtered one",
  );
  assert.doesNotMatch(restock, /\{received\.map\(/, "the render must not go back through the filter");
});

test("F4: no Radix Select item carries an empty value", () => {
  // Radix throws on `value=""`: the placeholder is what shows an empty
  // selection. This would have crashed the supplier picker the moment a line
  // rendered — which, thanks to the bug above, it never did.
  assert.doesNotMatch(restock, /<SelectItem value=""/, "Radix refuses an empty item value");
});

test("F4: receiving still goes through the one shared command", () => {
  assert.match(restock, /executeQuickRestock\(/, "no mobile-specific receipt path");
  assert.doesNotMatch(restock, /appendEvent\(/, "and no ledger write of its own");
  assert.doesNotMatch(restock, /"FM-" \+/, "and no invoice numbering of its own");
  assert.match(restock, /gate\.enter\(\)/, "the submit gate is what makes a triple-tap one receipt");
});

// ── F5: the shortages screen ────────────────────────────────────────────────

test("F5: /inventory/shortages is its own screen on the real RPC", () => {
  assert.match(
    router,
    /path="inventory\/shortages" element=\{<MobileShortagesScreen \/>\}/,
    "must not route back to the generic stock list",
  );
  assert.match(shortages, /readMobileShortages\(\)/, "and must read the authoritative aggregate");
  // required, stock, deficit, order_count and waiting_orders all come from the
  // RPC. Nothing here may recompute the deficit.
  assert.match(shortages, /row\.deficit/);
  assert.match(shortages, /row\.required/);
  assert.match(shortages, /row\.stock/);
  assert.match(shortages, /row\.order_count/);
  assert.match(shortages, /waiting_orders/);
  // Comments stripped: the prose explains that the screen depends on no flag,
  // and would otherwise trip the very assertion that checks it does not.
  const code = shortages.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(
    code,
    /required\s*-\s*stock|required\s*-\s*Number/,
    "the deficit is the database's answer, not a second subtraction",
  );
  assert.doesNotMatch(code, /shortfall|backorder/, "and depends on no flag");
});

// ── Secondary: S2, S3, S4, S5, S6 ───────────────────────────────────────────

test("S2: mobile never shows a negative shelf, exactly as desktop floors it", () => {
  assert.match(readers, /Math\.max\(0, stockBalance\.qty\)/, "the ledger sum is floored on read");
});

test("S3: the variant clamp has one definition, used by both surfaces", () => {
  assert.match(product, /export function variantStockFrom\(/, "the shared rule");
  assert.match(readers, /variantStockFrom\(/, "mobile uses it");
  assert.match(product, /return variantStockFrom\(product, variantName, getActualStock\(product\)\)/, "desktop uses it");
});

test("S4: every paged reader excludes soft-deleted rows", () => {
  assert.match(
    readers,
    /\.select\("\*", \{ count: "exact" \}\)\.is\("deleted_at", null\)/,
    "the one paging choke point must filter tombstones",
  );
});

test("S5: load-more is decided by the exact count, not by a full page", () => {
  assert.doesNotMatch(
    readers,
    /hasMore: rows\.length === pageSize/,
    "a total that is an exact multiple of the page size is not 'more'",
  );
  assert.match(readers, /from \+ rows\.length < total/, "the count already knows");
});

test("S6: courier identity is the registry id, never the typed label alone", () => {
  assert.match(readers, /export async function readMobileCouriers/, "mobile must read the registry");
  assert.match(readers, /\.from\("couriers"\)/, "the same table desktop writes");
  assert.match(shipmentVm, /LEGACY_COURIER_ID = "default"/, "the legacy bucket is not a company");
  assert.match(shipmentVm, /courierIsLegacy/, "and a row it cannot resolve must say so");
});

// ── The shortage semantic itself, as arithmetic ─────────────────────────────

test("the shortage deficit is required minus ledger stock, with no flag", () => {
  // This mirrors the SQL in `mobile_shortages`:
  //   deficit = required - COALESCE(stock, 0), kept when > 0.
  // An ordinary pending order for 3 against a shelf holding 1 is a shortage of
  // 2 — no `shortfall` and no `backorder` needs to have been ticked.
  const deficitOf = (required, stock) => required - (stock ?? 0);
  const isShortage = (required, stock) => deficitOf(required, stock) > 0;

  assert.equal(deficitOf(3, 1), 2);
  assert.equal(isShortage(3, 1), true);
  assert.equal(deficitOf(3, null), 3, "a product with no ledger line at all is short by the whole demand");
  assert.equal(isShortage(1, 1), false, "exactly covered is not short");
  assert.equal(isShortage(1, 5), false);
});

test("buildable boxes bind on the scarcest component, variant included", () => {
  // The بوكس العناية case from the live database: three components pinned to a
  // درجة, one not. Mobile used to ignore the pin and read the product total.
  const buildable = (recipe, onHand) =>
    recipe.reduce((least, c) => Math.min(least, Math.floor(onHand(c.productId, c.variantName) / c.quantity)), Infinity);

  const clamp = (variantStock, productTotal) => Math.min(variantStock, productTotal);

  const recipe = [
    { productId: "fondation", quantity: 1, variantName: "احمر" },
    { productId: "contor", quantity: 1, variantName: "نود" },
    { productId: "eyeshadow", quantity: 1 },
  ];
  const variantAware = (id, variant) => {
    const totals = { fondation: 48, contor: 79, eyeshadow: 60 };
    const variants = { "fondation:احمر": 28, "contor:نود": 29 };
    return variant ? clamp(variants[`${id}:${variant}`], totals[id]) : totals[id];
  };
  const variantBlind = (id) => ({ fondation: 48, contor: 79, eyeshadow: 60 })[id];

  assert.equal(buildable(recipe, variantAware), 28, "the red fondation is the binding constraint");
  assert.equal(buildable(recipe, variantBlind), 48, "ignoring the pin overstates it — this was the defect");
});

// ── Receiving safety, as the forced failure actually behaved ────────────────

test("the ledger attempts no delete it is not allowed to make", () => {
  // `no_delete_ledger_events` is `USING (false)`. The compensating delete that
  // used to sit in `driver.append` matched zero rows, returned 204, and had
  // its result discarded — safety theatre. Forcing a `ledger_lines` failure
  // against the live QA store left the header behind, and it was the only
  // line-less `purchase` event in the database.
  const driver = readFileSync(new URL("../src/lib/ledger/driver.ts", import.meta.url), "utf8")
    // Comments stripped: the note left in the driver quotes the deleted line
    // to explain why it is gone, and would otherwise trip this very check.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(
    driver,
    /from\("ledger_events"\)\s*\.delete\(\)/,
    "the ledger is append-only; a delete against it can only ever be a no-op",
  );
});

test("a failed receipt takes its DOCUMENT back, which is the part that can be taken back", () => {
  // `purchase_invoices` has no such prohibition, so `removePurchaseInvoice`
  // genuinely undoes it — verified: after the forced failure the invoice count
  // was unchanged and no payable was left standing.
  const commit = readFileSync(new URL("../src/lib/receiving/commitReceipt.ts", import.meta.url), "utf8");
  assert.match(commit, /removePurchaseInvoice\(invoice\.id\)/);
  assert.match(commit, /لم يُسجَّل التوريد ولم يتغيّر أي رصيد/, "and says so in the user's language");
});

// ── The primary action must not sit under the bottom navigation ─────────────

test("a screen's pinned action bar clears the fixed bottom nav", () => {
  // Found by a REAL coordinate tap, not by a dispatched one. The restock
  // footer was Tailwind's `sticky bottom-0` with no z-index, while
  // `.mobile-bottom-nav` is `position: fixed; z-index: 20` pinned to the same
  // edge. `document.elementFromPoint` across the full width of تسجيل التوريد
  // returned المزيد / المخزون / الطلبات at EVERY sample: the primary action of
  // the receiving screen was 100% un-tappable on a phone.
  //
  // Every automated check before this drove the button with `element.click()`,
  // which dispatches straight at the node and skips hit testing — so the whole
  // suite passed while no operator could ever have recorded a receipt.
  const css = readFileSync(new URL("../src/mobile/mobile.css", import.meta.url), "utf8");

  assert.ok(
    !/className="sticky bottom-0/.test(restock),
    "a raw `sticky bottom-0` lands underneath the fixed nav",
  );
  assert.match(restock, /className="mobile-sticky-actions"/, "use the class that clears the nav");

  const bar = css.slice(css.indexOf(".mobile-sticky-actions {"));
  const rule = bar.slice(0, bar.indexOf("}") + 1);
  // Lifted clear of the nav rather than merely stacked over it.
  assert.match(
    rule,
    /inset-block-end: calc\(68px \+ env\(safe-area-inset-bottom\)\)/,
    "the bar must sit above the nav's own height",
  );
  // And if a future safe-area change ever makes them touch, the ACTION wins.
  const navZ = Number(/\.mobile-bottom-nav \{[^}]*z-index:\s*(\d+)/s.exec(css)?.[1]);
  const barZ = Number(/z-index:\s*(\d+)/.exec(rule)?.[1]);
  assert.ok(Number.isFinite(navZ) && Number.isFinite(barZ), "both need an explicit z-index");
  assert.ok(barZ > navZ, `action bar (${barZ}) must outrank the nav (${navZ})`);
});

// ── M2.2: cash / partial / credit are ONE command with three inputs ─────────

test("M2.2: mobile forwards paidAmount instead of hardcoding paid-in-full", () => {
  // `buildPurchaseLines` has always split a receipt:
  //     paid > 0  →  wallet −paid
  //     owed > 0  →  payable_supplier +owed
  // Quick restock hardcoded `Number.POSITIVE_INFINITY`, which made the آجل
  // half unreachable from mobile even though the ledger supported it. The fix
  // is a forwarded number, NOT a second accounting path.
  const command = readFileSync(new URL("../src/lib/receiving/command.ts", import.meta.url), "utf8");
  assert.match(command, /paidAmount\?: number/, "the command must accept it");
  assert.match(
    command,
    /paidAmount: input\.paidAmount \?\? Number\.POSITIVE_INFINITY/,
    "forwarded, with paid-in-full as the default",
  );
  // Still no mobile-side accounting.
  assert.match(restock, /executeQuickRestock\(/);
  assert.doesNotMatch(restock, /payable_supplier/, "mobile must not name ledger accounts");
  assert.doesNotMatch(restock, /buildPurchaseLines/, "nor build ledger lines");
  assert.doesNotMatch(restock, /appendEvent\(/, "nor append events");
});

test("M2.2: the paid field means the same thing on mobile as on desktop", () => {
  // One expression, copied deliberately, so "paid" cannot drift between the
  // two screens that both write `purchase_invoices`.
  const desktop = readFileSync(
    new URL("../src/components/purchasing/PurchasingPage.tsx", import.meta.url),
    "utf8",
  );
  const shape = /paidInput\.trim\(\) === "" \? total : Math\.min\(Math\.max\(0, Number\(paidInput\) \|\| 0\), total\)/;
  assert.match(desktop, shape, "desktop's definition");
  assert.match(restock, shape, "and mobile's, character for character");
});

test("M2.2: a fully unpaid receipt is not labelled 'partial'", () => {
  // `owed > 0 ? "آجل جزئي" : "نقدي"` calls a receipt with NOTHING paid
  // "partially on credit", and that note is what shows on the supplier's
  // account later. Three states need three labels.
  assert.match(restock, /آجل بالكامل/, "paid = 0 is fully on credit");
  assert.match(restock, /آجل جزئي/, "0 < paid < total is partial");
  assert.match(restock, /دفع نقدي/, "paid = total is cash");
  assert.match(
    restock,
    /paidAmount <= 0\s*\r?\n?\s*\?\s*"توريد سريع من تطبيق الموبايل \(آجل بالكامل\)"/,
    "and the full-credit case must be keyed on paidAmount, not on owed",
  );
});

test("M2.2: an آجل figure is shown only when there IS a debt", () => {
  // A permanent "المتبقي آجل: ٠" is a financial zero that means nothing —
  // the same rule `alertModel` applies to alerts.
  assert.match(restock, /\{owedAmount > 0 && \(/, "the debt line is conditional");
});
