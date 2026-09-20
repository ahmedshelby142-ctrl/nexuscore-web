/**
 * The Owner's money, read through the one reader that checks who is asking.
 *
 * ## Why this exists rather than a handful of `useBalances` calls
 *
 * Every financial SELECT policy in this database is `is_store_member(store_id)`.
 * There is no role predicate on any of them. The M3.2 audit measured what that
 * means: an authenticated MODERATOR reads 489 `ledger_lines` in QA-STORE, which
 * is every revenue, cogs, wallet and payable line in it. "Owner-only" was a UI
 * statement, not a security one.
 *
 * Tightening those policies is not the fix — `customer_ltv`, stock and
 * shortages are read through the same tables by the Moderator certified in
 * M3.1 and by every other operational role, and narrowing the table breaks all
 * of them. So the restricted surface is this reader: `owner_financial_summary`
 * (migration 034) independently verifies that there is an authenticated
 * caller, that they are a member of the store they named, and that their role
 * there is ADMIN, and it returns only the metrics the M3.2 authority matrix
 * settled. There is deliberately no "read every ledger row" RPC.
 *
 * ## What it does NOT return, and why that is not a zero
 *
 * Owner draw, capital/equity, wallet transfers and every period-over-period
 * comparison are absent from the payload because the audit proved there is no
 * authoritative data behind them: `owner_budget` holds 0 lines, `owner_draw`
 * and `wallet_transfer` have 0 events, and the ledger is three weeks old. They
 * are omitted, never returned as 0 — `0` reads as "asked, and there are none",
 * which is the lie `alertModel` already refuses to tell.
 *
 * ## Lifetime and period are different questions
 *
 * A wallet balance, a supplier debt and inventory value are POSITIONS: what
 * they are right now. A date window on them is meaningless, so the window is
 * not applied to them. Revenue, COGS, expenses and returns are FLOWS and take
 * the window. The split is enforced in SQL, not here.
 *
 * ## No second formula
 *
 * `grossProfit` and `netProfit` are the same subtraction `pnl()` in
 * `reports.ts` performs over the same two accounts. Nothing in this module
 * re-derives them, and nothing downstream may either.
 */

import { getSupabaseClient } from "@/lib/supabase";
import { getActiveStoreId } from "@/services/api/storeContext";
import { fromPiastres } from "./money";

/** One subject's share of an account, in EGP. */
export interface OwnerSubjectAmount {
  subjectId: string;
  amount: number;
}

export interface OwnerFinancialSummary {
  /** The window the flows were measured over. `null` on both = lifetime. */
  from: Date | null;
  to: Date | null;

  // ── Flows, over the window ──
  /** `SUM(revenue)`. Already net of returns. */
  revenue: number;
  /** `SUM(cogs)`. Already net of returns. */
  cogs: number;
  /** `revenue − cogs`. Same definition as `pnl().grossProfit`. */
  grossProfit: number;
  /** `SUM(expense)` — the ledger account, never the `expenses` table. */
  expenses: number;
  /** `revenue − cogs − expenses`. Same definition as `pnl().netProfit`. */
  netProfit: number;
  /** Value returned in the window, POSITIVE. Already deducted above. */
  returnsValue: number;
  /** `revenue` split by channel subject: pos · ecommerce · wholesale · … */
  salesByChannel: OwnerSubjectAmount[];

  // ── Positions, lifetime ──
  /** `SUM(stock.amount)` — inventory value. */
  stockValue: number;
  /** `SUM(wallet)` per till, folded onto the canonical wallet key. */
  walletBalances: OwnerSubjectAmount[];
  supplierPayable: OwnerSubjectAmount[];
  courierReceivable: OwnerSubjectAmount[];
  courierPayable: OwnerSubjectAmount[];
  /** `SUM(receivable_client)` — wholesale and customer receivable. */
  receivableClient: number;
}

interface RawSubjectAmount {
  subjectId: string;
  amount: number | string;
}

/** Piastres in the payload, EGP at the boundary — the same rule as `driver.ts`. */
function toEgpRows(rows: RawSubjectAmount[] | null | undefined): OwnerSubjectAmount[] {
  return (rows ?? []).map((r) => ({
    subjectId: String(r.subjectId),
    amount: fromPiastres(Number(r.amount) || 0),
  }));
}

const egp = (value: unknown): number => fromPiastres(Number(value) || 0);

/**
 * Read the Owner summary for the signed-in store.
 *
 * THROWS on refusal — `42501` for any caller who is not an ADMIN of this
 * store. A caller must render an unavailable state from that, never a zero: a
 * screen that shows «٠ ج.م.» because the read was refused tells the owner the
 * shop took nothing today.
 */
export async function readOwnerFinancialSummary(
  window?: { from?: Date; to?: Date },
): Promise<OwnerFinancialSummary> {
  const sb = getSupabaseClient();
  if (!sb) throw new Error("[owner_financial_summary] no Supabase client");

  const storeId = await getActiveStoreId();
  if (!storeId) throw new Error("[owner_financial_summary] no active store");

  // `p_store` is checked against the CALLER's own membership inside the
  // function, so passing a different id cannot widen anything — it only
  // produces "not a member of this store".
  const { data, error } = await sb.rpc("owner_financial_summary", {
    p_store: storeId,
    p_from: window?.from ? window.from.toISOString() : null,
    p_to: window?.to ? window.to.toISOString() : null,
  });

  if (error) throw new Error(`[owner_financial_summary] ${error.message}`);
  if (!data) throw new Error("[owner_financial_summary] empty response");

  const payload = data as Record<string, unknown>;

  return {
    from: payload.from ? new Date(String(payload.from)) : null,
    to: payload.to ? new Date(String(payload.to)) : null,

    revenue: egp(payload.revenue),
    cogs: egp(payload.cogs),
    grossProfit: egp(payload.grossProfit),
    expenses: egp(payload.expenses),
    netProfit: egp(payload.netProfit),
    returnsValue: egp(payload.returnsValue),
    salesByChannel: toEgpRows(payload.salesByChannel as RawSubjectAmount[]),

    stockValue: egp(payload.stockValue),
    walletBalances: toEgpRows(payload.walletBalances as RawSubjectAmount[]),
    supplierPayable: toEgpRows(payload.supplierPayable as RawSubjectAmount[]),
    courierReceivable: toEgpRows(payload.courierReceivable as RawSubjectAmount[]),
    courierPayable: toEgpRows(payload.courierPayable as RawSubjectAmount[]),
    receivableClient: egp(payload.receivableClient),
  };
}
