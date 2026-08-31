/**
 * The door on every route, asking the same map the Sidebar asks.
 *
 * Wrapped once around the whole `<Layout>` rather than sprinkled per route:
 * a screen added later is covered the moment its path exists, instead of
 * waiting for someone to remember a guard. That is how `/branches`, `/users`
 * and `/backups` ended up reachable by URL while their links were hidden.
 *
 * A blocked user is REDIRECTED to their own landing screen, not shown a dead
 * end — `homeFor` guarantees the destination is one they can actually open, so
 * this can never bounce them in a loop.
 */

import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuthStore } from "@/store/useAuthStore";
import { canAccess, homeFor } from "@/lib/roles";

export function RequireAccess() {
  const userRole = useAuthStore((s) => s.userRole);
  const location = useLocation();

  if (canAccess(userRole, location.pathname)) {
    return <Outlet />;
  }

  // `replace` so the blocked URL does not sit in history for the back button
  // to walk into again.
  return <Navigate to={homeFor(userRole)} replace />;
}
