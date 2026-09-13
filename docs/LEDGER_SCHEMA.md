# NexusCore — Ledger Schema & Tenancy Contract

> Phase 1, step 1–2. This document is the contract the ledger code is written
> against. If code and this document disagree, one of them is a bug.

---

## 1. The one rule

**No number is stored. Every number is `SUM()`.**

Two kinds of table exist:

| Kind | Tables | Mutability |
|---|---|---|
| Events | `ledger_events`, `ledger_lines` | Append-only, enforced by the database |
| Reference | `products`, `customers`, … (step 3) | Mutable, Last-Write-Wins on `updated_at`, soft-deleted via `deleted_at` |

Stock, wallet balances, supplier debt, courier receivables, customer LTV and COGS
are **not columns anywhere**. They are aggregations over `ledger_lines`.

---

## 2. Money is stored as integer piastres

`amount_delta` and `unit_cost` are `INTEGER`, in **piastres (قرش)**, not pounds.

SQLite has no decimal type. Storing EGP as `REAL` accumulates float error across
`SUM()` over tens of thousands of rows, and makes `balance = 0` comparisons
unreliable. The brief requires the Owner Budget to account for *كل مليم* — that
demands exact arithmetic.

Conversion happens in exactly one place, the TypeScript driver boundary
(`toPiastres` / `fromPiastres`). Nothing above the driver ever sees piastres, so
the rest of the app keeps working in EGP as it does today.

`qty_delta` stays `REAL` — fractional quantities (kg, metres) are legitimate.

---

## 3. Append-only is enforced by the database, not by convention

### SQLite side
`BEFORE UPDATE` and `BEFORE DELETE` triggers on both `ledger_events` and
`ledger_lines`.

`DELETE` is always rejected. `UPDATE` is rejected unless the only columns that
changed are:

- `sync_status` — `pending` → `synced` / `conflict`
- `reversed_by` — pointing at the correcting event
- `store_id` — **only** during tenancy reconciliation (§5), which can only run
  while the row has never been synced

Every other column is immutable. A mistake is corrected by appending a reversal
event, never by editing history.

### Supabase side
`ledger_events` and `ledger_lines` get **`SELECT` and `INSERT` policies only**.
No `UPDATE` policy, no `DELETE` policy. A client that tries either is refused by
Postgres regardless of what the client code believes.

`store_id` re-tagging never happens server-side — see §5, it is a purely local,
pre-sync operation — so the absence of an `UPDATE` policy costs nothing.

---

## 4. Atomicity: one Rust command, one `sqlx::Transaction`

`tauri-plugin-sql` executes each statement against a connection taken from a
pool. Two `db.execute()` calls are **not** guaranteed to land on the same
connection, which means `BEGIN` in one call and `COMMIT` in another may apply to
different connections and silently fail to be a transaction.

A half-written event — a header with some of its lines — is invisible corruption:
it would never throw, it would just make stock or a wallet permanently wrong.
That is not a place to gamble on pool behaviour.

Therefore **all ledger writes go through one Rust command, `ledger_append`**,
which opens a single `sqlx::Transaction` and writes the event header and every
one of its lines inside it. Any error rolls the whole thing back.

`tauri-plugin-sql` is still used for the read path (aggregation `SELECT`s) and,
later, for reference-table writes, where no multi-statement atomicity is needed.
Both point at the same database file; Rust resolves the absolute path and hands
it to the frontend via `ledger_db_path`, so the two never disagree about which
file they are opening. WAL mode plus `busy_timeout` covers the two-pool case.

### Snapshot rule — binding constraint, read before adding a cache

`account_balance` is a view that scans `ledger_lines` on every read. Its ceiling
is in the tens of thousands of events; past that, a materialised
`product_stock_snapshot` table becomes worth adding.

**When that snapshot is added, it MUST be written inside the same
`sqlx::Transaction` as the event that changes it — in `ledger_append`, at the
marked point, never as a separate pass, background job, or post-commit hook.**

A snapshot written outside the event's transaction is exactly the stored-value
drift this entire redesign exists to delete. It would reintroduce the bug in a
form that is harder to see, because the snapshot would look authoritative.

The snapshot itself is deferred. The constraint is not.

---

## 5. Tenancy: `store_id` before login, and the two-device edge case

### Normal path
1. First run, offline: the device generates `store_id` (UUID v4) and
   `device_id` (UUID v4) into `app_state`, and marks
   `app_state['store_provisional'] = '1'`.
2. The app is fully usable offline under that provisional `store_id`.
3. **Sync is blocked while `store_provisional = '1'`.** Nothing is pushed to
   Supabase — not events, not reference rows.
4. On first successful login, the client calls the Supabase RPC
   `claim_store(local_store_id)`.

### `claim_store` resolution
The RPC looks up `store_members` for `auth.uid()`:

| Server state | Result |
|---|---|
| User has no store yet | The local id becomes canonical. Server inserts `stores(id = local)` and `store_members(auth.uid(), local, 'owner')`. Returns `{ canonical: local, rekey: false }`. |
| User already has canonical store `SC`, and `SC = local` | Returns `{ canonical: SC, rekey: false }`. Idempotent — a re-login changes nothing. |
| User already has canonical store `SC`, and `SC ≠ local` | Returns `{ canonical: SC, rekey: true }`. |

### The edge case, resolved
Device A offline generates `SA`. Device B offline generates `SB`. Both then log
into the same shop account.

Whichever device logs in first has no server-side store, so its id becomes
canonical — say `SA`. The second device calls `claim_store(SB)`, gets back
`{ canonical: SA, rekey: true }`, and performs a **local re-tag** before its
first push ever happens:

1. One SQLite transaction:
   - `UPDATE ledger_events SET store_id = 'SA' WHERE store_id = 'SB'`
   - `UPDATE ledger_lines  SET store_id = 'SA' WHERE store_id = 'SB'`
   - the same `UPDATE` on every reference table (step 3 onward)
   - `INSERT INTO store_alias (old_store_id, new_store_id, rekeyed_at)`
   - `app_state['store_id'] = 'SA'`, `app_state['store_provisional'] = '0'`
2. Clear every `pull:<table>` key in `app_state`, forcing a full pull.
3. Unblock sync.

**Why this cannot produce two unmergeable stores:** the provisional `store_id`
never reaches the server. Sync is blocked until the claim resolves, so by the
time any row is pushed it already carries the canonical `store_id`. Re-tagging is
purely local and there is nothing server-side to reconcile or clean up.

**Why re-tagging does not violate append-only:** the `store_id` column is in the
trigger's allowed-to-change set, and every row being re-tagged is by definition
`sync_status = 'pending'` and has never been transmitted. Business content —
kind, amounts, quantities, timestamps, lines — is untouched. `store_alias` keeps
the mapping auditable, and a second run of the re-tag finds zero rows, so it is
idempotent.

**Why event identity survives:** `ledger_events.id` is a client-generated UUID
and is never rewritten. Even in the impossible case where both devices somehow
pushed the same event, the server-side merge is `INSERT … ON CONFLICT (id) DO
NOTHING` and dedupes it.

---

## 6. Tables

### `app_state` — key/value
`device_id`, `store_id`, `store_provisional`, `pull:<table>` (last pull
timestamp per table). One table instead of three single-purpose ones.

### `store_alias`
`old_store_id` PK, `new_store_id`, `rekeyed_at`. Audit trail for §5.

### `ledger_events`
Header. `id`, `store_id`, `device_id`, `kind`, `occurred_at` (business time),
`created_at` (local write time), `actor`, `ref_type` / `ref_id`, `payload`
(JSON, descriptive only — never aggregated), `reversed_by`, `sync_status`.

`payload` is for display. **No screen may compute a number from it.** Numbers
come from `ledger_lines`.

### `ledger_lines`
Effect. `id`, `event_id`, `store_id`, `account`, `subject_id`, `qty_delta`,
`amount_delta` (piastres), `unit_cost` (piastres, snapshot of `cost_price` at
the moment of the sale — this is what replaces the hardcoded 70% COGS rule).

`account` ∈ `stock` · `wallet` · `revenue` · `cogs` · `expense` ·
`payable_supplier` · `receivable_client` · `receivable_courier` ·
`customer_ltv` · `owner_budget`

`payable_courier` is the courier's mirror of `receivable_courier`: they hold our
COD (owed to us) while we owe them fees. Same counterparty, two accounts,
because the shop needs both numbers separately — the settlement nets them.

`payable_supplier` is what we owe; `receivable_client` is what a wholesale
client owes us. They are separate accounts on purpose — a receivable is not a
negative payable, they are different people on different screens.

### `account_balance` — view
```sql
SELECT store_id, account, subject_id, SUM(qty_delta), SUM(amount_delta)
FROM ledger_lines GROUP BY store_id, account, subject_id
```
One view serves stock, wallets, debts, receivables and LTV. There is no
per-account view.

The TypeScript `balances()` query joins `ledger_events` instead of reading this
view, because the view can express neither a date window nor an event kind.
Both narrow the ROWS that go into the same `SUM()` — they never read a stored
total. The kind filter exists for figures that are a strict SUBSET of an
account and cannot be named any other way: **purchases** are the `stock +`
lines a `purchase` wrote (`SUM(stock)` on its own is inventory value), and
**returns** are the `revenue −` lines a `return_confirmed` wrote (`SUM(revenue)`
on its own is already net of them). See §3.12 / `src/lib/ledger/reports.ts`.

---

## 7. Reference writes must not become a ledger backdoor

Step 3 brings `products`, `customers`, `suppliers` — mutable tables the UI has to
write to. The obvious move is to grant `sql:allow-execute` in
`src-tauri/capabilities/default.json` and let the frontend run `INSERT` /
`UPDATE` through `tauri-plugin-sql`.

**That would silently undo §4.** `sql:allow-execute` is blanket permission to run
any statement. The append-only triggers block `UPDATE` and `DELETE` on the ledger
tables, but nothing blocks `INSERT` — so any frontend code could write a header
in one call and its lines in another, non-atomically. That is precisely the
half-written event the whole design exists to make impossible, and it would
arrive through a permission granted for an unrelated reason.

### The rule (standing, not a description of the current state)

> **Writes are separated by path, not by table name.**
>
> A write path is trusted because of *how* it reaches the database — through a
> command that controls the transaction — never because of *what* it claims it
> will touch. Any mechanism that can issue arbitrary SQL is a ledger write path,
> whatever it was added for.
>
> Therefore `sql:allow-execute` **is never granted**, and `tauri-plugin-sql`
> stays read-only (`sql:allow-select`) for the life of the project.

This is the rule to apply to future requests, not a snapshot of today's
permission list. When someone later needs a write path — a bulk import, a
settings screen, a migration tool, a "just this one table" fix — the question is
never "does this touch the ledger tables?" It is "can this issue SQL the
transaction boundary doesn't control?" If yes, it does not get the capability; it
gets a command.

