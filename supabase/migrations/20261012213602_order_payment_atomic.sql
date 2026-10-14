-- LOCAL ONLY; after the seven master-repair migrations. No historical writes.
-- A customer top-up, persisted deposit and remaining COD are one retryable fact.
CREATE TABLE financial_private.order_payment_commands (
 id text PRIMARY KEY REFERENCES public.ledger_events(id) DEFERRABLE INITIALLY DEFERRED,
 store_id uuid NOT NULL, request jsonb NOT NULL, result jsonb, completed boolean NOT NULL DEFAULT false
);
CREATE TABLE financial_private.order_payment_permits (
 transaction_id bigint,store_id uuid,order_id text,deposit numeric,cod numeric,
 PRIMARY KEY(transaction_id,store_id,order_id)
);
ALTER TABLE financial_private.order_payment_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_private.order_payment_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.order_payment_commands,financial_private.order_payment_permits FROM PUBLIC,anon,authenticated;

CREATE FUNCTION financial_private.guard_order_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE consumed integer;
BEGIN
 IF TG_TABLE_NAME='ledger_events' THEN
  IF NEW.kind='client_payment' AND NEW.ref_type='ecommerce_order' AND NOT EXISTS(
   SELECT 1 FROM financial_private.order_payment_commands c WHERE c.id=NEW.id AND c.store_id=NEW.store_id
    AND c.request=NEW.command_request AND c.xmin::text=pg_current_xact_id()::text) THEN
   RAISE EXCEPTION 'NEXUS_ORDER_PAYMENT_ATOMIC_REQUIRED: refresh the application' USING ERRCODE='23514';END IF;
 ELSE
  IF NEW."depositAmount" IS DISTINCT FROM OLD."depositAmount" OR
   (NEW."expectedCod" IS DISTINCT FROM OLD."expectedCod" AND NEW."totalAmount" IS NOT DISTINCT FROM OLD."totalAmount"
    AND NEW."shippingFee" IS NOT DISTINCT FROM OLD."shippingFee" AND NEW."wastedTripCompensation" IS NOT DISTINCT FROM OLD."wastedTripCompensation") THEN
   DELETE FROM financial_private.order_payment_permits p WHERE p.transaction_id=txid_current() AND p.store_id=OLD.store_id
    AND p.order_id=OLD.id AND NEW.store_id=OLD.store_id AND p.deposit=NEW."depositAmount" AND p.cod=NEW."expectedCod";
   GET DIAGNOSTICS consumed=ROW_COUNT;
   IF consumed<>1 THEN RAISE EXCEPTION 'NEXUS_ORDER_PAYMENT_ATOMIC_REQUIRED' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_order_payment() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER nexus_order_payment_event BEFORE INSERT ON public.ledger_events FOR EACH ROW EXECUTE FUNCTION financial_private.guard_order_payment();
CREATE TRIGGER nexus_order_payment_document BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION financial_private.guard_order_payment();

