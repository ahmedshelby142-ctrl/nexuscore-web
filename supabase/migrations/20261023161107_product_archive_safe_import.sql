-- Product lifecycle/import only. No historical backfill or ledger rewrite.
-- New rows delegate opening stock to the unchanged record_product_catalog.
CREATE FUNCTION financial_private.catalog_code(p_value text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO pg_catalog AS $fn$
 SELECT translate(translate(btrim(normalize(coalesce(p_value,''),NFKC),
   ' '||chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(5760)||chr(8232)||chr(8233)||chr(65279)),
   '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','01234567890123456789'),
   'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');
$fn$;
REVOKE ALL ON FUNCTION financial_private.catalog_code(text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION financial_private.product_reference(p_document jsonb,p_product text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path TO pg_catalog AS $fn$
 SELECT jsonb_path_exists(coalesce(p_document,'null'::jsonb),'$.**.productId ? (@ == $id)',jsonb_build_object('id',p_product),true)
 OR jsonb_path_exists(coalesce(p_document,'null'::jsonb),'$.**.product_id ? (@ == $id)',jsonb_build_object('id',p_product),true)
 OR jsonb_path_exists(coalesce(p_document,'null'::jsonb),'$.**.product.id ? (@ == $id)',jsonb_build_object('id',p_product),true);
$fn$;
REVOKE ALL ON FUNCTION financial_private.product_reference(jsonb,text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION financial_private.product_lifecycle_status(p_store uuid,p_product text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO pg_catalog AS $fn$
 SELECT jsonb_build_object(
  'pendingOrders',(SELECT count(*) FROM public.orders o WHERE o.store_id=p_store AND o.deleted_at IS NULL
   AND o.status IN ('pending','shipped') AND financial_private.product_reference(jsonb_build_array(o.items,o."stockItems",o.fulfillment),p_product)),
  'pendingReplacements',(SELECT count(*) FROM public.return_records r WHERE r.store_id=p_store AND r.deleted_at IS NULL
   AND financial_private.product_reference(r.pending_replacement,p_product)),
  'bundleDependencies',(SELECT count(*) FROM public.products b WHERE b.store_id=p_store AND b.id<>p_product
   AND b.deleted_at IS NULL AND coalesce(b."isActive",true) AND coalesce(b."isBundle",false)
   AND financial_private.product_reference(b."bundleItems",p_product)),
  'hasHistory',EXISTS(SELECT 1 FROM public.ledger_lines l WHERE l.store_id=p_store AND l.subject_id=p_product)
   OR EXISTS(SELECT 1 FROM public.orders o WHERE o.store_id=p_store AND financial_private.product_reference(jsonb_build_array(o.items,o."stockItems",o.fulfillment),p_product))
   OR EXISTS(SELECT 1 FROM public.purchase_invoices i WHERE i.store_id=p_store AND financial_private.product_reference(i.items,p_product))
   OR EXISTS(SELECT 1 FROM public.return_records r WHERE r.store_id=p_store AND financial_private.product_reference(jsonb_build_array(r.returned_items,r.exchanged_item,r.pending_replacement),p_product))
   OR EXISTS(SELECT 1 FROM public.wholesale_invoices i WHERE i.store_id=p_store AND financial_private.product_reference(i.items,p_product)));
$fn$;
REVOKE ALL ON FUNCTION financial_private.product_lifecycle_status(uuid,text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.read_product_archive_status(p_store uuid,p_product_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
DECLARE p public.products;d jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false) THEN
  RAISE EXCEPTION 'NEXUS_PRODUCT_ARCHIVE_FORBIDDEN' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM public.products WHERE store_id=p_store AND id=p_product_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_PRODUCT_NOT_FOUND' USING ERRCODE='23514';END IF;
 d:=financial_private.product_lifecycle_status(p_store,p_product_id);
 RETURN d||jsonb_build_object('productId',p.id,'storeId',p_store,'revision',p.updated_at,'archived',p.deleted_at IS NOT NULL,
  'canArchive',(d->>'pendingOrders')::int=0 AND (d->>'pendingReplacements')::int=0 AND (d->>'bundleDependencies')::int=0,
  'canDelete',NOT (d->>'hasHistory')::boolean AND (d->>'pendingOrders')::int=0 AND (d->>'pendingReplacements')::int=0 AND (d->>'bundleDependencies')::int=0);
END $fn$;
REVOKE ALL ON FUNCTION public.read_product_archive_status(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.read_product_archive_status(uuid,text) TO authenticated;

CREATE FUNCTION financial_private.guard_product_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
DECLARE d jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  d:=financial_private.product_lifecycle_status(OLD.store_id,OLD.id);
  IF (d->>'hasHistory')::boolean OR (d->>'pendingOrders')::int>0 OR (d->>'pendingReplacements')::int>0 OR (d->>'bundleDependencies')::int>0 THEN
   RAISE EXCEPTION 'NEXUS_PRODUCT_HISTORY_REQUIRES_ARCHIVE' USING ERRCODE='23514';END IF;
  RETURN OLD;
 END IF;
 IF NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN RETURN NEW;END IF;
 -- A private journal row created in THIS transaction is the unforgeable
 -- permit. No caller-controlled setting or broad grant can mint it.
 IF NOT EXISTS(SELECT 1 FROM financial_private.catalog_commands c WHERE c.store_id=OLD.store_id
   AND c.xmin::text=pg_current_xact_id()::text AND c.request->>'command'='product_archive'
   AND c.request#>>'{input,productId}'=OLD.id
   AND ((c.request#>>'{input,action}'='archive' AND NEW.deleted_at IS NOT NULL)
     OR (c.request#>>'{input,action}'='restore' AND NEW.deleted_at IS NULL))) THEN
  RAISE EXCEPTION 'NEXUS_PRODUCT_ARCHIVE_COMMAND_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.deleted_at IS NOT NULL THEN
  d:=financial_private.product_lifecycle_status(OLD.store_id,OLD.id);
  IF (d->>'pendingOrders')::int>0 OR (d->>'pendingReplacements')::int>0 THEN
   RAISE EXCEPTION 'NEXUS_PRODUCT_HAS_PENDING_COMMITMENTS' USING ERRCODE='23514';END IF;
  IF (d->>'bundleDependencies')::int>0 THEN RAISE EXCEPTION 'NEXUS_PRODUCT_USED_IN_ACTIVE_BUNDLE' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_product_lifecycle() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER nexus_product_lifecycle_guard BEFORE UPDATE OF deleted_at OR DELETE ON public.products
 FOR EACH ROW EXECUTE FUNCTION financial_private.guard_product_lifecycle();

CREATE FUNCTION public.record_product_archive(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
DECLARE p public.products;c financial_private.catalog_commands;request jsonb;result jsonb;stamp bigint;
 target text:=p_input->>'productId';action text:=p_input->>'action';
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false) THEN
  RAISE EXCEPTION 'NEXUS_PRODUCT_ARCHIVE_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF p_command IS DISTINCT FROM 'product_archive' OR nullif(p_id,'') IS NULL OR p_device IS NULL OR nullif(target,'') IS NULL
   OR action NOT IN ('archive','restore') OR action IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
   OR NOT(p_input ? 'expectedUpdatedAt') THEN RAISE EXCEPTION 'NEXUS_PRODUCT_ARCHIVE_INVALID' USING ERRCODE='23514';END IF;
 request:=jsonb_build_object('command',p_command,'input',p_input,'actorId',auth.uid(),'deviceId',p_device);
 PERFORM pg_advisory_xact_lock(hashtextextended('catalog-operation:'||p_id,0));
 SELECT * INTO c FROM financial_private.catalog_commands WHERE id=p_id;
 IF FOUND THEN
  IF c.store_id IS DISTINCT FROM p_store OR c.request IS DISTINCT FROM request THEN RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514';END IF;
  RETURN c.result||jsonb_build_object('replayed',true);
 END IF;
 IF NOT public.store_licensed(p_store) THEN RAISE EXCEPTION 'NEXUS_STORE_NOT_LICENSED' USING ERRCODE='42501';END IF;
 -- Same store lock as POS/order placement: a product cannot be archived
 -- between an availability check and the pending order/stock commit.
 PERFORM financial_private.fulfillment_lock(p_store);
 PERFORM pg_advisory_xact_lock(hashtextextended('catalog-store:'||p_store,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pos-stock:'||p_store||':'||target,0));
 SELECT * INTO p FROM public.products WHERE id=target AND store_id=p_store FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_PRODUCT_NOT_FOUND' USING ERRCODE='23514';END IF;
 IF (p.deleted_at IS NOT NULL)=(action='archive') THEN
  result:=jsonb_build_object('product',to_jsonb(p),'eventId',NULL,'replayed',false,'unchanged',true);
 ELSE
  IF coalesce((p_input->>'expectedUpdatedAt')::bigint,-1)<>p.updated_at THEN RAISE EXCEPTION 'NEXUS_PRODUCT_STALE' USING ERRCODE='23514';END IF;
  IF action='restore' AND EXISTS(SELECT 1 FROM public.products other WHERE other.store_id=p_store AND other.id<>p.id AND other.deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM unnest(ARRAY[financial_private.catalog_code(p.sku),financial_private.catalog_code(p.barcode)]) code
      WHERE code<>'' AND code IN (financial_private.catalog_code(other.sku),financial_private.catalog_code(other.barcode)))) THEN
   RAISE EXCEPTION 'NEXUS_PRODUCT_RESTORE_CODE_CONFLICT' USING ERRCODE='23505';END IF;
  IF action='restore' AND p."isBundle" THEN
   PERFORM public.validate_bundle_definition(p_store,p.id,p."bundleItems");
  END IF;
  stamp:=greatest(p.updated_at+1,(extract(epoch FROM clock_timestamp())*1000)::bigint);
  INSERT INTO financial_private.catalog_commands VALUES(p_id,p_store,request,jsonb_build_object('processing',true));
  UPDATE public.products SET deleted_at=CASE WHEN action='archive' THEN stamp ELSE NULL END,updated_at=stamp,sync_status='synced'
   WHERE id=target AND store_id=p_store RETURNING * INTO p;
  result:=jsonb_build_object('product',to_jsonb(p),'eventId',NULL,'replayed',false,'unchanged',false);
  UPDATE financial_private.catalog_commands j SET result=jsonb_build_object('product',to_jsonb(p),'eventId',NULL,'replayed',false,'unchanged',false) WHERE j.id=p_id;
  RETURN result;
 END IF;
 INSERT INTO financial_private.catalog_commands VALUES(p_id,p_store,request,result);
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.record_product_archive(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_product_archive(text,uuid,uuid,text,jsonb) TO authenticated;

CREATE FUNCTION public.record_product_import(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
DECLARE request jsonb:=jsonb_build_object('command',p_command,'input',p_input);c financial_private.catalog_commands;
 supplied jsonb:=p_input->'product';p public.products;matches text[];result jsonb;v_sku text;v_barcode text;quantity numeric;
BEGIN
 -- Bulk import is an existing ADMIN-only UI capability. Other catalogue
 -- commands retain their original ADMIN/ACCOUNTANT role behaviour.
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN']),false) THEN
  RAISE EXCEPTION 'NEXUS_PRODUCT_IMPORT_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF p_command IS DISTINCT FROM 'product_import' OR nullif(p_id,'') IS NULL OR p_device IS NULL
  OR jsonb_typeof(supplied) IS DISTINCT FROM 'object' OR nullif(supplied->>'id','') IS NULL THEN
  RAISE EXCEPTION 'NEXUS_PRODUCT_IMPORT_INVALID' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('catalog-operation:'||p_id,0));
 SELECT * INTO c FROM financial_private.catalog_commands WHERE id=p_id;
 IF FOUND THEN
  IF c.store_id IS DISTINCT FROM p_store OR c.request IS DISTINCT FROM request THEN RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514';END IF;
  RETURN c.result||jsonb_build_object('replayed',true);
 END IF;
 IF NOT public.store_licensed(p_store) THEN RAISE EXCEPTION 'NEXUS_STORE_NOT_LICENSED' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('catalog-store:'||p_store,0));
 v_sku:=financial_private.catalog_code(supplied->>'sku');v_barcode:=financial_private.catalog_code(supplied->>'barcode');
 IF v_sku='' THEN RAISE EXCEPTION 'NEXUS_PRODUCT_IMPORT_IDENTIFIER_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT array_agg(id ORDER BY id) INTO matches FROM public.products other WHERE other.store_id=p_store AND
   ((v_sku<>'' AND v_sku IN (financial_private.catalog_code(other.sku),financial_private.catalog_code(other.barcode)))
    OR (v_barcode<>'' AND v_barcode IN (financial_private.catalog_code(other.sku),financial_private.catalog_code(other.barcode))));
 IF coalesce(cardinality(matches),0)>1 THEN RAISE EXCEPTION 'NEXUS_PRODUCT_IMPORT_CODE_CONFLICT' USING ERRCODE='23505';END IF;
 IF cardinality(matches)=1 THEN
  SELECT * INTO p FROM public.products WHERE store_id=p_store AND id=matches[1];
  -- A supplied explicit pair must not resolve to inconsistent identities.
  IF coalesce((p_input->>'separateIdentifiers')::boolean,false) AND
    (v_sku<>financial_private.catalog_code(p.sku) OR (v_barcode<>'' AND v_barcode<>financial_private.catalog_code(p.barcode))) THEN
   RAISE EXCEPTION 'NEXUS_PRODUCT_IMPORT_CODE_CONFLICT' USING ERRCODE='23505';END IF;
  result:=jsonb_build_object('product',to_jsonb(p),'eventId',NULL,'skipped',true,'replayed',false);
  INSERT INTO financial_private.catalog_commands VALUES(p_id,p_store,request,result);RETURN result;
 END IF;
 quantity:=coalesce((supplied->>'quantity')::numeric,0);
 IF quantity>0 AND coalesce(p_input->>'stockContext','') NOT IN ('opening','owned') THEN
  RAISE EXCEPTION 'NEXUS_PRODUCT_IMPORT_STOCK_CONTEXT_REQUIRED' USING ERRCODE='23514';END IF;
 -- Existing canonical validation and atomic stock/ledger allocation remain
 -- the only creator. No client-supplied ledger, cost override or stock PATCH.
 result:=public.record_product_catalog(p_id,p_store,p_device,'product_catalog',jsonb_build_object('action','create','product',supplied,'unitCost',p_input->'unitCost'))
   ||jsonb_build_object('skipped',false);
 -- Only the row just created by the delegate is relabelled with this outer
 -- immutable request. A failed transaction rolls back both journals and stock.
 UPDATE financial_private.catalog_commands j SET request=jsonb_build_object('command',p_command,'input',p_input),result=
   (SELECT j2.result||jsonb_build_object('skipped',false) FROM financial_private.catalog_commands j2 WHERE j2.id=p_id) WHERE j.id=p_id;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.record_product_import(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_product_import(text,uuid,uuid,text,jsonb) TO authenticated;
