-- LOCAL ONLY. Requires 20261019114804_cashier_shift_cash_expense first.
-- Sequential custody records, not new wallets or a rewrite of closed shifts.
-- The approved runner must wrap this batch with bounded lock/statement timeouts.
DO $migration$
DECLARE d text; needle text; replacement text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='financial_private.cashier_shifts'::regclass
   AND conname='cashier_shifts_store_id_shift_day_key' AND pg_get_constraintdef(oid)='UNIQUE (store_id, shift_day)')
  OR to_regprocedure('financial_private.record_cashier_shift_expense(text,uuid,uuid,jsonb)') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='financial_private.cashier_shift_one_active'::regclass
   AND indisunique AND pg_get_expr(indpred,indrelid)='(status <> ''closed''::text)')
 THEN RAISE EXCEPTION 'NEXUS_SEQUENTIAL_SHIFT_SCHEMA_DRIFT'; END IF;

 d:=replace(pg_get_functiondef('public.record_cashier_shift(text,uuid,uuid,text,jsonb)'::regprocedure),chr(13),'');
 needle:='SELECT retained_piastre INTO v_carry FROM financial_private.cashier_shifts WHERE store_id=p_store AND status=''closed'' ORDER BY closed_at DESC LIMIT 1;';
 IF strpos(d,needle)=0 OR strpos(d,'v_cashier uuid;')=0
  OR strpos(d,'RETURN financial_private.record_cashier_shift_expense(p_id,p_store,p_device,p_input);')=0
 THEN RAISE EXCEPTION 'NEXUS_SEQUENTIAL_SHIFT_COMMAND_DRIFT'; END IF;
 d:=replace(d,'v_cashier uuid;','v_previous_shift uuid; v_cashier uuid;');
 replacement:=$body$SELECT id,retained_piastre INTO v_previous_shift,v_carry FROM financial_private.cashier_shifts
    WHERE store_id=p_store AND status='closed' ORDER BY closed_at DESC,id DESC LIMIT 1;
  IF NOT (p_input ? 'expectedPreviousShiftId') THEN
   RAISE EXCEPTION 'NEXUS_SHIFT_OPEN_SNAPSHOT_REQUIRED' USING ERRCODE='23514';
  END IF;
  IF p_input->'expectedPreviousShiftId' IS DISTINCT FROM coalesce(to_jsonb(v_previous_shift),'null'::jsonb) THEN
   RAISE EXCEPTION 'NEXUS_SHIFT_STATE_CHANGED' USING ERRCODE='23514';
  END IF;$body$;
 d:=replace(d,needle,replacement);
 -- FOUND must keep referring to the previous closed-row SELECT, not a later query.
 d:=replace(d,'IF FOUND AND p.opening_piastre IS DISTINCT FROM v_carry',
   'IF v_previous_shift IS NOT NULL AND p.opening_piastre IS DISTINCT FROM v_carry');
 d:=replace(d,'''cashier_shifts_store_id_shift_day_key'',''cashier_shift_one_active''','''cashier_shift_one_active''');
 EXECUTE d;

 d:=replace(pg_get_functiondef('public.cashier_shift_snapshot(uuid)'::regprocedure),chr(13),'');
 IF strpos(d,'v_previous boolean;')=0 OR strpos(d,needle)=0
  OR strpos(d,'SELECT id,shift_day,cashier_id,status,opening_piastre')=0 THEN
  RAISE EXCEPTION 'NEXUS_SEQUENTIAL_SHIFT_READER_DRIFT'; END IF;
 d:=replace(d,'v_previous boolean;','v_previous boolean; v_previous_shift uuid;');
 d:=replace(d,needle,'SELECT id,retained_piastre INTO v_previous_shift,v_carry FROM financial_private.cashier_shifts WHERE store_id=p_store AND status=''closed'' ORDER BY closed_at DESC,id DESC LIMIT 1;');
 d:=replace(d,'''has_previous_shift'',v_previous','''has_previous_shift'',v_previous,''previous_shift_id'',v_previous_shift');
 d:=replace(d,'''enabled'',coalesce(v_policy.enabled,false)', '''sequential_opening'',true,''enabled'',coalesce(v_policy.enabled,false)');
 d:=replace(d,'SELECT id,shift_day,cashier_id,status,opening_piastre','SELECT id,shift_day,opened_at,planned_end_at,cashier_id,status,opening_piastre');
 d:=replace(d,'ORDER BY opened_at DESC LIMIT 14','ORDER BY opened_at DESC,id DESC LIMIT 14');
 d:=replace(d,'ORDER BY (status<>''closed'') DESC,opened_at DESC LIMIT 1','ORDER BY (status<>''closed'') DESC,opened_at DESC,id DESC LIMIT 1');
 EXECUTE d;

 ALTER TABLE financial_private.cashier_shifts DROP CONSTRAINT cashier_shifts_store_id_shift_day_key;
END $migration$;

-- Bounded read-only drill-down. Never switches the active shift or reopens history.
CREATE FUNCTION public.read_cashier_shift_history(p_store uuid,p_shift uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE s financial_private.cashier_shifts; v_admin boolean;
BEGIN
 v_admin:=coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN']),false);
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','CASHIER_ONLY']),false)
  OR NOT coalesce(public.store_licensed(p_store),false) THEN
  RAISE EXCEPTION 'NEXUS_SHIFT_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 SELECT * INTO s FROM financial_private.cashier_shifts WHERE id=p_shift AND store_id=p_store
  AND (v_admin OR cashier_id=auth.uid());
 IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_SHIFT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('shift',financial_private.cashier_shift_summary(s.id),
  'audit',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT a.id,a.action,a.recorded_at,
    jsonb_build_object('input',jsonb_build_object('reason',a.detail->'input'->'reason')) detail
    FROM financial_private.cashier_shift_audit a WHERE a.store_id=p_store AND a.shift_id=s.id
    ORDER BY a.id DESC LIMIT 50) x),'[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.read_cashier_shift_history(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.read_cashier_shift_history(uuid,uuid) TO authenticated;
