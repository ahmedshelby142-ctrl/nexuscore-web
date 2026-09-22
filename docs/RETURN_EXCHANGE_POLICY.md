# Returns, Exchanges and the Deposit — the business policy

Corrected 2026-09-21. Enforced by `scripts/check_return_policy.mjs`.

This is the money contract for every way goods come back. It is a **fixed
business rule**, not a setting: الإعدادات states it and does not offer to
change it, because a toggle here would be a way to configure an invalid
financial policy.

---

## 1. The two rules everything follows from

### Responsibility follows CAUSE, not REQUESTER

A customer asking for a swap does not make the swap theirs. If we shipped the
wrong item, or it arrived faulty, it is the shop's — however the request
reached us.

This was the expensive confusion. The picker said «العميل», an operator read
that as *the customer asked*, and picked it, and the money followed the wrong
party. On an exchange the choices now name the cause, and the customer option
names the only case that is genuinely theirs: **«تغيير رغبة العميلة»**.

### A deposit is not refunded when the customer walks away

It is what made the order real, and the trip was committed on the strength of
it. Kept money is booked as `revenue / forfeited_deposit` — its own subject, so
صافي الربح can report retained deposits separately from goods sold, because
they are not a sale.

---

## 2. The axis

`return_cause` — `orders.return_cause` and `return_records.return_cause`,
CHECK-constrained, migration 026.

| Cause | Return wording | Exchange wording |
|---|---|---|
| `shop` | المحل | خطأ من المحل أو عيب في المنتج |
| `courier` | المندوب / شركة الشحن | خطأ من المندوب / شركة الشحن |
| `customer` | العميل | تغيير رغبة العميلة |
| `unknown` | غير محدد | غير محدد |

`shop` deliberately covers **both** "we sent the wrong thing" and "the product
is defective". They are one cause because they have one payer, and splitting
them would invite an operator to file a defect under the customer.

`unknown` is **history only**. Every row written before migration 026 carries
it, and `shippingBorneBy` still resolves it to the old movement-keyed default
so no historical figure moves. Nothing new can be written with it:
`blockingCauseReason` refuses the confirmation, in the UI and again in the
handler.

---

## 3. Who pays

`shippingBorneBy(cause, movement)` in `src/lib/shippingRates.ts`. **The movement
prices the trip; the cause decides who carries it.**

| Cause | Bearer | Ledger effect | Deposit |
|---|---|---|---|
| `shop` | shop | `expense / shipping_return +fee` | **held** pending resolution — §6 |
| `courier` | courier | `payable_courier +fee` **and** `receivable_courier +fee` — nets to zero for the shop; the provider compensates us | **held** pending resolution — §6 |
| `customer` | customer | `payable_courier +fee` and `receivable_courier +fee` — the courier collects it on our behalf | **forfeited** on a return; untouched on an exchange |

A courier-caused and a customer-caused movement produce **identical ledger
lines** — both are non-shop pass-throughs against the same courier account.
That is correct and deliberate: the distinction is a fact about *why*, and it
is carried by `return_cause` on the append-only event, not by the amounts.
`compensationExpectedFrom(cause, movement)` reads it back in words.

An exchange **never** forfeits the deposit: the same money funds the
replacement.

---

## 4. The nine scenarios, as money

Deposit 200, goods 500, courier fee 40, EGP. Produced by running the real
builders — see the changelog entry for the full dump.

| # | Scenario | Bearer | Deposit | Wasted trip | Compensation |
|---|---|---|---|---|---|
| 1 | customer cancels | — | **forfeited** | — | — |
| 2 | company-caused return | shop | **held** | no | — |
| 3 | courier-caused return | courier | **held** | no | **courier** |
| 4 | customer-caused return | customer | **forfeited** | yes | — |
| 5 | company-caused exchange | shop | untouched | no | — |
| 6 | courier-caused exchange | courier | untouched | no | **courier** |
| 7 | **voluntary** customer exchange | customer | untouched | no | — |
| 8 | exchange, company fault | shop | untouched | no | — |
| 9 | exchange, product defect | shop | untouched | no | — |

"Held" means `revenue / deposit_pending_resolution`: the cash stays in the till
and the decision is still open. §6 is what closes it.

Scenario 1 writes **no wallet line at all** — the cash is already in the till
from `order_placed`, and cancelling is the moment it stops being a holding and
becomes income:

```
stock/A +300   revenue/forfeited_deposit +200   customer_ltv/c1 +200
```

### The one cancellation that does refund

The rollback in شاشة الطلبات الإلكترونية, where `order_placed` banked a deposit
and Postgres then **refused the order document**. No order ever existed, so the
money cannot be earned and comes back out. It passes `refundedDeposit`, and the
two fields are mutually exclusive at the builder.

