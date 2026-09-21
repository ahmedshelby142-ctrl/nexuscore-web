import { ShieldCheck } from "lucide-react";
import { ROLE_LABELS, toAppRole } from "@/lib/roles";
import { useAuthStore } from "@/store/useAuthStore";
import { cn } from "@/lib/utils";

/**
 * Who is actually signed in, and as what.
 *
 * ## What this replaced
 *
 * `components/dashboard/Header.tsx` rendered two string literals:
 *
 * ```tsx
 * <p>سارة المصري</p>
 * <p>مدير النظام</p>
 * ```
 *
 * — a fictional person, and ADMIN, to every user of every store. A cashier, an
 * accountant and a read-only moderator all read "مدير النظام" off the chrome
 * of every screen. On a shared till that is not decoration: it is the app
 * telling the operator they hold permissions they do not, which is exactly the
 * kind of thing somebody acts on before they are refused by Postgres.
 *
 * The shipped desktop shell (`layout/Layout.tsx`) had the opposite problem and
 * the same root: it showed no identity at all, so there was no way to see who
 * was signed in or notice that it was the wrong person.
 *
 * One component now answers it for both, because two of them is how the
 * fiction survived in one while the other was rewritten.
 *
 * ## Where each field comes from
 *
 * | Shown | Source | Authority |
 * |---|---|---|
 * | name | `useAuthStore.username` | the Supabase session's email |
 * | role | `useAuthStore.userRole` → `ROLE_LABELS` | `store_members.role` |
 * | owner badge | `useAuthStore.isSystemOwner` | `is_system_owner()` RPC |
 *
 * All three are re-resolved from the server on every boot by
 * `reconcileSupabaseSession`, which is what makes them worth showing.
 * `username` and `userRole` are persisted, but they are OVERWRITTEN on each
 * reconciliation from `auth.getSession()` and a fresh `store_members` read —
 * so editing them in devtools survives exactly until the next render, and
 * changes nothing at the database either way. `isSystemOwner` is never
 * persisted at all (see `useAuthStore.partialize`); it is re-asked every boot
 * and cleared by `logout()`.
 *
 * ## It is a label, not a lock
 *
 * Nothing here grants anything. `RequireAccess` decides what opens and RLS
 * decides what answers. This only stops the chrome from misreporting it.
 *
 * ## The email is the name, deliberately
 *
 * `store_members` holds no name column and `list_store_members` returns none —
 * the invite form asks for an address and nothing else. Inventing a profile
 * table to put a prettier string here would be a new feature carrying a new
 * source of truth, so the identity the product actually has is the identity
 * shown.
 */

/** Initials for the avatar. Latin-safe, Arabic-safe, and never longer than 2. */
function initialsOf(identity: string): string {
  const local = identity.split("@")[0] ?? "";
  const parts = local.split(/[._\-\s]+/).filter(Boolean);
  if (parts.length === 0) return "؟";
  if (parts.length === 1) return [...parts[0]].slice(0, 2).join("").toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function SessionIdentity({ className }: { className?: string }) {
  const username = useAuthStore((s) => s.username);
  const userRole = useAuthStore((s) => s.userRole);
  const isSystemOwner = useAuthStore((s) => s.isSystemOwner);

  // No session, nothing to claim. Rendering a blank chip would read as "signed
  // in as nobody"; rendering nothing reads as what it is.
  if (!username) return null;

  const roleLabel = ROLE_LABELS[toAppRole(userRole)];

  return (
    <div
      className={cn("flex items-center gap-2 min-w-0", className)}
      // One label for assistive tech, because three separate nodes read as
      // three unrelated fragments.
      aria-label={`المستخدم الحالي: ${username}، الصلاحية: ${roleLabel}${
        isSystemOwner ? "، مالك النظام" : ""
      }`}
    >
      <div
        className="size-8 shrink-0 rounded-full flex items-center justify-center text-primary-foreground font-semibold text-xs"
        style={{ background: "var(--gradient-primary)" }}
        aria-hidden="true"
      >
        <span dir="ltr">{initialsOf(username)}</span>
      </div>
      <div className="text-right hidden md:block min-w-0">
        <p className="text-xs font-semibold leading-tight truncate max-w-[14rem]" dir="ltr">
          {username}
        </p>
        <p className="text-[10px] text-muted-foreground leading-tight flex items-center gap-1 justify-end">
          {/* The System Owner is a GLOBAL identity, not a store role, so it is
              shown ALONGSIDE the store role and never instead of it. An owner
              who is also an ADMIN of their own shop is both, and collapsing the
              two would hide which one a given screen is answering to. */}
          {isSystemOwner && (
            <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400 font-medium">
              <ShieldCheck className="size-3" aria-hidden="true" />
              مالك النظام
            </span>
          )}
          {isSystemOwner && <span aria-hidden="true">·</span>}
          <span>{roleLabel}</span>
        </p>
      </div>
    </div>
  );
}
