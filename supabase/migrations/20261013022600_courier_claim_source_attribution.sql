-- A new return-phase claim cannot reuse collections belonging to an older
-- delivery. Forward evidence only; historical claims/ledger are not backfilled.
ALTER TABLE public.courier_claims ADD COLUMN source_event_id text REFERENCES public.ledger_events(id);
CREATE TABLE financial_private.courier_claim_phases (
 event_id text PRIMARY KEY REFERENCES public.ledger_events(id), store_id uuid NOT NULL,
 order_id text NOT NULL, courier_id text NOT NULL, gross_piastres numeric NOT NULL CHECK(gross_piastres>=0),
 offset_piastres numeric NOT NULL CHECK(offset_piastres>=0), prior_settlement_ids jsonb NOT NULL,
 review_reason text, UNIQUE(store_id,order_id)
);
ALTER TABLE financial_private.courier_claim_phases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.courier_claim_phases FROM PUBLIC,anon,authenticated;

CREATE FUNCTION financial_private.guard_courier_financial_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF NEW."courierId" IS DISTINCT FROM OLD."courierId" AND EXISTS(SELECT 1 FROM public.ledger_events e JOIN public.ledger_lines l ON l.event_id=e.id AND l.store_id=e.store_id
  WHERE e.store_id=OLD.store_id AND e.ref_type='ecommerce_order' AND e.ref_id=OLD."orderNumber" AND e.kind IN ('order_delivered','return_confirmed','rto_confirmed')
   AND l.account IN ('receivable_courier','payable_courier') AND l.subject_id=coalesce(nullif(OLD."courierId",''),'default') AND l.amount_delta<>0) THEN
  RAISE EXCEPTION 'NEXUS_COURIER_FINANCIAL_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_courier_financial_identity() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER zz_courier_financial_identity BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION financial_private.guard_courier_financial_identity();

CREATE FUNCTION financial_private.capture_courier_claim_phase(p_event_id text,p_order_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE o public.orders;e public.ledger_events;gross numeric;offset_amount numeric;delta_amount numeric;basis jsonb;prior jsonb;changed integer;
BEGIN
 SELECT * INTO o FROM public.orders WHERE id=p_order_id;
 IF auth.uid() IS NULL OR NOT FOUND OR NOT coalesce(public.has_role(o.store_id,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false)
  OR NOT public.store_licensed(o.store_id) THEN RAISE EXCEPTION 'NEXUS_CLAIM_SOURCE_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF o.return_cause IS DISTINCT FROM 'courier' THEN RETURN;END IF;
 SELECT * INTO e FROM public.ledger_events WHERE id=p_event_id AND store_id=o.store_id AND ref_type='ecommerce_order' AND ref_id=o."orderNumber"
  AND kind IN ('return_confirmed','rto_confirmed') AND xmin::text=pg_current_xact_id()::text;
 IF NOT FOUND OR o.status<>'returned' OR o."returnConfirmedAt" IS NULL OR nullif(o."courierId",'') IS NULL
  OR NOT EXISTS(SELECT 1 FROM public.orders WHERE id=o.id AND xmin::text=pg_current_xact_id()::text)
  THEN RAISE EXCEPTION 'NEXUS_CLAIM_SOURCE_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(greatest(amount_delta,0)),0),coalesce(sum(greatest(-amount_delta,0)),0),coalesce(sum(amount_delta),0)
  INTO gross,offset_amount,delta_amount FROM public.ledger_lines WHERE event_id=e.id AND account='receivable_courier' AND subject_id=o."courierId";
 basis:=financial_private.courier_obligation(o,o."courierId");
 -- Existing negative principal can legitimately offset the new compensation.
 -- Save that fact at the source transaction, never infer it at claim closure.
 offset_amount:=offset_amount+greatest(0,-((basis->>'codPiastres')::numeric-delta_amount));
 SELECT coalesce(jsonb_agg(s.id ORDER BY s.id),'[]') INTO prior FROM public.ledger_events s WHERE s.store_id=o.store_id AND s.kind='courier_settlement'
  AND ((s.ref_type='ecommerce_order' AND s.ref_id=o."orderNumber") OR (s.ref_type='courier_batch' AND s.payload::jsonb->>'courierId'=o."courierId"
   AND (EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s.payload::jsonb->'orders','[]')) x WHERE x->>'id'=o.id)
    OR coalesce(s.payload::jsonb->'orderNumbers','[]') ? o."orderNumber")));
 INSERT INTO financial_private.courier_claim_phases VALUES(e.id,o.store_id,o.id,o."courierId",gross,offset_amount,prior,basis->>'reviewReason');
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>1 THEN RAISE EXCEPTION 'NEXUS_CLAIM_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.capture_courier_claim_phase(text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION financial_private.capture_courier_claim_phase(text,text) TO authenticated;

