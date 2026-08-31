-- ============================================================================
-- 014 — new-user store provisioning + SECURITY DEFINER search_path
--
-- ALREADY APPLIED to the live project. Recorded here so the repo's migration
-- history matches the database.
--
-- ── 1. SECURITY: unpinned search_path on the RLS helpers ────────────────────
--
-- `is_store_member`, `has_role`, `member_role` and `claim_store` ran
-- SECURITY DEFINER with no search_path. EVERY RLS policy in this database
-- calls them, so a caller able to influence search_path could shadow
-- `public.store_members` with their own relation and make `is_store_member()`
-- return true for any store — a full RLS bypass.
--
-- ── 2. CORRECTNESS: new signups could never get a store ─────────────────────
--
-- `claim_store` inserted `role = 'owner'`, but `store_members_role_check`
-- permits only ADMIN / POS_ECOMMERCE / ECOMMERCE_ONLY / ACCOUNTANT — verified:
-- the insert raises check_violation. So the one routine able to bootstrap a
-- shop was guaranteed to fail, and nothing had called it since the desktop
-- build (its only caller sat behind `if (isDesktop)`) was removed.
--
-- The result: every new signup produced an authenticated account attached to
-- no store — no licence, and every write refused with "لم يتم ربط هذا الجهاز
-- بمتجر بعد".
--
-- It cannot be fixed client-side: `stores` has NO INSERT policy, and
-- `store_members` writes require has_role(store_id,'ADMIN') — the very row
-- being created. A SECURITY DEFINER function is the only way out of that
-- deadlock. 'ADMIN' is both the valid value and the right semantics: whoever
-- creates the shop administers it.
-- ============================================================================

ALTER FUNCTION public.is_store_member(uuid)           SET search_path = public, pg_temp;
ALTER FUNCTION public.has_role(uuid, VARIADIC text[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.member_role(uuid)               SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.claim_store(local_store_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    canonical_store_id UUID;
    v_uid UUID := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Already a member? Return it. Idempotent by design: a retry, a second tab
    -- or a re-login must never create a second shop.
    SELECT store_id INTO canonical_store_id
    FROM public.store_members
    WHERE user_id = v_uid
    LIMIT 1;

    IF canonical_store_id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'canonical', canonical_store_id,
            'rekey', canonical_store_id <> local_store_id
        );
    END IF;

    -- Refuse to attach to a store that already exists. Without this an
    -- authenticated stranger could pass someone else's store id and, finding no
    -- membership of their own, insert themselves into it.
    IF EXISTS (SELECT 1 FROM public.stores s WHERE s.id = local_store_id) THEN
        RAISE EXCEPTION 'store % already exists', local_store_id
          USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO public.stores (id) VALUES (local_store_id);
    INSERT INTO public.store_members (user_id, store_id, role)
    VALUES (v_uid, local_store_id, 'ADMIN');

    RETURN jsonb_build_object('canonical', local_store_id, 'rekey', false);
END;
$function$;

-- anon hits 'Not authenticated' immediately, but nothing unauthenticated has
-- business calling either of these.
REVOKE EXECUTE ON FUNCTION public.claim_store(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon, authenticated;
