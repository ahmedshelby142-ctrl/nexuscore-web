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
