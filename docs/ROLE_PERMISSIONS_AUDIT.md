# NEXUS CORE — Role Permissions + Data Visibility Audit

**2026-09-27, from HEAD `5cf4434`.** Built from the live code and the live
database (`oczgqpxeixlrufvevitz`, read-only catalog queries), not from older
documents. Focus: **MODERATOR**, the operations supervisor.

The rule applied throughout: *selling* figures (price, order total, COD,
shipping fee, deposit) are operational; what the shop **paid** (unit cost,
stock value, COGS, margin, profit, courier commission, supplier and wallet
money) is the owner's and finance's.

---

## 1. Current role matrix

### Screens

| Module | ADMIN | ACCOUNTANT | POS_ECOMMERCE | ECOMMERCE_ONLY | MODERATOR |
|---|---|---|---|---|---|
| Desktop routes (`ROUTE_ACCESS`, `RequireAccess`) | all | /inventory /stock-audit /purchasing /partners /preferences | /pos /orders /ecommerce-orders /crm /returns /preferences | /orders /ecommerce-orders /returns /inventory /preferences | **/preferences only** |
| Mobile capabilities | all + المالية (owner) | stock, purchasing (+restock), preferences | orders, shipments, customers, preferences | orders, stock, shipments, preferences | **orders, stock, shipments, customers, preferences** |
| Owner financial summary (`owner_financial_summary`) | ✅ | ❌ 42501 | ❌ | ❌ | ❌ |

### Database writes (live RLS)

| Table / event | Roles allowed to write |
|---|---|
| orders, customers, return_records, discount_codes | ADMIN, POS_ECOMMERCE, ECOMMERCE_ONLY |
| products (definition columns guarded to ADMIN/ACCOUNTANT) | ADMIN, ACCOUNTANT (+ UPDATE of non-definition columns: POS, ECOM) |
| purchase_invoices, suppliers, expenses, transactions, wholesale_*, shipping_rates, branches | ADMIN, ACCOUNTANT |
| couriers | ADMIN |
| courier_claims | ADMIN, ACCOUNTANT |
| ledger `purchase`, `stock_adjustment`, `supplier_payment`, `expense`, `payroll`, `owner_draw`, `wallet_transfer`, `deposit_refunded` | ADMIN, ACCOUNTANT |
| every other ledger kind | ADMIN, POS_ECOMMERCE, ECOMMERCE_ONLY, ACCOUNTANT |
| ledger UPDATE / DELETE | nobody (append-only) |
| store_members, stores | ADMIN |
| store_licenses | nobody (System Owner RPCs, `42501` otherwise) |

**MODERATOR appears in no write policy and no write RPC.** Every create,
update, delete and financial mutation is refused by the database.

### Database reads (live RLS) — the root finding

Every SELECT policy on every public table is `is_store_member(store_id)`, with
no role predicate: ledger_lines, ledger_events, orders, products, customers,
expenses, transactions, purchase_invoices, suppliers, wholesale_invoices,
wholesale_clients, courier_claims, couriers, discount_codes, shipping_rates,
branches, return_records, store_members. `ledger_balances` and
`ledger_events_page` are SECURITY INVOKER, so they return whatever those
policies allow. **A Moderator's own token can therefore read every financial
row in its store** — see §6.

---

## 2. MODERATOR = OPERATIONS SUPERVISOR

**Can see:** orders (number, status, customer, phone, address, products,
quantities, selling price, total, discount, shipping fee, deposit, COD,
courier, payment/settlement status, timeline); stock quantity, reorder level,
low-stock/shortage status, variants, SKU, barcode; shortages with demand and
affected orders; shipments and their status; customers, their order history
and open COD.

**Cannot see (UI and app state, after this change):** unit cost, weighted
average cost, stock value, margin, COGS, courier commission, profit, owner
financials, wallet balances, supplier/purchasing money, partner finance,
staff administration, licence administration, system settings.

**Can perform:** nothing that writes. Mobile is read-only for it; Quick
Restock, Purchasing and المالية are hidden and route-guarded.

---

## 3. Field-level audit (MODERATOR)

"Received" = in the payload its app requests. "Direct" = readable with its
token outside the app (the RLS finding).

