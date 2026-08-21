import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  PackageOpen,
  Truck,
  Users,
  Settings,
  LogOut,
  Globe,
  ChevronLeft,
  ChevronRight,
  ShoppingBag,
  RotateCcw,
  ClipboardList,
  ClipboardCheck,
  Wallet,
  Boxes,
  Percent,
  UserCheck,
  Building2,
  ShieldCheck,
  DatabaseBackup,
  KeyRound,
} from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/useAuthStore";
import { useThemeStore } from "@/store/useThemeStore";
import { useFeatureStore } from "@/store/useFeatureStore";
import {
  BUSINESS_TYPE_LABELS,
  type BusinessType,
  type UserRole,
  type BusinessProfile,
} from "@/types";
import { getEffectiveVisibleNavRoles } from "@/lib/permissions";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import logoLight from "@/assets/logo-light.png";
import logoDark from "@/assets/logo-dark.png";
import { logout as serverLogout } from "@/lib/api/authServer";

interface NavItem {
  label: string;
  prefLabel?: string; // alternate label for non-owner roles
  icon: React.ElementType;
  path: string;
  roles: UserRole[];
  profiles: BusinessProfile[];
  featureKey?:
    | "returnsEnabled"
    | "shippingTrackingEnabled"
    | "salesCommissionsEnabled"
    | "ecommerceSyncEnabled"
    | "depositMandatory";
}

const allNavItems: NavItem[] = [
  {
    label: "نظرة عامة",
    icon: LayoutDashboard,
    path: "/",
    roles: ["owner"],
    profiles: ["omnichannel", "retail_only", "ecommerce_only"],
  },
  {
    label: "المنتجات",
    icon: PackageOpen,
    path: "/products",
    roles: ["owner"],
    profiles: ["omnichannel", "retail_only", "ecommerce_only"],
  },
  {
    label: "نقاط البيع (POS)",
    icon: ShoppingCart,
    path: "/pos",
    roles: ["owner", "cashier", "cashier_data_entry"],
    profiles: ["omnichannel", "retail_only"],
  },
  {
    label: "المخازن",
    icon: Package,
    path: "/inventory",
    roles: ["owner"],
    profiles: ["omnichannel", "retail_only", "ecommerce_only"],
  },
  {
    label: "الجرد",
    icon: ClipboardCheck,
    path: "/stock-audit",
    roles: ["owner"],
    profiles: ["omnichannel", "retail_only", "ecommerce_only"],
  },
  {
    label: "المشتريات والموردين",
    icon: Truck,
    path: "/purchasing",
    roles: ["owner"],
    profiles: ["omnichannel", "retail_only", "ecommerce_only"],
  },
  {
    label: "الشركاء والمالية",
    icon: Users,
    path: "/partners",
    roles: ["owner"],
    profiles: ["omnichannel", "retail_only", "ecommerce_only"],
  },
  {
    label: "الطلبات الإلكترونية",
    icon: ShoppingBag,
    path: "/ecommerce-orders",
    roles: ["owner", "data_entry", "cashier_data_entry"],
    profiles: ["omnichannel", "ecommerce_only"],
  },
  {
    label: "إدارة الطلبات",
    icon: ClipboardList,
    path: "/orders",
    roles: ["owner", "data_entry", "cashier_data_entry"],
    profiles: ["omnichannel", "ecommerce_only"],
  },
  {
    label: "حسابات الشحن",
    icon: Wallet,
    path: "/courier-ledger",
    roles: ["owner"],
    profiles: ["omnichannel", "ecommerce_only"],
  },
  {
    label: "البوكسات/التجميعات",
    icon: Boxes,
    path: "/bundles",
    roles: ["owner", "data_entry"],
    profiles: ["omnichannel", "ecommerce_only"],
  },
  {
    label: "الخصومات",
    icon: Percent,
    path: "/discounts",
    roles: ["owner", "data_entry"],
    profiles: ["omnichannel", "ecommerce_only"],
  },
  {
    label: "قاعدة العملاء",
    icon: UserCheck,
    path: "/crm",
    roles: ["owner", "data_entry"],
    profiles: ["omnichannel", "ecommerce_only"],
  },
  {
    label: "مبيعات الجملة",
    icon: Building2,
    path: "/wholesale",
    roles: ["owner"],
    profiles: ["omnichannel", "retail_only", "ecommerce_only"],
  },
  {
    label: "المرتجعات والاستبدال",
    icon: RotateCcw,
    path: "/returns",
    roles: ["owner", "cashier", "data_entry", "cashier_data_entry"],
    profiles: ["omnichannel", "ecommerce_only"],
    featureKey: "returnsEnabled",
  },
  {
    label: "ربط المتجر الإلكتروني",
    icon: Globe,
    path: "/integrations",
    roles: ["owner"],
    profiles: ["omnichannel", "ecommerce_only"],
    featureKey: "ecommerceSyncEnabled",
  },
  {
    label: "الإعدادات",
    icon: Settings,
    path: "/settings",
    roles: ["owner", "cashier", "data_entry", "cashier_data_entry"],
    profiles: ["omnichannel", "retail_only", "ecommerce_only"],
    prefLabel: "التفضيلات الشخصية",
  },
  {
    label: "الفروع والمنافذ",
    icon: Building2,
    path: "/branches",
    roles: ["owner"],
    profiles: ["omnichannel", "retail_only", "ecommerce_only"],
  },
  {
    label: "المستخدمين والصلاحيات",
    icon: ShieldCheck,
    path: "/users",
    roles: ["owner"],
    profiles: ["omnichannel", "retail_only", "ecommerce_only"],
  },
  {
    label: "النسخ الاحتياطي والاستعادة",
    icon: DatabaseBackup,
    path: "/backups",
    roles: ["owner"],
    profiles: ["omnichannel", "retail_only", "ecommerce_only"],
  },
];

