/**
 * Shared Supabase session workflows.
 *
 * Desktop and mobile own their presentation and navigation, but they must not
 * each grow their own answer to the security-sensitive questions below: which
 * Supabase session is current, which store membership it has, and which
 * canonical application role the session receives.
 *
 * This module deliberately does not grant permissions. Membership is read from
 * `store_members`, the same source RLS reads, and all business writes still
 * reach the database under the caller's Supabase JWT.
 */

import { checkLeakedPassword, LEAKED_PASSWORD_MESSAGE_AR } from "@/lib/security";
import { getOperationMode, getSupabaseClient } from "@/lib/supabase";
import { toAppRole, type AppRole } from "@/lib/roles";
import { clearStoreIdCache } from "@/services/api/storeContext";
import { useAuthStore } from "@/store/useAuthStore";
import {
  BUSINESS_PROFILE_TO_BUSINESS_TYPE,
  BUSINESS_TYPE_TO_MODE,
  type BusinessProfile,
} from "@/types";

export type MissingMembershipPolicy = "claim" | "reject";

export type SessionWorkflowResult =
  | { success: true; role: AppRole }
  | {
      success: false;
      code: "no_server" | "invalid_credentials" | "session_unavailable" | "membership_missing";
      message: string;
    };

interface EstablishSessionInput {
  accessToken: string;
  expiresAt?: number;
  userId: string;
  username: string;
  businessProfile: BusinessProfile;
  missingMembership: MissingMembershipPolicy;
  /**
   * May a System Owner hold a session here with NO store membership?
   *
   * True on desktop, which hosts `/system-admin/licenses` — refusing the owner
   * there locks the only account that can issue a licence out of the only
   * screen that issues one.
   *
   * False everywhere else, and mobile leaves it false deliberately: mobile has
   * no System Owner surface, so a store-less owner would land in a shell with
   * nothing in it and a licence screen explaining a store they do not have.
   * Its existing "الحساب غير مربوط بأي متجر" is the more useful answer.
   *
   * Note this gates only the SESSION, never the identity: `isSystemOwner` is
   * resolved and recorded on every surface regardless.
   */
  systemOwnerNeedsNoStore?: boolean;
  /** Desktop keeps its established post-login cloud refresh. Mobile Phase 1 has no data screens. */
  hydrateCloudData: boolean;
}

async function applyBusinessProfile(profile: BusinessProfile): Promise<void> {
  const businessType = BUSINESS_PROFILE_TO_BUSINESS_TYPE[profile];
  useAuthStore.getState().setBusinessType(businessType);
  useAuthStore.getState().setOperationMode(getOperationMode());
  useAuthStore.getState().setBusinessProfile(profile);
  // The business store pulls in data-domain code. It is needed by desktop only
  // after a successful login, not by the mobile shell's initial bundle.
  const { useBusinessStore } = await import("@/store/useBusinessStore");
  useBusinessStore.getState().setBusinessMode(BUSINESS_TYPE_TO_MODE[businessType]);
}

function hydrateAfterLogin(prefix: string): void {
  void import("@/services/cloudHydrate")
    .then((module) => module.hydrateAll())
    .catch((error) => console.error(`${prefix}:`, error));
}

/**
 * Complete an already authenticated Supabase session.
 *
 * `claim` exists solely for the current desktop owner-signup flow and retains
 * its existing `claim_store` behavior. Mobile sign-in always uses `reject` so
 * it can never create a tenant or membership as a side effect of logging in.
 */
