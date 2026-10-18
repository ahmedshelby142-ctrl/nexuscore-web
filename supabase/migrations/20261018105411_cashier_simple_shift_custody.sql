-- One daily drawer: custody of inStoreSafe cash, NOT another financial wallet.
-- Disabled until ADMIN explicitly configures it. No historical rows rewritten.
CREATE TABLE financial_private.cashier_shift_policy (
 store_id uuid PRIMARY KEY REFERENCES public.stores(id), cashier_id uuid NOT NULL,
 enabled boolean NOT NULL, opening_piastre bigint NOT NULL CHECK(opening_piastre BETWEEN 0 AND 1000000000),
 keep_piastre bigint NOT NULL CHECK(keep_piastre BETWEEN 0 AND 1000000000),
 updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE financial_private.cashier_shifts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), store_id uuid NOT NULL REFERENCES public.stores(id),
 cashier_id uuid NOT NULL, shift_day date NOT NULL, opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 opened_by uuid NOT NULL, planned_end_at timestamptz NOT NULL,
 opening_piastre bigint NOT NULL CHECK(opening_piastre>=0), keep_piastre bigint NOT NULL CHECK(keep_piastre>=0),
 carry_in_piastre bigint NOT NULL DEFAULT 0, float_adjustment_piastre bigint NOT NULL DEFAULT 0,
 status text NOT NULL CHECK(status IN ('open','awaiting_review','awaiting_handover','handover_reported','closed')),
 expected_piastre bigint, actual_piastre bigint CHECK(actual_piastre>=0), variance_piastre bigint,
 retained_piastre bigint CHECK(retained_piastre>=0), handover_piastre bigint CHECK(handover_piastre>=0),
 counted_at timestamptz, counted_by uuid, discrepancy_reason text, reviewed_by uuid, reviewed_at timestamptz,
 handover_reported_by uuid, handover_reported_at timestamptz, received_by uuid, closed_at timestamptz,
 UNIQUE(store_id,shift_day)
);
CREATE UNIQUE INDEX cashier_shift_one_active ON financial_private.cashier_shifts(store_id) WHERE status<>'closed';
CREATE INDEX cashier_shift_owner ON financial_private.cashier_shifts(store_id,cashier_id,opened_at DESC);
CREATE TABLE financial_private.cashier_shift_movements (
 ledger_line_id text PRIMARY KEY REFERENCES public.ledger_lines(id),
 shift_id uuid NOT NULL REFERENCES financial_private.cashier_shifts(id),
 event_id text NOT NULL REFERENCES public.ledger_events(id), actor_id uuid NOT NULL,
 wallet_id text NOT NULL, payment_piastre bigint NOT NULL, cash_piastre bigint NOT NULL,
 category text NOT NULL CHECK(category IN ('sale','refund','expense','other')),
 reason text, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cashier_shift_movement_shift ON financial_private.cashier_shift_movements(shift_id,recorded_at);
-- Eligible cash movements observed by the server while a drawer is open.
-- They remain SAFE movements until ADMIN explicitly confirms drawer custody.
CREATE TABLE financial_private.cashier_shift_candidates (
 ledger_line_id text PRIMARY KEY REFERENCES public.ledger_lines(id),
 shift_id uuid NOT NULL REFERENCES financial_private.cashier_shifts(id),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cashier_shift_candidates_shift ON financial_private.cashier_shift_candidates(shift_id);
CREATE TABLE financial_private.cashier_shift_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, store_id uuid NOT NULL,
 shift_id uuid REFERENCES financial_private.cashier_shifts(id), actor_id uuid NOT NULL,
 action text NOT NULL, detail jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cashier_shift_audit_store ON financial_private.cashier_shift_audit(store_id,id DESC);
CREATE TABLE financial_private.cashier_shift_requests (
 id text PRIMARY KEY, store_id uuid NOT NULL, actor_id uuid NOT NULL,
 request jsonb NOT NULL, result jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE financial_private.cashier_shift_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_private.cashier_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_private.cashier_shift_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_private.cashier_shift_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_private.cashier_shift_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_private.cashier_shift_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.cashier_shift_policy,financial_private.cashier_shifts,
 financial_private.cashier_shift_movements,financial_private.cashier_shift_audit,
 financial_private.cashier_shift_requests,financial_private.cashier_shift_candidates FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE financial_private.cashier_shift_audit_id_seq FROM PUBLIC,anon,authenticated;

CREATE FUNCTION financial_private.cashier_shift_summary(p_id uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT to_jsonb(s)||jsonb_build_object(
  'live_expected_piastre',s.opening_piastre+coalesce((SELECT sum(cash_piastre) FROM financial_private.cashier_shift_movements WHERE shift_id=s.id),0),
  'cash_sales_piastre',coalesce((SELECT sum(cash_piastre) FROM financial_private.cashier_shift_movements WHERE shift_id=s.id AND category='sale'),0),
  'cash_refunds_piastre',coalesce((SELECT -sum(cash_piastre) FROM financial_private.cashier_shift_movements WHERE shift_id=s.id AND category='refund'),0),
  'cash_expenses_piastre',coalesce((SELECT -sum(cash_piastre) FROM financial_private.cashier_shift_movements WHERE shift_id=s.id AND category='expense'),0),
  'other_cash_piastre',coalesce((SELECT sum(cash_piastre) FROM financial_private.cashier_shift_movements WHERE shift_id=s.id AND category='other'),0),
  'electronic',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT wallet_id,sum(payment_piastre) amount_piastre
    FROM financial_private.cashier_shift_movements WHERE shift_id=s.id AND wallet_id<>'inStoreSafe' GROUP BY wallet_id) x),'[]'::jsonb),
  'movements',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT m.event_id,m.actor_id,m.wallet_id,m.payment_piastre,m.cash_piastre,m.category,m.reason,m.recorded_at,
    coalesce(e.payload::jsonb->>'documentNumber',e.payload::jsonb->>'sourceDocumentNumber',e.id) document_number
    FROM financial_private.cashier_shift_movements m JOIN public.ledger_events e ON e.id=m.event_id
    WHERE m.shift_id=s.id ORDER BY m.recorded_at DESC,m.ledger_line_id LIMIT 200) x),'[]'::jsonb))
 FROM financial_private.cashier_shifts s WHERE s.id=p_id;
