-- LOCAL ONLY: forward stock authority; NO historical allocation repair.
-- Requires receipt_variant_stock, pos_atomic_exchange, courier_atomic_batch.
CREATE TABLE financial_private.stock_applications (
 event_id text PRIMARY KEY REFERENCES public.ledger_events(id), store_id uuid NOT NULL,
 stock_lines jsonb NOT NULL, moves jsonb NOT NULL
);
CREATE TABLE financial_private.stock_write_permits (
 transaction_id bigint NOT NULL, store_id uuid NOT NULL, product_id text NOT NULL,
 quantity numeric NOT NULL, variants jsonb NOT NULL,
 PRIMARY KEY(transaction_id,store_id,product_id)
);
ALTER TABLE financial_private.stock_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_private.stock_write_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.stock_applications,financial_private.stock_write_permits FROM PUBLIC,anon,authenticated;

CREATE FUNCTION financial_private.guard_stock_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE permitted integer; old_counts jsonb; new_counts jsonb; variants jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM public.ledger_lines WHERE store_id=OLD.store_id AND account='stock' AND subject_id=OLD.id) THEN
   RAISE EXCEPTION 'NEXUS_STOCK_IDENTITY_IMMUTABLE: archive the product instead' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF (NEW.store_id IS DISTINCT FROM OLD.store_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW."isBundle" IS DISTINCT FROM OLD."isBundle")
  AND EXISTS(SELECT 1 FROM public.ledger_lines WHERE store_id=OLD.store_id AND account='stock' AND subject_id=OLD.id) THEN
  RAISE EXCEPTION 'NEXUS_STOCK_IDENTITY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NEW.quantity IS DISTINCT FROM OLD.quantity OR
   coalesce(NEW.metadata->'variants','[]') IS DISTINCT FROM coalesce(OLD.metadata->'variants','[]') THEN
  variants:=coalesce(NEW.metadata->'variants','[]');
  IF jsonb_typeof(variants) IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(variants) v
   WHERE nullif(v->>'name','') IS NULL OR v->>'stock' IS NULL OR (v->>'stock')::numeric<0
    OR (v->>'stock')::numeric::text IN ('NaN','Infinity','-Infinity'))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(variants) v GROUP BY v->>'name' HAVING count(*)>1) THEN
   RAISE EXCEPTION 'NEXUS_STOCK_VARIANT_REVIEW' USING ERRCODE='23514'; END IF;
  SELECT coalesce(jsonb_object_agg(v->>'name',(v->>'stock')::numeric),'{}') INTO old_counts
   FROM jsonb_array_elements(coalesce(OLD.metadata->'variants','[]')) v WHERE (v->>'stock')::numeric<>0;
  SELECT coalesce(jsonb_object_agg(v->>'name',(v->>'stock')::numeric),'{}') INTO new_counts
   FROM jsonb_array_elements(variants) v WHERE (v->>'stock')::numeric<>0;
  IF jsonb_array_length(variants)>0 AND (SELECT sum((v->>'stock')::numeric) FROM jsonb_array_elements(variants) v) IS DISTINCT FROM NEW.quantity THEN
   RAISE EXCEPTION 'NEXUS_STOCK_RECONCILIATION_REQUIRED' USING ERRCODE='23514'; END IF;
  -- Safe catalog edits may add/remove zero-stock choices or edit descriptive
  -- variant fields. Existing nonzero identities/counts cannot be reassigned.
  IF NEW.quantity IS NOT DISTINCT FROM OLD.quantity AND old_counts=new_counts THEN RETURN NEW; END IF;
  DELETE FROM financial_private.stock_write_permits permit
   WHERE permit.transaction_id=txid_current() AND permit.store_id=OLD.store_id AND permit.product_id=OLD.id
     AND NEW.store_id=OLD.store_id AND NEW.id=OLD.id AND permit.quantity=NEW.quantity
     AND permit.variants=coalesce(NEW.metadata->'variants','[]');
  GET DIAGNOSTICS permitted=ROW_COUNT;
  IF permitted<>1 THEN RAISE EXCEPTION 'NEXUS_STOCK_ATOMIC_REQUIRED: refresh the application; use a stock command'
   USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_stock_write() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER nexus_stock_write_guard BEFORE UPDATE OR DELETE ON public.products
 FOR EACH ROW EXECUTE FUNCTION financial_private.guard_stock_write();