export async function establishSupabaseSession(
  input: EstablishSessionInput,
): Promise<SessionWorkflowResult> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return {
      success: false,
      code: "no_server",
      message: "لم يتم العثور على إعدادات السحابة",
    };
  }

  let { data: membership } = await supabase
    .from("store_members")
    .select("role")
    .eq("user_id", input.userId)
    .maybeSingle();

  // ── The System Owner is a GLOBAL identity, asked about first ──────────────
  //
  // `is_system_owner()` matches the signed-in email against an allowlist in
  // `auth.users`. It does not read `store_members`, does not take a store id,
  // and does not consult `has_role` or `store_licensed` — so it can be
  // answered before any store context exists, which is exactly the point.
  //
  // Everything below used to run before anyone asked this question, and a
  // System Owner who happened to hold no membership was therefore treated as a
  // stranger: `reject` refused the sign-in outright, and `claim` MINTED THEM A
  // STORE as a side effect of logging in. Neither is right for an identity
  // that exists above stores. The reported symptom — signing out and back in
  // and finding License Management gone — is the `reject`/no-membership arm of
  // exactly this.
  //
  // A transport failure must not silently promote a stranger, so the answer on
  // failure is `false`. That costs a genuine owner only the redirect shortcut:
  // `SystemOwnerGate` asks the server again when they navigate to the screen.
  let isSystemOwner = false;
  try {
    const { data, error } = await supabase.rpc("is_system_owner");
    isSystemOwner = !error && data === true;
  } catch {
    isSystemOwner = false;
  }
  useAuthStore.getState().setSystemOwner(isSystemOwner);

  // Identity is global; the store-less SESSION is a surface decision. Declared
  // here because both membership branches below consult it.
  const systemOwnerExempt = isSystemOwner && input.systemOwnerNeedsNoStore === true;

  // A global identity must never acquire a tenant by signing in. Claiming here
  // would hand the System Owner a store they did not ask for and did not need,
  // and then that store's licence would start deciding what they can see.
  if (!membership && input.missingMembership === "claim" && !systemOwnerExempt) {
    const { data: claimed, error: claimError } = await supabase.rpc("claim_store", {
      local_store_id: crypto.randomUUID(),
    });
    if (claimError) {
      return {
        success: false,
        code: "membership_missing",
        message: `تم تسجيل الدخول، لكن تعذّر ربط الحساب بمتجر. ${claimError.message}`,
      };
    }

    if (claimed) {
      const reread = await supabase
        .from("store_members")
        .select("role")
        .eq("user_id", input.userId)
        .maybeSingle();
      membership = reread.data;
    }
  }

  // Desktop's established owner-signup path may receive an empty `claimed`
  // response from older RPC deployments. Its historical behavior continued
  // with the least-privileged canonical role in that edge case. Keep that
  // desktop compatibility; mobile always supplies `reject` and fails closed.
  //
  // The System Owner is exempt: refusing the session would lock the one
  // account that can issue licences out of the one screen that issues them,
  // which is a bootstrap the product cannot recover from on its own.
  if (!membership && input.missingMembership === "reject" && !systemOwnerExempt) {
    return {
      success: false,
      code: "membership_missing",
      message: "الحساب غير مربوط بأي متجر. تواصل مع مسؤول المتجر للحصول على دعوة صحيحة.",
    };
  }

  // `membership` is legitimately null for a System Owner who belongs to no
  // store, and was ALSO reachable as null on desktop's `claim` path when an
  // older `claim_store` returned an empty response. This line used to be
  // `membership.role` — TypeScript had been flagging it (TS18047) and it was a
  // real crash, not a false positive.
  //
  // `toAppRole(null)` resolves to the least-privileged role, which is the
  // honest answer for a session with no membership: the System Owner holds NO
  // store rights, and RLS enforces that independently — `is_store_member` is
  // false for them everywhere, so every store-scoped read and write is refused
  // by Postgres no matter what this client-side role says. Global authority
  // travels in `isSystemOwner`, not in here.
  const role = toAppRole(membership?.role ?? null);
  useAuthStore.getState().setSession({
    token: input.accessToken,
    expires_at: new Date(input.expiresAt ? input.expiresAt * 1000 : Date.now() + 3600000) as never,
    machine_id: "cloud-device",
    user: {
      id: input.userId,
      username: input.username,
      role,
      is_active: true,
      created_at: new Date() as never,
      must_change_password: false,
    },
  } as never);

  // Tenancy is derived from the signed-in session. A previous user's cached
  // value must not survive a successful login.
  clearStoreIdCache();

  // Keep desktop's current two post-login hydration opportunities exactly as
  // they are: one after identity is established and one after profile state is
  // applied. Mobile has no data screens in Phase 1, so it intentionally does
  // neither read nor hydrate business records yet.
  if (input.hydrateCloudData) hydrateAfterLogin("hydrate after login failed");

  await applyBusinessProfile(input.businessProfile);

  if (input.hydrateCloudData) hydrateAfterLogin("[Login] hydrate failed");

  return { success: true, role };
}

