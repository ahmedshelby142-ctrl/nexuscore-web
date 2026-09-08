# Security model

The client is the attacker's machine. Every rule that matters is enforced in
Postgres, and the frontend guards exist to make the product usable, not to make
it safe.

Verified against the live project across two passes: the hardening audit of
6 September 2026, and the roles and permissions audit of 7 September 2026 (the
"Roles and permissions" section). Where a claim rests on reading code rather
than exercising it, that is stated.

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

## Roles and permissions

Audited 7 September 2026. Every cell in the matrix below was produced by
executing the write against the live database as that role, not by reading
policy definitions.

### The four roles

There are exactly four, hardcoded in `src/lib/roles.ts` and constrained in the
database by a CHECK on `store_members.role`. There is no role builder, and no
`CASHIER` or `MANAGER` role — those names exist only in `LEGACY_ROLE_MAP`, which
folds old stored strings onto the fixed four (`CASHIER` → `POS_ECOMMERCE`,
`MANAGER` → `ADMIN`).

| Role | Label | Lands on | Responsibility |
| --- | --- | --- | --- |
| `ADMIN` | مدير النظام | `/` | Everything in the shop |
| `POS_ECOMMERCE` | كاشير وأونلاين | `/pos` | The till, orders, the storefront, customers |
| `ECOMMERCE_ONLY` | أونلاين فقط | `/orders` | Orders and the storefront; stock read-only |
| `ACCOUNTANT` | محاسب ومخازن | `/purchasing` | Buying, suppliers, stock, treasury |

An unknown or missing role resolves to `ECOMMERCE_ONLY`, the least privileged —
a typo in a row must not open the safe.

**System Owner is not one of these.** It is a separate, global authority; see
below.

### Enforcement layers

| Layer | What it does | What it is worth |
| --- | --- | --- |
| Sidebar | Hides links via `canAccess` | Cosmetic |
| `RequireAccess` | Redirects a blocked route to `homeFor(role)` | Client-side; editable with dev tools |
| RLS policies | Decides what may be read and written | **The boundary** |
| `products` trigger | Decides which product *columns* a role may change | **The boundary** |
| `is_system_owner()` | Gates the six licence RPCs | **The boundary** |

The Sidebar and the router call the *same* `canAccess`, so a visible link and an
open URL cannot drift apart. Both are a courtesy to honest users; nothing above
the RLS line stops a crafted request.

### Verified write matrix

Each row is the result of attempting the operation as that role, in a
transaction that rolled back. Reproduce with `scripts/role_matrix_probe.sql`.

| Capability | ADMIN | ACCOUNTANT | POS_ECOMMERCE | ECOMMERCE_ONLY |
| --- | :-: | :-: | :-: | :-: |
| Create product | ✅ | ✅ | ❌ | ❌ |
| Change product price / name / codes | ✅ | ✅ | ❌ | ❌ |
| Update product stock mirror | ✅ | ✅ | ✅ | ✅ |
| Delete product | ✅ | ✅ | ❌ | ❌ |
| Suppliers | ✅ | ✅ | ❌ | ❌ |
| Branches | ✅ | ✅ | ❌ | ❌ |
| Expenses | ✅ | ✅ | ❌ | ❌ |
| Orders | ✅ | ❌ | ✅ | ✅ |
| Customers | ✅ | ❌ | ✅ | ✅ |
| Discount codes | ✅ | ❌ | ✅ | ✅ |
| Assign roles (`store_members`) | ✅ | ❌ | ❌ | ❌ |
| Change own licence | ❌ | ❌ | ❌ | ❌ |
| Read another store | ❌ | ❌ | ❌ | ❌ |
| Write another store | ❌ | ❌ | ❌ | ❌ |
| Global licence RPCs | ❌ | ❌ | ❌ | ❌ |

Two rows deserve their reasons:

**The stock mirror is writable by every role, deliberately.** `applyStockMoves`
writes `products.quantity` from الطلبات, which POS_ECOMMERCE and ECOMMERCE_ONLY
own — dispatching or returning an order updates it. Restricting `products`
UPDATE by role would break order handling for exactly the roles whose screen it
is. The mirror is also not authoritative: stock is `SUM(qty_delta)` over
`ledger_lines`, so a tampered mirror misleads nobody and corrects itself.

**Nobody can change their own licence,** not even ADMIN. `store_licenses` has
`false` for INSERT, UPDATE and DELETE on every client role.

### The hole this audit closed

Six tables carried a role-gated `ALL` policy **and** a permissive INSERT/UPDATE
policy keyed only on `is_store_member`:

```sql
write_products    FOR ALL    USING has_role(store_id,'ADMIN','ACCOUNTANT')
insert_products   FOR INSERT WITH CHECK is_store_member(store_id)   -- defeats it
update_products   FOR UPDATE USING      is_store_member(store_id)   -- defeats it
```