$$;

CREATE FUNCTION public.cashier_shift_snapshot(p_store uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_admin boolean; v_policy financial_private.cashier_shift_policy; v_shift uuid;
BEGIN
 v_admin:=coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN']),false);
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','CASHIER_ONLY']),false)
 THEN RAISE EXCEPTION 'NEXUS_SHIFT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_policy FROM financial_private.cashier_shift_policy WHERE store_id=p_store;
 SELECT id INTO v_shift FROM financial_private.cashier_shifts WHERE store_id=p_store
  AND (v_admin OR cashier_id=auth.uid()) ORDER BY (status<>'closed') DESC,opened_at DESC LIMIT 1;
 RETURN jsonb_build_object('enabled',coalesce(v_policy.enabled,false),'admin',v_admin,
  'policy',CASE WHEN v_policy.store_id IS NOT NULL AND (v_admin OR v_policy.cashier_id=auth.uid()) THEN to_jsonb(v_policy) ELSE NULL END,
  'shift',financial_private.cashier_shift_summary(v_shift),
  'allocatable',CASE WHEN v_admin THEN coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
    SELECT e.id event_id,min(c.recorded_at) created_at,coalesce(nullif(e.payload::jsonb->>'description',''),
     CASE e.kind WHEN 'expense' THEN 'مصروف' WHEN 'payroll' THEN 'راتب' WHEN 'purchase' THEN 'مشتريات' WHEN 'supplier_payment' THEN 'دفعة مورد' ELSE 'حركة نقدية' END)
     ||' — '||to_char(min(c.recorded_at) AT TIME ZONE 'Africa/Cairo','DD/MM HH24:MI') description,sum(l.amount_delta) amount_piastre
    FROM public.ledger_events e JOIN public.ledger_lines l ON l.event_id=e.id AND l.store_id=e.store_id
    JOIN financial_private.cashier_shift_candidates c ON c.ledger_line_id=l.id
    JOIN financial_private.cashier_shifts a ON a.id=v_shift AND a.status='open'
    WHERE e.store_id=p_store AND l.account='wallet' AND l.subject_id='inStoreSafe' AND c.shift_id=a.id
    AND NOT(e.kind='sale' AND e.ref_type='pos_sale') AND NOT EXISTS(SELECT 1 FROM financial_private.cashier_shift_movements m WHERE m.ledger_line_id=l.id)
    GROUP BY e.id,e.payload,e.kind ORDER BY min(c.recorded_at) DESC LIMIT 30) x),'[]'::jsonb) ELSE '[]'::jsonb END,
  'cashiers',CASE WHEN v_admin THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.user_id,'email',u.email))
    FROM public.store_members m JOIN auth.users u ON u.id=m.user_id WHERE m.store_id=p_store AND m.role='CASHIER_ONLY'),'[]'::jsonb) ELSE '[]'::jsonb END,
  'history',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT id,shift_day,cashier_id,status,opening_piastre,expected_piastre,actual_piastre,variance_piastre,retained_piastre,handover_piastre,closed_at
    FROM financial_private.cashier_shifts WHERE store_id=p_store AND (v_admin OR cashier_id=auth.uid()) ORDER BY opened_at DESC LIMIT 14) x),'[]'::jsonb),
  'audit',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT a.id,a.shift_id,a.actor_id,a.action,a.detail,a.recorded_at FROM financial_private.cashier_shift_audit a
    WHERE a.store_id=p_store AND (v_admin OR a.shift_id=v_shift) ORDER BY a.id DESC LIMIT 50) x),'[]'::jsonb));
