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
 * | Capability | ADMIN | POS_ECOMMERCE | ECOMMERCE_ONLY | ACCOUNTANT | MODERATOR |
 * |---|---|---|---|---|---|
 * | home | ✅ | ✅ | ✅ | ✅ | ✅ |
 * | more | ✅ | ✅ | ✅ | ✅ | ✅ |
 * | orders | ✅ | ✅ | ✅ | ❌ | ✅ |
 * | stock | ✅ | ❌ | ✅ | ✅ | ✅ |
 * | shipments | ✅ | ✅ | ✅ | ❌ | ✅ |
 * | customers | ✅ | ✅ | ❌ | ❌ | ✅ |
 * | purchasing | ✅ | ❌ | ❌ | ✅ | ❌ |
 * | preferences | ✅ | ✅ | ✅ | ✅ | ✅ |
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
 * `home` and `more` are always included for authenticated users. For the four
 * roles that own desktop screens, everything else is resolved via `canAccess()`
 * against the existing desktop access map — no new permission logic. MODERATOR
 * is the stated exception; see `MODERATOR_CAPABILITIES` below for why.
 */
/**
 * One Set per role, for the life of the tab.
 *
 * ## Why this is a cache and not just a function
 *
 * `getMobileCapabilities` is called during render by `MobileHomePlaceholder`
 * and by `useAlertBadges` — which the bottom nav mounts on EVERY screen.
 * Building a fresh `Set` each time gave every render a new object identity, so
 * `useMobileHomeData`'s `useCallback([capabilities, …])` was rebuilt on every
 * render, its `useEffect([reload])` re-fired, `setState` re-rendered, and the
 * loop closed. React gave up after 50 nested updates and logged "Maximum
 * update depth exceeded" ~900 times in seconds; the restock screen stopped
 * answering taps entirely.
 *
 * The answer is a pure function of the role and the role set is fixed, so this
 * is one entry per role and none of them ever needs invalidating. Fixing it HERE rather
 * than wrapping each call site in `useMemo` is what makes it impossible for
 * the next caller to reintroduce the loop.
 */
const CAPABILITIES_BY_ROLE = new Map<AppRole, ReadonlySet<MobileCapability>>();

/**
 * MODERATOR is stated here, not derived from `canAccess`.
 *
 * ## Why this one role is an exception
 *
 * Every other role's mobile capabilities are a projection of a DESKTOP screen
 * it already owns, so delegating to `canAccess` cannot invent a permission.
 * The Moderator owns no desktop screen: it is a phone persona. Reaching its
 * surfaces through `canAccess` would mean adding `MODERATOR` to `/orders`,
 * `/inventory` and `/crm` in `ROUTE_ACCESS` — and `ROUTE_ACCESS` is what the
 * DESKTOP router and sidebar read. That would hand a read-only supervisor
 * three full desktop screens of buttons (edit order, adjust stock, edit
 * customer) whose writes Postgres then refuses one click later.
 *
 * `docs/MOBILE_PERSONA_ARCHITECTURE.md` §4 names the shortcut this avoids:
 * widening a shared desktop route to reach a mobile screen. So the split is
 * the point — mobile capability resolution stops being desktop authorization
 * for this role, and the desktop map is left exactly as it was.
 *
 * This grants nothing on its own. Every surface below is a READ, and each one
 * is gated in Postgres on `is_store_member(store_id)`. No write reaches the
 * Moderator through this set: `purchasing` — the only mobile capability behind
 * which a write lives (`/restock` → `commitReceipt`) — is deliberately absent,
 * and every `has_role(...)` write policy omits the role besides.
 */
const MODERATOR_CAPABILITIES: readonly MobileCapability[] = [
  "home",
  "more",
  "orders",
  "stock",
  "shipments",
  "customers",
  "preferences",
];

export function getMobileCapabilities(role: AppRole): ReadonlySet<MobileCapability> {
  const cached = CAPABILITIES_BY_ROLE.get(role);
  if (cached) return cached;

  const capabilities = new Set<MobileCapability>(["home", "more"]);

  if (role === "MODERATOR") {
    for (const capability of MODERATOR_CAPABILITIES) capabilities.add(capability);
  } else {
    for (const [capability, desktopPath] of Object.entries(
      DESKTOP_RESOURCE_FOR_CAPABILITY,
    ) as [Exclude<MobileCapability, "home" | "more">, string][]) {
      if (canAccess(role, desktopPath)) {
        capabilities.add(capability);
      }
    }
  }

  CAPABILITIES_BY_ROLE.set(role, capabilities);
  return capabilities;
}

/**
 * Returns whether a role holds a specific mobile capability.
 *
 * This asks `getMobileCapabilities` rather than re-deriving the answer. It used
 * to call `canAccess` directly, which was the same answer for the four desktop
 * roles and the WRONG one for `MODERATOR` — whose set is stated above and is
 * deliberately not reachable through the desktop route map. `MobileRouteGuard`
 * is the caller, so the divergence would have been a guard that redirected the
 * Moderator away from the screens the bottom nav had just drawn for it.
 */
export function hasMobileCapability(role: AppRole, capability: MobileCapability): boolean {
  return getMobileCapabilities(role).has(capability);
}
