-- Forward-only features; no historical document or ledger backfill.
-- Depends on wholesale toggle, receipt validation and final_v1_financial_integrity.
CREATE TABLE financial_private.catalog_commands (
 id text PRIMARY KEY, store_id uuid NOT NULL REFERENCES public.stores(id),
 request jsonb NOT NULL, result jsonb NOT NULL
);
ALTER TABLE financial_private.catalog_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.catalog_commands FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.validate_bundle_definition(p_store uuid,p_bundle text,p_recipe jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path TO public,pg_temp AS $fn$
DECLARE c jsonb; p public.products; variant text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY','ACCOUNTANT']),false) THEN
  RAISE EXCEPTION 'غير مسموح بفحص مكونات متجر آخر' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_recipe) IS DISTINCT FROM 'array' OR jsonb_array_length(p_recipe)=0 THEN
  RAISE EXCEPTION 'يجب اختيار مكونات البوكس' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_recipe) i GROUP BY i->>'productId',coalesce(nullif(i->>'variantName',''),'') HAVING count(*)>1) THEN
  RAISE EXCEPTION 'مكونات البوكس مكررة' USING ERRCODE='23514'; END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(p_recipe) ORDER BY value->>'productId' LOOP
  IF c->>'quantity' IS NULL OR (c->>'quantity')::numeric::text IN ('NaN','Infinity','-Infinity')
   OR (c->>'quantity')::numeric<=0 OR (c->>'quantity')::numeric<>trunc((c->>'quantity')::numeric) THEN
   RAISE EXCEPTION 'كمية المكون يجب أن تكون عددًا صحيحًا موجبًا' USING ERRCODE='23514'; END IF;
  SELECT * INTO p FROM public.products WHERE id=c->>'productId' AND store_id=p_store FOR UPDATE;
  IF NOT FOUND OR p.id=p_bundle OR coalesce(p."isBundle",false) OR NOT coalesce(p."isActive",false) OR p.deleted_at IS NOT NULL THEN
   RAISE EXCEPTION 'مكون البوكس غير متاح أو لا يخص المتجر' USING ERRCODE='23514'; END IF;
  variant:=nullif(c->>'variantName','');
  IF (variant IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p.metadata->'variants','[]'::jsonb)) v WHERE v->>'name'=variant))
   OR (variant IS NULL AND jsonb_array_length(coalesce(p.metadata->'variants','[]'::jsonb))>0) THEN
   RAISE EXCEPTION 'اختر درجة صالحة لكل مكون في البوكس' USING ERRCODE='23514'; END IF;
 END LOOP;
