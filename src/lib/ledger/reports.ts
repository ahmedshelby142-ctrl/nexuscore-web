/**
 * التقارير المالية (§3.12) — where the P&L defines its terms.
 *
 * Every figure on the reports screen is a `SUM()` over `ledger_lines` inside a
 * date window. Nothing here stores, accumulates or caches a total; this module
 * is the pure arithmetic that turns balance ROWS into the lines of a P&L, so
 * the same functions can be tested on plain arrays without a database.
 *
 * The one thing worth reading before changing a number here:
 *
 *   **`SUM(revenue)` and `SUM(cogs)` are ALREADY NET of returns.**
 *
 * A `return_confirmed` writes `revenue −` and `cogs −` (docs/LEDGER_SCHEMA.md
 * §8), so subtracting returns a second time understates profit by the value of
 * every return. Same for shipping: the courier return fee is an `expense` line,
 * so it is inside `SUM(expense)` and is only ever SPLIT OUT of it, never added.
 * Both figures are shown because the owner asked to SEE them, labelled as
 * already deducted.
 *
 * The brief originally specified «revenue − (COGS + expenses + returns +
 * shipping)». That version is wrong against this ledger; §3.12 of
 * docs/NEXUSCORE_DEV_BRIEF.md now carries the correction, the reasoning, and
 * the two invariants a change here must keep. Read it before editing `pnl()`.
 */

import {
  addDays,
  addMonths,
  addQuarters,
  addYears,
  differenceInCalendarDays,
  format,
  startOfDay,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
} from "date-fns";

import type { BalanceQuery } from "./types";

// ── The period filter ───────────────────────────────────────────────────────

export type PeriodPreset = "day" | "week" | "month" | "quarter" | "year" | "custom";

export const PERIOD_LABELS: Record<PeriodPreset, string> = {
  day: "يوم",
  week: "أسبوع",
  month: "شهر",
  quarter: "كوارتر",
  year: "سنة",
  custom: "نطاق مخصّص",
};

export interface ReportWindow {
  from: Date;
  /** EXCLUSIVE, matching `BalanceQuery.to` and the driver's `occurred_at < ?`. */
  to: Date;
}

/** Saturday — the Egyptian week, same as the ar-EG locale. */
const WEEK_STARTS_ON = 6;

/**
 * The window a preset means, derived from the DATE every time it is asked.
 *
 * Deliberately not stored: an app left open past midnight, or reopened after a
 * month, must report the period it is actually in — the same reason 7.3's
 * monthly budget derives its start from the calendar.
 */
export function periodWindow(
  preset: Exclude<PeriodPreset, "custom">,
  now: Date = new Date(),
): ReportWindow {
  switch (preset) {
    case "day": {
      const from = startOfDay(now);
      return { from, to: addDays(from, 1) };
    }
    case "week": {
      const from = startOfWeek(now, { weekStartsOn: WEEK_STARTS_ON });
      return { from, to: addDays(from, 7) };
    }
    case "month": {
      const from = startOfMonth(now);
      return { from, to: addMonths(from, 1) };
    }
    case "quarter": {
      const from = startOfQuarter(now);
      return { from, to: addQuarters(from, 1) };
    }
    case "year": {
      const from = startOfYear(now);
      return { from, to: addYears(from, 1) };
    }
  }
}

