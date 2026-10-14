import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { openBusinessDb, read } from "./helpers/business-db.mjs";
import { buildOpeningBalanceLines } from "../src/lib/ledger/audit.ts";
import { buildSaleLines } from "../src/lib/ledger/sales.ts";
import { costedReturnLine, remainingSaleLines } from "../src/lib/posReturn.ts";
import {
  buildOrderDeliveredLines,
  buildOrderCancelledLines,
  buildReturnConfirmedLines,
  buildOrderPlacedLines,
  buildCourierBatchSettlementLines,
} from "../src/lib/ledger/orders.ts";
import { batchSummary, courierSettlementAmounts } from "../src/lib/courierBatch.ts";
let db, c, p, box, original;
const migration = "supabase/migrations/20261011202254_final_features_bundle_exchange.sql";
const snapshot = (p) =>
  Object.fromEntries(
    ["name", "sku", "unitPrice", "bundleItems", "updated_at"].map((k) => [k, p[k]]),
  );
const edit = (input, id = crypto.randomUUID(), client = c) =>
  client
    .query("select record_bundle_edit($1,$2,$3,$4,$5) r", [
      id,
      db.store,
      db.device,
      "bundle_edit",
      input,
    ])
    .then((r) => r.rows[0].r);
const row = async (table, id) =>
  (await db.admin.query(`select to_jsonb(t) r from ${table} t where id=$1`, [id])).rows[0]?.r;
const orderBefore = (o) =>
  Object.fromEntries(
    ["items", "stockItems", "totalAmount", "discountAmount", "depositAmount"].map((k) => [k, o[k]]),
  );
before(async () => {
  db = await openBusinessDb();
  c = await db.client("ADMIN");
  p = crypto.randomUUID();
  box = crypto.randomUUID();
  await db.insert("products", {
    id: p,
    store_id: db.store,
    device_id: db.device,
    name: "Synthetic component",
    sku: p,
    quantity: 10,
    unitPrice: 30,
  });
  await (
    await db.client("ADMIN")
  ).query("select ledger_append($1)", [
    db.event(
      "stock_adjustment",
      "product",
      p,
      buildOpeningBalanceLines({ productId: p, quantity: 10, unitCost: 10 }),
    ),
  ]);
  await db.insert("products", {
    id: box,
    store_id: db.store,
    device_id: db.device,
    name: "Synthetic box",
    sku: box,
    isBundle: true,
    unitPrice: 80,
    bundleItems: [{ productId: p, quantity: 2 }],
  });
  await db.admin.query("select set_config('request.jwt.claim.sub',$1,false)", [db.users.ADMIN]);
  original = await row("products", box);
});
after(async () => {
  await db?.close();
});

