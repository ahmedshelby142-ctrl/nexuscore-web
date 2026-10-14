-- LOCAL ONLY. Requires authoritative_stock_commands and courier_atomic_batch.
-- No historical settlement stamps/amounts are reconstructed or changed.
CREATE TABLE financial_private.courier_commands (
 event_id text PRIMARY KEY REFERENCES public.ledger_events(id) DEFERRABLE INITIALLY DEFERRED,
 store_id uuid NOT NULL, request jsonb NOT NULL
);
CREATE TABLE financial_private.courier_stamp_permits (
 transaction_id bigint NOT NULL, store_id uuid NOT NULL, order_id text NOT NULL,
 stamp timestamptz NOT NULL, PRIMARY KEY(transaction_id,store_id,order_id)
);
ALTER TABLE financial_private.courier_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_private.courier_stamp_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.courier_commands,financial_private.courier_stamp_permits FROM PUBLIC,anon,authenticated;
CREATE FUNCTION financial_private.guard_courier_writer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF NEW.kind IN ('courier_settlement','order_delivered') AND NOT EXISTS(SELECT 1 FROM financial_private.courier_commands c
   WHERE c.event_id=NEW.id AND c.store_id=NEW.store_id AND c.request=NEW.command_request) THEN
  RAISE EXCEPTION 'NEXUS_COURIER_ATOMIC_REQUIRED: refresh the application' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $fn$;
CREATE FUNCTION financial_private.guard_courier_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE permitted integer;
BEGIN
 IF NEW."codSettledAt" IS DISTINCT FROM OLD."codSettledAt" THEN
  DELETE FROM financial_private.courier_stamp_permits p WHERE p.transaction_id=txid_current()
   AND p.store_id=OLD.store_id AND p.order_id=OLD.id AND NEW.store_id=OLD.store_id AND p.stamp=NEW."codSettledAt";
  GET DIAGNOSTICS permitted=ROW_COUNT;
  IF permitted<>1 THEN RAISE EXCEPTION 'NEXUS_COURIER_ATOMIC_REQUIRED' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_courier_writer(),financial_private.guard_courier_stamp() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER nexus_courier_writer BEFORE INSERT ON public.ledger_events FOR EACH ROW EXECUTE FUNCTION financial_private.guard_courier_writer();
CREATE TRIGGER nexus_courier_stamp BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION financial_private.guard_courier_stamp();

DO $migration$
DECLARE definition text;
BEGIN
 definition:=replace(pg_get_functiondef('public.record_courier_batch(text,uuid,uuid,text,jsonb)'::regprocedure),chr(13),'');
 IF strpos(definition,' PERFORM public.ledger_append(')=0 OR strpos(definition,' UPDATE public.orders SET "codSettledAt"=now()')=0 THEN
  RAISE EXCEPTION 'NEXUS_COURIER_SCHEMA_DRIFT'; END IF;
 definition:=replace(definition,' PERFORM public.ledger_append(',
  ' INSERT INTO financial_private.courier_commands VALUES(p_id,p_store,request);'||chr(10)||' PERFORM public.ledger_append(');
 definition:=replace(definition,' UPDATE public.orders SET "codSettledAt"=now()',
  ' INSERT INTO financial_private.courier_stamp_permits SELECT txid_current(),p_store,x,now() FROM jsonb_array_elements_text(p_input->''orderIds'') x;'||chr(10)||
  ' UPDATE public.orders SET "codSettledAt"=now()');
 -- A courier-caused delivery surcharge is a booked courier receivable, not
 -- an invented merchant loss and not an amount the customer owes twice.
 definition:=replace(definition,'  IF o."exchangeDetails"->>''status''=''confirmed'' THEN',
  '  IF o."exchangeDetails"->>''cause''=''courier'' THEN r:=r+greatest(0,f-round(o."shippingFee"*100)); END IF;'||chr(10)||
  '  IF o."exchangeDetails"->>''status''=''confirmed'' THEN');
 EXECUTE definition;
