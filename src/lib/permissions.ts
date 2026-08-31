import type { UserRole } from "@/types";

/**
 * RBAC permission mapper.
 *
 * The system shipped with 4 retail-flavoured roles
 * (owner / cashier / data_entry / cashier_data_entry). New roles
 * (branch_manager / inventory_clerk / accountant / customer_support /
 * viewer) are additive — they project onto the existing 4 roles for
 * permission purposes so the rest of the app (Sidebar, RoleGuard, route
 * definitions) does not need to be rewritten.
 *
 * If you need a new permission that is not covered by any of the four
 * existing roles, add a new role and a mapping here. Do not edit the
 * existing roles' behaviour — that would break the lockdown rules
 * already exercised by the rest of the system.
 *
 * Mappings (all include branch-aware variants where applicable):
 *   - branch_manager      -> owner (scoped to assigned branch)
 *   - inventory_clerk     -> owner for inventory + purchasing
 *   - accountant          -> owner for partners/finance only
 *   - customer_support    -> data_entry for orders/CRM/returns
 *   - viewer              -> owner (read-only) — UI must disable writes
 */
export type Permission =
  | "view:dashboard"
  | "view:pos"
  | "view:inventory"
  | "view:purchasing"
  | "view:wholesale"
  | "view:partners"
  | "view:products"
  | "view:orders"
  | "view:ecommerce-orders"
  | "view:courier-ledger"
  | "view:bundles"
  | "view:discounts"
  | "view:crm"
  | "view:returns"
  | "view:integrations"
  | "view:settings"
  | "view:users"
  | "view:branches"
  | "view:reports"
  | "edit:orders"
  | "edit:inventory"
  | "edit:finance"
  | "edit:settings"
  | "edit:users";

/**
 * Project an extended role onto the canonical 4-role set for permission
 * lookups. Use this when checking "is this user allowed to do X" — the
 * Sidebar / RoleGuard treat the result as the effective role.
 */
export function projectToCanonicalRole(role: UserRole): UserRole {
  switch (role) {
    case "branch_manager":
    case "inventory_clerk":
    case "accountant":
    case "viewer":
      return "owner";
    case "customer_support":
      return "data_entry";
    default:
      return role;
  }
}

/**
 * Returns the set of permissions granted to a given role. This is the
 * single source of truth for what each role can do.
 */
export function getRolePermissions(role: UserRole): Set<Permission> {
  const canonical = projectToCanonicalRole(role);
  const base = new Set<Permission>(BASE_PERMISSIONS[canonical] ?? []);

  // Inventory clerk is locked to inventory only.
  if (role === "inventory_clerk") {
    return new Set<Permission>([
      "view:dashboard",
      "view:inventory",
      "view:purchasing",
      "view:products",
      "view:branches",
      "view:reports",
      "edit:inventory",
    ]);
  }

  // Accountant is locked to finance/ledger only.
  if (role === "accountant") {
    return new Set<Permission>([
      "view:dashboard",
      "view:partners",
      "view:inventory",
      "view:products",
      "view:branches",
      "view:reports",
      "edit:finance",
    ]);
  }

  // Customer support sees orders / CRM / returns.
  if (role === "customer_support") {
    return new Set<Permission>([
      "view:dashboard",
      "view:orders",
      "view:ecommerce-orders",
      "view:crm",
      "view:returns",
      "view:branches",
      "view:reports",
      "edit:orders",
    ]);
  }

  // Viewer is read-only — strip write permissions.
  if (role === "viewer") {
    return new Set<Permission>(Array.from(base).filter((p) => p.startsWith("view:")));
  }

  return base;
}

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return getRolePermissions(role).has(permission);
}

export function hasAnyPermission(role: UserRole, permissions: Permission[]): boolean {
  const set = getRolePermissions(role);
  return permissions.some((p) => set.has(p));
}

const BASE_PERMISSIONS: Record<UserRole, Permission[]> = {
  owner: [
    "view:dashboard",
    "view:pos",
    "view:inventory",
    "view:purchasing",
    "view:wholesale",
    "view:partners",
    "view:products",
    "view:orders",
    "view:ecommerce-orders",
    "view:courier-ledger",
    "view:bundles",
    "view:discounts",
    "view:crm",
    "view:returns",
    "view:integrations",
    "view:settings",
    "view:users",
    "view:branches",
    "view:reports",
    "edit:orders",
    "edit:inventory",
    "edit:finance",
    "edit:settings",
    "edit:users",
  ],
  cashier: ["view:pos", "view:products", "view:returns", "view:settings", "edit:orders"],
  data_entry: [
    "view:ecommerce-orders",
    "view:orders",
    "view:bundles",
    "view:discounts",
    "view:crm",
    "view:returns",
    "view:products",
    "view:settings",
    "edit:orders",
  ],
  cashier_data_entry: [
    "view:pos",
    "view:products",
    "view:returns",
    "view:settings",
    "view:ecommerce-orders",
    "view:orders",
    "view:bundles",
    "view:discounts",
    "view:crm",
    "edit:orders",
  ],
  // Extended roles — handled by the per-case logic above.
  branch_manager: [],
  inventory_clerk: [],
  accountant: [],
  customer_support: [],
  viewer: [],
};

/**
 * Returns the list of visible nav items for a role. Used by the Sidebar
 * to filter items when a user lands on a non-canonical role.
 */
export function getEffectiveVisibleNavRoles(role: UserRole): UserRole[] {
  switch (role) {
    case "branch_manager":
      return ["owner", "cashier_data_entry"];
    case "inventory_clerk":
      return ["owner"]; // but the inventory-only permission set narrows it
    case "accountant":
      return ["owner"]; // but the finance-only permission set narrows it
    case "customer_support":
      return ["data_entry", "cashier_data_entry"];
    case "viewer":
      return ["owner", "cashier", "data_entry", "cashier_data_entry"];
    default:
      return [role];
  }
}
