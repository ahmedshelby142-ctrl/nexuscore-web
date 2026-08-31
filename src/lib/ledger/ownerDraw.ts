/**
 * ميزانية صاحبة العمل — a ceiling on personal draws, and the draws themselves.
 *
 * ## What a draw is
 *
 * Not an expense. Rent and salaries are costs of running the shop; money the
 * owner takes for herself is equity leaving the business. It gets its own
 * event kind (`owner_draw`) and its own account (`owner_budget`), so a P&L can
 * ignore it and a budget can count it.
 *
 * ## Who the subject is — READ THIS BEFORE CHANGING IT
 *
 * `owner_budget` lines are keyed by WHO took the money:
 *   - `OWNER_SUBJECT` ("owner") — the business owner's personal draw. This is
 *     what the budget below measures.
 *   - a partner id — a working شريك's draw, which 7.2 treats as an ADVANCE
 *     against that person's dividend share.
 *
 * One event kind, one builder, different subject. That keeps the owner's
 * ceiling from being eaten by a partner's advance, and keeps a partner's
 * advance from being invisible to the distribution rule.
 *
 * ## Nothing here is stored
 *
 * Spent is `SUM(owner_budget)` over the period. The limit and the period are
 * settings the owner types; `spent` and `remaining` are always derived.
 */

import type { NewLine } from "./types";

/** The subject id for the owner's own draws, as opposed to a partner's. */
export const OWNER_SUBJECT = "owner";

/**
 * A personal draw can carry a category (أكل, مشاوير…), and the breakdown must
 * be derivable from the LINES — not from the payload, which is descriptive
 * only and may not be summed (§ ledger rules).
 *
 * So the category lives in the subject id: `owner#أكل`. One ceiling, one
 * total — the budget sums every `owner…` subject — and the same rows give the
 * per-category split for free, with no second account, no second event kind
 * and no arithmetic over payload.
 *
 * A partner's draw keeps a plain partner id, so it is never mistaken for hers.
 */
export function ownerSubjectFor(category?: string | null): string {
  const clean = (category ?? "").trim();
  return clean ? `${OWNER_SUBJECT}#${clean}` : OWNER_SUBJECT;
}

/** Is this subject one of the owner's own draws (categorised or not)? */
export function isOwnerSubject(subjectId: string): boolean {
  return subjectId === OWNER_SUBJECT || subjectId.startsWith(`${OWNER_SUBJECT}#`);
}

/** The category on an owner subject, or null for an uncategorised draw. */
export function categoryOfSubject(subjectId: string): string | null {
  if (!subjectId.startsWith(`${OWNER_SUBJECT}#`)) return null;
  return subjectId.slice(OWNER_SUBJECT.length + 1) || null;
}

/** Starting suggestions. She can type anything else — this is not a fixed set. */
export const DRAW_CATEGORY_SUGGESTIONS = [
  "أكل",
  "مشاوير",
  "فواتير البيت",
  "علاج",
  "مدارس",
  "هدايا",
];

export interface OwnerDrawInput {
  /** `OWNER_SUBJECT` or a partner id. */
  subjectId: string;
  /** EGP, positive: this describes money going out. */
  amount: number;
  /** Which wallet it left. Manual wallets, §3.6a. */
  wallet: string;
}

export function buildOwnerDrawLines(draw: OwnerDrawInput): NewLine[] {
  if (!(draw.amount > 0)) {
    throw new Error("owner draw: amount must be positive");
  }
  if (!draw.subjectId) {
    throw new Error("owner draw: needs to know who took the money");
  }
  if (!draw.wallet) {
    throw new Error("owner draw: needs the wallet the money left");
  }

  return [
    // What was drawn, by whom. The budget and the dividend rule both read this.
    { account: "owner_budget", subjectId: draw.subjectId, amount: draw.amount },
    // The cash that actually left. Without it the till would still show money
    // that is now in someone's pocket.
    { account: "wallet", subjectId: draw.wallet, amount: -draw.amount },
  ];
}

// ── The budget itself ───────────────────────────────────────────────────────

/**
 * How the ceiling behaves. Chosen at setup — the owner asked for control over
 * the period rather than an assumed monthly cycle.
 */
export type BudgetPeriod = "monthly" | "open";

export const BUDGET_PERIOD_LABELS: Record<BudgetPeriod, string> = {
  monthly: "شهري",
  open: "بدون مدة",
};

export const BUDGET_PERIOD_HINTS: Record<BudgetPeriod, string> = {
  monthly: "بيتصفّر لوحده مع أول يوم في الشهر الجديد",
  open: "سقف ثابت بيفضل شغال لحد ما تصفّريه بنفسك",
};

export interface OwnerBudget {
  /** EGP. What she allows herself for the period. */
  limit: number;
  periodType: BudgetPeriod;
  /**
   * Epoch ms. When the CURRENT open period started — set at setup and moved
   * by a manual reset. Ignored for `monthly`, whose period is the calendar.
   */
  startedAt: number;
}

/**
 * Where the current period begins.
 *
 * `monthly` is the calendar month of `now` — derived from the DATE, never from
 * a wallet balance or a stored counter, so it is right after the app has been
 * closed for a month. `open` runs from the last reset.
 */
export function periodStart(budget: OwnerBudget, now: Date = new Date()): Date {
  if (budget.periodType === "monthly") {
    return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  }
  return new Date(budget.startedAt);
}

export type BudgetLevel = "ok" | "warn" | "over";

export interface BudgetStatus {
  spent: number;
  /** limit − spent. NEGATIVE when she has gone past it — shown, not hidden. */
  remaining: number;
  /** 0–100+, for the progress bar. */
  percent: number;
  level: BudgetLevel;
}

/** Amber at 80% of the limit, red at 100%. */
export function budgetStatus(limit: number, spent: number): BudgetStatus {
  const percent = limit > 0 ? (spent / limit) * 100 : 0;
  return {
    spent,
    remaining: limit - spent,
    percent,
    // A draw over the limit is still a real withdrawal: this warns, it never
    // blocks. Refusing it would only mean the money left without a record.
    level: percent >= 100 ? "over" : percent >= 80 ? "warn" : "ok",
  };
}

/**
 * Spent per category for the period, biggest first, from balance ROWS.
 *
 * Input is whatever `balances({ account: "owner_budget", from, to })` returned:
 * partner subjects are filtered out here, so the breakdown and the ceiling
 * always agree — they are the same rows, grouped differently.
 */
export function drawBreakdown(
  rows: { subjectId: string; amount: number }[],
): { category: string | null; amount: number }[] {
  const totals = new Map<string | null, number>();
  for (const row of rows) {
    if (!isOwnerSubject(row.subjectId)) continue;
    const key = categoryOfSubject(row.subjectId);
    totals.set(key, (totals.get(key) ?? 0) + row.amount);
  }
  return [...totals]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
}

/** The ceiling's spent figure: every owner subject, categorised or not. */
export function ownerSpent(rows: { subjectId: string; amount: number }[]): number {
  return rows
    .filter((row) => isOwnerSubject(row.subjectId))
    .reduce((total, row) => total + row.amount, 0);
}