END $fn$;
REVOKE ALL ON FUNCTION public.validate_bundle_definition(uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.validate_bundle_definition(uuid,text,jsonb) TO authenticated;

CREATE FUNCTION financial_private.check_bundle_definition() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF NEW."isBundle" AND NEW.deleted_at IS NULL THEN
  IF btrim(NEW.name)='' OR btrim(NEW.sku)='' OR NEW."unitPrice"::text IN ('NaN','Infinity','-Infinity')
   OR NEW."unitPrice"<=0 OR NEW."unitPrice"<>round(NEW."unitPrice",2) THEN
   RAISE EXCEPTION 'اسم البوكس والكود والسعر غير صالحة' USING ERRCODE='23514'; END IF;
  PERFORM public.validate_bundle_definition(NEW.store_id,NEW.id,NEW."bundleItems");
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.check_bundle_definition() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER nexus_bundle_definition BEFORE INSERT OR UPDATE OF "bundleItems","isBundle","unitPrice",name,sku
 ON public.products FOR EACH ROW EXECUTE FUNCTION financial_private.check_bundle_definition();

CREATE FUNCTION public.record_bundle_edit(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE p public.products; receipt financial_private.catalog_commands; patch jsonb:=p_input->'patch'; result jsonb;
 request jsonb:=jsonb_build_object('command',p_command,'input',p_input);
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false) THEN
  RAISE EXCEPTION 'غير مسموح بتعديل البوكس' USING ERRCODE='42501'; END IF;
 IF nullif(p_id,'') IS NULL OR p_device IS NULL OR p_command IS DISTINCT FROM 'bundle_edit' THEN
  RAISE EXCEPTION 'عملية تعديل البوكس غير صالحة' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('bundle-edit:'||p_id,0));
 SELECT * INTO receipt FROM financial_private.catalog_commands WHERE id=p_id;
 IF FOUND THEN
  IF receipt.store_id<>p_store OR receipt.request IS DISTINCT FROM request THEN
   RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN receipt.result||jsonb_build_object('replayed',true);
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('bundle-sku:'||p_store::text,0));
 SELECT * INTO p FROM public.products WHERE id=p_input->>'productId' AND store_id=p_store AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR NOT coalesce(p."isBundle",false) THEN RAISE EXCEPTION 'البوكس غير موجود في المتجر' USING ERRCODE='23514'; END IF;
 IF jsonb_build_object('name',p.name,'sku',p.sku,'unitPrice',p."unitPrice",'bundleItems',p."bundleItems",'updated_at',p.updated_at)
  IS DISTINCT FROM p_input->'before' THEN RAISE EXCEPTION 'تم تعديل البوكس في جلسة أخرى؛ أعد فتحه' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.products WHERE store_id=p_store AND id<>p.id AND deleted_at IS NULL AND lower(btrim(sku))=lower(btrim(patch->>'sku'))) THEN
  RAISE EXCEPTION 'SKU مستخدم لمنتج آخر' USING ERRCODE='23514'; END IF;
 IF nullif(btrim(patch->>'name'),'') IS NULL OR nullif(btrim(patch->>'sku'),'') IS NULL OR patch->>'unitPrice' IS NULL THEN
  RAISE EXCEPTION 'أكمل اسم البوكس والكود والسعر' USING ERRCODE='23514'; END IF;
 UPDATE public.products SET name=btrim(patch->>'name'),sku=btrim(patch->>'sku'),"unitPrice"=(patch->>'unitPrice')::numeric,
  wholesale_price=(patch->>'unitPrice')::numeric,"bundleItems"=patch->'bundleItems',updated_at=(extract(epoch FROM clock_timestamp())*1000)::bigint
  WHERE id=p.id AND store_id=p_store RETURNING * INTO p;
 result:=jsonb_build_object('product',to_jsonb(p),'replayed',false);
 INSERT INTO financial_private.catalog_commands VALUES(p_id,p_store,request,result);
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.record_bundle_edit(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_bundle_edit(text,uuid,uuid,text,jsonb) TO authenticated;

-- Expand SOLD units; an existing bundle keeps the recipe it reserved, even if
-- its catalogue definition was edited later. New bundles snapshot today's recipe.
-- Costs are subsequently derived inside record_order_edit from old reservations / ledger WAC.
CREATE FUNCTION public.order_edit_stock(p_store uuid,p_order jsonb,p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path TO public,pg_temp AS $fn$
DECLARE i jsonb; c jsonb; p public.products; old_sold jsonb; recipe jsonb; result jsonb:='[]'; q numeric;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'غير مسموح بتعديل الطلب' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)=0 THEN
  RAISE EXCEPTION 'يجب اختيار منتجات الطلب' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) x GROUP BY x->>'productId',coalesce(nullif(x->>'variantName',''),'') HAVING count(*)>1) THEN
  RAISE EXCEPTION 'بنود الطلب مكررة' USING ERRCODE='23514'; END IF;
 FOR i IN SELECT value FROM jsonb_array_elements(p_items) ORDER BY value->>'productId' LOOP
  q:=(i->>'quantity')::numeric;
  IF q IS NULL OR q::text IN ('NaN','Infinity','-Infinity') OR q<=0 OR q<>trunc(q) THEN
   RAISE EXCEPTION 'كمية الطلب يجب أن تكون عددًا صحيحًا موجبًا' USING ERRCODE='23514'; END IF;
  SELECT * INTO p FROM public.products WHERE id=i->>'productId' AND store_id=p_store FOR UPDATE;
  IF NOT FOUND OR p.deleted_at IS NOT NULL OR NOT coalesce(p."isActive",false) THEN
   RAISE EXCEPTION 'منتج غير متاح أو لا يخص المتجر' USING ERRCODE='23514'; END IF;
  IF coalesce(p."isBundle",false) THEN
   SELECT x INTO old_sold FROM jsonb_array_elements(p_order->'items') x WHERE x->>'productId'=p.id OR x->>'bundleId'=p.id;
   IF FOUND THEN
    SELECT jsonb_agg(jsonb_build_object('productId',x->>'productId','variantName',x->>'variantName','quantity',(x->>'quantity')::numeric/(old_sold->>'quantity')::numeric))
     INTO recipe FROM jsonb_array_elements(p_order->'stockItems') x WHERE x->>'bundleId'=p.id;
    IF recipe IS NULL THEN RAISE EXCEPTION 'وصفة حجز البوكس القديمة غير مكتملة؛ راجع الطلب' USING ERRCODE='23514'; END IF;
   ELSE recipe:=p."bundleItems"; END IF;
   PERFORM public.validate_bundle_definition(p_store,p.id,recipe);
   FOR c IN SELECT value FROM jsonb_array_elements(recipe) LOOP
    result:=result||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'productId',c->>'productId',
     'variantName',c->>'variantName','productName',(SELECT name FROM public.products WHERE id=c->>'productId' AND store_id=p_store),
     'quantity',(c->>'quantity')::numeric*q,'unitPrice',0,'bundleId',p.id,'bundleName',i->>'productName'));
   END LOOP;
  ELSE
   IF nullif(i->>'bundleId','') IS NOT NULL OR (nullif(i->>'variantName','') IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(coalesce(p.metadata->'variants','[]')) v WHERE v->>'name'=i->>'variantName'))
    OR (nullif(i->>'variantName','') IS NULL AND jsonb_array_length(coalesce(p.metadata->'variants','[]'))>0) THEN
    RAISE EXCEPTION 'درجة المنتج أو ربط البوكس غير صالح' USING ERRCODE='23514'; END IF;
   result:=result||jsonb_build_array(i-'unitCost');
  END IF;
 END LOOP;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.order_edit_stock(uuid,jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.order_edit_stock(uuid,jsonb,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_order_edit(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO public,pg_temp AS $function$
DECLARE o public.orders; v_old public.ledger_events; v_patch jsonb:=p_input->'patch';
  v_request jsonb:=jsonb_build_object('command',p_command,'input',p_input);
  v_expected_stock jsonb; v_lines jsonb; v_result jsonb; v_subject text; v_extra numeric; v_available numeric;
  v_goods numeric; v_discount numeric; v_total numeric; v_cogs numeric;
  v_old_qty numeric; v_new_qty numeric; v_old_value numeric; v_stock_value numeric; v_unit_cost numeric;
  v_now text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
    RAISE EXCEPTION 'NEXUS_ORDER_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF nullif(p_id,'') IS NULL OR p_device IS NULL OR p_command IS DISTINCT FROM 'order_edit' THEN
    RAISE EXCEPTION 'NEXUS_ORDER_EDIT_INVALID' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('order-edit:'||p_id,0));
  SELECT * INTO v_old FROM public.ledger_events WHERE id=p_id AND store_id=p_store;
  IF FOUND THEN
    IF v_old.command_request IS DISTINCT FROM v_request OR v_old.command_result IS NULL THEN
      RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514'; END IF;
    RETURN v_old.command_result||jsonb_build_object('replayed',true);
  END IF;
  -- Code before order: same lock order as discount reconciliation.
  PERFORM 1 FROM public.discount_codes d JOIN public.orders x ON x."discountCodeId"=d.id AND x.store_id=d.store_id
    WHERE x.id=p_input->>'orderId' AND x.store_id=p_store FOR UPDATE OF d;
  SELECT * INTO o FROM public.orders WHERE id=p_input->>'orderId' AND store_id=p_store AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR o.status<>'pending' THEN RAISE EXCEPTION 'NEXUS_ORDER_NOT_EDITABLE' USING ERRCODE='23514'; END IF;
  IF jsonb_build_object('items',o.items,'stockItems',o."stockItems",'totalAmount',o."totalAmount",'discountAmount',o."discountAmount",'depositAmount',o."depositAmount")
     IS DISTINCT FROM p_input->'before' THEN RAISE EXCEPTION 'NEXUS_ORDER_EDIT_STALE' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(v_patch->'items') IS DISTINCT FROM 'array' OR jsonb_typeof(v_patch->'stockItems') IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_patch->'items')=0 OR jsonb_array_length(v_patch->'stockItems')=0 THEN
    RAISE EXCEPTION 'NEXUS_ORDER_EDIT_INVALID' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements((v_patch->'items')||(v_patch->'stockItems')) i
    WHERE nullif(i->>'productId','') IS NULL OR (i->>'quantity') IS NULL OR (i->>'quantity')::numeric<=0
      OR (i->>'quantity')::numeric::text IN ('NaN','Infinity','-Infinity') OR (i->>'unitPrice') IS NULL
      OR (i->>'unitPrice')::numeric<>round((i->>'unitPrice')::numeric,2) OR (i->>'unitPrice')::numeric<0 OR (i->>'unitPrice')::numeric::text IN ('NaN','Infinity','-Infinity')
      OR coalesce((i->>'unitCost')::numeric,0)<0 OR coalesce((i->>'unitCost')::numeric,0)::text IN ('NaN','Infinity','-Infinity')) THEN
    RAISE EXCEPTION 'NEXUS_ORDER_EDIT_INVALID' USING ERRCODE='23514'; END IF;
  v_expected_stock:=public.order_edit_stock(p_store,to_jsonb(o),v_patch->'items');
  IF EXISTS(WITH supplied AS (
   SELECT i->>'productId' id,coalesce(nullif(i->>'variantName',''),'') variant,coalesce(nullif(i->>'bundleId',''),'') bundle,sum((i->>'quantity')::numeric) qty
    FROM jsonb_array_elements(v_patch->'stockItems') i GROUP BY 1,2,3
  ), expected AS (
   SELECT i->>'productId' id,coalesce(nullif(i->>'variantName',''),'') variant,coalesce(nullif(i->>'bundleId',''),'') bundle,sum((i->>'quantity')::numeric) qty
    FROM jsonb_array_elements(v_expected_stock) i GROUP BY 1,2,3
  ) SELECT 1 FROM supplied FULL JOIN expected USING(id,variant,bundle) WHERE supplied.qty IS DISTINCT FROM expected.qty) THEN
   RAISE EXCEPTION 'NEXUS_ORDER_EDIT_STOCK_MISMATCH' USING ERRCODE='23514'; END IF;
  v_patch:=jsonb_set(v_patch,'{stockItems}',v_expected_stock);
  SELECT round(sum((i->>'quantity')::numeric*(i->>'unitPrice')::numeric),2) INTO v_goods FROM jsonb_array_elements(v_patch->'items') i;
  v_discount:=coalesce((v_patch->>'discountAmount')::numeric,0);v_total:=v_goods-v_discount;
  IF v_discount::text IN ('NaN','Infinity','-Infinity') OR v_discount<0 OR v_discount>v_goods
     OR v_total IS DISTINCT FROM (v_patch->>'totalAmount')::numeric OR o."depositAmount">v_total+o."shippingFee"+o."wastedTripCompensation" THEN
    RAISE EXCEPTION 'NEXUS_ORDER_EDIT_TOTAL' USING ERRCODE='23514'; END IF;
  -- Snapshot retained units at their original reservation cost. Additional
  -- units use the current ledger WAC. The browser cannot reprice inventory by
  -- changing a hidden unitCost; blend the resulting reservation on the server.
  FOR v_subject IN SELECT DISTINCT i->>'productId' FROM jsonb_array_elements((coalesce(o."stockItems",'[]'::jsonb))||(v_patch->'stockItems')) i ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('pos-stock:'||p_store::text||':'||v_subject,0));
    IF NOT EXISTS(SELECT 1 FROM public.products WHERE id=v_subject AND store_id=p_store) THEN
      RAISE EXCEPTION 'NEXUS_ORDER_PRODUCT_INVALID' USING ERRCODE='23514'; END IF;
    SELECT coalesce(sum((i->>'quantity')::numeric),0),coalesce(sum((i->>'quantity')::numeric*coalesce((i->>'unitCost')::numeric,0)),0)
      INTO v_old_qty,v_old_value FROM jsonb_array_elements(o."stockItems") i WHERE i->>'productId'=v_subject;
    SELECT coalesce(sum((i->>'quantity')::numeric),0) INTO v_new_qty FROM jsonb_array_elements(v_patch->'stockItems') i WHERE i->>'productId'=v_subject;
    SELECT coalesce(sum(qty_delta),0),coalesce(sum(amount_delta),0)/100 INTO v_available,v_stock_value FROM public.ledger_lines WHERE store_id=p_store AND account='stock' AND subject_id=v_subject;
    IF v_new_qty>v_old_qty+v_available THEN RAISE EXCEPTION 'NEXUS_STOCK_SHORT' USING ERRCODE='23514'; END IF;
    IF v_new_qty>0 THEN
      v_unit_cost:=CASE WHEN v_new_qty<=v_old_qty THEN v_old_value/v_old_qty
        ELSE (v_old_value+(v_new_qty-v_old_qty)*coalesce(v_stock_value/nullif(v_available,0),0))/v_new_qty END;
      SELECT jsonb_agg(CASE WHEN i->>'productId'=v_subject THEN jsonb_set(i,'{unitCost}',to_jsonb(v_unit_cost)) ELSE i END)
        INTO v_lines FROM jsonb_array_elements(v_patch->'stockItems') i;
      v_patch:=jsonb_set(v_patch,'{stockItems}',v_lines);
    END IF;
  END LOOP;
  WITH movements AS (
    SELECT i->>'productId' subject,(i->>'quantity')::numeric qty,coalesce((i->>'unitCost')::numeric,0)*(i->>'quantity')::numeric amount FROM jsonb_array_elements(o."stockItems") i
    UNION ALL SELECT i->>'productId',-(i->>'quantity')::numeric,-coalesce((i->>'unitCost')::numeric,0)*(i->>'quantity')::numeric FROM jsonb_array_elements(v_patch->'stockItems') i
  ) SELECT jsonb_agg(jsonb_build_object('id',gen_random_uuid()::text,'account','stock','subject_id',subject,'qty_delta',qty,'amount_delta',round(amount*100)))
    INTO v_lines FROM (SELECT subject,sum(qty) qty,sum(amount) amount FROM movements GROUP BY subject HAVING sum(qty)<>0) t;
  v_lines:=coalesce(v_lines,'[]'::jsonb);
  FOR v_subject IN SELECT l->>'subject_id' FROM jsonb_array_elements(v_lines) l ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('pos-stock:'||p_store::text||':'||v_subject,0));
    SELECT coalesce(sum(qty_delta),0) INTO v_available FROM public.ledger_lines WHERE store_id=p_store AND account='stock' AND subject_id=v_subject;
    SELECT sum((l->>'qty_delta')::numeric) INTO v_extra FROM jsonb_array_elements(v_lines) l WHERE l->>'subject_id'=v_subject;
    IF v_available+v_extra<0 THEN RAISE EXCEPTION 'NEXUS_STOCK_SHORT' USING ERRCODE='23514'; END IF;
  END LOOP;
  SELECT sum((i->>'quantity')::numeric*coalesce((i->>'unitCost')::numeric,0)) INTO v_cogs FROM jsonb_array_elements(v_patch->'stockItems') i;
  UPDATE public.orders SET items=v_patch->'items',"stockItems"=v_patch->'stockItems',"discountAmount"=v_discount,"totalAmount"=v_total,"cogsAmount"=v_cogs,
    "expectedCod"=v_total+"shippingFee"+"wastedTripCompensation"-"depositAmount","updatedAt"=now(),updated_at=(extract(epoch FROM now())*1000)::bigint WHERE id=o.id AND store_id=p_store RETURNING * INTO o;
  IF o."discountCodeId" IS NOT NULL THEN PERFORM public.reconcile_discount_order(p_store,o."discountCodeId",o.id); END IF;
  v_result:=jsonb_build_object('eventId',p_id,'order',to_jsonb(o),'replayed',false);
  PERFORM public.ledger_append(jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'kind','order_edited','ref_type','ecommerce_order','ref_id',o."orderNumber",
    'occurred_at',v_now,'created_at',v_now,'payload',jsonb_build_object('before',p_input->'before','after',v_patch)::text,'lines',v_lines,'command_request',v_request,'command_result',v_result));
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_order_edit(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_order_edit(text,uuid,uuid,text,jsonb) TO authenticated;

-- Selected original units are reserved here, separately from replacement stock.
-- This is a workflow document, not a second ledger: all money/stock is still
-- booked through ledger_append with the existing accounts and event kinds.
ALTER TABLE public.orders ADD COLUMN "exchangeDetails" jsonb;
CREATE TABLE financial_private.order_exchanges (
 id text PRIMARY KEY, store_id uuid NOT NULL REFERENCES public.stores(id),
 original_id text NOT NULL REFERENCES public.orders(id), replacement_id text NOT NULL UNIQUE,
 status text NOT NULL CHECK(status IN ('pending','confirmed','cancelled')),
 selections jsonb NOT NULL, details jsonb NOT NULL,
 confirmation_event_id text UNIQUE,
 placement_request jsonb NOT NULL, placement_result jsonb,
 confirmation_request jsonb, confirmation_result jsonb
);
CREATE INDEX order_exchanges_original ON financial_private.order_exchanges(store_id,original_id);
ALTER TABLE financial_private.order_exchanges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.order_exchanges FROM PUBLIC,anon,authenticated;

-- Original sold-line IDs and individual unit numbers survive catalogue edits.
-- Integer allocation at each unit boundary preserves every last piastre over
-- multiple partial exchanges, including cancelled reservations and retries.
CREATE FUNCTION financial_private.exchange_selection(p_store uuid,o public.orders,p_selected jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE s jsonb; sold jsonb; component jsonb; line_id text; product_id text; variant text; bundle text;
 q int; requested int; claimed jsonb; slots jsonb; unit_no int; legacy numeric; old_refund numeric;
 gross numeric; prefix numeric; line_gross numeric; line_net numeric; refund numeric; per numeric; total_cost numeric;
 parts jsonb; selection jsonb; result jsonb:='[]';
BEGIN
 IF jsonb_typeof(p_selected) IS DISTINCT FROM 'array' OR jsonb_array_length(p_selected)=0 THEN
  RAISE EXCEPTION 'حدد الوحدات الأصلية المطلوب استبدالها' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(o.items) WITH ORDINALITY t(x,n) GROUP BY coalesce(nullif(x->>'id',''),'line:'||n::text) HAVING count(*)>1) THEN
  RAISE EXCEPTION 'هويات بنود الطلب القديم مكررة؛ يلزم مراجعة' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_selected) x GROUP BY x->>'lineId' HAVING count(*)>1) THEN
  RAISE EXCEPTION 'وحدات الاستبدال مكررة' USING ERRCODE='23514'; END IF;
 SELECT sum((x->>'quantity')::numeric*(x->>'unitPrice')::numeric) INTO gross FROM jsonb_array_elements(o.items) x;
 IF gross IS NULL OR gross<0 OR gross::text IN ('NaN','Infinity','-Infinity') OR o."totalAmount"<0 OR o."totalAmount">gross THEN
  RAISE EXCEPTION 'أسعار الطلب القديم تحتاج مراجعة قبل الاستبدال' USING ERRCODE='23514'; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p_selected) LOOP
  line_id:=s->>'lineId';requested:=(s->>'quantity')::numeric;
  IF line_id IS NULL OR s->>'quantity' IS NULL OR (s->>'quantity')::numeric::text IN ('NaN','Infinity','-Infinity')
   OR requested<=0 OR requested<>(s->>'quantity')::numeric THEN
   RAISE EXCEPTION 'كمية الاستبدال غير صالحة' USING ERRCODE='23514'; END IF;
  SELECT x INTO sold FROM jsonb_array_elements(o.items) WITH ORDINALITY t(x,n) WHERE coalesce(nullif(x->>'id',''),'line:'||n::text)=line_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'البند الأصلي غير موجود في الطلب' USING ERRCODE='23514'; END IF;
  q:=(sold->>'quantity')::numeric;
  IF q<=0 OR q<>(sold->>'quantity')::numeric THEN RAISE EXCEPTION 'كمية الطلب القديم تحتاج مراجعة' USING ERRCODE='23514'; END IF;
  product_id:=coalesce(nullif(sold->>'bundleId',''),sold->>'productId');variant:=coalesce(nullif(sold->>'variantName',''),'');
  bundle:=nullif(sold->>'bundleId','');
  IF (SELECT count(*) FROM jsonb_array_elements(o.items) x WHERE coalesce(nullif(x->>'bundleId',''),x->>'productId')=product_id
   AND coalesce(nullif(x->>'variantName',''),'')=variant)>1 THEN
   RAISE EXCEPTION 'البنود القديمة المتكررة تحتاج مراجعة لتحديد الوحدة الأصلية' USING ERRCODE='23514'; END IF;
  -- Price-weighted prefix, not a quantity-weighted discount allocation.
  SELECT coalesce(sum((x->>'quantity')::numeric*(x->>'unitPrice')::numeric),0) INTO prefix
   FROM jsonb_array_elements(o.items) WITH ORDINALITY t(x,n)
   WHERE n<(SELECT n FROM jsonb_array_elements(o.items) WITH ORDINALITY t2(y,n) WHERE coalesce(nullif(y->>'id',''),'line:'||n::text)=line_id);
  line_gross:=q*(sold->>'unitPrice')::numeric;
  line_net:=CASE WHEN gross=0 THEN 0 ELSE round((prefix+line_gross)*o."totalAmount"*100/gross)-round(prefix*o."totalAmount"*100/gross) END;
  -- Old ordinary returns remain authoritative; never rewrite their records.
  -- New exchange records are excluded because the private unit reservations
  -- below already count them, once.
  SELECT coalesce(sum((i->>'quantity')::numeric),0) INTO legacy
   FROM public.return_records r CROSS JOIN LATERAL jsonb_array_elements(r.returned_items) i
   WHERE r.store_id=p_store AND r.original_order_id=o.id AND r.deleted_at IS NULL AND r.id NOT LIKE 'exchange:%'
    AND i->>'product_id'=product_id
    AND coalesce(i->>'variantName','')=variant;
  IF legacy<>trunc(legacy) OR legacy<0 OR legacy>q THEN RAISE EXCEPTION 'سجل المرتجعات القديم يحتاج مراجعة' USING ERRCODE='23514'; END IF;
  SELECT coalesce(jsonb_agg(n),'[]') INTO claimed FROM financial_private.order_exchanges e
   CROSS JOIN LATERAL jsonb_array_elements(e.selections) i CROSS JOIN LATERAL jsonb_array_elements(i->'unitNumbers') n
   WHERE e.store_id=p_store AND e.original_id=o.id AND e.status IN ('pending','confirmed') AND i->>'lineId'=line_id;
  slots:='[]';refund:=0;
  FOR unit_no IN 1..q LOOP
   IF unit_no<=legacy OR claimed @> jsonb_build_array(unit_no) THEN CONTINUE; END IF;
   EXIT WHEN jsonb_array_length(slots)>=requested;
   slots:=slots||jsonb_build_array(unit_no);
   refund:=refund+round(unit_no*line_net/q)-round((unit_no-1)*line_net/q);
  END LOOP;
  IF jsonb_array_length(slots)<>requested THEN RAISE EXCEPTION 'الكمية محجوزة لاستبدال آخر أو سبق إرجاعها' USING ERRCODE='23514'; END IF;
  parts:='[]';
  FOR component IN SELECT x FROM jsonb_array_elements(o."stockItems") x
   WHERE (bundle IS NOT NULL AND x->>'bundleId'=bundle) OR
    (bundle IS NULL AND nullif(x->>'bundleId','') IS NULL AND x->>'productId'=product_id AND coalesce(nullif(x->>'variantName',''),'')=variant) LOOP
   per:=(component->>'quantity')::numeric/q;
   IF per<=0 OR per<>trunc(per) OR (bundle IS NULL AND per<>1) OR coalesce((component->>'unitCost')::numeric,0)::text IN ('NaN','Infinity','-Infinity') OR coalesce((component->>'unitCost')::numeric,0)<0 THEN
    RAISE EXCEPTION 'تكلفة أو وصفة الحجز الأصلية تحتاج مراجعة' USING ERRCODE='23514'; END IF;
   total_cost:=round((component->>'quantity')::numeric*coalesce((component->>'unitCost')::numeric,0)*100);
   SELECT coalesce(sum(round((n::text)::numeric*total_cost/q)-round(((n::text)::numeric-1)*total_cost/q)),0) INTO old_refund FROM jsonb_array_elements(slots) n;
   parts:=parts||jsonb_build_array(jsonb_build_object('productId',component->>'productId','variantName',component->>'variantName',
    'quantity',per*requested,'costPiastres',old_refund));
  END LOOP;
  IF jsonb_array_length(parts)=0 THEN RAISE EXCEPTION 'حجز مخزون الطلب الأصلي غير مكتمل' USING ERRCODE='23514'; END IF;
  selection:=jsonb_build_object('lineId',line_id,'productId',product_id,'productName',sold->>'productName','variantName',nullif(variant,''),
   'quantity',requested,'unitNumbers',slots,'refundPiastres',refund,'parts',parts);
  result:=result||jsonb_build_array(selection);
 END LOOP;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.exchange_selection(uuid,public.orders,jsonb) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.record_exchange_place(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE o public.orders; e financial_private.order_exchanges; request jsonb:=jsonb_build_object('command',p_command,'input',p_input);
 replacement jsonb:=p_input->'order'; event jsonb:=p_input->'event'; selected jsonb; v_details jsonb; stock jsonb;
 lines jsonb:='[]'; result jsonb; subject text; quantity numeric; available numeric; value numeric; cost numeric;
 money_field text; source_subject text;
 cause text:=p_input->>'cause'; now_text text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'غير مسموح بإنشاء استبدال' USING ERRCODE='42501'; END IF;
 IF nullif(p_id,'') IS NULL OR p_device IS NULL OR p_command IS DISTINCT FROM 'exchange_place'
  OR (replacement->>'store_id')::uuid IS DISTINCT FROM p_store OR (replacement->>'device_id')::uuid IS DISTINCT FROM p_device OR nullif(replacement->>'wholesaleClientId','') IS NOT NULL THEN
  RAISE EXCEPTION 'عملية الاستبدال غير صالحة' USING ERRCODE='23514'; END IF;
 IF cause IS NULL OR cause NOT IN ('customer','shop','courier') THEN RAISE EXCEPTION 'اختر سبب الاستبدال' USING ERRCODE='23514'; END IF;
 IF cause<>'customer' AND NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false) THEN
  RAISE EXCEPTION 'تحديد مسؤولية المتجر أو المندوب للمدير أو المحاسب فقط' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('exchange-operation:'||p_id,0));
 SELECT * INTO e FROM financial_private.order_exchanges WHERE id=p_id;
 IF FOUND THEN
  IF e.store_id<>p_store OR e.placement_request IS DISTINCT FROM request THEN RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN e.placement_result||jsonb_build_object('replayed',true);
 END IF;
 -- Discount locks precede order and stock locks in all candidate commands.
 PERFORM 1 FROM public.discount_codes WHERE store_id=p_store AND id=replacement->>'discountCodeId' FOR UPDATE;
 SELECT * INTO o FROM public.orders WHERE id=p_input->>'originalOrderId' AND store_id=p_store AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR o.status<>'delivered' OR o."returnConfirmedAt" IS NOT NULL OR o."wholesaleClientId" IS NOT NULL THEN
  RAISE EXCEPTION 'الاستبدال متاح لطلب تجزئة مسلم ولم يرجع بالكامل' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ledger_events WHERE store_id=p_store AND ref_type='ecommerce_order' AND ref_id=o."orderNumber" AND kind='order_delivered') THEN
  RAISE EXCEPTION 'لا توجد حركة تسليم أصلية مؤكدة لهذا الطلب' USING ERRCODE='23514'; END IF;
 -- Compare the editable document to the immutable delivery before valuing returns.
 IF (SELECT count(*) FROM public.ledger_events WHERE store_id=p_store AND ref_type='ecommerce_order' AND ref_id=o."orderNumber" AND kind='order_delivered')<>1
  OR (SELECT coalesce(sum(l.amount_delta),0) FROM public.ledger_lines l JOIN public.ledger_events x ON x.id=l.event_id WHERE x.store_id=p_store AND x.ref_type='ecommerce_order' AND x.ref_id=o."orderNumber" AND x.kind='order_delivered' AND l.account='revenue' AND l.subject_id='ecommerce')<>round(o."totalAmount"*100) THEN
  RAISE EXCEPTION 'قيمة مستند الطلب القديم لا تطابق التسليم؛ يلزم مراجعة بدون تعديل التاريخ' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.ledger_lines l JOIN public.ledger_events x ON x.id=l.event_id
  WHERE x.store_id=p_store AND x.ref_type='ecommerce_order' AND x.ref_id=o."orderNumber" AND x.kind='order_delivered'
   AND l.account='customer_ltv' AND l.subject_id IS DISTINCT FROM o."customerId") THEN
  RAISE EXCEPTION 'هوية العميل لا تطابق حركة التسليم الأصلية؛ يلزم مراجعة' USING ERRCODE='23514'; END IF;
 -- Old partial-return failures could leave an event without its return record.
 -- There is no safe way to allocate original unit numbers from that evidence.
 IF EXISTS(SELECT 1 FROM public.ledger_events x WHERE x.store_id=p_store AND x.ref_type='ecommerce_order'
   AND x.ref_id=o."orderNumber" AND x.kind='return_confirmed') THEN
  RAISE EXCEPTION 'يوجد مرتجع قديم بدون ترقيم وحدات الاستبدال؛ يلزم مراجعة تاريخية قبل استبدال جديد' USING ERRCODE='23514'; END IF;
 FOR source_subject IN SELECT DISTINCT x->>'productId' FROM jsonb_array_elements(o."stockItems") x LOOP
  IF (SELECT coalesce(sum(l.amount_delta),0) FROM public.ledger_lines l JOIN public.ledger_events x ON x.id=l.event_id WHERE x.store_id=p_store AND x.ref_type='ecommerce_order' AND x.ref_id=o."orderNumber" AND x.kind='order_delivered' AND l.account='cogs' AND l.subject_id=source_subject)
   <> (SELECT sum(round((x->>'quantity')::numeric*coalesce((x->>'unitCost')::numeric,0)*100)) FROM jsonb_array_elements(o."stockItems") x WHERE x->>'productId'=source_subject) THEN
   RAISE EXCEPTION 'تكلفة مستند الطلب القديم لا تطابق حركة التسليم؛ يلزم مراجعة' USING ERRCODE='23514'; END IF;
 END LOOP;
 -- Quantities must match the immutable original reservation, including edits.
 -- Matching COGS value alone would allow quantity/cost drift to preserve value.
 IF EXISTS(
  SELECT 1 FROM (
   SELECT x->>'productId' subject,sum((x->>'quantity')::numeric) q FROM jsonb_array_elements(o."stockItems") x GROUP BY 1
  ) d FULL JOIN (
   SELECT l.subject_id subject,-sum(l.qty_delta) q FROM public.ledger_lines l JOIN public.ledger_events x ON x.id=l.event_id
   WHERE x.store_id=p_store AND x.ref_type='ecommerce_order' AND x.ref_id=o."orderNumber" AND x.kind IN ('order_placed','order_edited') AND l.account='stock' GROUP BY 1
  ) h USING(subject) WHERE coalesce(d.q,0)<>coalesce(h.q,0)
 ) THEN RAISE EXCEPTION 'كمية حجز الطلب القديم لا تطابق المخزون التاريخي؛ يلزم مراجعة' USING ERRCODE='23514'; END IF;
 FOR money_field IN SELECT unnest(ARRAY['totalAmount','shippingFee','depositAmount','expectedCod','discountAmount','courierFee','wastedTripCompensation']) LOOP
  value:=coalesce((replacement->>money_field)::numeric,0);
  IF value::text IN ('NaN','Infinity','-Infinity') OR value<0 OR value<>round(value,2) THEN RAISE EXCEPTION 'قيمة مالية غير صالحة في بديل الاستبدال' USING ERRCODE='23514'; END IF;
 END LOOP;
 SELECT jsonb_agg(CASE WHEN nullif(x->>'bundleId','') IS NOT NULL THEN jsonb_set(x,'{productId}',to_jsonb(x->>'bundleId')) ELSE x END) INTO stock FROM jsonb_array_elements(replacement->'items') x;
 replacement:=jsonb_set(replacement,'{items}',stock);
 selected:=financial_private.exchange_selection(p_store,o,p_input->'selections');
 stock:=public.order_edit_stock(p_store,jsonb_build_object('items','[]'::jsonb,'stockItems','[]'::jsonb),replacement->'items');
 FOR subject IN SELECT DISTINCT x->>'productId' FROM jsonb_array_elements(stock) x ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-stock:'||p_store::text||':'||subject,0));
  SELECT coalesce(sum(qty_delta),0),coalesce(sum(amount_delta),0) INTO available,value FROM public.ledger_lines WHERE store_id=p_store AND account='stock' AND subject_id=subject;
  SELECT sum((x->>'quantity')::numeric) INTO quantity FROM jsonb_array_elements(stock) x WHERE x->>'productId'=subject;
  IF quantity>available THEN RAISE EXCEPTION 'المخزون غير كافٍ لحجز بديل الاستبدال' USING ERRCODE='23514'; END IF;
  cost:=coalesce(value/nullif(available,0),0)/100;
  SELECT jsonb_agg(CASE WHEN x->>'productId'=subject THEN jsonb_set(x,'{unitCost}',to_jsonb(cost)) ELSE x END) INTO stock FROM jsonb_array_elements(stock) x;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',gen_random_uuid()::text,'account','stock','subject_id',x->>'productId',
  'qty_delta',-(x->>'quantity')::numeric,'amount_delta',-round((x->>'quantity')::numeric*(x->>'unitCost')::numeric*100))),'[]') INTO lines FROM jsonb_array_elements(stock) x;
 IF coalesce((replacement->>'depositAmount')::numeric,0)>0 THEN
  lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','wallet','subject_id',replacement->>'depositWallet','qty_delta',0,'amount_delta',round((replacement->>'depositAmount')::numeric*100)));
 END IF;
 SELECT jsonb_build_object('id',p_id,'originalOrderId',o.id,'originalOrderNumber',o."orderNumber",'status','pending','cause',cause,
  'refundPiastres',sum((x->>'refundPiastres')::numeric),'selections',jsonb_agg(x-'parts')) INTO v_details FROM jsonb_array_elements(selected) x;
 replacement:=replacement||jsonb_build_object('isExchange',true,'original_order_id',o.id,'exchangeDetails',v_details,'status','pending',
  'customerId',o."customerId",'customerName',o."customerName",'customerPhone',o."customerPhone",'stockItems',stock,
  'cogsAmount',(SELECT sum((x->>'quantity')::numeric*(x->>'unitCost')::numeric) FROM jsonb_array_elements(stock) x));
 IF cause<>'customer' AND (replacement->>'shippingFee')::numeric<>0 THEN
  RAISE EXCEPTION 'تكلفة استبدال بسبب المتجر أو المندوب لا تحمل على العميل' USING ERRCODE='23514'; END IF;
 INSERT INTO financial_private.order_exchanges(id,store_id,original_id,replacement_id,status,selections,details,placement_request)
  VALUES(p_id,p_store,o.id,replacement->>'id','pending',selected,v_details,request);
 event:=event||jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'kind','order_placed','ref_type','ecommerce_order',
  'ref_id',replacement->>'orderNumber','created_at',now_text,'occurred_at',now_text,'lines',lines,
  'payload',jsonb_build_object('movement','exchange','originalOrderId',o.id,'exchangeId',p_id)::text);
 result:=public.place_order(replacement,event);
 IF coalesce((result->>'replayed')::boolean,false) THEN RAISE EXCEPTION 'رقم البديل مستخدم؛ أعد فتح الطلب' USING ERRCODE='23514'; END IF;
 UPDATE financial_private.order_exchanges SET placement_result=result WHERE id=p_id;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.record_exchange_place(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_exchange_place(text,uuid,uuid,text,jsonb) TO authenticated;

CREATE FUNCTION public.record_exchange_return(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE e financial_private.order_exchanges; o public.orders; replacement public.orders; selected jsonb; part jsonb;
 request jsonb:=jsonb_build_object('command',p_command,'input',p_input); result jsonb; v_details jsonb; lines jsonb:='[]';
 refund numeric; fee numeric:=coalesce((p_input->>'returnFee')::numeric,0); refund_via text:=p_input->>'refundVia';
 subject text; amount numeric; quantity numeric; now_text text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'غير مسموح بتأكيد استلام وحدات الاستبدال' USING ERRCODE='42501'; END IF;
 IF nullif(p_id,'') IS NULL OR p_device IS NULL OR p_command IS DISTINCT FROM 'exchange_return' THEN
  RAISE EXCEPTION 'عملية تأكيد الاستبدال غير صالحة' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('exchange-operation:'||p_id,0));
 SELECT * INTO e FROM financial_private.order_exchanges WHERE store_id=p_store AND id=p_input->>'exchangeId';
 IF NOT FOUND THEN RAISE EXCEPTION 'عملية الاستبدال غير موجودة في المتجر' USING ERRCODE='23514'; END IF;
 -- Original before replacement: every exchange shares this serialization point.
 SELECT * INTO o FROM public.orders WHERE id=e.original_id AND store_id=p_store FOR UPDATE;
 SELECT * INTO replacement FROM public.orders WHERE id=e.replacement_id AND store_id=p_store FOR UPDATE;
 SELECT * INTO e FROM financial_private.order_exchanges WHERE id=e.id FOR UPDATE;
 IF e.status='confirmed' THEN
  IF e.confirmation_event_id<>p_id OR e.confirmation_request IS DISTINCT FROM request THEN
   RAISE EXCEPTION 'تم تأكيد الاستبدال بالفعل؛ حدّث الشاشة' USING ERRCODE='23514'; END IF;
  RETURN e.confirmation_result||jsonb_build_object('replayed',true);
 END IF;
 IF e.status<>'pending' OR replacement.status IN ('cancelled','returned') OR o.status<>'delivered' OR o."returnConfirmedAt" IS NOT NULL THEN
  RAISE EXCEPTION 'الاستبدال ملغي أو لا يمكن تأكيد استلامه' USING ERRCODE='23514'; END IF;
 IF fee::text IN ('NaN','Infinity','-Infinity') OR fee<0 OR fee<>round(fee,2) OR refund_via IS NULL OR refund_via NOT IN ('wallet','courier') THEN
  RAISE EXCEPTION 'بيانات رد المبلغ أو تكلفة رحلة الرجوع غير صالحة' USING ERRCODE='23514'; END IF;
 IF e.details->>'cause'<>'customer' AND NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false) THEN
  RAISE EXCEPTION 'تأكيد مسؤولية المتجر أو المندوب للمدير أو المحاسب فقط' USING ERRCODE='42501'; END IF;
 SELECT sum((x->>'refundPiastres')::numeric) INTO refund FROM jsonb_array_elements(e.selections) x;
 FOR subject IN SELECT DISTINCT c->>'productId' FROM jsonb_array_elements(e.selections) s CROSS JOIN LATERAL jsonb_array_elements(s->'parts') c ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-stock:'||p_store::text||':'||subject,0));
  SELECT sum((c->>'quantity')::numeric),sum((c->>'costPiastres')::numeric) INTO quantity,amount
   FROM jsonb_array_elements(e.selections) s CROSS JOIN LATERAL jsonb_array_elements(s->'parts') c WHERE c->>'productId'=subject;
  lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','stock','subject_id',subject,'qty_delta',quantity,'amount_delta',amount),
   jsonb_build_object('id',gen_random_uuid()::text,'account','cogs','subject_id',subject,'qty_delta',0,'amount_delta',-amount));
 END LOOP;
 lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','revenue','subject_id','ecommerce','qty_delta',0,'amount_delta',-refund));
 IF o."customerId" IS NOT NULL THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','customer_ltv','subject_id',o."customerId",'qty_delta',0,'amount_delta',-refund)); END IF;
 IF refund_via='wallet' THEN
  subject:=p_input->>'wallet';
  IF subject IS NULL OR lower(subject) NOT IN ('instoresafe','vodafonecash','instapay','bankaccount') THEN RAISE EXCEPTION 'اختر خزينة صالحة لرد المبلغ' USING ERRCODE='23514'; END IF;
  IF refund>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','wallet','subject_id',subject,'qty_delta',0,'amount_delta',-refund)); END IF;
 ELSE
  subject:=replacement."courierId";
  IF subject IS NULL OR NOT EXISTS(SELECT 1 FROM public.couriers WHERE store_id=p_store AND id=subject AND deleted_at IS NULL) THEN
   RAISE EXCEPTION 'اختر شركة شحن صالحة لرد مبلغ الاستبدال' USING ERRCODE='23514'; END IF;
  IF refund>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','receivable_courier','subject_id',subject,'qty_delta',0,'amount_delta',-refund)); END IF;
 END IF;
 IF fee>0 THEN
  IF replacement."courierId" IS NULL THEN RAISE EXCEPTION 'تكلفة رحلة الرجوع تتطلب شركة شحن' USING ERRCODE='23514'; END IF;
  lines:=lines||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','payable_courier','subject_id',replacement."courierId",'qty_delta',0,'amount_delta',round(fee*100)),
   jsonb_build_object('id',gen_random_uuid()::text,'account',CASE WHEN e.details->>'cause'<>'shop' THEN 'receivable_courier' ELSE 'expense' END,
    'subject_id',CASE WHEN e.details->>'cause'<>'shop' THEN replacement."courierId" ELSE 'shipping_exchange' END,'qty_delta',0,'amount_delta',round(fee*100)));
 END IF;
 v_details:=e.details||jsonb_build_object('status','confirmed','confirmationEventId',p_id,'refundVia',refund_via,'returnFee',fee,'confirmedAt',now_text);
 UPDATE financial_private.order_exchanges SET status='confirmed',details=v_details,confirmation_event_id=p_id,confirmation_request=request WHERE id=e.id;
 UPDATE public.orders SET "exchangeDetails"=v_details,"updatedAt"=now(),updated_at=(extract(epoch FROM clock_timestamp())*1000)::bigint WHERE id=replacement.id RETURNING * INTO replacement;
 INSERT INTO public.return_records(id,store_id,device_id,original_order_id,type,customer_name,customer_phone,governorate,returned_items,
  exchanged_item,financial_difference,processed_by,created_at,return_cause)
 SELECT 'exchange:'||e.id,p_store,p_device,o.id,'exchange',o."customerName",o."customerPhone",coalesce(o.governorate,''),
  (SELECT jsonb_agg(jsonb_build_object('lineId',x->>'lineId','product_id',x->>'productId','product_name',x->>'productName','variantName',x->>'variantName','quantity',(x->>'quantity')::numeric,'unit_price',(x->>'refundPiastres')::numeric/100/(x->>'quantity')::numeric)) FROM jsonb_array_elements(e.selections) x),
  (SELECT jsonb_agg(jsonb_build_object('product_id',coalesce(nullif(x->>'bundleId',''),x->>'productId'),'product_name',x->>'productName','quantity',x->'quantity','price',x->'unitPrice')) FROM jsonb_array_elements(replacement.items) x),
  replacement."totalAmount"-refund/100,'استبدال إلكتروني',now(),e.details->>'cause';
 result:=jsonb_build_object('order',to_jsonb(replacement),'eventId',p_id,'refundPiastres',refund,'replayed',false,'affectedProductIds',
  (SELECT jsonb_agg(DISTINCT c->>'productId') FROM jsonb_array_elements(e.selections) x CROSS JOIN LATERAL jsonb_array_elements(x->'parts') c));
 UPDATE financial_private.order_exchanges SET confirmation_result=result WHERE id=e.id;
 PERFORM public.ledger_append(jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'kind','return_confirmed','ref_type','ecommerce_exchange','ref_id',o."orderNumber",
  'occurred_at',now_text,'created_at',now_text,'lines',lines,'payload',jsonb_build_object('movement','exchange','exchangeId',e.id,'originalOrderId',o.id,'replacementOrderId',replacement.id,'return_cause',e.details->>'cause','refundVia',refund_via,'selections',v_details->'selections')::text,
  'command_request',request,'command_result',result));
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.record_exchange_return(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_exchange_return(text,uuid,uuid,text,jsonb) TO authenticated;

-- Preserve new workflow fields against ordinary upserts and release unreceived
-- original-unit claims when a replacement is cancelled. The private snapshot
-- is retained forever; cancellation does not erase evidence or return money.
CREATE FUNCTION financial_private.guard_exchange_document() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE e financial_private.order_exchanges;
BEGIN
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM financial_private.order_exchanges WHERE store_id=OLD.store_id AND original_id=OLD.id AND status IN ('pending','confirmed'))
  AND (NEW.items IS DISTINCT FROM OLD.items OR NEW."stockItems" IS DISTINCT FROM OLD."stockItems"
   OR NEW."totalAmount" IS DISTINCT FROM OLD."totalAmount" OR NEW."discountAmount" IS DISTINCT FROM OLD."discountAmount"
   OR NEW."depositAmount" IS DISTINCT FROM OLD."depositAmount" OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
   OR NEW."orderNumber" IS DISTINCT FROM OLD."orderNumber" OR NEW.store_id IS DISTINCT FROM OLD.store_id) THEN
  RAISE EXCEPTION 'بنود وهوية الطلب الأصلي محفوظة لوحدات الاستبدال ولا يمكن تغييرها' USING ERRCODE='23514'; END IF;
 SELECT * INTO e FROM financial_private.order_exchanges WHERE store_id=NEW.store_id AND replacement_id=NEW.id;
 IF FOUND THEN
  IF TG_OP='UPDATE' AND (NEW.status='cancelled' OR (NEW.status='returned' AND NEW."returnConfirmedAt" IS NOT NULL)) AND e.status='pending' THEN
   UPDATE financial_private.order_exchanges SET status='cancelled',details=details||jsonb_build_object('status','cancelled') WHERE id=e.id RETURNING * INTO e;
   NEW."exchangeDetails":=e.details;
  END IF;
  IF NEW."exchangeDetails" IS DISTINCT FROM e.details OR NEW.original_order_id IS DISTINCT FROM e.original_id OR NOT NEW."isExchange" THEN
   RAISE EXCEPTION 'تفاصيل الاستبدال محفوظة بأمر مالي مستقل ولا يمكن تغييرها يدويًا' USING ERRCODE='23514'; END IF;
 ELSIF NEW."exchangeDetails" IS NOT NULL THEN RAISE EXCEPTION 'مرجع الاستبدال غير صالح' USING ERRCODE='23514'; END IF;
 IF NEW.status<>'delivered' AND EXISTS(SELECT 1 FROM financial_private.order_exchanges WHERE store_id=NEW.store_id AND original_id=NEW.id AND status IN ('pending','confirmed')) THEN
  RAISE EXCEPTION 'الطلب له وحدات استبدال؛ استخدم استبدال الوحدات المتبقية بدل إرجاع الطلب بالكامل' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_exchange_document() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER nexus_exchange_document BEFORE INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION financial_private.guard_exchange_document();

