# NEXUS CORE Mobile — Persona Architecture & Data Authority Matrix

Status: **Moderator is implemented (M3.1, migration 033).** The Owner sections
are still architecture only. This document exists so that when they are built,
every number already has an owner and nobody has to invent a second formula
under deadline.

Last verified against the live database (`oczgqpxeixlrufvevitz`, store
`QA-STORE (disposable)`) on 2026-09-20.

---

## 1. The rule this whole document serves

> Mobile is not a small Desktop. It is a role-shaped cockpit over the **same**
> Supabase, the **same** ledger, and the **same** domain commands.

Concretely that means three prohibitions, in descending order of how expensive
they are to get wrong:

1. **No second formula.** If Desktop answers "what is this customer worth" with
   `SUM(customer_ltv)`, Mobile asks the same account. A mobile-only sum that
   agrees today will disagree the first time a partial return lands.
2. **No second write path.** Receiving goes through `commitReceipt`. There is no
   `mobileCommitReceipt`, and the moment there is, one of them stops getting the
   numbering fix.
3. **No invented metric.** A number nobody can source is omitted, not zeroed.
   `alertModel.ts` already encodes this: `undefined` means "no reader can answer
   this", `0` means "asked, and there are none". Rendering the first as the
   second is how a dashboard tells you everything is fine because nobody looked.

---

## 2. Persona A — Moderator (operational)

### The job

Reduce the number of times someone has to ask in the group chat. The Moderator
is not an accountant and not the owner; they are the person who can answer, from
a phone, in under thirty seconds:

| Question | Screen that answers it | Authority behind the answer |
|---|---|---|
| العميلة دي طلبت إيه؟ | Customer → Order History → Order Details | `orders` + `customer_ltv` |
| هل المنتج موجود؟ | Inventory / Product Details | `SUM(ledger_lines.qty_delta)` where `account='stock'` |
| هل الطلب ناقص؟ | Shortages | `mobile_shortages` RPC |
| الطلب وصل لفين؟ | Order Details → الخط الزمني | `ledger_events` (`ref_type='ecommerce_order'`) |
| مين شركة الشحن؟ | Order Details → الشحن والمندوب | `couriers` registry, keyed by `orders.courierId` |
| هل الشحنة اتسلمت؟ | Shipments / Order Details | `order_delivered` event |
| إيه المنتجات اللي ناقصة؟ | Shortages | `mobile_shortages` RPC |

### Surfaces

Orders · Order Details · Customers · Customer History · Inventory · Product
Details · Shortages · Shipments.

### Explicitly NOT

Profit analytics · supplier payments · financial settlement · business settings ·
member management · wholesale money · discount management.

### Home UX

Operational, in this order. No money anywhere on it.

1. **Orders requiring action** — pending/processing count, three most urgent
2. **Shortages** — products blocking open orders, deficit first
3. **In transit** — shipped, with courier and age
4. **Customer lookup** — a search field, not a list
5. **Shipment status** — by courier
6. **Quick search**

### Read-only

The Moderator mutates nothing until a specific operational mutation is proposed
and approved on its own merits. This is not a UI decision — see §4, where it
falls out of the database for free.

---

## 3. Persona B — Owner (business cockpit)

Owner is **ADMIN**. No new role, no widening: ADMIN already covers every
capability below, and it is the only role that does.

### Home UX — hierarchy, not a KPI grid

A grid of twelve tiles is a way of having no opinion about what matters. The
Owner home answers four questions in order, and every card drills into the rows
behind it.

1. **Critical alerts** — "فيه ٣ طلبات ناقصة"
2. **Money snapshot** — "عليك ١٢٬٤٠٠ ج.م للموردين" · "لك ٧٬٨٥٠ ج.م عند شركات الشحن" · "صافي الربح اليوم ٢٬٣٤٠ ج.م"
3. **Operations** — "٥ طلبات لم تُسلّم"
4. **Inventory / shortages**
5. **Supplier & courier attention**
6. **Quick actions**

Each card states a fact, then why, then the action. Never a number alone.

### Required readers, and whether they exist yet

`✅` = a Mobile reader exists and was verified. `➖` = the Desktop authority is
settled but Mobile has no reader; build the reader, never a formula.