### Legacy orders forfeit nothing

An order placed before `depositWallet` existed holds an amount and no wallet,
and never wrote a wallet line at placement. Forfeiting one would recognise
income against cash the ledger never saw — inventing revenue rather than
retaining it. The call site passes neither field for those.

---

## 5. What changed, and what did not

**Changed**

* `buildOrderCancelledLines` no longer takes `depositAmount` and no longer
  writes `wallet −deposit`. The disposition is explicit — `forfeitedDeposit`
  or `refundedDeposit` — with no default, so an old call site cannot compile
  into the old behaviour.
* Both confirm dialogs refuse an unclassified movement, on the button **and**
  in the handler.
* Exchange wording; the financial bearer is stated on screen before تأكيد.
* الإعدادات gained a fixed-rule panel and `depositMandatory` now actually
  gates order submission — it had been described to the owner as disabling the
  submit button since it was added, and nothing read it.

**Not changed**

* `shippingBorneBy`'s `unknown` fallback. History depends on it.
* No migration, no RLS policy, no schema change. The cause axis already
  existed and is reused; no second responsibility field was created.
* No production financial record was rewritten.

---

## 6. The courier-caused return, and the deposit exception

**Resolved 2026-09-22.** §6 previously recorded this as an open question. It is
now answered, and the answer is neither "always keep" nor "always refund".

### A courier-caused return is NOT a customer cancellation

They are different business events and the system must never file one as the
other. A courier that fails a delivery — or records a customer cancellation
that never happened — has not caused the customer to walk away.

| | Deposit at confirmation | Later resolution |
|---|---|---|
| customer cancelled / caused the return | **forfeited** — Rule A, final | none |
| shop or courier caused it | **held** | optional, case-by-case |
| any exchange | untouched | none |

### Held, not refunded

The old code answered this with a boolean and refunded **automatically** on a
shop- or courier-caused return. That is a blanket refund rule, and it is wrong
for the same reason the blanket forfeit was: it decides a question nobody has
asked yet. The customer has not said whether they still want the goods.

So a non-customer cause now books the deposit to
`revenue / deposit_pending_resolution` — the cash is in the till and the
balance must be explained, but the subject says the decision is not final.
`forfeited_deposit` stays reserved for money that is genuinely earned.

### The sequence

```
Order A → courier-caused return
            ├── claim: receivable_courier +fee, no expense   (settles at the courier batch)
            └── deposit: revenue/deposit_pending_resolution  (held)
                   │
                   ├── customer still wants it → Order B, its own shipment,
                   │     its own costs. Order A is never overwritten; the link
                   │     is orders.original_order_id.
                   │
                   └── customer declines → تسوية العميلة
                         ├── keep   → nothing is written; holding already happened
                         └── refund → deposit_refunded: wallet −, revenue −, LTV −
```

### Compensation ≠ deposit refund

Two different amounts, owed by and to different parties, settled by different
mechanisms. The refund touches **no** courier account — asserted, because
paying a customer must not quietly forgive the provider.

### Where the choice lives

In the **incident**, not in Settings. الإعدادات states the fixed rule and
offers no "refund deposits = ON" switch: that would be a way to configure an
invalid financial policy. The button appears on a confirmed, eligible return
and needs an explicit confirmation.

### Why the exception also covers `shop`

The brief names only the courier case. The same mechanism covers a
shop-caused return because both are "not a customer cancellation", and the
alternative was leaving shop-caused on the blanket auto-refund this correction
exists to remove. **Flagged as an extension of the stated rule**, not as a
finding — if a shop-caused return should instead forfeit, that is a one-line
change in `depositDispositionOn`.

### Server authorization

`refund_order_deposit` (migration 038), SECURITY **INVOKER** so the existing
policies are the gate rather than a hand-copied imitation of them:

| Check | Enforced by |
|---|---|
| is this order mine | `select_orders` → `is_store_member` |
| may this user refund | `insert_ledger_events`, with `deposit_refunded` moved to the ADMIN/ACCOUNTANT branch |
| is the shop licensed | `insert_ledger_lines` → `store_licensed` |
| does the cause qualify | `NEXUS_CAUSE_NOT_ELIGIBLE` |
| was a deposit banked / already refunded | the standing balance; `NEXUS_NOTHING_TO_REFUND` |
| two operators at once | `pg_advisory_xact_lock` per order |

The client sends **no amount**. There is no `depositRefundedAt` column: the
balance is both the entitlement and the duplicate guard, and the ledger cannot
be updated or deleted by any client role, so the guard cannot be edited away.

