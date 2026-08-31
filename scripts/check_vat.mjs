/**
 * نسبة الضريبة from الإعدادات → the tax line on a printed فاتورة.
 *
 *     node --test scripts/check_vat.mjs
 *
 * The receipt breaks VAT OUT of the total charged; it never adds to it. If
 * this ever starts returning `total * rate / 100`, every printed invoice
 * overstates the tax and the total stops matching the ledger.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { includedVat } from "../src/lib/math.ts";

test("extracts the tax already inside a tax-inclusive total", () => {
  // 114 gross at 14% = 100 net + 14 tax.
  assert.equal(includedVat(114, 14), 14);
  // 100 gross at 14% — the tax is a part OF the 100, not 14 on top.
  assert.equal(includedVat(100, 14), 12.28);
  assert.ok(includedVat(100, 14) < 14, "must never exceed the add-on amount");
});

test("a blank or absent نسبة الضريبة prints no tax line", () => {
  for (const rate of [0, -5, NaN, undefined, null]) {
    assert.equal(includedVat(250, rate), 0, `rate ${String(rate)} should yield 0`);
  }
});

test("never invents tax on a zero or negative total", () => {
  assert.equal(includedVat(0, 14), 0);
  assert.equal(includedVat(-50, 14), 0);
});

test("the extracted tax is always a part of the total", () => {
  for (const [total, rate] of [
    [1, 14],
    [999.99, 5],
    [12500, 25],
    [3, 100],
  ]) {
    const vat = includedVat(total, rate);
    assert.ok(vat > 0 && vat < total, `${vat} must sit inside ${total}`);
  }
});
