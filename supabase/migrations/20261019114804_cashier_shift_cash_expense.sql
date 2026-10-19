-- LOCAL CANDIDATE ONLY: owner approval required before Production application.
-- Reuse expense documents, category caps, immutable ledger and existing shift requests.
-- No new tables, broad cashier finance grants, history rewrite or balance reset.
-- Canonical validation remains mandatory. Pure expense/wallet events have no
-- stock application; skip that no-op without changing any stock permission.
DO $migration$
DECLARE d text; needle text:='PERFORM financial_private.apply_stock_event(v_id);';
BEGIN
 d:=replace(pg_get_functiondef('financial_private.append_authorized_event(jsonb)'::regprocedure),chr(13),'');
 IF strpos(d,needle)=0 OR strpos(d,'PERFORM public.ledger_validate_event(p_event);')=0
  THEN RAISE EXCEPTION 'NEXUS_SHIFT_EXPENSE_POSTING_DRIFT'; END IF;
 EXECUTE replace(d,needle,$insert$IF p_event->>'kind' IS DISTINCT FROM 'expense' OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(p_event->'lines') l WHERE l->>'account' NOT IN ('expense','wallet')) THEN
   PERFORM financial_private.apply_stock_event(v_id);
  END IF;$insert$);
END $migration$;
CREATE OR REPLACE FUNCTION financial_private.record_expense_document(p_expense jsonb, p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_id       text := p_expense ->> 'id';
  v_store    uuid := (p_expense ->> 'store_id')::uuid;
  v_category text := p_expense ->> 'category';
  v_amount   numeric := (p_expense ->> 'amount')::numeric;
  v_row      jsonb;
  v_cap      numeric;
  v_spent    numeric;
  v_booked   bigint;
BEGIN
  IF v_id IS NULL OR v_store IS NULL OR NULLIF(v_category, '') IS NULL OR v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'NEXUS_DOCUMENT_INVALID' USING ERRCODE = '23514';
  END IF;

  -- A retry after a lost answer: the expense is already paid. Say so.
  SELECT to_jsonb(x.*) INTO v_row FROM public.expenses x WHERE x.id = v_id AND x.store_id = v_store;
  IF v_row IS NOT NULL THEN
    RETURN jsonb_build_object('expense', v_row, 'replayed', true);
  END IF;

  -- The event must be THIS expense: same store, pointing at this document, and
  -- booking exactly this amount to exactly this category.
  SELECT COALESCE(SUM((l ->> 'amount_delta')::bigint), 0) INTO v_booked
    FROM jsonb_array_elements(COALESCE(p_event -> 'lines', '[]'::jsonb)) l
   WHERE l ->> 'account' = 'expense' AND l ->> 'subject_id' = v_category;
  IF p_event ->> 'kind' IS DISTINCT FROM 'expense'
     OR (p_event ->> 'store_id')::uuid IS DISTINCT FROM v_store
     OR p_event ->> 'ref_type' IS DISTINCT FROM 'expense'
     OR p_event ->> 'ref_id' IS DISTINCT FROM v_id
     OR v_booked <> round(v_amount * 100) THEN
    RAISE EXCEPTION 'NEXUS_EVENT_NOT_THIS_DOCUMENT' USING ERRCODE = '23514';
  END IF;

  -- The cap, before anything moves. Locked, so two devices spending the last
  -- of a budget at once cannot both pass.
  SELECT c."capAmount" INTO v_cap FROM public.budget_caps c
   WHERE c.store_id = v_store AND c.category = v_category AND c.deleted_at IS NULL
   FOR UPDATE;
  IF v_cap IS NOT NULL THEN
    SELECT COALESCE(SUM(e.amount), 0) INTO v_spent FROM public.expenses e
     WHERE e.store_id = v_store AND e.category = v_category AND e.deleted_at IS NULL;
    IF v_category = 'salaries' THEN
      v_spent := v_spent + (SELECT COALESCE(SUM(p.amount), 0) FROM public.payroll p
                             WHERE p.store_id = v_store AND p.deleted_at IS NULL);
    END IF;
    IF v_spent + v_amount > v_cap THEN
      RAISE EXCEPTION 'NEXUS_OVER_BUDGET' USING ERRCODE = '23514',
        DETAIL = format('cap %s, spent %s, requested %s', v_cap, v_spent, v_amount);
    END IF;
  END IF;

  INSERT INTO public.expenses (id, store_id, device_id, category, amount, description, date,
                               ledger_event_id, updated_at, sync_status)
  VALUES (v_id, v_store, (p_expense ->> 'device_id')::uuid, v_category, v_amount,
          p_expense ->> 'description', COALESCE((p_expense ->> 'date')::timestamptz, now()),
          p_event ->> 'id', (extract(epoch FROM clock_timestamp()) * 1000)::bigint, 'synced')
  RETURNING to_jsonb(expenses.*) INTO v_row;

  PERFORM financial_private.append_authorized_event(p_event);
  RETURN jsonb_build_object('expense', v_row, 'replayed', false);
END;
$function$
;
REVOKE ALL ON FUNCTION financial_private.record_expense_document(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.record_expense(p_expense jsonb,p_event jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_store uuid:=(p_expense->>'store_id')::uuid;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(v_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false)
  THEN RAISE EXCEPTION 'NEXUS_LEDGER_FORBIDDEN' USING ERRCODE='42501'; END IF;
 -- All expense writers take the existing store financial lock before cap rows.
 -- This avoids cap -> drawer vs drawer -> cap deadlocks with the new action.
 PERFORM financial_private.fulfillment_lock(v_store);
 RETURN financial_private.record_expense_document(p_expense,p_event);
END $$;
REVOKE ALL ON FUNCTION public.record_expense(jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_expense(jsonb,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION financial_private.cashier_shift_summary(p_id uuid) RETURNS jsonb
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
    CASE WHEN e.kind='expense' THEN e.payload::jsonb->>'description' END expense_description,
    CASE WHEN e.kind='expense' THEN e.payload::jsonb->>'category' END expense_category,
    coalesce(e.payload::jsonb->>'documentNumber',e.payload::jsonb->>'sourceDocumentNumber',e.id) document_number
    FROM financial_private.cashier_shift_movements m JOIN public.ledger_events e ON e.id=m.event_id
    WHERE m.shift_id=s.id ORDER BY m.recorded_at DESC,m.ledger_line_id LIMIT 200) x),'[]'::jsonb))
 FROM financial_private.cashier_shifts s WHERE s.id=p_id;
$$;
-- Called only by the existing authenticated shift dispatcher after its lock/replay checks.
-- Financial writes MUST stay outside PL/pgSQL exception/savepoint blocks: canonical
-- stock/backorder integrity checks intentionally require the current top-level xid.
CREATE FUNCTION financial_private.record_cashier_shift_expense(p_id text,p_store uuid,p_device uuid,p_input jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE s financial_private.cashier_shifts; v_before jsonb; v_error text; v_result jsonb;
 v_amount bigint; v_category text; v_note text; v_expected bigint; v_cap numeric; v_spent numeric;
 v_expense text:='shift-expense:'||p_id; v_event jsonb; v_row jsonb; v_count integer; v_now timestamptz:=clock_timestamp();
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['CASHIER_ONLY']),false)
  THEN v_error:='NEXUS_SHIFT_WRONG_CASHIER';
 ELSIF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('action','shiftId','expectedRevision','category','amountPiastres','note'))
  OR coalesce(p_input->>'amountPiastres','') !~ '^[0-9]{1,10}$'
  OR coalesce(p_input->>'shiftId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  OR coalesce(p_input->>'expectedRevision','') !~ '^[0-9]{1,18}$'
  OR (p_input ? 'note' AND jsonb_typeof(p_input->'note') IS DISTINCT FROM 'string')
  THEN v_error:='NEXUS_SHIFT_EXPENSE_INVALID';
 ELSE
  v_amount:=(p_input->>'amountPiastres')::bigint;v_category:=p_input->>'category';v_note:=nullif(btrim(p_input->>'note'),'');
  IF v_amount NOT BETWEEN 1 AND 1000000000 OR coalesce(v_category,'') NOT IN ('store_rent','shipping','marketing','office_supplies','utilities','transport','maintenance','other')
   OR length(v_note)>500 THEN v_error:='NEXUS_SHIFT_EXPENSE_INVALID';
  ELSE
   SELECT * INTO s FROM financial_private.cashier_shifts WHERE id=(p_input->>'shiftId')::uuid AND store_id=p_store AND cashier_id=auth.uid() FOR UPDATE;
   IF NOT FOUND THEN v_error:='NEXUS_SHIFT_FORBIDDEN';
   ELSE
    v_before:=to_jsonb(s);
    IF (p_input->>'expectedRevision')::bigint<>s.revision THEN v_error:='NEXUS_SHIFT_STATE_CHANGED';
    ELSIF s.status<>'open' OR NOT EXISTS(SELECT 1 FROM financial_private.cashier_shift_policy WHERE store_id=p_store AND enabled)
     THEN v_error:='NEXUS_SHIFT_NOT_OPEN';
    ELSE
     SELECT s.opening_piastre+coalesce(sum(cash_piastre),0) INTO v_expected FROM financial_private.cashier_shift_movements WHERE shift_id=s.id;
     IF v_amount>v_expected THEN v_error:='NEXUS_DRAWER_CASH_INSUFFICIENT';
     ELSE
      -- Preflight the SAME existing cap while holding its row. The shared
      -- document writer rechecks it. No financial write is caught/committed partially.
      SELECT c."capAmount" INTO v_cap FROM public.budget_caps c WHERE c.store_id=p_store AND c.category=v_category AND c.deleted_at IS NULL FOR UPDATE;
      IF v_cap IS NOT NULL THEN
       SELECT coalesce(sum(e.amount),0) INTO v_spent FROM public.expenses e WHERE e.store_id=p_store AND e.category=v_category AND e.deleted_at IS NULL;
       IF v_spent+v_amount::numeric/100>v_cap THEN v_error:='NEXUS_OVER_BUDGET'; END IF;
      END IF;
     END IF;
    END IF;
   END IF;
  END IF;
 END IF;
 IF v_error IS NULL THEN
  v_event:=jsonb_build_object('id',v_expense,'store_id',p_store,'device_id',p_device,'kind','expense',
   'actor',auth.uid()::text,'ref_type','expense','ref_id',v_expense,'occurred_at',v_now::text,'created_at',v_now::text,
   'payload',jsonb_build_object('category',v_category,'description',v_note,'wallet','inStoreSafe','shiftId',s.id,'cashierId',auth.uid()),
   'lines',jsonb_build_array(
    jsonb_build_object('id',v_expense||':expense','account','expense','subject_id',v_category,'amount_delta',v_amount,'qty_delta',0),
    jsonb_build_object('id',v_expense||':cash','account','wallet','subject_id','inStoreSafe','amount_delta',-v_amount,'qty_delta',0)));
  v_row:=financial_private.record_expense_document(jsonb_build_object('id',v_expense,'store_id',p_store,'device_id',p_device,
   'category',v_category,'amount',v_amount::numeric/100,'description',v_note,'date',v_now),v_event);
  IF v_row->>'replayed'='true' THEN RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514'; END IF;
  INSERT INTO financial_private.cashier_shift_movements(ledger_line_id,shift_id,event_id,actor_id,wallet_id,payment_piastre,cash_piastre,category,reason)
   SELECT l.id,s.id,l.event_id,auth.uid(),l.subject_id,l.amount_delta,l.amount_delta,'expense',v_note FROM public.ledger_lines l
   WHERE l.id=v_expense||':cash' AND l.event_id=v_expense AND l.store_id=p_store AND l.account='wallet' AND l.subject_id='inStoreSafe' AND l.amount_delta=-v_amount;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN RAISE EXCEPTION 'NEXUS_SHIFT_EXPENSE_INVALID' USING ERRCODE='23514'; END IF;
  UPDATE financial_private.cashier_shifts SET revision=revision+1 WHERE id=s.id;
  v_result:=jsonb_build_object('requestId',p_id,'shiftId',s.id,'action','expense','replayed',false,'expenseId',v_expense,'eventId',v_expense,'amountPiastres',v_amount);
 ELSE
  v_result:=jsonb_build_object('requestId',p_id,'action','expense','replayed',false,'rejected',true,'code',v_error);
 END IF;
 INSERT INTO financial_private.cashier_shift_audit(store_id,shift_id,actor_id,action,detail)
  VALUES(p_store,s.id,auth.uid(),CASE WHEN v_error IS NULL THEN 'expense' ELSE 'rejected_expense' END,
   jsonb_build_object('requestId',p_id,'input',p_input,'before',v_before,'code',v_error));
 INSERT INTO financial_private.cashier_shift_requests(id,store_id,actor_id,request,result) VALUES(p_id,p_store,auth.uid(),p_input,v_result);
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION financial_private.record_cashier_shift_expense(text,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.record_cashier_shift(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p financial_private.cashier_shift_policy; s financial_private.cashier_shifts; v_old financial_private.cashier_shift_requests;
 v_admin boolean; v_action text:=p_input->>'action'; v_reason text:=nullif(btrim(p_input->>'reason'),'');
 v_result jsonb; v_before jsonb; v_open bigint; v_keep bigint; v_actual bigint; v_expected bigint; v_carry bigint:=0;
 v_cashier uuid; v_line record; v_count integer:=0; v_shift uuid; v_enabled boolean; v_error text; v_constraint text;
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
 IF v_action='expense' THEN RETURN financial_private.record_cashier_shift_expense(p_id,p_store,p_device,p_input); END IF;
 v_admin:=coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN']),false);
 BEGIN
 IF length(v_reason)>500 THEN RAISE EXCEPTION 'NEXUS_SHIFT_REASON_REQUIRED' USING ERRCODE='23514'; END IF;
 SELECT * INTO p FROM financial_private.cashier_shift_policy WHERE store_id=p_store;
 IF v_action='configure' THEN
  IF NOT v_admin THEN RAISE EXCEPTION 'NEXUS_SHIFT_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM financial_private.cashier_shifts WHERE store_id=p_store AND status<>'closed') THEN RAISE EXCEPTION 'NEXUS_SHIFT_ACTIVE' USING ERRCODE='23514'; END IF;
  IF coalesce(p_input->>'expectedPolicyRevision','') !~ '^[0-9]+$' OR (p_input->>'expectedPolicyRevision')::bigint IS DISTINCT FROM coalesce(p.revision,0)
   THEN RAISE EXCEPTION 'NEXUS_SHIFT_POLICY_CHANGED' USING ERRCODE='23514'; END IF;
  IF coalesce(p_input->>'openingPiastres','') !~ '^[0-9]+$' OR coalesce(p_input->>'keepPiastres','') !~ '^[0-9]+$'
   OR jsonb_typeof(p_input->'enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'NEXUS_SHIFT_INVALID' USING ERRCODE='23514'; END IF;
  v_open:=(p_input->>'openingPiastres')::bigint;v_keep:=(p_input->>'keepPiastres')::bigint;v_cashier:=(p_input->>'cashierId')::uuid;v_enabled:=(p_input->>'enabled')::boolean;
  IF NOT EXISTS(SELECT 1 FROM public.store_members WHERE store_id=p_store AND user_id=v_cashier AND role='CASHIER_ONLY')
   OR v_open>1000000000 OR v_keep>1000000000 THEN RAISE EXCEPTION 'NEXUS_SHIFT_INVALID' USING ERRCODE='23514'; END IF;
  v_before:=to_jsonb(p);
  INSERT INTO financial_private.cashier_shift_policy(store_id,cashier_id,enabled,opening_piastre,keep_piastre,updated_by)
   VALUES(p_store,v_cashier,v_enabled,v_open,v_keep,auth.uid()) ON CONFLICT(store_id) DO UPDATE SET cashier_id=excluded.cashier_id,
   enabled=excluded.enabled,opening_piastre=excluded.opening_piastre,keep_piastre=excluded.keep_piastre,updated_by=auth.uid(),updated_at=clock_timestamp(),revision=cashier_shift_policy.revision+1;
 ELSIF v_action='open' THEN
  IF p.store_id IS NULL OR NOT p.enabled THEN RAISE EXCEPTION 'NEXUS_SHIFT_DISABLED' USING ERRCODE='23514'; END IF;
  IF NOT v_admin AND auth.uid()<>p.cashier_id THEN RAISE EXCEPTION 'NEXUS_SHIFT_WRONG_CASHIER' USING ERRCODE='42501'; END IF;
  IF p_input->>'floatReceived' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'NEXUS_SHIFT_FLOAT_CONFIRM_REQUIRED' USING ERRCODE='23514'; END IF;
  IF coalesce(p_input->>'expectedPolicyRevision','') !~ '^[0-9]+$' OR (p_input->>'expectedPolicyRevision')::bigint IS DISTINCT FROM p.revision
   THEN RAISE EXCEPTION 'NEXUS_SHIFT_POLICY_CHANGED' USING ERRCODE='23514'; END IF;
  IF v_admin AND coalesce(length(v_reason),0)<4 THEN RAISE EXCEPTION 'NEXUS_SHIFT_OVERRIDE_REASON_REQUIRED' USING ERRCODE='23514'; END IF;
  IF p.opening_piastre>(SELECT coalesce(sum(amount_delta),0) FROM public.ledger_lines WHERE store_id=p_store AND account='wallet' AND subject_id='inStoreSafe')
   THEN RAISE EXCEPTION 'NEXUS_SHIFT_FLOAT_UNFUNDED' USING ERRCODE='23514'; END IF;
  SELECT retained_piastre INTO v_carry FROM financial_private.cashier_shifts WHERE store_id=p_store AND status='closed' ORDER BY closed_at DESC LIMIT 1;
  IF FOUND AND p.opening_piastre IS DISTINCT FROM v_carry AND p_input->>'floatAdjustmentConfirmed' IS DISTINCT FROM 'true'
   THEN RAISE EXCEPTION 'NEXUS_SHIFT_FLOAT_TRANSFER_CONFIRM_REQUIRED' USING ERRCODE='23514'; END IF;
  INSERT INTO financial_private.cashier_shifts(store_id,cashier_id,shift_day,opened_by,planned_end_at,opening_piastre,keep_piastre,carry_in_piastre,float_adjustment_piastre,status)
   VALUES(p_store,p.cashier_id,(clock_timestamp() AT TIME ZONE 'Africa/Cairo')::date,auth.uid(),clock_timestamp()+interval '8 hours',p.opening_piastre,p.keep_piastre,
    coalesce(v_carry,0),p.opening_piastre-coalesce(v_carry,0),'open') RETURNING id INTO v_shift;
 ELSE
  v_shift:=(p_input->>'shiftId')::uuid;
  SELECT * INTO s FROM financial_private.cashier_shifts WHERE id=v_shift AND store_id=p_store FOR UPDATE;
  IF NOT FOUND OR (NOT v_admin AND s.cashier_id<>auth.uid()) THEN RAISE EXCEPTION 'NEXUS_SHIFT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  v_before:=to_jsonb(s);
  IF coalesce(p_input->>'expectedRevision','') !~ '^[0-9]+$' OR (p_input->>'expectedRevision')::bigint IS DISTINCT FROM s.revision
   THEN RAISE EXCEPTION 'NEXUS_SHIFT_STATE_CHANGED' USING ERRCODE='23514'; END IF;
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
  IF v_action='attach_movement' AND (SELECT s.opening_piastre+coalesce(sum(cash_piastre),0) FROM financial_private.cashier_shift_movements WHERE shift_id=s.id)<0
   THEN RAISE EXCEPTION 'NEXUS_DRAWER_CASH_INSUFFICIENT' USING ERRCODE='23514'; END IF;
  UPDATE financial_private.cashier_shifts SET revision=revision+1 WHERE id=s.id;
 END IF;
 EXCEPTION WHEN check_violation OR insufficient_privilege OR unique_violation THEN
  GET STACKED DIAGNOSTICS v_error=MESSAGE_TEXT,v_constraint=CONSTRAINT_NAME;
  IF v_error LIKE 'NEXUS_SHIFT_%' OR v_error='NEXUS_DRAWER_CASH_INSUFFICIENT' THEN NULL;
  ELSIF SQLSTATE='23505' AND v_constraint IN ('cashier_shifts_store_id_shift_day_key','cashier_shift_one_active','cashier_shift_movements_pkey') THEN v_error:='NEXUS_SHIFT_DUPLICATE';
  ELSE RAISE; END IF;
  -- Durable negative receipt: late retries can never make a rejected physical acknowledgement valid later.
  v_result:=jsonb_build_object('requestId',p_id,'action',v_action,'replayed',false,'rejected',true,'code',v_error);
  IF v_before IS NULL THEN v_shift:=NULL; END IF;
 END;
 INSERT INTO financial_private.cashier_shift_audit(store_id,shift_id,actor_id,action,detail)
  VALUES(p_store,v_shift,auth.uid(),CASE WHEN v_result->>'rejected'='true' THEN 'rejected_'||coalesce(v_action,'invalid') ELSE v_action END,
   jsonb_build_object('requestId',p_id,'input',p_input,'before',v_before,'code',v_result->>'code'));
 v_result:=coalesce(v_result,jsonb_build_object('requestId',p_id,'shiftId',v_shift,'action',v_action,'replayed',false));
 INSERT INTO financial_private.cashier_shift_requests(id,store_id,actor_id,request,result) VALUES(p_id,p_store,auth.uid(),p_input,v_result);
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION financial_private.cashier_shift_summary(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.record_cashier_shift(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_cashier_shift(text,uuid,uuid,text,jsonb) TO authenticated;