END $$;

-- Trigger runs inside the EXISTING financial transaction: no split receipt writer.
CREATE FUNCTION financial_private.capture_cashier_shift_payment() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE e public.ledger_events; p financial_private.cashier_shift_policy; s financial_private.cashier_shifts; v_admin boolean; v_reason text;
BEGIN
 SELECT * INTO e FROM public.ledger_events WHERE id=NEW.event_id AND store_id=NEW.store_id;
 SELECT * INTO p FROM financial_private.cashier_shift_policy WHERE store_id=NEW.store_id;
 IF NOT FOUND OR NOT p.enabled THEN RETURN NEW; END IF;
 PERFORM financial_private.fulfillment_lock(NEW.store_id);
 SELECT * INTO s FROM financial_private.cashier_shifts WHERE store_id=NEW.store_id AND status='open' FOR UPDATE;
 IF e.kind IS DISTINCT FROM 'sale' OR e.ref_type IS DISTINCT FROM 'pos_sale' THEN
  IF s.id IS NOT NULL AND NEW.subject_id='inStoreSafe' THEN
   INSERT INTO financial_private.cashier_shift_candidates(ledger_line_id,shift_id) VALUES(NEW.id,s.id);
  END IF;
  RETURN NEW;
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_SHIFT_OPEN_REQUIRED' USING ERRCODE='23514'; END IF;
 v_admin:=coalesce(public.has_role(NEW.store_id,VARIADIC ARRAY['ADMIN']),false);
 v_reason:=nullif(btrim(e.payload::jsonb->>'shiftOverrideReason'),'');
 IF auth.uid() IS NULL OR (NOT v_admin AND (auth.uid()<>s.cashier_id OR NOT coalesce(public.has_role(NEW.store_id,VARIADIC ARRAY['CASHIER_ONLY']),false)))
 THEN RAISE EXCEPTION 'NEXUS_SHIFT_WRONG_CASHIER' USING ERRCODE='42501'; END IF;
 IF v_admin AND (v_reason IS NULL OR length(v_reason)<4 OR length(v_reason)>500)
 THEN RAISE EXCEPTION 'NEXUS_SHIFT_OVERRIDE_REASON_REQUIRED' USING ERRCODE='23514'; END IF;
 INSERT INTO financial_private.cashier_shift_movements(ledger_line_id,shift_id,event_id,actor_id,wallet_id,payment_piastre,cash_piastre,category,reason)
 VALUES(NEW.id,s.id,e.id,auth.uid(),NEW.subject_id,NEW.amount_delta,CASE WHEN NEW.subject_id='inStoreSafe' THEN NEW.amount_delta ELSE 0 END,
  CASE WHEN NEW.amount_delta<0 THEN 'refund' ELSE 'sale' END,v_reason);
 INSERT INTO financial_private.cashier_shift_audit(store_id,shift_id,actor_id,action,detail)
 VALUES(s.store_id,s.id,auth.uid(),CASE WHEN v_admin THEN 'admin_pos_override' ELSE 'pos_payment' END,
  jsonb_build_object('eventId',e.id,'lineId',NEW.id,'wallet',NEW.subject_id,'paymentPiastres',NEW.amount_delta,'reason',v_reason));
 RETURN NEW;
