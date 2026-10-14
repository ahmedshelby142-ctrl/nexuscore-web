-- Forward-only: customer trip debt is consumed/earned with its financial event.
-- No historical counter inference or backfill. CRM edits retain server counters.
CREATE TABLE financial_private.customer_trip_commands (
 event_id text PRIMARY KEY REFERENCES public.ledger_events(id) DEFERRABLE INITIALLY DEFERRED,
 store_id uuid NOT NULL, order_id text NOT NULL, customer_id text NOT NULL,
 action text NOT NULL CHECK(action IN ('earn','recover')),
 before_count integer NOT NULL CHECK(before_count>=0),
 after_count integer NOT NULL CHECK(after_count>=0),
 CHECK(after_count=before_count+CASE action WHEN 'earn' THEN 1 ELSE -1 END),
 UNIQUE(store_id,order_id,action)
);
CREATE TABLE financial_private.customer_trip_permits (
 store_id uuid NOT NULL, customer_id text NOT NULL, before_count integer NOT NULL,
 after_count integer NOT NULL, PRIMARY KEY(store_id,customer_id)
);
CREATE TABLE financial_private.customer_trip_order_permits (
 store_id uuid NOT NULL, order_id text NOT NULL, PRIMARY KEY(store_id,order_id)
);
ALTER TABLE financial_private.customer_trip_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_private.customer_trip_permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_private.customer_trip_order_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.customer_trip_commands,financial_private.customer_trip_permits,financial_private.customer_trip_order_permits FROM PUBLIC,anon,authenticated;

CREATE FUNCTION financial_private.guard_customer_trip_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.returned_orders_count<>0 THEN
   -- INSERT trigger also runs before ON CONFLICT UPDATE for legitimate CRM
   -- full-row upserts. Lock the existing identity; its UPDATE preserves debt.
   PERFORM 1 FROM public.customers WHERE id=NEW.id AND store_id=NEW.store_id FOR KEY SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_TRIP_COUNTER_SERVER_OWNED' USING ERRCODE='23514'; END IF;
  END IF;
 ELSIF NEW.returned_orders_count IS DISTINCT FROM OLD.returned_orders_count THEN
  DELETE FROM financial_private.customer_trip_permits WHERE store_id=OLD.store_id AND customer_id=OLD.id
   AND before_count=OLD.returned_orders_count AND after_count=NEW.returned_orders_count;
  IF NOT FOUND THEN NEW.returned_orders_count:=OLD.returned_orders_count; END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_customer_trip_count() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER zz_customer_trip_count BEFORE INSERT OR UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION financial_private.guard_customer_trip_count();

CREATE FUNCTION financial_private.guard_customer_trip_flag() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF NEW."shippingPenaltyApplied" IS DISTINCT FROM OLD."shippingPenaltyApplied" THEN
  DELETE FROM financial_private.customer_trip_order_permits WHERE store_id=OLD.store_id AND order_id=OLD.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_TRIP_FLAG_SERVER_OWNED' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_customer_trip_flag() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER zz_customer_trip_flag BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION financial_private.guard_customer_trip_flag();

