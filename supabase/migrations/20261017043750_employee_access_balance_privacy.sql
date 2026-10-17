-- Employee presets and company-balance confidentiality. No data/history rewrite.
-- Baseline: Production 624e557, 55 applied migrations. Apply only after owner approval.
ALTER TABLE public.store_members DROP CONSTRAINT store_members_role_check;
ALTER TABLE public.store_members ADD CONSTRAINT store_members_role_check CHECK
 (role IN ('ADMIN','CASHIER_ONLY','POS_ECOMMERCE','ECOMMERCE_ONLY','ACCOUNTANT','MODERATOR'));
CREATE OR REPLACE FUNCTION public.can_read_store_finance(p_store_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
 SELECT auth.uid() IS NOT NULL AND coalesce(public.has_role(p_store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false)
$fn$;
REVOKE ALL ON FUNCTION public.can_read_store_finance(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.can_read_store_finance(uuid) TO authenticated;
-- The only new catalog write is linking a POS customer. No product/price,
-- stock-adjustment, discount-definition, courier or finance grant is added.
CREATE POLICY cashier_customer_insert ON public.customers FOR INSERT TO authenticated
 WITH CHECK (public.has_role(store_id,VARIADIC ARRAY['CASHIER_ONLY']));
CREATE POLICY cashier_discount_read ON public.discount_codes FOR SELECT TO authenticated
 USING (public.has_role(store_id,VARIADIC ARRAY['CASHIER_ONLY']));

-- Only the validated POS command can authorize a POS ledger event. This is
-- transaction-local evidence, not a user-controlled setting or broad grant.
CREATE TABLE financial_private.pos_command_permits (
 transaction_id bigint NOT NULL,store_id uuid NOT NULL,event_id text NOT NULL,request jsonb NOT NULL,
 PRIMARY KEY(transaction_id,store_id,event_id));
ALTER TABLE financial_private.pos_command_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.pos_command_permits FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION financial_private.append_authorized_event(p_event jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id text := p_event->>'id';
  v_store uuid := (p_event->>'store_id')::uuid;
  v_device uuid := (p_event->>'device_id')::uuid;
  v_count integer;
  v_subject text;
BEGIN
 PERFORM financial_private.fulfillment_lock(v_store);
  IF v_id IS NULL OR v_store IS NULL OR v_device IS NULL THEN
    RAISE EXCEPTION 'ledger_append: identity required' USING ERRCODE='23514';
  END IF;
  IF p_event->>'kind' IS NULL OR jsonb_typeof(coalesce(p_event->'lines','[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'ledger_append: kind and lines array required' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_event->'lines','[]'::jsonb)) l
    WHERE l->>'qty_delta' IN ('NaN','Infinity','-Infinity') OR l->>'amount_delta' IN ('NaN','Infinity','-Infinity') OR l->>'unit_cost' IN ('NaN','Infinity','-Infinity')) THEN
    RAISE EXCEPTION 'ledger_append: finite line values required' USING ERRCODE='23514';
  END IF;
  IF p_event->>'ref_type'='ecommerce_order' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_event->'lines') l WHERE l->>'account'='stock') THEN
    PERFORM 1 FROM public.orders WHERE store_id=v_store AND "orderNumber"=p_event->>'ref_id' ORDER BY id FOR UPDATE;
  END IF;
  FOR v_subject IN SELECT DISTINCT l->>'subject_id' FROM jsonb_array_elements(p_event->'lines') l WHERE l->>'account'='stock' ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('pos-stock:'||v_store::text||':'||v_subject,0));
  END LOOP;
  PERFORM 1 FROM public.products WHERE store_id=v_store AND id IN (SELECT l->>'subject_id' FROM jsonb_array_elements(p_event->'lines') l WHERE l->>'account'='stock') ORDER BY id FOR UPDATE;
  PERFORM public.ledger_validate_event(p_event);
  INSERT INTO public.ledger_events(id,store_id,device_id,kind,occurred_at,created_at,actor,ref_type,ref_id,payload,sync_status,command_request,command_result)
  VALUES(v_id,v_store,v_device,p_event->>'kind',p_event->>'occurred_at',p_event->>'created_at',p_event->>'actor',p_event->>'ref_type',p_event->>'ref_id',coalesce(p_event->>'payload','{}'),'synced',p_event->'command_request',p_event->'command_result');
  INSERT INTO public.ledger_lines(id,event_id,store_id,device_id,account,subject_id,qty_delta,amount_delta,unit_cost,sync_status)
  SELECT l->>'id',v_id,v_store,v_device,l->>'account',l->>'subject_id',coalesce((l->>'qty_delta')::real,0),coalesce((l->>'amount_delta')::integer,0),nullif(l->>'unit_cost','')::integer,'synced'
  FROM jsonb_array_elements(p_event->'lines') l;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> jsonb_array_length(coalesce(p_event->'lines','[]'::jsonb)) THEN
    RAISE EXCEPTION 'ledger_append: not all lines were written' USING ERRCODE='23514';
  END IF;
  PERFORM financial_private.apply_stock_event(v_id);
  PERFORM financial_private.allocate_backorders(v_id);
  PERFORM financial_private.finish_exchange_credit_event(v_id);
  RETURN v_id;
END $function$;

REVOKE ALL ON FUNCTION financial_private.append_authorized_event(jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.ledger_append(p_event jsonb) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE s uuid:=(p_event->>'store_id')::uuid;k text:=p_event->>'kind';ok boolean;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NEXUS_LEDGER_FORBIDDEN' USING ERRCODE='42501';END IF;
 ok:=CASE WHEN k IN ('owner_capital','owner_contribution') THEN public.has_role(s,VARIADIC ARRAY['ADMIN'])
  WHEN k IN ('stock_adjustment','purchase','supplier_payment','expense','payroll','owner_draw','wallet_transfer','deposit_refunded')
   THEN public.has_role(s,VARIADIC ARRAY['ADMIN','ACCOUNTANT'])
  WHEN public.member_role(s)='CASHIER_ONLY' THEN k='sale' AND p_event->>'ref_type'='pos_sale' AND public.has_role(s,VARIADIC ARRAY['CASHIER_ONLY'])
  ELSE public.has_role(s,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY']) END;
 IF NOT coalesce(ok,false) THEN RAISE EXCEPTION 'NEXUS_LEDGER_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF k='sale' AND p_event->>'ref_type'='pos_sale' AND NOT EXISTS (
  SELECT 1 FROM financial_private.pos_command_permits p WHERE p.transaction_id=txid_current() AND p.store_id=s
   AND p.event_id=p_event->>'id' AND p.request=p_event->'command_request') THEN
  RAISE EXCEPTION 'NEXUS_POS_COMMAND_REQUIRED' USING ERRCODE='42501';END IF;
 RETURN financial_private.append_authorized_event(p_event);
END $fn$;
REVOKE ALL ON FUNCTION public.ledger_append(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ledger_append(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_pos_sale(p_id text, p_store uuid, p_device uuid, p_command text, p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_request jsonb := jsonb_build_object('command',p_command,'input',p_input);
  v_old public.ledger_events;
  v_lines jsonb;
  v_result jsonb := jsonb_build_object('eventId',p_id,'replayed',false);
  v_now text := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_source text := nullif(p_input->'payload'->>'returnOfEventId','');
  v_payload jsonb;
  v_item jsonb;
  v_subject text;
  v_available numeric;
  v_qty numeric;
  v_original numeric;
  v_returned numeric;
  v_cost numeric;
  v_value numeric;
  v_previous_qty numeric;
  v_refund numeric:=0;
  v_line_net numeric;
  v_gross numeric;
  v_net numeric;
  v_prior_gross numeric;
  v_expected_stock jsonb := '{}'::jsonb;
  v_component jsonb;
  v_recipe jsonb;
  v_write_payload jsonb := p_input->'payload';
  v_ltv_count integer;
BEGIN
 PERFORM financial_private.fulfillment_lock(p_store);
  IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','CASHIER_ONLY']),false) THEN
    RAISE EXCEPTION 'NEXUS_POS_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF nullif(p_id,'') IS NULL OR p_device IS NULL OR p_command IS DISTINCT FROM 'pos_sale'
     OR p_input->>'kind' IS DISTINCT FROM 'sale' OR p_input->>'refType' IS DISTINCT FROM 'pos_sale'
     OR jsonb_typeof(p_input->'payload'->'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'NEXUS_POS_INVALID' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-operation:'||p_id,0));
  SELECT * INTO v_old FROM public.ledger_events WHERE id=p_id AND store_id=p_store;
  IF FOUND THEN
    IF v_old.command_request IS DISTINCT FROM v_request OR v_old.command_result IS NULL THEN
      RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514';
    END IF;
    RETURN v_old.command_result || jsonb_build_object('replayed',true);
  END IF;
  SELECT jsonb_agg(jsonb_build_object('id',gen_random_uuid()::text,'account',l->>'account','subject_id',l->>'subjectId',
    'qty_delta',coalesce((l->>'qty')::numeric,0),'amount_delta',floor(coalesce((l->>'amount')::numeric,0)*100+0.5),
    'unit_cost',floor((l->>'unitCost')::numeric*100+0.5))) INTO v_lines FROM jsonb_array_elements(p_input->'lines') l;
  SELECT jsonb_agg(jsonb_build_object('id',gen_random_uuid()::text,'account',account,'subject_id',subject,
    'qty_delta',qty,'amount_delta',amount,'unit_cost',unit_cost)) INTO v_lines FROM
    (SELECT l->>'account' account,l->>'subject_id' subject,sum((l->>'qty_delta')::numeric) qty,
      sum((l->>'amount_delta')::numeric) amount,max((l->>'unit_cost')::numeric) unit_cost
      FROM jsonb_array_elements(v_lines) l GROUP BY l->>'account',l->>'subject_id') grouped;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_lines) l WHERE l->>'account' NOT IN ('stock','cogs','wallet','revenue','customer_ltv'))
     OR coalesce((p_input->'payload'->>'discountAmount')::numeric,0)<0 THEN
    RAISE EXCEPTION 'NEXUS_POS_INVALID' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(p_input->'payload'->'items')=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'payload'->'items') i
    WHERE nullif(i->>'productId','') IS NULL OR (i->>'quantity') IS NULL OR (i->>'quantity')::numeric=0
      OR (i->>'quantity')::numeric::text IN ('NaN','Infinity','-Infinity') OR (i->>'unitPrice') IS NULL
      OR (i->>'unitPrice')::numeric<0 OR (i->>'unitPrice')::numeric::text IN ('NaN','Infinity','-Infinity')
      OR (v_source IS NULL AND (i->>'quantity')::numeric<0) OR (v_source IS NOT NULL AND (i->>'quantity')::numeric>0)) THEN
    RAISE EXCEPTION 'NEXUS_POS_RECEIPT_REQUIRED' USING ERRCODE='23514'; END IF;
  IF v_source IS NULL THEN
    SELECT round((sum((i->>'quantity')::numeric*(i->>'unitPrice')::numeric)
      -coalesce((p_input->'payload'->>'discountAmount')::numeric,0))*100) INTO v_net
      FROM jsonb_array_elements(p_input->'payload'->'items') i;
    IF v_net<0 OR v_net::text IN ('NaN','Infinity','-Infinity') OR
       (SELECT sum((l->>'amount_delta')::numeric) FROM jsonb_array_elements(v_lines) l WHERE l->>'account'='wallet') IS DISTINCT FROM v_net OR
       (SELECT sum((l->>'amount_delta')::numeric) FROM jsonb_array_elements(v_lines) l WHERE l->>'account'='revenue') IS DISTINCT FROM v_net THEN
      RAISE EXCEPTION 'NEXUS_POS_VALUE_MISMATCH' USING ERRCODE='23514'; END IF;
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_input->'payload'->'items') LOOP
      SELECT CASE WHEN p."isBundle" THEN p."bundleItems" ELSE jsonb_build_array(jsonb_build_object('productId',p.id,'quantity',1)) END
        INTO v_recipe FROM public.products p WHERE p.id=v_item->>'productId' AND p.store_id=p_store AND p.deleted_at IS NULL AND coalesce(p."isActive",true);
      IF v_recipe IS NULL OR jsonb_array_length(v_recipe)=0 THEN RAISE EXCEPTION 'NEXUS_POS_PRODUCT_INVALID' USING ERRCODE='23514'; END IF;
      FOR v_component IN SELECT * FROM jsonb_array_elements(v_recipe) LOOP
        v_subject:=v_component->>'productId';
        v_expected_stock:=jsonb_set(v_expected_stock,ARRAY[v_subject],to_jsonb(coalesce((v_expected_stock->>v_subject)::numeric,0)
          -(v_item->>'quantity')::numeric*(v_component->>'quantity')::numeric));
      END LOOP;
    END LOOP;
    IF EXISTS (SELECT 1 FROM jsonb_each_text(v_expected_stock) e FULL JOIN
      (SELECT l->>'subject_id' subject,(l->>'qty_delta')::numeric qty FROM jsonb_array_elements(v_lines) l WHERE l->>'account'='stock') actual ON actual.subject=e.key
      WHERE actual.qty IS DISTINCT FROM e.value::numeric) THEN
      RAISE EXCEPTION 'NEXUS_POS_STOCK_MISMATCH' USING ERRCODE='23514'; END IF;
  END IF;
  -- Deterministic component lock order also covers a box and its loose items.
  FOR v_subject IN SELECT DISTINCT l->>'subject_id' FROM jsonb_array_elements(v_lines) l
    WHERE l->>'account'='stock' ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('pos-stock:'||p_store::text||':'||v_subject,0));
    SELECT coalesce(sum(qty_delta),0),coalesce(sum(amount_delta),0) INTO v_available,v_value FROM public.ledger_lines WHERE store_id=p_store AND account='stock' AND subject_id=v_subject;
    SELECT sum((l->>'qty_delta')::numeric) INTO v_qty FROM jsonb_array_elements(v_lines) l WHERE l->>'account'='stock' AND l->>'subject_id'=v_subject;
    IF v_qty < 0 AND v_available+v_qty < 0 THEN RAISE EXCEPTION 'NEXUS_STOCK_SHORT' USING ERRCODE='23514'; END IF;
    SELECT sum((l->>'amount_delta')::numeric) INTO v_cost FROM jsonb_array_elements(v_lines) l WHERE l->>'account'='stock' AND l->>'subject_id'=v_subject;
    IF v_qty<0 AND v_cost IS DISTINCT FROM round(v_qty*v_value/nullif(v_available,0)) THEN
      RAISE EXCEPTION 'NEXUS_STOCK_COST_CHANGED' USING ERRCODE='23514'; END IF;
    IF v_cost IS DISTINCT FROM -(SELECT coalesce(sum((l->>'amount_delta')::numeric),0) FROM jsonb_array_elements(v_lines) l WHERE l->>'account'='cogs' AND l->>'subject_id'=v_subject) THEN
      RAISE EXCEPTION 'NEXUS_POS_COST_MISMATCH' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF v_source IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('pos-return:'||p_store::text||':'||v_source,0));
    SELECT payload::jsonb INTO v_payload FROM public.ledger_events WHERE id=v_source AND store_id=p_store AND kind='sale' AND ref_type='pos_sale';
    IF NOT FOUND OR v_payload->>'returnOfEventId' IS NOT NULL THEN RAISE EXCEPTION 'NEXUS_POS_RECEIPT_REQUIRED' USING ERRCODE='23514'; END IF;
    SELECT sum((i->>'quantity')::numeric*(i->>'unitPrice')::numeric) INTO v_gross FROM jsonb_array_elements(v_payload->'items') i;
    SELECT sum(amount_delta) INTO v_net FROM public.ledger_lines WHERE store_id=p_store AND event_id=v_source AND account='revenue';
    FOR v_item IN SELECT jsonb_build_object('productId',i->>'productId','variantName',coalesce(i->>'variantName',''),'quantity',sum(-(i->>'quantity')::numeric))
      FROM jsonb_array_elements(p_input->'payload'->'items') i GROUP BY i->>'productId',coalesce(i->>'variantName','') LOOP
      v_qty := (v_item->>'quantity')::numeric;
      SELECT coalesce(sum((i->>'quantity')::numeric),0) INTO v_original FROM jsonb_array_elements(v_payload->'items') i
        WHERE i->>'productId'=v_item->>'productId' AND coalesce(i->>'variantName','')=v_item->>'variantName';
      SELECT coalesce(sum(-(i->>'quantity')::numeric),0) INTO v_returned FROM public.ledger_events e,
        LATERAL jsonb_array_elements(e.payload::jsonb->'items') i WHERE e.store_id=p_store AND e.kind='sale' AND e.ref_type='pos_sale'
        AND e.payload::jsonb->>'returnOfEventId'=v_source AND i->>'productId'=v_item->>'productId'
        AND coalesce(i->>'variantName','')=v_item->>'variantName';
      IF v_qty <= 0 OR v_qty > v_original-v_returned THEN RAISE EXCEPTION 'NEXUS_POS_RETURN_LIMIT' USING ERRCODE='23514'; END IF;
      -- Tie component restoration to the selected receipt quantity, not merely
      -- the receipt's aggregate maximum. New receipts carry their recipe.
      SELECT i->'bundleItems' INTO v_recipe FROM jsonb_array_elements(v_payload->'items') i
        WHERE i->>'productId'=v_item->>'productId' AND coalesce(i->>'variantName','')=v_item->>'variantName' LIMIT 1;
      IF v_recipe IS NULL AND EXISTS(SELECT 1 FROM public.products p WHERE p.id=v_item->>'productId' AND p.store_id=p_store AND p."isBundle") THEN
        IF jsonb_array_length(v_payload->'items')<>1 THEN RAISE EXCEPTION 'NEXUS_POS_LEGACY_BOX_REVIEW' USING ERRCODE='23514'; END IF;
        SELECT jsonb_agg(jsonb_build_object('productId',subject_id,'quantity',-qty_delta/v_original)) INTO v_recipe
          FROM public.ledger_lines WHERE store_id=p_store AND event_id=v_source AND account='stock';
      END IF;
      v_recipe:=coalesce(v_recipe,jsonb_build_array(jsonb_build_object('productId',v_item->>'productId','quantity',1)));
      FOR v_component IN SELECT * FROM jsonb_array_elements(v_recipe) LOOP
        v_subject:=v_component->>'productId';
        v_expected_stock:=jsonb_set(v_expected_stock,ARRAY[v_subject],to_jsonb(coalesce((v_expected_stock->>v_subject)::numeric,0)+v_qty*(v_component->>'quantity')::numeric));
      END LOOP;
      WITH source_items AS (SELECT i,ordinality,row_number() OVER (ORDER BY ordinality) rn FROM jsonb_array_elements(v_payload->'items') WITH ORDINALITY t(i,ordinality)),
      selected AS (SELECT * FROM source_items WHERE i->>'productId'=v_item->>'productId' AND coalesce(i->>'variantName','')=v_item->>'variantName')
      SELECT coalesce((SELECT sum((i->>'quantity')::numeric*(i->>'unitPrice')::numeric) FROM source_items WHERE rn<(SELECT min(rn) FROM selected)),0),
        (SELECT sum((i->>'quantity')::numeric*(i->>'unitPrice')::numeric) FROM selected) INTO v_prior_gross,v_value;
      v_line_net:=CASE WHEN v_gross=0 AND v_net=0 THEN 0 ELSE round((v_prior_gross+v_value)*v_net/nullif(v_gross,0))-round(v_prior_gross*v_net/nullif(v_gross,0)) END;
      v_refund:=v_refund+round(v_line_net*(v_returned+v_qty)/v_original)-round(v_line_net*v_returned/v_original);
    END LOOP;
    IF EXISTS (SELECT 1 FROM jsonb_each_text(v_expected_stock) e FULL JOIN
      (SELECT l->>'subject_id' subject,(l->>'qty_delta')::numeric qty FROM jsonb_array_elements(v_lines) l WHERE l->>'account'='stock') actual ON actual.subject=e.key
      WHERE actual.qty IS DISTINCT FROM e.value::numeric) THEN
      RAISE EXCEPTION 'NEXUS_POS_STOCK_MISMATCH' USING ERRCODE='23514'; END IF;
    IF v_refund IS NULL OR (SELECT sum((l->>'amount_delta')::numeric) FROM jsonb_array_elements(v_lines) l WHERE l->>'account'='wallet') IS DISTINCT FROM -v_refund
      OR (SELECT sum((l->>'amount_delta')::numeric) FROM jsonb_array_elements(v_lines) l WHERE l->>'account'='revenue') IS DISTINCT FROM -v_refund THEN
      RAISE EXCEPTION 'NEXUS_POS_RETURN_VALUE' USING ERRCODE='23514'; END IF;
    -- A later receipt at a different cost must not reprice this return.
    FOR v_subject IN SELECT DISTINCT l->>'subject_id' FROM jsonb_array_elements(v_lines) l WHERE l->>'account'='stock' LOOP
      SELECT -sum(qty_delta),-sum(amount_delta) INTO v_original,v_cost FROM public.ledger_lines WHERE store_id=p_store AND event_id=v_source AND account='stock' AND subject_id=v_subject;
      SELECT sum((l->>'qty_delta')::numeric),sum((l->>'amount_delta')::numeric) INTO v_qty,v_returned FROM jsonb_array_elements(v_lines) l WHERE l->>'account'='stock' AND l->>'subject_id'=v_subject;
      IF v_original IS NULL OR v_original<=0 OR v_qty<=0 OR abs(v_returned-round(v_qty*v_cost/v_original))>1 THEN
        RAISE EXCEPTION 'NEXUS_POS_RETURN_COST' USING ERRCODE='23514';
      END IF;
      SELECT coalesce(sum(l.qty_delta),0) INTO v_previous_qty FROM public.ledger_lines l JOIN public.ledger_events e ON e.id=l.event_id
        WHERE e.store_id=p_store AND e.ref_type='pos_sale' AND e.payload::jsonb->>'returnOfEventId'=v_source AND l.account='stock' AND l.subject_id=v_subject;
      IF v_previous_qty+v_qty>v_original THEN RAISE EXCEPTION 'NEXUS_POS_RETURN_LIMIT' USING ERRCODE='23514'; END IF;
      v_value:=round((v_previous_qty+v_qty)*v_cost/v_original)-round(v_previous_qty*v_cost/v_original);
      SELECT jsonb_agg(CASE WHEN l->>'subject_id'=v_subject AND l->>'account'='stock' THEN jsonb_set(l,'{amount_delta}',to_jsonb(v_value))
        WHEN l->>'subject_id'=v_subject AND l->>'account'='cogs' THEN jsonb_set(l,'{amount_delta}',to_jsonb(-v_value)) ELSE l END) INTO v_lines FROM jsonb_array_elements(v_lines) l;
    END LOOP;
  END IF;
  -- Customer spend follows the immutable receipt, never the cashier's current
  -- customer picker. Preserve request identity but derive this reporting line.
  SELECT coalesce(jsonb_agg(l),'[]'::jsonb) INTO v_lines FROM jsonb_array_elements(v_lines) l WHERE l->>'account'<>'customer_ltv';
  IF v_source IS NOT NULL THEN
    v_write_payload := (v_write_payload - 'customerId' - 'customerName' - 'customerPhone') ||
      jsonb_strip_nulls(jsonb_build_object('customerId',v_payload->>'customerId','customerName',v_payload->>'customerName','customerPhone',v_payload->>'customerPhone'));
  END IF;
  v_subject := nullif(v_write_payload->>'customerId','');
  IF v_source IS NOT NULL THEN
    SELECT count(*) INTO v_ltv_count FROM public.ledger_lines WHERE store_id=p_store AND event_id=v_source AND account='customer_ltv';
    IF v_ltv_count>1 THEN RAISE EXCEPTION 'NEXUS_POS_CUSTOMER_HISTORY_REVIEW' USING ERRCODE='23514'; END IF;
    SELECT subject_id INTO v_subject FROM public.ledger_lines WHERE store_id=p_store AND event_id=v_source AND account='customer_ltv';
    IF v_ltv_count=1 AND NOT EXISTS(SELECT 1 FROM public.ledger_lines WHERE store_id=p_store AND event_id=v_source AND account='customer_ltv' AND amount_delta=v_net) THEN
      RAISE EXCEPTION 'NEXUS_POS_CUSTOMER_HISTORY_REVIEW' USING ERRCODE='23514'; END IF;
  END IF;
  IF v_subject IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.customers WHERE id=v_subject AND store_id=p_store) THEN
      RAISE EXCEPTION 'NEXUS_POS_CUSTOMER_INVALID' USING ERRCODE='23514'; END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','customer_ltv',
      'subject_id',v_subject,'qty_delta',0,'amount_delta',CASE WHEN v_source IS NULL THEN v_net ELSE -v_refund END));
  END IF;

  IF v_source IS NULL THEN
   v_write_payload:=(v_write_payload-'sourceDocumentNumber')||jsonb_build_object('documentNumber',financial_private.allocate_document_number(p_store,'pos',p_id));
  ELSE
   v_write_payload:=(v_write_payload-'documentNumber')||jsonb_build_object('sourceDocumentNumber',coalesce(nullif(v_payload->>'documentNumber',''),v_source));
  END IF;
  v_result:=v_result||jsonb_strip_nulls(jsonb_build_object('documentNumber',v_write_payload->>'documentNumber','sourceDocumentNumber',v_write_payload->>'sourceDocumentNumber'));
  INSERT INTO financial_private.pos_command_permits VALUES(txid_current(),p_store,p_id,v_request);
  PERFORM public.ledger_append(jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'kind','sale','actor',p_input->>'actor',
    'ref_type','pos_sale','ref_id',p_input->>'refId','occurred_at',v_now,'created_at',v_now,'payload',v_write_payload::text,
    'lines',v_lines,'command_request',v_request,'command_result',v_result));
  DELETE FROM financial_private.pos_command_permits WHERE transaction_id=txid_current() AND store_id=p_store AND event_id=p_id;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_pos_exchange(p_id text, p_store uuid, p_device uuid, p_command text, p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 request jsonb:=jsonb_build_object('command',p_command,'input',p_input);
 saved financial_private.pos_exchange_commands;
 source jsonb; source_id text:=p_input->'return'->'payload'->>'returnOfEventId';
 item jsonb; original jsonb; component jsonb; recipe jsonb; product public.products;
 returns jsonb:='[]'; sales jsonb:='[]'; catalog jsonb:='{}'; all_ids text[];
 subject text; variants jsonb; variant text; delta numeric; available numeric; value numeric;
 costs jsonb:='{}'; quantities jsonb:='{}'; normalized jsonb:='[]'; components jsonb;
 return_input jsonb:=p_input->'return'; sale_input jsonb:=p_input->'replacement';
 sale_lines jsonb:='[]'; result jsonb; returned jsonb; sold jsonb;
 net numeric; refund numeric; gross numeric; discount numeric;
 now_text text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
 PERFORM financial_private.fulfillment_lock(p_store);
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','CASHIER_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF nullif(p_id,'') IS NULL OR p_device IS NULL OR p_command IS DISTINCT FROM 'pos_exchange'
  OR nullif(source_id,'') IS NULL OR jsonb_typeof(return_input->'payload'->'items') IS DISTINCT FROM 'array'
  OR jsonb_typeof(sale_input->'payload'->'items') IS DISTINCT FROM 'array'
  OR jsonb_array_length(return_input->'payload'->'items')=0 OR jsonb_array_length(sale_input->'payload'->'items')=0
  OR return_input->'payload'->>'walletId' IS DISTINCT FROM sale_input->'payload'->>'walletId'
  OR sale_input->'payload'->>'returnOfEventId' IS NOT NULL THEN
  RAISE EXCEPTION 'NEXUS_POS_EXCHANGE_INVALID' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(return_input->'lines') l WHERE l->>'account'='wallet'
   AND l->>'subjectId' IS DISTINCT FROM return_input->'payload'->>'walletId')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(return_input->'payload'->'items') i GROUP BY i->>'productId',coalesce(i->>'variantName','') HAVING count(*)>1)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(sale_input->'payload'->'items') i GROUP BY i->>'productId',coalesce(i->>'variantName','') HAVING count(*)>1) THEN
  RAISE EXCEPTION 'NEXUS_POS_EXCHANGE_INVALID' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pos-exchange:'||p_id,0));
 SELECT * INTO saved FROM financial_private.pos_exchange_commands WHERE id=p_id;
 IF FOUND THEN
  IF saved.store_id<>p_store OR saved.request IS DISTINCT FROM request THEN
   RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN saved.result||jsonb_build_object('replayed',true);
 END IF;
 SELECT payload::jsonb INTO source FROM public.ledger_events WHERE id=source_id AND store_id=p_store AND kind='sale' AND ref_type='pos_sale';
 IF NOT FOUND OR source->>'returnOfEventId' IS NOT NULL THEN RAISE EXCEPTION 'NEXUS_POS_RECEIPT_REQUIRED' USING ERRCODE='23514'; END IF;
 -- Expand returns from the IMMUTABLE sold recipe. Never trust a caller's
 -- variant/component definition or the current bundle recipe for a refund.
 FOR item IN SELECT x FROM jsonb_array_elements(return_input->'payload'->'items') x LOOP
  IF (item->>'quantity')::numeric>=0 THEN RAISE EXCEPTION 'NEXUS_POS_EXCHANGE_INVALID' USING ERRCODE='23514'; END IF;
  SELECT x INTO original FROM jsonb_array_elements(source->'items') x WHERE x->>'productId'=item->>'productId'
   AND coalesce(x->>'variantName','')=coalesce(item->>'variantName','') LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_POS_RECEIPT_REQUIRED' USING ERRCODE='23514'; END IF;
  recipe:=original->'bundleItems';
  IF coalesce((original->>'isBundle')::boolean,false) AND (recipe IS NULL OR jsonb_typeof(recipe)<>'array' OR jsonb_array_length(recipe)=0) THEN
   RAISE EXCEPTION 'NEXUS_POS_LEGACY_BOX_REVIEW' USING ERRCODE='23514'; END IF;
  recipe:=coalesce(recipe,jsonb_build_array(jsonb_build_object('productId',item->>'productId','variantName',item->>'variantName','quantity',1)));
  FOR component IN SELECT x FROM jsonb_array_elements(recipe) x LOOP
   returns:=returns||jsonb_build_array(jsonb_build_object('productId',component->>'productId','variantName',component->>'variantName',
    'quantity',-(item->>'quantity')::numeric*(component->>'quantity')::numeric));
  END LOOP;
 END LOOP;
 -- Snapshot current replacement recipes, then verify them again under locks.
 FOR item IN SELECT x FROM jsonb_array_elements(sale_input->'payload'->'items') x LOOP
  IF (item->>'quantity')::numeric<=0 THEN RAISE EXCEPTION 'NEXUS_POS_EXCHANGE_INVALID' USING ERRCODE='23514'; END IF;
  SELECT * INTO product FROM public.products WHERE id=item->>'productId' AND store_id=p_store AND deleted_at IS NULL AND "isActive";
  IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_POS_PRODUCT_INVALID' USING ERRCODE='23514'; END IF;
  catalog:=jsonb_set(catalog,ARRAY[product.id],to_jsonb(product));
  recipe:=CASE WHEN product."isBundle" THEN product."bundleItems" ELSE jsonb_build_array(jsonb_build_object('productId',product.id,'variantName',item->>'variantName','quantity',1)) END;
  IF jsonb_typeof(recipe) IS DISTINCT FROM 'array' OR jsonb_array_length(recipe)=0 THEN RAISE EXCEPTION 'NEXUS_POS_PRODUCT_INVALID' USING ERRCODE='23514'; END IF;
  FOR component IN SELECT x FROM jsonb_array_elements(recipe) x LOOP
   sales:=sales||jsonb_build_array(jsonb_build_object('productId',component->>'productId','variantName',component->>'variantName',
    'quantity',-(item->>'quantity')::numeric*(component->>'quantity')::numeric));
  END LOOP;
 END LOOP;
 SELECT array_agg(id ORDER BY id) INTO all_ids FROM (SELECT DISTINCT x->>'productId' id FROM jsonb_array_elements(returns||sales) x
  UNION SELECT key FROM jsonb_object_keys(catalog) key) ids;
 -- Same stock namespace as purchasing, POS and reservations, all before rows.
 FOREACH subject IN ARRAY all_ids LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-stock:'||p_store::text||':'||subject,0));
 END LOOP;
 PERFORM 1 FROM public.products WHERE store_id=p_store AND id=ANY(all_ids) ORDER BY id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended('pos-return:'||p_store::text||':'||source_id,0));
 FOR item IN SELECT x FROM jsonb_array_elements(sale_input->'payload'->'items') x LOOP
  SELECT * INTO product FROM public.products WHERE id=item->>'productId' AND store_id=p_store AND deleted_at IS NULL AND "isActive";
  IF NOT FOUND OR product."bundleItems" IS DISTINCT FROM catalog->product.id->'bundleItems'
   OR product."isBundle" IS DISTINCT FROM (catalog->product.id->>'isBundle')::boolean THEN
   RAISE EXCEPTION 'NEXUS_POS_CATALOG_CHANGED' USING ERRCODE='23514'; END IF;
  IF product."isBundle" THEN PERFORM public.validate_bundle_definition(p_store,product.id,product."bundleItems"); END IF;
 END LOOP;
 -- Validate exact identities and reject historical variant drift, not repair it.
 FOREACH subject IN ARRAY all_ids LOOP
  SELECT * INTO product FROM public.products WHERE id=subject AND store_id=p_store;
  IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_POS_PRODUCT_INVALID' USING ERRCODE='23514'; END IF;
  IF product."isBundle" THEN CONTINUE; END IF;
  variants:=coalesce(nullif(product.metadata->'variants','null'::jsonb),'[]');
  IF jsonb_typeof(variants)<>'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(variants) v GROUP BY v->>'name' HAVING count(*)>1)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(variants) v WHERE nullif(v->>'name','') IS NULL OR v->>'stock' IS NULL
    OR (v->>'stock')::numeric<0 OR (v->>'stock')::numeric::text IN ('NaN','Infinity','-Infinity')) THEN
   RAISE EXCEPTION 'NEXUS_POS_VARIANT_REVIEW' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(qty_delta::numeric),0) INTO available FROM public.ledger_lines WHERE store_id=p_store AND account='stock' AND subject_id=subject;
  IF jsonb_array_length(variants)>0 AND (SELECT sum((v->>'stock')::numeric) FROM jsonb_array_elements(variants) v) IS DISTINCT FROM available THEN
   RAISE EXCEPTION 'NEXUS_POS_VARIANT_REVIEW' USING ERRCODE='23514'; END IF;
  FOR component IN SELECT x FROM jsonb_array_elements(returns||sales) x WHERE x->>'productId'=subject LOOP
   variant:=nullif(component->>'variantName','');
   IF (jsonb_array_length(variants)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(variants) v WHERE v->>'name'=variant))
    OR (jsonb_array_length(variants)=0 AND variant IS NOT NULL) THEN
    RAISE EXCEPTION 'NEXUS_POS_VARIANT_INVALID' USING ERRCODE='23514'; END IF;
  END LOOP;
 END LOOP;
 return_input:=return_input||jsonb_build_object('refId',p_id,'payload',(return_input->'payload')||jsonb_build_object('exchangeId',p_id,'exchangeLeg','return','replacementEventId',p_id||':replacement'));
 returned:=public.record_pos_sale(p_id,p_store,p_device,'pos_sale',return_input);
 -- Replacement COGS is the locked WAC AFTER historical stock restoration.
 -- Derive stock/cost lines here rather than trusting stale client costOf().
 FOR component IN SELECT x FROM jsonb_array_elements(sales) x LOOP
  subject:=component->>'productId';
  SELECT coalesce(sum(qty_delta::numeric),0),coalesce(sum(amount_delta),0) INTO available,value FROM public.ledger_lines WHERE store_id=p_store AND account='stock' AND subject_id=subject;
  IF available<=0 THEN RAISE EXCEPTION 'NEXUS_STOCK_SHORT' USING ERRCODE='23514'; END IF;
  costs:=jsonb_set(costs,ARRAY[subject],to_jsonb(value/available/100));
  quantities:=jsonb_set(quantities,ARRAY[subject],to_jsonb(coalesce((quantities->>subject)::numeric,0)+(component->>'quantity')::numeric));
 END LOOP;
 FOR subject IN SELECT key FROM jsonb_each(quantities) ORDER BY key LOOP
  delta:=(quantities->>subject)::numeric;value:=round(delta*(costs->>subject)::numeric*100);
  sale_lines:=sale_lines||jsonb_build_array(jsonb_build_object('account','stock','subjectId',subject,'qty',delta,'amount',value/100),
   jsonb_build_object('account','cogs','subjectId',subject,'amount',-value/100));
 END LOOP;
 FOR item IN SELECT x FROM jsonb_array_elements(sale_input->'payload'->'items') x LOOP
  SELECT * INTO product FROM public.products WHERE id=item->>'productId' AND store_id=p_store;
  components:='[]';
  IF product."isBundle" THEN
   FOR component IN SELECT x FROM jsonb_array_elements(product."bundleItems") x LOOP
    components:=components||jsonb_build_array(component||jsonb_build_object('unitCost',(costs->>(component->>'productId'))::numeric));
   END LOOP;
  END IF;
  normalized:=normalized||jsonb_build_array((item-'bundleItems'-'isBundle'-'unitCost')||jsonb_build_object('productName',product.name,
   'isBundle',product."isBundle",'unitCost',coalesce((costs->>product.id)::numeric,0))||CASE WHEN product."isBundle" THEN jsonb_build_object('bundleItems',components) ELSE '{}'::jsonb END);
 END LOOP;
 SELECT round(sum((x->>'quantity')::numeric*(x->>'unitPrice')::numeric)*100) INTO gross FROM jsonb_array_elements(normalized) x;
 discount:=round(coalesce((sale_input->'payload'->>'discountAmount')::numeric,0)*100);net:=gross-discount;
 sale_lines:=sale_lines||jsonb_build_array(jsonb_build_object('account','wallet','subjectId',sale_input->'payload'->>'walletId','amount',net/100),jsonb_build_object('account','revenue','subjectId','pos','amount',net/100));
 sale_input:=sale_input||jsonb_build_object('refId',p_id,'lines',sale_lines,'payload',
  ((sale_input->'payload')-'customerId'-'customerName'-'customerPhone')||jsonb_strip_nulls(jsonb_build_object('customerId',source->>'customerId','customerName',source->>'customerName','customerPhone',source->>'customerPhone'))||
  jsonb_build_object('items',normalized,'totalAmount',net/100,'exchangeId',p_id,'exchangeLeg','replacement','exchangeSourceEventId',source_id,'returnEventId',p_id));
 sold:=public.record_pos_sale(p_id||':replacement',p_store,p_device,'pos_sale',sale_input);
 SELECT -sum(amount_delta) INTO refund FROM public.ledger_lines WHERE store_id=p_store AND event_id=p_id AND account='wallet';
 INSERT INTO public.return_records(id,store_id,device_id,original_order_id,type,customer_name,customer_phone,governorate,returned_items,exchanged_item,financial_difference,processed_by,notes,created_at,updated_at,sync_status)
 VALUES('pos-exchange:'||p_id,p_store,p_device,source_id,'exchange',coalesce(source->>'customerName','عميل غير مسجل'),coalesce(source->>'customerPhone',''),'POS',
  (SELECT jsonb_agg(jsonb_build_object('product_id',x->>'productId','product_name',x->>'productName','variantName',x->>'variantName','quantity',-(x->>'quantity')::numeric,'refund_amount',round(-(x->>'quantity')::numeric*(x->>'unitPrice')::numeric,2))) FROM jsonb_array_elements(return_input->'payload'->'items') x),
  (SELECT jsonb_agg(jsonb_build_object('product_id',x->>'productId','product_name',x->>'productName','variantName',x->>'variantName','quantity',(x->>'quantity')::numeric,'price',(x->>'unitPrice')::numeric)) FROM jsonb_array_elements(normalized) x),
  (net-refund)/100,'POS','استبدال ذري مرتبط بفاتورة الأصل',now(),(extract(epoch FROM clock_timestamp())*1000)::bigint,'synced');
 result:=jsonb_build_object('eventId',p_id,'returnEventId',p_id,'replacementEventId',p_id||':replacement','sourceEventId',source_id,
  'returnRecordId','pos-exchange:'||p_id,'refundPiastres',refund,'replacementPiastres',net,'netPiastres',net-refund,'affectedProductIds',to_jsonb(all_ids),'replayed',false);
 result:=result||jsonb_build_object('sourceDocumentNumber',coalesce(nullif(source->>'documentNumber',''),source_id),'replacementDocumentNumber',sold->>'documentNumber');
 INSERT INTO financial_private.pos_exchange_commands VALUES(p_id,p_store,request,result);
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.record_stock_command(p_id text, p_store uuid, p_device uuid, p_command text, p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE request jsonb:=jsonb_build_object('command',p_command,'input',p_input);
 saved public.ledger_events; lines jsonb; result jsonb;
BEGIN
 PERFORM financial_private.fulfillment_lock(p_store);
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_STOCK_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF nullif(p_id,'') IS NULL OR p_device IS NULL OR p_command<>'stock_event' OR jsonb_typeof(p_input->'lines') IS DISTINCT FROM 'array'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'lines') l WHERE l->>'account'='stock') THEN
  RAISE EXCEPTION 'NEXUS_STOCK_COMMAND_INVALID' USING ERRCODE='23514'; END IF;
 IF NOT ((p_input->>'kind'='purchase' AND p_input->>'refType'='supplier_return')
  OR (p_input->>'kind'='stock_adjustment' AND p_input->>'refType'='stock_audit')
  OR (p_input->>'kind' IN ('return_confirmed','rto_confirmed') AND p_input->>'refType'='ecommerce_order')) THEN
  RAISE EXCEPTION 'NEXUS_STOCK_CLIENT_UPDATE_REQUIRED' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('stock-command:'||p_id,0));
 SELECT * INTO saved FROM public.ledger_events WHERE id=p_id AND store_id=p_store;
 IF FOUND THEN
  IF saved.command_request IS DISTINCT FROM request OR saved.command_result IS NULL THEN
   RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN saved.command_result||jsonb_build_object('replayed',true);
 END IF;
 p_input:=financial_private.fulfillment_return_input(p_store,p_input);
 SELECT jsonb_agg(jsonb_build_object('id',gen_random_uuid()::text,'account',l->>'account','subject_id',l->>'subjectId',
  'qty_delta',coalesce((l->>'qty')::numeric,0),'amount_delta',floor(coalesce((l->>'amount')::numeric,0)*100+0.5),
  'unit_cost',floor((l->>'unitCost')::numeric*100+0.5))) INTO lines FROM jsonb_array_elements(p_input->'lines') l;
 result:=jsonb_build_object('eventId',p_id,'replayed',false);
 PERFORM public.ledger_append(jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'kind',p_input->>'kind',
  'ref_type',p_input->>'refType','ref_id',p_input->>'refId','actor',p_input->>'actor','payload',coalesce(p_input->'payload','{}')::text,
  'occurred_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'created_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'lines',lines,'command_request',request,'command_result',result));
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.order_edit_stock(p_store uuid, p_order jsonb, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE i jsonb; c jsonb; p public.products; old_sold jsonb; recipe jsonb; result jsonb:='[]'; q numeric;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'غير مسموح بتعديل الطلب' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)=0 THEN
  RAISE EXCEPTION 'يجب اختيار منتجات الطلب' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) x GROUP BY x->>'productId',coalesce(nullif(x->>'variantName',''),'') HAVING count(*)>1) THEN
  RAISE EXCEPTION 'بنود الطلب مكررة' USING ERRCODE='23514'; END IF;
 FOR i IN SELECT value FROM jsonb_array_elements(p_items) ORDER BY value->>'productId' LOOP
  q:=(i->>'quantity')::numeric;
  IF q IS NULL OR q::text IN ('NaN','Infinity','-Infinity') OR q<=0 OR q<>trunc(q) THEN
   RAISE EXCEPTION 'كمية الطلب يجب أن تكون عددًا صحيحًا موجبًا' USING ERRCODE='23514'; END IF;
  SELECT * INTO p FROM public.products WHERE id=i->>'productId' AND store_id=p_store FOR UPDATE;
  IF NOT FOUND OR p.deleted_at IS NOT NULL OR NOT coalesce(p."isActive",false) THEN
   RAISE EXCEPTION 'منتج غير متاح أو لا يخص المتجر' USING ERRCODE='23514'; END IF;
  IF coalesce(p."isBundle",false) THEN
   SELECT x INTO old_sold FROM jsonb_array_elements(p_order->'items') x WHERE x->>'productId'=p.id OR x->>'bundleId'=p.id;
   IF FOUND THEN
    SELECT jsonb_agg(jsonb_build_object('productId',x->>'productId','variantName',x->>'variantName','quantity',(x->>'quantity')::numeric/(old_sold->>'quantity')::numeric))
     INTO recipe FROM jsonb_array_elements(coalesce(p_order#>'{fulfillment,demands}',p_order->'stockItems')) x WHERE x->>'bundleId'=p.id;
    IF recipe IS NULL THEN RAISE EXCEPTION 'وصفة حجز البوكس القديمة غير مكتملة؛ راجع الطلب' USING ERRCODE='23514'; END IF;
   ELSE recipe:=p."bundleItems"; END IF;
   PERFORM public.validate_bundle_definition(p_store,p.id,recipe);
   FOR c IN SELECT value FROM jsonb_array_elements(recipe) LOOP
    result:=result||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'productId',c->>'productId',
     'variantName',c->>'variantName','productName',(SELECT name FROM public.products WHERE id=c->>'productId' AND store_id=p_store),
     'quantity',(c->>'quantity')::numeric*q,'unitPrice',0,'bundleId',p.id,'bundleName',i->>'productName'));
   END LOOP;
  ELSE
   IF nullif(i->>'bundleId','') IS NOT NULL OR (nullif(i->>'variantName','') IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(coalesce(p.metadata->'variants','[]')) v WHERE v->>'name'=i->>'variantName'))
    OR (nullif(i->>'variantName','') IS NULL AND jsonb_array_length(coalesce(p.metadata->'variants','[]'))>0) THEN
    RAISE EXCEPTION 'درجة المنتج أو ربط البوكس غير صالح' USING ERRCODE='23514'; END IF;
   result:=result||jsonb_build_array(i-'unitCost');
  END IF;
 END LOOP;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.place_order(p_order jsonb, p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_store    uuid := (p_order ->> 'store_id')::uuid;
  v_number   text := p_order ->> 'orderNumber';
  v_existing jsonb;
  v_cols     text;
  v_row      jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(v_store,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_ORDER_FORBIDDEN' USING ERRCODE='42501';END IF;
 PERFORM financial_private.fulfillment_lock(v_store);
  IF p_order#>>'{fulfillment,allowBackorder}'='true' AND NOT financial_private.has_fulfillment_permit(v_store,p_order->>'id') THEN RETURN financial_private.place_backorder(p_order,p_event);END IF;
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

CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id text, p_cause text, p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order public.orders;
  v_row   jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role((SELECT store_id FROM public.orders WHERE id=p_order_id),VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_ORDER_FORBIDDEN' USING ERRCODE='42501';END IF;
 PERFORM financial_private.fulfillment_lock((p_event->>'store_id')::uuid);
  IF p_cause IS NULL OR p_cause NOT IN ('customer', 'courier', 'shop') THEN
    RAISE EXCEPTION 'NEXUS_CAUSE_REQUIRED' USING ERRCODE = '23514';
  END IF;

  -- One cancellation at a time per order: a second press waits here, then
  -- finds it already cancelled below.
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.status = 'cancelled' THEN
    RAISE EXCEPTION 'NEXUS_ORDER_ALREADY_CANCELLED' USING ERRCODE = '23505';
  END IF;
  -- Same rule as `ACTIONS_BY_STATUS` (src/lib/orderLifecycle.ts): only an
  -- order still in the shop can be called off; once it left, it is a return.
  IF v_order.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_CANCELLABLE' USING ERRCODE = '23514';
  END IF;

  IF p_event ->> 'kind' IS DISTINCT FROM 'order_cancelled'
     OR (p_event ->> 'store_id')::uuid IS DISTINCT FROM v_order.store_id
     OR p_event ->> 'ref_type' IS DISTINCT FROM 'ecommerce_order'
     OR p_event ->> 'ref_id' IS DISTINCT FROM v_order."orderNumber" THEN
    RAISE EXCEPTION 'NEXUS_EVENT_NOT_THIS_ORDER' USING ERRCODE = '23514';
  END IF;

  -- RLS decides who may cancel; orders_guard_return_cause decides who may
  -- record courier/shop.
  UPDATE public.orders
     SET status = 'cancelled', return_cause = p_cause, "updatedAt" = now(),
         updated_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
   WHERE id = p_order_id
  RETURNING to_jsonb(orders.*) INTO v_row;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_UPDATABLE' USING ERRCODE = '42501';
  END IF;

  PERFORM public.ledger_append(p_event);
  RETURN jsonb_build_object('order', v_row);
END;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_order_return(p_order_id text, p_cause text, p_movement text, p_events jsonb, p_customer_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order public.orders;
  v_row   jsonb;
  v_cust  jsonb;
  v_n     int;
  v_i     int;
  v_ev    jsonb;
  v_now   bigint := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role((SELECT store_id FROM public.orders WHERE id=p_order_id),VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_ORDER_FORBIDDEN' USING ERRCODE='42501';END IF;
 PERFORM financial_private.fulfillment_lock((SELECT store_id FROM public.orders WHERE id=p_order_id));
  IF p_cause IS NULL OR p_cause NOT IN ('customer', 'courier', 'shop') THEN
    RAISE EXCEPTION 'NEXUS_CAUSE_REQUIRED' USING ERRCODE = '23514';
  END IF;
  IF p_movement IS NULL OR p_movement NOT IN ('return', 'exchange') THEN
    RAISE EXCEPTION 'NEXUS_MOVEMENT_REQUIRED' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array' OR jsonb_array_length(p_events) NOT IN (1, 2) THEN
    RAISE EXCEPTION 'NEXUS_EVENTS_INVALID' USING ERRCODE = '23514';
  END IF;

  -- One confirmation at a time per order: a second press waits here, then
  -- finds the first one's stamp below and is refused.
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.status IS DISTINCT FROM 'returned' THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_RETURNED' USING ERRCODE = '23514';
  END IF;
  IF v_order."returnConfirmedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'NEXUS_RETURN_ALREADY_CONFIRMED' USING ERRCODE = '23505';
  END IF;

  -- Only THIS order's events: an optional order_delivered (the refund path's
  -- auto-delivery), then exactly one return_confirmed / rto_confirmed.
  v_n := jsonb_array_length(p_events);
  FOR v_i IN 0 .. v_n - 1 LOOP
    v_ev := p_events -> v_i;
    IF (v_ev ->> 'store_id')::uuid IS DISTINCT FROM v_order.store_id
       OR v_ev ->> 'ref_type' IS DISTINCT FROM 'ecommerce_order'
       OR v_ev ->> 'ref_id' IS DISTINCT FROM v_order."orderNumber" THEN
      RAISE EXCEPTION 'NEXUS_EVENT_NOT_THIS_ORDER' USING ERRCODE = '23514';
    END IF;
    IF (v_i = v_n - 1 AND v_ev ->> 'kind' NOT IN ('return_confirmed', 'rto_confirmed'))
       OR (v_i < v_n - 1 AND v_ev ->> 'kind' IS DISTINCT FROM 'order_delivered') THEN
      RAISE EXCEPTION 'NEXUS_EVENT_KIND' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF nullif(p_customer_id,'') IS NOT NULL AND p_customer_id IS DISTINCT FROM v_order."customerId" THEN RAISE EXCEPTION 'NEXUS_TRIP_CUSTOMER_IDENTITY_REVIEW' USING ERRCODE='23514'; END IF;
  -- The document first. RLS decides who may confirm at all; the cause trigger
  -- (orders_guard_return_cause) decides who may record courier/shop.
  UPDATE public.orders
     SET "returnConfirmedAt" = now(), return_cause = p_cause, "updatedAt" = now(), updated_at = v_now
   WHERE id = p_order_id
  RETURNING to_jsonb(orders.*) INTO v_row;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_UPDATABLE' USING ERRCODE = '42501';
  END IF;

  FOR v_i IN 0 .. v_n - 1 LOOP
    v_ev:=p_events->v_i;
    IF v_ev->>'kind'='order_delivered' THEN v_ev:=financial_private.prepare_return_delivery(v_ev,p_order_id); END IF;
    PERFORM public.ledger_append(v_ev);
  END LOOP;

  PERFORM financial_private.capture_courier_claim_phase(p_events->(v_n-1)->>'id',v_order.id);
  -- A wasted trip is owed only when the CUSTOMER caused a plain return (an
  -- exchange carries the replacement out on the same journey). Same rule as
  -- `countsAsWastedTrip` in src/lib/shippingRates.ts.
  IF p_cause='customer' AND p_movement='return' THEN v_cust:=financial_private.apply_customer_trip(p_events->(v_n-1)->>'id',v_order.id,v_order.store_id,'earn'); END IF;

  -- `customer` is null when no trip was owed (or the customer is not on file).
  SELECT to_jsonb(o.*) INTO v_row FROM public.orders o WHERE id=p_order_id AND store_id=v_order.store_id;
  RETURN jsonb_build_object('order', v_row, 'customer', v_cust);
END;
$function$;

CREATE OR REPLACE FUNCTION financial_private.persist_return_document(p_event text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e public.ledger_events;o public.orders;source public.ledger_events;payload jsonb;source_payload jsonb;
 units jsonb:='[]';selected jsonb;physical jsonb:='[]';documents jsonb:='[]';replacements jsonb;u jsonb;s jsonb;part jsonb;requests jsonb:='[]';priced jsonb;
 q numeric;prior numeric;weight numeric;weights numeric:=0;refund numeric;allocated numeric:=0;line_refund numeric;ordinal integer:=0;expected_refund numeric;gross numeric;reversed numeric;
 original_id text;customer text;phone text;region text;cause text:='unknown';difference numeric;source_id text;
BEGIN
 SELECT * INTO STRICT e FROM public.ledger_events WHERE id=p_event;
 payload:=coalesce(e.payload::jsonb,'{}');
 IF NOT ((e.kind='sale' AND e.ref_type='pos_sale' AND payload->>'exchangeLeg' IS NULL
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'items') x WHERE (x->>'quantity')::numeric<0))
  OR (e.ref_type='ecommerce_order' AND e.kind IN ('return_confirmed','rto_confirmed'))) THEN RETURN;END IF;
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(e.store_id,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY','CASHIER_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_RETURN_DOCUMENT_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF public.member_role(e.store_id)='CASHIER_ONLY' AND NOT (e.kind='sale' AND e.ref_type='pos_sale') THEN
  RAISE EXCEPTION 'NEXUS_RETURN_DOCUMENT_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF e.kind='sale' AND e.ref_type='pos_sale' AND payload->>'exchangeLeg' IS NULL
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'items') x WHERE (x->>'quantity')::numeric<0) THEN
  source_id:=payload->>'returnOfEventId';
  SELECT * INTO source FROM public.ledger_events WHERE id=source_id AND store_id=e.store_id AND kind='sale' AND ref_type='pos_sale';
  IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_RETURN_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
  source_payload:=source.payload::jsonb;original_id:=source.id;customer:=source_payload->>'customerName';phone:=source_payload->>'customerPhone';region:='POS';
  SELECT jsonb_agg(x||jsonb_build_object('quantity',-(x->>'quantity')::numeric)) INTO selected FROM jsonb_array_elements(payload->'items') x WHERE (x->>'quantity')::numeric<0;
  SELECT jsonb_agg(jsonb_build_object('product_id',x->>'productId','product_name',x->>'productName','variantName',x->>'variantName','quantity',(x->>'quantity')::numeric,'price',(x->>'unitPrice')::numeric))
   INTO replacements FROM jsonb_array_elements(payload->'items') x WHERE (x->>'quantity')::numeric>0;
  SELECT coalesce(sum(floor((x->>'quantity')::numeric*(x->>'unitPrice')::numeric*100+0.5)),0) INTO refund FROM jsonb_array_elements(selected) x;
  SELECT coalesce(sum(amount_delta),0) INTO difference FROM public.ledger_lines WHERE event_id=e.id AND account='wallet';
 ELSIF e.ref_type='ecommerce_order' AND e.kind IN ('return_confirmed','rto_confirmed') THEN
  SELECT * INTO o FROM public.orders WHERE store_id=e.store_id AND "orderNumber"=e.ref_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_RETURN_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
  original_id:=o.id;customer:=o."customerName";phone:=o."customerPhone";region:=coalesce(o.governorate,'');cause:=coalesce(payload->>'return_cause',o.return_cause,'unknown');
  IF (payload ? 'returnUnits' AND (o.status<>'delivered' OR NOT o."revenueLogged"))
   OR (NOT payload ? 'returnUnits' AND (o.status<>'returned' OR o."returnConfirmedAt" IS NULL)) THEN
   RAISE EXCEPTION 'NEXUS_RETURN_DOCUMENT_SOURCE_STATE' USING ERRCODE='23514';END IF;
  -- Reconstruct sold units and per-unit historic component recipes.
  FOR s IN SELECT x FROM jsonb_array_elements(o."stockItems") x WHERE nullif(x->>'bundleId','') IS NULL LOOP
   units:=units||jsonb_build_array(s);
  END LOOP;
  FOR s IN SELECT x FROM jsonb_array_elements(o.items) x WHERE nullif(x->>'bundleId','') IS NOT NULL LOOP
   q:=(s->>'quantity')::numeric;
   SELECT jsonb_agg(x||jsonb_build_object('quantity',(x->>'quantity')::numeric/q)) INTO part FROM jsonb_array_elements(o."stockItems") x WHERE x->>'bundleId'=s->>'bundleId';
   IF q<=0 OR part IS NULL THEN RAISE EXCEPTION 'NEXUS_RETURN_BUNDLE_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
   units:=units||jsonb_build_array(s||jsonb_build_object('productId',s->>'bundleId','isBundle',true,'bundleItems',part));
  END LOOP;
  selected:=coalesce(payload->'returnUnits',units);
  IF jsonb_typeof(selected) IS DISTINCT FROM 'array' OR jsonb_array_length(selected)=0 THEN RAISE EXCEPTION 'NEXUS_RETURN_DOCUMENT_INVALID' USING ERRCODE='23514';END IF;
  FOR u IN SELECT x FROM jsonb_array_elements(selected) x LOOP
   IF (SELECT count(*) FROM jsonb_array_elements(units) x WHERE x->>'productId'=u->>'productId' AND coalesce(x->>'variantName','')=coalesce(u->>'variantName',''))<>1 THEN
    RAISE EXCEPTION 'NEXUS_RETURN_DOCUMENT_IDENTITY_REQUIRED' USING ERRCODE='23514';END IF;
   SELECT x INTO s FROM jsonb_array_elements(units) x WHERE x->>'productId'=u->>'productId' AND coalesce(x->>'variantName','')=coalesce(u->>'variantName','');
   q:=(u->>'quantity')::numeric;
   SELECT coalesce(sum((x->>'quantity')::numeric),0) INTO prior FROM public.return_records r CROSS JOIN LATERAL jsonb_array_elements(r.returned_items) x
    WHERE r.store_id=e.store_id AND r.original_order_id=o.id AND x->>'product_id'=u->>'productId' AND coalesce(x->>'variantName','')=coalesce(u->>'variantName','');
   IF q IS NULL OR q<=0 OR q::text IN ('NaN','Infinity','-Infinity') OR q+prior>(s->>'quantity')::numeric
    OR (SELECT count(*) FROM jsonb_array_elements(selected) x WHERE x->>'productId'=u->>'productId' AND coalesce(x->>'variantName','')=coalesce(u->>'variantName',''))<>1 THEN
    RAISE EXCEPTION 'NEXUS_RETURN_DOCUMENT_QUANTITY' USING ERRCODE='23514';END IF;
   IF coalesce((s->>'isBundle')::boolean,false) THEN
    FOR part IN SELECT x FROM jsonb_array_elements(s->'bundleItems') x LOOP
     physical:=physical||jsonb_build_array(jsonb_build_object('productId',part->>'productId','variantName',part->>'variantName','quantity',q*(part->>'quantity')::numeric));
    END LOOP;
   ELSE physical:=physical||jsonb_build_array(jsonb_build_object('productId',s->>'productId','variantName',s->>'variantName','quantity',q));END IF;
   documents:=documents||jsonb_build_array(s||jsonb_build_object('quantity',q));
  END LOOP;
  -- Human bundle/variant units must describe exactly the stock application.
  IF EXISTS(WITH wanted AS (SELECT x->>'productId' id,coalesce(x->>'variantName','') variant,sum((x->>'quantity')::numeric) qty FROM jsonb_array_elements(physical) x GROUP BY 1,2),
    actual AS (SELECT x->>'productId' id,coalesce(x->>'variantName','') variant,sum((x->>'delta')::numeric) qty FROM financial_private.stock_applications a CROSS JOIN LATERAL jsonb_array_elements(a.moves) x WHERE a.event_id=e.id GROUP BY 1,2)
    SELECT 1 FROM wanted FULL JOIN actual USING(id,variant) WHERE wanted.qty IS DISTINCT FROM actual.qty) THEN
   RAISE EXCEPTION 'NEXUS_RETURN_DOCUMENT_STOCK_MISMATCH' USING ERRCODE='23514';END IF;
  selected:=documents;documents:='[]';
  SELECT coalesce(sum(greatest(-amount_delta,0)),0) INTO refund FROM public.ledger_lines WHERE event_id=e.id AND account IN ('wallet','receivable_courier');
  IF payload ? 'returnUnits' THEN
   FOR u IN SELECT x FROM jsonb_array_elements(selected) x LOOP
    SELECT jsonb_build_object('lineId',coalesce(nullif(x->>'id',''),'line:'||n::text),'quantity',u->'quantity') INTO s
     FROM jsonb_array_elements(o.items) WITH ORDINALITY t(x,n)
     WHERE coalesce(nullif(x->>'bundleId',''),x->>'productId')=u->>'productId'
      AND coalesce(x->>'variantName','')=coalesce(u->>'variantName','');
    IF s IS NULL THEN RAISE EXCEPTION 'NEXUS_RETURN_DOCUMENT_IDENTITY_REQUIRED' USING ERRCODE='23514';END IF;
    requests:=requests||jsonb_build_array(s);
   END LOOP;
   priced:=financial_private.exchange_selection(e.store_id,o,requests);
   SELECT coalesce(sum((x->>'refundPiastres')::numeric),0) INTO expected_refund FROM jsonb_array_elements(priced) x;
   SELECT -coalesce(sum(amount_delta),0) INTO reversed FROM public.ledger_lines WHERE event_id=e.id AND account='revenue';
   IF refund<>expected_refund OR reversed<>expected_refund OR EXISTS(SELECT 1 FROM public.ledger_lines WHERE event_id=e.id AND account IN ('receivable_courier','payable_courier','expense')) THEN
    RAISE EXCEPTION 'NEXUS_RETURN_DOCUMENT_REFUND_MISMATCH' USING ERRCODE='23514';END IF;
  END IF;
  difference:=-refund;
  IF payload ? 'return_cause' THEN
   -- This invokes the existing role/cause guard; no permission is broadened.
   UPDATE public.orders SET return_cause=cause,updated_at=greatest(updated_at+1,(extract(epoch FROM clock_timestamp())*1000)::bigint),"updatedAt"=now() WHERE id=o.id AND store_id=e.store_id;
  END IF;
 ELSE RETURN;
 END IF;
 SELECT coalesce(sum((x->>'quantity')::numeric*coalesce((x->>'unitPrice')::numeric,0)),0) INTO weights FROM jsonb_array_elements(selected) x;
 FOR u IN SELECT x FROM jsonb_array_elements(selected) x LOOP
  ordinal:=ordinal+1;weight:=(u->>'quantity')::numeric*coalesce((u->>'unitPrice')::numeric,0);
  line_refund:=CASE WHEN ordinal=jsonb_array_length(selected) THEN refund-allocated WHEN weights>0 THEN floor(refund*weight/weights) ELSE 0 END;
  s:=NULL;
  IF priced IS NOT NULL THEN
   SELECT x INTO STRICT s FROM jsonb_array_elements(priced) x WHERE x->>'productId'=u->>'productId' AND coalesce(x->>'variantName','')=coalesce(u->>'variantName','');
   line_refund:=(s->>'refundPiastres')::numeric;
  END IF;
  allocated:=allocated+line_refund;
  documents:=documents||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('product_id',u->>'productId','product_name',coalesce(u->>'productName',u->>'productId'),
   'variantName',u->>'variantName','quantity',(u->>'quantity')::numeric,'refund_amount',line_refund/100,'lineId',s->>'lineId','unitNumbers',s->'unitNumbers')));
 END LOOP;
 INSERT INTO public.return_records(id,store_id,device_id,original_order_id,type,customer_name,customer_phone,governorate,returned_items,exchanged_item,financial_difference,processed_by,notes,created_at,updated_at,sync_status,return_cause)
 VALUES('return:'||e.id,e.store_id,e.device_id,original_id,CASE WHEN replacements IS NOT NULL THEN 'exchange' ELSE 'return' END,coalesce(customer,'عميل غير مسجل'),coalesce(phone,''),region,documents,replacements,difference/100,
  coalesce(e.actor,'مرتجعات'),coalesce(payload->>'notes','مستند ذري مرتبط بالعملية المالية '||e.id),e.occurred_at::timestamptz,(extract(epoch FROM clock_timestamp())*1000)::bigint,'synced',cause);
