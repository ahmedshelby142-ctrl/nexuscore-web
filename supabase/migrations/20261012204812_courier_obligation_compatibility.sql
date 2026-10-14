-- LOCAL ONLY. Requires catalog_return_compatibility and the five preceding
-- master migrations. New allocations only; no historical rewrites/backfill.
CREATE FUNCTION financial_private.courier_obligation(o public.orders,p_courier text) RETURNS jsonb
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $fn$
DECLARE r numeric;f numeric;allocated_r numeric;allocated_f numeric;reason text;
BEGIN
 IF (SELECT count(*) FROM public.orders WHERE store_id=o.store_id AND "orderNumber"=o."orderNumber")<>1 THEN
  RETURN jsonb_build_object('reviewReason','NEXUS_COURIER_SOURCE_REVIEW_REQUIRED');END IF;
 SELECT coalesce(sum(l.amount_delta) FILTER(WHERE l.account='receivable_courier'),0),
        coalesce(sum(l.amount_delta) FILTER(WHERE l.account='payable_courier'),0)
 INTO r,f FROM public.ledger_lines l JOIN public.ledger_events e ON e.id=l.event_id AND e.store_id=l.store_id
 WHERE e.store_id=o.store_id AND l.subject_id=p_courier AND
  ((e.ref_type='ecommerce_order' AND e.ref_id=o."orderNumber" AND e.kind IN ('order_delivered','return_confirmed','rto_confirmed','courier_settlement'))
   OR EXISTS(SELECT 1 FROM financial_private.order_exchanges ex WHERE ex.store_id=o.store_id AND ex.replacement_id=o.id AND ex.status='confirmed' AND ex.confirmation_event_id=e.id));
 -- Batch snapshots are the immutable per-order allocation journal. Older
 -- individual settlements are included above; never subtract either twice.
 SELECT coalesce(sum((x->>'codPiastres')::numeric),0),coalesce(sum((x->>'feePiastres')::numeric),0)
 INTO allocated_r,allocated_f FROM public.ledger_events e CROSS JOIN LATERAL jsonb_array_elements(e.payload::jsonb->'orders') x
 WHERE e.store_id=o.store_id AND e.kind='courier_settlement' AND e.ref_type='courier_batch'
  AND e.payload::jsonb->>'courierId'=p_courier AND x->>'id'=o.id;
 r:=r-allocated_r;f:=f-allocated_f;
 IF EXISTS(SELECT 1 FROM public.ledger_events e WHERE e.store_id=o.store_id AND e.kind='courier_settlement'
   AND e.ref_type='courier_batch' AND e.payload::jsonb->>'courierId'=p_courier AND NOT e.payload::jsonb ? 'orders'
   AND coalesce(e.payload::jsonb->'orderNumbers','[]') ? o."orderNumber")
  OR (o."codSettledAt" IS NOT NULL AND allocated_r=0 AND allocated_f=0 AND NOT EXISTS(SELECT 1 FROM public.ledger_events e WHERE e.store_id=o.store_id AND e.kind='courier_settlement' AND e.ref_type='ecommerce_order' AND e.ref_id=o."orderNumber"))
  OR f<0 THEN reason:='NEXUS_COURIER_HISTORY_REVIEW_REQUIRED';END IF;
 RETURN jsonb_build_object('orderId',o.id,'orderNumber',o."orderNumber",'courierId',p_courier,'codPiastres',r,'feePiastres',f,'reviewReason',reason);
