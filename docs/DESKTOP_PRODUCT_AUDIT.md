# DESKTOP PRODUCT COMPLETION AUDIT

Audit date: **2026-09-21**
Baseline commit: **97c515c**
Live project audited: `oczgqpxeixlrufvevitz` (nexuscore), read-only
Deployment audited: Vercel team `nexuscore1`, project `nexuscore-web1`

This is an **audit only**. No source file was changed, no migration was
created, no RLS policy was touched, no production row was modified, and no
Mobile code was opened except to prove a shared-code fact.

Everything below is either a file/line, an RPC body, a policy definition, a
SQL result, or a command output produced during this pass. Where something
could not be exercised it says so rather than guessing.

---

## A. Product scope

NEXUS CORE Desktop/Web is an **online-only**, single-tenant-per-store,
Arabic/RTL business management SPA.

* **Vite + React 19 + `react-router-dom`.** Not Next.js, no server runtime.
  (`src/App.tsx` mounts `<BrowserRouter>`; `vercel.json` sets
  `"framework": "vite"` and one SPA rewrite.)
* **Supabase is the entire backend.** PostgREST + Auth over HTTPS. 25 tables
  in `public`, RLS enabled on all 25, 29 functions of which 20 are
  `SECURITY DEFINER`.
* **Money and stock are event-sourced** in `ledger_events` / `ledger_lines`,
  append-only at the database (`no_update_*` / `no_delete_*` policies are
  `USING (false)`).
* **Offline-First is OUT OF SCOPE** and must not appear in any backlog item
  below. The PWA precaches the shell only; every read and write needs the
  network, and writes throw rather than queue.

### What this audit deliberately does not claim

Desktop is **not** complete. §D–§F below are the real backlog.

---

## B. Route / page inventory

**33 route entries** over **25 distinct screen components**, from
`src/App.tsx` (the only router that runs — see §H.7 on `routeTree.gen.ts`).

`docs/ARCHITECTURE.md` says 32; it omits `/set-password`. Corrected here.

### B.1 Guard chain, outermost first

```
ProtectedRoute        useAuthStore.isAuthenticated  (localStorage boolean)
  ├── SystemOwnerGate      /system-admin/* only; asks the server
  └── LicenseGate          store licence currently usable
        └── RequireAccess  lib/roles.ts canAccess(role, path)
              └── Layout → screen
```

### B.2 Public / pre-app (2)

| # | Route | Component | State |
|---|---|---|---|
| 1 | `/login` | `src/pages/Login.tsx` | ✅ |
| 2 | `/set-password` | `src/pages/SetPassword.tsx` | ✅ (outside `ProtectedRoute` on purpose) |

### B.3 Session-only, outside `LicenseGate` (2)

| # | Route | Component | State |
|---|---|---|---|
| 3 | `/license-expired` | `src/pages/LicenseExpired.tsx` | ✅ |
| 4 | `/system-admin/licenses` | `src/routes/system-admin-licenses.tsx` | 🟡 owner happy-path never pressed |

### B.4 Gated business screens (21)

| # | Route | Component | In sidebar | Roles (beyond ADMIN) |
|---|---|---|---|---|
| 5 | `/` | `ExecutiveDashboard` | ✅ | — |
| 6 | `/preferences` | `routes/preferences.tsx` | ✅ | POS, ECOM, ACCT, MOD |
| 7 | `/products` | `ProductsPage` | ✅ | — |
| 8 | `/pos` | `CheckoutForm` | ✅ | POS |
| 9 | `/inventory` | `InventoryTable` | ✅ | ECOM, ACCT |
| 10 | `/stock-audit` | `StockAuditPage` | ✅ | ACCT |
| 11 | `/purchasing` | `PurchasingPage` | ✅ | ACCT |
| 12 | `/wholesale` | `WholesalePage` | ✅ | — |
| 13 | `/partners` | `PartnersFinancePage` + `CapitalEquityPage` | ✅ | ACCT |
| 14 | `/ecommerce-orders` | `routes/ecommerce-orders.tsx` (order **creation**) | ✅ | POS, ECOM |
| 15 | `/orders` | `OrdersPage` (order **lifecycle**) | ✅ | POS, ECOM |
| 16 | `/courier-ledger` | `CourierLedgerPage` | ✅ | — |
| 17 | `/bundles` | `BundlesPage` | ✅ | — |
| 18 | `/discounts` | `DiscountsPage` | ✅ | — |
| 19 | `/crm` | `CRMPage` | ✅ | POS |
| 20 | `/returns` | `routes/returns.tsx` | ✅ *(flag now defaults on — P0 Wave 1)* | POS, ECOM |
| 21 | `/integrations` | `IntegrationsSettingsPanel` | ✅ *(flag now defaults on — P0 Wave 1)* | — |
| 22 | `/settings` | `routes/settings.tsx` (5 tabs) | ✅ | — |
| 23 | `/branches` | `routes/branches.tsx` | ❌ URL-only duplicate of Settings→Branches | — |
| 24 | `/users` | `UserManagementPanel` | ❌ URL-only duplicate of Settings→Roles | — |
| 25 | `/backups` | `routes/backups.tsx` | ❌ URL-only duplicate of Settings→Backups | — |

### B.5 Placeholders — all 8 unreachable (8)

`credit-invoices`, `credit-limits`, `reps-activity`, `b2b-sales`,
`contracts`, `production-lines`, `raw-materials`, `waste-cost`.

All render `PlaceholderPage` ("هذه الوحدة قيد التطوير"). **Nothing links to
them.** They exist for `activeBusinessProfile` values other than
`"omnichannel"`, and `setBusinessProfile` has **zero call sites**
(`src/store/useAuthStore.ts:150`), so no other profile can ever be selected.
See §C-44.

### B.6 Nested surfaces

| Surface | Count | Notes |
|---|---|---|
| Sidebar nav items | 17 defined | 2 hidden by default (§B.4 rows 20, 21) |
| Settings tabs | 5 | general, shipping, branches, roles, backups |
| Other tab groups | 6 screens, 13 triggers | returns 2, orders 1, partners 4, integrations 2, purchasing 2, POS 2 |
| Dialog / AlertDialog | 54 | heaviest: purchasing 6, wholesale 6, orders 5, partners 5 |
| Sheet / Drawer | 1 | `MobileNav` responsive drawer |
| Deep links | **1** | `/ecommerce-orders` `useSearchParams` only. See §C-39 |

---

## C. Business capability matrix

Legend: ✅ COMPLETE · 🟡 PARTIAL · ❌ MISSING · 🔴 BROKEN · ⚠️ BUSINESS DECISION

"COMPLETE" means the whole chain held under inspection: UI → validation →
authorization → service/RPC → database → ledger → realtime → persistence →
reload → error handling → cross-screen consistency.

| # | Capability | Status | Evidence |
|---|---|---|---|
| 1 | Authentication (email + password) | ✅ | `lib/auth/sessionWorkflow.ts:221` `signInWithPassword`; leaked-password check at `:299`; min length `:291` |
| 2 | Signup → store provisioning | ✅ | `claim_store(uuid)` SECURITY DEFINER, idempotent, `TRIAL_DAYS := 0` |
| 3 | Session reconciliation (logic) | ✅ | `lib/auth/useSessionReconciliation.ts` — `getSession()`, `onAuthStateChange`, sign-out only |
| 4 | Session reconciliation (Desktop gating) | ✅ *(was 🔴 — fixed in P0 Wave 1)* | `useRealtimeSync` returns the verdict; `App` passes it to `ProtectedRoute`, which holds on `"checking"` and refuses anything else. §P0-4 |
| 5 | Logout ends the Supabase session | ✅ | `Sidebar.tsx` `useSidebarLogout` → `auth.signOut()` after `logout()` |
| 6 | Password change / reset in-app | ❌ | `Login.tsx` change-password UI unreachable (`mustChangePassword` has no setter). Supabase recovery email is the only path — and email does not deliver (§M-6) |
| 7 | System Owner identity | ✅ | `is_system_owner()` reads `auth.users.email` against 2 literals + `email_confirmed_at`; resolved on login **and** every boot |
| 8 | System Owner UI separation | ✅ | `SystemOwnerGate` fails closed on transport error; `LicenseGate` routes owners to `/system-admin/licenses` not `/license-expired` |
| 9 | License management (RPCs) | ✅ | 6 `admin_*` RPCs, all SECURITY DEFINER + `is_system_owner()`; refuse service-role SQL |
| 10 | License management (owner UI pressed) | 🟡 | Never exercised by a real owner session — carried over from `KNOWN_LIMITATIONS.md` #9, still open |
| 11 | License enforcement (client) | ✅ | `LicenseGate` holds render until `resolved`; re-checks on `online` |
| 12 | License enforcement (database) | ✅ | `has_role()` = role match **AND** `store_licensed()`. Every write policy routes through it |
| 13 | License expiry blocks **reads** | ⚠️ | It does not. SELECT policies use `is_store_member()`, which has no licence term. An expired shop can still read via the API. Deliberate or not, it is undecided |
| 14 | Plan tiers (BASIC/PRO) gate features | ❌ | Two disconnected sources: `store_licenses.plan_type` (real, unused by UI) and `useSubscriptionStore.isProPlan` (localStorage-only, never fetched). §H-3 |
| 15 | Staff invitation | 🟡 | `invite-staff` is the only deployed Edge Function and works; **the email never arrives** (§M-6) |
| 16 | Staff management UI | 🟡 | `UserManagementPanel` lists/invites/removes. No name column exists (`store_members` has none) |
| 17 | Role permissions — UI | ✅ | One map, `lib/roles.ts` `ROUTE_ACCESS`; Sidebar and `RequireAccess` call the same `canAccess` |
| 18 | Role permissions — database | ✅ | 45 policies; every write gate is `has_role(store_id, …)` |
| 19 | Role propagation without reload | 🟡 | `useAuthStore.userRole` set at boot only. Menu is stale for one page load; DB refuses regardless |
| 20 | Dashboard | 🟡 | `ExecutiveDashboard` renders real ledger sums, but its upgrade prompt reads the dead `isProPlan` (§C-14) |
| 21 | Global header — identity | ✅ *(was 🔴 — fixed in P0 Wave 1)* | `layout/SessionIdentity.tsx`; real username, `ROLE_LABELS` role, System Owner badge alongside the store role. The three dead controls were deleted. Global search and notifications remain ❌ — see §C-57, §C-67 |
| 22 | POS sale | ✅ | `CheckoutForm` → `appendEvent({kind:"sale"})`; stock/wallet/revenue/cogs lines; submit-gated |
| 23 | POS return | ✅ | `POSReturnModal` + `lib/posReturn.ts` |
| 24 | Order creation (e-commerce) | ✅ | `routes/ecommerce-orders.tsx` → `order_placed`; shipping rate, discount claim, deposit |
| 25 | Order lifecycle | ✅ | `lib/orderLifecycle.ts` state table + synchronous `inFlight` claim; DB CHECK mirrors the 5 statuses |
| 26 | Order details | ✅ | Inside `OrdersPage` dialogs |
| 27 | Order numbering | 🔴 | `useOrderStore.ts:170` — `ECO-${Date.now()}`. Not from `next_document_number`, and **no unique index on `orders."orderNumber"`**. Every other document type is server-allocated and uniquely indexed |
| 28 | Returns & exchange | ✅ | `routes/returns.tsx`, `lib/exchange.ts`; `order_returned_pending` → `return_confirmed` split is correct and asserted |
| 29 | Return / POS-sale document numbers | ❌ | Neither has a number. Only `FM-` (purchase), `FJ-` (wholesale), `SP-` (supplier payment) are allocated |
| 30 | Purchasing / supplier invoices | ✅ | `PurchasingPage` + `lib/receiving/commitReceipt.ts`; `FM-` from `next_document_number` |
| 31 | Receiving → stock | ✅ | `commitReceipt` appends `purchase` with stock + payable_supplier lines |
| 32 | Supplier payment | ✅ | `lib/supplierPaymentCommand.ts`, `SP-` numbered |
| 33 | Inventory view | ✅ | `InventoryTable` reads `useStock` (ledger SUM) |
| 34 | Stock adjustments / جرد | ✅ | `StockAuditPage` → `stock_adjustment` |
| 35 | Shortages | ✅ | `lib/shortages.ts`, `ShortagesReport` |
| 36 | Stock authority | 🟡 | Ledger is authority, `products.quantity` is a mirror — but the mirror **is provably stale** and is read on a live fallback path. §H-1 |
| 37 | Shipments / courier assignment | ✅ | `CourierSelect`, `lib/courierBatch.ts`, `shipping_rates` per governorate |
| 38 | Shipping provider API | ❌ | Not implemented. `handle-shipping-webhook` exists in `supabase/functions/` and is **not deployed**. Out of scope this phase per brief |
| 39 | Customers / CRM | ✅ | `CRMPage`; `CustomerPhoneMatch` dedupe is **client-side only** — no unique index on `(store_id, phone)` |
| 40 | Suppliers | ✅ | Inside `PurchasingPage` |
| 41 | Couriers | ✅ | `couriers` table, ADMIN-only writes, unique name per store |
| 42 | Courier settlements | ✅ | `CourierLedgerPage` → `courier_settlement`; `CourierSettlementReport` print view |
| 43 | Discounts | ✅ | `DiscountsPage`; usage counters are **trigger-protected** — direct UPDATE of `usedCount`/`totalDiscount` is silently reverted unless inside the 3 RPCs |
| 44 | Bundles | ✅ | `BundlesPage`; `expandBundleMoves` + `bundleAvailableStock` |
| 45 | Wholesale | ✅ | `WholesalePage`; `FJ-` numbered; `canSellWholesale` mirrors the live policy |
| 46 | Wholesale returns | ✅ | `WholesaleReturnPanel`, `WholesaleInvoiceReturnPicker` |
| 47 | Expenses | ✅ | `PartnersFinancePage` → `expense`; DB CHECK on 10 categories |
| 48 | Payroll / owner draw / wallet transfer | 🟡 | Code and policies exist; `wallet_transfer` and `owner_draw` have **never been written in production** |
| 49 | Ledger (append) | ✅ | `ledger_append(jsonb)` SECURITY **INVOKER** — atomic, authorised by the caller's policies |
| 50 | Ledger browser / event viewer | ❌ | `ledger_events_page` RPC exists; **no Desktop consumer**. There is no screen that shows raw events |
| 51 | Wallets | ✅ | `canonical_wallet_subject`, `WALLET_LABELS` |
| 52 | Owner financials | 🟡 | **Two implementations**: Desktop recomputes in TS (`lib/ledger/reports.ts fetchPnl`), Mobile calls SQL `owner_financial_summary`. Nothing asserts they agree — the test that would is skipped. §H-2 |
| 53 | Owner budget | 🟡 | `OwnerBudgetCard` writes `owner_budget` lines; **zero such lines exist in either store** |
| 54 | Financial reports | ✅ | `FinancialReportsPage` — P&L by period/granularity, print to PDF |
| 55 | Capital & equity | ✅ | `CapitalEquityPage` |
| 56 | Per-screen search | ✅ | Products, inventory, orders, CRM, wholesale, purchasing all have local search |
| 57 | Global search | 🔴 | Header input is decorative (§C-21) |
| 58 | Filters | ✅ | Status/date/courier filters on orders, returns, courier ledger |
| 59 | Pagination | 🟡 | `ui/pagination.tsx` exists; screens render full lists. `pageAll()` removes the 1000-row PostgREST cap on **reads**, so a large tenant renders every row at once |
| 60 | Realtime | 🟡 | 5 of 16 published tables subscribed. §J |
| 61 | Export (Excel) | 🟡 | Import **template** download only. No data export to xlsx |
| 62 | Export (CSV) | ❌ | The only CSV export lives in `ProfitDashboard`, which has **0 importers** |
| 63 | Print / PDF | 🟡 | No PDF library. `lib/pdfGenerator.ts` builds HTML then `window.print()` or downloads a `.html`. §K |
| 64 | Settings (store profile) | ✅ | `GeneralSettingsPanel`; `pullSettings` now wired into hydration |
| 65 | Branches | ⚠️ | CRUD works; **no policy, filter or permission references a branch**. It is a directory, not a boundary |
| 66 | Backups | 🟡 | Settings-only JSON bundle with SHA-256. **No business-data backup or restore exists**; restore has never been executed |
| 67 | Notifications | ❌ | No store, no table, no delivery. One decorative bell |
| 68 | Feature toggles | 🟡 *(was 🔴 — P0 half fixed in Wave 1)* | The two module flags now default `true` and existing browsers are migrated, so no fresh device hides a finished screen. Still per-browser `localStorage` and not store-level — that is G-12. `depositMandatory` and `salesCommissionsEnabled` still have **no consumers at all** |
| 69 | Error handling (writes) | ✅ | `writeThrough` rethrows; `appendEvent` throws; `<Toaster/>` mounted |
| 70 | Error handling (boot reads) | 🟡 | One toast on partial hydration failure. No retry affordance except the sidebar refresh |
| 71 | Loading states | 🔴 | **No global loading gate.** 14 tables hydrate into empty Zustand stores; every screen renders its *empty state* during boot and after a failed read. `useSyncStatus` has exactly one consumer (Sidebar). §L-1 |
| 72 | Empty states | ✅ | `ui/empty-state.tsx` + Arabic copy throughout — but indistinguishable from loading and from failure (§C-71) |
| 73 | Retry | ❌ | 3 occurrences across 98 components |
| 74 | Validation | ✅ | Zod + react-hook-form on forms; `assertFiniteLines` before any ledger write |
| 75 | Duplicate-submit gating | ✅ | `useSubmitGate` / `useRunOnce`; enforced by test over every `async` handler that calls `appendEvent` |
| 76 | RTL / Arabic | ✅ | `dir="rtl"` document-level, logical CSS properties, Arabic copy |
| 77 | Responsive | 🟡 | `MobileNav` drawer exists; verified only by manual browser driving in a previous pass, not in CI |
| 78 | Keyboard / a11y | 🟡 | `check_control_names.mjs` asserts accessible names; no focus-order or trap coverage |
| 79 | PWA | ✅ | 21 precached shell entries, no data caching, no write queue |
| 80 | Deep links | 🟡 | Only `/ecommerce-orders?…`. No `/orders/:id`, `/products/:id`, `/crm/:id` — Mobile has all three |
| 81 | Session expiry UX | 🟡 | Sign-out happens; no message, no return-to-where-you-were |
| 82 | License expiry UX | ✅ | `LicenseExpired` page with owner-aware routing |
| 83 | Tenant isolation | ✅ | Proven: 0 orphan `store_id` values across orders/products/suppliers/couriers |
| 84 | Type safety | 🔴 | `src/types/index.ts` exports **66 domain types aliased to `any`** — `EcommerceOrder`, `EcommerceOrderStatus`, `LedgerEvent`, `Partner`, `Product`-adjacent types. `tsc --noEmit` passing proves much less than it appears to. Known debt, documented in the file header |

