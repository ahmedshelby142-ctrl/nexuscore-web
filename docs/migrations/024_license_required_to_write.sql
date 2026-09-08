-- ============================================================================
-- 024 — a licence is required to WRITE, not merely to see the screens
--
-- Safe to re-run.
--
-- WHY THIS EXISTS
-- ---------------
-- Public signup is open: anyone can create an account, and `claim_store` gives
-- them a store with themselves as ADMIN. `TRIAL_DAYS = 0`, so no licence row is
-- written — the store is UNLICENSED, `evaluateLicense(null)` returns
-- `unlicensed`, and `LicenseGate` redirects every business route to the lockout
-- screen. That part worked.
--
-- What did not: **the database never consulted the licence at all.** Measured
-- 8 September 2026, as the ADMIN of a store whose licence row had been removed:
--
--     create product   ALLOWED
--     create order     ALLOWED
--     read products    5 rows
--
-- The lock was a routing decision in a bundle the customer controls. Anyone
-- willing to send their own PostgREST requests — with their own legitimate
-- token, no forgery needed — had a working ERP without ever being approved.
-- For a product sold by manual activation that is the whole control, missing.
--
-- WHERE THE CHECK GOES, AND WHY NOT ANYWHERE ELSE
-- -----------------------------------------------
-- Every business write policy funnels through `has_role(store_id, …)`, so
-- teaching that one function about licences reaches all of them at once. Three
-- write policies keyed on `is_store_member` instead are amended directly below.
--
-- READS ARE DELIBERATELY LEFT ALONE. `select_store_licenses` is
-- `USING (is_store_member(store_id))` — if membership required a licence, a
-- shop whose licence expired could no longer read the row that says so, and the
-- lockout screen would tell them "not activated yet" instead of "expired". This
-- codebase went to some trouble to stop those four states collapsing into one
-- another (see `lib/license/evaluate.ts`); gating reads would undo it, and buy
-- nothing — a brand-new store has nothing in it to read, and a suspended one is
-- reading only its own data.
--
-- The consequence to be explicit about: an UNLICENSED store cannot WRITE
-- anything through the API, and cannot open any screen in the app. It can still
-- SELECT its own (empty) tables with a hand-made request. That is the stated
-- boundary, not an oversight.

-- ── 1. The predicate ────────────────────────────────────────────────────────
--
-- SECURITY DEFINER so it reads `store_licenses` regardless of the caller's own
-- RLS, and so it cannot be defeated by the policies it is used inside.
--
-- Status AND date, in that order, matching `licenseState()` on the client:
-- a suspension bites while the paid period still runs, and a date that has
-- passed expires a row whose status still says 'active' — nothing writes that
-- status when a calendar day rolls by, and nothing should.

CREATE OR REPLACE FUNCTION public.store_licensed(p_store_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.store_licenses l
    WHERE l.store_id = p_store_id
      AND l.status = 'active'
      AND l.valid_until > now()
  );
$fn$;

REVOKE ALL ON FUNCTION public.store_licensed(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.store_licensed(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.store_licensed(uuid) TO authenticated;

-- ── 2. One function, every business write ───────────────────────────────────
--
-- `has_role` was `member_role(store) = ANY(roles)`. Every write policy in the
-- schema is built on it — products, orders, customers, expenses, suppliers,
-- branches, wholesale, purchase invoices, returns, shipping rates,
-- transactions, discount codes, ledger events, store_members and stores — so
-- adding the licence here reaches all of them in one place rather than in
-- twenty policies that could drift apart.
--
-- It also makes the licence states real at the database: SUSPENDED and EXPIRED
-- stop writes exactly as UNLICENSED does, which is what the manual licence
-- model always claimed and only the client actually did.

CREATE OR REPLACE FUNCTION public.has_role(p_store_id uuid, VARIADIC p_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT public.member_role(p_store_id) = ANY(p_roles)
     AND public.store_licensed(p_store_id);
$fn$;

-- ── 3. The two writes that do not go through has_role ───────────────────────
--
-- `update_products` is the stock mirror, deliberately writable by every role so
-- that dispatching an order can move quantity (see migration 022). `is_store_member`
-- is the right role test for it and stays; it just needs the licence too.
--
-- `insert_ledger_lines` is keyed on membership because the ROLE decision is
-- made on the parent event, which `insert_ledger_events` already gates through
-- `has_role`. A line cannot exist without its event, so this is belt-and-braces
-- rather than a second hole — but an unlicensed store should not be able to
-- write a row into a financial table under any reading.

DROP POLICY IF EXISTS update_products ON public.products;
CREATE POLICY update_products ON public.products
  FOR UPDATE
  USING (public.is_store_member(store_id) AND public.store_licensed(store_id));

DROP POLICY IF EXISTS insert_ledger_lines ON public.ledger_lines;
CREATE POLICY insert_ledger_lines ON public.ledger_lines
  FOR INSERT
  WITH CHECK (public.is_store_member(store_id) AND public.store_licensed(store_id));

-- ── What is deliberately NOT changed ────────────────────────────────────────
--
-- * `is_store_member` keeps its original meaning. Reads stay open so a
--   suspended or expired shop can still read the licence row that explains why
--   it is locked out.
-- * `claim_store` still creates a store and an ADMIN membership at signup. It
--   is SECURITY DEFINER and does not pass through these policies, which is what
--   lets a brand-new customer exist at all while owning nothing they can use.
-- * The six `admin_*` licence RPCs are unaffected: they gate on
--   `is_system_owner()` and write `store_licenses` as definer, so the System
--   Owner can always activate a store that cannot write a single row.
-- * `TRIAL_DAYS` stays 0. No automatic licence is issued anywhere.
