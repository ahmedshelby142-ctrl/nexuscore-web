-- LOCAL ONLY. Requires the five master-repair migrations, in order.
-- Forward business commands only; never repair or rewrite historical rows.
-- Reuse the existing private catalog replay journal; preserve bundle commands.
REVOKE ALL ON financial_private.catalog_commands FROM PUBLIC,anon,authenticated;
CREATE TABLE financial_private.catalog_creation_permits(transaction_id bigint,store_id uuid,product_id text,quantity numeric,variants jsonb,PRIMARY KEY(transaction_id,store_id,product_id));
ALTER TABLE financial_private.catalog_creation_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.catalog_creation_permits FROM PUBLIC,anon,authenticated;
CREATE FUNCTION financial_private.guard_catalog_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE v_variants jsonb:=coalesce(nullif(NEW.metadata->'variants','null'::jsonb),'[]');permitted integer;
BEGIN
 IF jsonb_typeof(v_variants) IS DISTINCT FROM 'array' OR NEW.quantity<0 OR NEW.quantity::text IN ('NaN','Infinity','-Infinity')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_variants) x WHERE nullif(x->>'name','') IS NULL OR x->>'stock' IS NULL OR (x->>'stock')::numeric<0
    OR (x->>'stock')::numeric::text IN ('NaN','Infinity','-Infinity'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_variants) x GROUP BY x->>'name' HAVING count(*)>1)
  OR (jsonb_array_length(v_variants)>0 AND (SELECT sum((x->>'stock')::numeric) FROM jsonb_array_elements(v_variants) x) IS DISTINCT FROM NEW.quantity) THEN
  RAISE EXCEPTION 'NEXUS_CATALOG_VARIANT_INVALID' USING ERRCODE='23514';END IF;
 IF NEW.quantity<>0 THEN
  DELETE FROM financial_private.catalog_creation_permits p WHERE p.transaction_id=txid_current() AND p.store_id=NEW.store_id AND p.product_id=NEW.id AND p.quantity=NEW.quantity AND p.variants=v_variants;
  GET DIAGNOSTICS permitted=ROW_COUNT;
  IF permitted<>1 THEN RAISE EXCEPTION 'NEXUS_CATALOG_ATOMIC_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_catalog_insert() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER product_catalog_insert BEFORE INSERT ON public.products FOR EACH ROW EXECUTE FUNCTION financial_private.guard_catalog_insert();

