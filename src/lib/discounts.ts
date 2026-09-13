/**
 * كود الخصم — the one place that decides whether a code may be used.
 *
 * ## Why this exists
 *
 * نقطة البيع and طلبات المتجر each carried their own copy of the rule:
 *
 *     promoDiscounts.find((x) => x.code === input.trim() && x.active)
 *
 * Two copies of one business rule, and both were missing most of it. Neither
 * looked at `expiryDate`, so an expired code applied normally. Neither looked
 * at `maxUses`, so a one-use code could be used forever — there was nothing to
 * count against it anyway (see migration 027). And matching `x.code === input`
 * against a stored code that `addPromoDiscount` had upper-cased meant anything
 * typed in another case simply "did not exist".
 *
 * The amount itself was already shared — `discountAmountFor` in `lib/math` —
 * and stays there. This module is the ELIGIBILITY half, so that both screens
 * ask one question and get one answer.
 *
 * ## What this deliberately does NOT check
 *
 * Minimum order value, per-customer limits, and product/category eligibility.
 * The `discount_codes` table has no column for any of them, so there is no
 * specification to enforce — inventing one here would be a new restriction the
 * shop never agreed to, and would start silently refusing codes that are valid
 * today. If the business wants them, they are a schema change first.
 *
 * ## This is the client-side half
 *
 * It decides what to draw and refuses early with a useful message. It is NOT
 * the security boundary: the limit is enforced by `claim_discount_use` inside a
 * Postgres row lock, because only the database can check-and-increment without
 * a gap. See `services/discountUsage`.
 */

// Relative, not the `@/` alias: this module is imported by the node test
// scripts, which run without Vite's resolver. Same reason `lib/exchange` and
// the ledger builders stay relative.
import { discountAmountFor, round, type DiscountKind } from "./math.ts";

/** The little of a code this module needs. `PromoDiscount` is `any`. */
export interface DiscountLike {
  id: string;
  code?: string;
  type?: DiscountKind | string;
  value?: number | string;
  active?: boolean;
  /** Null / absent means unlimited. */
  maxUses?: number | string | null;
  /** Null / absent means no expiry. */
  expiryDate?: string | Date | null;
  /** Maintained only by the claim RPC — see migration 027. */
  usedCount?: number | string | null;
  totalDiscount?: number | string | null;
}

/** Why a code may not be used, or `null` when it may. */
export type DiscountBlock = "not_found" | "inactive" | "expired" | "exhausted";

