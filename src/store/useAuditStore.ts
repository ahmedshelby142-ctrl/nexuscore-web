import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AuditAction, AuditEntry, UserRole } from "@/types";

/**
 * Central audit log for sensitive actions.
 *
 * The log is append-only at the API level (no setter exposes mutation of
 * an existing entry). It is persisted in localStorage so the trail
 * survives page refreshes while offline; once a Supabase backend is
 * configured, src/lib/api/audit.server.ts is the recommended sink.
 *
 * Hook the helper `logAuditEvent()` into:
 *   - login / logout (in useAuthStore)
 *   - role changes (in DevRoleSwitcher / settings)
 *   - every financial store mutation (expenses, payroll, dividends, transfers)
 *   - every stock adjustment
 *   - integration config changes
 *   - order status transitions
 *   - manual overrides (audit-confirmed adjustments)
 *
 * This store is intentionally lightweight — production deploys should
 * mirror the entries to a server-side table (server/db/schema-audit.sql
 * can be added later; the in-browser log is the source of truth until
 * then).
 */

const MAX_ENTRIES = 2000; // hard cap to keep localStorage bounded

interface AuditState {
  entries: AuditEntry[];

  /** Append a new audit entry. Idempotency-guard: pass a `key` to dedupe. */
  log: (entry: Omit<AuditEntry, "id" | "timestamp"> & { key?: string }) => void;

  /** Read-only accessors. */
  getRecent: (limit?: number) => AuditEntry[];
  getByAction: (action: AuditAction) => AuditEntry[];
  getByResource: (resource: string) => AuditEntry[];
  getByActor: (username: string) => AuditEntry[];
  getByDateRange: (start: Date, end: Date) => AuditEntry[];
  getByBranch: (branchId: string) => AuditEntry[];

  /** Maintenance. */
  clear: () => void;
}

/** Convenience helper usable outside React components. */
export function logAuditEvent(
  get: () => AuditState,
  entry: Omit<AuditEntry, "id" | "timestamp"> & { key?: string },
) {
  try {
    get().log(entry);
  } catch (e) {
    // Audit logging must NEVER break the calling action. Swallow errors.
    if (typeof console !== "undefined") {
      console.warn("[audit] failed to log entry", e);
    }
  }
}

export const useAuditStore = create<AuditState>()(
  persist(
    (set, get) => ({
      entries: [],

      log: (entry) => {
        const id = crypto.randomUUID();
        const next: AuditEntry = {
          id,
          timestamp: new Date(),
          actorUsername: entry.actorUsername,
          actorRole: entry.actorRole,
          branchId: entry.branchId,
          action: entry.action,
          resource: entry.resource,
          details: entry.details,
          notes: entry.notes,
        };

        set((state) => {
          // Dedupe by optional key (resource+action) to avoid double logs
          // when the same logical action is fanned out (e.g. webhook + UI).
          if (entry.key) {
            const dup = state.entries.find(
              (e) =>
                e.action === entry.action &&
                e.resource === entry.resource &&
                e.notes === entry.notes &&
                (entry.details?.["key"] as string | undefined) === entry.key,
            );
            if (dup) return state;
          }
          const nextEntries = [next, ...state.entries].slice(0, MAX_ENTRIES);
          return { entries: nextEntries };
        });
      },

      getRecent: (limit = 50) => get().entries.slice(0, limit),
      getByAction: (action) => get().entries.filter((e) => e.action === action),
      getByResource: (resource) => get().entries.filter((e) => e.resource === resource),
      getByActor: (username) => get().entries.filter((e) => e.actorUsername === username),
      getByDateRange: (start, end) =>
        get().entries.filter((e) => {
          const t = new Date(e.timestamp);
          return t >= start && t <= end;
        }),
      getByBranch: (branchId) => get().entries.filter((e) => e.branchId === branchId),

      clear: () => set({ entries: [] }),
    }),
    { name: "audit-storage" },
  ),
);

/**
 * Hook-style helper for components. Returns a stable `log` function bound
 * to the current auth/branch context.
 */
export function useAuditLogger() {
  const username = useAuditStore((s) => s.entries[0]?.actorUsername) || "system";
  return {
    log: (
      entry: Omit<AuditEntry, "id" | "timestamp" | "actorUsername" | "actorRole"> & {
        actorUsername?: string;
        actorRole?: UserRole | "system";
      },
    ) =>
      useAuditStore.getState().log({
        actorUsername: entry.actorUsername || username || "system",
        actorRole: entry.actorRole || "system",
        action: entry.action,
        resource: entry.resource,
        branchId: entry.branchId,
        details: entry.details,
        notes: entry.notes,
      }),
  };
}
