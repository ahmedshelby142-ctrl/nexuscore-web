-- ============================================================================
-- 020 — licence control: four states, four actions, and the history behind them
--
-- Safe to re-run: every statement is idempotent.
--
-- WHY THIS EXISTS
-- ---------------
-- The licence system could already say "this shop may trade" or "it may not".
-- What it could not say is WHY not, and the difference matters to the person
-- reading the lockout screen:
--
--   * a shop whose paid period ran out has EXPIRED;
--   * a shop the system owner switched off before that date is SUSPENDED;
--   * a shop that was never activated at all is UNLICENSED.
--
-- All three landed on `status = 'expired'` or an absent row, so the customer
-- was told "انتهت صلاحية الترخيص" in cases where nothing had expired. Telling a
-- brand-new signup their licence ran out, or telling a suspended shop the same
-- thing, sends them looking for a renewal button when what they need is a phone
-- call. `status` now carries 'suspended' as its own value.
--
-- WHAT THIS IS NOT
-- ----------------
-- Not billing. There is no subscription object, no renewal schedule, no
-- payment hook, and nothing here runs on a timer. A licence changes when the
-- system owner changes it, and expires because a date passed. That is the
-- entire model: the customer pays in the real world, and the owner turns the
-- key.
--
-- THE HISTORY COLUMNS
-- -------------------
-- Four columns on the existing row rather than an audit table. The questions
-- this has to answer are "when was it turned on", "when was it switched off",
-- "when did it come back", and "who did that" — each has exactly one current
-- answer per store, so a row of columns answers them without a join. A full
-- event log would be the right shape for "every change ever made", which is
-- not what was asked for and would be the more expensive thing to keep correct.
--
-- `updated_at` is already maintained by the `touch_store_license` trigger.
-- ============================================================================

-- ── 1. The fourth state ─────────────────────────────────────────────────────

ALTER TABLE public.store_licenses DROP CONSTRAINT IF EXISTS store_licenses_status_check;
ALTER TABLE public.store_licenses ADD CONSTRAINT store_licenses_status_check
  CHECK (status = ANY (ARRAY['active', 'expired', 'suspended']));

-- ── 2. History ──────────────────────────────────────────────────────────────

ALTER TABLE public.store_licenses ADD COLUMN IF NOT EXISTS activated_at   TIMESTAMPTZ;
ALTER TABLE public.store_licenses ADD COLUMN IF NOT EXISTS suspended_at   TIMESTAMPTZ;
ALTER TABLE public.store_licenses ADD COLUMN IF NOT EXISTS reactivated_at TIMESTAMPTZ;
ALTER TABLE public.store_licenses ADD COLUMN IF NOT EXISTS updated_by     UUID;

-- Rows that predate these columns were activated when they were created. Only
-- fills NULLs, so re-running never rewrites a real activation timestamp.
UPDATE public.store_licenses SET activated_at = created_at WHERE activated_at IS NULL;

-- Finding "everything expiring this month" scans the whole table without this.
CREATE INDEX IF NOT EXISTS store_licenses_valid_until_idx
  ON public.store_licenses (valid_until);

-- ── 3. ACTIVATE ─────────────────────────────────────────────────────────────
--
-- Issue a licence, or replace the one a store has. This is the only entry
-- point that mints a key, and the only one that can bring a SUSPENDED store
-- back by re-issuing rather than reactivating.

CREATE OR REPLACE FUNCTION public.admin_set_license(
  p_store_id    UUID,
  p_license_key TEXT,
  p_plan_type   TEXT,
  p_valid_until TIMESTAMPTZ,
  p_status      TEXT DEFAULT 'active',
  p_note        TEXT DEFAULT NULL
)
RETURNS public.store_licenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  result public.store_licenses;
BEGIN
  IF NOT public.is_system_owner() THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  -- Validated here as well as by the CHECK constraints, so the screen shows a
  -- readable message instead of a constraint name.
  IF p_store_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.stores WHERE id = p_store_id) THEN
    RAISE EXCEPTION 'unknown store';
  END IF;
  IF coalesce(btrim(p_license_key), '') = '' THEN
    RAISE EXCEPTION 'license key is required';
  END IF;
  IF p_plan_type NOT IN ('BASIC', 'PRO') THEN
    RAISE EXCEPTION 'plan must be BASIC or PRO';
  END IF;
  IF p_status NOT IN ('active', 'expired', 'suspended') THEN
    RAISE EXCEPTION 'status must be active, expired or suspended';
  END IF;
  IF p_valid_until IS NULL THEN
    RAISE EXCEPTION 'expiry date is required';
  END IF;

  INSERT INTO public.store_licenses AS sl
        (store_id,   license_key,          plan_type,   valid_until,   status,   notes,
         activated_at, updated_by)
  VALUES (p_store_id, btrim(p_license_key), p_plan_type, p_valid_until, p_status, p_note,
          CASE WHEN p_status = 'active' THEN now() END, auth.uid())
  ON CONFLICT (store_id) DO UPDATE
     SET license_key = EXCLUDED.license_key,
         plan_type   = EXCLUDED.plan_type,
         valid_until = EXCLUDED.valid_until,
         status      = EXCLUDED.status,
         notes       = COALESCE(EXCLUDED.notes, sl.notes),
         updated_by  = auth.uid(),
         -- Issuing an active licence IS an activation, and it clears any
         -- standing suspension: the row must never read "active" and carry a
         -- `suspended_at` that looks current.
         activated_at = CASE WHEN EXCLUDED.status = 'active' THEN now() ELSE sl.activated_at END,
         suspended_at = CASE WHEN EXCLUDED.status = 'suspended' THEN now() ELSE NULL END
  RETURNING sl.* INTO result;

  RETURN result;
