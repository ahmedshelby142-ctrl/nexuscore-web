import { dayRangeBounds } from "@/lib/orderSearch";
import { windowFor } from "@/lib/dashboard";

/**
 * The Orders date filter: the app's existing presets plus a custom range.
 *
 * Presets reuse `windowFor` — the definitions and labels the dashboards
 * already use — so «آخر ٧ أيام» means the same seven days everywhere. The
 * custom range is inclusive at both ends and is turned into server bounds by
 * `dayRangeBounds`, the same boundary rule as Desktop's `ordersInPeriod`.
 */
export type OrderDatePreset = "all" | "today" | "week" | "thisMonth" | "custom";

export interface OrderDateSelection {
  preset: OrderDatePreset;
  /** `YYYY-MM-DD`, only for `custom`. */
  from?: string;
  to?: string;
}

export const ORDER_DATE_PRESETS: readonly { id: OrderDatePreset; label: string }[] = [
  { id: "all", label: "كل التواريخ" },
  { id: "today", label: "اليوم" },
  { id: "week", label: "آخر ٧ أيام" },
  { id: "thisMonth", label: "هذا الشهر" },
  { id: "custom", label: "فترة مخصصة" },
];

/** What `readMobileOrders` receives: `createdAt >= createdFrom AND < createdBefore`. */
export interface OrderDateBounds {
  createdFrom?: string;
  createdBefore?: string;
}

export type OrderDateResolution =
  | { status: "ok"; bounds: OrderDateBounds }
  /** Custom with one or both dates missing — not applied, never guessed. */
  | { status: "incomplete" }
  | { status: "reversed"; messageAr: string }
  | { status: "invalid"; messageAr: string };

export const REVERSED_RANGE_AR = "تاريخ البداية بعد تاريخ النهاية — اختار فترة صحيحة.";

export function resolveOrderDateFilter(selection: OrderDateSelection, now: Date = new Date()): OrderDateResolution {
  if (selection.preset === "all") return { status: "ok", bounds: {} };
  if (selection.preset !== "custom") {
    // Orders cannot be created in the future, so a preset needs only its start.
    return { status: "ok", bounds: { createdFrom: windowFor(selection.preset, now).from.toISOString() } };
  }
  const from = selection.from ?? "";
  const to = selection.to ?? "";
  if (!from || !to) return { status: "incomplete" };
  const bounds = dayRangeBounds(from, to);
  if (bounds.status === "invalid") return { status: "invalid", messageAr: "تاريخ غير صالح." };
  if (bounds.status === "reversed") return { status: "reversed", messageAr: REVERSED_RANGE_AR };
  return {
    status: "ok",
    bounds: { createdFrom: bounds.start!.toISOString(), createdBefore: bounds.end!.toISOString() },
  };
}

/**
 * The ONE reading of a persisted (URL) date filter — what both the trigger's
 * label and the query use.
 *
 * A custom range is kept only if `resolveOrderDateFilter` applies it; anything
 * else — a missing end, an impossible or malformed day, a reversed pair, an
 * unknown preset — is "no date filter". It used to reach the label as typed
 * while the query silently dropped it: `?date=custom&from=2026-99-99&to=x`
 * listed every order under «٧/٦/٢٠٣٤ – Invalid Date». A preset carries no days.
 */
export function parseOrderDateSelection(raw: { date?: string | null; from?: string | null; to?: string | null }): OrderDateSelection {
  const preset = ORDER_DATE_PRESETS.find((p) => p.id === raw.date)?.id ?? "all";
  if (preset !== "custom") return { preset };
  const selection: OrderDateSelection = { preset, from: raw.from || undefined, to: raw.to || undefined };
  return resolveOrderDateFilter(selection).status === "ok" ? selection : { preset: "all" };
}

/** «١/٩/٢٠٢٦ – ٣٠/٩/٢٠٢٦» for the trigger, or the preset's label. */
export function orderDateFilterLabel(selection: OrderDateSelection): string {
  if (selection.preset === "custom" && selection.from && selection.to) {
    const day = (value: string) => {
      const [y, m, d] = value.split("-").map(Number);
      return new Date(y, m - 1, d).toLocaleDateString("ar-EG", { day: "numeric", month: "numeric", year: "numeric" });
    };
    return `${day(selection.from)} – ${day(selection.to)}`;
  }
  return ORDER_DATE_PRESETS.find((p) => p.id === selection.preset)?.label ?? "التاريخ";
}
