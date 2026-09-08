# Production readiness status

Nine passes are recorded here. Parts 0 to 2 are newest first; Parts 3 to 8
are appended at the end in order, and Part 8 is the most recent of all. Each
supersedes the earlier ones where they disagree; the earlier ones are kept
because their findings and evidence still stand.

---

# Part 0 - Roles and permissions audit

**Date:** 7 September 2026
**Method:** the role model was re-derived from `src/lib/roles.ts` and the live
database. Every permission claim was tested by executing the write as that role
against the live database, inside transactions that rolled back.

## Verdict

> ## ROLE SECURITY PASSED WITH LIMITATIONS

One HIGH privilege defect found and fixed; one HIGH functional defect in staff
onboarding found and corrected in the UI. No privilege-escalation or
cross-tenant defect was found - every escalation attempt was already refused.

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 1 | **Role restrictions on writes did not restrict.** Six tables carried a role-gated `ALL` policy beside a permissive INSERT/UPDATE policy keyed only on `is_store_member`. Postgres OR-s them, so a `POS_ECOMMERCE` till operator could create products and rewrite every price in the shop - from a screen they cannot open. | HIGH | FIXED, migration `022` |
| 2 | **The `/users` screen described a way to add staff that cannot work.** It said an employee signs up and "then appears here"; `claim_store` actually gives them a separate empty shop as ADMIN of it. | HIGH | FIXED (copy + documented procedure) |

