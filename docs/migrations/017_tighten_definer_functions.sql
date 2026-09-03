-- ============================================================================
-- 017 — lock down three SECURITY DEFINER routines
--
-- ALREADY APPLIED to the live project (oczgqpxeixlrufvevitz). Kept so the repo
-- matches the database.
--
-- Found by Supabase's own security advisor after 016, not by reading code —
-- all three predate this phase.
--
-- 1. `rls_auto_enable()` is SECURITY DEFINER and performs DDL, and it was
--    executable by `anon`. The publishable key that reaches that role ships
--    inside the client bundle by design, so "anon can call it" means "anyone
--    who opened the site can call it". Nothing in the app invokes it; it is a
--    maintenance routine. EXECUTE is now revoked from every client role.
--
-- 2. `claim_store(uuid)` creates a store and an ADMIN membership for
--    `auth.uid()`. Signup calls it while already authenticated, so `anon`
--    never needed it — and an anon caller has no `auth.uid()` to attach the
--    membership to. Restricted to `authenticated`.
--
--    Verified after applying: `authenticated` still holds EXECUTE, so signup
--    is unaffected; `anon` does not.
--
-- 3. `touch_store_license()` had a role-mutable `search_path`, which lets a
--    caller shadow the objects a definer function references. Pinned, exactly
--    as migration 014 did for the others.
--
-- The read-only predicates (`has_role`, `is_store_member`, `member_role`,
-- `list_store_members`) are deliberately left callable by `anon`: each returns
-- false or an empty set without a session, and `list_store_members` filters on
-- `is_store_member`. Revoking them would break nothing but buys nothing.
-- ============================================================================

REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM anon;
REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM authenticated;

REVOKE ALL ON FUNCTION public.claim_store(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_store(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_store(uuid) TO authenticated;

ALTER FUNCTION public.touch_store_license() SET search_path = public, pg_temp;
