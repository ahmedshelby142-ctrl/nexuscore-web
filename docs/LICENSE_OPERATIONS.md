# Licence operations

The commercial model is manual and deliberately simple:

> A customer pays you in the real world. You turn the key.
> A customer stops paying. You suspend them, or let the licence lapse.
> Their data stays exactly where it is. Only their access changes.

There is no billing in this system. No subscriptions, no recurring payments, no
renewal job, no payment webhook, and nothing runs on a timer. A licence changes
when **you** change it, and expires because a date passed.

## The four states

| State | What it means | What the customer sees |
| --- | --- | --- |
| **UNLICENSED** | Never activated. The account and the shop exist; nothing has run out. | «المتجر لسه متفعّلش» — the account and shop were created, data is safe, activation is pending. |
| **ACTIVE** | Trading normally. A warning appears in the last 14 days. | The application. |
| **EXPIRED** | The paid period ended on its own. | «انتهت صلاحية الترخيص», with the expiry date. |
| **SUSPENDED** | You switched access off before that date. | «تم إيقاف الوصول مؤقتاً» — suspended by the administrator, **no data has been deleted**, contact the administrator. |

These are four different messages because they need four different responses
from the person reading them. Telling a brand-new signup that their licence
expired sends them looking for a renewal button; telling a suspended shop the
same sends them looking for one instead of picking up the phone.

**Status outranks the date, in both directions.** A licence suspended with 300
days left is SUSPENDED. A licence suspended and past its date is still
SUSPENDED, because reactivating is what you have to undo first. And a licence
whose date has passed is EXPIRED even though `status` still reads `active` —
nothing writes that column when a date rolls by, and nothing should.

## The manager screen

`/system-admin/licenses`, visible only to a system owner.

Each row shows the shop, its owner's email, the state, the plan label, the
expiry, when the licence last changed, the key, the member count and the
creation date. Search matches shop name, owner email, licence key or store id.
Filter by any of the four states, or click one of the five counters to filter to
it.

## The four actions

Only the actions that apply to a row's state are shown. This is not cosmetic:
each of these functions raises in Postgres for a nonsensical call, and hiding
the button is what stops you discovering that by pressing it.

| State | Buttons |
| --- | --- |
| UNLICENSED | Activate |
| ACTIVE | Extend · Suspend |
| EXPIRED | Extend · Issue new |
| SUSPENDED | Reactivate |

### Activate

Issues a licence, or replaces the one a store has. Inputs: plan label
(BASIC/PRO), licence key (generate or type), expiry date, and an optional
internal note. Quick-pick buttons set the expiry to +1, +3, +6 or +12 months.

The expiry is stored as the **last moment of the chosen day**, local time, so
"valid until the 30th" means the shop works all day on the 30th.

### Extend

Pushes the expiry out by 30, 90, 180 or 365 days, or to a date you pick.

Days are added **on the server** to `GREATEST(now(), valid_until)`. Extending a
licence that lapsed three months ago by 30 days gives the shop thirty days from
**today** — adding to the old date would hand them a licence that is still
expired.

Extending an expired licence also sets it back to `active`, because that is what
the customer means by "extend".

A **suspended** licence is refused: reactivate it first. Quietly switching a
shop back on because someone reached for the wrong button is the one mistake
this screen must not make easy.

### Suspend

Switches access off immediately, with an optional internal note (kept with the
licence, never shown to the customer — e.g. "September subscription unpaid").

The licence row is kept, the dates are kept, and **not one business record is
touched**. Suspension changes access and nothing else.

### Reactivate

Undoes a suspension in one click, restoring the licence exactly as it was, with
the same key and the same expiry. Refuses anything that is not suspended — on an
expired licence it would appear to work and change nothing, and you would think
the shop was open when it was not. That case is Extend.

## Public signup, and who grants first access

Signup is open to anyone. Using the ERP is not. NEXUS CORE is sold by hand, and
the **System Owner is the only authority that grants a new store its first
access** — there is no trial, no self-service activation and no billing hook
that could grant one.

The lifecycle, end to end:

| # | Step | State |
| --- | --- | --- |
| 1 | Visitor completes public signup (leaked-password check, then Supabase Auth) | account exists |
| 2 | On first sign-in `claim_store` creates the store and an ADMIN membership | store exists, **UNLICENSED** |
| 3 | Every business route redirects to the lockout screen | cannot use the ERP |
| 4 | Every business **write** is refused by Postgres | cannot use the API either |
| 5 | The store appears in `/system-admin/licenses` as **بدون ترخيص** | visible to the owner |
| 6 | Owner presses **تفعيل**, issues a key and an expiry | **ACTIVE** |
| 7 | The lockout screen's poll notices within a minute and lets them in | working ERP |

**`TRIAL_DAYS` is 0 and must stay 0** unless a trial is an explicit product
decision. `claim_store` writes a licence row *only* when it is greater than
zero, so at 0 a new store has no row at all — and no row is `UNLICENSED`. That
is the whole mechanism; there is no separate approval flag to keep in step with
it.