test("FEATURE-BOX-04: POS uses edited recipe and price, then refunds that captured recipe after a second edit", async () => {
  const component = crypto.randomUUID(),
    bundle = crypto.randomUUID();
  await db.insert("products", {
    id: component,
    store_id: db.store,
    device_id: db.device,
    name: "POS component",
    sku: component,
    quantity: 10,
    unitPrice: 30,
  });
  await c.query("select ledger_append($1)", [
    db.event(
      "stock_adjustment",
      "product",
      component,
      buildOpeningBalanceLines({ productId: component, quantity: 10, unitCost: 10 }),
    ),
  ]);
  await db.insert("products", {
    id: bundle,
    store_id: db.store,
    device_id: db.device,
    name: "POS box",
    sku: bundle,
    isBundle: true,
    unitPrice: 80,
    bundleItems: [{ productId: component, quantity: 2 }],
  });
  const old = await row("products", bundle);
  const revised = (
    await edit({
      productId: bundle,
      before: snapshot(old),
      patch: {
        name: "POS box revised",
        sku: bundle,
        unitPrice: 90,
        bundleItems: [{ productId: component, quantity: 3 }],
      },
    })
  ).product;
  const items = [
    {
      productId: bundle,
      productName: revised.name,
      quantity: 1,
      unitPrice: revised.unitPrice,
      unitCost: 0,
      isBundle: true,
      bundleItems: revised.bundleItems.map((i) => ({ ...i, unitCost: 10 })),
    },
  ];
  const source = crypto.randomUUID();
  const pos = (input, id) =>
    c.query("select record_pos_sale($1,$2,$3,$4,$5)", [id, db.store, db.device, "pos_sale", input]);
  await pos(
    {
      kind: "sale",
      refType: "pos_sale",
      payload: { items },
      lines: buildSaleLines({ items, wallet: "inStoreSafe" }),
    },
    source,
  );
  assert.equal(await accountTotal("revenue", undefined, [source]), "9000");
  assert.equal(await accountTotal("cogs", undefined, [source]), "3000");
  const history = (
    await db.admin.query("select to_jsonb(l) r from ledger_lines l where event_id=$1 order by id", [
      source,
    ])
  ).rows;
  await edit({
    productId: bundle,
    before: snapshot(revised),
    patch: {
      name: "POS box newest",
      sku: bundle,
      unitPrice: 120,
      bundleItems: [{ productId: component, quantity: 1 }],
    },
  });
  assert.deepEqual(
    (
      await db.admin.query(
        "select to_jsonb(l) r from ledger_lines l where event_id=$1 order by id",
        [source],
      )
    ).rows,
    history,
  );
  const sale = { id: source, payload: { items } },
    savedLines = (
      await db.admin.query(
        "select account,subject_id,qty_delta,amount_delta from ledger_lines where event_id=$1",
        [source],
      )
    ).rows;
  const historical = costedReturnLine(sale, remainingSaleLines(sale)[0], savedLines, true),
    refundItems = [{ ...historical, quantity: -1 }],
    refund = crypto.randomUUID();
  assert.equal(historical.bundleItems[0].quantity, 3);
  assert.equal(historical.bundleItems[0].unitCost, 10);
  await pos(
    {
      kind: "sale",
      refType: "pos_sale",
      payload: { items: refundItems, returnOfEventId: source },
      lines: buildSaleLines({ items: refundItems, wallet: "inStoreSafe" }),
    },
    refund,
  );
  for (const account of ["stock", "wallet", "revenue", "cogs"])
    assert.equal(await accountTotal(account, undefined, [source, refund]), "0");
});
test("FEATURE-BOX-01: editing name/SKU/price/recipe is replay-safe and moves no stock, money or history", async () => {
  const before = await db.admin.query("select to_jsonb(l) r from ledger_lines l order by id");
  const id = crypto.randomUUID(),
    input = {
      productId: box,
      before: snapshot(original),
      patch: {
        name: "Edited box",
        sku: "EDITED",
        unitPrice: 90,
        bundleItems: [{ productId: p, quantity: 3 }],
      },
    };
  const first = await edit(input, id),
    again = await edit(input, id);
  assert.equal(first.product.name, "Edited box");
  assert.equal(again.replayed, true);
  assert.deepEqual(
    (await db.admin.query("select to_jsonb(l) r from ledger_lines l order by id")).rows,
    before.rows,
  );
  await assert.rejects(
    edit({ ...input, patch: { ...input.patch, unitPrice: 91 } }, id),
    /PAYLOAD_MISMATCH/,
  );
  await assert.rejects(edit(input), /جلسة أخرى/);
});
test("FEATURE-BOX-02: invalid/duplicate/foreign/archived/nested/variant components fail without changing catalogue", async () => {
  const before = await row("products", box),
    nested = box;
  const archived = crypto.randomUUID();
  await db.insert("products", {
    id: archived,
    store_id: db.store,
    device_id: db.device,
    name: "Archived",
    sku: archived,
    isActive: false,
  });
  const variant = crypto.randomUUID();
  await db.insert("products", {
    id: variant,
    store_id: db.store,
    device_id: db.device,
    name: "Variant",
    sku: variant,
    metadata: { variants: [{ name: "red", stock: 2 }] },
  });
  for (const recipe of [
    [],
    [{ productId: p, quantity: 0 }],
    [{ productId: p, quantity: 1.2 }],
    [
      { productId: p, quantity: 1 },
      { productId: p, quantity: 2 },
    ],
    [{ productId: crypto.randomUUID(), quantity: 1 }],
    [{ productId: archived, quantity: 1 }],
    [{ productId: nested, quantity: 1 }],
    [{ productId: variant, quantity: 1 }],
    [{ productId: variant, quantity: 1, variantName: "blue" }],
  ]) {
    await assert.rejects(
      edit({
        productId: box,
        before: snapshot(before),
        patch: { ...snapshot(before), bundleItems: recipe },
      }),
    );
    assert.deepEqual(await row("products", box), before);
  }
  const outsider = await db.client("POS_ECOMMERCE");
  await assert.rejects(
    edit(
      { productId: box, before: snapshot(before), patch: snapshot(before) },
      undefined,
      outsider,
    ),
    /غير مسموح/,
  );
});
test("FEATURE-BOX-03: pending bundle edits retain reserved recipe after catalogue edit; added stock is authoritative", async () => {
  const id = crypto.randomUUID(),
    stockItems = [
      {
        id: crypto.randomUUID(),
        productId: p,
        productName: "Component",
        quantity: 2,
        unitPrice: 0,
        unitCost: 10,
        bundleId: box,
      },
    ],
    items = [
      {
        id: crypto.randomUUID(),
        productId: box,
        productName: "Original box",
        quantity: 1,
        unitPrice: 80,
        bundleId: box,
      },
    ],
    order = {
      id,
      store_id: db.store,
      device_id: db.device,
      orderNumber: id,
      customerName: "Synthetic",
      customerPhone: "01000000000",
      items,
      stockItems,
      totalAmount: 80,
      shippingFee: 0,
      depositAmount: 0,
      expectedCod: 80,
      paymentMethod: "partial_cod",
    };
  await c.query("select place_order($1,$2)", [
    order,
    db.event("order_placed", "ecommerce_order", id, buildOrderPlacedLines({ items: stockItems })),
  ]);
  const old = await row("orders", id),
    operation = crypto.randomUUID(),
    patch = {
      items: [{ ...items[0], quantity: 2 }],
      stockItems: [{ ...stockItems[0], quantity: 4, unitCost: 999 }],
      totalAmount: 160,
      discountAmount: 0,
    };
  const input = { orderId: id, before: orderBefore(old), patch };
  const run = (input, id) =>
    c
      .query("select record_order_edit($1,$2,$3,$4,$5) r", [
        id,
        db.store,
        db.device,
        "order_edit",
        input,
      ])
      .then((r) => r.rows[0].r);
  const result = await run(input, operation);
  assert.equal(result.order.stockItems[0].quantity, 4);
  assert.equal(result.order.stockItems[0].unitCost, 10);
  assert.equal(result.order.items[0].productName, "Original box");
  assert.equal(result.order.cogsAmount, 40);
  assert.equal((await run(input, operation)).replayed, true);
  assert.equal(
    Number(
      (
        await db.admin.query(
          "select sum(qty_delta) n from ledger_lines where account='stock' and subject_id=$1",
          [p],
        )
      ).rows[0].n,
    ),
    6,
  );
  await assert.rejects(run(input, crypto.randomUUID()), /EDIT_STALE/);
  const tooMuch = {
    orderId: id,
    before: orderBefore(result.order),
    patch: {
      ...patch,
      items: [{ ...items[0], quantity: 20 }],
      stockItems: [{ ...stockItems[0], quantity: 40 }],
      totalAmount: 1600,
    },
  };
  await assert.rejects(run(tooMuch, crypto.randomUUID()), /STOCK_SHORT/);
  assert.deepEqual(await row("orders", id), result.order);
});