| Owner metric | Authority | Mobile reader |
|---|---|---|
| Sales / revenue | `revenue` ledger account | ✅ `owner_financial_summary` |
| COGS | `cogs` ledger account | ✅ `owner_financial_summary` |
| Expenses | `expense` ACCOUNT (not the `expenses` table) | ✅ `owner_financial_summary` |
| Net profit | revenue − COGS − expenses, over the ledger | ✅ `owner_financial_summary` |
| Cash / wallet | `wallet` account per `WalletType` | ✅ `owner_financial_summary` |
| Courier receivable | `receivable_courier`, by `courierId` | ✅ `owner_financial_summary` |
| Courier payable | `payable_courier` | ✅ `owner_financial_summary` |
| Supplier payable | `payable_supplier`, by supplier id | ✅ `owner_financial_summary` |
| Wholesale receivable | `receivable_client` | ✅ `owner_financial_summary` |
| Inventory value | `SUM(stock.amount_delta)` | ✅ `owner_financial_summary` |
| Low stock | ledger qty vs `minStockLevel` | ✅ |
| Shortages | `mobile_shortages` RPC | ✅ |
| Returns / exchanges | `return_confirmed` / `rto_confirmed` events | ✅ (per order) |
| Discount usage | `discount_codes` + `claim_discount_use` | ➖ |
| Orders | `orders` | ✅ |
| Customers | `customers` + `customer_ltv` | ✅ |
| Purchases | `purchase_invoices` + `purchase` events | ➖ (written ✅, not read) |
| Supplier activity | `purchase` events by supplier | ➖ |
| Courier activity | `courier_settlement` events | ➖ |

---

## 4. Role / capability decision

### Current canonical roles

`ADMIN` · `ACCOUNTANT` · `POS_ECOMMERCE` · `ECOMMERCE_ONLY` · `MODERATOR`
(`store_members_role_check` enforces exactly these five since migration 033.)

### Capability matrix

| Capability (desktop path) | ADMIN | ACCOUNTANT | POS_ECOMMERCE | ECOMMERCE_ONLY | Moderator needs | Owner needs |
|---|---|---|---|---|---|---|
| orders `/orders` | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| stock `/inventory` | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| shipments (→`/orders`) | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| customers `/crm` | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ |
| shortages (RPC role gate) | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| purchasing / suppliers | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |
| financials `/partners` | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |
| courier ledger | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| wholesale · discounts | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| settings · users · branches | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

### Implemented matrix — MOBILE capability by role

Desktop access is unchanged by M3.1: `MODERATOR` is absent from every
`ROUTE_ACCESS` entry except `/preferences`, and no other role's entry moved.

| Mobile capability | ADMIN | ACCOUNTANT | POS_ECOMMERCE | ECOMMERCE_ONLY | MODERATOR |
|---|---|---|---|---|---|
| home · more | ✅ | ✅ | ✅ | ✅ | ✅ |
| orders (+ details) | ✅ | ❌ | ✅ | ✅ | ✅ |
| stock (+ product details) | ✅ | ✅ | ❌ | ✅ | ✅ |
| shortages | ✅ | ✅ | ❌ | ✅ | ✅ |
| shipments | ✅ | ❌ | ✅ | ✅ | ✅ |
| customers (+ details) | ✅ | ❌ | ✅ | ❌ | ✅ |
| purchasing · `/restock` | ✅ | ✅ | ❌ | ❌ | ❌ |
| preferences | ✅ | ✅ | ✅ | ✅ | ✅ |
| **any write** | ✅ | ✅ | ✅ | ✅ | **❌ (DB)** |

### Decision

**Owner = ADMIN.** Exists, fits, no change.

**Moderator = no existing role fits.** Each is short by exactly what matters:

- `POS_ECOMMERCE` — has orders, shipments, customers; **missing stock**, and it
  is also the one role the `mobile_shortages` RPC excludes.
- `ECOMMERCE_ONLY` — has orders, shipments, stock, shortages; **missing customers**.
- `ACCOUNTANT` — missing orders, shipments and customers. Wrong persona.
- `ADMIN` — fits by covering everything, including financial ownership and
  member management. Disqualifying.

Widening `ECOMMERCE_ONLY` to reach `/crm` is the tempting one-liner and it is
wrong: `ROUTE_ACCESS` is shared with Desktop, so it would silently open Desktop
CRM to every `ECOMMERCE_ONLY` member in every store.

### Smallest change that works — IMPLEMENTED (M3.1)

