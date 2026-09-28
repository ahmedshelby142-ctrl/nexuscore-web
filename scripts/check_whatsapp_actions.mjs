/**
 * واتساب actions + Mobile money formatting.
 *
 *     node --test scripts/check_whatsapp_actions.mjs
 *
 * WhatsApp: NEXUS drafts, `wa.me` opens, a human presses Send. The core is pure
 * (`src/lib/whatsapp.ts`) and tested as such; the screens are pinned to it.
 *
 * Money: `formatArabicCurrency` shows no «٫٠٠» on whole amounts, keeps real
 * piastres, and says «غير مسجل» for a missing amount — never a zero.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) return next(new URL(`src/${specifier.slice(2)}.ts`, root).href, context);
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const wa = await import(new URL("src/lib/whatsapp.ts", root).href);
const { formatArabicCurrency } = await import(new URL("src/mobile/viewmodels/formatters.ts", root).href);
const { equityStatement } = await import(new URL("src/lib/ledger/equity.ts", root).href);

const ok = (n) => ({ status: "ok", number: n });

// ═══ Phone → WhatsApp target ════════════════════════════════════════════════

test("1 · Egyptian local mobiles become 20…", () => {
  for (const p of ["01012345678", "01112345678", "01212345678", "01512345678"]) {
    assert.deepEqual(wa.whatsAppTarget(p), ok(`20${p.slice(1)}`), p);
  }
  assert.deepEqual(wa.whatsAppTarget("0101 234 5678"), ok("201012345678"), "separators");
  assert.deepEqual(wa.whatsAppTarget("٠١٠١٢٣٤٥٦٧٨"), ok("201012345678"), "Arabic-Indic digits");
});

test("2 · already-international numbers are kept, never re-prefixed", () => {
  for (const p of ["+201012345678", "201012345678", "00201012345678", "+20 101 234 5678"]) {
    assert.deepEqual(wa.whatsAppTarget(p), ok("201012345678"), p);
  }
  assert.deepEqual(wa.whatsAppTarget("+20 0101 234 5678"), ok("201012345678"), "trunk 0 kept after +20 — unambiguous");
  assert.deepEqual(wa.whatsAppTarget("+966 51 234 5678"), ok("966512345678"), "not every supplier is Egyptian");
  assert.deepEqual(wa.whatsAppTarget("+1 415 555 2671"), ok("14155552671"));
});

test("3 · a number that cannot be opened with confidence is refused, not corrected", () => {
  for (const p of [
    "1012345678", // Egyptian mobile without its 0 — would otherwise be a US number
    "0223456789", // Cairo landline — no WhatsApp
    "0101234567", // one digit short
    "010123456789", // one digit long
    "01312345678", // no such Egyptian mobile prefix
    "123",
    "not-a-phone",
  ]) {
    assert.deepEqual(wa.whatsAppTarget(p), { status: "invalid" }, p);
  }
});

test("9/10 · no stored phone is «missing», for customers and suppliers alike", () => {
  for (const p of [undefined, null, "", "   "]) assert.deepEqual(wa.whatsAppTarget(p), { status: "missing" }, String(p));
  const component = code(read("src/mobile/components/WhatsAppAction.tsx"));
  // Missing and invalid return BEFORE the link: there is no dead button.
  const link = component.indexOf("<a");
  for (const [state, re] of [
    ["missing", /if \(target\.status === "missing"\) \{\s*return/],
    ["invalid", /if \(target\.status === "invalid"\) \{\s*return/],
  ]) {
    const at = component.search(re);
    assert.ok(at > -1 && at < link, `${state} returns before the link`);
  }
  assert.match(component, /رقم واتساب غير مسجل/);
  assert.match(component, /مش صالح لواتساب — صحّحه \{fixWhere\}/);
  assert.match(component, /href=\{whatsAppUrl\(target\.number, message\)\}/, "only the confirmed number is linked");
});

// ═══ URL + encoding ═════════════════════════════════════════════════════════

test("4/8 · the URL is wa.me + number + encoded text, and the text survives the round trip", () => {
  const message = "السلام عليكم المرادي،\nمحتاجين توريد المنتج:\n- شنطة (كبير) — الكمية: ١٢\nمن فضلك أكد التوفر والسعر & شكراً؟ #1";
  const url = wa.whatsAppUrl("201012345678", message);
  assert.ok(url.startsWith("https://wa.me/201012345678?text="));
  assert.match(url, /^[\x21-\x7e]+$/, "no raw Arabic, space or line break in the URL");
  assert.equal(decodeURIComponent(url.slice(url.indexOf("text=") + 5)), message);
  assert.ok(!url.slice(url.indexOf("text=") + 5).includes("&"), "an & in the message cannot end the parameter");
});

// ═══ Messages ═══════════════════════════════════════════════════════════════

test("5 · customer message: their name, the shop's name, nothing invented", () => {
  assert.equal(wa.customerMessage({ customerName: "محمد", storeName: "رديانت" }), "أهلاً محمد،\nمعاك من رديانت.");
  assert.equal(wa.customerMessage({ customerName: "محمد", storeName: null }), "أهلاً محمد،", "no store line without a store name");
  assert.equal(wa.customerMessage({ customerName: "  ", storeName: "" }), "أهلاً،");
});

test("6 · supplier message is the trade greeting, not the customer one", () => {
  const s = wa.supplierMessage({ supplierName: "المرادي", storeName: "رديانت" });
  assert.equal(s, "السلام عليكم المرادي،\nمعاك من رديانت.");
  assert.notEqual(s, wa.customerMessage({ customerName: "المرادي", storeName: "رديانت" }));
});

test("7/11 · restock request lists each product with its real quantity and درجة", () => {
  const m = wa.restockRequestMessage({
    supplierName: "المرادي",
    storeName: "رديانت",
    items: [
      { name: "شنطة جلد", variant: "كبير", quantity: 12 },
      { name: "محفظة", variant: null, quantity: null }, // nothing known — no quantity line
      { name: "كارت", quantity: 0 }, // a zero is not a request
      { name: "حزام", quantity: 2.5 },
    ],
  });
  assert.equal(
    m,
    [
      "السلام عليكم المرادي،",
      "معاك من رديانت.",
      "محتاجين توريد المنتجات دي:",
      "- شنطة جلد (كبير) — الكمية: ١٢",
      "- محفظة",
      "- كارت",
      "- حزام — الكمية: ٢٫٥",
      "من فضلك أكد التوفر والسعر.",
      "شكراً.",
    ].join("\n"),
  );
  assert.match(wa.restockRequestMessage({ items: [{ name: "شنطة", quantity: 3 }] }), /^السلام عليكم،\nمحتاجين توريد المنتج:\n- شنطة — الكمية: ٣\n/);
});

test("11 · the quantity comes from the screen: typed, else the shortage deficit, else none", () => {
  assert.deepEqual([...wa.parseRestockNeed("p-1:3,p-2:0,p-3:x,:4,p-4:-1,p-5:2.5")], [["p-1", 3], ["p-5", 2.5]]);
  assert.equal(wa.parseRestockNeed(null).size, 0);
  const shortages = code(read("src/mobile/screens/MobileShortagesScreen.tsx"));
  assert.match(shortages, /&need=\$\{encodeURIComponent\(`\$\{row\.product_id\}:\$\{Number\(row\.deficit\)\}`\)\}/, "the deficit mobile_shortages returned");
  const restock = code(read("src/mobile/screens/MobileQuickRestock.tsx"));
  assert.match(restock, /name: String\(r\.product\.name \?\? ""\),\s*variant: r\.draft\.variantName,\s*quantity: r\.quantity > 0 \? r\.quantity : \(need\.get\(r\.id\) \?\? null\),/);
  assert.match(restock, /phone=\{registeringNew \? newSupplierPhone : chosenSupplier\?\.phone\}/, "the chosen supplier's own number");
});

test("12 · nothing fake: no placeholder store, no invented price, the only destination is wa.me", () => {
  const lib = code(read("src/lib/whatsapp.ts"));
  assert.doesNotMatch(lib, /محلي|NexusCore|price|سعر:|fetch\(|console\./);
  assert.equal((lib.match(/https:\/\//g) ?? []).length, 1, "wa.me only");
  const storeName = code(read("src/mobile/data/useStoreName.ts"));
  assert.match(storeName, /from\("stores"\)\.select\("name"\)/);
  assert.doesNotMatch(storeName, /useSettingsStore|محلي/, "mobile's settings store holds the default «محلي»");
  const purchasing = code(read("src/mobile/screens/MobilePurchasingScreen.tsx"));
  assert.match(purchasing, /phone=\{names\.supplierPhones\.get\(row\.subjectId\)\}/);
  assert.match(code(read("src/mobile/screens/MobileCustomerDetails.tsx")), /phone=\{customer\.phone\}\s*message=\{customerMessage\(\{ customerName: customer\.name, storeName \}\)\}/);
});

test("the identity key is untouched: toWhatsAppNumber keeps its lenient rules", () => {
  // `customerKey` dedupes customers on it; tightening it would re-key people.
  assert.match(read("src/lib/customers.ts"), /const phone = toWhatsAppNumber\(person\.phone\);/);
  assert.doesNotMatch(read("src/lib/phone.ts"), /whatsAppTarget/);
});

// ═══ Money formatting ═══════════════════════════════════════════════════════

test("B · whole amounts drop «٫٠٠»; real piastres keep two places", () => {
  const cases = [
    [800000, "٨٠٠٬٠٠٠ ج.م."],
    [100000, "١٠٠٬٠٠٠ ج.م."],
    [15000, "١٥٬٠٠٠ ج.م."],
    [1250, "١٬٢٥٠ ج.م."],
    [0, "٠ ج.م."],
    [-0, "٠ ج.م."],
    [800000.5, "٨٠٠٬٠٠٠٫٥٠ ج.م."],
    [1250.75, "١٬٢٥٠٫٧٥ ج.م."],
    [12500.5, "١٢٬٥٠٠٫٥٠ ج.م."],
    [0.1 + 0.2, "٠٫٣٠ ج.م."],
    [800000.0000001, "٨٠٠٬٠٠٠ ج.م."],
  ];
  for (const [value, expected] of cases) assert.equal(formatArabicCurrency(value), expected, String(value));
  const loss = formatArabicCurrency(-150000);
  assert.ok(loss.includes("-١٥٠٬٠٠٠") && !loss.includes("٫"), loss);
  assert.equal(formatArabicCurrency(Number.NaN), "—");
});

test("B · missing is «غير مسجل», zero is «٠ ج.م.»", () => {
  assert.equal(formatArabicCurrency(null), "غير مسجل");
  assert.equal(formatArabicCurrency(undefined), "غير مسجل");
  assert.equal(formatArabicCurrency(0), "٠ ج.م.");
});

test("B · Mobile money goes through the one formatter", () => {
  for (const f of [
    "src/mobile/screens/MobileQuickRestock.tsx",
    "src/mobile/data/mobileReaders.ts",
    "src/mobile/screens/MobileOwnerScreen.tsx",
  ]) {
    const src = code(read(f));
    assert.doesNotMatch(src, /formatMoney\(/, `${f}: Desktop formatter`);
    assert.doesNotMatch(src, /toLocaleString\([^)]*\)[^\n]{0,20}ج\.م/, `${f}: ad-hoc money`);
  }
});

test("C · the §10 statement reads 500k / 100k / 300k / 80k / 820k with no «٫٠٠»", () => {
  const s = equityStatement({
    capitalRows: [{ subjectId: "owner", amount: 500000 }], capitalCash: 500000,
    contributionRows: [{ subjectId: "owner", amount: 100000 }],
    drawRows: [{ subjectId: "owner", amount: 80000 }],
    adjustmentStock: 0, adjustmentWallet: 0, adjustmentExpense: 0,
    revenue: 450000, cogs: 100000, expenses: 50000,
  });
  assert.deepEqual(
    [s.capital, s.contributions, s.accumulatedResult, s.withdrawals, s.totalEquity].map(formatArabicCurrency),
    ["٥٠٠٬٠٠٠ ج.م.", "١٠٠٬٠٠٠ ج.م.", "٣٠٠٬٠٠٠ ج.م.", "٨٠٬٠٠٠ ج.م.", "٨٢٠٬٠٠٠ ج.م."],
  );
  assert.equal(formatArabicCurrency(equityStatement({ ...s, capitalRows: [], contributionRows: [], drawRows: [], capitalCash: 0, adjustmentStock: 0, adjustmentWallet: 0, adjustmentExpense: 0, revenue: 0, cogs: 0, expenses: 0 }).capital), "غير مسجل");
});
