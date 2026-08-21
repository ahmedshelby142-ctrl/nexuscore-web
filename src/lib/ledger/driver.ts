/**
 * Ledger driver — the only place that knows where events are stored.
 *
 * The interface is deliberately SQL-free. It describes *what* the ledger is
 * asked for, not how it is queried, so the in-memory driver is an honest
 * implementation rather than a fake SQL engine, and so swapping in a real
 * browser backend (IndexedDB / wa-sqlite) later is a one-file change.
 *
 * Runtime selection, per the agreed Option A:
 *   - Tauri  → SQLite. Writes via the `ledger_append` command (one
 *              sqlx::Transaction), reads via tauri-plugin-sql.
 *   - Browser → in-memory. Demo only, gone on refresh. `npm run dev` alone
 *              is not a supported way to run this app; use `tauri:dev`.
 */

import { isDesktop } from "../tauri";
import type { Balance, BalanceQuery, EventQuery, Identity, LedgerEvent, SyncStatus } from "./types";

// ── Money boundary ──────────────────────────────────────────────────────────
// Lives in ./money so tooling and tests can convert without importing the
// Tauri bridge. Re-exported here because this file is the boundary in spirit.
export { fromPiastres, toPiastres } from "./money";
import { fromPiastres, toPiastres } from "./money";
import { pushPendingChanges } from "../../services/ledgerSyncEngine";

// ── Wire shapes ─────────────────────────────────────────────────────────────
// snake_case, piastres, fully-formed ids: exactly what Rust's serde expects
// and exactly what the SQLite columns hold.

export interface WireLine {
  id: string;
  account: string;
  subject_id: string;
  qty_delta: number;
  amount_delta: number;
  unit_cost: number | null;
}

export interface WireEvent {
  id: string;
  store_id: string;
  device_id: string;
  kind: string;
  occurred_at: string;
  created_at: string;
  actor: string | null;
  ref_type: string | null;
  ref_id: string | null;
  payload: string;
  lines: WireLine[];
}

export interface LedgerDriver {
  /** Append one event and all its lines atomically. Throws on rejection. */
  append(event: WireEvent): Promise<void>;
  /** Aggregate. Never reads a stored total — always sums lines. */
  balances(query: BalanceQuery): Promise<Balance[]>;
  events(query: EventQuery): Promise<LedgerEvent[]>;
  /** Fetch the lines of a specific event */
  eventLines(eventId: string): Promise<WireLine[]>;
  /** How many events are waiting to reach Supabase. Drives the Sidebar badge. */
  pendingCount(): Promise<number>;
  /** Device tenancy, creating it on first run. */
  identity(): Promise<Identity>;
}

// ── Tauri / SQLite driver ───────────────────────────────────────────────────

interface SqlDb {
  select<T>(sql: string, params?: unknown[]): Promise<T>;
}

let dbPromise: Promise<SqlDb> | null = null;

/**
 * Open the read connection against the exact file Rust wrote to.
 *
 * The path comes from `ledger_db_path` rather than being guessed from a
 * `sqlite:name.db` shorthand, so the read pool and the write pool can never
 * end up on different files.
 */
async function readDb(): Promise<SqlDb> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await invoke<string>("ledger_db_path");
      const Database = (await import("@tauri-apps/plugin-sql")).default;
      return (await Database.load(`sqlite:${path}`)) as unknown as SqlDb;
    })();
  }
  return dbPromise;
}

/** Builds the `occurred_at` window shared by the balance and event queries. */
function window(from?: Date, to?: Date): { clause: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (from) {
    parts.push("e.occurred_at >= ?");
    params.push(from.toISOString());
  }
  if (to) {
    parts.push("e.occurred_at < ?");
    params.push(to.toISOString());
  }
  return { clause: parts.length ? ` AND ${parts.join(" AND ")}` : "", params };
}

