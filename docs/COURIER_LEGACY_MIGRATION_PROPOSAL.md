# Courier legacy data — audit and migration proposal

**Status: PROPOSAL. Nothing in this document has been executed.** No historical
order was rewritten, no courier registry row was fabricated, and no couriers
were merged. Audited 2026-09-19 against the live database.

---

## 1. What the registry is, and what came before it

Migration `030_couriers_registry.sql` gave couriers a real store-scoped table.
Before it, an order carried a typed `courierName` and usually no id at all, so
«أرامكس» typed twice became two couriers whose money could never be settled
against one account.

`lib/courierBatch.ts` already names the consequence:

```ts
courierIdOf(order) => order.courierId || LEGACY_COURIER_SUBJECT   // "default"
```

Every order without a registry id books its money against the subject
`"default"`. That is a **bucket, not a company**.

---

## 2. Exact counts

Orders, by how their courier resolves (`deleted_at IS NULL`):

| Store | `courierId` | `courierName` | Orders | Shipped/delivered | COD | In registry? |
|---|---|---|---|---|---|---|
| QA-STORE | `cert-courier` | CERT Courier | 5 | 4 | 1,620 | ✅ yes |
| QA-STORE | `default` | QA Courier | 8 | 6 | 1,800 | ❌ no |
| QA-STORE | — | `جي ان تي ` | 3 | 1 | 700 | ❌ no |
| QA-STORE | — | `""` | 18 | 0 | 2,190 | n/a |
| QA-STORE | — | `null` | 2 | 0 | 800 | n/a |
| المحل التجاري | — | `جي ان تي ` | 2 | 2 | 840 | ❌ no |

### The number that matters

**13 orders** carry a courier that is not a registry entity — 8 under
`courierId='default'`, 5 with free text and no id. **9 of those 13 actually
shipped or were delivered.**

The 20 orders with no courier at all are **not** legacy debt: none of them ever
shipped. An order sitting in the shop correctly has no courier. Counting them as
a data problem would overstate the work by more than double.

---

## 3. The finding that blocks an automatic migration

The order documents are only half the story. The **ledger** has already booked
money against the `default` subject:

| Store | Account | Subject | EGP | Lines |
|---|---|---|---|---|
| QA-STORE | `receivable_courier` | `default` | **1,440.00** | 18 |
| QA-STORE | `payable_courier` | `default` | **1,010.00** | 25 |
| المحل التجاري | `receivable_courier` | `default` | **270.00** | 3 |
| المحل التجاري | `payable_courier` | `default` | **70.00** | 3 |
| QA-STORE | `receivable_courier` | `cert-courier` | 790.00 | 5 |
| QA-STORE | `payable_courier` | `cert-courier` | 80.00 | 6 |

**1,710.00 EGP receivable and 1,080.00 EGP payable sit under `default` across
two stores**, and cannot be settled against any real courier account.

Worse, `default` is a **mixed** bucket. It collects both:

- orders that named "QA Courier" but had no registry id, and
- orders that never had a courier at all

— because `courierIdOf` maps both to the same subject. 49 ledger lines sit under
`default` in QA-STORE against only 8 `default`-id orders, which is the merge
happening in plain sight.

So the attribution **cannot be recovered from the ledger**. It can still be
recovered per-order from `orders.courierId` / `orders.courierName`, but
re-pointing the already-written lines would mean rewriting `subject_id` on
committed ledger rows — and the ledger is append-only by policy
(`no_update_ledger_lines`, `no_delete_ledger_lines`, both `USING (false)`).
That policy is correct and must not be relaxed for a tidy-up.

---

## 4. Which rows could be mapped unambiguously

**None.**

| Legacy value | Candidate registry match | Verdict |
|---|---|---|
| `default` / "QA Courier" | no registry row named "QA Courier" | **Manual.** Is it a real company or test data? In a store named "(disposable)" it is probably the latter — but that is a judgement, not a fact the data states. |
| `جي ان تي ` (note the **trailing space**) | no registry row | **Manual.** Appears in two stores; couriers are store-scoped, so it needs one record per store. The trailing space is itself evidence of free-text entry, so other spellings may exist. |
| `cert-courier` | `cert-courier` | Already correct — nothing to do. |

Because zero rows map unambiguously, §6's condition for acting in this phase
("unless the mapping is unambiguous and explicitly required") is **not met**, and
nothing was changed.

---

## 5. Proposed migration — forward-only

The honest shape is forward-only. Do not try to rewrite history.

**Step 1 — register the real couriers (human decides).**
For each legacy name a human confirms is a real company, create a `couriers` row
in the owning store, through the existing Desktop courier screen. Do not script
this: the decision is "is this a company", and only a person holds it.

**Step 2 — map the order DOCUMENTS only, per store, one name at a time.**
```sql
-- Illustrative. Run per store, per confirmed name, after Step 1.
-- `orders` carries no append-only policy, so this is reversible.
UPDATE public.orders
   SET "courierId" = :confirmed_courier_id
 WHERE store_id = :store
   AND "courierId" IS NULL
   AND lower(trim("courierName")) = lower(trim(:legacy_name))
   AND deleted_at IS NULL;
```
Trim on both sides — `جي ان تي ` will not match `جي ان تي` otherwise.

**Step 3 — leave the historical ledger under `default`, and say so.**
Those lines stay. They are a truthful record that the money moved before anyone
knew which company held it. Settlement for them continues through the legacy
bucket, which `courierBatch.ts` already models and `isLegacyCourier()` already
identifies.

**Step 4 — stop the source.**
`requiresCourier()` in `courierBatch.ts` already refuses to save a shipping
order without a registered courier. Confirm it is enforced on every write path
before Step 2, or the bucket starts refilling behind the migration.

### Explicitly rejected alternatives

- **Rewriting `ledger_lines.subject_id`** — breaks append-only, and the
  attribution is not recoverable from the ledger anyway.
- **Auto-creating registry rows from distinct `courierName` values** — would
  fabricate companies from typos; `جي ان تي ` and a future `جي ان تي` would
  become two couriers, which is the original bug with extra steps.
- **Auto-merging couriers by name similarity** — silently reassigns money.

---

## 6. What Mobile does today, and why that is already correct

`readMobileCouriers()` reads the registry; `resolveCourierName()` prefers a
registry hit and falls back to the frozen `courierName` on the order, flagging
the row `courierIsLegacy`. The order detail screen prints, in Arabic, that the
courier is not in the registry and that the name is historical.

That is the right behaviour while this proposal is unexecuted: it neither hides
the gap nor invents a company to fill it. No Mobile change is needed for the
migration itself — only Step 1's new registry rows will start resolving, which
happens automatically.