CREATE FUNCTION public.record_product_catalog(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE request jsonb:=jsonb_build_object('command',p_command,'input',p_input);saved financial_private.catalog_commands;
 old public.products;product public.products;row_data jsonb:=p_input->'product';target jsonb;before_variants jsonb;counts jsonb:='[]';v jsonb;
 v_product_id text:=row_data->>'id';creating boolean:=p_input->>'action'='create';total numeric;prior numeric;value numeric;delta numeric;
 cost numeric;amount numeric;lines jsonb;result jsonb;event_id text;stamp bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false) THEN
  RAISE EXCEPTION 'NEXUS_CATALOG_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF nullif(p_id,'') IS NULL OR p_device IS NULL OR p_command IS DISTINCT FROM 'product_catalog'
  OR coalesce(p_input->>'action','') NOT IN ('create','update') OR nullif(v_product_id,'') IS NULL OR jsonb_typeof(row_data) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'NEXUS_CATALOG_INVALID' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('catalog-operation:'||p_id,0));
 SELECT * INTO saved FROM financial_private.catalog_commands WHERE catalog_commands.id=p_id;
 IF FOUND THEN
  IF saved.store_id IS DISTINCT FROM p_store OR saved.request IS DISTINCT FROM request THEN RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514';END IF;
  RETURN saved.result||jsonb_build_object('replayed',true);
 END IF;
 IF NOT public.store_licensed(p_store) THEN RAISE EXCEPTION 'NEXUS_STORE_NOT_LICENSED' USING ERRCODE='42501';END IF;
 -- Serialize uniqueness checks, then use the same stock/product lock order.
 PERFORM pg_advisory_xact_lock(hashtextextended('catalog-store:'||p_store,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pos-stock:'||p_store||':'||v_product_id,0));
 SELECT * INTO old FROM public.products WHERE products.id=v_product_id AND store_id=p_store FOR UPDATE;
 IF creating AND FOUND THEN RAISE EXCEPTION 'NEXUS_CATALOG_EXISTS' USING ERRCODE='23505';END IF;
 IF NOT creating AND (old.id IS NULL OR old.deleted_at IS NOT NULL OR coalesce((p_input->>'expectedUpdatedAt')::bigint,-1)<>old.updated_at) THEN
  RAISE EXCEPTION 'NEXUS_CATALOG_STALE: refresh before adjusting stock' USING ERRCODE='23514';END IF;
 IF NOT creating AND old."isBundle" THEN RAISE EXCEPTION 'NEXUS_CATALOG_BOX_DEFINITION_REQUIRED' USING ERRCODE='23514';END IF;
 row_data:=CASE WHEN creating THEN row_data ELSE to_jsonb(old)||row_data END;
 product:=jsonb_populate_record(NULL::public.products,row_data);
 IF nullif(trim(product.name),'') IS NULL OR nullif(trim(product.sku),'') IS NULL OR coalesce(product."isBundle",false)
  OR coalesce(product."unitPrice",0)<0 OR coalesce(product.wholesale_price,0)<0
  OR coalesce(product."unitPrice",0)::text IN ('NaN','Infinity','-Infinity') OR coalesce(product.wholesale_price,0)::text IN ('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'NEXUS_CATALOG_INVALID' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.products p WHERE p.store_id=p_store AND p.deleted_at IS NULL AND p.id<>v_product_id AND
   (p.sku=product.sku OR (nullif(product.barcode,'') IS NOT NULL AND p.barcode=product.barcode))) THEN
  RAISE EXCEPTION 'NEXUS_CATALOG_DUPLICATE_CODE' USING ERRCODE='23505';END IF;
 target:=coalesce(nullif(product.metadata->'variants','null'::jsonb),'[]');
 IF jsonb_typeof(target) IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(target) x WHERE nullif(x->>'name','') IS NULL
  OR x->>'stock' IS NULL OR (x->>'stock')::numeric<0 OR (x->>'stock')::numeric::text IN ('NaN','Infinity','-Infinity'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(target) x GROUP BY x->>'name' HAVING count(*)>1) THEN RAISE EXCEPTION 'NEXUS_CATALOG_VARIANT_INVALID' USING ERRCODE='23514';END IF;
 total:=CASE WHEN jsonb_array_length(target)>0 THEN (SELECT sum((x->>'stock')::numeric) FROM jsonb_array_elements(target) x) ELSE coalesce(product.quantity,0) END;
 IF jsonb_array_length(target)>0 AND product.quantity IS DISTINCT FROM total THEN RAISE EXCEPTION 'NEXUS_CATALOG_EXPLICIT_VARIANT_COUNTS_REQUIRED' USING ERRCODE='23514';END IF;
 IF total<0 OR total::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'NEXUS_CATALOG_INVALID' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(qty_delta::numeric),0),coalesce(sum(amount_delta),0) INTO prior,value FROM public.ledger_lines WHERE store_id=p_store AND account='stock' AND subject_id=v_product_id;
 IF creating AND EXISTS(SELECT 1 FROM public.ledger_lines WHERE store_id=p_store AND account='stock' AND subject_id=v_product_id) THEN RAISE EXCEPTION 'NEXUS_STOCK_IDENTITY_IMMUTABLE' USING ERRCODE='23514';END IF;
 cost:=CASE WHEN NOT creating AND prior>0 THEN value/prior/100 ELSE coalesce((p_input->>'unitCost')::numeric,0) END;
 IF cost<0 OR cost::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'NEXUS_CATALOG_INVALID' USING ERRCODE='23514';END IF;
 stamp:=greatest(coalesce(old.updated_at,0)+1,(extract(epoch FROM clock_timestamp())*1000)::bigint);
 IF creating THEN
  INSERT INTO financial_private.catalog_creation_permits VALUES(txid_current(),p_store,v_product_id,total,target);
  INSERT INTO public.products(id,store_id,device_id,name,sku,barcode,category,description,image_url,"unitPrice",wholesale_price,"minStockLevel","maxStockLevel","isActive","isBundle","bundleItems",metadata,quantity,updated_at,sync_status)
   VALUES(v_product_id,p_store,p_device,trim(product.name),trim(product.sku),product.barcode,coalesce(product.category,''),product.description,product.image_url,coalesce(product."unitPrice",0),coalesce(product.wholesale_price,0),
    product."minStockLevel",product."maxStockLevel",coalesce(product."isActive",true),false,'[]',product.metadata,total,stamp,'synced');
 ELSE
  before_variants:=coalesce(nullif(old.metadata->'variants','null'::jsonb),'[]');
  IF old.quantity IS DISTINCT FROM prior OR (jsonb_array_length(before_variants)>0 AND
   (SELECT sum((x->>'stock')::numeric) FROM jsonb_array_elements(before_variants) x) IS DISTINCT FROM prior) THEN RAISE EXCEPTION 'NEXUS_STOCK_RECONCILIATION_REQUIRED' USING ERRCODE='23514';END IF;
  -- Nonzero identities cannot disappear or be relabelled. Use a counted
  -- adjustment against the existing exact identity; never guess allocations.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(before_variants) x WHERE (x->>'stock')::numeric<>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(target) y WHERE y->>'name'=x->>'name'))
    OR (jsonb_array_length(before_variants)=0 AND prior<>0 AND jsonb_array_length(target)>0) THEN RAISE EXCEPTION 'NEXUS_CATALOG_VARIANT_REVIEW' USING ERRCODE='23514';END IF;
  IF jsonb_array_length(target)>0 THEN
   FOR v IN SELECT x FROM jsonb_array_elements(target) x LOOP
    counts:=counts||jsonb_build_array(jsonb_build_object('productId',v_product_id,'variantName',v->>'name','systemQty',coalesce((SELECT (x->>'stock')::numeric FROM jsonb_array_elements(before_variants) x WHERE x->>'name'=v->>'name'),0),'countedQty',(v->>'stock')::numeric));
   END LOOP;
   SELECT jsonb_agg(jsonb_set(x,'{stock}',to_jsonb(coalesce((SELECT (b->>'stock')::numeric FROM jsonb_array_elements(before_variants) b WHERE b->>'name'=x->>'name'),0))) ORDER BY n)
    INTO before_variants FROM jsonb_array_elements(target) WITH ORDINALITY t(x,n);
  ELSE counts:=jsonb_build_array(jsonb_build_object('productId',v_product_id,'systemQty',prior,'countedQty',total));END IF;
  UPDATE public.products SET name=trim(product.name),sku=trim(product.sku),barcode=product.barcode,category=coalesce(product.category,''),description=product.description,image_url=product.image_url,
    "unitPrice"=coalesce(product."unitPrice",0),wholesale_price=coalesce(product.wholesale_price,0),"minStockLevel"=product."minStockLevel","maxStockLevel"=product."maxStockLevel","isActive"=coalesce(product."isActive",true),
    metadata=CASE WHEN jsonb_array_length(target)>0 THEN jsonb_set(coalesce(product.metadata,'{}'),'{variants}',before_variants) ELSE product.metadata END,updated_at=stamp,sync_status='synced'
    WHERE products.id=v_product_id AND store_id=p_store;
 END IF;
 DELETE FROM financial_private.catalog_creation_permits WHERE transaction_id=txid_current() AND store_id=p_store AND catalog_creation_permits.product_id=v_product_id;
 delta:=total-prior;amount:=floor(delta*cost*100+0.5);
 IF (creating AND total>0) OR (NOT creating AND EXISTS(SELECT 1 FROM jsonb_array_elements(counts) x WHERE (x->>'systemQty')::numeric IS DISTINCT FROM (x->>'countedQty')::numeric)) THEN
  event_id:=p_id;
  IF creating THEN
   lines:=jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','stock','subject_id',v_product_id,'qty_delta',delta,'amount_delta',amount));
  ELSE
   -- Preserve each real counted movement, even when their aggregate is zero.
   -- A zero-quantity stock line is prohibited by the existing ledger contract.
   SELECT jsonb_agg(jsonb_build_object('id',gen_random_uuid()::text,'account','stock','subject_id',v_product_id,
      'qty_delta',movement,'amount_delta',floor(prefix*cost*100+0.5)-floor((prefix-movement)*cost*100+0.5)) ORDER BY n)
    INTO lines FROM (SELECT n,movement,sum(movement) OVER(ORDER BY n) prefix FROM
      (SELECT n,(x->>'countedQty')::numeric-(x->>'systemQty')::numeric movement FROM jsonb_array_elements(counts) WITH ORDINALITY t(x,n)) movements
      WHERE movement<>0) allocated;
   SELECT sum((x->>'amount_delta')::numeric) INTO amount FROM jsonb_array_elements(lines) x;
  END IF;
  IF NOT creating AND amount<>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','expense','subject_id','shrinkage','amount_delta',-amount));END IF;
  PERFORM public.ledger_append(jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'kind','stock_adjustment',
    'ref_type',CASE WHEN creating THEN 'opening_balance' ELSE 'stock_audit' END,'ref_id',v_product_id,'actor','كتالوج المنتجات',
    'occurred_at',now(),'created_at',now(),'payload',jsonb_build_object('productName',product.name,'stockCounts',counts,'catalogAction',p_input->>'action')::text,'lines',lines));
 END IF;
 SELECT * INTO product FROM public.products WHERE products.id=v_product_id AND store_id=p_store;
 result:=jsonb_build_object('product',to_jsonb(product),'eventId',event_id,'replayed',false);
 INSERT INTO financial_private.catalog_commands VALUES(p_id,p_store,request,result);
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.record_product_catalog(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_product_catalog(text,uuid,uuid,text,jsonb) TO authenticated;

-- Ordinary returns consume the same immutable original-unit slots as exchanges.
-- Legacy documents keep their old prefix interpretation; new documents retain
-- exact slots so a pending exchange cannot make a later return consume it twice.
DO $migration$
DECLARE definition text;needle text;
BEGIN
 definition:=replace(pg_get_functiondef('financial_private.exchange_selection(uuid,public.orders,jsonb)'::regprocedure),chr(13),'');
 needle:='AND i->>''product_id''=product_id';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'NEXUS_RETURN_SELECTION_SCHEMA_DRIFT';END IF;
 definition:=replace(definition,needle,'AND NOT i ? ''unitNumbers'' '||needle);
 needle:='  slots:=''[]'';refund:=0;';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'NEXUS_RETURN_SELECTION_SCHEMA_DRIFT';END IF;
 definition:=replace(definition,needle,$patch$
  SELECT claimed||coalesce(jsonb_agg(n),'[]') INTO claimed FROM public.return_records r
   CROSS JOIN LATERAL jsonb_array_elements(r.returned_items) i
   CROSS JOIN LATERAL jsonb_array_elements(i->'unitNumbers') n
   WHERE r.store_id=p_store AND r.original_order_id=o.id AND r.deleted_at IS NULL AND r.id NOT LIKE 'exchange:%'
    AND i->>'product_id'=product_id AND coalesce(i->>'variantName','')=variant;
  IF variant<>'' AND EXISTS(SELECT 1 FROM public.return_records r CROSS JOIN LATERAL jsonb_array_elements(r.returned_items) i
   WHERE r.store_id=p_store AND r.original_order_id=o.id AND r.deleted_at IS NULL
    AND i->>'product_id'=product_id AND coalesce(i->>'variantName','')='') THEN
   RAISE EXCEPTION 'NEXUS_RETURN_LEGACY_VARIANT_REVIEW' USING ERRCODE='23514';END IF;
  slots:='[]';refund:=0;
$patch$);
 EXECUTE definition;
END $migration$;

-- Every ordinary return's human document is created inside the same stock /
-- ledger transaction. Source snapshots, not current catalog recipes/prices.
CREATE FUNCTION financial_private.persist_return_document(p_event text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
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
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(e.store_id,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
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
END $fn$;
REVOKE ALL ON FUNCTION financial_private.persist_return_document(text) FROM PUBLIC,anon,authenticated;
DO $migration$
DECLARE definition text;needle text:=' INSERT INTO financial_private.stock_applications VALUES(e.id,e.store_id,stocks,moves);';
 valuation text:='(SELECT sum(floor((x->>''qty'')::numeric*prior_value/prior+0.5)) FROM jsonb_array_elements(stocks) x WHERE x->>''productId''=subject)';
BEGIN
 definition:=replace(pg_get_functiondef('financial_private.apply_stock_event(text)'::regprocedure),chr(13),'');
 IF strpos(definition,needle)=0 OR strpos(definition,valuation)=0 THEN RAISE EXCEPTION 'NEXUS_RETURN_DOCUMENT_SCHEMA_DRIFT';END IF;
 definition:=replace(definition,valuation,'(CASE WHEN e.kind=''stock_adjustment'' THEN floor(delta*prior_value/prior+0.5) ELSE '||valuation||' END)');
 EXECUTE replace(definition,needle,needle||chr(10)||' PERFORM financial_private.persist_return_document(e.id);');
END $migration$;

CREATE FUNCTION financial_private.guard_return_document() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM public.ledger_events e WHERE 'return:'||e.id=OLD.id AND e.store_id=OLD.store_id) THEN
  RAISE EXCEPTION 'NEXUS_RETURN_DOCUMENT_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_return_document() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER nexus_return_document_immutable BEFORE UPDATE OR DELETE ON public.return_records FOR EACH ROW EXECUTE FUNCTION financial_private.guard_return_document();

CREATE FUNCTION financial_private.require_return_document() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE payload jsonb:=coalesce(NEW.payload::jsonb,'{}');required boolean;
BEGIN
 required:=(NEW.ref_type='ecommerce_order' AND NEW.kind IN ('return_confirmed','rto_confirmed'))
  OR (NEW.kind='sale' AND NEW.ref_type='pos_sale' AND payload->>'exchangeLeg' IS NULL
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'items') x WHERE (x->>'quantity')::numeric<0));
 IF required AND NOT EXISTS(SELECT 1 FROM public.return_records r WHERE r.id='return:'||NEW.id AND r.store_id=NEW.store_id) THEN
  RAISE EXCEPTION 'NEXUS_RETURN_DOCUMENT_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.require_return_document() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER nexus_return_document_required AFTER INSERT ON public.ledger_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION financial_private.require_return_document();

