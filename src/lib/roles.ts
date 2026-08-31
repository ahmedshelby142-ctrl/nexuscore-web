/**
 * The four roles. Fixed, hardcoded, and the ONLY source of who sees what.
 *
 * ## Why this file exists
 *
 * Access used to be decided in two places that never agreed. The Sidebar
 * carried a `roles: UserRole[]` on every nav item, and `App.tsx` carried a
 * separate `<RoleGuard allowedRoles={...}>` around some — but not all — of the
 * matching routes. A link could be hidden while its URL stayed wide open, which
 * is not a hidden screen, it is an unlocked door with the sign taken down.
 *
 * One map now answers both questions. The Sidebar asks "may this role see this
 * path"; the router asks the same function about the same path. They cannot
 * drift because there is nothing to keep in step.
 *
 * ## This is the UX half of the lock, not the lock
 *
 * Everything here runs in the browser and can be edited by anyone with dev
 * tools. It decides what to *draw* and where to *redirect*. What a user may
 * actually READ or WRITE is enforced by Postgres RLS against
 * `store_members.role` — see `docs/migrations/002_rbac_roles.sql`. A client
 * guard is a courtesy to honest users; the database is the security boundary.
 */

/** The four fixed roles. No dynamic role-building, by design. */
export type AppRole = "ADMIN" | "POS_ECOMMERCE" | "ECOMMERCE_ONLY" | "ACCOUNTANT";

export const APP_ROLES: readonly AppRole[] = [
  "ADMIN",
  "POS_ECOMMERCE",
  "ECOMMERCE_ONLY",
  "ACCOUNTANT",
] as const;

/** What each role is called on screen. Arabic only — this reaches the user. */
export const ROLE_LABELS: Record<AppRole, string> = {
  ADMIN: "مدير النظام",
  POS_ECOMMERCE: "كاشير وأونلاين",
  ECOMMERCE_ONLY: "أونلاين فقط",
  ACCOUNTANT: "محاسب ومخازن",
};

/** One line describing the access each role gets, for the invite dropdown. */
export const ROLE_DESCRIPTIONS: Record<AppRole, string> = {
  ADMIN: "صلاحية كاملة على كل الشاشات والإعدادات",
  POS_ECOMMERCE: "نقطة البيع، الطلبات، المتجر الإلكتروني، وقاعدة العملاء",
  ECOMMERCE_ONLY: "الطلبات والمتجر الإلكتروني، والمخزون للعرض فقط",
  ACCOUNTANT: "المشتريات والموردين والمخزون وتقارير الخزنة",
};

/**
 * Path → the roles allowed to open it.
 *
 * `ADMIN` is omitted from every list on purpose: it is granted by
 * `canAccess` before the map is consulted, so a screen added later is closed to
 * the other three by default and open to the admin. Forgetting an entry fails
 * SHUT for staff, which is the direction a mistake should fail in.
 */
const ROUTE_ACCESS: Record<string, readonly AppRole[]> = {
  // ── Open to everyone ──────────────────────────────────────────────────────
  // Appearance is a preference, not a permission. Every role lands here able to
  // set light/dark; nothing that changes the business belongs on this path.
  "/preferences": ["POS_ECOMMERCE", "ECOMMERCE_ONLY", "ACCOUNTANT"],

  // ── Selling ───────────────────────────────────────────────────────────────
  "/pos": ["POS_ECOMMERCE"],
  "/orders": ["POS_ECOMMERCE", "ECOMMERCE_ONLY"],
  "/ecommerce-orders": ["POS_ECOMMERCE", "ECOMMERCE_ONLY"],
  "/crm": ["POS_ECOMMERCE"],
  // Returns start at the till more often than anywhere else (Phase 5), so a
  // cashier who cannot open this screen cannot do the job the till exists for.
  "/returns": ["POS_ECOMMERCE", "ECOMMERCE_ONLY"],

  // ── Stock ─────────────────────────────────────────────────────────────────
  // Read-only for ECOMMERCE_ONLY is enforced by RLS, not by hiding the screen —
  // they need to see what is sellable before promising it to a customer.
  "/inventory": ["ECOMMERCE_ONLY", "ACCOUNTANT"],
  "/stock-audit": ["ACCOUNTANT"],

  // ── Buying and money ──────────────────────────────────────────────────────
  "/purchasing": ["ACCOUNTANT"],
  "/partners": ["ACCOUNTANT"],

  // ── ADMIN only (absent from every list) ───────────────────────────────────
  // "/", "/products", "/wholesale", "/settings", "/branches", "/users",
  // "/backups", "/integrations", "/courier-ledger", "/bundles", "/discounts"
};

/**
 * Where each role lands, and where it is sent when it reaches a closed door.
 *
 * Never a screen the role cannot open — a redirect loop is worse than a denial.
 */
const ROLE_HOME: Record<AppRole, string> = {
  ADMIN: "/",
  POS_ECOMMERCE: "/pos",
  ECOMMERCE_ONLY: "/orders",
  ACCOUNTANT: "/purchasing",
};

/** Legacy role strings → the fixed four. */
const LEGACY_ROLE_MAP: Record<string, AppRole> = {
  // The old `UserRole` set.
  owner: "ADMIN",
  cashier: "POS_ECOMMERCE",
  cashier_data_entry: "POS_ECOMMERCE",
  data_entry: "ECOMMERCE_ONLY",
  // The old `StaffRole` set the users screen wrote.
  OWNER: "ADMIN",
  MANAGER: "ADMIN",
  CASHIER: "POS_ECOMMERCE",
  VIEWER: "ECOMMERCE_ONLY",
  // The five extended roles that used to exist. `branch_manager` projected onto
  // a FULL owner — `edit:users` and all — so anyone holding it could grant
  // themselves anything. It lands on the narrowest role that still does its job.
  branch_manager: "ACCOUNTANT",
  inventory_clerk: "ACCOUNTANT",
  accountant: "ACCOUNTANT",
  customer_support: "ECOMMERCE_ONLY",
  viewer: "ECOMMERCE_ONLY",
};

/**
 * Any stored role string → one of the fixed four.
 *
 * Unknown values land on `ECOMMERCE_ONLY`, the least privileged role, rather
 * than throwing or defaulting to admin. A row with a typo in it must not open
 * the safe.
 */
export function toAppRole(role: string | null | undefined): AppRole {
  if (!role) return "ECOMMERCE_ONLY";
  if ((APP_ROLES as readonly string[]).includes(role)) return role as AppRole;
  return LEGACY_ROLE_MAP[role] ?? "ECOMMERCE_ONLY";
}

/** Is this role allowed to open this path? */
export function canAccess(role: string | null | undefined, path: string): boolean {
  const app = toAppRole(role);
  if (app === "ADMIN") return true;

  // Match the top-level segment so `/orders/123` resolves like `/orders`.
  const segment = "/" + (path.split("?")[0].split("/")[1] ?? "");
  const allowed = ROUTE_ACCESS[segment === "/" ? "/" : segment];
  return allowed ? allowed.includes(app) : false;
}

/** The screen this role should land on, and be redirected to when blocked. */
export function homeFor(role: string | null | undefined): string {
  return ROLE_HOME[toAppRole(role)];
}