/** A custom from–to, read off two `input type="date"` values. */
export function customWindow(fromISO: string, toISO: string): ReportWindow | null {
  const from = new Date(`${fromISO}T00:00:00`);
  const to = new Date(`${toISO}T00:00:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  // The picker's "to" is the last day the owner means to include, and the
  // ledger's `to` is exclusive — so the day after it is the bound.
  return from <= to ? { from, to: addDays(to, 1) } : null;
}

// ── P&L granularity ─────────────────────────────────────────────────────────

export type Granularity = "day" | "month" | "quarter" | "year";

export const GRANULARITY_LABELS: Record<Granularity, string> = {
  day: "يومي",
  month: "شهري",
  quarter: "ربع سنوي",
  year: "سنوي",
};

/** What a window of this length is naturally read at. The owner can override. */
export function defaultGranularity({ from, to }: ReportWindow): Granularity {
  const days = differenceInCalendarDays(to, from);
  if (days <= 31) return "day";
  if (days <= 366) return "month";
  return "year";
}

export interface Bucket extends ReportWindow {
  label: string;
}

/**
 * ponytail: capped at 60 rows. Each row costs one `fetchPnl` (five indexed
 * SUMs on a local SQLite file), and past a screenful the table stops being
 * readable anyway. Raise the cap if a decade-wide yearly view is ever wanted —
 * do not add a cache.
 */
const MAX_BUCKETS = 60;

/** Split a window into the rows of the P&L table. */
export function buckets({ from, to }: ReportWindow, g: Granularity): Bucket[] {
  const step = (d: Date): Date =>
    g === "day"
      ? addDays(d, 1)
      : g === "month"
        ? addMonths(d, 1)
        : g === "quarter"
          ? addQuarters(d, 1)
          : addYears(d, 1);

  const alignedStart = (d: Date): Date =>
    g === "day"
      ? startOfDay(d)
      : g === "month"
        ? startOfMonth(d)
        : g === "quarter"
          ? startOfQuarter(d)
          : startOfYear(d);

  const out: Bucket[] = [];
  let cursor = alignedStart(from);
  while (cursor < to && out.length < MAX_BUCKETS) {
    const next = step(cursor);
    out.push({
      // Clipped to the requested window, so a partial first or last bucket
      // reports only the days the owner actually asked for.
      from: cursor < from ? from : cursor,
      to: next > to ? to : next,
      label: bucketLabel(cursor, g),
    });
    cursor = next;
  }
  return out;
}

function bucketLabel(d: Date, g: Granularity): string {
  switch (g) {
    case "day":
      return format(d, "dd/MM/yyyy");
    case "month":
      return format(d, "MM/yyyy");
    case "quarter":
      return `ر${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
    case "year":
      return String(d.getFullYear());
  }
}

// ── The P&L itself ──────────────────────────────────────────────────────────

/**
 * `expense` subjects that are shipping cost rather than running cost.
 *
 * `shipping_return` is written by `return_confirmed` — per the schema's
 * who-bears-the-fee table, a RETURN is the shop's only shipping expense; a
 * delivery or an exchange fee nets out through the courier accounts and is
 * neither revenue nor cost. `shipping` is the wholesale delivery cost and the
 * manual «مصاريف شحن وتوصيل» expense category, which share the subject string.
 */
export const SHIPPING_SUBJECTS = ["shipping", "shipping_return"] as const;

const CHANNEL_LABELS: Record<string, string> = {
  pos: "نقطة البيع",
  ecommerce: "الطلبات الإلكترونية",
  wholesale: "الجملة",
};

export function channelLabel(subjectId: string): string {
  return CHANNEL_LABELS[subjectId] ?? subjectId;
}

/** Just the shape of a `Balance` this module needs — keeps the tests plain. */
export interface Row {
  subjectId: string;
  amount: number;
}

export interface PnlInput {
  /** `balances({ account: "revenue", ...window })`. Already net of returns. */
  revenueRows: Row[];
  /** `balances({ account: "expense", ...window })`. */
  expenseRows: Row[];
  /** `SUM(cogs)` for the window. Already net of returns. */
  cogs: number;
  /**
   * `SUM(revenue)` restricted to `kind: "return_confirmed"` — NEGATIVE, being
   * the reversal lines themselves. Display only; see the file header.
   */
  returnsRevenue: number;
  /** `SUM(stock.amount)` restricted to `kind: "purchase"`. Display only. */
  purchases: number;
}

export interface Pnl {
  /** Net sales per channel, biggest first. */
  salesByChannel: Row[];
  /** `SUM(revenue)` — net of returns. */
  netSales: number;
  cogs: number;
  /** `SUM(expense)` on the shipping subjects. A SUBSET of `expenses`. */
  shipping: number;
  /** `SUM(expense)` on everything else: rent, salaries, marketing, جرد… */
  opex: number;
  /** `opex + shipping`, and therefore exactly `SUM(expense)`. */
  expenses: number;
  /** Value returned in the period, as a POSITIVE number. Already deducted. */
  returns: number;
  /** Goods bought into stock. NOT a P&L line — cash became inventory. */
  purchases: number;
  /** `netSales − cogs − expenses`. The only definition of profit in the app. */
  netProfit: number;
}

export function pnl(input: PnlInput): Pnl {
  const sum = (rows: Row[]) => rows.reduce((total, r) => total + r.amount, 0);
  const isShipping = (r: Row) => (SHIPPING_SUBJECTS as readonly string[]).includes(r.subjectId);

  const netSales = sum(input.revenueRows);
  const shipping = sum(input.expenseRows.filter(isShipping));
  const opex = sum(input.expenseRows.filter((r) => !isShipping(r)));
  const expenses = opex + shipping;

  return {
    salesByChannel: [...input.revenueRows]
      .map((r) => ({ subjectId: r.subjectId, amount: r.amount }))
      .sort((a, b) => b.amount - a.amount),
    netSales,
    cogs: input.cogs,
    shipping,
    opex,
    expenses,
    returns: -input.returnsRevenue,
    purchases: input.purchases,
    netProfit: netSales - input.cogs - expenses,
  };
}

// ── Fetching a P&L from the ledger ──────────────────────────────────────────

/**
 * The five queries one P&L row is. Kept beside the arithmetic so there is
 * exactly one definition of "what the report reads", used by the headline
 * cards, every table row and the PDF alike.
 *
 * `balances` is injected rather than imported so the tests can drive this with
 * plain rows; the app always passes `balances` from `@/lib/ledger`.
 */
export type BalancesFn = (query: BalanceQuery) => Promise<Row[]>;

export async function fetchPnl(balances: BalancesFn, w: ReportWindow): Promise<Pnl> {
  const total = (rows: Row[]) => rows.reduce((t, r) => t + r.amount, 0);
  const [revenueRows, cogsRows, expenseRows, returnRows, purchaseRows] = await Promise.all([
    balances({ account: "revenue", ...w }),
    balances({ account: "cogs", ...w }),
    balances({ account: "expense", ...w }),
    balances({ account: "revenue", kind: "return_confirmed", ...w }),
    balances({ account: "stock", kind: "purchase", ...w }),
  ]);
  return pnl({
    revenueRows,
    expenseRows,
    cogs: total(cogsRows),
    returnsRevenue: total(returnRows),
    purchases: total(purchaseRows),
  });
}
