import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { openBusinessDb, read, MIGRATION } from "./helpers/business-db.mjs";
import { buildSaleLines } from "../src/lib/ledger/sales.ts";
import {
  buildOrderPlacedLines,
  buildOrderDeliveredLines,
  buildOrderCancelledLines,
  buildReturnConfirmedLines,
  buildCourierSettlementLines,
} from "../src/lib/ledger/orders.ts";
import { buildOpeningBalanceLines } from "../src/lib/ledger/audit.ts";
import { costedReturnLine, remainingSaleLines, posRefundValue } from "../src/lib/posReturn.ts";
let db, c;
function payroll(amount = 10, type = "salary", wallet = "inStoreSafe") {
  const doc = {
    id: crypto.randomUUID(),
    store_id: db.store,
    device_id: db.device,
    employeeName: "Synthetic employee",
    type,
    amount,
    wallet,
    date: "2026-10-11T00:00:00Z",
    description: "Synthetic payroll regression",
  };
  return {
    doc,
    event: db.event("payroll", "payroll", doc.id, [
      { account: "expense", subjectId: "salaries", amount },
      { account: "wallet", subjectId: wallet, amount: -amount },
    ]),
  };
}
const record = ({ doc, event }, client = c) =>
  client.query("select record_payroll($1,$2) result", [doc, event]).then((r) => r.rows[0].result);
const count = async (table, id) =>
  Number((await db.admin.query(`select count(*) n from ${table} where id=$1`, [id])).rows[0].n);
