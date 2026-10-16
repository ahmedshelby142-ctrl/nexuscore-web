-- JSONB preserves decimal numerics; browser JSON preserves binary64 numbers.
-- Accept only that representation loss in the saved cost snapshot. All other
-- identities, quantities, money and fields still require exact equality.
-- Never use the browser's cost to value an edit: both existing command paths
-- continue to price retained stock from the locked authoritative order.
CREATE FUNCTION financial_private.order_edit_snapshot_matches(saved jsonb, supplied jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER
SET search_path TO pg_catalog,pg_temp AS $fn$
DECLARE a jsonb;b jsonb;n integer;cost_a numeric;cost_b numeric;qty numeric;
BEGIN
 IF saved IS NOT DISTINCT FROM supplied THEN RETURN true;END IF;
 IF jsonb_typeof(saved) IS DISTINCT FROM 'object' OR jsonb_typeof(supplied) IS DISTINCT FROM 'object'
  OR (saved-'stockItems') IS DISTINCT FROM (supplied-'stockItems')
  OR jsonb_typeof(saved->'stockItems') IS DISTINCT FROM 'array'
  OR jsonb_typeof(supplied->'stockItems') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(saved->'stockItems')<>jsonb_array_length(supplied->'stockItems') THEN RETURN false;END IF;
 FOR n IN 0..jsonb_array_length(saved->'stockItems')-1 LOOP
  a:=saved->'stockItems'->n;b:=supplied->'stockItems'->n;
  IF a IS NOT DISTINCT FROM b THEN CONTINUE;END IF;
  IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR jsonb_typeof(b) IS DISTINCT FROM 'object'
   OR (a-'unitCost') IS DISTINCT FROM (b-'unitCost')
   OR jsonb_typeof(a->'unitCost') IS DISTINCT FROM 'number'
   OR jsonb_typeof(b->'unitCost') IS DISTINCT FROM 'number'
   OR jsonb_typeof(a->'quantity') IS DISTINCT FROM 'number' THEN RETURN false;END IF;
  cost_a:=(a->>'unitCost')::numeric;cost_b:=(b->>'unitCost')::numeric;qty:=(a->>'quantity')::numeric;
  IF cost_a<0 OR cost_b<0 OR qty<0
   OR cost_a::double precision IS DISTINCT FROM cost_b::double precision
   OR round(cost_a*qty*100) IS DISTINCT FROM round(cost_b*qty*100) THEN RETURN false;END IF;
 END LOOP;
 -- The legacy edit values inventory after grouping all rows of a product.
 -- Reject an ULP-sized difference that crosses any group piastre boundary.
 IF EXISTS(WITH a AS (
  SELECT x->>'productId' id,round(sum((x->>'unitCost')::numeric*(x->>'quantity')::numeric)*100) value
  FROM jsonb_array_elements(saved->'stockItems') x GROUP BY 1
 ), b AS (
  SELECT x->>'productId' id,round(sum((x->>'unitCost')::numeric*(x->>'quantity')::numeric)*100) value
  FROM jsonb_array_elements(supplied->'stockItems') x GROUP BY 1
 ) SELECT 1 FROM a FULL JOIN b USING(id) WHERE a.value IS DISTINCT FROM b.value) THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION financial_private.order_edit_snapshot_matches(jsonb,jsonb) FROM PUBLIC,anon,authenticated;

-- One predicate repair for legacy/exchange AND forward fulfillment edits.
-- CREATE OR REPLACE retains each reviewed function's ACL, auth, locks, replay,
-- financial validation and server-owned stock valuation. No data UPDATEs.
DO $migration$
DECLARE proc regprocedure;definition text;needle text;
BEGIN
 needle:=replace($needle$IF jsonb_build_object('items',o.items,'stockItems',o."stockItems",'totalAmount',o."totalAmount",'discountAmount',o."discountAmount",'depositAmount',o."depositAmount")
     IS DISTINCT FROM p_input->'before' THEN$needle$,chr(13),'');
 FOREACH proc IN ARRAY ARRAY['public.record_order_edit(text,uuid,uuid,text,jsonb)'::regprocedure,
  'financial_private.record_fulfillment_edit(text,uuid,uuid,text,jsonb)'::regprocedure] LOOP
  definition:=replace(pg_get_functiondef(proc),chr(13),'');
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1
   OR strpos(definition,'NEXUS_ORDER_EDIT_STALE')=0
   OR strpos(definition,'NEXUS_OPERATION_PAYLOAD_MISMATCH')=0
   OR strpos(definition,'FOR UPDATE')=0 THEN RAISE EXCEPTION 'NEXUS_ORDER_EDIT_SNAPSHOT_SCHEMA_DRIFT';END IF;
  EXECUTE replace(definition,needle,$replacement$IF NOT financial_private.order_edit_snapshot_matches(
   jsonb_build_object('items',o.items,'stockItems',o."stockItems",'totalAmount',o."totalAmount",'discountAmount',o."discountAmount",'depositAmount',o."depositAmount"),p_input->'before') THEN$replacement$);
 END LOOP;
END $migration$;
