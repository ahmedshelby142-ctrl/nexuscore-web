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
    return "unauthenticated";
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