before(async () => {
  db = await openBusinessDb({ migrate: false });
  c = await db.client("ACCOUNTANT");
  const vulnerable = payroll(1000);
  vulnerable.event.lines[0].amount_delta = 1;
  vulnerable.event.lines[1].amount_delta = -1;
  await c.query("begin");
  await record(vulnerable);
  assert.equal(
    await count("payroll", vulnerable.doc.id),
    0,
    "uncommitted document is not visible on the admin connection",
  );
  assert.equal(
    (await c.query("select amount from payroll where id=$1", [vulnerable.doc.id])).rows[0].amount,
    "1000",
  );
  await c.query("rollback");
  const badCode = (
    await db.insert("discount_codes", {
      id: crypto.randomUUID(),
      store_id: db.store,
      device_id: db.device,
      code: "BASELINE-RELEASE",
      type: "fixed",
      value: 10,
      active: true,
      maxUses: 1,
    })
  ).rows[0];
  await c.query("begin");
  await c.query("select claim_discount_use($1,$2,10)", [db.store, badCode.id]);
  await c.query("select release_discount_use($1,$2,-100)", [db.store, badCode.id]);
  assert.equal(
    (await c.query('select "totalDiscount" from discount_codes where id=$1', [badCode.id])).rows[0]
      .totalDiscount,
    "110",
  );
  await c.query("select release_discount_use($1,$2,'NaN'::numeric)", [db.store, badCode.id]);
  assert.equal(
    (await c.query('select "totalDiscount" from discount_codes where id=$1', [badCode.id])).rows[0]
      .totalDiscount,
    "NaN",
  );
  await c.query("rollback");
  // Both independent transactions accept the same final unit on the captured
  // baseline. Keep them uncommitted and roll both back: no corrupt fixture is
  // carried into the candidate regressions.
  const last = await product(1),
    seller = await db.client("POS_ECOMMERCE"),
    orderId = crypto.randomUUID();
  const items = [{ productId: last, quantity: 1, unitPrice: 50, unitCost: 10 }];
  const order = {
    id: orderId,
    store_id: db.store,
    device_id: db.device,
    orderNumber: orderId,
    customerName: "Synthetic",
    customerPhone: "01000000000",
    items,
    stockItems: items,
    totalAmount: 50,
    shippingFee: 0,
    depositAmount: 0,
    paymentMethod: "partial_cod",
    expectedCod: 50,
  };
  await c.query("begin");
  await seller.query("begin");
  await Promise.all([
    c.query("select ledger_append($1)", [
      db.event(
        "sale",
        "pos_sale",
        crypto.randomUUID(),
        buildSaleLines({ items, wallet: "inStoreSafe" }),
        { items },
      ),
    ]),
    seller.query("select place_order($1,$2)", [
      order,
      db.event(
        "order_placed",
        "ecommerce_order",
        orderId,
        buildOrderPlacedLines({ items, depositAmount: 0, wallet: "inStoreSafe" }),
      ),
    ]),
  ]);
  for (const connection of [c, seller])
    assert.equal(
      Number(
        (
          await connection.query(
            "select sum(qty_delta) n from ledger_lines where account='stock' and subject_id=$1",
            [last],
          )
        ).rows[0].n,
      ),
      0,
    );
  await c.query("rollback");
  await seller.query("rollback");
  await db.admin.query(read(MIGRATION));
  fs.writeFileSync(
    "logs/final-v1-sprint/financial-db-environment.json",
    JSON.stringify(
      {
        version: db.version,
        host: "127.0.0.1",
        baselinePayrollMismatchReproduced: true,
        baselineDiscountCorruptionReproduced: true,
        baselineConcurrentLastUnitBothAccepted: true,
        baselineProbeRolledBack: true,
        migration: MIGRATION,
      },
      null,
      2,
    ),
  );
});
after(async () => {
  await db?.close();
});
test("SPR-STOCK-01: POS and ecommerce concurrently reserving the last unit cannot both commit", async () => {
  const id = await product(1),
    seller = await db.client("POS_ECOMMERCE"),
    orderId = crypto.randomUUID();
  const items = [{ productId: id, quantity: 1, unitPrice: 50, unitCost: 10 }],
    order = {
      id: orderId,
      store_id: db.store,
      device_id: db.device,
      orderNumber: orderId,
      customerName: "Synthetic",
      customerPhone: "01000000000",
      items,
      stockItems: items,
      totalAmount: 50,
      shippingFee: 0,
      paymentMethod: "partial_cod",
      depositAmount: 0,
      expectedCod: 50,
    };
  const event = db.event(
    "order_placed",
    "ecommerce_order",
    orderId,
    buildOrderPlacedLines({ items, depositAmount: 0, wallet: "inStoreSafe" }),
  );
  const outcomes = await Promise.allSettled([
    pos(sale(id)),
    seller.query("select place_order($1,$2)", [order, event]),
  ]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    Number(
      (
        await db.admin.query(
          "select sum(qty_delta) n from ledger_lines where account='stock' and subject_id=$1",
          [id],
        )
      ).rows[0].n,
    ),
    0,
  );
  if (outcomes[1].status === "rejected") assert.equal(await count("orders", orderId), 0);
});
test("SPR-FIN-01: salary, bonus and advance preserve established salary expense semantics and exact piastres", async () => {
  for (const type of ["salary", "bonus", "advance"]) {
    const input = payroll(0.01, type);
    const result = await record(input);
    assert.equal(result.replayed, false);
    assert.equal(result.payroll.amount, 0.01);
    assert.deepEqual(
      (
        await db.admin.query(
          "select account,subject_id,amount_delta from ledger_lines where event_id=$1 order by account",
          [input.event.id],
        )
      ).rows,
      [
        { account: "expense", subject_id: "salaries", amount_delta: 1 },
        { account: "wallet", subject_id: "inStoreSafe", amount_delta: -1 },
      ],
    );
  }
});
test("SPR-FIN-02: amount/wallet/category/extra-line mismatches leave no document or ledger", async () => {
  for (const mutate of [
    (i) => {
      i.event.lines[0].amount_delta = 1;
      i.event.lines[1].amount_delta = -1;
    },
    (i) => {
      i.event.lines[1].subject_id = "bankAccount";
    },
    (i) => {
      i.event.lines[0].subject_id = "other";
    },
    (i) => {
      i.event.lines.push({ ...i.event.lines[0], id: crypto.randomUUID() });
    },
    (i) => {
      i.event.lines[0].qty_delta = 1;
    },
  ]) {
    const input = payroll(1000);
    mutate(input);
    await assert.rejects(record(input), /NEXUS_PAYROLL_EVENT_MISMATCH/);
    assert.equal(await count("payroll", input.doc.id), 0);
    assert.equal(await count("ledger_events", input.event.id), 0);
  }
});
test("SPR-FIN-03: negative, zero, nonfinite, subpiastre and unsupported document values rejected", async () => {
  for (const amount of [0, -1, "NaN", "Infinity", "-Infinity", 0.001, 1.005]) {
    const input = payroll(10);
    input.doc.amount = amount;
    await assert.rejects(record(input), /NEXUS_PAYROLL_INVALID/);
    assert.equal(await count("payroll", input.doc.id), 0);
  }
  const invalid = payroll(10, "unknown");
  await assert.rejects(record(invalid), /NEXUS_PAYROLL_INVALID/);
});
test("SPR-FIN-04: lost-reply replay pays once; changed business payload cannot reuse identity", async () => {
  const input = payroll(12.34);
  assert.equal((await record(input)).replayed, false);
  // Existing clients prepare a fresh event ID on a document retry; preserve that contract.
  const retry = { doc: { ...input.doc }, event: { ...input.event, id: crypto.randomUUID() } };
  assert.equal((await record(retry)).replayed, true);
  assert.equal(await count("ledger_events", retry.event.id), 0);
  retry.doc.amount = 13;
  await assert.rejects(record(retry), /NEXUS_REPLAY_MISMATCH/);
});
test("SPR-FIN-05: concurrent same-document submissions produce one payment", async () => {
  const input = payroll(2),
    other = await db.client("ACCOUNTANT");
  const results = await Promise.all([record(input), record(input, other)]);
  assert.deepEqual(results.map((x) => x.replayed).sort(), [false, true]);
  assert.equal(await count("payroll", input.doc.id), 1);
  assert.equal(await count("ledger_events", input.event.id), 1);
});
test("SPR-FIN-06: late ledger refusal atomically rolls payroll back", async () => {
  const input = payroll(3);
  input.event.lines[0].id = input.event.lines[1].id;
  await assert.rejects(record(input));
  assert.equal(await count("payroll", input.doc.id), 0);
  assert.equal(await count("ledger_events", input.event.id), 0);
});
test("SPR-FIN-07: existing bank wallet remains supported and unknown wallet keeps its inherited refusal", async () => {
  const input = payroll(2.34, "salary", "bankAccount");
  await record(input);
  assert.equal(
    Number(
      (
        await db.admin.query(
          "select amount_delta from ledger_lines where event_id=$1 and account='wallet'",
          [input.event.id],
        )
      ).rows[0].amount_delta,
    ),
    -234,
  );
  const invalid = payroll(2, "salary", "unknown-wallet");
  await assert.rejects(record(invalid), /wallet line must name/);
  assert.equal(await count("payroll", invalid.doc.id), 0);
});

async function code(patch = {}) {
  return (
    await db.insert("discount_codes", {
      id: crypto.randomUUID(),
      store_id: db.store,
      device_id: db.device,
      code: "SYN-" + crypto.randomUUID(),
      type: "fixed",
      value: 5,
      active: true,
      maxUses: 2,
      ...patch,
    })
  ).rows[0];
}
const usage = async (d) =>
  (
    await db.admin.query(
      'select "usedCount" n,"totalDiscount" total from discount_codes where id=$1',
      [d.id],
    )
  ).rows[0];