### What the customer sees while waiting

The lockout screen, headed **«المتجر لسه متفعّلش»**:

> الحساب والمتجر اتعملوا بنجاح، وبياناتك كلها في مكانها. لسه محتاج تفعيل
> الاشتراك عشان تقدر تستخدم الشاشات — كلّم الدعم وهيتفعّل.

It says the account was created and nothing was lost, offers logout, and polls
every 60 seconds so that activation needs no second phone call. It does **not**
say the licence expired, does not claim a payment was taken, and does not
mention the System Owner's screens. The four states each have their own copy —
a new signup is never told its licence "ran out", which would send an owner
looking for a renewal button that does not apply to them.

### The other three states

| State | How it is reached | Customer sees | Writes |
| --- | --- | --- | --- |
| **UNLICENSED** | never activated | "المتجر لسه متفعّلش" | refused |
| **SUSPENDED** | owner pressed إيقاف | "تم إيقاف الوصول مؤقتاً" — data untouched | refused |
| **EXPIRED** | `valid_until` passed, or owner set it | "انتهت صلاحية الترخيص" | refused |
| **ACTIVE** | owner activated / extended / reactivated | the app | allowed |

Reactivating or extending returns the store to ACTIVE and access resumes on the
next poll. Nothing is deleted in any state: suspension and expiry stop access,
never data.

## Day-to-day procedure

**A new customer pays.** Find the shop — it will be UNLICENSED, and searching by
the owner's email is usually fastest. Press Activate, generate a key, set the
expiry to the end of the period they paid for, note the payment in the internal
note, save. The customer is in as soon as their app next checks, which is on
their next page load.

**An existing customer renews.** Find the shop, press Extend, pick the period
they paid for, add a note. Works the same whether they renewed early (added to
their existing expiry) or late (added to today).

**A customer stops paying.** Two options:

* *Let it lapse.* Do nothing. They become EXPIRED on the day and are locked out
  automatically. Gentler, and appropriate when you expect them back.
* *Suspend.* Immediate, and appropriate when you need access to stop now.

**A suspended customer settles up.** Press Reactivate. If their licence had also
expired in the meantime, press Extend afterwards — Reactivate restores the old
expiry, it does not move it.

## What happens to the customer's data

Nothing. In every blocked state:

* Every row stays in the database — products, orders, customers, invoices, the
  whole ledger.
* Sync continues, so anything the shop recorded before the block still uploads.
* The lockout screen tells them their data is safe, in those words, because an
  owner who thinks their data is gone reinstalls or restores a backup and *then*
  loses something.

Access is the only thing that changes, and it comes straight back.

## Verified behaviour

Every transition below was driven on the QA tenant during the audit of
6 September 2026 and checked through the customer's own gate.

| Transition | Verified |
| --- | --- |
| licence deleted → UNLICENSED | Blocked; "not activated yet", not "expired"; 9 of 9 protected routes redirect |
| → ACTIVE | Access restored; data intact |
| → SUSPENDED | Blocked; suspension wording; date labelled "valid until", not "expired on"; 9 of 9 routes redirect |
| → REACTIVATED | Access restored immediately, same licence and expiry |
| expiry set 2 days past → EXPIRED | Blocked; expiry wording. `status` was still `active` — the date alone did it |
| +365 days → ACTIVE | Access restored; new expiry a year from today, not from the lapsed date |

Bypass attempts while suspended — direct URLs, a forged `localStorage` verdict,
and wiping all local state then restoring the session — were all blocked. See
[SECURITY.md](./SECURITY.md).

## Who may do this

Only a **system owner**: an account whose confirmed email is in the allowlist
inside `is_system_owner()`. Every one of the six licence functions re-checks it
in its first statement and raises `42501` otherwise.

A normal store `ADMIN` cannot activate, extend, suspend or reactivate any
licence including their own, cannot see the manager screen, and cannot write
`store_licenses` directly — that table's INSERT, UPDATE and DELETE policies are
`false` for every client role. Verified; see [SECURITY.md](./SECURITY.md).

To change who the system owners are, edit the allowlist in `is_system_owner()`
via a migration. It is deliberately not configurable from the application.

There is **no provisioning screen and no promotion path**, and that is the point:
a migration is a reviewed, version-controlled change, whereas a table row is
something a bug or an over-broad policy could write. A store ADMIN cannot become
an owner, and being an owner is unrelated to store membership — one of the two
current owners is only a `POS_ECOMMERCE` member of one shop.

## One thing left to confirm

The audit could not press these buttons as a system owner — the functions accept
only a real owner session, and no such session was available to fabricate. They
were verified three other ways: their refusal path against a real non-owner
session, their arithmetic evaluated against real rows, and every state they
produce driven through the customer gate.

**No new access is needed to close this.** The allowlist already contains the
address this project is being developed under, so the owner account exists
today. Sign in with it, open `/system-admin/licenses` and press Extend on a test
shop. Ten seconds.
