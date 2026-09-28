-- ============================================================================
-- 050 — Release fixes: shared partners, atomic return confirmation, and the
--       Mobile shortage count on the Desktop meaning.
--
-- 1. partners — ownership is business data. It lived only in the browser that
--    typed it (`business-storage`), so another device had no partners and a
--    cleared browser lost them. One store-scoped table, read by the two roles
--    that own الشركاء والمالية (ADMIN, ACCOUNTANT), written by the same two.
--    Archiving keeps the row (past reports still resolve the name), so the
--    tombstone is `archived_at`, not the `deleted_at` the loader filters out.
--
-- 2. confirm_order_return — the confirmation of a returned online order in ONE
--    transaction: the order's `returnConfirmedAt` + `return_cause`, the ledger
--    event(s), and the customer's wasted-trip count. It used to be three
--    requests; when the cause was refused (orders_guard_return_cause) the
--    ledger had already moved, the order still looked unconfirmed, and a second
--    press booked the return twice. Now any refusal rolls everything back, and
--    `returnConfirmedAt` under a row lock makes a repeat a clean refusal.
--    SECURITY INVOKER: RLS on orders / ledger_events / customers and the cause
--    trigger decide exactly as before. No EXCEPTION block anywhere (043).
--
-- 3. mobile_shortages — the Mobile النواقص count. It subtracted open-order
--    demand from ledger stock, but `order_placed` has ALREADY taken those units
--    off the ledger, so every pending unit was counted twice (27 on hand +
--    an order for 30 → "short 33"; a covered order → a false shortage). It now
--    returns what Desktop's `computeShortages` (src/lib/shortages.ts) returns:
--        deficit = Σ shortfall on pending lines − max(0, ledger stock)
--    Signature, role gate and columns unchanged.
--
-- Re-runnable. Touches no existing row.
-- ============================================================================

-- ── 1. partners ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.partners (
  id                    text PRIMARY KEY,
  store_id              uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  device_id             uuid,
  name                  text NOT NULL,
  kind                  text NOT NULL DEFAULT 'working',
  "equityPercentage"    numeric NOT NULL DEFAULT 0 CHECK ("equityPercentage" >= 0 AND "equityPercentage" <= 100),
  status                text NOT NULL DEFAULT 'active',
  "joinedDate"          timestamptz,
  "userId"              text,
  -- The pre-ledger capital a browser once held for this partner. Kept so the
  -- «رقم مكتوب قبل الدفتر» hint survives the move; it is NOT capital (049).
  "capitalContribution" numeric,
  archived_at           bigint,
  "createdAt"           timestamptz DEFAULT now(),
  "updatedAt"           timestamptz DEFAULT now(),
  updated_at            bigint,
  sync_status           text
);
CREATE INDEX IF NOT EXISTS idx_partners_store ON public.partners (store_id);

ALTER TABLE public.partners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_partners ON public.partners;
CREATE POLICY select_partners ON public.partners FOR SELECT
  USING (
    public.is_store_member(store_id)
    AND EXISTS (SELECT 1 FROM public.store_members m
                 WHERE m.store_id = partners.store_id AND m.user_id = auth.uid()
                   AND m.role IN ('ADMIN', 'ACCOUNTANT'))
  );

DROP POLICY IF EXISTS write_partners ON public.partners;
CREATE POLICY write_partners ON public.partners FOR ALL
  USING (public.has_role(store_id, VARIADIC ARRAY['ADMIN', 'ACCOUNTANT']))
  WITH CHECK (public.has_role(store_id, VARIADIC ARRAY['ADMIN', 'ACCOUNTANT']));

REVOKE ALL ON public.partners FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partners TO authenticated;