Points 3 and 4 held exactly as written. Point 1 did not, and the correction is
the most important line in this section.

1. `"MODERATOR"` is in `AppRole` / `APP_ROLES` in `src/lib/roles.ts`, but it is
   **NOT** in `ROUTE_ACCESS` for `/orders`, `/inventory` or `/crm`. Those three
   entries would have been the same widening this document rules out one
   paragraph above — `ROUTE_ACCESS` is what the DESKTOP sidebar and router read,
   so a `/crm` entry opens desktop CRM to the role, whoever it was added for.
   The Moderator gets `/preferences` and `ROLE_HOME → "/preferences"` on
   desktop, and its MOBILE surfaces are stated in
   `src/mobile/navigation/mobileCapabilities.ts` (`MODERATOR_CAPABILITIES`)
   instead. Mobile capability resolution is therefore split from desktop
   business-role authorization **for this role only**; the other four still
   project from `canAccess`.
2. Migration `033_moderator_role.sql`: `store_members_role_check` gains
   `'MODERATOR'`, and so does the `has_role` array inside `mobile_shortages`.
3. **No SELECT policy change.** Every read the Moderator needs — `orders`,
   `products`, `customers`, `couriers`, `ledger_lines`, `ledger_events` — is
   gated on `is_store_member(store_id)`, not on role. Read access comes with
   membership. Verified: 34 orders, 7 products, 8 customers, 1 courier, 489
   ledger lines and 167 ledger events readable in QA-STORE; 0 rows of any of
   them in the other tenant.
4. **No write policy change, deliberately** — but five write paths had to be
   *corrected* first, because they were gated on MEMBERSHIP and not on role, so
   "absent from every `has_role` list" was not yet enough:

   | Path | was | is |
   |---|---|---|
   | `insert_ledger_lines` | `is_store_member AND store_licensed` | `has_role(…four)` |
   | `update_products` | `is_store_member AND store_licensed` | `has_role(…four)` |
   | `claim_discount_use` | `is_store_member` | `has_role(…four)` |
   | `release_discount_use` | `is_store_member` | `has_role(…four)` |
   | `adjust_discount_total` | `is_store_member` | `has_role(…four)` |
   | `next_document_number` | `is_store_member` | `has_role(…four)` |

   `insert_ledger_lines` was the sharp one: `ledger_append` is SECURITY INVOKER
   and writes the header first, so the role gate on `insert_ledger_events`
   stops the RPC — but not a direct PostgREST insert of lines onto an event
   that already exists, which moves every balance that sums them.

   Each now lists the four roles that already held the write, so nothing
   changed for them (verified for all four against QA-STORE). `MODERATOR` is in
   none of them, and the role is read-only **at the database**, not merely in
   the UI — which is the property the persona actually requires.

### Verified refusals (QA-STORE, authenticated Moderator, 2026-09-20)

Every one returned `42501` or mutated 0 rows:

receiving (`purchase_invoices`) · `ledger_append` for stock adjustment, supplier
payment and courier settlement · a bare `ledger_lines` append · `products`
(stock mirror) · `orders` · `customers` · `suppliers` · `transactions` ·
`expenses` · `couriers` · `store_members` (insert and self-promotion) ·
`store_licenses` (insert and extension) · `next_document_number` ·
`claim_discount_use` · `admin_list_stores` · `admin_extend_license` ·
every store-B read and write. `is_system_owner()` → `false`.

### Mobile

Bottom nav: الرئيسية · الطلبات · المخزون · المزيد. العملاء، الشحنات and
الإعدادات live in المزيد. `/restock` and `/purchasing` are behind the
`purchasing` capability the role does not hold, so a deep link to either
redirects to home, and the توريد buttons on المخزون and النواقص are not drawn
for a role that cannot buy.

### M3.2.1 — the secure financial foundation (implemented)

The Owner cockpit UI is still unbuilt. What exists is the foundation under it.

**One dated aggregation, and it casts.** `ledger_events.occurred_at` is a `text`
column and `driver.balances` compared it as text with `from.toISOString()`. The
table holds two spellings of one instant — `2026-09-12T14:18:07.675Z` and
`2026-09-12 14:18:07.675957+00` — and `' ' < 'T'`, so a Postgres-style row sorts
below the `...T00:00:00Z` bound of its own day. It was therefore dropped from
its own day AND pulled into the previous one. Live, for 2026-09-12: 308.00 EGP
of revenue where the timestamps mean 3,100.00, and 14 events in the wrong
bucket. `ledger_balances` (migration 034) casts `occurred_at::timestamptz` once
in SQL and every dated read goes through it. No timezone convention was
invented: all rows carry an explicit offset, the database is UTC, and the
bounds already arrive as instants. Lifetime reads are byte-identical to before.