const tauriDriver: LedgerDriver = {
  async append(event) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("ledger_append", { event });
    pushPendingChanges().catch(console.error);
  },

  async balances(query) {
    const db = await readDb();
    const { storeId } = await this.identity();
    const w = window(query.from, query.to);

    // Joined to ledger_events rather than reading the account_balance view,
    // because the view cannot express a date window. Same aggregation.
    const rows = await db.select<
      { account: string; subject_id: string; qty: number; amount: number }[]
    >(
      `SELECT l.account, l.subject_id,
              COALESCE(SUM(l.qty_delta), 0)    AS qty,
              COALESCE(SUM(l.amount_delta), 0) AS amount
         FROM ledger_lines l
         JOIN ledger_events e ON e.id = l.event_id
        WHERE l.store_id = ? AND l.account = ?
          ${query.subjectId ? "AND l.subject_id = ?" : ""}
          ${query.kind ? "AND e.kind = ?" : ""}
          ${w.clause}
        GROUP BY l.account, l.subject_id`,
      [
        storeId,
        query.account,
        ...(query.subjectId ? [query.subjectId] : []),
        ...(query.kind ? [query.kind] : []),
        ...w.params,
      ],
    );

    return rows.map((r) => ({
      account: r.account as Balance["account"],
      subjectId: r.subject_id,
      qty: r.qty,
      amount: fromPiastres(r.amount),
    }));
  },

  async events(query) {
    const db = await readDb();
    const { storeId } = await this.identity();
    const w = window(query.from, query.to);
    const filters: string[] = [];
    const params: unknown[] = [storeId];

    if (query.kind) {
      filters.push("e.kind = ?");
      params.push(query.kind);
    }
    if (query.refType) {
      filters.push("e.ref_type = ?");
      params.push(query.refType);
    }
    if (query.refId) {
      filters.push("e.ref_id = ?");
      params.push(query.refId);
    }
    params.push(...w.params);

    const rows = await db.select<Record<string, string | null>[]>(
      `SELECT * FROM ledger_events e
        WHERE e.store_id = ?
          ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
          ${w.clause}
        ORDER BY e.occurred_at DESC
        LIMIT ${Number(query.limit ?? 200)}`,
      params,
    );

    return rows.map(rowToEvent);
  },

  async eventLines(eventId) {
    const db = await readDb();
    const rows = await db.select<WireLine[]>(
      `SELECT * FROM ledger_lines WHERE event_id = ?`,
      [eventId]
    );
    return rows;
  },

  async pendingCount() {
    const db = await readDb();
    const rows = await db.select<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM ledger_events WHERE sync_status = 'pending'",
    );
    return rows[0]?.n ?? 0;
  },

  async identity() {
    const { invoke } = await import("@tauri-apps/api/core");
    const row = await invoke<{
      store_id: string;
      device_id: string;
      store_provisional: boolean;
    }>("ledger_identity", {
      // Candidate ids, used only if this device has none yet. Generating them
      // here keeps UUID creation client-side (brief §1.4) without pulling a
      // uuid crate into the Rust build.
      candidateStoreId: crypto.randomUUID(),
      candidateDeviceId: crypto.randomUUID(),
    });
    return {
      storeId: row.store_id,
      deviceId: row.device_id,
      storeProvisional: row.store_provisional,
    };
  },
};

function rowToEvent(r: Record<string, unknown>): LedgerEvent {
  return {
    id: String(r.id),
    storeId: String(r.store_id),
    deviceId: String(r.device_id),
    kind: r.kind as LedgerEvent["kind"],
    occurredAt: String(r.occurred_at),
    createdAt: String(r.created_at),
    actor: (r.actor as string) ?? null,
    refType: (r.ref_type as string) ?? null,
    refId: (r.ref_id as string) ?? null,
    payload: safeJson(r.payload),
    reversedBy: (r.reversed_by as string) ?? null,
    syncStatus: r.sync_status as SyncStatus,
  };
}

function safeJson(v: unknown): Record<string, unknown> {
  if (typeof v !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(v);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── In-memory driver (browser demo only) ────────────────────────────────────
//
// ponytail: no persistence, no date-window index, linear scans. That is the
// whole point — the browser path is a demo, not a supported runtime. If it
// ever needs to be real, replace this object with an IndexedDB implementation
// and nothing above driver.ts changes.

function memoryDriver(): LedgerDriver {
  const events: WireEvent[] = [];
  const identity: Identity = {
    storeId: "demo-store",
    deviceId: "demo-device",
    storeProvisional: true,
  };

  const inWindow = (e: WireEvent, from?: Date, to?: Date) =>
    (!from || e.occurred_at >= from.toISOString()) && (!to || e.occurred_at < to.toISOString());

  return {
    append(event) {
      // Mirrors the transaction guarantee: the array push is all-or-nothing.
      events.push(event);
      return Promise.resolve();
    },

    balances(query) {
      const totals = new Map<string, { qty: number; amount: number }>();
      for (const e of events) {
        if (!inWindow(e, query.from, query.to)) continue;
        if (query.kind && e.kind !== query.kind) continue;
        for (const l of e.lines) {
          if (l.account !== query.account) continue;
          if (query.subjectId && l.subject_id !== query.subjectId) continue;
          const t = totals.get(l.subject_id) ?? { qty: 0, amount: 0 };
          t.qty += l.qty_delta;
          t.amount += l.amount_delta;
          totals.set(l.subject_id, t);
        }
      }
      return Promise.resolve(
        [...totals].map(([subjectId, t]) => ({
          account: query.account,
          subjectId,
          qty: t.qty,
          amount: fromPiastres(t.amount),
        })),
      );
    },

    events(query) {
      const out = events
        .filter(
          (e) =>
            (!query.kind || e.kind === query.kind) &&
            (!query.refType || e.ref_type === query.refType) &&
            (!query.refId || e.ref_id === query.refId) &&
            inWindow(e, query.from, query.to),
        )
        .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
        .slice(0, query.limit ?? 200)
        .map((e) => rowToEvent({ ...e, reversed_by: null, sync_status: "pending" }));
      return Promise.resolve(out);
    },

    async eventLines(eventId) {
      const e = events.find((ev) => ev.id === eventId);
      return e ? e.lines : [];
    },

    pendingCount: () => Promise.resolve(events.length),
    identity: () => Promise.resolve(identity),
  };
}

/** The active driver for this runtime. */
export const driver: LedgerDriver = isDesktop ? tauriDriver : memoryDriver();
