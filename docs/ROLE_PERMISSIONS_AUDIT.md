# NEXUS CORE — Role Permissions + Data Visibility Audit

> **Status:** client-side minimisation `a331d08`; server-side read security (S-1/S-2/S-3/S-5) **FIXED** by migrations 047 + 048, in production — §6.

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
policies allow. **A Moderator's own token could therefore read every financial
row in its store.** **FIXED 2026-09-27 by migrations 047 + 048** — see §6.

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

## 6. SERVER-SIDE READ SECURITY — S-1 / S-2 / S-3 / S-5 FIXED (2026-09-27)

Migrations **047** (additive) and **048** (restrictive), both **applied to
production** (`oczgqpxeixlrufvevitz`) and recorded in
`supabase_migrations.schema_migrations`. The database is now the boundary: a
Moderator's own JWT, through the ordinary authenticated client, cannot read
the rows below. No historical row was modified; writes, 043–046 and every
other role's reads are unchanged.

### Root cause

Every SELECT policy was `is_store_member(store_id)` — "any member of the
store". `ledger_balances` / `ledger_events_page` are SECURITY INVOKER over
those policies; `list_store_members()` (DEFINER) returned every colleague's
email and role to any member. Measured before the fix (rolled back), as
MODERATOR: 500 ledger lines (111 with `unit_cost`), 5 wallet balances via
`ledger_balances`, 34 orders with `cogsAmount` and line `unitCost`, 2
expenses, 12 purchase invoices, 1 supplier, 5 wholesale invoices, 20 return
records, 7 discount codes, 2 staff emails — identical to ADMIN.

### The predicate

`can_read_store_finance(store)` (047) = `member_role(store) ∈ {ADMIN,
ACCOUNTANT, POS_ECOMMERCE, ECOMMERCE_ONLY}`. An explicit allow-list: MODERATOR
and any role this build does not know are outside it. Built on `member_role`,
not `has_role`, because `has_role` also requires a live licence — `NOT
has_role(…,'MODERATOR')` would reopen the ledger to a Moderator the day a
licence lapses (tested: still 0 with the licence expired).

### S-1 — ledger (FIXED)

- `select_ledger_lines`, `select_ledger_events` → `can_read_store_finance`.
  `ledger_balances` / `ledger_events_page` follow automatically.
- Operational replacements (047), SECURITY DEFINER, **no store argument**
  (store = the caller's own membership), `anon` revoked:
  `mobile_stock_quantities(product_ids) → (product_id, qty)` — the same
  quantity `ledger_balances('stock')` reports, no amount;
  `mobile_order_timeline(order_number) → (id, kind, occurred_at)` — no
  payload, no lines.
- `mobile_shortages` (DEFINER) and `owner_financial_summary` (ADMIN-only)
  unchanged.

### S-2 — order cost (FIXED)

- `select_orders` → `can_read_store_finance`: a Moderator cannot select the
  table, so `cogsAmount`, `courierFee` and JSON `unitCost` are unreachable.
- `orders_operational` (047) is the Mobile order read for every role: the
  same rows (its own `WHERE is_store_member(store_id)`, `security_barrier`),
  `cogsAmount` absent for everyone, `courierFee` and line `unitCost` present
  only for `can_read_store_finance`. Historical JSON is not rewritten —
  `strip_line_cost` drops the key on the way out. Desktop and every write
  keep using `orders`.
- **Accepted advisor finding:** Supabase flags `orders_operational` as a
  *security definer view* (ERROR level). That is the design — the view must
  read `orders` with its owner's rights because the Moderator no longer can —
  and it is safe because its own WHERE applies the tenant check and
  `security_barrier` stops caller filters running first. Proven: foreign
  ADMIN 0 rows, `anon` 42501.

### S-3 — financial / business tables (FIXED)

`select_*` → `can_read_store_finance` on `expenses`, `transactions`,
`purchase_invoices`, `suppliers`, `wholesale_invoices`, `wholesale_clients`,
`courier_claims`, `return_records`, `discount_codes`. Proven unused by any
Moderator reader: no Mobile reader touches them (Purchasing is route-guarded;
Desktop hydrates nothing for MODERATOR since `a331d08`). Realtime obeys the
same RLS, so these rows no longer reach a Moderator socket either.
`products`, `customers`, `couriers`, `shipping_rates`, `branches`, `stores`,
`store_licenses` stay member-readable (operational, no cost columns).

### S-5 — staff directory (FIXED)

- `list_store_members()` → only for the store's ADMIN (`member_role`);
  `anon` revoked.
- `select_store_members` → `user_id = auth.uid() OR member_role = 'ADMIN'`.
  Every client read of the table is the caller's own row (login, session
  reconciliation, store context); invite/re-role/remove are ADMIN paths;
  `invite-staff` checks with `staff_invite_context` and writes as the caller
  (INSERT, unaffected). `has_role` / `is_store_member` / `member_role` are
  DEFINER and unaffected.

### Realtime

`postgres_changes` delivers whole rows, so a subscription is a read. Mobile no
longer subscribes to `orders` or `ledger_events` for any role: it listens to
`store_activity` (047) — `(store_id, source, created_at)`, written only by
AFTER triggers on `orders` and `ledger_events` (DEFINER, no EXCEPTION block —
043), member-readable, not client-writable, pruned to one hour — and turns
each row's `source` into the same cue the screens already used. Moderator
socket: `products`, `customers`, `store_activity`. Purchasing roles add
`purchase_invoices`.

### Role matrix (after 048, measured in production)