CREATE FUNCTION financial_private.guard_courier_claim_phase() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN RAISE EXCEPTION 'NEXUS_CLAIM_SOURCE_IMMUTABLE' USING ERRCODE='23514';END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_courier_claim_phase() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER courier_claim_phase_immutable BEFORE UPDATE OR DELETE ON financial_private.courier_claim_phases FOR EACH ROW EXECUTE FUNCTION financial_private.guard_courier_claim_phase();

CREATE FUNCTION financial_private.is_courier_claim_offset(p_store uuid,p_order text,p_courier text,p_source text,p_settlement text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
 SELECT auth.uid() IS NOT NULL AND coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false)
 AND EXISTS(SELECT 1 FROM financial_private.courier_claim_phases phase JOIN public.ledger_events e ON e.id=p_settlement AND e.store_id=phase.store_id
  JOIN financial_private.courier_commands c ON c.event_id=e.id AND c.store_id=e.store_id AND c.request=e.command_request
  WHERE phase.store_id=p_store AND phase.order_id=p_order AND phase.courier_id=p_courier AND phase.event_id=p_source
   AND NOT phase.prior_settlement_ids ? e.id AND e.kind='courier_settlement' AND e.ref_type='courier_batch' AND e.payload::jsonb->>'courierId'=p_courier
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.payload::jsonb->'orders') x WHERE x->>'id'=p_order AND (x->>'remainingCodPiastres')::numeric=0))
$fn$;
REVOKE ALL ON FUNCTION financial_private.is_courier_claim_offset(uuid,text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION financial_private.is_courier_claim_offset(uuid,text,text,text,text) TO authenticated;

DO $migration$
DECLARE definition text;marker text;
BEGIN
 definition:=replace(pg_get_functiondef('public.confirm_order_return(text,text,text,jsonb,text)'::regprocedure),chr(13),'');
 marker:='  -- A wasted trip is owed';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'NEXUS_CLAIM_RETURN_SCHEMA_DRIFT';END IF;
 definition:=replace(definition,marker,'  PERFORM financial_private.capture_courier_claim_phase(p_events->(v_n-1)->>''id'',v_order.id);'||chr(10)||marker);
 EXECUTE definition;
 definition:=replace(pg_get_functiondef('financial_private.guard_claim_coverage()'::regprocedure),chr(13),'');
 marker:='DECLARE o public.orders;e public.ledger_events;covered numeric;obligation jsonb;';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'NEXUS_CLAIM_GUARD_SCHEMA_DRIFT';END IF;
 definition:=replace(definition,marker,marker||' phase financial_private.courier_claim_phases;');
 marker:='  IF OLD.status IN (''settled'',''rejected'') THEN RETURN NEW;END IF;';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'NEXUS_CLAIM_IDENTITY_SCHEMA_DRIFT';END IF;
 definition:=replace(definition,marker,'  IF OLD.source_event_id IS NOT NULL AND NEW.source_event_id IS DISTINCT FROM OLD.source_event_id THEN RAISE EXCEPTION ''NEXUS_CLAIM_IDENTITY_IMMUTABLE'' USING ERRCODE=''23514'';END IF;'||chr(10)||marker);
 marker:=' IF NEW.status<>''settled'' THEN RETURN NEW;END IF;';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'NEXUS_CLAIM_STATUS_SCHEMA_DRIFT';END IF;
 definition:=replace(definition,marker,$patch$
 SELECT * INTO phase FROM financial_private.courier_claim_phases WHERE store_id=NEW.store_id AND order_id=o.id AND courier_id=NEW.courier_id;
 IF FOUND THEN
  IF NEW.source_event_id IS NOT NULL AND NEW.source_event_id IS DISTINCT FROM phase.event_id THEN RAISE EXCEPTION 'NEXUS_CLAIM_SOURCE_MISMATCH' USING ERRCODE='23514';END IF;
  NEW.source_event_id:=phase.event_id;
 ELSIF NEW.source_event_id IS NOT NULL OR (o."returnConfirmedAt" IS NOT NULL AND o.return_cause='courier' AND NEW.status IN ('submitted','approved','settled')) THEN
  RAISE EXCEPTION 'NEXUS_CLAIM_SOURCE_REVIEW_REQUIRED' USING ERRCODE='23514';
 END IF;
 IF NEW.status<>'settled' THEN RETURN NEW;END IF;
 IF phase.event_id IS NOT NULL THEN
  IF phase.review_reason IS NOT NULL OR NEW.amount_piastres>phase.gross_piastres THEN RAISE EXCEPTION 'NEXUS_CLAIM_NOT_COVERED' USING ERRCODE='23514';END IF;
  SELECT * INTO e FROM public.ledger_events WHERE id=NEW.settlement_event_id AND store_id=NEW.store_id AND kind='courier_settlement' AND ref_type='courier_batch';
  IF NOT FOUND OR phase.prior_settlement_ids ? e.id OR e.payload::jsonb->>'courierId' IS DISTINCT FROM NEW.courier_id
   OR NOT EXISTS(SELECT 1 FROM financial_private.courier_commands c WHERE c.event_id=e.id AND c.store_id=NEW.store_id AND c.request=e.command_request)
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.payload::jsonb->'orders') x WHERE x->>'id'=o.id AND (x->>'remainingCodPiastres')::numeric=0)
   THEN RAISE EXCEPTION 'NEXUS_CLAIM_NOT_COVERED' USING ERRCODE='23514';END IF;
  obligation:=financial_private.courier_obligation(o,NEW.courier_id);
  IF obligation->>'reviewReason' IS NOT NULL OR (obligation->>'codPiastres')::numeric<>0 THEN RAISE EXCEPTION 'NEXUS_CLAIM_NOT_COVERED' USING ERRCODE='23514';END IF;
  -- A single-order write-off has exact attribution. Multiple-order write-offs
  -- have no per-order loss allocation: fail closed instead of assigning one.
  IF EXISTS(SELECT 1 FROM public.ledger_events s WHERE s.store_id=NEW.store_id AND s.kind='courier_settlement' AND s.ref_type='courier_batch'
   AND s.payload::jsonb->>'courierId'=NEW.courier_id AND NOT phase.prior_settlement_ids ? s.id
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.payload::jsonb->'orders') x WHERE x->>'id'=o.id)
   AND jsonb_array_length(s.payload::jsonb->'orders')<>1
   AND EXISTS(SELECT 1 FROM public.ledger_lines l WHERE l.event_id=s.id AND l.account='expense' AND l.amount_delta<>0)) THEN
   RAISE EXCEPTION 'NEXUS_CLAIM_NOT_COVERED' USING ERRCODE='23514';END IF;
  SELECT phase.offset_piastres+coalesce(sum((x->>'codPiastres')::numeric-coalesce((SELECT sum(l.amount_delta) FROM public.ledger_lines l WHERE l.event_id=s.id AND l.account='expense'),0)),0) INTO covered FROM public.ledger_events s
   JOIN financial_private.courier_commands c ON c.event_id=s.id AND c.store_id=s.store_id AND c.request=s.command_request
   CROSS JOIN LATERAL jsonb_array_elements(s.payload::jsonb->'orders') x
   WHERE s.store_id=NEW.store_id AND s.kind='courier_settlement' AND s.ref_type='courier_batch' AND s.payload::jsonb->>'courierId'=NEW.courier_id
    AND x->>'id'=o.id AND NOT phase.prior_settlement_ids ? s.id;
  IF covered<NEW.amount_piastres THEN RAISE EXCEPTION 'NEXUS_CLAIM_NOT_COVERED' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
