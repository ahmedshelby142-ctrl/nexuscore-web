/**
 * What a money figure may show, given the reads it was computed from.
 *
 * `useBalances` answers `total = 0` / `amountOf() = 0` in two situations that
 * are not zero at all: before its first read lands, and after that read FAILS.
 * A screen that renders the number without asking which one it is paints
 * «٠ ج.م» — which an owner reads as "the shop took nothing" or "this courier
 * owes us nothing", and acts on.
 *
 * So a figure is only a number when EVERY read under it succeeded:
 *
 *   any read failed   →  `formatMoney(null)`, the project's existing "— ج.م"
 *   any still loading →  "…"
 *   all succeeded     →  the number
 *
 * Failure outranks loading: a retry in flight after a failure is still a
 * failure until it lands, and must not flash a number from before it.
 *
 * Pure and node-loadable — the tests drive it directly.
 */

import { formatMoney } from "./math.ts";

export interface ReadState {
  loading: boolean;
  error: string | null;
}

export type FigureStatus = "loading" | "error" | "ready";

export function statusOf(...reads: ReadState[]): FigureStatus {
  if (reads.some((r) => r.error)) return "error";
  if (reads.some((r) => r.loading)) return "loading";
  return "ready";
}

/**
 * `render()` — only called once every read succeeded — or the honest
 * placeholder. For figures that are not plain money, like a signed balance
 * worded «علينا / لنا».
 */
export function figureOr(render: () => string, ...reads: ReadState[]): string {
  const status = statusOf(...reads);
  if (status === "error") return formatMoney(null);
  if (status === "loading") return "…";
  return render();
}

/** `value` formatted as money, or the honest placeholder for its reads. */
export function moneyFigure(value: number, ...reads: ReadState[]): string {
  return figureOr(() => formatMoney(value), ...reads);
}