-- Only a validated event newly inserted in THIS transaction can apply its
-- exact physical movements. No caller deltas/GUC can grant write permission.
-- ledger_append remains INVOKER and retains all RLS/licence/financial gates.
CREATE FUNCTION financial_private.apply_stock_event(p_event_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE e public.ledger_events; payload jsonb; moves jsonb:='[]';
 before_rows jsonb:='[]'; after_rows jsonb:='[]'; item jsonb; part jsonb; recipe jsonb;
 source public.orders; invoice public.purchase_invoices; product public.products;
 subject text; variant text; delta numeric; prior numeric; total numeric; quantity numeric;
 variants jsonb; expected numeric; actual numeric; stocks jsonb;
 opening boolean; updated integer; return_value numeric; debt_before numeric; reduction numeric; prior_value numeric;
 paid numeric; allocation numeric; credit numeric; paid_allocation numeric; updated_items jsonb; allocation_invoice public.purchase_invoices;
BEGIN
 SELECT * INTO e FROM public.ledger_events WHERE id=p_event_id;
 IF NOT FOUND OR auth.uid() IS NULL OR NOT coalesce(public.has_role(e.store_id,VARIADIC
   ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_STOCK_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM financial_private.stock_applications WHERE event_id=e.id AND store_id=e.store_id) THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ledger_events WHERE id=e.id AND xmin::text=pg_current_xact_id()::text) THEN
  RAISE EXCEPTION 'NEXUS_STOCK_CURRENT_COMMAND_REQUIRED' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'productId',subject_id,'qty',qty_delta,'piastres',amount_delta) ORDER BY id),'[]')
  INTO stocks FROM public.ledger_lines WHERE event_id=e.id AND store_id=e.store_id AND account='stock';
 IF jsonb_array_length(stocks)=0 THEN RETURN; END IF;
 payload:=coalesce(e.payload::jsonb,'{}');
 opening:=e.kind='stock_adjustment' AND e.ref_type='opening_balance';
 IF e.kind='sale' AND e.ref_type='pos_sale' THEN
  FOR item IN SELECT x FROM jsonb_array_elements(payload->'items') x LOOP
   recipe:=CASE WHEN coalesce((item->>'isBundle')::boolean,false) THEN item->'bundleItems'
    ELSE jsonb_build_array(jsonb_build_object('productId',item->>'productId','variantName',item->>'variantName','quantity',1)) END;
   IF jsonb_typeof(recipe) IS DISTINCT FROM 'array' OR jsonb_array_length(recipe)=0 THEN
    RAISE EXCEPTION 'NEXUS_STOCK_RECIPE_REQUIRED' USING ERRCODE='23514'; END IF;
   FOR part IN SELECT x FROM jsonb_array_elements(recipe) x LOOP
    moves:=moves||jsonb_build_array(jsonb_build_object('productId',part->>'productId','variantName',part->>'variantName',
     'delta',-(item->>'quantity')::numeric*(part->>'quantity')::numeric));
   END LOOP;
  END LOOP;
 ELSIF e.kind='purchase' AND e.command_request->>'command'='receipt' THEN
  IF NOT EXISTS(SELECT 1 FROM public.purchase_invoices pi WHERE pi.id=e.id AND pi.store_id=e.store_id AND pi."invoiceNumber"=e.ref_id) THEN
   RAISE EXCEPTION 'NEXUS_STOCK_RECEIPT_REQUIRED' USING ERRCODE='23514'; END IF;
  SELECT jsonb_agg(jsonb_build_object('productId',x->>'productId','variantName',x->>'variantName','delta',(x->>'quantity')::numeric))
   INTO moves FROM jsonb_array_elements(e.command_request#>'{input,items}') x;
 ELSIF e.kind='purchase' AND e.ref_type='supplier_return' THEN
  PERFORM 1 FROM public.suppliers WHERE id=payload->>'supplierId' AND store_id=e.store_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_STOCK_RETURN_SOURCE_REQUIRED' USING ERRCODE='23514'; END IF;
  SELECT * INTO invoice FROM public.purchase_invoices WHERE store_id=e.store_id AND "invoiceNumber"=e.ref_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR invoice."supplierId" IS DISTINCT FROM payload->>'supplierId' THEN
   RAISE EXCEPTION 'NEXUS_STOCK_RETURN_SOURCE_REQUIRED' USING ERRCODE='23514'; END IF;
  FOR item IN SELECT x FROM jsonb_array_elements(payload->'items') x LOOP
   SELECT coalesce(sum((x->>'quantity')::numeric),0) INTO expected FROM jsonb_array_elements(invoice.items) x
    WHERE coalesce(x->>'id',x->>'productId')=item->>'lineKey' AND x->>'productId'=item->>'productId' AND coalesce(x->>'variantName','')=coalesce(item->>'variantName','');
   SELECT coalesce(sum((x->>'quantity')::numeric),0) INTO actual FROM public.ledger_events le
    CROSS JOIN LATERAL jsonb_array_elements(le.payload::jsonb->'items') x
    WHERE le.store_id=e.store_id AND le.ref_type='supplier_return' AND le.kind='purchase' AND le.ref_id=e.ref_id
     AND x->>'lineKey'=item->>'lineKey' AND x->>'productId'=item->>'productId' AND coalesce(x->>'variantName','')=coalesce(item->>'variantName','');
   IF expected<=0 OR actual>expected OR (item->>'quantity')::numeric<=0 OR NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(invoice.items) x WHERE coalesce(x->>'id',x->>'productId')=item->>'lineKey' AND x->>'productId'=item->>'productId'
     AND coalesce(x->>'variantName','')=coalesce(item->>'variantName','') AND (x->>'unitCost')::numeric=(item->>'unitCost')::numeric) THEN
    RAISE EXCEPTION 'NEXUS_STOCK_RETURN_SOURCE_REQUIRED' USING ERRCODE='23514'; END IF;
   moves:=moves||jsonb_build_array(jsonb_build_object('productId',item->>'productId','variantName',item->>'variantName','delta',-(item->>'quantity')::numeric));
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.ledger_events le WHERE le.store_id=e.store_id AND le.ref_type='supplier_return' AND le.kind='purchase' AND le.ref_id=e.ref_id
    AND le.id<>e.id AND NOT EXISTS(SELECT 1 FROM financial_private.stock_applications sa WHERE sa.event_id=le.id)) THEN
   RAISE EXCEPTION 'NEXUS_STOCK_RETURN_HISTORY_REVIEW' USING ERRCODE='23514'; END IF;
  SELECT sum(round((x->>'quantity')::numeric*(x->>'unitCost')::numeric*100)) INTO return_value FROM jsonb_array_elements(payload->'items') x;
  IF return_value IS NULL OR return_value IS DISTINCT FROM -(SELECT sum(amount_delta) FROM public.ledger_lines WHERE event_id=e.id AND account='stock') THEN
   RAISE EXCEPTION 'NEXUS_STOCK_RETURN_VALUE_MISMATCH' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(amount_delta),0) INTO debt_before FROM public.ledger_lines WHERE store_id=e.store_id AND account='payable_supplier' AND subject_id=invoice."supplierId" AND event_id<>e.id;
  paid:=round(coalesce((payload->>'paidNow')::numeric,0)*100);
  reduction:=least(return_value,debt_before)+paid;
  credit:=least(return_value,debt_before);
  IF debt_before<0 OR round((payload->>'previousDebt')::numeric*100) IS DISTINCT FROM debt_before
    OR paid<0 OR paid>greatest(0,debt_before-return_value)
    OR coalesce((SELECT sum(amount_delta) FROM public.ledger_lines WHERE event_id=e.id AND account='payable_supplier' AND subject_id=invoice."supplierId"),0) IS DISTINCT FROM -reduction
    OR EXISTS(SELECT 1 FROM public.ledger_lines WHERE event_id=e.id AND account='payable_supplier' AND subject_id<>invoice."supplierId") THEN
   RAISE EXCEPTION 'NEXUS_STOCK_SUPPLIER_BALANCE_CHANGED' USING ERRCODE='23514'; END IF;
  -- Source return quantities and payable allocations persist with the event,
  -- not an asynchronous invoice PATCH. Existing invoices are never rewritten
  -- by migration; these are only normal forward business document effects.
  SELECT jsonb_agg(x||jsonb_build_object('returnedQuantity',coalesce((SELECT sum((i->>'quantity')::numeric)
   FROM public.ledger_events le CROSS JOIN LATERAL jsonb_array_elements(le.payload::jsonb->'items') i
   WHERE le.store_id=e.store_id AND le.kind='purchase' AND le.ref_type='supplier_return' AND le.ref_id=e.ref_id
     AND i->>'lineKey'=coalesce(x->>'id',x->>'productId')),0)) ORDER BY ordinal) INTO updated_items
   FROM jsonb_array_elements(invoice.items) WITH ORDINALITY t(x,ordinal);
  UPDATE public.purchase_invoices SET items=updated_items,"updatedAt"=now(),updated_at=greatest(coalesce(updated_at,0)+1,(extract(epoch FROM clock_timestamp())*1000)::bigint)
   WHERE id=invoice.id AND store_id=e.store_id;
  FOR allocation_invoice IN SELECT * FROM public.purchase_invoices WHERE store_id=e.store_id AND "supplierId"=invoice."supplierId" AND deleted_at IS NULL AND "remainingAmount">0
   ORDER BY (id=invoice.id) DESC,"createdAt",id FOR UPDATE LOOP
   EXIT WHEN reduction<=0;
   allocation:=least(credit,round(allocation_invoice."remainingAmount"*100));
   paid_allocation:=least(paid,round(allocation_invoice."remainingAmount"*100)-allocation);
   UPDATE public.purchase_invoices SET "remainingAmount"="remainingAmount"-(allocation+paid_allocation)/100,
    "paidAmount"="paidAmount"+paid_allocation/100,
    status=CASE WHEN "remainingAmount"-(allocation+paid_allocation)/100=0 THEN 'paid' ELSE 'partial' END,"updatedAt"=now(),
    updated_at=greatest(coalesce(updated_at,0)+1,(extract(epoch FROM clock_timestamp())*1000)::bigint) WHERE id=allocation_invoice.id AND store_id=e.store_id;
   -- Cash and credit allocations are distinct even though they clear the
   -- same payable. A supplier refund is never invented as a cash payment.
   credit:=credit-allocation;paid:=paid-paid_allocation;
   reduction:=reduction-allocation-paid_allocation;
  END LOOP;
  IF reduction<>0 THEN RAISE EXCEPTION 'NEXUS_STOCK_SUPPLIER_DOCUMENT_REVIEW' USING ERRCODE='23514'; END IF;
 ELSIF e.kind='order_edited' AND e.command_request->>'command'='order_edit' THEN
  before_rows:=payload#>'{before,stockItems}'; after_rows:=payload#>'{after,stockItems}';
 ELSIF e.ref_type='ecommerce_exchange' AND e.kind='return_confirmed' THEN
  SELECT jsonb_agg(c) INTO before_rows FROM financial_private.order_exchanges ex
   CROSS JOIN LATERAL jsonb_array_elements(ex.selections) x CROSS JOIN LATERAL jsonb_array_elements(x->'parts') c
   WHERE ex.store_id=e.store_id AND ex.confirmation_event_id=e.id AND ex.status='confirmed';
 ELSIF e.ref_type='ecommerce_order' AND e.kind IN ('order_placed','order_cancelled','rto_confirmed','return_confirmed') THEN
  SELECT * INTO source FROM public.orders WHERE store_id=e.store_id AND "orderNumber"=e.ref_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_STOCK_ORDER_REQUIRED' USING ERRCODE='23514'; END IF;
  IF e.kind='order_placed' THEN after_rows:=source."stockItems";
  ELSE
   before_rows:=coalesce(payload->'stockItems',source."stockItems");
   FOR item IN SELECT x FROM jsonb_array_elements(before_rows) x LOOP
    SELECT coalesce(sum((x->>'quantity')::numeric),0) INTO expected FROM jsonb_array_elements(source."stockItems") x
     WHERE x->>'productId'=item->>'productId' AND coalesce(x->>'variantName','')=coalesce(item->>'variantName','')
      AND (x->>'unitCost')::numeric=(item->>'unitCost')::numeric;
    IF EXISTS(SELECT 1 FROM public.ledger_events le WHERE le.store_id=e.store_id AND le.ref_type='ecommerce_order' AND le.ref_id=e.ref_id
      AND le.id<>e.id AND le.kind IN ('order_cancelled','rto_confirmed','return_confirmed')
      AND NOT EXISTS(SELECT 1 FROM financial_private.stock_applications sa WHERE sa.event_id=le.id)) THEN
     RAISE EXCEPTION 'NEXUS_STOCK_RETURN_HISTORY_REVIEW' USING ERRCODE='23514'; END IF;
    SELECT coalesce(sum((m->>'delta')::numeric),0) INTO actual FROM financial_private.stock_applications sa JOIN public.ledger_events le ON le.id=sa.event_id
     CROSS JOIN LATERAL jsonb_array_elements(sa.moves) m WHERE le.store_id=e.store_id AND le.ref_type='ecommerce_order' AND le.ref_id=e.ref_id
      AND le.kind IN ('order_cancelled','rto_confirmed','return_confirmed') AND m->>'productId'=item->>'productId'
      AND coalesce(m->>'variantName','')=coalesce(item->>'variantName','');
    actual:=actual+(SELECT sum((x->>'quantity')::numeric) FROM jsonb_array_elements(before_rows) x
      WHERE x->>'productId'=item->>'productId' AND coalesce(x->>'variantName','')=coalesce(item->>'variantName',''));
    IF expected<=0 OR actual>expected OR (item->>'quantity')::numeric<=0 THEN
     RAISE EXCEPTION 'NEXUS_STOCK_RETURN_ALLOCATION_REQUIRED' USING ERRCODE='23514'; END IF;
   END LOOP;
  END IF;
 ELSIF opening THEN moves:='[]';
 ELSIF e.kind='stock_adjustment' AND e.ref_type='stock_audit' THEN
  FOR item IN SELECT x FROM jsonb_array_elements(payload->'stockCounts') x LOOP
   moves:=moves||jsonb_build_array(jsonb_build_object('productId',item->>'productId','variantName',item->>'variantName',
    'delta',(item->>'countedQty')::numeric-(item->>'systemQty')::numeric,'systemQty',item->'systemQty'));
  END LOOP;
 ELSE RAISE EXCEPTION 'NEXUS_STOCK_CLIENT_UPDATE_REQUIRED: unsupported legacy stock writer' USING ERRCODE='23514';
 END IF;
 FOR item IN SELECT x FROM jsonb_array_elements(coalesce(before_rows,'[]')) x LOOP
  moves:=moves||jsonb_build_array(jsonb_build_object('productId',item->>'productId','variantName',item->>'variantName','delta',(item->>'quantity')::numeric));
 END LOOP;
 FOR item IN SELECT x FROM jsonb_array_elements(coalesce(after_rows,'[]')) x LOOP
  moves:=moves||jsonb_build_array(jsonb_build_object('productId',item->>'productId','variantName',item->>'variantName','delta',-(item->>'quantity')::numeric));
 END LOOP;
 moves:=coalesce(moves,'[]');
 IF NOT opening AND (jsonb_array_length(moves)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(moves) x
  WHERE nullif(x->>'productId','') IS NULL OR x->>'delta' IS NULL OR (x->>'delta')::numeric::text IN ('NaN','Infinity','-Infinity'))) THEN
  RAISE EXCEPTION 'NEXUS_STOCK_IDENTITIES_REQUIRED' USING ERRCODE='23514'; END IF;
 FOR subject IN SELECT DISTINCT x->>'productId' FROM jsonb_array_elements(stocks||moves) x ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-stock:'||e.store_id::text||':'||subject,0));
 END LOOP;
 FOR subject IN SELECT DISTINCT x->>'productId' FROM jsonb_array_elements(stocks||moves) x ORDER BY 1 LOOP
  -- Historical returns/cancellations may restore an archived product. New
  -- sale/receipt availability is still checked by their original commands.
  SELECT * INTO product FROM public.products WHERE store_id=e.store_id AND id=subject FOR UPDATE;
  IF NOT FOUND OR product."isBundle" THEN RAISE EXCEPTION 'NEXUS_STOCK_PRODUCT_INVALID' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(qty_delta::numeric),0) INTO total FROM public.ledger_lines WHERE store_id=e.store_id AND account='stock' AND subject_id=subject;
  SELECT coalesce(sum((x->>'qty')::numeric),0) INTO delta FROM jsonb_array_elements(stocks) x WHERE x->>'productId'=subject;
  prior:=total-delta;
  IF e.kind='order_placed' OR (e.kind='stock_adjustment' AND e.ref_type='stock_audit') THEN
   SELECT coalesce(sum(amount_delta),0) INTO prior_value FROM public.ledger_lines WHERE store_id=e.store_id AND account='stock' AND subject_id=subject AND event_id<>e.id;
   IF prior>0 AND (SELECT sum((x->>'piastres')::numeric) FROM jsonb_array_elements(stocks) x WHERE x->>'productId'=subject) IS DISTINCT FROM
    (SELECT sum(floor((x->>'qty')::numeric*prior_value/prior+0.5)) FROM jsonb_array_elements(stocks) x WHERE x->>'productId'=subject) THEN
    RAISE EXCEPTION 'NEXUS_STOCK_COST_CHANGED' USING ERRCODE='23514'; END IF;
  ELSIF e.kind IN ('order_cancelled','rto_confirmed','return_confirmed') THEN
   IF (SELECT sum((x->>'piastres')::numeric) FROM jsonb_array_elements(stocks) x WHERE x->>'productId'=subject) IS DISTINCT FROM
    (SELECT sum(coalesce((x->>'costPiastres')::numeric,floor((x->>'quantity')::numeric*(x->>'unitCost')::numeric*100+0.5))) FROM jsonb_array_elements(before_rows) x WHERE x->>'productId'=subject) THEN
    RAISE EXCEPTION 'NEXUS_STOCK_HISTORICAL_COST_MISMATCH' USING ERRCODE='23514'; END IF;
  END IF;
  variants:=coalesce(nullif(product.metadata->'variants','null'::jsonb),'[]');
  IF jsonb_typeof(variants) IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(variants) v
   WHERE nullif(v->>'name','') IS NULL OR v->>'stock' IS NULL OR (v->>'stock')::numeric<0 OR (v->>'stock')::numeric::text IN ('NaN','Infinity','-Infinity'))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(variants) v GROUP BY v->>'name' HAVING count(*)>1) THEN
   RAISE EXCEPTION 'NEXUS_STOCK_VARIANT_REVIEW' USING ERRCODE='23514'; END IF;
  IF opening THEN
   IF EXISTS(SELECT 1 FROM public.ledger_lines WHERE store_id=e.store_id AND account='stock' AND subject_id=subject AND event_id<>e.id)
    OR delta<=0 OR (jsonb_array_length(variants)>0 AND (SELECT sum((v->>'stock')::numeric) FROM jsonb_array_elements(variants) v) IS DISTINCT FROM delta) THEN
    RAISE EXCEPTION 'NEXUS_STOCK_OPENING_REVIEW' USING ERRCODE='23514'; END IF;
  ELSE
   IF (jsonb_array_length(variants)>0 AND (SELECT sum((v->>'stock')::numeric) FROM jsonb_array_elements(variants) v) IS DISTINCT FROM prior)
    OR (jsonb_array_length(variants)=0 AND product.quantity IS DISTINCT FROM prior) THEN
    RAISE EXCEPTION 'NEXUS_STOCK_RECONCILIATION_REQUIRED' USING ERRCODE='23514'; END IF;
   SELECT coalesce(sum((x->>'delta')::numeric),0) INTO expected FROM jsonb_array_elements(moves) x WHERE x->>'productId'=subject;
   IF expected IS DISTINCT FROM delta THEN RAISE EXCEPTION 'NEXUS_STOCK_MOVEMENT_MISMATCH' USING ERRCODE='23514'; END IF;
   FOR item IN SELECT x FROM jsonb_array_elements(moves) x WHERE x->>'productId'=subject LOOP
    variant:=nullif(item->>'variantName','');
    IF (jsonb_array_length(variants)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(variants) v WHERE v->>'name'=variant))
     OR (jsonb_array_length(variants)=0 AND variant IS NOT NULL) THEN
     RAISE EXCEPTION 'NEXUS_STOCK_VARIANT_INVALID' USING ERRCODE='23514'; END IF;
    quantity:=CASE WHEN variant IS NULL THEN prior ELSE (SELECT (v->>'stock')::numeric FROM jsonb_array_elements(variants) v WHERE v->>'name'=variant) END;
    IF e.ref_type='stock_audit' AND (item->>'systemQty')::numeric IS DISTINCT FROM quantity THEN
     RAISE EXCEPTION 'NEXUS_STOCK_COUNT_STALE' USING ERRCODE='23514'; END IF;
   END LOOP;
   SELECT coalesce(jsonb_agg(jsonb_set(v,'{stock}',to_jsonb((v->>'stock')::numeric+coalesce((SELECT sum((x->>'delta')::numeric)
    FROM jsonb_array_elements(moves) x WHERE x->>'productId'=subject AND x->>'variantName'=v->>'name'),0))) ORDER BY ordinal),'[]')
    INTO variants FROM jsonb_array_elements(variants) WITH ORDINALITY t(v,ordinal);
  END IF;
  IF total<0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(variants) v WHERE (v->>'stock')::numeric<0)
   OR (jsonb_array_length(variants)>0 AND (SELECT sum((v->>'stock')::numeric) FROM jsonb_array_elements(variants) v) IS DISTINCT FROM total) THEN
   RAISE EXCEPTION 'NEXUS_STOCK_SHORT' USING ERRCODE='23514'; END IF;
  INSERT INTO financial_private.stock_write_permits VALUES(txid_current(),e.store_id,subject,total,variants);
  UPDATE public.products SET quantity=total,
   metadata=CASE WHEN jsonb_array_length(variants)>0 THEN jsonb_set(coalesce(metadata,'{}'),'{variants}',variants) ELSE metadata END,
   updated_at=greatest(coalesce(updated_at,0)+1,(extract(epoch FROM clock_timestamp())*1000)::bigint),sync_status='synced'
   WHERE id=subject AND store_id=e.store_id;
  GET DIAGNOSTICS updated=ROW_COUNT;
  IF updated<>1 THEN RAISE EXCEPTION 'NEXUS_STOCK_NOT_WRITTEN' USING ERRCODE='23514'; END IF;
  DELETE FROM financial_private.stock_write_permits WHERE transaction_id=txid_current() AND store_id=e.store_id AND product_id=subject;
 END LOOP;
 INSERT INTO financial_private.stock_applications VALUES(e.id,e.store_id,stocks,moves);
