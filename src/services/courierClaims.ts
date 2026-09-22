import { getSupabaseClient } from "@/lib/supabase";
import { getSyncIdentity } from "@/services/api/storeContext";
import { toPiastres } from "@/lib/ledger/money";

/**
 * مطالبات شركة الشحن — the workflow around a compensation claim.
 *
 * ## This module moves no money, and that is the design
 *
 * A courier-caused return already books `receivable_courier +fee` when it is
 * confirmed, and a `courier_settlement` event already reduces it. The money is
 * correct and has one home. What was missing is everything AROUND it: has the
 * claim been put to the provider, did they accept it, when, and by whom.
 *
 * So `courier_claims` records STATE. `amountPiastres` is a snapshot of the
 * ledger line for reconciliation, never a balance — nothing sums this table.
 * Writing the amount here as a second financial fact is how two answers to
 * "what does this courier owe us" come to exist.
 *
 * It is equally not a string in a ledger payload. `no_update_ledger_events` is
 * `USING (false)`, so a status living there could never advance past the
 * moment it was written.
 *
 * ## Settling a claim is not refunding a customer
 *
 * Different counterparties, different money, different events. Nothing in this
 * file touches a wallet, a deposit or `revenue`, and `settleClaim` records
 * WHICH `courier_settlement` event closed the claim rather than creating one.
 * The mirror rule lives in `depositResolution.ts`, which touches no courier
 * account.
 */

export type ClaimStatus = "pending" | "submitted" | "approved" | "rejected" | "settled";

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  pending: "لسه متقدّمتش",
  submitted: "اتقدّمت للشركة",
  approved: "الشركة وافقت",
  rejected: "الشركة رفضت",
  settled: "اتحصّلت",
};

/** The legal moves out of each state. Mirrors `courier_claims_guard_status`. */
export const CLAIM_TRANSITIONS: Record<ClaimStatus, readonly ClaimStatus[]> = {
  pending: ["submitted", "rejected"],
  submitted: ["approved", "rejected"],
  approved: ["settled"],
  rejected: [],
  settled: [],
};

export interface CourierClaim {
  id: string;
  store_id: string;
  order_id: string;
  courier_id: string;
  return_record_id: string | null;
  amount_piastres: number;
  status: ClaimStatus;
  settlement_event_id: string | null;
  notes: string | null;
  created_at: string;
  submitted_at: string | null;
  decided_at: string | null;
  settled_at: string | null;
}

const REFUSALS: Record<string, string> = {
  NEXUS_CLAIM_MUST_START_PENDING: "المطالبة لازم تبدأ بحالة «لسه متقدّمتش».",
  NEXUS_CLAIM_BAD_TRANSITION: "الانتقال ده مش مسموح — راجع حالة المطالبة.",
  NEXUS_CLAIM_SETTLEMENT_NEEDS_EVENT:
    "مش ممكن تقفل المطالبة من غير تسوية حقيقية مع شركة الشحن.",
  courier_claims_one_open_per_order: "فيه مطالبة مفتوحة على الطلب ده بالفعل.",
};

function translate(message: string): string {
  for (const [code, text] of Object.entries(REFUSALS)) {
    if (message.includes(code)) return text;
  }
  if (/row-level security|42501/i.test(message)) {
    return "صلاحيتك مش بتسمح بإدارة مطالبات الشحن — محتاج مدير أو محاسب.";
  }
  return message;
}

function client() {
  const sb = getSupabaseClient();
  if (!sb) throw new Error("لا يوجد اتصال بالسحابة");
  return sb;
}

/** Every claim for this store, newest first. */
export async function listClaims(): Promise<CourierClaim[]> {
  const { data, error } = await client()
    .from("courier_claims")
    .select("*")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(translate(error.message));
  return (data ?? []) as CourierClaim[];
}

/** The open claim on this order, if one exists. */
export async function claimForOrder(orderId: string): Promise<CourierClaim | null> {
  const { data, error } = await client()
    .from("courier_claims")
    .select("*")
    .eq("order_id", orderId)
    .is("deleted_at", null)
    .neq("status", "rejected")
    .maybeSingle();
  if (error) throw new Error(translate(error.message));
  return (data as CourierClaim) ?? null;
}

/**
 * Raise a claim against the provider for a courier-caused return.
 *
 * `amountEgp` is converted at the same boundary every other amount crosses, so
 * the snapshot is comparable with the `receivable_courier` line without anyone
 * re-deriving a rounding.
 *
 * A second open claim on the same order is refused by
 * `courier_claims_one_open_per_order`, in the database — not by checking first
 * and hoping nothing lands in between.
 */
export async function openClaim(input: {
  orderId: string;
  courierId: string;
  amountEgp: number;
  returnRecordId?: string | null;
  notes?: string;
}): Promise<CourierClaim> {
  const identity = await getSyncIdentity();
  if (!identity) throw new Error("لم يتم ربط هذا الجهاز بمتجر بعد");

  const amount = toPiastres(input.amountEgp);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("قيمة المطالبة لازم تكون أكبر من صفر");
  }

  const { data, error } = await client()
    .from("courier_claims")
    .insert({
      id: crypto.randomUUID(),
      store_id: identity.storeId,
      order_id: input.orderId,
      courier_id: input.courierId,
      return_record_id: input.returnRecordId ?? null,
      amount_piastres: amount,
      status: "pending",
      notes: input.notes ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(translate(error.message));
  return data as CourierClaim;
}

/**
 * Advance a claim. The database decides whether the move is legal — the
 * transition table here only decides what to OFFER.
 *
 * `settlementEventId` is required to reach `settled`, and the trigger enforces
 * it: a claim is closed by a settlement that happened, not by someone choosing
 * the word from a dropdown.
 */
export async function advanceClaim(input: {
  claimId: string;
  to: ClaimStatus;
  settlementEventId?: string;
  notes?: string;
}): Promise<CourierClaim> {
  const patch: Record<string, unknown> = { status: input.to };
  if (input.settlementEventId) patch.settlement_event_id = input.settlementEventId;
  if (input.notes !== undefined) patch.notes = input.notes;

  const { data, error } = await client()
    .from("courier_claims")
    .update(patch)
    .eq("id", input.claimId)
    .select()
    .single();
  if (error) throw new Error(translate(error.message));
  return data as CourierClaim;
}