| Data area | ADMIN | ACCOUNTANT | POS_ECOMMERCE | ECOMMERCE_ONLY | MODERATOR |
|---|---|---|---|---|---|
| Ledger financial rows | ALLOW | ALLOW | ALLOW | ALLOW | **DENY** (0) |
| Stock quantity | ALLOW | ALLOW | ALLOW | ALLOW | **MINIMAL PROJECTION** (`mobile_stock_quantities`) |
| Product cost / stock value | ALLOW | ALLOW | ALLOW | ALLOW | **DENY** |
| Order cost (cogsAmount, courierFee, line unitCost) | ALLOW | ALLOW | ALLOW | ALLOW | **DENY** |
| Expenses | ALLOW | ALLOW | ALLOW | ALLOW | **DENY** (0) |
| Supplier finance (suppliers, purchase invoices) | ALLOW | ALLOW | ALLOW | ALLOW | **DENY** (0) |
| Courier finance (courier_claims) | ALLOW | ALLOW | ALLOW | ALLOW | **DENY** (0) |
| Owner finance (`owner_financial_summary`) | ALLOW | DENY (42501) | DENY | DENY | DENY (42501) |
| Member emails / roles | ALLOW | own row only | own row only | own row only | own row only |
| Orders operational fields | ALLOW | ALLOW | ALLOW | ALLOW | **MINIMAL PROJECTION** (`orders_operational`) |
| Order timeline | ALLOW | ALLOW | ALLOW | ALLOW | **MINIMAL PROJECTION** (`mobile_order_timeline`) |
| Shipments (orders status/courier/COD) | ALLOW | ALLOW | ALLOW | ALLOW | MINIMAL PROJECTION |
| Customers operational fields | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW |

ACCOUNTANT / POS / ECOMMERCE_ONLY lost only the colleague directory, which no
screen of theirs reads (the staff screen is ADMIN-only).

### QA and production evidence

`scripts/security/047_048_read_matrix.sql`, every probe through the caller's
JWT (`set local role authenticated` + `request.jwt.claims`), rolled back:

| Probe | ADMIN | ACC | POS | ECOM | MOD |
|---|---|---|---|---|---|
| ledger_lines | 501 | 501 | 501 | 501 | **0** |
| ledger_balances wallet | 5 | 5 | 5 | 5 | **0** |
| orders (table) | 35 | 35 | 35 | 35 | **0** |
| orders_operational | 35 | 35 | 35 | 35 | 35 |
| … with line unitCost / courierFee | 35 / 35 | 35 / 35 | 35 / 35 | 35 / 35 | **0 / 0** |
| mobile_stock_quantities | 6 | 6 | 6 | 6 | 6 |
| … qty ≠ ledger_balances | 0 | 0 | 0 | 0 | — |
| mobile_order_timeline | 90 | 90 | 90 | 90 | 90 |
| expenses / purchase_invoices / suppliers | 2/12/1 | 2/12/1 | 2/12/1 | 2/12/1 | **0/0/0** |
| wholesale / returns / discount codes | 5/20/7 | 5/20/7 | 5/20/7 | 5/20/7 | **0/0/0** |
| list_store_members | 2 | 0 | 0 | 0 | **0** |
| owner_financial_summary | ✓ | 42501 | 42501 | 42501 | 42501 |
| insert into store_activity | — | — | — | — | 42501 |

Also: MODERATOR with the licence expired — ledger 0, expenses 0. Foreign
store's ADMIN — 0 on every QA-STORE surface. `anon` — 42501 on the view, both
functions, the ledger, `store_activity`, `list_store_members`. `place_order`
still succeeds with the triggers in place and emits one `orders` and one
`ledger_events` signal. The same matrix re-run against production after
apply gave the same numbers (34→35 orders includes the rolled-back probe
order); afterwards 0 QA rows, POS role and licence unchanged.

**Mutation (real database, rolled back):** reverting each protection alone
brought back exactly its exposure — ledger policy → 500 lines; expenses
policy → 2 rows; view without the line strip → 34 orders with unitCost;
staff list for any member → 2 emails.

### B-1 — resolved

A Moderator no longer receives a customer's lifetime revenue: the reader
does not ask (`customer_ltv` is ledger, 048 refuses it), and Customer Details
omits the tile rather than showing «٠».

### Remaining (not in this phase)

- Pre-existing advisor warnings: `has_role`, `is_store_member`,
  `member_role`, the discount RPCs and two trigger functions are executable by
  `anon` (they answer false/refuse without a session); Leaked Password
  Protection is off in Auth settings.
- `products`, `customers`, `couriers` stay readable by every member,
  including Moderator — operational by design.
- The Mobile PWA still has no production deployment (Mobile audit P0-1), so
  the new Mobile client paths are verified by tests and the stubbed-backend
  harness, not yet by a deployed Mobile build.

---

## 7. Tests

Server-side (047/048): `scripts/check_read_security_048.mjs` (19 — the
predicate is an allow-list on `member_role`, the twelve policies, no
`USING (true)`, the view's projection and tenant WHERE, no-store-argument
functions, the signal table, the staff directory, writes untouched; each
critical predicate mutation-checked) and `scripts/security/047_048_read_matrix.sql`
(live, rolled back — §6). Client (`check_moderator_visibility.mjs`, now 18):
every Mobile order read goes through `orders_operational`; a Moderator's stock
comes from `mobile_stock_quantities` and never from the ledger; the timeline
from `mobile_order_timeline`; lifetime revenue is null, not 0; the socket
hears orders/ledger only through `store_activity`.


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