END $fn$;
REVOKE ALL ON FUNCTION financial_private.apply_stock_event(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION financial_private.apply_stock_event(text) TO authenticated;
-- Private schema is not exposed by the managed REST API. USAGE grants no
-- table access; every private table/function retains its explicit revocations.
GRANT USAGE ON SCHEMA financial_private TO authenticated;

-- Exact known definitions only; refuse schema drift. Central application
-- REPLACES old mirror loops; validation/docs/replay and financial lines stay.
DO $migration$
DECLARE definition text; first_pos integer; last_pos integer;
BEGIN
 definition:=pg_get_functiondef('public.record_financial_command(text,uuid,uuid,text,jsonb)'::regprocedure);
 definition:=replace(definition,chr(13),'');
 first_pos:=strpos(definition,'  IF p_command=''receipt'' THEN' || chr(10) || '    -- Same SQL transaction');
 last_pos:=strpos(definition,'  RETURN v_result;' || chr(10) || 'END');
 IF first_pos=0 OR last_pos<=first_pos THEN RAISE EXCEPTION 'NEXUS_RECEIPT_STOCK_SCHEMA_DRIFT'; END IF;
 EXECUTE left(definition,first_pos-1)||substring(definition FROM last_pos);
 definition:=pg_get_functiondef('public.record_pos_exchange(text,uuid,uuid,text,jsonb)'::regprocedure);
 definition:=replace(definition,chr(13),'');
 first_pos:=strpos(definition,' -- Both legs committed, but still in this SQL transaction.');
 last_pos:=strpos(definition,' SELECT -sum(amount_delta) INTO refund');
 IF first_pos=0 OR last_pos<=first_pos THEN RAISE EXCEPTION 'NEXUS_POS_STOCK_SCHEMA_DRIFT'; END IF;
 EXECUTE left(definition,first_pos-1)||substring(definition FROM last_pos);
 definition:=pg_get_functiondef('public.ledger_append(jsonb)'::regprocedure);
 definition:=replace(definition,chr(13),'');
 IF strpos(definition,'  PERFORM public.ledger_validate_event(p_event);')=0 OR strpos(definition,'  RETURN v_id;')=0 THEN
  RAISE EXCEPTION 'NEXUS_LEDGER_STOCK_SCHEMA_DRIFT'; END IF;
 definition:=replace(definition,'  v_count integer;','  v_count integer;'||chr(10)||'  v_subject text;');
 definition:=replace(definition,'  PERFORM public.ledger_validate_event(p_event);',
  -- Existing order edit/cancel/return commands lock their order first. The
  -- generic stock command must follow that order too, before product locks.
  '  IF p_event->>''ref_type''=''ecommerce_order'' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_event->''lines'') l WHERE l->>''account''=''stock'') THEN'||chr(10)||
  '    PERFORM 1 FROM public.orders WHERE store_id=v_store AND "orderNumber"=p_event->>''ref_id'' ORDER BY id FOR UPDATE;'||chr(10)||
  '  END IF;'||chr(10)||
  '  FOR v_subject IN SELECT DISTINCT l->>''subject_id'' FROM jsonb_array_elements(p_event->''lines'') l WHERE l->>''account''=''stock'' ORDER BY 1 LOOP'||chr(10)||
  '    PERFORM pg_advisory_xact_lock(hashtextextended(''pos-stock:''||v_store::text||'':''||v_subject,0));'||chr(10)||
  '  END LOOP;'||chr(10)||
  '  PERFORM 1 FROM public.products WHERE store_id=v_store AND id IN (SELECT l->>''subject_id'' FROM jsonb_array_elements(p_event->''lines'') l WHERE l->>''account''=''stock'') ORDER BY id FOR UPDATE;'||chr(10)||
  '  PERFORM public.ledger_validate_event(p_event);');
 definition:=replace(definition,'  RETURN v_id;','  PERFORM financial_private.apply_stock_event(v_id);'||chr(10)||'  RETURN v_id;');
 EXECUTE definition;
END $migration$;
DROP TRIGGER nexus_feature_stock_mirror ON public.ledger_events;

-- Direct table writes cannot bypass the authority or append extra stock
-- lines after its application. Commit guard, never an async mirror writer.
CREATE FUNCTION financial_private.require_stock_application() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE stocks jsonb; receipt jsonb;
BEGIN
 IF NEW.account<>'stock' THEN RETURN NULL; END IF;
 SELECT jsonb_agg(jsonb_build_object('id',id,'productId',subject_id,'qty',qty_delta,'piastres',amount_delta) ORDER BY id)
  INTO stocks FROM public.ledger_lines WHERE event_id=NEW.event_id AND store_id=NEW.store_id AND account='stock';
 SELECT stock_lines INTO receipt FROM financial_private.stock_applications WHERE event_id=NEW.event_id AND store_id=NEW.store_id;
 IF receipt IS NULL OR receipt IS DISTINCT FROM stocks THEN RAISE EXCEPTION 'NEXUS_STOCK_COMMAND_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.require_stock_application() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER nexus_stock_application_required AFTER INSERT ON public.ledger_lines
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION financial_private.require_stock_application();

-- Stable retry boundary for legacy stock-only UI writers. Existing role and
-- licence authorization still occurs in INVOKER ledger_append/table policies.
CREATE FUNCTION public.record_stock_command(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path TO public,pg_temp AS $fn$
DECLARE request jsonb:=jsonb_build_object('command',p_command,'input',p_input);
 saved public.ledger_events; lines jsonb; result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY']),false) THEN
  RAISE EXCEPTION 'NEXUS_STOCK_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF nullif(p_id,'') IS NULL OR p_device IS NULL OR p_command<>'stock_event' OR jsonb_typeof(p_input->'lines') IS DISTINCT FROM 'array'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'lines') l WHERE l->>'account'='stock') THEN
  RAISE EXCEPTION 'NEXUS_STOCK_COMMAND_INVALID' USING ERRCODE='23514'; END IF;
 IF NOT ((p_input->>'kind'='purchase' AND p_input->>'refType'='supplier_return')
  OR (p_input->>'kind'='stock_adjustment' AND p_input->>'refType'='stock_audit')
  OR (p_input->>'kind' IN ('return_confirmed','rto_confirmed') AND p_input->>'refType'='ecommerce_order')) THEN
  RAISE EXCEPTION 'NEXUS_STOCK_CLIENT_UPDATE_REQUIRED' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('stock-command:'||p_id,0));
 SELECT * INTO saved FROM public.ledger_events WHERE id=p_id AND store_id=p_store;
 IF FOUND THEN
  IF saved.command_request IS DISTINCT FROM request OR saved.command_result IS NULL THEN
   RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN saved.command_result||jsonb_build_object('replayed',true);
 END IF;
 SELECT jsonb_agg(jsonb_build_object('id',gen_random_uuid()::text,'account',l->>'account','subject_id',l->>'subjectId',
  'qty_delta',coalesce((l->>'qty')::numeric,0),'amount_delta',floor(coalesce((l->>'amount')::numeric,0)*100+0.5),
  'unit_cost',floor((l->>'unitCost')::numeric*100+0.5))) INTO lines FROM jsonb_array_elements(p_input->'lines') l;
 result:=jsonb_build_object('eventId',p_id,'replayed',false);
 PERFORM public.ledger_append(jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'kind',p_input->>'kind',
  'ref_type',p_input->>'refType','ref_id',p_input->>'refId','actor',p_input->>'actor','payload',coalesce(p_input->'payload','{}')::text,
  'occurred_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'created_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'lines',lines,'command_request',request,'command_result',result));
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.record_stock_command(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_stock_command(text,uuid,uuid,text,jsonb) TO authenticated;