END $$;
CREATE TRIGGER cashier_shift_capture_payment AFTER INSERT ON public.ledger_lines
 FOR EACH ROW WHEN(NEW.account='wallet') EXECUTE FUNCTION financial_private.capture_cashier_shift_payment();

-- Deferred so a single atomic exchange may return first and collect its net next.
CREATE FUNCTION financial_private.check_cashier_drawer_cash() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF (SELECT s.opening_piastre+coalesce(sum(m.cash_piastre),0) FROM financial_private.cashier_shifts s
  LEFT JOIN financial_private.cashier_shift_movements m ON m.shift_id=s.id WHERE s.id=NEW.shift_id GROUP BY s.opening_piastre)<0
 THEN RAISE EXCEPTION 'NEXUS_DRAWER_CASH_INSUFFICIENT' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER cashier_drawer_cash_nonnegative AFTER INSERT ON financial_private.cashier_shift_movements
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION financial_private.check_cashier_drawer_cash();

CREATE FUNCTION public.record_cashier_shift(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p financial_private.cashier_shift_policy; s financial_private.cashier_shifts; v_old financial_private.cashier_shift_requests;
 v_admin boolean; v_action text:=p_input->>'action'; v_reason text:=nullif(btrim(p_input->>'reason'),'');
 v_result jsonb; v_before jsonb; v_open bigint; v_keep bigint; v_actual bigint; v_expected bigint; v_carry bigint:=0;
 v_cashier uuid; v_line record; v_count integer:=0; v_shift uuid; v_enabled boolean;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','CASHIER_ONLY']),false)
  OR NOT coalesce(public.store_licensed(p_store),false) THEN RAISE EXCEPTION 'NEXUS_SHIFT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF p_id IS NULL OR length(p_id) NOT BETWEEN 1 AND 128 OR p_device IS NULL OR p_command IS DISTINCT FROM 'cashier_shift' OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR pg_column_size(p_input)>8192
 THEN RAISE EXCEPTION 'NEXUS_SHIFT_INVALID' USING ERRCODE='23514'; END IF;
 PERFORM financial_private.fulfillment_lock(p_store);
 SELECT * INTO v_old FROM financial_private.cashier_shift_requests WHERE id=p_id;
 IF FOUND THEN
  IF v_old.store_id<>p_store OR v_old.actor_id<>auth.uid() OR v_old.request IS DISTINCT FROM p_input
  THEN RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN v_old.result||jsonb_build_object('replayed',true);
 END IF;
 v_admin:=coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN']),false);
 IF length(v_reason)>500 THEN RAISE EXCEPTION 'NEXUS_SHIFT_REASON_REQUIRED' USING ERRCODE='23514'; END IF;
 SELECT * INTO p FROM financial_private.cashier_shift_policy WHERE store_id=p_store;
 IF v_action='configure' THEN
  IF NOT v_admin THEN RAISE EXCEPTION 'NEXUS_SHIFT_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM financial_private.cashier_shifts WHERE store_id=p_store AND status<>'closed') THEN RAISE EXCEPTION 'NEXUS_SHIFT_ACTIVE' USING ERRCODE='23514'; END IF;
  IF coalesce(p_input->>'openingPiastres','') !~ '^[0-9]+$' OR coalesce(p_input->>'keepPiastres','') !~ '^[0-9]+$'
   OR jsonb_typeof(p_input->'enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'NEXUS_SHIFT_INVALID' USING ERRCODE='23514'; END IF;
  v_open:=(p_input->>'openingPiastres')::bigint;v_keep:=(p_input->>'keepPiastres')::bigint;v_cashier:=(p_input->>'cashierId')::uuid;v_enabled:=(p_input->>'enabled')::boolean;
  IF NOT EXISTS(SELECT 1 FROM public.store_members WHERE store_id=p_store AND user_id=v_cashier AND role='CASHIER_ONLY')
   OR v_open>1000000000 OR v_keep>1000000000 THEN RAISE EXCEPTION 'NEXUS_SHIFT_INVALID' USING ERRCODE='23514'; END IF;
  v_before:=to_jsonb(p);
  INSERT INTO financial_private.cashier_shift_policy(store_id,cashier_id,enabled,opening_piastre,keep_piastre,updated_by)
   VALUES(p_store,v_cashier,v_enabled,v_open,v_keep,auth.uid()) ON CONFLICT(store_id) DO UPDATE SET cashier_id=excluded.cashier_id,
   enabled=excluded.enabled,opening_piastre=excluded.opening_piastre,keep_piastre=excluded.keep_piastre,updated_by=auth.uid(),updated_at=clock_timestamp();
 ELSIF v_action='open' THEN
  IF p.store_id IS NULL OR NOT p.enabled THEN RAISE EXCEPTION 'NEXUS_SHIFT_DISABLED' USING ERRCODE='23514'; END IF;
  IF NOT v_admin AND auth.uid()<>p.cashier_id THEN RAISE EXCEPTION 'NEXUS_SHIFT_WRONG_CASHIER' USING ERRCODE='42501'; END IF;
  IF p_input->>'floatReceived' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'NEXUS_SHIFT_FLOAT_CONFIRM_REQUIRED' USING ERRCODE='23514'; END IF;
  IF v_admin AND coalesce(length(v_reason),0)<4 THEN RAISE EXCEPTION 'NEXUS_SHIFT_OVERRIDE_REASON_REQUIRED' USING ERRCODE='23514'; END IF;
  IF p.opening_piastre>(SELECT coalesce(sum(amount_delta),0) FROM public.ledger_lines WHERE store_id=p_store AND account='wallet' AND subject_id='inStoreSafe')
   THEN RAISE EXCEPTION 'NEXUS_SHIFT_FLOAT_UNFUNDED' USING ERRCODE='23514'; END IF;
  SELECT retained_piastre INTO v_carry FROM financial_private.cashier_shifts WHERE store_id=p_store AND status='closed' ORDER BY closed_at DESC LIMIT 1;
  INSERT INTO financial_private.cashier_shifts(store_id,cashier_id,shift_day,opened_by,planned_end_at,opening_piastre,keep_piastre,carry_in_piastre,float_adjustment_piastre,status)
   VALUES(p_store,p.cashier_id,(clock_timestamp() AT TIME ZONE 'Africa/Cairo')::date,auth.uid(),clock_timestamp()+interval '8 hours',p.opening_piastre,p.keep_piastre,
    coalesce(v_carry,0),p.opening_piastre-coalesce(v_carry,0),'open') RETURNING id INTO v_shift;
 ELSE
  v_shift:=(p_input->>'shiftId')::uuid;
  SELECT * INTO s FROM financial_private.cashier_shifts WHERE id=v_shift AND store_id=p_store FOR UPDATE;
  IF NOT FOUND OR (NOT v_admin AND s.cashier_id<>auth.uid()) THEN RAISE EXCEPTION 'NEXUS_SHIFT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  v_before:=to_jsonb(s);
  IF v_action='close' THEN
   IF s.status<>'open' THEN RAISE EXCEPTION 'NEXUS_SHIFT_NOT_OPEN' USING ERRCODE='23514'; END IF;
   IF coalesce(p_input->>'actualPiastres','') !~ '^[0-9]+$' OR p_input->>'countConfirmed' IS DISTINCT FROM 'true'
    THEN RAISE EXCEPTION 'NEXUS_SHIFT_COUNT_REQUIRED' USING ERRCODE='23514'; END IF;
   IF v_admin AND coalesce(length(v_reason),0)<4 THEN RAISE EXCEPTION 'NEXUS_SHIFT_OVERRIDE_REASON_REQUIRED' USING ERRCODE='23514'; END IF;
   v_actual:=(p_input->>'actualPiastres')::bigint;
   IF v_actual>1000000000 THEN RAISE EXCEPTION 'NEXUS_SHIFT_INVALID' USING ERRCODE='23514'; END IF;
   SELECT s.opening_piastre+coalesce(sum(cash_piastre),0) INTO v_expected FROM financial_private.cashier_shift_movements WHERE shift_id=s.id;
   UPDATE financial_private.cashier_shifts SET expected_piastre=v_expected,actual_piastre=v_actual,variance_piastre=v_actual-v_expected,
    retained_piastre=least(keep_piastre,v_actual),handover_piastre=v_actual-least(keep_piastre,v_actual),counted_at=clock_timestamp(),counted_by=auth.uid(),
    status=CASE WHEN v_actual=v_expected THEN 'awaiting_handover' ELSE 'awaiting_review' END WHERE id=s.id;
  ELSIF v_action IN ('review_discrepancy','reopen') THEN
   IF NOT v_admin THEN RAISE EXCEPTION 'NEXUS_SHIFT_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
   IF coalesce(length(v_reason),0)<4 OR length(v_reason)>500 THEN RAISE EXCEPTION 'NEXUS_SHIFT_REASON_REQUIRED' USING ERRCODE='23514'; END IF;
   IF v_action='review_discrepancy' THEN
    IF s.status<>'awaiting_review' THEN RAISE EXCEPTION 'NEXUS_SHIFT_STATE_INVALID' USING ERRCODE='23514'; END IF;
    UPDATE financial_private.cashier_shifts SET status='awaiting_handover',discrepancy_reason=v_reason,reviewed_by=auth.uid(),reviewed_at=clock_timestamp() WHERE id=s.id;
   ELSE
    IF s.status NOT IN ('awaiting_review','awaiting_handover') THEN RAISE EXCEPTION 'NEXUS_SHIFT_STATE_INVALID' USING ERRCODE='23514'; END IF;
    UPDATE financial_private.cashier_shifts SET status='open',expected_piastre=NULL,actual_piastre=NULL,variance_piastre=NULL,retained_piastre=NULL,handover_piastre=NULL,
     counted_at=NULL,counted_by=NULL,discrepancy_reason=NULL,reviewed_by=NULL,reviewed_at=NULL WHERE id=s.id;
   END IF;
  ELSIF v_action='report_handover' THEN
   IF v_admin AND coalesce(length(v_reason),0)<4 THEN RAISE EXCEPTION 'NEXUS_SHIFT_OVERRIDE_REASON_REQUIRED' USING ERRCODE='23514'; END IF;
   IF s.status<>'awaiting_handover' OR p_input->>'physicalHandoverConfirmed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'NEXUS_SHIFT_HANDOVER_CONFIRM_REQUIRED' USING ERRCODE='23514'; END IF;
   UPDATE financial_private.cashier_shifts SET status='handover_reported',handover_reported_by=auth.uid(),handover_reported_at=clock_timestamp() WHERE id=s.id;
  ELSIF v_action='confirm_handover' THEN
   IF NOT v_admin THEN RAISE EXCEPTION 'NEXUS_SHIFT_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
   IF s.status<>'handover_reported' OR p_input->>'cashReceivedConfirmed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'NEXUS_SHIFT_RECEIPT_CONFIRM_REQUIRED' USING ERRCODE='23514'; END IF;
   UPDATE financial_private.cashier_shifts SET status='closed',received_by=auth.uid(),closed_at=clock_timestamp() WHERE id=s.id;
  ELSIF v_action='attach_movement' THEN
   IF NOT v_admin THEN RAISE EXCEPTION 'NEXUS_SHIFT_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
   IF s.status<>'open' OR coalesce(length(v_reason),0)<4 OR length(v_reason)>500 THEN RAISE EXCEPTION 'NEXUS_SHIFT_REASON_REQUIRED' USING ERRCODE='23514'; END IF;
   FOR v_line IN SELECT l.*,e.kind FROM public.ledger_lines l JOIN public.ledger_events e ON e.id=l.event_id AND e.store_id=l.store_id
    JOIN financial_private.cashier_shift_candidates c ON c.ledger_line_id=l.id AND c.shift_id=s.id
    WHERE l.store_id=p_store AND l.event_id=p_input->>'eventId' AND l.account='wallet' AND l.subject_id='inStoreSafe'
     AND NOT(e.kind='sale' AND e.ref_type='pos_sale') LOOP
    INSERT INTO financial_private.cashier_shift_movements(ledger_line_id,shift_id,event_id,actor_id,wallet_id,payment_piastre,cash_piastre,category,reason)
     VALUES(v_line.id,s.id,v_line.event_id,auth.uid(),v_line.subject_id,v_line.amount_delta,v_line.amount_delta,
      CASE WHEN v_line.kind IN ('expense','payroll') AND v_line.amount_delta<0 THEN 'expense' ELSE 'other' END,v_reason);
    v_count:=v_count+1;
   END LOOP;
   IF v_count=0 THEN RAISE EXCEPTION 'NEXUS_SHIFT_MOVEMENT_INVALID' USING ERRCODE='23514'; END IF;
  ELSE RAISE EXCEPTION 'NEXUS_SHIFT_INVALID' USING ERRCODE='23514';
  END IF;
 END IF;
 INSERT INTO financial_private.cashier_shift_audit(store_id,shift_id,actor_id,action,detail)
  VALUES(p_store,v_shift,auth.uid(),v_action,jsonb_build_object('requestId',p_id,'input',p_input,'before',v_before));
 v_result:=jsonb_build_object('requestId',p_id,'shiftId',v_shift,'action',v_action,'replayed',false);
 INSERT INTO financial_private.cashier_shift_requests(id,store_id,actor_id,request,result) VALUES(p_id,p_store,auth.uid(),p_input,v_result);
 RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION financial_private.cashier_shift_summary(uuid),financial_private.capture_cashier_shift_payment(),financial_private.check_cashier_drawer_cash() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cashier_shift_snapshot(uuid),public.record_cashier_shift(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cashier_shift_snapshot(uuid),public.record_cashier_shift(text,uuid,uuid,text,jsonb) TO authenticated;
