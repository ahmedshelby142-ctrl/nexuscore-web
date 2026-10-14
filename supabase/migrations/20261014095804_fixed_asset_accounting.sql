-- LOCAL ONLY: additive asset subledger and date-sensitive accounting projection.
-- No existing document, settled event, cash balance or historic ledger is rewritten.
ALTER TABLE public.fixed_assets ADD COLUMN "accountingStartDate" date;
ALTER TABLE public.fixed_assets ADD COLUMN "deactivatedAt" date;
REVOKE TRUNCATE ON public.fixed_assets FROM PUBLIC,anon,authenticated;
-- Publish only this existing RLS-protected public table; private command
-- journals never enter Realtime. Local schema fixtures have no publication.
DO $migration$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime' AND NOT puballtables)
  AND NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='fixed_assets') THEN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.fixed_assets;
 END IF;
END $migration$;
CREATE TABLE financial_private.asset_commands (
 id text PRIMARY KEY,store_id uuid NOT NULL,asset_id text NOT NULL,request jsonb NOT NULL,result jsonb,
 actor_id uuid NOT NULL DEFAULT auth.uid(),created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE financial_private.asset_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.asset_commands FROM PUBLIC,anon,authenticated;
CREATE TABLE financial_private.asset_write_permits (
 transaction_id bigint NOT NULL,store_id uuid NOT NULL,asset_id text NOT NULL,
 PRIMARY KEY(transaction_id,store_id,asset_id)
);
ALTER TABLE financial_private.asset_write_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.asset_write_permits FROM PUBLIC,anon,authenticated;

-- Calendar-month anniversaries, actual days within the anniversary month.
-- Round the cumulative depreciable cost ONCE; period expense is a difference
-- of cumulative amounts. Thus24 months of16000/96 =4000, not4000.08.
CREATE FUNCTION financial_private.asset_depreciation(p_cost numeric,p_residual numeric,p_life_months integer,p_start date,p_asof date)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path TO public,pg_temp AS $fn$
DECLARE months integer;anniversary date;next_anniversary date;fraction numeric;
BEGIN
 IF p_cost IS NULL OR p_residual IS NULL OR p_life_months IS NULL OR p_start IS NULL OR p_asof IS NULL
  OR p_cost<=0 OR p_cost>=1000000000 OR p_residual<0 OR p_residual>p_cost OR p_life_months<=0 OR p_life_months>12000
  OR NOT isfinite(p_start) OR NOT isfinite(p_asof) THEN RAISE EXCEPTION 'NEXUS_ASSET_INVALID' USING ERRCODE='23514';END IF;
 IF p_asof<=p_start THEN RETURN 0;END IF;
 IF p_asof>=(p_start+make_interval(months=>p_life_months))::date THEN RETURN p_cost-p_residual;END IF;
 months:=(extract(year FROM p_asof)::int-extract(year FROM p_start)::int)*12+extract(month FROM p_asof)::int-extract(month FROM p_start)::int;
 anniversary:=(p_start+make_interval(months=>months))::date;
 IF anniversary>p_asof THEN months:=months-1;anniversary:=(p_start+make_interval(months=>months))::date;END IF;
 next_anniversary:=(p_start+make_interval(months=>months+1))::date;
 fraction:=months+(p_asof-anniversary)::numeric/(next_anniversary-anniversary);
 RETURN least(p_cost-p_residual,greatest(0,round((p_cost-p_residual)*fraction/p_life_months)));
END $fn$;
REVOKE ALL ON FUNCTION financial_private.asset_depreciation(numeric,numeric,integer,date,date) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION financial_private.asset_position(a public.fixed_assets,p_asof date,p_from date,p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path TO public,pg_temp AS $fn$
DECLARE cost numeric:=round(a."purchaseValue"*100);residual numeric:=round(a."salvageValue"*100);
 months integer:=round(a."usefulLifeYears"*12);start_date date:=(a."purchaseDate" AT TIME ZONE 'Africa/Cairo')::date;
 recognition date:=coalesce(a."accountingStartDate",(a."createdAt" AT TIME ZONE 'Africa/Cairo')::date);
 cutoff date;historical numeric;accum numeric;period numeric;opening numeric;review text;status text;
BEGIN
 IF a."usefulLifeYears"*12<>months OR recognition IS NULL THEN RAISE EXCEPTION 'NEXUS_ASSET_INVALID' USING ERRCODE='23514';END IF;
 recognition:=greatest(recognition,start_date);
 cutoff:=least(p_asof,coalesce(a."deactivatedAt",p_asof));
 IF NOT a."isActive" AND a."deactivatedAt" IS NULL THEN review:='NEXUS_LEGACY_ASSET_DEACTIVATION_DATE_REQUIRED';END IF;
 historical:=financial_private.asset_depreciation(cost,residual,months,start_date,recognition);
 accum:=financial_private.asset_depreciation(cost,residual,months,start_date,cutoff);
 opening:=cost-historical;
 period:=greatest(0,financial_private.asset_depreciation(cost,residual,months,start_date,least(cutoff,coalesce(p_to,cutoff)))
  -financial_private.asset_depreciation(cost,residual,months,start_date,greatest(recognition,coalesce(p_from,recognition))));
 IF p_asof<recognition THEN accum:=0;cost:=0;opening:=0;period:=0;historical:=0;END IF;
 status:=CASE WHEN p_asof<recognition THEN 'not_recognized' WHEN a."deactivatedAt" IS NOT NULL AND a."deactivatedAt"<=p_asof THEN 'inactive'
  WHEN accum>=cost-residual THEN 'fully_depreciated' ELSE 'active' END;
 RETURN jsonb_build_object('id',a.id,'name',a.name,'purchaseDate',start_date,'accountingStartDate',recognition,'deactivatedAt',a."deactivatedAt",
  'paymentSource',a."paymentSource",'revision',coalesce(a.updated_at,0),'usefulLifeMonths',months,'residualPiastres',residual,'grossPiastres',cost,
  'historicalDepreciationPiastres',historical,'accumulatedDepreciationPiastres',accum,'openingCarryingPiastres',opening,
  'netBookPiastres',cost-accum,'remainingDepreciablePiastres',greatest(0,cost-residual-accum),
  'lifetimeDepreciationPiastres',greatest(0,accum-historical),'periodDepreciationPiastres',period,
  'monthlyEstimatePiastres',CASE WHEN status='active' THEN round((cost-residual)/months) ELSE 0 END,
  'usefulLifeEndsOn',(start_date+make_interval(months=>months))::date,
  'remainingLifeMonths',greatest(0,extract(year FROM age((start_date+make_interval(months=>months))::date,cutoff))::int*12+extract(month FROM age((start_date+make_interval(months=>months))::date,cutoff))::int),
  'status',status,'reviewReason',review);
END $fn$;
REVOKE ALL ON FUNCTION financial_private.asset_position(public.fixed_assets,date,date,date) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.fixed_asset_accounting(p_store uuid,p_asof date DEFAULT NULL,p_from timestamptz DEFAULT NULL,p_to timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE a public.fixed_assets;r jsonb;rows jsonb:='[]';asof date:=coalesce(p_asof,(now() AT TIME ZONE 'Africa/Cairo')::date);
 cost numeric:=0;accum numeric:=0;historical numeric:=0;net numeric:=0;period numeric:=0;lifedep numeric:=0;opening numeric:=0;monthly numeric:=0;
 reclassified numeric:=0;reclassified_lifetime numeric:=0;booked numeric;paid numeric;review boolean:=false;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false) THEN
  RAISE EXCEPTION 'NEXUS_ASSET_ACCOUNTING_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF NOT isfinite(asof) OR (p_from IS NOT NULL AND p_to IS NOT NULL AND p_from>=p_to) THEN RAISE EXCEPTION 'NEXUS_ASSET_PERIOD_INVALID' USING ERRCODE='23514';END IF;
 FOR a IN SELECT * FROM public.fixed_assets WHERE store_id=p_store AND deleted_at IS NULL ORDER BY id LOOP
  r:=financial_private.asset_position(a,asof,(p_from AT TIME ZONE 'Africa/Cairo')::date,(p_to AT TIME ZONE 'Africa/Cairo')::date);
  rows:=rows||jsonb_build_array(r);review:=review OR r->>'reviewReason' IS NOT NULL;
  cost:=cost+(r->>'grossPiastres')::numeric;accum:=accum+(r->>'accumulatedDepreciationPiastres')::numeric;
  historical:=historical+(r->>'historicalDepreciationPiastres')::numeric;net:=net+(r->>'netBookPiastres')::numeric;
  period:=period+(r->>'periodDepreciationPiastres')::numeric;lifedep:=lifedep+(r->>'lifetimeDepreciationPiastres')::numeric;
  monthly:=monthly+(r->>'monthlyEstimatePiastres')::numeric;
  IF a."paymentSource"='prepaid' AND a.ledger_event_id IS NULL THEN
   opening:=opening+(r->>'openingCarryingPiastres')::numeric;
  ELSE
   SELECT coalesce(sum(l.amount_delta) FILTER(WHERE l.account='expense'),0),-coalesce(sum(l.amount_delta) FILTER(WHERE l.account='wallet'),0)
   INTO booked,paid FROM public.ledger_events e JOIN public.ledger_lines l ON l.event_id=e.id AND l.store_id=e.store_id
   WHERE e.store_id=p_store AND e.ref_type='fixed_asset' AND e.ref_id=a.id AND e.id=a.ledger_event_id;
   IF booked<>round(a."purchaseValue"*100) OR paid<>booked THEN review:=true;
   ELSE
    reclassified_lifetime:=reclassified_lifetime+booked;
    SELECT coalesce(sum(l.amount_delta),0) INTO booked FROM public.ledger_events e JOIN public.ledger_lines l ON l.event_id=e.id AND l.store_id=e.store_id
     WHERE e.store_id=p_store AND e.id=a.ledger_event_id AND l.account='expense'
      AND (p_from IS NULL OR e.occurred_at::timestamptz>=p_from) AND (p_to IS NULL OR e.occurred_at::timestamptz<p_to);
    reclassified:=reclassified+booked;
    opening:=opening-(r->>'historicalDepreciationPiastres')::numeric;
   END IF;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('unit','piastres','storeId',p_store,'asOf',asof,'policy','monthly-anniversary/actual-days/cumulative-piastres; registration-date opening cutoff',
  'rows',rows,'grossCostPiastres',cost,'accumulatedDepreciationPiastres',accum,'historicalDepreciationPiastres',historical,'netBookPiastres',net,
  'periodDepreciationPiastres',period,'lifetimeDepreciationPiastres',lifedep,'openingEquityAdjustmentPiastres',opening,'monthlyEstimatePiastres',monthly,
  'capitalPurchasesReclassifiedPiastres',reclassified,'capitalPurchasesReclassifiedLifetimePiastres',reclassified_lifetime,'reviewRequired',review);
END $fn$;
REVOKE ALL ON FUNCTION public.fixed_asset_accounting(uuid,date,timestamptz,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fixed_asset_accounting(uuid,date,timestamptz,timestamptz) TO authenticated;

CREATE FUNCTION financial_private.guard_asset_document() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'NEXUS_ASSET_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['name','updated_at','sync_status']) IS NOT DISTINCT FROM
  (to_jsonb(OLD)-ARRAY['name','updated_at','sync_status']) THEN RETURN NEW;END IF;
 IF NOT EXISTS(SELECT 1 FROM financial_private.asset_write_permits WHERE transaction_id=txid_current() AND store_id=NEW.store_id AND asset_id=NEW.id) THEN
  RAISE EXCEPTION 'NEXUS_ASSET_COMMAND_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_asset_document() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER nexus_asset_document BEFORE INSERT OR UPDATE OR DELETE ON public.fixed_assets FOR EACH ROW EXECUTE FUNCTION financial_private.guard_asset_document();

CREATE OR REPLACE FUNCTION public.record_fixed_asset(p_asset jsonb,p_event jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE v_asset_id text:=p_asset->>'id';store uuid:=(p_asset->>'store_id')::uuid;device uuid:=(p_asset->>'device_id')::uuid;
 a public.fixed_assets;saved financial_private.asset_commands;request jsonb;result jsonb;event_id text;wallet text;
 cost numeric:=(p_asset->>'purchaseValue')::numeric;residual numeric:=coalesce((p_asset->>'salvageValue')::numeric,0);
 life numeric:=(p_asset->>'usefulLifeYears')::numeric;purchase timestamptz:=(p_asset->>'purchaseDate')::timestamptz;
 recognition date:=(now() AT TIME ZONE 'Africa/Cairo')::date;lines jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false) THEN RAISE EXCEPTION 'NEXUS_ASSET_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF nullif(v_asset_id,'') IS NULL OR device IS NULL OR nullif(btrim(p_asset->>'name'),'') IS NULL OR cost IS NULL OR cost<=0 OR cost>=10000000 OR cost<>round(cost,2)
  OR residual<0 OR residual>cost OR residual<>round(residual,2) OR life IS NULL OR life<=0 OR life>1000 OR life*12<>round(life*12)
  OR purchase IS NULL OR NOT isfinite(purchase) OR (purchase AT TIME ZONE 'Africa/Cairo')::date>recognition THEN RAISE EXCEPTION 'NEXUS_ASSET_INVALID' USING ERRCODE='23514';END IF;
 wallet:=CASE WHEN lower(p_asset->>'paymentSource')='prepaid' THEN 'prepaid' ELSE public.canonical_wallet_subject(p_asset->>'paymentSource') END;
 IF wallet IS NULL OR wallet NOT IN ('prepaid','inStoreSafe','vodafoneCash','instaPay','bankAccount') THEN RAISE EXCEPTION 'NEXUS_ASSET_WALLET_INVALID' USING ERRCODE='23514';END IF;
 request:=jsonb_build_object('name',btrim(p_asset->>'name'),'cost',cost,'residual',residual,'life',life,'purchaseDate',purchase,'wallet',wallet);
 PERFORM financial_private.fulfillment_lock(store);PERFORM pg_advisory_xact_lock(hashtextextended('asset:'||store::text||':'||v_asset_id,0));
 SELECT * INTO saved FROM financial_private.asset_commands WHERE asset_id=v_asset_id AND store_id=store AND id='create:'||v_asset_id;
 IF FOUND THEN
  IF saved.request IS DISTINCT FROM request THEN RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514';END IF;
  RETURN saved.result||jsonb_build_object('replayed',true);
 END IF;
 SELECT * INTO a FROM public.fixed_assets WHERE fixed_assets.id=v_asset_id AND store_id=store;
 IF FOUND THEN
  IF a."purchaseValue"<>cost OR a."salvageValue"<>residual OR a."usefulLifeYears"<>life OR a."purchaseDate"<>purchase OR (CASE WHEN lower(a."paymentSource")='prepaid' THEN 'prepaid' ELSE public.canonical_wallet_subject(a."paymentSource") END) IS DISTINCT FROM wallet
   THEN RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('asset',to_jsonb(a),'replayed',true);
 END IF;
 IF NOT public.store_licensed(store) THEN RAISE EXCEPTION 'NEXUS_STORE_NOT_LICENSED' USING ERRCODE='42501';END IF;
 IF (wallet='prepaid' AND p_event IS NOT NULL) OR (wallet<>'prepaid' AND (p_event IS NULL OR p_event->>'kind' IS DISTINCT FROM 'expense'
  OR p_event->>'ref_type' IS DISTINCT FROM 'fixed_asset' OR p_event->>'ref_id' IS DISTINCT FROM v_asset_id OR (p_event->>'store_id')::uuid IS DISTINCT FROM store)) THEN
  RAISE EXCEPTION 'NEXUS_EVENT_NOT_THIS_DOCUMENT' USING ERRCODE='23514';END IF;
 event_id:=CASE WHEN wallet<>'prepaid' THEN 'asset:'||v_asset_id ELSE NULL END;
 INSERT INTO financial_private.asset_write_permits VALUES(txid_current(),store,v_asset_id);
 INSERT INTO public.fixed_assets(id,store_id,device_id,name,"purchaseValue","salvageValue","usefulLifeYears","purchaseDate","monthlyDepreciation","isActive","paymentSource",ledger_event_id,"accountingStartDate",updated_at,sync_status)
  VALUES(v_asset_id,store,device,btrim(p_asset->>'name'),cost,residual,life,purchase,round((cost-residual)/(life*12),2),true,wallet,event_id,recognition,(extract(epoch FROM clock_timestamp())*1000)::bigint,'synced') RETURNING * INTO a;
 DELETE FROM financial_private.asset_write_permits WHERE transaction_id=txid_current() AND store_id=store AND asset_id=v_asset_id;
 IF event_id IS NOT NULL THEN
  lines:=jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','expense','subject_id','assets','amount_delta',round(cost*100)),
   jsonb_build_object('id',gen_random_uuid()::text,'account','wallet','subject_id',wallet,'amount_delta',-round(cost*100)));
  PERFORM public.ledger_append(jsonb_build_object('id',event_id,'store_id',store,'device_id',device,'kind','expense','ref_type','fixed_asset','ref_id',v_asset_id,
   'occurred_at',now(),'created_at',now(),'actor','أصل ثابت','payload',jsonb_build_object('capitalized',true,'wallet',wallet,'assetId',v_asset_id)::text,'lines',lines));
 END IF;
 result:=jsonb_build_object('asset',to_jsonb(a),'replayed',false);
 INSERT INTO financial_private.asset_commands VALUES('create:'||v_asset_id,store,v_asset_id,request,result);
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.record_fixed_asset(jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_fixed_asset(jsonb,jsonb) TO authenticated;

-- New clients retain p_id across lost responses/reloads using the established
-- financial-command envelope. The legacy two-argument RPC remains compatible.
CREATE FUNCTION public.record_asset_command(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE asset jsonb;event jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false) THEN RAISE EXCEPTION 'NEXUS_ASSET_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF p_command IS DISTINCT FROM 'asset_record' OR jsonb_typeof(p_input->'asset') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'NEXUS_ASSET_INVALID' USING ERRCODE='23514';END IF;
 asset:=p_input->'asset'||jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device);
 event:=CASE WHEN asset->>'paymentSource'='prepaid' THEN NULL ELSE jsonb_build_object('id',p_id,'store_id',p_store,'kind','expense','ref_type','fixed_asset','ref_id',p_id) END;
 RETURN public.record_fixed_asset(asset,event);
END $fn$;
REVOKE ALL ON FUNCTION public.record_asset_command(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_asset_command(text,uuid,uuid,text,jsonb) TO authenticated;

-- Correct a previously owned opening asset only. Preserve the complete
-- before/after register and valuation in the durable audit; no cash or
-- historical ledger event is rewritten. Historical pre-adoption depreciation
-- remains outside post-adoption P&L.
CREATE FUNCTION public.correct_opening_asset_date(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE a public.fixed_assets;saved financial_private.asset_commands;request jsonb:=jsonb_build_object('command',p_command,'input',p_input);
 before_asset jsonb;before_position jsonb;after_position jsonb;result jsonb;corrected date;recognition date;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN']),false) THEN RAISE EXCEPTION 'NEXUS_ASSET_OPENING_OWNER_ONLY' USING ERRCODE='42501';END IF;
 IF p_command IS DISTINCT FROM 'asset_opening_date' OR nullif(p_id,'') IS NULL OR p_device IS NULL OR nullif(btrim(p_input->>'reason'),'') IS NULL
  OR (p_input->>'purchaseDate') !~ '^\d{4}-\d{2}-\d{2}$' OR jsonb_typeof(p_input->'beforeRevision') IS DISTINCT FROM 'number'
  THEN RAISE EXCEPTION 'NEXUS_ASSET_INVALID' USING ERRCODE='23514';END IF;
 corrected:=(p_input->>'purchaseDate')::date;
 IF corrected IS NULL OR NOT isfinite(corrected) THEN RAISE EXCEPTION 'NEXUS_ASSET_INVALID' USING ERRCODE='23514';END IF;
 PERFORM financial_private.fulfillment_lock(p_store);PERFORM pg_advisory_xact_lock(hashtextextended('asset-opening-correction:'||p_id,0));
 SELECT * INTO saved FROM financial_private.asset_commands WHERE id=p_id AND store_id=p_store;
 IF FOUND THEN
  IF saved.request IS DISTINCT FROM request THEN RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514';END IF;
  RETURN saved.result||jsonb_build_object('replayed',true);END IF;
 SELECT * INTO a FROM public.fixed_assets WHERE id=p_input->>'assetId' AND store_id=p_store AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR a."paymentSource" IS DISTINCT FROM 'prepaid' OR a.ledger_event_id IS NOT NULL OR NOT a."isActive" OR a."deactivatedAt" IS NOT NULL THEN
  RAISE EXCEPTION 'NEXUS_ASSET_OPENING_ONLY' USING ERRCODE='23514';END IF;
 IF NOT public.store_licensed(p_store) THEN RAISE EXCEPTION 'NEXUS_STORE_NOT_LICENSED' USING ERRCODE='42501';END IF;
 recognition:=coalesce(a."accountingStartDate",(a."createdAt" AT TIME ZONE 'Africa/Cairo')::date);
 IF recognition IS NULL OR corrected>recognition OR corrected>(now() AT TIME ZONE 'Africa/Cairo')::date
  THEN RAISE EXCEPTION 'NEXUS_ASSET_INVALID' USING ERRCODE='23514';END IF;
 IF coalesce(a.updated_at,0)<>(p_input->>'beforeRevision')::numeric OR (a."purchaseDate" AT TIME ZONE 'Africa/Cairo')::date IS DISTINCT FROM (p_input->>'beforePurchaseDate')::date
  THEN RAISE EXCEPTION 'NEXUS_ASSET_OPENING_STALE' USING ERRCODE='23514';END IF;
 before_asset:=to_jsonb(a);before_position:=financial_private.asset_position(a,(now() AT TIME ZONE 'Africa/Cairo')::date,NULL,NULL);
 INSERT INTO financial_private.asset_write_permits VALUES(txid_current(),p_store,a.id);
 UPDATE public.fixed_assets SET "purchaseDate"=corrected::timestamp AT TIME ZONE 'UTC',
  updated_at=greatest(coalesce(updated_at,0)+1,(extract(epoch FROM clock_timestamp())*1000)::bigint) WHERE id=a.id AND store_id=p_store RETURNING * INTO a;
 DELETE FROM financial_private.asset_write_permits WHERE transaction_id=txid_current() AND store_id=p_store AND asset_id=a.id;
 after_position:=financial_private.asset_position(a,(now() AT TIME ZONE 'Africa/Cairo')::date,NULL,NULL);
 result:=jsonb_build_object('asset',to_jsonb(a),'beforeAsset',before_asset,'beforePosition',before_position,'afterPosition',after_position,
  'openingEquityDeltaPiastres',(after_position->>'openingCarryingPiastres')::numeric-(before_position->>'openingCarryingPiastres')::numeric,'replayed',false);
 INSERT INTO financial_private.asset_commands(id,store_id,asset_id,request,result) VALUES(p_id,p_store,a.id,request,result);
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.correct_opening_asset_date(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.correct_opening_asset_date(text,uuid,uuid,text,jsonb) TO authenticated;

CREATE FUNCTION public.read_asset_audit(p_store uuid,p_asset_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false) THEN RAISE EXCEPTION 'NEXUS_ASSET_ACCOUNTING_FORBIDDEN' USING ERRCODE='42501';END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'actorId',actor_id,'at',created_at,'request',request,'result',result) ORDER BY created_at,id)
  FROM financial_private.asset_commands WHERE store_id=p_store AND asset_id=p_asset_id),'[]');
END $fn$;
REVOKE ALL ON FUNCTION public.read_asset_audit(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.read_asset_audit(uuid,text) TO authenticated;

CREATE FUNCTION public.deactivate_fixed_asset(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE a public.fixed_assets;saved financial_private.asset_commands;request jsonb:=jsonb_build_object('command',p_command,'input',p_input);result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false) THEN RAISE EXCEPTION 'NEXUS_ASSET_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF p_command IS DISTINCT FROM 'asset_deactivate' OR nullif(p_id,'') IS NULL OR p_device IS NULL OR nullif(btrim(p_input->>'reason'),'') IS NULL THEN RAISE EXCEPTION 'NEXUS_ASSET_INVALID' USING ERRCODE='23514';END IF;
 PERFORM financial_private.fulfillment_lock(p_store);PERFORM pg_advisory_xact_lock(hashtextextended('asset-status:'||p_id,0));
 SELECT * INTO saved FROM financial_private.asset_commands WHERE id=p_id AND store_id=p_store;
 IF FOUND THEN
  IF saved.request IS DISTINCT FROM request THEN RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514';END IF;
  RETURN saved.result||jsonb_build_object('replayed',true);END IF;
 SELECT * INTO a FROM public.fixed_assets WHERE id=p_input->>'assetId' AND store_id=p_store AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR NOT a."isActive" OR a."deactivatedAt" IS NOT NULL THEN RAISE EXCEPTION 'NEXUS_ASSET_NOT_ACTIVE' USING ERRCODE='23514';END IF;
 IF NOT public.store_licensed(p_store) THEN RAISE EXCEPTION 'NEXUS_STORE_NOT_LICENSED' USING ERRCODE='42501';END IF;
 INSERT INTO financial_private.asset_write_permits VALUES(txid_current(),p_store,a.id);
 UPDATE public.fixed_assets SET "isActive"=false,"deactivatedAt"=(now() AT TIME ZONE 'Africa/Cairo')::date,
  updated_at=greatest(coalesce(updated_at,0)+1,(extract(epoch FROM clock_timestamp())*1000)::bigint) WHERE id=a.id AND store_id=p_store RETURNING * INTO a;
 DELETE FROM financial_private.asset_write_permits WHERE transaction_id=txid_current() AND store_id=p_store AND asset_id=a.id;
 result:=jsonb_build_object('asset',to_jsonb(a),'replayed',false);
 INSERT INTO financial_private.asset_commands VALUES(p_id,p_store,a.id,request,result);
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.deactivate_fixed_asset(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.deactivate_fixed_asset(text,uuid,uuid,text,jsonb) TO authenticated;

-- Owner reader keeps its original ADMIN/tenant gate. Capital acquisition
-- ledger events remain immutable and are explicitly reclassified, never
-- hidden as an unmatched expense. Depreciation is noncash, derived once.
DO $migration$
DECLARE d text;
BEGIN
 d:=pg_get_functiondef('public.owner_financial_summary(uuid,timestamptz,timestamptz)'::regprocedure);
 EXECUTE replace(d,'FUNCTION public.owner_financial_summary(','FUNCTION financial_private.owner_summary_before_assets(');
END $migration$;
REVOKE ALL ON FUNCTION financial_private.owner_summary_before_assets(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.owner_financial_summary(p_store uuid,p_from timestamptz DEFAULT NULL,p_to timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE base jsonb;assets jsonb;operating numeric;profit_before numeric;depreciation numeric;
BEGIN
 base:=financial_private.owner_summary_before_assets(p_store,p_from,p_to);
 assets:=public.fixed_asset_accounting(p_store,NULL,p_from,p_to);
 operating:=(base->>'expenses')::numeric-(assets->>'capitalPurchasesReclassifiedPiastres')::numeric;
 profit_before:=(base->>'revenue')::numeric-(base->>'cogs')::numeric-operating;
 depreciation:=(assets->>'periodDepreciationPiastres')::numeric;
 RETURN base||jsonb_build_object('rawLedgerExpenses',base->'expenses','expenses',operating,'capitalPurchasesReclassified',assets->'capitalPurchasesReclassifiedPiastres',
  'profitBeforeDepreciation',profit_before,'depreciation',depreciation,'netProfit',profit_before-depreciation,'fixedAssets',assets,'position',public.accounting_position(p_store));
END $fn$;
REVOKE ALL ON FUNCTION public.owner_financial_summary(uuid,timestamptz,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.owner_financial_summary(uuid,timestamptz,timestamptz) TO authenticated;

-- Positions remain lifetime. Reserved goods still belong to the business
-- until delivery; cash deposits for those orders are liabilities, not profit.
CREATE FUNCTION public.accounting_position(p_store uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE fixed jsonb;assets numeric;liabilities numeric;equity numeric;opening numeric;result_profit numeric;
 counterparty_assets numeric;counterparty_liabilities numeric;
 wallet numeric;stock numeric;customer numeric;supplier numeric;courier_r numeric;courier_p numeric;
 reserved numeric;deposits numeric;capital numeric;capital_cash numeric;contributions numeric;draws numeric;adjustments numeric;income numeric;costs numeric;expenses numeric;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false) THEN RAISE EXCEPTION 'NEXUS_ASSET_ACCOUNTING_FORBIDDEN' USING ERRCODE='42501';END IF;
 fixed:=public.fixed_asset_accounting(p_store);
 SELECT coalesce(sum(amount_delta) FILTER(WHERE account='wallet'),0),coalesce(sum(amount_delta) FILTER(WHERE account='stock'),0),
  coalesce(sum(amount_delta) FILTER(WHERE account='receivable_client'),0),coalesce(sum(amount_delta) FILTER(WHERE account='payable_supplier'),0),
  coalesce(sum(amount_delta) FILTER(WHERE account='receivable_courier'),0),coalesce(sum(amount_delta) FILTER(WHERE account='payable_courier'),0),
  coalesce(sum(amount_delta) FILTER(WHERE account='revenue'),0),coalesce(sum(amount_delta) FILTER(WHERE account='cogs'),0),coalesce(sum(amount_delta) FILTER(WHERE account='expense'),0)
 INTO wallet,stock,customer,supplier,courier_r,courier_p,income,costs,expenses FROM public.ledger_lines WHERE store_id=p_store;
 SELECT coalesce(sum(CASE WHEN account IN ('wallet','receivable_client','receivable_courier') THEN greatest(amount,0) ELSE greatest(-amount,0) END),0),
  coalesce(sum(CASE WHEN account IN ('wallet','receivable_client','receivable_courier') THEN greatest(-amount,0) ELSE greatest(amount,0) END),0)
 INTO counterparty_assets,counterparty_liabilities FROM (
  SELECT account,CASE WHEN account='wallet' THEN public.canonical_wallet_subject(subject_id) ELSE subject_id END subject_id,sum(amount_delta) amount FROM public.ledger_lines WHERE store_id=p_store
   AND account IN ('wallet','receivable_client','receivable_courier','payable_supplier','payable_courier') GROUP BY account,2
 ) x;
 SELECT coalesce(sum(coalesce((item->>'costPiastres')::numeric,round((item->>'quantity')::numeric*(item->>'unitCost')::numeric*100))),0)
 INTO reserved FROM public.orders o CROSS JOIN LATERAL jsonb_array_elements(o."stockItems") item WHERE o.store_id=p_store AND o.deleted_at IS NULL AND o."wholesaleClientId" IS NULL
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(o."stockItems") x WHERE nullif(x->>'wholesaleInvoiceId','') IS NOT NULL)
  AND (o.status IN ('pending','shipped') OR(o.status='returned' AND o."returnConfirmedAt" IS NULL));
 SELECT coalesce(sum(round(o."depositAmount"*100)),0) INTO deposits FROM public.orders o WHERE store_id=p_store AND deleted_at IS NULL AND "wholesaleClientId" IS NULL
  AND (o.status IN ('pending','shipped') OR(o.status='returned' AND o."returnConfirmedAt" IS NULL));
 SELECT coalesce(sum(l.amount_delta) FILTER(WHERE e.kind='owner_capital' AND l.account='owner_equity'),0),
  coalesce(sum(l.amount_delta) FILTER(WHERE e.kind='owner_capital' AND l.account='wallet'),0),
  coalesce(sum(l.amount_delta) FILTER(WHERE e.kind='owner_contribution' AND l.account='owner_equity'),0),
  coalesce(sum(l.amount_delta) FILTER(WHERE l.account='owner_budget'),0),
  coalesce(sum(l.amount_delta) FILTER(WHERE e.kind='stock_adjustment' AND l.account IN ('stock','wallet','expense')),0)
 INTO capital,capital_cash,contributions,draws,adjustments FROM public.ledger_lines l JOIN public.ledger_events e ON e.id=l.event_id AND e.store_id=l.store_id WHERE l.store_id=p_store;
 opening:=adjustments-(capital-capital_cash)+(fixed->>'openingEquityAdjustmentPiastres')::numeric;
 result_profit:=income-costs-expenses+(fixed->>'capitalPurchasesReclassifiedLifetimePiastres')::numeric-(fixed->>'lifetimeDepreciationPiastres')::numeric;
 equity:=capital+contributions+opening+result_profit-draws;
 assets:=counterparty_assets+stock+reserved+(fixed->>'netBookPiastres')::numeric;
 liabilities:=counterparty_liabilities+deposits;
 RETURN jsonb_build_object('unit','piastres','storeId',p_store,'wallet',wallet,'stock',stock,'reservedStock',reserved,'customerNet',customer,
  'courierReceivable',courier_r,'courierPayable',courier_p,'supplierPayable',supplier,'customerDeposits',deposits,'fixedAssets',fixed->'netBookPiastres',
  'totalAssets',assets,'liabilities',liabilities,'netAssets',assets-liabilities,'equity',equity,'openingEquity',opening,'accumulatedProfit',result_profit,
  'reconciliationDifference',assets-liabilities-equity,'reviewRequired',(fixed->>'reviewRequired')::boolean OR assets-liabilities<>equity OR stock<0,
  'assetAccounting',fixed);
END $fn$;
REVOKE ALL ON FUNCTION public.accounting_position(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.accounting_position(uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
