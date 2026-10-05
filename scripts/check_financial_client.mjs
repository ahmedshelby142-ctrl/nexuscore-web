import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/lib/financialCommand.ts", import.meta.url), "utf8");
function storage() {
  const values = {};
  return new Proxy(values, {
    get: (o, k) =>
      k === "getItem"
        ? (key) => o[key] ?? null
        : k === "setItem"
          ? (key, value) => {
              o[key] = value;
            }
          : k === "removeItem"
            ? (key) => {
                delete o[key];
              }
            : o[k],
  });
}
function client(rpc, sessionStorage = storage()) {
  const exports = {},
    attrs = {};
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      crypto,
      sessionStorage,
      document: {
        documentElement: {
          setAttribute: (key, value) => {
            attrs[key] = value;
          },
        },
      },
      require: (name) =>
        name.includes("supabase")
          ? { getSupabaseClient: () => ({ rpc }) }
          : name.includes("storeContext")
            ? { getSyncIdentity: async () => ({ storeId: "store", deviceId: "device" }) }
            : { assertFiniteLines: () => {} },
    },
  );
  return { ...exports, attrs, sessionStorage };
}
test("actual client retries a lost committed response with one identity and original payload", async () => {
  const calls = [],
    commits = new Map();
  const c = client(async (_name, args) => {
    calls.push(args);
    if (!commits.has(args.p_id)) {
      commits.set(args.p_id, args.p_input);
      throw new TypeError("response lost after commit");
    }
    return { data: { eventId: args.p_id, replayed: true } };
  });
  const result = await c.runFinancialCommand("ledger", { amount: 100 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].p_id, calls[1].p_id);
  assert.equal(commits.size, 1);
  assert.equal(result.replayed, true);
  assert.equal(Object.keys(c.sessionStorage).length, 0);
  assert.equal(c.attrs["data-pwa-unsaved"], "false");
});
test("unresolved retries survive a page reload and protect automatic PWA reload", async () => {
  const ids = [],
    saved = storage();
  const first = client(async (_n, a) => {
    ids.push(a.p_id);
    throw Error("offline");
  }, saved);
  await assert.rejects(first.runFinancialCommand("receipt", { paidAmount: 40 }), /لم يصل/);
  assert.equal(first.attrs["data-pwa-unsaved"], "true");
  const next = client(async (_n, a) => {
    ids.push(a.p_id);
    return { data: { replayed: true } };
  }, saved);
  await next.runFinancialCommand("receipt", { paidAmount: 40 });
  assert.equal(new Set(ids).size, 1);
});
test("a changed draft resolves only the previous uncertain operation, never submits changed money", async () => {
  const saved = storage(),
    calls = [];
  const first = client(async () => {
    throw Error("offline");
  }, saved);
  await assert.rejects(first.runFinancialCommand("supplier_payment", { amount: 100 }));
  const next = client(async (_n, a) => {
    calls.push(a);
    return { data: { replayed: true } };
  }, saved);
  await assert.rejects(
    next.runFinancialCommand("supplier_payment", { amount: 200 }),
    /العملية السابقة/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].p_input.amount, 100);
});
test("concurrent same-draft client submissions share one request; different draft is refused", async () => {
  let release;
  const calls = [];
  const c = client(async (_n, a) => {
    calls.push(a);
    return new Promise((resolve) => {
      release = () => resolve({ data: { eventId: a.p_id } });
    });
  });
  const a = c.runFinancialCommand("ledger", { amount: 100 });
  await new Promise((resolve) => setImmediate(resolve));
  const b = c.runFinancialCommand("ledger", { amount: 100 });
  await assert.rejects(c.runFinancialCommand("ledger", { amount: 200 }), /انتظر/);
  release();
  assert.equal((await a).eventId, (await b).eventId);
  assert.equal(calls.length, 1);
});
test("definite pre-commit refusal permits correction; earlier uncertainty keeps identity on later refusal", async () => {
  const saved = storage();
  let mode = "reject";
  const ids = [];
  const c = client(async (_n, a) => {
    ids.push(a.p_id);
    if (mode === "offline") throw Error("offline");
    return mode === "reject"
      ? { error: { code: "23514", message: "invalid" } }
      : { data: { eventId: a.p_id } };
  }, saved);
  await assert.rejects(c.runFinancialCommand("ledger", { amount: 0 }));
  assert.equal(Object.keys(saved).length, 0);
  mode = "offline";
  await assert.rejects(c.runFinancialCommand("ledger", { amount: 100 }));
  const id = ids.at(-1);
  mode = "reject";
  await assert.rejects(c.runFinancialCommand("ledger", { amount: 100 }));
  assert.equal(ids.at(-1), id);
  assert.equal(Object.keys(saved).length, 1);
  mode = "success";
  await c.runFinancialCommand("ledger", { amount: 100 });
  assert.equal(ids.at(-1), id);
});
test("non-finite requests are refused before serialization can turn them into null/full payment", async () => {
  let calls = 0;
  const c = client(async () => {
    calls++;
    return { data: {} };
  });
  for (const amount of [NaN, Infinity, -Infinity])
    await assert.rejects(c.runFinancialCommand("receipt", { paidAmount: amount }), /غير صالحة/);
  assert.equal(calls, 0);
});
test("unfinished product opening resolves before another product can be created", async () => {
  const saved = storage();
  const c = client(async () => {
    throw Error("lost");
  }, saved);
  await assert.rejects(
    c.runFinancialCommand(
      "ledger",
      { amount: 10 },
      "ledger:stock_adjustment:opening_balance:product-1",
    ),
  );
  const next = client(async () => ({ data: { eventId: "first" } }), saved);
  await assert.rejects(next.resolvePendingOpeningBalance(), /الرصيد الافتتاحي السابق/);
  assert.equal(Object.keys(saved).length, 0);
});
