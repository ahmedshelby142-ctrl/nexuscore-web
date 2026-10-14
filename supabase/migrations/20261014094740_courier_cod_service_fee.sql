-- LOCAL correction candidate only. Requires the fourteen master-repair migrations.
-- Additive: no historical order, ledger, settlement or wallet row is rewritten.
ALTER TABLE public.orders ADD COLUMN "codServiceFee" numeric NOT NULL DEFAULT 0
 CHECK ("codServiceFee">=0 AND "codServiceFee"=round("codServiceFee",2) AND "codServiceFee"<10000000);

-- Mobile reads this cost-protected view, never the raw order table.
-- Append one column while retaining every existing column, predicate and ACL.
DO $migration$
DECLARE d text;options text;needle text:='   FROM orders o';
BEGIN
 d:=pg_get_viewdef('public.orders_operational'::regclass,true);
 SELECT array_to_string(reloptions,',') INTO options FROM pg_class WHERE oid='public.orders_operational'::regclass;
 IF strpos(d,needle)=0 OR strpos(d,'can_read_store_finance(store_id)')=0 THEN RAISE EXCEPTION 'NEXUS_COD_FEE_VIEW_DRIFT';END IF;
 EXECUTE 'CREATE OR REPLACE VIEW public.orders_operational'||CASE WHEN options IS NULL THEN '' ELSE ' WITH ('||options||')' END||' AS '||replace(d,needle,
  ', CASE WHEN public.can_read_store_finance(store_id) THEN "codServiceFee" ELSE NULL::numeric END AS "codServiceFee"'||chr(10)||needle);
END $migration$;

