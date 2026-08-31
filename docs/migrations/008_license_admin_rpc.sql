-- ════════════════════════════════════════════════════════════════════════════
--  008 — System-owner RPCs for the in-app License Manager
-- ════════════════════════════════════════════════════════════════════════════
--
--  007 denied every client-side write to `store_licenses`, which is still the
--  right default: no shop may extend its own licence. These four functions are
--  the ONLY sanctioned way past that, and they open only for you.
--
--  Idempotent. Run after 000 and 007.
--
--  ── Why SECURITY DEFINER is dangerous, and what makes it safe here ─────────
--
--  A SECURITY DEFINER function runs as its owner (postgres), so it ignores RLS.
--  Get it wrong and you have handed every authenticated user superuser reach
--  into the licence table. Three things make it safe:
--
--    1. `SET search_path = public, pg_temp` on EVERY function. Without it, a
--       caller can create a table or function in their own schema that shadows
--       a name used inside the body, and the definer-rights function will
--       happily execute their code as postgres. This is THE classic
--       SECURITY DEFINER escalation, and the pin below closes it.
--    2. EXECUTE revoked from `public` and `anon`, granted only to
--       `authenticated`. An anonymous visitor cannot even call them.
--    3. Every function opens with the same owner check and raises otherwise.
--
--  ── Why the owner check is not just the JWT email ──────────────────────────
--
--  `auth.jwt()->>'email'` is the email on the token, and if your Supabase
--  project has email confirmation DISABLED, anyone may sign up claiming to be
--  '14ahmedashraf@gmail.com' and receive a token that says exactly that. The
--  check below reads `auth.users` for the current `auth.uid()` and additionally
--  requires `email_confirmed_at IS NOT NULL`, so an unconfirmed impostor gets
--  nothing even if confirmations are off.

BEGIN;

-- ── 1. Who is a system owner? ───────────────────────────────────────────────
--
-- Kept as a function rather than a table so the allowlist cannot be edited by
-- anything reaching the database as a normal user — changing it takes a
-- migration, which is exactly the friction an owner list should have.
CREATE OR REPLACE FUNCTION public.is_system_owner()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM   auth.users u
    WHERE  u.id = auth.uid()
      AND  u.email_confirmed_at IS NOT NULL
      AND  lower(u.email) IN ('14ahmedashraf@gmail.com', 'ahmedshelby142@gmail.com')
  );
$fn$;

-- ── 2. Every store, with its licence (the manager's table) ──────────────────
--
-- SECURITY DEFINER because `stores` is RLS'd to your own memberships, and the
-- whole point of this screen is to see shops you are NOT a member of.
CREATE OR REPLACE FUNCTION public.admin_list_stores()
RETURNS TABLE (
  store_id     UUID,
  store_name   TEXT,
  created_at   TIMESTAMPTZ,
  license_key  TEXT,
  plan_type    TEXT,
  valid_until  TIMESTAMPTZ,
  status       TEXT,
  member_count BIGINT
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
         l.license_key,
         l.plan_type,
         l.valid_until,
         l.status,
         (SELECT count(*) FROM public.store_members m WHERE m.store_id = s.id)
  FROM   public.stores s
  LEFT   JOIN public.store_licenses l ON l.store_id = s.id
  ORDER  BY s.created_at DESC;
END;
$fn$;

-- ── 3. Issue or renew ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_set_license(
  p_store_id    UUID,
  p_license_key TEXT,
  p_plan_type   TEXT,
  p_valid_until TIMESTAMPTZ,
  p_status      TEXT DEFAULT 'active'
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
  IF p_status NOT IN ('active', 'expired') THEN
    RAISE EXCEPTION 'status must be active or expired';
  END IF;
  IF p_valid_until IS NULL THEN
    RAISE EXCEPTION 'expiry date is required';
  END IF;

  INSERT INTO public.store_licenses AS sl
        (store_id,   license_key,          plan_type,   valid_until,   status)
  VALUES (p_store_id, btrim(p_license_key), p_plan_type, p_valid_until, p_status)
  ON CONFLICT (store_id) DO UPDATE
     SET license_key = EXCLUDED.license_key,
         plan_type   = EXCLUDED.plan_type,
         valid_until = EXCLUDED.valid_until,
         status      = EXCLUDED.status
  RETURNING sl.* INTO result;

  RETURN result;
END;
$fn$;

-- ── 4. Revoke, without destroying the record ────────────────────────────────
--
-- Flips `status` and leaves the key and dates intact, so what the shop had is
-- still readable and re-activating is one call rather than a re-issue.
CREATE OR REPLACE FUNCTION public.admin_revoke_license(p_store_id UUID)
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
     SET status = 'expired'
   WHERE store_id = p_store_id
  RETURNING * INTO result;

  IF result.store_id IS NULL THEN
    RAISE EXCEPTION 'this store has no license to revoke';
  END IF;

  RETURN result;
END;
$fn$;

-- ── 5. Lock the door ────────────────────────────────────────────────────────
--
-- Postgres grants EXECUTE to PUBLIC by default — without these REVOKEs an
-- anonymous caller could invoke a definer-rights function. The owner check
-- inside would still refuse them, but defence in depth costs four lines.
REVOKE ALL ON FUNCTION public.is_system_owner()   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_list_stores() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_license(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_revoke_license(UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.is_system_owner()   TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_stores() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_license(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revoke_license(UUID) TO authenticated;

COMMIT;


-- ── Verify ──────────────────────────────────────────────────────────────────

-- 1. Expect four rows, every one `security_definer = t` with a pinned
--    search_path in `settings`. A blank `settings` cell is the escalation hole.
SELECT p.proname,
       p.prosecdef                        AS security_definer,
       array_to_string(p.proconfig, ', ') AS settings
FROM   pg_proc p
JOIN   pg_namespace n ON n.oid = p.pronamespace
WHERE  n.nspname = 'public'
  AND  p.proname IN ('is_system_owner','admin_list_stores',
                     'admin_set_license','admin_revoke_license')
ORDER  BY p.proname;

-- 2. Expect `authenticated` = true and `anon` = false.
SELECT p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS can_execute
FROM   pg_proc p
JOIN   pg_namespace n ON n.oid = p.pronamespace
CROSS  JOIN (SELECT unnest(ARRAY['anon','authenticated']) AS rolname) r
WHERE  n.nspname = 'public'
  AND  p.proname IN ('admin_list_stores','admin_set_license','admin_revoke_license')
ORDER  BY p.proname, r.rolname;

-- 3. In the SQL editor this returns FALSE — the editor runs as postgres with no
--    `auth.uid()`. That is correct and expected; call it from the signed-in app
--    to see true. If it returns true HERE, something is wrong.
SELECT public.is_system_owner() AS am_i_owner;
