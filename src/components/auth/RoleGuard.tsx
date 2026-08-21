import { type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ShieldAlert, ShoppingCart } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import { Button } from "@/components/ui/button";
import { USER_ROLE_LABELS, type UserRole } from "@/types";

interface RoleGuardProps {
  allowedRoles: UserRole[];
  children: ReactNode;
  /** Optional message override */
  message?: string;
  /** Optional custom redirect path */
  redirectPath?: string;
  /** Optional custom button label (default: POS) */
  redirectLabel?: string;
}

export function RoleGuard({
  allowedRoles,
  children,
  message,
  redirectPath,
  redirectLabel,
}: RoleGuardProps) {
  const userRole = useAuthStore((s) => s.userRole);
  const navigate = useNavigate();

  if (allowedRoles.includes(userRole)) {
    return <>{children}</>;
  }

  const btnLabel = redirectLabel || "العودة إلى نقاط البيع (POS)";
  const btnPath = redirectPath || "/pos";

  return (
    <div className="w-full flex items-center justify-center py-16">
      <div className="rounded-2xl border border-border bg-card p-10 text-center space-y-5 max-w-lg mx-auto shadow-sm">
        <div className="size-16 rounded-2xl flex items-center justify-center mx-auto bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
          <ShieldAlert className="size-8 text-amber-600 dark:text-amber-400" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-bold">غير مصرح بالوصول</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {message ||
              `عذراً، حسابك الحالي (${USER_ROLE_LABELS[userRole]}) لا يمتلك صلاحية عرض هذه الصفحة.`}
          </p>
        </div>
        <Button
          variant="default"
          onClick={() => navigate(btnPath, { replace: true })}
          className="gap-2"
        >
          <ShoppingCart className="size-4" />
          {btnLabel}
        </Button>
      </div>
    </div>
  );
}