const personaSubLabels: Record<BusinessType, string> = {
  retail: "منظومة إدارة المحلات التجارية",
  ecommerce: "منظومة المتجر الإلكتروني",
};

function NavLink({
  item,
  collapsed,
  active,
}: {
  item: NavItem;
  collapsed: boolean;
  active: boolean;
}) {
  const link = (
    <Link
      to={item.path}
      className={cn(
        "w-full flex items-center rounded-lg text-sm font-medium transition-all duration-200",
        collapsed ? "justify-center px-0 py-3" : "gap-3 px-3 py-2.5",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      <item.icon className={cn("shrink-0", collapsed ? "size-5" : "size-4")} />
      {!collapsed && <span className="flex-1 text-right truncate">{item.label}</span>}
      {!collapsed && active && <span className="size-1.5 rounded-full bg-primary shrink-0" />}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={12} className="text-xs font-medium">
          {item.label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return link;
}

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { userRole, businessType, operationMode, username, logout, activeBusinessProfile } =
    useAuthStore();
  const { mode, sidebarCollapsed, toggleSidebar } = useThemeStore();
  const featureFlags = useFeatureStore();
  const logoSrc = mode === "dark" ? logoDark : logoLight;
  const collapsed = sidebarCollapsed;

  const navItems = allNavItems.filter(
    (item) =>
      getEffectiveVisibleNavRoles(userRole).some((r) => item.roles.includes(r)) &&
      item.profiles.includes(activeBusinessProfile) &&
      (!item.featureKey || featureFlags[item.featureKey]),
  );

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          "hidden lg:flex shrink-0 flex-col border-l border-sidebar-border bg-sidebar transition-all duration-300 ease-in-out",
          collapsed ? "w-[70px]" : "w-[260px]",
        )}
      >
        <div
          className={cn(
            "flex border-b border-sidebar-border transition-all duration-300",
            collapsed ? "flex-col items-center gap-2 px-0 py-4" : "items-center gap-3 px-5 py-5",
          )}
        >
          <img
            src={logoSrc}
            alt="NexusCore"
            className={cn("object-contain shrink-0", collapsed ? "size-7" : "size-9")}
          />
          {!collapsed && (
            <div className="min-w-0">
              <h1 className="font-display text-base font-bold leading-tight tracking-tight">
                NexusCore
              </h1>
              <p className="text-[10px] text-muted-foreground leading-relaxed mt-0.5 truncate">
                {personaSubLabels[businessType]}
              </p>
            </div>
          )}
        </div>

        <button
          onClick={toggleSidebar}
          className={cn(
            "flex items-center justify-center text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent/60 transition-all duration-200",
            collapsed
              ? "mx-auto mt-3 size-8 rounded-lg"
              : "mx-3 mt-3 px-3 py-1.5 rounded-lg gap-2 text-xs font-medium",
          )}
          title={collapsed ? "توسيع القائمة" : "طي القائمة"}
        >
          {collapsed ? (
            <ChevronLeft className="size-4" />
          ) : (
            <>
              <ChevronRight className="size-3.5" /> طي القائمة
            </>
          )}
        </button>

        <nav
          className={cn(
            "flex-1 overflow-y-auto transition-all duration-300",
            collapsed ? "px-2 py-4 space-y-1" : "px-3 py-4 space-y-0.5",
          )}
        >
          {navItems.map((item) => {
            const label = userRole !== "owner" && item.prefLabel ? item.prefLabel : item.label;
            return (
              <NavLink
                key={item.path}
                item={{ ...item, label }}
                collapsed={collapsed}
                active={location.pathname === item.path}
              />
            );
          })}
        </nav>

        <div className={collapsed ? "px-2 pb-2" : "px-3 pb-2"}>
          {operationMode === "cloud_sync" ? (
            <div
              className={cn(
                "flex rounded-xl border border-sidebar-border bg-sidebar-accent/30 transition-all duration-300",
                collapsed
                  ? "items-center justify-center p-2.5"
                  : "items-center gap-2.5 px-3 py-2.5",
              )}
            >
              <span className="size-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)] shrink-0" />
              {!collapsed && (
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-green-600 dark:text-green-400 leading-tight">
                    سحابي متصل
                  </p>
                  <p className="text-[10px] text-muted-foreground leading-relaxed mt-px truncate">
                    متزامن مع الخادم
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div
              className={cn(
                "flex rounded-xl border border-sidebar-border bg-sidebar-accent/30 transition-all duration-300",
                collapsed
                  ? "items-center justify-center p-2.5"
                  : "items-center gap-2.5 px-3 py-2.5",
              )}
            >
              <span className="size-2 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.6)] shrink-0" />
              {!collapsed && (
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-blue-600 dark:text-blue-400 leading-tight">
                    محلي أوفلاين
                  </p>
                  <p className="text-[10px] text-muted-foreground leading-relaxed mt-px truncate">
                    جاهز لتصدير التقرير
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <div className={collapsed ? "px-2 pb-3" : "px-3 pb-3"}>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <button
                onClick={async () => {
                  // Best-effort server-side logout. If the server is
                  // unreachable we still clear local state so the user
                  // is not stuck on the app.
                  try {
                    const token = useAuthStore.getState().sessionToken;
                    if (token) {
                      await serverLogout({ data: { token } }).catch(() => undefined);
                    }
                  } catch {
                    // ignore
                  }
                  logout();
                  navigate("/login", { replace: true });
                }}
                className={cn(
                  "flex items-center rounded-lg text-sm font-medium text-red-500/70 hover:text-red-500 hover:bg-red-500/10 transition-all duration-200",
                  collapsed ? "justify-center w-full p-2.5" : "w-full gap-3 px-3 py-2.5",
                )}
              >
                <LogOut className={cn("shrink-0", collapsed ? "size-5" : "size-4")} />
                {!collapsed && <span className="flex-1 text-right">تسجيل الخروج</span>}
              </button>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right" sideOffset={12} className="text-xs font-medium">
                تسجيل الخروج
              </TooltipContent>
            )}
          </Tooltip>
        </div>
      </aside>
    </TooltipProvider>
  );
}