-- Keep the legacy blanket guard for unallocated/full returns. The new partial
-- command is checked by exchange_selection and the required atomic document.
DO $migration$
DECLARE definition text;needle text;
BEGIN
 definition:=replace(pg_get_functiondef('financial_private.guard_exchange_ledger()'::regprocedure),chr(13),'');
 needle:='  IF EXISTS(SELECT 1 FROM financial_private.order_exchanges WHERE store_id=NEW.store_id AND original_id=original AND status IN (''pending'',''confirmed'')) THEN';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'NEXUS_RETURN_GUARD_SCHEMA_DRIFT';END IF;
 EXECUTE replace(definition,needle,replace(needle,' THEN',$patch$
   AND NOT coalesce((NEW.kind='return_confirmed' AND NEW.command_request->>'command'='stock_event'
    AND jsonb_typeof(NEW.payload::jsonb->'returnUnits')='array'),false) THEN$patch$));
 definition:=replace(pg_get_functiondef('public.record_exchange_place(text,uuid,uuid,text,jsonb)'::regprocedure),chr(13),'');
 needle:='   AND x.ref_id=o."orderNumber" AND x.kind=''return_confirmed'') THEN';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'NEXUS_RETURN_EXCHANGE_SCHEMA_DRIFT';END IF;
 EXECUTE replace(definition,needle,$patch$
   AND x.ref_id=o."orderNumber" AND x.kind='return_confirmed' AND NOT EXISTS(
    SELECT 1 FROM public.return_records r WHERE r.id='return:'||x.id AND r.store_id=p_store AND r.original_order_id=o.id
     AND r.deleted_at IS NULL AND jsonb_array_length(r.returned_items)>0
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.returned_items) i WHERE NOT i ? 'unitNumbers' OR NOT i ? 'lineId'))) THEN$patch$);
END $migration$;