**Owner money is ADMIN-gated at the reader, not at the table.** Every financial
SELECT policy is `is_store_member(store_id)`; a MODERATOR reads every revenue,
cogs, wallet and payable line in its own store. Those policies are deliberately
UNCHANGED — `customer_ltv`, stock and shortages run through the same tables for
the Moderator certified in M3.1. The restricted surface is
`owner_financial_summary`, which independently verifies an authenticated
caller, membership of the store it was handed, and the `ADMIN` role there, and
returns only the audited metrics. `p_store` is checked against the caller's own
membership, so changing it cannot widen anything. There is no "read every
ledger row" RPC.

**Store Owner is not System Owner.** The Owner persona is `ADMIN` of one store.
The System Owner is a global identity from an email allowlist in
`is_system_owner()`, holds no store membership and no store data rights, and is
explicitly NOT accepted by this reader.

**ACCOUNTANT is refused here** and keeps every financial screen it already has
on Desktop, which reads through the unchanged `useBalances` path. Nothing was
taken away.

**`grossProfit` is `revenue − cogs`, defined once** in `pnl()`
(`src/lib/ledger/reports.ts`). The SQL reader performs the same subtraction
over the same two accounts. No screen may re-derive it.

**Lifetime and period are different questions.** Wallet balances, supplier
payable, courier balances, stock value and `receivable_client` are POSITIONS
and ignore the window. Revenue, COGS, expenses, returns and sales-by-channel
are FLOWS and take it. Enforced in SQL.

**Absent, never zero.** Owner draw, capital/equity, wallet transfers and every
period-over-period comparison are omitted from the payload — `owner_budget`
holds 0 lines, `owner_draw` and `wallet_transfer` 0 events, and the ledger is
three weeks old. A `0` would read as "asked, and there are none".

**Sources the P&L must never use:** the `transactions` table (0 rows), the
`expenses` table (1,050.00 EGP against the `expense` account's 3,831.43 — it
holds only manually-entered expenses and misses shrinkage, shipping penalties
and payroll), and the `orders` table.

---

## 5. Owner purchasing / supplier cockpit — NOT implemented

Not a list of invoices. A screen that answers "what do I buy, from whom, and
what do I already owe them."

### Per supplier

Name · phone · WhatsApp · address · total payable · unpaid invoices · recent
purchases · last purchase date · products supplied · purchase frequency ·
outstanding amount · recent returns · notes.

Actions: اتصال · واتساب · فتح المورد · عرض الفواتير · تسجيل دفعة · شراء من المورد.

WhatsApp uses `suppliers.phone` and nothing else. No contact data is invented,
guessed, or derived; a supplier with no phone shows no WhatsApp action.

### Authorities

| Field | Source |
|---|---|
| identity, phone, address | `suppliers` |
| total payable | `SUM(payable_supplier)` for that supplier id |
| invoices, unpaid, last purchase | `purchase_invoices` |
| purchase history, last unit cost | `purchase` events + their `unit_cost` lines |
| returns | `purchase` events with `ref_type='supplier_return'` |

### Decision support

Join, never invent:

```
shortage (mobile_shortages)
  → "غسول سيرافي ناقص ٨ وحدات لتغطية الطلبات المفتوحة"
who supplied it (purchase events for that product)
  → "آخر شراء من المورد X بسعر ١٠٠ ج.م"
what is owed (payable_supplier)
  → "عند المورد ٣ فواتير مفتوحة بإجمالي ٢٬٤٠٠ ج.م"
→ actions: واتساب · فتح المورد · شراء · تسجيل دفعة
```

Every line is a stored fact. No recommendation engine, no predicted demand — if
a claim cannot be traced to a row, it does not appear.

### Purchase / receive from Mobile

Must use `commitReceipt` / `executeQuickRestock` unchanged. What exists today is
the **cash** path only. Credit and partial payment are not implemented on Mobile
and must not be re-implemented there when they are:

