import { getSupabaseClient } from "@/lib/supabase";
import { getSyncIdentity } from "@/services/api/storeContext";
import { captureReadAuthority, assertReadAuthority } from "@/services/operationalSource";
import { runFinancialCommand, resolvePendingFinancialCommand } from "./financialCommand";

export interface CashierShift {
  id: string;
  cashier_id: string;
  shift_day: string;
  status: "open" | "awaiting_review" | "awaiting_handover" | "handover_reported" | "closed";
  opened_at: string;
  planned_end_at: string;
  opening_piastre: number;
  keep_piastre: number;
  live_expected_piastre: number;
  expected_piastre: number | null;
  actual_piastre: number | null;
  variance_piastre: number | null;
  retained_piastre: number | null;
  handover_piastre: number | null;
  cash_sales_piastre: number;
  cash_refunds_piastre: number;
  cash_expenses_piastre: number;
  other_cash_piastre: number;
  discrepancy_reason?: string;
  closed_at?: string;
  electronic: { wallet_id: string; amount_piastre: number }[];
  movements: {
    event_id: string;
    document_number: string;
    wallet_id: string;
    payment_piastre: number;
    cash_piastre: number;
    category: string;
    recorded_at: string;
  }[];
}
export interface CashierShiftSnapshot {
  enabled: boolean;
  admin: boolean;
  policy: {
    cashier_id: string;
    opening_piastre: number;
    keep_piastre: number;
    updated_at: string;
  } | null;
  shift: CashierShift | null;
  cashiers: { id: string; email: string }[];
  history: Pick<
    CashierShift,
    | "id"
    | "shift_day"
    | "status"
    | "opening_piastre"
    | "expected_piastre"
    | "actual_piastre"
    | "variance_piastre"
    | "retained_piastre"
    | "handover_piastre"
  >[];
  audit: {
    id: number;
    action: string;
    recorded_at: string;
    detail: { input?: { reason?: string } };
  }[];
  allocatable: {
    event_id: string;
    description: string;
    amount_piastre: number;
    created_at: string;
  }[];
}
export function shiftMoneyInput(text: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(text.trim()))
    throw new Error("أدخل مبلغًا صحيحًا حتى منزلتين عشريتين.");
  const [whole, fraction = ""] = text.trim().split(".");
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(value) || value > 1000000000)
    throw new Error("المبلغ خارج الحد المسموح.");
  return value;
}
export async function readCashierShift(): Promise<CashierShiftSnapshot> {
  const authority = captureReadAuthority(),
    identity = await getSyncIdentity(),
    sb = getSupabaseClient();
  if (!identity || !sb) throw new Error("يلزم اتصال بمتجر مسجل.");
  const { data, error } = await sb.rpc("cashier_shift_snapshot", { p_store: identity.storeId });
  assertReadAuthority(authority);
  if (error) throw new Error(error.message);
  if (!data || typeof data.enabled !== "boolean" || typeof data.admin !== "boolean")
    throw new Error("تعذّر التحقق من حالة الوردية.");
  return data as CashierShiftSnapshot;
}
export const actOnCashierShift = (action: string, input: Record<string, unknown> = {}) =>
  runFinancialCommand<{ shiftId: string | null; action: string; replayed: boolean }>(
    "cashier_shift",
    { ...input, action },
    "cashier-shift",
  );
export const resolveCashierShift = () => resolvePendingFinancialCommand("cashier-shift");
export function shiftError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const codes: Record<string, string> = {
    NEXUS_SHIFT_OPEN_REQUIRED: "افتح الوردية قبل تسجيل البيع أو المرتجع.",
    NEXUS_SHIFT_ADMIN_REQUIRED: "هذا الإجراء للمدير فقط.",
    NEXUS_SHIFT_FORBIDDEN: "تعذّر التحقق من صلاحية الوردية أو ترخيص المتجر.",
    NEXUS_SHIFT_WRONG_CASHIER: "الوردية مخصصة لكاشير آخر.",
    NEXUS_SHIFT_OVERRIDE_REASON_REQUIRED: "اكتب سبب تدخل المدير في الوردية.",
    NEXUS_SHIFT_FLOAT_UNFUNDED:
      "الرصيد النقدي المسجل لا يغطي العهدة. راجع النقدية مع المدير دون إنشاء رصيد وهمي.",
    NEXUS_SHIFT_ACTIVE: "أكمل إغلاق الوردية وتسليم النقدية قبل تغيير السياسة.",
    NEXUS_DRAWER_CASH_INSUFFICIENT: "نقدية الدرج لا تكفي لهذه الحركة؛ لم تُسجل العملية.",
    NEXUS_SHIFT_NOT_OPEN: "الوردية ليست مفتوحة؛ حدّث الحالة قبل أي إجراء.",
    NEXUS_SHIFT_STATE_INVALID: "تغيّرت حالة الوردية؛ حدّثها وراجع السجل.",
  };
  for (const [code, text] of Object.entries(codes)) if (message.includes(code)) return text;
  if (/cashier_shift_one_active|cashier_shifts_store_id_shift_day_key/.test(message))
    return "توجد وردية لهذا اليوم أو وردية سابقة لم يكتمل تسليمها.";
  return /NEXUS_SHIFT_|permission denied/i.test(message)
    ? "تعذّر تأكيد إجراء الوردية. حدّث الحالة وراجع البيانات والصلاحية."
    : message;
}
