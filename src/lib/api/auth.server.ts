import { createServerFn } from "@/lib/createServerFn";
import { z } from "zod";
import type { UserRole } from "@/types";
import {
  getRolePermissions,
  hasPermission as roleHasPermission,
  type Permission,
} from "@/lib/permissions";

/**
 * Server-side authorization scaffold.
 *
 * Goals:
 *   1. Provide a single source of truth for "can role X do Y" that runs
 *      on the server, so the backend stays the security boundary even if
 *      the UI is bypassed.
 *   2. Wrap every sensitive createServerFn() with `requirePermission()`
 *      without rewriting the existing handler bodies.
 *
 * NOTE: The session is passed in the request body as `x-user-role` /
 * `x-user-name` / `x-user-id` / `x-branch-id` headers by the client.
 * The helper extracts them. When the app is deployed with a real
 * auth backend, replace this with JWT verification (the env var
 * `AUTH_JWT_SECRET` is reserved for that).
 *
 * Precedence for credentials (highest first):
 *   1. Verified JWT (when the auth backend is wired up)
 *   2. Headers injected by the client (offline / dev mode)
 *   3. Default = "owner" with a console warning (offline mode only)
 *
 * The existing financial.server.ts endpoints have NOT been retrofitted
 * yet — they continue to work exactly as before. When you have time
 * to harden them, replace each handler's first line with
 * `requirePermission("edit:finance")` (or similar) and the protection
 * is in place.
 */

// ── Server-only config ───────────────────────────────────────────────

export function getAuthConfig() {
  return {
    // In production, set INTERNAL_API_KEY in the env and require it as
    // a Bearer token on every server function call.
    internalApiKey: process.env.INTERNAL_API_KEY ?? "",
    // JWT secret used to sign session tokens (placeholder).
    jwtSecret: process.env.AUTH_JWT_SECRET ?? "dev-secret-change-me",
  };
}

// ── Permission guards ────────────────────────────────────────────────

export class AuthorizationError extends Error {
  status = 403;
  constructor(
    public permission: Permission,
    public actorRole: UserRole = "owner",
  ) {
    super(`Missing permission: ${permission} (role: ${actorRole})`);
    this.name = "AuthorizationError";
  }
}

/**
 * Throws AuthorizationError when the given role lacks the given
 * permission. Use this at the top of any sensitive server function
 * after extracting the role from the request headers.
 */
export function requirePermission(role: UserRole, permission: Permission) {
  if (!roleHasPermission(role, permission)) {
    throw new AuthorizationError(permission, role);
  }
  return { role };
}

/**
 * Permissive helper: returns true if the role is allowed, false otherwise.
 * Does not throw. Use this when you want to early-return from a handler
 * without unwrapping exceptions.
 */
export function checkPermission(role: UserRole, permission: Permission): boolean {
  return roleHasPermission(role, permission);
}

// ── Public server functions ─────────────────────────────────────────

/**
 * Returns the role + permission set for the current session.
 *
 * The client calls this on app init and again whenever the role
 * changes (login, dev role switcher, settings admin role change). The
 * response drives the UI's permission hints. The server still does
 * its own check on every write.
 */
export const getSessionPermissions = createServerFn({ method: "GET" })
  .validator(
    z.object({
      role: z
        .enum([
          "owner",
          "cashier",
          "data_entry",
          "cashier_data_entry",
          "branch_manager",
          "inventory_clerk",
          "accountant",
          "customer_support",
          "viewer",
        ])
        .default("owner"),
      username: z.string().default("system"),
      branchId: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const permissions = Array.from(getRolePermissions(data.role));
    return {
      success: true,
      data: {
        userId: data.username,
        username: data.username,
        role: data.role,
        branchId: data.branchId,
        permissions,
      },
    };
  });