async function seedProduct({ quantity = 10, cost = 10, variants } = {}) {
  const id = crypto.randomUUID();
  await db.insert("products", {
    id,
    store_id: db.store,
    device_id: db.device,
    name: "Synthetic " + id,
    sku: id,
    unitPrice: 50,
    quantity,
    metadata: variants ? { variants } : null,
  });
  await c.query("select ledger_append($1)", [
    db.event(
      "stock_adjustment",
      "product",
      id,
      buildOpeningBalanceLines({ productId: id, quantity, unitCost: cost }),
    ),
  ]);
  return id;
}
async function sourceOrder({
  qty = 3,
  prices = [50, 30, 20],
  discount = 20,
  deposit = 20,
  bundle = false,
  variant,
} = {}) {
  const courier = crypto.randomUUID(),
    customer = crypto.randomUUID(),
    id = crypto.randomUUID();
  await db.insert("couriers", {
    id: courier,
    store_id: db.store,
    device_id: db.device,
    name: "Synthetic courier " + courier,
  });
  await db.insert("customers", {
    id: customer,
    store_id: db.store,
    device_id: db.device,
    name: "Synthetic customer",
    phone: "qa:" + customer,
    address: "Synthetic only",
  });
  const items = [],
    stockItems = [];
  for (let n = 0; n < prices.length; n++) {
    const product = await seedProduct({
      quantity: 10,
      variants: variant ? [{ name: variant, stock: 10 }] : undefined,
    });
    let sold = product;
    const quantity = n === 0 ? qty : 1;
    if (bundle && n === 0) {
      sold = crypto.randomUUID();
      await db.insert("products", {
        id: sold,
        store_id: db.store,
        device_id: db.device,
        name: "Synthetic bundle",
        sku: sold,
        isBundle: true,
        unitPrice: prices[n],
        bundleItems: [
          { productId: product, quantity: 2, ...(variant ? { variantName: variant } : {}) },
        ],
      });
    }
    items.push({
      id: crypto.randomUUID(),
      productId: bundle && n === 0 ? "" : sold,
      productName: "Sold " + n,
      quantity,
      unitPrice: prices[n],
      ...(bundle && n === 0 ? { bundleId: sold } : variant ? { variantName: variant } : {}),
    });
    stockItems.push({
      id: crypto.randomUUID(),
      productId: product,
      productName: "Component " + n,
      quantity: quantity * (bundle && n === 0 ? 2 : 1),
      unitPrice: bundle && n === 0 ? 0 : prices[n],
      unitCost: 10,
      ...(bundle && n === 0 ? { bundleId: sold } : {}),
      ...(variant ? { variantName: variant } : {}),
    });
  }
  const total = items.reduce((n, i) => n + i.quantity * i.unitPrice, 0) - discount;
  const order = {
    id,
    store_id: db.store,
    device_id: db.device,
    orderNumber: id,
    customerName: "Synthetic customer",
    customerPhone: "qa:" + customer,
    customerId: customer,
    items,
    stockItems,
    totalAmount: total,
    discountAmount: discount,
    shippingFee: 0,
    depositAmount: deposit,
    depositWallet: deposit ? "inStoreSafe" : null,
    expectedCod: total - deposit,
    paymentMethod: "partial_cod",
    courierId: courier,
  };
  await c.query("select place_order($1,$2)", [
    order,
    db.event(
      "order_placed",
      "ecommerce_order",
      id,
      buildOrderPlacedLines({ items: stockItems, depositAmount: deposit, wallet: "inStoreSafe" }),
    ),
  ]);
  await c.query("update orders set status='delivered' where id=$1", [id]);
  await c.query("select ledger_append($1)", [
    db.event(
      "order_delivered",
      "ecommerce_order",
      id,
      buildOrderDeliveredLines({
        items: stockItems,
        goodsTotal: total + discount,
        discountAmount: discount,
        codAmount: total - deposit,
        depositAmount: deposit,
        courierId: courier,
        customerId: customer,
      }),
    ),
  ]);
  // Ordinary placement on the old command uses its established UI mirror.
  if (variant)
    for (const stock of stockItems)
      await db.admin.query(
        "update products set metadata=jsonb_set(metadata,'{variants,0,stock}',to_jsonb(10-$2::int)) where id=$1",
        [stock.productId, stock.quantity],
      );
  return await row("orders", id);
}
async function replacementInput(
  source,
  {
    quantity = 1,
    price = 45,
    selected = 1,
    line = 0,
    product,
    bundle = false,
    cause = "customer",
    deposit = 0,
    variant,
  } = {},
) {
  product ??= await seedProduct();
  if (bundle) {
    const id = crypto.randomUUID();
    await db.insert("products", {
      id,
      store_id: db.store,
      device_id: db.device,
      name: "Replacement bundle",
      sku: id,
      isBundle: true,
      unitPrice: price,
      bundleItems: [{ productId: product, quantity: 2 }],
    });
    product = id;
  }
  const id = crypto.randomUUID(),
    items = [
      {
        id: crypto.randomUUID(),
        productId: bundle ? "" : product,
        productName: "Replacement",
        quantity,
        unitPrice: price,
        ...(bundle ? { bundleId: product } : variant ? { variantName: variant } : {}),
      },
    ];
  const order = {
    id,
    store_id: db.store,
    device_id: db.device,
    orderNumber: id,
    customerName: source.customerName,
    customerPhone: source.customerPhone,
    items,
    stockItems: [],
    totalAmount: price * quantity,
    discountAmount: 0,
    shippingFee: 0,
    depositAmount: deposit,
    depositWallet: deposit ? "inStoreSafe" : null,
    expectedCod: price * quantity - deposit,
    paymentMethod: "partial_cod",
    courierId: source.courierId,
  };
  return {
    order,
    event: db.event("order_placed", "ecommerce_order", id, []),
    originalOrderId: source.id,
    cause,
    selections: [{ lineId: source.items[line].id, quantity: selected }],
  };
}
const placeExchange = (input, id = crypto.randomUUID(), client = c) =>
  client
    .query("select record_exchange_place($1,$2,$3,$4,$5) r", [
      id,
      db.store,
      db.device,
      "exchange_place",
      input,
    ])
    .then((r) => r.rows[0].r);
