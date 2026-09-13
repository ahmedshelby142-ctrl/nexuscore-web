-- 027 — Discount usage: a counter that cannot be raced, faked, or clobbered.
--
-- ## Why
--
-- `discount_codes` carried `maxUses` and nothing to count against it. There was
-- no `usedCount`, no `totalDiscount`, and no redemption record — so the limit
-- was unenforceable, and صفحة الخصومات had nothing truthful to show. That is
-- the reported bug: "the code worked once, but the screen did not record how
-- many times it was used or how much discount it gave."
--
-- ## Why a counter and an RPC, rather than deriving it from orders
--
-- Deriving usage by counting orders that carry the code is the honest shape for
-- a REPORT, and the orders remain exactly that — the audit trail. It cannot
-- enforce a limit. The count only changes once the order is written, which is
-- after the check, so two checkouts a millisecond apart both read
-- `used = limit - 1` and both proceed. This app is a browser talking straight
-- to PostgREST; there is no server runtime in between to serialise them. The
-- only place the read and the increment can happen together is inside one
-- Postgres transaction.
--
-- So `claim_discount_use` takes a row lock, re-validates the code against the
-- committed row, and increments — the same shape `next_document_number`
-- (migration 016) uses to hand out invoice numbers two tills cannot share.
-- `release_discount_use` is its compensation: a claim taken for an order that
-- then failed to write is given back.
--
-- ## Why the trigger
--
-- `write_discount_codes` lets ADMIN / POS_ECOMMERCE / ECOMMERCE_ONLY UPDATE the
-- row, and the client writes through a whole-row upsert. Without the trigger,
-- toggling a code active from a tab that loaded an hour ago would quietly write
-- that tab's stale `usedCount` back over the real one — and a crafted request
-- could set it to anything at all. The trigger pins both counters to their
-- committed values on every UPDATE that does not come from the two functions
-- below, so the RPCs are the only things that can move them. No policy is
-- widened and no role is invented.
--
-- ## Backfill
--
-- Existing codes are seeded from the real order history rather than from zero,
-- so the screen is truthful for codes already used before this ran. POS sales
-- count too: they carry the code in the ledger event payload.

ALTER TABLE public.discount_codes
  ADD COLUMN IF NOT EXISTS "usedCount" integer NOT NULL DEFAULT 0;

ALTER TABLE public.discount_codes
  ADD COLUMN IF NOT EXISTS "totalDiscount" numeric NOT NULL DEFAULT 0;

-- Marks the transaction as coming from a trusted function, so the guard trigger
-- knows to let the counters move. `set_config(..., true)` is LOCAL: scoped to
-- the transaction, so it cannot leak to the next one on the same connection.
CREATE OR REPLACE FUNCTION public._discount_usage_is_trusted()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce(current_setting('nexus.discount_usage', true), '') = 'on';
$fn$;

CREATE OR REPLACE FUNCTION public.guard_discount_usage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF public._discount_usage_is_trusted() THEN
    RETURN NEW;
  END IF;
  -- Any other writer keeps the committed values, whatever it sent.
  NEW."usedCount"     := OLD."usedCount";
  NEW."totalDiscount" := OLD."totalDiscount";
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS discount_usage_guard ON public.discount_codes;
CREATE TRIGGER discount_usage_guard
  BEFORE UPDATE ON public.discount_codes
  FOR EACH ROW EXECUTE FUNCTION public.guard_discount_usage();

-- Claim one use of a discount code, or refuse it. Returns the row AFTER the
-- claim. Raises with a stable NEXUS_ prefix the client maps to Arabic — the
-- codes are the contract, the wording is not.
CREATE OR REPLACE FUNCTION public.claim_discount_use(
  p_store uuid,
  p_code_id text,
  p_amount numeric
)
RETURNS public.discount_codes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  d public.discount_codes;
BEGIN
  IF NOT public.is_store_member(p_store) THEN
    RAISE EXCEPTION 'NEXUS_NOT_A_MEMBER';
  END IF;
  IF p_amount IS NULL OR NOT (p_amount >= 0) OR p_amount > 1e9 THEN
    RAISE EXCEPTION 'NEXUS_BAD_AMOUNT';
  END IF;

  -- The row lock is the whole point: concurrent claims queue here, so the
  -- limit check below reads a count nobody else can still be changing.
  SELECT * INTO d
  FROM public.discount_codes
  WHERE id = p_code_id AND store_id = p_store AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Also the cross-tenant answer: another store's code is simply not here.
    RAISE EXCEPTION 'NEXUS_CODE_NOT_FOUND';
  END IF;
  IF NOT d.active THEN
    RAISE EXCEPTION 'NEXUS_CODE_INACTIVE';
  END IF;
  IF d."expiryDate" IS NOT NULL AND d."expiryDate" < now() THEN
    RAISE EXCEPTION 'NEXUS_CODE_EXPIRED';
  END IF;
  IF d."maxUses" IS NOT NULL AND d."usedCount" >= d."maxUses" THEN
    RAISE EXCEPTION 'NEXUS_CODE_EXHAUSTED';
  END IF;

  PERFORM set_config('nexus.discount_usage', 'on', true);
  UPDATE public.discount_codes
     SET "usedCount"     = "usedCount" + 1,
         "totalDiscount" = "totalDiscount" + p_amount,
         updated_at      = (extract(epoch FROM now()) * 1000)::bigint
   WHERE id = p_code_id AND store_id = p_store
  RETURNING * INTO d;
  PERFORM set_config('nexus.discount_usage', 'off', true);

  RETURN d;
