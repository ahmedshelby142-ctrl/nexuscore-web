import { useEffect, useState } from "react";
import { toAppRole } from "@/lib/roles";
import { getSupabaseClient, isCloudSyncMode } from "@/lib/supabase";
import { useAuthStore } from "@/store/useAuthStore";

export type SessionReconciliationState = "authenticated" | "unauthenticated" | "unavailable";

/**
 * Make Zustand's local auth mirror agree with Supabase's real session.
 *
 * This is the existing desktop reconciliation behavior, extracted so the
 * independent mobile entry gets the same fail-closed session recovery without
 * mounting desktop data hydration or realtime business subscriptions.
 */
export async function reconcileSupabaseSession(): Promise<SessionReconciliationState> {
  if (!isCloudSyncMode()) return "unavailable";

  const supabase = getSupabaseClient();
  if (!supabase) return "unavailable";

  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    if (useAuthStore.getState().isAuthenticated) {
      console.warn("[Auth] local session flag with no Supabase session — signing out");
      useAuthStore.getState().logout();
    }
    // No session, no global identity. `logout()` clears it too, but this path
    // is also reached when there was never a local flag to clear.
    useAuthStore.getState().setSystemOwner(false);
    return "unauthenticated";
  }

  // ── The global identity, re-asked on every boot ───────────────────────────
  //
  // `isSystemOwner` is deliberately NOT persisted: a flag in localStorage that
  // decides what the UI unlocks is a flag an attacker edits. The cost of that
  // choice is that it does not survive a reload, and it is resolved on LOGIN
  // only — so a refresh left a genuine owner with `false`.
  //
  // That is not cosmetic. A store-less System Owner sees no `store_licenses`
  // row (RLS: `is_store_member` is false everywhere for them), so
  // `evaluateLicense(null)` returns `unlicensed`, and `LicenseGate` sends
  // anyone without the flag to /license-expired — a screen telling the person
  // whose job is to issue licences that their licence has lapsed. Pressing F5
  // reproduced the exact bug the login path was fixed to remove.
  //
  // So the question is asked here too: this is the one step that runs on every
  // boot and already answers "who is this". Same RPC, same fail-closed
  // default — a transport failure denies rather than promotes.
  //
  // It widens nothing. Mobile mounts this hook and reads `isSystemOwner`
  // nowhere; `MobileSessionGate` does not consult it, and mobile has no
  // System Owner surface to reach. On desktop it only restores what a login
  // had already established.
  try {
    const { data: owner, error } = await supabase.rpc("is_system_owner");
    useAuthStore.getState().setSystemOwner(!error && owner === true);
  } catch {
    useAuthStore.getState().setSystemOwner(false);
  }

  if (!useAuthStore.getState().isAuthenticated) {
    const uid = data.session.user.id;
    const { data: membership } = await supabase
      .from("store_members")
      .select("role")
      .eq("user_id", uid)
      .maybeSingle();

    useAuthStore.getState().setSession({
      token: data.session.access_token,
      expires_at: new Date(
        data.session.expires_at ? data.session.expires_at * 1000 : Date.now() + 3600000,
      ) as never,
      machine_id: "cloud-device",
      user: {
        id: uid,
        username: data.session.user.email ?? "",
        role: toAppRole(membership?.role),
        is_active: true,
        created_at: new Date() as never,
      },
    } as never);
    console.info("[Auth] restored a valid Supabase session the local store had lost");
  }

  return "authenticated";
}

export function useSessionReconciliation(): "checking" | SessionReconciliationState {
  const [state, setState] = useState<"checking" | SessionReconciliationState>("checking");

  useEffect(() => {
    if (!isCloudSyncMode()) {
      setState("unavailable");
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      const reconciled = await reconcileSupabaseSession();
      if (cancelled) return;
      setState(reconciled);

      const supabase = getSupabaseClient();
      if (!supabase) return;
      const { data } = supabase.auth.onAuthStateChange((event, session) => {
        if (!session && (event === "SIGNED_OUT" || event === "TOKEN_REFRESHED")) {
          if (useAuthStore.getState().isAuthenticated) useAuthStore.getState().logout();
          setState("unauthenticated");
        }
      });
      unsubscribe = () => data.subscription.unsubscribe();
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return state;
}
