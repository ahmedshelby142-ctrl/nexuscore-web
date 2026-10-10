-- Store-owned setting: existing and future stores are off without backfilling
-- or changing any business document. Existing stores RLS remains unchanged:
-- members read; licensed ADMIN alone updates.
ALTER TABLE public.stores ADD COLUMN wholesale_enabled boolean NOT NULL DEFAULT false;

-- Internal trigger code, not a callable Data API endpoint. Definer is needed
-- ONLY for classification of historical references hidden by finance RLS and
-- for a shared row lock without granting staff store-settings update access.
CREATE SCHEMA wholesale_private;
REVOKE ALL ON SCHEMA wholesale_private FROM PUBLIC, anon, authenticated;

CREATE FUNCTION wholesale_private.assert_enabled(p_store uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE enabled boolean;
BEGIN
  SELECT wholesale_enabled INTO enabled FROM public.stores WHERE id=p_store FOR SHARE;
  IF enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'NEXUS_WHOLESALE_DISABLED' USING ERRCODE='42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION wholesale_private.assert_enabled(uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION wholesale_private.is_wholesale_order(p_store uuid, p_ref text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS(SELECT 1 FROM public.orders o WHERE o.store_id=p_store
    AND (o.id=p_ref OR o."orderNumber"=p_ref)
    AND (nullif(o."wholesaleClientId",'') IS NOT NULL
      OR jsonb_path_exists(coalesce(o."stockItems",'[]'::jsonb),'$[*].wholesaleInvoiceId')))
$$;
REVOKE ALL ON FUNCTION wholesale_private.is_wholesale_order(uuid,text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION wholesale_private.guard_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE doc jsonb; old_doc jsonb; item jsonb; meta jsonb; wholesale boolean := false; s uuid;
BEGIN
  IF TG_OP <> 'DELETE' THEN doc := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN old_doc := to_jsonb(OLD); END IF;
  -- Inspect BOTH versions: changing the marker or tenant cannot strip a guard
  -- from an existing wholesale record. Preserve all historical read policies.
  FOR item IN SELECT value FROM jsonb_array_elements(jsonb_build_array(doc,old_doc)) WHERE value <> 'null'::jsonb LOOP
    s := (item->>'store_id')::uuid;
    wholesale := TG_TABLE_NAME IN ('wholesale_clients','wholesale_invoices');
    IF TG_TABLE_NAME='orders' THEN
      wholesale := nullif(item->>'wholesaleClientId','') IS NOT NULL
        OR jsonb_path_exists(coalesce(nullif(item->'stockItems','null'::jsonb),'[]'::jsonb),'$[*].wholesaleInvoiceId');
    ELSIF TG_TABLE_NAME='return_records' THEN
      wholesale := item->>'type'='wholesale_return'
        OR EXISTS(SELECT 1 FROM public.wholesale_invoices i WHERE i.store_id=s AND i.id=item->>'original_order_id')
        OR wholesale_private.is_wholesale_order(s,item->>'original_order_id');
    ELSIF TG_TABLE_NAME='ledger_events' THEN
      -- Payload is text in the deployed schema. Invalid legacy JSON is not a
      -- reason to break an unrelated finance operation.
      BEGIN meta := (item->>'payload')::jsonb; EXCEPTION WHEN invalid_text_representation THEN meta := '{}'; END;
      wholesale := coalesce(item->>'ref_type' IN ('wholesale_invoice','wholesale_return','wholesale_payment'),false)
        OR coalesce(meta->>'channel'='wholesale',false)
        OR coalesce(meta->>'type'='wholesale_return',false)
        OR coalesce(item#>>'{command_request,input,refType}' IN ('wholesale_invoice','wholesale_return','wholesale_payment'),false)
        OR coalesce(item#>>'{command_request,input,payload,channel}'='wholesale',false)
        OR EXISTS(SELECT 1 FROM public.wholesale_invoices i WHERE i.store_id=s AND (i.id=item->>'ref_id' OR i."invoiceNumber"=item->>'ref_id'))
        OR wholesale_private.is_wholesale_order(s,item->>'ref_id');
    ELSIF TG_TABLE_NAME='ledger_lines' THEN
      wholesale := (item->>'account'='revenue' AND item->>'subject_id'='wholesale')
        OR (item->>'account'='receivable_client' AND EXISTS(SELECT 1 FROM public.wholesale_clients c WHERE c.store_id=s AND c.id=item->>'subject_id'));
    END IF;
    IF wholesale THEN
      IF auth.uid() IS NULL OR NOT coalesce(public.is_store_member(s),false) THEN
        RAISE EXCEPTION 'NEXUS_WHOLESALE_FORBIDDEN' USING ERRCODE='42501';
      END IF;
      PERFORM wholesale_private.assert_enabled(s);
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wholesale_private.guard_write() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER wholesale_enabled_guard BEFORE INSERT OR UPDATE OR DELETE ON public.wholesale_clients FOR EACH ROW EXECUTE FUNCTION wholesale_private.guard_write();
CREATE TRIGGER wholesale_enabled_guard BEFORE INSERT OR UPDATE OR DELETE ON public.wholesale_invoices FOR EACH ROW EXECUTE FUNCTION wholesale_private.guard_write();
CREATE TRIGGER wholesale_enabled_guard BEFORE INSERT OR UPDATE OR DELETE ON public.return_records FOR EACH ROW EXECUTE FUNCTION wholesale_private.guard_write();
CREATE TRIGGER wholesale_enabled_guard BEFORE INSERT OR UPDATE OR DELETE ON public.orders FOR EACH ROW EXECUTE FUNCTION wholesale_private.guard_write();
CREATE TRIGGER wholesale_enabled_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ledger_events FOR EACH ROW EXECUTE FUNCTION wholesale_private.guard_write();
CREATE TRIGGER wholesale_enabled_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ledger_lines FOR EACH ROW EXECUTE FUNCTION wholesale_private.guard_write();
-- Existing RLS, ledger validators and financial command role checks still run.
-- The SHARE lock serializes wholesale writes with a store flag UPDATE: a
-- disable waits for a prior write; later writes see OFF and are rejected.
