/**
 * Ledger driver — the only place that knows where events are stored.
 *
 * There is exactly one store now: Supabase. The SQLite (Tauri) and IndexedDB
 * drivers this replaces were two independent ledgers reconciled by a sync
 * engine, and every disagreement between them showed up as stock and money that
 * differed per machine. A single remote ledger cannot disagree with itself.
 *
 * What that costs, honestly: a write needs the network. That is the deliberate
 * trade of going cloud-native — `append` throws when the network is down
 * instead of queueing, and the caller surfaces the failure rather than
 * pretending the sale landed.
 */

import type {
  Balance,
  BalanceQuery,
  EventQuery,
  Identity,
  LedgerEvent,
  RefBalance,
  RefBalanceQuery,
  SyncStatus,
} from "./types";
import { getSupabaseClient } from "@/lib/supabase";
import { getSyncIdentity } from "@/services/api/storeContext";

// ── Money boundary ──────────────────────────────────────────────────────────
// Lives in ./money so tooling and tests can convert without importing the
// Supabase client. Re-exported here because this file is the boundary in spirit.
export { fromPiastres, toPiastres } from "./money";
import { fromPiastres } from "./money";
import { pageAll } from "@/lib/pageAll";

// ── Wire shapes ─────────────────────────────────────────────────────────────
// snake_case, piastres, fully-formed ids: exactly what the Postgres columns hold.

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
  /** Append one event and all its lines. Throws on rejection. */
  append(event: WireEvent): Promise<void>;
  /** Aggregate. Never reads a stored total — always sums lines. */
  balances(query: BalanceQuery): Promise<Balance[]>;
  /** The same aggregate, split by the document each event points at. */
  balancesByRef(query: RefBalanceQuery): Promise<RefBalance[]>;
  events(query: EventQuery): Promise<LedgerEvent[]>;
  /** Fetch the lines of a specific event */
  eventLines(eventId: string): Promise<WireLine[]>;
  /** Retained for the interface; always 0 — nothing is queued locally. */
  pendingCount(): Promise<number>;
  /** Store tenancy, from the signed-in session. */
  identity(): Promise<Identity>;
}

/** The cloud is the only ledger, so no client means no ledger. */
export class LedgerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerUnavailable";
  }
}

function requireClient() {
  const sb = getSupabaseClient();
  if (!sb) throw new LedgerUnavailable("لا يوجد اتصال بالسحابة");
  return sb;
}

async function requireStoreId(): Promise<string> {
  const identity = await getSyncIdentity();
  if (!identity) {
    throw new LedgerUnavailable("لم يتم ربط هذا الجهاز بمتجر بعد — سجّل الدخول أولاً");
  }
  return identity.storeId;
}

/** A line joined to the two parent facts a balance query filters on. */
interface JoinedLine {
  subject_id: string;
  qty_delta: number | string;
  amount_delta: number | string;
}

