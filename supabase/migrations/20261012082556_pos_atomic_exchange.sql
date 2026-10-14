-- LOCAL CANDIDATE ONLY. No history backfill. Requires receipt_variant_stock.
-- One transaction links a validated historical return and a replacement sale.
-- Existing sale/refund contracts and old clients remain unchanged.
CREATE TABLE financial_private.pos_exchange_commands (
 id text PRIMARY KEY, store_id uuid NOT NULL REFERENCES public.stores(id),
 request jsonb NOT NULL, result jsonb NOT NULL
);
ALTER TABLE financial_private.pos_exchange_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.pos_exchange_commands FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.record_pos_exchange(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
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
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE']),false) THEN
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
 -- Both legs committed, but still in this SQL transaction. Exact variant net
 -- movements and ledger aggregate persist together with the linked record.
 FOREACH subject IN ARRAY all_ids LOOP
  SELECT * INTO product FROM public.products WHERE id=subject AND store_id=p_store;
  IF product."isBundle" THEN CONTINUE; END IF;
  variants:=coalesce(nullif(product.metadata->'variants','null'::jsonb),'[]');
  IF jsonb_array_length(variants)>0 THEN
   SELECT jsonb_agg(jsonb_set(v,'{stock}',to_jsonb((v->>'stock')::numeric+coalesce((SELECT sum((x->>'quantity')::numeric) FROM jsonb_array_elements(returns||sales) x
    WHERE x->>'productId'=subject AND x->>'variantName'=v->>'name'),0))) ORDER BY ordinal) INTO variants FROM jsonb_array_elements(variants) WITH ORDINALITY t(v,ordinal);
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(variants) v WHERE (v->>'stock')::numeric<0) THEN RAISE EXCEPTION 'NEXUS_STOCK_SHORT' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT coalesce(sum(qty_delta::numeric),0) INTO available FROM public.ledger_lines WHERE store_id=p_store AND account='stock' AND subject_id=subject;
  UPDATE public.products SET quantity=available,metadata=CASE WHEN jsonb_array_length(variants)>0 THEN jsonb_set(coalesce(metadata,'{}'),'{variants}',variants) ELSE metadata END,
   updated_at=greatest(coalesce(updated_at,0)+1,(extract(epoch FROM clock_timestamp())*1000)::bigint),sync_status='synced' WHERE store_id=p_store AND id=subject;
 END LOOP;
 SELECT -sum(amount_delta) INTO refund FROM public.ledger_lines WHERE store_id=p_store AND event_id=p_id AND account='wallet';
 INSERT INTO public.return_records(id,store_id,device_id,original_order_id,type,customer_name,customer_phone,governorate,returned_items,exchanged_item,financial_difference,processed_by,notes,created_at,updated_at,sync_status)
 VALUES('pos-exchange:'||p_id,p_store,p_device,source_id,'exchange',coalesce(source->>'customerName','عميل غير مسجل'),coalesce(source->>'customerPhone',''),'POS',
  (SELECT jsonb_agg(jsonb_build_object('product_id',x->>'productId','product_name',x->>'productName','variantName',x->>'variantName','quantity',-(x->>'quantity')::numeric,'refund_amount',round(-(x->>'quantity')::numeric*(x->>'unitPrice')::numeric,2))) FROM jsonb_array_elements(return_input->'payload'->'items') x),
  (SELECT jsonb_agg(jsonb_build_object('product_id',x->>'productId','product_name',x->>'productName','variantName',x->>'variantName','quantity',(x->>'quantity')::numeric,'price',(x->>'unitPrice')::numeric)) FROM jsonb_array_elements(normalized) x),
  (net-refund)/100,'POS','استبدال ذري مرتبط بفاتورة الأصل',now(),(extract(epoch FROM clock_timestamp())*1000)::bigint,'synced');
 result:=jsonb_build_object('eventId',p_id,'returnEventId',p_id,'replacementEventId',p_id||':replacement','sourceEventId',source_id,
  'returnRecordId','pos-exchange:'||p_id,'refundPiastres',refund,'replacementPiastres',net,'netPiastres',net-refund,'affectedProductIds',to_jsonb(all_ids),'replayed',false);
 INSERT INTO financial_private.pos_exchange_commands VALUES(p_id,p_store,request,result);
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.record_pos_exchange(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_pos_exchange(text,uuid,uuid,text,jsonb) TO authenticated;
