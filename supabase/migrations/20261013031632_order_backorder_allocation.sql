-- LOCAL ONLY, forward opted-in manual orders. Never backfill legacy shortages.
-- Partial reservation consumes only actual ATP. Demand and allocation are
-- workflow evidence; every physical quantity/value remains in immutable stock
-- ledger lines. No sale, customer charge or delivery is invented on allocation.
ALTER TABLE public.orders ADD COLUMN fulfillment jsonb;
-- Preserve the existing Moderator cost boundary for the new integer snapshot
-- as well as unitCost. Finance-capable readers keep their original access.
DO $migration$
DECLARE d text;
BEGIN
 d:=pg_get_functiondef('public.strip_line_cost(jsonb)'::regprocedure);
 IF strpos(d,'e - ''unitCost''')=0 THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_COST_VISIBILITY_DRIFT';END IF;
 EXECUTE replace(d,'e - ''unitCost''','e - ''unitCost'' - ''costPiastres''');
END $migration$;
CREATE INDEX orders_waiting_fulfillment ON public.orders(store_id,"createdAt",id)
 WHERE deleted_at IS NULL AND status='pending' AND fulfillment->>'version'='1';
CREATE TABLE financial_private.fulfillment_actions (
 event_id text PRIMARY KEY REFERENCES public.ledger_events(id) DEFERRABLE INITIALLY DEFERRED,
 store_id uuid NOT NULL,order_id text NOT NULL REFERENCES public.orders(id) DEFERRABLE INITIALLY DEFERRED,
 action text NOT NULL CHECK(action IN ('placement','allocation','edit')),
 source_event_id text REFERENCES public.ledger_events(id),request jsonb NOT NULL,
 before_document jsonb,after_document jsonb NOT NULL,result jsonb
);
CREATE TABLE financial_private.fulfillment_permits (
 transaction_id bigint,store_id uuid,order_id text,document jsonb,stock_items jsonb,items jsonb,
 PRIMARY KEY(transaction_id,store_id,order_id)
);
ALTER TABLE financial_private.fulfillment_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_private.fulfillment_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.fulfillment_actions,financial_private.fulfillment_permits FROM PUBLIC,anon,authenticated;

