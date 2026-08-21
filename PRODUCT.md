# NexusCore — Product Architecture

> **A sellable, offline-first retail & e-commerce admin system.**
> No live third-party dependencies required. The system is fully
> usable as a standalone product. External integrations (payment
> gateways, shipping carriers, online storefronts) are **wire-it-yourself
> slots** that the buyer activates when they need them.

---

## What you can sell today (without any external account)

The following are **fully implemented and run locally out of the box**:

| Capability | Where | Status |
|---|---|---|
| Cash / non-COD POS sales | `src/routes/pos.tsx`, `CheckoutForm.tsx` | ✅ Ready |
| Barcode-scanner POS lane | `CheckoutForm.tsx` (auto-focus, Enter-to-add) | ✅ Ready |
| Inventory tracking with SKU + barcode + reorder point | `src/routes/inventory.tsx` | ✅ Ready |
| Excel / CSV bulk product import | `src/components/products/BulkImportProduct.tsx` | ✅ Ready |
| Wholesale invoicing + client ledger + debt tracking | `WholesalePage.tsx` | ✅ Ready |
| Purchasing + supplier invoices (auto-increment stock) | `PurchasingPage.tsx` | ✅ Ready |
| Returns & exchanges with stock restoration | `src/routes/returns.tsx` | ✅ Ready |
| Manual e-commerce order entry (full form, deposit, COD) | `src/routes/ecommerce-orders.tsx` | ✅ Ready |
| 3-wallet accounting (Safe / Vodafone Cash / Bank) | `useFinancialStore.ts` | ✅ Ready |
| Internal wallet-to-wallet transfers with audit log | `useFinancialStore.transferBetweenWallets` | ✅ Ready |
| Capital & shareholders with dividend calculation | `useFinancialStore`, `CapitalEquityPage.tsx` | ✅ Ready |
| Immutable stock ledger (append-only) | `useFinancialStore.logStockChange` | ✅ Ready |
| Inventory audit with discrepancy → P&L | `StockAuditPage.tsx` | ✅ Ready |
| Courier receivables (shipped → reconcile → wallet) | `useCourierStore`, `OrdersPage.tsx` | ✅ Ready |
| PDF reports (financial, courier, orders) | `src/lib/pdfGenerator.ts` | ✅ Ready |
| RBAC (4 built-in roles, expandable to 9) | `src/lib/permissions.ts` | ✅ Ready |
| 3 business profiles (retail / e-commerce / both) | `BusinessProfile` type, `Sidebar` filter | ✅ Ready |
| Multi-branch / outlet tracking | `useBranchStore.ts`, `/branches` route | ✅ Ready |
| Audit log (login, financial, stock, integration changes) | `useAuditStore.ts` | ✅ Ready |
| Settings & feature toggles (returns, shipping, e-comm sync…) | `useFeatureStore.ts`, `Settings.tsx` | ✅ Ready |
| Dark / light / 4 industry theme presets | `useThemeStore.ts` | ✅ Ready |
| Arabic + English, RTL layout, glassmorphism | `style.css`, Arabic labels everywhere | ✅ Ready |

---

## What is intentionally a placeholder (you wire it up later)

These three integration slots are **architecturally ready** — types,
stores, UI, server endpoints, and SQL tables all exist. The system
works without them. When your customer needs them, the integrator
fills in the real HTTP calls. **None of them is a runtime dependency.**

### 1. Paymob (payment gateway)
- **Status:** placeholder. UI accepts and persists the API key, public
  key, integration ID, HMAC secret, callback URL. "Test Connection"
  only validates that fields are non-empty.
- **To activate:** drop the keys into `.env`, deploy
  `src/lib/api/integrations.server.ts`, fill in the real HMAC formula
  in `supabase/functions/handle-paymob-webhook/index.ts`.
- **Effect on product today:** zero — manual cash / Vodafone Cash /
  bank transfer flows cover 100% of revenue.

