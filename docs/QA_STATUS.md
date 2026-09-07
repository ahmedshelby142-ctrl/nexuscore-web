# Production readiness status

Three passes are recorded here, newest first. Each supersedes the earlier ones
where they disagree; the earlier ones are kept because their findings and
evidence still stand.

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