const receiveExchange = (
  exchangeId,
  { id = crypto.randomUUID(), refundVia = "courier", wallet, returnFee = 0, client = c } = {},
) =>
  client
    .query("select record_exchange_return($1,$2,$3,$4,$5) r", [
      id,
      db.store,
      db.device,
      "exchange_return",
      { exchangeId, refundVia, wallet, returnFee },
    ])
    .then((r) => r.rows[0].r);
const accountTotal = async (account, subject, events) =>
  (
    await db.admin.query(
      "select coalesce(sum(amount_delta),0)::bigint n from ledger_lines where store_id=$1 and account=$2 and ($3::text is null or subject_id=$3) and ($4::text[] is null or event_id=any($4))",
      [db.store, account, subject ?? null, events ?? null],
    )
  ).rows[0].n;
test("FEATURE-EX-01: one of three units in a three-product order; immutable source, deferred stock, stable replay", async () => {
  const source = await sourceOrder(),
    before = await row("orders", source.id),
    input = await replacementInput(source),
    id = crypto.randomUUID();
  const history = (
    await db.admin.query(
      "select to_jsonb(l) r from ledger_lines l join ledger_events e on e.id=l.event_id where e.ref_id=$1 order by l.id",
      [source.orderNumber],
    )
  ).rows;
  const result = await placeExchange(input, id);
  assert.equal(result.order.exchangeDetails.refundPiastres, 4500);
  assert.equal(result.order.exchangeDetails.selections[0].lineId, source.items[0].id);
  assert.equal((await placeExchange(input, id)).replayed, true);
  assert.equal(
    Number(
      (
        await db.admin.query(
          "select sum(qty_delta) n from ledger_lines where account='stock' and subject_id=$1",
          [source.stockItems[0].productId],
        )
      ).rows[0].n,
    ),
    7,
    "original stock not restored until receipt",
  );
  const confirmation = crypto.randomUUID(),
    received = await receiveExchange(id, { id: confirmation });
  assert.equal(received.refundPiastres, 4500);
  assert.equal((await receiveExchange(id, { id: confirmation })).replayed, true);
  assert.equal(await accountTotal("revenue", undefined, [confirmation]), "-4500");
  assert.equal(await accountTotal("cogs", undefined, [confirmation]), "-1000");
  assert.equal(await accountTotal("customer_ltv", source.customerId, [confirmation]), "-4500");
  assert.equal(await accountTotal("wallet", undefined, [confirmation]), "0");
  assert.equal(await accountTotal("receivable_courier", source.courierId, [confirmation]), "-4500");
  assert.deepEqual(await row("orders", source.id), before);
  const still = (
    await db.admin.query(
      "select to_jsonb(l) r from ledger_lines l join ledger_events e on e.id=l.event_id where e.ref_id=$1 and e.kind<>'return_confirmed' order by l.id",
      [source.orderNumber],
    )
  ).rows;
  assert.deepEqual(still, history);
  assert.equal((await row("products", source.stockItems[0].productId)).quantity, 8);
  await assert.rejects(receiveExchange(id), /بالفعل/);
});
test("FEATURE-EX-02: lower/equal/higher replacement, deposit, courier settlement amounts reconcile to the two legs only", async () => {
  for (const price of [40, 45, 60]) {
    const source = await sourceOrder(),
      input = await replacementInput(source, { price, deposit: 5 }),
      operation = crypto.randomUUID();
    const placed = await placeExchange(input, operation),
      ret = crypto.randomUUID();
    await receiveExchange(operation, { id: ret });
    const o = placed.order,
      delivered = db.event(
        "order_delivered",
        "ecommerce_order",
        o.orderNumber,
        buildOrderDeliveredLines({
          items: o.stockItems,
          goodsTotal: o.totalAmount,
          depositAmount: o.depositAmount,
          codAmount: o.expectedCod,
          courierId: o.courierId,
          customerId: o.customerId,
        }),
      );
    await c.query("update orders set status='delivered' where id=$1", [o.id]);
    await c.query("select ledger_append($1)", [delivered]);
    assert.equal(
      await accountTotal("revenue", undefined, [ret, delivered.id]),
      String((price - 45) * 100),
    );
    assert.equal(
      await accountTotal("customer_ltv", source.customerId, [ret, delivered.id]),
      String((price - 45) * 100),
    );
    assert.equal(
      Number(await accountTotal("wallet", undefined, [operation, ret, delivered.id])) +
        Number(await accountTotal("receivable_courier", undefined, [operation, ret, delivered.id])),
      (price - 45) * 100,
    );
    if (price === 60) {
      const confirmed = await row("orders", o.id);
      const summary = batchSummary([confirmed], price - 45 - o.depositAmount);
      assert.equal(summary.shortfall, 0);
      const settlement = db.event("courier_settlement", "courier_batch", crypto.randomUUID(),
        buildCourierBatchSettlementLines({ courierId: o.courierId, wallet: "inStoreSafe",
          orders: [{ orderId: o.id, ...courierSettlementAmounts(confirmed) }],
          netReceived: summary.expectedNet, expectedFees: summary.expectedFees }));
      await c.query("select ledger_append($1)", [settlement]);
      assert.equal(await accountTotal("receivable_courier", o.courierId, [ret, delivered.id, settlement.id]), "0");
      assert.equal(await accountTotal("expense", undefined, [settlement.id]), "0");
      assert.equal(await accountTotal("wallet", undefined, [operation, ret, delivered.id, settlement.id]), String((price - 45) * 100));
    }
  }
});
test("FEATURE-EX-03: bundle→product and product→bundle return historical component recipe/cost", async () => {
  for (const oldBundle of [true, false]) {
    const source = await sourceOrder({ bundle: oldBundle }),
      input = await replacementInput(source, { bundle: !oldBundle }),
      id = crypto.randomUUID();
    const placed = await placeExchange(input, id);
    assert.ok(placed.order.stockItems.length);
    if (oldBundle) {
      const b = await row("products", source.items[0].bundleId);
      await edit({
        productId: b.id,
        before: snapshot(b),
        patch: { ...snapshot(b), bundleItems: [{ productId: await seedProduct(), quantity: 3 }] },
      });
    }
    const event = crypto.randomUUID();
    await receiveExchange(id, { id: event, refundVia: "wallet", wallet: "inStoreSafe" });
    assert.equal(
      await accountTotal("stock", source.stockItems[0].productId, [event]),
      oldBundle ? "2000" : "1000",
    );
    assert.equal(
      await accountTotal("cogs", source.stockItems[0].productId, [event]),
      oldBundle ? "-2000" : "-1000",
    );
  }
});
test("FEATURE-EX-04: multiple pending/confirmed exchanges never exceed original units; cancel releases only unreceived claims", async () => {
  const source = await sourceOrder({ qty: 2, prices: [50], discount: 0, deposit: 0 });
  const first = crypto.randomUUID(),
    second = crypto.randomUUID();
  const a = await placeExchange(await replacementInput(source), first);
  await placeExchange(await replacementInput(source), second);
  await assert.rejects(placeExchange(await replacementInput(source)), /الكمية محجوزة/);
  await c.query("select cancel_order($1,$2,$3)", [
    a.order.id,
    "customer",
    db.event(
      "order_cancelled",
      "ecommerce_order",
      a.order.orderNumber,
      buildOrderCancelledLines({ items: a.order.stockItems }),
    ),
  ]);
  assert.equal((await row("orders", a.order.id)).exchangeDetails.status, "cancelled");
  const third = crypto.randomUUID();
  await placeExchange(await replacementInput(source), third);
  await receiveExchange(third);
  await assert.rejects(placeExchange(await replacementInput(source)), /الكمية محجوزة/);
  await assert.rejects(receiveExchange(first), /ملغي/);
});
test("FEATURE-EX-05: malformed selection, foreign source, stale source cost, failed placement and failed confirmation rollback every fact", async () => {
  const source = await sourceOrder(),
    good = await replacementInput(source);
  for (const selections of [
    [],
    [{ lineId: source.items[0].id, quantity: 0 }],
    [{ lineId: source.items[0].id, quantity: 1.2 }],
    [{ lineId: "foreign-line", quantity: 1 }],
    Array(2).fill({ lineId: source.items[0].id, quantity: 1 }),
  ]) {
    const id = crypto.randomUUID();
    await assert.rejects(placeExchange({ ...good, selections }, id));
    assert.equal(await row("orders", good.order.id), undefined);
    assert.equal(
      (
        await db.admin.query(
          "select count(*) n from financial_private.order_exchanges where id=$1",
          [id],
        )
      ).rows[0].n,
      "0",
    );
  }
  await assert.rejects(placeExchange({ ...good, originalOrderId: crypto.randomUUID() }), /تجزئة/);
  const id = crypto.randomUUID();
  await assert.rejects(placeExchange({ ...good, order: { ...good.order, expectedCod: 999 } }, id));
  assert.equal(
    (
      await db.admin.query("select count(*) n from financial_private.order_exchanges where id=$1", [
        id,
      ])
    ).rows[0].n,
    "0",
  );
  const placed = await placeExchange(good, id),
    snapshot = await row("orders", placed.order.id);
  for (const options of [
    { returnFee: -1 },
    { refundVia: "wallet", wallet: "invalid" },
    { returnFee: 0.001 },
  ])
    await assert.rejects(receiveExchange(id, options));
  assert.deepEqual(await row("orders", placed.order.id), snapshot);
  await assert.rejects(
    c.query("update orders set status='returned' where id=$1", [source.id]),
    /وحدات استبدال/,
  );
  await assert.rejects(
    c.query("select ledger_append($1)", [
      db.event(
        "return_confirmed",
        "ecommerce_order",
        source.orderNumber,
        buildReturnConfirmedLines({
          items: source.stockItems,
          refundAmount: source.totalAmount,
          refundVia: "wallet",
          wallet: "inStoreSafe",
          revenueAmount: source.totalAmount,
          customerId: source.customerId,
        }),
      ),
    ]),
    /لا يمكن إرجاع/,
  );
});
test("FEATURE-EX-06: concurrent claims of last original unit serialize; different payload under same operation is rejected", async () => {
  const source = await sourceOrder({ qty: 1, prices: [50], discount: 0, deposit: 0 }),
    other = await db.client("ECOMMERCE_ONLY");
  const a = await replacementInput(source),
    b = await replacementInput(source),
    id = crypto.randomUUID();
  const results = await Promise.allSettled([
    placeExchange(a, id),
    placeExchange(b, crypto.randomUUID(), other),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  if (results[0].status === "fulfilled")
    await assert.rejects(
      placeExchange({ ...a, selections: [{ lineId: source.items[0].id, quantity: 2 }] }, id),
      /PAYLOAD_MISMATCH/,
    );
});
test("FEATURE-EX-07: indivisible discount piastres and original component cost are exhausted exactly over three partial exchanges", async () => {
  const source = await sourceOrder({ qty: 3, prices: [0.01], discount: 0.01, deposit: 0 }),
    events = [];
  for (let n = 0; n < 3; n++) {
    const id = crypto.randomUUID();
    await placeExchange(await replacementInput(source, { price: 0.01 }), id);
    const event = crypto.randomUUID();
    await receiveExchange(id, { id: event, refundVia: "wallet", wallet: "inStoreSafe" });
    events.push(event);
  }
  assert.equal(await accountTotal("revenue", undefined, events), "-2");
  assert.equal(await accountTotal("wallet", undefined, events), "-2");
  assert.equal(await accountTotal("stock", source.stockItems[0].productId, events), "3000");
});
test("FEATURE-EX-08: cause controls extra-trip pass-through, shop expense and courier compensation, without double-booking difference", async () => {
  for (const cause of ["customer", "shop", "courier"]) {
    const source = await sourceOrder(),
      input = await replacementInput(source, { cause }),
      id = crypto.randomUUID();
    await placeExchange(input, id);
    const event = crypto.randomUUID();
    await receiveExchange(id, { id: event, returnFee: 5 });
    assert.equal(await accountTotal("payable_courier", source.courierId, [event]), "500");
    assert.equal(
      await accountTotal("receivable_courier", source.courierId, [event]),
      cause === "shop" ? "-4500" : "-4000",
    );
    assert.equal(await accountTotal("expense", undefined, [event]), cause === "shop" ? "500" : "0");
  }
  const source = await sourceOrder(),
    input = await replacementInput(source, { cause: "shop" }),
    staff = await db.client("POS_ECOMMERCE");
  await assert.rejects(placeExchange(input, crypto.randomUUID(), staff), /للمدير/);
});
test("FEATURE-EX-09: variant stock is committed once and missing variant stock rolls back every reservation under concurrency", async () => {
  const source = await sourceOrder({ variant: "red" }),
    id = crypto.randomUUID();
  await placeExchange(await replacementInput(source), id);
  await receiveExchange(id);
  assert.equal(
    (await row("products", source.stockItems[0].productId)).metadata.variants[0].stock,
    8,
  );
  const limited = await seedProduct({
      quantity: 10,
      variants: [
        { name: "red", stock: 1 },
        { name: "blue", stock: 9 },
      ],
    }),
    a = await sourceOrder(),
    b = await sourceOrder();
  const ia = await replacementInput(a, { product: limited, variant: "red" }),
    ib = await replacementInput(b, { product: limited, variant: "red" }),
    other = await db.client("ECOMMERCE_ONLY");
  const outcome = await Promise.allSettled([
    placeExchange(ia),
    placeExchange(ib, crypto.randomUUID(), other),
  ]);
  assert.equal(outcome.filter((o) => o.status === "fulfilled").length, 1);
  assert.equal((await row("products", limited)).metadata.variants[0].stock, 0);
  assert.equal((await row("products", limited)).quantity, 9);
  assert.equal(
    [await row("orders", ia.order.id), await row("orders", ib.order.id)].filter(Boolean).length,
    1,
  );
});
test("FEATURE-EX-10: late return failure rolls document, unit claims, return record, ledger and mirrors back; retry then commits once", async () => {
  const source = await sourceOrder(),
    id = crypto.randomUUID(),
    placed = await placeExchange(await replacementInput(source), id),
    event = crypto.randomUUID();
  const productBefore = await row("products", source.stockItems[0].productId);
  await db.admin.query(
    `create function public.synthetic_feature_failure() returns trigger language plpgsql as $$ begin if NEW.ref_type='ecommerce_exchange' then raise exception 'synthetic late failure' using errcode='23514'; end if;return NEW;end $$;create trigger synthetic_feature_failure before insert on ledger_events for each row execute function public.synthetic_feature_failure()`,
  );
  await assert.rejects(receiveExchange(id, { id: event }), /synthetic late failure/);
  assert.deepEqual(await row("orders", placed.order.id), placed.order);
  assert.deepEqual(await row("products", source.stockItems[0].productId), productBefore);
  assert.equal(
    (await db.admin.query("select status from financial_private.order_exchanges where id=$1", [id]))
      .rows[0].status,
    "pending",
  );
  assert.equal(await row("return_records", "exchange:" + id), undefined);
  assert.equal(await row("ledger_events", event), undefined);
  await db.admin.query(
    "drop trigger synthetic_feature_failure on ledger_events;drop function synthetic_feature_failure()",
  );
  const second = await db.client("ECOMMERCE_ONLY");
  const results = await Promise.all([
    receiveExchange(id, { id: event }),
    receiveExchange(id, { id: event, client: second }),
  ]);
  assert.equal(results.filter((x) => x.replayed).length, 1);
  assert.equal(await accountTotal("revenue", undefined, [event]), "-4500");
});
test("FEATURE-EX-11: source amount/cost/customer drift and foreign replacement product cannot revalue immutable history", async () => {
  const source = await sourceOrder(),
    input = await replacementInput(source),
    history = (await db.admin.query("select to_jsonb(l) r from ledger_lines l order by id")).rows;
  for (const changed of [
    { totalAmount: source.totalAmount + 1 },
    { stockItems: source.stockItems.map((i) => ({ ...i, unitCost: 999 })) },
    { customerId: crypto.randomUUID() },
  ]) {
    for (const [key, value] of Object.entries(changed))
      await db.admin.query(`update orders set "${key}"=$2 where id=$1`, [
        source.id,
        Array.isArray(value) ? JSON.stringify(value) : value,
      ]);
    await assert.rejects(placeExchange(input), /لا تطابق/);
    for (const key of Object.keys(changed))
      await db.admin.query(`update orders set "${key}"=$2 where id=$1`, [
        source.id,
        Array.isArray(source[key]) ? JSON.stringify(source[key]) : source[key],
      ]);
  }
  const foreignStore = crypto.randomUUID(),
    foreign = crypto.randomUUID();
  await db.admin.query("insert into stores(id,name) values($1,$2)", [
    foreignStore,
    "Other isolated tenant",
  ]);
  await db.insert("products", {
    id: foreign,
    store_id: foreignStore,
    device_id: db.device,
    name: "Foreign",
    sku: foreign,
    unitPrice: 45,
  });
  await assert.rejects(
    placeExchange({
      ...input,
      order: { ...input.order, items: [{ ...input.order.items[0], productId: foreign }] },
    }),
    /لا يخص المتجر/,
  );
  assert.deepEqual(
    (await db.admin.query("select to_jsonb(l) r from ledger_lines l order by id")).rows,
    history,
  );
});
test("FEATURE-EX-12: courier-caused replacement delivery compensates the carrier fee without charging customer or inventing expense", async () => {
  const source = await sourceOrder(),
    input = await replacementInput(source, { cause: "courier", price: 60 });
  input.order.courierFee = 5;
  const id = crypto.randomUUID(),
    placed = await placeExchange(input, id),
    event = crypto.randomUUID();
  await receiveExchange(id, { id: event });
  const o = placed.order,
    delivery = db.event(
      "order_delivered",
      "ecommerce_order",
      o.orderNumber,
      buildOrderDeliveredLines({
        items: o.stockItems,
        goodsTotal: o.totalAmount,
        codAmount: o.expectedCod,
        courierId: o.courierId,
        customerId: o.customerId,
        courierFee: 5,
        courierCompensation: true,
      }),
    );
  await c.query("update orders set status='delivered' where id=$1", [o.id]);
  await c.query("select ledger_append($1)", [delivery]);
  assert.equal(await accountTotal("revenue", undefined, [event, delivery.id]), "1500");
  assert.equal(await accountTotal("expense", undefined, [event, delivery.id]), "0");
  assert.equal(await accountTotal("receivable_courier", o.courierId, [event, delivery.id]), "2000");
  assert.equal(await accountTotal("payable_courier", o.courierId, [event, delivery.id]), "500");
});
test("FEATURE-EX-13: replacement discount use is atomic with original-unit reservation and remains cumulative on cancellation", async () => {
  const source = await sourceOrder(),
    input = await replacementInput(source, { price: 50 }),
    code = crypto.randomUUID();
  await db.insert("discount_codes", {
    id: code,
    store_id: db.store,
    device_id: db.device,
    code: code,
    type: "fixed",
    value: 5,
    maxUses: 1,
  });
  input.order.discountCodeId = code;
  input.order.discountAmount = 5;
  input.order.totalAmount = 45;
  input.order.expectedCod = 45;
  const id = crypto.randomUUID(),
    placed = await placeExchange(input, id);
  await placeExchange(input, id);
  assert.equal((await row("discount_codes", code)).usedCount, 1);
  assert.equal((await row("discount_codes", code)).totalDiscount, 5);
  await c.query("select cancel_order($1,$2,$3)", [
    placed.order.id,
    "customer",
    db.event(
      "order_cancelled",
      "ecommerce_order",
      placed.order.orderNumber,
      buildOrderCancelledLines({ items: placed.order.stockItems }),
    ),
  ]);
  assert.equal((await row("discount_codes", code)).usedCount, 1);
  const next = await replacementInput(source, { price: 50 });
  next.order.discountCodeId = code;
  next.order.discountAmount = 5;
  next.order.totalAmount = 45;
  next.order.expectedCod = 45;
  await assert.rejects(placeExchange(next), /NEXUS_CODE_EXHAUSTED/);
  assert.equal(await row("orders", next.order.id), undefined);
});

test("FEATURE-EX-14: preserved COGS cannot hide source quantity drift; claimed source identities stay immutable", async () => {
  const source = await sourceOrder(),
    input = await replacementInput(source);
  const items = source.items.map((x, i) =>
    i === 0 ? { ...x, quantity: x.quantity * 10, unitPrice: x.unitPrice / 10 } : x,
  );
  const stock = source.stockItems.map((x, i) =>
    i === 0 ? { ...x, quantity: x.quantity * 10, unitCost: x.unitCost / 10 } : x,
  );
  await c.query('update orders set items=$2,"stockItems"=$3 where id=$1', [
    source.id,
    JSON.stringify(items),
    JSON.stringify(stock),
  ]);
  await assert.rejects(placeExchange(input), /كمية حجز الطلب القديم/);
  assert.equal(await row("orders", input.order.id), undefined);
  await c.query('update orders set items=$2,"stockItems"=$3 where id=$1', [
    source.id,
    JSON.stringify(source.items),
    JSON.stringify(source.stockItems),
  ]);
  await placeExchange(input);
  const history = (await db.admin.query("select to_jsonb(l) r from ledger_lines l order by id"))
    .rows;
  await assert.rejects(
    c.query("update orders set items=$2 where id=$1", [source.id, JSON.stringify(items)]),
    /بنود وهوية الطلب الأصلي/,
  );
  await assert.rejects(
    c.query('update orders set "customerId"=null where id=$1', [source.id]),
    /بنود وهوية الطلب الأصلي/,
  );
  assert.deepEqual(await row("orders", source.id), source);
  assert.deepEqual(
    (await db.admin.query("select to_jsonb(l) r from ledger_lines l order by id")).rows,
    history,
  );
});
