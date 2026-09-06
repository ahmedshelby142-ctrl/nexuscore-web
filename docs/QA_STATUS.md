# Production readiness status

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
