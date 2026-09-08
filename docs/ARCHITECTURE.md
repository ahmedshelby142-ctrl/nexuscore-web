# Architecture

## Shape of the system

```
Browser (Vite SPA, Arabic/RTL, PWA)
   │
   │  supabase-js  →  PostgREST + Auth over HTTPS
   ▼
Supabase project oczgqpxeixlrufvevitz
   ├── Auth              email + password, JWT sessions
   ├── PostgreSQL        24 tables in `public`, RLS on every one
   ├── RLS policies      tenant isolation, enforced in the database
   └── 6 SECURITY DEFINER RPCs (licence administration, store provisioning,
                                document numbering, role predicates)
```

There is **no application server**. The SPA talks to Supabase directly; Vercel
serves static files and nothing else. That single fact explains most of what
follows: every rule that matters has to live in Postgres, because the client is
the attacker's machine.

## Frontend

* **Vite + React**, `react-router-dom` for routing. Not Next.js.
* **Zustand** for state. Stores that own cloud data do *not* persist to
  `localStorage`; stores that own device preferences do.
* **Radix UI + Tailwind** for components, **sonner** for toasts.
* **Arabic, RTL throughout.** `dir="rtl"` at the document level; layout uses
  logical properties so the same CSS serves both directions.

### Routes

32 route entries, from `src/App.tsx`:

| Group | Count | Routes |
| --- | --- | --- |
| Business screens | 21 | index (dashboard), `pos`, `products`, `inventory`, `stock-audit`, `purchasing`, `wholesale`, `partners`, `orders`, `ecommerce-orders`, `courier-ledger`, `returns`, `bundles`, `discounts`, `crm`, `integrations`, `settings`, `preferences`, `branches`, `users`, `backups` |
| Auth / admin | 3 | `/login`, `/license-expired`, `/system-admin/licenses` |
| Placeholders | 8 | `credit-invoices`, `credit-limits`, `reps-activity`, `b2b-sales`, `contracts`, `production-lines`, `raw-materials`, `waste-cost` |

The eight placeholders render a title, a description and an explicit
"هذه الوحدة قيد التطوير" notice. They contain no business logic and no controls.

### Route guarding, outermost first

```
ProtectedRoute      you are signed in
  └── SystemOwnerGate      /system-admin/licenses only; asks the server
  └── LicenseGate          the store's licence is currently usable
        └── RequireAccess  your role may see this screen
              └── screen
```

`/license-expired` sits **outside** `LicenseGate` deliberately — a gate that
redirected to a route it also blocks would loop. `/system-admin/licenses` sits
outside it too, so a system owner whose own shop lapsed can still reach the one
screen that issues licences.

## Multi-tenancy

A **store** is the tenant. Every business table carries `store_id`.

```
auth.users ──< store_members >── stores ──1:1── store_licenses
                  (role)
```

* `store_members(user_id, store_id, role)` is the membership fact. `role` is one
  of `ADMIN`, `POS_ECOMMERCE`, `ECOMMERCE_ONLY`, `ACCOUNTANT`, enforced by a
  CHECK constraint.
* Isolation is **not** enforced in the client. Every policy calls
  `is_store_member(store_id)` or `has_role(store_id, …)`, both `SECURITY DEFINER`
  with a pinned `search_path`, which resolve the caller's membership from
  `auth.uid()`. A client that sends someone else's `store_id` is refused by
  Postgres.
* Provisioning happens in `claim_store(uuid)`, called once at signup while
  already authenticated. It is idempotent: a retry, a second tab or a re-login
  returns the existing store rather than creating a second one, and it refuses
  to attach the caller to a store that already exists.

## Data access

`src/services/cloudData.ts` is the single door to tenant data.

* `cloudList(table)` reads a whole table, **paged**. PostgREST caps a response at
  1000 rows and the cap is invisible — a truncated page is shaped exactly like a
  short table — so reads go through `pageAll()` in `src/lib/pageAll.ts` until a
  short page comes back. The ledger driver uses the same loop.
* `writeThrough(table, row)` sends the row, awaits it, reads back what the
  database stored, and only then commits to local state. It **rethrows** on
  failure, so a caller cannot commit after a failed write.
* A failed read throws. It never returns `[]`, because an empty array is
  indistinguishable from a healthy empty table and reads on screen as data loss.

There is no offline write queue by design. Offline, writes reject and the user
is told.

## The ledger

Money and stock are **event-sourced**. There is no `stock_qty` column and no
stored balance.

```
ledger_events   (id, kind, occurred_at, store_id, …)   append-only
ledger_lines    (event_id, account, subject_id,
                 qty_delta, amount_delta, unit_cost)   append-only
```

* `account` is one of `stock`, `revenue`, `cogs`, `wallet`,
  `receivable_client`, `receivable_courier`, `payable_supplier`, …
* A balance is `SUM(qty_delta)` / `SUM(amount_delta)` over the lines for an
  account, computed on read. Every screen that shows a stock number or a balance
  reads the same SUM, so they cannot disagree.
* Money is stored as **integer piastres** and converted only at the display
  boundary, so no balance is ever a floating-point artefact.
* Cost is **weighted average (WAC)**, derived from what was actually paid on
  receipt: `SUM(amount_delta) / SUM(qty_delta)` over an item's stock lines. A
  sale snapshots that value as `unit_cost`, which is what makes COGS stable
  after the fact.
* RLS makes `ledger_events` and `ledger_lines` **immutable to clients**: UPDATE
  and DELETE policies are `false`. History can be corrected only by appending a
  reversing event.

Worked example, verified end to end on the QA tenant during the audit:

| Step | stock qty | stock value | COGS | revenue | wallet |
| --- | ---: | ---: | ---: | ---: | ---: |
| purchase 60 @ 100 | 60 | 6,000 | 0 | 0 | −1,000 |
| sale 2 @ 300 | 58 | 5,800 | 200 | 600 | −400 |
| return 1 @ 300 | 59 | 5,900 | 100 | 300 | −700 |

Products, Inventory and the dashboard all reported 5,900 / 59 / net 5,200
(= 5,900 stock − 700 wallet) from the same rows.

### Stock has exactly one source

`useStock()` aggregates the ledger and publishes the result through
`setStockSnapshot()`, which the synchronous `getActualStock()` helper reads. The
`products.quantity` column still exists as a mirror for sync, but it can never
override the ledger: a bundle's availability is derived from its components, and
a variant is clamped to its parent's ledger quantity.

## Licensing

Manual, described in full in [LICENSE_OPERATIONS.md](./LICENSE_OPERATIONS.md).
Four states — `ACTIVE`, `EXPIRED`, `SUSPENDED`, `UNLICENSED` — decided from
`store_licenses.status` first and `valid_until` second. `LicenseGate` fetches the
verdict from the server on every application load; a cached verdict is a
fallback for an outage only, and expires after three days.

No billing, no subscriptions, no plan-based feature gating.

**Since migration 024 the licence is an authorization boundary, not only a
route.** `store_licensed(store_id)` is true only for a row that is `active` and
not past `valid_until`, and `has_role()` — which every business write policy is
built on — ANDs it in. So UNLICENSED, SUSPENDED and EXPIRED refuse writes at the
database, not merely in the bundle. Before that, a store whose licence had been
removed could still create products and orders through PostgREST with its own
legitimate token; the lock was a routing decision inside code the customer
controls.

Reads stay ungated on purpose: `select_store_licenses` is keyed on membership,
and a shop that could not read its own licence row could not be told *why* it is
locked out. Measured before/after in [SECURITY.md](./SECURITY.md).

This is what makes public signup safe to leave open. A visitor gets a real
account and a real store that owns nothing it can use until the System Owner
activates it; `claim_store` is `SECURITY DEFINER` and bypasses these policies,
which is what lets that customer exist at all.

## PWA

`vite-plugin-pwa` (Workbox), `registerType: "autoUpdate"`.

* **The precache is the app shell and nothing else** — 21 entries: JS, CSS,
  `index.html`, icons, the manifest. Verified: the built `sw.js` contains no
  reference to `supabase` or `rest/v1`.
* **No `runtimeCaching`, deliberately.** Caching a Supabase response would serve
  a stale price or stock count, which is the class of bug this architecture
  exists to prevent.
* `navigateFallbackDenylist` excludes `/rest/`, `/auth/` and `/functions/`, so a
  navigation request can never be answered from the shell cache.
* `skipWaiting` + `clientsClaim` + `cleanupOutdatedCaches`, so a deployment
  cannot strand a user on an old bundle.
* A `vite:preloadError` handler recovers a stale code-split chunk with a
  one-shot reload guarded by a `sessionStorage` flag, so a failed chunk after a
  deployment reloads once instead of killing the route or looping.
* Icons: 192 and 512 `any`, plus separate 192 and 512 `maskable` files — a
  maskable icon needs its artwork inside the safe zone, so reusing the plain
  icon would crop the logo.

## Integrations

`/integrations` configures Paymob, shipping and online-order intake. Two things
to be clear about:

* **No integration is live.** Four integration edge functions exist in
  `supabase/functions/` (`handle-ecommerce-order`, `handle-paymob-webhook`,
  `handle-shipping-webhook`, `handle-subscription-webhook`) and **none of them is
  deployed**. The screen stores configuration; it does not currently exchange
  traffic with any provider. (`invite-staff`, described below, is deployed and is
  unrelated to integrations — it is the only deployed function.)
* **No integration secret is persisted.** The store strips secret fields before
  writing to `localStorage` and purges anything an older build left behind.
  Secrets live in memory for the session only.

## The one server-side function

`invite-staff` is the only deployed Edge Function, and it exists for one reason:
creating an auth account requires the service key, and a service key cannot be
in a Vite bundle. Everything else in this app is a browser talking to PostgREST
under RLS, and that is on purpose — a rule in TypeScript is a rule anyone can
edit, so authorization lives in Postgres.

The function keeps to that rule rather than becoming an exception to it. It
derives the store from `auth.uid()` via `staff_invite_context()`, uses the
service key for the single `inviteUserByEmail` call, and inserts the membership
back through the *caller's* client so RLS decides. Read it as plumbing around a
key, not as an application server. Full flow and the refusals it was tested
against: `SECURITY.md` → "Adding a member of staff".

## Document numbering

Invoice numbers come from `next_document_number(store, name, prefix)`, a
`SECURITY DEFINER` function that increments a counter row inside a single
`INSERT … ON CONFLICT DO UPDATE … RETURNING` statement. Two concurrent callers
are serialised by the row lock and get different numbers. `store_counters` has
RLS on and **no policy**, so the counter is reachable only through that function
and cannot be rewound. Unique indexes on `(store_id, "invoiceNumber")` for both
purchase and wholesale invoices are the last line of defence.

## Client-side persistence

`localStorage` holds: the Supabase session (managed by supabase-js), the app's
own auth flag, device id and machine fingerprint, UI preferences, feature
toggles, and the licence verdict cache. It does **not** hold products, orders,
customers, invoices or any ledger data — those are fetched from Supabase on
every boot.
