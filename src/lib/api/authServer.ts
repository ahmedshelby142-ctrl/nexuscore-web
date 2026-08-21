import { createServerFn } from "@/lib/createServerFn";
import { z } from "zod";
import { getSupabaseClient } from "@/lib/supabase";
import { hashPassword, verifyPassword, generateSessionToken, hashToken } from "@/lib/crypto";
import type { PublicSession, UserRecord, UserRole } from "@/types";

/**
 * Real authentication server functions.
 *
 * These replace the local-state login stub. Every endpoint is offline-
 * safe: if Supabase is not configured, they fall back to an in-memory
 * user table (so the dev experience still works), and they always
 * return well-typed responses that the client can handle uniformly.
 *
 * Precedence:
 *   1. Supabase `users` / `auth_sessions` tables (production)
 *   2. In-memory table below (dev / no-DB mode)
 *
 * The in-memory table is seeded on first login attempt if it's empty
 * with a default owner (`owner` / `owner`) and the user is forced to
 * change the password on first login.
 */

// ── In-memory fallback (dev only) ────────────────────────────────────

interface InMemoryUser {
  id: string;
  username: string;
  full_name: string;
  role: UserRole;
  password_hash: string;
  must_change_password: boolean;
  is_active: boolean;
  created_at: Date;
}

const inMemoryUsers: InMemoryUser[] = [];
const inMemorySessions = new Map<
  string,
  {
    user_id: string;
    username: string;
    role: UserRole;
    machine_id: string;
    created_at: Date;
    expires_at: Date;
    revoked: boolean;
  }
>();
const inMemoryLoginAttempts: Array<{
  username: string;
  machine_id: string;
  success: boolean;
  reason?: string;
  timestamp: Date;
}> = [];

let bootPromise: Promise<void> | null = null;

async function ensureBootstrapped() {
  if (inMemoryUsers.length > 0) return;
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    // Seed the first owner with a temporary password the user must
    // change on first login. Username: "owner", password: "owner".
    const hash = await hashPassword("owner");
    inMemoryUsers.push({
      id: crypto.randomUUID(),
      username: "owner",
      full_name: "Default Owner",
      role: "owner",
      password_hash: hash,
      must_change_password: true,
      is_active: true,
      created_at: new Date(),
    });
  })();
  return bootPromise;
}

function findInMemoryUser(username: string): InMemoryUser | undefined {
  return inMemoryUsers.find((u) => u.username === username);
}

function recordInMemoryAttempt(
  username: string,
  machineId: string,
  success: boolean,
  reason?: string,
) {
  inMemoryLoginAttempts.push({
    username,
    machine_id: machineId,
    success,
    reason,
    timestamp: new Date(),
  });
  // Keep at most 200.
  if (inMemoryLoginAttempts.length > 200) inMemoryLoginAttempts.shift();
}

// ── Common helpers ────────────────────────────────────────────────

const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours

function publicSessionFromUser(
  user: InMemoryUser,
  token: string,
  machineId: string,
): PublicSession {
  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      is_active: user.is_active,
      must_change_password: user.must_change_password,
      created_at: user.created_at,
    },
    machine_id: machineId,
    expires_at: new Date(Date.now() + SESSION_TTL_MS),
  };
}

// ── Public server functions ──────────────────────────────────────

/**
 * Login. Validates username + password, creates a session, and
 * returns the public session (no password hash). The client stores
 * the session in useAuthStore and uses the token for subsequent
 * server fns.
 */
