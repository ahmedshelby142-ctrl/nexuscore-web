-- LOCAL ONLY: forward exchange-credit allocation; no historical rewrites.
-- The original return creates a negative customer receivable (earned credit).
-- Delivery consumes it and books only actual net customer COD to the courier.
-- Cash deposits remain cash only. Excess original credit is a separate refund.
CREATE TABLE financial_private.exchange_credit_commands (
 id text PRIMARY KEY REFERENCES public.ledger_events(id) DEFERRABLE INITIALLY DEFERRED,
 store_id uuid NOT NULL, request jsonb NOT NULL, result jsonb, completed boolean NOT NULL DEFAULT false
);
ALTER TABLE financial_private.exchange_credit_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.exchange_credit_commands FROM PUBLIC,anon,authenticated;

CREATE FUNCTION financial_private.exchange_allocated_credit(o public.orders) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE e financial_private.order_exchanges;
BEGIN
 IF NOT coalesce(public.has_role(o.store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF o."exchangeDetails"->'credit'->>'version' IS DISTINCT FROM '1' THEN RETURN 0;END IF;
 SELECT * INTO e FROM financial_private.order_exchanges WHERE store_id=o.store_id AND replacement_id=o.id;
 IF NOT FOUND OR e.details IS DISTINCT FROM o."exchangeDetails" THEN
  RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_SOURCE_REVIEW' USING ERRCODE='23514';END IF;
 RETURN (e.details->'credit'->>'allocatedPiastres')::numeric;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.exchange_allocated_credit(public.orders) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION financial_private.exchange_allocated_credit(public.orders) TO authenticated;

-- Rewrite only captured, explicitly matched contracts. Schema drift aborts.
DO $migration$
DECLARE d text;needle text;
BEGIN
 d:=replace(pg_get_functiondef('public.record_exchange_place(text,uuid,uuid,text,jsonb)'::regprocedure),chr(13),'');
 needle:=' replacement:=replacement||jsonb_build_object(''isExchange'',true';
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_PLACE_SCHEMA_DRIFT';END IF;
 d:=replace(d,needle,$patch$
 value:=round((coalesce((replacement->>'totalAmount')::numeric,0)+coalesce((replacement->>'shippingFee')::numeric,0)+coalesce((replacement->>'wastedTripCompensation')::numeric,0)-coalesce((replacement->>'depositAmount')::numeric,0))*100);
 IF value<0 THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_DEPOSIT_EXCESS' USING ERRCODE='23514';END IF;

 v_details:=v_details||jsonb_build_object('credit',jsonb_build_object('version',1,'eligiblePiastres',(v_details->>'refundPiastres')::numeric,
  'allocatedPiastres',least((v_details->>'refundPiastres')::numeric,value),'excessPiastres',greatest(0,(v_details->>'refundPiastres')::numeric-value),
  'refundedAllocationPiastres',0,'status','reserved','courierId',replacement->>'courierId'));
 replacement:=replacement||jsonb_build_object('expectedCod',(value-(v_details->'credit'->>'allocatedPiastres')::numeric)/100);
 replacement:=replacement||jsonb_build_object('isExchange',true$patch$);
 EXECUTE d;

 d:=replace(pg_get_functiondef('public.ledger_validate_event(jsonb)'::regprocedure),chr(13),'');
 needle:='abs(v_dep + v_cod - v_total - v_ship - v_comp) >= 0.005';
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_PLACEMENT_VALIDATOR_DRIFT';END IF;
 d:=replace(d,needle,$patch$abs(v_dep + v_cod + coalesce((SELECT financial_private.exchange_allocated_credit(o)/100 FROM public.orders o WHERE o.store_id=v_store AND o."orderNumber"=v_ref_id),0) - v_total - v_ship - v_comp) >= 0.005$patch$);
 EXECUTE d;

 d:=replace(pg_get_functiondef('public.record_exchange_return(text,uuid,uuid,text,jsonb)'::regprocedure),chr(13),'');
 d:=replace(d,'refund numeric; fee numeric','allocated numeric:=0; actual_refund numeric; refund numeric; fee numeric');
 needle:=' IF refund_via=''wallet'' THEN';
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_RETURN_SCHEMA_DRIFT';END IF;
 d:=replace(d,needle,$patch$
 allocated:=financial_private.exchange_allocated_credit(replacement);
 actual_refund:=refund-allocated;
 IF allocated>0 THEN
  lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','receivable_client','subject_id','exchange-credit:'||e.id,'qty_delta',0,'amount_delta',-allocated));
 END IF;
 IF refund_via='wallet' THEN$patch$);
 -- Only the unallocated remainder is an actual cash/courier refund.
 d:=replace(d,$needle$IF refund>0 THEN lines:=lines||$needle$, $replacement$IF actual_refund>0 THEN lines:=lines||$replacement$);
 d:=replace(d,$needle$'amount_delta',-refund)); END IF;$needle$,$replacement$'amount_delta',-actual_refund)); END IF;$replacement$);
 d:=replace(d,$needle$'subject_id',o."customerId",'qty_delta',0,'amount_delta',-actual_refund$needle$,$replacement$'subject_id',o."customerId",'qty_delta',0,'amount_delta',-refund$replacement$);
 needle:=' UPDATE financial_private.order_exchanges SET status=''confirmed'',details=v_details';
 d:=replace(d,needle,$patch$
 IF e.details->'credit'->>'version'='1' THEN
  v_details:=jsonb_set(v_details,'{credit}',(e.details->'credit')||jsonb_build_object('status','applied','excessDisposition',refund_via,'physicalReturnEventId',p_id));
 END IF;
 UPDATE financial_private.order_exchanges SET status='confirmed',details=v_details$patch$);
 d:=replace(d,' INSERT INTO public.return_records(id,store_id', $patch$
 IF NOT FOUND OR replacement."exchangeDetails" IS DISTINCT FROM v_details THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_DOCUMENT_REQUIRED' USING ERRCODE='23514';END IF;
 INSERT INTO public.return_records(id,store_id$patch$);
 EXECUTE d;

 d:=replace(pg_get_functiondef('financial_private.delivery_lines(public.orders)'::regprocedure),chr(13),'');
 needle:=' compensation:=round(coalesce(o."wastedTripCompensation",0)*100);';
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_DELIVERY_SCHEMA_DRIFT';END IF;
 d:=replace(d,needle,$patch$
 IF o."exchangeDetails"->'credit'->>'version'='1' THEN
  IF o."exchangeDetails"->>'status'<>'confirmed' OR o."exchangeDetails"->'credit'->>'status'<>'applied' THEN
   RAISE EXCEPTION 'NEXUS_EXCHANGE_PHYSICAL_RETURN_REQUIRED' USING ERRCODE='23514';END IF;
  IF financial_private.exchange_allocated_credit(o)>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','receivable_client','subject_id','exchange-credit:'||(o."exchangeDetails"->>'id'),'amount_delta',financial_private.exchange_allocated_credit(o)));END IF;
 END IF;
 compensation:=round(coalesce(o."wastedTripCompensation",0)*100);$patch$);
 d:=replace(d,'round(o."depositAmount"*100)+cod<>goods','round(o."depositAmount"*100)+cod+financial_private.exchange_allocated_credit(o)<>goods');
 EXECUTE d;
END $migration$;

-- Current private journal is the one authoritative allocation. Direct clients
-- cannot alter it, forge its projection, change its counterparty after receipt,
-- or convert allocated merchandise credit into a fictitious cash deposit.
CREATE FUNCTION financial_private.guard_exchange_credit_document() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE e financial_private.order_exchanges;c jsonb;amount numeric;
BEGIN
 SELECT * INTO e FROM financial_private.order_exchanges WHERE store_id=NEW.store_id AND replacement_id=NEW.id;
 IF NOT FOUND OR e.details->'credit'->>'version' IS DISTINCT FROM '1' THEN RETURN NEW;END IF;
 c:=e.details->'credit';amount:=(c->>'allocatedPiastres')::numeric;
 IF TG_OP='UPDATE' AND (NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."customerName" IS DISTINCT FROM OLD."customerName"
  OR NEW."customerPhone" IS DISTINCT FROM OLD."customerPhone" OR NEW."orderNumber" IS DISTINCT FROM OLD."orderNumber" OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
  RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_IDENTITY_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF NEW."courierId" IS DISTINCT FROM c->>'courierId' THEN
  IF e.status<>'pending' OR c->>'status'<>'reserved' OR NOT EXISTS(SELECT 1 FROM public.couriers WHERE id=NEW."courierId" AND store_id=NEW.store_id AND deleted_at IS NULL) THEN
   RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_COURIER_IMMUTABLE' USING ERRCODE='23514';END IF;
  c:=c||jsonb_build_object('courierId',NEW."courierId");
 END IF;
 IF e.status='cancelled' AND c->>'status'='reserved' THEN
  c:=c||jsonb_build_object('status','released','releasedPiastres',(c->>'eligiblePiastres')::numeric,'allocatedPiastres',0,'excessPiastres',0);
 ELSIF NEW.status='cancelled' AND e.status='confirmed' AND c->>'status'='applied' THEN
  c:=c||jsonb_build_object('status',CASE WHEN amount>0 THEN 'refund_due' ELSE 'refunded' END);
 ELSIF NEW.status='delivered' AND coalesce(NEW."revenueLogged",false) AND c->>'status'='applied' THEN
  c:=c||jsonb_build_object('status','consumed');
 END IF;
 IF c IS DISTINCT FROM e.details->'credit' THEN
  UPDATE financial_private.order_exchanges SET details=jsonb_set(details,'{credit}',c) WHERE id=e.id RETURNING * INTO e;
  NEW."exchangeDetails":=e.details;
 END IF;
 IF NEW."exchangeDetails" IS DISTINCT FROM e.details THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_SOURCE_REVIEW' USING ERRCODE='23514';END IF;
 IF NEW.status IN ('pending','shipped') AND round((NEW."depositAmount"+NEW."expectedCod")*100)+(c->>'allocatedPiastres')::numeric
  <>round((NEW."totalAmount"+NEW."shippingFee"+NEW."wastedTripCompensation")*100) THEN
  RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_AMOUNT_REVIEW' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_exchange_credit_document() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER zz_exchange_credit_document BEFORE INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION financial_private.guard_exchange_credit_document();

-- RTO earns no replacement sale. Keep the already earned original credit as a
-- visible refund due, never release the returned original units for reuse.
CREATE FUNCTION financial_private.finish_exchange_credit_event(p_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE ev public.ledger_events;e financial_private.order_exchanges;o public.orders;
BEGIN
 SELECT * INTO ev FROM public.ledger_events WHERE id=p_id;
 IF NOT FOUND OR ev.kind NOT IN ('rto_confirmed','order_delivered') OR ev.ref_type<>'ecommerce_order' THEN RETURN;END IF;
 SELECT * INTO o FROM public.orders WHERE store_id=ev.store_id AND "orderNumber"=ev.ref_id FOR UPDATE;
 SELECT * INTO e FROM financial_private.order_exchanges WHERE store_id=o.store_id AND replacement_id=o.id FOR UPDATE;
 IF NOT FOUND OR e.status<>'confirmed' OR e.details->'credit'->>'version' IS DISTINCT FROM '1' OR e.details->'credit'->>'status'<>'applied' THEN RETURN;END IF;
 IF NOT coalesce(public.has_role(o.store_id,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_FORBIDDEN' USING ERRCODE='42501';END IF;
 UPDATE financial_private.order_exchanges SET details=jsonb_set(details,'{credit,status}',to_jsonb(CASE WHEN ev.kind='order_delivered' THEN 'consumed' WHEN (e.details->'credit'->>'allocatedPiastres')::numeric=0 THEN 'refunded' ELSE 'refund_due' END)) WHERE id=e.id RETURNING * INTO e;
 UPDATE public.orders SET "exchangeDetails"=e.details,updated_at=greatest(updated_at+1,(extract(epoch FROM clock_timestamp())*1000)::bigint),"updatedAt"=now() WHERE id=o.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_DOCUMENT_REQUIRED' USING ERRCODE='23514';END IF;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.finish_exchange_credit_event(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION financial_private.finish_exchange_credit_event(text) TO authenticated;
DO $migration$
DECLARE d text;
BEGIN
 d:=pg_get_functiondef('public.ledger_append(jsonb)'::regprocedure);
 IF strpos(d,'  RETURN v_id;')=0 THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_APPEND_SCHEMA_DRIFT';END IF;
 EXECUTE replace(d,'  RETURN v_id;','  PERFORM financial_private.finish_exchange_credit_event(v_id);'||chr(10)||'  RETURN v_id;');
END $migration$;

-- Editing an unreceived exchange recalculates its reserved credit. Once the
-- original is received, changing the allocation requires an explicit refund,
-- not an invisible cash movement inside a product editor.
DO $migration$
DECLARE d text;needle text;
BEGIN
 d:=replace(pg_get_functiondef('public.record_order_edit(text,uuid,uuid,text,jsonb)'::regprocedure),chr(13),'');
 d:=replace(d,' LANGUAGE plpgsql',' LANGUAGE plpgsql SECURITY DEFINER');
 d:=replace(d,'DECLARE o public.orders;', 'DECLARE credit jsonb;ex financial_private.order_exchanges;allocated numeric:=0;capacity numeric;o public.orders;');
 needle:='  -- Snapshot retained units at their original reservation cost.';
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_EDIT_SCHEMA_DRIFT';END IF;
 d:=replace(d,needle,$patch$
  IF NOT public.store_licensed(p_store) THEN RAISE EXCEPTION 'NEXUS_STORE_NOT_LICENSED' USING ERRCODE='42501';END IF;
  IF o."exchangeDetails"->'credit'->>'version'='1' THEN
   SELECT * INTO ex FROM financial_private.order_exchanges WHERE store_id=p_store AND replacement_id=o.id FOR UPDATE;
   credit:=ex.details->'credit';capacity:=round((v_total+o."shippingFee"+o."wastedTripCompensation"-o."depositAmount")*100);
   allocated:=(credit->>'allocatedPiastres')::numeric;
   IF credit->>'status'='reserved' THEN
    allocated:=least((credit->>'eligiblePiastres')::numeric,capacity);
    credit:=credit||jsonb_build_object('allocatedPiastres',allocated,'excessPiastres',(credit->>'eligiblePiastres')::numeric-allocated);
   ELSIF capacity<allocated THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_REFUND_CREDIT_BEFORE_EDIT' USING ERRCODE='23514';END IF;
   UPDATE financial_private.order_exchanges SET details=jsonb_set(details,'{credit}',credit) WHERE id=ex.id RETURNING * INTO ex;
   o."exchangeDetails":=ex.details;
   INSERT INTO financial_private.order_payment_permits VALUES(txid_current(),p_store,o.id,o."depositAmount",(capacity-allocated)/100);
  END IF;
  -- Snapshot retained units at their original reservation cost.$patch$);
 d:=replace(d,'"expectedCod"=v_total+"shippingFee"+"wastedTripCompensation"-"depositAmount",','"exchangeDetails"=o."exchangeDetails","expectedCod"=v_total+"shippingFee"+"wastedTripCompensation"-"depositAmount"-allocated/100,');
 d:=replace(d,'  IF o."discountCodeId" IS NOT NULL THEN', '  DELETE FROM financial_private.order_payment_permits WHERE transaction_id=txid_current() AND store_id=p_store AND order_id=o.id;'||chr(10)||'  IF o."discountCodeId" IS NOT NULL THEN');
 EXECUTE d;
END $migration$;

-- A cancelled/RTO credit is still owed to the customer. It is NOT a cash
-- refund until this explicit retryable wallet command commits. The same
-- command can release part of an applied allocation before editing a cheaper
-- replacement. It never changes the cash deposit or the original unit claims.
CREATE FUNCTION public.record_exchange_credit_refund(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE saved financial_private.exchange_credit_commands;o public.orders;e financial_private.order_exchanges;c jsonb;
 request jsonb:=jsonb_build_object('command',p_command,'input',p_input);amount numeric;allocated numeric;wallet text:=p_input->>'wallet';v_result jsonb;new_cod numeric;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF nullif(p_id,'') IS NULL OR p_device IS NULL OR p_command IS DISTINCT FROM 'exchange_credit_refund' OR jsonb_typeof(p_input->'amount') IS DISTINCT FROM 'number'
  OR wallet IS NULL OR wallet NOT IN ('inStoreSafe','vodafoneCash','instaPay','bankAccount') THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_REFUND_INVALID' USING ERRCODE='23514';END IF;
 amount:=round((p_input->>'amount')::numeric*100);
 IF (p_input->>'amount')::numeric::text IN ('NaN','Infinity','-Infinity') OR amount<=0 OR (p_input->>'amount')::numeric*100<>amount THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_REFUND_INVALID' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('exchange-credit:'||p_id,0));
 SELECT * INTO saved FROM financial_private.exchange_credit_commands WHERE id=p_id;
 IF FOUND THEN
  IF saved.store_id IS DISTINCT FROM p_store OR saved.request IS DISTINCT FROM request OR NOT saved.completed THEN RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514';END IF;
  RETURN saved.result||jsonb_build_object('replayed',true);
 END IF;
 IF NOT public.store_licensed(p_store) THEN RAISE EXCEPTION 'NEXUS_STORE_NOT_LICENSED' USING ERRCODE='42501';END IF;
 SELECT * INTO o FROM public.orders WHERE id=p_input->>'orderId' AND store_id=p_store AND deleted_at IS NULL FOR UPDATE;
 SELECT * INTO e FROM financial_private.order_exchanges WHERE store_id=p_store AND replacement_id=o.id FOR UPDATE;
 IF NOT FOUND OR e.status<>'confirmed' OR e.details->'credit'->>'version' IS DISTINCT FROM '1' OR o."revenueLogged" OR
  o.status NOT IN ('pending','shipped','cancelled','returned') OR e.details->'credit'->>'status' NOT IN ('applied','refund_due') THEN
  RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_REFUND_NOT_OPEN' USING ERRCODE='23514';END IF;
 c:=e.details->'credit';allocated:=(c->>'allocatedPiastres')::numeric;
 IF (p_input->>'expectedAllocatedPiastres')::numeric IS DISTINCT FROM allocated OR amount>allocated THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_REFUND_STALE_OR_EXCESS' USING ERRCODE='23514';END IF;
 c:=c||jsonb_build_object('allocatedPiastres',allocated-amount,'refundedAllocationPiastres',(c->>'refundedAllocationPiastres')::numeric+amount,
  'status',CASE WHEN c->>'status'='refund_due' AND amount=allocated THEN 'refunded' ELSE c->>'status' END,'lastRefundEventId',p_id);
 INSERT INTO financial_private.exchange_credit_commands(id,store_id,request) VALUES(p_id,p_store,request);
 UPDATE financial_private.order_exchanges SET details=jsonb_set(details,'{credit}',c) WHERE id=e.id RETURNING * INTO e;
 new_cod:=o."expectedCod"+CASE WHEN o.status IN ('pending','shipped') THEN amount/100 ELSE 0 END;
 INSERT INTO financial_private.order_payment_permits VALUES(txid_current(),p_store,o.id,o."depositAmount",new_cod);
 UPDATE public.orders SET "exchangeDetails"=e.details,"expectedCod"=new_cod,updated_at=greatest(updated_at+1,(extract(epoch FROM clock_timestamp())*1000)::bigint),"updatedAt"=now()
  WHERE id=o.id AND store_id=p_store RETURNING * INTO o;
 IF NOT FOUND OR o."exchangeDetails" IS DISTINCT FROM e.details OR o."expectedCod" IS DISTINCT FROM new_cod THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_DOCUMENT_REQUIRED' USING ERRCODE='23514';END IF;
 DELETE FROM financial_private.order_payment_permits WHERE transaction_id=txid_current() AND store_id=p_store AND order_id=o.id;
 v_result:=jsonb_build_object('eventId',p_id,'order',to_jsonb(o),'cashRefundPiastres',amount,'replayed',false);
 PERFORM public.ledger_append(jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'kind','client_payment','ref_type','ecommerce_exchange_credit','ref_id',e.id,'created_at',now(),'occurred_at',now(),
  'payload',jsonb_build_object('type','exchange_credit_cash_refund','exchangeId',e.id,'orderId',o.id,'amountPiastres',amount,'wallet',wallet)::text,
  'lines',jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','receivable_client','subject_id','exchange-credit:'||e.id,'amount_delta',amount),
   jsonb_build_object('id',gen_random_uuid()::text,'account','wallet','subject_id',wallet,'amount_delta',-amount)), 'command_request',request,'command_result',v_result));
 UPDATE financial_private.exchange_credit_commands SET result=v_result,completed=true WHERE id=p_id;
 RETURN v_result;
END $fn$;
REVOKE ALL ON FUNCTION public.record_exchange_credit_refund(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_exchange_credit_refund(text,uuid,uuid,text,jsonb) TO authenticated;

DO $migration$
DECLARE d text;
BEGIN
 d:=replace(pg_get_functiondef('public.record_courier_batch(text,uuid,uuid,text,jsonb)'::regprocedure),chr(13),'');
 IF strpos(d,'obligation:=financial_private.courier_obligation(o,courier);')=0 THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_BATCH_SCHEMA_DRIFT';END IF;
 d:=replace(d,$needle$o.status='delivered' OR (o.status='returned' AND o."returnConfirmedAt" IS NOT NULL)$needle$,$replacement$o.status='delivered' OR (o.status='returned' AND o."returnConfirmedAt" IS NOT NULL) OR (o.status='cancelled' AND o."exchangeDetails"->'credit'->>'version'='1' AND o."exchangeDetails"->>'status'='confirmed')$replacement$);
 d:=replace(d,'obligation:=financial_private.courier_obligation(o,courier);',$patch$
  obligation:=financial_private.courier_obligation(o,courier);$patch$);
 EXECUTE d;
END $migration$;

-- Stable cancellation recovery, including the original-credit disposition
-- written by the document guard in this same transaction.
CREATE FUNCTION public.record_order_cancel(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE saved financial_private.exchange_credit_commands;o public.orders;v_result jsonb;request jsonb:=jsonb_build_object('command',p_command,'input',p_input);ev jsonb;lines jsonb;deposit numeric;paid numeric;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN RAISE EXCEPTION 'NEXUS_ORDER_CANCEL_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF nullif(p_id,'') IS NULL OR p_device IS NULL OR p_command IS DISTINCT FROM 'order_cancel' THEN RAISE EXCEPTION 'NEXUS_ORDER_CANCEL_INVALID' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('order-cancel:'||p_id,0));
 SELECT * INTO saved FROM financial_private.exchange_credit_commands WHERE id=p_id;
 IF FOUND THEN
  IF saved.store_id IS DISTINCT FROM p_store OR saved.request IS DISTINCT FROM request OR NOT saved.completed THEN RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514';END IF;
  RETURN saved.result||jsonb_build_object('replayed',true);
 END IF;
 IF NOT public.store_licensed(p_store) THEN RAISE EXCEPTION 'NEXUS_STORE_NOT_LICENSED' USING ERRCODE='42501';END IF;
 SELECT * INTO o FROM public.orders WHERE id=p_input->>'orderId' AND store_id=p_store AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR o."wholesaleClientId" IS NOT NULL THEN RAISE EXCEPTION 'NEXUS_ORDER_NOT_FOUND' USING ERRCODE='23514';END IF;
 IF p_input->>'cause' IS NULL OR p_input->>'cause' NOT IN ('customer','shop','courier') THEN RAISE EXCEPTION 'NEXUS_CAUSE_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',gen_random_uuid()::text,'account','stock','subject_id',x->>'productId','qty_delta',(x->>'quantity')::numeric,'amount_delta',round((x->>'quantity')::numeric*coalesce((x->>'unitCost')::numeric,0)*100))),'[]') INTO lines FROM jsonb_array_elements(o."stockItems") x;
 deposit:=CASE WHEN lower(o."depositWallet") IN ('instoresafe','vodafonecash','instapay','bankaccount') THEN round(least(o."depositAmount",o."totalAmount")*100) ELSE 0 END;
 IF deposit>0 THEN
  SELECT coalesce(sum(l.amount_delta),0) INTO paid FROM public.ledger_events x JOIN public.ledger_lines l ON l.event_id=x.id WHERE x.store_id=p_store AND x.ref_type='ecommerce_order' AND x.ref_id=o."orderNumber" AND x.kind IN ('order_placed','client_payment') AND l.account='wallet';
  IF paid<>round(o."depositAmount"*100) THEN RAISE EXCEPTION 'NEXUS_ORDER_CANCEL_DEPOSIT_HISTORY_REVIEW' USING ERRCODE='23514';END IF;
  lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','revenue','subject_id',CASE WHEN p_input->>'cause'='customer' THEN 'forfeited_deposit' ELSE 'deposit_pending_resolution' END,'amount_delta',deposit));
  IF o."customerId" IS NOT NULL THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','customer_ltv','subject_id',o."customerId",'amount_delta',deposit));END IF;
 END IF;
 ev:=jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'kind','order_cancelled','ref_type','ecommerce_order','ref_id',o."orderNumber",'created_at',now(),'occurred_at',now(),
  'payload',jsonb_build_object('customerName',o."customerName",'return_cause',p_input->>'cause','type','atomic_order_cancellation')::text,'lines',lines,'command_request',request,'command_result',jsonb_build_object('eventId',p_id));
 INSERT INTO financial_private.exchange_credit_commands(id,store_id,request) VALUES(p_id,p_store,request);
 v_result:=public.cancel_order(o.id,p_input->>'cause',ev)||jsonb_build_object('eventId',p_id,'replayed',false);
 UPDATE financial_private.exchange_credit_commands SET result=v_result,completed=true WHERE id=p_id;
 RETURN v_result;
END $fn$;
REVOKE ALL ON FUNCTION public.record_order_cancel(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_order_cancel(text,uuid,uuid,text,jsonb) TO authenticated;

-- A credit awaiting customer refund must remain visible even when its
-- replacement has been cancelled. It is not an ordinary collectible COD.
DO $migration$
DECLARE d text;needle text;
BEGIN
 d:=replace(pg_get_functiondef('public.read_courier_obligations(uuid,text)'::regprocedure),chr(13),'');
 needle:='(status=''delivered'' OR (status=''returned'' AND "returnConfirmedAt" IS NOT NULL))';
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_READER_DRIFT';END IF;
 d:=replace(d,needle,'(status=''delivered'' OR (status=''returned'' AND "returnConfirmedAt" IS NOT NULL) OR (status=''cancelled'' AND "exchangeDetails"->''credit''->>''status'' IN (''refund_due'',''refunded'')))');
 d:=replace(d,'  item:=financial_private.courier_obligation(o,o."courierId");', '  item:=financial_private.courier_obligation(o,o."courierId");'||chr(10)||'');
 EXECUTE d;
END $migration$;

-- Reserve this namespace for canonical customer-credit legs, never an ordinary
-- customer/wholesale balance. Existing customer receivable accounts support
-- negative return credits; no new balance source or historical backfill.
CREATE FUNCTION financial_private.validate_exchange_credit_lines(p_event jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE l jsonb;e financial_private.order_exchanges;o public.orders;amount numeric;valid boolean;
BEGIN
 FOR l IN SELECT x FROM jsonb_array_elements(p_event->'lines') x WHERE x->>'account'='receivable_client' LOOP
  IF l->>'subject_id' NOT LIKE 'exchange-credit:%' THEN
   IF p_event->>'kind'='order_delivered' THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_LEDGER_SOURCE' USING ERRCODE='23514';END IF;
   CONTINUE;
  END IF;
  IF auth.uid() IS NULL OR NOT coalesce(public.has_role((p_event->>'store_id')::uuid,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_FORBIDDEN' USING ERRCODE='42501';END IF;
  SELECT * INTO e FROM financial_private.order_exchanges WHERE id=substr(l->>'subject_id',17) AND store_id=(p_event->>'store_id')::uuid;
  IF NOT FOUND OR e.details->'credit'->>'version' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_LEDGER_SOURCE' USING ERRCODE='23514';END IF;
  SELECT * INTO o FROM public.orders WHERE id=e.replacement_id AND store_id=e.store_id;
  amount:=(l->>'amount_delta')::numeric;valid:=false;
  IF p_event->>'kind'='return_confirmed' AND p_event->>'ref_type'='ecommerce_exchange' THEN
   valid:=e.confirmation_event_id=p_event->>'id' AND e.confirmation_request=p_event->'command_request' AND e.status='confirmed' AND amount=-(e.details->'credit'->>'allocatedPiastres')::numeric;
  ELSIF p_event->>'kind'='order_delivered' AND p_event->>'ref_type'='ecommerce_order' THEN
   valid:=p_event->>'ref_id'=o."orderNumber" AND amount=(e.details->'credit'->>'allocatedPiastres')::numeric AND EXISTS(
    SELECT 1 FROM financial_private.courier_commands c WHERE c.event_id=p_event->>'id' AND c.store_id=e.store_id AND c.request=p_event->'command_request' AND c.xmin::text=pg_current_xact_id()::text);
  ELSIF p_event->>'kind'='client_payment' AND p_event->>'ref_type'='ecommerce_exchange_credit' THEN
   valid:=p_event->>'ref_id'=e.id AND e.details->'credit'->>'lastRefundEventId'=p_event->>'id' AND EXISTS(
    SELECT 1 FROM financial_private.exchange_credit_commands c WHERE c.id=p_event->>'id' AND c.store_id=e.store_id AND c.request=p_event->'command_request' AND c.request->>'command'='exchange_credit_refund'
     AND c.xmin::text=pg_current_xact_id()::text AND amount=round((c.request->'input'->>'amount')::numeric*100));
  END IF;
  IF NOT coalesce(valid,false) OR EXISTS(SELECT 1 FROM public.ledger_events WHERE id=p_event->>'id') THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_LEDGER_SOURCE' USING ERRCODE='23514';END IF;
 END LOOP;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.validate_exchange_credit_lines(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION financial_private.validate_exchange_credit_lines(jsonb) TO authenticated;
DO $migration$
DECLARE d text;needle text:='WHEN ''order_delivered''    THEN ARRAY[''cogs'',''receivable_courier'',''revenue'',''payable_courier'',''customer_ltv'',''expense'']';
BEGIN
 d:=replace(pg_get_functiondef('public.ledger_validate_event(jsonb)'::regprocedure),chr(13),'');
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_ACCOUNT_DRIFT';END IF;
 d:=replace(d,needle,replace(needle,'''cogs''','''receivable_client'',''cogs'''));
 IF strpos(d,'  v_allowed := CASE v_kind')=0 THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_VALIDATOR_DRIFT';END IF;
 d:=replace(d,'  v_allowed := CASE v_kind','  PERFORM financial_private.validate_exchange_credit_lines(p_event);'||chr(10)||'  v_allowed := CASE v_kind');
 EXECUTE d;
END $migration$;

-- At commit, private disposition, public document and the immutable customer
-- credit account must agree. A suppressed document or missing credit leg can
-- never become a committed, unrecoverable financial fact.
CREATE FUNCTION financial_private.require_exchange_credit_reconciled() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE e financial_private.order_exchanges;o public.orders;c jsonb;balance numeric;expected numeric;
BEGIN
 SELECT * INTO e FROM financial_private.order_exchanges WHERE id=NEW.id;
 IF NOT FOUND OR e.details->'credit'->>'version' IS DISTINCT FROM '1' THEN RETURN NULL;END IF;
 c:=e.details->'credit';
 SELECT * INTO o FROM public.orders WHERE store_id=e.store_id AND id=e.replacement_id;
 IF NOT FOUND OR o."exchangeDetails" IS DISTINCT FROM e.details THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_DOCUMENT_REQUIRED' USING ERRCODE='23514';END IF;
 IF (c->>'eligiblePiastres')::numeric<>(c->>'allocatedPiastres')::numeric+(c->>'excessPiastres')::numeric+(c->>'refundedAllocationPiastres')::numeric+coalesce((c->>'releasedPiastres')::numeric,0)
  OR EXISTS(SELECT 1 FROM jsonb_each(c) x WHERE x.key IN ('eligiblePiastres','allocatedPiastres','excessPiastres','refundedAllocationPiastres','releasedPiastres') AND ((x.value#>>'{}')::numeric<0 OR (x.value#>>'{}')::numeric<>round((x.value#>>'{}')::numeric))) THEN
  RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_CONSERVATION_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(amount_delta),0) INTO balance FROM public.ledger_lines WHERE store_id=e.store_id AND account='receivable_client' AND subject_id='exchange-credit:'||e.id;
 expected:=CASE WHEN c->>'status' IN ('applied','refund_due') THEN -(c->>'allocatedPiastres')::numeric ELSE 0 END;
 IF balance<>expected THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_LEDGER_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.require_exchange_credit_reconciled() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER exchange_credit_reconciled AFTER INSERT OR UPDATE ON financial_private.order_exchanges DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION financial_private.require_exchange_credit_reconciled();

-- A proved customer-credit cash refund is the reverse client-payment leg.
-- It is NOT another merchandise return or a deposit refund. All existing raw
-- payments retain the inbound-only rule and original authorization.
CREATE FUNCTION financial_private.is_exchange_credit_cash_refund(p_event jsonb) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
 SELECT auth.uid() IS NOT NULL AND p_event->>'kind'='client_payment' AND p_event->>'ref_type'='ecommerce_exchange_credit'
 AND jsonb_array_length(p_event->'lines')=2 AND EXISTS(
  SELECT 1 FROM financial_private.exchange_credit_commands c JOIN financial_private.order_exchanges e ON e.store_id=c.store_id AND e.id=p_event->>'ref_id'
  WHERE c.id=p_event->>'id' AND c.store_id=(p_event->>'store_id')::uuid AND c.request=p_event->'command_request' AND c.request->>'command'='exchange_credit_refund'
   AND c.xmin::text=pg_current_xact_id()::text AND e.details->'credit'->>'lastRefundEventId'=c.id
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_event->'lines') l WHERE l->>'account'='receivable_client' AND l->>'subject_id'='exchange-credit:'||e.id AND (l->>'amount_delta')::numeric=round((c.request->'input'->>'amount')::numeric*100))
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_event->'lines') l WHERE l->>'account'='wallet' AND l->>'subject_id'=c.request->'input'->>'wallet' AND (l->>'amount_delta')::numeric=-round((c.request->'input'->>'amount')::numeric*100))
 ) AND NOT EXISTS(SELECT 1 FROM public.ledger_events WHERE id=p_event->>'id')
$fn$;
REVOKE ALL ON FUNCTION financial_private.is_exchange_credit_cash_refund(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION financial_private.is_exchange_credit_cash_refund(jsonb) TO authenticated;
DO $migration$
DECLARE d text;needle text:='IF v_wallet_out > 0 THEN';
BEGIN
 d:=replace(pg_get_functiondef('public.ledger_validate_event(jsonb)'::regprocedure),chr(13),'');
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_CREDIT_CASH_VALIDATOR_DRIFT';END IF;
 EXECUTE replace(d,needle,'IF v_wallet_out > 0 AND NOT financial_private.is_exchange_credit_cash_refund(p_event) THEN');
END $migration$;
