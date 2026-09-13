/**
 * Claiming and releasing a discount use — the atomic half.
 *
 * ## Why this is an RPC and not an update
 *
 * Enforcing `maxUses` means reading the current count and incrementing it with
 * nothing able to happen in between. A browser cannot do that against
 * PostgREST: `select` then `update` always leaves a gap, and two tills a
 * millisecond apart both read `used = limit - 1` and both proceed. Counting
 * orders instead of keeping a counter does not help — the count only moves once
 * the order is written, which is after the check.
 *
 * `claim_discount_use` (migration 027) does the check and the increment inside
 * one transaction holding a row lock, exactly as `next_document_number` does
 * for invoice numbers. That is the only place the answer can be trusted, so it
 * is the only place the limit is enforced; `lib/discounts` is the early,
 * friendly refusal, not the boundary.
 *
 * ## The order of operations, and why
 *
 *     claim → write the order → (on failure) release
 *
 * Claiming first means a code can never be spent by more orders than its limit.
 * The opposite order — order first, claim after — would let a sold-out code
 * through whenever the claim failed, and there is no way to un-sell the goods.
 * A claim held for an order that then fails is given back by `releaseUse`, so
 * the failure direction is a use temporarily unavailable rather than a
 * discount granted for free.
 */

import { getSupabaseClient } from "@/lib/supabase";
import { getActiveStoreId } from "@/services/api/storeContext";
import { useBusinessStore } from "@/store/useBusinessStore";
import { DISCOUNT_BLOCK_MESSAGE, type DiscountBlock } from "@/lib/discounts";

/** The refusals `claim_discount_use` raises, mapped to the shared wording. */
const CLAIM_ERRORS: Record<string, string> = {
  NEXUS_CODE_NOT_FOUND: DISCOUNT_BLOCK_MESSAGE.not_found,
  NEXUS_CODE_INACTIVE: DISCOUNT_BLOCK_MESSAGE.inactive,
  NEXUS_CODE_EXPIRED: DISCOUNT_BLOCK_MESSAGE.expired,
  NEXUS_CODE_EXHAUSTED: DISCOUNT_BLOCK_MESSAGE.exhausted,
  NEXUS_NOT_A_MEMBER: "مش مسموح لك تستخدم أكواد خصم المتجر ده",
  NEXUS_BAD_AMOUNT: "قيمة الخصم غير صالحة",
};

/** The block a raised error corresponds to, when it maps to one. */
export function blockFromClaimError(e: unknown): DiscountBlock | null {
  const raw = e instanceof Error ? e.message : String(e);
  if (raw.includes("NEXUS_CODE_NOT_FOUND")) return "not_found";
  if (raw.includes("NEXUS_CODE_INACTIVE")) return "inactive";
  if (raw.includes("NEXUS_CODE_EXPIRED")) return "expired";
  if (raw.includes("NEXUS_CODE_EXHAUSTED")) return "exhausted";
  return null;
}

/** Arabic for whatever the claim refused with. */
export function messageForClaimError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  for (const [code, message] of Object.entries(CLAIM_ERRORS)) {
    if (raw.includes(code)) return message;
  }
  return `تعذّر استخدام كود الخصم. ${raw}`;
}

/**
 * Take one use of a code. Throws — with an Arabic message — if it may not be.
 *
 * The row that comes back is the committed one, so the local copy is refreshed
 * from it: the screen's "used / remaining" is then the database's answer and
 * not this tab's guess.
 */
export async function claimDiscountUse(codeId: string, amount: number): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) throw new Error("لا يوجد اتصال بالسحابة — لم يتم تطبيق كود الخصم");

  const storeId = await getActiveStoreId();
  if (!storeId) throw new Error("لم يتم ربط هذا الجهاز بمتجر بعد");

  const { data, error } = await sb.rpc("claim_discount_use", {
    p_store: storeId,
    p_code_id: codeId,
    p_amount: amount,
  });
  if (error) throw new Error(messageForClaimError(error.message ?? error));

  if (data) mergeLocally(data);
}

/**
 * Give a claim back. Never throws: it runs on a path that is already failing,
 * and turning the compensation into a second error would replace the message
 * explaining what actually went wrong.
 *
 * A release that genuinely fails leaves one use unavailable on a code — visible
 * on the Discounts screen and fixable, unlike the alternative.
 */
export async function releaseDiscountUse(codeId: string, amount: number): Promise<void> {
  try {
    const sb = getSupabaseClient();
    if (!sb) return;
    const storeId = await getActiveStoreId();
    if (!storeId) return;
    await sb.rpc("release_discount_use", {
      p_store: storeId,
      p_code_id: codeId,
      p_amount: amount,
    });
    await refreshDiscountRow(codeId);
  } catch (e) {
    console.error("[discountUsage] release failed", e);
  }
}

/**
 * Move only what a code has GRANTED, leaving the use count alone.
 *
 * Editing an order re-prices its discount — a percentage follows the new
 * basket — which changes the money without changing how many times the code was
 * used. Neither claim nor release fits: one would consume a second use, the
 * other would give the use back. Without this the Discounts screen kept
 * reporting the discount the order was FIRST given.
 *
 * Never throws, for the same reason `releaseDiscountUse` does not: it runs
 * beside an edit that has already been saved.
 */
export async function adjustDiscountTotal(codeId: string, delta: number): Promise<void> {
  if (!delta) return;
  try {
    const sb = getSupabaseClient();
    if (!sb) return;
    const storeId = await getActiveStoreId();
    if (!storeId) return;
    await sb.rpc("adjust_discount_total", {
      p_store: storeId,
      p_code_id: codeId,
      p_delta: delta,
    });
    await refreshDiscountRow(codeId);
  } catch (e) {
    console.error("[discountUsage] adjust failed", e);
  }
}

/** Re-read one code so the screens show the committed counters. */
export async function refreshDiscountRow(codeId: string): Promise<void> {
  try {
    const sb = getSupabaseClient();
    if (!sb) return;
    const storeId = await getActiveStoreId();
    if (!storeId) return;
    const { data } = await sb
      .from("discount_codes")
      .select("*")
      .eq("id", codeId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (data) mergeLocally(data);
  } catch {
    /* the counters stay as they were; the next hydrate corrects them */
  }
}

/**
 * Merge the committed row into the store WITHOUT writing it back.
 *
 * Deliberately `setState` and not the store's `updatePromoDiscount`: that one
 * upserts the whole row to Supabase, which would send the counters straight
 * back at the database. The trigger from migration 027 would pin them anyway,
 * but a write that exists only to be ignored is a write nobody should have to
 * reason about.
 */
function mergeLocally(row: any): void {
  useBusinessStore.setState((state: any) => ({
    promoDiscounts: (state.promoDiscounts ?? []).map((d: any) =>
      d.id === row.id ? { ...d, ...row } : d,
    ),
  }));
}
