import { canAccess, type AppRole } from "@/lib/roles";

/**
 * Presentation-level capabilities for the Mobile PWA.
 *
 * These are NOT permissions. They are mobile product capabilities that map
 * to existing desktop resource concepts solely to reuse the existing
 * `canAccess()` access control without duplicating any logic.
 *
 * The backend (RLS, RPCs, server functions) remains the security boundary.
 * These only control what the mobile UI shows and where it navigates.
 *
 * ## Capability to Desktop Resource Mapping
 *
 * | Mobile Capability | Desktop Path | Reason |
 * |---|---|---|
 * | home | (unconditional) | Available to every authenticated user |
 * | more | (unconditional) | Shell affordance, no operational content |
 * | orders | /orders | Order management |
 * | stock | /inventory | Inventory management |
 * | shipments | /orders | Shipment queue is a view over orders (shipped) |
 * | customers | /crm | Customer profiles |
 * | purchasing | /purchasing | Supplier purchasing |
 * | preferences | /preferences | User preferences |
 *
 * ## Role Matrix
 *
 * | Capability | ADMIN | POS_ECOMMERCE | ECOMMERCE_ONLY | ACCOUNTANT |
 * |---|---|---|---|---|
 * | home | ✅ | ✅ | ✅ | ✅ |
 * | more | ✅ | ✅ | ✅ | ✅ |
 * | orders | ✅ | ✅ | ✅ | ❌ |
 * | stock | ✅ | ❌ | ✅ | ✅ |
 * | shipments | ✅ | ✅ | ✅ | ❌ |
 * | customers | ✅ | ✅ | ❌ | ❌ |
 * | purchasing | ✅ | ❌ | ❌ | ✅ |
 * | preferences | ✅ | ✅ | ✅ | ✅ |
 */
export type MobileCapability =
  | "home"
  | "more"
  | "orders"
  | "stock"
  | "shipments"
  | "customers"
  | "purchasing"
  | "preferences";

export const ALL_MOBILE_CAPABILITIES: readonly MobileCapability[] = [
  "home",
  "more",
  "orders",
  "stock",
  "shipments",
  "customers",
  "purchasing",
  "preferences",
];

/**
 * Desktop path each mobile capability delegates access resolution to.
 * `home` and `more` are unconditional and absent from this map.
 */
const DESKTOP_RESOURCE_FOR_CAPABILITY: Record<
  Exclude<MobileCapability, "home" | "more">,
  string
> = {
  orders: "/orders",
  stock: "/inventory",
  // Shipments is an operational view over shipped orders.
  // It proxies through /orders access since both read the same domain.
  shipments: "/orders",
  customers: "/crm",
  purchasing: "/purchasing",
  preferences: "/preferences",
};

/**
 * Returns the full set of mobile capabilities for a given role.
 *
 * `home` and `more` are always included for authenticated users.
 * All other capabilities are resolved via `canAccess()` against the
 * existing desktop access map — no new permission logic is introduced.
 */
export function getMobileCapabilities(role: AppRole): ReadonlySet<MobileCapability> {
  const capabilities = new Set<MobileCapability>(["home", "more"]);

  for (const [capability, desktopPath] of Object.entries(
    DESKTOP_RESOURCE_FOR_CAPABILITY,
  ) as [Exclude<MobileCapability, "home" | "more">, string][]) {
    if (canAccess(role, desktopPath)) {
      capabilities.add(capability);
    }
  }

  return capabilities;
}

/**
 * Returns whether a role holds a specific mobile capability.
 * Prefer `getMobileCapabilities()` when checking multiple capabilities at once.
 */
export function hasMobileCapability(role: AppRole, capability: MobileCapability): boolean {
  // Unconditional capabilities.
  if (capability === "home" || capability === "more") return true;
  const desktopPath =
    DESKTOP_RESOURCE_FOR_CAPABILITY[
      capability as Exclude<MobileCapability, "home" | "more">
    ];
  return canAccess(role, desktopPath);
}
