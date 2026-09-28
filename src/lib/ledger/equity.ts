/**
 * حقوق الملكية — what the owner put in, what the business earned, what she took
 * out. The ONE place those figures are defined; every screen reads this.
 *
 * ## Where each figure lives (migration 049)
 *
 *   رأس المال              `owner_equity` lines of `owner_capital` events
 *   مساهمات إضافية          `owner_equity` lines of `owner_contribution` events
 *   المسحوبات               `owner_budget` (the `owner_draw` events — ownerDraw.ts)
 *   الأرباح/الخسائر المتراكمة  revenue − cogs − expense since the ledger began
 *                           (the same definition as `netProfitOf` and the
 *                           Owner summary; never recomputed here any other way)
 *   أرصدة افتتاحية          what `stock_adjustment` added to wallets and stock
 *                           without a P&L effect (opening wallets, opening
 *                           stock) — the ledger's "opening balance equity" —
 *                           less any capital DECLARED against it (see below)
 *
 *   صافي حقوق الملكية = رأس المال + مساهمات + أرصدة افتتاحية + الأرباح − المسحوبات
 *
 * ## Capital is never inferred
 *
 * With no `owner_capital` line, `capital` is `null` — «غير مسجل» — not 0.
 * Nothing here derives it from wallets, stock, net worth or profit.
 *
 * ## Historical capital vs cash arriving now
 *
 * A capital line WITH a wallet line is money entering today. A capital line
 * WITHOUT one declares money put in before the ledger existed: what it bought
 * is already on the books as opening balances. So declared capital is
 * RECLASSIFIED out of the opening balances rather than added on top of them —
 * total equity does not move, only its split. What remains of the opening
 * balances is pre-ledger history (earlier profits, or assets recorded without
 * capital), shown as such. It can be negative: declared capital larger than
 * what was recorded at go-live.
 *
 * ## What this is not
 *
 * The ledger is not a full double-entry book: the order lifecycle moves stock
 * at placement and books its cost at delivery, and deposits held are not a
 * liability account. So total equity here is NOT asserted to equal
 * `netWorthOf` (assets − supplier payables); the two are shown side by side.
 * See docs/OWNER_EQUITY_MODEL.md.
 */

import type { Balance, BalanceQuery, NewLine } from "./types";
import { isOwnerSubject, OWNER_SUBJECT } from "./ownerDraw";
import { netProfitOf } from "./reports";

// ── Writing ─────────────────────────────────────────────────────────────────

export interface OwnerCapitalInput {
  /** `OWNER_SUBJECT` or a partner id. */
  subjectId: string;
  /** EGP. Positive records capital; negative corrects an earlier entry down. */
  amount: number;
  /** Set when the money arrives in a wallet NOW. Omit for capital put in before the ledger. */
  wallet?: string | null;
}

export function buildOwnerCapitalLines(input: OwnerCapitalInput): NewLine[] {
  if (!input.subjectId) throw new Error("owner capital: needs to know whose capital it is");
  if (!Number.isFinite(input.amount) || input.amount === 0) {
    throw new Error("owner capital: amount must be a non-zero number");
  }
  const lines: NewLine[] = [
    { account: "owner_equity", subjectId: input.subjectId, amount: input.amount },
  ];
  if (input.wallet)
    lines.push({ account: "wallet", subjectId: input.wallet, amount: input.amount });
  return lines;
}

export interface OwnerContributionInput {
  subjectId: string;
  /** EGP, positive: money entering the business. */
  amount: number;
  /** The wallet it landed in. Required — a contribution is cash that arrived. */
  wallet: string;
}

export function buildOwnerContributionLines(input: OwnerContributionInput): NewLine[] {
  if (!input.subjectId) throw new Error("owner contribution: needs to know who put the money in");
  if (!(input.amount > 0)) throw new Error("owner contribution: amount must be positive");
  if (!input.wallet) throw new Error("owner contribution: needs the wallet the money landed in");
  return [
    { account: "owner_equity", subjectId: input.subjectId, amount: input.amount },
    { account: "wallet", subjectId: input.wallet, amount: input.amount },
  ];
}

// ── Reading ─────────────────────────────────────────────────────────────────

type Rows = Pick<Balance, "subjectId" | "amount">[];

/** Exactly what the ledger answered — rows by subject, or a total. */
export interface EquityInputs {
  capitalRows: Rows;
  contributionRows: Rows;
  drawRows: Rows;
  /** SUM(wallet) of `owner_capital` events: the cash-backed part of capital. */
  capitalCash: number;
  /** SUM(stock / wallet / expense) of `stock_adjustment` events. */
  adjustmentStock: number;
  adjustmentWallet: number;
  adjustmentExpense: number;
  /** Lifetime SUM(revenue), SUM(cogs), SUM(expense). */
  revenue: number;
  cogs: number;
  expenses: number;
}