-- ── 2. confirm_order_return ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.confirm_order_return(
  p_order_id    text,
  p_cause       text,
  p_movement    text,
  p_events      jsonb,
  p_customer_id text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order public.orders;
  v_row   jsonb;
  v_cust  jsonb;
  v_n     int;
  v_i     int;
  v_ev    jsonb;
  v_now   bigint := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
  IF p_cause IS NULL OR p_cause NOT IN ('customer', 'courier', 'shop') THEN
    RAISE EXCEPTION 'NEXUS_CAUSE_REQUIRED' USING ERRCODE = '23514';
  END IF;
  IF p_movement IS NULL OR p_movement NOT IN ('return', 'exchange') THEN
    RAISE EXCEPTION 'NEXUS_MOVEMENT_REQUIRED' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array' OR jsonb_array_length(p_events) NOT IN (1, 2) THEN
    RAISE EXCEPTION 'NEXUS_EVENTS_INVALID' USING ERRCODE = '23514';
  END IF;

  -- One confirmation at a time per order: a second press waits here, then
  -- finds the first one's stamp below and is refused.
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.status IS DISTINCT FROM 'returned' THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_RETURNED' USING ERRCODE = '23514';
  END IF;
  IF v_order."returnConfirmedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'NEXUS_RETURN_ALREADY_CONFIRMED' USING ERRCODE = '23505';
  END IF;

  -- Only THIS order's events: an optional order_delivered (the refund path's
  -- auto-delivery), then exactly one return_confirmed / rto_confirmed.
  v_n := jsonb_array_length(p_events);
  FOR v_i IN 0 .. v_n - 1 LOOP
    v_ev := p_events -> v_i;
    IF (v_ev ->> 'store_id')::uuid IS DISTINCT FROM v_order.store_id
       OR v_ev ->> 'ref_type' IS DISTINCT FROM 'ecommerce_order'
       OR v_ev ->> 'ref_id' IS DISTINCT FROM v_order."orderNumber" THEN
      RAISE EXCEPTION 'NEXUS_EVENT_NOT_THIS_ORDER' USING ERRCODE = '23514';
    END IF;
    IF (v_i = v_n - 1 AND v_ev ->> 'kind' NOT IN ('return_confirmed', 'rto_confirmed'))
       OR (v_i < v_n - 1 AND v_ev ->> 'kind' IS DISTINCT FROM 'order_delivered') THEN
      RAISE EXCEPTION 'NEXUS_EVENT_KIND' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  -- The document first. RLS decides who may confirm at all; the cause trigger
  -- (orders_guard_return_cause) decides who may record courier/shop.
  UPDATE public.orders
     SET "returnConfirmedAt" = now(), return_cause = p_cause, "updatedAt" = now(), updated_at = v_now
   WHERE id = p_order_id
  RETURNING to_jsonb(orders.*) INTO v_row;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_UPDATABLE' USING ERRCODE = '42501';
  END IF;

  FOR v_i IN 0 .. v_n - 1 LOOP
    PERFORM public.ledger_append(p_events -> v_i);
  END LOOP;

  -- A wasted trip is owed only when the CUSTOMER caused a plain return (an
  -- exchange carries the replacement out on the same journey). Same rule as
  -- `countsAsWastedTrip` in src/lib/shippingRates.ts.
  IF p_cause = 'customer' AND p_movement = 'return' AND NULLIF(p_customer_id, '') IS NOT NULL THEN
    UPDATE public.customers
       SET returned_orders_count = COALESCE(returned_orders_count, 0) + 1, updated_at = v_now
     WHERE id = p_customer_id AND store_id = v_order.store_id
    RETURNING to_jsonb(customers.*) INTO v_cust;
  END IF;

  -- `customer` is null when no trip was owed (or the customer is not on file).
  RETURN jsonb_build_object('order', v_row, 'customer', v_cust);
END;
$function$;

REVOKE ALL ON FUNCTION public.confirm_order_return(text, text, text, jsonb, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.confirm_order_return(text, text, text, jsonb, text) TO authenticated, service_role;


-- ── 3. mobile_shortages on the Desktop meaning ──────────────────────────────
CREATE OR REPLACE FUNCTION public.mobile_shortages(p_store uuid)
 RETURNS TABLE(product_id text, product_name text, sku text, stock numeric, required numeric, deficit numeric, order_count bigint, waiting_orders jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- COALESCE is load-bearing: `has_role` is NULL (not false) for a non-member.
  IF NOT COALESCE(public.has_role(
    p_store,
    VARIADIC ARRAY['ADMIN', 'ACCOUNTANT', 'ECOMMERCE_ONLY', 'MODERATOR']::text[]
  ), false) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH open_lines AS (
    SELECT o.id, o."orderNumber", o."customerName", line,
           CASE WHEN (line->>'quantity') ~ '^[0-9]+(\.[0-9]+)?$' THEN (line->>'quantity')::numeric ELSE 0 END AS qty
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
      SUM(qty) AS required,
      -- What each line could NOT cover when it was taken. `order_placed` has
      -- already taken every unit off the ledger, so this — not the line
      -- quantity — is what is still owed. `shortfallOf` in src/lib/shortages.ts.
      SUM(CASE
            WHEN jsonb_typeof(line->'shortfall') = 'null' THEN 0   -- Number(null) = 0 on Desktop
            WHEN (line->>'shortfall') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN GREATEST((line->>'shortfall')::numeric, 0)
            WHEN (line->>'backorder') = 'true' THEN qty
            ELSE 0
          END) AS owed,
      COUNT(DISTINCT id) AS order_count,
      jsonb_agg(DISTINCT jsonb_build_object(
        'orderId', id,
        'orderNumber', COALESCE("orderNumber", id),
        'customerName', COALESCE("customerName", '—')
      )) AS waiting_orders
    FROM open_lines
    WHERE NULLIF(line->>'productId', '') IS NOT NULL AND qty > 0
    GROUP BY 1
  ),
  on_hand AS (
    SELECT l.subject_id AS pid, SUM(l.qty_delta)::numeric AS stock
    FROM public.ledger_lines l
    WHERE l.store_id = p_store AND l.account = 'stock' AND l.deleted_at IS NULL
    GROUP BY 1
  )
  -- Stock as Desktop's getActualStock reads it: the ledger, floored at 0.
  SELECT d.pid, p.name, p.sku,
         GREATEST(COALESCE(h.stock, 0), 0), d.required,
         d.owed - GREATEST(COALESCE(h.stock, 0), 0),
         d.order_count, d.waiting_orders
  FROM demand d
  JOIN public.products p ON p.id = d.pid AND p.store_id = p_store
  LEFT JOIN on_hand h ON h.pid = d.pid
  WHERE d.owed - GREATEST(COALESCE(h.stock, 0), 0) > 0
  ORDER BY d.owed - GREATEST(COALESCE(h.stock, 0), 0) DESC, d.pid;
END;
$function$;
