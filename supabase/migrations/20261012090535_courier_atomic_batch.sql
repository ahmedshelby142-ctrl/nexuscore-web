-- LOCAL CANDIDATE: atomic full-order settlements. No historical backfill.
-- Fee-only payouts, individual partial allocations and old inconsistent
-- documents are deliberately NOT inferred by this forward-only contract.
CREATE FUNCTION public.record_courier_batch(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb)
-- ACCOUNTANT may settle money but the general orders UPDATE policy correctly
-- does not allow that role to edit merchandise/customer fields. This bounded
-- definer command changes only settlement/sync fields after explicit store
-- authorization; it does not broaden the orders RLS policy.
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE
 request jsonb:=jsonb_build_object('command',p_command,'input',p_input);
 saved public.ledger_events; o public.orders; order_id text;
 courier text:=p_input->>'courierId'; wallet text:=p_input->>'wallet';
 net numeric; cod numeric:=0; fees numeric:=0; r numeric; f numeric; extra numeric;
 posted_r numeric; posted_p numeric; shortfall numeric; lines jsonb:='[]'; result jsonb; changed integer;
 snapshots jsonb:='[]'; now_text text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false) THEN
  RAISE EXCEPTION 'NEXUS_COURIER_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF nullif(p_id,'') IS NULL OR p_device IS NULL OR p_command IS DISTINCT FROM 'courier_batch'
  OR nullif(courier,'') IS NULL OR wallet IS NULL OR lower(wallet) NOT IN ('instoresafe','vodafonecash','instapay','bankaccount')
  OR jsonb_typeof(p_input->'orderIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'orderIds')=0
  OR jsonb_typeof(p_input->'netReceived') IS DISTINCT FROM 'number' THEN
  RAISE EXCEPTION 'NEXUS_COURIER_BATCH_INVALID' USING ERRCODE='23514'; END IF;
 net:=(p_input->>'netReceived')::numeric;
 IF net::text IN ('NaN','Infinity','-Infinity') OR net<0 OR net<>round(net,2)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'orderIds') x WHERE jsonb_typeof(x)<>'string' OR x#>>'{}'='')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_input->'orderIds') x GROUP BY x HAVING count(*)>1) THEN
  RAISE EXCEPTION 'NEXUS_COURIER_BATCH_INVALID' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('courier-batch:'||p_id,0));
 SELECT * INTO saved FROM public.ledger_events WHERE id=p_id;
 IF FOUND THEN
  IF saved.store_id<>p_store OR saved.command_request IS DISTINCT FROM request THEN
   RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN saved.command_result||jsonb_build_object('replayed',true);
 END IF;
 -- Lock every selected document before courier balance validation; another
 -- new batch cannot consume a document using another operation identity.
 FOR order_id IN SELECT x FROM jsonb_array_elements_text(p_input->'orderIds') x ORDER BY x LOOP
  SELECT * INTO o FROM public.orders WHERE id=order_id AND store_id=p_store FOR UPDATE;
  IF NOT FOUND OR o.deleted_at IS NOT NULL OR o.status<>'delivered' OR o."expectedCod"<=0
   OR o."codSettledAt" IS NOT NULL OR coalesce(o."courierId",'default')<>courier THEN
   RAISE EXCEPTION 'NEXUS_COURIER_ORDER_NOT_OPEN' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM public.orders WHERE store_id=p_store AND "orderNumber"=o."orderNumber")<>1 THEN
   RAISE EXCEPTION 'NEXUS_COURIER_SOURCE_REVIEW_REQUIRED' USING ERRCODE='23514'; END IF;
  r:=round(o."expectedCod"*100); f:=round((CASE WHEN o."courierFee">0 THEN o."courierFee" ELSE o."shippingFee" END)*100);
  IF o."exchangeDetails"->>'status'='confirmed' THEN
   IF o."exchangeDetails"->>'refundVia'='courier' THEN r:=r-(o."exchangeDetails"->>'refundPiastres')::numeric; END IF;
   extra:=round(coalesce((o."exchangeDetails"->>'returnFee')::numeric,0)*100); f:=f+extra;
   IF o."exchangeDetails"->>'cause'<>'shop' THEN r:=r+extra; END IF;
  END IF;
  -- A mutable document alone cannot authorize consuming another order's
  -- balance. Match its attributed immutable source lines, including only
  -- THIS replacement's separately posted exchange-return leg.
  SELECT coalesce(sum(l.amount_delta) FILTER(WHERE l.account='receivable_courier'),0),
         coalesce(sum(l.amount_delta) FILTER(WHERE l.account='payable_courier'),0)
   INTO posted_r,posted_p FROM public.ledger_lines l JOIN public.ledger_events e ON e.id=l.event_id AND e.store_id=l.store_id
   WHERE e.store_id=p_store AND l.subject_id=courier AND
    ((e.ref_type='ecommerce_order' AND e.ref_id=o."orderNumber" AND e.kind IN ('order_delivered','return_confirmed','rto_confirmed'))
     OR (e.id=o."exchangeDetails"->>'confirmationEventId' AND e.ref_type='ecommerce_exchange' AND e.kind='return_confirmed'));
  IF r<0 OR f<0 OR posted_r<>r OR posted_p<>f OR r+f=0 THEN
   RAISE EXCEPTION 'NEXUS_COURIER_SOURCE_REVIEW_REQUIRED' USING ERRCODE='23514'; END IF;
  cod:=cod+r; fees:=fees+f;
  snapshots:=snapshots||jsonb_build_array(jsonb_build_object('id',o.id,'orderNumber',o."orderNumber",'codPiastres',r,'feePiastres',f));
 END LOOP;
 net:=net*100;
 -- Do not close fees which were not actually covered. Fee-only/negative-net
 -- and per-order partial allocations need the separate obligation contract.
 IF cod<fees OR net>cod-fees THEN
  RAISE EXCEPTION 'NEXUS_COURIER_PARTIAL_ALLOCATION_REQUIRED' USING ERRCODE='23514'; END IF;
 shortfall:=cod-fees-net;
 IF net>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','wallet','subject_id',wallet,'amount_delta',net::integer)); END IF;
 IF cod>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','receivable_courier','subject_id',courier,'amount_delta',(-cod)::integer)); END IF;
 IF fees>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','payable_courier','subject_id',courier,'amount_delta',(-fees)::integer)); END IF;
 IF shortfall>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','expense','subject_id','courier_shortfall','amount_delta',shortfall::integer)); END IF;
 result:=jsonb_build_object('eventId',p_id,'orderIds',p_input->'orderIds','orders',snapshots,'codPiastres',cod,'feePiastres',fees,
  'netPiastres',net,'shortfallPiastres',shortfall,'replayed',false);
 PERFORM public.ledger_append(jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'kind','courier_settlement',
  'actor','حسابات الشحن','ref_type','courier_batch','ref_id',p_id,'created_at',now_text,'occurred_at',now_text,
  'payload',jsonb_build_object('courierId',courier,'courierName',p_input->>'courierName','orderCount',jsonb_array_length(snapshots),
   'orderNumbers',(SELECT jsonb_agg(x->>'orderNumber') FROM jsonb_array_elements(snapshots) x),'orders',snapshots,
   'codTotal',cod/100,'expectedFees',fees/100,'expectedNet',(cod-fees)/100,'netReceived',net/100,'shortfall',shortfall/100,
   'wallet',wallet,'settlementType',CASE WHEN net=0 AND shortfall=0 THEN 'offset' ELSE 'transfer' END)::text,
  'lines',lines,'command_request',request,'command_result',result));
 UPDATE public.orders SET "codSettledAt"=now(),"updatedAt"=now(),sync_status='synced',
  updated_at=greatest(updated_at+1,(extract(epoch FROM clock_timestamp())*1000)::bigint)
  WHERE store_id=p_store AND id IN (SELECT x FROM jsonb_array_elements_text(p_input->'orderIds') x);
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>jsonb_array_length(p_input->'orderIds') THEN
  RAISE EXCEPTION 'NEXUS_COURIER_ORDER_WRITE_FAILED' USING ERRCODE='23514'; END IF;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.record_courier_batch(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_courier_batch(text,uuid,uuid,text,jsonb) TO authenticated;
