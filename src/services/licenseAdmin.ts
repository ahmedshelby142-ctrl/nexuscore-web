/**
 * Client side of the License Manager.
 *
 * Every call here is an RPC that re-checks `is_system_owner()` in Postgres. The
 * route guard in front of the screen is a courtesy — it stops the wrong person
 * seeing a menu item. THIS is not the security boundary either: the database is.
 * Someone who edits the bundle to render the screen still cannot issue a licence,
 * because every function raises `42501` for a caller who is not an owner.
 *
 * ## Why the owner allowlist is not in this file
 *
 * Hard-coding the two emails client-side would ship them inside every client's
 * .exe, and leave two copies of the list to drift apart. Instead the client asks
 * the server (`is_system_owner`) and believes the answer — one source of truth,
 * and nothing to read out of the bundle.
 */

import { getSupabaseClient } from "@/lib/supabase";

// Key generation lives in `lib/license/key.ts` so it can be unit-tested without
// pulling Supabase into the test runner. Re-exported so callers import one name.
export { generateLicenseKey } from "@/lib/license/key";

export interface AdminStoreRow {
  store_id: string;
  store_name: string;
  created_at: string;
  license_key: string | null;
  plan_type: "BASIC" | "PRO" | null;
  valid_until: string | null;
  status: "active" | "expired" | null;
  member_count: number;
}

/** Ask the server whether the signed-in user may open the manager. */
export async function checkSystemOwner(): Promise<boolean> {
  const sb = getSupabaseClient();
  if (!sb) return false;
  const { data, error } = await sb.rpc("is_system_owner");
  if (error) return false;
  return data === true;
}

export async function listStoresForAdmin(): Promise<AdminStoreRow[]> {
  const sb = getSupabaseClient();
  if (!sb) throw new Error("لا يوجد اتصال بالسحابة");
  const { data, error } = await sb.rpc("admin_list_stores");
  if (error) throw new Error(translateRpcError(error.message));
  return (data ?? []) as AdminStoreRow[];
}

export async function setLicense(input: {
  storeId: string;
  licenseKey: string;
  planType: "BASIC" | "PRO";
  validUntil: string; // ISO
  status?: "active" | "expired";
}): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) throw new Error("لا يوجد اتصال بالسحابة");
  const { error } = await sb.rpc("admin_set_license", {
    p_store_id: input.storeId,
    p_license_key: input.licenseKey,
    p_plan_type: input.planType,
    p_valid_until: input.validUntil,
    p_status: input.status ?? "active",
  });
  if (error) throw new Error(translateRpcError(error.message));
}

export async function revokeLicense(storeId: string): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) throw new Error("لا يوجد اتصال بالسحابة");
  const { error } = await sb.rpc("admin_revoke_license", { p_store_id: storeId });
  if (error) throw new Error(translateRpcError(error.message));
}

/** Postgres speaks English; the screen speaks Arabic. */
function translateRpcError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("not authorised") || m.includes("42501")) {
    return "غير مصرّح لك بهذا الإجراء.";
  }
  if (m.includes("unknown store")) return "المتجر غير موجود.";
  if (m.includes("license key is required")) return "مفتاح الترخيص مطلوب.";
  if (m.includes("plan must be")) return "الباقة يجب أن تكون BASIC أو PRO.";
  if (m.includes("expiry date is required")) return "تاريخ الانتهاء مطلوب.";
  if (m.includes("no license to revoke")) return "هذا المتجر ليس لديه ترخيص لإيقافه.";
  if (m.includes("duplicate key") || m.includes("unique")) {
    return "مفتاح الترخيص مستخدم بالفعل لمتجر آخر.";
  }
  if (m.includes("could not find the function") || m.includes("does not exist")) {
    // The filename is wrapped in an LTR isolate (U+2066 … U+2069). Without it
    // the bidi algorithm reorders the leading digits and Arabic readers see
    // "license_admin_rpc.sql_008" — a filename that does not exist.
    return "دوال الإدارة غير منصّبة. شغّل ⁦008_license_admin_rpc.sql⁩ أولاً.";
  }
  return `تعذّر تنفيذ الإجراء: ${message}`;
}
