import { Navigate, Outlet } from "react-router-dom";
import { useAuthStore } from "@/store/useAuthStore";
import type { SessionReconciliationState } from "@/lib/auth/useSessionReconciliation";

/**
 * The outermost door: are you signed in, according to the SERVER?
 *
 * ## What this used to be, and why it was not a door
 *
 * ```tsx
 * const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
 * if (!isAuthenticated) return <Navigate to="/login" replace />;
 * ```
 *
 * `isAuthenticated` is a boolean in `localStorage` (`auth-storage-v2`). Nothing
 * here asked Supabase whether it was still true. `useSessionReconciliation`
 * existed to ask — and `useRealtimeSync` called it and threw the answer away.
 *
 * So a session that had expired hours ago, or a flag typed into devtools, or a
 * tab restored after the refresh token was revoked, all rendered the complete
 * application: sidebar, dashboard, POS, every button. Every read behind it
 * returned 401 and every write was refused, which is the database doing its
 * job — but the user was looking at a working shop and being told nothing.
 *
 * ## The three states, and why "checking" needs its own screen
 *
 * Reconciliation is asynchronous. Rendering the app "just for that moment"
 * hands someone a working-looking till for the moment, and flashing /login at
 * a user whose session is perfectly valid is its own kind of wrong. So the
 * first render holds, exactly as `LicenseGate` already holds for its verdict
 * and `MobileSessionGate` holds for this one.
 *
 * `unavailable` means no Supabase is configured. There is no local database to
 * fall back to, so there is no session to have — it is refused with the rest.
 *
 * ## This is the UX half of the lock
 *
 * Nothing here is a security boundary; RLS is. What this fixes is the app
 * lying about which side of the boundary you are on.
 */
export function ProtectedRoute({
  sessionState,
}: {
  sessionState: "checking" | SessionReconciliationState;
}) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (sessionState === "checking") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0B1220]">
        <div className="flex flex-col items-center gap-4">
          <div
            className="size-8 rounded-full border-2 border-[#06B6D4] border-t-transparent animate-spin"
            aria-hidden="true"
          />
          <p className="text-sm text-white/60" aria-live="polite">
            جارٍ التحقق من الجلسة…
          </p>
        </div>
      </div>
    );
  }

  // Both halves must agree. The server's verdict is the authority — it is what
  // makes a hand-edited `isAuthenticated` worthless — and the store flag is
  // still read because `logout()` clears it synchronously, so signing out takes
  // effect on the next render rather than waiting for `onAuthStateChange`.
  if (sessionState !== "authenticated" || !isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
