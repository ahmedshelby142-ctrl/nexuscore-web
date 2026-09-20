import { Boxes, ClipboardList, House, Menu, Package, Truck, Users, Settings, Wallet, type LucideIcon } from "lucide-react";
import type { MobileCapability } from "./mobileCapabilities";
import type { AppRole } from "@/lib/roles";

export interface MobileNavigationItem {
  id: MobileCapability;
  label: string;
  icon: LucideIcon;
  path?: string;
  /**
   * True if this module actually has a mobile screen built.
   *
   * `MobileMoreSheet` renders a `disabled` row with a قريباً badge when this is
   * false, so a stale `false` is not cosmetic — it is a screen that exists,
   * routes, and cannot be opened. Keep it in step with `router.tsx`: false
   * means the path lands on `MobileDeferredScreen`.
   */
  isImplemented: boolean;
}

export const ALL_MODULES: Record<MobileCapability, MobileNavigationItem> = {
  home: { id: "home", label: "الرئيسية", icon: House, path: "/", isImplemented: true },
  orders: { id: "orders", label: "الطلبات", icon: ClipboardList, path: "/orders", isImplemented: true },
  stock: { id: "stock", label: "المخزون", icon: Package, path: "/inventory", isImplemented: true },
  shipments: { id: "shipments", label: "الشحنات", icon: Truck, path: "/shipments", isImplemented: true },
  customers: { id: "customers", label: "العملاء", icon: Users, path: "/customers", isImplemented: true },
  purchasing: { id: "purchasing", label: "المشتريات", icon: Boxes, path: "/purchasing", isImplemented: false },
  preferences: { id: "preferences", label: "الإعدادات", icon: Settings, path: "/preferences", isImplemented: false },
  owner: { id: "owner", label: "المالية", icon: Wallet, path: "/owner", isImplemented: true },
  more: { id: "more", label: "المزيد", icon: Menu, isImplemented: true },
};

/**
 * Returns the maximum 4 bottom navigation items for a given role.
 * This defines the priority navigation for the role's primary workflow.
 */
export function getBottomNavForRole(role: AppRole): MobileNavigationItem[] {
  switch (role) {
    // Money is the Owner's first question (persona architecture §3), so
    // المالية takes the slot المخزون used to hold; المخزون is one tap away in
    // المزيد. The bar is capped at four and the Owner is the only role with a
    // fifth destination to fit.
    case "ADMIN":
      return [ALL_MODULES.home, ALL_MODULES.owner, ALL_MODULES.orders, ALL_MODULES.more];
    case "ACCOUNTANT":
      return [ALL_MODULES.home, ALL_MODULES.stock, ALL_MODULES.purchasing, ALL_MODULES.more];
    case "POS_ECOMMERCE":
    case "ECOMMERCE_ONLY":
      return [ALL_MODULES.home, ALL_MODULES.orders, ALL_MODULES.shipments, ALL_MODULES.more];
    // The supervisor's three questions in the order they get asked: what needs
    // doing, is it in stock, where is it. العملاء and الشحنات live one tap away
    // in المزيد — a lookup, not a queue (persona architecture §2, Home UX).
    case "MODERATOR":
      return [ALL_MODULES.home, ALL_MODULES.orders, ALL_MODULES.stock, ALL_MODULES.more];
    default:
      return [ALL_MODULES.home, ALL_MODULES.more];
  }
}

/**
 * Returns the modules that should appear in the 'More' overflow sheet for a role.
 * This excludes modules already present in their bottom nav.
 */
export function getMoreModulesForRole(
  role: AppRole,
  activeCapabilities: ReadonlySet<MobileCapability>
): MobileNavigationItem[] {
  const bottomNavIds = new Set(getBottomNavForRole(role).map((item) => item.id));
  
  const moreModules: MobileNavigationItem[] = [];
  
  // Sort capabilities according to the order in ALL_MODULES keys for consistent display
  const orderedCapabilities: MobileCapability[] = [
    "owner", "orders", "stock", "shipments", "customers", "purchasing", "preferences"
  ];
  
  for (const cap of orderedCapabilities) {
    if (activeCapabilities.has(cap) && !bottomNavIds.has(cap)) {
      moreModules.push(ALL_MODULES[cap]);
    }
  }
  
  return moreModules;
}
