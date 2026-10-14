-- LOCAL ONLY. Forward business identifiers; internal IDs and all old events stay intact.
-- Uses existing per-store counters. A retry journal is identity metadata, not money.
CREATE TABLE financial_private.document_numbers (
 store_id uuid NOT NULL REFERENCES public.stores(id), kind text NOT NULL CHECK(kind IN ('pos','order')),
 request_id text NOT NULL, number text NOT NULL, PRIMARY KEY(store_id,kind,request_id), UNIQUE(store_id,kind,number)
);
ALTER TABLE financial_private.document_numbers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financial_private.document_numbers FROM PUBLIC,anon,authenticated;
CREATE FUNCTION financial_private.document_number_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $fn$
BEGIN RAISE EXCEPTION 'NEXUS_DOCUMENT_NUMBER_IMMUTABLE' USING ERRCODE='23514';END $fn$;
REVOKE ALL ON FUNCTION financial_private.document_number_immutable() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER document_number_immutable BEFORE UPDATE OR DELETE ON financial_private.document_numbers
 FOR EACH ROW EXECUTE FUNCTION financial_private.document_number_immutable();

CREATE FUNCTION financial_private.store_abbreviation(p_name text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path TO public,pg_temp AS $fn$
DECLARE words text[]; word text; clean text; result text:='';
BEGIN
 clean:=upper(translate(regexp_replace(coalesce(p_name,''),'[ًٌٍَُِّْـ]','','g'),
  'اأإآبتثجحخدذرزسشصضطظعغفقكلمنهويىةؤئ','AAAABTTJHKDDRZSSSDTZAGFQKLMNHWYYHWE'));
 clean:=trim(regexp_replace(clean,'[^A-Z]+',' ','g'));
 IF clean='' THEN RETURN 'NC';END IF;
 words:=string_to_array(clean,' ');
 IF cardinality(words)=1 THEN RETURN left(words[1],3);END IF;
 FOREACH word IN ARRAY words LOOP result:=result||left(word,1);EXIT WHEN length(result)=4;END LOOP;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.store_abbreviation(text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION financial_private.allocate_document_number(p_store uuid,p_kind text,p_request text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE result text; prefix text; counter text; n bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC
  CASE WHEN p_kind='pos' THEN ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE'] ELSE ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY'] END),false) THEN
  RAISE EXCEPTION 'NEXUS_DOCUMENT_NUMBER_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF p_kind NOT IN ('pos','order') OR p_kind IS NULL OR nullif(p_request,'') IS NULL OR length(p_request)>200 THEN
  RAISE EXCEPTION 'NEXUS_DOCUMENT_NUMBER_INVALID' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('document-number:'||p_store||':'||p_kind||':'||p_request,0));
 SELECT number INTO result FROM financial_private.document_numbers WHERE store_id=p_store AND kind=p_kind AND request_id=p_request;
 IF FOUND THEN RETURN result;END IF;
 SELECT financial_private.store_abbreviation(name)||CASE WHEN p_kind='pos' THEN '-P' ELSE '-O' END INTO prefix FROM public.stores WHERE id=p_store;
 IF prefix IS NULL THEN RAISE EXCEPTION 'NEXUS_DOCUMENT_NUMBER_STORE_REQUIRED' USING ERRCODE='23514';END IF;
 counter:='branded_'||p_kind;
 LOOP
  INSERT INTO public.store_counters(store_id,name,value) VALUES(p_store,counter,1)
   ON CONFLICT(store_id,name) DO UPDATE SET value=public.store_counters.value+1 RETURNING value INTO n;
  result:=prefix||lpad(n::text,greatest(3,length(n::text)),'0');
  EXIT WHEN NOT EXISTS(SELECT 1 FROM financial_private.document_numbers WHERE store_id=p_store AND kind=p_kind AND number=result)
   AND NOT EXISTS(SELECT 1 FROM public.orders WHERE store_id=p_store AND "orderNumber"=result)
   AND NOT EXISTS(SELECT 1 FROM public.ledger_events WHERE store_id=p_store AND ref_type='pos_sale' AND payload::jsonb->>'documentNumber'=result);
 END LOOP;
 INSERT INTO financial_private.document_numbers VALUES(p_store,p_kind,p_request,result);
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.allocate_document_number(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION financial_private.allocate_document_number(uuid,text,text) TO authenticated;

-- Run through the existing stable client command envelope; no financial mutation.
CREATE FUNCTION public.record_document_number(p_id text,p_store uuid,p_device uuid,p_command text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF p_command IS DISTINCT FROM 'document_number' OR p_input IS DISTINCT FROM '{"kind":"order"}'::jsonb OR p_device IS NULL THEN
  RAISE EXCEPTION 'NEXUS_DOCUMENT_NUMBER_INVALID' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('documentNumber',financial_private.allocate_document_number(p_store,'order',p_id));
END $fn$;
REVOKE ALL ON FUNCTION public.record_document_number(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_document_number(text,uuid,uuid,text,jsonb) TO authenticated;

DO $migration$
DECLARE d text; needle text;
BEGIN
 -- Existing callers retain their legacy namespaces. Protect the new reserved counters
 -- and avoid lpad truncating a legacy sequence above9999. Never reset any counter.
 d:=replace(pg_get_functiondef('public.next_document_number(uuid,text,text)'::regprocedure),chr(13),'');
 needle:='  INSERT INTO public.store_counters';
 IF strpos(d,needle)=0 OR strpos(d,'lpad(v::text, 4, ''0'')')=0 THEN RAISE EXCEPTION 'NEXUS_NUMBER_SCHEMA_DRIFT';END IF;
 d:=replace(d,needle,'  IF p_name IN (''branded_pos'',''branded_order'') THEN RAISE EXCEPTION ''NEXUS_RESERVED_COUNTER'' USING ERRCODE=''23514'';END IF;'||chr(10)||needle);
 EXECUTE replace(d,'lpad(v::text, 4, ''0'')','lpad(v::text, greatest(4,length(v::text)), ''0'')');
 -- Allocate only after canonical validation and before the immutable append, in the
 -- SAME transaction. command_request and event identity stay byte-for-byte original.
 d:=replace(pg_get_functiondef('public.record_pos_sale(text,uuid,uuid,text,jsonb)'::regprocedure),chr(13),'');
 needle:='  PERFORM public.ledger_append(jsonb_build_object(''id'',p_id,''store_id'',p_store';
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_POS_NUMBER_SCHEMA_DRIFT';END IF;
 d:=replace(d,needle,$patch$
  IF v_source IS NULL THEN
   v_write_payload:=(v_write_payload-'sourceDocumentNumber')||jsonb_build_object('documentNumber',financial_private.allocate_document_number(p_store,'pos',p_id));
  ELSE
   v_write_payload:=(v_write_payload-'documentNumber')||jsonb_build_object('sourceDocumentNumber',coalesce(nullif(v_payload->>'documentNumber',''),v_source));
  END IF;
  v_result:=v_result||jsonb_strip_nulls(jsonb_build_object('documentNumber',v_write_payload->>'documentNumber','sourceDocumentNumber',v_write_payload->>'sourceDocumentNumber'));
$patch$||needle);
 EXECUTE d;
 d:=replace(pg_get_functiondef('public.record_pos_exchange(text,uuid,uuid,text,jsonb)'::regprocedure),chr(13),'');
 needle:=' INSERT INTO financial_private.pos_exchange_commands VALUES(p_id,p_store,request,result);';
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'NEXUS_EXCHANGE_NUMBER_SCHEMA_DRIFT';END IF;
 EXECUTE replace(d,needle,' result:=result||jsonb_build_object(''sourceDocumentNumber'',coalesce(nullif(source->>''documentNumber'',''''),source_id),''replacementDocumentNumber'',sold->>''documentNumber'');'||chr(10)||needle);
END $migration$;

-- Forward issued orders keep their identity across edits, cancellation and rename.
-- Existing historical rows are not re-numbered or backfilled.
CREATE FUNCTION financial_private.guard_numbered_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM financial_private.document_numbers WHERE store_id=OLD.store_id AND kind='order' AND number=OLD."orderNumber")
  AND (TG_OP='DELETE' OR NEW."orderNumber" IS DISTINCT FROM OLD."orderNumber" OR NEW.id IS DISTINCT FROM OLD.id OR NEW.store_id IS DISTINCT FROM OLD.store_id) THEN
  RAISE EXCEPTION 'NEXUS_DOCUMENT_NUMBER_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.guard_numbered_order() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_numbered_order BEFORE UPDATE OR DELETE ON public.orders
 FOR EACH ROW EXECUTE FUNCTION financial_private.guard_numbered_order();

-- Search the saved friendly/legacy reference before limiting, then include every
-- return against those receipts so an older return cannot disappear from the ceiling.
CREATE FUNCTION public.search_pos_receipts(p_store uuid,p_search text) RETURNS SETOF public.ledger_events
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path TO public,pg_temp AS $fn$
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT','POS_ECOMMERCE']),false) THEN
  RAISE EXCEPTION 'NEXUS_POS_FORBIDDEN' USING ERRCODE='42501';END IF;
 IF nullif(trim(p_search),'') IS NULL OR length(p_search)>150 THEN RAISE EXCEPTION 'NEXUS_RECEIPT_SEARCH_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN QUERY WITH receipts AS (
  SELECT e.id FROM public.ledger_events e WHERE e.store_id=p_store AND e.kind='sale' AND e.ref_type='pos_sale'
   AND nullif(e.payload::jsonb->>'returnOfEventId','') IS NULL
   AND (strpos(lower(e.id),lower(trim(p_search)))>0 OR strpos(lower(coalesce(e.payload::jsonb->>'documentNumber','')),lower(trim(p_search)))>0
    OR strpos(lower(coalesce(e.payload::jsonb->>'customerPhone','')),lower(trim(p_search)))>0
    OR strpos(lower(coalesce(e.payload::jsonb->>'customerName','')),lower(trim(p_search)))>0)
  ORDER BY e.occurred_at::timestamptz DESC,e.id LIMIT 100
 ) SELECT e.* FROM public.ledger_events e WHERE e.store_id=p_store AND e.kind='sale' AND e.ref_type='pos_sale'
  AND (e.id IN(SELECT id FROM receipts) OR e.payload::jsonb->>'returnOfEventId' IN(SELECT id FROM receipts))
 ORDER BY e.occurred_at::timestamptz DESC,e.id;
END $fn$;
REVOKE ALL ON FUNCTION public.search_pos_receipts(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.search_pos_receipts(uuid,text) TO authenticated;
