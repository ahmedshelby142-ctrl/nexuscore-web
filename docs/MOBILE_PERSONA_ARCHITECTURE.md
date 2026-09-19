# NEXUS CORE Mobile — Persona Architecture & Data Authority Matrix

Status: **architecture only.** Nothing in the Owner or Moderator sections below is
implemented. This document exists so that when it is, every number already has an
owner and nobody has to invent a second formula under deadline.

Last verified against the live database (`oczgqpxeixlrufvevitz`, store
`QA-STORE (disposable)`) on 2026-09-15.

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
| Sales / revenue | `revenue` ledger account | ➖ |
| COGS | `cogs` ledger account | ➖ |
| Expenses | `expense` events | ➖ |
| Net profit | revenue − COGS − expenses, over the ledger | ➖ |
| Cash / wallet | `wallet` account per `WalletType` | ➖ |
| Courier receivable | `receivable_courier`, by `courierId` | ➖ |
| Courier payable | `payable_courier` | ➖ |
| Supplier payable | `payable_supplier`, by supplier id | ➖ |
| Wholesale receivable | `receivable_trader` | ➖ |
| Inventory value | `SUM(stock.amount_delta)` | ➖ |
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

`ADMIN` · `ACCOUNTANT` · `POS_ECOMMERCE` · `ECOMMERCE_ONLY`
(`store_members_role_check` enforces exactly these four.)

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

### Smallest change that works — NOT implemented

1. Add `"MODERATOR"` to `AppRole` in `src/lib/roles.ts`, with `ROUTE_ACCESS`
   entries for `/orders`, `/inventory`, `/crm`, `/preferences`, and
   `ROLE_HOME → "/orders"`.
2. One migration: extend `store_members_role_check` with `'MODERATOR'`, and add
   `'MODERATOR'` to the `has_role` array inside `mobile_shortages`.
3. **No SELECT policy change.** Every read the Moderator needs — `orders`,
   `products`, `customers`, `couriers`, `ledger_lines` — is gated on
   `is_store_member(store_id)`, not on role. Read access comes with membership.
4. **No write policy change, deliberately.** `write_orders`, `write_products`,
   `write_customers`, `write_suppliers` and `write_purchase_invoices` are
   `has_role(...)` lists that will not contain `MODERATOR`. The role is
   therefore read-only **at the database**, not merely in the UI — which is the
   property the persona actually requires, and it costs nothing.

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
| wholesale receivable | `receivable_trader` | ➖ | `ledger_lines` | — | ➖ |
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