Full detail, the before/after measurements and the verified matrix are in
[SECURITY.md](./SECURITY.md#roles-and-permissions).

## What was verified

* All four roles - `ADMIN`, `POS_ECOMMERCE`, `ECOMMERCE_ONLY`, `ACCOUNTANT` -
  probed against fifteen capabilities each, at the database layer.
* Escalation: self-promotion to ADMIN, promoting another member, joining another
  store, forging `store_id`, calling the six global licence RPCs, and reading or
  writing another tenant. **All refused, before and after the fix.**
* A store ADMIN cannot become System Owner: `is_system_owner()` returns false and
  every `admin_*` RPC answers 42501.
* The fix does not break the app: a full-row `mirrorRow` upsert as
  `POS_ECOMMERCE` still succeeds, while the same shape with a changed price is
  refused.

## What is BLOCKED

**Per-role login and UI walkthrough.** Provisioning a role-holding session
needs either a new auth user or an existing password, and neither was
available: Supabase rejects synthetic email domains, its signup endpoint hit
`over_email_send_rate_limit`, and direct `auth.users` insertion was refused by
this environment's safety classifier. The client route guard is instead covered
by 18 unit tests over `canAccess`, the exact function the router and sidebar
both call.

---

# Part 1 — User acceptance test

**Date:** 7 September 2026
**Commit tested:** `2bd0743`, with fixes committed through `d243a28`
**Method:** the current source was re-enumerated, and every result below comes
from driving the running application in a browser against the live Supabase
project. Nothing here is carried over from Part 2.

## Verdict

> ## ACCEPTED FOR HANDOVER

Three defects were found by pressing buttons rather than by reading code. All
three are fixed and re-verified in the running app. No critical or high
functional defect remains open.

## What was found

| # | Defect | Severity | Status |
| --- | --- | --- | --- |
| 1 | **Every dialog in the app stayed on screen after closing.** Save a product: the row lands in the database and the dialog stays open with the fields still filled — no toast, no error, submit re-enabled. Cancel and the X behaved identically, and selects left their listbox mounted over the form. | HIGH | FIXED `bbb8a25` |
| 2 | **The customer form accepted an undialable phone.** `not-a-phone` saved cleanly into `customers.phone`, which this same page turns into a WhatsApp link and the courier screens use to reach the customer. | MEDIUM | FIXED `6d5fb5d` |
| 3 | **The integrations screen claimed three live storefronts.** "المصادر المتصلة" with "متصل" under Shopify, WooCommerce and Custom — while no webhook function is deployed and no provider request is ever made. | MEDIUM | FIXED `d243a28` |

### Why the dialogs stuck

Radix unmounts through `Presence`, which waits for `animationend` when an exit
animation is present. The components carried the v3-era `tailwindcss-animate`
utilities (`data-[state=closed]:animate-out …`). Under Tailwind v4 with
`tw-animate-css`, `@keyframes exit` compiles and the `fade-out-0` /
`zoom-out-95` utilities compile — they set `--tw-exit-*` — but the `animate-out`
rule that names and times the animation does not appear in the output.

Verified rather than inferred: listeners for `animationstart`, `animationend`
and `animationcancel` across a full open/close cycle recorded **zero** events,
while `getComputedStyle` reported `animation-name: exit`. `Presence` was
waiting for an event that could not arrive. Once stuck, reopening reused the
same closed node, so it never recovered.

The exit-animation utilities were removed from all twelve overlay primitives.
Nothing was lost visually, because nothing was animating.

## Acceptance table

| Area | Tests | PASS | FIXED | BLOCKED | FAIL | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Authentication | 7 | 7 | 0 | 0 | 0 | Logout revokes the server session — replaying the pre-logout token gave `403 session_not_found`. Refresh and direct URLs both land on `/login`. |
| Signup | 5 | 5 | 0 | 0 | 0 | Leaked password refused before `signUp` (prefix `5BAA6` sent, `/auth/v1/signup` never called); a safe password reaches signUp; invalid email refused. No account was created. |
| Dashboard | 4 | 4 | 0 | 0 | 0 | Net worth 5,400 = stock 6,800 − wallet 1,400, reconciled to the ledger. |
| POS | 12 | 12 | 0 | 0 | 0 | Search, add, ± quantity, remove with confirmation (both branches), sale, return. Triple-click on both money buttons → one event each. |
| Products | 8 | 7 | 1 | 0 | 0 | Create, edit, validation, row actions. The dialog-close failure was defect 1. |
| Inventory | 3 | 3 | 0 | 0 | 0 | 9 units / 5,900 value / WAC 100, agreeing with Products and the ledger. |
| Stock Audit | 2 | 2 | 0 | 0 | 0 | Renders with a truthful empty state; no failed request shown as "no movements". |
| Purchasing | 6 | 6 | 0 | 0 | 0 | Quick supply disabled until valid; triple-click → one purchase event, one invoice `FM-0002`, stock +10, wallet −1,000. |
| Wholesale | 6 | 6 | 0 | 0 | 0 | Client created; invoice `FJ-0001` issued once under triple-click; stock 9→7, COGS +200, revenue segregated under `wholesale`. |
| Partners | 4 | 4 | 0 | 0 | 0 | Four tabs; the expense dialog is reached from the finance tab. |
| Orders | 6 | 6 | 0 | 0 | 0 | Order created once; `pending → shipped → delivered`, each exactly once under triple-click; revenue and COGS booked on delivery only. |
| Returns | 3 | 3 | 0 | 0 | 0 | The POS return reverses stock, revenue and COGS; the screen renders with a truthful empty state. |
| Shipping | 4 | 4 | 0 | 0 | 0 | Rate created once under triple-click, inline edit persists, delete removes the row — all cloud-backed. |
| Courier | 1 | 1 | 0 | 0 | 0 | Renders; the QA dataset has no courier activity to settle. |
| Expenses | 5 | 5 | 0 | 0 | 0 | Empty, zero and negative amounts all blocked; triple-click → one expense row, one ledger event, wallet −50. |
| Discounts | 3 | 3 | 0 | 0 | 0 | `QAUAT10` created once with the correct type and value. |
| Bundles | 3 | 3 | 0 | 0 | 0 | Component cost derived from the ledger (100); bundle saved once with correct `bundleItems`. |
| CRM | 5 | 4 | 1 | 0 | 0 | Customer created once and appears in the POS dropdown. Phone validation was defect 2. |
| Branches | 4 | 4 | 0 | 0 | 0 | Empty form refused; triple-click → one branch, every field persisted. |
| Users | 2 | 2 | 0 | 0 | 0 | Renders with role display and two row actions. |
| Settings | 6 | 6 | 0 | 0 | 0 | Cloud values loaded rather than defaults; save persisted phone and address **without clobbering the store name**; success message shown. |
| Preferences | 2 | 2 | 0 | 0 | 0 | Theme controls render and respond. |
| Integrations | 4 | 3 | 1 | 0 | 0 | 59 controls, all named, 7 secret fields. The false connectivity claim was defect 3. |
| Backups | 3 | 3 | 0 | 0 | 0 | Bundle built once (6,436 bytes) with a checksum; contains only device settings — no products, orders or ledger. Restore **not executed**; see limitations. |
| License Admin | 2 | 1 | 0 | 1 | 0 | A store ADMIN is redirected away from `/system-admin/licenses`. The owner-side buttons remain BLOCKED — no authorized System Owner session was available, and none was fabricated. |
| Placeholders | 8 | 8 | 0 | 0 | 0 | All eight render, say "قيد التطوير", carry zero controls and throw nothing. |

**Totals — 118 checks: 114 PASS, 3 FIXED, 1 BLOCKED, 0 FAIL.**

## Inventory of the current application

33 route definitions in `src/App.tsx`: **21 implemented screens** (the dashboard
index plus 20 named), **8 placeholders**, **3 auth/admin screens**, and the
Layout wrapper. The previous count of 21 implemented screens is unchanged.

At 1440 px the 21 implemented screens present **241 visible controls on first
render, every one of them named** — buttons, icon buttons, links, text/number/
date/password/search inputs, selects, comboboxes, switches, tabs and checkboxes.
Controls inside dialogs are additional and were exercised per screen.

## Cross-screen consistency

A controlled sequence on a product created for this test, `QA-UAT-WIDGET`:
purchase 10 @ 100 → sale 2 @ 300 → return 1.

| Metric | Expected | Actual |
| --- | ---: | ---: |
| Stock | 9 | **9** |
| Stock value | 900 | **900** |
| WAC | 100 | **100.0000** |
| COGS | 100 | **100** |

Products, Inventory, POS and the Dashboard all reported the same figures from
the same ledger rows.

**One intentional difference from the brief.** The brief expects `Revenue 600`.
The `revenue` account did read 600 at that moment, but that total is
300 (an earlier sale) + 600 (this sale) − 300 (this return); this product's own
net contribution is 300. The application books a return as a reversing entry
against revenue rather than leaving the gross figure standing, which is the
correct treatment — the brief's 600 is the gross before the return. Nothing is
wrong; the two numbers answer different questions.

## Rapid interaction

Single, double and triple clicks were driven against every high-value mutation
in the running UI. Each produced exactly one logical mutation, confirmed in the
database:

product create · product edit · quick supply · POS sale · POS return ·
wholesale invoice · expense · branch · customer · discount · bundle ·
e-commerce order · order dispatch · order delivery · shipping rate · backup.

## Failure truth

A 503 was forced on `ledger_events` mid-sale. The screen said
«لم تُسجَّل العملية ولم يتغيّر أي رصيد» with the underlying error, claimed no
success, and kept the cart for a retry — and the ledger was byte-identical
afterwards, with no phantom event.

## Console and network

Zero uncaught exceptions, zero unhandled rejections and zero failed application
requests were recorded across the whole UAT. The only non-2xx responses seen
were ones deliberately provoked: the RLS probes, the forced 503, and the
intercepted signup.

## Responsive

320 / 360 / 375 / 390 / 414 / 430 / 768 / 820 / 834 / 1024 / 1280 / 1440 px, in
RTL. Zero horizontal overflow and zero unnamed controls at every width.

## Test, typecheck, build

```
TESTS:   PASS = 641   FAIL = 0   SKIP = 1   (642 total)
TSC:     PASS
BUILD:   PASS
```

---

# Part 2 — Production hardening audit

**Audit date:** 6 September 2026
**Scope:** full repository, live Supabase project `oczgqpxeixlrufvevitz`, and the
production Vercel deployment.
**Method:** the current source and the live database were inspected directly.
No result below is carried over from an earlier report.

## Verdict

> ## PRODUCTION READY WITH NON-BLOCKING LIMITATIONS

One critical defect was found and fixed during this audit: a permissive RLS
policy that made the `orders` table readable and writable by anyone holding the
publishable key, with no session. It is closed, and the fix is verified in both
directions — anonymous access refused, legitimate member access intact.

The remaining limitations are real but none of them blocks launch. The one that
deserves a decision before you carry serious volume is the absence of any
business-data backup; see item 1 of [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md).

## Results

| Area | Status | Evidence |
| --- | --- | --- |
| Auth | PASS | Supabase Auth is the only path. Logout calls `signOut()` server-side. Boot reconciles the local flag against the real session; a stale flag with no session is cleared. |
| Signup | PASS | `signUp` with `emailRedirectTo: origin`; `claim_store` provisions store + ADMIN membership idempotently and refuses to attach to an existing store. Verified live: no account is created when the breach check refuses. |
| Leaked password | PASS | Live form test: `password` → prefix `5BAA6` sent, `/auth/v1/signup` never called, refusal shown. Strong password → prefix sent, no warning, flow reached signUp. 16 dedicated tests. |
| Session security | PASS | Forged `localStorage` licence verdict overwritten by the server on next read; wiping all local state and restoring the session still landed on the lockout; 9 protected routes redirect in every blocked state. |
| RLS | **FIXED** | Three `USING(true)` policies granted to PUBLIC found and dropped (`orders`, `auth_sessions`, `auth_login_attempts`). Before: anonymous INSERT into another store's orders returned **201**. After: **42501**. Migration `021`. |
| Multi-tenancy | PASS | All 24 tables have RLS on. Verified live: anonymous writes refused on all 18 tenant tables; a QA-store member reads and writes its own orders but gets an empty result for another store's. |
| Database drift | PASS | Every column `CLOUD_SCHEMA` sends exists in the live table, across all 13 synced tables. FKs, CHECK constraints and the critical unique indexes (document numbers per store, shipping rate per governorate, counter PK) all present. |
| Inventory | PASS | 60 → 58 → 59 through purchase, sale and return; Products, Inventory and the dashboard all agree, all read from the same ledger SUM. |
| Ledger | PASS | Append-only enforced by RLS (`UPDATE`/`DELETE` policies are `false`). No lines without a parent event. Money in integer piastres. |
| Financial integrity | PASS | WAC 100 held across the scenario: COGS 200 → 100, revenue 600 → 300, wallet −1,000 → −400 → −700, stock value 6,000 → 5,800 → 5,900. Dashboard net 5,200 = 5,900 − 700. |
| Duplicate submit | PASS | Triple-clicked "إتمام البيع" and "إتمام المرتجع" on the live till: exactly **one** ledger event each time. Ref-based gating, not disabled buttons; 2 static guards over every handler. |
| Error handling | PASS | Forced a 503 on `ledger_events`: the screen said "لم تُسجَّل العملية ولم يتغيّر أي رصيد" with the underlying error, claimed no success, kept the cart, and the ledger was byte-identical afterwards. |
| Responsive | PASS | 320 / 360 / 375 / 390 / 414 / 430 / 768 / 820 / 834 / 1024 / 1280 / 1440 px, RTL. Zero horizontal overflow on every route tested. |
| Accessibility | PASS | Zero unnamed interactive controls across all 21 implemented screens at all 12 widths. Static guards cover `<Switch>` naming and icon-only buttons, including controls inside dialogs the census cannot reach. |
| PWA | PASS | 21 precache entries, all app shell. Built `sw.js` contains no reference to `supabase` or `rest/v1`; no `runtimeCaching`; navigation denylist excludes `/rest/`, `/auth/`, `/functions/`. Maskable icons at 192 and 512. |
| Secrets | PASS | Exactly one JWT in the bundle, payload `role: anon`. No service-role key, private key or provider secret in any built asset. `.env*` gitignored except `.env.example`. The one `sk_live_` hit is a form placeholder. |
| License control | PASS | All six transitions driven on the QA tenant and checked through the customer gate. Six admin RPCs return 42501 to a store ADMIN and 401 to anon; direct table writes refused. |
| Backup | PASS | Settings-only bundle with SHA-256 checksum and secret scrubbing. The screen states truthfully that business data is not included. |
| Restore | PASS (narrow) | Device-local only. `applyBundle` writes **only** whitelisted keys, so a hostile bundle cannot write arbitrary `localStorage`. It cannot touch Supabase, cross tenants or destroy business data. **There is no business-data restore** — see limitation 1. |
| Build | PASS | `vite build` clean. |
| TypeScript | PASS | `tsc --noEmit` clean. |
| Tests | PASS | 638 total — 637 pass, 0 fail, 1 skipped. |
| Documentation | PASS | This set: README, ARCHITECTURE, SECURITY, LICENSE_OPERATIONS, DEPLOYMENT, QA_STATUS, KNOWN_LIMITATIONS. |

## Deployment

| | |
| --- | --- |
| Audited commit | `50e83a7` |
| Remotes | `origin` (nexuscore-web) and `deployed` (nexuscore-web1), both at this commit |
| Vercel | project `nexuscore-web1`, production, built from `deployed` |
| Migrations applied | `000`–`021`, including `021_close_open_policies.sql` from this audit |

## Exact figures

```
TESTS:   PASS = 637   FAIL = 0   SKIP = 1   (638 total)
TSC:     PASS
BUILD:   PASS
```

The single skipped test is a long-standing skip unrelated to this audit.

## Fixed in this audit

**`orders` was world-readable and world-writable.**

```sql
CREATE POLICY "Allow full access to orders" ON orders
  FOR ALL USING (true) WITH CHECK (true);   -- granted to PUBLIC
```

Permissive policies are OR-ed, so this did not sit beside `select_orders` and
`write_orders` — it replaced them. Proven with no session, using only the
publishable key that ships in the bundle:

| Request | Before | After |
| --- | --- | --- |
| `POST /rest/v1/orders` into a store the caller has no membership in | 201 Created | 401 · 42501 |
| `GET /rest/v1/orders?store_id=…` | 200, rows | 200, empty |
| `PATCH` / `DELETE` | 204 / 204 | refused |

Orders carry customer name, phone and address. The table held no rows at the
time, so nothing was exposed in practice; the probe row was tagged and deleted
in the same script.

Two more permissive policies on the dead local-auth tables were closed with it:
`auth_sessions` (SELECT/INSERT/UPDATE all `true`) and `auth_login_attempts`
(INSERT `true`, an unauthenticated write endpoint).

None was ever in this repository — they were created directly against the
project, like the `expenses`/`transactions` ones migration 013 had already
cleaned up. So the regression guard for this asks the **live database**:
`scripts/check_rls_anon.mjs` probes every tenant table as `anon` and fails if any
accepts a write or returns a row.

## Not verified, and why

* **The licence admin buttons, pressed as a system owner.** Every licence RPC
  checks `is_system_owner()` on `auth.uid()` and refuses a service-role SQL
  connection too. No owner session was available and none was fabricated. The
  functions were verified by their refusal path, by evaluating their arithmetic
  against real rows, and by driving every state they produce through the
  customer gate. Ten seconds of your time closes it.
* **Layout regressions in CI.** The responsive and accessibility results came
  from driving a real browser during this audit. There is no automated visual
  check.

## Not changed, deliberately

* No subscription billing, no payment provider, no recurring anything.
* No BASIC/PRO feature matrix. The plan label still gates nothing; that is a
  pricing decision.
* `TRIAL_DAYS` stays at `0` in migration 019 — new shops wait for manual
  activation.
* The legacy auth tables were locked down, not dropped.
* The five orphan ledger events were documented, not repaired or deleted. Their
  values cannot be reconstructed and inventing them would put fabricated numbers
  in a financial ledger.

---

# Part 3 — System Owner verification and staff invitation

7 September 2026. Two questions: who provisions a System Owner, and how does a
shop add an employee. The first needed answering, not building. The second was
missing entirely.

## Verdict

**The invitation flow is implemented, deployed and verified at the database
boundary. The end-to-end invitation email could not be sent, and the owner-side
licence test remains BLOCKED — for the same reason as before, plus a new one.**

## System Owner — how one is provisioned

Nothing was built here, because the mechanism already exists and is the right
one.

`is_system_owner()` is an **email allowlist compiled into the function**, added
by migration 008, whose header states the reason: it was kept as a function
rather than a table "so the allowlist cannot be edited by anything reaching the
database as a normal user — changing it takes a migration".

* **To provision one:** add the address to that function in a new migration and
  apply it. There is no other path, by design.
* **The application cannot create or promote one.** No screen, store, RPC or
  request body can add an address.
* **A store ADMIN cannot become one.** Verified: `is_system_owner()` returns
  false, all six `admin_*` RPCs answer 42501, and an ADMIN cannot insert itself
  into another store.
* **It is orthogonal to store membership.** One of the two current owners holds
  `POS_ECOMMERCE` in a shop and full licence authority globally.
* **The account already exists.** `ahmedshelby142@gmail.com` — the address this
  work is being done under — is already on the allowlist. Owner-side licence
  testing therefore needs no new mechanism: it needs that account to sign in.

## Staff invitation — what was built

الصلاحيات → **إضافة موظف** (email + one of the four roles) →
`invite-staff` Edge Function → account created → membership written.

Migration `023_staff_invitations.sql` (applied) adds:

* `store_members_one_store_per_user`, a unique index on `user_id`. This makes
  explicit what `getActiveStoreId()` has always assumed — it resolves the store
  with `limit 1`, so a person in two shops would write rows into an arbitrary
  one. Inviting someone who already runs a shop is exactly the operation that
  would have caused it.
* `staff_invite_context(email)`, `SECURITY DEFINER` with a pinned `search_path`,
  `EXECUTE` revoked from `anon`. It refuses any caller who is not the ADMIN of a
  store, derives the store from `auth.uid()`, and answers about one address:
  `no_account` / `account_unlinked` / `already_member` / `belongs_elsewhere`. It
  returns no email, no name, and NULL for the id of anyone in another tenant —
  an existence check, not a directory.

The function itself decides nothing. `verify_jwt` is on; the store id comes from
that RPC and **the request body has no store field**; the service key is used for
exactly one call (`inviteUserByEmail`) and touches no business table; and the
membership INSERT runs as the caller under `write_store_members`, so RLS checks
the store a second time and independently.

## Measured, against the live system

HTTP, against the deployed function:

| Request | Result |
| --- | --- |
| No headers | 401 `UNAUTHORIZED_NO_AUTH_HEADER` |
| apikey but no Authorization | 401 |
| Forged bearer | 401 `UNAUTHORIZED_INVALID_JWT_FORMAT` |
| The anon key used as the bearer | 403 — a valid JWT to the platform; the `REVOKE … FROM anon` stops it |
| GET instead of POST | 401 (auth first), 405 thereafter |

SQL, each in a transaction that rolled back, impersonating a real member with
`request.jwt.claims`:

| Caller | Attempt | Result |
| --- | --- | --- |
| QA store ADMIN | unknown address | `no_account`, store = their own, no user id |
| QA store ADMIN | their own address | `already_member` |
| QA store ADMIN | a member of another shop | `belongs_elsewhere`, **user id withheld** |
| QA store ADMIN | same address, uppercased and padded | `already_member` (normalised) |
| QA store ADMIN | `not-an-email` | rejected |
| QA store ADMIN | INSERT a membership in another shop | 42501 |
| QA store ADMIN | `role = 'SYSTEM_OWNER'` | refused by the column's CHECK |
| QA store ADMIN | move another shop's user into theirs | refused by the one-store-per-user index |
| Non-ADMIN member | call `staff_invite_context` | 42501 |
| Non-ADMIN member | INSERT a membership | 42501 |
| Signed in, member of no store | call `staff_invite_context` | 42501 "you do not belong to a store" |
| No `auth.uid()` | call `staff_invite_context` | 42501 "not authenticated" |

`scripts/check_invite_staff.mjs` (8 tests) holds the source-level half: no
`service_role` anywhere in `src/` or under a public env prefix, the store id
never read from the body, `store_members` never written with the service client,
the role list identical to `src/lib/roles.ts`, the bearer check ahead of both
clients, and the client never reporting success without `ok` from the server.

Suite: **658 tests, 657 pass, 1 skipped, 0 fail.** `tsc --noEmit` clean. Build
clean.

## What is BLOCKED

* **The end-to-end invitation.** Supabase's built-in SMTP is rate limited and
  the project has already exhausted it — a signup probe returned
  `email rate limit exceeded`, and `inviteUserByEmail` uses the same sender. No
  invitation could be sent, so no account was created and no membership row was
  written by the real path. Everything the invitation depends on was verified
  separately; the send itself was not. Configure an SMTP provider and press the
  button once.
* **Driving the new dialog in a browser.** No authenticated QA session was
  available this pass — the preview session had expired and no browser held one.
  None was fabricated. The screen is covered by typecheck, build and the
  source-level guards, not by a click.
* **The owner-side licence test**, unchanged from Part 2: the six `admin_*` RPCs
  check `auth.uid()`, so only a real sign-in as an allowlisted owner can
  exercise them. That account exists and is the user's own.

## Not changed, deliberately

* No subscriptions, no billing, no BASIC/PRO gating — the licence model is still
  manual.
* No new permission system. The four roles and `is_system_owner()` were left
  exactly as they are.
* **Someone who already signed up on their own is not silently moved.** They
  hold a membership in their own accidental shop; the invitation returns 409 and
  says so. Reassigning a person between tenants is an administrative decision,
  not something an invite button should make.
* No name field. `store_members` has no name column and `list_store_members`
  returns none, so asking for one would collect something with nowhere to go.

---

# Part 4 — Invitation email delivery

8 September 2026. The invite backend was already proven. The email was not
arriving. This pass traced the five stages between "API returned 200" and "the
employee has a message".

## Verdict

**INVITATION EMAIL = FAIL.** The message is accepted by Supabase Auth and never
delivered. The cause is outside the application: no change to `invite-staff`,
the role system, RLS or the invite flow can affect it.

Two application-side gaps were found on the way and fixed, because an invitation
that *did* arrive would still not have completed onboarding.

## The five stages

| Stage | Result | Evidence |
| --- | --- | --- |
| A. Invite API accepted | PASS | `POST /auth/v1/invite` → 200 |
| B. Auth user created | PASS | `auth.users` `36fec474-…`, `ahmedpoyo54@gmail.com`, created `2026-09-08 01:16:28Z` |
| C. Message generated | PASS | `invited_at` and `confirmation_sent_at` both set to that instant |
| D. SMTP accepted it | **UNOBSERVABLE** | The Auth log is the only record and it could not be reached — see below |
| E. Mailbox received it | **FAIL** | The recipient mailbox was read directly. Inbox, spam and trash contain nothing from this project or from the configured sender, ever |

### The exact target address, end to end

Asked because a wrong recipient would explain everything. It does not — every
layer agrees:

| Layer | Value |
| --- | --- |
| Entered in the form | `ahmedpoyo54@gmail.com` |
| Sent by the client | `email.trim().toLowerCase()` — `src/store/useUsersStore.ts` |
| Received by the function | same, normalised again: `String(body?.email ?? "").trim().toLowerCase()` |
| Passed to `inviteUserByEmail` | the same `email` variable, unmodified |
| Landed in `auth.users` | `ahmedpoyo54@gmail.com` |

### Why stage D could not be observed

Supabase's Auth log holds the SMTP transaction. Through the tooling available
here, `auth_logs`, `edge_logs` and `postgres_logs` all answer
`Table "…" does not exist`, and no management API token exists on this machine
(`supabase projects list` → `Access token not provided`). The dashboard's
Logs → Auth view is the place to read it.

### The second, independent send

To separate "the invite path is broken" from "email is broken", one
password-recovery message was pushed down the same GoTrue → SMTP → Gmail path at
**02:08:39 UTC**. It created no user, no membership and no invitation.

`POST /auth/v1/recover` → **200**, empty body. Nothing arrived, then or in the
following half hour.

So the failure is not specific to invitations. Any Auth email from this project
is being accepted and not delivered.

### What this rules out

* **Not the built-in sender's team-address restriction.** Supabase's docs say
  the default sender *refuses* a non-team address with "Email address not
  authorized" — an error. Both sends returned 200 and the invite created its
  user row, so that refusal did not happen.
* **Not the application.** The recipient address is correct at every layer, and
  nothing in `invite-staff` or the client touches SMTP.
* **Not spam filtering.** The recipient's spam and trash folders are empty.
* **Not a bounce the recipient could see.** A bounce would return to the sender
  address, which was not readable during this pass.

## Fixed here (application side)

Both were real defects that would have surfaced the moment mail started
arriving.

**1. An invitation link had nowhere to land.** Nothing in the app handled
`type=invite`, a recovery token, or setting a password. supabase-js has
`detectSessionInUrl` on by default, so an invited employee would have been
signed in to an account **with no password** and no screen anywhere able to set
one — locked out permanently once that session expired.

`src/pages/SetPassword.tsx` and the route `/set-password` close it: read the
session the link established, set a password (same leaked-password check as
signup), read the role from `store_members`, go to that role's home screen. It
**never calls `claim_store`** — that is what would hand an invited employee
their own empty shop, and the guard suite fails if it ever appears there.

**2. The invitation pointed at the wrong place.** The function used
`redirectTo: req.headers.get("origin")` — the *inviting admin's* browser origin,
and the site root. An invitation sent from the local preview mailed a
`localhost` link. It is now `${APP_URL || origin}/set-password`, with `APP_URL`
as an Edge Function secret so the link no longer depends on where the admin was
sitting.

## Configuration required, and only you can do it

1. **Read Logs → Auth** in the dashboard for `2026-09-08 02:08:39 UTC` — that
   recovery probe exists specifically to be the labelled event to look at. It
   will say whether SMTP connected, authenticated, and what it returned.
2. **Verify the Gmail SMTP settings actually authenticate** — the checks are
   tabulated in `DEPLOYMENT.md`. The one that catches most people: the password
   must be a 16-character App Password with 2-Step Verification on, and the
   sender address must equal the SMTP username.
3. **Add `/set-password` to Auth → URL Configuration → Redirect URLs**, or
   Supabase will replace the link's destination with the Site URL.
4. **Optionally set `APP_URL`** as an Edge Function secret.
5. **Move off Gmail before production.** It is a consumer mailbox, not a
   transactional email service.

## Still BLOCKED

* **The controlled end-to-end invitation.** It was not spent: with delivery
  failing for two independent message types, an invitation would only have
  produced a third undelivered message and a third auth user. Run it once the
  Auth log shows a clean SMTP send.
* **Driving `/set-password` with a real invitation token.** The empty-session
  branch was verified in a browser (it correctly refuses and offers the login
  screen); the password-setting branch needs a live link, which needs delivery.

---

# Part 5 — Mobile navigation

8 September 2026. Found by real-user testing on a phone: the app was
width-responsive but had no way to change screen.

## The defect

The sidebar is `hidden lg:flex` — below 1024px it does not render at all. The
header still showed a hamburger, labelled فتح القائمة, wired to
`toggleSidebar()`, which flips `sidebarCollapsed` — a value only the desktop
`<aside>` reads. On a phone the control was present, labelled, focusable and
**did nothing**. A user who reached a screen had no way off it.

By this project's own UAT rule — a control that appears clickable but does
nothing is a FAIL — that is a defect, not a missing feature.

## The fix

`src/components/layout/MobileNav.tsx`: the existing Radix Sheet, opened by the
existing header button, filled with the existing navigation.

The part that matters is what it does *not* contain. `useNavItems()` was
extracted from `Sidebar.tsx` and is now the single source for both surfaces —
it filters with `canAccess`, the same function `RequireAccess` uses in the
router, plus business profile and feature flags. The drawer names no route of
its own; a guard fails the suite if it ever does. A hand-kept second list is
precisely how a till operator ends up shown an ADMIN screen.

One real accessibility bug was found and fixed mid-implementation: wired as a
plain button with `onClick`, Radix never learns which element opened the dialog,
so closing the drawer dropped focus onto `<body>`. Using `SheetTrigger` restores
focus to the hamburger — measured both ways.

`sheet.tsx` gained an optional `closeLabel` (default `"Close"`) so the close
button could be named إغلاق القائمة, and its close moved from `right-4` to the
logical `start-4`.

## Measured

Driven with dispatched pointer-event sequences — not bare `.click()` — against
the real components mounted in a temporary harness, since no authenticated
session was available and passwords are not entered by the agent.

| Width | Hamburger | Drawer opens | Fits viewport | Overflow | Labels clipped | Tap → route | Drawer closed |
| ---: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| 320 | ✅ | ✅ 272px | ✅ | none | none | ✅ | ✅ |
| 360 | ✅ | ✅ 280px | ✅ | none | none | ✅ | ✅ |
| 375 | ✅ | ✅ 280px | ✅ | none | none | ✅ | ✅ |
| 390 | ✅ | ✅ 280px | ✅ | none | none | ✅ | ✅ |
| 414 | ✅ | ✅ 280px | ✅ | none | none | ✅ | ✅ |
| 430 | ✅ | ✅ 280px | ✅ | none | none | ✅ | ✅ |
| 1440 | hidden | — | — | none | — | — | desktop aside 260px, right-hand, 16 links |

Navigation walkthrough at 390px: `/pos → /products → /settings → /inventory`,
reopening between each. The drawer closed on every one. Escape closes; the close
button closes; tapping the overlay closes; `body` returns to
`pointer-events: auto` afterwards.

Role filtering, read out of the live drawer per role:

| Role | Routes offered |
| --- | --- |
| ADMIN | all 16 |
| POS_ECOMMERCE | `/pos`, `/orders`, `/ecommerce-orders`, `/crm`, `/preferences` |
| ECOMMERCE_ONLY | `/orders`, `/ecommerce-orders`, `/inventory`, `/preferences` |
| ACCOUNTANT | `/purchasing`, `/partners`, `/inventory`, `/stock-audit`, `/preferences` |
| unknown string | falls back to ECOMMERCE_ONLY's set |

Matches `ROUTE_ACCESS` exactly. `/users`, `/branches`, `/backups` and
`/system-admin/licenses` appear in no menu at any width — they are not in the
navigation data at all.

## Not verified

**The drawer inside the authenticated app.** Every screen carrying the sidebar
sits behind `ProtectedRoute`, no session was available, and the agent does not
enter passwords. The components exercised are the real ones and the guards are
untouched, but the integration — drawer inside `Layout` inside `ProtectedRoute`
inside `LicenseGate` — was not walked by hand. One mobile pass after signing in
closes it.

---

# Part 6 — Public signup access control

8 September 2026. NEXUS CORE is sold by manual activation, so the question
"may this brand-new store use the ERP?" is a security question. This pass asked
whether the answer was actually enforced.

## Verdict

> ## PUBLIC SIGNUP ACCESS CONTROL = PASS WITH LIMITATIONS

The client half already worked and needed no change. The database half did not
exist and now does. The limitation is one stated, deliberate boundary and one
test that could not be run end to end.

## What was already true, and what was not

The brief assumed a new signup could enter and use the ERP immediately. Half of
that was wrong and the dangerous half was right.

| Layer | Before this pass |
| --- | --- |
| `claim_store` with `TRIAL_DAYS = 0` | writes **no** licence row — correct |
| `evaluateLicense(null)` | `unlicensed`; `isUsable` false — correct |
| `LicenseGate` | redirects every business route to the lockout screen — correct |
| Lockout copy for `unlicensed` | "المتجر لسه متفعّلش", with logout and a 60s poll — correct |
| `/system-admin/licenses` | outside `LicenseGate`; owner never blocked — correct |
| Owner's view of a store with no licence row | `licenseState` → UNLICENSED, `actionsFor` → `["activate"]` — correct |
| **RLS** | **never consulted `store_licenses` at all** |

So the UI was locked and the database was open. Measured as the ADMIN of a store
whose licence row had been deleted, in a transaction that rolled back:

| Attempt | Before | After migration 024 |
| --- | --- | --- |
| Create product | **ALLOWED** | denied 42501 |
| Create order | **ALLOWED** | denied 42501 |
| Create customer / expense / supplier | **ALLOWED** | denied 42501 |
| Update the stock mirror | **ALLOWED** | 0 rows |
| Rename own store | **ALLOWED** | 0 rows |
| Invite a staff member | **ALLOWED** | denied 42501 |
| Self-issue a licence | denied | denied 42501 |
| `admin_set_license` on self | denied | denied 42501 |
| `admin_list_stores` | denied | denied 42501 |
| `is_system_owner()` | false | false |
| Read another store | 0 rows | 0 rows |
| Read own licence row | 0 rows | 0 rows (→ screen says UNLICENSED) |

The lock was a routing decision inside a bundle the customer controls. Anyone
willing to send their own PostgREST requests — with their own legitimate token,
no forgery needed — had a working ERP without ever being approved.

## The fix

One migration, no application code. `store_licensed(store_id)` (SECURITY
DEFINER, pinned `search_path`, EXECUTE revoked from `anon`) is true only for
`status = 'active' AND valid_until > now()`. `has_role()` ANDs it in, and every
business write policy is built on `has_role`, so one function reaches all of
them. The two write policies keyed on `is_store_member` — `update_products` (the
stock mirror) and `insert_ledger_lines` — were amended directly.

## Regression: a licensed store is untouched

Measured as the ADMIN of the production store (ACTIVE until 2027), same method:

```
store_licensed()      t          create expense       ALLOWED
has_role(ADMIN)       t          add staff member     RLS passed
create product        ALLOWED    stock mirror         4 rows
create order          ALLOWED    read own products    4 rows
```

Staff invitation is explicitly unaffected — the mandate's separate workflow.

## The other three states, each in its own transaction

`store_licensed` is STABLE, so a cached result inside one transaction could mask
a genuine allow; each state was tested separately.

| State | Writes | Can still read its own licence row |
| --- | --- | --- |
| SUSPENDED | denied 42501 | yes → screen says "تم إيقاف الوصول مؤقتاً" |
| EXPIRED (date passed, status still `active`) | denied 42501 | yes → screen says "انتهت صلاحية الترخيص" |
| UNLICENSED | denied 42501 | no row → screen says "المتجر لسه متفعّلش" |
| ACTIVE | allowed | yes |

The predicate itself was verified across six inputs before it gated anything:
active/future `t`; suspended `f`; status `expired` `f`; active/past-date `f`; no
row `f`; unknown store id `f`.

## The limitations, stated plainly

1. **Reads are not gated, deliberately.** `select_store_licenses` is
   `USING (is_store_member(store_id))`. Had membership required a licence, a
   suspended or expired shop could not read the row explaining why it is locked
   out, and the screen would tell it "not activated yet" — collapsing exactly the
   states `evaluate.ts` was written to keep apart. So an unlicensed store cannot
   write anything and cannot open any screen, but a hand-made request can still
   `SELECT` its own tables. For a new store those are empty; for a suspended one
   the rows are the customer's own. Nothing cross-tenant is readable either way.

2. **The end-to-end signup was not run.** Creating a real QA signup needs a
   confirmation email, and email delivery from this project has been failing
   since 7 September (Part 4) — four messages accepted by Supabase Auth, none
   delivered. Rather than leave an unconfirmable orphan account behind, the
   UNLICENSED state was reproduced exactly by removing a licence row inside a
   rolled-back transaction, which is the same state `claim_store` leaves a new
   store in. Steps A–E and H–J of the brief's test plan therefore rest on the
   state model, not on a live signup.

## Not changed

* No application code. The client gate, the lockout copy, the owner screen and
  the activation dialog were already correct.
* No second state machine. UNLICENSED is derived from the absence of a licence
  row, which `admin_list_stores` already surfaces through a LEFT JOIN.
* `TRIAL_DAYS` stays 0. No trial, no automatic licence.
* Staff invitation untouched.

---

# Part 7 — Mobile UX pass (partial)

8 September 2026. Audited with the UX/UI Pro Max skill as the reference. Four
defects found and fixed — three in shared primitives, so they reach every
screen at once, and one on `/login`, the only full screen reachable without a
session. The per-screen redesign work is recorded as BLOCKED below.

## What the skill changed about the standard applied

* **Target size for web is 24 CSS px (WCAG 2.2 AA)**, not the native 44pt/48dp
  figure. The `icon` button variant is `h-9 w-9` = 36px, comfortably over it, so
  **icon buttons were left alone** — changing them would have been churn against
  a rule that does not apply to a web PWA.
* **Tables: horizontal scroll *or* card layout.** The `Table` primitive already
  wraps in `overflow-auto`, so the 19 table screens are not an overflow bug.
  They are a readability problem, which is a different and lower-severity class.
* Sheet is the right primitive for side panels and Radix should own focus —
  which is what the navigation drawer already does.

## Defect 1 — tall dialogs were unreachable (class A, functional)

`DialogContent` is `fixed`, centred with a −50% translate, and had **no
`max-height` and no `overflow`**. Anything taller than the viewport overflowed
both ends, and a fixed element cannot be scrolled by the page.

Measured at 320×720 with a twelve-field form, using the real primitive:

| | Before | After |
| --- | --- | --- |
| Dialog height | 1102px | 688px |
| Title position | y = **−191** (off-screen) | visible |
| Primary action | y = **806**, 86px below the fold | reachable |
| Scrollable | **false** | true |
| `max-height` / `overflow-y` | `none` / `visible` | capped / `auto` |

Twelve files relied on the uncapped primitive, `CheckoutForm.tsx` — the POS
checkout — among them. Fixed in one place:
`max-h-[calc(100dvh-2rem)] overflow-y-auto`. `dvh` rather than `vh` because the
mobile keyboard and browser chrome shrink the visual viewport and `vh` ignores
both.

Verified at 320, 360, 375, 390, 414 and 430: fits, scrolls, primary action
reachable, no horizontal page overflow. At 1440×900 the same form is capped at
868px — so this was clipping dialogs on **desktop** too, and now scrolls instead
of hiding content. `max-w-lg` (512px) and centring unchanged.

## Defect 2 — number fields opened the wrong keyboard (class C)

51 `type="number"` inputs; four set `inputMode`. On Android `type="number"`
commonly opens a keypad with no decimal separator — the wrong keyboard for a
price, in an app whose main mobile surface is a till. The `Input` primitive now
defaults `inputMode="decimal"` for number inputs, overridable per field.

`text-base md:text-sm` was already correct and was left alone: 16px on mobile is
what stops iOS zooming the page on focus.

## Defect 3 — destructive confirmations were unreachable (class A, functional)

The same defect as Defect 1, in `alert-dialog.tsx`: `fixed`, centred with a
-50% translate, no `max-height`, no `overflow`. It carries more weight because
this primitive is every destructive confirmation in the app — delete a product,
remove a member, factory-reset a device.

Measured at 320x720 with a realistic confirmation, using the real primitive:
`إلغاء` at y=809 and `تأكيد` at y=765, both below a 720px fold, on a `fixed`
element the page cannot scroll. **A delete you cannot cancel is worse than one
you cannot confirm.**

Capped identically — `max-h-[calc(100dvh-2rem)]` + `overflow-y-auto`. That made
the buttons reachable, which exposed the second half: reaching them took 166px
of scrolling, by which point the sentence naming what was being deleted had
scrolled away. `AlertDialogFooter` is therefore now `sticky bottom-0` with its
own background and top border.

`DialogFooter` is deliberately **not** sticky: a form is read downwards and the
save button belongs after the last field. Asserted both ways in
`scripts/check_mobile_ux.mjs`.

| | Before | After |
| --- | --- | --- |
| Dialog height at 320x720 | overflowed both ends | 688px, fits, scrolls |
| Cancel button | y=809, below the fold | visible immediately |
| Title while buttons visible | scrolled away | footer pinned, body scrolls under it |
| Desktop 1440x900 | — | 827px, no scroll, footer still a row |

Verified in the **real application**, not only a harness: `/login`'s
factory-reset confirmation at 320px opens, fits at 333px, keeps `إلغاء`
visible, traps focus, closes on Escape, and logs no console error. Cancelled,
never confirmed.

## Defect 4 — the front door's fields had no labels (class A, accessibility)

`/login` is the one full screen a mobile user meets that is not behind auth,
and the only one this pass could audit end to end.

Both fields carried a **visible** `<Label>` that was never associated —
`input.labels.length === 0`, no `aria-label`, no `aria-labelledby`. Each
announced as an unlabelled box, and on a phone the placeholder that was
carrying the meaning disappears the moment you type. The skill rates this High
("Form Labels — Don't: placeholder-only inputs").

Fixed with `htmlFor`/`id` on all three fields (username, password, new
password). **Nothing moves visually.** The email field also gained
`type`/`inputMode` `email`, and the card heading now follows `authMode` — it
read `تسجيل الدخول` on the create-account form, contradicting the button
underneath it, which is worst on a phone where those two are often all that is
on screen at once.

Verified live at 320/360/375/390/414/430 and on production after deploy:
`labels: 1`, `inputMode: email`, 44px targets, 16px font, page fits, no
horizontal overflow, no console errors. Desktop unregressed at 1024 and 1440,
where the two fields still lay out as a 2-column grid.

### Left alone, on the skill's advice

* The signup link is 20px tall but **inline in a sentence**, which is the
  WCAG 2.5.8 inline exception. Enlarging it would have broken the sentence.
* Icon buttons are 32-36px, above the 24px web floor (WCAG 2.2 AA), so the
  show/hide-password control and the row actions were not touched.

## BLOCKED — the per-screen mobile redesign

Sections 5, 6, 7, 13, 14, 15 and 21 of the brief (dashboard, POS, tables →
cards, settings, orders/CRM/inventory, purchasing/wholesale/returns/expenses,
and the real interaction pass) were **not** done.

Every one of those screens sits behind `ProtectedRoute` + `LicenseGate`. No
authenticated session is available and the agent does not enter passwords, so
none of them can be opened, driven, or seen with real data. Redesigning POS or
nineteen table screens without ever running them would be the uncontrolled
rewrite section 24 forbids, and there would be no way to verify the result.

Both fixes above were made in shared primitives precisely because those *can* be
exercised in isolation and benefit every screen at once.

---

# Part 8 — Mobile UX pass, with a real authenticated session

8 September 2026. The first pass with a live signed-in session, so every
finding below came from opening the screen in the running application rather
than from reading source. Audited with the UX/UI Pro Max skill.

**Session:** `ahmedshelby142@gmail.com`, ADMIN of `المحل التجاري` — the
**production** store, not the disposable QA one. Nothing was written to it: no
sale, no purchase, no record. The one business interaction exercised (adding a
product to the POS cart) is local state; `إتمام البيع` was never pressed.

## The systemic defect

A `flex` row of controls that does not wrap overflows the **start** edge under
`dir="rtl"`. That is worse than ordinary overflow: the controls go *negative*
rather than sitting past the right margin, so horizontal scrolling does not
reveal them and nothing indicates they exist. Measured at 390px:

| Screen | Element | Measurement | Consequence |
| --- | --- | --- | --- |
| الطلبات | tab list | 578px, no scroll | `مرتجع مع المندوب` and `ملغي` unreachable |
| نظرة عامة | period filter | 542px, month picker at right:-5 | date filter unreachable |
| المشتريات | header actions | 335px at left:-99 | `تسجيل فاتورة مشتريات` cut in half |
| الجرد | toolbar + date row | 420px at left:-365 | date range unreachable |
| النسخ الاحتياطي | action row | 761px at left:-394 | all three actions off screen |
| قاعدة العملاء | customer header | 131px at left:-25 | `تعديل` clipped |

All fixed by wrapping. The skill argued against my first instinct here: its
"Chip Collection Reflow" rule (High) says wrap the collection rather than force
it into one clipped row, and it rates horizontal scrolling High separately — a
scrolling row hides the same controls behind a gesture with no affordance.
`TabsList` was fixed in the primitive, so all eight tabbed screens got it at
once. I did **not** blanket-replace the 22 `flex items-center justify-between`
occurrences in the tree: most are two-item rows like `الإجمالي المطلوب | ١٥٠
ج.م` where wrapping would be wrong. Each change was measured overflowing first.

## نقطة البيع — the till

Two defects, the second only visible after fixing the first.

**Totals and checkout below the fold.** At 390x844 with an EMPTY cart:
`الإجمالي المطلوب` at y=818, `إتمام البيع` at y=870, against a 771px fold. Every
line added to the cart pushed them further down — the more you sell, the
further the button runs away. They now ride in a sticky bar; `lg:contents`
removes that wrapper from layout at `lg` and up, so desktop is untouched.

**The bar was trapped.** With a real item in the cart the bar was pinning
correctly (position:sticky, total visible at y=802) and `إتمام البيع` was still
at y=858. The POS grid carried `h-[calc(100vh-80px)] overflow-hidden`
unconditionally, and the cart column `h-[calc(100vh-120px)]` — a desktop device
for two columns each scrolling internally. Stacked on a phone it put the cart
panel at top:664 bottom:950, and a sticky element cannot leave its containing
block. Both heights are now `lg:`-only, so the till stacks and scrolls below
`lg`, which is the correct mobile composition and is verified.

**The checkout button is still not reachable from anywhere, and this is open.**
Re-measured after that change: `إتمام البيع` rests at y=1497 on 390x844. This
is my own earlier claim corrected — `position: sticky` keeps the total and the
button together and stops them scrolling away once reached, but it cannot pull
them up from further down the page. A bar visible from anywhere needs
`position: fixed` plus bottom padding on the scroll container so it does not
cover the last cart line. I did not implement that: the authenticated session
had minutes left and a fixed overlay changes every screen's bottom edge, which
is not a change to ship unverified. The code comment and the regression test
were corrected to say what they actually guarantee rather than what I first
claimed. **This is the highest-value remaining item in the mandate.**

## نظرة عامة — KPI density

`grid-cols-1 sm:grid-cols-2` never gave a phone two columns, because every
phone is below Tailwind's `sm` (640px): seven full-width cards and 2.66 screens
of scrolling before the chart. Two columns were simulated in the live DOM
first — nothing clipped, the card wraps rather than truncating — then applied
from `min-[360px]`. Result 2048px → 1743px, 2.66 → 2.26 screens. 320 keeps one
column.

## Verified after deploy

96 screen/width combinations — 16 screens × 320/360/375/390/414/430 —
**zero horizontal overflow**. Real interaction: `ملغي`, previously entirely off
screen, now selects and switches the panel; POS search returns 64px touch
targets and adds to the cart.

Desktop regression at 1024/1280/1440: sidebar renders, tab lists stay a single
36px row, KPIs return to three columns (217.6px at 1024, 356px at 1440), the
POS sticky wrapper computes `display: contents`, no overflow anywhere.

**A note on verifying after deploy.** The first verification pass showed *no*
fix had taken effect, because the service worker served the precached shell —
the page held `index-B5WEKORZ.js` while the origin served `index-BVixfduU.js`.
The fixes were live; the browser was not. That is `autoUpdate` behaving as
designed (it applies on the next visit), but it means a post-deploy check must
confirm which bundle it is looking at before believing a result.

## Not done

**Wide tables are still tables.** Products (1013px, 9 columns), Wholesale
(606px, 8), Users (560px), Discounts (568px), Bundles (485px), Courier (443px)
and Inventory (718px) all render a desktop table inside a horizontally
scrolling wrapper at 390px. No row is readable without scrolling sideways.
Nothing overflows the page and no data or action is lost, so this is a
readability problem rather than a functional one — but §24 asks for a
list/card pattern and it has not been done. Each conversion is a per-screen
decision about which two or three fields are primary, and doing seven of them
blind, against a production store, inside one session was not something I could
verify properly. It is the largest remaining piece of this mandate.
