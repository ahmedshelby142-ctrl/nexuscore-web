import { create } from "zustand";
import { getSupabaseClient } from "@/lib/supabase";
import { toAppRole, type AppRole } from "@/lib/roles";

/**
 * Who works here, and which of the four roles they hold.
 *
 * ## This screen used to be a mock
 *
 * Every action was a `setTimeout` over local state: inviting someone added a
 * row that existed until refresh, and changing a role changed nothing at all.
 * That was harmless while roles were decorative. It stopped being harmless the
 * moment RLS started reading `store_members.role` — an admin would demote a
 * cashier, see the screen agree, and the database would keep letting them in.
 *
 * The list and the role change now go to `store_members`, the same column the
 * policies read. Offline (or with Supabase unconfigured) it falls back to local
 * state so the screen still renders, and says so rather than pretending.
 */

export type StaffStatus = "ACTIVE" | "PENDING";

export interface StaffMember {
  id: string;
  /** `store_members.user_id` — what a role change is keyed on. */
  userId: string;
  name: string;
  email: string;
  role: AppRole;
  status: StaffStatus;
  invitedAt?: Date;
  joinedAt?: Date;
}

interface UsersState {
  staffMembers: StaffMember[];
  isLoading: boolean;
  /** Non-null when the last action could not reach the server. */
  error: string | null;

  fetchStaffMembers: () => Promise<void>;
  inviteStaff: (email: string, role: AppRole) => Promise<InviteResult>;
  updateUserRole: (userId: string, role: AppRole) => Promise<void>;
  removeUser: (userId: string) => Promise<void>;
}

export interface InviteResult {
  ok: boolean;
  /** Arabic, and true either way — shown verbatim to the admin. */
  message: string;
}

/**
 * Pull the real reason out of a failed `functions.invoke`.
 *
 * supabase-js turns any non-2xx into a `FunctionsHttpError` whose message is
 * the useless "Edge Function returned a non-2xx status code"; the body it read
 * hangs off `context` as a Response. `invite-staff` always answers JSON with an
 * `error` string, so reading it is the difference between telling an admin
 * "الإيميل ده مربوط بمحل تاني" and telling them nothing at all.
 */
async function functionErrorMessage(error: unknown): Promise<string> {
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) {
    try {
      const body = (await context.json()) as { error?: unknown };
      if (typeof body?.error === "string" && body.error) return body.error;
    } catch {
      // Not JSON — fall through to the generic message.
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export const useUsersStore = create<UsersState>((set, get) => ({
  staffMembers: [],
  isLoading: false,
  error: null,

  fetchStaffMembers: async () => {
    const sb = getSupabaseClient();
    if (!sb) {
      // Offline / local-only mode has no membership table to read.
      set({ isLoading: false, error: null });
      return;
    }

    set({ isLoading: true, error: null });
    try {
      // An RPC, not a PostgREST select. The select this replaces asked for
      // `store_members?select=user_id,role,created_at,users(email,username)`
      // and got a 400 every time, so the screen rendered but listed nobody:
      //   - `store_members` had no `created_at` column,
      //   - `public.users` has no `email` column,
      //   - and store_members.user_id references auth.users, not public.users,
      //     so the embed could never resolve — `auth` is not exposed over
      //     PostgREST, and it should not be.
      // `list_store_members()` is SECURITY DEFINER and filtered by
      // `is_store_member(store_id)`, so it returns exactly this store's people
      // and a member of one shop can never enumerate another's.
      const { data, error } = await sb.rpc("list_store_members");

      if (error) throw error;

      set({
        staffMembers: (data ?? []).map((row: any) => ({
          id: row.user_id,
          userId: row.user_id,
          name: row.email || "مستخدم",
          email: row.email || "",
          // Legacy values ('owner', 'CASHIER', …) resolve to the fixed four, so
          // a shop provisioned before this phase still reads correctly.
          role: toAppRole(row.role),
          status: "ACTIVE",
          joinedAt: row.joined_at ? new Date(row.joined_at) : undefined,
        })),
        isLoading: false,
      });
    } catch (e) {
      // A failed read must not render as "no staff" — that reads as an empty
      // shop and would have an admin re-invite people who are already here.
      set({
        isLoading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Add someone to THIS shop — the missing half of الصلاحيات.
   *
   * Nothing about who-may-invite-whom is decided here. The Edge Function
   * derives the store from the caller's own JWT and inserts the membership AS
   * the caller, under the same `write_store_members` policy as every other
   * write, so a tampered client can ask for a different store and still be
   * refused by Postgres. This method carries the answer back, nothing more.
   *
   * It deliberately does NOT add a row optimistically. A membership that
   * appears on screen but not in the table is the exact lie the rest of this
   * store was rewritten to remove — so on success it re-reads the table, and
   * on failure it says so.
   */
  inviteStaff: async (email: string, role: AppRole) => {
    const sb = getSupabaseClient();
    if (!sb) {
      const message = "إضافة موظف محتاجة اتصال بالسحابة.";
      set({ error: message });
      return { ok: false, message };
    }

    set({ isLoading: true, error: null });
    try {
      const { data, error } = await sb.functions.invoke("invite-staff", {
        body: { email: email.trim().toLowerCase(), role },
      });

      if (error) {
        const message = await functionErrorMessage(error);
        set({ isLoading: false, error: message });
        return { ok: false, message };
      }

      const result = data as { ok?: boolean; message?: string; error?: string } | null;
      if (!result?.ok) {
        const message = result?.error || "لم تتم الإضافة.";
        set({ isLoading: false, error: message });
        return { ok: false, message };
      }

      // The table is the truth, not the reply. This also brings back the row
      // with whatever the database actually stored.
      await get().fetchStaffMembers();
      set({ isLoading: false, error: null });
      return { ok: true, message: result.message || "تمت الإضافة." };
    } catch (e) {
      const message = `لم تتم الإضافة. ${e instanceof Error ? e.message : String(e)}`;
      set({ isLoading: false, error: message });
      return { ok: false, message };
    }
  },

  updateUserRole: async (userId: string, role: AppRole) => {
    const sb = getSupabaseClient();
    if (!sb) {
      set({ error: "تغيير الصلاحيات محتاج اتصال بالسحابة." });
      return;
    }

    set({ isLoading: true, error: null });
    try {
      const { error } = await sb
        .from("store_members")
        .update({ role })
        .eq("user_id", userId);
      if (error) throw error;

      set((state) => ({
        staffMembers: state.staffMembers.map((m) =>
          m.userId === userId ? { ...m, role } : m,
        ),
        isLoading: false,
      }));
    } catch (e) {
      // Leave the old role on screen. Showing the new one after a failed write
      // is exactly the lie this rewrite exists to remove.
      set({
        isLoading: false,
        error: `لم تُحفظ الصلاحية. ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },

  removeUser: async (userId: string) => {
    const sb = getSupabaseClient();
    if (!sb) {
      set({ error: "إزالة مستخدم محتاجة اتصال بالسحابة." });
      return;
    }

    set({ isLoading: true, error: null });
    try {
      const { error } = await sb.from("store_members").delete().eq("user_id", userId);
      if (error) throw error;

      set((state) => ({
        staffMembers: state.staffMembers.filter((m) => m.userId !== userId),
        isLoading: false,
      }));
    } catch (e) {
      set({
        isLoading: false,
        error: `لم تتم الإزالة. ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },
}));