export const login = createServerFn({ method: "POST" })
  .validator(
    z.object({
      username: z.string().min(1),
      password: z.string().min(1),
      machine_id: z.string().min(8),
    }),
  )
  .handler(async ({ data }) => {
    const sb = getSupabaseClient();
    if (!sb) {
      // In-memory fallback.
      await ensureBootstrapped();
      const user = findInMemoryUser(data.username);
      if (!user || !user.is_active) {
        recordInMemoryAttempt(data.username, data.machine_id, false, "no_user");
        return { success: false as const, error: "بيانات الدخول غير صحيحة" };
      }
      const ok = await verifyPassword(data.password, user.password_hash);
      if (!ok) {
        recordInMemoryAttempt(data.username, data.machine_id, false, "bad_password");
        return { success: false as const, error: "بيانات الدخول غير صحيحة" };
      }
      const token = generateSessionToken();
      inMemorySessions.set(token, {
        user_id: user.id,
        username: user.username,
        role: user.role,
        machine_id: data.machine_id,
        created_at: new Date(),
        expires_at: new Date(Date.now() + SESSION_TTL_MS),
        revoked: false,
      });
      recordInMemoryAttempt(data.username, data.machine_id, true);
      return { success: true as const, data: publicSessionFromUser(user, token, data.machine_id) };
    }

    // Supabase path.
    const { data: rows, error: fetchErr } = await sb
      .from("users")
      .select("*")
      .eq("username", data.username)
      .eq("is_active", true)
      .single();

    if (fetchErr || !rows) {
      await sb.from("auth_login_attempts").insert({
        username: data.username,
        machine_id: data.machine_id,
        success: false,
        reason: "no_user",
      });
      return { success: false as const, error: "بيانات الدخول غير صحيحة" };
    }

    const user = rows as UserRecord & { password_hash: string };
    const ok = await verifyPassword(data.password, user.password_hash);
    if (!ok) {
      await sb.from("auth_login_attempts").insert({
        username: data.username,
        machine_id: data.machine_id,
        success: false,
        reason: "bad_password",
      });
      return { success: false as const, error: "بيانات الدخول غير صحيحة" };
    }

    const token = generateSessionToken();
    const tokenHash = await hashToken(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    const { error: sessErr } = await sb.from("auth_sessions").insert({
      user_id: user.id,
      username: user.username,
      role: user.role,
      machine_id: data.machine_id,
      token: tokenHash,
      expires_at: expiresAt.toISOString(),
    });

    if (sessErr) {
      return { success: false as const, error: "تعذّر إنشاء الجلسة" };
    }

    await sb
      .from("users")
      .update({ last_login_at: new Date().toISOString(), last_login_machine: data.machine_id })
      .eq("id", user.id);

    await sb.from("auth_login_attempts").insert({
      username: data.username,
      machine_id: data.machine_id,
      success: true,
    });

    return {
      success: true as const,
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          full_name: user.full_name,
          email: user.email,
          role: user.role,
          is_active: user.is_active,
          must_change_password: user.must_change_password,
          created_at: new Date(user.created_at),
        },
        machine_id: data.machine_id,
        expires_at: expiresAt,
      } satisfies PublicSession,
    };
  });

/**
 * Logout. Revokes the active session. Idempotent — safe to call
 * from a "Log out" button even if the session is already gone.
 */
export const logout = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string().min(1) }))
  .handler(async ({ data }) => {
    const sb = getSupabaseClient();
    if (!sb) {
      inMemorySessions.delete(data.token);
      return { success: true as const };
    }
    const tokenHash = await hashToken(data.token);
    await sb
      .from("auth_sessions")
      .update({ revoked: true, revoked_at: new Date().toISOString() })
      .eq("token", tokenHash);
    return { success: true as const };
  });

/**
 * Validate. Checks that a session token is still active (not expired,
 * not revoked, and bound to the calling machine). Returns the public
 * session on success, or an error on failure.
 */
export const validateSession = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string().min(1),
      machine_id: z.string().min(8),
    }),
  )
  .handler(async ({ data }) => {
    const sb = getSupabaseClient();
    if (!sb) {
      const sess = inMemorySessions.get(data.token);
      if (!sess || sess.revoked) {
        return { success: false as const, error: "الجلسة غير صالحة" };
      }
      if (sess.expires_at.getTime() < Date.now()) {
        return { success: false as const, error: "انتهت صلاحية الجلسة" };
      }
      if (sess.machine_id !== data.machine_id) {
        return { success: false as const, error: "الجلسة مرتبطة بجهاز آخر" };
      }
      const user = findInMemoryUser(sess.username);
      if (!user) return { success: false as const, error: "المستخدم غير موجود" };
      return {
        success: true as const,
        data: publicSessionFromUser(user, data.token, data.machine_id),
      };
    }

    const tokenHash = await hashToken(data.token);
    const { data: row, error } = await sb
      .from("auth_sessions")
      .select("*, users(*)")
      .eq("token", tokenHash)
      .single();

    if (error || !row) {
      return { success: false as const, error: "الجلسة غير صالحة" };
    }

    const r = row as any;
    if (r.revoked) return { success: false as const, error: "تم إنهاء الجلسة" };
    if (new Date(r.expires_at).getTime() < Date.now()) {
      return { success: false as const, error: "انتهت صلاحية الجلسة" };
    }
    if (r.machine_id !== data.machine_id) {
      return { success: false as const, error: "الجلسة مرتبطة بجهاز آخر" };
    }
    const u = r.users;
    if (!u || !u.is_active) {
      return { success: false as const, error: "المستخدم معطّل" };
    }

    return {
      success: true as const,
      data: {
        token: data.token,
        user: {
          id: u.id,
          username: u.username,
          full_name: u.full_name,
          email: u.email,
          role: u.role,
          is_active: u.is_active,
          must_change_password: u.must_change_password,
          created_at: new Date(u.created_at),
        },
        machine_id: r.machine_id,
        expires_at: new Date(r.expires_at),
      } satisfies PublicSession,
    };
  });

