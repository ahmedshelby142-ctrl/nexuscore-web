/**
 * التفضيلات الشخصية — the one screen every role can open.
 *
 * Making `/settings` ADMIN-only in Phase 8 was right for the business config
 * living there, but it took the light/dark toggle with it — and a cashier
 * staring at a bright screen through a night shift is a real complaint with no
 * security value behind it. Appearance is a preference, not a permission.
 *
 * Deliberately holds NOTHING but appearance. The moment a business setting
 * lands here it becomes a hole in the RBAC map, because this route is open to
 * everyone by design.
 */

import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { useAuthStore } from "@/store/useAuthStore";
import { toAppRole, ROLE_LABELS } from "@/lib/roles";

export function Preferences() {
  const { username, userRole } = useAuthStore();

  return (
    <div className="space-y-6 max-w-4xl mx-auto w-full">
      <div className="pb-1">
        <h2 className="text-3xl font-display font-bold tracking-tight">
          التفضيلات الشخصية والمظهر
        </h2>
        <p className="text-muted-foreground mt-1">
          تخصيص ألوان واجهة النظام — الوضع الفاتح / الداكن
        </p>
      </div>

      {/* Who you are signed in as. Useful on a shared till, and it makes the
          screens you can and cannot see explainable rather than mysterious. */}
      <div className="rounded-2xl border border-border bg-card p-5 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <p className="text-sm text-muted-foreground">الحساب الحالي</p>
          <p className="text-lg font-semibold mt-0.5">{username || "مستخدم"}</p>
        </div>
        <div className="text-left">
          <p className="text-sm text-muted-foreground">الصلاحية</p>
          <p className="text-lg font-semibold mt-0.5">{ROLE_LABELS[toAppRole(userRole)]}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-6">
        {/* `simplified` keeps this to light/dark. The full brand-identity
            palettes stay in الإعدادات — those change what CUSTOMERS see on a
            printed invoice, which is a business decision, not a personal one. */}
        <ThemeSwitcher simplified />
      </div>
    </div>
  );
}