CREATE FUNCTION financial_private.guard_exchange_ledger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE original text;
BEGIN
 IF NEW.kind IN ('return_confirmed','order_cancelled','rto_confirmed') AND NEW.ref_type='ecommerce_order' THEN
  SELECT id INTO original FROM public.orders WHERE store_id=NEW.store_id AND "orderNumber"=NEW.ref_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM financial_private.order_exchanges WHERE store_id=NEW.store_id AND original_id=original AND status IN ('pending','confirmed')) THEN
   RAISE EXCEPTION 'لا يمكن إرجاع وحدات محجوزة أو مؤكدة في استبدال؛ استخدم تأكيد الاستبدال' USING ERRCODE='23514'; END IF;
 ELSIF NEW.ref_type='ecommerce_exchange' THEN
  IF NEW.kind<>'return_confirmed' OR NOT EXISTS(SELECT 1 FROM financial_private.order_exchanges WHERE store_id=NEW.store_id AND status='confirmed' AND confirmation_event_id=NEW.id) THEN
   RAISE EXCEPTION 'حركة استبدال غير مرتبطة بتأكيد استلام صالح' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_exchange_ledger() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER nexus_exchange_ledger BEFORE INSERT ON public.ledger_events FOR EACH ROW EXECUTE FUNCTION financial_private.guard_exchange_ledger();
