import { useEffect } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { toAppRole } from "@/lib/roles";
import { useAuthStore } from "@/store/useAuthStore";
import { getMobileCapabilities, hasMobileCapability } from "./mobileCapabilities";
import type { MobileCapability } from "./mobileCapabilities";

/**
 * Mobile route-level capability guard.
 *
 * Placed as a layout route around protected mobile screens. It enforces
 * that the authenticated user holds the required mobile capability before
 * rendering the child route.
 *
 * ## What this does
 *
 * - Reads the user's canonical role from `useAuthStore`.
 * - Resolves capabilities via `getMobileCapabilities()` — one canonical source.
 * - If the user lacks the required capability, redirects to the mobile home (`/`).
 * - If the user is not authenticated, redirects to `/login`.
 * - Never duplicates `canAccess()` logic; delegates entirely to the canonical function.
 *
 * ## What this does NOT do
 *
 * - Does not enforce data-level security. RLS remains the security boundary.
 * - Does not create permissions — only maps existing `canAccess()` results.
 * - Does not redirect to desktop routes.
 * - Does not loop: home (`/`) is always reachable for authenticated users.
 *
 * ## Public routes
 *
 * Routes that need no capability check (`/login`, `/set-password`) must NOT
 * be wrapped in this guard. The `MobileRouter` keeps those routes outside
 * the `MobileSessionGate` + `MobileRouteGuard` tree entirely.
 *
 * ## Usage
 *
 * ```tsx
 * // In router.tsx
 * <Route element={<MobileRouteGuard capability="orders" />}>
 *   <Route path="/orders" element={<MobileOrdersScreen />} />
 * </Route>
 * ```
 *
 * For routes that only require authentication (not a specific capability),
 * use `capability={null}`:
 * ```tsx
 * <Route element={<MobileRouteGuard capability={null} />}>
 *   <Route index element={<MobileHomeScreen />} />
 * </Route>
 * ```
 */
export function MobileRouteGuard({
  capability,
}: {
  /** The capability required to access child routes. `null` means authenticated only. */
  capability: MobileCapability | null;
}) {
  const location = useLocation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const userRole = useAuthStore((s) => s.userRole);

  // Not authenticated → send to login, preserving the intended destination.
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  // No specific capability required — authenticated is sufficient.
  if (capability === null) {
    return <Outlet />;
  }

  const appRole = toAppRole(userRole);
  const allowed = hasMobileCapability(appRole, capability);

  if (!allowed) {
    // Redirect to home. Home is always reachable for authenticated users
    // (`home` capability is unconditional), so this can never loop.
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}

/**
 * A hook version of the guard for imperative use inside screen components.
 *
 * Redirects in an effect (after render) rather than during render, which
 * avoids the React warning about navigation during render.
 *
 * Use `MobileRouteGuard` (component) for route-level protection.
 * Use this hook only when a component needs to react to a capability change
 * after it has already mounted (rare).
 */
export function useMobileCapabilityGuard(capability: MobileCapability): boolean {
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const userRole = useAuthStore((s) => s.userRole);

  const appRole = toAppRole(userRole);
  const allowed = isAuthenticated && hasMobileCapability(appRole, capability);

  useEffect(() => {
    if (!isAuthenticated) {
      navigate("/login", { replace: true });
      return;
    }
    if (!allowed) {
      navigate("/", { replace: true });
    }
  }, [isAuthenticated, allowed, navigate]);

  return allowed;
}

/**
 * Returns all capabilities the current authenticated user holds.
 * Useful for conditional rendering within a screen that is already protected.
 */
export function useMobileCapabilities(): ReadonlySet<MobileCapability> {
  const userRole = useAuthStore((s) => s.userRole);
  const appRole = toAppRole(userRole);
  return getMobileCapabilities(appRole);
}
