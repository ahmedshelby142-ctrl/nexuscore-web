// Synthetic fixtures and fixed loopback connections only; never reads cloud env.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import pg from "pg";
import EmbeddedPostgres from "embedded-postgres";
import { toPiastres } from "../../src/lib/ledger/money.ts";
export const ROOT = path.resolve(import.meta.dirname, "../..");
export const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
export const MIGRATION = "supabase/migrations/20261011150322_final_v1_financial_integrity.sql";
export const FEATURES_MIGRATION="supabase/migrations/20261011202254_final_features_bundle_exchange.sql";
export async function openBusinessDb({ migrate = true, baselineOnly = false } = {}) {
  const store = crypto.randomUUID(),
    device = crypto.randomUUID();
  const users = Object.fromEntries(
    ["ADMIN", "ACCOUNTANT", "POS_ECOMMERCE", "ECOMMERCE_ONLY"].map((role) => [
      role,
      crypto.randomUUID(),
    ]),
  );
  const port = await new Promise((resolve) => {
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1", () => {
      const p = socket.address().port;
      socket.close(() => resolve(p));
    });
  });
  const evidence = path.join(ROOT, "logs/final-v1-sprint");
  fs.mkdirSync(evidence, { recursive: true });
  // Optional local storage override for NEW disposable databases only. Existing
  // databases/evidence stay in place; no connection URL or cloud credentials.
  const dataRoot=process.env.NEXUS_QA_PG_DATA_ROOT
    ? path.resolve(process.env.NEXUS_QA_PG_DATA_ROOT) : evidence;
  fs.mkdirSync(dataRoot,{recursive:true});
  const dir = fs.mkdtempSync(path.join(dataRoot, "pg-"));
  const clients = [];
  let control, server, admin;
  const connect = async () => {
    const c = new pg.Client({
      host: "127.0.0.1",
      port,
      user: "postgres",
      database: "postgres",
      password: "synthetic-only",
    });
    await c.connect();
    clients.push(c);
    return c;
  };
  try {
    if (process.platform === "win32") {
      const bins =
        process.env.NEXUS_QA_PG17 === "1"
          ? await import(
              pathToFileURL(
                path.join(ROOT, "logs/purchasing-r2/pg17-binaries/package/dist/index.js"),
              ).href
            )
          : await import("@embedded-postgres/windows-x64");
      control = bins.pg_ctl;
      const init = spawnSync(
        bins.initdb,
        ["-D", dir, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C"],
        { windowsHide: true, encoding: "utf8" },
      );
      assert.equal(init.status, 0, init.stderr);
      server = spawn(bins.postgres, ["-D", dir, "-p", String(port), "-h", "127.0.0.1"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      server = new EmbeddedPostgres({
        databaseDir: dir,
        port,
        user: "postgres",
        password: "synthetic-only",
        persistent: true,
        onLog() {},
        onError() {},
      });
      await server.initialise();
      await server.start();
    }
    for (let i = 0; i < 100; i++) {
      try {
        admin = await connect();
        break;
      } catch (error) {
        if (i === 99) throw error;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await admin.query(read("scripts/fixtures/purchasing-public-schema.sql"));
    if (!baselineOnly) {
      await admin.query(read("supabase/migrations/20261010183049_wholesale_feature_toggle.sql"));
      await admin.query(read("supabase/migrations/20261011051927_receipt_product_validation.sql"));
    }
    for (const [role, id] of Object.entries(users))
      await admin.query("insert into auth.users values($1,$2,now())", [
        id,
        role.toLowerCase() + "@qa.invalid",
      ]);
    await admin.query("insert into stores(id,name) values($1,$2)", [
      store,
      "Synthetic business regression",
    ]);
    await admin.query(
      "insert into store_licenses(store_id,license_key,valid_until) values($1,$2,now()+interval '1 year')",
      [store, store],
    );
    for (const [role, id] of Object.entries(users))
      await admin.query("insert into store_members(user_id,store_id,role) values($1,$2,$3)", [
        id,
        store,
        role,
      ]);
    await admin.query("select set_config('request.jwt.claim.sub',$1,false)",[users.ADMIN]);
    if (migrate && !baselineOnly) {await admin.query(read(MIGRATION));await admin.query(read(FEATURES_MIGRATION));}
    async function client(role = "ADMIN") {
      const c = await connect();
      await c.query("set role authenticated");
      await c.query("select set_config('request.jwt.claim.sub',$1,false)", [users[role]]);
      return c;
    }
    async function insert(table, row) {
      const q = (x) => '"' + x.replaceAll('"', '""') + '"',
        keys = Object.keys(row);
      return admin.query(
        `insert into ${q(table)} (${keys.map(q)}) values (${keys.map((_, i) => "$" + (i + 1))}) returning *`,
        Object.values(row).map((x) => (Array.isArray(x) ? JSON.stringify(x) : x)),
      );
    }
    function event(kind, refType, refId, lines, payload = {}) {
      return {
        id: crypto.randomUUID(),
        store_id: store,
        device_id: device,
        kind,
        ref_type: refType,
        ref_id: refId,
        payload: JSON.stringify(payload),
        occurred_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        lines: lines.map((l) => ({
          id: crypto.randomUUID(),
          account: l.account,
          subject_id: l.subjectId,
          amount_delta: toPiastres(l.amount ?? 0),
          qty_delta: l.qty ?? 0,
          unit_cost: l.unitCost == null ? null : toPiastres(l.unitCost),
        })),
      };
    }
    const version = (await admin.query("select version()")).rows[0].version;
    async function close() {
      await Promise.allSettled(clients.map((c) => c.end()));
      if (control)
        spawnSync(control, ["-D", dir, "stop", "-m", "fast"], {
          windowsHide: true,
          stdio: "ignore",
        });
      else await server.stop();
    }
    return { admin, client, insert, event, store, device, users, version, dataDir:dir, close };
  } catch (error) {
    await Promise.allSettled(clients.map((c) => c.end()));
    if (control)
      spawnSync(control, ["-D", dir, "stop", "-m", "fast"], { windowsHide: true, stdio: "ignore" });
    else await server?.stop?.();
    throw error;
  }
}
