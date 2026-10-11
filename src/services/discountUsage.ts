/** Discount eligibility is a read-only preflight. PostgreSQL commits usage with
 * the successful sale/order in the same transaction. Failed transactions need
 * no counter compensation; retries keep the original financial identity. */

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

  // This is only a friendly preflight. The deferred database trigger checks
  // the limit again and accounts the use with the committed sale/order.
  const { data, error } = await sb.rpc("validate_discount_use", {
    p_store: storeId,
    p_code_id: codeId,
    p_amount: amount,
  });
  if (error) throw new Error(messageForClaimError(error.message ?? error));

  if (data) mergeLocally(data);
}

/** Failure cleanup refreshes the committed row without changing usage. */
export async function releaseDiscountUse(codeId: string, amount: number): Promise<void> {
  // A refused financial transaction rolled its use back too. There is no
  // separate claim to decrement, including on a repeated/lost-reply failure.
  // Keep the existing callers' cleanup entry point without a mutable RPC.
  if (!Number.isFinite(amount) || amount < 0) return;
  await refreshDiscountRow(codeId);
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
 * Reconcile from an identified persisted document, never an unpaired delta.
 * Pending edits use record_order_edit so this occurs inside their transaction.
 */
export async function adjustDiscountTotal(
  codeId: string,
  delta: number,
  orderId: string,
): Promise<void> {
  if (!Number.isFinite(delta)) throw new Error("قيمة الخصم غير صالحة");
  {
    const sb = getSupabaseClient();
    if (!sb) throw new Error("تعذّر تحديث إحصاءات الخصم — لا يوجد اتصال بالسحابة");
    const storeId = await getActiveStoreId();
    if (!storeId) throw new Error("لم يتم ربط هذا الجهاز بمتجر بعد");
    const { error } = await sb.rpc("reconcile_discount_order", {
      p_store: storeId,
      p_code_id: codeId,
      p_order_id: orderId,
    });
    if (error) throw new Error(`تعذّر تأكيد إحصاءات الخصم: ${error.message}`);
    await refreshDiscountRow(codeId);
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