END;
$fn$;

-- ── 4. EXTEND ───────────────────────────────────────────────────────────────
--
-- Push the expiry date out. Either a number of days or an explicit date; the
-- screen offers 30 / 90 / 180 / 365 and a picker, and both arrive here.
--
-- Days are added to GREATEST(now(), valid_until), never to `valid_until`
-- alone. Extending a licence that lapsed three months ago by 30 days must give
-- the shop thirty days from TODAY — adding to the old date would hand them a
-- licence that is still expired, and the owner would have to press the button
-- four times to notice.
--
-- A SUSPENDED licence is refused. Suspension is a deliberate switch-off, and
-- quietly turning a shop back on because someone reached for the wrong button
-- is the one mistake this screen must not make easy. Reactivate first.

CREATE OR REPLACE FUNCTION public.admin_extend_license(
  p_store_id UUID,
  p_days     INT         DEFAULT NULL,
  p_until    TIMESTAMPTZ DEFAULT NULL,
  p_note     TEXT        DEFAULT NULL
)
RETURNS public.store_licenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  current_row public.store_licenses;
  result      public.store_licenses;
  new_until   TIMESTAMPTZ;
BEGIN
  IF NOT public.is_system_owner() THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO current_row FROM public.store_licenses WHERE store_id = p_store_id;
  IF current_row.store_id IS NULL THEN
    RAISE EXCEPTION 'this store has no license to extend';
  END IF;
  IF current_row.status = 'suspended' THEN
    RAISE EXCEPTION 'this license is suspended — reactivate it first';
  END IF;

  IF p_until IS NOT NULL THEN
    new_until := p_until;
  ELSIF p_days IS NOT NULL THEN
    IF p_days <= 0 OR p_days > 3650 THEN
      RAISE EXCEPTION 'extension must be between 1 and 3650 days';
    END IF;
    new_until := GREATEST(now(), current_row.valid_until) + (p_days || ' days')::interval;
  ELSE
    RAISE EXCEPTION 'give either a number of days or an expiry date';
  END IF;

  IF new_until <= now() THEN
    RAISE EXCEPTION 'the new expiry date is already in the past';
  END IF;

  UPDATE public.store_licenses
     SET valid_until = new_until,
         -- An extension of an expired licence is a reactivation in every sense
         -- the customer cares about: the shop opens again.
         status       = 'active',
         activated_at = CASE WHEN status <> 'active' THEN now() ELSE activated_at END,
         suspended_at = NULL,
         notes        = COALESCE(p_note, notes),
         updated_by   = auth.uid()
   WHERE store_id = p_store_id
  RETURNING * INTO result;

  RETURN result;
END;
$fn$;

-- ── 5. SUSPEND ──────────────────────────────────────────────────────────────
--
-- Switch a shop off before its date. The row is kept, the dates are kept, and
-- not one business row is touched — suspension changes access and nothing else.

CREATE OR REPLACE FUNCTION public.admin_suspend_license(
  p_store_id UUID,
  p_note     TEXT DEFAULT NULL
)
RETURNS public.store_licenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  result public.store_licenses;
BEGIN
  IF NOT public.is_system_owner() THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  UPDATE public.store_licenses
     SET status       = 'suspended',
         suspended_at = now(),
         notes        = COALESCE(p_note, notes),
         updated_by   = auth.uid()
   WHERE store_id = p_store_id
  RETURNING * INTO result;

  IF result.store_id IS NULL THEN
    RAISE EXCEPTION 'this store has no license to suspend';
  END IF;

  RETURN result;
END;
$fn$;

