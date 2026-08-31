import { useState, useRef, useEffect } from "react";
import { UserCog } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/useAuthStore";
import { USER_ROLE_LABELS, type UserRole } from "@/types";

// All 9 supported roles. The original 4 are listed first for dev convenience;
// the 5 extended roles (branch_manager / inventory_clerk / accountant /
// customer_support / viewer) can be added in the same dev tool without
// touching the rest of the system.
const ROLES: UserRole[] = [
  "owner",
  "cashier",
  "data_entry",
  "cashier_data_entry",
  "branch_manager",
  "inventory_clerk",
  "accountant",
  "customer_support",
  "viewer",
];

export function DevRoleSwitcher() {
  const userRole = useAuthStore((s) => s.userRole);
  const setUserRole = useAuthStore((s) => s.setUserRole);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all",
          "border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40",
          "text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950/60",
          "shadow-sm",
        )}
        title="أداة تطوير — تبديل الصلاحية"
      >
        <UserCog className="size-3.5" />
        <span dir="ltr">{USER_ROLE_LABELS[userRole]}</span>
        <span className="text-[9px] opacity-60">DEV</span>
      </button>

      {open && (
        <div className="absolute top-full mt-1.5 right-0 min-w-[160px] rounded-xl border border-border bg-card shadow-xl p-1.5 space-y-0.5 z-50">
          {ROLES.map((role) => (
            <button
              key={role}
              type="button"
              onClick={() => {
                setUserRole(role);
                setOpen(false);
              }}
              className={cn(
                "w-full text-right px-3 py-2 rounded-lg text-xs font-medium transition-all",
                role === userRole
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {USER_ROLE_LABELS[role]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
