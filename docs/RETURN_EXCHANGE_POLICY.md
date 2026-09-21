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
| `shop` | shop | `expense / shipping_return +fee` | **refunded** (not forfeited) |
| `courier` | courier | `payable_courier +fee` **and** `receivable_courier +fee` — nets to zero for the shop; the provider compensates us | **refunded** |
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

| # | Scenario | Bearer | Deposit kept | Wasted trip | Compensation |
|---|---|---|---|---|---|
| 1 | customer cancels | — | **yes** | — | — |
| 2 | company-caused return | shop | no | no | — |
| 3 | courier-caused return | courier | no | no | **courier** |
| 4 | customer-caused return | customer | **yes** | yes | — |
| 5 | company-caused exchange | shop | no | no | — |
| 6 | courier-caused exchange | courier | no | no | **courier** |
| 7 | **voluntary** customer exchange | customer | no | no | — |
| 8 | exchange, company fault | shop | no | no | — |
| 9 | exchange, product defect | shop | no | no | — |

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

## 6. Open business decision — the deposit on a shop- or courier-caused return

**Current behaviour: the deposit is REFUNDED when the shop or the courier
caused the return.** `depositForfeitedOn` returns false for both.

The P0 brief is internally inconsistent here and this audit did not resolve it
unilaterally:

* Rule 3A says a company-caused return "is NOT charged to the customer" —
  forfeiting their deposit *is* charging them.
* Scenario 2 says "deposit is NOT refunded", which points the other way.

Keeping the current behaviour is the conservative reading: a shop that keeps
the customer's money on its own mistake is profiting from it, and reversing
that later is a policy change, whereas taking money now is an irreversible
entry in an append-only ledger.

**Decision required** before this can be called settled: on a return the shop
or courier caused, does the customer's deposit come back?

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
