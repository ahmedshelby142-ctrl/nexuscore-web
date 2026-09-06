# Known limitations

Every item here was confirmed during the audit of 6 September 2026. Nothing on
this page is speculation, and nothing that was actually fixed is listed as a
limitation.

Ordered by how much it would cost you if it bit.

---

## 1. There is no backup or restore of business data

**What exists.** `/backups` produces a JSON bundle of the app's `localStorage`
slices — device settings, preferences, feature toggles, integration
configuration — with a SHA-256 checksum, an optional sanitised mode that
replaces secrets with `***`, and a restore that writes back only whitelisted
keys. The screen states plainly, in Arabic, that the file contains **settings
only** and not products, orders, customers, invoices or the ledger.

**What does not exist.** Nothing in this application can back up or restore a
tenant's business data. If a store's rows are deleted, the app has no way to
bring them back.

**Why it is listed rather than fixed.** Business data lives in Supabase, so the
disaster-recovery story is Supabase's — and on the free plan there is no
point-in-time recovery. Building a tenant-level export/restore is a real feature
with real risks (a restore that is not perfectly tenant-scoped is worse than no
restore), and it was out of scope for a hardening pass.

**What to do.** Either move the project to a Supabase plan with PITR, or take
periodic `pg_dump` snapshots out-of-band. Until then, treat deletion as
permanent. The append-only ledger limits the damage: `ledger_events` and
`ledger_lines` cannot be updated or deleted by any client role, so ordinary
application use cannot destroy financial history.

---

## 2. Leaked-password protection is disabled at the project level

Supabase can check passwords against known breach corpora at the Auth API, but
only on a paid plan. The setting is **off**.

`src/lib/security.ts` implements the same check client-side, using HIBP's
k-anonymity range API, and it is wired into the signup form. That is a genuine
protection and it was verified working — but it guards **the form**, not the
API. An account created through any other path (the Supabase dashboard, a direct
call to `/auth/v1/signup`, a future admin tool) skips it entirely.

It also **fails open** by design: an outage at the range API lets the signup
through rather than blocking registration.

**What to do.** Enable the project setting when the plan allows. The client-side
check can stay; the two are complementary.

---

## 3. There is no cloud password-change flow

The change-password UI in `src/pages/Login.tsx` is unreachable: it renders only
when `mustChangePassword` is true, and nothing sets it true any more — the only
setter was in the local-login branch removed for security reasons. The handler it
calls writes the legacy `users` table, which has RLS on and no policies and is
therefore inert.

Users change their password through Supabase's own password-recovery email.

**Not invented for this audit.** Building a proper flow means calling
`supabase.auth.updateUser({ password })` behind a re-authentication step, which
is a feature, not a fix. The leaked-password guard is already wired into the
dead handler, so it will be correct the day the flow is revived.

---

## 4. Five ledger events with no lines

In the production store, from 30–31 August 2026:

| Kind | Count |
| --- | --- |
| `stock_adjustment` | 3 |
| `purchase` | 2 |

An event carries the fact; the lines carry the quantities and amounts. These
have no lines, so they contribute **nothing** to any balance — every screen's
arithmetic is correct and unaffected.

They cannot be repaired. The quantities and costs existed only in the missing
lines, and there is no other source to reconstruct them from. Inventing values
would put fabricated numbers into a financial ledger, so they are documented and
left in place rather than deleted, since deleting them would erase the record
that something happened.

The `ledger_lines → ledger_events` foreign key means the reverse orphan — a line
with no parent — cannot occur, and there are none.

---

## 5. No integration is live

`/integrations` configures Paymob, shipping carriers and online-order intake.
Four edge functions exist in `supabase/functions/`
(`handle-ecommerce-order`, `handle-paymob-webhook`, `handle-shipping-webhook`,
`handle-subscription-webhook`) but **none is deployed** — the Supabase project
reports zero edge functions.

The screen therefore stores configuration and does not exchange traffic with any
provider. It does not claim otherwise: the cards show a "not verified" state
rather than a false "connected", and no integration secret is persisted to
`localStorage`.

Treat the integrations screen as configuration-ahead-of-deployment.

---

## 6. Plan labels gate nothing

`store_licenses.plan_type` is `BASIC` or `PRO`, and it is settable and displayed.
No feature is withheld on the basis of it: `isPlanFeatureEnabled` resolves
through a stub that answers `true`, and its only consumer is a component nothing
renders.

Licence **validity** — the subject of the manual licence model — is fully
enforced and entirely independent of the plan label. Only the tier is decorative.

Deciding which features belong to PRO is a pricing decision, not an engineering
one, so nothing was changed. The dashboard's upgrade prompt currently advertises
a restriction that is not enforced.

---

## 7. The application cannot work offline

The PWA installs and launches offline because the shell is precached, but every
screen reads through Supabase and there is no offline write queue. Offline, reads
fail honestly and writes reject with a message.

This is deliberate. Caching business data would serve stale prices and stock
counts, and an offline write queue would make a write look like it succeeded
before it had. Do not read "PWA" as "works on the road".

The licence verdict cache is the one exception, and it is bounded to three days
so a suspension cannot be outrun by staying offline.

---

## 8. Dead code and legacy scaffolding

None of this is reachable or deployed; it costs nothing at runtime, but it
misleads anyone reading the repository.

* **The legacy local auth system** — `src/lib/api/authServer.ts` and the tables
  `users`, `auth_sessions`, `auth_login_attempts`. Unreachable since the
  `owner`/`owner` fallback was removed. All three tables now have RLS on with no
  policies (deny-all). The tables were **not dropped**, because dropping is
  irreversible and buys nothing over deny-all.
* **`supabase/migrations/`** — a `profiles`/`is_pro` subscription schema from an
  earlier product direction. Must not be applied. `docs/migrations/` is
  authoritative.
* **Roughly ten unreferenced modules** — `PlanGate`, `ProfitDashboard`,
  `ShippingSelector`, `financialSyncService`, `settingsStore`, `themeStore`,
  `supplierTotals`, two `*.selfcheck.ts` files, `example.functions.ts` — plus the
  usual unused shadcn components. All tree-shaken out of the build.

---

## 9. The licence admin buttons have not been pressed by a system owner

Every licence RPC checks `is_system_owner()` against `auth.uid()`. It refuses a
service-role SQL connection as firmly as it refuses a shop admin, which is the
correct design and also means the audit could not exercise the owner's happy
path without fabricating a session — which it did not do.

They were verified three other ways: the refusal path against a real non-owner
session, the extension arithmetic evaluated against real rows, and every state
they produce driven through the customer's gate end to end.

**Closing this takes ten seconds:** open `/system-admin/licenses` as a system
owner and press Extend on a test shop.

---

## 10. Regression cover has a shape, and a hole

638 automated checks cover the ledger arithmetic, duplicate-submission gating,
the licence state machine, accessible names, the cloud-write contract, and — as
of this audit — what an anonymous caller can reach in the **live** database.

What they do not cover: rendered layout. The responsive and accessibility results
in `QA_STATUS.md` come from driving a real browser at twelve widths during the
audit, not from a test that runs in CI. A layout regression would not be caught
automatically.