END $migration$;

-- One canonical delivery projection for explicit delivery and the historical
-- implicit-delivery-before-return workflow. Private, owner execution only.
CREATE FUNCTION financial_private.delivery_lines(o public.orders) RETURNS jsonb
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $fn$
DECLARE lines jsonb:='[]';part jsonb;goods numeric;cod numeric;compensation numeric;
 fee numeric;margin numeric;value numeric;
BEGIN
 goods:=round(o."totalAmount"*100);cod:=round(o."expectedCod"*100);
 compensation:=round(coalesce(o."wastedTripCompensation",0)*100);
 fee:=round((CASE WHEN o."courierFee">0 THEN o."courierFee" ELSE o."shippingFee" END)*100);
 margin:=round(o."shippingFee"*100)-fee;
 IF goods<0 OR cod<0 OR fee<0 OR compensation<0 OR round(o."depositAmount"*100)+cod<>goods+round(o."shippingFee"*100)+compensation
  OR (cod+fee>0 AND nullif(o."courierId",'') IS NULL) THEN RAISE EXCEPTION 'NEXUS_DELIVERY_AMOUNT_REVIEW' USING ERRCODE='23514'; END IF;
 FOR part IN SELECT x FROM jsonb_array_elements(o."stockItems") x LOOP
  value:=floor((part->>'quantity')::numeric*(part->>'unitCost')::numeric*100+0.5);
  IF value IS NULL OR value<0 THEN RAISE EXCEPTION 'NEXUS_DELIVERY_COST_REVIEW' USING ERRCODE='23514'; END IF;
  IF value>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','cogs','subject_id',part->>'productId','amount_delta',value)); END IF;
 END LOOP;
 lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','revenue','subject_id','ecommerce','amount_delta',goods));
 IF cod>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','receivable_courier','subject_id',o."courierId",'amount_delta',cod)); END IF;
 IF compensation>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','revenue','subject_id','wasted_trip_compensation','amount_delta',compensation)); END IF;
 IF margin>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','revenue','subject_id','shipping_delivery_margin','amount_delta',margin));
 ELSIF margin<0 THEN
  lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account',CASE WHEN o."exchangeDetails"->>'cause'='courier' THEN 'receivable_courier' ELSE 'expense' END,
   'subject_id',CASE WHEN o."exchangeDetails"->>'cause'='courier' THEN o."courierId" ELSE 'shipping' END,'amount_delta',-margin));
 END IF;
 IF fee>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','payable_courier','subject_id',o."courierId",'amount_delta',fee)); END IF;
 IF nullif(o."customerId",'') IS NOT NULL THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','customer_ltv','subject_id',o."customerId",'amount_delta',goods+compensation+greatest(0,margin))); END IF;
 RETURN lines;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.delivery_lines(public.orders) FROM PUBLIC,anon,authenticated;

