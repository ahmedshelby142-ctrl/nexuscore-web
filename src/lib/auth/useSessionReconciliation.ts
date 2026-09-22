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

  // ── The membership, re-asked on EVERY boot ────────────────────────────────
  //
  // This block used to sit behind `if (!isAuthenticated)`, so it ran only when
  // the local flag had been LOST. On an ordinary reload the flag is present and
  // the persisted `userRole` was kept verbatim — which is how a demoted user
  // kept an ADMIN sidebar until they happened to clear their storage, and how a
  // role edited by hand in devtools survived a refresh.
  //
  // `store_members.role` is what every RLS check reads, so it is the only
  // honest answer to "what may this person do". Asking it once per boot costs
  // one request and removes the whole class.
  //
  // It is not a privilege grant. The answer can only ever narrow what the UI
  // draws; Postgres re-resolves the same row on every request regardless.
  const uid = data.session.user.id;
  const { data: membership, error: membershipError } = await supabase
    .from("store_members")
    .select("role, store_id")
    .eq("user_id", uid)
    .maybeSingle();

  // A membership that is GONE — the query answered, and answered "no row" —
  // means the person was removed from the shop while signed in. Their local
  // session must not outlive it.
  //
  // The System Owner is exempt: they are a global identity with no membership
  // by design, and signing them out here would lock the one account that can
  // issue licences out of the app on every reload.
  //
  // A FAILED query is not the same answer and must not be treated as one. On a
  // flaky connection `maybeSingle()` returns an error with a null row, and
  // signing the user out for that would throw away their work over a dropped
  // packet. Postgres refuses every read and write from a revoked member anyway,
  // so holding the UI open through a transport failure exposes nothing.
  if (!membershipError && !membership && !useAuthStore.getState().isSystemOwner) {
    if (useAuthStore.getState().isAuthenticated) {
      console.warn("[Auth] the signed-in user no longer holds a store membership — signing out");
    }
    useAuthStore.getState().logout();
    return "unauthenticated";
  }

  // Written unconditionally, from the server's answer. `setSession` refreshes
  // `username`, `userRole` and `isAuthenticated` together, so the persisted
  // copies of all three are replaced rather than merged into.
  //
  // `membershipError` leaves `membership` null and `toAppRole(undefined)`
  // resolves to the LEAST privileged role, so an inconclusive read narrows the
  // UI rather than widening it.
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
        // ── A session that APPEARS ──────────────────────────────────────────
        //
        // This branch did not exist, and its absence broke signing in.
        //
        // The effect above runs once, with `[]` deps. The listener was the
        // only thing that could move the state afterwards, and it only ever
        // moved it DOWN — `if (!session && …)`. A `SIGNED_IN` event always
        // carries a session, so it matched nothing, and a boot that resolved
        // to "unauthenticated" stayed that way until the page was reloaded.
        //
        // That was invisible while the return value was discarded. Once
        // `ProtectedRoute` began gating on it, the sequence became:
        //
        //   boot, no session  → "unauthenticated"
        //   user signs in     → isAuthenticated = true, navigate to "/"
        //   ProtectedRoute    → sessionState !== "authenticated" → /login
        //
        // — correct credentials, bounced straight back to the login screen.
        // Mobile did not bounce (its gate tests "unavailable") but ran without
        // realtime until the next reload, from the same cause.
        //
        // Reporting the session is not a privilege grant. This says only
        // "Supabase currently holds a session", which is the fact this hook
        // exists to track; `ProtectedRoute` still requires `isAuthenticated`
        // as well, and that is set by `establishSupabaseSession` only after
        // membership has been resolved. A forged local flag still cannot
        // conjure a session, and the next boot re-runs the full membership
        // check and signs out anyone whose membership has gone.
        if (session) {
          setState("authenticated");
          return;
        }

        // ── …and one that vanishes ─────────────────────────────────────────
        if (event === "SIGNED_OUT" || event === "TOKEN_REFRESHED") {
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