## 6b. Cancellation has a cause, and the claim has a lifecycle

Added 2026-09-22, migration 039.

### The falsified cancellation

A courier that fails a delivery may report *"the customer cancelled"*. Until
now the app could not contradict it: `cancelOrder` recorded **no cause at
all**, so a falsified cancellation and a real one were the same row — and both
forfeited the customer's deposit.

إلغاء الطلب now asks. Three causes, written to the order **and** to the
append-only event:

| Cause | Deposit | Next |
|---|---|---|
| العميلة لغت بنفسها | **forfeited** — Rule A | — |
| المندوب / شركة الشحن | **held** | claim + customer resolution |
| خطأ من المحل | **held** | customer resolution |

### Who may say who was at fault

`orders_guard_return_cause`, a **trigger** — not an RPC, because the cause is
written from four handlers and from anything anyone points at PostgREST
tomorrow. An RPC guards the path that calls it; a trigger guards the table.

* `courier` and `shop` require **ADMIN or ACCOUNTANT** — the same pair the
  ledger's money kinds require. `write_orders` admits POS_ECOMMERCE and
  ECOMMERCE_ONLY, so without this a cashier could assert that a shipping
  provider owes the shop money.
* `customer` stays open to the order-writing roles: it creates nothing to
  claim and is the ordinary reading of a cancellation.
* The cause **freezes** once a `deposit_refunded` event exists. Re-pointing
  the blame after the money moved would leave a refund standing on an order
  that no longer justifies it — and the refund cannot be reversed.

**Workflow impact, stated plainly:** a POS_ECOMMERCE or ECOMMERCE_ONLY user
can no longer confirm a return as courier- or shop-caused. That is the
intended restriction, and it is a real change to who can complete that step.

### The claim lifecycle

`courier_claims` — `pending → submitted → approved → settled`, with
`rejected` reachable from the first two, and both terminal states enforced by
a trigger. A status column with no transition rule is a column where any
state reaches any other, which is not a lifecycle.

It is traceable to the order, the courier, the return record, the amount, the
settlement event, four dates and two users — by **foreign key**, not text ids.

**It holds no money.** The receivable already lives in `ledger_lines` and the
settlement is a `courier_settlement` event this table only *references*.
`amount_piastres` is a snapshot for reconciliation and nothing sums it — a
second summed amount is how two answers to "what does this courier owe us"
come to exist. It is equally not a string in a ledger payload:
`no_update_ledger_events` is `USING (false)`, so a status living there could
never advance past the moment it was written.

### What must never couple — proven, not asserted

Settling the claim left the deposit **still held at 30000 piastres**.
Refunding the deposit left the claim **still `settled`, amount unchanged at
4000**. Different counterparties, different money, different events.

### Shop-caused: still a business decision

The evidence determines that `shop` is **not forfeited** — `RETURN_CAUSE_HINTS`,
the old `depositForfeitedOn` doc and migration 029 all say so. It does **not**
determine refund-now versus hold, because the one source that said "refunded"
is the same boolean this correction overrode for the courier case.

So `shop` is **held**: the only answer that moves no money and leaves both
outcomes reachable. Not invented, and not settled either.

**Decision still required:** on a shop-caused return, should the deposit be
refunded automatically, or stay a case-by-case resolution as it is now?

Two hint strings promised «والعربون يرجع للعميل» — *the deposit goes back* —
which stopped being true when the disposition became "held". Both corrected;
shipped copy that contradicts the ledger is worse than no copy.

---

## 7. Data facts, 2026-09-21 (read-only, nothing executed)

Live project `oczgqpxeixlrufvevitz`.

| Fact | Count |
|---|---|
| `orders` with a recorded cause (customer / shop / courier) | 12 |
| `orders` still `unknown` | 22 |
| …of those, `status = 'returned'` | 9 |
| `return_records` with `type = 'exchange'` and cause `unknown` | 1 |
| `revenue / forfeited_deposit` lines already in the ledger | 5, EGP 1,300 |
| `order_cancelled` events in the entire database | **1**, wallet movement **0** |

**The cancellation defect never fired.** The single `order_cancelled` event
carries no wallet line — the order had no banked deposit — so no customer was
ever refunded a deposit they should have forfeited, and there is nothing to
unwind. The fix is forward-only.

**RECOVERY PROPOSAL — NOT EXECUTED.** The 9 returned orders and 1 exchange
still marked `unknown` were priced by the old movement-keyed fallback. Their
accounting is internally consistent and re-deciding them would move historical
figures in an append-only ledger. Reclassifying them is a deliberate
administrative act requiring someone who knows what actually happened in each
case; it is documented here and left alone.