-- One retryable transaction derives delivery from the saved reservation,
-- persists status/revenue/COGS, and optionally settles the courier. Explicit
-- tenant/role checks match write_orders (ACCOUNTANT cannot deliver); no RLS
-- policy is broadened. Definer is bounded to these fields and server amounts.
CREATE FUNCTION public.record_order_delivery(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE request jsonb:=jsonb_build_object('command',p_command,'input',p_input);
 saved public.ledger_events; o public.orders; lines jsonb:='[]'; result jsonb; part jsonb;
 fee numeric; goods numeric; cod numeric; compensation numeric; margin numeric; value numeric; changed integer;
 settle boolean:=coalesce((p_input->>'settle')::boolean,false); batch jsonb; amounts jsonb;
 now_text text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_DELIVERY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF p_command IS DISTINCT FROM 'order_delivery' OR nullif(p_id,'') IS NULL OR p_device IS NULL OR nullif(p_input->>'orderId','') IS NULL THEN
  RAISE EXCEPTION 'NEXUS_DELIVERY_INVALID' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('order-delivery:'||p_id,0));
 SELECT * INTO saved FROM public.ledger_events WHERE id=p_id AND store_id=p_store;
 IF FOUND THEN
  IF saved.command_request IS DISTINCT FROM request OR saved.command_result IS NULL THEN RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN saved.command_result||jsonb_build_object('replayed',true);
 END IF;
 IF NOT public.store_licensed(p_store) THEN RAISE EXCEPTION 'NEXUS_STORE_NOT_LICENSED' USING ERRCODE='42501'; END IF;
 SELECT * INTO o FROM public.orders WHERE id=p_input->>'orderId' AND store_id=p_store AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR o.status<>'shipped' OR o."revenueLogged" OR o."wholesaleClientId" IS NOT NULL
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(o."stockItems") x WHERE nullif(x->>'wholesaleInvoiceId','') IS NOT NULL) THEN
  RAISE EXCEPTION 'NEXUS_DELIVERY_NOT_OPEN' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.ledger_events WHERE store_id=p_store AND kind='order_delivered' AND ref_type='ecommerce_order' AND ref_id=o."orderNumber") THEN
  RAISE EXCEPTION 'NEXUS_DELIVERY_HISTORY_REVIEW' USING ERRCODE='23514'; END IF;
 lines:=financial_private.delivery_lines(o);
 cod:=round(o."expectedCod"*100);
 UPDATE public.orders SET status='delivered',"revenueLogged"=true,"updatedAt"=now(),updated_at=greatest(coalesce(updated_at,0)+1,(extract(epoch FROM clock_timestamp())*1000)::bigint)
  WHERE id=o.id AND store_id=p_store;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>1 THEN RAISE EXCEPTION 'NEXUS_DELIVERY_NOT_WRITTEN' USING ERRCODE='42501'; END IF;
 result:=jsonb_build_object('eventId',p_id,'orderIds',jsonb_build_array(o.id),'settlementEventId',CASE WHEN settle AND cod>0 THEN p_id||':settlement' END,'replayed',false);
 INSERT INTO financial_private.courier_commands VALUES(p_id,p_store,request);
 PERFORM public.ledger_append(jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'kind','order_delivered','ref_type','ecommerce_order','ref_id',o."orderNumber",
  'actor','أونلاين','occurred_at',now_text,'created_at',now_text,'payload',jsonb_build_object('customerName',o."customerName",'channel','ecommerce')::text,
  'lines',lines,'command_request',request,'command_result',result));
 IF settle AND cod>0 THEN
  IF p_input->>'wallet' IS NULL OR jsonb_typeof(p_input->'netReceived') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'NEXUS_COURIER_BATCH_INVALID' USING ERRCODE='23514'; END IF;
  batch:=public.record_courier_batch(p_id||':settlement',p_store,p_device,'courier_batch',jsonb_build_object('courierId',o."courierId",'courierName',o."courierName",'orderIds',jsonb_build_array(o.id),'wallet',p_input->>'wallet','netReceived',p_input->'netReceived'));
 END IF;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.record_order_delivery(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_order_delivery(text,uuid,uuid,text,jsonb) TO authenticated;

-- confirm_order_return already owns the order stamp, events and customer trip
-- in one INVOKER transaction. Authorize only its exact newly stamped return's
-- canonical delivery; never allow the legacy raw append endpoint to register
-- a delivery or settlement receipt on its own.
CREATE FUNCTION financial_private.prepare_return_delivery(p_event jsonb,p_order_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE o public.orders;expected jsonb;actual jsonb;request jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role((p_event->>'store_id')::uuid,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_DELIVERY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO o FROM public.orders WHERE id=p_order_id AND store_id=(p_event->>'store_id')::uuid AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR o.status<>'returned' OR o."returnConfirmedAt" IS NULL OR o."revenueLogged" OR o."wholesaleClientId" IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM public.orders WHERE id=o.id AND store_id=o.store_id AND xmin::text=pg_current_xact_id()::text)
  OR p_event->>'kind' IS DISTINCT FROM 'order_delivered' OR p_event->>'ref_type' IS DISTINCT FROM 'ecommerce_order'
  OR p_event->>'ref_id' IS DISTINCT FROM o."orderNumber" OR nullif(p_event->>'id','') IS NULL THEN
  RAISE EXCEPTION 'NEXUS_RETURN_DELIVERY_REVIEW' USING ERRCODE='23514'; END IF;
 IF NOT public.store_licensed(o.store_id) THEN RAISE EXCEPTION 'NEXUS_STORE_NOT_LICENSED' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM public.ledger_events WHERE store_id=o.store_id AND kind='order_delivered' AND ref_type='ecommerce_order' AND ref_id=o."orderNumber") THEN
  RAISE EXCEPTION 'NEXUS_DELIVERY_HISTORY_REVIEW' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY account,subject_id),'[]') INTO expected FROM (
  SELECT l->>'account' account,l->>'subject_id' subject_id,sum(coalesce((l->>'qty_delta')::numeric,0)) qty,sum((l->>'amount_delta')::numeric) amount
  FROM jsonb_array_elements(financial_private.delivery_lines(o)) l GROUP BY 1,2
  HAVING sum(coalesce((l->>'qty_delta')::numeric,0))<>0 OR sum((l->>'amount_delta')::numeric)<>0) g;
 SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY account,subject_id),'[]') INTO actual FROM (
  SELECT l->>'account' account,l->>'subject_id' subject_id,sum(coalesce((l->>'qty_delta')::numeric,0)) qty,sum((l->>'amount_delta')::numeric) amount
  FROM jsonb_array_elements(p_event->'lines') l GROUP BY 1,2
  HAVING sum(coalesce((l->>'qty_delta')::numeric,0))<>0 OR sum((l->>'amount_delta')::numeric)<>0) g;
 IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'NEXUS_RETURN_DELIVERY_AMOUNT_REVIEW' USING ERRCODE='23514'; END IF;
 request:=jsonb_build_object('command','return_delivery','orderId',o.id,'eventId',p_event->>'id');
 INSERT INTO financial_private.courier_commands VALUES(p_event->>'id',o.store_id,request);
 UPDATE public.orders SET "revenueLogged"=true,updated_at=greatest(coalesce(updated_at,0)+1,(extract(epoch FROM clock_timestamp())*1000)::bigint) WHERE id=o.id AND store_id=o.store_id;
 RETURN p_event||jsonb_build_object('command_request',request,'command_result',jsonb_build_object('eventId',p_event->>'id','orderIds',jsonb_build_array(o.id)));
