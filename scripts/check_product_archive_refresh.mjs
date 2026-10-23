import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openBusinessDb, read, ROOT } from "./helpers/business-db.mjs";
import { uiHarness } from "./helpers/ui-harness.mjs";
import { buildImportPlan } from "../src/lib/productImportWorkflow.ts";

// Real import/archive contracts on disposable captured-schema PostgreSQL and
// the real cloudList/pageAll/field mapping. Only the Supabase transport and
// React store boundary are adapted; no Production connection or data is used.
test("PG17.6 + actual ProductsPage: Import → Archive → Refresh → Restore → Refresh preserves identity, stock and history", async () => {
  const db = await openBusinessDb();
  let h;
  try {
    assert.match(db.version, /PostgreSQL 17\.6/);
    for (const file of fs
      .readdirSync(path.join(ROOT, "supabase/migrations"))
      .filter((f) => f >= "20261012000000" && f <= "20261023161107_product_archive_safe_import.sql")
      .sort()) {
      await db.admin.query(read("supabase/migrations/" + file));
    }
    const client = await db.client("ADMIN");
    const controlId = crypto.randomUUID();
    await client.query("select record_product_catalog($1,$2,$3,'product_catalog',$4)", [
      crypto.randomUUID(),
      db.store,
      db.device,
      {
        action: "create",
        product: {
          id: controlId,
          name: "Untouched existing product",
          sku: "CONTROL",
          quantity: 3,
          unitPrice: 4,
        },
        unitCost: 2,
      },
    ]);
    const rawProduct = async (id) =>
      (await db.admin.query("select * from products where store_id=$1 and id=$2", [db.store, id]))
        .rows[0];
    const controlBefore = await rawProduct(controlId);
    const history = async () => ({
      events: (
        await db.admin.query("select * from ledger_events where store_id=$1 order by id", [
          db.store,
        ])
      ).rows,
      lines: (
        await db.admin.query("select * from ledger_lines where store_id=$1 order by id", [db.store])
      ).rows,
      applications: (
        await db.admin.query(
          "select * from financial_private.stock_applications where store_id=$1 order by event_id",
          [db.store],
        )
      ).rows,
    });
    const commands = async () =>
      (
        await db.admin.query(
          "select count(*)::int n from financial_private.catalog_commands where store_id=$1",
          [db.store],
        )
      ).rows[0].n;
    let pendingRpc;
    const sb = {
      from(table) {
        assert.equal(table, "products");
        const conditions = [],
          values = [];
        let range = null,
          single = false;
        const query = {
          select() {
            return this;
          },
          range(from, to) {
            range = [from, to];
            return this;
          },
          is(column, value) {
            assert.equal(column, "deleted_at");
            assert.equal(value, null);
            conditions.push("deleted_at is null");
            return this;
          },
          eq(column, value) {
            assert.ok(["id", "store_id"].includes(column));
            values.push(value);
            conditions.push(`${column}=$${values.length}`);
            return this;
          },
          single() {
            single = true;
            return this;
          },
          async then(resolve, reject) {
            try {
              let sql =
                "select * from products" +
                (conditions.length ? " where " + conditions.join(" and ") : "") +
                " order by id";
              if (range) {
                values.push(range[1] - range[0] + 1, range[0]);
                sql += ` limit $${values.length - 1} offset $${values.length}`;
              }
              // The authenticated DB client enforces the existing tenant RLS.
              const rows = (await client.query(sql, values)).rows;
              return resolve({ data: single ? rows[0] : rows, error: null });
            } catch (error) {
              return reject(error);
            }
          },
        };
        return query;
      },
      rpc(name, p) {
        pendingRpc = (async () => {
          if (name === "read_product_archive_status") {
            return {
              data: (
                await client.query("select read_product_archive_status($1,$2) r", [
                  p.p_store,
                  p.p_product_id,
                ])
              ).rows[0].r,
              error: null,
            };
          }
          assert.ok(["record_product_import", "record_product_archive"].includes(name));
          const data = (
            await client.query(`select ${name}($1,$2,$3,$4,$5) r`, [
              p.p_id,
              p.p_store,
              p.p_device,
              p.p_command,
              p.p_input,
            ])
          ).rows[0].r;
          return { data, error: null };
        })();
        return pendingRpc;
      },
    };
    async function boot() {
      let state = { products: [] },
        pendingCommand;
      const listeners = new Set(),
        stock = new Map();
      const auth = {
        userRole: "ADMIN",
        permissionsVerified: true,
        accessRevision: 1,
        session: { user: { id: db.users.ADMIN } },
      };
      const useBusinessStore = Object.assign(
        (select = (s) => s) =>
          h.React.useSyncExternalStore(
            (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            () => select(state),
          ),
        {
          getState: () => state,
          setState(patch) {
            state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
            for (const listener of listeners) listener();
          },
        },
      );
      h = uiHarness({
        "@/lib/supabase": { getSupabaseClient: () => sb },
        "@/services/api/storeContext": {
          getSyncIdentity: async () => ({ storeId: db.store, deviceId: db.device }),
        },
        "@/store/useAuthStore": {
          useAuthStore: Object.assign((select) => select(auth), { getState: () => auth }),
        },
        "@/store/useBusinessStore": { useBusinessStore },
        "@/lib/ledger/useStock": {
          useStock: () => ({
            qtyOf: (id) => stock.get(id)?.qty ?? 0,
            costOf: (id) => stock.get(id)?.cost ?? 0,
            loading: false,
            error: null,
            refresh() {},
          }),
        },
        "@/components/ui/collection-gate": {
          CollectionGate: ({ children }) => children,
          useCollectionStatus: () => ({ read: { loading: false, error: null } }),
        },
        // Unused purchase/import panels are outside this archive-reader check.
        "./QuickRestockDialog": { QuickRestockDialog: () => null },
        "./BulkImportProduct": { BulkImportProduct: () => null },
      });
      for (const [method, action] of [
        ["archiveProduct", "archive"],
        ["restoreProduct", "restore"],
      ]) {
        state[method] = (id) => {
          pendingCommand = (async () => {
            const saved = await h.load("src/lib/productArchive.ts").changeProductArchive(
              state.products.find((p) => p.id === id),
              action,
            );
            useBusinessStore.setState({
              products: state.products.map((p) => (p.id === id ? saved : p)),
            });
          })();
          return pendingCommand;
        };
      }
      const rows = await h.load("src/services/cloudData.ts").cloudList("products");
      useBusinessStore.setState({ products: rows });
      const totals = (
        await db.admin.query(
          "select subject_id id,sum(qty_delta)::numeric qty,sum(amount_delta)::numeric amount from ledger_lines where store_id=$1 and account='stock' group by subject_id",
          [db.store],
        )
      ).rows;
      for (const r of totals)
        stock.set(r.id, {
          qty: Number(r.qty),
          cost: Number(r.qty) ? Number(r.amount) / 100 / Number(r.qty) : 0,
        });
      h.load("src/lib/ledger/stockSnapshot.ts").setStockSnapshot(
        new Map(totals.map((r) => [r.id, Number(r.qty)])),
      );
      return {
        state: () => state,
        settled: () => pendingCommand,
        runImport: (plan) =>
          h
            .load("src/lib/productImportCommand.ts")
            .executeProductImport(plan, () => {}, db.store, "owned"),
        render: () => h.render(h.load("src/components/products/ProductsPage.tsx").ProductsPage),
      };
    }
    const headers = [
      "SKU / كود المنتج",
      "اسم المنتج",
      "تكلفة الوحدة",
      "سعر البيع القطاعي",
      "الكمية",
    ];
    const row = ["ARCHIVE-REFRESH", "Archive refresh synthetic product", 1.25, 2.5, 2];
    const plan = buildImportPlan([headers, row]);
    assert.deepEqual(plan.errors, []);
    let session = await boot();
    assert.deepEqual(await session.runImport(plan), {
      created: 1,
      recovered: 0,
      skipped: 0,
      units: 2,
    });
    const id = session.state().products.find((p) => p.sku === row[0]).id;
    const imported = await rawProduct(id),
      ledger = await history();
    const opening = ledger.lines.filter((l) => l.subject_id === id && l.account === "stock");
    assert.equal(opening.length, 1);
    assert.equal(Number(opening[0].qty_delta), 2);
    assert.equal(Number(opening[0].amount_delta), 250);
    // Discard all in-memory state before exercising the actual React screen.
    await h.cleanup();
    session = await boot();
    let user = await session.render();
    assert.match(document.body.textContent, /النشطة \(2\)/);
    const productRow = h.getByText(document.body, row[1]).closest("tr");
    await h.perform(() => user.click(h.getByTitle(productRow, "مسح أو أرشفة")));
    await h.perform(() => pendingRpc);
    const confirm = h.getByRole(document.body, "button", { name: "تأكيد الأرشفة" });
    await h.perform(async () => {
      await user.click(confirm);
      await session.settled();
    });
    assert.match(document.body.textContent, /المؤرشفة \(1\)/);
    assert.notEqual((await rawProduct(id)).deleted_at, null);
    assert.deepEqual(await history(), ledger);
    await h.cleanup();
    session = await boot();
    // This fails on 786e928: the real cloudList silently discards the row.
    assert.equal(
      session.state().products.length,
      2,
      "refresh must retain the archived product, not only the active shelf",
    );
    user = await session.render();
    assert.equal(
      h.queryByText(document.body, row[1]),
      null,
      "archived records remain off the active shelf",
    );
    assert.match(
      document.body.textContent,
      /٨٫٥ ج\.م/,
      "valuation retains the archived 250 piastres after refresh",
    );
    await h.perform(() =>
      user.click(h.getByRole(document.body, "button", { name: "المؤرشفة (1)" })),
    );
    assert.ok(h.getByText(document.body, row[1]));
    assert.equal(h.queryByText(document.body, controlBefore.name), null);
    // Same-file and changed-name imports must not resurrect or duplicate it.
    const archived = await rawProduct(id),
      count = await commands();
    let result;
    await h.perform(async () => {
      result = await session.runImport(plan);
    });
    assert.deepEqual(result, { created: 0, recovered: 1, skipped: 0, units: 0 });
    await h.perform(async () => {
      result = await session.runImport(
        buildImportPlan([headers, [row[0], "Do not overwrite", 9, 10, 5]]),
      );
    });
    assert.deepEqual(result, { created: 0, recovered: 0, skipped: 1, units: 0 });
    assert.deepEqual(await rawProduct(id), archived);
    assert.equal(await commands(), count);
    await h.perform(async () => {
      await user.click(h.getByRole(document.body, "button", { name: "استرجاع" }));
      await session.settled();
    });
    assert.equal((await rawProduct(id)).deleted_at, null);
    assert.match(document.body.textContent, /المؤرشفة \(0\)/);
    await h.cleanup();
    session = await boot();
    await session.render();
    assert.match(document.body.textContent, /النشطة \(2\)/);
    assert.match(document.body.textContent, /المؤرشفة \(0\)/);
    assert.ok(h.getByText(document.body, row[1]));
    assert.equal(session.state().products.length, 2);
    assert.equal(new Set(session.state().products.map((p) => p.id)).size, 2);
    assert.equal(
      (await db.admin.query("select count(*)::int n from products where store_id=$1", [db.store]))
        .rows[0].n,
      2,
    );
    const restored = await rawProduct(id);
    const { updated_at: beforeStamp, ...beforeFields } = imported;
    const { updated_at: afterStamp, ...afterFields } = restored;
    assert.ok(Number(afterStamp) > Number(beforeStamp));
    assert.deepEqual(
      afterFields,
      beforeFields,
      "only the lifecycle revision changed after restoration",
    );
    assert.deepEqual(await rawProduct(controlId), controlBefore);
    assert.deepEqual(
      await history(),
      ledger,
      "archive, refresh, skip and restore cannot change any stock application or immutable financial record",
    );
  } finally {
    if (h) await h.cleanup();
    await db.close();
  }
});

test("actual cloudList retains archived products across page boundaries while ordinary tombstones stay filtered", async () => {
  const rows = Array.from({ length: 1002 }, (_, i) => ({
    id: String(i),
    deleted_at: i % 2 ? 123 : null,
  }));
  const h = uiHarness({
    "@/lib/supabase": {
      getSupabaseClient: () => ({
        from: () => {
          let range,
            activeOnly = false;
          return {
            select() {
              return this;
            },
            range(from, to) {
              range = [from, to];
              return this;
            },
            is(column, value) {
              assert.equal(column, "deleted_at");
              assert.equal(value, null);
              activeOnly = true;
              return this;
            },
            then(resolve) {
              return resolve({
                data: (activeOnly ? rows.filter((p) => p.deleted_at == null) : rows).slice(
                  range[0],
                  range[1] + 1,
                ),
                error: null,
              });
            },
          };
        },
      }),
    },
    "@/store/useAuthStore": {
      useAuthStore: {
        getState: () => ({
          userRole: "ADMIN",
          accessRevision: 1,
          session: { user: { id: "synthetic" } },
        }),
      },
    },
  });
  try {
    const { cloudList } = h.load("src/services/cloudData.ts");
    const products = await cloudList("products");
    assert.equal(products.length, 1002);
    assert.equal(products.filter((p) => p.deleted_at != null).length, 501);
    assert.equal(new Set(products.map((p) => p.id)).size, 1002);
    assert.equal((await cloudList("customers")).length, 501);
  } finally {
    await h.cleanup();
  }
});
