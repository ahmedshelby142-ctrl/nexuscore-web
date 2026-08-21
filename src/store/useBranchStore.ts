import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Branch, BranchAssignment, UserRole } from "@/types";
import { safeInvoke, isDesktop } from "@/lib/tauri";
import { pushPendingChanges } from "@/services/ledgerSyncEngine";
import { SyncService } from "@/services/api/SyncService";

async function syncBranchToDb(branch: Branch) {
  try {
    if (isDesktop) {
      const identity: any = await safeInvoke("ledger_identity", {
        candidateStoreId: "dummy",
        candidateDeviceId: "dummy",
      });
      if (!identity || identity.store_provisional) return;
      
      const Database = (await import("@tauri-apps/plugin-sql")).default;
      const dbPath = await safeInvoke<string | null>("ledger_db_path");
      if (!dbPath) return;
      
      const db = await Database.load(`sqlite:${dbPath}`);
      
      await db.execute(
        `INSERT INTO branches (id, name, code, address, phone, is_active, created_at, deleted_at, store_id, device_id, sync_status) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
         ON CONFLICT(id) DO UPDATE SET 
           name = EXCLUDED.name,
           code = EXCLUDED.code,
           address = EXCLUDED.address,
           phone = EXCLUDED.phone,
           is_active = EXCLUDED.is_active,
           deleted_at = EXCLUDED.deleted_at,
           sync_status = 'pending'`,
        [
          branch.id, 
          branch.name, 
          branch.code, 
          branch.address || null, 
          branch.phone || null, 
          branch.isActive ? 1 : 0,
          branch.createdAt.toISOString(),
          (branch as any).deleted_at || null,
          identity.store_id,
          identity.device_id
        ]
      );
      
      await pushPendingChanges();
    } else {
      await SyncService.pushChanges("branches", branch);
    }
  } catch (err) {
    console.error("Failed to sync branch to DB:", err);
  }
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
  addBranch: (branch: Omit<Branch, "id" | "createdAt">) => void;
  updateBranch: (id: string, patch: Partial<Branch>) => void;
  removeBranch: (id: string) => void;
  setCurrentBranch: (id: string | null) => void;
  toggleBranchActive: (id: string) => void;

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

      addBranch: (branchData) => {
        const branch: Branch = {
          ...branchData,
          id: crypto.randomUUID(),
          createdAt: new Date(),
        };
        set((state) => ({
          branches: [...state.branches, branch],
          // If this is the first branch, auto-select it.
          currentBranchId: state.currentBranchId ?? branch.id,
        }));
        syncBranchToDb(branch);
      },

      updateBranch: (id, patch) => {
        set((state) => ({
          branches: state.branches.map((b) => (b.id === id ? { ...b, ...patch } : b)),
        }));
        const b = get().branches.find((br) => br.id === id);
        if (b) syncBranchToDb(b);
      },

      removeBranch: (id) => {
        const b = get().branches.find((br) => br.id === id);
        if (b) {
          syncBranchToDb({ ...b, deleted_at: new Date().toISOString() } as unknown as Branch);
        }
        set((state) => ({
          branches: state.branches.filter((br) => br.id !== id),
          assignments: state.assignments.filter((a) => a.branchId !== id),
          currentBranchId: state.currentBranchId === id ? null : state.currentBranchId,
        }));
      },

      setCurrentBranch: (id) => set({ currentBranchId: id }),

      toggleBranchActive: (id) => {
        set((state) => ({
          branches: state.branches.map((b) => (b.id === id ? { ...b, isActive: !b.isActive } : b)),
        }));
        const b = get().branches.find((br) => br.id === id);
        if (b) syncBranchToDb(b);
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
    { name: "branch-storage" },
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