CREATE FUNCTION financial_private.apply_customer_trip(p_event_id text,p_order_id text,p_store uuid,p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE o public.orders; c public.customers; count_after integer; changed integer; saved jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false)
  OR NOT public.store_licensed(p_store) THEN RAISE EXCEPTION 'NEXUS_TRIP_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO o FROM public.orders WHERE id=p_order_id AND store_id=p_store AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR o."wholesaleClientId" IS NOT NULL OR p_action NOT IN ('earn','recover') THEN RAISE EXCEPTION 'NEXUS_TRIP_SOURCE_REVIEW' USING ERRCODE='23514'; END IF;
 IF p_action='recover' THEN
  IF NOT coalesce(o."shippingPenaltyApplied",false) THEN RETURN NULL; END IF;
  IF o.status NOT IN ('delivered','returned') OR NOT o."revenueLogged"
   OR NOT EXISTS(SELECT 1 FROM financial_private.courier_commands WHERE event_id=p_event_id AND store_id=p_store AND xmin::text=pg_current_xact_id()::text
    AND ((request->>'command'='order_delivery' AND request->'input'->>'orderId'=o.id) OR (request->>'command'='return_delivery' AND request->>'orderId'=o.id)))
   OR EXISTS(SELECT 1 FROM public.ledger_events WHERE id=p_event_id)
   OR NOT EXISTS(SELECT 1 FROM public.orders WHERE id=o.id AND xmin::text=pg_current_xact_id()::text)
   THEN RAISE EXCEPTION 'NEXUS_TRIP_DELIVERY_REVIEW' USING ERRCODE='23514'; END IF;
 ELSE
  IF o.status<>'returned' OR o.return_cause IS DISTINCT FROM 'customer' OR o."returnConfirmedAt" IS NULL
   OR NOT EXISTS(SELECT 1 FROM public.orders WHERE id=o.id AND xmin::text=pg_current_xact_id()::text)
   OR NOT EXISTS(SELECT 1 FROM public.ledger_events WHERE id=p_event_id AND store_id=p_store AND kind IN ('return_confirmed','rto_confirmed') AND ref_type='ecommerce_order' AND ref_id=o."orderNumber" AND xmin::text=pg_current_xact_id()::text)
   THEN RAISE EXCEPTION 'NEXUS_TRIP_RETURN_REVIEW' USING ERRCODE='23514'; END IF;
  IF nullif(o."customerId",'') IS NULL THEN RETURN NULL; END IF;
 END IF;
 SELECT * INTO c FROM public.customers WHERE id=o."customerId" AND store_id=p_store FOR UPDATE;
 IF NOT FOUND OR c.returned_orders_count<0 OR (p_action='recover' AND c.returned_orders_count=0) THEN RAISE EXCEPTION 'NEXUS_TRIP_CUSTOMER_DEBT_REVIEW' USING ERRCODE='23514'; END IF;
 count_after:=c.returned_orders_count+CASE p_action WHEN 'earn' THEN 1 ELSE -1 END;
 INSERT INTO financial_private.customer_trip_commands VALUES(p_event_id,p_store,o.id,c.id,p_action,c.returned_orders_count,count_after);
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>1 THEN RAISE EXCEPTION 'NEXUS_TRIP_JOURNAL_REQUIRED' USING ERRCODE='23514'; END IF;
 INSERT INTO financial_private.customer_trip_permits VALUES(p_store,c.id,c.returned_orders_count,count_after);
 UPDATE public.customers SET returned_orders_count=count_after,updated_at=greatest(updated_at+1,(extract(epoch FROM clock_timestamp())*1000)::bigint)
  WHERE id=c.id AND store_id=p_store RETURNING to_jsonb(customers.*) INTO saved;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>1 OR (saved->>'returned_orders_count')::integer IS DISTINCT FROM count_after
  OR EXISTS(SELECT 1 FROM financial_private.customer_trip_permits WHERE store_id=p_store AND customer_id=c.id)
  THEN RAISE EXCEPTION 'NEXUS_TRIP_CUSTOMER_WRITE_REQUIRED' USING ERRCODE='23514'; END IF;
 IF p_action='recover' THEN
  INSERT INTO financial_private.customer_trip_order_permits VALUES(p_store,o.id);
  UPDATE public.orders SET "shippingPenaltyApplied"=false,updated_at=greatest(updated_at+1,(extract(epoch FROM clock_timestamp())*1000)::bigint) WHERE id=o.id AND store_id=p_store;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 OR EXISTS(SELECT 1 FROM public.orders WHERE id=o.id AND "shippingPenaltyApplied")
   OR EXISTS(SELECT 1 FROM financial_private.customer_trip_order_permits WHERE store_id=p_store AND order_id=o.id)
   THEN RAISE EXCEPTION 'NEXUS_TRIP_ORDER_WRITE_REQUIRED' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN saved;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.apply_customer_trip(text,text,uuid,text) FROM PUBLIC,anon;
-- Needed only by the existing INVOKER return transaction. Internal proof above
-- rejects any standalone invocation, forged event, or previously committed row.
GRANT EXECUTE ON FUNCTION financial_private.apply_customer_trip(text,text,uuid,text) TO authenticated;