### C.1 Transparent completion count

Rows 1–84 above, one status each:

Counted twice: as the audit found it (2026-09-21, commit `97c515c`) and after
P0 Wave 1 landed the same day.

| Status | At audit | After P0 Wave 1 |
|---|---|---|
| ✅ COMPLETE | 45 (53.6 %) | **48 (57.1 %)** |
| 🟡 PARTIAL | 22 (26.2 %) | **20 (23.8 %)** |
| ❌ MISSING | 9 (10.7 %) | 9 (10.7 %) |
| 🔴 BROKEN | 7 (8.3 %) | **4 (4.8 %)** |
| ⚠️ BUSINESS DECISION | 3 (3.6 %) | 3 (3.6 %) |
| **Total** | **84** | **84** |

Rows 4, 20 and 21 moved 🔴 → ✅; row 68 moved 🔴 → 🟡. A capability-weighted
completion figure is therefore **57.1 % complete / 81.0 % complete-or-partial**.
It is quoted only because it is reproducible from the table above; it is not a
schedule estimate.

The four remaining 🔴 are rows **27** (order numbering), **57** (global
search), **71** (loading states) and **84** (type safety). All four are P1.
None blocks shipping.

---

## D. P0 blockers

Nothing here loses money or corrupts the ledger. These block *shipping to a
customer*.

> **Status after P0 Wave 1 (2026-09-21).** All four are **FIXED**. Each entry
> below keeps the original finding and closes with what changed and how it was
> proven. One caveat is recorded under P0-2: the two logged-in runtime scenarios
> could not be executed, because this audit holds no NexusCore credentials and
> does not create accounts.
>
> | Blocker | Status | Runtime proof |
> |---|---|---|
> | P0-1 public production access | ✅ FIXED | anonymous fetch + rendered login screen |
> | P0-2 dynamic identity | ✅ FIXED (2 scenarios ⚠️ credential-blocked) | fictional persona absent from `dist/` |
> | P0-3 Returns / Integrations visibility | ✅ FIXED | pre-fix `localStorage` blob migrated live |
> | P0-4 session reconciliation authority | ✅ FIXED | forged auth flag refused in a real browser |

### P0-1 — The production Desktop URL is behind a Vercel login

`nexuscore-web1` has `ssoProtection: { enabled: true, deploymentType:
"all_except_custom_domains" }` and **no custom domain** — only
`nexuscore-web1.vercel.app` and two git aliases. Every visitor is asked for a
Vercel team login before the app loads. `DEPLOYMENT.md` flags this for Mobile
and does not say it applies to Desktop.

Fix: attach a custom domain, or relax `ssoProtection`. Nothing in the codebase
changes.

**✅ FIXED — 2026-09-21.** `ssoProtection` set to `null` on `nexuscore-web1`
through the Vercel API; the project now reports
`ssoProtection: { enabled: false }`. No repository change, and **application
authentication was not touched** — Supabase Auth + RLS remains the only
boundary, and removing the Vercel gate exposes the login screen, not the data.

Proven anonymously, with no cookie jar and no Vercel session:

```
GET https://nexuscore-web1.vercel.app/       → 200, <title>NexusCore …</title>
GET https://nexuscore-web1.vercel.app/login  → 200 (SPA rewrite intact)
no _vercel_sso cookie · no redirect to vercel.com · no "Authentication Required"
```

and rendered in a browser: the URL resolves to `/login` and paints NexusCore's
own «تسجيل الدخول» screen.

Regression cover: `scripts/check_desktop_p0.mjs`, opt-in because it reaches the
public internet —
`NEXUS_PUBLIC_URL=https://nexuscore-web1.vercel.app npm run test:units`.

**A custom domain is still wanted** and is tracked as §F-13, not as a blocker:
the team default re-applies `ssoProtection` to new projects, so a `*.vercel.app`
origin depends on a project setting staying flipped. That is a hardening step
for an access path that now works, not a reason the P0 is open.

### P0-2 — The header misreports who is signed in

`src/components/dashboard/Header.tsx:64-67` renders `"سارة المصري"` and
`"مدير النظام"` as literals. A cashier, an accountant and a moderator all see
an admin's name and role on every screen. On a shared till that is not a
cosmetic bug — it is the app telling the operator they hold permissions they
do not.

**Correction to this finding (2026-09-21).** The severity above was overstated
and the audit should have caught it. `dashboard/Header.tsx` has exactly one
importer, `src/routes/index.tsx`, which is a **TanStack file-route** reachable
only through `routeTree.gen.ts` → `src/router.tsx`. `src/main.tsx` renders
`App` (react-router). **That header never rendered in the shipped product.**

The real defect is adjacent and was missed: the shipped shell,
`layout/Layout.tsx`, showed **no identity at all**. There was no way for an
operator to see who was signed in or in what role — so on a shared machine
nobody could notice they were working inside someone else's session. The
fictional persona was one route change away from shipping; the absent identity
was already shipping.

**✅ FIXED — 2026-09-21.** One shared component,
`src/components/layout/SessionIdentity.tsx`, used by both headers — two copies
is how the fiction survived in the one nobody looked at.

| Shown | Source | Server-authoritative because |
|---|---|---|
| name | `useAuthStore.username` | overwritten each boot from `auth.getSession()` |
| role | `ROLE_LABELS[toAppRole(userRole)]` | overwritten each boot from `store_members.role` (P0-4) |
| owner badge | `useAuthStore.isSystemOwner` | never persisted; re-asked via `is_system_owner()` each boot |

The System Owner badge renders **alongside** the store role, never instead of
it: an owner who also administers their own shop is both, and collapsing them
would hide which one a screen is answering to.

The email is the name deliberately — `store_members` has no name column and
`list_store_members` returns none, so inventing a profile table to hold a
prettier string would be a new feature with a new source of truth.

Three dead controls beside it were deleted rather than wired up: a search input
with no handler, a bell with an unconditional unread dot, and a قطاعي/جملة
toggle backed by `useState` nothing read. Global search and notifications are
features (§C-57, §C-67), not omissions to patch into a header.

**Runtime proof.** `سارة المصري` is present in `git show HEAD:…/Header.tsx`
and **absent from the built `dist/` bundle** (0 occurrences). All five
`ROLE_LABELS` plus the new `مالك النظام` badge ship.

**⚠️ Two scenarios could not be executed.** "a real authenticated user sees
their own name and role" and "changing user does not retain prior identity"
both need a working NexusCore login. This audit holds none — `pwd.txt` contains
`owner`, the string from the local-auth backdoor that was removed for security,
not a Supabase credential — and creating accounts is outside what this pass
will do. The wiring, the label source, the owner/ADMIN separation and the
absence of the literals are covered by `check_desktop_p0.mjs` and were
mutation-tested; the rendered result for a signed-in operator is **asserted,
not observed**, and should be confirmed by someone holding a QA account.

**Note on one label.** The P0 brief lists MODERATOR as «مراجع»; `ROLE_LABELS`
says «مشرف متابعة», and the other four labels in the brief match that map
verbatim. The canonical map was used, because a second spelling here would
drift from the invite dropdown and the sidebar — which is the exact class of
bug `lib/roles.ts` exists to prevent. If «مراجع» is the intended wording it
should change in `ROLE_LABELS`, once, for all three surfaces.

### P0-3 — Returns and Integrations are invisible on every fresh browser

`useFeatureStore` defaults `returnsEnabled: false` and
`ecommerceSyncEnabled: false`, persists to `localStorage` only, and
`Sidebar.tsx:194` filters the nav on those flags. A shop that installs on a
new machine has no "المرتجعات والاستبدال" link and no
"ربط المتجر الإلكتروني" link until someone finds Settings and toggles them —
per device, forever.

**✅ FIXED — 2026-09-21.** Both module flags default to `true`, and
`feature-storage` gained `version: 1` with a `migrate` that forces the two
module flags on once. A new default alone would have fixed nothing: `persist`
rehydrates **over** the initializer, so every browser that had ever opened the
app still held the old `false` and would have kept both modules hidden forever.

