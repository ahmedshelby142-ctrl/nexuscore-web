-- 028 — Mobile shortages: real demand vs real stock, for a named store.
--
-- ## Why
--
-- `mobile_shortages` (migration 025) answered the wrong question and guessed
-- the store.
--
-- **Wrong question.** `deficit` was `owed - stock`, where `owed` counted only
-- lines already flagged `shortfall` or `backorder`. An ordinary pending order
-- for 3 units with 1 on the shelf produced `owed = 0`, a negative deficit, and
-- was filtered out — so the shortage list could not answer the one question the
-- operator opens it for: "customer X ordered 3, can we fulfil it?" Only
-- shortfalls somebody had already hand-flagged ever appeared.
--
-- The deficit is now `required - stock`: what open orders actually demand,
-- against what the ledger actually holds. `required` and `stock` are both
-- returned so the screen can show the two numbers the question is about.
--
-- **Guessed store.** It picked the caller's membership with `LIMIT 1`, which
-- for a member of more than one store is an arbitrary answer. The store is now
-- a parameter, validated against membership — the same shape
-- `claim_discount_use` and `next_document_number` use — so the client's
-- `getActiveStoreId()` stays the single authority for which store is active
-- and the database verifies rather than guesses.
--
-- ## Unchanged
--
-- Stock is still `SUM(ledger_lines.qty_delta)` — never `products.quantity`.
-- The role gate is still ADMIN / ACCOUNTANT / ECOMMERCE_ONLY, matching
-- `/inventory` in `ROUTE_ACCESS`. No policy is widened and no role invented.

DROP FUNCTION IF EXISTS public.mobile_shortages();

CREATE OR REPLACE FUNCTION public.mobile_shortages(p_store uuid)
RETURNS TABLE(
  product_id text,
  product_name text,
  sku text,
  stock numeric,
  required numeric,
  deficit numeric,
  order_count bigint,
  waiting_orders jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  -- Membership AND the same roles `/inventory` admits. A caller who may not
  -- open the stock screen may not read its shortages either.
  --
  -- COALESCE is load-bearing. `has_role` is `member_role(store) = ANY(roles)`,
  -- and `member_role` is NULL for someone who is not a member at all — so
  -- `NULL = ANY(...)` is NULL, `NOT NULL` is NULL, and plpgsql treats
  -- `IF NULL THEN` as false. Without it the guard does not fire for exactly
  -- the caller it exists to stop, and a non-member reads another shop's
  -- shortages. Verified: an ADMIN of a different store got QA-STORE's rows.
  IF NOT COALESCE(public.has_role(
    p_store,
    VARIADIC ARRAY['ADMIN', 'ACCOUNTANT', 'ECOMMERCE_ONLY']::text[]
  ), false) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH open_lines AS (
    SELECT
      o.id,
      o."orderNumber",
      o."customerName",
      line
    FROM public.orders o
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(o."stockItems") = 'array' AND jsonb_array_length(o."stockItems") > 0
          THEN o."stockItems"
        ELSE COALESCE(o.items, '[]'::jsonb)
      END
    ) AS lines(line)
    WHERE o.store_id = p_store
      AND o.deleted_at IS NULL
      AND o.status IN ('pending', 'processing')
  ),
  demand AS (
    SELECT
      (line->>'productId')::text AS pid,
      -- What the open orders actually ask for. This is the number the old
      -- version never used.
      SUM(
        CASE
          WHEN (line->>'quantity') ~ '^[0-9]+(\.[0-9]+)?$'
            THEN GREATEST((line->>'quantity')::numeric, 0)
          ELSE 0
        END
      ) AS required,
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
    -- `qty_delta` is `real`, so the SUM is `real` and does not match the
    -- declared `numeric` column. Postgres only raises that when a row is
    -- actually returned, so it stayed invisible while the deficit filter
    -- matched nothing.
    SELECT l.subject_id AS pid, SUM(l.qty_delta)::numeric AS stock
    FROM public.ledger_lines l
    WHERE l.store_id = p_store
      AND l.account = 'stock'
      AND l.deleted_at IS NULL
    GROUP BY 1
  )
  SELECT
    d.pid,
    p.name,
    p.sku,
    COALESCE(h.stock, 0),
    d.required,
    d.required - COALESCE(h.stock, 0),
    d.order_count,
    d.waiting_orders
  FROM demand d
  JOIN public.products p
    ON p.id = d.pid AND p.store_id = p_store
  LEFT JOIN on_hand h ON h.pid = d.pid
  WHERE d.required - COALESCE(h.stock, 0) > 0
  ORDER BY d.required - COALESCE(h.stock, 0) DESC, d.pid;
END;
$fn$;

REVOKE ALL ON FUNCTION public.mobile_shortages(uuid) FROM public;
-- `anon` holds EXECUTE explicitly, from Supabase's default privileges — not via
-- PUBLIC — so revoking PUBLIC alone leaves it callable by a signed-out client.
-- It would return nothing (`has_role` is false with no `auth.uid()`), but 025
-- revoked it and there is no reason to widen that.
REVOKE ALL ON FUNCTION public.mobile_shortages(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.mobile_shortages(uuid) TO authenticated;
