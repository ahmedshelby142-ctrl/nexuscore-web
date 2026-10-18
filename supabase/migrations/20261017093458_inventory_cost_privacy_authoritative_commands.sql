-- LOCAL candidate only. Financial privacy without changing historical rows.
-- Dependencies: all 56 released migrations through 20261017043750.
-- Operational prices, quantities, customer payments and per-order courier
-- obligations remain visible. Inventory acquisition costs/COGS/profit do not.
CREATE FUNCTION public.strip_inventory_finance(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path TO pg_catalog,pg_temp AS $fn$
DECLARE result jsonb; k text; v jsonb;
BEGIN
 IF jsonb_typeof(value)='array' THEN
  SELECT coalesce(jsonb_agg(public.strip_inventory_finance(x) ORDER BY n),'[]') INTO result
   FROM jsonb_array_elements(value) WITH ORDINALITY t(x,n);RETURN result;
 ELSIF jsonb_typeof(value)='object' THEN
  result:='{}';
  FOR k,v IN SELECT key,val FROM jsonb_each(value) t(key,val) LOOP
   IF lower(replace(k,'_','')) IN ('unitcost','costpiastres','cogs','cogsamount','cogspiastres',
    'cost','costprice','totalcost','purchasecost','purchaseprice','stockvalue','inventoryvalue',
    'valuation','averagecost','weightedaveragecost','acquisitioncost','inventorycost','totalinventoryvalue',
    'profit','profitpiastres','grossprofit','netprofit','margin','profitmargin','marginpercent',
    'commandrequest','commandresult') THEN CONTINUE;END IF;
   result:=result||jsonb_build_object(k,public.strip_inventory_finance(v));
  END LOOP;RETURN result;
 END IF;
 RETURN value;
END $fn$;
REVOKE ALL ON FUNCTION public.strip_inventory_finance(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.strip_inventory_finance(jsonb) TO authenticated;

-- Stock quantities stay available. NULL means WITHHELD, never zero valuation.
CREATE OR REPLACE FUNCTION public.ledger_balances(p_store uuid,p_account text,p_kind text DEFAULT NULL,p_subject_id text DEFAULT NULL,p_from timestamptz DEFAULT NULL,p_to timestamptz DEFAULT NULL)
RETURNS TABLE(subject_id text,qty numeric,amount bigint) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','CASHIER_ONLY','POS_ECOMMERCE','ECOMMERCE_ONLY']),false)
  OR (NOT public.can_read_store_finance(p_store) AND p_account NOT IN ('stock','customer_ltv')) OR p_account IS NULL THEN
  RAISE EXCEPTION 'NEXUS_FINANCIAL_READ_FORBIDDEN' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT l.subject_id,sum(l.qty_delta::numeric),
  CASE WHEN p_account='stock' AND NOT public.can_read_store_finance(p_store) THEN NULL::bigint ELSE sum(l.amount_delta)::bigint END
 FROM public.ledger_lines l JOIN public.ledger_events e ON e.id=l.event_id AND e.store_id=l.store_id
 WHERE l.store_id=p_store AND l.account=p_account AND (p_kind IS NULL OR e.kind=p_kind) AND (p_subject_id IS NULL OR l.subject_id=p_subject_id)
 AND (p_from IS NULL OR e.occurred_at::timestamptz>=p_from) AND (p_to IS NULL OR e.occurred_at::timestamptz<p_to) GROUP BY l.subject_id;
END $fn$;

-- POS retains its ORIGINAL client request for replay; only the server-owned
-- accounting working copy is hydrated. The caller never needs WAC or original
-- COGS. All existing ownership/value/variant/receipt/ledger guards still run.
DO $migration$
DECLARE d text;
BEGIN
 d:=replace(pg_get_functiondef('public.validate_bundle_definition(uuid,text,jsonb)'::regprocedure),chr(13),'');
 IF strpos(d,'''POS_ECOMMERCE''')=0 OR strpos(d,'FUNCTION public.validate_bundle_definition(')=0 THEN RAISE EXCEPTION 'NEXUS_POS_BUNDLE_SCHEMA_DRIFT';END IF;
 d:=replace(d,'FUNCTION public.validate_bundle_definition(','FUNCTION financial_private.validate_pos_bundle(');
 d:=replace(d,'''POS_ECOMMERCE''','''CASHIER_ONLY'',''POS_ECOMMERCE''');
 EXECUTE d;
END $migration$;
REVOKE ALL ON FUNCTION financial_private.validate_pos_bundle(uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION financial_private.pos_cost_input(p_store uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path TO public,pg_temp AS $fn$
DECLARE source_id text:=nullif(p_input#>>'{payload,returnOfEventId}','');source jsonb;
 item jsonb;original jsonb;recipe jsonb;part jsonb;product public.products;
 items jsonb:='[]';parts jsonb:='[]';movements jsonb:='[]';lines jsonb;subject text;
 qty numeric;available numeric;value numeric;cost numeric;delta numeric;costs jsonb:='{}';legacy_box boolean;
BEGIN
 IF source_id IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-return:'||p_store::text||':'||source_id,0));
  SELECT payload::jsonb INTO source FROM public.ledger_events WHERE store_id=p_store AND id=source_id AND kind='sale' AND ref_type='pos_sale';
  IF NOT FOUND OR source->>'returnOfEventId' IS NOT NULL THEN RAISE EXCEPTION 'NEXUS_POS_RECEIPT_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;
 FOR item IN SELECT x FROM jsonb_array_elements(p_input#>'{payload,items}') x LOOP
  qty:=(item->>'quantity')::numeric;
  IF qty IS NULL OR qty=0 OR qty::text IN ('NaN','Infinity','-Infinity') OR (source_id IS NULL AND qty<0) OR (source_id IS NOT NULL AND qty>0) THEN
   RAISE EXCEPTION 'NEXUS_POS_RECEIPT_REQUIRED' USING ERRCODE='23514';END IF;
  IF source_id IS NULL THEN
   SELECT * INTO product FROM public.products WHERE store_id=p_store AND id=item->>'productId' AND deleted_at IS NULL AND "isActive";
   IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_POS_PRODUCT_INVALID' USING ERRCODE='23514';END IF;
   IF product."isBundle" THEN PERFORM financial_private.validate_pos_bundle(p_store,product.id,product."bundleItems");END IF;
   recipe:=CASE WHEN product."isBundle" THEN product."bundleItems" ELSE jsonb_build_array(jsonb_build_object('productId',product.id,'variantName',item->>'variantName','quantity',1)) END;
   original:=item||jsonb_build_object('productName',product.name,'isBundle',product."isBundle");
  ELSE
   SELECT x INTO original FROM jsonb_array_elements(source->'items') x WHERE x->>'productId'=item->>'productId' AND coalesce(x->>'variantName','')=coalesce(item->>'variantName','') LIMIT 1;
   IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_POS_RECEIPT_REQUIRED' USING ERRCODE='23514';END IF;
   recipe:=original->'bundleItems';
   legacy_box:=recipe IS NOT NULL OR coalesce((original->>'isBundle')::boolean,false) OR EXISTS(SELECT 1 FROM public.products WHERE store_id=p_store AND id=item->>'productId' AND "isBundle");
   IF legacy_box AND recipe IS NULL THEN
    -- Preserve the existing single-box legacy recovery from immutable source
    -- stock lines. A mixed receipt or missing historical shade stays review-only.
    IF jsonb_array_length(source->'items')<>1 THEN RAISE EXCEPTION 'NEXUS_POS_LEGACY_BOX_REVIEW' USING ERRCODE='23514';END IF;
    SELECT jsonb_agg(jsonb_build_object('productId',subject_id,'quantity',-qty_delta/(original->>'quantity')::numeric)) INTO recipe
     FROM public.ledger_lines WHERE store_id=p_store AND event_id=source_id AND account='stock';
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(recipe) x JOIN public.products p ON p.id=x->>'productId' AND p.store_id=p_store
      WHERE jsonb_array_length(coalesce(p.metadata->'variants','[]'))>0) THEN RAISE EXCEPTION 'NEXUS_POS_LEGACY_BOX_REVIEW' USING ERRCODE='23514';END IF;
   END IF;
   recipe:=coalesce(recipe,jsonb_build_array(jsonb_build_object('productId',item->>'productId','variantName',item->>'variantName','quantity',1)));
   original:=item||jsonb_build_object('productName',original->>'productName','isBundle',legacy_box,'unitCost',original->'unitCost');
  END IF;
  IF jsonb_typeof(recipe) IS DISTINCT FROM 'array' OR jsonb_array_length(recipe)=0 THEN RAISE EXCEPTION 'NEXUS_POS_PRODUCT_INVALID' USING ERRCODE='23514';END IF;
  parts:='[]';
  FOR part IN SELECT x FROM jsonb_array_elements(recipe) x LOOP
   subject:=part->>'productId';
   PERFORM pg_advisory_xact_lock(hashtextextended('pos-stock:'||p_store::text||':'||subject,0));
   IF source_id IS NULL THEN
    SELECT coalesce(sum(qty_delta::numeric),0),coalesce(sum(amount_delta),0) INTO available,value FROM public.ledger_lines WHERE store_id=p_store AND account='stock' AND subject_id=subject;
   ELSE
    SELECT -sum(qty_delta::numeric),-sum(amount_delta) INTO available,value FROM public.ledger_lines WHERE store_id=p_store AND event_id=source_id AND account='stock' AND subject_id=subject;
   END IF;
   IF available IS NULL OR available<=0 OR value IS NULL OR value<0 THEN RAISE EXCEPTION 'NEXUS_STOCK_SHORT' USING ERRCODE='23514';END IF;
   cost:=value/available;costs:=jsonb_set(costs,ARRAY[subject],to_jsonb(cost));
   movements:=movements||jsonb_build_array(jsonb_build_object('subject',subject,'qty',-qty*(part->>'quantity')::numeric));
   parts:=parts||jsonb_build_array(part||jsonb_build_object('unitCost',cost/100));
  END LOOP;
  original:=(original-'bundleItems'-'unitCost')||jsonb_build_object('unitCost',CASE WHEN coalesce((original->>'isBundle')::boolean,false) THEN 0 ELSE (costs->>(item->>'productId'))::numeric/100 END);
  IF coalesce((original->>'isBundle')::boolean,false) THEN original:=original||jsonb_build_object('bundleItems',parts);END IF;
  items:=items||jsonb_build_array(original);
 END LOOP;
 SELECT coalesce(jsonb_agg(x),'[]') INTO lines FROM jsonb_array_elements(p_input->'lines') x WHERE x->>'account' NOT IN ('stock','cogs');
 FOR subject,delta IN SELECT x->>'subject',sum((x->>'qty')::numeric) FROM jsonb_array_elements(movements) x GROUP BY 1 ORDER BY 1 LOOP
  value:=round(delta*(costs->>subject)::numeric);
  lines:=lines||jsonb_build_array(jsonb_build_object('account','stock','subjectId',subject,'qty',delta,'amount',value/100),
   jsonb_build_object('account','cogs','subjectId',subject,'amount',-value/100));
 END LOOP;
 RETURN p_input||jsonb_build_object('lines',lines,'payload',(p_input->'payload')||jsonb_build_object('items',items));
END $fn$;
REVOKE ALL ON FUNCTION financial_private.pos_cost_input(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
DO $migration$
DECLARE d text;needle text:='  SELECT jsonb_agg(jsonb_build_object(''id'',gen_random_uuid()::text,''account'',l->>''account'',''subject_id'',l->>''subjectId'',';
BEGIN
 d:=replace(pg_get_functiondef('public.record_pos_sale(text,uuid,uuid,text,jsonb)'::regprocedure),chr(13),'');
 IF strpos(d,needle)=0 OR strpos(d,'v_old.command_request IS DISTINCT FROM v_request')=0 OR strpos(d,'PERFORM financial_private.fulfillment_lock(p_store)')=0 THEN RAISE EXCEPTION 'NEXUS_POS_PRIVACY_SCHEMA_DRIFT';END IF;
 EXECUTE replace(d,needle,$insert$  IF NOT public.can_read_store_finance(p_store) THEN
   p_input:=financial_private.pos_cost_input(p_store,p_input);
   v_write_payload:=p_input->'payload';
  END IF;
$insert$||needle);
 d:=pg_get_functiondef('public.record_pos_exchange(text,uuid,uuid,text,jsonb)'::regprocedure);
 IF strpos(d,'public.validate_bundle_definition(p_store,product.id,product."bundleItems")')=0 THEN RAISE EXCEPTION 'NEXUS_POS_EXCHANGE_PRIVACY_SCHEMA_DRIFT';END IF;
 EXECUTE replace(d,'public.validate_bundle_definition(p_store,product.id,product."bundleItems")','financial_private.validate_pos_bundle(p_store,product.id,product."bundleItems")');
END $migration$;

-- Staff placement enters the existing authoritative fulfillment allocator,
-- even when the old client supplied a zero cost and no backorder flag. This
-- does not opt a normal order into shortages: missing stock still rejects.
DO $migration$
DECLARE d text;needle text;
BEGIN
 d:=replace(pg_get_functiondef('public.place_order(jsonb,jsonb)'::regprocedure),chr(13),'');
 needle:='  IF p_order#>>''{fulfillment,allowBackorder}''=''true'' AND NOT financial_private.has_fulfillment_permit(v_store,p_order->>''id'') THEN RETURN financial_private.place_backorder(p_order,p_event);END IF;';
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_PLACE_PRIVACY_SCHEMA_DRIFT';END IF;
 EXECUTE replace(d,needle,needle||chr(10)||$insert$ IF NOT public.can_read_store_finance(v_store) AND NOT financial_private.has_fulfillment_permit(v_store,p_order->>'id')
   AND (p_order->'exchangeDetails' IS NULL OR p_order->'exchangeDetails'='null'::jsonb) THEN RETURN financial_private.place_backorder(p_order,p_event);END IF;$insert$);
 d:=replace(pg_get_functiondef('financial_private.place_backorder(jsonb,jsonb)'::regprocedure),chr(13),'');
 needle:=' plan:=financial_private.fulfillment_plan(store,demands,''[]'');';
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_FULFILLMENT_PRIVACY_SCHEMA_DRIFT';END IF;
 EXECUTE replace(d,needle,needle||chr(10)||$insert$ IF p_order#>>'{fulfillment,allowBackorder}' IS DISTINCT FROM 'true' AND EXISTS(
  SELECT 1 FROM jsonb_array_elements(plan#>'{fulfillment,demands}') x WHERE (x->>'missing')::numeric>0) THEN
   RAISE EXCEPTION 'NEXUS_STOCK_SHORT' USING ERRCODE='23514';END IF;$insert$);
END $migration$;

-- Return clients choose units and customer-facing amounts. The locked order
-- owns inventory cost. The existing validator still checks every financial
-- leg, original unit ownership and document atomicity after hydration.
CREATE FUNCTION financial_private.inventory_return_event(o public.orders,ev jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path TO public,pg_temp AS $fn$
DECLARE l jsonb;selected_item jsonb;stock jsonb;payload jsonb;lines jsonb:='[]';value numeric;qty numeric;costs jsonb:='{}';subject text;
BEGIN
 IF public.can_read_store_finance(o.store_id) THEN RETURN ev;END IF;
 IF ev->>'kind'='order_delivered' THEN RETURN ev||jsonb_build_object('lines',financial_private.delivery_lines(o));END IF;
 FOR l IN SELECT x FROM jsonb_array_elements(ev->'lines') x LOOP
  subject:=l->>'subject_id';
  IF l->>'account'='stock' THEN
   SELECT sum(coalesce((x->>'costPiastres')::numeric,round((x->>'quantity')::numeric*(x->>'unitCost')::numeric*100))),sum((x->>'quantity')::numeric)
    INTO value,qty FROM jsonb_array_elements(o."stockItems") x WHERE x->>'productId'=subject;
   IF qty IS NULL OR qty<=0 OR value IS NULL THEN RAISE EXCEPTION 'NEXUS_STOCK_HISTORICAL_COST_MISMATCH' USING ERRCODE='23514';END IF;
   value:=round((l->>'qty_delta')::numeric*value/qty);
   l:=l||jsonb_build_object('amount_delta',value,'unit_cost',NULL);
   costs:=jsonb_set(costs,ARRAY[subject],to_jsonb(coalesce((costs->>subject)::numeric,0)+value));
  END IF;
  IF l->>'account'<>'cogs' THEN lines:=lines||jsonb_build_array(l);END IF;
 END LOOP;
 -- A sold return reverses original COGS; RTO restores reserved stock only.
 IF ev->>'kind'='return_confirmed' THEN
  FOR subject,value IN SELECT key,val::numeric FROM jsonb_each_text(costs) t(key,val) LOOP
   lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','cogs','subject_id',subject,'qty_delta',0,'amount_delta',-value));
  END LOOP;
 END IF;
 payload:=coalesce(ev->'payload','"{}"'::jsonb);IF jsonb_typeof(payload)='string' THEN payload:=(payload#>>'{}')::jsonb;END IF;
 IF jsonb_typeof(payload->'stockItems')='array' THEN
  stock:='[]';
  FOR selected_item IN SELECT v FROM jsonb_array_elements(payload->'stockItems') v LOOP
   SELECT sum(coalesce((i->>'costPiastres')::numeric,round((i->>'quantity')::numeric*(i->>'unitCost')::numeric*100))),sum((i->>'quantity')::numeric)
    INTO value,qty FROM jsonb_array_elements(o."stockItems") i WHERE i->>'productId'=selected_item->>'productId' AND coalesce(i->>'variantName','')=coalesce(selected_item->>'variantName','');
   IF qty IS NULL OR qty<=0 THEN RAISE EXCEPTION 'NEXUS_STOCK_RETURN_ALLOCATION_REQUIRED' USING ERRCODE='23514';END IF;
   stock:=stock||jsonb_build_array((selected_item-'costPiastres')||jsonb_build_object('unitCost',value/qty/100));
  END LOOP;
  payload:=jsonb_set(payload,'{stockItems}',stock);
 END IF;
 RETURN ev||jsonb_build_object('lines',lines,'payload',payload::text);
END $fn$;
REVOKE ALL ON FUNCTION financial_private.inventory_return_event(public.orders,jsonb) FROM PUBLIC,anon,authenticated,service_role;
DO $migration$
DECLARE d text;needle text:='    v_ev:=p_events->v_i;';
BEGIN
 d:=replace(pg_get_functiondef('public.confirm_order_return(text,text,text,jsonb,text)'::regprocedure),chr(13),'');
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_RETURN_PRIVACY_SCHEMA_DRIFT';END IF;
 EXECUTE replace(d,needle,needle||chr(10)||'    v_ev:=financial_private.inventory_return_event(v_order,v_ev);');
END $migration$;

-- An operational edit proves the SAME public snapshot, not a secret cost it
-- cannot read. Costs are still taken from the locked saved order by both
-- existing edit commands. Finance retains the exact binary64/piastre check.
DO $migration$
DECLARE d text;proc regprocedure;needle text;
BEGIN
 needle:=replace($needle$IF NOT financial_private.order_edit_snapshot_matches(
   jsonb_build_object('items',o.items,'stockItems',o."stockItems",'totalAmount',o."totalAmount",'discountAmount',o."discountAmount",'depositAmount',o."depositAmount"),p_input->'before') THEN$needle$,chr(13),'');
 FOREACH proc IN ARRAY ARRAY['public.record_order_edit(text,uuid,uuid,text,jsonb)'::regprocedure,
  'financial_private.record_fulfillment_edit(text,uuid,uuid,text,jsonb)'::regprocedure] LOOP
  d:=replace(pg_get_functiondef(proc),chr(13),'');
  IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_EDIT_PRIVACY_SCHEMA_DRIFT';END IF;
  EXECUTE replace(d,needle,$insert$IF (CASE WHEN public.can_read_store_finance(p_store) THEN NOT financial_private.order_edit_snapshot_matches(
   jsonb_build_object('items',o.items,'stockItems',o."stockItems",'totalAmount',o."totalAmount",'discountAmount',o."discountAmount",'depositAmount',o."depositAmount"),p_input->'before')
   ELSE public.strip_inventory_finance(jsonb_build_object('items',o.items,'stockItems',o."stockItems",'totalAmount',o."totalAmount",'discountAmount',o."discountAmount",'depositAmount',o."depositAmount"))
    IS DISTINCT FROM public.strip_inventory_finance(p_input->'before') END) THEN$insert$);
 END LOOP;
END $migration$;

-- The original request stays untouched for identity/replay. Private allocation
-- proofs and immutable before/after evidence must use the locked FULL server
-- snapshot, not the employee's deliberately redacted browser projection.
DO $migration$
DECLARE proc regprocedure;d text;snapshot text:='jsonb_build_object(''items'',o.items,''stockItems'',o."stockItems",''totalAmount'',o."totalAmount",''discountAmount'',o."discountAmount",''depositAmount'',o."depositAmount")';
BEGIN
 FOREACH proc IN ARRAY ARRAY['public.record_order_edit(text,uuid,uuid,text,jsonb)'::regprocedure,'financial_private.record_fulfillment_edit(text,uuid,uuid,text,jsonb)'::regprocedure] LOOP
  d:=pg_get_functiondef(proc);
  IF strpos(d,'''before'',p_input->''before'',''after'',v_patch')=0 THEN RAISE EXCEPTION 'NEXUS_EDIT_EVIDENCE_PRIVACY_DRIFT';END IF;
  IF strpos(d,'IF (CASE WHEN public.can_read_store_finance(p_store)')=0 THEN RAISE EXCEPTION 'NEXUS_EDIT_CAPTURE_PRIVACY_DRIFT';END IF;
  d:=replace(d,'DECLARE ','DECLARE v_server_before jsonb; ');
  d:=replace(d,'IF (CASE WHEN public.can_read_store_finance(p_store)','v_server_before:='||snapshot||';'||chr(10)||'  IF (CASE WHEN public.can_read_store_finance(p_store)');
  d:=replace(d,'''before'',p_input->''before'',''after'',v_patch','''before'',v_server_before,''after'',v_patch');
  IF proc='financial_private.record_fulfillment_edit(text,uuid,uuid,text,jsonb)'::regprocedure THEN
   IF strpos(d,'v_request,p_input->''before'',v_patch,v_result')=0 THEN RAISE EXCEPTION 'NEXUS_EDIT_ALLOCATION_PRIVACY_DRIFT';END IF;
   d:=replace(d,'v_request,p_input->''before'',v_patch,v_result','v_request,v_server_before,v_patch,v_result');
  END IF;
  EXECUTE d;
 END LOOP;
END $migration$;

-- The already atomic partial-return command uses immutable selected units to
-- hydrate costs for forward orders. Extend that SAME path to restricted staff
-- returning a legacy order; finance keeps its previously validated behavior.
DO $migration$
DECLARE d text;needle text:=' IF NOT FOUND OR o.fulfillment->>''version'' IS DISTINCT FROM ''1'' THEN RETURN p_input;END IF;';
BEGIN
 d:=replace(pg_get_functiondef('financial_private.fulfillment_return_input(uuid,jsonb)'::regprocedure),chr(13),'');
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_PARTIAL_RETURN_PRIVACY_SCHEMA_DRIFT';END IF;
 EXECUTE replace(d,needle,' IF NOT FOUND OR (o.fulfillment->>''version'' IS DISTINCT FROM ''1'' AND public.can_read_store_finance(p_store)) THEN RETURN p_input;END IF;');
END $migration$;
REVOKE ALL ON FUNCTION financial_private.fulfillment_return_input(uuid,jsonb),financial_private.place_backorder(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Authenticated callers can read only the operational projection. The old
-- FOR ALL write policy otherwise grants SELECT too. A restrictive SELECT
-- closes that alternate path without altering the existing write predicates.
CREATE POLICY inventory_finance_orders ON public.orders AS RESTRICTIVE FOR SELECT TO authenticated
 USING(public.can_read_store_finance(store_id));
CREATE POLICY inventory_finance_returns ON public.return_records AS RESTRICTIVE FOR SELECT TO authenticated
 USING(public.can_read_store_finance(store_id));
DO $migration$
DECLARE d text;
BEGIN
 d:=pg_get_viewdef('public.orders_operational'::regclass,true);
 d:=replace(d,'THEN items','THEN public.strip_inventory_finance(items)');
 d:=replace(d,'ELSE strip_line_cost(items)','ELSE public.strip_inventory_finance(items)');
 d:=replace(d,'THEN "stockItems"','THEN public.strip_inventory_finance("stockItems")');
 d:=replace(d,'ELSE strip_line_cost("stockItems")','ELSE public.strip_inventory_finance("stockItems")');
 -- Finance keeps its full projection. Operational per-order shipping charges
 -- and courier obligations remain usable; they are not inventory valuation.
 d:=replace(d,'public.strip_inventory_finance(items)','CASE WHEN public.can_read_store_finance(store_id) THEN items ELSE public.strip_inventory_finance(items) END');
 d:=replace(d,'public.strip_inventory_finance("stockItems")','CASE WHEN public.can_read_store_finance(store_id) THEN "stockItems" ELSE public.strip_inventory_finance("stockItems") END');
 d:=replace(d,'"exchangeDetails",','CASE WHEN public.can_read_store_finance(store_id) THEN "exchangeDetails" ELSE public.strip_inventory_finance("exchangeDetails") END AS "exchangeDetails",');
 d:=replace(d,'    fulfillment,','    CASE WHEN public.can_read_store_finance(store_id) THEN fulfillment ELSE public.strip_inventory_finance(fulfillment) END AS fulfillment,');
 IF strpos(d,'strip_inventory_finance(fulfillment)')=0 OR strpos(d,'strip_inventory_finance("stockItems")')=0 THEN RAISE EXCEPTION 'NEXUS_ORDER_PROJECTION_SCHEMA_DRIFT';END IF;
 EXECUTE 'CREATE OR REPLACE VIEW public.orders_operational WITH (security_barrier=true) AS '||d;
END $migration$;
CREATE VIEW public.return_records_operational WITH (security_barrier=true) AS
 SELECT (jsonb_populate_record(NULL::public.return_records,CASE WHEN public.can_read_store_finance(r.store_id) THEN to_jsonb(r)
  ELSE public.strip_inventory_finance(to_jsonb(r)) END)).* FROM public.return_records r
 WHERE public.has_role(r.store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY']) OR public.can_read_pos_return(r.store_id,r.original_order_id);
-- These are READ projections. Existing view ACLs and Supabase's table defaults
-- can include INSERT/UPDATE/DELETE; preserve no alternate privileged writer.
-- ADMIN's legitimate writes still use the base tables/validated commands.
REVOKE ALL ON public.orders_operational,public.return_records_operational FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.orders_operational,public.return_records_operational TO authenticated;

-- The only remaining direct order mutation is an operational PATCH. No cost
-- echo or full-row upsert. Existing financial/state/return-cause triggers stay
-- authoritative. This endpoint cannot create/delete an order or change money.
CREATE FUNCTION public.patch_operational_order(p_store uuid,p_order text,p_patch jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE o public.orders;cols text;result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_ORDER_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_patch) k WHERE k NOT IN
  ('status','courierId','courierName','courierFee','codServiceFee','returnType','return_cause','customerName','customerPhone','address','governorate','city','updatedAt','updated_at','store_id','device_id','sync_status'))
  OR (p_patch ? 'store_id' AND (p_patch->>'store_id')::uuid IS DISTINCT FROM p_store) THEN RAISE EXCEPTION 'NEXUS_ORDER_PATCH_FIELDS' USING ERRCODE='23514';END IF;
 PERFORM financial_private.fulfillment_lock(p_store);
 SELECT * INTO o FROM public.orders WHERE store_id=p_store AND id=p_order AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_ORDER_NOT_FOUND' USING ERRCODE='23514';END IF;
 IF p_patch ? 'status' AND p_patch->>'status' IS DISTINCT FROM o.status AND
  (p_patch->>'status' IN ('delivered','cancelled') OR o.status='cancelled' OR o."returnConfirmedAt" IS NOT NULL) THEN
  RAISE EXCEPTION 'NEXUS_ORDER_STATE_COMMAND_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT string_agg(format('%1$I=p.%1$I',a.attname),',') INTO cols FROM pg_attribute a
  WHERE a.attrelid='public.orders'::regclass AND a.attnum>0 AND NOT a.attisdropped AND p_patch ? a.attname
   AND a.attname NOT IN ('store_id','device_id');
 IF cols IS NOT NULL THEN EXECUTE format('UPDATE public.orders o SET %s FROM jsonb_populate_record(NULL::public.orders,$1) p WHERE o.store_id=$2 AND o.id=$3 RETURNING to_jsonb(o)',cols)
  USING p_patch,p_store,p_order INTO result;ELSE result:=to_jsonb(o);END IF;
 RETURN CASE WHEN public.can_read_store_finance(p_store) THEN result ELSE public.strip_inventory_finance(result) END;
END $fn$;
REVOKE ALL ON FUNCTION public.patch_operational_order(uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.patch_operational_order(uuid,text,jsonb) TO authenticated;

-- Bound receipt lines expose payment/revenue and operational quantities only.
-- Raw company lines remain inaccessible by the existing finance RLS.
DO $migration$
DECLARE d text;
BEGIN
 d:=pg_get_functiondef('public.read_pos_lines(uuid,text[])'::regprocedure);
 d:=replace(d,'SELECT l.* FROM public.ledger_lines l',
  'SELECT (jsonb_populate_record(NULL::public.ledger_lines,CASE WHEN public.can_read_store_finance(p_store) THEN to_jsonb(l) ELSE to_jsonb(l)||jsonb_build_object(''unit_cost'',NULL,''amount_delta'',CASE WHEN l.account=''stock'' THEN NULL ELSE l.amount_delta END) END)).* FROM public.ledger_lines l');
 d:=replace(d,'AND e.id=ANY(p_ids) ORDER BY l.id;',
  'AND e.id=ANY(p_ids) AND (public.can_read_store_finance(p_store) OR l.account<>''cogs'') ORDER BY l.id;');
 IF strpos(d,'''unit_cost'',NULL')=0 OR strpos(d,'l.account<>''cogs''')=0 THEN RAISE EXCEPTION 'NEXUS_RECEIPT_PROJECTION_SCHEMA_DRIFT';END IF;
 EXECUTE d;
END $migration$;

-- Receipt/event JSON is text on the wire. Sanitize the parsed payload rather
-- than looking only for top-level cost keys. Finance receives the full row.
CREATE FUNCTION financial_private.project_ledger_header(e public.ledger_events) RETURNS public.ledger_events
LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO public,pg_temp AS $fn$
 SELECT CASE WHEN public.can_read_store_finance(e.store_id) THEN e ELSE
  jsonb_populate_record(NULL::public.ledger_events,(to_jsonb(e)-'command_request'-'command_result')||
   jsonb_build_object('payload',public.strip_inventory_finance(e.payload::jsonb)::text)) END
$fn$;
REVOKE ALL ON FUNCTION financial_private.project_ledger_header(public.ledger_events) FROM PUBLIC,anon,authenticated,service_role;
DO $migration$
DECLARE proc regprocedure;d text;needle text;
BEGIN
 FOREACH proc IN ARRAY ARRAY['public.read_pos_headers(uuid,text[],text)'::regprocedure,'public.search_pos_receipts(uuid,text)'::regprocedure,'public.ledger_events_page(uuid,text,text,text,timestamptz,timestamptz,integer)'::regprocedure] LOOP
  d:=replace(pg_get_functiondef(proc),chr(13),'');
  IF strpos(d,'CASE WHEN finance THEN to_jsonb(e)')>0 THEN
   needle:=replace($needle$(jsonb_populate_record(NULL::public.ledger_events,
  CASE WHEN finance THEN to_jsonb(e) ELSE to_jsonb(e)-'command_request'-'command_result' END)).*$needle$,chr(13),'');
  ELSE needle:='(jsonb_populate_record(NULL::public.ledger_events,to_jsonb(e)-''command_request''-''command_result'')).*';END IF;
  IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_HEADER_PRIVACY_SCHEMA_DRIFT: %',proc;END IF;
  EXECUTE replace(d,needle,'(financial_private.project_ledger_header(e)).*');
 END LOOP;
END $migration$;

-- JSON-returning commands retain exact private replay results and nested
-- command contracts. Sanitize once at the OUTERMOST public boundary only.
-- The depth proof is private transaction state, never a client-settable GUC.
CREATE TABLE financial_private.inventory_api_depth(transaction_id bigint PRIMARY KEY,depth integer NOT NULL CHECK(depth>0));
ALTER TABLE financial_private.inventory_api_depth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.inventory_api_depth FROM PUBLIC,anon,authenticated,service_role;
DO $migration$
DECLARE sig text;proc regprocedure;args text;identity_args text;call_args text;name text;store_expr text;body text;
BEGIN
 FOREACH sig IN ARRAY ARRAY['place_order(jsonb,jsonb)','cancel_order(text,text,jsonb)','confirm_order_return(text,text,text,jsonb,text)',
  'record_order_edit(text,uuid,uuid,text,jsonb)','record_exchange_place(text,uuid,uuid,text,jsonb)','record_exchange_return(text,uuid,uuid,text,jsonb)',
  'record_order_cancel(text,uuid,uuid,text,jsonb)','record_order_payment(text,uuid,uuid,text,jsonb)','record_exchange_credit_refund(text,uuid,uuid,text,jsonb)',
  'record_cod_service_fee(text,uuid,uuid,text,jsonb)'] LOOP
  proc:=('public.'||sig)::regprocedure;
  SELECT proname,pg_get_function_arguments(oid),pg_get_function_identity_arguments(oid),array_to_string(proargnames,',') INTO name,args,identity_args,call_args FROM pg_proc WHERE oid=proc;
  store_expr:=CASE name WHEN 'place_order' THEN '(p_order->>''store_id'')::uuid' WHEN 'cancel_order' THEN '(p_event->>''store_id'')::uuid'
   WHEN 'confirm_order_return' THEN '(SELECT store_id FROM public.orders WHERE id=p_order_id)' ELSE 'p_store' END;
  EXECUTE format('ALTER FUNCTION %s SET SCHEMA financial_private',proc);
  EXECUTE format('REVOKE ALL ON FUNCTION financial_private.%I(%s) FROM PUBLIC,anon,authenticated,service_role',name,identity_args);
  body:=format($body$DECLARE result jsonb;nest integer;store uuid;
BEGIN
 INSERT INTO financial_private.inventory_api_depth VALUES(txid_current(),1) ON CONFLICT(transaction_id) DO UPDATE SET depth=inventory_api_depth.depth+1 RETURNING depth INTO nest;
 result:=financial_private.%I(%s);
 store:=%s;
 IF nest=1 THEN DELETE FROM financial_private.inventory_api_depth WHERE transaction_id=txid_current();
 ELSE UPDATE financial_private.inventory_api_depth SET depth=depth-1 WHERE transaction_id=txid_current();END IF;
 RETURN CASE WHEN nest>1 OR public.can_read_store_finance(store) THEN result ELSE public.strip_inventory_finance(result) END;
END$body$,name,call_args,store_expr);
  EXECUTE format('CREATE FUNCTION public.%I(%s) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS %L',name,args,body);
  EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC,anon',name,identity_args);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO authenticated',name,identity_args);
 END LOOP;
END $migration$;
NOTIFY pgrst,'reload schema';
