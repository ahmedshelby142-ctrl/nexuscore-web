-- ============================================================================
-- 019 — claim_store: give the new shop a name, and one switch for activation
--
-- Safe to re-run.
--
-- TWO SEPARATE THINGS. Read the second one before changing it.
--
-- ── 1. THE BUG (fixed here, unconditionally) ────────────────────────────────
--
-- `claim_store` created the store with `INSERT INTO public.stores (id)` and no
-- name at all, so every shop provisioned by a signup had `name = NULL`. The
-- settings screen then showed its hardcoded default ("محلي") over a row that
-- held nothing, and any report or header printing the shop name printed blank.
--
-- A store is now created with a neutral placeholder the owner renames in
-- الإعدادات. Deliberately NOT derived from the email: the shop name is printed
-- on invoices and shown to customers, and turning someone's personal address
-- into their public shop name is a privacy leak they never agreed to.
--
-- ── 2. THE POLICY (NOT decided here) ────────────────────────────────────────
--
-- `TRIAL_DAYS` below is the only line that decides whether a brand-new shop can
-- work before you activate it:
--
--     0   → no licence row is created. The owner lands on /license-expired,
--           which now says the account and shop exist and activation is
--           pending. THIS IS THE CURRENT BEHAVIOUR and this migration does not
--           change it.
--
--     >0  → a trial licence of that many days is issued automatically and the
--           shop works immediately.
--
-- Which one is right is a commercial decision about when you get paid, not an
-- engineering one, so it is left at 0 — the behaviour that exists today. To
-- switch to a trial, change the one number and re-run this file. Nothing else
-- needs to move.
--
-- The licence table is deliberately writable only by `service_role` (migration
-- 007) so a shop owner can never extend their own. That still holds: this
-- function is SECURITY DEFINER, so it — and only it — may issue the initial
-- grant, and only at the moment the shop is created.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.claim_store(local_store_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
    canonical_store_id UUID;
    v_uid UUID := auth.uid();
    -- ── the switch. 0 = manual activation (current behaviour). ──
    TRIAL_DAYS CONSTANT INT := 0;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Already a member of a store? Return it. Idempotent by design: a retry,
    -- a second tab, or a re-login must never create a second shop.
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
    -- membership of their own, try to insert themselves into it.
    IF EXISTS (SELECT 1 FROM public.stores s WHERE s.id = local_store_id) THEN
        RAISE EXCEPTION 'store % already exists', local_store_id
          USING ERRCODE = 'unique_violation';
    END IF;

    -- THE FIX: a name, so the row is not NULL.
    INSERT INTO public.stores (id, name) VALUES (local_store_id, 'متجري');
    INSERT INTO public.store_members (user_id, store_id, role)
    VALUES (v_uid, local_store_id, 'ADMIN');

    IF TRIAL_DAYS > 0 THEN
        -- `license_key` is UNIQUE NOT NULL, so the key carries the store id.
        INSERT INTO public.store_licenses
            (store_id, license_key, plan_type, valid_until, status, notes)
        VALUES (
            local_store_id,
            'TRIAL-' || replace(local_store_id::text, '-', ''),
            'BASIC',
            now() + (TRIAL_DAYS || ' days')::interval,
            'active',
            'Automatic trial issued at signup by claim_store.'
        )
        ON CONFLICT (store_id) DO NOTHING;
    END IF;

    RETURN jsonb_build_object('canonical', local_store_id, 'rekey', false);
END;
$fn$;

-- Unchanged from migration 017: signup calls this while already authenticated,
-- and an anon caller has no auth.uid() to attach a membership to.
REVOKE ALL ON FUNCTION public.claim_store(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_store(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_store(UUID) TO authenticated;

-- Backfill the shops that were already created with no name. Scoped to NULL
-- only, so a shop the owner has already named is never touched.
UPDATE public.stores SET name = 'متجري' WHERE name IS NULL;
