-- 033 — MODERATOR: a fifth role that is read-only AT THE DATABASE.
--
-- ## Why a new role instead of widening one
--
-- `docs/MOBILE_PERSONA_ARCHITECTURE.md` §4 works through the four that exist
-- and each is short by exactly the thing that matters: `POS_ECOMMERCE` has no
-- stock, `ECOMMERCE_ONLY` has no customers, `ACCOUNTANT` has neither orders nor
-- shipments, and `ADMIN` fits only by also carrying member management and the
-- money. Widening `ECOMMERCE_ONLY` to reach CRM is the tempting one-liner and
-- it silently opens DESKTOP CRM to every `ECOMMERCE_ONLY` member in every
-- store, because `ROUTE_ACCESS` is shared.
--
-- ## Why this migration adds almost nothing
--
-- Reads come with membership: `select_orders`, `select_products`,
-- `select_customers`, `select_couriers`, `select_ledger_lines` and
-- `select_ledger_events` are all `is_store_member(store_id)`, not role-gated.
-- So the Moderator can read what it needs the moment the CHECK constraint lets
-- the row exist. NO SELECT POLICY IS TOUCHED HERE.
--
-- Writes are the mirror image: `write_orders`, `write_products`,
-- `write_customers`, `write_suppliers`, `write_purchase_invoices`,
-- `write_transactions`, `write_expenses`, `insert_ledger_events` and the rest
-- are `has_role(...)` lists, and none of them gains 'MODERATOR'. The role is
-- therefore read-only because of what this file does NOT say.
--
-- ## The holes that had to be closed for that to be TRUE
--
-- Audited against the live database on 2026-09-20. Three write paths were
-- gated on MEMBERSHIP alone, so "absent from every has_role list" would not
-- have been enough — a Moderator would have inherited all three:
--
--   1. `insert_ledger_lines`  WITH CHECK (is_store_member AND store_licensed)
--      — `ledger_append` is SECURITY INVOKER and inserts the header first, so
--        the role gate on `insert_ledger_events` stops the RPC. It does not
--        stop a direct PostgREST insert of lines onto an EXISTING event id,
--        which moves every balance that sums them.
--   2. `update_products`      USING (is_store_member AND store_licensed)
--      — deliberately open because `applyStockMoves` writes the quantity
--        mirror for the selling roles (022). The definition columns are held
--        by the `products_guard_definition_columns` trigger; the quantity
--        column is not, and quantity is a stock mutation.
--   3. `claim_discount_use` / `release_discount_use` / `adjust_discount_total`
--      / `next_document_number` — SECURITY DEFINER, guarded by
--        `is_store_member` only.
--
-- Each is re-gated on the FOUR EXISTING ROLES. Every member who could perform
-- these writes before can still perform them: the only caller `has_role(…four)`
-- refuses that `is_store_member` allowed is one holding a role outside the
-- four, and until today no such role existed.
--
-- The one deliberate consequence: `has_role` also requires `store_licensed`,
-- which the two policies already required and the four functions did not. All
-- four are called only from sale / purchase / wholesale flows that write the
-- ledger, and `insert_ledger_lines` has required a live licence since 024 — so
-- for an unlicensed store the refusal now arrives one call earlier than it did.

BEGIN;

-- ── 1. The role becomes assignable ──────────────────────────────────────────
ALTER TABLE public.store_members DROP CONSTRAINT IF EXISTS store_members_role_check;
ALTER TABLE public.store_members ADD CONSTRAINT store_members_role_check
  CHECK (role::text = ANY (ARRAY[
    'ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT', 'MODERATOR'
  ]::text[]));

-- ── 2. Shortages — the one READ that is role-gated, not membership-gated ────
-- Body unchanged from 028/031 apart from the added role.
CREATE OR REPLACE FUNCTION public.mobile_shortages(p_store uuid)
RETURNS TABLE(product_id text, product_name text, sku text, stock numeric,
              required numeric, deficit numeric, order_count bigint,
              waiting_orders jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- COALESCE is load-bearing: `has_role` is NULL (not false) for a non-member,
  -- and plpgsql treats `IF NOT NULL THEN` as false, so an unguarded `IF NOT`
  -- lets through exactly the caller it exists to stop.
  IF NOT COALESCE(public.has_role(
    p_store,
    VARIADIC ARRAY['ADMIN', 'ACCOUNTANT', 'ECOMMERCE_ONLY', 'MODERATOR']::text[]
  ), false) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH open_lines AS (
    SELECT o.id, o."orderNumber", o."customerName", line
    FROM public.orders o
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(o."stockItems") = 'array' AND jsonb_array_length(o."stockItems") > 0
           THEN o."stockItems" ELSE COALESCE(o.items, '[]'::jsonb) END
    ) AS lines(line)
    WHERE o.store_id = p_store AND o.deleted_at IS NULL
      AND o.status IN ('pending', 'processing')
  ),
  demand AS (
    SELECT (line->>'productId')::text AS pid,
      SUM(CASE WHEN (line->>'quantity') ~ '^[0-9]+(\.[0-9]+)?$'
               THEN GREATEST((line->>'quantity')::numeric, 0) ELSE 0 END) AS required,
      COUNT(DISTINCT id) AS order_count,
      jsonb_agg(DISTINCT jsonb_build_object(
        'orderId', id,
        'orderNumber', COALESCE("orderNumber", id),
        'customerName', COALESCE("customerName", '—')
      )) AS waiting_orders
    FROM open_lines
    WHERE NULLIF(line->>'productId', '') IS NOT NULL
    GROUP BY 1
  ),
  on_hand AS (
    SELECT l.subject_id AS pid, SUM(l.qty_delta)::numeric AS stock
    FROM public.ledger_lines l
    WHERE l.store_id = p_store AND l.account = 'stock' AND l.deleted_at IS NULL
    GROUP BY 1
  )
  SELECT d.pid, p.name, p.sku,
         COALESCE(h.stock, 0), d.required,
         d.required - COALESCE(h.stock, 0),
         d.order_count, d.waiting_orders
  FROM demand d
  JOIN public.products p ON p.id = d.pid AND p.store_id = p_store
  LEFT JOIN on_hand h ON h.pid = d.pid
  WHERE d.required - COALESCE(h.stock, 0) > 0
  ORDER BY d.required - COALESCE(h.stock, 0) DESC, d.pid;
