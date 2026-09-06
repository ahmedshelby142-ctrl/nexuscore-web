# Security model

The client is the attacker's machine. Every rule that matters is enforced in
Postgres, and the frontend guards exist to make the product usable, not to make
it safe.

Everything below was verified against the live project during the audit of
6 September 2026. Where a claim rests on reading code rather than exercising it,
that is stated.

## Authentication

**Supabase Auth, email and password, is the only way in.**

* Signup calls `sb.auth.signUp()` with `emailRedirectTo: window.location.origin`,
  so the confirmation link returns to the origin the user actually signed up
  from. That origin must be listed under Redirect URLs in the Supabase dashboard.
* Login calls `sb.auth.signInWithPassword()`. The user's role is read from
  `store_members` — the same column the RLS policies read — never assumed from a
  literal.
* Logout calls `supabase.auth.signOut()` **before** clearing local state, so the
  server-side session is ended and not merely forgotten locally.
* On boot, `useRealtimeSync` reconciles the app's local auth flag against
  `getSession()`. A stale local flag with no real session is cleared; a real
  session with a missing local flag is restored, with the role re-read from
  `store_members`.

### Two bypasses that were removed

1. A hardcoded `owner` / `owner` branch in the login screen.
2. The same account one layer down: `authServer.login` fell back to an in-memory
   user table seeded with `owner` / `owner`, role `owner`, whenever
   `getSupabaseClient()` returned null. That condition is identical to "the
   Supabase env vars are absent", so any build served without them accepted
   those credentials from any visitor. Removed; the screen now names the missing
   configuration and refuses. Guarded by `scripts/check_no_login_backdoor.mjs`.

### Session security

* Sessions are Supabase JWTs held by supabase-js in `localStorage`, refreshed by
  the library.
* **Forging local state buys nothing.** Verified: with the licence cache in
  `localStorage` hand-edited to say `active` while the server said `suspended`,
  a reload stayed blocked and the forged cache was overwritten by the server's
  answer.
* **Wiping local state buys nothing.** Verified: clearing every application key
  and restoring the session — the post-logout, post-login condition — landed on
  the lockout screen, still blocked.
* Direct navigation to a protected URL is not a bypass. Verified against nine
  routes (`/`, `/products`, `/pos`, `/inventory`, `/orders`, `/purchasing`,
  `/wholesale`, `/settings`, `/backups`) in each blocked licence state; all
  redirect.

### Password change

**There is no cloud password-change flow.** The change-password UI in
`src/pages/Login.tsx` is reachable only when `mustChangePassword` is true, and
nothing sets it true any more — its only setter was in the removed local-login
branch. The handler it calls (`authServer.changePassword`) writes the legacy
`users` table, which has RLS on and no policies and is therefore inert.

The leaked-password guard is wired into that handler, so it is correct if the
flow is ever revived, but **no password change currently happens** and this
document does not claim otherwise. Users reset passwords through Supabase's own
recovery email. See `KNOWN_LIMITATIONS.md`.

## Leaked-password protection

Supabase offers this as a project setting, but only on a paid plan. It is
implemented in the client instead, in `src/lib/security.ts`, using HIBP's
k-anonymity range API.

* The password is SHA-1'd **locally**. Only the **first five** hex characters
  leave the browser. Verified in the running application: submitting the signup
  form with `password` sent the prefix `5BAA6` and nothing else.
* The suffix is matched locally against the returned list.
* `Add-Padding: true` is sent, so the response size reveals nothing. Padding
  entries carry a count of zero and are **ignored** — counting one would tell a
  user with a good password that it had been breached.
* The request sends no credentials and is not cached.
* **It fails open.** Network error, non-200, a 3-second timeout, a malformed
  body, or no Web Crypto all return "no objection" with a `console.warn`. A
  third-party outage must not stop people opening accounts. A caller therefore
  reads a negative result as *no reason to object*, never as *verified safe*.
* **Nothing about the password is ever logged** — not the password, not the
  hash, not the prefix or suffix. Asserted by a test.
* Wired **before** `sb.auth.signUp()`. Verified: with `password`,
  `/auth/v1/signup` was never called and the form refused.

This is advisory. It is not an authentication boundary and must not be treated
as one.

## Row-level security

RLS is enabled on **all 24 tables** in `public`.

| Pattern | Applies to |
| --- | --- |
| `SELECT USING (is_store_member(store_id))` | every tenant table |
| `ALL USING/WITH CHECK (has_role(store_id, …))` | writes, per role set |
| `INSERT WITH CHECK (is_store_member(store_id))` | tables where any member may create |
| `UPDATE/DELETE USING (false)` | `ledger_events`, `ledger_lines` — append-only |
| `INSERT/UPDATE/DELETE (false)`, SELECT for members | `store_licenses` |
| RLS on, **no policy** (deny-all) | `store_counters`, `users`, `store_alias`, `auth_sessions`, `auth_login_attempts` |

`is_store_member` and `has_role` are `SECURITY DEFINER` with
`search_path = public, pg_temp` pinned. They resolve membership from
`auth.uid()`, so a `store_id` supplied by the client cannot grant anything.

### Three open policies found and closed

The audit read every policy on every table looking for `USING (true)`. Three
turned up, all granted to `PUBLIC`, which includes `anon` — the role the
publishable key in every shipped bundle resolves to.

