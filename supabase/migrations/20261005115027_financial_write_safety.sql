-- Forward-only: nullable receipt metadata leaves every historical event untouched.
-- The existing event primary key IS the operation identity; no second ID scheme.
ALTER TABLE public.ledger_events ADD COLUMN IF NOT EXISTS command_request jsonb;
ALTER TABLE public.ledger_events ADD COLUMN IF NOT EXISTS command_result jsonb;

CREATE OR REPLACE FUNCTION public.ledger_append(p_event jsonb)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path TO public, pg_temp AS $$
DECLARE
  v_id text := p_event->>'id';
  v_store uuid := (p_event->>'store_id')::uuid;
  v_device uuid := (p_event->>'device_id')::uuid;
  v_count integer;
BEGIN
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
  RETURN v_id;
END $$;

-- All three commands use this single replay boundary. No exception block around
-- ledger_append: its existing same-transaction xmin line policy remains valid.
CREATE OR REPLACE FUNCTION public.record_financial_command(
  p_id text, p_store uuid, p_device uuid, p_command text, p_input jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path TO public, pg_temp AS $$
DECLARE
  v_request jsonb := jsonb_build_object('command',p_command,'input',p_input);
  v_old public.ledger_events%ROWTYPE;
  v_event jsonb;
  v_lines jsonb := '[]';
  v_items jsonb := '[]';
  v_item jsonb;
  v_supplier public.suppliers%ROWTYPE;
  v_invoice public.purchase_invoices%ROWTYPE;
  v_result jsonb;
  v_allocations jsonb := '[]';
  v_total numeric := 0;
  v_paid numeric;
  v_left numeric;
  v_applied numeric;
  v_quantity numeric;
  v_cost numeric;
  v_ref text;
  v_kind text;
  v_updated integer;
  -- Ledger readers compare these text timestamps with JavaScript ISO bounds.
  v_now text := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false) THEN
    RAISE EXCEPTION 'NEXUS_FINANCE_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF nullif(p_id,'') IS NULL OR p_device IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' THEN
    RAISE EXCEPTION 'NEXUS_COMMAND_INVALID' USING ERRCODE='23514';
  END IF;
  IF p_command='ledger' AND p_input->>'kind' IN ('owner_capital','owner_contribution')
     AND NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN']),false) THEN
    RAISE EXCEPTION 'NEXUS_FINANCE_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('financial-command|' || p_id,0));
  SELECT * INTO v_old FROM public.ledger_events WHERE id=p_id AND store_id=p_store;
  IF FOUND THEN
    IF v_old.command_request IS DISTINCT FROM v_request OR v_old.command_result IS NULL THEN
      RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514';
    END IF;
    RETURN v_old.command_result || jsonb_build_object('replayed',true);
  END IF;

  IF p_command='ledger' THEN
    v_kind := p_input->>'kind';
    IF v_kind NOT IN ('owner_draw','owner_capital','owner_contribution','stock_adjustment')
       OR (v_kind='stock_adjustment' AND p_input->>'refType' IS DISTINCT FROM 'opening_balance') THEN
      RAISE EXCEPTION 'NEXUS_COMMAND_KIND' USING ERRCODE='23514';
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',gen_random_uuid()::text,'account',l->>'account','subject_id',l->>'subjectId',
      'qty_delta',coalesce((l->>'qty')::numeric,0),'amount_delta',floor(coalesce((l->>'amount')::numeric,0)*100+0.5),
      'unit_cost',floor((l->>'unitCost')::numeric*100+0.5))),'[]'::jsonb) INTO v_lines FROM jsonb_array_elements(p_input->'lines') l;
    v_event := jsonb_build_object('kind',v_kind,'ref_type',p_input->>'refType','ref_id',p_input->>'refId',
      'actor',p_input->>'actor','occurred_at',coalesce(p_input->>'occurredAt',v_now),'payload',coalesce(p_input->'payload','{}'::jsonb)::text);
    v_result := jsonb_build_object('eventId',p_id);

  ELSIF p_command='receipt' THEN
    -- Serialize receipts/payments for one supplier, including the invoice set.
    IF p_input->>'supplierId'='__new__' THEN
      IF nullif(trim(p_input->>'newSupplierName'),'') IS NULL THEN
        RAISE EXCEPTION 'NEXUS_SUPPLIER_REQUIRED' USING ERRCODE='23514';
      END IF;
      INSERT INTO public.suppliers(id,store_id,device_id,"companyName","contactPerson",phone,"createdAt","updatedAt",updated_at,sync_status)
      VALUES(p_id,p_store,p_device,trim(p_input->>'newSupplierName'),'',coalesce(p_input->>'newSupplierPhone',''),now(),now(),(extract(epoch FROM clock_timestamp())*1000)::bigint,'synced') RETURNING * INTO v_supplier;
    ELSE
      SELECT * INTO v_supplier FROM public.suppliers WHERE id=p_input->>'supplierId' AND store_id=p_store AND deleted_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_SUPPLIER_REQUIRED' USING ERRCODE='23514'; END IF;
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_input->'items') LOOP
      v_quantity := (v_item->>'quantity')::numeric;
      v_cost := (v_item->>'unitCost')::numeric;
      IF v_quantity IS NULL OR v_quantity<=0 OR v_quantity::text IN ('NaN','Infinity','-Infinity') OR v_cost IS NULL OR v_cost<0 OR v_cost::text IN ('NaN','Infinity','-Infinity') OR nullif(v_item->>'productId','') IS NULL THEN
        RAISE EXCEPTION 'NEXUS_RECEIPT_LINE_INVALID' USING ERRCODE='23514';
      END IF;
      v_total := v_total + v_quantity*v_cost;
      v_items := v_items || jsonb_build_array(v_item || jsonb_build_object('id',gen_random_uuid()::text,'sku',coalesce(v_item->>'sku',''),'total',v_quantity*v_cost));
      -- Same line semantics as buildPurchaseLines: stock by product, EGP→piastres.
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','stock','subject_id',v_item->>'productId','qty_delta',v_quantity,'amount_delta',round(v_quantity*v_cost*100),'unit_cost',round(v_cost*100)));
    END LOOP;
    IF jsonb_array_length(v_items)=0 THEN RAISE EXCEPTION 'NEXUS_RECEIPT_EMPTY' USING ERRCODE='23514'; END IF;
    v_paid := least(greatest(coalesce((p_input->>'paidAmount')::numeric,v_total),0),v_total);
    IF v_paid::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'NEXUS_AMOUNT_INVALID' USING ERRCODE='23514'; END IF;
    IF v_paid>0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','wallet','subject_id',p_input->>'wallet','amount_delta',-round(v_paid*100)));
    END IF;
    IF v_total>v_paid THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','payable_supplier','subject_id',v_supplier.id,'amount_delta',round((v_total-v_paid)*100)));
    END IF;
    -- Counter lock serializes invoice numbers; skip legacy numbers, no deletion.
    LOOP
      v_ref := public.next_document_number(p_store,'purchase_invoice','FM-');
      EXIT WHEN NOT EXISTS(SELECT 1 FROM public.purchase_invoices WHERE store_id=p_store AND "invoiceNumber"=v_ref);
    END LOOP;
    INSERT INTO public.purchase_invoices(id,store_id,device_id,"invoiceNumber","supplierId","supplierName",items,"totalAmount","paidAmount","remainingAmount","dueDate",status,notes,"createdAt","updatedAt",updated_at,sync_status)
    VALUES(p_id,p_store,p_device,v_ref,v_supplier.id,v_supplier."companyName",v_items,v_total,v_paid,v_total-v_paid,coalesce(p_input->>'dueDate',current_date::text),CASE WHEN v_paid>=v_total THEN 'paid' WHEN v_paid>0 THEN 'partial' ELSE 'unpaid' END,coalesce(p_input->>'notes',''),now(),now(),(extract(epoch FROM clock_timestamp())*1000)::bigint,'synced') RETURNING * INTO v_invoice;
    v_event := jsonb_build_object('kind','purchase','ref_type','supplier_invoice','ref_id',v_ref,'actor',p_input->>'actor','occurred_at',v_now,
      'payload',(jsonb_build_object('invoiceNumber',v_ref,'supplierName',v_supplier."companyName",'itemCount',jsonb_array_length(v_items),'wallet',p_input->>'wallet','via',p_input->>'via') || coalesce(p_input->'payloadExtra','{}'::jsonb))::text);
    v_result := jsonb_build_object('eventId',p_id,'invoiceId',p_id,'invoiceNumber',v_ref,'invoice',to_jsonb(v_invoice),'supplier',to_jsonb(v_supplier),'total',v_total,'itemCount',jsonb_array_length(v_items));

  ELSIF p_command='supplier_payment' THEN
    v_paid := round((p_input->>'amount')::numeric,2);
    IF v_paid IS NULL OR v_paid<=0 OR v_paid::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'NEXUS_AMOUNT_INVALID' USING ERRCODE='23514'; END IF;
    SELECT * INTO v_supplier FROM public.suppliers WHERE id=p_input->>'supplierId' AND store_id=p_store AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_SUPPLIER_REQUIRED' USING ERRCODE='23514'; END IF;
    v_left := v_paid;
    FOR v_invoice IN SELECT * FROM public.purchase_invoices WHERE store_id=p_store AND "supplierId"=v_supplier.id AND deleted_at IS NULL AND "remainingAmount">0
      ORDER BY CASE WHEN "dueDate" IS NULL THEN "createdAt"
        WHEN pg_input_is_valid("dueDate",'timestamp with time zone') THEN "dueDate"::timestamptz
        ELSE 'infinity'::timestamptz END,"createdAt",id FOR UPDATE LOOP
      EXIT WHEN v_left<=0;
      v_applied := least(v_left,round(v_invoice."remainingAmount",2));
      v_allocations := v_allocations || jsonb_build_array(jsonb_build_object('invoiceId',v_invoice.id,'invoiceNumber',v_invoice."invoiceNumber",'outstanding',round(v_invoice."remainingAmount",2),'applied',v_applied));
      UPDATE public.purchase_invoices SET "paidAmount"="paidAmount"+v_applied,"remainingAmount"=greatest(0,"remainingAmount"-v_applied),
        status=CASE WHEN "remainingAmount"-v_applied<=0 THEN 'paid' ELSE 'partial' END,"updatedAt"=now(),updated_at=(extract(epoch FROM clock_timestamp())*1000)::bigint
        WHERE id=v_invoice.id AND store_id=p_store;
      GET DIAGNOSTICS v_updated = ROW_COUNT;
      IF v_updated <> 1 THEN RAISE EXCEPTION 'NEXUS_ALLOCATION_NOT_WRITTEN' USING ERRCODE='23514'; END IF;
      v_left := round(v_left-v_applied,2);
    END LOOP;
    v_ref := public.next_document_number(p_store,'supplier_payment','SP-');
    v_lines := jsonb_build_array(
      jsonb_build_object('id',gen_random_uuid()::text,'account','wallet','subject_id',p_input->>'wallet','amount_delta',-round(v_paid*100)),
      jsonb_build_object('id',gen_random_uuid()::text,'account','payable_supplier','subject_id',v_supplier.id,'amount_delta',-round(v_paid*100)));
    v_event := jsonb_build_object('kind','supplier_payment','ref_type','supplier_payment','ref_id',v_ref,'actor',coalesce(p_input->>'actor','الكاشير'),'occurred_at',v_now,
      'payload',jsonb_build_object('paymentRef',v_ref,'supplierId',v_supplier.id,'supplierName',v_supplier."companyName",'wallet',p_input->>'wallet','amount',v_paid,'note',coalesce(p_input->>'note',''),'allocations',v_allocations,'unapplied',v_left)::text);
    v_result := jsonb_build_object('eventId',p_id,'paymentRef',v_ref,'amount',v_paid,'applied',v_paid-v_left,'unapplied',v_left,'allocations',v_allocations);
  ELSE
    RAISE EXCEPTION 'NEXUS_COMMAND_KIND' USING ERRCODE='23514';
  END IF;
  v_result := v_result || jsonb_build_object('replayed',false);
  v_event := v_event || jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'created_at',v_now,'lines',v_lines,'command_request',v_request,'command_result',v_result);
  PERFORM public.ledger_append(v_event);
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.record_financial_command(text,uuid,uuid,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_financial_command(text,uuid,uuid,text,jsonb) TO authenticated;