CREATE FUNCTION financial_private.guard_customer_trip_journal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'NEXUS_TRIP_JOURNAL_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_customer_trip_journal() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER customer_trip_journal_immutable BEFORE UPDATE OR DELETE ON financial_private.customer_trip_commands FOR EACH ROW EXECUTE FUNCTION financial_private.guard_customer_trip_journal();

CREATE FUNCTION financial_private.require_customer_trip_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.ledger_events e JOIN public.orders o ON o.id=NEW.order_id AND o.store_id=NEW.store_id
  WHERE e.id=NEW.event_id AND e.store_id=NEW.store_id AND e.ref_type='ecommerce_order' AND e.ref_id=o."orderNumber"
   AND o."customerId"=NEW.customer_id AND ((NEW.action='recover' AND e.kind='order_delivered' AND NOT o."shippingPenaltyApplied")
    OR (NEW.action='earn' AND e.kind IN ('return_confirmed','rto_confirmed') AND o.return_cause='customer' AND o."returnConfirmedAt" IS NOT NULL)))
  THEN RAISE EXCEPTION 'NEXUS_TRIP_EVENT_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.require_customer_trip_event() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER customer_trip_event_required AFTER INSERT ON financial_private.customer_trip_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION financial_private.require_customer_trip_event();

DO $migration$
DECLARE definition text; marker text;
BEGIN
 definition:=replace(pg_get_functiondef('public.record_order_delivery(text,uuid,uuid,text,jsonb)'::regprocedure),chr(13),'');
 marker:=' INSERT INTO financial_private.courier_commands VALUES(p_id,p_store,request);';
 IF strpos(definition,marker)=0 OR strpos(definition,' result:=jsonb_build_object(')=0 THEN RAISE EXCEPTION 'NEXUS_TRIP_DELIVERY_SCHEMA_DRIFT'; END IF;
 definition:=replace(definition,marker,'');
 definition:=replace(definition,' result:=jsonb_build_object(',marker||chr(10)||' part:=financial_private.apply_customer_trip(p_id,o.id,p_store,''recover'');'||chr(10)||' result:=jsonb_build_object(');
 definition:=replace(definition,'''replayed'',false);','''replayed'',false,''customer'',part);');
 EXECUTE definition;
 definition:=replace(pg_get_functiondef('financial_private.prepare_return_delivery(jsonb,text)'::regprocedure),chr(13),'');
 marker:=' RETURN p_event||jsonb_build_object(';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'NEXUS_TRIP_IMPLICIT_SCHEMA_DRIFT'; END IF;
 definition:=replace(definition,marker,' PERFORM financial_private.apply_customer_trip(p_event->>''id'',o.id,o.store_id,''recover'');'||chr(10)||marker);
 EXECUTE definition;
 definition:=replace(pg_get_functiondef('public.confirm_order_return(text,text,text,jsonb,text)'::regprocedure),chr(13),'');
 marker:='  -- The document first.';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'NEXUS_TRIP_RETURN_SCHEMA_DRIFT'; END IF;
 definition:=replace(definition,marker,'  IF nullif(p_customer_id,'''') IS NOT NULL AND p_customer_id IS DISTINCT FROM v_order."customerId" THEN RAISE EXCEPTION ''NEXUS_TRIP_CUSTOMER_IDENTITY_REVIEW'' USING ERRCODE=''23514''; END IF;'||chr(10)||marker);
 marker:='  IF p_cause = ''customer'' AND p_movement = ''return'' AND NULLIF(p_customer_id, '''') IS NOT NULL THEN'||chr(10)||
 '    UPDATE public.customers'||chr(10)||
 '       SET returned_orders_count = COALESCE(returned_orders_count, 0) + 1, updated_at = v_now'||chr(10)||
 '     WHERE id = p_customer_id AND store_id = v_order.store_id'||chr(10)||
 '    RETURNING to_jsonb(customers.*) INTO v_cust;'||chr(10)||'  END IF;';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'NEXUS_TRIP_COUNTER_SCHEMA_DRIFT'; END IF;
 definition:=replace(definition,marker,'  IF p_cause=''customer'' AND p_movement=''return'' THEN v_cust:=financial_private.apply_customer_trip(p_events->(v_n-1)->>''id'',v_order.id,v_order.store_id,''earn''); END IF;');
 EXECUTE definition;
END $migration$;
