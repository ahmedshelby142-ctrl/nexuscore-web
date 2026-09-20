import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getOperationMode } from "@/lib/supabase";
import type {
  PublicSession,
  UserRole,
  BusinessType,
  OperationMode,
  BusinessProfile,
  SessionRecord,
} from "@/types";

/**
 * Authentication state.
 *
 * The store exposes TWO layers of API:
 *
 *   1. The legacy fields (userRole / businessType / operationMode /
 *      isAuthenticated / username / activeBusinessProfile) — these
 *      are what every existing screen reads. We keep them in sync
 *      with the real session.
 *
 *   2. The new "real auth" layer (status / session / lastError /
 *      bootstrapped) — this is what the Login page writes to.
 *
 * The Login page is the only place that calls login() / logout() and
 * writes to `status` / `session`. Every other screen reads the legacy
 * fields which are automatically updated when the session changes.
 *
 * IMPORTANT: This store is the *client* view of the session. The
 * authoritative session lives on the server (auth_sessions table).
 * Server functions (src/lib/api/authServer.ts) verify the token on
 * every sensitive call. A tampered client cannot grant itself
 * permissions because every server fn re-checks the role.
 */

type AuthStatus = "idle" | "checking" | "online" | "offline" | "error";

interface AuthError {
  code:
    | "invalid_credentials"
    | "no_server"
    | "expired"
    | "revoked"
    | "machine_mismatch"
    | "rate_limited"
    // The two codes `sessionWorkflow` actually returns. They were missing, so
    // `setError({ code: result.code })` on the login page did not type-check —
    // TS2322, twice, standing in the codebase. Which means the one failure at
    // the centre of the System Owner bug, `membership_missing`, could not be
    // recorded in the store even as the login page displayed it.
    | "session_unavailable"
    | "membership_missing"
    | "unknown";
  message: string;
}

interface AuthState {
  // ── Legacy fields (read by Sidebar, RoleGuard, Layout, etc.) ──
  userRole: UserRole;
  businessType: BusinessType;
  operationMode: OperationMode;
  isAuthenticated: boolean;
  username: string;
  activeBusinessProfile: BusinessProfile;

  // ── New "real auth" layer ─────────────────────────────────────
  status: AuthStatus;
  session: PublicSession | null;
  /** Last login error. Cleared on next attempt. */
  lastError: AuthError | null;
  /** Has this device ever been bootstrapped (first owner created)? */
  bootstrapped: boolean;
  /** The server session token, used by server fns to verify identity. */
  sessionToken: string | null;
  /**
   * NexusCore System Owner — a GLOBAL identity, not a store role.
   *
   * Deliberately a separate field from `userRole`. The System Owner is
   * recognised by `is_system_owner()`, which matches the signed-in email
   * against an allowlist in `auth.users` and never looks at `store_members`.
   * Folding it into `userRole` would have re-coupled it to a store, which is
   * the bug this field exists to keep fixed.
   *
   * It grants nothing on its own. Every `/system-admin` RPC re-checks
   * ownership in Postgres, so this only decides what the UI draws and where it
   * routes — see `SystemOwnerGate`.
   */
  isSystemOwner: boolean;

  // ── Legacy actions (kept for backward compat) ─────────────────
  setUserRole: (role: UserRole) => void;
  setBusinessType: (type: BusinessType) => void;
  setOperationMode: (mode: OperationMode) => void;
  setBusinessProfile: (profile: BusinessProfile) => void;

  // ── New real-auth actions ─────────────────────────────────────
  setStatus: (s: AuthStatus) => void;
  setSystemOwner: (isSystemOwner: boolean) => void;
  setSession: (s: PublicSession | null) => void;
  setError: (e: AuthError | null) => void;
  setBootstrapped: (v: boolean) => void;
  logout: () => void;
}

/**
 * A function, not a const, on purpose.
 *
 * `operationMode` is derived by calling into `lib/supabase`, and doing that
 * while THIS module is still being evaluated makes the value hostage to import
 * order — which showed up as `getOperationMode is not defined` at runtime even
 * though the types were fine. Zustand calls the initializer lazily, on first
 * use, by which point every module has finished loading.
 */
function legacyDefault(): Pick<
  AuthState,
  | "userRole"
  | "businessType"
  | "operationMode"
  | "isAuthenticated"
  | "username"
  | "activeBusinessProfile"
> {
  return {
    userRole: "owner",
    businessType: "retail",
    // Derived from configuration, never chosen: there is no local database to
    // fall back to, so "local" is not a mode this app has.
    operationMode: getOperationMode(),
    isAuthenticated: false,
    username: "",
    activeBusinessProfile: "omnichannel",
  };
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      ...legacyDefault(),
      status: "idle",
      session: null,
      lastError: null,
      bootstrapped: false,
      sessionToken: null,
      isSystemOwner: false,

      setUserRole: (role) => set({ userRole: role }),
      setBusinessType: (type) => set({ businessType: type }),
      setOperationMode: (mode) => set({ operationMode: mode }),
      setBusinessProfile: (profile) =>
        set({
          activeBusinessProfile: profile,
          businessType: profile === "ecommerce_only" ? "ecommerce" : "retail",
        }),

      setStatus: (status) => set({ status }),
      setSystemOwner: (isSystemOwner) => set({ isSystemOwner }),
      /**
       * Set the real session. Also updates the legacy fields so the
       * rest of the app keeps working without modification.
       */
      setSession: (session) => {
        if (session) {
          set({
            session,
            sessionToken: session.token,
            username: session.user.username,
            userRole: session.user.role,
            isAuthenticated: true,
            status: "online",
            lastError: null,
          });
        } else {
          set({
            session: null,
            sessionToken: null,
            isAuthenticated: false,
            status: "idle",
            lastError: null,
            username: "",
            // Keep userRole / businessType / activeBusinessProfile as
            // they are — the user might still be looking at the app
            // pre-login.
          });
        }
      },
      setError: (lastError) => set({ lastError, status: lastError ? "error" : "idle" }),
      setBootstrapped: (bootstrapped) => set({ bootstrapped }),
      logout: () =>
        set({
          session: null,
          sessionToken: null,
          isAuthenticated: false,
          status: "idle",
          lastError: null,
          username: "",
          // Cleared on the way out: the next person at this machine is not the
          // System Owner until the server says so again.
          isSystemOwner: false,
        }),
    }),
    {
      name: "auth-storage-v2",
      partialize: (s) => ({
        // Persist the active session so reloads keep the user logged in.
        session: s.session,
        sessionToken: s.sessionToken,
        bootstrapped: s.bootstrapped,
        // Legacy fields — kept for backward compat with any in-flight code.
        userRole: s.userRole,
        businessType: s.businessType,
        operationMode: s.operationMode,
        isAuthenticated: s.isAuthenticated,
        username: s.username,
        activeBusinessProfile: s.activeBusinessProfile,
      }),
    },
  ),
);

// ── Selectors (stable, raw — avoids useMemo thrash) ─────────────

export const selectIsAuthenticated = (s: AuthState) => s.isAuthenticated;
export const selectUsername = (s: AuthState) => s.username;
export const selectUserRole = (s: AuthState): UserRole => s.userRole;
export const selectBranchId = (s: AuthState) => s.session?.branch_id;
export const selectUserId = (s: AuthState) => s.session?.user.id;
export const selectAuthStatus = (s: AuthState) => s.status;
export const selectSessionToken = (s: AuthState) => s.sessionToken;