CREATE FUNCTION public.record_order_payment(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE saved financial_private.order_payment_commands;o public.orders;
 request jsonb:=jsonb_build_object('command',p_command,'input',p_input);v_result jsonb;amount numeric;paid numeric;
 wallet text:=p_input->>'wallet';stamp bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_ORDER_PAYMENT_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF nullif(p_id,'') IS NULL OR p_device IS NULL OR p_command IS DISTINCT FROM 'order_payment'
  OR jsonb_typeof(p_input->'amount') IS DISTINCT FROM 'number' OR nullif(p_input->>'orderId','') IS NULL
  OR wallet IS NULL OR wallet NOT IN ('inStoreSafe','vodafoneCash','instaPay','bankAccount') THEN
  RAISE EXCEPTION 'NEXUS_ORDER_PAYMENT_INVALID' USING ERRCODE='23514';END IF;
 amount:=(p_input->>'amount')::numeric;
 IF amount::text IN ('NaN','Infinity','-Infinity') OR amount<=0 OR amount<>round(amount,2) THEN
  RAISE EXCEPTION 'NEXUS_ORDER_PAYMENT_INVALID' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('order-payment:'||p_id,0));
 SELECT * INTO saved FROM financial_private.order_payment_commands WHERE id=p_id;
 IF FOUND THEN
  IF saved.store_id IS DISTINCT FROM p_store OR saved.request IS DISTINCT FROM request OR NOT saved.completed THEN
   RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514';END IF;
  RETURN saved.result||jsonb_build_object('replayed',true);
 END IF;
 IF NOT public.store_licensed(p_store) THEN RAISE EXCEPTION 'NEXUS_STORE_NOT_LICENSED' USING ERRCODE='42501';END IF;
 SELECT * INTO o FROM public.orders WHERE id=p_input->>'orderId' AND store_id=p_store AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR o.status NOT IN ('pending','shipped') OR o."revenueLogged" OR o."wholesaleClientId" IS NOT NULL THEN
  RAISE EXCEPTION 'NEXUS_ORDER_PAYMENT_NOT_OPEN' USING ERRCODE='23514';END IF;
 IF (p_input->>'expectedDeposit')::numeric IS DISTINCT FROM o."depositAmount" OR
  (p_input->>'expectedCod')::numeric IS DISTINCT FROM o."expectedCod" THEN
  RAISE EXCEPTION 'NEXUS_ORDER_PAYMENT_STALE' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(l.amount_delta),0) INTO paid FROM public.ledger_events e JOIN public.ledger_lines l ON l.event_id=e.id
  WHERE e.store_id=p_store AND e.ref_type='ecommerce_order' AND e.ref_id=o."orderNumber"
   AND e.kind IN ('order_placed','client_payment') AND l.account='wallet';
 IF paid<>round(o."depositAmount"*100) THEN RAISE EXCEPTION 'NEXUS_ORDER_PAYMENT_HISTORY_REVIEW' USING ERRCODE='23514';END IF;
 IF amount>o."expectedCod" THEN RAISE EXCEPTION 'NEXUS_ORDER_PAYMENT_EXCESS' USING ERRCODE='23514';END IF;
 stamp:=greatest(o.updated_at+1,(extract(epoch FROM clock_timestamp())*1000)::bigint);
 INSERT INTO financial_private.order_payment_commands(id,store_id,request) VALUES(p_id,p_store,request);
 PERFORM public.ledger_append(jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'kind','client_payment','ref_type','ecommerce_order','ref_id',o."orderNumber",
  'actor','أونلاين','created_at',now(),'occurred_at',now(),'payload',jsonb_build_object('type','order_additional_payment','orderId',o.id,'customerName',o."customerName",'wallet',wallet,'amount',amount)::text,
  'lines',jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','wallet','subject_id',wallet,'amount_delta',round(amount*100))),
  'command_request',request,'command_result',jsonb_build_object('eventId',p_id)));
 INSERT INTO financial_private.order_payment_permits VALUES(txid_current(),p_store,o.id,o."depositAmount"+amount,o."expectedCod"-amount);
 UPDATE public.orders SET "depositAmount"="depositAmount"+amount,"expectedCod"="expectedCod"-amount,
  "depositWallet"=coalesce("depositWallet",wallet),"updatedAt"=now(),updated_at=stamp,sync_status='synced'
  WHERE id=o.id AND store_id=p_store RETURNING * INTO o;
 IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_ORDER_PAYMENT_DOCUMENT_REQUIRED' USING ERRCODE='23514';END IF;
 IF o."depositAmount" IS DISTINCT FROM (p_input->>'expectedDeposit')::numeric+amount OR
  o."expectedCod" IS DISTINCT FROM (p_input->>'expectedCod')::numeric-amount THEN
  RAISE EXCEPTION 'NEXUS_ORDER_PAYMENT_DOCUMENT_REQUIRED' USING ERRCODE='23514';END IF;
 DELETE FROM financial_private.order_payment_permits WHERE transaction_id=txid_current() AND store_id=p_store AND order_id=o.id;
 v_result:=jsonb_build_object('eventId',p_id,'order',to_jsonb(o),'amountPiastres',round(amount*100),'replayed',false);
 UPDATE financial_private.order_payment_commands SET result=v_result,completed=true WHERE id=p_id;
 RETURN v_result;
END $fn$;
REVOKE ALL ON FUNCTION public.record_order_payment(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_order_payment(text,uuid,uuid,text,jsonb) TO authenticated;
