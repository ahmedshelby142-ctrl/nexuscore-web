import { canViewCost } from "@/lib/roles";
import { useAuthStore } from "@/store/useAuthStore";

/**
 * What a role may SEE inside the Mobile screens it can open — the one place
 * that decides it. Which screens a role opens is `mobileCapabilities.ts`; this
 * is the second axis, what those screens show.
 *
 *   cost      what goods and delivery COST the store (average cost, margins,
 *             «عمولة المندوب»). `canViewCost` — the same rule the database's
 *             `orders_operational` projection applies (047/048).
 *   internal  what is about running the shop rather than answering the
 *             customer: record ids, revenue/remittance flags, the books' own
 *             reconciliation check, the customer's money summary.
 *
 * Today both are "every role but the Moderator", so `internal` follows `cost`.
 * They are separate so a future role (a dispatcher who needs ids but not
 * margins, say) is one line here, not a new branch in every screen. Neither
 * grants anything: the database withholds cost from a Moderator regardless.
 */
export interface MobileVisibility {
  readonly cost: boolean;
  readonly internal: boolean;
}

// One frozen object per role, so a screen's dependency lists see a stable value.
const BY_ROLE = new Map<string, MobileVisibility>();

export function mobileVisibilityFor(role: string | null | undefined): MobileVisibility {
  const key = String(role ?? "");
  let visibility = BY_ROLE.get(key);
  if (!visibility) {
    const cost = canViewCost(role);
    visibility = Object.freeze({ cost, internal: cost });
    BY_ROLE.set(key, visibility);
  }
  return visibility;
}

/** For screens: re-renders when the verified role changes. */
export function useMobileVisibility(): MobileVisibility {
  return mobileVisibilityFor(useAuthStore((s) => s.userRole));
}