END;
$function$;

-- ── 3. The two write policies that were gated on membership alone ───────────
DROP POLICY IF EXISTS insert_ledger_lines ON public.ledger_lines;
CREATE POLICY insert_ledger_lines ON public.ledger_lines
  FOR INSERT WITH CHECK (
    public.has_role(store_id, VARIADIC
      ARRAY['ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT'])
  );

DROP POLICY IF EXISTS update_products ON public.products;
CREATE POLICY update_products ON public.products
  FOR UPDATE USING (
    public.has_role(store_id, VARIADIC
      ARRAY['ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT'])
  );

-- ── 4. The four SECURITY DEFINER writers ────────────────────────────────────
-- `is_store_member` → `has_role(…four)`. Bodies are otherwise untouched.

CREATE OR REPLACE FUNCTION public.claim_discount_use(p_store uuid, p_code_id text, p_amount numeric)
RETURNS public.discount_codes
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d public.discount_codes;
BEGIN
  IF NOT COALESCE(public.has_role(p_store, VARIADIC
    ARRAY['ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT']), false)
  THEN RAISE EXCEPTION 'NEXUS_NOT_A_MEMBER' USING ERRCODE = '42501'; END IF;
  IF p_amount IS NULL OR NOT (p_amount >= 0) OR p_amount > 1e9 THEN RAISE EXCEPTION 'NEXUS_BAD_AMOUNT'; END IF;

  SELECT * INTO d FROM public.discount_codes
   WHERE id = p_code_id AND store_id = p_store AND deleted_at IS NULL FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_CODE_NOT_FOUND'; END IF;
  IF NOT d.active THEN RAISE EXCEPTION 'NEXUS_CODE_INACTIVE'; END IF;
  IF d."expiryDate" IS NOT NULL AND d."expiryDate" < now() THEN RAISE EXCEPTION 'NEXUS_CODE_EXPIRED'; END IF;
  IF d."maxUses" IS NOT NULL AND d."usedCount" >= d."maxUses" THEN RAISE EXCEPTION 'NEXUS_CODE_EXHAUSTED'; END IF;

  PERFORM set_config('nexus.discount_usage', 'on', true);
  UPDATE public.discount_codes
     SET "usedCount" = "usedCount" + 1,
         "totalDiscount" = "totalDiscount" + p_amount,
         updated_at = (extract(epoch FROM now()) * 1000)::bigint
   WHERE id = p_code_id AND store_id = p_store RETURNING * INTO d;
  PERFORM set_config('nexus.discount_usage', 'off', true);
  RETURN d;
END;
$function$;

CREATE OR REPLACE FUNCTION public.release_discount_use(p_store uuid, p_code_id text, p_amount numeric)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT COALESCE(public.has_role(p_store, VARIADIC
    ARRAY['ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT']), false)
  THEN RAISE EXCEPTION 'NEXUS_NOT_A_MEMBER' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('nexus.discount_usage', 'on', true);
  UPDATE public.discount_codes
     SET "usedCount" = GREATEST(0, "usedCount" - 1),
         "totalDiscount" = GREATEST(0, "totalDiscount" - coalesce(p_amount, 0)),
         updated_at = (extract(epoch FROM now()) * 1000)::bigint
   WHERE id = p_code_id AND store_id = p_store AND deleted_at IS NULL;
  PERFORM set_config('nexus.discount_usage', 'off', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.adjust_discount_total(p_store uuid, p_code_id text, p_delta numeric)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT COALESCE(public.has_role(p_store, VARIADIC
    ARRAY['ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT']), false)
  THEN RAISE EXCEPTION 'NEXUS_NOT_A_MEMBER' USING ERRCODE = '42501'; END IF;
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
$function$;

CREATE OR REPLACE FUNCTION public.next_document_number(p_store uuid, p_name text, p_prefix text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v BIGINT;
BEGIN
  IF NOT COALESCE(public.has_role(p_store, VARIADIC
    ARRAY['ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT']), false) THEN
    RAISE EXCEPTION 'not a member of this store' USING ERRCODE = '42501';
  END IF;
  IF p_name !~ '^[a-z_]{1,32}$' OR p_prefix !~ '^[A-Z]{1,6}-$' THEN
    RAISE EXCEPTION 'bad counter name or prefix';
  END IF;
  INSERT INTO public.store_counters (store_id, name, value)
  VALUES (p_store, p_name, 1)
  ON CONFLICT (store_id, name)
  DO UPDATE SET value = public.store_counters.value + 1
  RETURNING value INTO v;
  RETURN p_prefix || lpad(v::text, 4, '0');
END;
$function$;

COMMIT;
