-- ============================================================================
-- 045 — an order and its placement land together, or not at all
--
-- Safe to re-run: CREATE OR REPLACE. Additive: one new function, nothing else
-- changes, and nothing calls it until the client does. 043 and 044 untouched.
--
-- WHY
-- ---
-- `/ecommerce-orders` appended `order_placed` (stock out + the deposit into a
-- wallet) and THEN wrote the order row, in a second request. So:
--   * the deposit reached the ledger before any document said what was owed,
--     and nothing could bound it — the P1 this pair of migrations closes;
--   * a refused order row left money and a reservation with no document. The
--     client compensated with an `order_cancelled`, but compensation is itself
--     a request that can fail. Production holds 21 `order_placed` events whose
--     order does not exist, and 2 orders placed twice.
--
-- `place_order` inserts the row and calls `ledger_append` in ONE transaction:
-- a failure anywhere rolls back both. It is SECURITY INVOKER — `write_orders`
-- and the ledger policies decide who may do this, as the caller, exactly as
-- the two separate requests did. It adds no authority of its own.
--
-- RETRY
-- -----
-- Idempotent on (store, orderNumber), the pair `orders_number_per_store`
-- (042) already makes unique, and serialized on that pair with an advisory
-- lock. The client keeps a draft's number until the order is confirmed, so a
-- retry after a lost response finds its own order and returns it with
-- `replayed: true` instead of placing it twice. The order row and the
-- `order_placed` event are only ever created together, so "row exists" means
-- "placed" — a row found WITHOUT its event is refused, never patched.
--
-- 043: the append runs at top level (no exception handler here), so the event
-- is created by the transaction's own xid and its lines are admitted.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.place_order(p_order jsonb, p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_store    uuid := (p_order ->> 'store_id')::uuid;
  v_number   text := p_order ->> 'orderNumber';
  v_existing jsonb;
  v_cols     text;
  v_row      jsonb;
BEGIN
  IF v_store IS NULL OR p_order ->> 'id' IS NULL OR v_number IS NULL OR btrim(v_number) = '' THEN
    RAISE EXCEPTION 'place_order: the order needs an id, a store and an order number' USING ERRCODE = '23514';
  END IF;
  IF p_event ->> 'kind' IS DISTINCT FROM 'order_placed'
     OR p_event ->> 'ref_type' IS DISTINCT FROM 'ecommerce_order'
     OR p_event ->> 'ref_id' IS DISTINCT FROM v_number
     OR (p_event ->> 'store_id')::uuid IS DISTINCT FROM v_store THEN
    RAISE EXCEPTION 'place_order: the event must be this order''s own order_placed' USING ERRCODE = '23514';
  END IF;

  -- One placement per (store, number) at a time; a concurrent duplicate waits
  -- here and then sees the committed order below.
  PERFORM pg_advisory_xact_lock(hashtext('place_order:' || v_store::text || ':' || v_number));

  SELECT to_jsonb(o.*) INTO v_existing
    FROM public.orders o
   WHERE o.store_id = v_store AND o."orderNumber" = v_number;
  IF v_existing IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.ledger_events e
                WHERE e.store_id = v_store AND e.kind = 'order_placed'
                  AND e.ref_type = 'ecommerce_order' AND e.ref_id = v_number) THEN
      RETURN jsonb_build_object('order', v_existing, 'replayed', true);
    END IF;
    RAISE EXCEPTION 'place_order: order % exists without its placement', v_number USING ERRCODE = '23505';
  END IF;

  -- Only the columns the client sent, so every omitted column keeps its
  -- DEFAULT (jsonb_populate_record alone would write NULL over them).
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.orders'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND p_order ? a.attname;

  EXECUTE format(
    'INSERT INTO public.orders AS o (%1$s) SELECT %1$s FROM jsonb_populate_record(NULL::public.orders, $1) RETURNING to_jsonb(o.*)',
    v_cols)
  USING p_order INTO v_row;

  -- Validated by ledger_validate_event against the row just inserted (046).
  PERFORM public.ledger_append(p_event);

  RETURN jsonb_build_object('order', v_row, 'replayed', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.place_order(jsonb, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.place_order(jsonb, jsonb) TO authenticated, service_role;