/**
 * Change password. Requires the current password (verification) and
 * sets a new one. The session is *not* rotated, so a compromised
 * device can still use the new password until logout.
 */
export const changePassword = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string().min(1),
      current_password: z.string().min(1),
      new_password: z.string().min(8, "كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل"),
    }),
  )
  .handler(async ({ data }) => {
    const sb = getSupabaseClient();
    if (!sb) {
      const sess = inMemorySessions.get(data.token);
      if (!sess || sess.revoked) return { success: false as const, error: "الجلسة غير صالحة" };
      const user = findInMemoryUser(sess.username);
      if (!user) return { success: false as const, error: "المستخدم غير موجود" };
      const ok = await verifyPassword(data.current_password, user.password_hash);
      if (!ok) return { success: false as const, error: "كلمة المرور الحالية غير صحيحة" };
      user.password_hash = await hashPassword(data.new_password);
      user.must_change_password = false;
      return { success: true as const };
    }

    const tokenHash = await hashToken(data.token);
    const { data: row, error } = await sb
      .from("auth_sessions")
      .select("user_id, users(*)")
      .eq("token", tokenHash)
      .single();
    if (error || !row) return { success: false as const, error: "الجلسة غير صالحة" };

    const u = (row as any).users;
    if (!u) return { success: false as const, error: "المستخدم غير موجود" };

    const ok = await verifyPassword(data.current_password, u.password_hash);
    if (!ok) return { success: false as const, error: "كلمة المرور الحالية غير صحيحة" };

    const newHash = await hashPassword(data.new_password);
    await sb
      .from("users")
      .update({ password_hash: newHash, must_change_password: false })
      .eq("id", u.id);

    return { success: true as const };
  });

/**
 * List users. Owner-only. Returns the public UserRecord list
 * (no password hashes).
 */
export const listUsers = createServerFn({ method: "GET" })
  .validator(
    z.object({
      token: z.string().min(1),
      machine_id: z.string().min(8),
    }),
  )
  .handler(async ({ data }) => {
    // Verify caller is an owner.
    const validated = await validateSession({
      data: { token: data.token, machine_id: data.machine_id },
    });
    if (!validated.success) return { success: false as const, error: validated.error };
    if (validated.data.user.role !== "owner") {
      return { success: false as const, error: "يتطلب صلاحية مالك" };
    }

    const sb = getSupabaseClient();
    if (!sb) {
      return {
        success: true as const,
        data: inMemoryUsers.map((u) => ({
          id: u.id,
          username: u.username,
          full_name: u.full_name,
          role: u.role,
          is_active: u.is_active,
          must_change_password: u.must_change_password,
          created_at: u.created_at,
        })) as UserRecord[],
      };
    }
    const { data: rows, error } = await sb
      .from("users")
      .select(
        "id, username, full_name, email, role, default_branch_id, is_active, must_change_password, last_login_at, created_at",
      )
      .order("created_at", { ascending: true });
    if (error) return { success: false as const, error: error.message };
    return {
      success: true as const,
      data: (rows ?? []).map((r: any) => ({
        ...r,
        created_at: new Date(r.created_at),
        last_login_at: r.last_login_at ? new Date(r.last_login_at) : undefined,
      })) as UserRecord[],
    };
  });

/**
 * Create a new user. Owner-only. Securely hashes the password before storage.
 */
