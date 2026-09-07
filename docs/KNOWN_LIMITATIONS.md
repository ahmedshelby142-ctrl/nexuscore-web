# Known limitations

Items 1-10 were confirmed during the hardening audit of 6 September 2026;
items 11-14 by the user acceptance test of 7 September 2026; items 15-17 by the
roles and permissions audit of 7 September 2026. Nothing on
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
provider, and it now says so. The cards show a "not verified" state rather than a
false "connected", and no integration secret is persisted to `localStorage`.

The acceptance UAT of 7 September 2026 found one place that still claimed
otherwise: a panel headed "المصادر المتصلة" listing Shopify, WooCommerce and
Custom with "متصل" under each. Those are the adapters compiled into the build,
not connections. It now reads "المنصّات المدعومة" with each marked
"غير مربوط".

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

---

## 11. An access token keeps working for its lifetime after logout

Logout does revoke the session server-side — replaying a pre-logout token
against `/auth/v1/user` returns `403 session_not_found`, confirmed during the
UAT. But the same token still reads data: `/rest/v1/products` answered `200`
with rows.

That is how stateless JWT verification works. PostgREST checks the signature
and the claims; it does not consult the session table on every request, so an
already-issued access token stays valid until it expires (about an hour) even
though no new one can be minted.

The practical exposure is small: the browser no longer holds the token after
logout, so a user cannot restore their own access, and an attacker who had
already taken a copy would have had that window regardless. It is listed
because it is a real property somebody should know before assuming logout is
instantaneous everywhere.

**What would change it:** shortening the access-token lifetime in the Supabase
project settings. There is nothing to fix in this codebase.

---

## 12. Supabase auth errors reach the user in English

The login and signup screens surface Supabase's own error strings verbatim —
"Invalid login credentials", "Unable to validate email address: invalid
format" — inside an otherwise fully Arabic, RTL interface.

The messages are accurate and the flows behave correctly; only the language is
wrong. Every error the application itself raises is already in Arabic. Left
alone deliberately: mapping provider error codes to Arabic copy is a small
feature, not a defect fix, and guessing at the mapping risks turning a precise
message into a vague one.

Severity: LOW. Cosmetic, with no functional impact.

---

## 13. The QA tenant holds the acceptance dataset, and was not wiped

The UAT created a coherent set of records in the QA store
(`db31bbd8-…`): a product with a purchase, a sale, a return and an
e-commerce order against it; a wholesale client and invoice `FJ-0001`; a
purchase invoice `FM-0002`; a branch, a customer, a discount, a bundle, a
shipping rate and an expense.

These were **deliberately not deleted**. The ledger is append-only by design —
`ledger_events` and `ledger_lines` cannot be updated or deleted by any client
role — so removing the documents while the events remain would manufacture
exactly the orphan condition documented in limitation 4. A coherent test
dataset in a disposable tenant is safer than a half-deleted one.

The production store was not touched at any point. One customer row created by
a failing validation test (`phone: not-a-phone`) was removed, and every RLS
probe row was deleted in the same script that created it.

---

## 14. Restore was not executed

`/backups` produces and verifies a bundle, and the create path was exercised
during the UAT — one file, 6,436 bytes, checksummed, containing only device
settings.

Restore was **not run**. It is not unsafe — `applyBundle` writes only
whitelisted `localStorage` keys, so it cannot reach Supabase, cross tenants, or
destroy business data — but running it overwrites the live session's local
state, including the auth slice, and there was no throwaway browser context to
run it in without ending the audit. It is therefore reported as verified by
inspection and by its whitelist, not by execution.

This is separate from limitation 1, which is the larger point: there is no
business-data restore at all.

---

## 15. There is no self-service way to add a member of staff

`claim_store` gives an account with no membership a shop **of its own**, as
ADMIN of it. So an employee who signs up unprompted lands in a separate, empty
tenant and never appears in their employer's member list — `list_store_members`
only ever returns members of the caller's own store.

Linking an account to an existing shop is a manual administrator step, like
activating a licence: insert the `store_members` row (ideally *before* the
employee signs up, so `claim_store` finds it and does not create a second shop),
after which they appear in الصلاحيات and the store ADMIN can set their role.

The `/users` screen used to describe self-signup as sufficient on its own. It
now states the linking step and warns what happens without it. Building an
invite flow is a feature, not a fix, and was out of scope.

---

## 16. Roles are global to the store, never per branch

`branches` is a directory of shop locations. No RLS policy references a branch,
no record is filtered by one, and no permission is scoped to one. A user with a
role holds it across every branch of their store.

This is worth stating because the Branches screen looks like an access-control
boundary and is not one. If branch-level separation is ever needed it is new
work, not a configuration change.

---

## 17. The client half of role enforcement lags by one page load

`store_members.role` is authoritative and is read by every RLS check on every
request, so a role change takes effect **immediately** at the boundary that
matters.

The client copy — `useAuthStore.userRole`, which drives the sidebar and the
route guard — is set at boot. A user demoted while logged in keeps seeing the
old links until they reload, and clicking one gets a redirect from the router or
a refusal from Postgres. Nothing is exposed; the menu is briefly wrong.

Verified at the database layer. A live per-role UI walkthrough could not be run
this pass — see the BLOCKED note in `QA_STATUS.md`.