**`orders` — critical.**

```sql
CREATE POLICY "Allow full access to orders" ON orders
  FOR ALL USING (true) WITH CHECK (true);
```

Postgres OR-s permissive policies, so this did not sit *beside* `select_orders`
and `write_orders` — it replaced them. Every tenant check on the orders table
was decorative. Proven with no session at all and nothing but the publishable
key:

| Request | Before | After |
| --- | --- | --- |
| `POST /rest/v1/orders` into a store the caller has no membership in | **201 Created** | 401 · 42501 RLS violation |
| `GET /rest/v1/orders?store_id=…` for that store | **200, rows returned** | 200, empty |
| `PATCH /rest/v1/orders?id=…` | **204** | refused |
| `DELETE /rest/v1/orders?id=…` | **204** | refused |

Orders carry `customerName`, `customerPhone` and `address`, so this was customer
PII as well as business data. The probe row was tagged `QA-RLS-PROBE-…` and
deleted immediately; the table held no other rows, so nothing was exposed in
practice.

**`auth_sessions`** had SELECT, INSERT and UPDATE all `true` to PUBLIC — a
world-readable, world-writable table named "sessions". **`auth_login_attempts`**
had INSERT `true`, an unauthenticated write endpoint anyone could fill. Both
belong to the removed local auth system and held nothing of value.

All five policies are dropped in `docs/migrations/021_close_open_policies.sql`,
applied. After the fix, isolation was re-verified positively: a member of the QA
store could still read and update its own orders (200 / 204) while an anonymous
caller saw nothing and the same member reading another store's orders got an
empty result.

**None of these policies was ever in this repository.** They were created
directly against the project, exactly as the `expenses` and `transactions` ones
that migration 013 had already cleaned up. That is why the regression guard for
this is `scripts/check_rls_anon.mjs`, which asks the **live database** with the
publishable key rather than reading migration files.

### Verified authorization boundaries

Against the live database, signed in as a real store `ADMIN` (a normal customer
account):

| Attempt | Result |
| --- | --- |
| `is_system_owner()` | `false` |
| All six `admin_*` licence RPCs, on their own store | 403 · 42501 |
| Suspend or revoke **another** store | 403 · 42501 |
| Direct `INSERT` into `store_licenses` | 403 · RLS violation |
| Direct `UPDATE` of their own expiry to 2099 | 0 rows matched |
| Direct `DELETE` of their own licence | 0 rows matched, row still present |
| Read another store's licence | empty |
| Open `/system-admin/licenses` | redirected away |
| Anonymous: admin RPCs | 401 · permission denied for function |
| Anonymous: read `store_licenses` | empty |
| Anonymous: write to any of 18 tenant tables | 42501 on every one |

The licence functions also refuse a **service-role SQL connection**, because the
check is `is_system_owner()` on `auth.uid()` rather than a database role. Only a
real system-owner session passes.

## SECURITY DEFINER functions

Six exist. All have `search_path = public, pg_temp` pinned, so a caller cannot
shadow the objects they reference.

| Function | Callable by | Notes |
| --- | --- | --- |
| `is_store_member`, `has_role`, `member_role`, `list_store_members` | `anon`, `authenticated` | Read-only predicates. Each returns false or an empty set without a session; revoking would break nothing and buy nothing. |
| `claim_store` | `authenticated` | Idempotent; refuses to attach to an existing store. |
| `next_document_number` | `authenticated` | Checks `is_store_member` first; validates the counter name and prefix against a regex. |
| `is_system_owner` | `authenticated` | Allowlist of two email addresses, confirmed-email required. |
| `admin_*` (6) | `authenticated` | Each opens with `IF NOT is_system_owner() THEN RAISE 42501`. |
| `rls_auto_enable` | nobody | EXECUTE revoked from every client role (migration 017). |

## Secrets

* **Nothing but the publishable key reaches the browser.** The built bundle
  contains exactly one JWT-shaped string, and its payload is `role: anon`. No
  service-role key, no private key, no provider secret in any built asset.
* Every `service_role` occurrence in the repository is a *reference by name* —
  documentation, a `Deno.env.get(…)` in an undeployed edge function, or a test
  script reading `process.env`. No literal value.
* `.env`, `.env.local` and `.env.*.local` are gitignored; only `.env.example` is
  tracked.
* Integration secrets are never persisted. `useIntegrationsStore` strips them
  before writing to `localStorage` and purges anything an older build left.
* The one `sk_live_` match in the bundle is a form **placeholder** in the Paymob
  configuration card, not a key.

## Known gaps

These are real and are not claimed to be solved. Full detail in
[KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md).

* **Leaked-password protection is disabled at the Supabase project level.** The
  client-side check is a substitute, not a replacement — it protects the signup
  form, not the Supabase Auth API, so an account created by any other path skips
  it. Enabling the project setting requires a paid plan.
* **No cloud password-change flow**, as described above.
* **No tenant-level backup or restore of business data.** See
  `KNOWN_LIMITATIONS.md`.
* **Five ledger events with no lines** exist in the production store from
  30–31 August 2026. They contribute nothing to any balance. Their quantities and
  costs live in the missing lines and cannot be reconstructed, so they are
  documented rather than invented, and left in place rather than deleted.