async function product(quantity = 10) {
  const id = crypto.randomUUID();
  await db.insert("products", {
    id,
    store_id: db.store,
    device_id: db.device,
    name: "Synthetic product",
    sku: id,
    unitPrice: 50,
  });
  await c.query("select ledger_append($1)", [
    db.event(
      "stock_adjustment",
      "opening_balance",
      id,
      buildOpeningBalanceLines({ productId: id, quantity, unitCost: 10 }),
    ),
  ]);
  return id;
}
function sale(id, d, amount = 5, qty = 1, source) {
  const items = [
    { productId: id, productName: "Synthetic product", quantity: qty, unitPrice: 50, unitCost: 10 },
  ];
  return {
    kind: "sale",
    refType: "pos_sale",
    payload: {
      items,
      discountCodeId: d?.id,
      discountAmount: d ? amount : 0,
      returnOfEventId: source,
    },
    lines: buildSaleLines({ items, wallet: "inStoreSafe", discountAmount: d ? amount : 0 }),
  };
}
const pos = async (input, client = c, id = crypto.randomUUID()) =>
  (
    await client.query("select record_pos_sale($1,$2,$3,$4,$5) result", [
      id,
      db.store,
      db.device,
      "pos_sale",
      input,
    ])
  ).rows[0].result;
