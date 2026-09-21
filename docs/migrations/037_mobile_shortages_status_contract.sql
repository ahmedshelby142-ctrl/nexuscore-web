-- ============================================================================
-- 037 — the last `processing` leaves the database
--
-- `orders_status_check` accepts exactly five values:
--
--     pending · shipped · delivered · returned · cancelled
--
-- `mobile_shortages` still filtered `o.status IN ('pending', 'processing')`.
-- That second value is one Postgres rejects with 23514, so the predicate was
-- already a no-op — but it was the last place in the system still claiming a
-- sixth order state, and a stale predicate that is inert only because of a
-- CHECK somewhere else is a trap: widen that CHECK one day and this silently
-- starts selecting again.
--
-- Commit e1025a3 removed `processing` from every application path (the
-- wholesale write, which was failing 23514, and the mobile shortage/shipment
-- readers). This closes the database half. `processing` was never a business
-- state — `src/lib/orderLifecycle.ts` has no such node, and migration 012
-- records the live lineage as pending/shipped/delivered/returned + cancelled.
--
-- ## Scope
--
-- The body below is migration 033's, byte-for-byte, with ONE predicate
-- changed. Verified before writing: the normalised live definition and 033's
-- both hash to 9f244a14ca0a4b4f85811f26be8419fc, so 033 was a faithful record
-- of production and this is a true one-line diff against it.
--
-- Unchanged and deliberately re-stated so a reviewer can see they survived:
-- SECURITY DEFINER, STABLE, `search_path = public, pg_temp`, the `has_role`
-- gate over ADMIN/ACCOUNTANT/ECOMMERCE_ONLY/MODERATOR with its load-bearing
-- COALESCE, all three `store_id = p_store` tenant predicates, and the
-- eight-column output shape.
--
-- Grants are NOT re-issued: CREATE OR REPLACE keeps a function's ACL and
-- owner, so `authenticated` and `service_role` keep EXECUTE as before.
-- No table, column, policy, role, licence or ledger object is touched.
-- ============================================================================

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
      AND o.status IN ('pending')
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