CREATE TABLE financial_private.cod_fee_commands (
 event_id text PRIMARY KEY REFERENCES public.ledger_events(id) DEFERRABLE INITIALLY DEFERRED,
 store_id uuid NOT NULL, order_id text NOT NULL, request jsonb NOT NULL, result jsonb NOT NULL,
 actor_id uuid NOT NULL DEFAULT auth.uid(),created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE financial_private.cod_fee_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.cod_fee_commands FROM PUBLIC,anon,authenticated;
CREATE TABLE financial_private.cod_fee_permits (
 transaction_id bigint NOT NULL,store_id uuid NOT NULL,order_id text NOT NULL,
 amount numeric NOT NULL, PRIMARY KEY(transaction_id,store_id,order_id)
);
ALTER TABLE financial_private.cod_fee_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.cod_fee_permits FROM PUBLIC,anon,authenticated;

CREATE FUNCTION financial_private.guard_cod_service_fee() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF TG_OP='UPDATE' AND NEW."codServiceFee" IS DISTINCT FROM OLD."codServiceFee" THEN
  IF NOT EXISTS(SELECT 1 FROM financial_private.cod_fee_permits WHERE transaction_id=txid_current()
   AND store_id=OLD.store_id AND order_id=OLD.id AND amount=NEW."codServiceFee") THEN
   RAISE EXCEPTION 'NEXUS_COD_FEE_COMMAND_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_cod_service_fee() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER nexus_cod_service_fee BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION financial_private.guard_cod_service_fee();

-- Preserve the entire deployed delivery/credit calculation and extend only
-- the additional merchant service expense. Customer COD is never changed.
DO $migration$
DECLARE d text;
BEGIN
 d:=pg_get_functiondef('financial_private.delivery_lines(public.orders)'::regprocedure);
 EXECUTE replace(d,'FUNCTION financial_private.delivery_lines(','FUNCTION financial_private.delivery_lines_before_cod_service(');
END $migration$;
REVOKE ALL ON FUNCTION financial_private.delivery_lines_before_cod_service(public.orders) FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION financial_private.delivery_lines(o public.orders) RETURNS jsonb
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $fn$
DECLARE lines jsonb;fee numeric:=CASE WHEN o."expectedCod">0 THEN round(o."codServiceFee"*100) ELSE 0 END;
BEGIN
 lines:=financial_private.delivery_lines_before_cod_service(o);
 IF fee>0 THEN
  IF nullif(o."courierId",'') IS NULL THEN RAISE EXCEPTION 'NEXUS_COD_FEE_COURIER_REQUIRED' USING ERRCODE='23514';END IF;
  lines:=lines||jsonb_build_array(
   jsonb_build_object('id',gen_random_uuid()::text,'account','payable_courier','subject_id',o."courierId",'amount_delta',fee),
   jsonb_build_object('id',gen_random_uuid()::text,'account','expense','subject_id','courier_cod_service','amount_delta',fee));
 END IF;
 RETURN lines;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.delivery_lines(public.orders) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION financial_private.validate_cod_fee_event(p_event jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE c financial_private.cod_fee_commands;o public.orders;delta numeric;l jsonb;
BEGIN
 SELECT * INTO c FROM financial_private.cod_fee_commands WHERE event_id=p_event->>'id' AND store_id=(p_event->>'store_id')::uuid;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM financial_private.cod_fee_commands x WHERE x.event_id=c.event_id AND x.xmin::text=pg_current_xact_id()::text)
  OR auth.uid() IS NULL OR NOT coalesce(public.has_role(c.store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY']),false)
  OR c.request IS DISTINCT FROM p_event->'command_request' OR c.result IS DISTINCT FROM p_event->'command_result'
  OR EXISTS(SELECT 1 FROM public.ledger_events WHERE id=c.event_id) THEN
  RAISE EXCEPTION 'NEXUS_COD_FEE_LEDGER_SOURCE' USING ERRCODE='23514';END IF;
 SELECT * INTO o FROM public.orders WHERE id=c.order_id AND store_id=c.store_id;
 IF p_event->>'ref_type' IS DISTINCT FROM 'ecommerce_order' OR p_event->>'ref_id' IS DISTINCT FROM o."orderNumber"
  OR p_event->>'kind' IS DISTINCT FROM 'courier_fee_adjustment'
  OR jsonb_typeof(p_event->'lines') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'NEXUS_COD_FEE_LEDGER_SOURCE' USING ERRCODE='23514';END IF;
 delta:=(c.result->>'accruedDeltaPiastres')::numeric;
 IF jsonb_array_length(p_event->'lines')<>(CASE WHEN delta=0 THEN 0 ELSE 2 END) THEN RAISE EXCEPTION 'NEXUS_COD_FEE_LEDGER_AMOUNT' USING ERRCODE='23514';END IF;
 FOR l IN SELECT x FROM jsonb_array_elements(p_event->'lines') x LOOP
  IF (l->>'amount_delta')::numeric IS DISTINCT FROM delta OR coalesce((l->>'qty_delta')::numeric,0)<>0
   OR l->>'unit_cost' IS NOT NULL OR
   NOT ((l->>'account'='expense' AND l->>'subject_id'='courier_cod_service') OR (l->>'account'='payable_courier' AND l->>'subject_id'=o."courierId")) THEN
   RAISE EXCEPTION 'NEXUS_COD_FEE_LEDGER_AMOUNT' USING ERRCODE='23514';END IF;
 END LOOP;
 IF delta<>0 AND (SELECT count(DISTINCT x->>'account') FROM jsonb_array_elements(p_event->'lines') x)<>2 THEN
  RAISE EXCEPTION 'NEXUS_COD_FEE_LEDGER_AMOUNT' USING ERRCODE='23514';END IF;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.validate_cod_fee_event(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION financial_private.validate_cod_fee_event(jsonb) TO authenticated;

CREATE FUNCTION public.record_cod_service_fee(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE saved financial_private.cod_fee_commands;o public.orders;request jsonb:=jsonb_build_object('command',p_command,'input',p_input);
 amount numeric;delta numeric:=0;result jsonb;lines jsonb:='[]';eligible boolean;
BEGIN
 PERFORM financial_private.fulfillment_lock(p_store);
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_COD_FEE_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF p_command IS DISTINCT FROM 'cod_service_fee' OR nullif(p_id,'') IS NULL OR p_device IS NULL OR jsonb_typeof(p_input->'amount') IS DISTINCT FROM 'number'
  OR nullif(btrim(p_input->>'reason'),'') IS NULL THEN RAISE EXCEPTION 'NEXUS_COD_FEE_INVALID' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('cod-fee:'||p_id,0));
 SELECT * INTO saved FROM financial_private.cod_fee_commands WHERE event_id=p_id AND store_id=p_store;
 IF FOUND THEN
  IF saved.request IS DISTINCT FROM request THEN RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514';END IF;
  RETURN saved.result||jsonb_build_object('replayed',true);
 END IF;
 IF NOT public.store_licensed(p_store) THEN RAISE EXCEPTION 'NEXUS_STORE_NOT_LICENSED' USING ERRCODE='42501';END IF;
 amount:=(p_input->>'amount')::numeric;
 IF amount<0 OR amount>=10000000 OR amount<>round(amount,2) THEN RAISE EXCEPTION 'NEXUS_COD_FEE_INVALID' USING ERRCODE='23514';END IF;
 SELECT * INTO o FROM public.orders WHERE store_id=p_store AND id=p_input->>'orderId' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR o.status NOT IN ('pending','shipped','delivered','returned') OR o."wholesaleClientId" IS NOT NULL OR o."codSettledAt" IS NOT NULL
  OR nullif(o."courierId",'') IS NULL OR NOT EXISTS(SELECT 1 FROM public.couriers WHERE store_id=p_store AND id=o."courierId" AND deleted_at IS NULL) THEN
  RAISE EXCEPTION 'NEXUS_COD_FEE_NOT_OPEN' USING ERRCODE='23514';END IF;
 IF o."codServiceFee" IS DISTINCT FROM (p_input->>'before')::numeric THEN RAISE EXCEPTION 'NEXUS_COD_FEE_STALE' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.ledger_events e WHERE e.store_id=p_store AND e.kind='courier_settlement' AND
  ((e.ref_type='courier_batch' AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(e.payload::jsonb->'orders','[]')) x WHERE x->>'id'=o.id))
   OR(e.ref_type='ecommerce_order' AND e.ref_id=o."orderNumber"))) THEN RAISE EXCEPTION 'NEXUS_COD_FEE_ALREADY_ALLOCATED' USING ERRCODE='23514';END IF;
 eligible:=o."expectedCod">0 AND EXISTS(SELECT 1 FROM public.ledger_events e JOIN public.ledger_lines l ON l.event_id=e.id AND l.store_id=e.store_id
  WHERE e.store_id=p_store AND e.kind='order_delivered' AND e.ref_type='ecommerce_order' AND e.ref_id=o."orderNumber"
   AND l.account='receivable_courier' AND l.subject_id=o."courierId" AND l.amount_delta>0);
 IF o.status IN ('delivered','returned') AND NOT eligible AND amount>0 THEN RAISE EXCEPTION 'NEXUS_COD_FEE_NO_COLLECTION' USING ERRCODE='23514';END IF;
 IF eligible THEN delta:=round((amount-o."codServiceFee")*100);END IF;
 INSERT INTO financial_private.cod_fee_permits VALUES(txid_current(),p_store,o.id,amount);
 UPDATE public.orders SET "codServiceFee"=amount,"updatedAt"=now(),updated_at=greatest(coalesce(updated_at,0)+1,(extract(epoch FROM clock_timestamp())*1000)::bigint)
  WHERE id=o.id AND store_id=p_store RETURNING * INTO o;
 DELETE FROM financial_private.cod_fee_permits WHERE transaction_id=txid_current() AND store_id=p_store AND order_id=o.id;
 result:=jsonb_build_object('eventId',p_id,'orderIds',jsonb_build_array(o.id),'order',to_jsonb(o),'accruedDeltaPiastres',delta,'replayed',false);
 IF delta<>0 THEN lines:=jsonb_build_array(
  jsonb_build_object('id',gen_random_uuid()::text,'account','payable_courier','subject_id',o."courierId",'amount_delta',delta),
  jsonb_build_object('id',gen_random_uuid()::text,'account','expense','subject_id','courier_cod_service','amount_delta',delta));END IF;
 INSERT INTO financial_private.cod_fee_commands(event_id,store_id,order_id,request,result) VALUES(p_id,p_store,o.id,request,result);
 PERFORM public.ledger_append(jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'kind','courier_fee_adjustment',
  'ref_type','ecommerce_order','ref_id',o."orderNumber",'occurred_at',now(),'created_at',now(),
  'payload',jsonb_build_object('orderId',o.id,'before',p_input->'before','after',amount,'reason',p_input->>'reason','accruedDeltaPiastres',delta)::text,
  'command_request',request,'command_result',result,'lines',lines));
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.record_cod_service_fee(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_cod_service_fee(text,uuid,uuid,text,jsonb) TO authenticated;

CREATE FUNCTION public.read_cod_fee_audit(p_store uuid,p_order_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_COD_FEE_FORBIDDEN' USING ERRCODE='42501';END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',event_id,'actorId',actor_id,'at',created_at,
  'before',request->'input'->'before','after',request->'input'->'amount','reason',request->'input'->>'reason',
  'accruedDeltaPiastres',result->'accruedDeltaPiastres') ORDER BY created_at,event_id)
  FROM financial_private.cod_fee_commands WHERE store_id=p_store AND order_id=p_order_id),'[]');
