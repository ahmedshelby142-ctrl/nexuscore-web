/**
 * نظرة عامة — the arithmetic, without the screen.
 *
 * Pure: ledger rows in, the six summary figures out. It lives here rather than
 * inside the component so `scripts/check_dashboard.mjs` can run the REAL
 * summary over events built by the REAL builders — a .tsx cannot be imported
 * by the node test harness.
 *
 * It computes nothing the ledger cannot answer: every input is either a
 * `balances()` row or an event header.
 */

import type { Balance, LedgerEvent } from "@/lib/ledger";

export type Period = "today" | "week" | "month" | "thisMonth" | "thisYear" | string;

export const PERIOD_LABELS = {
  today: "اليوم",
  week: "آخر ٧ أيام",
  month: "آخر ٣٠ يوم",
  thisMonth: "هذا الشهر",
  thisYear: "هذه السنة",
};

/** Days the trend line covers for each standard period. */
export const TREND_DAYS = { today: 7, week: 7, month: 30 };

export function periodLabel(period: Period): string {
  if (period.match(/^\d{4}-\d{2}$/)) {
    const [year, month] = period.split("-").map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString("ar-EG", { month: "long", year: "numeric" });
  }
  return PERIOD_LABELS[period as keyof typeof PERIOD_LABELS] ?? "";
}

export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * The window a figure is summed over. `to` is exclusive, matching
 * `BalanceQuery`; `from` is midnight, so "اليوم" means today's trading and not
 * "the last 24 hours".
 */
export function windowFor(period: Period, now: Date = new Date()): { from: Date; to: Date } {
  if (period.match(/^\d{4}-\d{2}$/)) {
    const [year, month] = period.split("-").map(Number);
    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 1);
    return { from, to };
  }
  const today = startOfDay(now);
  if (period === "today") return { from: today, to: now };
  if (period === "thisMonth") {
    return { from: new Date(today.getFullYear(), today.getMonth(), 1), to: now };
  }
  if (period === "thisYear") {
    return { from: new Date(today.getFullYear(), 0, 1), to: now };
  }
  return { from: addDays(today, period === "week" ? -6 : -29), to: now };
}

/** The day windows the trend line asks for, oldest first. */
export function trendDays(period: Period, now: Date = new Date()): { from: Date; to: Date }[] {
  if (period.match(/^\d{4}-\d{2}$/)) {
    const [year, month] = period.split("-").map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    return Array.from({ length: daysInMonth }, (_, i) => {
      const from = new Date(year, month - 1, i + 1);
      return { from, to: addDays(from, 1) };
    });
  }
  const today = startOfDay(now);
  
  if (period === "thisMonth") {
    const daysInMonthSoFar = today.getDate();
    const from = new Date(today.getFullYear(), today.getMonth(), 1);
    return Array.from({ length: daysInMonthSoFar }, (_, i) => {
      const d = addDays(from, i);
      return { from: d, to: addDays(d, 1) };
    });
  }

  if (period === "thisYear") {
    const monthsSoFar = today.getMonth() + 1;
    return Array.from({ length: monthsSoFar }, (_, i) => {
      const from = new Date(today.getFullYear(), i, 1);
      return { from, to: new Date(today.getFullYear(), i + 1, 1) };
    });
  }

  const days = TREND_DAYS[period as keyof typeof TREND_DAYS];
  return Array.from({ length: days }, (_, i) => {
    const from = addDays(today, i - (days - 1));
    return { from, to: addDays(from, 1) };
  });
}

export const sumOf = (rows: Balance[]): number =>
  rows.reduce((total, row) => total + row.amount, 0);

export interface Summary {
  revenue: number;
  netProfit: number;
  orders: number;
  returns: number;
  avgOrderValue: number;
  /** Product whose goods left at the highest cost in the window, or null. */
  topProductId: string | null;
}

/**
 * The six figures.
 *
 * `revenue` already carries returns as negatives — a `return_confirmed` writes
 * `revenue −` — so nothing here subtracts them a second time. An order is any
 * `sale` (POS or wholesale) plus any online order placed in the window.
 */
export function summarise(input: {
  revenueRows: Balance[];
  cogsRows: Balance[];
  expenseRows: Balance[];
  events: Pick<LedgerEvent, "kind">[];
}): Summary {
  const revenue = sumOf(input.revenueRows);
  const orders = input.events.filter(
    (e) => e.kind === "sale" || e.kind === "order_placed",
  ).length;
  const top = [...input.cogsRows].sort((a, b) => b.amount - a.amount)[0];

  return {
    revenue,
    netProfit: revenue - sumOf(input.cogsRows) - sumOf(input.expenseRows),
    orders,
    returns: input.events.filter((e) => e.kind === "return_confirmed").length,
    avgOrderValue: orders > 0 ? revenue / orders : 0,
    topProductId: top && top.amount > 0 ? top.subjectId : null,
  };
}
