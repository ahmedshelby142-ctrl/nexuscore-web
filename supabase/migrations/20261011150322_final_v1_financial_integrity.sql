-- QA-FIN-001: payroll document and its immutable event are one monetary fact.
-- Forward-only; no historical document/event/line is rewritten.
CREATE OR REPLACE FUNCTION public.record_payroll(p_payroll jsonb, p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_id text := p_payroll ->> 'id';
  v_store uuid := (p_payroll ->> 'store_id')::uuid;
  v_row jsonb;
  v_amount numeric;
  v_piastres numeric;
  v_type text := COALESCE(p_payroll ->> 'type', 'salary');
  v_wallet text := p_payroll ->> 'wallet';
BEGIN
  IF v_id IS NULL OR btrim(v_id) = '' OR v_store IS NULL THEN
    RAISE EXCEPTION 'NEXUS_DOCUMENT_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NOT COALESCE(public.has_role(v_store, VARIADIC ARRAY['ADMIN','ACCOUNTANT']), false) THEN
    RAISE EXCEPTION 'NEXUS_NOT_A_MEMBER' USING ERRCODE = '42501';
  END IF;
  -- Serialize the same document before replay detection, including lost replies.
  PERFORM pg_advisory_xact_lock(hashtextextended('payroll:' || v_store::text || ':' || v_id, 0));
  SELECT to_jsonb(p.*) INTO v_row FROM public.payroll p
    WHERE p.id = v_id AND p.store_id = v_store;
  IF v_row IS NOT NULL THEN
    IF (v_row ->> 'amount')::numeric IS DISTINCT FROM (p_payroll ->> 'amount')::numeric
       OR v_row ->> 'type' IS DISTINCT FROM v_type
       OR v_row ->> 'wallet' IS DISTINCT FROM v_wallet
       OR v_row ->> 'employeeName' IS DISTINCT FROM p_payroll ->> 'employeeName'
       OR COALESCE(v_row ->> 'description','') IS DISTINCT FROM COALESCE(p_payroll ->> 'description','')
       OR (v_row ->> 'date')::timestamptz IS DISTINCT FROM (p_payroll ->> 'date')::timestamptz THEN
      RAISE EXCEPTION 'NEXUS_REPLAY_MISMATCH' USING ERRCODE = '23514';
    END IF;
    RETURN jsonb_build_object('payroll', v_row, 'replayed', true);
  END IF;
  v_amount := (p_payroll ->> 'amount')::numeric;
  v_piastres := round(v_amount * 100);
  IF v_amount IS NULL OR v_amount::text IN ('NaN','Infinity','-Infinity')
     OR v_amount <= 0 OR v_amount <> round(v_amount,2) OR v_piastres <= 0 OR v_piastres > 9007199254740991
     OR v_type NOT IN ('salary','bonus','advance')
     OR COALESCE(btrim(p_payroll ->> 'employeeName'),'') = ''
     OR COALESCE(btrim(v_wallet),'') = '' THEN
    RAISE EXCEPTION 'NEXUS_PAYROLL_INVALID' USING ERRCODE = '23514';
  END IF;
  IF p_event ->> 'kind' IS DISTINCT FROM 'payroll'
     OR (p_event ->> 'store_id')::uuid IS DISTINCT FROM v_store
     OR p_event ->> 'ref_type' IS DISTINCT FROM 'payroll'
     OR p_event ->> 'ref_id' IS DISTINCT FROM v_id THEN
    RAISE EXCEPTION 'NEXUS_EVENT_NOT_THIS_DOCUMENT' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(p_event -> 'lines') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'NEXUS_PAYROLL_EVENT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(p_event -> 'lines') <> 2
     OR (SELECT count(*) FROM jsonb_array_elements(p_event -> 'lines') l
         WHERE l ->> 'account' = 'expense' AND l ->> 'subject_id' = 'salaries'
           AND (l ->> 'amount_delta')::numeric = v_piastres
           AND COALESCE((l ->> 'qty_delta')::numeric,0) = 0) <> 1
     OR (SELECT count(*) FROM jsonb_array_elements(p_event -> 'lines') l
         WHERE l ->> 'account' = 'wallet' AND l ->> 'subject_id' = v_wallet
           AND (l ->> 'amount_delta')::numeric = -v_piastres
           AND COALESCE((l ->> 'qty_delta')::numeric,0) = 0) <> 1 THEN
    RAISE EXCEPTION 'NEXUS_PAYROLL_EVENT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.payroll (id,store_id,device_id,"employeeName",type,amount,description,
    date,wallet,ledger_event_id,updated_at,sync_status)
  VALUES (v_id,v_store,(p_payroll ->> 'device_id')::uuid,p_payroll ->> 'employeeName',
    v_type,v_amount,p_payroll ->> 'description',(p_payroll ->> 'date')::timestamptz,
    v_wallet,p_event ->> 'id',(extract(epoch FROM clock_timestamp())*1000)::bigint,'synced')
  RETURNING to_jsonb(payroll.*) INTO v_row;
  PERFORM public.ledger_append(p_event);
  RETURN jsonb_build_object('payroll',v_row,'replayed',false);
