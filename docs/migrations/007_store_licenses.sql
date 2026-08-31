-- ════════════════════════════════════════════════════════════════════════════
--  store_licenses — SaaS protection for the handed-over desktop build
-- ════════════════════════════════════════════════════════════════════════════
--
--  Idempotent, like the master script. Safe to run more than once.
--
--  ── The rule this enforces, and the rule it must NOT ──────────────────────
--
--  An expired licence locks the UI. It does NOT stop the device syncing.
--
--  That distinction is the whole design. A shop whose licence lapses on a
--  Friday may already hold a day of offline sales in its local ledger. Blocking
--  sync would strand that money on one machine — the owner loses real takings
--  because of a billing lapse. So the policies below deliberately keep every
--  existing ledger and reference-table permission untouched: only the client
--  refuses to render the business screens.
--
--  ── Who may write a licence ───────────────────────────────────────────────
--
--  Nobody, through the app. There is no "super admin" role in `store_members`
--  — the four roles are ADMIN / POS_ECOMMERCE / ECOMMERCE_ONLY / ACCOUNTANT,
--  and ADMIN is the SHOP OWNER, who must never be able to extend their own
--  licence. Writes are therefore restricted to the `service_role` key, which
--  lives only on your side and never ships inside the .exe.
--
--  HOW TO RUN
--    Supabase dashboard → SQL Editor → paste → Run. Run 000_master_schema first.

BEGIN;

CREATE TABLE IF NOT EXISTS public.store_licenses (
  store_id     UUID PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  license_key  TEXT NOT NULL UNIQUE,
  plan_type    TEXT NOT NULL DEFAULT 'BASIC',
  valid_until  TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes        TEXT
);

-- Columns added explicitly as well as declared, because `CREATE TABLE IF NOT
-- EXISTS` does nothing to a table that already exists — the trap that made an
-- earlier migration die on a column it had "created". Anything referenced
-- below is guaranteed present by these lines, not by the block above.
ALTER TABLE public.store_licenses ADD COLUMN IF NOT EXISTS license_key TEXT;
ALTER TABLE public.store_licenses ADD COLUMN IF NOT EXISTS plan_type   TEXT;
ALTER TABLE public.store_licenses ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ;
ALTER TABLE public.store_licenses ADD COLUMN IF NOT EXISTS status      TEXT;
ALTER TABLE public.store_licenses ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ DEFAULT now();
ALTER TABLE public.store_licenses ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ DEFAULT now();
ALTER TABLE public.store_licenses ADD COLUMN IF NOT EXISTS notes       TEXT;

-- Constrained so a typo cannot silently become an unrecognised plan that the
-- client then fails open on.
ALTER TABLE public.store_licenses DROP CONSTRAINT IF EXISTS store_licenses_plan_check;
ALTER TABLE public.store_licenses ADD CONSTRAINT store_licenses_plan_check
  CHECK (plan_type IN ('BASIC', 'PRO'));

ALTER TABLE public.store_licenses DROP CONSTRAINT IF EXISTS store_licenses_status_check;
ALTER TABLE public.store_licenses ADD CONSTRAINT store_licenses_status_check
  CHECK (status IN ('active', 'expired'));

CREATE INDEX IF NOT EXISTS idx_store_licenses_valid_until
  ON public.store_licenses (valid_until);

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.store_licenses ENABLE ROW LEVEL SECURITY;

-- Read: any member of the store, so the client can check its own licence on
-- login. Every role needs this, not just ADMIN — a cashier opening the till
-- must be told the shop is locked rather than seeing an empty screen.
DROP POLICY IF EXISTS select_store_licenses ON public.store_licenses;
CREATE POLICY select_store_licenses ON public.store_licenses
  FOR SELECT USING (is_store_member(store_id));

-- Write: nobody. No INSERT, UPDATE or DELETE policy exists, so all three are
-- denied to every authenticated user INCLUDING the shop's own ADMIN. Issuing
-- and renewing licences happens with the `service_role` key, which bypasses
-- RLS and stays on your side — it is never shipped in the desktop build.
--
-- Stated explicitly so the omission reads as a decision, not an oversight.
DROP POLICY IF EXISTS no_insert_store_licenses ON public.store_licenses;
CREATE POLICY no_insert_store_licenses ON public.store_licenses
  FOR INSERT WITH CHECK (FALSE);
DROP POLICY IF EXISTS no_update_store_licenses ON public.store_licenses;
CREATE POLICY no_update_store_licenses ON public.store_licenses
  FOR UPDATE USING (FALSE);
DROP POLICY IF EXISTS no_delete_store_licenses ON public.store_licenses;
CREATE POLICY no_delete_store_licenses ON public.store_licenses
  FOR DELETE USING (FALSE);

-- Keep `updated_at` honest without trusting the caller to set it.
CREATE OR REPLACE FUNCTION public.touch_store_license() RETURNS TRIGGER AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_store_license ON public.store_licenses;
CREATE TRIGGER trg_touch_store_license
  BEFORE UPDATE ON public.store_licenses
  FOR EACH ROW EXECUTE FUNCTION public.touch_store_license();

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
--  ISSUING A LICENCE  (run with the service_role key, never from the app)
-- ════════════════════════════════════════════════════════════════════════════
--
-- INSERT INTO public.store_licenses (store_id, license_key, plan_type, valid_until, status)
-- VALUES (
--   '<the store uuid>',
--   'NX-PRO-2026-XXXX-XXXX',
--   'PRO',
--   now() + interval '1 year',
--   'active'
-- )
-- ON CONFLICT (store_id) DO UPDATE
--   SET license_key = EXCLUDED.license_key,
--       plan_type   = EXCLUDED.plan_type,
--       valid_until = EXCLUDED.valid_until,
--       status      = EXCLUDED.status;
--
-- RENEWING:
-- UPDATE public.store_licenses
--    SET valid_until = now() + interval '1 year', status = 'active'
--  WHERE store_id = '<the store uuid>';
--
-- REVOKING immediately:
-- UPDATE public.store_licenses SET status = 'expired' WHERE store_id = '<uuid>';


-- ── Verify ──────────────────────────────────────────────────────────────────

-- 1. Expect one row: store_licenses.
SELECT table_name FROM information_schema.tables
WHERE  table_schema = 'public' AND table_name = 'store_licenses';

-- 2. Expect SELECT allowed, and INSERT/UPDATE/DELETE present-and-false.
SELECT policyname, cmd FROM pg_policies
WHERE  schemaname = 'public' AND tablename = 'store_licenses'
ORDER  BY cmd, policyname;

-- 3. Expect `t` — RLS on.
SELECT relname, relrowsecurity FROM pg_class
WHERE  relnamespace = 'public'::regnamespace AND relname = 'store_licenses';

-- 4. Every store and whether it is currently licensed.
SELECT s.id, s.name, l.plan_type, l.valid_until, l.status,
       (l.store_id IS NOT NULL AND l.status = 'active' AND l.valid_until > now()) AS usable
FROM   public.stores s
LEFT   JOIN public.store_licenses l ON l.store_id = s.id
ORDER  BY s.name;
