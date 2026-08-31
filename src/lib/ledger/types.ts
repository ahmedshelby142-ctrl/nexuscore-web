/**
 * Ledger types — the shape of the one source of truth.
 *
 * Contract: docs/LEDGER_SCHEMA.md.
 *
 * Everything above this module works in EGP (pounds). The database stores
 * piastres as integers. The conversion happens once, in `driver.ts`, and
 * nowhere else — see §2 of the schema doc for why.
 */

/** Where an effect lands. Mirrors the CHECK constraint on `ledger_lines`. */
export type Account =
  | "stock"
  | "wallet"
  | "revenue"
  | "cogs"
  | "expense"
  | "payable_supplier"
  | "receivable_client"
  | "receivable_courier"
  | "payable_courier"
  | "customer_ltv"
  | "owner_budget";

/** What happened. Mirrors the CHECK constraint on `ledger_events`. */
export type EventKind =
  | "sale"
  | "order_placed"
  | "order_delivered"
  | "order_returned_pending"
  | "order_cancelled"
  | "order_edited"
  | "return_confirmed"
  | "rto_confirmed"
  | "purchase"
  | "supplier_payment"
  | "client_payment"
  | "expense"
  | "payroll"
  | "wallet_transfer"
  | "courier_settlement"
  | "owner_draw"
  | "stock_adjustment";

export type SyncStatus = "pending" | "synced" | "conflict";

/** One effect of an event, in EGP. */
export interface NewLine {
  account: Account;
  /** Product / wallet / supplier / customer / courier id. */
  subjectId: string;
  /** Signed quantity change. Omit for pure-money lines. */
  qty?: number;
  /** Signed amount in EGP. Omit for pure-quantity lines. */
  amount?: number;
  /** Cost price per unit in EGP, captured at the moment of the sale. */
  unitCost?: number;
}

/**
 * An event to append. `id`, `storeId`, `deviceId` and `createdAt` are filled
 * in by `appendEvent` — callers describe what happened, not bookkeeping.
 */
export interface NewEvent {
  kind: EventKind;
  /** Business time. Defaults to now. */
  occurredAt?: Date;
  actor?: string;
  /** What this event points back at, e.g. `("order", orderId)`. */
  refType?: string;
  refId?: string;
  /** Descriptive only. No screen may compute a number from this. */
  payload?: Record<string, unknown>;
  lines: NewLine[];
}

/** A stored event header, as read back. */
export interface LedgerEvent {
  id: string;
  storeId: string;
  deviceId: string;
  kind: EventKind;
  occurredAt: string;
  createdAt: string;
  actor: string | null;
  refType: string | null;
  refId: string | null;
  payload: Record<string, unknown>;
  reversedBy: string | null;
  syncStatus: SyncStatus;
}

/** An aggregated balance, in EGP. Never a stored column — always a SUM. */
export interface Balance {
  account: Account;
  subjectId: string;
  qty: number;
  amount: number;
}

export interface BalanceQuery {
  account: Account;
  /** Restrict to one subject. Omit for every subject in the account. */
  subjectId?: string;
  /**
   * Restrict to the lines written by ONE kind of event.
   *
   * Needed because some report figures are a subset of an account that the
   * account alone cannot express: `SUM(stock.amount)` is inventory value,
   * while purchases are only the `stock +` lines a `purchase` wrote; and
   * `SUM(revenue)` is already NET of returns, so the returns figure is the
   * `revenue −` lines a `return_confirmed` wrote. Both are still SUMs over
   * `ledger_lines` — this narrows the rows, it does not read a stored total.
   */
  kind?: EventKind;
  /** Inclusive lower bound on `occurred_at`. */
  from?: Date;
  /** Exclusive upper bound on `occurred_at`. */
  to?: Date;
}

export interface EventQuery {
  kind?: EventKind;
  refType?: string;
  refId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

/** Device tenancy. See docs/LEDGER_SCHEMA.md §5. */
export interface Identity {
  storeId: string;
  deviceId: string;
  /**
   * True until `claim_store` has run against the server. Sync MUST stay
   * blocked while this is true — that is what makes the two-device
   * reconciliation a purely local re-tag.
   */
  storeProvisional: boolean;
}
