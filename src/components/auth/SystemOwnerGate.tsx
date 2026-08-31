import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { checkSystemOwner } from "@/services/licenseAdmin";

/**
 * Gate for `/system-admin/*`.
 *
 * The verdict comes from the server (`is_system_owner()`), not from a list in
 * the bundle — so it cannot drift from the RPCs it is guarding, and the owner
 * emails are never shipped to a client machine.
 *
 * This gate hides; it does not protect. Every admin RPC re-checks ownership in
 * Postgres, so patching the bundle to render this screen yields a screen whose
 * every button returns 42501.
 */
export function SystemOwnerGate() {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void checkSystemOwner().then((ok) => {
      if (!cancelled) setAllowed(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (allowed === null) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0B1220]">
        <div className="size-8 rounded-full border-2 border-[#06B6D4] border-t-transparent animate-spin" />
      </div>
    );
  }

  // Home, not /login: an ordinary signed-in user poking at the URL should land
  // back on their dashboard, not be thrown out of a session they legitimately
  // hold. Nothing here tells them the route exists.
  if (!allowed) return <Navigate to="/" replace />;

  return <Outlet />;
}