END $function$;

CREATE OR REPLACE FUNCTION financial_private.allocate_document_number(p_store uuid, p_kind text, p_request text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE result text; prefix text; counter text; n bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC
  CASE WHEN p_kind='pos' THEN ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','CASHIER_ONLY'] ELSE ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY'] END),false) THEN
  RAISE EXCEPTION 'NEXUS_DOCUMENT_NUMBER_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF p_kind NOT IN ('pos','order') OR p_kind IS NULL OR nullif(p_request,'') IS NULL OR length(p_request)>200 THEN
  RAISE EXCEPTION 'NEXUS_DOCUMENT_NUMBER_INVALID' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('document-number:'||p_store||':'||p_kind||':'||p_request,0));
 SELECT number INTO result FROM financial_private.document_numbers WHERE store_id=p_store AND kind=p_kind AND request_id=p_request;
 IF FOUND THEN RETURN result;END IF;
 SELECT financial_private.store_abbreviation(name)||CASE WHEN p_kind='pos' THEN '-P' ELSE '-O' END INTO prefix FROM public.stores WHERE id=p_store;
 IF prefix IS NULL THEN RAISE EXCEPTION 'NEXUS_DOCUMENT_NUMBER_STORE_REQUIRED' USING ERRCODE='23514';END IF;
 counter:='branded_'||p_kind;
 LOOP
  INSERT INTO public.store_counters(store_id,name,value) VALUES(p_store,counter,1)
   ON CONFLICT(store_id,name) DO UPDATE SET value=public.store_counters.value+1 RETURNING value INTO n;
  result:=prefix||lpad(n::text,greatest(3,length(n::text)),'0');
  EXIT WHEN NOT EXISTS(SELECT 1 FROM financial_private.document_numbers WHERE store_id=p_store AND kind=p_kind AND number=result)
   AND NOT EXISTS(SELECT 1 FROM public.orders WHERE store_id=p_store AND "orderNumber"=result)
   AND NOT EXISTS(SELECT 1 FROM public.ledger_events WHERE store_id=p_store AND ref_type='pos_sale' AND payload::jsonb->>'documentNumber'=result);
 END LOOP;
 INSERT INTO financial_private.document_numbers VALUES(p_store,p_kind,p_request,result);
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.validate_discount_use(p_store uuid, p_code_id text, p_amount numeric)
 RETURNS discount_codes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d public.discount_codes;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(public.has_role(p_store,VARIADIC
    ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY','ACCOUNTANT','CASHIER_ONLY']),false) THEN
    RAISE EXCEPTION 'NEXUS_NOT_A_MEMBER' USING ERRCODE='42501';
  END IF;
  IF p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity')
     OR p_amount < 0 OR p_amount > 1e9 OR p_amount <> round(p_amount,2) THEN
    RAISE EXCEPTION 'NEXUS_BAD_AMOUNT' USING ERRCODE='23514';
  END IF;
  SELECT * INTO d FROM public.discount_codes
    WHERE id=p_code_id AND store_id=p_store AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_CODE_NOT_FOUND' USING ERRCODE='23514'; END IF;
  IF NOT d.active THEN RAISE EXCEPTION 'NEXUS_CODE_INACTIVE' USING ERRCODE='23514'; END IF;
  IF d."expiryDate" IS NOT NULL AND d."expiryDate" < now() THEN
    RAISE EXCEPTION 'NEXUS_CODE_EXPIRED' USING ERRCODE='23514';
  END IF;
  IF d."maxUses" IS NOT NULL AND d."usedCount" >= d."maxUses" THEN
    RAISE EXCEPTION 'NEXUS_CODE_EXHAUSTED' USING ERRCODE='23514';
  END IF;
  IF d."totalDiscount"::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'NEXUS_DISCOUNT_HISTORY_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN d;
END;
$function$;

CREATE OR REPLACE FUNCTION public.release_discount_use(p_store uuid, p_code_id text, p_amount numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(public.has_role(p_store,VARIADIC
    ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY','ACCOUNTANT']),false) THEN
    RAISE EXCEPTION 'NEXUS_NOT_A_MEMBER' USING ERRCODE='42501';
  END IF;
  IF p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity')
     OR p_amount < 0 OR p_amount > 1e9 THEN
    RAISE EXCEPTION 'NEXUS_BAD_AMOUNT' USING ERRCODE='23514';
  END IF;
  RAISE EXCEPTION 'NEXUS_DISCOUNT_ATOMIC_REQUIRED' USING ERRCODE='23514';
END;
$function$;

CREATE OR REPLACE FUNCTION public.adjust_discount_total(p_store uuid, p_code_id text, p_delta numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(public.has_role(p_store,VARIADIC
    ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY','ACCOUNTANT']),false) THEN
    RAISE EXCEPTION 'NEXUS_NOT_A_MEMBER' USING ERRCODE='42501';
  END IF;
  IF p_delta IS NULL OR p_delta::text IN ('NaN','Infinity','-Infinity') OR abs(p_delta)>1e9 THEN
    RAISE EXCEPTION 'NEXUS_BAD_AMOUNT' USING ERRCODE='23514';
  END IF;
  RAISE EXCEPTION 'NEXUS_DISCOUNT_DOCUMENT_REQUIRED' USING ERRCODE='23514';
END;
$function$;

CREATE OR REPLACE VIEW public.orders_operational WITH (security_barrier=true) AS  SELECT id,
    "orderNumber",
    "customerName",
    "customerPhone",
    address,
    governorate,
    city,
        CASE
            WHEN has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY']) THEN items
            ELSE strip_line_cost(items)
        END AS items,
        CASE
            WHEN has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY']) THEN "stockItems"
            ELSE strip_line_cost("stockItems")
        END AS "stockItems",
    "totalAmount",
    "shippingFee",
    "paymentMethod",
    "depositAmount",
    "depositWallet",
    "expectedCod",
    "discountAmount",
    "discountCodeId",
    status,
    "courierId",
    "courierName",
        CASE
            WHEN has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY']) THEN "courierFee"
            ELSE NULL::numeric
        END AS "courierFee",
    "createdAt",
    "updatedAt",
    updated_at,
    "revenueLogged",
    "customerId",
    "codSettledAt",
    "returnConfirmedAt",
    "returnType",
    return_cause,
    "isExchange",
    original_order_id,
    "wholesaleClientId",
    "shippingPenaltyApplied",
    store_id,
    deleted_at,
    "wastedTripCompensation",
    "exchangeDetails",
    fulfillment,
        CASE
            WHEN has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY']) THEN "codServiceFee"
            ELSE NULL::numeric
        END AS "codServiceFee"
   FROM orders o
  WHERE has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY','MODERATOR']);

CREATE OR REPLACE FUNCTION public.read_order_activity(p_store uuid, p_order_id text)
 RETURNS TABLE(id text, kind text, occurred_at text, label text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE o public.orders;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY','MODERATOR']),false) THEN
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
END $function$;

CREATE OR REPLACE FUNCTION public.ledger_balances(p_store uuid,p_account text,p_kind text DEFAULT NULL,p_subject_id text DEFAULT NULL,p_from timestamptz DEFAULT NULL,p_to timestamptz DEFAULT NULL)
 RETURNS TABLE(subject_id text,qty numeric,amount bigint) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','CASHIER_ONLY','POS_ECOMMERCE','ECOMMERCE_ONLY']),false)
  OR (NOT public.can_read_store_finance(p_store) AND p_account NOT IN ('stock','customer_ltv')) OR p_account IS NULL THEN
  RAISE EXCEPTION 'NEXUS_FINANCIAL_READ_FORBIDDEN' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT l.subject_id,sum(l.qty_delta::numeric),sum(l.amount_delta)::bigint
 FROM public.ledger_lines l JOIN public.ledger_events e ON e.id=l.event_id AND e.store_id=l.store_id
 WHERE l.store_id=p_store AND l.account=p_account AND (p_kind IS NULL OR e.kind=p_kind) AND (p_subject_id IS NULL OR l.subject_id=p_subject_id)
 AND (p_from IS NULL OR e.occurred_at::timestamptz>=p_from) AND (p_to IS NULL OR e.occurred_at::timestamptz<p_to) GROUP BY l.subject_id;
END $fn$;
REVOKE ALL ON FUNCTION public.ledger_balances(uuid,text,text,text,timestamptz,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ledger_balances(uuid,text,text,text,timestamptz,timestamptz) TO authenticated;

-- A receipt exposes its own payment movement, never a company wallet total.
CREATE FUNCTION public.read_pos_headers(p_store uuid,p_ids text[],p_exchange text DEFAULT NULL)
 RETURNS SETOF public.ledger_events LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','CASHIER_ONLY','POS_ECOMMERCE']),false) THEN
  RAISE EXCEPTION 'NEXUS_POS_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF cardinality(p_ids)>3 OR (coalesce(cardinality(p_ids),0)=0 AND nullif(p_exchange,'') IS NULL) THEN
  RAISE EXCEPTION 'NEXUS_RECEIPT_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN QUERY SELECT (jsonb_populate_record(NULL::public.ledger_events,to_jsonb(e)-'command_request'-'command_result')).*
 FROM public.ledger_events e WHERE e.store_id=p_store AND e.kind='sale' AND e.ref_type='pos_sale'
 AND (e.id=ANY(p_ids) OR (p_exchange IS NOT NULL AND e.ref_id=p_exchange)) ORDER BY e.id LIMIT 3;
END $fn$;
CREATE FUNCTION public.read_pos_lines(p_store uuid,p_ids text[])
 RETURNS SETOF public.ledger_lines LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','CASHIER_ONLY','POS_ECOMMERCE']),false) THEN
  RAISE EXCEPTION 'NEXUS_POS_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF coalesce(cardinality(p_ids),0) NOT BETWEEN 1 AND 3 THEN RAISE EXCEPTION 'NEXUS_RECEIPT_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN QUERY SELECT l.* FROM public.ledger_lines l JOIN public.ledger_events e ON e.id=l.event_id AND e.store_id=l.store_id
 WHERE l.store_id=p_store AND e.kind='sale' AND e.ref_type='pos_sale' AND e.id=ANY(p_ids) ORDER BY l.id;
END $fn$;
REVOKE ALL ON FUNCTION public.read_pos_headers(uuid,text[],text),public.read_pos_lines(uuid,text[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.read_pos_headers(uuid,text[],text),public.read_pos_lines(uuid,text[]) TO authenticated;

CREATE FUNCTION public.can_read_pos_return(p_store uuid,p_source text) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
 SELECT auth.uid() IS NOT NULL AND public.has_role(p_store,VARIADIC ARRAY['CASHIER_ONLY']) AND EXISTS(
 SELECT 1 FROM public.ledger_events e WHERE e.store_id=p_store AND e.id=p_source AND e.kind='sale' AND e.ref_type='pos_sale')
$fn$;
REVOKE ALL ON FUNCTION public.can_read_pos_return(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.can_read_pos_return(uuid,text) TO authenticated;
CREATE POLICY cashier_return_read ON public.return_records FOR SELECT TO authenticated
 USING(public.can_read_pos_return(store_id,original_order_id));

-- Membership changes must reach the signed-in employee, not just ADMIN.
-- RLS still admits only their own row (or their tenant's ADMIN). Local PG
-- fixtures have no Supabase realtime publication; do not create one there.
DO $pub$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') AND NOT EXISTS(
  SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='store_members') THEN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.store_members;
 END IF;
END $pub$;

CREATE OR REPLACE FUNCTION public.ledger_events_page(p_store uuid,p_kind text DEFAULT NULL,p_ref_type text DEFAULT NULL,p_ref_id text DEFAULT NULL,p_from timestamptz DEFAULT NULL,p_to timestamptz DEFAULT NULL,p_limit integer DEFAULT 200)
 RETURNS SETOF public.ledger_events LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE finance boolean:=public.can_read_store_finance(p_store);r text:=public.member_role(p_store);
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','CASHIER_ONLY','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_LEDGER_READ_FORBIDDEN' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT (jsonb_populate_record(NULL::public.ledger_events,
  CASE WHEN finance THEN to_jsonb(e) ELSE to_jsonb(e)-'command_request'-'command_result' END)).*
 FROM public.ledger_events e WHERE e.store_id=p_store
 AND (finance OR (r IN ('CASHIER_ONLY','POS_ECOMMERCE') AND e.kind='sale' AND e.ref_type='pos_sale')
  OR (r IN ('POS_ECOMMERCE','ECOMMERCE_ONLY') AND e.ref_type IN ('ecommerce_order','ecommerce_exchange','ecommerce_exchange_credit')))
 AND (p_kind IS NULL OR e.kind=p_kind) AND (p_ref_type IS NULL OR e.ref_type=p_ref_type) AND (p_ref_id IS NULL OR e.ref_id=p_ref_id)
 AND (p_from IS NULL OR e.occurred_at::timestamptz>=p_from) AND (p_to IS NULL OR e.occurred_at::timestamptz<p_to)
 ORDER BY e.occurred_at::timestamptz DESC,e.id DESC LIMIT least(greatest(coalesce(p_limit,200),0),2000);
END $fn$;
REVOKE ALL ON FUNCTION public.ledger_events_page(uuid,text,text,text,timestamptz,timestamptz,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ledger_events_page(uuid,text,text,text,timestamptz,timestamptz,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.search_pos_receipts(p_store uuid,p_search text)
 RETURNS SETOF public.ledger_events LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','CASHIER_ONLY','POS_ECOMMERCE']),false) THEN
  RAISE EXCEPTION 'NEXUS_POS_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF nullif(trim(p_search),'') IS NULL OR length(p_search)>150 THEN RAISE EXCEPTION 'NEXUS_RECEIPT_SEARCH_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN QUERY WITH receipts AS (
 SELECT e.id FROM public.ledger_events e WHERE e.store_id=p_store AND e.kind='sale' AND e.ref_type='pos_sale'
 AND nullif(e.payload::jsonb->>'returnOfEventId','') IS NULL
 AND (strpos(lower(e.id),lower(trim(p_search)))>0 OR strpos(lower(coalesce(e.payload::jsonb->>'documentNumber','')),lower(trim(p_search)))>0
 OR strpos(lower(coalesce(e.payload::jsonb->>'customerPhone','')),lower(trim(p_search)))>0
 OR strpos(lower(coalesce(e.payload::jsonb->>'customerName','')),lower(trim(p_search)))>0)
 ORDER BY e.occurred_at::timestamptz DESC,e.id LIMIT 100)
 SELECT (jsonb_populate_record(NULL::public.ledger_events,to_jsonb(e)-'command_request'-'command_result')).*
 FROM public.ledger_events e WHERE e.store_id=p_store AND e.kind='sale' AND e.ref_type='pos_sale'
 AND (e.id IN(SELECT id FROM receipts) OR e.payload::jsonb->>'returnOfEventId' IN(SELECT id FROM receipts))
 ORDER BY e.occurred_at::timestamptz DESC,e.id;
END $fn$;
REVOKE ALL ON FUNCTION public.search_pos_receipts(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.search_pos_receipts(uuid,text) TO authenticated;

-- A phone can follow THIS order's courier position without selecting any
-- raw expense lines or requesting a company-wide financial ledger.
CREATE FUNCTION public.read_order_courier_position(p_store uuid,p_order text) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE o public.orders;obligation jsonb;service numeric;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_COURIER_FORBIDDEN' USING ERRCODE='42501';END IF;
 SELECT * INTO o FROM public.orders WHERE store_id=p_store AND id=p_order AND deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_ORDER_NOT_FOUND' USING ERRCODE='23514';END IF;
 obligation:=financial_private.courier_obligation(o,o."courierId");
 SELECT coalesce(sum(l.amount_delta),0) INTO service FROM public.ledger_lines l JOIN public.ledger_events e ON e.id=l.event_id AND e.store_id=l.store_id
 WHERE l.store_id=p_store AND e.ref_type='ecommerce_order' AND e.ref_id IN (o.id,o."orderNumber")
 AND l.account='expense' AND l.subject_id='courier_cod_service';
 RETURN obligation||jsonb_build_object('servicePiastres',service);
END $fn$;
REVOKE ALL ON FUNCTION public.read_order_courier_position(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.read_order_courier_position(uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION financial_private.apply_stock_event(p_event_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e public.ledger_events; payload jsonb; moves jsonb:='[]';
 before_rows jsonb:='[]'; after_rows jsonb:='[]'; item jsonb; part jsonb; recipe jsonb;
 source public.orders; invoice public.purchase_invoices; product public.products;
 subject text; variant text; delta numeric; prior numeric; total numeric; quantity numeric;
 variants jsonb; expected numeric; actual numeric; stocks jsonb;
 opening boolean; updated integer; return_value numeric; debt_before numeric; reduction numeric; prior_value numeric;
 paid numeric; allocation numeric; credit numeric; paid_allocation numeric; updated_items jsonb; allocation_invoice public.purchase_invoices;
BEGIN
 SELECT * INTO e FROM public.ledger_events WHERE id=p_event_id;
 IF NOT FOUND OR auth.uid() IS NULL OR NOT coalesce(public.has_role(e.store_id,VARIADIC
   ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY','CASHIER_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_STOCK_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF public.member_role(e.store_id)='CASHIER_ONLY' AND NOT (e.kind='sale' AND e.ref_type='pos_sale') THEN
  RAISE EXCEPTION 'NEXUS_STOCK_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM financial_private.stock_applications WHERE event_id=e.id AND store_id=e.store_id) THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ledger_events WHERE id=e.id AND xmin::text=pg_current_xact_id()::text) THEN
  RAISE EXCEPTION 'NEXUS_STOCK_CURRENT_COMMAND_REQUIRED' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'productId',subject_id,'qty',qty_delta,'piastres',amount_delta) ORDER BY id),'[]')
  INTO stocks FROM public.ledger_lines WHERE event_id=e.id AND store_id=e.store_id AND account='stock';
 IF jsonb_array_length(stocks)=0 THEN RETURN; END IF;
 payload:=coalesce(e.payload::jsonb,'{}');
 opening:=e.kind='stock_adjustment' AND e.ref_type='opening_balance';
 IF e.kind='sale' AND e.ref_type='pos_sale' THEN
  FOR item IN SELECT x FROM jsonb_array_elements(payload->'items') x LOOP
   recipe:=CASE WHEN coalesce((item->>'isBundle')::boolean,false) THEN item->'bundleItems'
    ELSE jsonb_build_array(jsonb_build_object('productId',item->>'productId','variantName',item->>'variantName','quantity',1)) END;
   IF jsonb_typeof(recipe) IS DISTINCT FROM 'array' OR jsonb_array_length(recipe)=0 THEN
    RAISE EXCEPTION 'NEXUS_STOCK_RECIPE_REQUIRED' USING ERRCODE='23514'; END IF;
   FOR part IN SELECT x FROM jsonb_array_elements(recipe) x LOOP
    moves:=moves||jsonb_build_array(jsonb_build_object('productId',part->>'productId','variantName',part->>'variantName',
     'delta',-(item->>'quantity')::numeric*(part->>'quantity')::numeric));
   END LOOP;
  END LOOP;
 ELSIF e.kind='purchase' AND e.command_request->>'command'='receipt' THEN
  IF NOT EXISTS(SELECT 1 FROM public.purchase_invoices pi WHERE pi.id=e.id AND pi.store_id=e.store_id AND pi."invoiceNumber"=e.ref_id) THEN
   RAISE EXCEPTION 'NEXUS_STOCK_RECEIPT_REQUIRED' USING ERRCODE='23514'; END IF;
  SELECT jsonb_agg(jsonb_build_object('productId',x->>'productId','variantName',x->>'variantName','delta',(x->>'quantity')::numeric))
   INTO moves FROM jsonb_array_elements(e.command_request#>'{input,items}') x;
 ELSIF e.kind='purchase' AND e.ref_type='supplier_return' THEN
  PERFORM 1 FROM public.suppliers WHERE id=payload->>'supplierId' AND store_id=e.store_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_STOCK_RETURN_SOURCE_REQUIRED' USING ERRCODE='23514'; END IF;
  SELECT * INTO invoice FROM public.purchase_invoices WHERE store_id=e.store_id AND "invoiceNumber"=e.ref_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR invoice."supplierId" IS DISTINCT FROM payload->>'supplierId' THEN
   RAISE EXCEPTION 'NEXUS_STOCK_RETURN_SOURCE_REQUIRED' USING ERRCODE='23514'; END IF;
  FOR item IN SELECT x FROM jsonb_array_elements(payload->'items') x LOOP
   SELECT coalesce(sum((x->>'quantity')::numeric),0) INTO expected FROM jsonb_array_elements(invoice.items) x
    WHERE coalesce(x->>'id',x->>'productId')=item->>'lineKey' AND x->>'productId'=item->>'productId' AND coalesce(x->>'variantName','')=coalesce(item->>'variantName','');
   SELECT coalesce(sum((x->>'quantity')::numeric),0) INTO actual FROM public.ledger_events le
    CROSS JOIN LATERAL jsonb_array_elements(le.payload::jsonb->'items') x
    WHERE le.store_id=e.store_id AND le.ref_type='supplier_return' AND le.kind='purchase' AND le.ref_id=e.ref_id
     AND x->>'lineKey'=item->>'lineKey' AND x->>'productId'=item->>'productId' AND coalesce(x->>'variantName','')=coalesce(item->>'variantName','');
   IF expected<=0 OR actual>expected OR (item->>'quantity')::numeric<=0 OR NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(invoice.items) x WHERE coalesce(x->>'id',x->>'productId')=item->>'lineKey' AND x->>'productId'=item->>'productId'
     AND coalesce(x->>'variantName','')=coalesce(item->>'variantName','') AND (x->>'unitCost')::numeric=(item->>'unitCost')::numeric) THEN
    RAISE EXCEPTION 'NEXUS_STOCK_RETURN_SOURCE_REQUIRED' USING ERRCODE='23514'; END IF;
   moves:=moves||jsonb_build_array(jsonb_build_object('productId',item->>'productId','variantName',item->>'variantName','delta',-(item->>'quantity')::numeric));
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.ledger_events le WHERE le.store_id=e.store_id AND le.ref_type='supplier_return' AND le.kind='purchase' AND le.ref_id=e.ref_id
    AND le.id<>e.id AND NOT EXISTS(SELECT 1 FROM financial_private.stock_applications sa WHERE sa.event_id=le.id)) THEN
   RAISE EXCEPTION 'NEXUS_STOCK_RETURN_HISTORY_REVIEW' USING ERRCODE='23514'; END IF;
  SELECT sum(round((x->>'quantity')::numeric*(x->>'unitCost')::numeric*100)) INTO return_value FROM jsonb_array_elements(payload->'items') x;
  IF return_value IS NULL OR return_value IS DISTINCT FROM -(SELECT sum(amount_delta) FROM public.ledger_lines WHERE event_id=e.id AND account='stock') THEN
   RAISE EXCEPTION 'NEXUS_STOCK_RETURN_VALUE_MISMATCH' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(amount_delta),0) INTO debt_before FROM public.ledger_lines WHERE store_id=e.store_id AND account='payable_supplier' AND subject_id=invoice."supplierId" AND event_id<>e.id;
  paid:=round(coalesce((payload->>'paidNow')::numeric,0)*100);
  reduction:=least(return_value,debt_before)+paid;
  credit:=least(return_value,debt_before);
  IF debt_before<0 OR round((payload->>'previousDebt')::numeric*100) IS DISTINCT FROM debt_before
    OR paid<0 OR paid>greatest(0,debt_before-return_value)
    OR coalesce((SELECT sum(amount_delta) FROM public.ledger_lines WHERE event_id=e.id AND account='payable_supplier' AND subject_id=invoice."supplierId"),0) IS DISTINCT FROM -reduction
    OR EXISTS(SELECT 1 FROM public.ledger_lines WHERE event_id=e.id AND account='payable_supplier' AND subject_id<>invoice."supplierId") THEN
   RAISE EXCEPTION 'NEXUS_STOCK_SUPPLIER_BALANCE_CHANGED' USING ERRCODE='23514'; END IF;
  -- Source return quantities and payable allocations persist with the event,
  -- not an asynchronous invoice PATCH. Existing invoices are never rewritten
  -- by migration; these are only normal forward business document effects.
  SELECT jsonb_agg(x||jsonb_build_object('returnedQuantity',coalesce((SELECT sum((i->>'quantity')::numeric)
   FROM public.ledger_events le CROSS JOIN LATERAL jsonb_array_elements(le.payload::jsonb->'items') i
   WHERE le.store_id=e.store_id AND le.kind='purchase' AND le.ref_type='supplier_return' AND le.ref_id=e.ref_id
     AND i->>'lineKey'=coalesce(x->>'id',x->>'productId')),0)) ORDER BY ordinal) INTO updated_items
   FROM jsonb_array_elements(invoice.items) WITH ORDINALITY t(x,ordinal);
  UPDATE public.purchase_invoices SET items=updated_items,"updatedAt"=now(),updated_at=greatest(coalesce(updated_at,0)+1,(extract(epoch FROM clock_timestamp())*1000)::bigint)
   WHERE id=invoice.id AND store_id=e.store_id;
  FOR allocation_invoice IN SELECT * FROM public.purchase_invoices WHERE store_id=e.store_id AND "supplierId"=invoice."supplierId" AND deleted_at IS NULL AND "remainingAmount">0
   ORDER BY (id=invoice.id) DESC,"createdAt",id FOR UPDATE LOOP
   EXIT WHEN reduction<=0;
   allocation:=least(credit,round(allocation_invoice."remainingAmount"*100));
   paid_allocation:=least(paid,round(allocation_invoice."remainingAmount"*100)-allocation);
   UPDATE public.purchase_invoices SET "remainingAmount"="remainingAmount"-(allocation+paid_allocation)/100,
    "paidAmount"="paidAmount"+paid_allocation/100,
    status=CASE WHEN "remainingAmount"-(allocation+paid_allocation)/100=0 THEN 'paid' ELSE 'partial' END,"updatedAt"=now(),
    updated_at=greatest(coalesce(updated_at,0)+1,(extract(epoch FROM clock_timestamp())*1000)::bigint) WHERE id=allocation_invoice.id AND store_id=e.store_id;
   -- Cash and credit allocations are distinct even though they clear the
   -- same payable. A supplier refund is never invented as a cash payment.
   credit:=credit-allocation;paid:=paid-paid_allocation;
   reduction:=reduction-allocation-paid_allocation;
  END LOOP;
  IF reduction<>0 THEN RAISE EXCEPTION 'NEXUS_STOCK_SUPPLIER_DOCUMENT_REVIEW' USING ERRCODE='23514'; END IF;
 ELSIF e.kind='order_edited' AND e.command_request->>'command'='order_edit' THEN
  before_rows:=payload#>'{before,stockItems}'; after_rows:=payload#>'{after,stockItems}';
 ELSIF e.ref_type='ecommerce_exchange' AND e.kind='return_confirmed' THEN
  SELECT jsonb_agg(c) INTO before_rows FROM financial_private.order_exchanges ex
   CROSS JOIN LATERAL jsonb_array_elements(ex.selections) x CROSS JOIN LATERAL jsonb_array_elements(x->'parts') c
   WHERE ex.store_id=e.store_id AND ex.confirmation_event_id=e.id AND ex.status='confirmed';
 ELSIF e.ref_type='ecommerce_order' AND e.kind IN ('order_placed','order_cancelled','rto_confirmed','return_confirmed') THEN
  SELECT * INTO source FROM public.orders WHERE store_id=e.store_id AND "orderNumber"=e.ref_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_STOCK_ORDER_REQUIRED' USING ERRCODE='23514'; END IF;
  IF e.kind='order_placed' THEN after_rows:=source."stockItems";
  ELSE
   before_rows:=coalesce(payload->'stockItems',source."stockItems");
   FOR item IN SELECT x FROM jsonb_array_elements(before_rows) x LOOP
    SELECT coalesce(sum((x->>'quantity')::numeric),0) INTO expected FROM jsonb_array_elements(source."stockItems") x
     WHERE x->>'productId'=item->>'productId' AND coalesce(x->>'variantName','')=coalesce(item->>'variantName','')
      AND (x->>'unitCost')::numeric=(item->>'unitCost')::numeric;
    IF EXISTS(SELECT 1 FROM public.ledger_events le WHERE le.store_id=e.store_id AND le.ref_type='ecommerce_order' AND le.ref_id=e.ref_id
      AND le.id<>e.id AND le.kind IN ('order_cancelled','rto_confirmed','return_confirmed')
      AND NOT EXISTS(SELECT 1 FROM financial_private.stock_applications sa WHERE sa.event_id=le.id)) THEN
     RAISE EXCEPTION 'NEXUS_STOCK_RETURN_HISTORY_REVIEW' USING ERRCODE='23514'; END IF;
    SELECT coalesce(sum((m->>'delta')::numeric),0) INTO actual FROM financial_private.stock_applications sa JOIN public.ledger_events le ON le.id=sa.event_id
     CROSS JOIN LATERAL jsonb_array_elements(sa.moves) m WHERE le.store_id=e.store_id AND le.ref_type='ecommerce_order' AND le.ref_id=e.ref_id
      AND le.kind IN ('order_cancelled','rto_confirmed','return_confirmed') AND m->>'productId'=item->>'productId'
      AND coalesce(m->>'variantName','')=coalesce(item->>'variantName','');
    actual:=actual+(SELECT sum((x->>'quantity')::numeric) FROM jsonb_array_elements(before_rows) x
      WHERE x->>'productId'=item->>'productId' AND coalesce(x->>'variantName','')=coalesce(item->>'variantName',''));
    IF expected<=0 OR actual>expected OR (item->>'quantity')::numeric<=0 THEN
     RAISE EXCEPTION 'NEXUS_STOCK_RETURN_ALLOCATION_REQUIRED' USING ERRCODE='23514'; END IF;
   END LOOP;
  END IF;
 ELSIF opening THEN moves:='[]';
 ELSIF e.kind='stock_adjustment' AND e.ref_type='stock_audit' THEN
  FOR item IN SELECT x FROM jsonb_array_elements(payload->'stockCounts') x LOOP
   moves:=moves||jsonb_build_array(jsonb_build_object('productId',item->>'productId','variantName',item->>'variantName',
    'delta',(item->>'countedQty')::numeric-(item->>'systemQty')::numeric,'systemQty',item->'systemQty'));
  END LOOP;
 ELSE RAISE EXCEPTION 'NEXUS_STOCK_CLIENT_UPDATE_REQUIRED: unsupported legacy stock writer' USING ERRCODE='23514';
 END IF;
 FOR item IN SELECT x FROM jsonb_array_elements(coalesce(before_rows,'[]')) x LOOP
  moves:=moves||jsonb_build_array(jsonb_build_object('productId',item->>'productId','variantName',item->>'variantName','delta',(item->>'quantity')::numeric));
 END LOOP;
 FOR item IN SELECT x FROM jsonb_array_elements(coalesce(after_rows,'[]')) x LOOP
  moves:=moves||jsonb_build_array(jsonb_build_object('productId',item->>'productId','variantName',item->>'variantName','delta',-(item->>'quantity')::numeric));
 END LOOP;
 moves:=coalesce(moves,'[]');
 IF NOT opening AND (jsonb_array_length(moves)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(moves) x
  WHERE nullif(x->>'productId','') IS NULL OR x->>'delta' IS NULL OR (x->>'delta')::numeric::text IN ('NaN','Infinity','-Infinity'))) THEN
  RAISE EXCEPTION 'NEXUS_STOCK_IDENTITIES_REQUIRED' USING ERRCODE='23514'; END IF;
 FOR subject IN SELECT DISTINCT x->>'productId' FROM jsonb_array_elements(stocks||moves) x ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-stock:'||e.store_id::text||':'||subject,0));
 END LOOP;
 FOR subject IN SELECT DISTINCT x->>'productId' FROM jsonb_array_elements(stocks||moves) x ORDER BY 1 LOOP
  -- Historical returns/cancellations may restore an archived product. New
  -- sale/receipt availability is still checked by their original commands.
  SELECT * INTO product FROM public.products WHERE store_id=e.store_id AND id=subject FOR UPDATE;
  IF NOT FOUND OR product."isBundle" THEN RAISE EXCEPTION 'NEXUS_STOCK_PRODUCT_INVALID' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(qty_delta::numeric),0) INTO total FROM public.ledger_lines WHERE store_id=e.store_id AND account='stock' AND subject_id=subject;
  SELECT coalesce(sum((x->>'qty')::numeric),0) INTO delta FROM jsonb_array_elements(stocks) x WHERE x->>'productId'=subject;
  prior:=total-delta;

  IF e.kind='order_placed' AND source.fulfillment->>'version'='1' THEN
   IF NOT EXISTS(SELECT 1 FROM financial_private.fulfillment_actions a WHERE a.event_id=e.id AND a.store_id=e.store_id AND a.action='placement'
     AND a.xmin::text=pg_current_xact_id()::text) OR
    (SELECT sum((x->>'piastres')::numeric) FROM jsonb_array_elements(stocks) x WHERE x->>'productId'=subject) IS DISTINCT FROM
    -(SELECT sum((x->>'costPiastres')::numeric) FROM jsonb_array_elements(source."stockItems") x WHERE x->>'productId'=subject) THEN
    RAISE EXCEPTION 'NEXUS_FULFILLMENT_COST_PROOF_REQUIRED' USING ERRCODE='23514';END IF;
  ELSIF e.kind='order_placed' OR (e.kind='stock_adjustment' AND e.ref_type='stock_audit') THEN

   SELECT coalesce(sum(amount_delta),0) INTO prior_value FROM public.ledger_lines WHERE store_id=e.store_id AND account='stock' AND subject_id=subject AND event_id<>e.id;
   IF prior>0 AND (SELECT sum((x->>'piastres')::numeric) FROM jsonb_array_elements(stocks) x WHERE x->>'productId'=subject) IS DISTINCT FROM
    (CASE WHEN e.kind='stock_adjustment' THEN floor(delta*prior_value/prior+0.5) ELSE (SELECT sum(floor((x->>'qty')::numeric*prior_value/prior+0.5)) FROM jsonb_array_elements(stocks) x WHERE x->>'productId'=subject) END) THEN
    RAISE EXCEPTION 'NEXUS_STOCK_COST_CHANGED' USING ERRCODE='23514'; END IF;
  ELSIF e.kind IN ('order_cancelled','rto_confirmed','return_confirmed') THEN
   IF (SELECT sum((x->>'piastres')::numeric) FROM jsonb_array_elements(stocks) x WHERE x->>'productId'=subject) IS DISTINCT FROM
    (SELECT sum(coalesce((x->>'costPiastres')::numeric,floor((x->>'quantity')::numeric*(x->>'unitCost')::numeric*100+0.5))) FROM jsonb_array_elements(before_rows) x WHERE x->>'productId'=subject) THEN
    RAISE EXCEPTION 'NEXUS_STOCK_HISTORICAL_COST_MISMATCH' USING ERRCODE='23514'; END IF;
  END IF;
  variants:=coalesce(nullif(product.metadata->'variants','null'::jsonb),'[]');
  IF jsonb_typeof(variants) IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(variants) v
   WHERE nullif(v->>'name','') IS NULL OR v->>'stock' IS NULL OR (v->>'stock')::numeric<0 OR (v->>'stock')::numeric::text IN ('NaN','Infinity','-Infinity'))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(variants) v GROUP BY v->>'name' HAVING count(*)>1) THEN
   RAISE EXCEPTION 'NEXUS_STOCK_VARIANT_REVIEW' USING ERRCODE='23514'; END IF;
  IF opening THEN
   IF EXISTS(SELECT 1 FROM public.ledger_lines WHERE store_id=e.store_id AND account='stock' AND subject_id=subject AND event_id<>e.id)
    OR delta<=0 OR (jsonb_array_length(variants)>0 AND (SELECT sum((v->>'stock')::numeric) FROM jsonb_array_elements(variants) v) IS DISTINCT FROM delta) THEN
    RAISE EXCEPTION 'NEXUS_STOCK_OPENING_REVIEW' USING ERRCODE='23514'; END IF;
  ELSE
   IF (jsonb_array_length(variants)>0 AND (SELECT sum((v->>'stock')::numeric) FROM jsonb_array_elements(variants) v) IS DISTINCT FROM prior)
    OR (jsonb_array_length(variants)=0 AND product.quantity IS DISTINCT FROM prior) THEN
    RAISE EXCEPTION 'NEXUS_STOCK_RECONCILIATION_REQUIRED' USING ERRCODE='23514'; END IF;
   SELECT coalesce(sum((x->>'delta')::numeric),0) INTO expected FROM jsonb_array_elements(moves) x WHERE x->>'productId'=subject;
   IF expected IS DISTINCT FROM delta THEN RAISE EXCEPTION 'NEXUS_STOCK_MOVEMENT_MISMATCH' USING ERRCODE='23514'; END IF;
   FOR item IN SELECT x FROM jsonb_array_elements(moves) x WHERE x->>'productId'=subject LOOP
    variant:=nullif(item->>'variantName','');
    IF (jsonb_array_length(variants)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(variants) v WHERE v->>'name'=variant))
     OR (jsonb_array_length(variants)=0 AND variant IS NOT NULL) THEN
     RAISE EXCEPTION 'NEXUS_STOCK_VARIANT_INVALID' USING ERRCODE='23514'; END IF;
    quantity:=CASE WHEN variant IS NULL THEN prior ELSE (SELECT (v->>'stock')::numeric FROM jsonb_array_elements(variants) v WHERE v->>'name'=variant) END;
    IF e.ref_type='stock_audit' AND (item->>'systemQty')::numeric IS DISTINCT FROM quantity THEN
     RAISE EXCEPTION 'NEXUS_STOCK_COUNT_STALE' USING ERRCODE='23514'; END IF;
   END LOOP;
   SELECT coalesce(jsonb_agg(jsonb_set(v,'{stock}',to_jsonb((v->>'stock')::numeric+coalesce((SELECT sum((x->>'delta')::numeric)
    FROM jsonb_array_elements(moves) x WHERE x->>'productId'=subject AND x->>'variantName'=v->>'name'),0))) ORDER BY ordinal),'[]')
    INTO variants FROM jsonb_array_elements(variants) WITH ORDINALITY t(v,ordinal);
  END IF;
  IF total<0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(variants) v WHERE (v->>'stock')::numeric<0)
   OR (jsonb_array_length(variants)>0 AND (SELECT sum((v->>'stock')::numeric) FROM jsonb_array_elements(variants) v) IS DISTINCT FROM total) THEN
   RAISE EXCEPTION 'NEXUS_STOCK_SHORT' USING ERRCODE='23514'; END IF;
  INSERT INTO financial_private.stock_write_permits VALUES(txid_current(),e.store_id,subject,total,variants);
  UPDATE public.products SET quantity=total,
   metadata=CASE WHEN jsonb_array_length(variants)>0 THEN jsonb_set(coalesce(metadata,'{}'),'{variants}',variants) ELSE metadata END,
   updated_at=greatest(coalesce(updated_at,0)+1,(extract(epoch FROM clock_timestamp())*1000)::bigint),sync_status='synced'
   WHERE id=subject AND store_id=e.store_id;
  GET DIAGNOSTICS updated=ROW_COUNT;
  IF updated<>1 THEN RAISE EXCEPTION 'NEXUS_STOCK_NOT_WRITTEN' USING ERRCODE='23514'; END IF;
  DELETE FROM financial_private.stock_write_permits WHERE transaction_id=txid_current() AND store_id=e.store_id AND product_id=subject;
 END LOOP;
 INSERT INTO financial_private.stock_applications VALUES(e.id,e.store_id,stocks,moves);
 PERFORM financial_private.persist_return_document(e.id);
END $function$;
