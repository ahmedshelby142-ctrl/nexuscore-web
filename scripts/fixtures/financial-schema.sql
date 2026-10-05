-- Disposable local PostgreSQL fixture. No Production connection or auth bypass.
-- Relevant column types/policies match the inspected Production schema.
CREATE ROLE authenticated;
CREATE ROLE anon;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE TABLE store_members(user_id uuid,store_id uuid,role text,PRIMARY KEY(user_id,store_id));
CREATE FUNCTION has_role(s uuid,VARIADIC roles text[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT EXISTS(SELECT 1 FROM store_members WHERE user_id=auth.uid() AND store_id=s AND role=ANY(roles)) $$;
CREATE FUNCTION is_store_member(s uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT EXISTS(SELECT 1 FROM store_members WHERE user_id=auth.uid() AND store_id=s) $$;
CREATE FUNCTION can_read_store_finance(s uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT has_role(s,VARIADIC ARRAY['ADMIN','ACCOUNTANT']) $$;
CREATE TABLE ledger_events(id text PRIMARY KEY,store_id uuid NOT NULL,device_id uuid NOT NULL,kind text NOT NULL,occurred_at text NOT NULL,created_at text NOT NULL,actor text,ref_type text,ref_id text,payload text,sync_status text);
CREATE TABLE ledger_lines(id text PRIMARY KEY,event_id text NOT NULL REFERENCES ledger_events(id),store_id uuid NOT NULL,device_id uuid NOT NULL,account text NOT NULL,subject_id text NOT NULL,qty_delta real NOT NULL DEFAULT 0,amount_delta integer NOT NULL DEFAULT 0,unit_cost integer,sync_status text);
CREATE TABLE suppliers(id text PRIMARY KEY,store_id uuid NOT NULL,device_id uuid NOT NULL,"companyName" text NOT NULL,"contactPerson" text NOT NULL,phone text NOT NULL,"createdAt" timestamptz,"updatedAt" timestamptz,updated_at bigint NOT NULL DEFAULT 0,sync_status text NOT NULL DEFAULT 'pending',deleted_at timestamptz);
CREATE TABLE store_counters(store_id uuid,name text,value bigint NOT NULL DEFAULT 0,PRIMARY KEY(store_id,name));
CREATE FUNCTION next_document_number(p_store uuid,p_name text,p_prefix text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n bigint; BEGIN
IF NOT is_store_member(p_store) THEN RAISE EXCEPTION 'denied' USING ERRCODE='42501'; END IF;
INSERT INTO store_counters VALUES(p_store,p_name,1) ON CONFLICT(store_id,name) DO UPDATE SET value=store_counters.value+1 RETURNING value INTO n;
RETURN p_prefix||lpad(n::text,4,'0'); END $$;
CREATE TABLE purchase_invoices(id text PRIMARY KEY,store_id uuid NOT NULL,device_id uuid NOT NULL,"invoiceNumber" text NOT NULL,"supplierId" text NOT NULL,"supplierName" text,items jsonb NOT NULL DEFAULT '[]',"totalAmount" numeric NOT NULL DEFAULT 0,"paidAmount" numeric NOT NULL DEFAULT 0,"remainingAmount" numeric NOT NULL DEFAULT 0,"dueDate" text,status text NOT NULL DEFAULT 'unpaid',notes text,"createdAt" timestamptz NOT NULL DEFAULT now(),"updatedAt" timestamptz NOT NULL DEFAULT now(),updated_at bigint NOT NULL DEFAULT 0,sync_status text NOT NULL DEFAULT 'pending',deleted_at timestamptz,UNIQUE(store_id,"invoiceNumber"));
ALTER TABLE ledger_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY events_read ON ledger_events FOR SELECT USING(can_read_store_finance(store_id));
CREATE POLICY events_write ON ledger_events FOR INSERT WITH CHECK(is_store_member(store_id) AND CASE WHEN kind IN ('owner_capital','owner_contribution') THEN has_role(store_id,VARIADIC ARRAY['ADMIN']) ELSE has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT']) END);
CREATE POLICY lines_read ON ledger_lines FOR SELECT USING(can_read_store_finance(store_id));
CREATE POLICY lines_write ON ledger_lines FOR INSERT WITH CHECK(has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT']) AND EXISTS(SELECT 1 FROM ledger_events e WHERE e.id=ledger_lines.event_id AND e.store_id=ledger_lines.store_id AND e.xmin=pg_current_xact_id()::xid));
CREATE POLICY invoices_all ON purchase_invoices FOR ALL USING(has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT'])) WITH CHECK(has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT']));
CREATE POLICY suppliers_all ON suppliers FOR ALL USING(has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT'])) WITH CHECK(has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT']));
GRANT USAGE ON SCHEMA public,auth TO authenticated,anon;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public,auth TO authenticated;