| Entity | Field | Before | Now | Intended | Action |
|---|---|---|---|---|---|
| Order | number, status, customer, phone, address, lines, qty, unitPrice, total, discount, shippingFee, deposit, COD, courier, codSettledAt, timeline | received + shown | received + shown | ✅ visible | keep |
| Order | `cogsAmount` | **received** (`select *`) | not requested | ❌ | **fixed** (projection); direct: S-2 |
| Order | `courierFee` (courier commission) | received + **shown** «عمولة المندوب» | not requested, not shown | ❌ | **fixed**; direct: S-2 |
| Order line | `unitCost` in `items` / `stockItems` JSON | received, held in state | on the wire, **stripped** from app state | ❌ | **fixed** in app; wire: S-2 |
| Product | name, SKU, barcode, category, variants, unitPrice, wholesalePrice, minStockLevel | received + shown | same | ✅ | keep |
| Product | stock qty (ledger) | received + shown | same | ✅ | keep |
| Product | ledger stock **amount** (shelf cost) | received as `mobileCost`; **shown** as avg cost, stock value, margins | not held, not shown (RPC still returns it) | ❌ | **fixed** in app; wire: S-1 |
| Customer | name, phone, address, order history, open COD, counts | received + shown | same | ✅ | keep |
| Customer | delivered revenue (`customer_ltv`) | received + shown | same | revenue, not cost | **kept — business decision B-1** |
| Shipment | courier, status, delivery/return state, dates | received + shown | same | ✅ | keep |
| Supplier / purchase invoice | amounts, payables, balances | Mobile: not read (route-guarded); **realtime pushed invoice rows**; Desktop: **hydrated** | not subscribed, not hydrated | ❌ | **fixed** in app; direct: S-3 |
| Expense, transactions (partners) | all | Desktop **hydrated** | not hydrated | ❌ | **fixed** in app; direct: S-3 |
| Ledger / wallet / COGS / profit | all | Desktop none shown; Mobile owner route-guarded; `ledger_events` realtime rows delivered | unchanged (ledger_events cue kept) | ❌ | S-1 |
| Owner summary | all | refused by RPC (42501) | same | ❌ | already enforced |
| Staff | `list_store_members` (emails + roles) | callable by any member | same | ❌ admin data | S-5 |

---

## 4. Action permissions (MODERATOR)

| Action | UI | Database |
|---|---|---|
| create / edit / cancel order, return, exchange | not offered (no Desktop order screen; Mobile read-only) | DENIED (orders, return_records, ledger) |
| restock / purchase / supplier payment | hidden, `/restock` `/purchasing` guarded | DENIED (ledger `purchase`, `supplier_payment`; purchase_invoices) |
| courier settlement, wallet transfer, customer payment | not offered | DENIED (ledger kinds, courier_claims) |
| product / price / stock editing | not offered | DENIED (products, `stock_adjustment`) |
| employee management, settings, licence, backups | `/users` `/settings` `/backups` `/system-admin` not reachable | DENIED (store_members, stores, licence RPCs) |
| exports | the shift export is offline-local only; no Desktop business screen | n/a |
| preferences (theme, password) | ✅ allowed | own profile only |

No dangerous action is visible to a Moderator on either platform.

---

## 5. Fixed in this change (client / data minimisation)

| # | Defect | Fix |
|---|---|---|
| M-1 | Mobile Product Details showed unit cost, stock value and margins to MODERATOR, which Desktop never lets it see (it has no Desktop inventory) | `canViewCost(role)` in `lib/roles.ts`, shared by both platforms; tiles absent (not «٠») |
| M-2 | Mobile product readers handed MODERATOR the shelf's cost | `mobileCost` only for roles that may see cost |
| M-3 | Mobile order readers `select("*")` — `cogsAmount` to every role | explicit `ORDER_COLUMNS` (no `cogsAmount` for anyone — no mobile screen shows it); `courierFee` only for cost roles; line `unitCost` stripped for MODERATOR |
| M-4 | Order Details showed «عمولة المندوب» to MODERATOR | role-guarded, and not selected |
| M-5 | Desktop `hydrateAll` loaded **every** table (expenses, partner transactions, purchase invoices, supplier data, order COGS) into a MODERATOR browser whose only screen is `/preferences`; realtime kept pushing rows | `readsDesktopBusinessData(role)`; one gate in `cloudHydrate` (`hydrateAll` + `hydrateTable`) that also refuses reads before the membership role is resolved; Desktop realtime not subscribed for it |
| M-6 | Mobile realtime subscribed every role to `purchase_invoices` — the socket receives whole rows | table set per role (`realtimeTablesFor`); the channel is rebuilt when the verified role replaces a stale persisted one |

ADMIN, ACCOUNTANT, POS_ECOMMERCE and ECOMMERCE_ONLY keep exactly what they
had (pinned by tests), except that **no** mobile read carries `cogsAmount`
any more — it was never displayed.

---

## 6. SUPABASE NOTES FOR CLAUDE CODE (not applied)

The client changes shrink what the app **holds and shows**. They are not the
boundary: the Moderator's JWT can still read every row below directly. The
M3.2 audit (see `lib/ledger/ownerFinancials.ts`) chose not to narrow these
policies because operational roles read stock and customer totals through the
same tables. The plan below keeps those reads working. Apply in order, with
the deposit-boundary sequencing (server first, client, then tighten), each
step QA'd in a rolled-back transaction with simulated JWT claims per role.

### S-3 — financial tables no Moderator screen reads (safe, do first)

- **Tables:** `expenses`, `transactions`, `purchase_invoices`, `suppliers`,
  `wholesale_invoices`, `wholesale_clients`, `courier_claims`.
- **Exposure:** SELECT `is_store_member` → Moderator reads expenses, partner
  capital/draws, supplier payables, purchase and wholesale amounts.