export const createUser = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string().min(1),
      machine_id: z.string().min(8),
      username: z.string().min(3, "اسم المستخدم يجب أن يكون 3 أحرف على الأقل"),
      password: z.string().min(8, "كلمة المرور يجب أن تكون 8 أحرف على الأقل"),
      full_name: z.string().optional(),
      email: z.string().email().optional(),
      role: z.enum([
        "owner",
        "cashier",
        "data_entry",
        "cashier_data_entry",
        "branch_manager",
        "inventory_clerk",
        "accountant",
        "customer_support",
        "viewer",
      ]),
    }),
  )
  .handler(async ({ data }) => {
    // Verify caller is an owner.
    const validated = await validateSession({
      data: { token: data.token, machine_id: data.machine_id },
    });
    if (!validated.success) return { success: false as const, error: validated.error };
    if (validated.data.user.role !== "owner") {
      return { success: false as const, error: "يتطلب صلاحية مالك" };
    }

    const passwordHash = await hashPassword(data.password);
    const sb = getSupabaseClient();

    if (!sb) {
      // In-memory fallback
      const existingUser = findInMemoryUser(data.username);
      if (existingUser) {
        return { success: false as const, error: "اسم المستخدم موجود بالفعل" };
      }
      const newUser: InMemoryUser = {
        id: crypto.randomUUID(),
        username: data.username,
        full_name: data.full_name || data.username,
        role: data.role as UserRole,
        password_hash: passwordHash,
        must_change_password: false,
        is_active: true,
        created_at: new Date(),
      };
      inMemoryUsers.push(newUser);
      return {
        success: true as const,
        data: {
          id: newUser.id,
          username: newUser.username,
          full_name: newUser.full_name,
          role: newUser.role,
          is_active: newUser.is_active,
          must_change_password: newUser.must_change_password,
          created_at: newUser.created_at,
        } as UserRecord,
      };
    }

    // Supabase mode
    const { data: newUser, error } = await sb
      .from("users")
      .insert({
        username: data.username,
        password_hash: passwordHash,
        full_name: data.full_name || data.username,
        email: data.email,
        role: data.role,
        is_active: true,
        must_change_password: false,
      })
      .select()
      .single();

    if (error) {
      if (error.message.includes("duplicate")) {
        return { success: false as const, error: "اسم المستخدم موجود بالفعل" };
      }
      return { success: false as const, error: error.message };
    }

    return {
      success: true as const,
      data: {
        id: newUser.id,
        username: newUser.username,
        full_name: newUser.full_name,
        email: newUser.email,
        role: newUser.role,
        is_active: newUser.is_active,
        must_change_password: newUser.must_change_password,
        created_at: new Date(newUser.created_at),
      } as UserRecord,
    };
  });

/**
 * Update a user. Owner-only. Can update role, full_name, email, and is_active status.
 */
export const updateUser = createServerFn({ method: "PATCH" })
  .validator(
    z.object({
      token: z.string().min(1),
      machine_id: z.string().min(8),
      userId: z.string().uuid(),
      full_name: z.string().optional(),
      email: z.string().email().optional(),
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
        .optional(),
      is_active: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    // Verify caller is an owner.
    const validated = await validateSession({
      data: { token: data.token, machine_id: data.machine_id },
    });
    if (!validated.success) return { success: false as const, error: validated.error };
    if (validated.data.user.role !== "owner") {
      return { success: false as const, error: "يتطلب صلاحية مالك" };
    }

    const sb = getSupabaseClient();

    if (!sb) {
      // In-memory fallback
      const user = inMemoryUsers.find((u) => u.id === data.userId);
      if (!user) return { success: false as const, error: "المستخدم غير موجود" };
      if (data.full_name !== undefined) user.full_name = data.full_name;
      if (data.role !== undefined) user.role = data.role as UserRole;
      if (data.is_active !== undefined) user.is_active = data.is_active;
      return { success: true as const };
    }

    // Supabase mode
    const updates: Record<string, unknown> = {};
    if (data.full_name !== undefined) updates.full_name = data.full_name;
    if (data.email !== undefined) updates.email = data.email;
    if (data.role !== undefined) updates.role = data.role;
    if (data.is_active !== undefined) updates.is_active = data.is_active;

    const { error } = await sb.from("users").update(updates).eq("id", data.userId);

    if (error) return { success: false as const, error: error.message };
    return { success: true as const };
  });

/**
 * Delete a user. Owner-only. Soft-delete by setting is_active to false.
 */
export const deleteUser = createServerFn({ method: "DELETE" })
  .validator(
    z.object({
      token: z.string().min(1),
      machine_id: z.string().min(8),
      userId: z.string().uuid(),
    }),
  )
  .handler(async ({ data }) => {
    // Verify caller is an owner.
    const validated = await validateSession({
      data: { token: data.token, machine_id: data.machine_id },
    });
    if (!validated.success) return { success: false as const, error: validated.error };
    if (validated.data.user.role !== "owner") {
      return { success: false as const, error: "يتطلب صلاحية مالك" };
    }

    const sb = getSupabaseClient();

    if (!sb) {
      // In-memory fallback: remove from array
      const idx = inMemoryUsers.findIndex((u) => u.id === data.userId);
      if (idx === -1) return { success: false as const, error: "المستخدم غير موجود" };
      inMemoryUsers.splice(idx, 1);
      return { success: true as const };
    }

    // Supabase mode: soft-delete
    const { error } = await sb.from("users").update({ is_active: false }).eq("id", data.userId);

    if (error) return { success: false as const, error: error.message };
    return { success: true as const };
  });
