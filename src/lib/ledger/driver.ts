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

import type { Balance, BalanceQuery, EventQuery, Identity, LedgerEvent, SyncStatus } from "./types";
import { getSupabaseClient } from "@/lib/supabase";
import { getSyncIdentity } from "@/services/api/storeContext";

// ── Money boundary ──────────────────────────────────────────────────────────
// Lives in ./money so tooling and tests can convert without importing the
// Supabase client. Re-exported here because this file is the boundary in spirit.
export { fromPiastres, toPiastres } from "./money";
import { fromPiastres } from "./money";

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

/**
 * PostgREST caps a response at 1000 rows. A balance is a SUM over every line
 * ever written for an account, so a shop with history WILL cross that — and a
 * silently truncated page reads as stock that vanished.
 *
 * ponytail: pages client-side and sums in JS. Correct at any size, but it
 * transfers every line to compute one number. If a balance read ever gets slow,
 * the upgrade is a Postgres view or RPC that returns the SUM — `balances()` is
 * the only caller that would change.
 */
const PAGE = 1000;

async function selectAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** A line joined to the two parent facts a balance query filters on. */
interface JoinedLine {
  subject_id: string;
  qty_delta: number | string;
  amount_delta: number | string;
}

const supabaseDriver: LedgerDriver = {
  /**
   * Insert the event, then its lines.
   *
   * Not one transaction: PostgREST has no multi-table transaction, and adding a
   * Postgres function would put a migration between this code and a working
   * app. Instead the event is deleted again when its lines fail, so the ledger
   * never keeps a header that moved no stock and no money.
   *
   * ponytail: compensating delete rather than an RPC. If a crash between the
   * two writes ever leaves an orphan header, move both inserts into a
   * `ledger_append(event jsonb)` SQL function — this method is the only caller.
   */
  async append(event) {
    const sb = requireClient();
    const { lines, payload, ...header } = event;

    const { error: evErr } = await sb.from("ledger_events").insert({
      ...header,
      payload: safeParse(payload),
      sync_status: "synced",
    });
    if (evErr) throw new Error(`[ledger_events] ${evErr.message}`);

    if (lines.length > 0) {
      const { error: lnErr } = await sb.from("ledger_lines").insert(
        lines.map((l) => ({
          id: l.id,
          event_id: event.id,
          store_id: event.store_id,
          account: l.account,
          subject_id: l.subject_id,
          // The deployed columns are `qty_delta` / `amount_delta` — the same
          // names as the wire shape. The sync layer this replaces sent `qty`
          // and `amount`, which are not columns on this table, so every line it
          // ever pushed was rejected. Verified against the live schema, not
          // against docs/migrations/000_master_schema.sql, which has drifted.
          qty_delta: l.qty_delta,
          // Piastres. No float ever crosses this.
          amount_delta: l.amount_delta,
          unit_cost: l.unit_cost,
          sync_status: "synced",
        })),
      );

      if (lnErr) {
        await sb.from("ledger_events").delete().eq("id", event.id);
        throw new Error(`[ledger_lines] ${lnErr.message}`);
      }
    }
  },

  async balances(query) {
    const sb = requireClient();
    const storeId = await requireStoreId();

    // `!inner` makes the join a filter: a line whose event does not match the
    // kind or the date window is dropped by Postgres rather than fetched here
    // and discarded.
    const rows = await selectAll<JoinedLine>((from, to) => {
      let q = sb
        .from("ledger_lines")
        .select("subject_id, qty_delta, amount_delta, ledger_events!inner(kind, occurred_at)")
        .eq("store_id", storeId)
        .eq("account", query.account);

      if (query.subjectId) q = q.eq("subject_id", query.subjectId);
      if (query.kind) q = q.eq("ledger_events.kind", query.kind);
      if (query.from) q = q.gte("ledger_events.occurred_at", query.from.toISOString());
      if (query.to) q = q.lt("ledger_events.occurred_at", query.to.toISOString());

      return q.range(from, to);
    });

    const totals = new Map<string, { qty: number; amount: number }>();
    for (const r of rows) {
      const t = totals.get(r.subject_id) ?? { qty: 0, amount: 0 };
      t.qty += Number(r.qty_delta) || 0;
      t.amount += Number(r.amount_delta) || 0;
      totals.set(r.subject_id, t);
    }

    return [...totals].map(([subjectId, t]) => ({
      account: query.account as Balance["account"],
      subjectId,
      qty: t.qty,
      // Piastres in the column, EGP at the boundary.
      amount: fromPiastres(t.amount),
    }));
  },

  async events(query) {
    const sb = requireClient();
    const storeId = await requireStoreId();

    let q = sb.from("ledger_events").select("*").eq("store_id", storeId);

    if (query.kind) q = q.eq("kind", query.kind);
    if (query.refType) q = q.eq("ref_type", query.refType);
    if (query.refId) q = q.eq("ref_id", query.refId);
    if (query.from) q = q.gte("occurred_at", query.from.toISOString());
    if (query.to) q = q.lt("occurred_at", query.to.toISOString());

    const { data, error } = await q
      .order("occurred_at", { ascending: false })
      .limit(Number(query.limit ?? 200));

    if (error) throw new Error(`[ledger_events] ${error.message}`);
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