const supabaseDriver: LedgerDriver = {
  /**
   * Append one event and all its lines, atomically.
   *
   * ## What this replaced, and why it had to be the database
   *
   * This used to be two PostgREST calls — insert the header, then insert the
   * lines — with a compensating delete when the second failed:
   *
   *     await sb.from("ledger_events").delete().eq("id", event.id);
   *
   * That delete could never once have worked. `no_delete_ledger_events` is
   * `USING (false)`, so Postgres matched zero rows, PostgREST answered 204,
   * and nobody inspected the result. The code read as if it cleaned up and did
   * nothing at all — and the failure it was pretending to handle is the one
   * that actually happens, because `ledger_lines` is the table with the
   * not-null columns and the licence check on it.
   *
   * Forcing that exact failure against QA-STORE left `ledger_events` row
   * `382e5914…` (`purchase`, ref `FM-0006`) standing with no lines behind it.
   * Migration 011 is the same disease an earlier round: at that point EVERY
   * event in the database was a line-less header.
   *
   * No amount of client-side care fixes this, because the client is the wrong
   * place to hold a transaction — between the two calls the tab can be closed,
   * the network can drop, the process can die. `ledger_append` (migration 032)
   * puts both inserts inside one plpgsql function, so any failure anywhere in
   * it aborts the statement and Postgres rolls the header back with the lines.
   *
   * The function is SECURITY **INVOKER** on purpose: it supplies atomicity and
   * nothing else. `insert_ledger_events` (membership + the role gate switched
   * on `kind`) and `insert_ledger_lines` (membership + licence) still do the
   * authorising, as the caller, unchanged. A forged `store_id` in this payload
   * is not a bypass — the policy resolves membership from `auth.uid()`.
   *
   * The `ledger_lines.event_id -> ledger_events.id` foreign key already made
   * the mirror case impossible, so with the header closed there is no longer
   * any partial shape a failed append can leave behind.
   */
  async append(event) {
    const sb = requireClient();

    // The wire shape IS the function's argument shape — same keys, same
    // casing, `payload` already the TEXT the column wants, lines carrying
    // `qty_delta` / `amount_delta` / `unit_cost`. Nothing is re-mapped here,
    // so there is no second place for a column name to drift.
    //
    // `store_id`, `device_id` and `event_id` on each line are filled in by the
    // function from the HEADER and are deliberately not sent per-line: a line
    // is never given the chance to name a different tenant than its event.
    const { error } = await sb.rpc("ledger_append", { p_event: event });

    if (error) {
      // A throw here means NOTHING was written — that is now a guarantee from
      // Postgres rather than a hope. Callers such as `commitReceipt` rely on
      // it to decide whether their document has to be taken back.
      throw new Error(`[ledger_append] ${error.message}`);
    }
  },

  /**
   * One account's balance per subject, aggregated by Postgres.
   *
   * ## Why this is an RPC and not a select
   *
   * It used to page every matching line into the browser and sum them here,
   * filtering the window with
   *
   *     .gte("ledger_events.occurred_at", from.toISOString())
   *
   * `occurred_at` is a `text` column, so that is a STRING comparison. The
   * table holds two spellings of the same instant — `2026-09-12T14:18:07.675Z`
   * and `2026-09-12 14:18:07.675957+00` — and `' ' < 'T'`, so every
   * Postgres-style row sorted below the lower bound of its own day and was
   * silently dropped. Measured against the live database for 2026-09-12: this
   * returned 308.00 EGP of revenue where the timestamps mean 3,100.00, and 14
   * in-period events disappeared. Every dated figure in التقارير المالية was
   * wrong by that much.
   *
   * `ledger_balances` (migration 034) casts `occurred_at::timestamptz` once,
   * in SQL, so the comparison is between two instants. It is SECURITY INVOKER,
   * so `select_ledger_lines` still decides what this caller may see and
   * nothing is granted that a select did not already allow. Lifetime reads —
   * no `from`, no `to` — are unaffected and return exactly what they did.
   */
  async balances(query) {
    const sb = requireClient();
    const storeId = await requireStoreId();

    const { data, error } = await sb.rpc("ledger_balances", {
      p_store: storeId,
      p_account: query.account,
      p_kind: query.kind ?? null,
      p_subject_id: query.subjectId ?? null,
      p_from: query.from ? query.from.toISOString() : null,
      p_to: query.to ? query.to.toISOString() : null,
    });

    if (error) throw new Error(`[ledger_balances] ${error.message}`);

    return (data ?? []).map((r: { subject_id: string; qty: number | string; amount: number | string }) => ({
      account: query.account as Balance["account"],
      subjectId: r.subject_id,
      qty: Number(r.qty) || 0,
      // Piastres in the column, EGP at the boundary.
      amount: fromPiastres(Number(r.amount) || 0),
    }));
  },

  /**
   * The same aggregation, but grouped by the DOCUMENT the event points at.
   *
   * `balances` collapses every event into one total per subject, which is the
   * right answer for "how much stock is there" and the wrong one for "how much
   * of THIS invoice has already gone back". A supplier return is capped per
   * purchase invoice, so the cap has to be able to name the invoice.
   *
   * Deriving it from the ledger rather than from a stored counter is not a
   * stylistic choice here: `return_records` may only be written by ADMIN /
   * POS_ECOMMERCE / ECOMMERCE_ONLY, and the role that actually does purchasing
   * is ACCOUNTANT. A ceiling kept there would silently stop working for the one
   * user who needs it. The ledger is readable by every store member and its
   * `purchase` events are writable by exactly ADMIN and ACCOUNTANT — the same
   * pair `/purchasing` admits — so the cap lives where the movement does, and
   * is append-only and atomic by construction.
   */
  async balancesByRef(query) {
    const sb = requireClient();
    const storeId = await requireStoreId();

    const rows = await pageAll<JoinedLine & { ledger_events: { ref_id: string | null } }>(
      (from, to) => {
        let q = sb
          .from("ledger_lines")
          .select(
            "subject_id, qty_delta, amount_delta, ledger_events!inner(kind, ref_type, ref_id)",
          )
          .eq("store_id", storeId)
          .eq("account", query.account)
          .eq("ledger_events.ref_type", query.refType);

        if (query.kind) q = q.eq("ledger_events.kind", query.kind);
        if (query.refId) q = q.eq("ledger_events.ref_id", query.refId);

        return q.range(from, to);
      },
    );

    const totals = new Map<string, { refId: string; subjectId: string; qty: number; amount: number }>();
    for (const r of rows) {
      const refId = String((r as any).ledger_events?.ref_id ?? "");
      const key = `${refId} ${r.subject_id}`;
      const t = totals.get(key) ?? { refId, subjectId: r.subject_id, qty: 0, amount: 0 };
      t.qty += Number(r.qty_delta) || 0;
      t.amount += Number(r.amount_delta) || 0;
      totals.set(key, t);
    }

    return [...totals.values()].map((t) => ({
      refId: t.refId,
      subjectId: t.subjectId,
      qty: t.qty,
      amount: fromPiastres(t.amount),
    }));
  },

  /**
   * Event headers, newest first.
   *
   * ## Why this is an RPC, like `balances`
   *
   * It had the defect 034 fixed there, and was not fixed with it.
   * `occurred_at` is a `text` column, so filtering it with
   * `.gte(from.toISOString())` and sorting it with `.order("occurred_at")`
   * compares two spellings of the same instant as STRINGS —
   * `2026-09-12T14:18:07.675Z` against `2026-09-12 14:18:07.675957+00`, where
   * `' ' < 'T'`.
   *
   * Measured per day against the live database: 14 events attributed to
   * 2026-09-11, which had NONE, and nine missing from the 13th. Separately, 44
   * of 167 rows sorted out of place — and a `.limit()` on a wrong order
   * returns the wrong rows, which is what «آخر ٥٠ تسوية» and the POS return
   * picker are built on.
   *
   * `ledger_events_page` (migration 035) casts once, in SQL, for both the
   * window and the sort. SECURITY INVOKER, so `select_ledger_events` still
   * decides what this caller may see.
   */
  async events(query) {
    const sb = requireClient();
    const storeId = await requireStoreId();

    const { data, error } = await sb.rpc("ledger_events_page", {
      p_store: storeId,
      p_kind: query.kind ?? null,
      p_ref_type: query.refType ?? null,
      p_ref_id: query.refId ?? null,
      p_from: query.from ? query.from.toISOString() : null,
      p_to: query.to ? query.to.toISOString() : null,
      p_limit: Number(query.limit ?? 200),
    });

    if (error) throw new Error(`[ledger_events_page] ${error.message}`);
    return (data ?? []).map(rowToEvent);
  },

  async eventLines(eventId) {
    const sb = requireClient();
    const { data, error } = await sb.from("ledger_lines").select("*").eq("event_id", eventId);
    if (error) throw new Error(`[ledger_lines] ${error.message}`);

    return (data ?? []).map((l: Record<string, unknown>) => ({
      id: String(l.id),
      account: String(l.account),
      subject_id: String(l.subject_id ?? ""),
      qty_delta: Number(l.qty_delta) || 0,
      amount_delta: Number(l.amount_delta) || 0,
      unit_cost: l.unit_cost == null ? null : Number(l.unit_cost),
    }));
  },

  /** Nothing is queued locally any more. Kept so the interface stays honest. */
  async pendingCount() {
    return 0;
  },

  async identity() {
    const identity = await getSyncIdentity();
    return {
      storeId: identity?.storeId ?? "",
      deviceId: identity?.deviceId ?? "",
      // Provisional means "no confirmed store". Without a session there is none.
      storeProvisional: !identity,
    };
  },
};

function rowToEvent(r: Record<string, unknown>): LedgerEvent {
  return {
    id: String(r.id),
    storeId: String(r.store_id),
    // NOT String(): on a row whose device_id is NULL this produced the literal
    // "undefined", which then travelled all the way to a UUID column.
    deviceId: r.device_id == null ? "" : String(r.device_id),
    kind: r.kind as LedgerEvent["kind"],
    occurredAt: String(r.occurred_at),
    createdAt: String(r.created_at),
    actor: (r.actor as string) ?? null,
    refType: (r.ref_type as string) ?? null,
    refId: (r.ref_id as string) ?? null,
    // `payload` is a jsonb column, so it arrives parsed. The string branch is
    // for rows written by the old SQLite path, which stored it as text.
    payload: asObject(r.payload),
    reversedBy: (r.reversed_by as string) ?? null,
    syncStatus: (r.sync_status as SyncStatus) ?? "synced",
  };
}

function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string") return asObject(safeParse(v));
  return {};
}

function safeParse(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
}

export const driver: LedgerDriver = supabaseDriver;