END $fn$;
REVOKE ALL ON FUNCTION financial_private.courier_obligation(public.orders,text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.read_courier_obligations(p_store uuid,p_courier text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE o public.orders;item jsonb;result jsonb:='[]';
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.can_read_store_finance(p_store),false) THEN RAISE EXCEPTION 'NEXUS_COURIER_FORBIDDEN' USING ERRCODE='42501';END IF;
 FOR o IN SELECT * FROM public.orders WHERE store_id=p_store AND deleted_at IS NULL AND "wholesaleClientId" IS NULL
  AND (status='delivered' OR (status='returned' AND "returnConfirmedAt" IS NOT NULL))
  AND nullif("courierId",'') IS NOT NULL AND (p_courier IS NULL OR "courierId"=p_courier) ORDER BY id LOOP
  item:=financial_private.courier_obligation(o,o."courierId");
  IF item->>'reviewReason' IS NOT NULL OR (item->>'codPiastres')::numeric<>0 OR (item->>'feePiastres')::numeric<>0 THEN
   result:=result||jsonb_build_array(item);END IF;
 END LOOP;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.read_courier_obligations(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.read_courier_obligations(uuid,text) TO authenticated;

-- A negative wallet/receivable clearing is allowed only inside this exact
-- canonical command, before its new immutable event is inserted. Raw legacy
-- writers retain every prior sign and balance restriction.
CREATE FUNCTION financial_private.is_courier_allocation(p_event jsonb) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
 SELECT auth.uid() IS NOT NULL AND coalesce(public.has_role((p_event->>'store_id')::uuid,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY']),false)
 AND p_event->>'kind'='courier_settlement' AND p_event->>'ref_type'='courier_batch'
 AND EXISTS(SELECT 1 FROM financial_private.courier_commands c WHERE c.event_id=p_event->>'id' AND c.store_id=(p_event->>'store_id')::uuid
  AND c.request=p_event->'command_request' AND c.request->>'command'='courier_batch' AND c.xmin::text=pg_current_xact_id()::text)
 AND NOT EXISTS(SELECT 1 FROM public.ledger_events e WHERE e.id=p_event->>'id')
$fn$;
REVOKE ALL ON FUNCTION financial_private.is_courier_allocation(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION financial_private.is_courier_allocation(jsonb) TO authenticated;
DO $migration$
DECLARE definition text;needle text:='IF w + rco - pc + ex <> 0 OR v_wallet_out > 0 OR v_rco_pos > 0 OR v_pc_pos > 0 OR v_ex_neg > 0 THEN';
BEGIN
 definition:=replace(pg_get_functiondef('public.ledger_validate_event(jsonb)'::regprocedure),chr(13),'');
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'NEXUS_COURIER_VALIDATOR_SCHEMA_DRIFT';END IF;
 EXECUTE replace(definition,needle,'IF w + rco - pc + ex <> 0 OR v_pc_pos > 0 OR v_ex_neg > 0 OR ((v_wallet_out > 0 OR v_rco_pos > 0) AND NOT financial_private.is_courier_allocation(p_event)) THEN');
END $migration$;

-- A claim is a workflow note, never a second balance. A settlement of another
-- order (or an expense write-off) cannot prove this claim was collected.
-- Forward checks only; existing claim/history rows are not rewritten.
CREATE FUNCTION financial_private.guard_claim_coverage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE o public.orders;e public.ledger_events;covered numeric;obligation jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.store_id IS DISTINCT FROM OLD.store_id OR NEW.id IS DISTINCT FROM OLD.id OR
    (OLD.status<>'pending' AND (NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.courier_id IS DISTINCT FROM OLD.courier_id
     OR NEW.amount_piastres IS DISTINCT FROM OLD.amount_piastres OR NEW.return_record_id IS DISTINCT FROM OLD.return_record_id)) THEN
   RAISE EXCEPTION 'NEXUS_CLAIM_IDENTITY_IMMUTABLE' USING ERRCODE='23514';END IF;
  IF OLD.status IN ('settled','rejected') THEN RETURN NEW;END IF;
 END IF;
 SELECT * INTO o FROM public.orders WHERE id=NEW.order_id AND store_id=NEW.store_id FOR UPDATE;
 IF NOT FOUND OR o."courierId" IS DISTINCT FROM NEW.courier_id OR NOT EXISTS(
   SELECT 1 FROM public.couriers WHERE id=NEW.courier_id AND store_id=NEW.store_id AND deleted_at IS NULL)
  OR (NEW.return_record_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.return_records
   WHERE id=NEW.return_record_id AND store_id=NEW.store_id AND original_order_id=NEW.order_id)) THEN
  RAISE EXCEPTION 'NEXUS_CLAIM_SOURCE_MISMATCH' USING ERRCODE='23514';END IF;
 IF NEW.status<>'settled' THEN RETURN NEW;END IF;
 SELECT * INTO e FROM public.ledger_events WHERE id=NEW.settlement_event_id AND store_id=NEW.store_id
  AND kind='courier_settlement';
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.ledger_lines l WHERE l.event_id=e.id
  AND l.account='receivable_courier' AND l.subject_id=NEW.courier_id AND l.amount_delta<0)
  OR EXISTS(SELECT 1 FROM public.ledger_lines l WHERE l.event_id=e.id AND l.account='expense' AND l.amount_delta<>0) THEN
  RAISE EXCEPTION 'NEXUS_CLAIM_NOT_COVERED' USING ERRCODE='23514';END IF;
 IF e.ref_type='courier_batch' THEN
  IF NOT EXISTS(SELECT 1 FROM financial_private.courier_commands c WHERE c.event_id=e.id AND c.store_id=NEW.store_id AND c.request=e.command_request)
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.payload::jsonb->'orders') x
    WHERE x->>'id'=o.id AND (x->>'codPiastres')::numeric>0 AND (x->>'remainingCodPiastres')::numeric=0) THEN
   RAISE EXCEPTION 'NEXUS_CLAIM_NOT_COVERED' USING ERRCODE='23514';END IF;
 ELSIF e.ref_type IS DISTINCT FROM 'ecommerce_order' OR e.ref_id IS DISTINCT FROM o."orderNumber" THEN
  RAISE EXCEPTION 'NEXUS_CLAIM_NOT_COVERED' USING ERRCODE='23514';END IF;
 obligation:=financial_private.courier_obligation(o,NEW.courier_id);
 IF obligation->>'reviewReason' IS NOT NULL OR (obligation->>'codPiastres')::numeric<>0 THEN
  RAISE EXCEPTION 'NEXUS_CLAIM_NOT_COVERED' USING ERRCODE='23514';END IF;
 -- Account for prior partial allocations, only from immutable, source-proved
 -- settlements without ambiguous multi-order shortfall allocation.
 SELECT coalesce(sum(n),0) INTO covered FROM (
  SELECT (x->>'codPiastres')::numeric n FROM public.ledger_events s
   JOIN financial_private.courier_commands c ON c.event_id=s.id AND c.store_id=s.store_id AND c.request=s.command_request
   CROSS JOIN LATERAL jsonb_array_elements(s.payload::jsonb->'orders') x
   WHERE s.store_id=NEW.store_id AND s.kind='courier_settlement' AND s.ref_type='courier_batch'
    AND s.payload::jsonb->>'courierId'=NEW.courier_id AND x->>'id'=o.id AND (x->>'codPiastres')::numeric>0
    AND NOT EXISTS(SELECT 1 FROM public.ledger_lines l WHERE l.event_id=s.id AND l.account='expense' AND l.amount_delta<>0)
  UNION ALL
  SELECT -l.amount_delta FROM public.ledger_events s JOIN public.ledger_lines l ON l.event_id=s.id
   WHERE s.store_id=NEW.store_id AND s.kind='courier_settlement' AND s.ref_type='ecommerce_order' AND s.ref_id=o."orderNumber"
    AND l.account='receivable_courier' AND l.subject_id=NEW.courier_id AND l.amount_delta<0
    AND NOT EXISTS(SELECT 1 FROM public.ledger_lines w WHERE w.event_id=s.id AND w.account='expense' AND w.amount_delta<>0)
 ) proven;
 IF covered<NEW.amount_piastres THEN RAISE EXCEPTION 'NEXUS_CLAIM_NOT_COVERED' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_claim_coverage() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER nexus_claim_coverage BEFORE INSERT OR UPDATE ON public.courier_claims FOR EACH ROW EXECUTE FUNCTION financial_private.guard_claim_coverage();

CREATE OR REPLACE FUNCTION public.record_courier_batch(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE request jsonb:=jsonb_build_object('command',p_command,'input',p_input);saved public.ledger_events;o public.orders;order_id text;
 courier text:=p_input->>'courierId';wallet text:=p_input->>'wallet';net numeric;cod numeric:=0;fees numeric:=0;r numeric;f numeric;available_r numeric;available_f numeric;
 obligation jsonb;allocation jsonb;snapshots jsonb:='[]';closed jsonb:='[]';lines jsonb:='[]';result jsonb;shortfall numeric;stamp timestamptz:=now();
 claim_id text;claim public.courier_claims;claim_ids jsonb:=coalesce(p_input->'claimIds','[]');
BEGIN
 -- These are the existing ledger courier-settlement roles. General orders
 -- RLS is unchanged; the bounded command updates settlement/sync fields only.
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN RAISE EXCEPTION 'NEXUS_COURIER_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF p_command IS DISTINCT FROM 'courier_batch' OR nullif(p_id,'') IS NULL OR p_device IS NULL OR nullif(courier,'') IS NULL
  OR wallet IS NULL OR lower(wallet) NOT IN ('instoresafe','vodafonecash','instapay','bankaccount')
  OR jsonb_typeof(p_input->'orderIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'orderIds')=0
  OR jsonb_typeof(p_input->'netReceived') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'NEXUS_COURIER_BATCH_INVALID' USING ERRCODE='23514';END IF;
 net:=(p_input->>'netReceived')::numeric;
 IF net::text IN ('NaN','Infinity','-Infinity') OR net<>round(net,2)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'orderIds') x WHERE jsonb_typeof(x)<>'string' OR x#>>'{}'='')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_input->'orderIds') x GROUP BY x HAVING count(*)>1) THEN RAISE EXCEPTION 'NEXUS_COURIER_BATCH_INVALID' USING ERRCODE='23514';END IF;
 IF p_input ? 'allocations' AND (jsonb_typeof(p_input->'allocations') IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_input->'allocations')<>jsonb_array_length(p_input->'orderIds')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'allocations') x WHERE NOT (p_input->'orderIds' ? (x->>'orderId')))) THEN
  RAISE EXCEPTION 'NEXUS_COURIER_ALLOCATION_INVALID' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(claim_ids) IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(claim_ids) x WHERE jsonb_typeof(x)<>'string' OR x#>>'{}'='')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(claim_ids) x GROUP BY x HAVING count(*)>1) THEN
  RAISE EXCEPTION 'NEXUS_CLAIM_BATCH_INVALID' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('courier-batch:'||p_id,0));
 SELECT * INTO saved FROM public.ledger_events WHERE id=p_id;
 IF FOUND THEN
  IF saved.store_id IS DISTINCT FROM p_store OR saved.command_request IS DISTINCT FROM request THEN RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514';END IF;
  RETURN saved.command_result||jsonb_build_object('replayed',true);
 END IF;
 IF NOT public.store_licensed(p_store) THEN RAISE EXCEPTION 'NEXUS_STORE_NOT_LICENSED' USING ERRCODE='42501';END IF;
 -- Same lock order as ordinary claim updates: claim first, then its order.
 -- Selecting a note never expands the existing ADMIN/ACCOUNTANT write role.
 IF jsonb_array_length(claim_ids)>0 AND NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false) THEN
  RAISE EXCEPTION 'NEXUS_CLAIM_FORBIDDEN' USING ERRCODE='42501';END IF;
 FOR claim_id IN SELECT x FROM jsonb_array_elements_text(claim_ids) x ORDER BY 1 LOOP
  SELECT * INTO claim FROM public.courier_claims WHERE id=claim_id AND store_id=p_store FOR UPDATE;
  IF NOT FOUND OR claim.status<>'approved' OR claim.deleted_at IS NOT NULL OR claim.courier_id IS DISTINCT FROM courier
   OR NOT (p_input->'orderIds' ? claim.order_id) THEN RAISE EXCEPTION 'NEXUS_CLAIM_NOT_COVERED' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR order_id IN SELECT x FROM jsonb_array_elements_text(p_input->'orderIds') x ORDER BY 1 LOOP
  SELECT * INTO o FROM public.orders WHERE id=order_id AND store_id=p_store FOR UPDATE;
  IF NOT FOUND OR o.deleted_at IS NOT NULL OR o."wholesaleClientId" IS NOT NULL OR o."courierId" IS DISTINCT FROM courier
   OR NOT (o.status='delivered' OR (o.status='returned' AND o."returnConfirmedAt" IS NOT NULL)) THEN RAISE EXCEPTION 'NEXUS_COURIER_ORDER_NOT_OPEN' USING ERRCODE='23514';END IF;
  obligation:=financial_private.courier_obligation(o,courier);
  IF obligation->>'reviewReason' IS NOT NULL THEN RAISE EXCEPTION '%',obligation->>'reviewReason' USING ERRCODE='23514';END IF;
  available_r:=(obligation->>'codPiastres')::numeric;available_f:=(obligation->>'feePiastres')::numeric;
  IF available_r=0 AND available_f=0 THEN RAISE EXCEPTION 'NEXUS_COURIER_ORDER_NOT_OPEN' USING ERRCODE='23514';END IF;
  IF p_input ? 'allocations' THEN
   IF (SELECT count(*) FROM jsonb_array_elements(p_input->'allocations') x WHERE x->>'orderId'=o.id)<>1 THEN RAISE EXCEPTION 'NEXUS_COURIER_ALLOCATION_INVALID' USING ERRCODE='23514';END IF;
   SELECT x INTO allocation FROM jsonb_array_elements(p_input->'allocations') x WHERE x->>'orderId'=o.id;
   IF (allocation ? 'expectedCodPiastres' AND (allocation->>'expectedCodPiastres')::numeric IS DISTINCT FROM available_r)
    OR (allocation ? 'expectedFeePiastres' AND (allocation->>'expectedFeePiastres')::numeric IS DISTINCT FROM available_f) THEN RAISE EXCEPTION 'NEXUS_COURIER_ALLOCATION_STALE' USING ERRCODE='23514';END IF;
   IF jsonb_typeof(allocation->'codPiastres') IS DISTINCT FROM 'number' OR jsonb_typeof(allocation->'feePiastres') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'NEXUS_COURIER_ALLOCATION_INVALID' USING ERRCODE='23514';END IF;
   r:=(allocation->>'codPiastres')::numeric;f:=(allocation->>'feePiastres')::numeric;
  ELSE r:=available_r;f:=available_f;END IF;
  IF r::text IN ('NaN','Infinity','-Infinity') OR f::text IN ('NaN','Infinity','-Infinity') OR r<>trunc(r) OR f<>trunc(f)
   OR f<0 OR f>available_f OR r<least(0,available_r) OR r>greatest(0,available_r) OR (r=0 AND f=0) THEN RAISE EXCEPTION 'NEXUS_COURIER_ALLOCATION_INVALID' USING ERRCODE='23514';END IF;
  cod:=cod+r;fees:=fees+f;
  snapshots:=snapshots||jsonb_build_array(jsonb_build_object('id',o.id,'orderNumber',o."orderNumber",'codPiastres',r,'feePiastres',f,
    'remainingCodPiastres',available_r-r,'remainingFeePiastres',available_f-f));
  IF r=available_r AND f=available_f THEN closed:=closed||jsonb_build_array(o.id);END IF;
 END LOOP;
 net:=net*100;
 IF (cod-fees<0 AND net<>cod-fees) OR (cod-fees>=0 AND (net<0 OR net>cod-fees)) THEN RAISE EXCEPTION 'NEXUS_COURIER_NET_MISMATCH' USING ERRCODE='23514';END IF;
 shortfall:=cod-fees-net;
 IF net<>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','wallet','subject_id',wallet,'amount_delta',net));END IF;
 FOR allocation IN SELECT x FROM jsonb_array_elements(snapshots) x LOOP
  IF (allocation->>'codPiastres')::numeric<>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','receivable_courier','subject_id',courier,'amount_delta',-(allocation->>'codPiastres')::numeric));END IF;
  IF (allocation->>'feePiastres')::numeric<>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','payable_courier','subject_id',courier,'amount_delta',-(allocation->>'feePiastres')::numeric));END IF;
 END LOOP;
 IF shortfall>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','expense','subject_id','courier_shortfall','amount_delta',shortfall));END IF;
 IF jsonb_array_length(lines)=0 THEN RAISE EXCEPTION 'NEXUS_COURIER_ALLOCATION_NET_ZERO' USING ERRCODE='23514';END IF;
 result:=jsonb_build_object('eventId',p_id,'orderIds',p_input->'orderIds','closedOrderIds',closed,'closedClaimIds',claim_ids,'orders',snapshots,'codPiastres',cod,'feePiastres',fees,'netPiastres',net,'shortfallPiastres',shortfall,'replayed',false);
 INSERT INTO financial_private.courier_commands VALUES(p_id,p_store,request);
 PERFORM public.ledger_append(jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'kind','courier_settlement','actor','حسابات الشحن','ref_type','courier_batch','ref_id',p_id,'created_at',now(),'occurred_at',now(),
  'payload',jsonb_build_object('courierId',courier,'courierName',p_input->>'courierName','orderCount',jsonb_array_length(snapshots),
   'orderNumbers',(SELECT jsonb_agg(x->>'orderNumber') FROM jsonb_array_elements(snapshots) x),'orders',snapshots,
   'codTotal',cod/100,'expectedFees',fees/100,'expectedNet',(cod-fees)/100,'netReceived',net/100,'shortfall',shortfall/100,'wallet',wallet,
   'settlementType',CASE WHEN net=0 AND shortfall=0 THEN 'offset' WHEN net<0 THEN 'payout' ELSE 'transfer' END)::text,
  'lines',lines,'command_request',request,'command_result',result));
 INSERT INTO financial_private.courier_stamp_permits SELECT txid_current(),p_store,x,stamp FROM jsonb_array_elements_text(closed) x;
 UPDATE public.orders SET "codSettledAt"=CASE WHEN closed ? id THEN stamp ELSE "codSettledAt" END,"updatedAt"=now(),sync_status='synced',
  updated_at=greatest(updated_at+1,(extract(epoch FROM clock_timestamp())*1000)::bigint) WHERE store_id=p_store AND p_input->'orderIds' ? id;
 -- When a second settlement occurs in the same transaction the timestamp
 -- may be unchanged; the trigger then needs no permit. Do not leave one.
 DELETE FROM financial_private.courier_stamp_permits WHERE transaction_id=txid_current() AND store_id=p_store;
 UPDATE public.courier_claims SET status='settled',settlement_event_id=p_id
  WHERE store_id=p_store AND claim_ids ? id;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(claim_ids) x WHERE NOT EXISTS(SELECT 1 FROM public.courier_claims c
  WHERE c.id=x AND c.store_id=p_store AND c.status='settled' AND c.settlement_event_id=p_id)) THEN
  RAISE EXCEPTION 'NEXUS_CLAIM_DOCUMENT_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.record_courier_batch(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_courier_batch(text,uuid,uuid,text,jsonb) TO authenticated;

DO $migration$
DECLARE definition text;
BEGIN
 definition:=replace(pg_get_functiondef('public.record_order_delivery(text,uuid,uuid,text,jsonb)'::regprocedure),chr(13),'');
 IF strpos(definition,'IF settle AND cod>0 THEN')=0 THEN RAISE EXCEPTION 'NEXUS_DELIVERY_SETTLEMENT_SCHEMA_DRIFT';END IF;
 -- Prepaid deliveries may still owe the courier a fee-only payout.
 definition:=replace(definition,' cod:=round(o."expectedCod"*100);',' cod:=round(o."expectedCod"*100);'||chr(10)||' fee:=round((CASE WHEN o."courierFee">0 THEN o."courierFee" ELSE o."shippingFee" END)*100);');
 definition:=replace(definition,'settle AND cod>0','settle AND (cod>0 OR fee>0)');
 EXECUTE definition;
END $migration$;