test("SPR-DISC-01: fixed and percentage use commit exactly once with POS and replay identity", async () => {
  for (const type of ["fixed", "percentage"]) {
    const d = await code({ type, value: type === "fixed" ? 5 : 10 }),
      id = await product(),
      input = sale(id, d),
      operation = crypto.randomUUID();
    await c.query("select validate_discount_use($1,$2,$3)", [db.store, d.id, 5]);
    assert.deepEqual(await usage(d), { n: 0, total: "0" });
    assert.equal((await pos(input, c, operation)).replayed, false);
    assert.equal((await pos(input, c, operation)).replayed, true);
    assert.deepEqual(await usage(d), { n: 1, total: "5" });
    await assert.rejects(
      pos({ ...input, actor: "changed" }, c, operation),
      /NEXUS_OPERATION_PAYLOAD_MISMATCH/,
    );
  }
});
test("SPR-DISC-02: negative/nonfinite and unpaired legacy compensation cannot corrupt usage", async () => {
  const d = await code();
  for (const amount of [-1, "NaN", "Infinity", "-Infinity", 1e10])
    for (const rpc of ["release_discount_use", "claim_discount_use"])
      await assert.rejects(
        c.query(`select ${rpc}($1,$2,$3)`, [db.store, d.id, amount]),
        /NEXUS_BAD_AMOUNT/,
      );
  for (const rpc of ["release_discount_use", "claim_discount_use"])
    for (let i = 0; i < 2; i++)
      await assert.rejects(
        c.query(`select ${rpc}($1,$2,$3)`, [db.store, d.id, 5]),
        /NEXUS_DISCOUNT_ATOMIC_REQUIRED/,
      );
  await assert.rejects(
    c.query("select adjust_discount_total($1,$2,5)", [db.store, d.id]),
    /NEXUS_DISCOUNT_DOCUMENT_REQUIRED/,
  );
  assert.deepEqual(await usage(d), { n: 0, total: "0" });
});
test("SPR-DISC-03: expiry, inactive, wrong amount and late ledger refusal roll sale back", async () => {
  const id = await product();
  for (const [patch, amount, message] of [
    [{ active: false }, 5, /INACTIVE/],
    [{ expiryDate: "2020-01-01" }, 5, /EXPIRED/],
    [{}, 4, /AMOUNT_MISMATCH/],
  ]) {
    const d = await code(patch),
      operation = crypto.randomUUID();
    await assert.rejects(pos(sale(id, d, amount), c, operation), message);
    assert.equal(await count("ledger_events", operation), 0);
    assert.deepEqual(await usage(d), { n: 0, total: "0" });
  }
  const d = await code(),
    input = sale(id, d),
    operation = crypto.randomUUID();
  input.lines.push({ account: "invalid", subjectId: id, amount: 1 });
  await assert.rejects(pos(input, c, operation));
  assert.equal(await count("ledger_events", operation), 0);
  assert.deepEqual(await usage(d), { n: 0, total: "0" });
});
test("SPR-DISC-04: concurrent one-use code accepts one sale, rolls the other stock and money back", async () => {
  const d = await code({ maxUses: 1 }),
    id = await product(2),
    other = await db.client("POS_ECOMMERCE"),
    ops = [crypto.randomUUID(), crypto.randomUUID()];
  const outcomes = await Promise.allSettled([
    pos(sale(id, d), c, ops[0]),
    pos(sale(id, d), other, ops[1]),
  ]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  assert.deepEqual(await usage(d), { n: 1, total: "5" });
  assert.equal(
    Number(
      (
        await db.admin.query(
          "select sum(qty_delta) qty from ledger_lines where account='stock' and subject_id=$1",
          [id],
        )
      ).rows[0].qty,
    ),
    1,
  );
});
test("SPR-POS-01: concurrent last-unit sales cannot oversell; exact refund restores cash, stock and profit", async () => {
  const id = await product(1),
    other = await db.client("POS_ECOMMERCE"),
    ops = [crypto.randomUUID(), crypto.randomUUID()];
  const results = await Promise.allSettled([
    pos(sale(id), c, ops[0]),
    pos(sale(id), other, ops[1]),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  const source = ops[results.findIndex((x) => x.status === "fulfilled")];
  const refund = sale(id, null, 0, -1, source),
    refundId = crypto.randomUUID();
  await pos(refund, c, refundId);
  await pos(refund, c, refundId);
  await assert.rejects(pos(refund), /NEXUS_POS_RETURN_LIMIT/);
  const rows = (
    await db.admin.query(
      "select account,sum(amount_delta) amount,sum(qty_delta) qty from ledger_lines where event_id=any($1) group by account order by account",
      [[source, refundId]],
    )
  ).rows;
  assert.ok(rows.every((x) => Number(x.amount) === 0 && Number(x.qty) === 0));
});
test("SPR-DISC-05: ecommerce placement accounts discount with document; refund/cancellation does not invent another use", async () => {
  const d = await code({ type: "percentage", value: 10 }),
    id = await product(),
    orderId = crypto.randomUUID();
  const items = [{ productId: id, quantity: 1, unitPrice: 50, unitCost: 10 }];
  const order = {
    id: orderId,
    store_id: db.store,
    device_id: db.device,
    orderNumber: orderId,
    customerName: "Synthetic",
    customerPhone: "01000000000",
    items,
    totalAmount: 45,
    shippingFee: 0,
    paymentMethod: "full_prepaid",
    depositAmount: 45,
    expectedCod: 0,
    discountCodeId: d.id,
    discountAmount: 5,
  };
  const event = db.event(
    "order_placed",
    "ecommerce_order",
    orderId,
    buildOrderPlacedLines({ items, depositAmount: 45, wallet: "inStoreSafe" }),
  );
  const seller = await db.client("POS_ECOMMERCE");
  const place = () => seller.query("select place_order($1,$2)", [order, event]);
  await place();
  await place();
  assert.deepEqual(await usage(d), { n: 1, total: "5" });
  await c.query("select reconcile_discount_order($1,$2,$3)", [db.store, d.id, orderId]);
  await c.query("select reconcile_discount_order($1,$2,$3)", [db.store, d.id, orderId]);
  assert.deepEqual(await usage(d), { n: 1, total: "5" });
});

test("SPR-BUNDLE-01: last-component box refund restores historical cost even after stock reached zero", async () => {
  const component = await product(2),
    bundle = crypto.randomUUID();
  await db.insert("products", {
    id: bundle,
    store_id: db.store,
    device_id: db.device,
    name: "Synthetic box",
    sku: bundle,
    isBundle: true,
    bundleItems: [{ productId: component, quantity: 2 }],
    unitPrice: 80,
  });
  const items = [
    {
      productId: bundle,
      productName: "Synthetic box",
      quantity: 1,
      unitPrice: 80,
      unitCost: 0,
      isBundle: true,
      bundleItems: [{ productId: component, quantity: 2, unitCost: 10 }],
    },
  ];
  const input = {
    kind: "sale",
    refType: "pos_sale",
    payload: { items },
    lines: buildSaleLines({ items, wallet: "inStoreSafe" }),
  };
  const source = crypto.randomUUID();
  await pos(input, c, source);
  const legacy = {
    id: source,
    payload: {
      items: [{ productId: bundle, productName: "Synthetic box", quantity: 1, unitPrice: 80 }],
    },
  };
  const originalLines = (
    await db.admin.query(
      "select account,subject_id,qty_delta,amount_delta from ledger_lines where event_id=$1",
      [source],
    )
  ).rows;
  const recovered = costedReturnLine(legacy, remainingSaleLines(legacy)[0], originalLines, true);
  assert.equal(recovered.bundleItems[0].unitCost, 10);
  const refundItems = [{ ...recovered, quantity: -1 }];
  const refund = crypto.randomUUID();
  await pos(
    {
      kind: "sale",
      refType: "pos_sale",
      payload: { items: refundItems, returnOfEventId: source },
      lines: buildSaleLines({ items: refundItems, wallet: "inStoreSafe" }),
    },
    c,
    refund,
  );
  const totals = (
    await db.admin.query(
      "select account,sum(amount_delta) n from ledger_lines where event_id=any($1) group by account",
      [[source, refund]],
    )
  ).rows;
  assert.ok(totals.every((t) => Number(t.n) === 0));
});
test("SPR-POS-04: malformed monetary or component requests roll back; selected return cannot restore the whole receipt", async () => {
  const id = await product(3),
    source = crypto.randomUUID();
  await pos(sale(id, null, 0, 2), c, source);
  const badMoney = sale(id);
  badMoney.lines.find((l) => l.account === "wallet").amount = 1;
  await assert.rejects(pos(badMoney), /NEXUS_POS_VALUE_MISMATCH/);
  const badQty = sale(id);
  badQty.lines.find((l) => l.account === "stock").qty = -0.5;
  await assert.rejects(pos(badQty), /NEXUS_POS_STOCK_MISMATCH/);
  const forgedReturn = sale(id, null, 0, -1, source);
  forgedReturn.lines = buildSaleLines({
    items: [{ productId: id, quantity: -2, unitPrice: 25, unitCost: 10 }],
    wallet: "inStoreSafe",
  });
  await assert.rejects(pos(forgedReturn), /NEXUS_POS_STOCK_MISMATCH/);
  const wrongPrice = sale(id, null, 0, -1, source);
  wrongPrice.lines.find((l) => l.account === "wallet").amount = -100;
  await assert.rejects(pos(wrongPrice), /NEXUS_POS_RETURN_VALUE/);
});
async function placedOrder({
  qty = 2,
  discount = true,
  deposit = 0,
  shipping = 0,
  compensation = 0,
} = {}) {
  const productId = await product(10),
    d = discount ? await code({ type: "percentage", value: 10 }) : null,
    id = crypto.randomUUID(),
    courier = crypto.randomUUID();
  await db.insert("couriers", {
    id: courier,
    store_id: db.store,
    device_id: db.device,
    name: "Synthetic courier " + courier,
  });
  const items = [{ productId, quantity: qty, unitPrice: 50, unitCost: 10 }],
    amount = qty * 50 - (d ? qty * 5 : 0);
  const order = {
    id,
    store_id: db.store,
    device_id: db.device,
    orderNumber: id,
    customerName: "Synthetic",
    customerPhone: "01000000000",
    items,
    stockItems: items,
    totalAmount: amount,
    shippingFee: shipping,
    wastedTripCompensation: compensation,
    paymentMethod: "partial_cod",
    depositAmount: deposit,
    expectedCod: amount + shipping + compensation - deposit,
    discountCodeId: d?.id,
    discountAmount: d ? qty * 5 : 0,
    courierId: courier,
    courierFee: shipping,
    cogsAmount: qty * 10,
  };
  const seller = await db.client("POS_ECOMMERCE");
  await seller.query("select place_order($1,$2)", [
    order,
    db.event(
      "order_placed",
      "ecommerce_order",
      id,
      buildOrderPlacedLines({ items, depositAmount: deposit, wallet: "inStoreSafe" }),
    ),
  ]);
  return { order, items, d, seller, productId, courier };
}
const beforeEdit = (o) => ({
  items: o.items,
  stockItems: o.stockItems,
  totalAmount: o.totalAmount,
  discountAmount: o.discountAmount,
  depositAmount: o.depositAmount,
});
const edit = async (input, client, id = crypto.randomUUID()) =>
  (
    await client.query("select record_order_edit($1,$2,$3,$4,$5) result", [
      id,
      db.store,
      db.device,
      "order_edit",
      input,
    ])
  ).rows[0].result;
test("SPR-ECO-01: pending basket edit atomically reconciles stock, COD and discount; replay does not double delta", async () => {
  const { order, d, seller } = await placedOrder(),
    items = order.items.map((i) => ({ ...i, quantity: 1 })),
    operation = crypto.randomUUID();
  const input = {
    orderId: order.id,
    before: beforeEdit(order),
    patch: { items, stockItems: items, totalAmount: 45, discountAmount: 5 },
  };
  const result = await edit(input, seller, operation);
  assert.equal(result.order.expectedCod, 45);
  assert.deepEqual(await usage(d), { n: 1, total: "5" });
  assert.equal((await edit(input, seller, operation)).replayed, true);
  assert.deepEqual(await usage(d), { n: 1, total: "5" });
  assert.equal(
    Number(
      (
        await db.admin.query(
          "select sum(qty_delta) n from ledger_lines where account='stock' and subject_id=$1",
          [items[0].productId],
        )
      ).rows[0].n,
    ),
    9,
  );
  await assert.rejects(edit(input, seller), /NEXUS_ORDER_EDIT_STALE/);
});
test("SPR-ECO-02: malformed/over-deposit edits and raced edits roll back document, stock and usage", async () => {
  const { order, d, seller } = await placedOrder({ deposit: 80 });
  const items = order.items.map((i) => ({ ...i, quantity: 1 }));
  await assert.rejects(
    edit(
      {
        orderId: order.id,
        before: beforeEdit(order),
        patch: {
          items: order.items,
          stockItems: items,
          totalAmount: order.totalAmount,
          discountAmount: order.discountAmount,
        },
      },
      seller,
    ),
    /NEXUS_ORDER_EDIT_STOCK_MISMATCH/,
  );
  await assert.rejects(
    edit(
      {
        orderId: order.id,
        before: beforeEdit(order),
        patch: { items, stockItems: items, totalAmount: 45, discountAmount: 5 },
      },
      seller,
    ),
    /NEXUS_ORDER_EDIT_TOTAL/,
  );
  assert.deepEqual(await usage(d), { n: 1, total: "10" });
  const one = await placedOrder(),
    a = one.order.items.map((i) => ({ ...i, quantity: 1 })),
    b = one.order.items.map((i) => ({ ...i, quantity: 3 }));
  const requests = [a, b].map((items) => ({
    orderId: one.order.id,
    before: beforeEdit(one.order),
    patch: {
      items,
      stockItems: items,
      totalAmount: items[0].quantity * 45,
      discountAmount: items[0].quantity * 5,
    },
  }));
  const other = await db.client("ECOMMERCE_ONLY");
  const results = await Promise.allSettled([
    edit(requests[0], one.seller),
    edit(requests[1], other),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});
test("SPR-ECO-03: discounted cancellation restores reservation once and preserves cumulative successful usage", async () => {
  const { order, d, seller, items } = await placedOrder({ deposit: 10 });
  const event = db.event(
    "order_cancelled",
    "ecommerce_order",
    order.orderNumber,
    buildOrderCancelledLines({ items, forfeitedDeposit: 10, wallet: "inStoreSafe" }),
    { return_cause: "customer" },
  );
  await seller.query("select cancel_order($1,$2,$3)", [order.id, "customer", event]);
  await assert.rejects(
    seller.query("select cancel_order($1,$2,$3)", [order.id, "customer", event]),
    /ALREADY_CANCELLED/,
  );
  assert.deepEqual(await usage(d), { n: 1, total: "10" });
  assert.equal(
    (await db.admin.query("select status from orders where id=$1", [order.id])).rows[0].status,
    "cancelled",
  );
});
test("SPR-ECO-04: COD delivery, courier settlement, return and fee principal reconcile independently", async () => {
  const { order, seller, items, courier } = await placedOrder({
    qty: 1,
    discount: false,
    deposit: 10,
    shipping: 5,
  });
  const delivered = db.event(
    "order_delivered",
    "ecommerce_order",
    order.orderNumber,
    buildOrderDeliveredLines({
      items,
      goodsTotal: 50,
      shippingFee: 5,
      depositAmount: 10,
      codAmount: 45,
      courierId: courier,
    }),
  );
  await seller.query("select ledger_append($1)", [delivered]);
  const settled = db.event(
    "courier_settlement",
    "ecommerce_order",
    order.orderNumber,
    buildCourierSettlementLines({
      courierId: courier,
      wallet: "inStoreSafe",
      amount: 45,
      commission: 5,
    }),
  );
  await c.query("select ledger_append($1)", [settled]);
  await db.admin.query("update orders set status='returned',\"returnType\"='refund' where id=$1", [
    order.id,
  ]);
  const returned = db.event(
    "return_confirmed",
    "ecommerce_order",
    order.orderNumber,
    buildReturnConfirmedLines({
      items,
      refundAmount: 50,
      revenueAmount: 50,
      wallet: "inStoreSafe",
      returnFee: 3,
      courierId: courier,
      feeBorneBy: "shop",
    }),
    { return_cause: "shop", movement: "return" },
  );
  const admin = await db.client("ADMIN");
  await admin.query("select confirm_order_return($1,$2,$3,$4,$5)", [
    order.id,
    "shop",
    "return",
    JSON.stringify([returned]),
    null,
  ]);
  await assert.rejects(
    admin.query("select confirm_order_return($1,$2,$3,$4,$5)", [
      order.id,
      "shop",
      "return",
      JSON.stringify([returned]),
      null,
    ]),
    /ALREADY_CONFIRMED/,
  );
  const balances = (
    await db.admin.query(
      "select account,sum(amount_delta) n from ledger_lines where event_id=any($1) group by account",
      [[delivered.id, settled.id, returned.id]],
    )
  ).rows;
  assert.equal(Number(balances.find((x) => x.account === "receivable_courier").n), 0);
  assert.equal(Number(balances.find((x) => x.account === "payable_courier").n), 300);
  assert.equal(Number(balances.find((x) => x.account === "revenue").n), 0);
  assert.equal(Number(balances.find((x) => x.account === "cogs").n), 0);
});
test("SPR-ECO-06: full linked replacements at lower/equal/higher prices reconcile difference, original cost and courier fee", async () => {
  const admin = await db.client("ADMIN");
  for (const price of [30, 50, 70]) {
    const { order, seller, items, courier } = await placedOrder({ qty: 1, discount: false });
    const ids = [];
    async function append(kind, ref, lines, payload = {}) {
      const event = db.event(kind, "ecommerce_order", ref, lines, payload);
      await seller.query("select ledger_append($1)", [event]);
      ids.push(event.id);
      return event;
    }
    await append(
      "order_delivered",
      order.orderNumber,
      buildOrderDeliveredLines({
        items,
        goodsTotal: 50,
        depositAmount: 0,
        codAmount: 50,
        courierId: courier,
      }),
    );
    await append(
      "courier_settlement",
      order.orderNumber,
      buildCourierSettlementLines({
        courierId: courier,
        wallet: "inStoreSafe",
        amount: 50,
        commission: 0,
      }),
    );
    const replacementProduct = await product(2),
      replacementId = crypto.randomUUID(),
      replacementItems = [
        { productId: replacementProduct, quantity: 1, unitPrice: price, unitCost: 10 },
      ];
    const replacement = {
      ...order,
      id: replacementId,
      orderNumber: replacementId,
      original_order_id: order.id,
      isExchange: true,
      items: replacementItems,
      stockItems: replacementItems,
      totalAmount: price,
      expectedCod: price,
      cogsAmount: 10,
    };
    const reserved = db.event(
      "order_placed",
      "ecommerce_order",
      replacementId,
      buildOrderPlacedLines({ items: replacementItems, depositAmount: 0, wallet: "inStoreSafe" }),
    );
    await seller.query("select place_order($1,$2)", [replacement, reserved]);
    ids.push(reserved.id);
    await db.admin.query(
      "update orders set status='returned',\"returnType\"='refund' where id=$1",
      [order.id],
    );
    const returned = db.event(
      "return_confirmed",
      "ecommerce_order",
      order.orderNumber,
      buildReturnConfirmedLines({
        items,
        refundAmount: 50,
        revenueAmount: 50,
        wallet: "inStoreSafe",
        returnFee: 3,
        courierId: courier,
        movement: "exchange",
        feeBorneBy: "customer",
      }),
      { movement: "exchange", return_cause: "customer" },
    );
    await admin.query("select confirm_order_return($1,$2,$3,$4,$5)", [
      order.id,
      "customer",
      "exchange",
      JSON.stringify([returned]),
      null,
    ]);
    ids.push(returned.id);
    await append(
      "order_delivered",
      replacementId,
      buildOrderDeliveredLines({
        items: replacementItems,
        goodsTotal: price,
        depositAmount: 0,
        codAmount: price,
        courierId: courier,
      }),
    );
    await append(
      "courier_settlement",
      replacementId,
      buildCourierSettlementLines({
        courierId: courier,
        wallet: "inStoreSafe",
        amount: price + 3,
        commission: 3,
      }),
    );
    const totals = Object.fromEntries(
      (
        await db.admin.query(
          "select account,sum(amount_delta) n from ledger_lines where event_id=any($1) group by account",
          [ids],
        )
      ).rows.map((r) => [r.account, Number(r.n)]),
    );
    assert.equal(totals.wallet, price * 100);
    assert.equal(totals.revenue, price * 100);
    assert.equal(totals.cogs, 1000);
    assert.equal(totals.receivable_courier, 0);
    assert.equal(totals.payable_courier, 0);
  }
});
test("SPR-ECO-07: late edit ledger failure rolls back the document, stock and redemption repricing", async () => {
  const { order, d, seller } = await placedOrder(),
    items = order.items.map((i) => ({ ...i, quantity: 1 })),
    operation = crypto.randomUUID();
  // Deliberately fail only this synthetic candidate at the final ledger append.
  await db.admin.query(
    `CREATE FUNCTION public.synthetic_edit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${operation}' THEN RAISE EXCEPTION 'SYNTHETIC_LATE_FAILURE'; END IF; RETURN NEW; END; $$; CREATE TRIGGER synthetic_edit_failure BEFORE INSERT ON ledger_events FOR EACH ROW EXECUTE FUNCTION synthetic_edit_failure()`,
  );
  try {
    await assert.rejects(
      edit(
        {
          orderId: order.id,
          before: beforeEdit(order),
          patch: { items, stockItems: items, totalAmount: 45, discountAmount: 5 },
        },
        seller,
        operation,
      ),
      /SYNTHETIC_LATE_FAILURE/,
    );
    assert.equal(
      Number(
        (await db.admin.query('select "totalAmount" from orders where id=$1', [order.id])).rows[0]
          .totalAmount,
      ),
      90,
    );
    assert.deepEqual(await usage(d), { n: 1, total: "10" });
    assert.equal(await count("ledger_events", operation), 0);
  } finally {
    await db.admin.query(
      "DROP TRIGGER synthetic_edit_failure ON ledger_events; DROP FUNCTION synthetic_edit_failure()",
    );
  }
});
test("SPR-ECO-08: price-only edit has durable replay without stock movement; added stock uses current WAC", async () => {
  const { order, seller, productId } = await placedOrder({ discount: false });
  const priceItems = order.items.map((i) => ({ ...i, unitPrice: 60, unitCost: 999 })),
    operation = crypto.randomUUID();
  const input = {
    orderId: order.id,
    before: beforeEdit(order),
    patch: { items: priceItems, stockItems: priceItems, totalAmount: 120, discountAmount: 0 },
  };
  const result = await edit(input, seller, operation);
  assert.equal(result.order.cogsAmount, 20);
  assert.equal(result.order.expectedCod, 120);
  assert.equal((await edit(input, seller, operation)).replayed, true);
  assert.equal(
    Number(
      (await db.admin.query("select count(*) n from ledger_lines where event_id=$1", [operation]))
        .rows[0].n,
    ),
    0,
  );
  // A new synthetic receipt changes shelf WAC from 10 to 15 after reservation.
  await c.query("select ledger_append($1)", [
    db.event(
      "stock_adjustment",
      "opening_balance",
      productId,
      buildOpeningBalanceLines({ productId, quantity: 8, unitCost: 20 }),
    ),
  ]);
  const nextItems = priceItems.map((i) => ({ ...i, quantity: 3 }));
  const next = await edit(
    {
      orderId: order.id,
      before: beforeEdit(result.order),
      patch: { items: nextItems, stockItems: nextItems, totalAmount: 180, discountAmount: 0 },
    },
    seller,
  );
  assert.equal(next.order.cogsAmount, 35);
  assert.equal(next.order.stockItems[0].unitCost, 35 / 3);
});
test("SPR-ECO-09: basket edit preserves separately recorded shipping compensation in COD", async () => {
  const { order, seller } = await placedOrder({
    discount: false,
    deposit: 10,
    shipping: 5,
    compensation: 7,
  });
  const items = order.items.map((i) => ({ ...i, quantity: 1 }));
  const result = await edit(
    {
      orderId: order.id,
      before: beforeEdit(order),
      patch: { items, stockItems: items, totalAmount: 50, discountAmount: 0 },
    },
    seller,
  );
  assert.equal(result.order.expectedCod, 52);
  assert.equal(result.order.wastedTripCompensation, 7);
  assert.equal(result.order.shippingFee, 5);
  assert.equal(result.order.depositAmount, 10);
});
test("SPR-FIN-08: owner and Desktop returns readers include negative POS revenue without altering net profit", async () => {
  const admin = await db.client("ADMIN");
  const id = await product(1),
    source = crypto.randomUUID();
  await pos(sale(id), c, source);
  await pos(sale(id, null, 0, -1, source));
  const expected = Number(
    (
      await db.admin.query(
        "select coalesce(sum(l.amount_delta),0) n from ledger_lines l join ledger_events e on e.id=l.event_id where l.store_id=$1 and l.account='revenue' and l.amount_delta<0 and e.kind in ('sale','return_confirmed')",
        [db.store],
      )
    ).rows[0].n,
  );
  const owner = (await admin.query("select owner_financial_summary($1) result", [db.store])).rows[0]
    .result;
  const desktop = Number(
    (await c.query("select sum(amount) n from ledger_return_balances($1,'revenue')", [db.store]))
      .rows[0].n,
  );
  assert.equal(owner.returnsValue, -expected);
  assert.equal(desktop, expected);
  const within = Number(
    (
      await c.query(
        "select sum(amount) n from ledger_return_balances($1,'revenue',null,null,$2,$3)",
        [
          db.store,
          new Date(Date.now() - 3600000).toISOString().replace("Z", "+00:00"),
          new Date(Date.now() + 3600000).toISOString(),
        ],
      )
    ).rows[0].n,
  );
  assert.equal(
    within,
    expected,
    "timestamp windows include the same refund instants regardless of offset spelling",
  );
  assert.ok(owner.returnsValue >= 50 * 100);
  assert.equal(owner.netProfit, owner.revenue - owner.cogs - owner.expenses);
  const outside = (
    await c.query(
      "select sum(amount) n from ledger_return_balances($1,'revenue',null,null,'1900-01-01','1900-01-02')",
      [db.store],
    )
  ).rows[0].n;
  assert.equal(outside, null);
});
test("SPR-POS-06: three discounted partial refunds reverse every cash and cost piastre exactly once", async () => {
  const id = crypto.randomUUID();
  await db.insert("products", {
    id,
    store_id: db.store,
    device_id: db.device,
    name: "Synthetic rounding",
    sku: id,
    unitPrice: 0.01,
  });
  await c.query("select ledger_append($1)", [
    db.event(
      "stock_adjustment",
      "opening_balance",
      id,
      buildOpeningBalanceLines({ productId: id, quantity: 3, unitCost: 0.01 / 3 }),
    ),
  ]);
  const d = await code({ value: 0.01 }),
    items = [{ productId: id, quantity: 3, unitPrice: 0.01, unitCost: 0.01 / 3 }],
    source = crypto.randomUUID();
  const payload = { items, discountCodeId: d.id, discountAmount: 0.01 };
  await pos(
    {
      kind: "sale",
      refType: "pos_sale",
      payload,
      lines: buildSaleLines({ items, wallet: "inStoreSafe", discountAmount: 0.01 }),
    },
    c,
    source,
  );
  const stock = (
    await db.admin.query(
      "select account,subject_id,qty_delta,amount_delta from ledger_lines where event_id=$1",
      [source],
    )
  ).rows;
  const all = [source];
  for (let returned = 0; returned < 3; returned++) {
    const line = costedReturnLine(
      { id: source, payload },
      remainingSaleLines(
        { id: source, payload },
        returned ? [{ sourceEventId: source, productId: id, quantity: returned }] : [],
      )[0],
      stock,
    );
    const refundItems = [{ ...line, quantity: -1, unitPrice: posRefundValue(line, 1) }],
      operation = crypto.randomUUID();
    await pos(
      {
        kind: "sale",
        refType: "pos_sale",
        payload: { items: refundItems, returnOfEventId: source },
        lines: buildSaleLines({ items: refundItems, wallet: "inStoreSafe" }),
      },
      c,
      operation,
    );
    all.push(operation);
  }
  const totals = (
    await db.admin.query(
      "select account,sum(amount_delta) amount,sum(qty_delta) qty from ledger_lines where event_id=any($1) group by account",
      [all],
    )
  ).rows;
  assert.ok(totals.every((r) => Number(r.amount) === 0 && Number(r.qty) === 0));
  assert.deepEqual(await usage(d), { n: 1, total: "0.01" });
});
test("SPR-POS-07: receipt refunds reverse original customer spend even when the picker is empty or changed", async () => {
  const original = crypto.randomUUID(),
    other = crypto.randomUUID();
  for (const id of [original, other])
    await db.insert("customers", {
      id,
      store_id: db.store,
      device_id: db.device,
      name: "Synthetic customer",
      phone: "01000000000",
      address: "Synthetic",
    });
  const id = await product(2),
    input = sale(id),
    source = crypto.randomUUID();
  input.payload.items[0].quantity = 2;
  input.payload.customerId = original;
  input.lines = buildSaleLines({
    items: input.payload.items,
    wallet: "inStoreSafe",
    customerId: original,
  });
  await pos(input, c, source);
  const operations = [source];
  for (const customerId of [undefined, other]) {
    const refund = sale(id, null, 0, -1, source),
      operation = crypto.randomUUID();
    refund.payload.customerId = customerId;
    refund.lines = buildSaleLines({
      items: refund.payload.items,
      wallet: "inStoreSafe",
      customerId,
    });
    await pos(refund, c, operation);
    operations.push(operation);
    assert.equal(
      (
        await db.admin.query(
          "select payload::jsonb->>'customerId' id from ledger_events where id=$1",
          [operation],
        )
      ).rows[0].id,
      original,
    );
  }
  const totals = (
    await db.admin.query(
      "select subject_id,sum(amount_delta) n from ledger_lines where event_id=any($1) and account='customer_ltv' group by subject_id",
      [operations],
    )
  ).rows;
  assert.deepEqual(totals, [{ subject_id: original, n: "0" }]);
});
test("SPR-ECO-10: box-component edits fail closed without replacing the sold box with zero-priced components", async () => {
  const plain = await placedOrder({ discount: false, qty: 1 }),
    box = crypto.randomUUID(),
    id = crypto.randomUUID();
  await db.insert("products", {
    id: box,
    store_id: db.store,
    device_id: db.device,
    name: "Synthetic box",
    sku: box,
    isBundle: true,
    bundleItems: [{ productId: plain.productId, quantity: 1 }],
    unitPrice: 80,
  });
  const stockItems = [{ ...plain.items[0], unitPrice: 0, bundleId: box }],
    items = [
      { productId: box, bundleId: box, productName: "Synthetic box", quantity: 1, unitPrice: 80 },
    ],
    order = {
      ...plain.order,
      id,
      orderNumber: id,
      items,
      stockItems,
      totalAmount: 80,
      discountCodeId: null,
      discountAmount: 0,
      expectedCod: 80,
    };
  await plain.seller.query("select place_order($1,$2)", [
    order,
    db.event(
      "order_placed",
      "ecommerce_order",
      id,
      buildOrderPlacedLines({ items: stockItems, depositAmount: 0, wallet: "inStoreSafe" }),
    ),
  ]);
  const operation = crypto.randomUUID(),
    before = (await db.admin.query("select to_jsonb(o) data from orders o where id=$1", [id]))
      .rows[0].data;
  await assert.rejects(
    edit(
      {
        orderId: id,
        before: beforeEdit(order),
        patch: { items: stockItems, stockItems, totalAmount: 0, discountAmount: 0 },
      },
      plain.seller,
      operation,
    ),
    /NEXUS_ORDER_BOX_EDIT_UNIMPLEMENTED/,
  );
  assert.equal(await count("ledger_events", operation), 0);
  assert.deepEqual(
    (await db.admin.query("select to_jsonb(o) data from orders o where id=$1", [id])).rows[0].data,
    before,
  );
});