END $fn$;
REVOKE ALL ON FUNCTION public.read_cod_fee_audit(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.read_cod_fee_audit(uuid,text) TO authenticated;

DO $migration$
DECLARE d text;needle text;
BEGIN
 d:=replace(pg_get_functiondef('public.ledger_validate_event(jsonb)'::regprocedure),chr(13),'');
 needle:='BEGIN'||chr(10);
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_COD_FEE_VALIDATOR_DRIFT';END IF;
 d:=replace(d,needle,needle||'  IF p_event->>''kind''=''courier_fee_adjustment'' THEN PERFORM financial_private.validate_cod_fee_event(p_event);RETURN;END IF;'||chr(10));
 EXECUTE d;
 d:=pg_get_functiondef('financial_private.courier_obligation(public.orders,text)'::regprocedure);
 needle:='''order_delivered'',''return_confirmed'',''rto_confirmed'',''courier_settlement''';
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_COD_FEE_OBLIGATION_DRIFT';END IF;
 EXECUTE replace(d,needle,needle||',''courier_fee_adjustment''');
 d:=pg_get_functiondef('public.record_exchange_place(text,uuid,uuid,text,jsonb)'::regprocedure);
 needle:='''discountAmount'',''courierFee'',''wastedTripCompensation''';
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_COD_FEE_EXCHANGE_DRIFT';END IF;
 d:=replace(d,' FOR money_field IN', ' replacement:=replacement||jsonb_build_object(''codServiceFee'',coalesce(replacement->''codServiceFee'',''0''::jsonb));'||chr(10)||' FOR money_field IN');
 EXECUTE replace(d,needle,'''discountAmount'',''courierFee'',''codServiceFee'',''wastedTripCompensation''');
 d:=pg_get_functiondef('public.record_order_delivery(text,uuid,uuid,text,jsonb)'::regprocedure);
 needle:='''channel'',''ecommerce'')::text';
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_COD_FEE_DELIVERY_DRIFT';END IF;
 EXECUTE replace(d,needle,'''channel'',''ecommerce'',''codServiceFeePiastres'',CASE WHEN o."expectedCod">0 THEN round(o."codServiceFee"*100) ELSE 0 END)::text');
 d:=pg_get_functiondef('financial_private.prepare_return_delivery(jsonb,text)'::regprocedure);
 needle:=' RETURN p_event||jsonb_build_object(';
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_COD_FEE_RETURN_DELIVERY_DRIFT';END IF;
 d:=replace(d,needle,' p_event:=jsonb_set(p_event,''{payload}'',to_jsonb(((p_event->>''payload'')::jsonb||jsonb_build_object(''codServiceFeePiastres'',CASE WHEN o."expectedCod">0 THEN round(o."codServiceFee"*100) ELSE 0 END))::text));'||chr(10)||needle);
 EXECUTE d;
END $migration$;