-- Receipt allocation needs order-before-product locking. A per-store entry
-- lock serializes the existing financial commands BEFORE either lock family.
-- Raw order writes fail quickly rather than hold a row while waiting for that
-- entry lock. Roles/RLS of every original command remain independently checked.
CREATE FUNCTION financial_private.fulfillment_lock(p_store uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF p_store IS NULL OR auth.uid() IS NULL OR NOT public.is_store_member(p_store) THEN
  RETURN;END IF; -- Original command retains its own exact refusal contract.
 PERFORM pg_advisory_xact_lock(hashtextextended('fulfillment:'||p_store::text,0));
END $fn$;

-- Follow-up is explicitly nonfinancial. Moderator gets no order, stock,
-- wallet or ledger mutation permission from this narrow new workflow.
CREATE TABLE public.order_shortage_followups (
 store_id uuid NOT NULL REFERENCES public.stores(id),order_id text NOT NULL REFERENCES public.orders(id),
 revision bigint NOT NULL CHECK(revision>0),state text NOT NULL CHECK(state IN ('waiting','contacted','awaiting_customer','procurement')),
 notes text NOT NULL CHECK(length(notes)<=1500),updated_at timestamptz NOT NULL,updated_by uuid NOT NULL REFERENCES auth.users(id),
 PRIMARY KEY(store_id,order_id)
);
ALTER TABLE public.order_shortage_followups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_shortage_followups FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.order_shortage_followups TO authenticated;
CREATE POLICY shortage_followup_read ON public.order_shortage_followups FOR SELECT TO authenticated
 USING(coalesce(public.has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT','ECOMMERCE_ONLY','MODERATOR']),false));
CREATE TABLE financial_private.shortage_followup_commands(id text PRIMARY KEY,store_id uuid NOT NULL,request jsonb NOT NULL,result jsonb NOT NULL);
ALTER TABLE financial_private.shortage_followup_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.shortage_followup_commands FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.save_shortage_followup(p_id text,p_store uuid,p_order text,p_expected bigint,p_state text,p_notes text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE request jsonb:=jsonb_build_object('orderId',p_order,'expectedRevision',p_expected,'state',p_state,'notes',p_notes);
 old financial_private.shortage_followup_commands;row public.order_shortage_followups;r jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','MODERATOR']),false)
  OR NOT public.store_licensed(p_store) THEN RAISE EXCEPTION 'NEXUS_SHORTAGE_FOLLOWUP_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF nullif(p_id,'') IS NULL OR p_expected IS NULL OR p_expected<0 OR p_notes IS NULL OR length(p_notes)>1500
  OR p_state IS NULL OR p_state NOT IN ('waiting','contacted','awaiting_customer','procurement') THEN
  RAISE EXCEPTION 'NEXUS_SHORTAGE_FOLLOWUP_INVALID' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('shortage-note-command:'||p_id,0));
 SELECT * INTO old FROM financial_private.shortage_followup_commands WHERE id=p_id;
 IF FOUND THEN
  IF old.store_id IS DISTINCT FROM p_store OR old.request IS DISTINCT FROM request THEN RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514';END IF;
  RETURN old.result||jsonb_build_object('replayed',true);
 END IF;
 -- Notes never take a financial/order row lock, so cannot invert the stock
 -- entry order or prevent receipt allocation. Source identity is scoped.
 IF NOT EXISTS(SELECT 1 FROM public.orders WHERE id=p_order AND store_id=p_store AND deleted_at IS NULL AND fulfillment->>'version'='1') THEN
  RAISE EXCEPTION 'NEXUS_SHORTAGE_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('shortage-note:'||p_store::text||':'||p_order,0));
 SELECT * INTO row FROM public.order_shortage_followups WHERE store_id=p_store AND order_id=p_order FOR UPDATE;
 IF coalesce(row.revision,0)<>p_expected THEN RAISE EXCEPTION 'NEXUS_SHORTAGE_NOTE_STALE' USING ERRCODE='40001';END IF;
 INSERT INTO public.order_shortage_followups VALUES(p_store,p_order,p_expected+1,p_state,p_notes,clock_timestamp(),auth.uid())
 ON CONFLICT(store_id,order_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,notes=excluded.notes,updated_at=excluded.updated_at,updated_by=excluded.updated_by RETURNING * INTO row;
 IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_SHORTAGE_NOTE_NOT_WRITTEN' USING ERRCODE='23514';END IF;
 r:=jsonb_build_object('followup',to_jsonb(row),'replayed',false);
 INSERT INTO financial_private.shortage_followup_commands VALUES(p_id,p_store,request,r);
 IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_SHORTAGE_NOTE_RECOVERY_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN r;
END $fn$;
REVOKE ALL ON FUNCTION public.save_shortage_followup(text,uuid,text,bigint,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_shortage_followup(text,uuid,text,bigint,text,text) TO authenticated;
REVOKE ALL ON FUNCTION financial_private.fulfillment_lock(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION financial_private.fulfillment_lock(uuid) TO authenticated;

CREATE FUNCTION financial_private.has_fulfillment_permit(p_store uuid,p_order text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
 SELECT EXISTS(SELECT 1 FROM financial_private.fulfillment_permits
  WHERE transaction_id=txid_current() AND store_id=p_store AND order_id=p_order)
$fn$;
REVOKE ALL ON FUNCTION financial_private.has_fulfillment_permit(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION financial_private.has_fulfillment_permit(uuid,text) TO authenticated;

CREATE FUNCTION financial_private.guard_fulfillment_document() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE changed boolean; permitted integer;
BEGIN
 IF TG_OP='UPDATE' AND OLD.fulfillment IS NOT NULL AND
  (NEW.id IS DISTINCT FROM OLD.id OR NEW.store_id IS DISTINCT FROM OLD.store_id OR
   (OLD.status='pending' AND NEW.status='pending' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'NEXUS_FULFILLMENT_IDENTITY_IMMUTABLE: cancel the pending order before archiving' USING ERRCODE='23514';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('fulfillment:'||NEW.store_id::text,0)) THEN
  RAISE EXCEPTION 'NEXUS_FULFILLMENT_BUSY_RETRY' USING ERRCODE='40001';END IF;
 changed:=CASE WHEN TG_OP='INSERT' THEN NEW.fulfillment IS NOT NULL
  ELSE NEW.fulfillment IS DISTINCT FROM OLD.fulfillment OR
   (OLD.fulfillment IS NOT NULL AND (NEW.items IS DISTINCT FROM OLD.items OR NEW."stockItems" IS DISTINCT FROM OLD."stockItems")) END;
 IF changed THEN
  DELETE FROM financial_private.fulfillment_permits p WHERE p.transaction_id=txid_current()
   AND p.store_id=NEW.store_id AND p.order_id=NEW.id AND p.document=NEW.fulfillment
   AND p.stock_items=NEW."stockItems" AND p.items=NEW.items;
  GET DIAGNOSTICS permitted=ROW_COUNT;
  IF permitted<>1 THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_COMMAND_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.fulfillment->>'version'='1' AND NEW.status IN ('shipped','delivered','returned') AND EXISTS(
  SELECT 1 FROM jsonb_array_elements(NEW.fulfillment->'demands') d WHERE (d->>'allocated')::numeric<(d->>'quantity')::numeric) THEN
  RAISE EXCEPTION 'NEXUS_FULFILLMENT_INCOMPLETE: استكمل حجز نواقص الطلب قبل الشحن' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_fulfillment_document() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER nexus_fulfillment_document BEFORE INSERT OR UPDATE ON public.orders
 FOR EACH ROW EXECUTE FUNCTION financial_private.guard_fulfillment_document();

-- Deterministic exact-variant plan. Existing reserved units retain their
-- historical integer value; newly acquired units use current ledger WAC.
CREATE FUNCTION financial_private.fulfillment_plan(p_store uuid,p_demands jsonb,p_stock jsonb,p_existing boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE d jsonb;old_item jsonb;p public.products;requested numeric;retained numeric;old_cost numeric;
 available numeric;total numeric;value numeric;take numeric;cost numeric;allocated numeric;
 released numeric;released_value numeric;released_variant numeric;
 demands jsonb:='[]';stocks jsonb:='[]';lines jsonb:='[]';used jsonb:='{}';product_used jsonb:='{}';taken numeric;key text;subject text;variant text;
BEGIN
 IF jsonb_typeof(p_demands) IS DISTINCT FROM 'array' OR jsonb_array_length(p_demands)=0 THEN
  RAISE EXCEPTION 'NEXUS_FULFILLMENT_DEMAND_REQUIRED' USING ERRCODE='23514';END IF;
 FOR subject IN SELECT DISTINCT x->>'productId' FROM jsonb_array_elements(p_demands) x ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-stock:'||p_store::text||':'||subject,0));
  PERFORM 1 FROM public.products WHERE store_id=p_store AND id=subject FOR UPDATE;
 END LOOP;
 FOR d IN SELECT x FROM jsonb_array_elements(p_demands) WITH ORDINALITY t(x,n) ORDER BY n LOOP
  subject:=d->>'productId';variant:=nullif(d->>'variantName','');requested:=(d->>'quantity')::numeric;
  SELECT * INTO p FROM public.products WHERE store_id=p_store AND id=subject;
  IF NOT FOUND OR p."isBundle" OR (NOT p_existing AND (p.deleted_at IS NOT NULL OR NOT coalesce(p."isActive",false)))
   OR requested IS NULL OR requested<=0 OR requested<>trunc(requested) OR requested::text IN ('NaN','Infinity','-Infinity') THEN
   RAISE EXCEPTION 'NEXUS_FULFILLMENT_PRODUCT_INVALID' USING ERRCODE='23514';END IF;
  IF (jsonb_array_length(coalesce(p.metadata->'variants','[]'))>0 AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(p.metadata->'variants') v WHERE v->>'name'=variant))
   OR (jsonb_array_length(coalesce(p.metadata->'variants','[]'))=0 AND variant IS NOT NULL) THEN
   RAISE EXCEPTION 'NEXUS_STOCK_VARIANT_INVALID' USING ERRCODE='23514';END IF;
  SELECT x INTO old_item FROM jsonb_array_elements(coalesce(p_stock,'[]')) x WHERE x->>'id'=d->>'id';
  retained:=least(requested,coalesce((old_item->>'quantity')::numeric,0));
  old_cost:=CASE WHEN retained>0 THEN round(coalesce((old_item->>'costPiastres')::numeric,
   (old_item->>'quantity')::numeric*(old_item->>'unitCost')::numeric*100)*retained/(old_item->>'quantity')::numeric) ELSE 0 END;
  SELECT coalesce(sum(qty_delta),0),coalesce(sum(amount_delta),0) INTO total,value
   FROM public.ledger_lines WHERE store_id=p_store AND account='stock' AND subject_id=subject;
  IF p.quantity IS DISTINCT FROM total OR (jsonb_array_length(coalesce(p.metadata->'variants','[]'))>0
   AND (SELECT sum((v->>'stock')::numeric) FROM jsonb_array_elements(p.metadata->'variants') v) IS DISTINCT FROM total) THEN
   RAISE EXCEPTION 'NEXUS_STOCK_RECONCILIATION_REQUIRED' USING ERRCODE='23514';END IF;
  -- A pending edit may release some of this order's OWN reservations. Those
  -- units, at their saved cost, can fund the new plan; another order's reserved
  -- units never appear in ATP. Supply allocation itself releases nothing.
  SELECT coalesce(sum(q),0),coalesce(sum(a),0),coalesce(sum(q) FILTER(WHERE v=coalesce(variant,'')),0)
   INTO released,released_value,released_variant FROM (
    SELECT coalesce(x->>'variantName','') v,
     (x->>'quantity')::numeric-least((x->>'quantity')::numeric,coalesce((SELECT (n->>'quantity')::numeric FROM jsonb_array_elements(p_demands) n WHERE n->>'id'=x->>'id'),0)) q,
     coalesce((x->>'costPiastres')::numeric,(x->>'quantity')::numeric*(x->>'unitCost')::numeric*100)-
      CASE WHEN coalesce((SELECT (n->>'quantity')::numeric FROM jsonb_array_elements(p_demands) n WHERE n->>'id'=x->>'id'),0)>0
       THEN round(coalesce((x->>'costPiastres')::numeric,(x->>'quantity')::numeric*(x->>'unitCost')::numeric*100)*
        least((x->>'quantity')::numeric,(SELECT (n->>'quantity')::numeric FROM jsonb_array_elements(p_demands) n WHERE n->>'id'=x->>'id'))/(x->>'quantity')::numeric) ELSE 0 END a
    FROM jsonb_array_elements(coalesce(p_stock,'[]')) x WHERE x->>'productId'=subject) r;
  available:=CASE WHEN variant IS NULL THEN total+released ELSE (SELECT (v->>'stock')::numeric FROM jsonb_array_elements(p.metadata->'variants') v WHERE v->>'name'=variant)+released_variant END;
  key:=jsonb_build_array(subject,variant)::text;
  available:=available-coalesce((used->>key)::numeric,0);
  IF p.deleted_at IS NOT NULL OR NOT coalesce(p."isActive",false) THEN available:=0;END IF;
  take:=least(requested-retained,greatest(0,available));allocated:=retained+take;
  taken:=coalesce((product_used->>subject)::numeric,0);
  IF value<0 OR (total=0 AND value<>0) THEN RAISE EXCEPTION 'NEXUS_STOCK_RECONCILIATION_REQUIRED' USING ERRCODE='23514';END IF;
  -- Cumulative product boundaries conserve every piastre even when several
  -- exact variants/bundles share a WAC of half a piastre per unit.
  cost:=old_cost+CASE WHEN total+released>0 THEN
   round((taken+take)*(value+released_value)/(total+released))-round(taken*(value+released_value)/(total+released)) ELSE 0 END;
  product_used:=jsonb_set(product_used,ARRAY[subject],to_jsonb(taken+take));
  used:=jsonb_set(used,ARRAY[key],to_jsonb(coalesce((used->>key)::numeric,0)+take));
  demands:=demands||jsonb_build_array(d-'unitCost'-'costPiastres'||jsonb_build_object('allocated',allocated,'missing',requested-allocated));
  IF allocated>0 THEN stocks:=stocks||jsonb_build_array(d-'allocated'-'missing'||jsonb_build_object(
   'quantity',allocated,'unitCost',cost/allocated/100,'costPiastres',cost,'shortfall',requested-allocated));END IF;
  IF take>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','stock',
   'subject_id',subject,'qty_delta',-take,'amount_delta',-(cost-old_cost)));END IF;
 END LOOP;
 RETURN jsonb_build_object('fulfillment',jsonb_build_object('version',1,'allowBackorder',true,'demands',demands),
  'stockItems',stocks,'lines',lines);
END $fn$;
REVOKE ALL ON FUNCTION financial_private.fulfillment_plan(uuid,jsonb,jsonb,boolean) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION financial_private.place_backorder(p_order jsonb,p_event jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE store uuid:=(p_order->>'store_id')::uuid;request jsonb:=jsonb_build_object('order',p_order,'event',p_event);
 saved financial_private.fulfillment_actions;draft jsonb;demands jsonb;plan jsonb;lines jsonb;r jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(store,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false)
  OR NOT public.store_licensed(store) THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_FORBIDDEN' USING ERRCODE='42501';END IF;
 PERFORM financial_private.fulfillment_lock(store);
 IF p_order->'exchangeDetails' IS NOT NULL AND p_order->'exchangeDetails'<>'null'::jsonb THEN
  RAISE EXCEPTION 'NEXUS_EXCHANGE_BACKORDER_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT * INTO saved FROM financial_private.fulfillment_actions WHERE event_id=p_event->>'id';
 IF FOUND THEN
  IF saved.store_id IS DISTINCT FROM store OR saved.request IS DISTINCT FROM request OR saved.result IS NULL THEN
   RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514';END IF;
  RETURN saved.result||jsonb_build_object('replayed',true,'order',(SELECT to_jsonb(o) FROM public.orders o WHERE o.id=saved.order_id AND o.store_id=store));
 END IF;
 IF EXISTS(SELECT 1 FROM public.orders WHERE store_id=store AND (id=p_order->>'id' OR "orderNumber"=p_order->>'orderNumber')) THEN
  RAISE EXCEPTION 'NEXUS_FULFILLMENT_PLACEMENT_IDENTITY_CHANGED' USING ERRCODE='23514';END IF;
 IF (nullif(p_order->>'customerId','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.customers WHERE store_id=store AND id=p_order->>'customerId' AND deleted_at IS NULL)) OR
  (nullif(p_order->>'courierId','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.couriers WHERE store_id=store AND id=p_order->>'courierId' AND deleted_at IS NULL)) THEN
  RAISE EXCEPTION 'NEXUS_FULFILLMENT_COUNTERPARTY_INVALID' USING ERRCODE='23514';END IF;
 -- Resolve current recipe server-side. Stable part IDs are independent of
 -- a browser's stale bundle expansion or forged shortage/cost fields.
 SELECT jsonb_agg(x||jsonb_build_object('productId',coalesce(nullif(x->>'bundleId',''),x->>'productId')) ORDER BY n)
  INTO draft FROM jsonb_array_elements(p_order->'items') WITH ORDINALITY t(x,n);
 demands:=public.order_edit_stock(store,'{}',draft);
 SELECT jsonb_agg(x||jsonb_build_object('id','d:'||n::text) ORDER BY n) INTO demands
  FROM jsonb_array_elements(demands) WITH ORDINALITY t(x,n);
 plan:=financial_private.fulfillment_plan(store,demands,'[]');
 lines:=(plan->'lines')||coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements(p_event->'lines') x WHERE x->>'account'<>'stock'),'[]');
 INSERT INTO financial_private.fulfillment_actions VALUES(p_event->>'id',store,p_order->>'id','placement',NULL,request,NULL,plan,NULL);
 INSERT INTO financial_private.fulfillment_permits VALUES(txid_current(),store,p_order->>'id',plan->'fulfillment',plan->'stockItems',p_order->'items');
 r:=public.place_order(p_order||jsonb_build_object('fulfillment',plan->'fulfillment','stockItems',plan->'stockItems',
  'cogsAmount',coalesce((SELECT sum((x->>'costPiastres')::numeric)/100 FROM jsonb_array_elements(plan->'stockItems') x),0)),
  p_event||jsonb_build_object('lines',lines));
 UPDATE financial_private.fulfillment_actions SET result=r WHERE event_id=p_event->>'id';
 RETURN r;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.place_backorder(jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION financial_private.place_backorder(jsonb,jsonb) TO authenticated;

CREATE FUNCTION financial_private.allocate_backorders(p_source text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE e public.ledger_events;o public.orders;plan jsonb;before jsonb;v_event_id text;v_result jsonb;updated integer;
BEGIN
 SELECT * INTO e FROM public.ledger_events WHERE id=p_source;
 IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ledger_events WHERE id=e.id AND xmin::text=pg_current_xact_id()::text)
  OR auth.uid() IS NULL OR NOT public.is_store_member(e.store_id) OR NOT public.store_licensed(e.store_id) THEN
  RAISE EXCEPTION 'NEXUS_FULFILLMENT_CURRENT_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM financial_private.fulfillment_actions WHERE event_id=e.id AND action='allocation')
  OR NOT EXISTS(SELECT 1 FROM public.ledger_lines WHERE event_id=e.id AND account='stock' AND qty_delta>0) THEN RETURN;END IF;
 IF e.kind='purchase' AND e.command_request->>'command'='receipt' AND nullif(e.command_request#>>'{input,payloadExtra,shortageOrderId}','') IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM public.orders linked CROSS JOIN LATERAL jsonb_array_elements(linked.fulfillment->'demands') d
  WHERE linked.id=e.command_request#>>'{input,payloadExtra,shortageOrderId}' AND linked.store_id=e.store_id AND linked.deleted_at IS NULL
   AND linked.status='pending' AND linked.fulfillment->>'version'='1' AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(e.command_request#>'{input,items}') item WHERE item->>'productId'=d->>'productId'
     AND coalesce(item->>'variantName','')=coalesce(d->>'variantName',''))) THEN
  RAISE EXCEPTION 'NEXUS_SHORTAGE_PROCUREMENT_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
 -- Caller already owns the common store lock BEFORE source order/products.
 FOR o IN SELECT * FROM public.orders WHERE store_id=e.store_id AND status='pending' AND deleted_at IS NULL
  AND fulfillment->>'version'='1' AND EXISTS(SELECT 1 FROM jsonb_array_elements(fulfillment->'demands') d WHERE (d->>'missing')::numeric>0
   AND EXISTS(SELECT 1 FROM public.ledger_lines WHERE event_id=e.id AND account='stock' AND qty_delta>0 AND subject_id=d->>'productId'))
  ORDER BY "createdAt",id FOR UPDATE LOOP
  plan:=financial_private.fulfillment_plan(e.store_id,o.fulfillment->'demands',o."stockItems",true);
  IF jsonb_array_length(plan->'lines')=0 THEN CONTINUE;END IF;
  v_event_id:='allocation:'||e.id||':'||o.id;
  before:=jsonb_build_object('stockItems',o."stockItems",'fulfillment',o.fulfillment);
  INSERT INTO financial_private.fulfillment_actions VALUES(v_event_id,e.store_id,o.id,'allocation',e.id,
   jsonb_build_object('sourceEventId',e.id,'orderId',o.id),before,plan,NULL);
  INSERT INTO financial_private.fulfillment_permits VALUES(txid_current(),e.store_id,o.id,plan->'fulfillment',plan->'stockItems',o.items);
  UPDATE public.orders SET fulfillment=plan->'fulfillment',"stockItems"=plan->'stockItems',
   "cogsAmount"=(SELECT sum((x->>'costPiastres')::numeric)/100 FROM jsonb_array_elements(plan->'stockItems') x),
   "updatedAt"=now(),updated_at=greatest(coalesce(updated_at,0)+1,(extract(epoch FROM clock_timestamp())*1000)::bigint)
   WHERE store_id=e.store_id AND id=o.id RETURNING * INTO o;
  GET DIAGNOSTICS updated=ROW_COUNT;
  IF updated<>1 THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_NOT_WRITTEN' USING ERRCODE='23514';END IF;
  v_result:=jsonb_build_object('eventId',v_event_id,'order',to_jsonb(o),'replayed',false);
  UPDATE financial_private.fulfillment_actions SET result=v_result WHERE fulfillment_actions.event_id=v_event_id;
  PERFORM public.ledger_append(jsonb_build_object('id',v_event_id,'store_id',e.store_id,'device_id',e.device_id,
   'kind','order_edited','ref_type','ecommerce_order','ref_id',o."orderNumber",'created_at',now(),'occurred_at',now(),
   'payload',jsonb_build_object('before',before,'after',plan,'type','backorder_allocation','sourceEventId',e.id)::text,
   'command_request',jsonb_build_object('command','order_edit','input',jsonb_build_object('orderId',o.id,'sourceEventId',e.id)),
   'command_result',v_result,'lines',plan->'lines'));
 END LOOP;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.allocate_backorders(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION financial_private.allocate_backorders(text) TO authenticated;

-- Zero-stock placements and zero-reservation cancellations may legitimately
-- have no stock lines, but ONLY a proved forward canonical document. Continue
-- all ordinary amount/deposit/account validation, never a general empty-event
-- permission or a client-set GUC bypass.
CREATE FUNCTION financial_private.empty_fulfillment_event(p_event jsonb) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
 SELECT EXISTS(SELECT 1 FROM public.orders o WHERE o.store_id=(p_event->>'store_id')::uuid
  AND o."orderNumber"=p_event->>'ref_id' AND o.fulfillment->>'version'='1' AND o."stockItems"='[]'::jsonb
  AND p_event->>'ref_type'='ecommerce_order' AND (
   (p_event->>'kind'='order_placed' AND EXISTS(SELECT 1 FROM financial_private.fulfillment_actions a
    WHERE a.event_id=p_event->>'id' AND a.store_id=o.store_id AND a.order_id=o.id AND a.action='placement'
     AND a.xmin::text=pg_current_xact_id()::text)) OR
   (p_event->>'kind'='order_cancelled' AND p_event#>>'{command_request,command}'='order_cancel'
    AND o.status='cancelled' AND EXISTS(SELECT 1 FROM financial_private.exchange_credit_commands c
     WHERE c.id=p_event->>'id' AND c.store_id=o.store_id AND c.xmin::text=pg_current_xact_id()::text))))
$fn$;
REVOKE ALL ON FUNCTION financial_private.empty_fulfillment_event(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION financial_private.empty_fulfillment_event(jsonb) TO authenticated;

DO $migration$
DECLARE d text;needle text;proc record;expression text;
BEGIN
 -- All these existing stock/order financial entry points must take the common
 -- lock before their existing order/supplier/discount/product locks. No auth,
 -- replay, command signature or immutable validator is removed.
 FOR proc IN SELECT p.oid,p.proname,pg_get_function_arguments(p.oid) args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('place_order','ledger_append','record_financial_command','record_stock_command',
   'record_pos_sale','record_pos_exchange','record_order_edit','record_order_cancel','cancel_order','confirm_order_return',
   'record_order_delivery','prepare_return_delivery','record_exchange_place','record_exchange_return','record_exchange_credit_refund',
   'record_order_payment','record_courier_batch','record_product_catalog','record_bundle_edit') LOOP
  d:=replace(pg_get_functiondef(proc.oid),chr(13),'');
  expression:=CASE WHEN proc.proname IN ('place_order','ledger_append') THEN 'v_store'
   WHEN proc.args LIKE '%p_store uuid%' THEN 'p_store'
   WHEN proc.args LIKE '%p_event jsonb%' THEN '(p_event->>''store_id'')::uuid'
   WHEN proc.proname='confirm_order_return' THEN '(SELECT store_id FROM public.orders WHERE id=p_order_id)'
   ELSE NULL END;
  IF expression IS NULL OR strpos(d,chr(10)||'BEGIN'||chr(10))=0 THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_ENTRY_DRIFT:%',proc.proname;END IF;
  d:=regexp_replace(d,E'\nBEGIN\n',chr(10)||'BEGIN'||chr(10)||' PERFORM financial_private.fulfillment_lock('||expression||');'||chr(10));
  EXECUTE d;
 END LOOP;
 d:=replace(pg_get_functiondef('public.place_order(jsonb,jsonb)'::regprocedure),chr(13),'');
 needle:='  IF v_store IS NULL';
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_PLACE_DRIFT';END IF;
 d:=replace(d,needle,'  IF p_order#>>''{fulfillment,allowBackorder}''=''true'' AND NOT financial_private.has_fulfillment_permit(v_store,p_order->>''id'') THEN RETURN financial_private.place_backorder(p_order,p_event);END IF;'||chr(10)||needle);
 EXECUTE d;
 d:=replace(pg_get_functiondef('public.ledger_append(jsonb)'::regprocedure),chr(13),'');
 needle:='  PERFORM financial_private.apply_stock_event(v_id);';
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_LEDGER_DRIFT';END IF;
 d:=replace(d,needle,needle||chr(10)||'  PERFORM financial_private.allocate_backorders(v_id);');EXECUTE d;
 d:=replace(pg_get_functiondef('public.ledger_validate_event(jsonb)'::regprocedure),chr(13),'');
 IF strpos(d,'  IF v_n = 0 THEN')=0 OR strpos(d,'IF v_stock_out = 0 OR v_stock_in > 0')=0 THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_VALIDATOR_DRIFT';END IF;
 d:=replace(d,'  IF v_n = 0 THEN','  IF v_n = 0 AND NOT financial_private.empty_fulfillment_event(p_event) THEN');
 d:=replace(d,'IF v_stock_out = 0 OR v_stock_in > 0','IF (v_stock_out = 0 AND NOT financial_private.empty_fulfillment_event(p_event)) OR v_stock_in > 0');EXECUTE d;
END $migration$;

-- Reuse the fully reviewed edit contract (auth, exact stale document, money,
-- discount, replay, credit protections); replace ONLY its stock-planning leg
-- for opted-in ordinary orders. Historical and exchange orders keep their
-- original function and reservation semantics.
DO $migration$
DECLARE d text;original text;first_pos integer;last_pos integer;needle text;
BEGIN
 d:=replace(pg_get_functiondef('public.order_edit_stock(uuid,jsonb,jsonb)'::regprocedure),chr(13),'');
 IF strpos(d,'jsonb_array_elements(p_order->''stockItems'')')=0 THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_RECIPE_DRIFT';END IF;
 EXECUTE replace(d,'jsonb_array_elements(p_order->''stockItems'')','jsonb_array_elements(coalesce(p_order#>''{fulfillment,demands}'',p_order->''stockItems''))');
 original:=replace(pg_get_functiondef('public.record_order_edit(text,uuid,uuid,text,jsonb)'::regprocedure),chr(13),'');
 d:=replace(original,'FUNCTION public.record_order_edit(','FUNCTION financial_private.record_fulfillment_edit(');
 d:=replace(d,'DECLARE credit jsonb;','DECLARE plan jsonb;demand jsonb;credit jsonb;');
 d:=replace(d,'RETURN v_old.command_result||jsonb_build_object(''replayed'',true);',
  'RETURN v_old.command_result||jsonb_build_object(''replayed'',true,''order'',(SELECT to_jsonb(current_order) FROM public.orders current_order WHERE current_order.id=p_input->>''orderId'' AND current_order.store_id=p_store));');
 d:=replace(d,'SELECT sum((i->>''quantity'')::numeric*coalesce((i->>''unitCost'')::numeric,0)) INTO v_cogs',
  'SELECT coalesce(sum((i->>''quantity'')::numeric*coalesce((i->>''unitCost'')::numeric,0)),0) INTO v_cogs');
 first_pos:=strpos(d,'  -- Snapshot retained units at their original reservation cost.');
 last_pos:=strpos(d,'  WITH movements AS (');
 IF first_pos=0 OR last_pos<=first_pos OR strpos(d,'"exchangeDetails"=o."exchangeDetails"')=0 THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_EDIT_DRIFT';END IF;
 d:=left(d,first_pos-1)||$patch$
  SELECT jsonb_agg(x||jsonb_build_object('id',coalesce((SELECT n->>'id' FROM jsonb_array_elements(o.fulfillment->'demands') n
   WHERE n->>'productId'=x->>'productId' AND coalesce(n->>'variantName','')=coalesce(x->>'variantName','')
    AND coalesce(n->>'bundleId','')=coalesce(x->>'bundleId','')),'d:'||gen_random_uuid()::text)) ORDER BY ordinal)
   INTO demand FROM jsonb_array_elements(v_expected_stock) WITH ORDINALITY t(x,ordinal);
  plan:=financial_private.fulfillment_plan(p_store,demand,o."stockItems");
  v_patch:=v_patch||jsonb_build_object('stockItems',plan->'stockItems','fulfillment',plan->'fulfillment');
$patch$||substring(d FROM last_pos);
 -- Keep gross restored/allocated movements separate even on a net-zero
 -- quantity variant edit: its actual historical value may change correctly.
 first_pos:=strpos(d,'  WITH movements AS (');last_pos:=strpos(d,'  FOR v_subject IN SELECT l->>''subject_id''');
 IF last_pos<=first_pos THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_EDIT_LINES_DRIFT';END IF;
 d:=left(d,first_pos-1)||$patch$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',gen_random_uuid()::text,'account','stock','subject_id',subject,
   'qty_delta',qty,'amount_delta',round(amount))),'[]') INTO v_lines FROM (
   SELECT x->>'productId' subject,(x->>'quantity')::numeric qty,coalesce((x->>'costPiastres')::numeric,(x->>'quantity')::numeric*(x->>'unitCost')::numeric*100) amount
    FROM jsonb_array_elements(o."stockItems") x
   UNION ALL SELECT x->>'productId',-(x->>'quantity')::numeric,-(x->>'costPiastres')::numeric FROM jsonb_array_elements(v_patch->'stockItems') x) t;
$patch$||substring(d FROM last_pos);
 d:=replace(d,'  UPDATE public.orders SET items=v_patch->''items'',',
  '  INSERT INTO financial_private.fulfillment_permits VALUES(txid_current(),p_store,o.id,v_patch->''fulfillment'',v_patch->''stockItems'',v_patch->''items'');'||chr(10)||
  '  UPDATE public.orders SET fulfillment=v_patch->''fulfillment'',items=v_patch->''items'',');
 needle:='  PERFORM public.ledger_append(jsonb_build_object(';
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_EDIT_EVENT_DRIFT';END IF;
 d:=replace(d,needle,'  INSERT INTO financial_private.fulfillment_actions VALUES(p_id,p_store,o.id,''edit'',NULL,v_request,p_input->''before'',v_patch,v_result);'||chr(10)||needle);
 EXECUTE d;
 needle:=' PERFORM financial_private.fulfillment_lock(p_store);';
 original:=replace(original,needle,needle||chr(10)||' IF EXISTS(SELECT 1 FROM public.orders WHERE store_id=p_store AND id=p_input->>''orderId'' AND fulfillment->>''version''=''1'') THEN RETURN financial_private.record_fulfillment_edit(p_id,p_store,p_device,p_command,p_input);END IF;');
 EXECUTE original;
END $migration$;
REVOKE ALL ON FUNCTION financial_private.record_fulfillment_edit(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION financial_private.require_fulfillment_action() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE a financial_private.fulfillment_actions;o public.orders;
BEGIN
 SELECT * INTO o FROM public.orders WHERE store_id=NEW.store_id AND "orderNumber"=NEW.ref_id;
 IF o.fulfillment->>'version' IS DISTINCT FROM '1' OR NEW.ref_type<>'ecommerce_order' OR NEW.kind NOT IN ('order_placed','order_edited') THEN RETURN NULL;END IF;
 SELECT * INTO a FROM financial_private.fulfillment_actions WHERE event_id=NEW.id AND store_id=NEW.store_id AND order_id=o.id;
 IF NOT FOUND OR a.result IS NULL OR a.after_document->'fulfillment' IS NULL OR
   (NEW.kind='order_placed' AND a.action<>'placement') OR
   (NEW.kind='order_edited' AND a.action NOT IN ('allocation','edit')) OR
   (a.action='allocation' AND (a.source_event_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.ledger_lines WHERE event_id=a.source_event_id AND account='stock' AND qty_delta>0))) THEN
  RAISE EXCEPTION 'NEXUS_FULFILLMENT_ACTION_REQUIRED' USING ERRCODE='23514';END IF;
 IF EXISTS(WITH expected AS (
  SELECT subject,sum(qty) qty,sum(amount) amount FROM (
   SELECT x->>'productId' subject,-(x->>'quantity')::numeric qty,-(x->>'costPiastres')::numeric amount
    FROM jsonb_array_elements(a.after_document->'stockItems') x
   UNION ALL SELECT x->>'productId',(x->>'quantity')::numeric,coalesce((x->>'costPiastres')::numeric,round((x->>'quantity')::numeric*(x->>'unitCost')::numeric*100))
    FROM jsonb_array_elements(coalesce(a.before_document->'stockItems','[]')) x) movements GROUP BY subject
 ),actual AS (
  SELECT subject_id subject,sum(qty_delta::numeric) qty,sum(amount_delta) amount FROM public.ledger_lines WHERE event_id=NEW.id AND account='stock' GROUP BY subject_id
 ) SELECT 1 FROM expected FULL JOIN actual USING(subject) WHERE coalesce(expected.qty,0) IS DISTINCT FROM coalesce(actual.qty,0)
   OR coalesce(expected.amount,0) IS DISTINCT FROM coalesce(actual.amount,0)) THEN
  RAISE EXCEPTION 'NEXUS_FULFILLMENT_LEDGER_MISMATCH' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $fn$;

-- The original signed per-line Math.round convention can lose a half-piastre
-- across several demanded components. For NEW canonical forward placements,
-- verify the private exact cumulative plan instead; every legacy cost guard
-- and every stock-availability/variant/application guard stays in force.
DO $migration$
DECLARE d text;marker text;
BEGIN
 d:=replace(pg_get_functiondef('financial_private.apply_stock_event(text)'::regprocedure),chr(13),'');
 marker:='  IF e.kind=''order_placed'' OR (e.kind=''stock_adjustment'' AND e.ref_type=''stock_audit'') THEN';
 IF strpos(d,marker)=0 THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_COST_SCHEMA_DRIFT';END IF;
 EXECUTE replace(d,marker,$patch$
  IF e.kind='order_placed' AND source.fulfillment->>'version'='1' THEN
   IF NOT EXISTS(SELECT 1 FROM financial_private.fulfillment_actions a WHERE a.event_id=e.id AND a.store_id=e.store_id AND a.action='placement'
     AND a.xmin::text=pg_current_xact_id()::text) OR
    (SELECT sum((x->>'piastres')::numeric) FROM jsonb_array_elements(stocks) x WHERE x->>'productId'=subject) IS DISTINCT FROM
    -(SELECT sum((x->>'costPiastres')::numeric) FROM jsonb_array_elements(source."stockItems") x WHERE x->>'productId'=subject) THEN
    RAISE EXCEPTION 'NEXUS_FULFILLMENT_COST_PROOF_REQUIRED' USING ERRCODE='23514';END IF;
  ELSIF e.kind='order_placed' OR (e.kind='stock_adjustment' AND e.ref_type='stock_audit') THEN
$patch$);
END $migration$;
REVOKE ALL ON FUNCTION financial_private.require_fulfillment_action() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER nexus_fulfillment_action_required AFTER INSERT ON public.ledger_events
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION financial_private.require_fulfillment_action();

CREATE FUNCTION financial_private.immutable_fulfillment_action() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF TG_OP='UPDATE' AND OLD.result IS NULL AND NEW.result IS NOT NULL AND to_jsonb(OLD)-'result'=to_jsonb(NEW)-'result'
  AND OLD.xmin::text=pg_current_xact_id()::text THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'NEXUS_FULFILLMENT_ACTION_IMMUTABLE' USING ERRCODE='23514';
END $fn$;
REVOKE ALL ON FUNCTION financial_private.immutable_fulfillment_action() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER nexus_fulfillment_action_immutable BEFORE UPDATE OR DELETE ON financial_private.fulfillment_actions
 FOR EACH ROW EXECUTE FUNCTION financial_private.immutable_fulfillment_action();

-- Keep the exact operational-view membership/cost stripping and append only
-- cost-free fulfillment demand. No replacement of its authorization predicate.
DO $migration$
DECLARE d text;
BEGIN
 d:=pg_get_viewdef('public.orders_operational'::regclass,true);
 IF strpos(d,'FROM orders o')=0 THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_VIEW_DRIFT';END IF;
 EXECUTE 'CREATE OR REPLACE VIEW public.orders_operational WITH (security_barrier=true) AS '||replace(d,'FROM orders o',', o.fulfillment FROM orders o');
 d:=replace(pg_get_functiondef('public.mobile_shortages(uuid)'::regprocedure),chr(13),'');
 IF strpos(d,'AND o.status IN (''pending'')')=0 THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_SHORTAGE_READER_DRIFT';END IF;
 d:=replace(d,'FUNCTION public.mobile_shortages(','FUNCTION financial_private.legacy_mobile_shortages(');
 EXECUTE replace(d,'AND o.status IN (''pending'')','AND o.status IN (''pending'') AND o.fulfillment IS NULL');
END $migration$;
REVOKE ALL ON FUNCTION financial_private.legacy_mobile_shortages(uuid) FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.mobile_shortages(p_store uuid)
RETURNS TABLE(product_id text,product_name text,sku text,stock numeric,required numeric,deficit numeric,order_count bigint,waiting_orders jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','ECOMMERCE_ONLY','MODERATOR']),false) THEN RETURN;END IF;
 RETURN QUERY
 WITH order_demand AS (
  SELECT o.id,o."orderNumber",o."customerName",o."customerPhone",o."createdAt",d->>'productId' pid,nullif(d->>'variantName','') variant,
   sum((d->>'quantity')::numeric) requested,sum((d->>'allocated')::numeric) allocated,sum((d->>'missing')::numeric) missing
  FROM public.orders o CROSS JOIN LATERAL jsonb_array_elements(o.fulfillment->'demands') d
  WHERE o.store_id=p_store AND o.status='pending' AND o.deleted_at IS NULL AND o.fulfillment->>'version'='1'
  GROUP BY o.id,o."orderNumber",o."customerName",o."customerPhone",o."createdAt",d->>'productId',nullif(d->>'variantName','')
 ),demand AS (
  SELECT od.pid,od.variant,sum(od.requested) requested,sum(od.missing) missing,count(*) count_orders,
   jsonb_agg(jsonb_build_object('orderId',od.id,'orderNumber',od."orderNumber",'customerName',od."customerName",'customerPhone',od."customerPhone",
    'variantName',od.variant,'requested',od.requested,'allocated',od.allocated,'missing',od.missing,
    'followupState',coalesce((SELECT f.state FROM public.order_shortage_followups f WHERE f.store_id=p_store AND f.order_id=od.id),'waiting'),
    'followupNotes',(SELECT f.notes FROM public.order_shortage_followups f WHERE f.store_id=p_store AND f.order_id=od.id),
    'status',CASE WHEN od.missing>0 THEN 'waiting_supply' ELSE 'allocated' END) ORDER BY od."createdAt",od.id) waiting
  FROM order_demand od GROUP BY od.pid,od.variant HAVING sum(od.missing)>0
 )
 SELECT d.pid,p.name||CASE WHEN d.variant IS NOT NULL THEN ' — '||d.variant ELSE '' END,p.sku,
  CASE WHEN d.variant IS NULL THEN p.quantity ELSE coalesce((SELECT (v->>'stock')::numeric FROM jsonb_array_elements(p.metadata->'variants') v WHERE v->>'name'=d.variant),0) END,
  d.requested,d.missing,d.count_orders,d.waiting
 FROM demand d JOIN public.products p ON p.id=d.pid AND p.store_id=p_store
 UNION ALL SELECT * FROM financial_private.legacy_mobile_shortages(p_store);
END $fn$;

-- Mixed-cost supply can yield a fractional per-unit cost. Ordinary partial
-- returns must allocate the ORIGINAL integer value at original unit boundaries
-- (217+217+218+217+217=1086), never round 217.2 five independent times. Reuse
-- the same original-unit owner/discount/cost allocator as atomic exchanges.
CREATE FUNCTION financial_private.fulfillment_return_input(p_store uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE o public.orders;u jsonb;sold jsonb;selection jsonb;part jsonb;source_part jsonb;requests jsonb:='[]';selected jsonb;
 physical jsonb:='[]';lines jsonb;line_id text;cost numeric;
BEGIN
 IF p_input->>'kind'<>'return_confirmed' OR p_input->>'refType'<>'ecommerce_order' OR NOT (p_input->'payload') ? 'returnUnits' THEN RETURN p_input;END IF;
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false)
  OR NOT public.store_licensed(p_store) THEN RAISE EXCEPTION 'NEXUS_RETURN_DOCUMENT_FORBIDDEN' USING ERRCODE='42501';END IF;
 PERFORM financial_private.fulfillment_lock(p_store);
 SELECT * INTO o FROM public.orders WHERE store_id=p_store AND "orderNumber"=p_input->>'refId' FOR UPDATE;
 IF NOT FOUND OR o.fulfillment->>'version' IS DISTINCT FROM '1' THEN RETURN p_input;END IF;
 IF o.status<>'delivered' OR NOT o."revenueLogged" THEN RAISE EXCEPTION 'NEXUS_RETURN_DOCUMENT_SOURCE_STATE' USING ERRCODE='23514';END IF;
 FOR u IN SELECT x FROM jsonb_array_elements(p_input#>'{payload,returnUnits}') x LOOP
  SELECT x,coalesce(nullif(x->>'id',''),'line:'||n::text) INTO sold,line_id
   FROM jsonb_array_elements(o.items) WITH ORDINALITY t(x,n)
   WHERE coalesce(nullif(x->>'bundleId',''),x->>'productId')=coalesce(nullif(u->>'bundleId',''),u->>'productId')
    AND coalesce(x->>'variantName','')=coalesce(u->>'variantName','');
  IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_RETURN_DOCUMENT_IDENTITY_REQUIRED' USING ERRCODE='23514';END IF;
  requests:=requests||jsonb_build_array(jsonb_build_object('lineId',line_id,'quantity',u->'quantity'));
 END LOOP;
 selected:=financial_private.exchange_selection(p_store,o,requests);
 FOR selection IN SELECT x FROM jsonb_array_elements(selected) x LOOP
  FOR part IN SELECT x FROM jsonb_array_elements(selection->'parts') x LOOP
   SELECT x INTO source_part FROM jsonb_array_elements(o."stockItems") x WHERE x->>'productId'=part->>'productId'
    AND coalesce(x->>'variantName','')=coalesce(part->>'variantName','') AND
     ((x->>'bundleId'=selection->>'productId') OR (nullif(x->>'bundleId','') IS NULL AND x->>'productId'=selection->>'productId'));
   IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_RETURN_DOCUMENT_IDENTITY_REQUIRED' USING ERRCODE='23514';END IF;
   physical:=physical||jsonb_build_array(source_part||jsonb_build_object('quantity',part->'quantity','costPiastres',part->'costPiastres'));
  END LOOP;
 END LOOP;
 IF EXISTS(WITH wanted AS (SELECT x->>'productId' id,coalesce(x->>'variantName','') variant,sum((x->>'quantity')::numeric) qty FROM jsonb_array_elements(physical) x GROUP BY 1,2),
  reported AS (SELECT x->>'productId' id,coalesce(x->>'variantName','') variant,sum((x->>'quantity')::numeric) qty FROM jsonb_array_elements(p_input#>'{payload,stockItems}') x GROUP BY 1,2)
  SELECT 1 FROM wanted FULL JOIN reported USING(id,variant) WHERE wanted.qty IS DISTINCT FROM reported.qty) THEN
  RAISE EXCEPTION 'NEXUS_RETURN_DOCUMENT_STOCK_MISMATCH' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(x),'[]') INTO lines FROM jsonb_array_elements(p_input->'lines') x WHERE x->>'account' NOT IN ('stock','cogs');
 FOR part IN SELECT x FROM jsonb_array_elements(physical) x LOOP
  cost:=(part->>'costPiastres')::numeric;
  lines:=lines||jsonb_build_array(jsonb_build_object('account','stock','subjectId',part->>'productId','qty',part->'quantity','amount',cost/100,'unitCost',part->'unitCost'));
  IF cost>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('account','cogs','subjectId',part->>'productId','amount',-cost/100));END IF;
 END LOOP;
 RETURN jsonb_set(p_input,'{payload,stockItems}',physical)||jsonb_build_object('lines',lines);
END $fn$;
REVOKE ALL ON FUNCTION financial_private.fulfillment_return_input(uuid,jsonb) FROM PUBLIC,anon,authenticated;
DO $migration$
DECLARE d text;marker text;
BEGIN
 d:=replace(pg_get_functiondef('public.record_stock_command(text,uuid,uuid,text,jsonb)'::regprocedure),chr(13),'');
 -- This command was INVOKER. Its wrapper must retain the existing four-role
 -- check and licence/RLS financial gates while invoking the private helper.
 -- Do not elevate the whole command; expose only this tenant-validated helper
 -- in the private, unexposed schema to authenticated SQL command callers.
 marker:=' SELECT jsonb_agg(jsonb_build_object(''id'',gen_random_uuid()::text,''account'',l->>''account''';
 IF strpos(d,marker)=0 THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_RETURN_SCHEMA_DRIFT';END IF;
 EXECUTE replace(d,marker,' p_input:=financial_private.fulfillment_return_input(p_store,p_input);'||chr(10)||marker);
END $migration$;
GRANT EXECUTE ON FUNCTION financial_private.fulfillment_return_input(uuid,jsonb) TO authenticated;
