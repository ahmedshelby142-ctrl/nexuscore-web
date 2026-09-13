-- 025 — mobile shortage read authority
--
-- One read-only, caller-scoped aggregate for Mobile Stock/Home.
-- It deliberately accepts no store_id: tenancy comes from auth.uid() through
-- store_members, and has_role() also applies the existing license predicate.
--
-- The deployed ledger uses qty_delta/amount_delta (not products.quantity) and
-- orders keep stockItems/items as JSONB documents. The formula mirrors
-- src/lib/shortages.ts:
--   deficit = SUM(open-line shortfall) - SUM(ledger stock qty_delta)
--
-- Apply this migration before enabling the Mobile shortage filter.

CREATE OR REPLACE FUNCTION public.mobile_shortages()
RETURNS TABLE (
  product_id TEXT,
  product_name TEXT,
  sku TEXT,
  stock NUMERIC,
  required NUMERIC,
  deficit NUMERIC,
  order_count BIGINT,
  waiting_orders JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_store_id UUID;
BEGIN
  SELECT sm.store_id
    INTO v_store_id
    FROM public.store_members sm
   WHERE sm.user_id = auth.uid()
     AND public.has_role(
       sm.store_id,
       VARIADIC ARRAY['ADMIN', 'ACCOUNTANT', 'ECOMMERCE_ONLY']::TEXT[]
     )
   LIMIT 1;

  IF v_store_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH open_orders AS (
    SELECT o.id, o."orderNumber", o."customerName", lines.line
      FROM public.orders o
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(o."stockItems") = 'array'
           AND jsonb_array_length(o."stockItems") > 0
            THEN o."stockItems"
          ELSE COALESCE(o.items, '[]'::jsonb)
        END
      ) AS lines(line)
     WHERE o.store_id = v_store_id
       AND o.status IN ('pending', 'processing')
  ), demand AS (
    SELECT
      (line->>'productId')::TEXT AS product_id,
      SUM(
        CASE
          WHEN (line->>'quantity') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN GREATEST((line->>'quantity')::NUMERIC, 0)
          ELSE 0
        END
      ) AS required,
      SUM(
        CASE
          WHEN (line->>'shortfall') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN GREATEST((line->>'shortfall')::NUMERIC, 0)
          WHEN lower(COALESCE(line->>'backorder', 'false')) = 'true'
           AND (line->>'quantity') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN GREATEST((line->>'quantity')::NUMERIC, 0)
          ELSE 0
        END
      ) AS owed,
      COUNT(DISTINCT id) AS order_count,
      jsonb_agg(
        DISTINCT jsonb_build_object(
          'orderId', id,
          'orderNumber', COALESCE("orderNumber", id),
          'customerName', COALESCE("customerName", '—')
        )
      ) AS waiting_orders
    FROM open_orders
   WHERE NULLIF(line->>'productId', '') IS NOT NULL
   GROUP BY (line->>'productId')::TEXT
  ), stock AS (
    SELECT l.subject_id AS product_id, SUM(l.qty_delta) AS stock
      FROM public.ledger_lines l
     WHERE l.store_id = v_store_id
       AND l.account = 'stock'
     GROUP BY l.subject_id
  )
  SELECT
    d.product_id,
    p.name,
    p.sku,
    COALESCE(s.stock, 0),
    d.required,
    d.owed - COALESCE(s.stock, 0),
    d.order_count,
    d.waiting_orders
  FROM demand d
  JOIN public.products p
    ON p.id = d.product_id
   AND p.store_id = v_store_id
  LEFT JOIN stock s ON s.product_id = d.product_id
 WHERE d.owed - COALESCE(s.stock, 0) > 0
 ORDER BY d.owed - COALESCE(s.stock, 0) DESC, d.product_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.mobile_shortages() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mobile_shortages() FROM anon;
GRANT EXECUTE ON FUNCTION public.mobile_shortages() TO authenticated;