/** Arabic for each refusal. One wording, so the two screens cannot disagree. */
export const DISCOUNT_BLOCK_MESSAGE: Record<DiscountBlock, string> = {
  not_found: "كود الخصم غير موجود",
  inactive: "كود الخصم متوقف",
  expired: "كود الخصم منتهي الصلاحية",
  exhausted: "كود الخصم استهلك عدد مرات الاستخدام المسموح بها",
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Codes are stored upper-case; compare that way whatever the operator typed. */
export const normalizeCode = (typed: string): string => typed.trim().toUpperCase();

/**
 * The code with this text, whatever case it was typed in.
 *
 * Matches inactive and expired codes too, on purpose: the operator needs to be
 * told "this code is expired", not "this code does not exist".
 */
export function findDiscountByCode<T extends DiscountLike>(
  codes: readonly T[],
  typed: string,
): T | undefined {
  const wanted = normalizeCode(typed);
  if (!wanted) return undefined;
  return codes.find((c) => normalizeCode(String(c.code ?? "")) === wanted);
}

/**
 * How many uses are left, or `null` when the code is unlimited.
 *
 * Floored at zero: a counter that somehow ran past its limit must not read as
 * a negative number of remaining uses and let one more through.
 */
export function remainingUses(code: DiscountLike | undefined | null): number | null {
  if (!code) return null;
  const max = code.maxUses;
  if (max === null || max === undefined || max === "") return null;
  const limit = num(max);
  if (limit <= 0) return null;
  return Math.max(0, limit - num(code.usedCount));
}

/** Has this code run out? `false` for an unlimited code. */
export function isExhausted(code: DiscountLike | undefined | null): boolean {
  const left = remainingUses(code);
  return left !== null && left <= 0;
}

/** Has this code passed its expiry? `false` when it has none. */
export function isExpired(
  code: DiscountLike | undefined | null,
  now: Date = new Date(),
): boolean {
  const raw = code?.expiryDate;
  if (!raw) return false;
  const at = raw instanceof Date ? raw : new Date(raw);
  // An unparseable date is not an expiry. Refusing a code because its date
  // column holds junk would take a working discount away for a data problem.
  if (Number.isNaN(at.getTime())) return false;
  return at.getTime() < now.getTime();
}

/**
 * May this code be applied right now? The reason, or `null` for yes.
 *
 * The order matters: a missing code is reported before anything else, and
 * "expired" before "exhausted", so the operator is told the fact that actually
 * stops them rather than whichever check happened to run first.
 */
export function discountBlock(
  code: DiscountLike | undefined | null,
  now: Date = new Date(),
): DiscountBlock | null {
  if (!code) return "not_found";
  if (code.active === false) return "inactive";
  if (isExpired(code, now)) return "expired";
  if (isExhausted(code)) return "exhausted";
  return null;
}

/** The boolean form, for a `disabled` or a filter. */
export function canUseDiscount(
  code: DiscountLike | undefined | null,
  now: Date = new Date(),
): boolean {
  return discountBlock(code, now) === null;
}

/**
 * Look a code up and validate it in one step — what both screens' تطبيق does.
 *
 * Returns the amount as well, so the screen never computes its own: the number
 * shown to the operator and the number written to the order come from here.
 */
export type DiscountApplication =
  | { ok: true; code: DiscountLike; amount: number; total: number }
  | { ok: false; block: DiscountBlock; message: string };

export function applyDiscountCode<T extends DiscountLike>(
  codes: readonly T[],
  typed: string,
  subtotal: number,
  now: Date = new Date(),
): DiscountApplication {
  const code = findDiscountByCode(codes, typed);
  const block = discountBlock(code, now);
  if (block || !code) {
    const reason = block ?? "not_found";
    return { ok: false, block: reason, message: DISCOUNT_BLOCK_MESSAGE[reason] };
  }
  const amount = discountAmountFor(subtotal, code.type as DiscountKind, code.value ?? 0);
  return { ok: true, code, amount, total: round(Math.max(0, subtotal - amount)) };
}

/**
 * What a code has actually granted, for صفحة الخصومات.
 *
 * Read off the code row, which `claim_discount_use` is the only writer of. The
 * ORDERS remain the audit trail — `usageOrdersFor` below lists them — but the
 * counter is what the limit is enforced against, so it is what the screen
 * shows. One authority, not two.
 */
export interface DiscountUsage {
  used: number;
  limit: number | null;
  remaining: number | null;
  total: number;
}

export function usageOf(code: DiscountLike): DiscountUsage {
  const max = code.maxUses;
  const limit = max === null || max === undefined || max === "" || num(max) <= 0 ? null : num(max);
  return {
    used: Math.max(0, num(code.usedCount)),
    limit,
    remaining: remainingUses(code),
    total: round(Math.max(0, num(code.totalDiscount))),
  };
}

/** One order or POS sale that used a code — the audit trail behind the count. */
export interface DiscountRedemption {
  ref: string;
  at?: string | Date;
  amount: number;
  channel: "order" | "pos";
}

/**
 * Every document that recorded this code, newest first.
 *
 * Derived from the documents themselves rather than from any counter: this is
 * the "which orders used it" question, and the only truthful answer to it is
 * the orders. Used for the drill-down, never for the limit.
 */
export function redemptionsFor(
  codeId: string,
  orders: readonly any[],
  posSales: readonly any[],
): DiscountRedemption[] {
  const fromOrders: DiscountRedemption[] = orders
    .filter((o) => o?.discountCodeId === codeId)
    .map((o) => ({
      ref: String(o.orderNumber ?? o.id ?? ""),
      at: o.createdAt,
      amount: round(num(o.discountAmount)),
      channel: "order" as const,
    }));

  const fromPos: DiscountRedemption[] = posSales
    .filter((s) => (s?.payload as any)?.discountCodeId === codeId)
    .map((s) => ({
      ref: String((s.payload as any)?.invoiceNumber ?? s.refId ?? s.id ?? ""),
      at: s.occurredAt ?? s.createdAt,
      amount: round(num((s.payload as any)?.discountAmount)),
      channel: "pos" as const,
    }));

  return [...fromOrders, ...fromPos].sort(
    (a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime(),
  );
}