-- Quantity / variant mirrors for the NEW commands are updated transactionally,
-- once at commit, after ledger lines exist. UI code only re-reads these mirrors.
CREATE FUNCTION financial_private.sync_feature_stock_mirror() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE before_rows jsonb:='[]'; after_rows jsonb:='[]'; payload jsonb:=NEW.payload::jsonb;
 e financial_private.order_exchanges; p public.products; subject text; variant text; delta numeric; variants jsonb; available numeric;
BEGIN
 IF NEW.kind='order_edited' AND NEW.command_request->>'command'='order_edit' THEN
  before_rows:=payload#>'{before,stockItems}';after_rows:=payload#>'{after,stockItems}';
 ELSIF NEW.kind='order_placed' AND payload->>'exchangeId' IS NOT NULL THEN
  SELECT * INTO e FROM financial_private.order_exchanges WHERE id=NEW.id AND store_id=NEW.store_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'مرجع حجز الاستبدال غير صالح' USING ERRCODE='23514'; END IF;
  SELECT "stockItems" INTO after_rows FROM public.orders WHERE id=e.replacement_id AND store_id=NEW.store_id;
 ELSIF NEW.kind IN ('order_cancelled','rto_confirmed','return_confirmed') AND NEW.ref_type='ecommerce_order' THEN
  SELECT * INTO e FROM financial_private.order_exchanges WHERE store_id=NEW.store_id AND replacement_id=(SELECT id FROM public.orders WHERE store_id=NEW.store_id AND "orderNumber"=NEW.ref_id);
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT "stockItems" INTO before_rows FROM public.orders WHERE id=e.replacement_id AND store_id=NEW.store_id;
 ELSIF NEW.ref_type='ecommerce_exchange' THEN
  SELECT * INTO e FROM financial_private.order_exchanges WHERE confirmation_event_id=NEW.id AND store_id=NEW.store_id;
  SELECT jsonb_agg(c) INTO before_rows FROM jsonb_array_elements(e.selections) x CROSS JOIN LATERAL jsonb_array_elements(x->'parts') c;
 ELSE RETURN NULL;
 END IF;
 before_rows:=coalesce(before_rows,'[]');after_rows:=coalesce(after_rows,'[]');
 FOR subject IN SELECT DISTINCT x->>'productId' FROM jsonb_array_elements(before_rows||after_rows) x ORDER BY 1 LOOP
  SELECT * INTO p FROM public.products WHERE id=subject AND store_id=NEW.store_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'منتج حركة الاستبدال غير موجود' USING ERRCODE='23514'; END IF;
  variants:=coalesce(p.metadata->'variants','[]');
  FOR variant IN SELECT DISTINCT nullif(x->>'variantName','') FROM jsonb_array_elements(before_rows||after_rows) x WHERE x->>'productId'=subject LOOP
   IF variant IS NULL THEN CONTINUE; END IF;
   SELECT coalesce(sum(q),0) INTO delta FROM (
    SELECT (x->>'quantity')::numeric q FROM jsonb_array_elements(before_rows) x WHERE x->>'productId'=subject AND x->>'variantName'=variant
    UNION ALL SELECT -(x->>'quantity')::numeric FROM jsonb_array_elements(after_rows) x WHERE x->>'productId'=subject AND x->>'variantName'=variant) t;
   SELECT (v->>'stock')::numeric INTO available FROM jsonb_array_elements(variants) v WHERE v->>'name'=variant;
   IF available IS NULL OR available+delta<0 THEN RAISE EXCEPTION 'مخزون الدرجة غير كافٍ؛ حدّث البيانات' USING ERRCODE='23514'; END IF;
   SELECT jsonb_agg(CASE WHEN v->>'name'=variant THEN jsonb_set(v,'{stock}',to_jsonb(available+delta)) ELSE v END) INTO variants FROM jsonb_array_elements(variants) v;
  END LOOP;
  UPDATE public.products SET quantity=(SELECT coalesce(sum(qty_delta),0) FROM public.ledger_lines WHERE store_id=NEW.store_id AND account='stock' AND subject_id=subject),
   metadata=CASE WHEN jsonb_array_length(variants)>0 THEN jsonb_set(coalesce(metadata,'{}'),'{variants}',variants) ELSE metadata END,
   updated_at=(extract(epoch FROM clock_timestamp())*1000)::bigint WHERE id=subject AND store_id=NEW.store_id;
 END LOOP;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.sync_feature_stock_mirror() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER nexus_feature_stock_mirror AFTER INSERT ON public.ledger_events
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION financial_private.sync_feature_stock_mirror();

-- Append a customer-facing workflow field to the existing cost-filtered view.
-- Keep its exact previous projection, membership predicate, security barrier,
-- owner and grants. No costs are present inside exchangeDetails.
DO $migration$
DECLARE definition text;
BEGIN
 definition:=pg_get_viewdef('public.orders_operational'::regclass,true);
 IF position('"exchangeDetails"' IN definition)>0 OR position('FROM orders o' IN definition)=0 THEN
  RAISE EXCEPTION 'NEXUS_ORDERS_VIEW_SCHEMA_DRIFT'; END IF;
 definition:=replace(definition,'FROM orders o',', o."exchangeDetails" FROM orders o');
 EXECUTE 'CREATE OR REPLACE VIEW public.orders_operational WITH (security_barrier=true) AS '||definition;
END $migration$;
