-- Minimal document tables for exercising the existing Production RPC bodies.
CREATE TABLE expenses(id text PRIMARY KEY, store_id uuid NOT NULL, device_id uuid NOT NULL,
 category text NOT NULL, amount numeric NOT NULL, description text, date timestamptz,
 ledger_event_id text UNIQUE, updated_at bigint, sync_status text, deleted_at timestamptz);
CREATE TABLE payroll(id text PRIMARY KEY, store_id uuid NOT NULL, device_id uuid NOT NULL,
 "employeeName" text NOT NULL, type text CHECK(type IN ('salary','bonus','advance')),
 amount numeric CHECK(amount>0), description text, date timestamptz, wallet text,
 ledger_event_id text UNIQUE, updated_at bigint, sync_status text, deleted_at timestamptz);
CREATE TABLE budget_caps(id text PRIMARY KEY, store_id uuid, category text, "capAmount" numeric, deleted_at timestamptz);
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_caps ENABLE ROW LEVEL SECURITY;
CREATE POLICY expense_access ON expenses TO authenticated USING(has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT'])) WITH CHECK(has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT']));
CREATE POLICY payroll_access ON payroll TO authenticated USING(has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT'])) WITH CHECK(has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT']));
CREATE POLICY caps_access ON budget_caps TO authenticated USING(has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT'])) WITH CHECK(has_role(store_id,VARIADIC ARRAY['ADMIN','ACCOUNTANT']));
GRANT SELECT,INSERT,UPDATE,DELETE ON expenses,payroll,budget_caps TO authenticated;