/** Sign in with the existing Supabase password flow, then establish one canonical app session. */
export async function signInWithPassword(input: {
  email: string;
  password: string;
  businessProfile: BusinessProfile;
  missingMembership: MissingMembershipPolicy;
  /** See `EstablishSessionInput.systemOwnerNeedsNoStore`. Forwarded, not decided here. */
  systemOwnerNeedsNoStore?: boolean;
  hydrateCloudData: boolean;
}): Promise<SessionWorkflowResult> {
  if (getOperationMode() === "offline_local") {
    return {
      success: false,
      code: "no_server",
      message:
        "إعدادات السحابة غير موجودة في هذه النسخة — لا يمكن تسجيل الدخول. راجع متغيرات البيئة VITE_SUPABASE_URL و VITE_SUPABASE_ANON_KEY.",
    };
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, code: "no_server", message: "لم يتم العثور على إعدادات السحابة" };
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: input.email.trim(),
    password: input.password,
  });
  if (error) return { success: false, code: "invalid_credentials", message: error.message };

  if (!data.session || !data.user?.id) {
    return {
      success: false,
      code: "session_unavailable",
      message: "يرجى التحقق من بريدك الإلكتروني لتفعيل الحساب أو المحاولة مجدداً.",
    };
  }

  return establishSupabaseSession({
    accessToken: data.session.access_token,
    expiresAt: data.session.expires_at,
    userId: data.user.id,
    username: input.email.trim(),
    businessProfile: input.businessProfile,
    missingMembership: input.missingMembership,
    systemOwnerNeedsNoStore: input.systemOwnerNeedsNoStore,
    hydrateCloudData: input.hydrateCloudData,
  });
}

export interface PasswordSetupSession {
  email: string | null;
  error: string | null;
}

/** Read the invite/recovery session that supabase-js consumed from the URL fragment. */
export async function readPasswordSetupSession(): Promise<PasswordSetupSession> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { email: null, error: "الإعداد ناقص: التطبيق مش موصول بالسحابة." };
  }

  const { data } = await supabase.auth.getSession();
  return { email: data.session?.user.email ?? null, error: null };
}

/**
 * Finish an invitation or recovery password flow without ever claiming a store.
 * A missing membership is a safe failure: this page is not a tenant-provisioning path.
 */
export async function completePasswordSetup(password: string): Promise<SessionWorkflowResult> {
  if (password.length < 8) {
    return {
      success: false,
      code: "invalid_credentials",
      message: "الباسورد لازم يكون 8 حروف على الأقل.",
    };
  }

  if (await checkLeakedPassword(password)) {
    return { success: false, code: "invalid_credentials", message: LEAKED_PASSWORD_MESSAGE_AR };
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, code: "no_server", message: "الإعداد ناقص: التطبيق مش موصول بالسحابة." };
  }

  const { data: updated, error: updateError } = await supabase.auth.updateUser({ password });
  if (updateError || !updated?.user) {
    return {
      success: false,
      code: "session_unavailable",
      message: updateError?.message
        ? `تعذّر حفظ الباسورد: ${updateError.message}`
        : "تعذّر حفظ الباسورد.",
    };
  }

  const { data: membership } = await supabase
    .from("store_members")
    .select("role")
    .eq("user_id", updated.user.id)
    .maybeSingle();

  if (!membership) {
    return {
      success: false,
      code: "membership_missing",
      message: "الحساب اتعمل بس مش مربوط بأي محل. كلّم صاحب المحل يبعتلك دعوة تاني.",
    };
  }

  const { data: session } = await supabase.auth.getSession();
  const role = toAppRole(membership.role);
  useAuthStore.getState().setSession({
    token: session.session?.access_token ?? "",
    expires_at: new Date(
      session.session?.expires_at ? session.session.expires_at * 1000 : Date.now() + 3600000,
    ) as never,
    machine_id: "cloud-device",
    user: {
      id: updated.user.id,
      username: updated.user.email ?? "",
      role,
      is_active: true,
      created_at: new Date() as never,
    },
  } as never);

  return { success: true, role };
}

/** Same sign-out ordering the desktop sidebar already uses. */
export async function signOutCurrentSession(): Promise<void> {
  try {
    const { logout: serverLogout } = await import("@/lib/api/authServer");
    const token = useAuthStore.getState().sessionToken;
    if (token) await serverLogout({ data: { token } }).catch(() => undefined);
  } catch {
    // Clearing the local Supabase session below remains the important outcome.
  }

  try {
    await getSupabaseClient()?.auth.signOut();
  } catch {
    // Never strand a user in the application because network logout failed.
  }

  useAuthStore.getState().logout();
}
