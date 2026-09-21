# NEXUS CORE Mobile — Product Completion Audit

Audit date: **2026-09-21**
Baseline commit: **2ccbb66**
Live project audited: `oczgqpxeixlrufvevitz`, store `db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f`
(34 orders, 7 products, 8 customers, 489 ledger lines, 167 ledger events, active licence)

This is an **audit only**. No production data was modified, no migration was
created, and no business behaviour was changed.

---

## A. Product scope — ONLINE-ONLY

NEXUS CORE is an **online-only** product. Supabase/Postgres is the server
authority; Vercel hosts the web/PWA client.

**Offline-First is OUT OF SCOPE.** The old roadmap item "one offline sells +
one online sells" is intentionally excluded — not deferred work, and not a gap.
It must never appear in P0/P1.

What online-only requires instead, and what this audit checked:

| Requirement | Verdict |
|---|---|
| Cached/read-only UI where already supported | ✅ shell precache only |
| Backend-dependent mutations blocked or failing safely | ✅ safe — see §K |
| User told the connection is unavailable | 🟡 7 of 13 screens — see §L |
| Hydration/realtime resumes on reconnect | 🟡 licence re-checks; **no realtime on mobile** — see §I |

The build is already aligned with this decision and should stay that way:
`vite.mobile.config.ts` precaches **shell assets only** (`js/css/html/ico/png/
svg/woff2`), runtime-caches **no** Supabase REST/Auth/Realtime response, and
carries **no background-sync write queue**. `commitReceipt` — the single mobile
write — throws on failure with no local queue, so an offline attempt cannot
produce a fake success.

---

## B. Screen inventory

**17 routes** over **13 screen components** (plus 8 shared mobile components,
7 viewmodels, 6 data hooks/readers). Source: `src/mobile/router.tsx`, verified
against `src/mobile/navigation/mobileNavigation.ts` and the filesystem
(52 files under `src/mobile/`).

| # | Route | Screen | Capability gate | State |
|---|---|---|---|---|
| 1 | `/login` | `MobileLogin` | public | ✅ |
| 2 | `/set-password` | `MobileSetPassword` | public | ✅ |
| 3 | `/license-expired` | `MobileLicenseExpired` | session | ✅ |
| 4 | `/` | `MobileHomePlaceholder` | home | ✅ |
| 5 | `/orders` | `MobileOrdersScreen` | orders | ✅ read |
| 6 | `/orders/:orderId` | `MobileOrderDetails` | orders | ✅ read |
| 7 | `/inventory` | `MobileStockScreen` | stock | ✅ read |
| 8 | `/inventory/shortages` | `MobileShortagesScreen` | stock | ✅ read |
| 9 | `/inventory/:productId` | `MobileProductDetails` | stock | ✅ read |
| 10 | `/shipments` | `MobileShipmentsScreen` | shipments | ✅ read |
| 11 | `/customers` | `MobileCustomersScreen` | customers | ✅ read |
| 12 | `/customers/:customerId` | `MobileCustomerDetails` | customers | ✅ read |
| 13 | `/purchasing` | **`MobileDeferredScreen`** | purchasing | ❌ placeholder |
| 14 | `/restock` | `MobileQuickRestock` | purchasing | ✅ **the only write** |
| 15 | `/owner` | `MobileOwnerScreen` | owner | ✅ read |
| 16 | `/preferences` | **`MobileDeferredScreen`** | preferences | ❌ placeholder |
| 17 | `*` | redirect → `/` | — | ✅ |

**Modals / sheets / nested surfaces:** product-picker `Dialog` (QuickRestock),
`FilterSheet` (orders, shipments, stock, restock), `MobileMoreSheet`,
`MobileBottomNav`, order timeline (OrderDetails), customer order history
(CustomerDetails), product waiting-orders (ProductDetails).

**Deep links:** `/orders/:orderId`, `/inventory/:productId`,
`/customers/:customerId`, `/restock?products=a,b`. All four resolve via
`useParams`/`useSearchParams`.

### The single most important structural fact

`src/mobile/` contains **zero** direct table writes — no `.insert()`,
`.update()`, `.upsert()` or `.delete()` anywhere. It makes exactly **one**
RPC read (`mobile_shortages`) and has exactly **one** write path:
`/restock` → `executeQuickRestock` → `commitReceipt`.