| Mode | stock | wallet | payable_supplier |
|---|---|---|---|
| cash (exists) | ↑ | ↓ | unchanged |
| credit (to build) | ↑ | unchanged | ↑ |
| partial (to build) | ↑ | ↓ by paid | ↑ by remainder |

`commitReceipt` already takes `paidAmount` and splits on it — quick restock just
passes `Infinity`. The credit and partial modes are a **form**, not a second
command.

---

## 6. Data authority matrix

`Verified` means checked against the live database during authenticated QA, not
inferred from the code.

| Metric | Desktop authority | Mobile reader | Supabase source | Ledger source | Verified |
|---|---|---|---|---|---|
| stock | `getActualStock` → ledger | `balanceOf("stock", id)`, floored at 0 | `ledger_lines` | `account='stock'` | ✅ ledger 17 ≠ `products.quantity` 24 |
| bundle availability | `bundleAvailableStock` → `buildableFromRecipe` | same `buildableFromRecipe` + `variantStockFrom` | `products.bundleItems` | component `stock` | ✅ rendered 8, then 11 after +5 |
| variant stock | `getVariantStock` → `variantStockFrom` | `variantStockFrom` | `products.metadata.variants` | clamped to `stock` | ✅ one shared clamp |
| customer LTV | `useBalances("customer_ltv")` | `balanceOf("customer_ltv", id)` | `ledger_lines` | `account='customer_ltv'` | ✅ 1500.00 both |
| wasted trips | `customers.returned_orders_count` | same column | `customers` | — (a debt, not a history) | ✅ |
| customer order count | derived from `orders` | derived from `orders` | `orders.customerId` | — | ✅ |
| order timeline | order ledger events | `events({refType:'ecommerce_order', refId: orderNumber})` | `ledger_events` | kinds | ✅ 4 events, right order |
| shipment COD | `orders.expectedCod` | `orders.expectedCod` | `orders` | — | ✅ 400.00 |
| courier identity | `couriers` registry via `courierId` | `readMobileCouriers()` | `couriers` | — | ✅ name + phone |
| shortages | — | `mobile_shortages` RPC | `orders` + `ledger_lines` | `account='stock'` | ✅ `required − stock`, no flag |
| supplier payable | `payable_supplier` | written via `commitReceipt` | `ledger_lines` | `account='payable_supplier'` | ✅ unchanged on cash buy |
| wallet | `wallet` account | written via `commitReceipt` | `ledger_lines` | `account='wallet'` | ✅ −500 on a 500 buy |
| purchase history | `purchase_invoices` + `purchase` events | ➖ no reader | `purchase_invoices` | `kind='purchase'` | write ✅ / read ➖ |
| courier receivable | `receivable_courier` | ➖ | `ledger_lines` | — | ➖ |
| courier payable | `payable_courier` | ➖ | `ledger_lines` | — | ➖ |
| wholesale receivable | `receivable_client` | `owner_financial_summary` | `ledger_lines` | `account='receivable_client'` | ✅ |
| revenue | `revenue` | ➖ | `ledger_lines` | — | ➖ |
| COGS | `cogs` | ➖ | `ledger_lines` | — | ➖ |
| expenses | `expense` events | ➖ | `ledger_events` | — | ➖ |
| net profit | revenue − COGS − expenses | ➖ | — | — | ➖ |
| discount usage | `claim_discount_use` | ➖ | `discount_codes` | — | ➖ |

A `➖` row is a missing reader, not a missing authority. Building one means
pointing at the column named here — never deriving a new number.

---

## 7. Open shared-core item

`driver.append` writes `ledger_events` then `ledger_lines` in two calls. When the
second fails there is nothing to compensate with: `no_delete_ledger_events` is
`USING (false)`, so the header cannot be removed. Proven by forcing that exact
failure — the header survived.

The gap is inert (every balance is `SUM(ledger_lines)`, so a line-less header
moves nothing, and `appendEvent` already treats one as legitimate for
`order_returned_pending`) but it is real. The fix is to stop needing
compensation:

```sql
create or replace function public.ledger_append(p_event jsonb)
returns uuid
language plpgsql
security invoker            -- RLS still applies; this only makes it ATOMIC
as $$ ... insert header; insert lines; return id; $$;
```

One transaction, one refusal, nothing half-written. `driver.append` is the only
caller, so it is a contained change — but it is a migration against the
certified core and is left for explicit approval.