END;
$fn$;

-- Give a claim back, for an order that was claimed for and then failed.
-- Floored at zero: a release with no matching claim must not drive the counter
-- negative and hand out a free extra use.
CREATE OR REPLACE FUNCTION public.release_discount_use(
  p_store uuid,
  p_code_id text,
  p_amount numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT public.is_store_member(p_store) THEN
    RAISE EXCEPTION 'NEXUS_NOT_A_MEMBER';
  END IF;

  PERFORM set_config('nexus.discount_usage', 'on', true);
  UPDATE public.discount_codes
     SET "usedCount"     = GREATEST(0, "usedCount" - 1),
         "totalDiscount" = GREATEST(0, "totalDiscount" - coalesce(p_amount, 0)),
         updated_at      = (extract(epoch FROM now()) * 1000)::bigint
   WHERE id = p_code_id AND store_id = p_store AND deleted_at IS NULL;
  PERFORM set_config('nexus.discount_usage', 'off', true);
END;
$fn$;

REVOKE ALL ON FUNCTION public.claim_discount_use(uuid, text, numeric) FROM public;
REVOKE ALL ON FUNCTION public.release_discount_use(uuid, text, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_discount_use(uuid, text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_discount_use(uuid, text, numeric) TO authenticated;

-- ── Backfill from the real history ──────────────────────────────────────────
DO $backfill$
BEGIN
  PERFORM set_config('nexus.discount_usage', 'on', true);

  WITH from_orders AS (
    SELECT "discountCodeId" AS code_id, store_id,
           count(*) AS n, coalesce(sum("discountAmount"), 0) AS amt
    FROM public.orders
    WHERE "discountCodeId" IS NOT NULL AND deleted_at IS NULL
    GROUP BY 1, 2
  ),
  from_pos AS (
    SELECT (payload::jsonb ->> 'discountCodeId') AS code_id, store_id,
           count(*) AS n,
           coalesce(sum((payload::jsonb ->> 'discountAmount')::numeric), 0) AS amt
    FROM public.ledger_events
    WHERE kind = 'sale'
      AND payload::jsonb ->> 'discountCodeId' IS NOT NULL
      AND deleted_at IS NULL
    GROUP BY 1, 2
  ),
  merged AS (
    SELECT code_id, store_id, sum(n) AS n, sum(amt) AS amt
    FROM (SELECT * FROM from_orders UNION ALL SELECT * FROM from_pos) u
    GROUP BY 1, 2
  )
  UPDATE public.discount_codes d
     SET "usedCount"     = m.n,
         "totalDiscount" = m.amt
    FROM merged m
   WHERE d.id = m.code_id AND d.store_id = m.store_id;

  PERFORM set_config('nexus.discount_usage', 'off', true);
END
$backfill$;

-- ── 027b ────────────────────────────────────────────────────────────────────
-- Editing an order re-prices its discount (a percentage follows the new
-- basket). That changes what the code has GRANTED without changing how many
-- times it was USED, so neither claim nor release fits: one would consume a
-- second use, the other would give the use back. This moves the money only.
CREATE OR REPLACE FUNCTION public.adjust_discount_total(
  p_store uuid,
  p_code_id text,
  p_delta numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT public.is_store_member(p_store) THEN
    RAISE EXCEPTION 'NEXUS_NOT_A_MEMBER';
  END IF;
  IF p_delta IS NULL OR abs(p_delta) > 1e9 THEN
    RAISE EXCEPTION 'NEXUS_BAD_AMOUNT';
  END IF;

  PERFORM set_config('nexus.discount_usage', 'on', true);
  UPDATE public.discount_codes
     SET "totalDiscount" = GREATEST(0, "totalDiscount" + p_delta),
         updated_at = (extract(epoch FROM now()) * 1000)::bigint
   WHERE id = p_code_id AND store_id = p_store AND deleted_at IS NULL;
  PERFORM set_config('nexus.discount_usage', 'off', true);
END;
$fn$;

REVOKE ALL ON FUNCTION public.adjust_discount_total(uuid, text, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.adjust_discount_total(uuid, text, numeric) TO authenticated;