END $fn$;
REVOKE ALL ON FUNCTION financial_private.prepare_return_delivery(jsonb,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION financial_private.prepare_return_delivery(jsonb,text) TO authenticated;
DO $migration$
DECLARE definition text;
BEGIN
 definition:=replace(pg_get_functiondef('public.confirm_order_return(text,text,text,jsonb,text)'::regprocedure),chr(13),'');
 IF strpos(definition,'    PERFORM public.ledger_append(p_events -> v_i);')=0 THEN RAISE EXCEPTION 'NEXUS_RETURN_SCHEMA_DRIFT'; END IF;
 definition:=replace(definition,'    PERFORM public.ledger_append(p_events -> v_i);',
  '    v_ev:=p_events->v_i;'||chr(10)||
  '    IF v_ev->>''kind''=''order_delivered'' THEN v_ev:=financial_private.prepare_return_delivery(v_ev,p_order_id); END IF;'||chr(10)||
  '    PERFORM public.ledger_append(v_ev);');
 definition:=replace(definition,'  RETURN jsonb_build_object(''order'', v_row, ''customer'', v_cust);',
  '  SELECT to_jsonb(o.*) INTO v_row FROM public.orders o WHERE id=p_order_id AND store_id=v_order.store_id;'||chr(10)||
  '  RETURN jsonb_build_object(''order'', v_row, ''customer'', v_cust);');
 EXECUTE definition;
END $migration$;
