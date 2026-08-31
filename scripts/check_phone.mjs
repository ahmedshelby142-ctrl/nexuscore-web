/**
 * Egyptian phone numbers → wa.me links (brief §3.5).
 *
 *     node --test scripts/check_phone.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { toWhatsAppNumber, whatsAppLink } from "../src/lib/phone.ts";

test("an Egyptian mobile written the local way becomes international", () => {
  // The case the brief names: 01… → 2010…
  assert.equal(toWhatsAppNumber("01012345678"), "201012345678");
  assert.equal(toWhatsAppNumber("01112345678"), "201112345678");
  assert.equal(toWhatsAppNumber("01212345678"), "201212345678");
  assert.equal(toWhatsAppNumber("01512345678"), "201512345678");
});

test("separators, spaces and a + are not part of a number", () => {
  assert.equal(toWhatsAppNumber("0101 234 5678"), "201012345678");
  assert.equal(toWhatsAppNumber("0101-234-5678"), "201012345678");
  assert.equal(toWhatsAppNumber("(010) 1234 5678"), "201012345678");
  assert.equal(toWhatsAppNumber("+20 101 234 5678"), "201012345678");
  assert.equal(toWhatsAppNumber("0020 101 234 5678"), "201012345678");
});

test("Arabic-Indic digits are numbers too", () => {
  assert.equal(toWhatsAppNumber("٠١٠١٢٣٤٥٦٧٨"), "201012345678");
  assert.equal(toWhatsAppNumber("٠١٠ ١٢٣ ٤٥٦٧٨"), "201012345678");
});

test("an already-international number is left alone", () => {
  assert.equal(toWhatsAppNumber("201012345678"), "201012345678");
  assert.equal(toWhatsAppNumber("966512345678"), "966512345678", "not every supplier is Egyptian");
});

test("a landline keeps working — the rule is about the trunk zero, not mobiles", () => {
  assert.equal(toWhatsAppNumber("0223456789"), "20223456789");
});

test("nothing dialable gives no link, rather than a broken one", () => {
  for (const bad of ["", "   ", null, undefined, "غير معروف", "123"]) {
    assert.equal(toWhatsAppNumber(bad), null, `"${bad}" is not a number`);
    assert.equal(whatsAppLink(bad), null);
  }
});

test("the link is the plain wa.me form", () => {
  assert.equal(whatsAppLink("01012345678"), "https://wa.me/201012345678");
});