- **Verified:** no Moderator Mobile reader touches them (Purchasing is
  route-guarded; realtime no longer subscribes it; Desktop no longer hydrates
  for it).
- **Change** (for each table `T`):
  ```sql
  ALTER POLICY select_T ON public.T
    USING (is_store_member(store_id) AND NOT has_role(store_id, 'MODERATOR'));
  ```
- **RLS implications:** every other role unchanged; realtime stops delivering
  those rows to Moderators too.
- **Regression:** per role, count visible rows before/after (ADMIN/ACCOUNTANT/
  POS/ECOM equal; MODERATOR 0); Mobile Purchasing and Desktop screens unchanged.

### S-1 — the ledger (needs RPCs first)

- **Tables/RPCs:** `ledger_lines` (amount_delta, unit_cost), `ledger_events`
  (payload: wallet, supplierName, amounts), `ledger_balances`,
  `ledger_events_page` (INVOKER).
- **Exposure:** Moderator reads every revenue, COGS, wallet, payable, owner
  draw and unit cost line; `ledger_balances(p_account='wallet')` returns
  treasury balances; `ledger_balances(p_account='stock')` returns shelf cost.
- **What the Moderator legitimately needs from the ledger:** stock **quantity**
  per product, the order timeline's event kinds and times, `customer_ltv`
  (pending B-1), and a "ledger changed" realtime cue.
- **Change:**
  1. Add SECURITY DEFINER RPCs, each checking `is_store_member(p_store)`:
     `mobile_stock_qty(p_store uuid, p_product_ids text[]) → (product_id, qty)`
     (no amount); `mobile_order_timeline(p_store uuid, p_order_number text) →
     (id, kind, occurred_at)` (no payload, no lines).
  2. Mobile readers use them when `!canViewCost(role)`.
  3. Then: `ALTER POLICY select_ledger_lines / select_ledger_events … USING
     (is_store_member(store_id) AND NOT has_role(store_id, 'MODERATOR'))`.
  4. Realtime cue for Moderators: `ledger_events` rows stop reaching them, so
     stock/shortage refresh needs another cue (e.g. a Broadcast from an
     `AFTER INSERT` trigger carrying only `store_id`), or the shortage
     screen's existing refresh on `orders`/`products` is accepted.
- **Regression:** Moderator Stock/Shortages/Product Details/Order timeline
  still correct; `ledger_balances` as Moderator returns 0 rows; ADMIN/
  ACCOUNTANT/POS/ECOM unchanged; `mobile_shortages` (already DEFINER) unchanged.

### S-2 — cost inside `orders`

- **Columns:** `cogsAmount`, `courierFee`, `stockItems[].unitCost`,
  `items[].unitCost`.
- **Exposure:** RLS cannot hide columns per app role (everyone is the
  `authenticated` Postgres role), and PostgREST cannot drop keys inside JSON.
- **Change options:** (a) a SECURITY DEFINER `mobile_orders_page(...)` that
  projects operational columns and strips `unitCost` with `jsonb` functions,
  used by Moderator readers, then exclude MODERATOR from `select_orders`; or
  (b) stop storing cost on the order (COGS already lives in the ledger) — a
  larger change touching the order screens and `place_order`.
- **Regression:** Moderator Orders/Shipments/Customer history/Home unchanged;
  other roles unchanged; 045/046 untouched.

### S-5 — staff list

- `list_store_members()` (DEFINER) returns every member's email and role to
  any member. Suggest `has_role(store, 'ADMIN')` inside it. Check the Desktop
  user-management screen is its only caller first.

### B-1 — business decision

Customer Details shows a Moderator the customer's delivered revenue
(`customer_ltv`). It is a selling figure, not cost, so it was kept. If the
business treats it as confidential, gate it with `canViewCost` (UI) and drop
it from the reader.

---

## 7. Tests

`scripts/check_moderator_visibility.mjs` — the real readers, hydrator, role
matrix and realtime table sets against stubbed Supabase/stores:

- Moderator: no `cogsAmount` / `courierFee` requested, no line `unitCost` in
  state, no `mobileCost`; operational order fields all still requested; stock
  quantity still received; Product/Order Details guards; exact Mobile
  capability set; not subscribed to `purchase_invoices`; Desktop hydrates
  nothing; nothing read before the role resolves; typed Desktop/Mobile URLs
  refused.
- ADMIN / ACCOUNTANT / POS_ECOMMERCE / ECOMMERCE_ONLY: cost visibility,
  Desktop hydration, route access and capabilities unchanged.

Mutation-checked: `canViewCost` always true, the hydration gate opened, and
`cogsAmount` put back in the projection each fail the suite.

Runtime (Mobile, stubbed backend, ADMIN vs MODERATOR, 11 routes): no cost
wording on any Moderator screen; `cogsAmount` never on the wire;
`courierFee` absent for Moderator, present for ADMIN; `/owner`
`/purchasing` `/restock` redirect for Moderator; Moderator socket subscribed
to orders/products/customers/ledger_events only.