END;
$function$;
REVOKE ALL ON FUNCTION public.record_payroll(jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_payroll(jsonb,jsonb) TO authenticated,service_role;

-- QA-DISC-001: counters are committed with the financial document, never by
-- an unpaired browser compensation. Existing history/counters are untouched.
CREATE SCHEMA financial_private;
REVOKE ALL ON SCHEMA financial_private FROM PUBLIC,anon,authenticated;
CREATE TABLE financial_private.discount_redemptions (
  event_id text PRIMARY KEY REFERENCES public.ledger_events(id),
  store_id uuid NOT NULL REFERENCES public.stores(id),
  code_id text NOT NULL REFERENCES public.discount_codes(id),
  ref_type text NOT NULL,
  ref_id text,
  amount numeric NOT NULL CHECK (amount >= 0 AND amount::text NOT IN ('NaN','Infinity','-Infinity'))
);
ALTER TABLE financial_private.discount_redemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.discount_redemptions FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.validate_discount_use(p_store uuid,p_code_id text,p_amount numeric)
RETURNS public.discount_codes LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp AS $function$
DECLARE d public.discount_codes;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(public.has_role(p_store,VARIADIC
    ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY','ACCOUNTANT']),false) THEN
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
REVOKE ALL ON FUNCTION public.validate_discount_use(uuid,text,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.validate_discount_use(uuid,text,numeric) TO authenticated;

CREATE FUNCTION financial_private.record_discount_redemption()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp AS $function$
DECLARE
  v_payload jsonb;
  v_code text;
  v_amount numeric;
  v_gross numeric;
  v_expected numeric;
  v_order public.orders;
  d public.discount_codes;
BEGIN
  IF NEW.kind='sale' AND NEW.ref_type='pos_sale' THEN
    v_payload := COALESCE(NEW.payload::jsonb,'{}'::jsonb);
    v_code := NULLIF(v_payload ->> 'discountCodeId','');
    v_amount := COALESCE((v_payload ->> 'discountAmount')::numeric,0);
    IF v_code IS NULL OR v_amount=0 THEN RETURN NEW; END IF;
    SELECT sum((i ->> 'unitPrice')::numeric*(i ->> 'quantity')::numeric) INTO v_gross
      FROM jsonb_array_elements(v_payload -> 'items') i;
    IF round((v_gross-v_amount)*100) IS DISTINCT FROM
      (SELECT sum(amount_delta) FROM public.ledger_lines WHERE event_id=NEW.id AND account='revenue') THEN
      RAISE EXCEPTION 'NEXUS_DISCOUNT_AMOUNT_MISMATCH' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.kind='order_placed' AND NEW.ref_type='ecommerce_order' THEN
    SELECT * INTO v_order FROM public.orders WHERE store_id=NEW.store_id AND "orderNumber"=NEW.ref_id;
    v_code := NULLIF(v_order."discountCodeId",'');
    v_amount := COALESCE(v_order."discountAmount",0);
    IF v_code IS NULL OR v_amount=0 THEN RETURN NEW; END IF;
    SELECT sum((i ->> 'unitPrice')::numeric*(i ->> 'quantity')::numeric) INTO v_gross
      FROM jsonb_array_elements(v_order.items) i;
    IF round(v_gross-v_amount,2) IS DISTINCT FROM v_order."totalAmount" THEN
      RAISE EXCEPTION 'NEXUS_DISCOUNT_AMOUNT_MISMATCH' USING ERRCODE='23514';
    END IF;
  ELSE RETURN NEW;
  END IF;
  -- Same code lock order for all successful tills/orders; limit checked again
  -- at commit, after its ledger lines exist, not at the UI preflight.
  SELECT * INTO d FROM public.discount_codes WHERE id=v_code AND store_id=NEW.store_id FOR UPDATE;
  d := public.validate_discount_use(NEW.store_id,v_code,v_amount);
  IF d.value::text IN ('NaN','Infinity','-Infinity') OR d.value <= 0
     OR d.type NOT IN ('fixed','percentage') OR v_gross IS NULL OR v_gross <= 0 THEN
    RAISE EXCEPTION 'NEXUS_BAD_AMOUNT' USING ERRCODE='23514';
  END IF;
  v_expected := round(least(v_gross,CASE WHEN d.type='percentage' THEN v_gross*d.value/100 ELSE d.value END),2);
  IF v_amount IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'NEXUS_DISCOUNT_AMOUNT_MISMATCH' USING ERRCODE='23514';
  END IF;
  INSERT INTO financial_private.discount_redemptions(event_id,store_id,code_id,ref_type,ref_id,amount)
    VALUES(NEW.id,NEW.store_id,v_code,NEW.ref_type,NEW.ref_id,v_amount);
  PERFORM set_config('nexus.discount_usage','on',true);
  UPDATE public.discount_codes SET "usedCount"="usedCount"+1,
    "totalDiscount"="totalDiscount"+v_amount,updated_at=(extract(epoch FROM now())*1000)::bigint
    WHERE id=v_code AND store_id=NEW.store_id;
  PERFORM set_config('nexus.discount_usage','off',true);
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION financial_private.record_discount_redemption() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER record_discount_redemption
AFTER INSERT ON public.ledger_events DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION financial_private.record_discount_redemption();

-- POS and ecommerce reservations must compete for the same last unit even
-- when an older supported writer still uses ledger_append/place_order. Check
-- the committed aggregate under the same component locks, in this transaction.
CREATE FUNCTION financial_private.validate_stock_availability()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp AS $function$
DECLARE subject text; available numeric;
BEGIN
  FOR subject IN SELECT DISTINCT l.subject_id FROM public.ledger_lines l
    WHERE l.event_id=NEW.id AND l.store_id=NEW.store_id AND l.account='stock' AND l.qty_delta<0 ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('pos-stock:'||NEW.store_id::text||':'||subject,0));
    SELECT coalesce(sum(qty_delta),0) INTO available FROM public.ledger_lines
      WHERE store_id=NEW.store_id AND account='stock' AND subject_id=subject;
    IF available<0 THEN RAISE EXCEPTION 'NEXUS_STOCK_SHORT' USING ERRCODE='23514'; END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION financial_private.validate_stock_availability() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER validate_stock_availability
AFTER INSERT ON public.ledger_events DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION financial_private.validate_stock_availability();

-- Stale clients must fail closed; a three-argument release cannot identify
-- which financial operation it compensates. No attempt to reconstruct history.
CREATE OR REPLACE FUNCTION public.claim_discount_use(p_store uuid,p_code_id text,p_amount numeric)
RETURNS public.discount_codes LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp AS $function$
BEGIN
  PERFORM public.validate_discount_use(p_store,p_code_id,p_amount);
  RAISE EXCEPTION 'NEXUS_DISCOUNT_ATOMIC_REQUIRED' USING ERRCODE='23514';
END;
$function$;
CREATE OR REPLACE FUNCTION public.release_discount_use(p_store uuid,p_code_id text,p_amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp AS $function$
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
REVOKE ALL ON FUNCTION public.claim_discount_use(uuid,text,numeric) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.release_discount_use(uuid,text,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.claim_discount_use(uuid,text,numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_discount_use(uuid,text,numeric) TO authenticated;

-- Reprice only a persisted order's known redemption. Repetition recomputes
-- from current document state, so a lost reply cannot apply a delta twice.
CREATE FUNCTION public.reconcile_discount_order(p_store uuid,p_code_id text,p_order_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp AS $function$
DECLARE o public.orders; r financial_private.discount_redemptions; d public.discount_codes; v_amount numeric; v_gross numeric; v_expected numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(public.has_role(p_store,VARIADIC
    ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY','ACCOUNTANT']),false) THEN
    RAISE EXCEPTION 'NEXUS_NOT_A_MEMBER' USING ERRCODE='42501';
  END IF;
  SELECT * INTO d FROM public.discount_codes WHERE id=p_code_id AND store_id=p_store FOR UPDATE;
  SELECT * INTO o FROM public.orders WHERE id=p_order_id AND store_id=p_store FOR SHARE;
  IF o."discountCodeId" IS DISTINCT FROM p_code_id THEN
    RAISE EXCEPTION 'NEXUS_DISCOUNT_DOCUMENT_REQUIRED' USING ERRCODE='23514';
  END IF;
  SELECT * INTO r FROM financial_private.discount_redemptions
    WHERE store_id=p_store AND code_id=p_code_id AND ref_type='ecommerce_order' AND ref_id=o."orderNumber" FOR UPDATE;
  IF NOT FOUND THEN
    -- Historical documents have no trustworthy operation record. Do not guess
    -- or rewrite old counters; the operator receives a reconciliation error.
    RAISE EXCEPTION 'NEXUS_DISCOUNT_HISTORY_UNTRACKED' USING ERRCODE='23514';
  END IF;
  v_amount := COALESCE(o."discountAmount",0);
  SELECT round(sum((i->>'quantity')::numeric*(i->>'unitPrice')::numeric),2) INTO v_gross FROM jsonb_array_elements(o.items) i;
  v_expected := CASE WHEN d.deleted_at IS NOT NULL THEN least(r.amount,v_gross)
    ELSE round(least(v_gross,CASE WHEN d.type='percentage' THEN v_gross*d.value/100 ELSE d.value END),2) END;
  IF v_amount::text IN ('NaN','Infinity','-Infinity') OR v_amount < 0 OR v_amount > 1e9
     OR v_amount IS DISTINCT FROM v_expected OR o."totalAmount" IS DISTINCT FROM v_gross-v_amount
     OR d."totalDiscount"::text IN ('NaN','Infinity','-Infinity') OR d."totalDiscount" < r.amount THEN
    RAISE EXCEPTION 'NEXUS_BAD_AMOUNT' USING ERRCODE='23514';
  END IF;
  PERFORM set_config('nexus.discount_usage','on',true);
  UPDATE public.discount_codes SET "totalDiscount"="totalDiscount"-r.amount+v_amount,
    updated_at=(extract(epoch FROM now())*1000)::bigint WHERE id=p_code_id AND store_id=p_store;
  UPDATE financial_private.discount_redemptions SET amount=v_amount WHERE event_id=r.event_id;
  PERFORM set_config('nexus.discount_usage','off',true);
END;
$function$;
REVOKE ALL ON FUNCTION public.reconcile_discount_order(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.reconcile_discount_order(uuid,text,text) TO authenticated;
CREATE OR REPLACE FUNCTION public.adjust_discount_total(p_store uuid,p_code_id text,p_delta numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp AS $function$
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
REVOKE ALL ON FUNCTION public.adjust_discount_total(uuid,text,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.adjust_discount_total(uuid,text,numeric) TO authenticated;

-- Retail retry identity is separate from owner/purchasing commands. Invoker
-- semantics retain the ledger's existing membership, role and licence gates.
CREATE FUNCTION public.record_pos_sale(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO public,pg_temp AS $function$
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
  IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE']),false) THEN
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
  PERFORM public.ledger_append(jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'kind','sale','actor',p_input->>'actor',
    'ref_type','pos_sale','ref_id',p_input->>'refId','occurred_at',v_now,'created_at',v_now,'payload',v_write_payload::text,
    'lines',v_lines,'command_request',v_request,'command_result',v_result));
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_pos_sale(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_pos_sale(text,uuid,uuid,text,jsonb) TO authenticated;

-- Pending-order edits previously moved stock, saved the document, and adjusted
-- usage in separate requests. Keep all three facts and retry identity atomic.
-- A price-only edit has no stock movement, but still needs an immutable retry
-- receipt. Preserve the captured validator except this explicit empty audit
-- event case. Abort on schema drift rather than silently omitting the guard.
DO $migration$
DECLARE definition text; marker text := 'IF v_kind = ''order_returned_pending'' THEN';
BEGIN
  definition:=pg_get_functiondef('public.ledger_validate_event(jsonb)'::regprocedure);
  IF length(definition)-length(replace(definition,marker,''))<>length(marker) THEN
    RAISE EXCEPTION 'NEXUS_LEDGER_VALIDATOR_SCHEMA_DRIFT'; END IF;
  definition:=replace(definition,marker,
    'IF v_kind = ''order_returned_pending'' OR (v_kind = ''order_edited'' AND v_n=0 AND p_event #>> ''{command_request,command}'' = ''order_edit'') THEN');
  EXECUTE definition;
END;
$migration$;
CREATE FUNCTION public.record_order_edit(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO public,pg_temp AS $function$
DECLARE o public.orders; v_old public.ledger_events; v_patch jsonb:=p_input->'patch';
  v_request jsonb:=jsonb_build_object('command',p_command,'input',p_input);
  v_lines jsonb; v_result jsonb; v_subject text; v_extra numeric; v_available numeric;
  v_goods numeric; v_discount numeric; v_total numeric; v_cogs numeric;
  v_old_qty numeric; v_new_qty numeric; v_old_value numeric; v_stock_value numeric; v_unit_cost numeric;
  v_now text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
    RAISE EXCEPTION 'NEXUS_ORDER_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF nullif(p_id,'') IS NULL OR p_device IS NULL OR p_command IS DISTINCT FROM 'order_edit' THEN
    RAISE EXCEPTION 'NEXUS_ORDER_EDIT_INVALID' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('order-edit:'||p_id,0));
  SELECT * INTO v_old FROM public.ledger_events WHERE id=p_id AND store_id=p_store;
  IF FOUND THEN
    IF v_old.command_request IS DISTINCT FROM v_request OR v_old.command_result IS NULL THEN
      RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514'; END IF;
    RETURN v_old.command_result||jsonb_build_object('replayed',true);
  END IF;
  -- Code before order: same lock order as discount reconciliation.
  PERFORM 1 FROM public.discount_codes d JOIN public.orders x ON x."discountCodeId"=d.id AND x.store_id=d.store_id
    WHERE x.id=p_input->>'orderId' AND x.store_id=p_store FOR UPDATE OF d;
  SELECT * INTO o FROM public.orders WHERE id=p_input->>'orderId' AND store_id=p_store AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR o.status<>'pending' THEN RAISE EXCEPTION 'NEXUS_ORDER_NOT_EDITABLE' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(o."stockItems",'[]'::jsonb)) i WHERE i->>'bundleId' IS NOT NULL) OR
     EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v_patch->'items','[]'::jsonb)) i JOIN public.products p ON p.id=i->>'productId' AND p.store_id=p_store WHERE p."isBundle") THEN
    RAISE EXCEPTION 'NEXUS_ORDER_BOX_EDIT_UNIMPLEMENTED' USING ERRCODE='23514'; END IF;
  IF jsonb_build_object('items',o.items,'stockItems',o."stockItems",'totalAmount',o."totalAmount",'discountAmount',o."discountAmount",'depositAmount',o."depositAmount")
     IS DISTINCT FROM p_input->'before' THEN RAISE EXCEPTION 'NEXUS_ORDER_EDIT_STALE' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(v_patch->'items') IS DISTINCT FROM 'array' OR jsonb_typeof(v_patch->'stockItems') IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_patch->'items')=0 OR jsonb_array_length(v_patch->'stockItems')=0 THEN
    RAISE EXCEPTION 'NEXUS_ORDER_EDIT_INVALID' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements((v_patch->'items')||(v_patch->'stockItems')) i
    WHERE nullif(i->>'productId','') IS NULL OR (i->>'quantity') IS NULL OR (i->>'quantity')::numeric<=0
      OR (i->>'quantity')::numeric::text IN ('NaN','Infinity','-Infinity') OR (i->>'unitPrice') IS NULL
      OR (i->>'unitPrice')::numeric<0 OR (i->>'unitPrice')::numeric::text IN ('NaN','Infinity','-Infinity')
      OR coalesce((i->>'unitCost')::numeric,0)<0 OR coalesce((i->>'unitCost')::numeric,0)::text IN ('NaN','Infinity','-Infinity')) THEN
    RAISE EXCEPTION 'NEXUS_ORDER_EDIT_INVALID' USING ERRCODE='23514'; END IF;
  IF EXISTS(WITH sold AS (
    SELECT i->>'productId' id,coalesce(i->>'variantName','') variant,sum((i->>'quantity')::numeric) qty FROM jsonb_array_elements(v_patch->'items') i GROUP BY 1,2
  ), reserved AS (
    SELECT i->>'productId' id,coalesce(i->>'variantName','') variant,sum((i->>'quantity')::numeric) qty FROM jsonb_array_elements(v_patch->'stockItems') i GROUP BY 1,2
  ) SELECT 1 FROM sold FULL JOIN reserved USING(id,variant) WHERE sold.qty IS DISTINCT FROM reserved.qty) THEN
    RAISE EXCEPTION 'NEXUS_ORDER_EDIT_STOCK_MISMATCH' USING ERRCODE='23514'; END IF;
  SELECT round(sum((i->>'quantity')::numeric*(i->>'unitPrice')::numeric),2) INTO v_goods FROM jsonb_array_elements(v_patch->'items') i;
  v_discount:=coalesce((v_patch->>'discountAmount')::numeric,0);v_total:=v_goods-v_discount;
  IF v_discount::text IN ('NaN','Infinity','-Infinity') OR v_discount<0 OR v_discount>v_goods
     OR v_total IS DISTINCT FROM (v_patch->>'totalAmount')::numeric OR o."depositAmount">v_total+o."shippingFee"+o."wastedTripCompensation" THEN
    RAISE EXCEPTION 'NEXUS_ORDER_EDIT_TOTAL' USING ERRCODE='23514'; END IF;
  -- Snapshot retained units at their original reservation cost. Additional
  -- units use the current ledger WAC. The browser cannot reprice inventory by
  -- changing a hidden unitCost; blend the resulting reservation on the server.
  FOR v_subject IN SELECT DISTINCT i->>'productId' FROM jsonb_array_elements((coalesce(o."stockItems",'[]'::jsonb))||(v_patch->'stockItems')) i ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('pos-stock:'||p_store::text||':'||v_subject,0));
    IF NOT EXISTS(SELECT 1 FROM public.products WHERE id=v_subject AND store_id=p_store) THEN
      RAISE EXCEPTION 'NEXUS_ORDER_PRODUCT_INVALID' USING ERRCODE='23514'; END IF;
    SELECT coalesce(sum((i->>'quantity')::numeric),0),coalesce(sum((i->>'quantity')::numeric*coalesce((i->>'unitCost')::numeric,0)),0)
      INTO v_old_qty,v_old_value FROM jsonb_array_elements(o."stockItems") i WHERE i->>'productId'=v_subject;
    SELECT coalesce(sum((i->>'quantity')::numeric),0) INTO v_new_qty FROM jsonb_array_elements(v_patch->'stockItems') i WHERE i->>'productId'=v_subject;
    SELECT coalesce(sum(qty_delta),0),coalesce(sum(amount_delta),0)/100 INTO v_available,v_stock_value FROM public.ledger_lines WHERE store_id=p_store AND account='stock' AND subject_id=v_subject;
    IF v_new_qty>v_old_qty+v_available THEN RAISE EXCEPTION 'NEXUS_STOCK_SHORT' USING ERRCODE='23514'; END IF;
    IF v_new_qty>0 THEN
      v_unit_cost:=CASE WHEN v_new_qty<=v_old_qty THEN v_old_value/v_old_qty
        ELSE (v_old_value+(v_new_qty-v_old_qty)*coalesce(v_stock_value/nullif(v_available,0),0))/v_new_qty END;
      SELECT jsonb_agg(CASE WHEN i->>'productId'=v_subject THEN jsonb_set(i,'{unitCost}',to_jsonb(v_unit_cost)) ELSE i END)
        INTO v_lines FROM jsonb_array_elements(v_patch->'stockItems') i;
      v_patch:=jsonb_set(v_patch,'{stockItems}',v_lines);
    END IF;
  END LOOP;
  WITH movements AS (
    SELECT i->>'productId' subject,(i->>'quantity')::numeric qty,coalesce((i->>'unitCost')::numeric,0)*(i->>'quantity')::numeric amount FROM jsonb_array_elements(o."stockItems") i
    UNION ALL SELECT i->>'productId',-(i->>'quantity')::numeric,-coalesce((i->>'unitCost')::numeric,0)*(i->>'quantity')::numeric FROM jsonb_array_elements(v_patch->'stockItems') i
  ) SELECT jsonb_agg(jsonb_build_object('id',gen_random_uuid()::text,'account','stock','subject_id',subject,'qty_delta',qty,'amount_delta',round(amount*100)))
    INTO v_lines FROM (SELECT subject,sum(qty) qty,sum(amount) amount FROM movements GROUP BY subject HAVING sum(qty)<>0) t;
  v_lines:=coalesce(v_lines,'[]'::jsonb);
  FOR v_subject IN SELECT l->>'subject_id' FROM jsonb_array_elements(v_lines) l ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('pos-stock:'||p_store::text||':'||v_subject,0));
    SELECT coalesce(sum(qty_delta),0) INTO v_available FROM public.ledger_lines WHERE store_id=p_store AND account='stock' AND subject_id=v_subject;
    SELECT sum((l->>'qty_delta')::numeric) INTO v_extra FROM jsonb_array_elements(v_lines) l WHERE l->>'subject_id'=v_subject;
    IF v_available+v_extra<0 THEN RAISE EXCEPTION 'NEXUS_STOCK_SHORT' USING ERRCODE='23514'; END IF;
  END LOOP;
  SELECT sum((i->>'quantity')::numeric*coalesce((i->>'unitCost')::numeric,0)) INTO v_cogs FROM jsonb_array_elements(v_patch->'stockItems') i;
  UPDATE public.orders SET items=v_patch->'items',"stockItems"=v_patch->'stockItems',"discountAmount"=v_discount,"totalAmount"=v_total,"cogsAmount"=v_cogs,
    "expectedCod"=v_total+"shippingFee"+"wastedTripCompensation"-"depositAmount","updatedAt"=now(),updated_at=(extract(epoch FROM now())*1000)::bigint WHERE id=o.id AND store_id=p_store RETURNING * INTO o;
  IF o."discountCodeId" IS NOT NULL THEN PERFORM public.reconcile_discount_order(p_store,o."discountCodeId",o.id); END IF;
  v_result:=jsonb_build_object('eventId',p_id,'order',to_jsonb(o),'replayed',false);
  PERFORM public.ledger_append(jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'kind','order_edited','ref_type','ecommerce_order','ref_id',o."orderNumber",
    'occurred_at',v_now,'created_at',v_now,'payload',jsonb_build_object('before',p_input->'before','after',v_patch)::text,'lines',v_lines,'command_request',v_request,'command_result',v_result));
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_order_edit(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_order_edit(text,uuid,uuid,text,jsonb) TO authenticated;

-- QA-FIN-003: POS refunds are negative sale revenue, not return_confirmed.
-- Only the informational returns metric changes; net revenue/profit already
-- include refunds and must never subtract this figure for a second time.
CREATE FUNCTION public.ledger_return_balances(p_store uuid,p_account text,p_kind text DEFAULT NULL,p_subject_id text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,p_to timestamptz DEFAULT NULL)
RETURNS TABLE(subject_id text,qty numeric,amount bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO public,pg_temp AS $function$
  SELECT l.subject_id,sum(l.qty_delta),sum(l.amount_delta)::bigint
  FROM public.ledger_lines l JOIN public.ledger_events e ON e.id=l.event_id AND e.store_id=l.store_id
  WHERE l.store_id=p_store AND p_account='revenue' AND l.account='revenue' AND l.amount_delta<0
    AND e.kind IN ('sale','return_confirmed') AND (p_kind IS NULL OR e.kind=p_kind)
    AND (p_subject_id IS NULL OR l.subject_id=p_subject_id)
    AND (p_from IS NULL OR e.occurred_at::timestamptz>=p_from)
    AND (p_to IS NULL OR e.occurred_at::timestamptz<p_to)
  GROUP BY l.subject_id;
$function$;
REVOKE ALL ON FUNCTION public.ledger_return_balances(uuid,text,text,text,timestamptz,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ledger_return_balances(uuid,text,text,text,timestamptz,timestamptz) TO authenticated;
DO $migration$
DECLARE definition text; marker text := 'public.ledger_balances(p_store, ''revenue'', ''return_confirmed'', NULL, p_from, p_to)';
BEGIN
  definition:=pg_get_functiondef('public.owner_financial_summary(uuid,timestamptz,timestamptz)'::regprocedure);
  IF length(definition)-length(replace(definition,marker,''))<>length(marker) THEN
    RAISE EXCEPTION 'NEXUS_OWNER_SUMMARY_SCHEMA_DRIFT'; END IF;
  EXECUTE replace(definition,marker,'public.ledger_return_balances(p_store, ''revenue'', NULL, NULL, p_from, p_to)');
END;
$migration$;