Mobile is therefore a **read-only operations cockpit with one supply write**.
That matches `docs/MOBILE_PERSONA_ARCHITECTURE.md` §2 ("The Moderator mutates
nothing…") and §3 (Owner = business cockpit). Every "missing" mutation below is
classified against that stated intent, not against the desktop feature list.

---

## C. Capability matrix

Status: ✅ COMPLETE · 🟡 PARTIAL · ❌ MISSING · 🔴 BROKEN · ⚠️ BUSINESS DECISION

| # | Capability | Status | Evidence | Missing / broken | Priority |
|---|---|---|---|---|---|
| 1 | Authentication | ✅ | `MobileLogin`, `MobileSetPassword`, Supabase Auth. Runtime: session for `shahdshrife@gmail.com` resolved on boot | — | — |
| 2 | Session reconciliation | ✅ | `useSessionReconciliation`; `MobileSessionGate` fail-closed → `/login`. Runtime console: `[Auth] local session flag with no Supabase session — signing out` | — | — |
| 3 | Home / dashboard | ✅ | `MobileHomePlaceholder` + `mobileHomeReader`. Runtime: alerts, 3 metrics, 2 queues, real data | hardcoded status label | P2 |
| 4 | Orders list | ✅ | `MobileOrdersScreen` + `readMobileOrders`. Runtime: 3 pending, correct labels | refresh button dead | **P1** |
| 5 | Order details | ✅ | `MobileOrderDetails` + ledger timeline (`ref_type='ecommerce_order'`) | no offline state, no retry | P2 |
| 6 | Creating orders | ❌ | no create path in `src/mobile` | whole flow | ⚠️ |
| 7 | Editing orders | ❌ | `MobileOrderDetails` has navigation only, zero actions | whole flow | ⚠️ |
| 8 | Cancelling orders | ❌ | no `updateOrderStatus` import in mobile | whole flow | ⚠️ |
| 9 | Returns | ❌ | no return / confirm-return surface | whole flow | ⚠️ |
| 10 | Receiving (توريد) | ✅ | `/restock` → `executeQuickRestock` → `commitReceipt`; numbering via `next_document_number`, supplier create via `NEW_SUPPLIER`, wallet + paid/owed | not runtime-tested (would write to production) | — |
| 11 | Purchasing | ❌ | `/purchasing` → `MobileDeferredScreen`, `isImplemented: false`. **It is ACCOUNTANT's 3rd bottom-nav tab** | whole screen | **P1** |
| 12 | Stock | ✅ | `MobileStockScreen`, `MobileProductDetails`; on-hand = `SUM(ledger_lines.qty_delta)` where `account='stock'` | — | — |
| 13 | Shortages | ✅ | `mobile_shortages` RPC. Runtime: 0 rows, independently confirmed correct (stock 22 vs 1 required; 50 vs 3) | — | — |
| 14 | Shipments | ✅ | `MobileShipmentsScreen`. Runtime: "جاهز للشحن" lists all 3 pending orders — the e1025a3 fix verified live | refresh button dead | **P1** |
| 15 | Customers | ✅ | `MobileCustomersScreen`, `MobileCustomerDetails`, `customer_ltv` | refresh dead; dead import | P1/P2 |
| 16 | Couriers | 🟡 | `readMobileCouriers` registry wired into Shipments only | no courier screen; Owner shows raw ids | P1 (labels) |
| 17 | Payments | ❌ | only the restock paid/owed field; no payment capture | whole flow | ⚠️ |
| 18 | Ledger visibility | 🟡 | order timeline reads `ledger_events` | no ledger browser | ⚠️ |
| 19 | Owner financials | ✅ | `owner_financial_summary`. Runtime: 17 keys; ADMIN allowed, POS refused, foreign refused, anon refused | subject ids unresolved | **P1** |
| 20 | Reports | ❌ | nothing beyond the owner summary | — | ⚠️ |
| 21 | Search | ✅ | `MobileSearch` on orders, customers, stock, shipments, restock | — | — |
| 22 | Filters | ✅ | `FilterSheet` + segmented controls | — | — |
| 23 | Realtime updates | ❌ | **`MobileApp.tsx` never mounts `useRealtimeSync`**; no polling, no refetch-on-focus in `src/mobile/data/*` | entire capability | **P1** |
| 24 | Preferences / settings | ❌ | `/preferences` → `MobileDeferredScreen`; offered to **all five roles** | whole screen | **P1** |
| 25 | Licence handling | ✅ | `MobileSessionGate` + `LicenseExpired`; re-checks on `online` event | — | — |
| 26 | Role permissions | ✅ | `mobileCapabilities.ts` + DB. Runtime-verified — see §J | — | — |
| 27 | Notifications | ❌ | in-app `useAlertBadges` only; no Push API, no `showNotification` | push | ⚠️ |
| 28 | Error recovery | 🟡 | `ErrorState` on all 11 data screens | `onRetry` missing on 2 detail screens | P2 |
| 29 | Empty / loading states | ✅ | `SkeletonState` / `EmptyState` on all 11 data screens | — | — |
| 30 | Deep links / navigation | 🟡 | 4 deep links work in dev | SW fallback path wrong — see §L | **P0** |
| 31 | PWA behaviour | 🔴 | manifest + icons + SW correct **and correctly online-only** | `navigateFallback` target absent from build | **P0** |
| 32 | **Mobile production deployment** | 🔴 | `vercel.json`: `buildCommand: npm run build`, `outputDirectory: dist` | mobile is **never built or served** | **P0** |
| 33 | Tenant isolation | ✅ | runtime-verified both directions — see §J | — | — |
| 34 | Data authority | ✅ | mobile reads the server directly; no client mirror | legacy `syncQueue` vestige — see §K | — |

### Transparent completion calculation

Only capabilities that are **decided requirements** count. The 8 rows marked
⚠️ BUSINESS DECISION (6, 7, 8, 9, 17, 18, 20, 27) are excluded because the
requirement itself is not yet decided, and Offline-First is excluded as out of
scope. That leaves **26** scored capabilities, ✅ = 1, 🟡 = 0.5, ❌/🔴 = 0:

- ✅ × 20 = 20.0
- 🟡 × 3 (16 Couriers, 28 Error recovery, 30 Deep links) = 1.5
- ❌/🔴 × 5 (11 Purchasing, 23 Realtime, 24 Preferences, 31 PWA, 32 Deployment) = 0

20 + 1.5 = **21.5 / 26 = 82.7 %**

Read it as: *the mobile product is ~83 % of its decided scope, and the missing
17 % is concentrated in five items — two of which (deployment, PWA fallback)
mean it cannot currently ship at all.*

---

## D. P0 blockers

### P0-1 · The mobile PWA has no production deployment

`vercel.json` builds `npm run build` into `dist` — the **desktop** app — and
rewrites every route to the desktop `/index.html`. `npm run build:mobile`
(output `dist-mobile`) is never invoked by the deploy, and `docs/DEPLOYMENT.md`
documents only "Build command `vite build`, output `dist`". The desktop entry
contains no mobile branch. `dist-mobile/` is built locally and committed, but
nothing serves it.

**Effect:** there is no URL at which a user's phone can install or open the
mobile app. Every other finding is downstream of this one.
**Decision needed:** separate Vercel project vs. a path prefix on the existing
one (BD-8). This is a deployment-architecture choice and should be confirmed
before implementation.

### P0-2 · Service-worker navigation fallback points at a file the build does not produce

`vite.mobile.config.ts` sets `navigateFallback: "/index.html"`, but the mobile
build's only HTML output is `dist-mobile/mobile/index.html` — verified:
`find dist-mobile -name "*.html"` returns that one path, and the generated
`dist-mobile/sw.js` contains `createHandlerBoundToURL("/index.html")`.

**Effect:** once installed, a hard refresh or a deep link on any route other
than the entry point has no precached document to fall back to. This is exactly
the standalone-mode refresh and deep-link behaviour Phase 9 asks about.
**Note:** the denylist (`/rest/`, `/auth/`, `/functions/`) is correct and must be
preserved by any fix.

---

## E. P1 — required for mobile product completion

### P1-1 · No realtime on mobile

`MobileApp.tsx` calls `useSessionReconciliation()` and nothing else.
`useRealtimeSync` — which owns the five `postgres_changes` subscriptions and is
what migration 036 fixed the publication for — is **desktop-only**. Mobile has
no subscription, no polling and no refetch-on-focus (a grep over
`src/mobile/data/` for `setInterval|subscribe|channel|visibilitychange|focus`
returns nothing).

**Effect:** a Moderator watching the orders queue never sees a new order until
they navigate away and back. "Realtime / multi-device: certified" was certified
for desktop; mobile was never in that scope.

### P1-2 · Three dead refresh buttons

`MobileOrdersScreen:25`, `MobileCustomersScreen:19` and
`MobileShipmentsScreen:45` each render `<button aria-label="تحديث">` with **no
`onClick`**. Verified by parsing the button elements — a naive line grep is
fooled, because the back button on the same minified JSX line does have
`onClick`.

Wired, for comparison: Home, Shortages, Stock, Owner.

**Effect:** compounds P1-1. On an app with no realtime, the refresh control is
the only way to see new data, and on three of the main list screens it silently
does nothing — which reads to the user as "the data is already current".

### P1-3 · Owner cockpit shows raw ids instead of names

`MobileOwnerScreen` renders `supplierPayable`, `courierReceivable` and
`courierPayable` through `SubjectList`, which **accepts a `labelOf` prop** — and
all three call sites (lines 247, 253, 255) omit it.

Runtime evidence: the screen displays `26dfe561-69ac-4d82-9d0b-25fe3053d89b`
(٢٬٣٣٠٫٠٠ ج.م.) and couriers `default` / `cert-courier`. That UUID resolves in
the database to supplier **"محمود"**.

**Effect:** this screen's stated goal in the persona doc is "عليك ١٢٬٤٠٠ ج.م
للموردين" — a fact the Owner can act on. A UUID is not actionable. The reader
needed for couriers (`readMobileCouriers`) already exists and is already used by
Shipments, so this is wiring, not new capability.

### P1-4 · `/purchasing` is a placeholder — and it is ACCOUNTANT's primary tab

`getBottomNavForRole("ACCOUNTANT")` returns `[home, stock, purchasing, more]`,
and `purchasing` has `isImplemented: false` → `MobileDeferredScreen` ("قريباً").
The ACCOUNTANT persona's third bottom-nav destination is a coming-soon card.
The persona document's Owner table also lists Purchases as "➖ written ✅, not
read": the write exists (`/restock`), the read does not.

### P1-5 · `/preferences` is a placeholder offered to every role

`preferences` is in all five roles' capability sets and is the one capability
`MODERATOR` shares with everyone, yet it routes to `MobileDeferredScreen`.
Minimum viable content needs deciding (BD-7) — **sign-out currently has no home
anywhere in the mobile app**.

---

## F. P2 — polish / quality

| # | Finding | Evidence |
|---|---|---|
| P2-1 | Home queue invents a status label — hardcodes `"قيد الإجراء"` while the taxonomy and the Orders screen say `"قيد الانتظار"` for the same order. Directly violates `statusTaxonomies.ts`' own rule ("Screens MUST NOT invent their own labels") | `mobileHomeReader.ts:89`; runtime: both labels seen on the same order |
| P2-2 | 4 screens have no offline state: `MobileOwnerScreen`, `MobileOrderDetails`, `MobileProductDetails`, `MobileCustomerDetails`. Runtime-confirmed: forcing `navigator.onLine = false` on `/owner` changed nothing on screen | 7 of 13 screens are offline-aware |
| P2-3 | `onRetry` missing on `MobileOrderDetails` and `MobileProductDetails` | both render `ErrorState` without it |
| P2-4 | Quick restock's توريد button is not disabled offline — `canSave` (line 159) has no connectivity term; `OfflineState` appears only inside the product-picker dialog. It **fails safely** (throws, nothing committed) but shows a raw error instead of preventing the tap | `MobileQuickRestock.tsx:159,469,495` |
| P2-5 | Dead imports: `useCustomerStore` in `MobileCustomersScreen`, `useBusinessStore` in `MobileQuickRestock` — imported, never called. Harmless, but exactly the stale-mirror pattern the surrounding comments warn about | — |
| P2-6 | `MobileHomePlaceholder` is a fully implemented home screen carrying a placeholder name | — |
| P2-7 | `MOBILE_PERSONA_ARCHITECTURE.md` §2 still describes the home queue as "pending/processing count" — stale since e1025a3 removed `processing` | — |

---

## G. Business decisions required

These cannot be inferred from existing product behaviour. Each is a real
capability gap **only if** the answer is yes.

| # | Question | Current state | Why it is not simply "missing" |
|---|---|---|---|
| BD-1 | Should mobile perform **order mutations** (create / edit / cancel / ship / deliver / settle / return / pay)? | none exist | The persona doc says the Moderator "mutates nothing until a specific operational mutation is proposed and approved on its own merits". The lifecycle and its guards already exist in `orderLifecycle.ts`, and the DB already permits the four writing roles. A product choice, not a technical gap. **"جاهز للشحن" → "مع المندوب" is the single highest-value candidate.** |
| BD-2 | Should mobile capture **payments / COD settlement**? | no | `courier_settlement` is already writable by the selling roles at the DB |
| BD-3 | Should mobile have **reports** beyond the owner summary? | no | The Owner cockpit may be sufficient for a phone |
| BD-4 | Should mobile have **push notifications**? | in-app badges only | Would partly substitute for P1-1; needs VAPID plus a server sender |
| BD-5 | Should mobile show a **courier screen** (activity, settlement)? | registry read only | Persona doc lists courier activity as "➖" |
| BD-6 | Should mobile browse the **ledger**? | order timeline only | Persona doc lists it for Owner only |
| BD-7 | What belongs in **`/preferences`**? | placeholder | Blocks P1-5; sign-out has no home |
| BD-8 | Where does the **mobile PWA deploy**? | nowhere | Blocks P0-1 |

---

## H. Desktop / Web parity gaps

Business capability, not visual parity.

**After a mobile operation, does Desktop see it?** Mobile has exactly one write
(`/restock` → `commitReceipt`), and it is the **same** command the desktop
purchasing screen calls — same document numbering (`next_document_number`), same
ledger append, same tables. There is no second write path, so no divergence is
possible. ✅

**Present on Desktop, absent from Mobile:**

| Desktop capability | Mobile | Classification |
|---|---|---|
| Order lifecycle actions (ship / deliver / settle / return / cancel / edit / pay) | ❌ | BD-1 |
| POS / selling | ❌ | out of persona scope |
| Purchasing screen (invoice list, supplier ledger) | ❌ | P1-4 |
| Returns hub / confirm-return | ❌ | BD-1 |
| Courier ledger and settlement | ❌ | BD-5 |
| Wholesale | ❌ | out of persona scope |
| Discounts | ❌ | persona doc "➖" |
| Expenses / payroll / owner draw | ❌ | out of persona scope |
| Settings, users, branches | ❌ | deliberately ADMIN-desktop only |
| Financial reports | 🟡 owner summary only | BD-3 |

**Present on Mobile, absent from Desktop:** none — `/restock` is a faster path
into the same desktop receiving command.

---

## I. Realtime gaps

| Entity | Published | Desktop subscribes | Mobile subscribes |
|---|---|---|---|
| `orders` | ✅ (036) | ✅ | ❌ |
| `products` | ✅ | ✅ | ❌ |
| `transactions` | ✅ (036) | ✅ | ❌ |
| `expenses` | ✅ (036) | ✅ | ❌ |
| `ledger_events` | ✅ | ✅ | ❌ |

**Mobile subscribes to nothing.** The publication work in migration 036 is
correct and is a prerequisite that is already satisfied — the gap is purely
client-side (P1-1). Tenant isolation for any future mobile subscription is
already guaranteed: Supabase Realtime applies RLS, and §J confirms RLS scopes
these tables correctly.

Duplicate-financial-event protection is unaffected by mobile: the in-flight
claim in `orderLifecycle.ts` and the atomic `insert_ledger_lines` (migration
032) both sit below any client, and mobile appends no financial event except
through `commitReceipt`, which carries an `idempotencyKey`.

---

## J. Security findings — no gaps found

All verified at **runtime** against the live database by simulating real
sessions (`request.jwt.claims` + `SET ROLE authenticated`), not by reading
source.

| Check | Method | Result |
|---|---|---|
| Tenant isolation (foreign member) | ADMIN of `c58d76ab…` reading store `db31bbd8…` | **0 rows** across orders, products, customers, ledger_lines, ledger_events, couriers |
| Tenant isolation (own member) | ADMIN of `db31bbd8…` | 34 / 7 / 8 / 489 / 167 / 1 — and `SELECT count(*) FROM orders` returns **34, not 36**: the 2 orders in an unrelated store stay invisible |
| Anonymous fail-closed | `SET ROLE anon` | **0 rows** in orders, products, customers, ledger_lines, ledger_events, store_members |
| Owner financial authorization | `owner_financial_summary` as 4 principals | ADMIN → allowed (17 keys); POS_ECOMMERCE → `42501 owner financial reporting is ADMIN only`; foreign ADMIN → `42501 not a member of this store`; anon → `42501 not authenticated` |
| Shortages RPC role gate | `mobile_shortages` as 4 principals | correct `member_role` per principal; `NULL` for foreign and anon |
| Moderator read-only | all 27 write policies inspected | `MODERATOR` appears in **zero** of them |
| No membership-only write gates | policy gate classification | **every** write policy is `has_role`-gated; none is `is_store_member`-only, so the gap 033 closed has not regressed |
| Ledger append-only | policy inspection | `no_update_*` / `no_delete_*` on `ledger_events` and `ledger_lines` |
| Licence enforcement | `has_role` → `store_licensed` | the licence check is inside the role check itself, so an unlicensed store cannot write |
| System Owner separation | `is_system_owner()` | email allowlist, holds no store membership; `owner_financial_summary` refuses it like any non-member |
| Client-only authorization on mobile | `mobileCapabilities.ts` | documented as presentation-only; the DB is the boundary, and the matrix above proves it independently |
| localStorage privilege escalation | `MobileSessionGate` | a local auth flag without a Supabase session signs out — observed live in the console |

**No client-only authorization was found doing security work on mobile.**

---

## K. Data-authority findings

| Value | Source of truth | Classification |
|---|---|---|
| Stock on hand | `SUM(ledger_lines.qty_delta)` where `account='stock'` | authoritative server |
| Order totals / status | `orders` table | authoritative server |
| Sales, COGS, expenses, profit | ledger accounts via `owner_financial_summary` | derived server |
| Wallets, supplier payable, courier receivable/payable, receivable_client, stock value | same RPC | derived server |
| Customer LTV | `customer_ltv` | derived server |
| Shortages | `mobile_shortages` RPC | derived server |
| Order timeline | `ledger_events` | authoritative server |
| Couriers | `couriers` registry (an order's `courierName` is a frozen label) | authoritative server + UI label |
| Mobile screen data | per-screen PostgREST read on mount | **no client cache at all** |

**Mobile holds no mirror.** It never calls `hydrateAll`, so the Zustand
collections (`useBusinessStore.suppliers`, `useCustomerStore`, …) are
permanently empty there — which is why suppliers are read from the server in
`MobileQuickRestock`. The two dead imports (P2-5) are the only residue.

**Legacy `syncQueue` — do not delete.** Present in `useBusinessStore`,
`useFinancialStore` and `useOrderStore`. Status: **neutralised, not dangerous.**
`partialize` no longer persists it, and `cloudHydrate.drainLegacyQueue()` flushes
any pre-existing entries on **desktop** boot before hydration. Mobile never
mounts that path and never enqueues. Classification: **stale but harmless
vestige with an active drain** — removing it is a separate cleanup that must not
happen before the drain has demonstrably run for existing installs.

**Production data hygiene** (observed, not modified):

- `M21-ATOMICITY-PROBE-WALLET` holds **−٥٥٠٫٠٠ ج.م.** and renders in the live
  Owner wallet list — a QA probe visible in the owner's financial cockpit.
- `payable_supplier` subject `qa-supplier` (٢٬٠٠٠٫٠٠ ج.م.) has **no row in
  `suppliers`** — an unresolvable balance.
- Product `QA-UAT-WIDGET` sits in live inventory.
- Store `c1c919f9-1d0e-469e-a33e-6a1acb3196e2` holds **2 orders but has no
  members and no licence** — unreachable by every principal (RLS-confirmed), so
  not a leak, but orphaned.
- `خزينة المحل` is **−١٬٧٤٠٫٠٠ ج.م.** and `receivable_client` is
  **−٣٠٠٫٠٠ ج.م.** Negative balances on those accounts deserve an accounting
  review; they may be legitimate consequences of QA sequences.

These are observations. **Nothing was changed** — cleaning them is a separate,
explicitly-approved task.

---

## L. UX and PWA findings

**Strong across the board:** all 11 data screens have loading, empty and error
states; RTL and Arabic labels are consistent; `FilterSheet` and the segmented
controls are uniform; `MobileAppBoundary` catches render failures with a reload
affordance; `installStaleChunkRecovery()` handles post-deploy stale chunks;
`useSubmitGate` prevents double submission on the one write.

**Gaps** (detail in §D–§F): dead refresh buttons (P1-2), 4 screens with no
offline state (P2-2), 2 missing retries (P2-3), restock not disabled offline
(P2-4), home label divergence (P2-1).

**PWA:**

| Item | Verdict |
|---|---|
| Manifest | ✅ name, short_name, `lang: ar`, `dir: rtl`, standalone, portrait, theme colours |
| Icons | ✅ all 6 present in `public/` (192/512 any + maskable, favicon, apple-touch) |
| Service worker | ✅ generated; `autoUpdate`, `cleanupOutdatedCaches`, `clientsClaim`, `skipWaiting` |
| Cache strategy | ✅ **correctly online-only** — shell assets only; no Supabase REST/Auth/Realtime runtime caching; no background-sync write queue |
| API denylist | ✅ `/rest/`, `/auth/`, `/functions/` excluded from navigation fallback |
| Navigation fallback | 🔴 **P0-2** — points at `/index.html`; the build emits `mobile/index.html` |
| Installability / standalone / deep links in production | 🔴 **P0-1** — nothing is deployed |

The caching posture is explicitly *not* a licence to write offline, and the code
already respects that: the only write throws rather than queueing.

---

## M. Offline

**OUT OF SCOPE — ONLINE-ONLY PRODUCT.**

Not a P0, not a P1, not a backlog item. The former roadmap entry
"one offline sells + one online sells" is **intentionally excluded**.

What the product does require instead is graceful online-only degradation,
tracked as P2-2 and P2-4 above — telling the user the connection is gone, and
disabling the one backend-dependent mutation rather than letting it fail with a
raw error. Neither item involves queuing, local ledger writes, local document
numbering or conflict resolution, and no implementation of them may introduce
those.

The safety property that matters is already true and was verified:
**an offline write cannot fake success.** `commitReceipt` throws, holds no
queue, and rolls back its own document if the ledger refuses.

---

## N. Recommended execution order

Ordered so that each step makes the next one verifiable.

1. **BD-8 → P0-1 — decide and implement mobile deployment.** Nothing can be
   validated in production until the app is reachable on a phone. Blocks
   everything.
2. **P0-2 — fix `navigateFallback`** so refresh and deep links survive in
   standalone. Do it with P0-1 and verify installed, not just in dev. Preserve
   the `/rest/`, `/auth/`, `/functions/` denylist.
3. **P1-2 — wire the three refresh buttons.** Smallest diff in the backlog, and
   it removes the worst failure mode (silently stale data) before the larger
   realtime work.
4. **P1-1 — realtime on mobile.** With refresh honest, add subscriptions for
   `orders` and `products`. The publication is already correct (036) and RLS
   already scopes it (§J).
5. **P1-3 — pass `labelOf` to the three `SubjectList` call sites.** The prop and
   the courier reader already exist; this makes the Owner cockpit actionable.
6. **P1-5 / BD-7 — `/preferences`**, at minimum sign-out, theme and app version.
7. **P1-4 — `/purchasing`**, so ACCOUNTANT's primary tab is not a placeholder —
   the read side of a write that already works.
8. **P2 batch** — offline states on the 4 detail screens, the 2 retries, restock
   offline disabling, the home label, dead imports, the stale persona-doc line.
9. **BD-1 and the remaining business decisions.** Deliberately last: they are the
   only items that would add a *second* write path to mobile, and they should
   land on a product that is deployed, honest about freshness, and already
   proven against the real database.

Data hygiene (§K) sits outside this order and needs its own approval.

---

## O. Files changed

Documentation only:

- `docs/MOBILE_PRODUCT_AUDIT.md` (this file, new)
- `docs/NEXUSCORE_CHANGELOG.md` (one entry recording the audit)

No source file, migration, schema object or production row was modified.
