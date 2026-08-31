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
  updateUserRole: (userId: string, role: AppRole) => Promise<void>;
  removeUser: (userId: string) => Promise<void>;
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
      const { data, error } = await sb
        .from("store_members")
        .select("user_id, role, created_at, users(email, username)");

      if (error) throw error;

      set({
        staffMembers: (data ?? []).map((row: any) => ({
          id: row.user_id,
          userId: row.user_id,
          name: row.users?.username || row.users?.email || "مستخدم",
          email: row.users?.email || "",
          // Legacy values ('owner', 'CASHIER', …) resolve to the fixed four, so
          // a shop provisioned before this phase still reads correctly.
          role: toAppRole(row.role),
          status: "ACTIVE",
          joinedAt: row.created_at ? new Date(row.created_at) : undefined,
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
