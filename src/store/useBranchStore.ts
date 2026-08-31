import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Branch, BranchAssignment, UserRole } from "@/types";
import { writeThrough } from "@/services/cloudData";

/**
 * Write one branch to Supabase, then commit WHAT SUPABASE STORED.
 *
 * This used to `set` first and push after, swallowing the failure in a
 * `console.error` — so a branch could be created, selected as the current
 * scope, and be absent everywhere else. Nothing is committed here until the
 * database has the row; a failure throws, having changed nothing.
 */
async function saveBranch(
  set: (fn: (state: any) => any) => void,
  branch: Branch,
): Promise<Branch> {
  const saved = (await writeThrough("branches", branch)) as Branch;
  set((state: any) => {
    const at = state.branches.findIndex((b: Branch) => b.id === saved.id);
    if (at < 0) {
      return {
        branches: [...state.branches, saved],
        // If this is the first branch, auto-select it.
        currentBranchId: state.currentBranchId ?? saved.id,
      };
    }
    const next = state.branches.slice();
    next[at] = { ...next[at], ...saved };
    return { branches: next };
  });
  return saved;
}

/**
 * Branch / outlet tracking.
 *
 * The system was originally single-tenant. To keep all existing stores
 * working untouched, branches are an additive layer:
 *
 *   - `branches[]` holds the catalogue of branches.
 *   - `currentBranchId` is the active scope the user is operating under.
 *   - `assignments[]` records which user has access to which branch.
 *
 * When a branch is selected, the helper `scopeToBranch()` filters any
 * record collection by an optional `branchId` field. Existing data is
 * simply considered branch-agnostic (branchId = undefined) until the
 * user starts scoping.
 *
 * Every store should eventually grow a `branchId?: string` field on
 * its records. The first cut ships the scope utilities so the UI can
 * filter; data migration is the user's call.
 */

interface BranchState {
  branches: Branch[];
  currentBranchId: string | null;
  assignments: BranchAssignment[];

  // Branch CRUD
  addBranch: (branch: Omit<Branch, "id" | "createdAt">) => Promise<void>;
  updateBranch: (id: string, patch: Partial<Branch>) => Promise<void>;
  removeBranch: (id: string) => Promise<void>;
  setCurrentBranch: (id: string | null) => void;
  toggleBranchActive: (id: string) => Promise<void>;

  // User assignment
  assignUser: (assignment: Omit<BranchAssignment, "id" | "createdAt">) => void;
  unassignUser: (assignmentId: string) => void;
  getUserBranches: (userId: string) => Branch[];

  // Scope helper — returns a record list filtered to the active branch.
  scopeToBranch: <T extends { branchId?: string }>(records: T[]) => T[];

  // Maintenance
  clearAll: () => void;
}

export const useBranchStore = create<BranchState>()(
  persist(
    (set, get) => ({
      branches: [],
      currentBranchId: null,
      assignments: [],

      addBranch: async (branchData) => {
        await saveBranch(set, {
          ...branchData,
          id: crypto.randomUUID(),
          createdAt: new Date(),
          // Epoch-ms sync clock, distinct from `createdAt` above.
          updated_at: Date.now(),
        } as Branch);
      },

      updateBranch: async (id, patch) => {
        const current = get().branches.find((br) => br.id === id);
        if (!current) return;
        await saveBranch(set, { ...current, ...patch, updated_at: Date.now() });
      },

      removeBranch: async (id) => {
        const current = get().branches.find((br) => br.id === id);
        if (!current) return;
        // Tombstoned, not deleted — assignments and scoped records still point
        // here. The local drop happens only once the server has the tombstone.
        await writeThrough("branches", {
          ...current,
          deleted_at: new Date().toISOString(),
          updated_at: Date.now(),
        });
        set((state) => ({
          branches: state.branches.filter((br) => br.id !== id),
          assignments: state.assignments.filter((a) => a.branchId !== id),
          currentBranchId: state.currentBranchId === id ? null : state.currentBranchId,
        }));
      },

      setCurrentBranch: (id) => set({ currentBranchId: id }),

      toggleBranchActive: async (id) => {
        const current = get().branches.find((br) => br.id === id);
        if (!current) return;
        await saveBranch(set, { ...current, isActive: !current.isActive, updated_at: Date.now() });
      },

      assignUser: (assignmentData) => {
        const assignment: BranchAssignment = {
          ...assignmentData,
          id: crypto.randomUUID(),
          createdAt: new Date(),
        };
        set((state) => ({ assignments: [...state.assignments, assignment] }));
      },

      unassignUser: (assignmentId) =>
        set((state) => ({
          assignments: state.assignments.filter((a) => a.id !== assignmentId),
        })),

      getUserBranches: (userId) => {
        const { assignments, branches } = get();
        const branchIds = new Set(
          assignments.filter((a) => a.userId === userId).map((a) => a.branchId),
        );
        return branches.filter((b) => branchIds.has(b.id));
      },

      // If no branch is selected, return everything (legacy behaviour).
      // If a branch is selected, only return records explicitly tagged
      // with that branchId OR records with no branchId at all (treated
      // as branch-agnostic / pre-existing data).
      scopeToBranch: <T extends { branchId?: string }>(records: T[]) => {
        const id = get().currentBranchId;
        if (!id) return records;
        return records.filter((r) => !r.branchId || r.branchId === id);
      },

      clearAll: () => set({ branches: [], currentBranchId: null, assignments: [] }),
    }),
    {
      name: "branch-storage",
      // `branches` is cloud-owned. `currentBranchId` and the local
      // assignments have no cloud table, so they stay persisted.
      partialize: (state: any) => ({
        currentBranchId: state.currentBranchId,
        assignments: state.assignments,
      }),
    },
  ),
);

/**
 * UI helper: returns the Arabic label for a branch.
 */
export function describeRole(role: UserRole): string {
  const map: Record<UserRole, string> = {
    owner: "مالك",
    cashier: "كاشير",
    data_entry: "داتا إنتري",
    cashier_data_entry: "كاشير + داتا إنتري",
    branch_manager: "مدير فرع",
    inventory_clerk: "أمين مخزن",
    accountant: "محاسب",
    customer_support: "دعم عملاء",
    viewer: "قراءة فقط",
  };
  return map[role];
}