-- ── 6. REACTIVATE ───────────────────────────────────────────────────────────
--
-- Undo a suspension, restoring the licence exactly as it was. Deliberately
-- refuses anything that is not suspended: "reactivate" on an expired licence
-- would silently do nothing useful (the date is still past), and the owner
-- would think the shop was open when it was not. That case is Extend.

CREATE OR REPLACE FUNCTION public.admin_reactivate_license(p_store_id UUID)
RETURNS public.store_licenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  current_row public.store_licenses;
  result      public.store_licenses;
BEGIN
  IF NOT public.is_system_owner() THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO current_row FROM public.store_licenses WHERE store_id = p_store_id;
  IF current_row.store_id IS NULL THEN
    RAISE EXCEPTION 'this store has no license to reactivate';
  END IF;
  IF current_row.status <> 'suspended' THEN
    RAISE EXCEPTION 'this license is not suspended';
  END IF;

  UPDATE public.store_licenses
     SET status         = 'active',
         suspended_at   = NULL,
         reactivated_at = now(),
         updated_by     = auth.uid()
   WHERE store_id = p_store_id
  RETURNING * INTO result;

  RETURN result;
END;
$fn$;

-- ── 7. The old name ─────────────────────────────────────────────────────────
--
-- `admin_revoke_license` was the suspend button before suspension had a state
-- of its own; it set `status = 'expired'`, which is what conflated the two.
-- Kept as a forwarding wrapper so a browser still running the previous bundle
-- does not get "function does not exist" — it now suspends, which is what the
-- button always meant.

CREATE OR REPLACE FUNCTION public.admin_revoke_license(p_store_id UUID)
RETURNS public.store_licenses
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT public.admin_suspend_license(p_store_id, NULL);
$fn$;

-- ── 8. The list ─────────────────────────────────────────────────────────────
--
-- One row per store with everything the manager screen shows, so opening it is
-- a single round trip. `owner_email` comes from `auth.users` — readable here
-- only because this function is SECURITY DEFINER and gated on
-- `is_system_owner()`; no client role can reach that table.

DROP FUNCTION IF EXISTS public.admin_list_stores();

CREATE OR REPLACE FUNCTION public.admin_list_stores()
RETURNS TABLE(
  store_id       UUID,
  store_name     TEXT,
  created_at     TIMESTAMPTZ,
  owner_email    TEXT,
  license_key    TEXT,
  plan_type      TEXT,
  valid_until    TIMESTAMPTZ,
  status         TEXT,
  notes          TEXT,
  activated_at   TIMESTAMPTZ,
  suspended_at   TIMESTAMPTZ,
  reactivated_at TIMESTAMPTZ,
  license_created_at TIMESTAMPTZ,
  license_updated_at TIMESTAMPTZ,
  member_count   BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NOT public.is_system_owner() THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT s.id,
         s.name,
         s.created_at,
         -- The shop's ADMIN, oldest membership first: the account that claimed
         -- the store at signup, which is who the owner needs to phone.
         (SELECT u.email::text
            FROM public.store_members m
            JOIN auth.users u ON u.id = m.user_id
           WHERE m.store_id = s.id
           ORDER BY (m.role <> 'ADMIN'), m.created_at
           LIMIT 1),
         l.license_key,
         l.plan_type,
         l.valid_until,
         l.status,
         l.notes,
         l.activated_at,
         l.suspended_at,
         l.reactivated_at,
         l.created_at,
         l.updated_at,
         (SELECT count(*) FROM public.store_members m2 WHERE m2.store_id = s.id)
  FROM   public.stores s
  LEFT   JOIN public.store_licenses l ON l.store_id = s.id
  ORDER  BY s.created_at DESC;
END;
$fn$;

-- ── 9. Grants ───────────────────────────────────────────────────────────────
--
-- `authenticated` only. Every function re-checks `is_system_owner()` in its
-- first statement, so the grant is a door, not the lock — a signed-in shop
-- admin who calls any of these gets 42501.
--
-- The table itself stays unwritable by every client role (migration 007:
-- INSERT/UPDATE/DELETE policies are `false`), so these SECURITY DEFINER
-- functions are the only path that can change a licence at all.

DO $g$
DECLARE fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'admin_set_license(uuid, text, text, timestamptz, text, text)',
    'admin_extend_license(uuid, integer, timestamptz, text)',
    'admin_suspend_license(uuid, text)',
    'admin_reactivate_license(uuid)',
    'admin_revoke_license(uuid)',
    'admin_list_stores()'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', fn);
  END LOOP;
END $g$;

-- The five-argument `admin_set_license` from migration 008 still exists as a
-- separate overload, and PostgREST would happily route to it. Drop it so there
-- is one activation path and it is the one that records history.
DROP FUNCTION IF EXISTS public.admin_set_license(uuid, text, text, timestamptz, text);
