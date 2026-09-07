-- ============================================================================
-- 023 — staff invitations: one store per person, decided by the database
--
-- Safe to re-run.
--
-- WHY THIS EXISTS
-- ---------------
-- الصلاحيات used to say an employee signs up and "then appears here". They do
-- not. `claim_store` gives an account with no membership a shop OF ITS OWN, as
-- ADMIN of it, so an unprompted signup lands in a separate empty tenant and is
-- invisible to the employer — `list_store_members` only ever returns members of
-- the caller's own store. There was no way at all to add a member of staff.
--
-- This adds the missing half. The Edge Function `invite-staff` creates the auth
-- account (the one thing that needs a service key, which is why it cannot live
-- in the browser); everything about WHO may invite WHOM is decided here, by
-- Postgres, from `auth.uid()`.
--
-- ── 1. One person, one shop ─────────────────────────────────────────────────
--
-- `getActiveStoreId()` resolves the caller's store with
--
--     select store_id from store_members where user_id = … limit 1
--
-- so a person in two stores gets an ARBITRARY one, and every row they write
-- lands in whichever the database happened to return. The application has
-- always assumed one membership per person; nothing enforced it.
--
-- An invitation is exactly the operation that would have broken it — inviting
-- someone who already runs their own shop. The index makes the assumption real,
-- so that case fails loudly at the database instead of quietly scrambling which
-- tenant they are in.
--
-- If multi-store membership is ever wanted, this index is the thing to drop,
-- and `getActiveStoreId` is the thing that has to learn how to choose.

CREATE UNIQUE INDEX IF NOT EXISTS store_members_one_store_per_user
  ON public.store_members (user_id);

-- ── 2. What an inviting admin is allowed to know ────────────────────────────
--
-- The Edge Function needs three facts before it can act: which store the caller
-- administers, whether the address already has an account, and whether that
-- account is already spoken for. All three come from here, derived from
-- `auth.uid()` — never from anything the browser sent.
--
-- SECURITY DEFINER because it reads `auth.users`, which no client role can
-- touch. It is deliberately narrow: it answers about ONE address the caller
-- typed, returns no email, no name and no other store's id, and refuses
-- entirely unless the caller is an ADMIN. It is an existence check, not a
-- directory — an admin cannot enumerate the user table with it.

CREATE OR REPLACE FUNCTION public.staff_invite_context(p_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid        UUID := auth.uid();
  v_store      UUID;
  v_role       TEXT;
  v_email      TEXT := lower(btrim(p_email));
  v_target     UUID;
  v_target_store UUID;
  v_status     TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  -- The caller's store and role come from the table, not the request.
  SELECT m.store_id, m.role INTO v_store, v_role
  FROM public.store_members m
  WHERE m.user_id = v_uid
  LIMIT 1;

  IF v_store IS NULL THEN
    RAISE EXCEPTION 'you do not belong to a store' USING ERRCODE = '42501';
  END IF;
  IF v_role <> 'ADMIN' THEN
    RAISE EXCEPTION 'only a store admin may invite staff' USING ERRCODE = '42501';
  END IF;

  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'that is not an email address';
  END IF;

  SELECT u.id INTO v_target FROM auth.users u WHERE lower(u.email) = v_email;

  IF v_target IS NULL THEN
    v_status := 'no_account';
  ELSE
    SELECT m.store_id INTO v_target_store
    FROM public.store_members m WHERE m.user_id = v_target LIMIT 1;

    IF v_target_store IS NULL THEN      v_status := 'account_unlinked';
    ELSIF v_target_store = v_store THEN v_status := 'already_member';
    ELSE                                v_status := 'belongs_elsewhere';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'store_id', v_store,
    'status',   v_status,
    -- Only ever this store's own candidate. `belongs_elsewhere` returns NULL so
    -- an admin cannot learn the id of a person in someone else's shop.
    'user_id',  CASE WHEN v_status IN ('no_account','belongs_elsewhere') THEN NULL ELSE v_target END
  );
END;
$fn$;

-- Callable by signed-in users only; the body refuses anyone who is not an
-- ADMIN of a store. `anon` cannot reach it at all.
REVOKE ALL ON FUNCTION public.staff_invite_context(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_invite_context(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.staff_invite_context(TEXT) TO authenticated;

-- ── 3. Linking the account to the shop ──────────────────────────────────────
--
-- The membership INSERT itself does NOT need a definer function and does not
-- get one: `write_store_members` already says `has_role(store_id,'ADMIN')`, so
-- the Edge Function performs it AS THE CALLER, under the same RLS as every
-- other write in the app. That is the point — the store id it writes is the one
-- this function returned, and RLS independently checks the caller administers
-- it. A forged store id fails the policy even if the function were bypassed.
--
-- The role is constrained by the existing CHECK on `store_members.role`, so
-- 'owner', 'system_owner' and 'superadmin' are rejected by the column itself,
-- not merely by the client.
--
-- Nothing here can grant System Owner: that is an email allowlist compiled into
-- `is_system_owner()` and changing it takes a migration.
