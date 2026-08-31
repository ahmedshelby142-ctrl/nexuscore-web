/**
 * The ledger API. Every number in every screen ultimately comes from here.
 *
 * Contract: docs/LEDGER_SCHEMA.md.
 *
 *   import { appendEvent, balances } from "@/lib/ledger";
 *
 *   await appendEvent({
 *     kind: "sale",
 *     refType: "order", refId: order.id,
 *     lines: [
 *       { account: "stock",   subjectId: productId, qty: -2 },
 *       { account: "wallet",  subjectId: "inStoreSafe", amount: 200 },
 *       { account: "revenue", subjectId: "pos",         amount: 200 },
 *       { account: "cogs",    subjectId: productId,     amount: 120, unitCost: 60 },
 *     ],
 *   });
 *
 * There is no `setStock`, no `addToWallet`, no `updateBalance`. Those are the
 * functions this module exists to make impossible.
 */

import { driver, toPiastres } from "./driver";
import { assertFiniteLines } from "./money";
import type { Balance, BalanceQuery, EventQuery, LedgerEvent, NewEvent } from "./types";

export type {
  Account,
  Balance,
  BalanceQuery,
  EventKind,
  EventQuery,
  Identity,
  LedgerEvent,
  NewEvent,
  NewLine,
  SyncStatus,
} from "./types";
export { fromPiastres, toPiastres } from "./driver";

/**
 * Append one event. The header and every line land together or not at all.
 *
 * Fills in the bookkeeping — id, tenancy, timestamps — and converts EGP to
 * piastres, so callers only describe what happened.
 *
 * Throws if the database rejects the event (unknown account, unknown kind,
 * duplicate id). A throw means nothing was written.
 */
export async function appendEvent(event: NewEvent): Promise<string> {
  if (event.lines.length === 0 && event.kind !== "order_returned_pending") {
    // A no-effect event is legitimate only where the brief calls for one:
    // a courier-side return that has not physically arrived yet (§3.9).
    // Anywhere else it means a caller forgot the lines.
    throw new Error(`ledger: event "${event.kind}" was appended with no lines`);
  }

  // Nothing non-finite reaches the database. Checked BEFORE identity() and
  // before any conversion, so a bad number costs nothing and writes nothing —
  // the ledger is append-only, and a NaN in it is permanent.
  assertFiniteLines(event.kind, event.lines);

  const { storeId, deviceId } = await driver.identity();
  const now = new Date();
  const id = crypto.randomUUID();

  await driver.append({
    id,
    store_id: storeId,
    device_id: deviceId,
    kind: event.kind,
    occurred_at: (event.occurredAt ?? now).toISOString(),
    created_at: now.toISOString(),
    actor: event.actor ?? null,
    ref_type: event.refType ?? null,
    ref_id: event.refId ?? null,
    payload: JSON.stringify(event.payload ?? {}),
    lines: event.lines.map((l) => ({
      id: crypto.randomUUID(),
      account: l.account,
      subject_id: l.subjectId,
      qty_delta: l.qty ?? 0,
      amount_delta: toPiastres(l.amount ?? 0),
      unit_cost: l.unitCost === undefined ? null : toPiastres(l.unitCost),
    })),
  });

  // No push step. `driver.append` IS the write to Supabase, and it is awaited
  // above — by the time we get here the event is in the database or this
  // function has already thrown. The fire-and-forget push that used to live
  // here existed only to drain a local queue that no longer exists.
  return id;
}

export async function balances(query: BalanceQuery): Promise<Balance[]> {
  return driver.balances(query);
}

export async function eventLines(eventId: string) {
  return driver.eventLines(eventId);
}

/** One subject's balance, or a zero row if it has no events yet. */
export async function balanceOf(
  account: BalanceQuery["account"],
  subjectId: string,
  window?: Pick<BalanceQuery, "from" | "to">,
): Promise<Balance> {
  const rows = await driver.balances({ account, subjectId, ...window });
  return rows[0] ?? { account, subjectId, qty: 0, amount: 0 };
}

/**
 * Every balance row the ledger holds for one subject. Empty means the ledger
 * has never mentioned it.
 *
 * Read-only, and deliberately NOT a balance test: a product received and then
 * sold out sums to zero and still has a history that must not be orphaned.
 * `balances()` returns a row whenever lines exist and none when they do not,
 * so the caller counts rows (`removalMode` in `@/lib/product`) rather than
 * asking whether a total is non-zero.
 *
 * Defaults to the two accounts a product can be the subject of — `stock`
 * (purchase, sale, order, return, opening balance) and `cogs`.
 */
export async function ledgerRowsFor(
  subjectId: string,
  accounts: BalanceQuery["account"][] = ["stock", "cogs"],
): Promise<Balance[]> {
  const found: Balance[] = [];
  for (const account of accounts) {
    found.push(...(await driver.balances({ account, subjectId })));
  }
  return found;
}

/** Raw event history, newest first. For timelines and audit views. */
export function events(query: EventQuery = {}): Promise<LedgerEvent[]> {
  return driver.events(query);
}

/** Events still waiting to reach Supabase. Drives the Sidebar sync badge. */
export function pendingCount(): Promise<number> {
  return driver.pendingCount();
}

/** This device's store / device ids. See docs/LEDGER_SCHEMA.md §5. */
export function identity() {
  return driver.identity();
}
