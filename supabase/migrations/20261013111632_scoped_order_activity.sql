-- LOCAL ONLY. Cost-free, read-only history for the exact active tenant/order.
-- Same membership boundary as orders_operational. No table/ledger write grant,
-- no payload/amount output, no historical reference change. Legacy API retained.
CREATE FUNCTION public.read_order_activity(p_store uuid,p_order_id text)
RETURNS TABLE(id text,kind text,occurred_at text,label text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE o public.orders;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_store_member(p_store),false) THEN
  RAISE EXCEPTION 'NEXUS_ORDER_ACTIVITY_FORBIDDEN' USING ERRCODE='42501';END IF;
 SELECT * INTO o FROM public.orders WHERE store_id=p_store AND orders.id=p_order_id AND deleted_at IS NULL;
 IF NOT FOUND OR nullif(o."orderNumber",'') IS NULL THEN
  RAISE EXCEPTION 'NEXUS_ORDER_ACTIVITY_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN QUERY
 SELECT e.id::text,e.kind::text,e.occurred_at::text,
  CASE WHEN e.ref_type='ecommerce_exchange_credit' THEN 'رد رصيد استبدال'
   WHEN e.id=o."exchangeDetails"->>'confirmationEventId' THEN 'استلام الأصل للاستبدال'
   WHEN e.kind='courier_settlement' THEN 'تسوية مع المندوب' ELSE NULL END
 FROM public.ledger_events e
 WHERE e.store_id=p_store AND (
  (e.ref_type='ecommerce_order' AND e.ref_id=o."orderNumber") OR
  (e.id=o."exchangeDetails"->>'confirmationEventId' AND e.kind='return_confirmed' AND e.ref_type='ecommerce_exchange' AND e.ref_id=o."exchangeDetails"->>'originalOrderNumber') OR
  (e.kind='client_payment' AND e.ref_type='ecommerce_exchange_credit' AND e.ref_id=o."exchangeDetails"->>'id') OR
  (e.kind='courier_settlement' AND e.ref_type='courier_batch' AND EXISTS(
   SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload::jsonb->'orders')='array' THEN e.payload::jsonb->'orders' ELSE '[]'::jsonb END) allocated
    WHERE allocated->>'id'=o.id)))
 ORDER BY e.occurred_at::timestamptz DESC,e.id DESC LIMIT 200;
END $fn$;
REVOKE ALL ON FUNCTION public.read_order_activity(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.read_order_activity(uuid,text) TO authenticated;
