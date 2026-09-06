/**
 * A read that stops at 1000 rows must not look like a read that finished.
 *
 *     node --test scripts/check_paging.mjs
 *
 * PostgREST caps a response at 1000 rows, and the cap is invisible: the
 * request succeeds, and a truncated page is byte-for-byte the shape of a table
 * that really is that short. No error, no header the caller checks, nothing on
 * screen.
 *
 * `cloudList` read whole tables in one `.select("*")`, so the moment a shop
 * crossed 1000 orders — or products, or customers, or invoices — the screen
 * showed the first 1000 and said nothing about the rest. Order search missed
 * orders that were present. The ledger driver already paged, because a balance
 * is a SUM over every line and a short read there is stock that vanished; both
 * now share one loop.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { pageAll, PAGE } from "../src/lib/pageAll.ts";

/** A fake PostgREST that holds `total` rows and honours an inclusive range. */
const table = (total) => (from, to) => {
  assert.equal(to - from + 1, PAGE, "each request must ask for exactly one page");
  return Promise.resolve({ data: Array.from({ length: Math.max(0, Math.min(to + 1, total) - from) }, (_, i) => from + i), error: null });
};

test("a table shorter than one page is read in one request", async () => {
  let calls = 0;
  const rows = await pageAll((f, t) => { calls++; return table(7)(f, t); });
  assert.equal(rows.length, 7);
  assert.equal(calls, 1);
});

test("an empty table is one request and no rows", async () => {
  const rows = await pageAll(table(0));
  assert.deepEqual(rows, []);
});

test("a table past the cap is read whole, in order", async () => {
  const rows = await pageAll(table(PAGE * 2 + 3));
  assert.equal(rows.length, PAGE * 2 + 3, "every row must come back");
  assert.deepEqual(rows.slice(0, 3), [0, 1, 2]);
  assert.equal(rows[rows.length - 1], PAGE * 2 + 2, "and in the order the server sent them");
});

test("a table that is an exact multiple of the page still terminates", async () => {
  // The subtle one: 1000 rows means the first page comes back FULL, so the
  // loop cannot stop there — it must ask again and get nothing back.
  let calls = 0;
  const rows = await pageAll((f, t) => { calls++; return table(PAGE)(f, t); });
  assert.equal(rows.length, PAGE);
  assert.equal(calls, 2, "a full last page must be followed by one empty request");
});

test("an error is thrown, never returned as a short read", async () => {
  await assert.rejects(
    () => pageAll(() => Promise.resolve({ data: null, error: { message: "permission denied" } })),
    /permission denied/,
    "swallowing this is what makes a failed read look like an empty table",
  );
});

test("both readers use the shared loop", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  for (const f of ["../src/services/cloudData.ts", "../src/lib/ledger/driver.ts"]) {
    const src = read(f);
    assert.match(src, /pageAll/, `${f} must page`);
    assert.ok(
      !/\bconst PAGE = \d/.test(src),
      `${f} has its own page size again — one of the two will drift`,
    );
  }
});