### 2. Shipping carrier (Bosta / Aramex / MyShipping / custom)
- **Status:** placeholder. The configuration is captured; the
  existing `useCourierStore` does manual reconciliation. Webhook
  endpoint exists for tracking updates but is a stub.
- **To activate:** deploy the server endpoint that calls the carrier's
  REST API; flip `autoCreateShipment` to true after a successful test.
- **Effect on product today:** zero — manual entry of shipment IDs
  and statuses works end-to-end.

### 3. Online order intake (Shopify / WooCommerce / custom)
- **Status:** placeholder. Schema and store are wired; webhook exists
  with HMAC-SHA256 verification; UI lets the buyer set the source,
  store URL, API key, and webhook secret.
- **To activate:** deploy the Edge Function or Deno runtime; point
  the storefront's webhook at it.
- **Effect on product today:** zero — the manual order entry at
  `/ecommerce-orders` is the default flow. The brief explicitly says
  no website exists yet, so this is a future hook only.

---

## Architecture: offline-first, sync-ready, feature-flag driven

### Storage layer (offline → online)

```
┌──────────────────────────────────────────────────────┐
│                    Frontend (Vite + React)            │
│                                                       │
│   Zustand stores (persisted to localStorage):         │
│   - useBusinessStore   products, partners, etc.      │
│   - useFinancialStore  wallets, ledgers, logs        │
│   - useOrderStore      e-commerce orders              │
│   - useCourierStore    courier reconciliation        │
│   - useIntegrationsStore  Paymob / shipping config   │
│   - useAuditStore      append-only audit trail       │
│   - useBranchStore     branches + assignments        │
│   - useCustomerStore   CRM                           │
│   - useBundleStore     product bundles               │
│   - useFeatureStore    toggles                       │
│   - useThemeStore      themes                        │
│   - useAuthStore       session + role + business     │
│                                                       │
└─────────────────────────┬────────────────────────────┘
                          │
                          │ (when cloud mode is enabled)
                          ▼
┌──────────────────────────────────────────────────────┐
│   Server layer (TanStack Start + Supabase)            │
│                                                       │
│   src/lib/api/                                        │
│   - financial.server.ts   (wallets, shareholders,    │
│                            stock logs, audit,        │
│                            courier, expenses)         │
│   - integrations.server.ts (Paymob/shipping/         │
│                              online order config)    │
│   - auth.server.ts         (RBAC permission guard)   │
│                                                       │
│   supabase/functions/                                │
│   - handle-subscription-webhook                       │
│   - handle-ecommerce-order   (HMAC-verified)         │
│   - handle-paymob-webhook     (placeholder HMAC)     │
│   - handle-shipping-webhook   (HMAC-verified)         │
│                                                       │
└─────────────────────────┬────────────────────────────┘
                          │
                          ▼
              Supabase (PostgreSQL 15+)
              - online_orders, integrations
              - branches, users, audit_log
              - paymob_transactions
              - (extends the existing schema.sql /
                schema-financial.sql /
                schema-rbac-audit-integrations.sql)
```

### Feature flags drive every optional behavior

`useFeatureStore` holds persisted booleans for:

- `returnsEnabled` — Returns & exchanges hub
- `shippingTrackingEnabled` — Courier ledger & status updates
- `salesCommissionsEnabled` — Sales rep commissions
- `ecommerceSyncEnabled` — Online order intake (placeholder slot)
- `depositMandatory` — Force deposit input before order submit

Plus the existing `businessMode` (retail / e-commerce / omnichannel)
in `useAuthStore` hides irrelevant navigation items via
`getEffectiveVisibleNavRoles()`.

### Settings / integrations panel

Path: `/integrations`

- Top banner explains these are wire-it-yourself placeholders
- Live indicator of offline / cloud mode
- "Manual fallback" card lists the screens that work without any
  integration (so the buyer can verify the product works standalone)