A capability bump is the most likely way this design gets undone, because it will
arrive with a good unrelated reason attached and a one-line diff. Rejecting it is
the intended outcome, not an obstacle to route around.

Writes are split by path as follows:

| Path | Reaches | Command |
|---|---|---|
| Ledger | `ledger_events`, `ledger_lines` | `ledger_append` — one transaction, header + lines |
| Reference | whitelisted mutable tables | `reference_write` — one row, LWW |
| Everything else | nothing | — |

`reference_write` takes `{ table, id, columns }` and validates `table` against a
hardcoded whitelist in Rust. **`ledger_events` and `ledger_lines` are not on that
whitelist and must never be added.** Column names are validated per-table and
values are bound as parameters, so the command cannot be turned into arbitrary
SQL by a crafted argument.

The two commands are the only writers in the system. A reviewer checking "can
this code corrupt the ledger?" has exactly two functions to read, and the
capability file states the answer on its own.

Deletion of a reference row is a tombstone (`deleted_at`), never a `DELETE`, so
it syncs to other devices instead of resurrecting on the next pull.

---

## 8. Event kinds and the lines they write

| kind | lines |
|---|---|
| `sale` | `stock −` · `wallet +` · `revenue +` · `cogs +` · `customer_ltv +` |
| `order_placed` | `stock −` (reservation, qty AND value — moving only qty would inflate the average cost of what is left) |
| `order_delivered` | `cogs +` · `wallet +` (deposit) · `receivable_courier +` (COD, cash the courier holds) · `revenue +` (**GOODS only**) · `payable_courier +` (the delivery fee) · `customer_ltv +` — **no `stock` line, it already moved at placement** |
| `order_returned_pending` | **none** — at the courier, not yet physically back |
| `order_cancelled` | `stock +` — the reservation `order_placed` took is released. Only valid before delivery; after it, goods coming back is a return |
| `order_edited` | `stock ±` — the NET change per product while an order is still pending: `stock +` for what was removed or reduced (at the cost it was reserved at), `stock −` for what was added or increased (at today's cost). Nothing else moves — an edit reserves goods, it does not sell them |
| `return_confirmed` | `stock +` · `wallet −` · `revenue −` · `cogs −` · **`customer_ltv −`** · `payable_courier +` (the fee, always) · plus EITHER `expense +` subject `shipping_return` (a return — the shop pays) OR `receivable_courier +` (an exchange — the customer pays, so it nets out). **Seven lines** on a return with a fee |
| `purchase` | `stock +` · `wallet −` and/or `payable_supplier +` (part-paid writes both) |
| `supplier_payment` | `wallet −` · `payable_supplier −` |
| `sale` (wholesale) | `stock −` · `cogs +` · `wallet +` and/or `receivable_client +` · `revenue +` (subject `wholesale`) · `expense +` (delivery cost) — **no `customer_ltv`** |
| `client_payment` | `wallet +` · `receivable_client −` |
| `expense` / `payroll` | `wallet −` · `expense +` |
| `wallet_transfer` | `wallet −` + `wallet +` |
| `courier_settlement` | `wallet +` (amount − withheld) · `receivable_courier −` (in full) · `payable_courier −` (the withheld fees). **No expense line** — the fee was booked at the movement, and booking it again here would count every return's shipping twice |
| `owner_draw` | `wallet −` · `owner_budget −` |
| `stock_adjustment` | `stock ±` · `expense ∓` (subject `shrinkage`) — one event per جرد, two lines per discrepancy. Counted fewer than recorded → `stock −` · `expense +`; counted more → `stock +` · `expense −` (a surplus cancels a cost, it is not revenue — nothing was sold). Valued at the ledger's weighted-average cost, never a flat per-unit figure |

The split between `order_returned_pending` and `return_confirmed` is what
implements §3.9 of the brief: **stock does not increase until a human confirms
the goods physically arrived.**

### Who bears a shipping fee — the rule that keeps profit honest

Shipping is priced in Settings as a matrix: **governorate × movement**
(delivery / return / exchange). That table is the only source of a fee, and a
rate is snapshotted into the event's lines at the moment of the movement, like
`unit_cost`. Editing a rate prices the future, never the past.

Who PAYS is not a pricing question, and getting it wrong corrupts profit:

| movement | who pays | our expense? | lines |
|---|---|---|---|
| delivery | customer | **no** | collected inside the COD → `payable_courier +`. Nets out |
| return | **the shop** | **yes** | `expense +` (`shipping_return`) · `payable_courier +` |
| exchange | customer | **no** | `receivable_courier +` · `payable_courier +`. Nets out |

**Returns are the shop's only shipping expense.** Booking a delivery or an
exchange fee as an expense would invent a cost the shop never bore and make
shipping look like a loss it is not. Equally, a delivery fee is not revenue —
booking it as one would inflate profit by every fee ever charged. It arrives
inside the money collected and leaves as a debt to the courier, touching
neither side of the P&L.

A courier's position is therefore two numbers, both derived:
`SUM(receivable_courier)` is what they hold for us, `SUM(payable_courier)` is
what we owe them, and the net is what actually changes hands at settlement.

### Editing a pending order does not rewrite history

An edit is conceptually "release the old reservation, take a new one", but it
is written as neither an update nor two events:

- the original `order_placed` row is **never touched** — the ledger is
  append-only, and a test asserts the old event still exists after an edit;
- release and re-reserve are **not** split into two events, because an edit is
  one operation and splitting it would let half of it land (stock released,
  nothing re-reserved).

So `order_edited` carries the net movement per product in a single event.
Swapping A for B is two lines — A back, B out — not four. A product whose
quantity did not change contributes nothing.

Editing is allowed **only while the order is pending**. Once it is with the
courier the goods have physically left, so changing its contents is a return,
not an edit.

### Wallet balances are derived, exactly like stock

A wallet — cash till, Vodafone Cash, bank — is an **identity, not an amount**.
What is in it is `SUM(wallet)` over the ledger lines whose `subject_id` is that
wallet. `Wallet` carries no `balance` field, and nothing stores one.

This was a live bug: the POS showed a fixed till figure (e.g. 7096) that never
moved after a sale. The sale itself was written to the ledger correctly — the
screen was reading a dead stored number sitting beside it. Same class as the
stored stock quantity.

Because each wallet is its own subject, a sale paid by Vodafone Cash moves only
Vodafone Cash, and a wallet nobody has used reads zero from an absent SUM rather
than from a stored default.

A wallet's **opening balance** follows the product rule: one user-entered
`stock_adjustment` (`ref_type = 'opening_balance'`, `ref_id` = the wallet) with
a single `wallet +` line and no counterpart — that money predates the ledger.

Moving money between two of the shop's own wallets is `wallet_transfer`: two
equal and opposite `wallet` lines that net to zero, because the shop is no
richer for moving its own money.

### Opening balance — a user-entered `stock_adjustment`, not a shortcut

A shop that already has stock enters it once, on the product form, as
`stock_adjustment` with `ref_type = 'opening_balance'` and actor `رصيد افتتاحي`.

It writes **one line**: `stock +` with the value it carries. Deliberately NOT
the `expense −` a جرد surplus writes — a surplus cancels a loss the shop had
already assumed, while an opening balance assumes nothing. The goods were paid
for out of the owner's earlier capital, before this ledger existed, so booking a
negative expense would invent profit out of the shop's own starting inventory.

It is offered only when ADDING a product. Editing must never re-apply it, for
the same reason a جرد recount must find nothing left to correct: the second
application would double-count the shelf.

This is the line between it and the fake seeds that were deleted — **the user
asserts the number, the system never invents one.**

### Every stock movement needs its reverse, and `order_placed` has two

`order_placed` reserves stock. There are exactly two ways those units come
back, and both must exist or inventory is silently swallowed:

- the order is **cancelled** before delivery → `order_cancelled` (`stock +`)
- the order is delivered, returned and **confirmed** → `return_confirmed`

A cancel that only deleted the order document would leave the units gone from
the shelf with nothing pointing at them. That is the forgotten-reverse bug this
row exists to prevent — check for it on every path that reserves anything.

### `return_confirmed` must write all six lines — checklist item, not a note

The smoke test's balance dump caught this: after a confirmed return, the test
customer's LTV still read **300.00 EGP** — the full original sale — because the
return event wrote no `customer_ltv` line. Brief §1.1 states a return *يعدّل
LTV*. Without that line the CRM reports a customer as having spent money they
sent back, and every "top customer" ranking built on LTV is wrong in the
customer's favour.

A confirmed return writes **six** lines. Missing any one of them is a bug:

- [ ] `stock +` — the returned units
- [ ] `wallet −` — the refund
- [ ] `revenue −` — reverse the sale
- [ ] `cogs −` — reverse the cost of the returned units (the goods came back, so
      their cost is no longer a cost of goods *sold*; without this, margin
      reports understate profit)
- [ ] `expense +` — courier return fee
- [ ] `customer_ltv −` — **the one the test caught going missing**

The returns-path tests must assert on the LTV line specifically, not just on
stock and wallet. A return that balances stock and cash while leaving LTV intact
passes a careless test and still corrupts the CRM.

---

## 9. Replacement / exchange (استبدال)

Verified by `scripts/check_exchange.mjs` (26 assertions). Everything below is
asserted there; nothing in this section describes intended-but-untested
behaviour.

### The document model

There is no "exchange event". An exchange is two existing documents, linked:

```
e-commerce exchange = a linked replacement order          (orders.original_order_id)
                    + the original order's return lifecycle
```

`orders.isExchange` and `orders.original_order_id` are real columns and were
always the intended model — the code simply never finished writing to them.
`original_order_id` is what makes the link, and it is **load-bearing**: it is
the only evidence that the original's eventual return is a swap and not a
refund.

### The sequence, and what each step moves

| # | Step | Event | Stock | Money |
|---|------|-------|-------|-------|
| 1 | replacement order placed | `order_placed` | new goods reserved (`stock −`) | deposit only, if any |
| 2 | original marked returned | `order_returned_pending` | nothing | nothing |
| 3 | original return confirmed | `return_confirmed`, `movement: "exchange"` | old goods back (`stock +`) | `revenue −`, `cogs −`, `customer_ltv −`, fee pass-through |
| 4 | replacement delivered | `order_delivered` | — | `revenue +`, `cogs +`, COD |

Step 2 moves nothing on purpose — §3.9. A courier saying an item is coming back
is a claim, not an arrival.

### Price difference — shown, never booked

**No code anywhere computes a difference and moves money by it.** Step 4 books
the replacement at full price; step 3 reverses the original at full price. What
the books end up with *is* the difference, with the correct sign:

| Case | Replacement | Returned | Net revenue booked |
|------|-------------|----------|--------------------|
| A — same price | 500 | 500 | **0** |
| B — dearer | 600 | 500 | **+100** (customer pays) |
| C — cheaper | 400 | 500 | **−100** (customer refunded) |

`lib/exchange.priceDifference` exists to show the operator this number before
they commit. Booking it as well would count it twice.

**Case D — a discounted original.** A discount lives at the order level, so a
line's `unitPrice` is its *list* price. Returned lines are valued by
`lib/exchange.returnedValue`, which scales by `totalAmount / listTotal`: two
items at 500 bought for 900 make a single return worth **450, not 500**.
Refunding list price pays the promotion a second time. This is the authoritative
valuation and both surfaces use it.

### Who pays the courier

`buildReturnConfirmedLines` takes `movement`, and the two are not the same:

- `"return"` — goods come back to us. **We** pay → `expense +`.
- `"exchange"` — the customer swaps. **They** pay → `receivable_courier +`
  cancels `payable_courier +`. Never our cost.

`lib/exchange.movementFor` decides it from the documents: a replacement order
pointing back at this order *is* the evidence. Before this, the caller hardcoded
`"return"`, so the exchange branch had never once executed and every swap booked
a courier trip the shop never paid for.

### Eligibility — one function, asked by every surface

`lib/exchange.exchangeBlock` returns the reason or `null`:

| Block | Meaning |
|-------|---------|
| `not_delivered` | status is not `delivered`. Goods that never reached the customer come back as an RTO or a cancellation, which reverse different things. |
| `already_returned` | `returnConfirmedAt` is set — the goods are already back. |
| `already_replaced` | a replacement order already points at this one. One per order. |
| `nothing_left` | every line has already been returned or swapped. |

Partial exchanges are supported: `remainingQuantities` subtracts what prior
`return_records` already took back, so a 3-item line that has had 2 returned
offers a ceiling of 1. This is derived from the records, not stored — a stored
counter would be a second truth to keep in step.

**This is a client-side guard.** It decides what to draw and refuses at the last
point before a write, but it is not the security boundary. What a user may
actually write is enforced by Postgres RLS against `store_members.role` and by
the license gate, exactly as for every other mutation — an exchange writes
`ledger_events`, `ledger_lines` and `orders`, and is covered by those tables'
existing policies. No replacement-specific permission exists, and none is needed.

### Wholesale returns are driven by the invoice

A **مرتجع جملة** may only send back goods that a real wholesale invoice sold to
that client. `lib/ledger/wholesale.resolveWholesaleReturn` is the single
producer of the value `buildWholesaleReturnLines` accepts, so the rules cannot
be skipped by a screen:

| Rule | Refusal |
|---|---|
| the invoice is in this store's list | `is not this store's` |
| the invoice belongs to THIS client | `belongs to another client` |
| the line exists on that invoice | `is not a line on invoice …` |
| the quantity is positive and finite | `must be positive` |
| the quantity is within what is still returnable | `only N left to return on …` |
| no line appears twice in one return | `appears twice` |

Three writers produce wholesale invoices — شاشة الجملة, نقطة البيع in وضع
الجملة, and إدارة الطلبات on a wholesale delivery — and all three store the
same line shape: a stable `id`, the price (`wholesalePrice`, or `unitPrice` on
the الطلبات path), and `unitCost`, **the cost the goods left at**. A return
reverses COGS at that stored cost, never at today's weighted average; today's
is the fallback only for invoices written before the field existed.

**The credit is the invoice's price, not today's.** `wholesaleDiscountFactor`
scales the line's list price by `(goodsTotal − discountAmount) / goodsTotal`, so
a promo is not paid a second time on the way out. Ten units invoiced at 100 and
returned after a rise to 140 credit 100 each.

**The ceiling is derived, never stored.** A wholesale return writes one
`return_records` row per source invoice, with `original_order_id` holding the
**wholesale invoice id**, `type = 'wholesale_return'`, and each returned item
carrying `line_id`. `remainingWholesaleLines` reads those rows back — the same
pattern `remainingQuantities` uses for orders, and for the same reason. Retail
`return` / `exchange` records are ignored by it, and vice versa, so the two
ledgers of "what has already come back" cannot eat each other's ceilings.

`return_confirmed` for a wholesale return points at `('wholesale_invoice',
invoiceNumber)`. It used to point at the CLIENT, which is why no invoice could
be found from it.

**وضع الجملة is ADMIN / ACCOUNTANT only**, because `write_wholesale_invoices`
is. `roles.canSellWholesale` states that in TypeScript so نقطة البيع and
إدارة الطلبات refuse before the ledger event rather than after it — the
`sale` INSERT policy on `ledger_events` admits all four roles, so a cashier
used to book the money and then have Postgres refuse the invoice document.

### POS vs e-commerce

The two surfaces use **different event shapes for the same business result**,
because the physical processes differ — a counter swap is instant, an
e-commerce swap is two courier trips days apart.

- **POS** (`CheckoutForm`) books **one signed `sale`**: returned lines enter the
  cart at negative quantity, the replacement at positive. Atomic by construction.
- **E-commerce** books the four steps above, over days.

`check_exchange.mjs` asserts they reach identical `revenue`, `cogs`,
`customer_ltv` and stock movements for the same swap. If a change makes them
disagree, that test fails.

### Atomicity — where it holds and where it does not

- **POS**: atomic. One event, one append.
- **E-commerce**: *not* a single transaction, and deliberately so — the steps
  are days apart and each is independently meaningful. What protects it is that
  every step is individually valid: a replacement order that is placed but never
  delivered is an ordinary pending order, and an original whose return is never
  confirmed is an ordinary returned order. There is no state in which stock has
  moved without a ledger line behind it.
- **Counter exchange** (`routes/returns.tsx`) writes two events and is the one
  path that can half-complete. It already handles this explicitly: if the
  replacement `sale` fails, the return stands and a `pending_replacement` is
  recorded on the return record and surfaced as a banner. That compensation is
  pre-existing and was left as-is.

### Double submit

`useRunOnce` closes the in-flight window on every one of these handlers, and
`claimOrder`/`releaseOrder` covers the order-level actions. The *sequential*
repeat — returning the same delivered order twice, minutes apart — is not a
double-click and was not covered by either; `remainingQuantities` is what closes
it, by lowering the ceiling to what is actually still with the customer.

### The deposit is NOT forfeited on an exchange

`buildReturnConfirmedLines` takes `forfeitedDeposit`, and on a **return** the
deposit stays with the shop — the delivery was attempted and paid for, so the
money is earned (see `forfeited_deposit` above).

On an **exchange** it must be `0`, and getting this wrong is how a swap invents
money. A forfeit means "the customer walked away". In a swap they did not: the
same money is about to pay for the replacement order. Forfeiting it makes
`forfeited_deposit +X` cancel the `revenue −X` reversal, leaves `customer_ltv`
untouched, and then the replacement books its own full revenue on delivery — so
an **even swap recognises revenue and LTV out of nothing**.

Measured on QA-STORE, fully-prepaid order, 300 → 300:

| | reversal | forfeit | net revenue | net LTV | wallet |
|---|---|---|---|---|---|
| forfeiting (wrong) | −300 | +300 | **0** | **0** | 0 |
| not forfeiting (right) | −300 | — | **−300** | **−300** | −300 |

With `0`, the money simply moves: `wallet −300` refunds the original, the
replacement's own deposit puts `wallet +300` back, and revenue/LTV net to the
price difference. The courier's trip is still paid for — by the customer,
through the pass-through exchange fee.

`movementFor` decides it, so no screen has to remember.

### Partial quantity is supported

The counter screen has always had a per-line quantity box, so partial
quantities are part of this ERP's return model — the e-commerce replacement
screen now has one too. It defaults to **1**, not the whole line: taking the
whole remaining quantity by default meant a customer swapping one of three
identical units had all three reversed and was refunded for two he still had.

The ceiling is `remainingQuantities`, i.e. what is still with the customer, and
it is enforced three times: the input's `max`, the clamp as you type, and a
final re-check in the submit handler before the write (the form is a draft that
outlives navigation, so a line marked "return 3" can outlive a return of 2
recorded elsewhere).

Verified live on a discounted order (2 × 300 list, 540 paid): returning 1 values
at **270**, returning 2 at **540** — exactly what was paid — and pressing `+`
again stays at 2.

### Multiple replacement items

`return_records.exchanged_item` is **JSONB and now holds an array**. No
migration and no new column were needed.

The POS cart takes any number of positive lines beside the returned ones and
`buildSaleLines` books all of them, so the ledger was always correct — but the
document stored `positiveItems[0]`, and a swap of one item for three left two of
them in no record at all: not in the exchange log, not in the PDF export, not in
the CRM.

Both writers now store an array. `exchangedItems()` normalises on read, so the
rows already stored as a single object keep working; read through it, never off
`record.exchanged_item` directly.

### A failed placement releases its reservation

The replacement order is two writes: the `order_placed` event, then the order
document. If the document is refused, the event and its stock reservation would
stand with nothing pointing at them — and because `addOrder` **rejects** rather
than returning a result, nothing caught it and the operator was shown *nothing
at all*.

Both failure shapes now take the same path: a compensating `order_cancelled`
event (the ledger is append-only, so this is compensation, not rollback) plus
the mirror move, and a message that says whether the goods are back. If the
compensation itself fails, the message says exactly that instead of reading as
an ordinary error.

Proven on QA-STORE by blocking the `POST /rest/v1/orders`: before, a unit left
the shelf for an order that will never exist; after, ledger and mirror both
return to their starting value and no order row is created.

This is the invariant the multi-step lifecycle rests on: **no step claims
success without its own document and ledger state, and a step that fails leaves
nothing behind.**

---

## 10. Shipping cost ownership, and the wasted-trip debt

Verified on QA-STORE. Everything below was measured, not inferred.

### What the model keys on today: MOVEMENT, not fault

There is **no field anywhere that records who caused a return.** The only
`reason` column in the database is on `auth_login_attempts`. What exists is:

| Field | Values | What it actually means |
|---|---|---|
| `orders.returnType` | `rto` \| `refund` | *When* the goods came back — refused at the door, or after delivery |
| `ReturnConfirmedInput.movement` | `return` \| `exchange` | *What kind of journey* — derived by `movementFor` from whether a replacement order points back |
| `return_records.type` | `return` \| `exchange` \| `wholesale_return` | same distinction, on the document |

Fee ownership therefore follows the **movement**:

- `return` → `expense + shipping_return`. The shop bears it.
- `exchange` → `receivable_courier` cancels `payable_courier`. The customer
  bears it, as a pass-through.

This is a deliberate, coherent rule, and the courier screen renders it: *"شحن
مرتجعات دفعناه"* is labelled *"ده الشحن الوحيد اللي بيتحسب خسارة علينا"* — the
only shipping counted as the shop's loss.

**It is not a fault model.** A swap caused by the shop sending the wrong item
still charges the customer, and a return caused by a defect is still borne by
the shop. Representing fault needs a new field — see the report accompanying
this section; no migration has been applied.

### One authority, already shared

`CourierLedgerPage` derives every figure from the ledger accounts narrowed by
event kind — `payable_courier`/`order_delivered`, `payable_courier`/
`return_confirmed`, `receivable_courier`/`return_confirmed`, and
`expense`/`shipping_return`. It holds no formula of its own, so it follows
whatever `buildReturnConfirmedLines` writes. Measured: COD 1,070 − fees 480 =
expected 590, with shop-borne return shipping 0 across four exchanges.

### The repeat-returner rule is a DEBT, not a history count

The established rule — documented in `shippingRates.ts` and asserted in
`check_returns.mjs` as **"double, not ×7"** — is:

```
fee = base × 2   while the customer owes at least one wasted trip
fee = base       once the debt is square
```

It is **flat 2×**, never `(N+1)×`. `returned_orders_count` is the number of
wasted trips still *owed*, and each delivered order that actually charged the
doubled fee pays one back (`clearsShippingDebt` → `settleWastedTrip`). Three
failed trips take three successful orders to settle. Verified live: base 40 with
a debt of 1 charged **80**, stored as `orders.shippingFee = 80`, and the screen
explained it as *"شحن مضاعف لتعويض رحلة شحن ضائعة — متبقي 1 رحلة على العميل
(الأساسي ٤٠ ج.م)"* — operational language naming the remaining debt, not a flag.

### An exchange is not a wasted trip

Both confirm-return handlers incremented the debt on *every* confirmation.
An exchange wastes no trip: the courier carries the replacement out and the
original back in one journey, the customer keeps goods, and they have already
paid the exchange fee as a pass-through. Incrementing billed them twice.

Measured before the fix: `QA-UAT-ECO-CUSTOMER` carried a debt of **4** from
**4 exchanges and 0 plain returns**. After: a plain return took the debt 0 → 1,
and a confirmed exchange left it at 1. `countsAsWastedTrip` is the one place
that decides; an RTO still counts, which is the clearest wasted trip there is.

`recordReturn` is also now awaited. Called bare it was an unhandled rejection —
a refused increment lost the wasted trip silently while the screen reported the
return as confirmed. It escaped the bare-call check only because it shared a
line with its `if`.

---

## 11. Responsibility: who caused it, and therefore who pays (migration 026)

Supersedes the movement-keyed rule described in §10. Every figure below was
measured end-to-end on QA-STORE through the real UI.

### The field

`orders.return_cause` and `return_records.return_cause`, both
`CHECK (return_cause IN ('customer','shop','unknown'))`, default `'unknown'`.

Movement (`return`/`exchange`) and `returnType` (`rto`/`refund`) describe the
JOURNEY. Neither can say whether the shop shipped the wrong size or the customer
changed their mind, and those two produce an identical movement. That gap is why
fee ownership used to follow the movement and therefore got both rules backwards.

**Nothing was reclassified.** All 12 pre-existing QA orders backfilled to
`'unknown'`, and `shippingBorneBy('unknown', …)` reproduces the old
movement-keyed answer exactly, so no historical figure moved.

### Who pays — `shippingBorneBy(cause, movement)`

| cause | movement | bearer | ledger |
|---|---|---|---|
| `customer` | either | customer | `receivable_courier +fee` cancels `payable_courier +fee` |
| `shop` | either | shop | `expense + shipping_return` |
| `unknown` | `return` | shop | the established default |
| `unknown` | `exchange` | customer | the established default |

Measured: a customer-caused return booked `receivable_courier +30` and
**expense 0**; a shop-caused exchange booked **`expense +40`** and no
receivable. Before 026 the first was an expense and the second was billed to the
customer — both inverted.

### The wasted-trip debt — `countsAsWastedTrip(cause, movement)`

Two conditions, **both** required:

- the **customer** caused it — `shop` and `unknown` never add debt, because not
  knowing who was at fault is not a finding of fault; and
- a trip was actually **wasted** — an exchange never qualifies, whoever caused
  it. One courier journey carries the replacement out and the original back, the
  customer keeps goods, and they have already paid the exchange fee directly.
  Counting it billed them twice.

An RTO the customer refused is the clearest wasted trip there is, and counts.

### The multiplier is flat 2×, and it is temporary

The established rule is preserved, not replaced: `RETURN_PENALTY_MULTIPLIER = 2`
while any debt is outstanding — never `(N+1)×`. `check_returns` has always
asserted "double, not ×7". What changes is the DEBT, one delivery at a time.

Verified live, base delivery 50 / exchange 40:

| step | debt | fee charged | after |
|---|---|---|---|
| two customer-caused returns | 0 → 2 | — | debt 2 |
| exchange order placed | 2 | **80** (2 × 40) | flag stored `true` |
| that order delivered | 2 | — | **debt 1**, flag consumed |
| new order placed | 1 | **100** (2 × 50) | flag stored `true` |
| that order delivered | 1 | — | **debt 0**, flag consumed |
| next order | 0 | **50** — no banner | square |

At debt 2 the fee was 80, not 120. The screen explains it in operational
language — *"شحن مضاعف لتعويض رحلة شحن ضائعة — متبقي 2 رحلة على العميل (الأساسي
٤٠ ج.م)"* — naming the outstanding debt, never flagging the customer.

### Why `shippingPenaltyApplied` is consumed on settlement

It means "this order charged a penalty that has not yet been credited back".
Settling clears the debt AND sets the flag false in the same step, so the claim
cannot be redeemed twice by an edit, a replay or a stale tab. The audit trail
survives in `shippingFee` (80 against a base of 40).

Until 026 the column did not exist and was absent from `CLOUD_SCHEMA`, so it was
dropped on every write, `clearsShippingDebt` was always false, and the debt never
cleared at all. **That made the surcharge permanent** — the one thing the rule
says it must not be.

### Verified QA matrix

1 customer return → debt 0→1 · 2 shop exchange → debt unchanged, `expense +40` ·
3 customer exchange → customer pays, no debt · 4 debt 2→1 on delivery ·
5 full cycle to 0 and back to base · 6 exchange never adds debt ·
7 plain return increments exactly once · 8 triple-click → exactly one order ·
9 forced failure → stock 55→55, no orphan, no false success ·
10 production store untouched (0 classified, 0 penalised) ·
11 historical rows stay `'unknown'` · 12 courier screen reconciles to the ledger
(1,480 receivable / 730 payable / 40 shop-borne / 750 expected).

---

## 12. البوكسات / bundles — cost, stock and profit

Verified end-to-end on QA-STORE. Recipe under test: 1 box = WIDGET ×2 + سيرافي ×1,
component WAC 100 each, so the box costs **300** and sells for 500.

### A box is VIRTUAL

Proven from the data, not assumed: `QA-UAT-BUNDLE` has `ledger_qty 0` and
`ledger_value 0` — it has never had a stock line of its own and never will. Its
availability is `bundleAvailableStock`, the scarcest component's recipe count
(`min(floor(18/2), 54/1) = 9`), and `getActualStock` routes bundles to that
instead of the ledger.

So selling a box moves its COMPONENTS and never the box. Confirmed live: a 2-box
sale wrote `stock WIDGET −4`, `stock SERAFY −2`, and **nothing at all against the
bundle id**. The `products.quantity` mirror moved the same way (15→11, 54→52,
bundle 0→0), because `applyStockMoves` runs every move through
`expandBundleMoves` first.

### Cost is DERIVED, never stored

`bundleItems` is JSONB of `{productId, quantity, variantName?}` — there is no
cost field in it, and there must not be. The cost is:

```
bundle cost = Σ (component quantity × box quantity × component WAC)
```

computed at the moment of the movement from the same `costOf` every ordinary
sale uses. `BundlesPage` shows that sum while the box is being built, from the
same reader, and saves only the recipe. A stored cost would be a second truth
that goes stale the next time a component is bought at a different price —
which is exactly what the weighted average exists to track.

### The bug this replaced

Four builders each carried their own copy of the expansion, and every copy
expanded the STOCK lines and not the COGS line:

```
if (item.isBundle) { for each component → stock − at component cost }
else               { stock − at item cost }
if (lineCost !== 0) { cogs += item.unitCost × item.quantity }   ← blind
```

A box is virtual, so `costOf(bundleId)` is 0 — and that zero is exactly what the
screens pass as `unitCost`. `lineCost` was therefore 0, the `!== 0` guard skipped
the COGS line altogether, and **a box sale booked full revenue against no cost**
while its inventory value left `stock` with nothing on the other side. A box
RETURN was the mirror image: components came back at value, COGS never moved.

`lib/ledger/bundles.ts` is now the single authority — `lineCostOf`,
`stockLinesFor`, `cogsLinesFor` — shared by `buildSaleLines`,
`buildOrderPlacedLines`, `buildOrderDeliveredLines`, `buildOrderCancelledLines`,
`buildOrderRTOLines`, `buildReturnConfirmedLines`, `buildWholesaleInvoiceLines`
and `buildWholesaleReturnLines`.

COGS is attributed to the **components**, matching the stock lines, so a margin
report reads the same subject on both sides. Against the bundle id it would have
been an orphan: the box has no stock lines to pair with.

### Measured

| Surface | Movement | stock | COGS | revenue | profit |
|---|---|---|---|---|---|
| POS | sell 2 boxes | WIDGET −4, SERAFY −2 | **600** | 1000 | 400 |
| POS | return 1 box | WIDGET +2, SERAFY +1 | **−300** | −500 | — |
| E-commerce | place 1 box | WIDGET −2, SERAFY −1 | — | — | — |
| E-commerce | deliver it | — | **300** | 500 | 200 |

Per box both surfaces book revenue 500 against cost 300. `orders.cogsAmount`
stored **300**, and `stockItems` stored the expanded components while `items`
kept the box — so the document says what was sold and what actually moved.

Dashboard reconciliation: ledger revenue 3,100 − COGS 900 − expense 40 =
**2,160**, and صافي الربح showed ٢٬١٦٠. Before the fix the same day would have
read 2,760 — overstated by exactly the bundle cost.

### Nesting is not supported

`BundlesPage` offers only `!p.isBundle` products as components, so a box cannot
contain a box. Expansion is deliberately **single-level** in both
`stockLinesFor` and `expandBundleMoves`: if a crafted row ever nested one, the
expansion charges the inner id once and stops rather than recursing.

### Guards

- Availability caps the cart: the POS line clamped at exactly 7 boxes when 7
  were buildable, so an over-sell never reaches the ledger and cannot partially
  commit.
- A `isBundle` with an empty recipe falls back to the plain-product path rather
  than selling something that moves nothing.
- A component quantity of ≤ 0 contributes no cost and no movement.
- A POS sale is ONE `appendEvent`, so it is atomic by construction. Forced
  failure (ledger write blocked) left ledger 16→16, mirror 13→13, no event, and
  "لم تُسجَّل العملية ولم يتغيّر أي رصيد."
- `products` RLS is `SELECT is_store_member` / `WRITE has_role(ADMIN,
  ACCOUNTANT)`, so components can only ever be read — and therefore chosen —
  from the caller's own store.

`isBundle` and `bundleItems` are both in `CLOUD_SCHEMA` and in the table: no
serialization drift, and no bundle cost field exists to drift.
