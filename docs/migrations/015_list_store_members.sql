-- ============================================================================
-- 015 — list_store_members() : fix the Users screen
--
-- ALREADY APPLIED to the live project. Recorded so the repo matches the DB.
--
-- WHAT WAS BROKEN
-- ---------------
-- The Users screen asked PostgREST for:
--     store_members?select=user_id,role,created_at,users(email,username)
-- and got a 400 on every load, so it rendered but listed nobody. Three
-- independent reasons:
--   1. `store_members` has no `created_at` column.
--   2. `public.users` has no `email` column.
--   3. store_members.user_id references auth.users, NOT public.users, so the
--      embed could never resolve — and `auth` is not exposed over PostgREST,
--      nor should it be.
--
-- Emails therefore cannot be read by the client directly. SECURITY DEFINER is
-- the correct tool: expose exactly the four columns the screen needs, scoped by
-- is_store_member(), so a member of one shop can never enumerate another's.
-- Same shape as the existing admin_* helpers.
-- ============================================================================

ALTER TABLE public.store_members ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

CREATE OR REPLACE FUNCTION public.list_store_members()
RETURNS TABLE (user_id uuid, role text, email text, joined_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT sm.user_id,
         sm.role::text,
         u.email::text,
         COALESCE(sm.created_at, u.created_at)
  FROM public.store_members sm
  JOIN auth.users u ON u.id = sm.user_id
  WHERE is_store_member(sm.store_id);
$$;

REVOKE EXECUTE ON FUNCTION public.list_store_members() FROM anon;
GRANT  EXECUTE ON FUNCTION public.list_store_members() TO authenticated;