Postgres OR-s permissive policies, so the role gate governed nothing but DELETE.
Measured before the fix, as a `POS_ECOMMERCE` member:

| Attempt | Before | After |
| --- | --- | --- |
| `products` INSERT | **ALLOWED** | denied (42501) |
| `products` UPDATE of price | **5 rows repriced** | denied (42501) |
| `products` UPDATE of quantity mirror | allowed | allowed (still works) |
| `branches` INSERT | **ALLOWED** | denied (42501) |
| `suppliers` INSERT | **ALLOWED** | denied (42501) |
| `expenses` INSERT | denied | denied |
| `products` DELETE | denied | denied |
| Self-escalation to ADMIN | denied | denied |

The till operator has no Products screen — `/products` is ADMIN-only — so the UI
hid a door the database had left unlocked. The price columns are what made it
serious: set a price to zero, sell, set it back.

Closed by `docs/migrations/022_role_write_enforcement.sql`, which drops the
eleven redundant policies and adds a `BEFORE UPDATE` trigger on `products` that
refuses a change to any defining column (name, sku, barcode, category,
description, image, both prices, both stock thresholds, isActive, isBundle,
bundleItems, deleted_at, store_id) unless the caller is ADMIN or ACCOUNTANT.

The trigger compares **values**, not which columns appeared in the SET list, so
the sync layer's whole-row upsert passes untouched — verified: a full-row
`mirrorRow` upsert as POS_ECOMMERCE succeeds, while the same shape with a
changed price is refused.

### Privilege escalation

All attempted as a real role, all refused:

| Attempt | Result |
| --- | --- |
| Non-ADMIN sets its own role to ADMIN | 0 rows |
| Non-ADMIN sets another member's role | 0 rows |
| Store ADMIN inserts itself into another store | denied (42501) |
| Store ADMIN calls `admin_list_stores` | denied (42501) |
| Store ADMIN calls `admin_set_license` / `extend` / `suspend` / `reactivate` | denied (42501) |
| Store ADMIN suspends **another** store's licence | denied (42501) |
| Any role writes with a forged `store_id` | denied (42501) |
| Any role reads another store's products | 0 rows |
| `is_system_owner()` for a store ADMIN | `false` |

### System Owner

A global authority, independent of `store_members`. It is an **email allowlist
compiled into `is_system_owner()`**:

```sql
SELECT EXISTS (SELECT 1 FROM auth.users u
               WHERE u.id = auth.uid()
                 AND u.email_confirmed_at IS NOT NULL
                 AND lower(u.email) IN (…));
```

* **How one is provisioned:** by editing that function in a migration and
  applying it. There is no other path.
* **The application cannot create or promote one.** No screen, store, RPC or
  payload can add an address to the list.
* **A store ADMIN cannot become one** — verified above, at the database layer.
* Being a System Owner is orthogonal to store membership: one of the two current
  owners holds `POS_ECOMMERCE` in a shop and full licence authority globally.
* The six `admin_*` RPCs re-check it in their first statement and refuse a
  service-role SQL connection too, because the check is on `auth.uid()` rather
  than a database role.

### Adding a member of staff

There is **no self-service join**, and there must not be: `claim_store` gives an
account with no membership a shop *of its own*, as ADMIN of it, so an employee
who signs up unprompted lands in a separate empty tenant and never appears in
their employer's member list. Until 7 September 2026 the app had no way to add
anyone at all, and the `/users` screen described that signup as the joining
procedure.

A store ADMIN now invites from الصلاحيات → **إضافة موظف** (email + one of the
four roles). What happens behind it:

1. The browser calls the `invite-staff` Edge Function with the admin's own
   session token. `verify_jwt` is on, so an unauthenticated request never
   reaches the code.
2. The function calls `staff_invite_context()` **as the caller**. That function
   reads `store_members` for `auth.uid()`, refuses anyone who is not an ADMIN of
   a store, and returns the store id it derived. **The request body has no store
   field**, so a tampered client cannot aim the invitation at another tenant.
3. Only then, and only to create the auth account, does the function use the
   service key: `auth.admin.inviteUserByEmail`. It touches no business table.
4. The membership row is inserted **as the caller**, under the ordinary
   `write_store_members` policy. RLS therefore re-checks the store independently
   of everything above.

The account is created before the invitation is accepted, so the membership is
in place well before the employee's first sign-in — `claim_store` finds it and
does not create a second shop.

The link lands on **`/set-password`** (`src/pages/SetPassword.tsx`), which reads
the session the link established, sets a password, and sends the employee to
their role's home screen. That screen deliberately does **not** call
`claim_store`: someone arriving there without a membership is not an invited
employee, and improvising a store for them is the exact failure this flow
exists to prevent. The password is held to the same leaked-password check as
signup.

**Delivery of the invitation email is a separate matter from all of the above,
and as of 8 September 2026 it does not work.** See `KNOWN_LIMITATIONS.md` §15
and `QA_STATUS.md` Part 4.