The two values are forced rather than merged because the old `false` carries no
information — it is what the store wrote on first run, so "the admin switched
this off" and "nobody ever touched this" are the same byte. Between restoring a
hidden module and honouring a choice that may never have been made, restoring
wins: a visible module a shop ignores costs nothing, an invisible one costs
them the feature.

**The flags were not deleted.** They are a real product preference and both
toggles remain in الإعدادات → عام. What changed is the default and the
migration, not the concept — and `version: 1` means a deliberate switch-off
*after* this ships is preserved like any other setting.

**Visibility and authorization stay separate.** `Sidebar.useNavItems` still
ANDs `canAccess(userRole, item.path)` before the flag, and `RequireAccess`
still asks the same function, so a flag can hide a link and never open one.
MODERATOR gained nothing: it is absent from `"/returns"` in `ROUTE_ACCESS`,
`/integrations` is ADMIN-only by omission, and MODERATOR appears in no
`has_role` array in any policy. `lib/roles.ts` and `RequireAccess` read no
storage at all, so clearing `localStorage` cannot change what a role may open.

**Runtime proof**, in a real browser:

| Seeded `feature-storage` | After reload |
|---|---|
| `version 0`, both module flags `false` (the pre-fix blob) | `version 1`, `returnsEnabled: true`, `ecommerceSyncEnabled: true` — other three untouched |
| `version 1`, `returnsEnabled: false` (a deliberate choice) | still `false` — preserved, not re-forced |

### P0-4 — Desktop renders business screens before the session is confirmed

`ProtectedRoute` gates on a `localStorage` boolean. `useRealtimeSync.ts:134`
calls `useSessionReconciliation()` and throws away the result, so nothing
blocks on the real answer. A stale flag paints a full working app whose every
read 401s, until the async reconcile lands. Mobile solved this with
`MobileSessionGate`; Desktop did not adopt it.

**✅ FIXED — 2026-09-21.** Four changes, one fact:

1. **`useRealtimeSync` returns the verdict** instead of discarding it, and
   `App` hands it to `<ProtectedRoute sessionState={…} />`. The hook asks; it
   does not decide.
2. **`ProtectedRoute` gates on it.** `"checking"` holds the UI behind
   «جارٍ التحقق من الجلسة…» — rendering the app "just for that moment" hands
   someone a working-looking till for the moment, and flashing `/login` at a
   valid user is its own kind of wrong. Anything but `"authenticated"`, and
   anything with `isAuthenticated` false, redirects.
3. **The membership is re-read on every boot.** The `store_members` lookup used
   to sit behind `if (!isAuthenticated)`, so it ran only when the local flag had
   been *lost* — an ordinary reload kept the persisted `userRole` verbatim. That
   is how a demoted user kept an ADMIN sidebar, and it is what `KNOWN_LIMITATIONS.md`
   #17 described. `setSession` now writes `username`, `userRole` and
   `isAuthenticated` from the server's answer on every boot, so a stale or
   hand-edited role survives until the next render and no longer.
4. **A revoked membership ends the session** — but only on a *definite* answer.
   `maybeSingle()` reports "no row" as `{data: null, error: null}` and a
   transport failure as `{data: null, error: {…}}`. Treating those alike would
   sign a user out over flaky wifi and throw away their work; Postgres refuses
   every read and write from a revoked member regardless, so holding the UI open
   through an inconclusive answer exposes nothing. The System Owner is exempt —
   they hold no membership by design, and signing them out here would lock the
   one account that can issue licences out of the app on every reload.

**Realtime is now a consumer, not an authority.** Boot hydration and the
`global-sync` channel both wait for `"authenticated"`. This closes a second,
separate bug found while fixing the first: Realtime applies RLS using the token
the socket **joined** with, so a channel opened before the session was restored
joined as `anon` and then silently delivered nothing for the rest of its life —
no error, no reconnect. Mobile already gated `useMobileRealtime` for exactly
this reason. The hook issues no redirect, sets no role and grants nothing.

Order is unchanged and still asserted: signed in → licensed → authorized.
`/license-expired` and `/system-admin/licenses` stay outside `LicenseGate`.

**Runtime proof**, in a real browser against the live project. The profile
happened to hold a genuine stale session — `isAuthenticated: true`,
`userRole: "ADMIN"`, `qa-sync-a1@nexuscore.test`, JWT expired the previous day:

| Step | Result |
|---|---|
| cold load of `/` | held on «جارٍ التحقق من الجلسة…» |
| reconciliation resolved | → `/login`, `isAuthenticated: false`, session cleared, `username: ""` |
| forged `isAuthenticated: true` + `userRole: ADMIN` + `isSystemOwner: true`, then opened `/products` | → `/login`; flag reset to `false`; `isSystemOwner` was never persisted at all |
| unauthenticated boot, network log | **zero** requests to `supabase.co` for tenant tables, and no `[Hydrate]` line — the 14 boot reads no longer fire before the session exists |

Console on that boot carried only the expected
`[Auth] local session flag with no Supabase session — signing out` and one 400
from the dead refresh token. No new errors.

### P0-5 — Committed code called a store method that was never committed — **FIXED** (2026-09-26)

**Found by isolation testing** at the end of P1 Wave 2: a clean worktree of
`207160d` did not typecheck. Every earlier suite/tsc figure had been measured
on the working tree, which carried the missing code uncommitted.

**Root cause.** `dccf949` ("finalize desktop core updates", 2026-09-16)
committed three call sites — `WholesalePage`, `CheckoutForm` (POS), and
`OrdersPage` — that credit the source invoice with
`useBusinessStore.getState().recordWholesaleReturn(...)`. The store method
itself stayed in the uncommitted diff of `useBusinessStore.ts`. So on committed
`main` the call was `undefined(...)`.

**Why it was a financial bug and not a typing one.** Each call ran **after**
`commitWholesaleReturn` had appended the `return_confirmed` event. The sequence
on `main` was: return records written → ledger event appended → TypeError →
the screen's catch said «لم يُسجَّل المرتجع ولم يتغيّر أي رصيد». The money and
stock had moved, the invoice «متبقي» had not, and the operator was told the
opposite. Even with the method present, the call was `.catch(() => {})`, so a
refused invoice write was silent.

**Fix.** The invoice credit moved **inside** the canonical command and
**before** the ledger event, so the event is the last step and nothing that
can fail runs after an append-only write:

1. return records (the returnable ceiling)
2. each source invoice's open balance credited
3. the ledger event

The order and the undo live in `lib/wholesaleReturnTxn.ts` (import-free,
driven by tests). A refusal at step 2 or 3 restores every credited invoice to
the **exact** balance it held — not by adding the credit back, which a clamp
at 0 makes wrong — deletes the records, and rethrows the original error, which
makes the screens' existing «لم يُسجَّل المرتجع ولم يتغيّر أي رصيد» true. If
the undo itself fails, `WholesaleReturnUndoError` names what was left behind.
The store method throws on a missing invoice instead of returning quietly. No
screen calls it any more; the three post-ledger loops are gone.

On `/orders` the order's own status is still written after the return (the
app-wide document-follows-ledger pattern). If that write fails, the operator
is now told the return **was** recorded, instead of «لم يتغيّر أي رصيد».

**Role matrix — a business question this surfaced (§G-14).** A trader return
writes three things, and live RLS lets only ADMIN write all three:

| Write | Allowed |
|---|---|
| `return_records` | ADMIN, POS_ECOMMERCE, ECOMMERCE_ONLY |
| `wholesale_invoices` | ADMIN, ACCOUNTANT |
| `ledger_events` (`return_confirmed`) | ADMIN, POS_ECOMMERCE, ECOMMERCE_ONLY, ACCOUNTANT |

POS_ECOMMERCE and ECOMMERCE_ONLY can open a trader return on `/orders`.
Before, theirs half-posted (records + ledger, invoice refused and swallowed).
Now it is refused at the credit and rolled back completely — proven live:
their upsert is refused with 42501. No Supabase change was made.

**Runtime (live, self-aborting):** ADMIN credits an own-store invoice (1 row);
ADMIN crediting **another tenant's** invoice touches 0 rows and leaves it at
500; POS_ECOMMERCE's upsert is refused 42501. Nothing persisted.

---

## E. P1 required work

### P1-1 / P1-D — Loading, empty and error were one state — **FIXED**

**Was.** Two readers answered "nothing" in situations that were not nothing.
The hydrated stores start empty, so `rows.length === 0` meant *no data*, *not
arrived yet* and *the read failed* at once, and every list said «لا توجد …»
for all three. `useBalances` answers `total = 0` / `amountOf() = 0` before its
read lands **and** after it fails, so every money figure built on it printed
«٠ ج.م» for a read that never happened. `useSyncStatus` existed; only the
Sidebar read it.

**The worse finding — commit paths decided on those zeros.** Found during
this sweep, and the reason this was not a labelling fix:

| Path | What an unread 0 did |
|---|---|
| Supplier return (الشراء) | settled against a debt of 0 → posted as a **cash refund** instead of reducing the payable |
| Trader return — جملة, نقاط البيع, الطلبات (3 paths) | the same, on `receivable_client` — the variant this codebase had already measured for the *stale* case (ORD-QA-WS: +800, panel showing ٠) but not the *failed* one |
| جرد (stock count) | `systemQty = qtyOf() = 0` → a count of 10 booked **+10 phantom surplus** |
| Dividend distribution | a working partner's draws read as 0 → **paid their share twice** |
| Store settings | a failed `pullSettings` left defaults in the form, and `updateSettings` pushes on every keystroke → one letter sent «محلي» and blanks **over the real store name, phone and tax number** |
| Courier statement / capital PDF / client list PDF | printed signed-looking documents full of zeros |
| الشركاء | a failed wallet read prompted "record your opening balances" → a **second** opening entry |

Every one of these now refuses (with a retry) until its read has answered.

**The model.** One rule, one component each, reused on every screen:

| Piece | What it is |
|---|---|
| `lib/figure.ts` | `statusOf(...reads)` → loading / error / ready, **error outranks loading**; `moneyFigure` / `figureOr` render `formatMoney(null)` («— ج.م», the project's own form) on error, «…» while loading, the number only when every read under it succeeded |
| `useSyncStatus.tables` | per-table `loading / ready / failed`, recorded by the hydrate; an absent entry is *loading*, never empty |
| `hydrateTable(table)` | the body of `hydrateAll`'s loop, now the one reader both boot and retry use — same `cloudList`, same sink, empties nothing else, a second call for a table already in flight is a no-op |
| `CollectionGate` | wraps only the **empty branch** of a list: rows present are real rows; no rows → skeleton / `LoadError` / the existing empty message |
| `LoadError` | the dashboard's existing banner, lifted out unchanged, with a retry that refuses a second click while `busy` and within 1 s (a ref, so two same-frame clicks cannot both pass) |
| `useBalances` | now reports a *recovering* read as loading — so `busy` means something — but not a routine refresh, which would blank the till after every sale |

**Coverage of the 21 screens.**

| Screen | Change |
|---|---|
| نظرة عامة | money from the RPC (P1-E); restock count waits for products + ledger; stock-only failure gets its own retry |
| المنتجات | empty gated on `products`; cost column withdrawn on a failed `useStock` |
| المخزون | empty gated; stock value waits for ledger **and** list; `useStock` failure surfaced |
| الجرد | commit refused on an unread ledger; value card; audit log gets loading + retry |
| الشراء | supplier balance, header totals, payment prefill; **return commit guarded**; 3 lists gated |
| الجملة | receivables, «حساب جيد» badge, totals, client export; **return commit guarded**; 4 lists gated |
| الشركاء + رأس المال | per-card status (loading was missing), one retry for all 7 reads, opening-balance prompt; **distribution needs draws**; profit error ≠ spinner; PDF guarded; wallets |
| نقاط البيع | wallet picker balances; **wholesale return guarded** |
| الطلبات أونلاين | customer LTV withheld until read |
| الطلبات | **wholesale return guarded**; list gated |
| حسابات الشحن | every courier figure, per-courier rows, PDF guarded, retry |
| البوكسات · الخصومات · المرتجعات · الفروع | lists gated; the returns log read `getState()` in render and never re-rendered on hydrate — now reactive |
| العملاء | LTV figures + retry; 4 empty states gated |
| الإعدادات | push refused until the pull succeeded; form disabled with a retry; status not persisted |
| المستخدمين | a failed staff read no longer says «مفيش مستخدمين غيرك» |
| التفضيلات · التكاملات · النسخ الاحتياطي | no cloud read — local state only, nothing to conflate |

**Deliberately not gated:** the courier *list* on حسابات الشحن. Its hydrate
sink is part of the separate, uncommitted courier work; gating on a table the
committed hydrate never marks ready would spin forever.

**Runtime proof** (in-app browser, localhost). No QA credentials exist in the
project and none were invented, so the gated screens could not be opened
signed-in. Instead a temporary, uncommitted page mounted the **real**
`CollectionGate`, `LoadError`, `useBalances`, `hydrateTable`, `useSyncStatus`
and `useOwnerFinancialSummary`, with only the network controlled (HTTP 500,
then the live QA-STORE figures) and identity stood in for:

| Phase | List | Revenue | Net profit |
|---|---|---|---|
| failed | `LoadError` + retry — **not** «لسه مفيش منتجات» | `— ج.م` — **not** `٠ ج.م` | withdrawn; banner + retry |
| double-click retry (still failing) | **1** request | **1** request | **1** request |
| retry in flight | skeleton; buttons disabled | `— ج.م` (no stale value) | withdrawn |
| recovered | the rows | `٧٬٥٠٠ ج.م` = SQL 750000 | `١٩٨٫٩٣ ج.م` = SQL 19893 |
| success, 0 rows | «لسه مفيش منتجات» | — | — |

The page also caught a real defect in the (interrupted-attempt) Owner hook:
`void promise.finally(...)` re-rejected into nothing, so every failed read
logged an *Uncaught (in promise)*. Fixed (`promise.then(clear, clear)`) and
re-proven: 2 failed reads, **0** unhandled rejections.

### P1-2 — E-commerce order numbers are a client timestamp — **FIXED**

**Was:** `ECO-${Date.now()}` in two places (`useOrderStore.ts:170` and
`routes/ecommerce-orders.tsx:749`), with no unique index on
`orders."orderNumber"`. A device-clock reading, so a till set a day back issued
numbers that sorted before yesterday's orders, two tills in the same
millisecond produced the same document number, and the database did not object.
`next_document_number` was built precisely for this in migration 016 and orders
were never migrated onto it.

**Now:** both sites draw `nextDocumentNumber("ecommerce_order", "ECO-")`.
Migration `042_order_number_from_counter.sql` adds the unique index
`orders_number_per_store (store_id, "orderNumber")` — the same shape
`wholesale_invoices` and `purchase_invoices` already had — and seeds the
counter. Applied to `oczgqpxeixlrufvevitz`.

**History is not renumbered.** The 22 existing `ECO-<13 digits>` orders keep the
numbers they shipped under. The counter is seeded from canonical numbers only
(`^ECO-[0-9]{1,9}$`, so all six stores start at 0); seeding the way 016 does —
`MAX` of every digit in the column — would have read a millisecond timestamp
and started the sequence at 1.75 trillion, putting the clock straight back into
the numbering, one increment at a time.

**A refused order still burns a number.** Gaps, not duplicates — the same trade
جملة and الشراء already make, and the right one: a gap is a question someone can
answer, a duplicate is a document nobody can trust.

**Runtime proof** — self-aborting `DO` block on the live project, impersonating
a real ADMIN and a real POS_ECOMMERCE through `request.jwt.claims`. Production
counts (321 events / 678 lines / 36 orders / 141 products) verified unchanged
afterwards, with 0 probe rows left behind and every `ecommerce_order` counter
back at 0:

| # | Property | Result |
|---|---|---|
| 1 | Three sequential draws | `ECO-0001` / `ECO-0002` / `ECO-0003` — distinct, monotonic |
| 2 | Shape | matches `^ECO-[0-9]{4,}$` |
| 3 | Per-store | store A advanced by exactly 2, store B unchanged |
| 4 | Legacy collision | `ECO-1789426501524` (17 chars) vs `ECO-0001` (8) — cannot meet |
| 5 | Duplicate within a store | **refused** by the unique index |
| 6 | `POS_ECOMMERCE` may draw | yes (`ECO-0004`) |
| 7 | Non-member may draw | **refused**, SQLSTATE 42501 |
| 8 | Rows of `store_counters` a client can read | **0** — the sequence cannot be rewound from a browser |

**Deliberately not changed:** `CheckoutForm.tsx:886`, `original_order_id:
pos_<Date.now()>`. That is a synthetic foreign key for a walk-in POS return with
no originating order — not a number anybody reads, sorts by, or speaks down a
phone. `check_desktop_p1.mjs` excludes it by pattern and says why.

### P1-3 — `products.quantity` is a stale mirror read on a live path — **FIXED**

**Classification of every live `products.quantity` read.** The codebase is
already disciplined here: mobile never reads it (`mobileReaders.ts:198`),
valuation is ledger-derived (`StockSummaryCards.tsx:10`), and `StockAuditPage`
reads it *deliberately*, as the thing being audited. Exactly two live readers
remained:

| Site | Kind | Verdict |
|---|---|---|
| `lib/stockMirror.ts:153` | the mirror's own writer | legitimate — leave |
| `lib/product.ts:168` (`getActualStock` fallback) | **authoritative path** | the defect |

`getActualStock` prefers the ledger and falls through to the mirror when
`ledgerQty()` returns `null`. The fallback is right in intent — `null` means
"not loaded yet", not zero, and turning it into zero would paint a sold-out
shop on every cold start — and wrong in effect at the three places that
**commit** against stock, which cannot tell a ledger number from a mirror
number.

**Now:** `stockIsAuthoritative()` (`lib/ledger/stockSnapshot.ts`) reports
whether an aggregation has landed. The three commit paths ask first and refuse
rather than validate against a number they cannot vouch for:

| Path | File |
|---|---|
| نقاط البيع cart | `components/sales/CheckoutForm.tsx` |
| فاتورة جملة | `components/wholesale/WholesalePage.tsx` |
| الطلبات أونلاين | `routes/ecommerce-orders.tsx` |

The mirror is **not** deleted — it is what lets 200 products render without 200
aggregations — and the ~48 display callers are untouched, which
`check_desktop_p1.mjs` pins in both directions.

**Measured drift, this pass.** This corrects the earlier reading in this
document, which reported "3 of 7" without separating the tenants:

| Store | Products with ledger stock | Disagree with mirror |
|---|---|---|
| المحل التجاري (production) | 132 | **0** |
| QA-STORE (disposable) | 6 | **3** — QA-UAT-PROBE2 0/14, QA-UAT-WIDGET 24/22, غسول سيرافي 51/50 |

The drift is demonstrated to occur, and has **not** occurred in the production
tenant. This fix closes the path; it does not repair a live number. Nothing was
written to correct the QA drift — the mirror is derived, and `applyStockMoves` /
`hydrateAll` rebuild it.

**Not attempted: a database-level oversell guard.** Backorders are legitimate —
`ecommerce-orders.tsx` skips the stock check for backordered lines and تقرير
النواقص sums the deficit — so a constraint refusing a negative `SUM(qty_delta)`
would refuse real business. The client stays the gate; this change makes the
gate ask an authoritative question.

### P1-4 — Eleven realtime-published tables have no Desktop subscriber — **FIXED**

16 tables are in `supabase_realtime`; 5 were listened to. The other 11 were
published and then ignored — the worst of the two states, because the write is
broadcast to every tab and every tab drops it: no error, no indication, just a
second device quietly showing yesterday's data.

**All 16 classified:**

| Table | Subscribed | Why |
|---|---|---|
| products, orders, transactions, expenses | ✅ was | unchanged — handlers left exactly as they were |
| ledger_events | ✅ was | pulse only; balances are re-read, not merged |
| customers | ✅ **new** | CRM, and the order form writes one per order |
| suppliers | ✅ **new** | الشراء |
| purchase_invoices | ✅ **new** | الشراء |
| return_records | ✅ **new** | المرتجعات |
| discount_codes | ✅ **new** | `claimDiscountUse` moves counts from any till; stale = a code that looks spendable and is not |
| wholesale_clients | ✅ **new** | جملة, till vs office — 016's stated reason for publishing it |
| wholesale_invoices | ✅ **new** | جملة |
| shipping_rates | ✅ **new** | an admin repricing a governorate while a till has the order form open |
| ledger_lines | ❌ | arrives with its event; `ledger_events` already pulses the readers. Subscribing re-fires that once per line of every sale |
| stores | ❌ | licence and identity — `useSessionReconciliation` owns it; a silent merge would be the app deciding on its own that the licence changed |
| branches | ❌ | structural; created once and then left alone |
| couriers | ❌ | not in the publication at all |

**Shape.** Still one channel (`global-sync`), but the listeners are now built by
reducing over `TABLE_HANDLERS` instead of being written out by hand — in source
a handler nobody subscribes to is indistinguishable from a working one, which
is exactly how four listeners stayed the whole of realtime while the
publication grew to sixteen. The eight new handlers come from one factory:
eight hand-copied merges would be eight chances to get Last-Write-Wins subtly
different, which `orders` (camelCase `updatedAt`, parsed as a Date) and
`products` (snake_case `updated_at`, compared as strings) already are.

**The auth gate from `1cb38ce` is preserved**, and pinned by test: the channel
is still opened only under `isCloudSyncMode() && authenticated`, the boot
hydrate still returns early on `!authenticated`, and the hook still returns
`sessionState` to `ProtectedRoute`. Three separate mutations confirm each.

### P1-5 / P1-E — Owner financials from two places — **FIXED** (one authority, one client definition)

**What was actually duplicated.** `owner_financial_summary` is itself built
on `ledger_balances` — the same SQL function Desktop's `balances()` driver
calls. So there was never a second *aggregation*: every SUM has one SQL
authority. What was duplicated was the arithmetic on top. Net profit was
written **four** times — the RPC, `pnl()`, `summarise()`, and الشركاء inline —
plus a fifth copy of `summarise`'s counting logic that the interrupted attempt
had pasted into the dashboard. They agreed, which is what made them
dangerous.

**Classification.**

| Metric | Authority | Desktop reads it as |
|---|---|---|
| revenue · cogs · expenses · returns · sales by channel | `ledger_balances` (SQL) | RPC on نظرة عامة; `balances()` elsewhere — the same function |
| gross profit · net profit | subtraction over the above | RPC on نظرة عامة; **`netProfitOf`** everywhere else — one client definition |
| stock value · wallets · supplier payable · courier receivable/payable · customer receivable | `ledger_balances` lifetime (SQL) | RPC on نظرة عامة; `useBalances` elsewhere |
| net worth · total assets | derived display | `netWorthOf` / `totalAssetsOf` — already one definition |
| order / return counts · top product | `ledger_events` / `ledger_balances` | `windowCounts` — one definition, shared by `summarise` and the dashboard |
| average order value | derived display | RPC revenue ÷ `windowCounts` orders |

**Why Desktop still computes anywhere.** Moving everything onto the RPC was
checked and rejected on the evidence: migration 034 makes the RPC ADMIN-only
*by decision* — "ACCOUNTANT is refused HERE on purpose. It keeps every
financial screen it already has on Desktop … through the unchanged
`useBalances` path". `/partners` is granted to ACCOUNTANT. The reports tab needs
up to 60 buckets per report. So:

* **نظرة عامة** (ADMIN-only — the Owner cockpit on Desktop) consumes the RPC
  and computes **no** money figure. A read failure withdraws the whole grid.
* **Everything else** computes through `netProfitOf`, which is pinned to the
  SQL formula by test, and whose display is pinned to SQL's integer result by
  a 2,001-case sweep (piastres in SQL, EGP floats on the client — no float
  residue reaches the screen).

No SQL was changed; no second SQL function was created.

**Cross-check — SQL authority vs Desktop reads, live.** Impersonating the real
ADMIN of QA-STORE (disposable), `owner_financial_summary` compared against the
exact `ledger_balances` calls Desktop makes, with Desktop's formulas applied:
**13 metrics × 5 windows (lifetime · today · 7d · 30d · this month) = 65
comparisons, 0 mismatches.** Lifetime, in piastres:

| revenue | cogs | gross | expenses | net | returns | stock | wallets | supplier payable | courier recv | courier pay | customer recv |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 750000 | 346964 | 403036 | 383143 | 19893 | 827000 | 1042643 | 646000 | 110000 | 223000 | 109000 | −50000 |

Sales by channel matched subject-for-subject (pos 437000, wholesale 153000,
forfeited_deposit 130000, exchange 90000, ecommerce −60000).

**Not crossable: the production tenant.** المحل التجاري has 0 members
(§M-2), so no one can read it through the ADMIN-gated RPC. That is the
existing M-2 finding, unchanged.

### P1-6 — 66 domain types are `any` — **FIXED for the financial core** (2026-09-26; 45 retained, each with a reason)

**66 → 45.** Every replacement came from the **live schema** (columns,
nullability, CHECK constraints) or an existing canonical type; nothing was
invented to silence TypeScript.

| Replaced (21) | Source of truth |
|---|---|
| `Account` `Balance` `BalanceQuery` `EventKind` `EventQuery` `Identity` `LedgerEvent` `NewEvent` `NewLine` `SyncStatus` | re-exported from `lib/ledger/types` — they had been **re-declared as `any`**, shadowing the real definitions |
| `EcommerceOrderStatus` | `orders_status_check` → the order state machine's table is now proven exhaustive |
| `EcommerceOrder`, `EcommerceOrderItem` (+ `NewEcommerceOrder`, `OrderPaymentMethod`) | `orders` (40 columns); NOT NULL+DEFAULT fields required on a stored order, optional on a new one |
| `WholesaleInvoice`, `WholesaleInvoiceItem`, `WholesaleClient` | `wholesale_*` + the resolver's `WholesaleInvoiceLine` |
| `ReturnRecord` (+ `ReturnedItem`, `ReplacementItem`) | `return_records` + all three writers |
| `PurchaseInvoice` (+ `PurchaseInvoiceItem`), `Supplier` | `purchase_invoices` / `suppliers` + `commitReceipt` |
| `PromoDiscount`, `CustomerProfile` | `discount_codes` / `customers` |

**What the types found** — real defects, all fixed (§P1-8 … P1-11 below) — which
is the argument for the work:

* the Wholesale screen's shipping order wrote its address to `customerAddress`,
  a field the sync whitelist drops;
* that same order could be **sold a second time** on delivery;
* an item added while editing a pending order was priced from `product.price`
  and costed from `product.cost` — neither exists;
* a courier statement reprint matched on `codSettlementId`, which has no column;
* `customers.address` is NOT NULL with no default, and an order without an
  address sent `undefined` into it.

Smaller, also fixed: `client.name` (the column is `companyName`); discount
`createdAt` rendering «Invalid Date» when null; `getInvoiceStatus` and three
helpers declared `undefined` where the column delivers `null` (all already
null-safe in their bodies); a wrongly-intersected `CreateEcommerceOrder.items`.

**Retained (45), deliberately:**

| Category | Types | Why |
|---|---|---|
| Large structural refactor | `Product` | Typing it makes the shared search/filter helpers generic across every product screen — 81 errors, all structural, none a defect. The bug class it would catch (`product.price` / `product.cost`) is pinned by `check_p1_closure.mjs` instead |
| External / integration boundary | `OnlineOrder*`, `Paymob*`, `Shipping*`, `ShipmentMovement`, `IntegrationAdapter` | payloads of features with no live backend |
| Dead code / dead concept | `License*` (F-8), `BusinessProfile` `BusinessPersona` `GatedFeature` (F-5), `SessionRecord` `UserRecord` `PublicSession` (legacy auth), `SyncAction` (removed queue), `Transaction` `EcommerceRevenueLedgerEntry` `StockLog` `StockActionType` `Audit*` (superseded by the ledger) | typing dead code is effort with no reader |
| Local document stores the ledger supersedes for money | `Wallet*`, `Partner*`, `Expense*`, `Payroll`, `FixedAsset`, `BudgetCap`, `Branch*`, `Backup*`, `Customer` | not a money authority; lower value |
| Excluded work | `CourierAccount`, `CourierReceivable` | their store carries uncommitted courier work this phase must not touch |

A test (`the any count only goes down`) pins 45 as a ceiling.

### P1-8 — A wholesale shipment could be sold twice, and lost its address — **FIXED**

شاشة الجملة books the whole sale when it issues an invoice — goods, stock,
COGS, receivable, the customer's shipping charge and the courier cost, in one
`sale` event — and, when the goods need a courier, opens an order in إدارة
الطلبات for the delivery run. That order carried no link to the sale it
belonged to (its `source: "wholesale"` marker is not a column and was
dropped), so إدارة الطلبات treated it as a new sale:

* **retail** delivery refused on the COD check (deposit 0 + COD 0 ≠ goods);
* **wholesale** delivery — the natural next click — appended a **second
  `sale`** and opened a **second invoice** for the same goods: revenue and the
  trader's receivable doubled;
* a return on it ran as a RETAIL return, not against the invoice;
* its delivery address went to `customerAddress`, dropped by the whitelist —
  the courier got an order with no address;
* a failed `addOrder` was announced as «تم إنشاء طلب شحن».

**Fix**, with the link the /orders conversion already uses: the shipment is
written with `address`, `wholesaleClientId`, and `wholesaleInvoiceId` on every
line (line ids equal to the invoice's). `soldOnWholesaleInvoice(order)`
recognises it; delivering it moves the document only. The addOrder result is
checked.

### P1-9 — Items added while editing an order were priced and costed at 0 — **FIXED**

`addItemToDraft` read `product.price` and `product.cost ?? 0`. Products have
`unitPrice` and no cost column, so an edited-in line went in at price 0 — left
out of the order total and the COD — and reserved stock at cost 0, understating
inventory value and delivery COGS. Now `productPrice(product)` and the ledger's
`costOf(product.id)`, as the code's own comment always claimed.

### P1-10 — An over-budget expense was paid, then "refused" — **FIXED**

The budget cap was checked inside `addExpense`, which الشركاء والمالية calls
AFTER appending the `expense` ledger event. An over-cap expense moved the
money, then showed «لا يمكن تجاوز الحد المسموح» with no document kept — and
left the form's gate held until a reload. The spending it compared against is
the hydrated `expenses` list, which reads 0 before it loads or after it fails.
`checkExpenseBudget` now runs BEFORE the ledger and answers `spending_unknown`
rather than "within budget" when the list has not loaded; a document failure
after the ledger is reported and releases the gate.

### P1-11 — Smaller integrity fixes found in the sweep — **FIXED**

* **Courier statement reprint** matched orders on `codSettlementId` (no
  column): every reprint after a reload listed NO orders under a real amount.
  It now reads the settlement event's own `orderNumbers`.
* **Owner budget card** showed «الباقي» as the whole budget, in green, on a
  failed read — and previewed "after this draw" from that 0. Now `— ج.م` with
  a retry, and no preview until the read answers.
* **Customer from an address-less order** was refused by NOT NULL.

### P1-12 — Failed read → 0 → mutation: the sweep

Every Desktop money mutation that consults a read before writing:

| Path | Verdict |
|---|---|
| Supplier return · trader return (×3) · جرد · dividend | SAFE — fixed in P1-D |
| Expense against a budget cap | **FIX REQUIRED → fixed (P1-10)** |
| Wallet transfer | SAFE — P1-D refuses on an unread balance |
| Opening balance | SAFE — additive, never consults the balance (label ambiguity → P2 F-16) |
| Owner draw | SAFE for the mutation (advisory budget); display fixed (P1-11) |
| Supplier payment | SAFE — books the amount entered; invoice documents are best-effort and reported |
| Trader payment | SAFE — validated against the invoice document |
| Courier batch settlement | SAFE — eligibility on `codSettledAt` (a column); amounts from order documents |
| Per-order courier settle · retail return · exchange · deposit | SAFE — order documents; deposit refund is a server RPC |
| Order placement | SAFE — P1-B `stockIsAuthoritative` |
| Order edit | SAFE — additions are refused when `qtyOf` has not answered (it answers 0 → insufficient) |
| Purchase receipt | SAFE — cost is an operator-typed, visible field |
| Courier claim settlement | SAFE — server trigger (migrations 040/041) |

### P1-7 — Five test files assert against code that moved — **FIXED** (2026-09-22)

All 5 failures were stale locations, not regressions. They were rebased onto
the canonical sources in the login-regression fix (`1cb38ce`); none was
deleted or weakened, and the suite has been fully green since.

---

## F. P2 improvements

* **F-1** Desktop bundle is one 2.31 MB chunk (680 KB gzip) plus **1.9 MB of
  PNG logos** (`logo-dark` 1014 KB, `logo-light` 893 KB). Vite warns. Convert
  the logos to SVG/WebP and `manualChunks` the vendor split.
* **F-2** Boot does 14 serial `await cloudList(table)` round trips. They are
  independent; `Promise.allSettled` costs one line.
* **F-3** No pagination on any list screen. `pageAll()` removes the 1000-row
  cap on the read, so the render is unbounded.
* **F-4** `/branches`, `/users`, `/backups` duplicate Settings tabs at
  URL-only routes. Two code paths, one of them undiscoverable.
* **F-5** 8 placeholder routes and the whole `BusinessProfile` concept are
  unreachable (`setBusinessProfile` has no callers; `BusinessProfile = any`).
* **F-6** Dead modules confirmed still dead: `ProfitDashboard`, `PlanGate`,
  `ShippingSelector`, `financialSyncService`, `settingsStore`, `themeStore`,
  `RoleGuard` (App.tsx mentions it only in a comment). `supplierTotals` is no
  longer dead — Mobile imports it, so `KNOWN_LIMITATIONS.md` #8 is now stale
  on that one item.
* **F-7** `routeTree.gen.ts`, `src/routes/__root.tsx`, `src/router.tsx`,
  `src/server.ts`, `src/start.ts` and `@tanstack/react-router` +
  `@tanstack/react-start` are a second, unused router stack. `App.tsx` uses
  `react-router-dom`.
* **F-8** `lib/api/*.server.ts` reference `process.env.DATABASE_URL`,
  `AUTH_JWT_SECRET`, `STRIPE_SECRET_KEY`, `LICENSE_SIGNING_SECRET`,
  `INTERNAL_API_KEY` — there is no server runtime to read them.
* **F-9** Desktop Vercel env vars are set for **production only**. Preview
  deployments boot into `offline_local` with empty screens.
* **F-10** 21 "TODO: Analytics Engine integration point" markers with no
  analytics engine.
* **F-11** No `sku` / `barcode` uniqueness at the database; no
  `(store_id, phone)` uniqueness on `customers`. Both are deduped in the
  client only.
* **F-12** Supabase auth errors reach the user in English inside an
  all-Arabic UI (carried from `KNOWN_LIMITATIONS.md` #12).
* **F-13** *(new, from P0 Wave 1)* `nexuscore-web1` serves from `*.vercel.app`
  with no custom domain, so public access depends on `ssoProtection` staying
  off — and the team default re-applies it to new projects. Attaching a domain
  makes the access path independent of that setting. The URL works today;
  this is hardening, not a blocker.
* **F-14** *(verified in P1 Wave 2)* The `expenses` realtime handler merges
  every INSERT/UPDATE unconditionally, although the table carries the same
  `updated_at` BIGINT clock the other handlers compare.
  **Exposure today: none.** Expense rows are insert-once (new UUID per
  record) and removed by hard `DELETE` (`cloudDelete`), which realtime
  delivers as a DELETE the handler removes correctly; no Desktop path
  updates an expense. Live data: 2 rows.
  **Latent risk:** the day an expense can be edited, an older UPDATE
  delivered after a newer one overwrites that row in the expense *document*
  list until the next hydrate. Money is not affected — every expense total
  is `SUM(expense)` over the ledger, never this table.
  **Fix:** one line — move `expenses` into the `reference()` factory in
  `useRealtimeSync`, which already compares `updated_at`. Left out of Wave 2
  on purpose: it would reopen P1-C's handlers for a risk nothing triggers.
  Do it together with any expense-edit feature.
  *Re-verified 2026-09-26:* still insert-only (new UUID per record) and hard
  delete — still latent, still P2.
* **F-15** *(P1-6)* The trader "saved addresses" picker has never had a source:
  `wholesale_clients` has no addresses column and nothing writes one. It always
  offers "new address" only. A feature to build or remove.
* **F-16** *(P1-12)* The wallet opening balance is additive, but its field is
  labelled «المبلغ الموجود حالياً» ("the amount present now"), which reads as a
  TOTAL. On a till that already has sales, an owner could enter the total and
  double it. Wording, or reconcile against the displayed balance.
* **F-17** *(P1-6)* `Product` typing — the generic-helper refactor described in
  §P1-6.
* **F-18** *(O-2)* The live-database tests need a dedicated QA Supabase project
  (or branch) with its own secrets before CI can run them — never the
  production service-role key.

---

## G. Business decisions required

Nothing below is invented. Each is a real fork the code and data leave open.

| # | Decision | Why it is open |
|---|---|---|
| G-1 | Should an expired licence block **reads**? | `has_role` includes `store_licensed`; `is_store_member` does not. Writes stop, reads do not. Both are defensible |
| G-2 | What does PRO actually buy? | `store_licenses.plan_type` is set and displayed; `PLAN_CATALOG` is `{}`; the UI reads a different, dead flag. Pricing decision, not engineering |
| G-3 | Order lifecycle extensions | `cancelled` is terminal; there is no partial-delivery, no partial-return, no re-ship of a returned order |
| G-4 | COD / payment model | `paymentMethod` CHECK allows only `full_prepaid` and `partial_cod`. No card, no wallet, no instalment. Paymob config exists, function undeployed |
| G-5 | Ledger browser scope | `ledger_events_page` is built and unused. Who may see raw events, and with what filters? |
| G-6 | Notifications | Nothing exists. In-app only, or email/SMS too? |
| G-7 | Reports scope | P&L + capital/equity exist. No VAT return, no ageing, no per-product profitability, no stock valuation report |
| G-8 | Courier UI scope | Couriers are ADMIN-write only, with no courier-facing surface at all |
| G-9 | Shipping provider | Out of scope this phase by explicit instruction, but the config screen promises it |
| G-10 | Branch semantics | §C-65. Directory, or an access/stock boundary? |
| G-11 | Business profiles | Keep and wire up (8 placeholder modules), or delete the concept and the routes? |
| G-12 | Feature toggles | Per-device localStorage, or a store-level setting in `stores`? Today two of them hide core navigation |
| G-13 | Business-data backup/restore | `KNOWN_LIMITATIONS.md` #1. Supabase PITR plan, out-of-band `pg_dump`, or an in-app tenant export? |
| G-14 | Who may complete a trader return | **Consistency FIXED 2026-09-26**: `canReturnWholesale` (ADMIN — the intersection of the three live policies) is asked by `commitWholesaleReturn` BEFORE any write, and `/orders` shows the refusal and disables the button. Proven at runtime: ADMIN completes (records → invoice → ledger, one each); POS/ECOM/ACCOUNTANT/MODERATOR make zero writes. **Still a decision:** should POS/e-commerce staff be able to complete these? If yes, `write_wholesale_invoices` must change — then `canReturnWholesale`. No documentation says they should, so nothing was widened. |

---

## H. Data-authority findings

| Value | Authoritative source | Mirrors / derived | Verdict |
|---|---|---|---|
| Stock | `SUM(ledger_lines.qty_delta) WHERE account='stock'` | `products.quantity`, `metadata.variants[].stock`, `lib/ledger/stockSnapshot` | **STALE MIRROR, ACTIVE** — read on the pre-snapshot fallback path; 3/7 QA products disagree (§P1-3) |
| Money balances | `SUM(ledger_lines.amount_delta)` per account | none | ACTIVE, single source |
| Wallet balances | ledger `wallet` account | none | ACTIVE |
| Supplier balance | ledger `payable_supplier` | `purchase_invoices.paidAmount/remainingAmount/status` | **READ-ONLY MIRROR** — document fields, not the balance |
| Customer receivable | ledger `receivable_client` | `wholesale_invoices.remainingAmount` | READ-ONLY MIRROR |
| Courier balances | ledger `receivable_courier` / `payable_courier` | `orders.expectedCod`, `codSettledAt` | READ-ONLY MIRROR |
| Customer LTV | ledger `customer_ltv` | `customers.returned_orders_count` | ACTIVE + counter mirror |
| Expenses | `expenses` table **and** ledger `expense` account | — | ACTIVE, dual-written. `useFinancialStore` is explicit that the ledger is the total |
| COGS | ledger `cogs`, `unit_cost` snapshotted at sale | `orders.cogsAmount` | READ-ONLY MIRROR |
| Revenue booked | ledger `revenue` | `orders.revenueLogged` (boolean) | ACTIVE flag |
| Plan tier | `store_licenses.plan_type` | `useSubscriptionStore.isProPlan` (localStorage), `profiles.is_pro` (0 rows) | **DANGEROUS-ADJACENT** — see H-3 |
| Role | `store_members.role` | `useAuthStore.userRole` (localStorage) | UI-ONLY; DB re-reads on every request |
| Auth | Supabase session | `useAuthStore.isAuthenticated` (localStorage) | **UI-ONLY and ungated on Desktop** (§P0-4) |
| Store settings | `public.stores` | `useSettingsStore` | ACTIVE, pulled on hydrate |
| `transactions` table | — | legacy sale/expense mirror | **STALE** — 0 rows in both stores, still hydrated, still realtime-subscribed |
| Document numbers | `store_counters` via `next_document_number` | — | ACTIVE for `FM-`/`FJ-`/`SP-`; **orders bypass it entirely** |

### H-1 Stock mirror drift — measured

Query and per-tenant result in §P1-3. Production store (المحل التجاري): **0
disagreements** across 132 products with ledger lines. QA-STORE: 3 of 6. Two
production products have no stock lines at all and therefore read the mirror
permanently.

Closed as a *path* by P1-3 — the three commit sites no longer accept a mirror
number — but the mirror itself is still derived state that can drift between
`applyStockMoves` and the next hydrate. That is by design; `StockAuditPage`
exists to show it.

### H-2 Owner financials computed twice

`lib/ledger/reports.ts` (Desktop, TS) and `owner_financial_summary` (Mobile,
SQL). `reports.ts:261` asserts in prose that the SQL reader "returns the
same"; no runnable check enforces it, and the one that would is skipped.

Positive finding while verifying this: `owner_financial_summary` **fails
closed**. Called over a service-role SQL connection it raised
`42501: not authenticated` — it will not answer without a real session.

### H-3 Plan tier has three sources, and the UI reads the wrong one

* `store_licenses.plan_type` — real, `BASIC`/`PRO`, set by the 6 admin RPCs.
  **No UI reads it for gating.**
* `profiles.is_pro` — legacy schema, table has **0 rows**, RLS `own_profile`.
* `useSubscriptionStore.isProPlan` — `persist`ed to `localStorage`, default
  `false`, and `fetchSubscriptionStatus` / `subscribeToRealtimeUpdates` have
  **zero call sites**. So it is never fetched from anywhere: it is a
  client-editable boolean that drives `ExecutiveDashboard:392` and
  `IntegrationsPanel:131`.

Nothing of value is gated on it today (`KNOWN_LIMITATIONS.md` #6 stands), so
this is a correctness and honesty problem rather than a privilege escalation.
It becomes one the day a real feature is hung off `isProPlan`.

### H-4 Feature toggles are device-local

`useFeatureStore` persists to `localStorage` under `feature-storage`. Nothing
writes them to `stores` or anywhere shared. Two of the five hide navigation
(§P0-3); two (`depositMandatory`, `salesCommissionsEnabled`) have no consumer
at all; one (`shippingTrackingEnabled`) only changes copy on the integrations
cards.

---

## I. Security findings

No security object was modified. Verified by reading live policies, function
bodies and the Supabase security advisor.

### What holds

* **RLS is enabled on all 25 `public` tables.** 5 carry zero policies and are
  therefore deny-all to every client role: `users`, `auth_sessions`,
  `auth_login_attempts`, `store_alias`, `store_counters`. The advisor reports
  these as INFO `rls_enabled_no_policy`; **that is the intended state**, not a
  gap — `store_counters` is reached only through SECURITY DEFINER
  `next_document_number`, and the three `auth_*` tables are the disabled
  legacy auth system.
* **Tenant isolation is in Postgres.** Every policy resolves membership from
  `auth.uid()` via `is_store_member` / `has_role` (both SECURITY DEFINER with
  pinned `search_path`). A forged `store_id` in a payload is refused.
* **Licence is enforced at the database**, not only in the UI:
  `has_role(store_id, …)` = role match **AND** `store_licensed(store_id)`.
* **MODERATOR appears in no `has_role` array anywhere.** It can SELECT (via
  `is_store_member`) and write nothing. Read-only is real, not UI-only.
* **Ledger is append-only for every client role.** `no_update_*` /
  `no_delete_*` are `USING (false)` on both ledger tables.
* **Discount counters are trigger-protected.** `guard_discount_usage` reverts
  any `usedCount` / `totalDiscount` change not made inside
  `claim_discount_use` / `adjust_discount_total` / `release_discount_use`.
* **`ledger_append` is SECURITY INVOKER** — it buys atomicity and grants
  nothing.
* **Store ADMIN ≠ System Owner.** `is_system_owner()` reads
  `auth.users.email` against two literals plus `email_confirmed_at`; no store
  role can reach it.
* **`SystemOwnerGate` fails closed** on transport error.
* **Advisor WARN `anon_security_definer_function_executable` (8 functions) is
  a false positive here.** All three discount RPCs open with
  `IF NOT COALESCE(public.has_role(p_store, …), false) THEN RAISE EXCEPTION …
  ERRCODE '42501'`, and `has_role` resolves from `auth.uid()`, which is null
  for `anon`. `is_store_member` / `has_role` / `member_role` /
  `list_store_members` likewise answer false/null for `anon`.
  `products_guard_definition_columns` is a trigger function and errors without
  trigger context. **No action required; recorded so it is not re-raised.**

### Real gaps

| # | Gap | Severity |
|---|---|---|
| I-1 | ~~Desktop does not gate on session reconciliation~~ **CLOSED 2026-09-21** (§P0-4) | was HIGH |
| I-2 | `insert_ledger_lines` allows all four writing roles with **no kind-based restriction**, while `insert_ledger_events` restricts `expense`/`payroll`/`owner_draw`/`wallet_transfer`/`purchase`/`supplier_payment`/`stock_adjustment` to ADMIN+ACCOUNTANT. A POS_ECOMMERCE session can therefore append lines to an **existing** ADMIN-created event. **PROVEN 2026-09-26: +1,000,000 EGP minted into a till** (rolled back) | **HIGH — REQUIRES SUPABASE ACTION** (see *Supabase notes* below) |
| I-3 | `products` carries two overlapping policies: `write_products` (ALL, ADMIN+ACCOUNTANT) and `update_products` (UPDATE, all four roles, `with_check` NULL). Permissive policies OR, so POS/ECOM can UPDATE products; only the `products_guard_definition_columns` trigger narrows which columns. **PROVEN 2026-09-26:** prices and definition columns are refused (42501), stock-mirror moves are allowed (intended) — but **`id` is not guarded**: POS can re-key a product | **MEDIUM — REQUIRES SUPABASE ACTION** (see below) |
| I-4 | An access token keeps reading for its ~1 h lifetime after logout (stateless JWT). Carried from `KNOWN_LIMITATIONS.md` #11 | LOW, no code fix |
| I-5 | Leaked-password protection is off at the project level; the client-side HIBP check guards the form, not the API, and fails open | LOW |
| I-6 | Client-side privilege assumptions in `localStorage`: `isAuthenticated`, `userRole`, `isProPlan`, `feature-storage`. Only `isProPlan` and the feature flags change what is *offered*; role and auth are re-checked by Postgres | LOW |
| I-7 | An expired licence still permits reads (§G-1) | DECISION |

### SUPABASE NOTES FOR CLAUDE CODE

Neither change below was applied. Both are **production migrations required:
YES**. Both were proven against the live project with self-aborting
transactions; nothing persisted.

#### I-2 — `ledger_lines` accepts lines for events it did not create

* **Table / policy:** `public.ledger_lines` · `insert_ledger_lines` (INSERT).
* **Current:** `WITH CHECK (has_role(store_id, 'ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY','ACCOUNTANT'))`
  — role and store only. Nothing ties a line to an event the caller may create.
* **Exploit, reproduced:** as a real POS_ECOMMERCE member of QA-STORE —
  (1) inserting a `purchase` event → **refused 42501** (the events policy
  restricts that kind); (2) inserting a `wallet +100,000,000 piastres` line
  whose `event_id` is an existing ADMIN `purchase` event → **ACCEPTED**. The
  till's SUM went 646,000 → 100,646,000. The lowest writing role can mint money
  and unbalance any posted event, bypassing the kind restriction entirely.
* **Why RLS is insufficient today:** the events policy is kind-aware; the lines
  policy is not, and lines are the money.
* **Proposed fix** — lines may attach only to an event created in the SAME
  transaction. `ledger_append` (the only client write path — `driver.ts`
  calls nothing else) inserts the event and its lines in one statement
  sequence with no exception sub-block, so the event row's `xmin` is the
  current transaction id:

  ```sql
  DROP POLICY IF EXISTS insert_ledger_lines ON public.ledger_lines;
  CREATE POLICY insert_ledger_lines ON public.ledger_lines
    FOR INSERT
    WITH CHECK (
      has_role(store_id, VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY','ACCOUNTANT'])
      AND EXISTS (
        SELECT 1 FROM public.ledger_events e
        WHERE e.id = ledger_lines.event_id
          AND e.store_id = ledger_lines.store_id
          AND e.xmin = pg_current_xact_id()::xid
      )
    );
  ```
* **Why legitimate writes survive:** the event was inserted moments earlier
  in the same `ledger_append` call, under `insert_ledger_events` — so kind
  authorization is inherited from the event, and only its own lines pass.
  Service-role writers (Edge Functions) bypass RLS and are unaffected.
* **Validated (dry run, PostgreSQL 17.6, not installed):** as POS_ECOMMERCE,
  the predicate evaluated **true** for lines of an event `ledger_append` had
  just created, and **false** for the existing ADMIN event.
* **Caveat to check before applying:** if `ledger_append` ever gains a
  `BEGIN … EXCEPTION` block, the event is inserted in a subtransaction and its
  `xmin` differs from the top-level id — the policy would then refuse every
  write. Keep the function free of exception blocks, or switch the predicate.
* **Regression required:** (a) a normal `ledger_append` by each writing role
  succeeds; (b) the reproduction above is refused 42501; (c) an ADMIN appending
  a line to an OLD event is refused too; (d) balances unchanged.

#### I-3 — a POS user can re-key a product

* **Table / guard:** `public.products` · trigger function
  `products_guard_definition_columns` (SECURITY DEFINER). It refuses non-ADMIN/
  ACCOUNTANT changes to name, sku, barcode, category, description, image_url,
  unitPrice, wholesale_price, min/maxStockLevel, isActive, isBundle,
  bundleItems, deleted_at and store_id — but **not `id`**.
* **Reproduced** as POS_ECOMMERCE: `unitPrice` change → refused 42501 ✓;
  stock-mirror `quantity` update → allowed ✓ (intended); **`UPDATE products
  SET id = id || '-rekeyed'` → 1 row**.
* **Risk:** ledger lines, order lines and invoice lines reference a product by
  id (text, no foreign key). A re-keyed product silently loses its entire stock
  and cost history; sales against the new id start from zero.
* **Proposed fix:** refuse an id change for EVERYONE, ahead of the role
  bypass — the app never changes an id (every write upserts ON CONFLICT (id)):

  ```sql
  -- inside products_guard_definition_columns, before the ADMIN/ACCOUNTANT RETURN:
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'a product id cannot change' USING ERRCODE = '42501';
  END IF;
  ```
* **Why stock operations stay allowed:** `quantity` and `metadata` (the stock
  mirror) are untouched by the new check.
* **Regression required:** POS / ADMIN id change → refused; POS quantity
  update → allowed; POS price change → still refused.


---

## J. Realtime findings

**Publication `supabase_realtime` carries 16 tables.** Desktop now subscribes
to **13** of them on one channel `global-sync` (`hooks/useRealtimeSync.ts`) —
12 merged through `TABLE_HANDLERS` plus the `ledger_events` pulse. It was 5;
P1-4 closed the gap, and the three still excluded are excluded on purpose.

| Table | Published | Desktop subscriber | Effect |
|---|---|---|---|
| products | ✅ | ✅ `*` | merged, LWW on `updated_at` |
| orders | ✅ | ✅ `*` | merged, LWW on `updatedAt` |
| transactions | ✅ | ✅ `*` | merged into a store with 0 rows in production |
| expenses | ✅ | ✅ `*` | merged, **no LWW guard** — unconditional overwrite (unchanged; see below) |
| ledger_events | ✅ | ✅ INSERT | fires a `ledger-sync-pulled` window event; consumed by `useStock` and `useBalances` |
| customers | ✅ | ✅ `*` | merged, LWW on `updated_at` |
| suppliers | ✅ | ✅ `*` | merged, LWW on `updated_at` |
| purchase_invoices | ✅ | ✅ `*` | merged, LWW on `updated_at` |
| wholesale_invoices | ✅ | ✅ `*` | merged, LWW on `updated_at` |
| wholesale_clients | ✅ | ✅ `*` | merged, LWW on `updated_at` |
| return_records | ✅ | ✅ `*` | merged, LWW on `updated_at` |
| discount_codes | ✅ | ✅ `*` | merged, LWW on `updated_at` |
| shipping_rates | ✅ | ✅ `*` | merged, LWW on `updated_at` |
| ledger_lines | ✅ | ❌ **by decision** | arrives with its event; `ledger_events` already pulses the readers |
| stores | ✅ | ❌ **by decision** | licence and identity — `useSessionReconciliation` owns it |
| branches | ✅ | ❌ **by decision** | structural; created once and then left alone |

**`expenses` still has no Last-Write-Wins guard** — verified in P1 Wave 2,
and classified **P2 (F-14)**, with the exact risk stated there. Short version:
no Desktop code path updates an expense row today, so nothing triggers it.

### Other findings

* **No duplicate subscriptions.** One channel, created in one `useEffect`
  with `[]` deps, removed on unmount. `useSubscriptionStore`'s
  `subscribeToProfileChanges` (on `profiles`) has **zero call sites**, so the
  second channel never opens.
* **No cross-tenant delivery risk.** `postgres_changes` is filtered by RLS;
  every subscribed table's SELECT policy is `is_store_member(store_id)`.
* **No `store_id` filter on any subscription.** Correct but wasteful: the
  server evaluates RLS per subscriber for every change in every tenant.
* **Duplicate financial effects: none.** Realtime never appends; `isOwnEcho`
  suppresses self-echo on `ledger_events`, and the ledger handler only asks
  readers to re-aggregate.
* **Reconnect is handled** — `window.addEventListener('online')` triggers a
  full `hydrateAll()` catch-up.
* **Auth/session race:** `hydrateAll()` runs in a `useEffect` with no
  dependency on reconciliation completing. A boot that ends in sign-out still
  fires 14 reads first.
* **No runtime multi-client proof was taken this pass.** Doing it properly
  needs two authenticated browser sessions against the disposable QA tenant;
  the brief forbids permanent ledger probes and none were written.

---

## K. Document / export / print findings

**There is no PDF library in this project.** `lib/pdfGenerator.ts` builds an
HTML string and then either calls `window.print()` (browser "Save as PDF") or
downloads a `.html` file. Every "PDF" button is one of those two.

| Flow | Source → mapper → template → output | Status |
|---|---|---|
| Financial report | ledger `balances()` → `fetchPnl` → `generateFinancialPdf` → print | ✅ |
| Courier settlement | `CourierLedgerPage` → `generateCourierPdf` → print | ✅ |
| Orders report | `OrdersPage` → `generateOrdersPdf` → print | ✅ |
| Generic tables | `printTableAsPdf` — inventory, shortages, POS, wholesale | ✅ |
| Product import template | `XLSX.write` → Blob download | ✅ |
| Product import | `XLSX.read` → `lib/productImport.ts` → validated rows | ✅ |
| Profit CSV export | `ProfitDashboard` → Blob | ❌ component has 0 importers |
| Shift report | `Layout.tsx:116` → `.txt` Blob | 🟡 plain text, no template |
| Data export (xlsx/csv) | — | ❌ does not exist |
| Quotations | — | ❌ the concept does not exist in Desktop (0 matches for `quotation` / `عرض سعر`) |

### Document numbering

`next_document_number(p_store, p_name, p_prefix)` — SECURITY DEFINER. The
LIVE definition checks `has_role(store, ADMIN | POS_ECOMMERCE | ECOMMERCE_ONLY
| ACCOUNTANT)`, which is tighter than the `is_store_member` in the repo copy of
migration 016 and is exactly the set of roles that may take an order — so
orders needed no change to the function. A single `INSERT … ON CONFLICT DO UPDATE … RETURNING`
so concurrent callers serialise on a row lock.

| Document | Prefix | Allocator | Unique index |
|---|---|---|---|
| Purchase invoice | `FM-` | ✅ RPC | ✅ `(store_id, "invoiceNumber")` |
| Wholesale invoice | `FJ-` | ✅ RPC | ✅ `(store_id, "invoiceNumber")` |
| Supplier payment | `SP-` | ✅ RPC | n/a (ledger ref) |
| **E-commerce order** | `ECO-` | ✅ RPC (migration 042) | ✅ `(store_id, "orderNumber")` |
| POS sale receipt | — | ❌ | ❌ |
| Return document | — | ❌ | ❌ |

**Fields dropped between authoring and snapshot:** none found. `orders.items`
/ `stockItems` and `*_invoices.items` are `jsonb` written whole, and
`writeThrough` reads back what Postgres stored before committing to local
state — a dropped field would surface immediately rather than silently.

---

## L. UX completeness findings

### L-1 The structural gap: no loading truth

Scanned all 98 non-`ui/` components. Per-screen loading indicators appear in
**11**. That is not an oversight — data arrives through one global
`hydrateAll()` into Zustand, so screens have no local load to show. The cost
is that **loading, empty and failed all render the same empty state**, and
`useSyncStatus` — which knows the difference — is consumed only by the
Sidebar.

### L-2 Per-dimension

| Dimension | Coverage |
|---|---|
| Loading | 🔴 no global gate; 11/98 components have any indicator |
| Empty | ✅ `EmptyState` + Arabic copy, widely used |
| Error | 🟡 writes ✅ (toast + rethrow); boot reads 🟡 one toast |
| Retry | ❌ 3 occurrences total |
| Validation | ✅ zod + react-hook-form + ledger-level `assertFiniteLines` |
| Success | ✅ sonner `<Toaster richColors closeButton dir="rtl">` mounted |
| Disabled | ✅ submit gates on every ledger-writing handler |
| Search | ✅ per-screen · 🔴 global header input is decorative |
| Filter | ✅ orders, returns, courier ledger, inventory |
| Pagination | 🟡 component exists, unused on list screens |
| Keyboard | 🟡 accessible names asserted; focus order not covered |
| RTL | ✅ throughout |
| Responsive | 🟡 `MobileNav` drawer; verified manually, not in CI |
| Refresh | ✅ sidebar refresh → `hydrateAll()` |
| Navigation | ✅ one map for sidebar and router |
| Deep links | 🟡 one route only |
| Session expiry | 🟡 silent sign-out |
| License expiry | ✅ dedicated screen, owner-aware |

### L-3 Error boundaries

`RouteBoundary` (App.tsx) wraps 10 of 21 business routes. `/products`,
`/pos`, `/inventory`, `/stock-audit`, `/purchasing`, `/wholesale`,
`/partners`, `/integrations`, `/settings`, `/preferences` and `/returns` are
**not** wrapped — a render throw there takes the whole app to a blank page.

---

## M. Production-data facts

Read-only. **No production row was modified.** Every item is FACT; recovery
proposals are labelled and **NOT EXECUTED**.

### M-1 Six stores

| Store | Name | Members | Products | Orders | Events | Licence |
|---|---|---|---|---|---|---|
| `c1c919f9…` | المحل التجاري | **0** | 134 | 2 | 154 | active → 2027-08-30 |
| `db31bbd8…` | QA-STORE (disposable) | 2 (ADMIN, POS_ECOMMERCE) | 7 | 34 | 167 | active → 2027-10-03 |
| `cf55f624…` | متجري | 1 (ADMIN) | 0 | 0 | 0 | suspended |
| `23338df8…` | متجري | 1 (ADMIN) | 0 | 0 | 0 | **none** |
| `c58d76ab…` | متجري | 1 (ADMIN) | 0 | 0 | 0 | active → 2027-09-19 |
| `b73ca66a…` | متجري | 1 (ADMIN) | 0 | 0 | 0 | suspended |

### M-2 FACT — the store holding the real dataset has no members — **BLOCKED / OPERATIONAL, not an application bug** (re-verified 2026-09-26)

Re-verified: still 0 members; activity from 2026-08-30 to 2026-09-11 across 7
devices, then none. The application handles it **fail-closed**: every read
policy is `is_store_member`, so nothing leaks, and session reconciliation
signs out a member-less non-owner on boot. It blocks runtime verification on
production data only — QA-STORE covers that. No production membership was
created; recovery is the owner's decision (which user — constrained by the
one-store-per-user index).

`c1c919f9…` "المحل التجاري" holds 134 products, 154 ledger events and an
active licence valid to 2027-08-30, and **zero rows in `store_members`**.
Because every SELECT policy is `is_store_member(store_id)`, **no client
session can read any of it.** It is live, licensed and unreachable.

*Recovery proposal (NOT EXECUTED):* insert one `store_members` row granting
ADMIN to a chosen `auth.users.id`. Blocked on two things this audit will not
decide — **which** user, and the `store_members_one_store_per_user` unique
index, which means that user must not already hold a membership elsewhere.

### M-3 FACT — four accidental single-owner tenants

`cf55f624…`, `23338df8…`, `c58d76ab…`, `b73ca66a…` are all named "متجري",
each with exactly one ADMIN and no business data. This is the
`claim_store` behaviour described in `KNOWN_LIMITATIONS.md` #15: an employee
who signs up unprompted gets a shop of their own.

*Recovery proposal (NOT EXECUTED):* deleting the stray membership and store is
the documented prerequisite for inviting that person properly. Needs the
owner to identify which accounts are genuinely stray.

### M-4 FACT — one store has no licence row

`23338df8…`. `store_licensed()` returns false, so it is fully write-blocked;
`LicenseGate` sends its ADMIN to `/license-expired`.

### M-5 FACT — 25 ledger events carry no lines; all 25 are explained

| Kind | Count | Store | Classification |
|---|---|---|---|
| `order_returned_pending` | 19 | QA | **BY DESIGN** — `lib/ledger/index.ts:61` explicitly permits zero lines for this kind only |
| `stock_adjustment` | 3 | production | `KNOWN_LIMITATIONS.md` #4, pre-`ledger_append` |
| `purchase` | 2 (both ref `FM-0001`, 3 s apart) | production | same, plus a pre-submit-gate double click |
| `purchase` | 1 (`382e5914…`, ref `FM-0006`) | QA | the atomicity failure **deliberately reproduced** and recorded in `lib/ledger/driver.ts` |

All six non-design orphans contribute nothing to any balance. None can be
repaired — the quantities existed only in the missing lines. **NOT EXECUTED**,
and inventing values would put fabricated numbers in a financial ledger.

### M-6 FACT — staff invitation email still does not deliver

Unchanged from `KNOWN_LIMITATIONS.md` #15. `invite-staff` is the only deployed
Edge Function (version 4, `verify_jwt: true`, ACTIVE). Four integration
functions in `supabase/functions/` remain **undeployed**:
`handle-ecommerce-order`, `handle-paymob-webhook`, `handle-shipping-webhook`,
`handle-subscription-webhook`.

### M-7 FACT — 2 of 8 auth users hold no membership

They can sign in; `claim_store` would give each a new empty shop on next
login through the `/login` path.

### M-8 FACT — event kinds never used in production

`wallet_transfer`, `owner_draw`. Account `owner_budget` has **zero lines** in
either store, though `OwnerBudgetCard` writes it.

### M-9 FACT — legacy tables carry residue

`auth_login_attempts` 5 rows, `users` 0, `auth_sessions` 0, `profiles` 0,
`store_alias` 0, `transactions` 0. All deny-all or empty. **HARMLESS.** Not
dropped — dropping is irreversible and buys nothing over deny-all.

---

## N. Deployment findings

### N-1 Desktop Vercel project

| Setting | Value |
|---|---|
| Project | `nexuscore-web1` (`prj_89Pd0Ge…`), team `nexuscore1` |
| Framework | vite · Node 24.x |
| Build command | `npm run build` |
| Output directory | `dist` |
| Latest production deployment | `dpl_HfpD8tU…`, **READY** |
| Domains | `nexuscore-web1.vercel.app` + 2 git aliases — **no custom domain** |
| `ssoProtection` | **enabled, `all_except_custom_domains`** → §P0-1 |
| `passwordProtection` | disabled |
| Env vars | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — **production target only** |

### N-2 Routing / SPA

`vercel.json` carries `"framework": "vite"` and one rewrite,
`/(.*) → /index.html`. Correct for a client-side router, and deliberately
carries **no** `buildCommand` / `outputDirectory` so the mobile project can
set its own (`DEPLOYMENT.md` explains why).

### N-3 Builds — both green

```
npm run build         → exit 0,  built in 15.24s, PWA precache 21 entries (4633.66 KiB)
npm run build:mobile  → exit 0,  built in  7.51s, PWA precache 18 entries (1360.33 KiB)
npx tsc --noEmit      → exit 0
```

Desktop warns: one chunk `index-*.js` at **2,313.42 kB** (gzip 680.85 kB),
plus `logo-dark` 1,014.15 kB and `logo-light` 892.64 kB. → §F-1.

### N-4 Supabase connectivity

`getOperationMode()` accepts `VITE_*` or `NEXT_PUBLIC_*`; both prefixes are
declared in `vite.config.ts`. Missing keys silently degrade to
`offline_local` with empty screens — which is what a preview deployment does
today (§F-9).

### N-5 Auth redirects

`invite-staff` builds `${APP_URL}/set-password`, falling back to the request
origin. Supabase replaces any `redirect_to` outside the allowlist with the
Site URL. Unchanged and unverified this pass — the invitation email does not
arrive (§M-6).

**No deployment setting was changed.** P0-1 is a production blocker but not
an active outage, so it is reported rather than fixed.

---

## O. Testing

```
npm run test:units
  tests 1190 · pass 1180 · fail 5 · skipped 5 · cancelled 0 · todo 0
  duration 11.4 s   (81 files, scripts/check_*.mjs)
```

**Identical to the stated baseline.** No new failures.

**After P0 Wave 1 (2026-09-21):**

```
  tests 1213 · pass 1202 · fail 5 · skipped 6 · cancelled 0 · todo 0
```

+23 tests (`scripts/check_desktop_p0.mjs`), +22 passing, +1 skipped (the
opt-in P0-1 live check). The 5 failures are **the same 5 stale pre-existing
ones** classified in O-1 below — unchanged in count, name and cause. Zero NEW
failures.

**After P1 closure (2026-09-26):**

```
  working tree   tests 1388 · pass 1382 · fail 0 · skipped 6
```

+19 tests: `check_p1_closure.mjs` (15) and 4 G-14 tests in
`check_wholesale_return_txn.mjs`. **19 mutations, 19 caught** (one escaped
first — a real test defect, fixed). No pre-existing test needed changing.

**O-2 — CI: PARTIALLY FIXED.** There was no CI at all; Vercel builds with Vite,
which neither typechecks nor tests, so nothing verified the committed tree.
`.github/workflows/ci.yml` now runs `npm ci`, `tsc --noEmit`, `npm test` and
the Desktop build on every push/PR to main — no secrets. It WILL report the 2
known committed-tree failures (courier sink; stale `dist-mobile` artifact)
until that excluded work is committed: that is the check doing its job. The 6
live tests (`check_desktop_p0` needs `NEXUS_PUBLIC_URL`;
`check_ledger_atomicity`, `check_moderator_role`, `check_owner_financials`,
`check_supabase_integrity` need `SUPABASE_URL` + the SERVICE-ROLE key) stay
skipped in CI — see F-18.

**After P0-5, the wholesale-return fix (2026-09-26):**

```
  working tree   tests 1369 · pass 1363 · fail 0 · skipped 6
```

+15 tests (`check_wholesale_return_txn.mjs` — the transaction core driven with
a fake ledger/invoice/record world, every failure direction forced). One
pre-existing test (`check_session7_core` · *a wholesale return writes the
invoice documents back*) was repointed from "each screen calls the credit" to
"each screen calls the command, and the command credits BEFORE the ledger" —
the same invariant, stricter. **11 mutations, 11 caught.**

**Isolated vs working tree.** Measured in a clean worktree, the committed tree
is the number that matters, and they differ because unrelated courier work
stays uncommitted by instruction. Before this fix, a clean `207160d`: 3 tsc
errors (all `recordWholesaleReturn`) and 2 failing tests. After it, isolated:
**tsc 0**, suite 1369 / 1361 / 2 fail / 6 skipped. The 2 are unchanged and both
depend on work excluded from commits by instruction:

* *couriers are a synced entity* — needs the uncommitted `couriers` hydrate
  sink and `useCourierStore` change;
* *P2-6 · the home screen is no longer named a placeholder* — a stale
  COMMITTED build artifact, `dist-mobile/assets/index-6LGpkZa9.js.map`, still
  names the mobile home screen's pre-rename component. The working tree already deletes it;
  `dist-mobile/**` is excluded from commits.

**After P1 Wave 2 (2026-09-26):**

```
  tests 1354 · pass 1348 · fail 0 · skipped 6 · cancelled 0 · todo 0
```

+45 tests: `check_load_states.mjs` (32 — the figure rule and per-table
status driven for real, every screen's wiring on comment-stripped source) and
`check_owner_authority.mjs` (13 — `netProfitOf` driven, the 2,001-case
piastre sweep, the cockpit's single source, 034's ACCOUNTANT decision pinned).
**Zero failures, and no pre-existing test needed changing.**

**Mutation-tested: 32 mutations, 32 caught**, every touched file verified
byte-identical after the run. Among them: each of the five commit guards
removed, failure made to outrank nothing, an unasked table counted as ready,
the settings status persisted, the profit formula dropping a term, the
cockpit deriving its own profit, and a failed Owner read keeping its figures.

**After P1 Wave 1 (2026-09-22):**

```
  tests 1309 · pass 1303 · fail 0 · skipped 6 · cancelled 0 · todo 0
```

+13 tests (`scripts/check_desktop_p1.mjs`). **Zero failures.**

Three pre-existing tests failed mid-wave and were repointed, not weakened —
each pinned a real invariant through a marker this wave replaced:

| Test | Marker that moved | Invariant, restated |
|---|---|---|
| `check_order_traceability` · *allocated BEFORE the ledger event* | `const orderNumber = \`ECO-` | now finds the `nextDocumentNumber` call, **and** asserts the route mints nothing itself |
| `check_order_traceability` · *the store uses the caller's number* | the `\`ECO-${Date.now()}\`` fallback | now asserts the fallback is the same counter, on comment-stripped source |
| `check_sync_layer` · *every subscribed table is published* | a hand-written `table: '…'` list | now reads `TABLE_HANDLERS` itself, and scans **every** migration for the publication rather than only the init file and 036 |

The last one also had its floor raised from 5 to 13, so losing realtime
coverage again fails loudly instead of passing.

**Mutation-tested: 22 mutations, 22 caught.** Two escapes were found and both
were real test defects, fixed before the wave closed:

* *the mirror is read before the ledger again* — the test pinned source ORDER,
  which survives falsifying the condition around the ledger read. It now pins
  the condition and the return.
* *the eight reference handlers are discarded* — the test grepped for table
  names, which survive inside a call whose result is thrown away. It now
  asserts the handlers are spread into `TABLE_HANDLERS`. This one was caught
  the hard way: a crashed mutation run left the mutated file on disk and the
  suite still passed on it.

One pre-existing test needed repointing because this wave changed the code it
reads: `check_invite_staff.mjs` matched `<ProtectedRoute />` verbatim, and the
guard now takes the reconciled session as a prop. It matches the tag name
instead, so the invariant it guards — `/set-password` must sit above the gate —
is unchanged and still enforced.

All seven guards added this wave were **mutation-tested**: removing the
`"checking"` hold, returning a constant instead of the verdict, opening the
realtime channel before the session, signing out on a dropped packet, flipping
either module flag back to `false`, dropping the `persist` migration, and
hardcoding the role label again each make the suite fail. One mutation
initially **escaped** — a file-wide `returnsEnabled: true` match was satisfied
by the `true` inside `migrate` — and the assertion was tightened to the
initializer before being re-run.

### O-1 The 5 failures — all PRE-EXISTING and STALE

Each asserts on a file the Mobile refactor moved code out of. Each behaviour
was located at its new home during this audit.

| Test | Asserts on | Behaviour actually lives at |
|---|---|---|
| the local auth flag is reconciled against the real Supabase session | `src/hooks/useRealtimeSync.ts` | `lib/auth/useSessionReconciliation.ts` — `getSession()` :24, `onAuthStateChange` :108, `logout()` :26 |
| logging out ends the Supabase session, not just the local flag | same | same |
| the only credential check left is Supabase Auth | `src/pages/Login.tsx` | `lib/auth/sessionWorkflow.ts:244` `auth.signInWithPassword` |
| accepting an invitation never creates a second shop | `src/pages/SetPassword.tsx` | `lib/auth/sessionWorkflow.ts:290-334` — no `claim_store`, `if (!membership)` :325, `toAppRole(membership.role)` :334 |
| the password set here is held to the same standard as signup | same | `sessionWorkflow.ts:291` length, `:299` `checkLeakedPassword` |

**Classification: PRE-EXISTING / STALE.** The fix is to repoint the test
reads — no production code changes. Not done here (§P forbids it).

### O-2 The 5 skips — ENVIRONMENTAL

All five need `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` /
`VITE_SUPABASE_ANON_KEY`, which are not in the shell:

* `ledger_append atomicity (live database)`
* `MODERATOR against a real database`
* `period filter and Owner reader (live database)` ← the only owner-financials
  cross-check (§P1-5)
* `the capability and the database agree, role by role (live)`
* `Supabase Environment Configuration`

This is the highest-value gap in the suite: the four live tests are exactly
the ones that would have caught §I-2, §I-3 and §H-2.

### O-3 Coverage shape

Strong: ledger arithmetic, duplicate-submit gating, licence state machine,
accessible names, cloud-write contract, order lifecycle, discounts, exchange,
paging, mobile alignment.

Absent: rendered layout, responsive behaviour, focus order, any Desktop
component render test.

---

## P. Recommended execution order

Each step is independently shippable and leaves the suite green.

| Order | Item | Why first |
|---|---|---|
| ~~1~~ | ~~**P0-1** attach a domain / relax `ssoProtection`~~ | ✅ **DONE** 2026-09-21 — `ssoProtection` off, verified anonymously |
| ~~2~~ | ~~**P0-2** wire the header to `useAuthStore`~~ | ✅ **DONE** 2026-09-21 — `SessionIdentity`, shared by both headers |
| ~~3~~ | ~~**P0-4 / I-1** gate `ProtectedRoute` on `SessionReconciliationState`~~ | ✅ **DONE** 2026-09-21 — plus the membership re-read and the realtime gate |
| ~~4~~ | ~~**P0-3 / H-4** default the two flags on~~ | ✅ **DONE** 2026-09-21 — default + `version: 1` migration |
| ~~5~~ | ~~**O-1** repoint the 5 stale tests~~ | ✅ **DONE** 2026-09-21 — suite green |
| ~~6~~ | ~~**P1-1 / C-71** one boot gate driven by `useSyncStatus`~~ | ✅ **DONE** 2026-09-26 (P1-D) — per-table status + `CollectionGate` + the figure rule, all 21 screens; five commit paths that decided on unread zeros now refuse |
| ~~7~~ | ~~**P1-2 / K** move order numbers onto `next_document_number("ecommerce_order","ECO-")` + add the unique index~~ | ✅ **DONE** 2026-09-22 — migration 042, two call sites (the route and the store fallback), history untouched |
| ~~8~~ | ~~**P1-4 / J** subscribe the 11 unsubscribed tables (or unpublish the ones nobody wants)~~ | ✅ **DONE** 2026-09-22 — 8 subscribed, 3 excluded with reasons, listeners now driven by the handler map |
| 9 | **O-2** get the 4 live tests running in CI | ◐ **PARTIAL** 2026-09-26 — CI now verifies the committed tree (tsc, suite, build); the live tests need a QA project (F-18) |
| ~~10~~ | ~~**P1-5 / H-2** assert Desktop `fetchPnl` == SQL `owner_financial_summary` on one real period~~ | ✅ **DONE** 2026-09-26 (P1-E) — 65 live comparisons, 0 mismatches; one client profit definition; cockpit on the RPC. The CI-run of the live test (step 9) is still open |
| 11 | **I-2 / I-3** — the exact changes are in *SUPABASE NOTES FOR CLAUDE CODE* (§I) | **NEXT, and the only open P1.** I-2 is a proven money-minting path. Apply through the migration workflow with the listed regressions |
| ~~12~~ | ~~**P1-3 / H-1** decide whether the mirror stays; if it does, add a reconciliation check~~ | ✅ **DONE** 2026-09-22 — the mirror STAYS (it is what makes a 200-row list cheap); the three commit paths now refuse to decide on it |
| 13 | **F-1 / F-2** logos → SVG/WebP, `manualChunks`, parallel hydrate | Pure performance, no behaviour change |
| 14 | **F-4 – F-8** delete the dead router stack, dead modules, URL-only duplicates, `*.server.ts` | Safe once nothing above depends on reading them |
| ~~15~~ | ~~**P1-6** restore the 66 `any` types, highest-traffic first~~ | ✅ **DONE for the financial core** 2026-09-26 — 66 → 45, retained ones classified; found and fixed P1-8 … P1-11 |
| 16 | **M-2** decide and execute the orphan-store recovery | Needs an owner decision, not an engineering one |
| 17 | Answer **G-1 … G-14** | Feeds the next roadmap, not this one |

**Not in this order, by explicit instruction:** Offline-First (out of product
scope), Shipping API (§G-9), Final UX/UI Pro Max pass, Mobile lint debt.

---

## Q. Explicit out-of-scope

* **Offline-First** — out of product scope. Not deferred work, not a gap.
  Must never appear in P0/P1.
* **Shipping provider API** — deferred by instruction.
* **Final UI/UX Pro Max pass** — deferred until the functional backlog above
  is closed.
* **Mobile** — untouched. Both builds verified green; no Mobile file was
  edited, and no shared-code regression was found.
* **Mobile P2-9 lint debt** — separate quality task, does not block Desktop.
* **Production data mutation** — nothing was changed. All recovery proposals
  in §M are labelled NOT EXECUTED.
* **Security changes** — §I documents gaps and changes nothing.
* **Any source, migration, RLS or UI change** — this pass wrote exactly one
  file, this one.

---

## Files changed

**Audit pass (2026-09-21, from `97c515c`)** — documentation only:

```
docs/DESKTOP_PRODUCT_AUDIT.md   (new)
```

**P0 Wave 1 (2026-09-21)** — the four blockers:

```
src/components/layout/SessionIdentity.tsx      (new)   P0-2
src/components/dashboard/Header.tsx                    P0-2
src/components/layout/Layout.tsx                       P0-2
src/store/useFeatureStore.ts                           P0-3
src/components/auth/ProtectedRoute.tsx                 P0-4
src/lib/auth/useSessionReconciliation.ts               P0-4
src/hooks/useRealtimeSync.ts                           P0-4
src/App.tsx                                            P0-4
scripts/check_desktop_p0.mjs                   (new)   tests
scripts/check_invite_staff.mjs                         test repointed
docs/DESKTOP_PRODUCT_AUDIT.md                          status
docs/NEXUSCORE_CHANGELOG.md                            entry
```

Plus one Vercel project setting (`nexuscore-web1.ssoProtection` → off), which
is not a repository change.

No migration, no RLS policy, no ledger code, no Mobile source, and no
production data was modified in either pass.