$patch$);
 EXECUTE definition;
 definition:=replace(pg_get_functiondef('public.courier_claims_guard_status()'::regprocedure),chr(13),'');
 marker:='    IF NOT EXISTS (';
 IF strpos(definition,marker)=0 OR strpos(definition,'NEXUS_CLAIM_SETTLEMENT_EVENT_MISMATCH')=0 THEN RAISE EXCEPTION 'NEXUS_CLAIM_LEGACY_STATUS_SCHEMA_DRIFT';END IF;
 -- The coverage trigger still verifies exact source value and collection.
 -- This compatibility guard permits an actual fee-only offset, not a fake R.
 definition:=replace(definition,marker,'    IF NOT financial_private.is_courier_claim_offset(NEW.store_id,NEW.order_id,NEW.courier_id,NEW.source_event_id,NEW.settlement_event_id) AND NOT EXISTS (');
 EXECUTE definition;
 definition:=replace(pg_get_functiondef('public.record_courier_batch(text,uuid,uuid,text,jsonb)'::regprocedure),chr(13),'');
 marker:=' net:=net*100;';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'NEXUS_COURIER_PIASTRE_SCHEMA_DRIFT';END IF;
 -- JSON integer readers reject numeric text 2499.00, despite exact arithmetic.
 -- Round only after the existing exact-two-decimal input validation.
 EXECUTE replace(definition,marker,' net:=round(net*100);');
END $migration$;
