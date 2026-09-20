import { useEffect } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { useStoreLicense } from "@/store/useStoreLicense";
import { useAuthStore } from "@/store/useAuthStore";
import { isUsable } from "@/lib/license/evaluate";

/**
 * Blocks the business screens when the store's licence is not current.
 *
 * Sits INSIDE `ProtectedRoute` (you must be signed in before a licence means
 * anything) and OUTSIDE `RequireAccess` (an expired shop is shut for every
 * role, so there is no point asking which screens this user may see).
 *
 * What it deliberately does not do: stop sync. This is a route element. The
 * sync hook lives in `App()` above the router and never unmounts, so a shop
 * that expired holding a day of offline sales still uploads every one of them.
 */
export function LicenseGate() {
  const { decision, resolved, hydrate, refresh } = useStoreLicense();
  const isSystemOwner = useAuthStore((s) => s.isSystemOwner);

  useEffect(() => {
    hydrate();
    void refresh();

    // Re-check when the machine comes back online, so a shop that renews while
    // offline is let back in without restarting the app.
    const onOnline = () => void refresh();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [hydrate, refresh]);

  // Hold the UI until the first verdict lands: rendering the business screens
  // "just for a moment" would let someone work in that moment, and flashing the
  // lockout at a paying shop is its own kind of wrong.
  if (!resolved) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0B1220]">
        <div className="flex flex-col items-center gap-4">
          <div className="size-8 rounded-full border-2 border-[#06B6D4] border-t-transparent animate-spin" />
          <p className="text-sm text-white/60">جارٍ التحقق من الترخيص…</p>
        </div>
      </div>
    );
  }

  // `decision === null` means licensing is not enforced in this build (no
  // Supabase configured) — a local-only install has no cloud licence to check.
  if (decision && !isUsable(decision.verdict)) {
    // The System Owner is a GLOBAL identity and must never be locked out by a
    // STORE's licence — least of all out of the screen that issues licences.
    //
    // /license-expired is a dead end by design: it tells a shop to renew. For
    // the person whose job is to renew it, it is a locked door with the key on
    // the other side. Sending them to the manager instead is the difference
    // between "your licence lapsed" and "and now nobody can fix it".
    //
    // This is not a privilege grant. `/system-admin/licenses` sits behind
    // `SystemOwnerGate`, which asks the server, and every RPC behind it
    // re-checks `is_system_owner()` in Postgres. A non-owner who reaches this
    // branch with a tampered flag arrives at a screen that bounces them home.
    if (isSystemOwner) return <Navigate to="/system-admin/licenses" replace />;
    return <Navigate to="/license-expired" replace />;
  }

  return <Outlet />;
}
