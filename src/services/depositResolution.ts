import { getSupabaseClient } from "@/lib/supabase";

/**
 * تسوية العميلة — refunding a deposit after a return the shop did not cause.
 *
 * ## Why this is an RPC and not a `writeThrough`
 *
 * Handing money back is a financial operation, and every check that makes it
 * legitimate is a question about state this client cannot be trusted to answer:
 *
 *   is this order mine?              `select_orders`, from `auth.uid()`
 *   may this user refund?            `insert_ledger_events`, role-gated
 *   is the shop licensed?            `insert_ledger_lines`
 *   did the cause qualify?           `orders.return_cause`
 *   was a deposit ever banked?       the ledger
 *   has it already been refunded?    the ledger, under a lock
 *
 * A client that computed the amount and posted the lines would be deciding all
 * six, and two browsers pressing the button together would each decide "not
 * yet refunded" and write two refunds. `refund_order_deposit` (migration 038)
 * settles them inside one statement, behind a per-order advisory lock, and
 * derives the amount itself — this function does not send one, deliberately.
 *
 * It is SECURITY INVOKER, so none of those checks is a copy: they are the same
 * policies that guard every other write.
 */

/** What the server refused, in the operator's language. */
const REFUSALS: Record<string, string> = {
  NEXUS_ORDER_NOT_FOUND: "الطلب ده مش موجود في المتجر بتاعك.",
  NEXUS_CAUSE_NOT_ELIGIBLE:
    "رد العربون متاح بس لما يكون سبب المرتجع المحل أو شركة الشحن — العميلة لو لغت بنفسها، العربون ميترجعش.",
  NEXUS_NOTHING_TO_REFUND:
    "مفيش عربون مستني تسوية على الطلب ده — يا إما اترد قبل كده، يا إما ماكانش اتسجّل أصلاً.",
  NEXUS_WALLET_REQUIRED: "اختار الخزينة اللي العربون هيترد منها.",
};

export interface DepositRefundResult {
  /** The `deposit_refunded` event id, for the operator's record. */
  eventId: string;
}

/**
 * Refund this order's held deposit. Throws with an Arabic message on refusal.
 *
 * The amount is NOT a parameter. Whatever is still standing on
 * `revenue / deposit_pending_resolution` for this order is what comes back —
 * so a client cannot ask for more than the customer left, and a second call
 * finds zero and is refused.
 */
export async function refundOrderDeposit(input: {
  orderId: string;
  wallet: string;
  note?: string;
}): Promise<DepositRefundResult> {
  const sb = getSupabaseClient();
  if (!sb) throw new Error("لا يوجد اتصال بالسحابة — لم يتم رد أي عربون");

  const { data, error } = await sb.rpc("refund_order_deposit", {
    p_order_id: input.orderId,
    p_wallet: input.wallet,
    p_note: input.note ?? null,
  });

  if (error) {
    // Postgres puts `RAISE EXCEPTION 'NEXUS_…'` in the message. Matched rather
    // than compared, because PostgREST wraps it.
    for (const [code, message] of Object.entries(REFUSALS)) {
      if (error.message.includes(code)) throw new Error(message);
    }
    // Role and licence refusals arrive as a policy violation, not as one of
    // ours — the gate is `insert_ledger_events`, which does not get to choose
    // its wording.
    if (/row-level security|42501/i.test(error.message)) {
      throw new Error("صلاحيتك مش بتسمح برد العربون — محتاج مدير أو محاسب.");
    }
    throw new Error(`تعذّر رد العربون: ${error.message}`);
  }

  if (typeof data !== "string" || !data) {
    throw new Error("تعذّر رد العربون: رد غير متوقع من الخادم");
  }
  return { eventId: data };
}