- Per-integration card with toggle, fields, activation steps, env
  vars, masked secrets, reset, docs link
- "Test Connection" honestly says "حفظ وتحقق من اكتمال الحقول" —
  it only validates field shape, never calls the network
- Audit log tab shows every config change with actor + role + branch

---

## RBAC (role-based access control)

Nine roles are supported. The original four (`owner` / `cashier` /
`data_entry` / `cashier_data_entry`) continue to work everywhere. The
five new roles project onto the original four for permission purposes
(see `src/lib/permissions.ts`):

| Role | What they see |
|---|---|
| `owner` | Everything |
| `branch_manager` | Everything, scoped to their branch (UI filter) |
| `cashier` | POS, products, returns, preferences |
| `data_entry` | E-commerce orders, returns, CRM, products |
| `cashier_data_entry` | Both cashier + data entry |
| `inventory_clerk` | Inventory, purchasing, products, branches |
| `accountant` | Partners / finance, inventory read-only, reports |
| `customer_support` | Orders, CRM, returns, reports |
| `viewer` | Read-only version of owner (UI strips write buttons) |

Permissions are enforced on the server via
`src/lib/api/auth.server.ts::requirePermission()`. Every sensitive
server function checks the role before executing.

---

## File map (where to look)

```
src/
├── store/                 13 Zustand stores (persisted)
├── lib/
│   ├── permissions.ts     RBAC permission matrix
│   ├── math.ts            Decimal-safe arithmetic
│   ├── pdfGenerator.ts    3 PDF report generators
│   ├── supabase.ts        Lazy Supabase client (offline-safe)
│   ├── settingsStore.ts   Tiny settings helper
│   └── api/               Server functions (TanStack Start)
├── components/
│   ├── integrations/      3 cards + main settings panel
│   ├── finance/           Partners, Capital, StockAudit, ProfitDashboard
│   ├── ecommerce/         Orders, Bundles, CRM, Discounts, CourierLedger
│   ├── inventory/         InventoryTable
│   ├── products/          ProductsPage, BulkImportProduct
│   ├── purchasing/        PurchasingPage
│   ├── wholesale/         WholesalePage
│   ├── sales/             CheckoutForm (POS)
│   ├── shipping/          ShippingSelector, ShippingTariffManager
│   ├── layout/            Layout (sidebar + topbar)
│   ├── auth/              RoleGuard, ProtectedRoute, DevRoleSwitcher
│   ├── dashboard/         Sidebar, KpiCards, ProfitChart…
│   └── ui/                shadcn-style primitives
├── routes/                React Router file-based pages
└── types/index.ts         All shared types (snake_case → DB columns)

server/db/
├── schema.sql                       Products, orders, returns
├── schema-financial.sql             Wallets, shareholders, stock logs
└── schema-rbac-audit-integrations.sql  Branches, users, audit_log, integrations, paymob_transactions

supabase/functions/
├── handle-subscription-webhook      (existing)
├── handle-ecommerce-order           HMAC-verified intake
├── handle-paymob-webhook            placeholder HMAC
└── handle-shipping-webhook          HMAC-verified status updates
```

---

## Build, run, deploy

```bash
# Local development (no internet required)
npm install
npm run dev          # opens on http://localhost:8080 in Chrome

# Production build
npm run build

# When you want to enable cloud mode:
# 1. Create a Supabase project
# 2. Run the 3 SQL files in server/db/ in order
# 3. Set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY in .env
# 4. Deploy the Edge Functions in supabase/functions/
# 5. Set OPERATION_MODE=cloud_sync in .env
```

---

## What the buyer does NOT need

- A Paymob account (until they want to accept online card payments)
- A shipping carrier API (until they want automated status updates)
- An online storefront (until they want auto-ingest)
- A real website of any kind

The product ships with everything they need to run a real retail or
e-commerce business today. External integrations are an upgrade, not
a prerequisite.