Refused by design, each verified against the live database on 7 September 2026:

| Attempt | Result |
| --- | --- |
| No `Authorization` header | 401, before the function body runs |
| Forged bearer token | 401 (`UNAUTHORIZED_INVALID_JWT_FORMAT`) |
| The anon key used as the bearer | 403 — the platform admits it as a valid JWT, and `REVOKE … FROM anon` on `staff_invite_context` stops it |
| Caller is a member but not ADMIN | 42501 → 403 |
| Caller belongs to no store | 42501 → 403 |
| A store id supplied in the request | Ignored — there is no such field, and RLS re-checks |
| ADMIN inserts a membership in another shop | 42501 |
| `role: "SYSTEM_OWNER"` (or any invented role) | 400, and the column's own CHECK refuses it regardless |
| Inviting someone who already belongs to another shop | 409, and the one-store-per-user index refuses it regardless |
| Inviting an existing member | 409 — change their role in the table instead |
| A malformed address | Rejected by `staff_invite_context` |

`staff_invite_context` is deliberately narrow: it answers about one address the
admin typed, returns no email, no name and no other store's id — `user_id` is
NULL for an address that belongs elsewhere — and refuses non-admins outright. It
is an existence check, not a directory.

**One person belongs to one shop.** `store_members_one_store_per_user` (a unique
index on `user_id`) makes explicit what `getActiveStoreId()` has always assumed:
it resolves the caller's store with `limit 1`, so a person in two stores would
get an arbitrary one and write rows into whichever the database happened to
return. Inviting someone who already runs a shop is exactly the operation that
would have caused that, so it fails loudly instead.

**Nothing here can grant System Owner.** That is an email allowlist compiled
into `is_system_owner()`; changing it takes a migration, and the role column
cannot hold the value anyway.

**Invitations depend on email delivery.** The project uses Supabase's built-in
SMTP, which is rate limited — a probe on 7 September 2026 came back
`email rate limit exceeded`. When the limit is hit the function answers 429 and
the screen says so rather than claiming an invitation was sent. Configure a real
SMTP provider in the Supabase dashboard before relying on this in production.

### Role changes

`store_members.role` is read on every application boot (`useRealtimeSync`
reconciles the session and re-reads the membership) and by every RLS check on
every request.

* **Database side: immediate.** The next request uses the new role; no
  re-login, because `has_role` reads the table rather than a token claim.
* **Client side: on next load.** `useAuthStore.userRole` is set at boot, so the
  sidebar and route guard keep the old role until the page reloads or the
  session is re-established.

A demotion therefore takes effect at the boundary that matters straight away,
while the demoted user may still *see* stale links until they reload — and
clicking one gets them a redirect from the router or a refusal from Postgres.
This was verified at the database layer; the client half is covered by the unit
tests over `canAccess`.

### Branches

`branches` is a directory of shop locations, and roles are **global to the
store, not per branch**. There is no branch-scoped permission anywhere in the
schema or the client: no policy references a branch, and no record is filtered
by one. A user with a role has that role across every branch of their store.
Do not read the Branches screen as an access-control boundary.

## Row-level security

RLS is enabled on **all 24 tables** in `public`.

| Pattern | Applies to |
| --- | --- |
| `SELECT USING (is_store_member(store_id))` | every tenant table |
| `ALL USING/WITH CHECK (has_role(store_id, …))` | writes, per role set |
| `INSERT WITH CHECK (is_store_member(store_id))` | ~~tables where any member may create~~ — removed by migration 022; see Roles and permissions |
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
  documentation, a `Deno.env.get(…)` in an edge function, or a test script
  reading `process.env`. No literal value.
* **`src/` mentions `service_role` nowhere at all**, and no public prefix
  (`VITE_`/`NEXT_PUBLIC_`) carries it. `scripts/check_invite_staff.mjs` walks the
  whole of `src/` on every test run to keep it that way: the one place a service
  key exists is inside the `invite-staff` Edge Function, where Supabase injects
  it, and a key in a Vite bundle would be a public key that bypasses every
  policy in the database.
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
* **Staff invitations depend on Supabase's built-in SMTP**, which is rate
  limited; a probe on 7 September 2026 returned `email rate limit exceeded`.
  Configure a real SMTP provider before relying on invitations. See "Adding a
  member of staff".
* **Roles are global to the store, never per branch.** Nothing in the schema or
  the client scopes a permission to a branch.
* **The client half of role enforcement updates on the next page load**, not
  instantly. The database half is immediate. See "Role changes".
* **No tenant-level backup or restore of business data.** See
  `KNOWN_LIMITATIONS.md`.
* **Five ledger events with no lines** exist in the production store from
  30–31 August 2026. They contribute nothing to any balance. Their quantities and
  costs live in the missing lines and cannot be reconstructed, so they are
  documented rather than invented, and left in place rather than deleted.