export interface OwnerEquityRow {
  /** `owner`, or a partner id. */
  subjectId: string;
  /** null = no capital entry for this owner. */
  capital: number | null;
  contributions: number;
  withdrawals: number;
}

export interface EquityStatement {
  /** null = «رأس المال الافتتاحي غير مسجل». Never inferred. */
  capital: number | null;
  contributions: number;
  withdrawals: number;
  /** revenue − cogs − expense since the ledger began. */
  accumulatedResult: number;
  /** Opening balance equity not classified as capital. May be negative. */
  openingBalances: number;
  totalEquity: number;
  /** Per owner — capital, contributions, drawings. Profit is NOT allocated: no sharing rule exists in the ledger. */
  owners: OwnerEquityRow[];
}

const sum = (rows: Rows) => rows.reduce((t, r) => t + r.amount, 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
/** `owner#أكل` is still the owner. */
const ownerKey = (subjectId: string) => (isOwnerSubject(subjectId) ? OWNER_SUBJECT : subjectId);

export function equityStatement(i: EquityInputs): EquityStatement {
  const hasCapital = i.capitalRows.length > 0;
  const capital = hasCapital ? round2(sum(i.capitalRows)) : null;
  const contributions = round2(sum(i.contributionRows));
  const withdrawals = round2(sum(i.drawRows));
  const accumulatedResult = round2(
    netProfitOf({ revenue: i.revenue, cogs: i.cogs, expenses: i.expenses }),
  );
  // Capital declared without cash was paid for by what the opening balances
  // already hold: it is taken OUT of them, not added beside them.
  const declaredCapital = (capital ?? 0) - i.capitalCash;
  const openingBalances = round2(
    i.adjustmentStock + i.adjustmentWallet + i.adjustmentExpense - declaredCapital,
  );
  const totalEquity = round2(
    (capital ?? 0) + contributions + openingBalances + accumulatedResult - withdrawals,
  );

  const byOwner = new Map<string, OwnerEquityRow>();
  const row = (subjectId: string) => {
    const key = ownerKey(subjectId);
    let r = byOwner.get(key);
    if (!r)
      byOwner.set(key, (r = { subjectId: key, capital: null, contributions: 0, withdrawals: 0 }));
    return r;
  };
  for (const r of i.capitalRows) {
    const o = row(r.subjectId);
    o.capital = round2((o.capital ?? 0) + r.amount);
  }
  for (const r of i.contributionRows) {
    const o = row(r.subjectId);
    o.contributions = round2(o.contributions + r.amount);
  }
  for (const r of i.drawRows) {
    const o = row(r.subjectId);
    o.withdrawals = round2(o.withdrawals + r.amount);
  }

  return {
    capital,
    contributions,
    withdrawals,
    accumulatedResult,
    openingBalances,
    totalEquity,
    owners: [...byOwner.values()],
  };
}

type BalancesFn = (q: BalanceQuery) => Promise<Balance[]>;

/**
 * Read every input from the ledger. THROWS if any read fails — a statement
 * built on a failed read would print an invented number.
 */
export async function fetchEquity(balances: BalancesFn): Promise<EquityStatement> {
  const [
    capitalRows,
    contributionRows,
    drawRows,
    capitalCash,
    adjStock,
    adjWallet,
    adjExpense,
    revenue,
    cogs,
    expenses,
  ] = await Promise.all([
    balances({ account: "owner_equity", kind: "owner_capital" }),
    balances({ account: "owner_equity", kind: "owner_contribution" }),
    balances({ account: "owner_budget" }),
    balances({ account: "wallet", kind: "owner_capital" }),
    balances({ account: "stock", kind: "stock_adjustment" }),
    balances({ account: "wallet", kind: "stock_adjustment" }),
    balances({ account: "expense", kind: "stock_adjustment" }),
    balances({ account: "revenue" }),
    balances({ account: "cogs" }),
    balances({ account: "expense" }),
  ]);
  return equityStatement({
    capitalRows,
    contributionRows,
    drawRows,
    capitalCash: sum(capitalCash),
    adjustmentStock: sum(adjStock),
    adjustmentWallet: sum(adjWallet),
    adjustmentExpense: sum(adjExpense),
    revenue: sum(revenue),
    cogs: sum(cogs),
    expenses: sum(expenses),
  });
}
