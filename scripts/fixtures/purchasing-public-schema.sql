-- Read-only catalog snapshot of baseline 440d8ed (PostgreSQL 17.6): no row data.
-- Preserves actual public DDL, function bodies, RLS, grants and triggers.
-- auth.users is the minimal three-column local fixture; auth.uid reads claims.
-- This does not reproduce GoTrue, PostgREST or JWT signature verification.
-- Run only in a fresh synthetic local database; the test binds to loopback.
set check_function_bodies=off; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; REVOKE CREATE ON SCHEMA public FROM PUBLIC; CREATE SCHEMA auth; GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))::uuid $$;
CREATE TABLE public."courier_claims" ("id" text NOT NULL,"store_id" uuid NOT NULL,"order_id" text NOT NULL,"courier_id" text NOT NULL,"return_record_id" text,"amount_piastres" integer NOT NULL,"status" text DEFAULT 'pending'::text NOT NULL,"settlement_event_id" text,"notes" text,"created_at" timestamp with time zone DEFAULT now() NOT NULL,"submitted_at" timestamp with time zone,"decided_at" timestamp with time zone,"settled_at" timestamp with time zone,"created_by" uuid DEFAULT auth.uid(),"decided_by" uuid,"updated_at" bigint DEFAULT ((EXTRACT(epoch FROM now()) * (1000)::numeric))::bigint NOT NULL,"deleted_at" timestamp with time zone);
CREATE TABLE public."couriers" ("id" text NOT NULL,"name" text NOT NULL,"phone" text,"notes" text,"createdAt" timestamp with time zone,"updatedAt" timestamp with time zone,"store_id" uuid NOT NULL,"device_id" uuid NOT NULL,"sync_status" text DEFAULT 'pending'::text NOT NULL,"deleted_at" timestamp with time zone,"updated_at" bigint DEFAULT 0 NOT NULL);
CREATE TABLE public."store_activity" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,"store_id" uuid NOT NULL,"source" text NOT NULL,"created_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE TABLE public."users" ("id" uuid DEFAULT gen_random_uuid() NOT NULL,"username" text NOT NULL,"password_hash" text,"role" text DEFAULT 'ECOMMERCE_ONLY'::text NOT NULL,"is_active" boolean DEFAULT true NOT NULL,"must_change_password" boolean DEFAULT false NOT NULL,"store_id" uuid,"created_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE TABLE public."profiles" ("id" uuid NOT NULL,"is_pro" boolean DEFAULT false NOT NULL,"subscription_expiry" timestamp with time zone);
CREATE TABLE public."expenses" ("id" text NOT NULL,"category" text DEFAULT 'other'::text NOT NULL,"amount" numeric DEFAULT 0 NOT NULL,"description" text,"date" timestamp with time zone DEFAULT now() NOT NULL,"updated_at" bigint DEFAULT ((EXTRACT(epoch FROM now()) * (1000)::numeric))::bigint,"store_id" uuid,"device_id" uuid,"sync_status" text DEFAULT 'pending'::text NOT NULL,"deleted_at" timestamp with time zone,"ledger_event_id" text);
CREATE TABLE public."transactions" ("id" text NOT NULL,"type" text DEFAULT 'sale'::text NOT NULL,"amount" numeric DEFAULT 0 NOT NULL,"timestamp" timestamp with time zone DEFAULT now() NOT NULL,"partnerId" text,"category" text DEFAULT ''::text NOT NULL,"description" text,"updated_at" bigint DEFAULT ((EXTRACT(epoch FROM now()) * (1000)::numeric))::bigint,"store_id" uuid,"device_id" uuid,"sync_status" text DEFAULT 'pending'::text NOT NULL,"deleted_at" timestamp with time zone);
CREATE TABLE public."orders" ("id" text NOT NULL,"orderNumber" text NOT NULL,"customerName" text NOT NULL,"customerPhone" text NOT NULL,"address" text DEFAULT ''::text NOT NULL,"governorate" text,"items" jsonb DEFAULT '[]'::jsonb NOT NULL,"stockItems" jsonb DEFAULT '[]'::jsonb,"totalAmount" numeric DEFAULT 0 NOT NULL,"shippingFee" numeric DEFAULT 0 NOT NULL,"paymentMethod" text DEFAULT 'full_prepaid'::text NOT NULL,"depositAmount" numeric DEFAULT 0 NOT NULL,"expectedCod" numeric DEFAULT 0 NOT NULL,"status" text DEFAULT 'pending'::text NOT NULL,"courierId" text,"courierName" text,"courierFee" numeric DEFAULT 0 NOT NULL,"cogsAmount" numeric DEFAULT 0 NOT NULL,"createdAt" timestamp with time zone DEFAULT now() NOT NULL,"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,"revenueLogged" boolean DEFAULT false NOT NULL,"updated_at" bigint DEFAULT 0 NOT NULL,"store_id" uuid NOT NULL,"customerId" text,"city" text,"discountCodeId" text,"discountAmount" numeric DEFAULT 0 NOT NULL,"depositWallet" text,"codSettledAt" timestamp with time zone,"returnConfirmedAt" timestamp with time zone,"returnType" text,"isExchange" boolean DEFAULT false NOT NULL,"original_order_id" text,"wholesaleClientId" text,"device_id" uuid,"sync_status" text DEFAULT 'pending'::text NOT NULL,"deleted_at" timestamp with time zone,"shippingPenaltyApplied" boolean DEFAULT false NOT NULL,"return_cause" text DEFAULT 'unknown'::text NOT NULL,"wastedTripCompensation" numeric DEFAULT 0 NOT NULL);
CREATE TABLE public."store_licenses" ("store_id" uuid NOT NULL,"license_key" text NOT NULL,"plan_type" text DEFAULT 'BASIC'::text NOT NULL,"valid_until" timestamp with time zone NOT NULL,"status" text DEFAULT 'active'::text NOT NULL,"created_at" timestamp with time zone DEFAULT now() NOT NULL,"updated_at" timestamp with time zone DEFAULT now() NOT NULL,"notes" text,"activated_at" timestamp with time zone,"suspended_at" timestamp with time zone,"reactivated_at" timestamp with time zone,"updated_by" uuid);
CREATE TABLE public."store_members" ("user_id" uuid NOT NULL,"store_id" uuid NOT NULL,"role" character varying(50) NOT NULL,"created_at" timestamp with time zone DEFAULT now());
CREATE TABLE public."store_alias" ("old_store_id" uuid NOT NULL,"new_store_id" uuid NOT NULL,"rekeyed_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE TABLE public."wholesale_clients" ("id" text NOT NULL,"companyName" text NOT NULL,"contactPerson" text DEFAULT ''::text NOT NULL,"phone" text DEFAULT ''::text NOT NULL,"email" text,"notes" text,"createdAt" timestamp with time zone DEFAULT now() NOT NULL,"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,"store_id" uuid NOT NULL,"device_id" uuid NOT NULL,"sync_status" text DEFAULT 'pending'::text NOT NULL,"updated_at" bigint DEFAULT 0 NOT NULL,"deleted_at" timestamp with time zone);
CREATE TABLE public."stores" ("id" uuid NOT NULL,"name" text,"logo_url" text,"phone" text,"address" text,"tax_number" text,"vat_rate" numeric DEFAULT 0,"created_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE TABLE public."ledger_lines" ("id" text NOT NULL,"event_id" text NOT NULL,"store_id" uuid NOT NULL,"device_id" uuid NOT NULL,"account" text NOT NULL,"subject_id" text NOT NULL,"qty_delta" real DEFAULT 0 NOT NULL,"amount_delta" integer DEFAULT 0 NOT NULL,"unit_cost" integer,"sync_status" text DEFAULT 'pending'::text NOT NULL,"deleted_at" timestamp with time zone);
CREATE TABLE public."wholesale_invoices" ("id" text NOT NULL,"invoiceNumber" text NOT NULL,"clientId" text NOT NULL,"clientName" text DEFAULT ''::text NOT NULL,"items" jsonb DEFAULT '[]'::jsonb NOT NULL,"goodsTotal" numeric DEFAULT 0 NOT NULL,"discountAmount" numeric DEFAULT 0 NOT NULL,"totalAmount" numeric DEFAULT 0 NOT NULL,"paidAmount" numeric DEFAULT 0 NOT NULL,"remainingAmount" numeric DEFAULT 0 NOT NULL,"dueDate" text,"status" text DEFAULT 'unpaid'::text NOT NULL,"notes" text,"createdAt" timestamp with time zone DEFAULT now() NOT NULL,"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,"store_id" uuid NOT NULL,"device_id" uuid NOT NULL,"sync_status" text DEFAULT 'pending'::text NOT NULL,"updated_at" bigint DEFAULT 0 NOT NULL,"deleted_at" timestamp with time zone);
CREATE TABLE public."store_counters" ("store_id" uuid NOT NULL,"name" text NOT NULL,"value" bigint DEFAULT 0 NOT NULL);
CREATE TABLE public."ledger_events" ("id" text NOT NULL,"store_id" uuid NOT NULL,"device_id" uuid NOT NULL,"kind" text NOT NULL,"occurred_at" text NOT NULL,"created_at" text NOT NULL,"actor" text,"ref_type" text,"ref_id" text,"payload" text DEFAULT '{}'::text NOT NULL,"reversed_by" text,"sync_status" text DEFAULT 'pending'::text NOT NULL,"deleted_at" timestamp with time zone,"command_request" jsonb,"command_result" jsonb);
CREATE TABLE public."shipping_rates" ("id" text NOT NULL,"governorate" text NOT NULL,"delivery" numeric DEFAULT 0 NOT NULL,"return" numeric DEFAULT 0 NOT NULL,"exchange" numeric DEFAULT 0 NOT NULL,"createdAt" timestamp with time zone DEFAULT now() NOT NULL,"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,"store_id" uuid NOT NULL,"device_id" uuid NOT NULL,"sync_status" text DEFAULT 'pending'::text NOT NULL,"updated_at" bigint DEFAULT 0 NOT NULL,"deleted_at" timestamp with time zone);
CREATE TABLE public."products" ("id" text NOT NULL,"name" text NOT NULL,"sku" text NOT NULL,"image_url" text,"category" text DEFAULT ''::text NOT NULL,"description" text,"quantity" numeric DEFAULT 0 NOT NULL,"unitPrice" numeric DEFAULT 0 NOT NULL,"wholesale_price" numeric DEFAULT 0 NOT NULL,"minStockLevel" numeric,"maxStockLevel" numeric,"barcode" text,"isActive" boolean DEFAULT true,"isBundle" boolean DEFAULT false,"bundleItems" jsonb DEFAULT '[]'::jsonb,"updated_at" bigint DEFAULT 0 NOT NULL,"deleted_at" bigint,"store_id" uuid NOT NULL,"device_id" uuid NOT NULL,"sync_status" text DEFAULT 'pending'::text NOT NULL,"metadata" jsonb);
CREATE TABLE public."return_records" ("id" text NOT NULL,"original_order_id" text NOT NULL,"type" text NOT NULL,"customer_name" text NOT NULL,"customer_phone" text NOT NULL,"governorate" text NOT NULL,"returned_items" jsonb NOT NULL,"exchanged_item" jsonb,"pending_replacement" jsonb,"financial_difference" numeric NOT NULL,"processed_by" text NOT NULL,"notes" text,"created_at" timestamp with time zone,"store_id" uuid NOT NULL,"device_id" uuid NOT NULL,"sync_status" text DEFAULT 'pending'::text NOT NULL,"deleted_at" timestamp with time zone,"updated_at" bigint DEFAULT 0 NOT NULL,"return_cause" text DEFAULT 'unknown'::text NOT NULL);
CREATE TABLE public."discount_codes" ("id" text NOT NULL,"code" text NOT NULL,"type" text NOT NULL,"value" numeric NOT NULL,"active" boolean DEFAULT true NOT NULL,"maxUses" numeric,"expiryDate" timestamp with time zone,"createdAt" timestamp with time zone,"store_id" uuid NOT NULL,"device_id" uuid NOT NULL,"sync_status" text DEFAULT 'pending'::text NOT NULL,"deleted_at" timestamp with time zone,"updated_at" bigint DEFAULT 0 NOT NULL,"usedCount" integer DEFAULT 0 NOT NULL,"totalDiscount" numeric DEFAULT 0 NOT NULL);
CREATE TABLE public."partners" ("id" text NOT NULL,"store_id" uuid NOT NULL,"device_id" uuid,"name" text NOT NULL,"kind" text DEFAULT 'working'::text NOT NULL,"equityPercentage" numeric DEFAULT 0 NOT NULL,"status" text DEFAULT 'active'::text NOT NULL,"joinedDate" timestamp with time zone,"userId" text,"capitalContribution" numeric,"archived_at" bigint,"createdAt" timestamp with time zone DEFAULT now(),"updatedAt" timestamp with time zone DEFAULT now(),"updated_at" bigint,"sync_status" text);
CREATE TABLE public."auth_sessions" ("id" uuid DEFAULT gen_random_uuid() NOT NULL,"user_id" uuid NOT NULL,"username" text NOT NULL,"role" text NOT NULL,"machine_id" text NOT NULL,"token" text NOT NULL,"created_at" timestamp with time zone DEFAULT now() NOT NULL,"expires_at" timestamp with time zone NOT NULL,"revoked" boolean DEFAULT false NOT NULL,"revoked_at" timestamp with time zone,"ip_address" text,"user_agent" text);
CREATE TABLE public."fixed_assets" ("id" text NOT NULL,"store_id" uuid NOT NULL,"device_id" uuid,"name" text NOT NULL,"purchaseValue" numeric NOT NULL,"salvageValue" numeric DEFAULT 0 NOT NULL,"usefulLifeYears" numeric NOT NULL,"purchaseDate" timestamp with time zone NOT NULL,"monthlyDepreciation" numeric DEFAULT 0 NOT NULL,"isActive" boolean DEFAULT true NOT NULL,"paymentSource" text,"ledger_event_id" text,"createdAt" timestamp with time zone DEFAULT now(),"updated_at" bigint,"deleted_at" timestamp with time zone,"sync_status" text);
CREATE TABLE public."budget_caps" ("id" text NOT NULL,"store_id" uuid NOT NULL,"device_id" uuid,"category" text NOT NULL,"capAmount" numeric NOT NULL,"updated_at" bigint,"deleted_at" timestamp with time zone,"sync_status" text);
CREATE TABLE public."customers" ("id" text NOT NULL,"name" text NOT NULL,"phone" text NOT NULL,"address" text NOT NULL,"store_id" uuid NOT NULL,"device_id" uuid NOT NULL,"sync_status" text DEFAULT 'pending'::text NOT NULL,"deleted_at" timestamp with time zone,"updated_at" bigint DEFAULT 0 NOT NULL,"returned_orders_count" integer DEFAULT 0 NOT NULL);
CREATE TABLE public."auth_login_attempts" ("id" uuid DEFAULT gen_random_uuid() NOT NULL,"timestamp" timestamp with time zone DEFAULT now() NOT NULL,"username" text NOT NULL,"machine_id" text NOT NULL,"ip_address" text,"success" boolean NOT NULL,"reason" text,"user_agent" text);
CREATE TABLE public."suppliers" ("id" text NOT NULL,"companyName" text NOT NULL,"contactPerson" text NOT NULL,"phone" text NOT NULL,"email" text,"address" text,"taxId" text,"notes" text,"createdAt" timestamp with time zone,"updatedAt" timestamp with time zone,"store_id" uuid NOT NULL,"device_id" uuid NOT NULL,"sync_status" text DEFAULT 'pending'::text NOT NULL,"deleted_at" timestamp with time zone,"updated_at" bigint DEFAULT 0 NOT NULL);
CREATE TABLE public."branches" ("id" text NOT NULL,"name" text NOT NULL,"code" text NOT NULL,"address" text,"phone" text,"isActive" boolean DEFAULT true,"createdAt" timestamp with time zone DEFAULT now(),"store_id" uuid NOT NULL,"device_id" uuid NOT NULL,"sync_status" text DEFAULT 'pending'::text NOT NULL,"deleted_at" timestamp with time zone,"updated_at" bigint DEFAULT 0 NOT NULL);
CREATE TABLE public."purchase_invoices" ("id" text NOT NULL,"invoiceNumber" text NOT NULL,"supplierId" text NOT NULL,"supplierName" text DEFAULT ''::text NOT NULL,"items" jsonb DEFAULT '[]'::jsonb NOT NULL,"totalAmount" numeric DEFAULT 0 NOT NULL,"paidAmount" numeric DEFAULT 0 NOT NULL,"remainingAmount" numeric DEFAULT 0 NOT NULL,"dueDate" text,"status" text DEFAULT 'unpaid'::text NOT NULL,"notes" text,"createdAt" timestamp with time zone DEFAULT now() NOT NULL,"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,"store_id" uuid NOT NULL,"device_id" uuid NOT NULL,"sync_status" text DEFAULT 'pending'::text NOT NULL,"updated_at" bigint DEFAULT 0 NOT NULL,"deleted_at" timestamp with time zone);
CREATE TABLE public."payroll" ("id" text NOT NULL,"store_id" uuid NOT NULL,"device_id" uuid,"employeeName" text NOT NULL,"type" text DEFAULT 'salary'::text NOT NULL,"amount" numeric NOT NULL,"description" text,"date" timestamp with time zone NOT NULL,"wallet" text,"ledger_event_id" text,"createdAt" timestamp with time zone DEFAULT now(),"updated_at" bigint,"deleted_at" timestamp with time zone,"sync_status" text);
CREATE TABLE public."owner_budgets" ("store_id" uuid NOT NULL,"budget_limit" numeric NOT NULL,"period_type" text NOT NULL,"started_at" timestamp with time zone NOT NULL,"created_at" timestamp with time zone DEFAULT now() NOT NULL,"updated_at" timestamp with time zone DEFAULT now() NOT NULL);
ALTER TABLE public."courier_claims" ADD CONSTRAINT "courier_claims_amount_piastres_check" CHECK ((amount_piastres > 0));
ALTER TABLE public."courier_claims" ADD CONSTRAINT "courier_claims_pkey" PRIMARY KEY (id);
ALTER TABLE public."courier_claims" ADD CONSTRAINT "courier_claims_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'submitted'::text, 'approved'::text, 'rejected'::text, 'settled'::text])));
ALTER TABLE public."couriers" ADD CONSTRAINT "couriers_pkey" PRIMARY KEY (id);
ALTER TABLE public."store_activity" ADD CONSTRAINT "store_activity_pkey" PRIMARY KEY (id);
ALTER TABLE public."store_activity" ADD CONSTRAINT "store_activity_source_check" CHECK ((source = ANY (ARRAY['orders'::text, 'ledger_events'::text])));
ALTER TABLE public."users" ADD CONSTRAINT "users_pkey" PRIMARY KEY (id);
ALTER TABLE public."users" ADD CONSTRAINT "users_username_key" UNIQUE (username);
ALTER TABLE public."profiles" ADD CONSTRAINT "profiles_pkey" PRIMARY KEY (id);
ALTER TABLE public."expenses" ADD CONSTRAINT "expenses_category_check" CHECK ((category = ANY (ARRAY['rent'::text, 'utilities'::text, 'salaries'::text, 'transport'::text, 'maintenance'::text, 'marketing'::text, 'office_supplies'::text, 'shipping'::text, 'store_rent'::text, 'other'::text])));
ALTER TABLE public."expenses" ADD CONSTRAINT "expenses_pkey" PRIMARY KEY (id);
ALTER TABLE public."transactions" ADD CONSTRAINT "transactions_pkey" PRIMARY KEY (id);
ALTER TABLE public."transactions" ADD CONSTRAINT "transactions_type_check" CHECK ((type = ANY (ARRAY['sale'::text, 'expense'::text])));
ALTER TABLE public."orders" ADD CONSTRAINT "orders_paymentMethod_check" CHECK (("paymentMethod" = ANY (ARRAY['full_prepaid'::text, 'partial_cod'::text])));
ALTER TABLE public."orders" ADD CONSTRAINT "orders_pkey" PRIMARY KEY (id);
ALTER TABLE public."orders" ADD CONSTRAINT "orders_return_cause_check" CHECK ((return_cause = ANY (ARRAY['customer'::text, 'courier'::text, 'shop'::text, 'unknown'::text])));
ALTER TABLE public."orders" ADD CONSTRAINT "orders_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'shipped'::text, 'delivered'::text, 'returned'::text, 'cancelled'::text])));
ALTER TABLE public."orders" ADD CONSTRAINT "orders_wasted_trip_compensation_nonnegative" CHECK (("wastedTripCompensation" >= (0)::numeric));
ALTER TABLE public."store_licenses" ADD CONSTRAINT "store_licenses_license_key_key" UNIQUE (license_key);
ALTER TABLE public."store_licenses" ADD CONSTRAINT "store_licenses_pkey" PRIMARY KEY (store_id);
ALTER TABLE public."store_licenses" ADD CONSTRAINT "store_licenses_plan_check" CHECK ((plan_type = ANY (ARRAY['BASIC'::text, 'PRO'::text])));
ALTER TABLE public."store_licenses" ADD CONSTRAINT "store_licenses_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'expired'::text, 'suspended'::text])));
ALTER TABLE public."store_members" ADD CONSTRAINT "store_members_pkey" PRIMARY KEY (user_id, store_id);
ALTER TABLE public."store_members" ADD CONSTRAINT "store_members_role_check" CHECK (((role)::text = ANY (ARRAY['ADMIN'::text, 'POS_ECOMMERCE'::text, 'ECOMMERCE_ONLY'::text, 'ACCOUNTANT'::text, 'MODERATOR'::text])));
ALTER TABLE public."store_alias" ADD CONSTRAINT "store_alias_pkey" PRIMARY KEY (old_store_id);
ALTER TABLE public."wholesale_clients" ADD CONSTRAINT "wholesale_clients_pkey" PRIMARY KEY (id);
ALTER TABLE public."stores" ADD CONSTRAINT "stores_pkey" PRIMARY KEY (id);
ALTER TABLE public."ledger_lines" ADD CONSTRAINT "ledger_lines_pkey" PRIMARY KEY (id);
ALTER TABLE public."wholesale_invoices" ADD CONSTRAINT "wholesale_invoices_pkey" PRIMARY KEY (id);
ALTER TABLE public."wholesale_invoices" ADD CONSTRAINT "wholesale_invoices_status_check" CHECK ((status = ANY (ARRAY['paid'::text, 'partial'::text, 'unpaid'::text, 'overdue'::text])));
ALTER TABLE public."store_counters" ADD CONSTRAINT "store_counters_pkey" PRIMARY KEY (store_id, name);
ALTER TABLE public."ledger_events" ADD CONSTRAINT "ledger_events_pkey" PRIMARY KEY (id);
ALTER TABLE public."shipping_rates" ADD CONSTRAINT "shipping_rates_pkey" PRIMARY KEY (id);
ALTER TABLE public."products" ADD CONSTRAINT "products_pkey" PRIMARY KEY (id);
ALTER TABLE public."return_records" ADD CONSTRAINT "return_records_pkey" PRIMARY KEY (id);
ALTER TABLE public."return_records" ADD CONSTRAINT "return_records_return_cause_check" CHECK ((return_cause = ANY (ARRAY['customer'::text, 'courier'::text, 'shop'::text, 'unknown'::text])));
ALTER TABLE public."discount_codes" ADD CONSTRAINT "discount_codes_pkey" PRIMARY KEY (id);
ALTER TABLE public."partners" ADD CONSTRAINT "partners_equityPercentage_check" CHECK ((("equityPercentage" >= (0)::numeric) AND ("equityPercentage" <= (100)::numeric)));
ALTER TABLE public."partners" ADD CONSTRAINT "partners_pkey" PRIMARY KEY (id);
ALTER TABLE public."auth_sessions" ADD CONSTRAINT "auth_sessions_pkey" PRIMARY KEY (id);
ALTER TABLE public."auth_sessions" ADD CONSTRAINT "auth_sessions_token_key" UNIQUE (token);
ALTER TABLE public."fixed_assets" ADD CONSTRAINT "fixed_assets_pkey" PRIMARY KEY (id);
ALTER TABLE public."fixed_assets" ADD CONSTRAINT "fixed_assets_purchaseValue_check" CHECK (("purchaseValue" > (0)::numeric));
ALTER TABLE public."fixed_assets" ADD CONSTRAINT "fixed_assets_salvageValue_check" CHECK (("salvageValue" >= (0)::numeric));
ALTER TABLE public."fixed_assets" ADD CONSTRAINT "fixed_assets_usefulLifeYears_check" CHECK (("usefulLifeYears" > (0)::numeric));
ALTER TABLE public."budget_caps" ADD CONSTRAINT "budget_caps_capAmount_check" CHECK (("capAmount" > (0)::numeric));
ALTER TABLE public."budget_caps" ADD CONSTRAINT "budget_caps_pkey" PRIMARY KEY (id);
ALTER TABLE public."customers" ADD CONSTRAINT "customers_pkey" PRIMARY KEY (id);
ALTER TABLE public."auth_login_attempts" ADD CONSTRAINT "auth_login_attempts_pkey" PRIMARY KEY (id);
ALTER TABLE public."suppliers" ADD CONSTRAINT "suppliers_pkey" PRIMARY KEY (id);
ALTER TABLE public."branches" ADD CONSTRAINT "branches_pkey" PRIMARY KEY (id);
ALTER TABLE public."purchase_invoices" ADD CONSTRAINT "purchase_invoices_pkey" PRIMARY KEY (id);
ALTER TABLE public."payroll" ADD CONSTRAINT "payroll_amount_check" CHECK ((amount > (0)::numeric));
ALTER TABLE public."payroll" ADD CONSTRAINT "payroll_pkey" PRIMARY KEY (id);
ALTER TABLE public."payroll" ADD CONSTRAINT "payroll_type_check" CHECK ((type = ANY (ARRAY['salary'::text, 'bonus'::text, 'advance'::text])));
ALTER TABLE public."owner_budgets" ADD CONSTRAINT "owner_budgets_budget_limit_check" CHECK (((budget_limit > (0)::numeric) AND (budget_limit < ('1000000000000'::bigint)::numeric) AND (budget_limit = round(budget_limit, 2))));
ALTER TABLE public."owner_budgets" ADD CONSTRAINT "owner_budgets_period_type_check" CHECK ((period_type = ANY (ARRAY['monthly'::text, 'open'::text])));
ALTER TABLE public."owner_budgets" ADD CONSTRAINT "owner_budgets_pkey" PRIMARY KEY (store_id);
ALTER TABLE public."owner_budgets" ADD CONSTRAINT "owner_budgets_started_at_check" CHECK (isfinite(started_at));
ALTER TABLE public."courier_claims" ADD CONSTRAINT "courier_claims_courier_id_fkey" FOREIGN KEY (courier_id) REFERENCES couriers(id);
ALTER TABLE public."courier_claims" ADD CONSTRAINT "courier_claims_order_id_fkey" FOREIGN KEY (order_id) REFERENCES orders(id);
ALTER TABLE public."courier_claims" ADD CONSTRAINT "courier_claims_return_record_id_fkey" FOREIGN KEY (return_record_id) REFERENCES return_records(id);
ALTER TABLE public."courier_claims" ADD CONSTRAINT "courier_claims_settlement_event_id_fkey" FOREIGN KEY (settlement_event_id) REFERENCES ledger_events(id);
ALTER TABLE public."courier_claims" ADD CONSTRAINT "courier_claims_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id);
ALTER TABLE public."couriers" ADD CONSTRAINT "couriers_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;
ALTER TABLE public."store_licenses" ADD CONSTRAINT "store_licenses_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;
ALTER TABLE public."store_members" ADD CONSTRAINT "store_members_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;
ALTER TABLE public."store_members" ADD CONSTRAINT "store_members_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public."ledger_lines" ADD CONSTRAINT "ledger_lines_event_id_fkey" FOREIGN KEY (event_id) REFERENCES ledger_events(id);
ALTER TABLE public."ledger_events" ADD CONSTRAINT "ledger_events_reversed_by_fkey" FOREIGN KEY (reversed_by) REFERENCES ledger_events(id);
ALTER TABLE public."partners" ADD CONSTRAINT "partners_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;
ALTER TABLE public."auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public."fixed_assets" ADD CONSTRAINT "fixed_assets_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;
ALTER TABLE public."budget_caps" ADD CONSTRAINT "budget_caps_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;
ALTER TABLE public."payroll" ADD CONSTRAINT "payroll_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;
ALTER TABLE public."owner_budgets" ADD CONSTRAINT "owner_budgets_store_id_fkey" FOREIGN KEY (store_id) REFERENCES stores(id);
CREATE UNIQUE INDEX courier_claims_one_open_per_order ON public.courier_claims USING btree (order_id) WHERE ((deleted_at IS NULL) AND (status <> 'rejected'::text));
CREATE INDEX courier_claims_by_courier ON public.courier_claims USING btree (store_id, courier_id, status);
CREATE UNIQUE INDEX couriers_name_per_store ON public.couriers USING btree (store_id, lower(name)) WHERE (deleted_at IS NULL);
CREATE INDEX idx_couriers_store ON public.couriers USING btree (store_id);
CREATE INDEX store_activity_store_created_idx ON public.store_activity USING btree (store_id, created_at);
CREATE INDEX idx_expenses_updated_at ON public.expenses USING btree (updated_at);
CREATE INDEX expenses_store_idx ON public.expenses USING btree (store_id);
CREATE UNIQUE INDEX expenses_one_event ON public.expenses USING btree (ledger_event_id) WHERE (ledger_event_id IS NOT NULL);
CREATE INDEX idx_transactions_updated_at ON public.transactions USING btree (updated_at);
CREATE INDEX idx_transactions_type ON public.transactions USING btree (type);
CREATE INDEX transactions_store_idx ON public.transactions USING btree (store_id);
CREATE INDEX idx_orders_updated_at ON public.orders USING btree (updated_at);
CREATE INDEX idx_orders_status ON public.orders USING btree (status);
CREATE UNIQUE INDEX orders_number_per_store ON public.orders USING btree (store_id, "orderNumber");
CREATE INDEX idx_orders_store ON public.orders USING btree (store_id);
CREATE INDEX orders_customer_idx ON public.orders USING btree (store_id, "customerId");
CREATE INDEX orders_updated_idx ON public.orders USING btree (store_id, updated_at);
CREATE INDEX store_licenses_valid_until_idx ON public.store_licenses USING btree (valid_until);
CREATE INDEX idx_store_licenses_valid_until ON public.store_licenses USING btree (valid_until);
CREATE UNIQUE INDEX store_members_one_store_per_user ON public.store_members USING btree (user_id);
CREATE INDEX idx_store_members_user ON public.store_members USING btree (user_id);
CREATE INDEX wholesale_clients_store_idx ON public.wholesale_clients USING btree (store_id);
CREATE INDEX wholesale_clients_updated_idx ON public.wholesale_clients USING btree (store_id, updated_at);
CREATE INDEX idx_ledger_lines_account_subject ON public.ledger_lines USING btree (store_id, account, subject_id);
CREATE INDEX idx_ledger_lines_event ON public.ledger_lines USING btree (event_id);
CREATE INDEX idx_lines_account_subject ON public.ledger_lines USING btree (store_id, account, subject_id);
CREATE INDEX idx_lines_event ON public.ledger_lines USING btree (event_id);
CREATE INDEX wholesale_invoices_store_idx ON public.wholesale_invoices USING btree (store_id);
CREATE INDEX wholesale_invoices_client_idx ON public.wholesale_invoices USING btree (store_id, "clientId");
CREATE INDEX wholesale_invoices_updated_idx ON public.wholesale_invoices USING btree (store_id, updated_at);
CREATE UNIQUE INDEX wholesale_invoices_number_per_store ON public.wholesale_invoices USING btree (store_id, "invoiceNumber");
CREATE INDEX idx_ledger_events_ref ON public.ledger_events USING btree (store_id, ref_type, created_at DESC);
CREATE INDEX idx_ledger_events_kind ON public.ledger_events USING btree (store_id, kind, occurred_at DESC);
CREATE INDEX idx_events_sync ON public.ledger_events USING btree (sync_status);
CREATE INDEX idx_events_occurred ON public.ledger_events USING btree (store_id, occurred_at);
CREATE INDEX idx_events_ref ON public.ledger_events USING btree (ref_type, ref_id);
CREATE UNIQUE INDEX ledger_events_one_transfer_op ON public.ledger_events USING btree (store_id, ref_id) WHERE ((kind = 'wallet_transfer'::text) AND (ref_id IS NOT NULL));
CREATE INDEX shipping_rates_store_idx ON public.shipping_rates USING btree (store_id);
CREATE INDEX shipping_rates_updated_idx ON public.shipping_rates USING btree (store_id, updated_at);
CREATE UNIQUE INDEX shipping_rates_governorate_per_store ON public.shipping_rates USING btree (store_id, lower(btrim(governorate))) WHERE (deleted_at IS NULL);
CREATE INDEX idx_products_updated_at ON public.products USING btree (updated_at);
CREATE INDEX idx_products_store ON public.products USING btree (store_id);
CREATE INDEX idx_return_records_updated_at ON public.return_records USING btree (updated_at);
CREATE INDEX idx_return_records_store ON public.return_records USING btree (store_id);
CREATE INDEX idx_discount_codes_updated_at ON public.discount_codes USING btree (updated_at);
CREATE INDEX idx_discount_codes_store ON public.discount_codes USING btree (store_id);
CREATE INDEX idx_partners_store ON public.partners USING btree (store_id);
CREATE INDEX idx_auth_sessions_token ON public.auth_sessions USING btree (token);
CREATE INDEX idx_auth_sessions_user ON public.auth_sessions USING btree (user_id);
CREATE INDEX idx_auth_sessions_active ON public.auth_sessions USING btree (revoked, expires_at);
CREATE INDEX idx_fixed_assets_store ON public.fixed_assets USING btree (store_id);
CREATE UNIQUE INDEX budget_caps_category_per_store ON public.budget_caps USING btree (store_id, category) WHERE (deleted_at IS NULL);
CREATE INDEX idx_customers_updated_at ON public.customers USING btree (updated_at);
CREATE INDEX idx_customers_store ON public.customers USING btree (store_id);
CREATE INDEX idx_login_attempts_user ON public.auth_login_attempts USING btree (username, "timestamp" DESC);
CREATE INDEX idx_suppliers_updated_at ON public.suppliers USING btree (updated_at);
CREATE INDEX idx_suppliers_store ON public.suppliers USING btree (store_id);
CREATE INDEX idx_branches_updated_at ON public.branches USING btree (updated_at);
CREATE INDEX idx_branches_store ON public.branches USING btree (store_id);
CREATE INDEX purchase_invoices_store_idx ON public.purchase_invoices USING btree (store_id);
CREATE INDEX purchase_invoices_supplier_idx ON public.purchase_invoices USING btree (store_id, "supplierId");
CREATE INDEX purchase_invoices_updated_idx ON public.purchase_invoices USING btree (store_id, updated_at);
CREATE UNIQUE INDEX purchase_invoices_number_per_store ON public.purchase_invoices USING btree (store_id, "invoiceNumber");
CREATE INDEX idx_payroll_store ON public.payroll USING btree (store_id);
CREATE UNIQUE INDEX payroll_one_event ON public.payroll USING btree (ledger_event_id) WHERE (ledger_event_id IS NOT NULL);
CREATE OR REPLACE FUNCTION public.canonical_wallet_subject(p_subject text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE lower(coalesce(p_subject, ''))
           WHEN 'instoresafe'  THEN 'inStoreSafe'
           WHEN 'vodafonecash' THEN 'vodafoneCash'
           WHEN 'instapay'     THEN 'instaPay'
           WHEN 'bankaccount'  THEN 'bankAccount'
           ELSE p_subject
         END
$function$
;
CREATE OR REPLACE FUNCTION public.stamp_owner_budget()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN NEW.created_at := OLD.created_at; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.ledger_balances(p_store uuid, p_account text, p_kind text DEFAULT NULL::text, p_subject_id text DEFAULT NULL::text, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(subject_id text, qty numeric, amount bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT l.subject_id,
         sum(l.qty_delta::numeric) AS qty,
         sum(l.amount_delta)::bigint AS amount
  FROM public.ledger_lines  l
  JOIN public.ledger_events e ON e.id = l.event_id
  WHERE l.store_id = p_store
    AND l.account  = p_account
    AND (p_kind       IS NULL OR e.kind       = p_kind)
    AND (p_subject_id IS NULL OR l.subject_id = p_subject_id)
    AND (p_from IS NULL OR e.occurred_at::timestamptz >= p_from)
    AND (p_to   IS NULL OR e.occurred_at::timestamptz <  p_to)
  GROUP BY l.subject_id
$function$
;
CREATE OR REPLACE FUNCTION public.owner_financial_summary(p_store uuid, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_revenue  bigint;
  v_cogs     bigint;
  v_expenses bigint;
  v_returns  bigint;
  v_stock    bigint;
  v_channels jsonb;
  v_wallets  jsonb;
  v_supplier jsonb;
  v_recv_cur jsonb;
  v_pay_cur  jsonb;
  v_recv_cli bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;
  IF public.member_role(p_store) IS NULL THEN
    RAISE EXCEPTION 'not a member of this store' USING ERRCODE = '42501';
  END IF;
  IF public.member_role(p_store) <> 'ADMIN' THEN
    RAISE EXCEPTION 'owner financial reporting is ADMIN only' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(sum(b.amount), 0) INTO v_revenue
    FROM public.ledger_balances(p_store, 'revenue', NULL, NULL, p_from, p_to) b;
  SELECT coalesce(sum(b.amount), 0) INTO v_cogs
    FROM public.ledger_balances(p_store, 'cogs', NULL, NULL, p_from, p_to) b;
  SELECT coalesce(sum(b.amount), 0) INTO v_expenses
    FROM public.ledger_balances(p_store, 'expense', NULL, NULL, p_from, p_to) b;
  SELECT coalesce(sum(b.amount), 0) INTO v_returns
    FROM public.ledger_balances(p_store, 'revenue', 'return_confirmed', NULL, p_from, p_to) b;

  SELECT coalesce(
           jsonb_agg(jsonb_build_object('subjectId', b.subject_id, 'amount', b.amount)
                     ORDER BY b.amount DESC),
           '[]'::jsonb)
    INTO v_channels
    FROM public.ledger_balances(p_store, 'revenue', NULL, NULL, p_from, p_to) b;

  SELECT coalesce(sum(b.amount), 0) INTO v_stock
    FROM public.ledger_balances(p_store, 'stock') b;
  SELECT coalesce(sum(b.amount), 0) INTO v_recv_cli
    FROM public.ledger_balances(p_store, 'receivable_client') b;

  SELECT coalesce(
           jsonb_agg(jsonb_build_object('subjectId', w.key, 'amount', w.amount) ORDER BY w.key),
           '[]'::jsonb)
    INTO v_wallets
    FROM (
      SELECT public.canonical_wallet_subject(b.subject_id) AS key, sum(b.amount) AS amount
      FROM public.ledger_balances(p_store, 'wallet') b
      GROUP BY 1
    ) w;

  SELECT coalesce(
           jsonb_agg(jsonb_build_object('subjectId', b.subject_id, 'amount', b.amount)
                     ORDER BY b.amount DESC),
           '[]'::jsonb)
    INTO v_supplier
    FROM public.ledger_balances(p_store, 'payable_supplier') b;

  SELECT coalesce(
           jsonb_agg(jsonb_build_object('subjectId', b.subject_id, 'amount', b.amount)
                     ORDER BY b.amount DESC),
           '[]'::jsonb)
    INTO v_recv_cur
    FROM public.ledger_balances(p_store, 'receivable_courier') b;

  SELECT coalesce(
           jsonb_agg(jsonb_build_object('subjectId', b.subject_id, 'amount', b.amount)
                     ORDER BY b.amount DESC),
           '[]'::jsonb)
    INTO v_pay_cur
    FROM public.ledger_balances(p_store, 'payable_courier') b;

  RETURN jsonb_build_object(
    'unit',              'piastres',
    'storeId',           p_store,
    'from',              p_from,
    'to',                p_to,
    'revenue',           v_revenue,
    'cogs',              v_cogs,
    'grossProfit',       v_revenue - v_cogs,
    'expenses',          v_expenses,
    'netProfit',         v_revenue - v_cogs - v_expenses,
    'returnsValue',      -v_returns,
    'salesByChannel',    v_channels,
    'stockValue',        v_stock,
    'walletBalances',    v_wallets,
    'supplierPayable',   v_supplier,
    'courierReceivable', v_recv_cur,
    'courierPayable',    v_pay_cur,
    'receivableClient',  v_recv_cli
  );
END;
$function$
;
CREATE OR REPLACE FUNCTION public.record_expense(p_expense jsonb, p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id       text := p_expense ->> 'id';
  v_store    uuid := (p_expense ->> 'store_id')::uuid;
  v_category text := p_expense ->> 'category';
  v_amount   numeric := (p_expense ->> 'amount')::numeric;
  v_row      jsonb;
  v_cap      numeric;
  v_spent    numeric;
  v_booked   bigint;
BEGIN
  IF v_id IS NULL OR v_store IS NULL OR NULLIF(v_category, '') IS NULL OR v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'NEXUS_DOCUMENT_INVALID' USING ERRCODE = '23514';
  END IF;

  -- A retry after a lost answer: the expense is already paid. Say so.
  SELECT to_jsonb(x.*) INTO v_row FROM public.expenses x WHERE x.id = v_id AND x.store_id = v_store;
  IF v_row IS NOT NULL THEN
    RETURN jsonb_build_object('expense', v_row, 'replayed', true);
  END IF;

  -- The event must be THIS expense: same store, pointing at this document, and
  -- booking exactly this amount to exactly this category.
  SELECT COALESCE(SUM((l ->> 'amount_delta')::bigint), 0) INTO v_booked
    FROM jsonb_array_elements(COALESCE(p_event -> 'lines', '[]'::jsonb)) l
   WHERE l ->> 'account' = 'expense' AND l ->> 'subject_id' = v_category;
  IF p_event ->> 'kind' IS DISTINCT FROM 'expense'
     OR (p_event ->> 'store_id')::uuid IS DISTINCT FROM v_store
     OR p_event ->> 'ref_type' IS DISTINCT FROM 'expense'
     OR p_event ->> 'ref_id' IS DISTINCT FROM v_id
     OR v_booked <> round(v_amount * 100) THEN
    RAISE EXCEPTION 'NEXUS_EVENT_NOT_THIS_DOCUMENT' USING ERRCODE = '23514';
  END IF;

  -- The cap, before anything moves. Locked, so two devices spending the last
  -- of a budget at once cannot both pass.
  SELECT c."capAmount" INTO v_cap FROM public.budget_caps c
   WHERE c.store_id = v_store AND c.category = v_category AND c.deleted_at IS NULL
   FOR UPDATE;
  IF v_cap IS NOT NULL THEN
    SELECT COALESCE(SUM(e.amount), 0) INTO v_spent FROM public.expenses e
     WHERE e.store_id = v_store AND e.category = v_category AND e.deleted_at IS NULL;
    IF v_category = 'salaries' THEN
      v_spent := v_spent + (SELECT COALESCE(SUM(p.amount), 0) FROM public.payroll p
                             WHERE p.store_id = v_store AND p.deleted_at IS NULL);
    END IF;
    IF v_spent + v_amount > v_cap THEN
      RAISE EXCEPTION 'NEXUS_OVER_BUDGET' USING ERRCODE = '23514',
        DETAIL = format('cap %s, spent %s, requested %s', v_cap, v_spent, v_amount);
    END IF;
  END IF;

  INSERT INTO public.expenses (id, store_id, device_id, category, amount, description, date,
                               ledger_event_id, updated_at, sync_status)
  VALUES (v_id, v_store, (p_expense ->> 'device_id')::uuid, v_category, v_amount,
          p_expense ->> 'description', COALESCE((p_expense ->> 'date')::timestamptz, now()),
          p_event ->> 'id', (extract(epoch FROM clock_timestamp()) * 1000)::bigint, 'synced')
  RETURNING to_jsonb(expenses.*) INTO v_row;

  PERFORM public.ledger_append(p_event);
  RETURN jsonb_build_object('expense', v_row, 'replayed', false);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.can_read_store_finance(p_store_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    public.member_role(p_store_id) = ANY (ARRAY['ADMIN', 'ACCOUNTANT', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY']),
    false
  );
$function$
;
CREATE OR REPLACE FUNCTION public.strip_line_cost(p_lines jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(p_lines) = 'array' THEN COALESCE(
      (SELECT jsonb_agg(CASE WHEN jsonb_typeof(e) = 'object' THEN e - 'unitCost' ELSE e END ORDER BY ord)
         FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS t(e, ord)),
      '[]'::jsonb)
    ELSE p_lines
  END;
$function$
;
CREATE OR REPLACE FUNCTION public.mobile_stock_quantities(p_product_ids text[])
 RETURNS TABLE(product_id text, qty numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT l.subject_id, sum(l.qty_delta::numeric)
  FROM public.ledger_lines l
  JOIN public.ledger_events e ON e.id = l.event_id
  WHERE l.store_id = (SELECT m.store_id FROM public.store_members m WHERE m.user_id = auth.uid())
    AND l.account = 'stock'
    AND l.subject_id = ANY (p_product_ids)
  GROUP BY l.subject_id;
$function$
;
CREATE OR REPLACE FUNCTION public.mobile_order_timeline(p_order_number text)
 RETURNS TABLE(id text, kind text, occurred_at text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.id::text, e.kind::text, e.occurred_at::text
  FROM public.ledger_events e
  WHERE e.store_id = (SELECT m.store_id FROM public.store_members m WHERE m.user_id = auth.uid())
    AND e.ref_type = 'ecommerce_order'
    AND e.ref_id = p_order_number
  ORDER BY e.occurred_at::timestamptz DESC
  LIMIT 200;
$function$
;
CREATE OR REPLACE FUNCTION public.signal_store_activity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_store uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.store_id ELSE NEW.store_id END;
BEGIN
  IF v_store IS NOT NULL THEN
    INSERT INTO public.store_activity (store_id, source) VALUES (v_store, TG_ARGV[0]);
    DELETE FROM public.store_activity
     WHERE store_id = v_store AND created_at < now() - interval '1 hour';
  END IF;
  RETURN NULL;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.ledger_events_page(p_store uuid, p_kind text DEFAULT NULL::text, p_ref_type text DEFAULT NULL::text, p_ref_id text DEFAULT NULL::text, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 200)
 RETURNS SETOF ledger_events
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.*
  FROM public.ledger_events e
  WHERE e.store_id = p_store
    AND (p_kind     IS NULL OR e.kind     = p_kind)
    AND (p_ref_type IS NULL OR e.ref_type = p_ref_type)
    AND (p_ref_id   IS NULL OR e.ref_id   = p_ref_id)
    AND (p_from IS NULL OR e.occurred_at::timestamptz >= p_from)
    AND (p_to   IS NULL OR e.occurred_at::timestamptz <  p_to)
  ORDER BY e.occurred_at::timestamptz DESC
  LIMIT GREATEST(COALESCE(p_limit, 200), 0)
$function$
;
CREATE OR REPLACE FUNCTION public.record_wallet_transfer(p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_store uuid := (p_event ->> 'store_id')::uuid;
  v_op    text := p_event ->> 'ref_id';
  v_id    text;
BEGIN
  IF p_event ->> 'kind' IS DISTINCT FROM 'wallet_transfer'
     OR p_event ->> 'ref_type' IS DISTINCT FROM 'wallet_transfer'
     OR v_store IS NULL OR NULLIF(v_op, '') IS NULL THEN
    RAISE EXCEPTION 'NEXUS_TRANSFER_INVALID' USING ERRCODE = '23514';
  END IF;

  -- One attempt per operation at a time: a double submit waits here, then
  -- finds the first one's event below.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_store::text || '|wallet_transfer|' || v_op, 0));

  SELECT e.id INTO v_id FROM public.ledger_events e
   WHERE e.store_id = v_store AND e.kind = 'wallet_transfer' AND e.ref_id = v_op;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('event_id', v_id, 'replayed', true);
  END IF;

  v_id := public.ledger_append(p_event);
  RETURN jsonb_build_object('event_id', v_id, 'replayed', false);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.wallet_transfer_history(p_store uuid, p_limit integer DEFAULT 50)
 RETURNS TABLE(id text, occurred_at timestamp with time zone, actor text, notes text, from_wallet text, to_wallet text, amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.id,
         e.occurred_at::timestamptz,
         e.actor,
         -- `payload` is a TEXT column holding JSON (ledger_append writes it so).
         CASE WHEN e.payload ~ '^\s*\{' THEN NULLIF(e.payload::jsonb ->> 'notes', '') END,
         (SELECT l.subject_id FROM public.ledger_lines l
           WHERE l.event_id = e.id AND l.account = 'wallet' AND l.amount_delta < 0 LIMIT 1),
         (SELECT l.subject_id FROM public.ledger_lines l
           WHERE l.event_id = e.id AND l.account = 'wallet' AND l.amount_delta > 0 LIMIT 1),
         (SELECT COALESCE(SUM(l.amount_delta), 0) FROM public.ledger_lines l
           WHERE l.event_id = e.id AND l.account = 'wallet' AND l.amount_delta > 0)::numeric / 100
    FROM public.ledger_events e
   WHERE e.store_id = p_store AND e.kind = 'wallet_transfer'
   ORDER BY e.occurred_at::timestamptz DESC, e.id
   LIMIT GREATEST(COALESCE(p_limit, 50), 0)
$function$
;
CREATE OR REPLACE FUNCTION public.is_store_member(p_store_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.store_members
    WHERE user_id = auth.uid() AND store_id = p_store_id
  );
$function$
;
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.has_role(p_store_id uuid, VARIADIC p_roles text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    public.member_role(p_store_id) = ANY(p_roles)
      AND public.store_licensed(p_store_id),
    false
  );
$function$
;
CREATE OR REPLACE FUNCTION public.member_role(p_store_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT role FROM public.store_members
  WHERE user_id = auth.uid() AND store_id = p_store_id;
$function$
;
CREATE OR REPLACE FUNCTION public.refund_order_deposit(p_order_id text, p_wallet text, p_note text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order      public.orders;
  v_pending    integer;
  v_event_id   text;
  v_device     uuid;
  v_lines      jsonb;
BEGIN
  IF p_wallet IS NULL OR btrim(p_wallet) = '' THEN
    RAISE EXCEPTION 'NEXUS_WALLET_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('refund_order_deposit:' || p_order_id));

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_FOUND';
  END IF;

  IF COALESCE(v_order.return_cause, 'unknown') NOT IN ('courier', 'shop') THEN
    RAISE EXCEPTION 'NEXUS_CAUSE_NOT_ELIGIBLE';
  END IF;

  SELECT COALESCE(SUM(l.amount_delta), 0) INTO v_pending
  FROM public.ledger_lines l
  JOIN public.ledger_events e ON e.id = l.event_id
  WHERE e.store_id = v_order.store_id
    AND e.ref_id = v_order."orderNumber"
    AND l.account = 'revenue'
    AND l.subject_id = 'deposit_pending_resolution';

  IF v_pending <= 0 THEN
    RAISE EXCEPTION 'NEXUS_NOTHING_TO_REFUND';
  END IF;

  v_device := COALESCE(
    (SELECT e.device_id FROM public.ledger_events e
      WHERE e.store_id = v_order.store_id ORDER BY e.created_at DESC LIMIT 1),
    gen_random_uuid()
  );

  v_event_id := gen_random_uuid()::text;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'id', gen_random_uuid()::text,
      'account', 'wallet',
      'subject_id', p_wallet,
      'qty_delta', 0,
      'amount_delta', -v_pending
    ),
    jsonb_build_object(
      'id', gen_random_uuid()::text,
      'account', 'revenue',
      'subject_id', 'deposit_pending_resolution',
      'qty_delta', 0,
      'amount_delta', -v_pending
    )
  );

  IF v_order."customerId" IS NOT NULL AND v_order."customerId" <> '' THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'id', gen_random_uuid()::text,
        'account', 'customer_ltv',
        'subject_id', v_order."customerId",
        'qty_delta', 0,
        'amount_delta', -v_pending
      )
    );
  END IF;

  PERFORM public.ledger_append(jsonb_build_object(
    'id', v_event_id,
    'store_id', v_order.store_id,
    'device_id', v_device,
    'kind', 'deposit_refunded',
    'occurred_at', now(),
    'created_at', now(),
    'actor', 'تسوية العميلة',
    'ref_type', 'ecommerce_order',
    'ref_id', v_order."orderNumber",
    'payload', jsonb_build_object(
      'return_cause', v_order.return_cause,
      'resolution', 'final_cancellation',
      'authorised_as', 'courier_or_shop_caused_return_exception',
      'note', p_note
    )::text,
    'lines', v_lines
  ));

  RETURN v_event_id;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.orders_guard_return_cause()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old text := CASE WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.return_cause, 'unknown') ELSE NULL END;
  v_new text := COALESCE(NEW.return_cause, 'unknown');
BEGIN
  IF TG_OP = 'UPDATE' AND v_old = v_new THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM public.ledger_events e
     WHERE e.store_id = NEW.store_id
       AND e.ref_id = NEW."orderNumber"
       AND e.kind = 'deposit_refunded'
  ) THEN
    RAISE EXCEPTION 'NEXUS_CAUSE_FROZEN_AFTER_RESOLUTION';
  END IF;

  IF v_new IN ('courier', 'shop')
     AND NOT COALESCE(public.has_role(NEW.store_id, VARIADIC ARRAY['ADMIN', 'ACCOUNTANT']), false)
  THEN
    RAISE EXCEPTION 'NEXUS_CAUSE_NOT_AUTHORISED';
  END IF;

  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.courier_claims_guard_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'NEXUS_CLAIM_MUST_START_PENDING';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('settled', 'rejected') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.settlement_event_id IS DISTINCT FROM OLD.settlement_event_id
       OR NEW.amount_piastres     IS DISTINCT FROM OLD.amount_piastres
       OR NEW.order_id            IS DISTINCT FROM OLD.order_id
       OR NEW.courier_id          IS DISTINCT FROM OLD.courier_id
       OR NEW.return_record_id    IS DISTINCT FROM OLD.return_record_id
    THEN
      RAISE EXCEPTION 'NEXUS_CLAIM_IS_CLOSED';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  v_ok := CASE OLD.status
    WHEN 'pending'   THEN NEW.status IN ('submitted', 'rejected')
    WHEN 'submitted' THEN NEW.status IN ('approved', 'rejected')
    WHEN 'approved'  THEN NEW.status = 'settled'
    ELSE false
  END;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'NEXUS_CLAIM_BAD_TRANSITION';
  END IF;

  IF NEW.status = 'settled' THEN
    IF NEW.settlement_event_id IS NULL THEN
      RAISE EXCEPTION 'NEXUS_CLAIM_SETTLEMENT_NEEDS_EVENT';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.ledger_events e
        JOIN public.ledger_lines l ON l.event_id = e.id
       WHERE e.id = NEW.settlement_event_id
         AND e.store_id = NEW.store_id
         AND e.kind = 'courier_settlement'
         AND l.account = 'receivable_courier'
         AND l.subject_id = NEW.courier_id
    ) THEN
      RAISE EXCEPTION 'NEXUS_CLAIM_SETTLEMENT_EVENT_MISMATCH';
    END IF;
  END IF;

  NEW.submitted_at := CASE WHEN NEW.status = 'submitted' THEN now() ELSE NEW.submitted_at END;
  NEW.decided_at   := CASE WHEN NEW.status IN ('approved','rejected') THEN now() ELSE NEW.decided_at END;
  NEW.settled_at   := CASE WHEN NEW.status = 'settled' THEN now() ELSE NEW.settled_at END;
  NEW.decided_by   := CASE WHEN NEW.status IN ('approved','rejected') THEN auth.uid() ELSE NEW.decided_by END;
  NEW.updated_at   := (extract(epoch FROM now()) * 1000)::bigint;

  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.touch_store_license()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.is_system_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM   auth.users u
    WHERE  u.id = auth.uid()
      AND  u.email_confirmed_at IS NOT NULL
      AND  lower(u.email) IN ('14ahmedashraf@gmail.com', 'ahmedshelby142@gmail.com')
  );
$function$
;
CREATE OR REPLACE FUNCTION public.list_store_members()
 RETURNS TABLE(user_id uuid, role text, email text, joined_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT sm.user_id,
         sm.role::text,
         u.email::text,
         COALESCE(sm.created_at, u.created_at)
  FROM public.store_members sm
  JOIN auth.users u ON u.id = sm.user_id
  WHERE public.member_role(sm.store_id) = 'ADMIN';
$function$
;
CREATE OR REPLACE FUNCTION public.admin_reactivate_license(p_store_id uuid)
 RETURNS store_licenses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  current_row public.store_licenses;
  result      public.store_licenses;
BEGIN
  IF NOT public.is_system_owner() THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO current_row FROM public.store_licenses WHERE store_id = p_store_id;
  IF current_row.store_id IS NULL THEN
    RAISE EXCEPTION 'this store has no license to reactivate';
  END IF;
  IF current_row.status <> 'suspended' THEN
    RAISE EXCEPTION 'this license is not suspended';
  END IF;

  UPDATE public.store_licenses
     SET status         = 'active',
         suspended_at   = NULL,
         reactivated_at = now(),
         updated_by     = auth.uid()
   WHERE store_id = p_store_id
  RETURNING * INTO result;

  RETURN result;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.admin_revoke_license(p_store_id uuid)
 RETURNS store_licenses
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.admin_suspend_license(p_store_id, NULL);
$function$
;
CREATE OR REPLACE FUNCTION public.claim_store(local_store_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    canonical_store_id UUID;
    v_uid UUID := auth.uid();
    TRIAL_DAYS CONSTANT INT := 0;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT store_id INTO canonical_store_id
    FROM public.store_members
    WHERE user_id = v_uid
    LIMIT 1;

    IF canonical_store_id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'canonical', canonical_store_id,
            'rekey', canonical_store_id <> local_store_id
        );
    END IF;

    IF EXISTS (SELECT 1 FROM public.stores s WHERE s.id = local_store_id) THEN
        RAISE EXCEPTION 'store % already exists', local_store_id
          USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO public.stores (id, name) VALUES (local_store_id, 'متجري');
    INSERT INTO public.store_members (user_id, store_id, role)
    VALUES (v_uid, local_store_id, 'ADMIN');

    IF TRIAL_DAYS > 0 THEN
        INSERT INTO public.store_licenses
            (store_id, license_key, plan_type, valid_until, status, notes)
        VALUES (
            local_store_id,
            'TRIAL-' || replace(local_store_id::text, '-', ''),
            'BASIC',
            now() + (TRIAL_DAYS || ' days')::interval,
            'active',
            'Automatic trial issued at signup by claim_store.'
        )
        ON CONFLICT (store_id) DO NOTHING;
    END IF;

    RETURN jsonb_build_object('canonical', local_store_id, 'rekey', false);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.guard_discount_usage()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF public._discount_usage_is_trusted() THEN RETURN NEW; END IF;
  NEW."usedCount"     := OLD."usedCount";
  NEW."totalDiscount" := OLD."totalDiscount";
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.admin_set_license(p_store_id uuid, p_license_key text, p_plan_type text, p_valid_until timestamp with time zone, p_status text DEFAULT 'active'::text, p_note text DEFAULT NULL::text)
 RETURNS store_licenses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result public.store_licenses;
BEGIN
  IF NOT public.is_system_owner() THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  IF p_store_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.stores WHERE id = p_store_id) THEN
    RAISE EXCEPTION 'unknown store';
  END IF;
  IF coalesce(btrim(p_license_key), '') = '' THEN
    RAISE EXCEPTION 'license key is required';
  END IF;
  IF p_plan_type NOT IN ('BASIC', 'PRO') THEN
    RAISE EXCEPTION 'plan must be BASIC or PRO';
  END IF;
  IF p_status NOT IN ('active', 'expired', 'suspended') THEN
    RAISE EXCEPTION 'status must be active, expired or suspended';
  END IF;
  IF p_valid_until IS NULL THEN
    RAISE EXCEPTION 'expiry date is required';
  END IF;

  INSERT INTO public.store_licenses AS sl
        (store_id,   license_key,          plan_type,   valid_until,   status,   notes,
         activated_at, updated_by)
  VALUES (p_store_id, btrim(p_license_key), p_plan_type, p_valid_until, p_status, p_note,
          CASE WHEN p_status = 'active' THEN now() END, auth.uid())
  ON CONFLICT (store_id) DO UPDATE
     SET license_key = EXCLUDED.license_key,
         plan_type   = EXCLUDED.plan_type,
         valid_until = EXCLUDED.valid_until,
         status      = EXCLUDED.status,
         notes       = COALESCE(EXCLUDED.notes, sl.notes),
         updated_by  = auth.uid(),
         activated_at = CASE WHEN EXCLUDED.status = 'active' THEN now() ELSE sl.activated_at END,
         suspended_at = CASE WHEN EXCLUDED.status = 'suspended' THEN now() ELSE NULL END
  RETURNING sl.* INTO result;

  RETURN result;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.admin_extend_license(p_store_id uuid, p_days integer DEFAULT NULL::integer, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_note text DEFAULT NULL::text)
 RETURNS store_licenses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  current_row public.store_licenses;
  result      public.store_licenses;
  new_until   TIMESTAMPTZ;
BEGIN
  IF NOT public.is_system_owner() THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO current_row FROM public.store_licenses WHERE store_id = p_store_id;
  IF current_row.store_id IS NULL THEN
    RAISE EXCEPTION 'this store has no license to extend';
  END IF;
  IF current_row.status = 'suspended' THEN
    RAISE EXCEPTION 'this license is suspended - reactivate it first';
  END IF;

  IF p_until IS NOT NULL THEN
    new_until := p_until;
  ELSIF p_days IS NOT NULL THEN
    IF p_days <= 0 OR p_days > 3650 THEN
      RAISE EXCEPTION 'extension must be between 1 and 3650 days';
    END IF;
    new_until := GREATEST(now(), current_row.valid_until) + (p_days || ' days')::interval;
  ELSE
    RAISE EXCEPTION 'give either a number of days or an expiry date';
  END IF;

  IF new_until <= now() THEN
    RAISE EXCEPTION 'the new expiry date is already in the past';
  END IF;

  UPDATE public.store_licenses
     SET valid_until = new_until,
         status       = 'active',
         activated_at = CASE WHEN status <> 'active' THEN now() ELSE activated_at END,
         suspended_at = NULL,
         notes        = COALESCE(p_note, notes),
         updated_by   = auth.uid()
   WHERE store_id = p_store_id
  RETURNING * INTO result;

  RETURN result;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.admin_suspend_license(p_store_id uuid, p_note text DEFAULT NULL::text)
 RETURNS store_licenses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result public.store_licenses;
BEGIN
  IF NOT public.is_system_owner() THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  UPDATE public.store_licenses
     SET status       = 'suspended',
         suspended_at = now(),
         notes        = COALESCE(p_note, notes),
         updated_by   = auth.uid()
   WHERE store_id = p_store_id
  RETURNING * INTO result;

  IF result.store_id IS NULL THEN
    RAISE EXCEPTION 'this store has no license to suspend';
  END IF;

  RETURN result;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.admin_list_stores()
 RETURNS TABLE(store_id uuid, store_name text, created_at timestamp with time zone, owner_email text, license_key text, plan_type text, valid_until timestamp with time zone, status text, notes text, activated_at timestamp with time zone, suspended_at timestamp with time zone, reactivated_at timestamp with time zone, license_created_at timestamp with time zone, license_updated_at timestamp with time zone, member_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.is_system_owner() THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT s.id,
         s.name,
         s.created_at,
         (SELECT u.email::text
            FROM public.store_members m
            JOIN auth.users u ON u.id = m.user_id
           WHERE m.store_id = s.id
           ORDER BY (m.role <> 'ADMIN'), m.created_at
           LIMIT 1),
         l.license_key,
         l.plan_type,
         l.valid_until,
         l.status,
         l.notes,
         l.activated_at,
         l.suspended_at,
         l.reactivated_at,
         l.created_at,
         l.updated_at,
         (SELECT count(*) FROM public.store_members m2 WHERE m2.store_id = s.id)
  FROM   public.stores s
  LEFT   JOIN public.store_licenses l ON l.store_id = s.id
  ORDER  BY s.created_at DESC;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.ledger_validate_event(p_event jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_kind     text  := p_event ->> 'kind';
  v_store    uuid  := (p_event ->> 'store_id')::uuid;
  v_ref_type text  := p_event ->> 'ref_type';
  v_ref_id   text  := p_event ->> 'ref_id';
  v_lines    jsonb := COALESCE(p_event -> 'lines', '[]'::jsonb);
  v_allowed  text[];
  v_n int; v_bad_account int; v_no_subject int; v_qty_off_stock int; v_zero_qty int;
  v_sign_clash int; v_bad_cost int; v_bad_wallet int; v_off_kind int;
  w bigint; r bigint; rc bigint; rco bigint; pc bigint; ps bigint; ex bigint;
  st bigint; ltv bigint; ob bigint;
  v_stock_in int; v_stock_out int; v_wallet_in int; v_wallet_out int;
  v_rev_neg int; v_rev_not_deposit int; v_rco_neg int; v_rco_pos int;
  v_pc_neg int; v_pc_pos int; v_ex_neg int; v_ex_pos int; v_cogs_neg int;
  v_prior bigint; v_outstanding numeric; v_subject text;
  -- 046: the order an order_placed reserves for
  v_total numeric; v_ship numeric; v_comp numeric; v_dep numeric; v_cod numeric; v_disc numeric; v_goods numeric;
  -- 049: owner equity
  oe bigint; v_oe_lines int; v_oe_subject text;
BEGIN
  IF jsonb_typeof(v_lines) <> 'array' THEN
    RAISE EXCEPTION 'ledger: lines must be an array' USING ERRCODE = '23514';
  END IF;

  IF v_kind IS NULL OR v_kind <> ALL (ARRAY[
      'sale', 'order_placed', 'order_delivered', 'order_returned_pending',
      'order_cancelled', 'order_edited', 'return_confirmed', 'rto_confirmed',
      'purchase', 'supplier_payment', 'client_payment', 'expense', 'payroll',
      'wallet_transfer', 'courier_settlement', 'owner_draw', 'stock_adjustment',
      'deposit_refunded',
      -- 049: owner equity
      'owner_capital', 'owner_contribution']) THEN
    RAISE EXCEPTION 'ledger: unknown event kind "%"', v_kind USING ERRCODE = '23514';
  END IF;

  v_n := jsonb_array_length(v_lines);
  IF v_kind = 'order_returned_pending' THEN
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'ledger: order_returned_pending moves nothing' USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'ledger: % must move something', v_kind USING ERRCODE = '23514';
  END IF;

  v_allowed := CASE v_kind
    WHEN 'sale'               THEN ARRAY['stock','cogs','wallet','receivable_client','revenue','customer_ltv','expense']
    WHEN 'order_placed'       THEN ARRAY['stock','wallet']
    WHEN 'order_edited'       THEN ARRAY['stock']
    WHEN 'order_cancelled'    THEN ARRAY['stock','wallet','revenue','customer_ltv']
    WHEN 'order_delivered'    THEN ARRAY['cogs','receivable_courier','revenue','payable_courier','customer_ltv','expense']
    WHEN 'return_confirmed'   THEN ARRAY['stock','cogs','wallet','receivable_client','receivable_courier','payable_courier','revenue','expense','customer_ltv']
    WHEN 'rto_confirmed'      THEN ARRAY['stock','payable_courier','expense','receivable_courier','wallet','revenue','customer_ltv']
    WHEN 'purchase'           THEN ARRAY['stock','wallet','payable_supplier']
    WHEN 'supplier_payment'   THEN ARRAY['wallet','payable_supplier']
    WHEN 'client_payment'     THEN ARRAY['wallet','receivable_client']
    WHEN 'expense'            THEN ARRAY['wallet','expense']
    WHEN 'payroll'            THEN ARRAY['wallet','expense']
    WHEN 'wallet_transfer'    THEN ARRAY['wallet']
    WHEN 'courier_settlement' THEN ARRAY['wallet','receivable_courier','payable_courier','expense']
    WHEN 'owner_draw'         THEN ARRAY['wallet','owner_budget']
    WHEN 'stock_adjustment'   THEN ARRAY['stock','expense','wallet']
    WHEN 'deposit_refunded'   THEN ARRAY['wallet','revenue','customer_ltv']
    WHEN 'owner_capital'      THEN ARRAY['owner_equity','wallet']
    WHEN 'owner_contribution' THEN ARRAY['owner_equity','wallet']
  END;

  WITH ln AS (
    SELECT l ->> 'account'                          AS acc,
           NULLIF(btrim(l ->> 'subject_id'), '')    AS subj,
           COALESCE((l ->> 'qty_delta')::real, 0)   AS q,
           COALESCE((l ->> 'amount_delta')::integer, 0)::bigint AS a,
           NULLIF(l ->> 'unit_cost', '')::integer   AS uc
      FROM jsonb_array_elements(v_lines) AS l
  )
  SELECT
    count(*) FILTER (WHERE acc IS NULL OR acc <> ALL (ARRAY['stock','wallet','revenue','cogs','expense',
                     'payable_supplier','receivable_client','receivable_courier','payable_courier',
                     'customer_ltv','owner_budget','owner_equity'])),
    count(*) FILTER (WHERE subj IS NULL),
    count(*) FILTER (WHERE acc <> 'stock' AND q <> 0),
    count(*) FILTER (WHERE acc = 'stock' AND q = 0),
    count(*) FILTER (WHERE acc = 'stock' AND ((q > 0 AND a < 0) OR (q < 0 AND a > 0))),
    count(*) FILTER (WHERE uc IS NOT NULL AND (uc < 0 OR acc NOT IN ('stock','cogs'))),
    count(*) FILTER (WHERE acc = 'wallet'
                       AND lower(subj) <> ALL (ARRAY['instoresafe','vodafonecash','instapay','bankaccount'])),
    count(*) FILTER (WHERE acc IS NOT NULL AND acc <> ALL (v_allowed)),
    COALESCE(sum(a) FILTER (WHERE acc = 'wallet'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'revenue'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'receivable_client'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'receivable_courier'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'payable_courier'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'payable_supplier'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'expense'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'stock'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'customer_ltv'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'owner_budget'), 0),
    count(*) FILTER (WHERE acc = 'stock' AND q > 0),
    count(*) FILTER (WHERE acc = 'stock' AND q < 0),
    count(*) FILTER (WHERE acc = 'wallet' AND a > 0),
    count(*) FILTER (WHERE acc = 'wallet' AND a <= 0),
    count(*) FILTER (WHERE acc = 'revenue' AND a < 0),
    count(*) FILTER (WHERE acc = 'revenue' AND (a <= 0 OR subj NOT IN ('forfeited_deposit','deposit_pending_resolution'))),
    count(*) FILTER (WHERE acc = 'receivable_courier' AND a < 0),
    count(*) FILTER (WHERE acc = 'receivable_courier' AND a >= 0),
    count(*) FILTER (WHERE acc = 'payable_courier' AND a < 0),
    count(*) FILTER (WHERE acc = 'payable_courier' AND a >= 0),
    count(*) FILTER (WHERE acc = 'expense' AND a < 0),
    count(*) FILTER (WHERE acc = 'expense' AND a <= 0),
    count(*) FILTER (WHERE acc = 'cogs' AND a < 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'owner_equity'), 0),
    count(*) FILTER (WHERE acc = 'owner_equity'),
    (array_agg(subj) FILTER (WHERE acc = 'owner_equity'))[1]
  INTO v_bad_account, v_no_subject, v_qty_off_stock, v_zero_qty, v_sign_clash, v_bad_cost,
       v_bad_wallet, v_off_kind, w, r, rc, rco, pc, ps, ex, st, ltv, ob,
       v_stock_in, v_stock_out, v_wallet_in, v_wallet_out, v_rev_neg, v_rev_not_deposit,
       v_rco_neg, v_rco_pos, v_pc_neg, v_pc_pos, v_ex_neg, v_ex_pos, v_cogs_neg,
       oe, v_oe_lines, v_oe_subject
  FROM ln;

  -- ── Every line ────────────────────────────────────────────────────────────
  IF v_bad_account > 0 THEN
    RAISE EXCEPTION 'ledger: unknown account on a % line', v_kind USING ERRCODE = '23514';
  END IF;
  IF v_no_subject > 0 THEN
    RAISE EXCEPTION 'ledger: every % line needs a subject', v_kind USING ERRCODE = '23514';
  END IF;
  IF v_qty_off_stock > 0 OR v_zero_qty > 0 OR v_sign_clash > 0 THEN
    RAISE EXCEPTION 'ledger: only stock carries a quantity, and never zero or signed against its value'
      USING ERRCODE = '23514';
  END IF;
  IF v_bad_cost > 0 THEN
    RAISE EXCEPTION 'ledger: unit cost must be non-negative and only on stock or cogs' USING ERRCODE = '23514';
  END IF;
  IF v_bad_wallet > 0 THEN
    RAISE EXCEPTION 'ledger: a wallet line must name one of the shop''s wallets' USING ERRCODE = '23514';
  END IF;
  IF v_off_kind > 0 THEN
    RAISE EXCEPTION 'ledger: % cannot move that account', v_kind USING ERRCODE = '23514';
  END IF;

  -- ── Per kind ──────────────────────────────────────────────────────────────
  IF v_kind = 'sale' THEN
    IF w + rc <> r THEN
      RAISE EXCEPTION 'ledger: sale — money in (wallet + receivable) must equal revenue' USING ERRCODE = '23514';
    END IF;
    IF ltv NOT IN (0, r) OR v_ex_neg > 0 THEN
      RAISE EXCEPTION 'ledger: sale — customer value must match revenue, and a delivery cost is a cost'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'order_placed' THEN
    IF v_stock_out = 0 OR v_stock_in > 0 OR v_wallet_out > 0 THEN
      RAISE EXCEPTION 'ledger: order_placed — reserves stock and may only take a deposit in'
        USING ERRCODE = '23514';
    END IF;
    -- 046 — the deposit is bounded by the order it is paid on.
    --
    -- The order row must already exist in this store: `place_order` (045)
    -- inserts it in this same transaction, so a placement can no longer reach
    -- the ledger ahead of the document that says what is owed.
    SELECT o."totalAmount", o."shippingFee", COALESCE(o."wastedTripCompensation", 0), o."depositAmount", o."expectedCod",
           COALESCE(o."discountAmount", 0),
           (SELECT COALESCE(sum((i ->> 'quantity')::numeric * (i ->> 'unitPrice')::numeric), 0)
              FROM jsonb_array_elements(COALESCE(o.items, '[]'::jsonb)) AS i)
      INTO v_total, v_ship, v_comp, v_dep, v_cod, v_disc, v_goods
      FROM public.orders o
     WHERE o.store_id = v_store
       AND o."orderNumber" = v_ref_id
       AND o.deleted_at IS NULL;
    IF v_ref_type IS DISTINCT FROM 'ecommerce_order' OR v_ref_id IS NULL OR NOT FOUND THEN
      RAISE EXCEPTION 'ledger: order_placed — must reserve for an order in this store (place it with place_order)'
        USING ERRCODE = '23514';
    END IF;
    -- One placement per order: a second one would bank the deposit twice.
    IF EXISTS (SELECT 1 FROM public.ledger_events e
                WHERE e.store_id = v_store AND e.kind = 'order_placed'
                  AND e.ref_type = 'ecommerce_order' AND e.ref_id = v_ref_id) THEN
      RAISE EXCEPTION 'ledger: order_placed — this order is already placed' USING ERRCODE = '23514';
    END IF;
    -- The order's own figures must add up, exactly as every order in
    -- production does: goods − discount = total, deposit + COD = total +
    -- shipping, nothing negative. With COD ≥ 0 that IS the bound:
    --     deposit ≤ total + shipping = everything this order can ever owe.
    IF v_total < 0 OR v_ship < 0 OR v_dep < 0 OR v_cod < 0
       OR abs(v_goods - v_disc - v_total) >= 0.005
       OR abs(v_dep + v_cod - v_total - v_ship - v_comp) >= 0.005 THEN
      RAISE EXCEPTION 'ledger: order_placed — the order''s total, deposit and COD do not add up'
        USING ERRCODE = '23514';
    END IF;
    -- And the money banked is that deposit — not more (within one piastre of
    -- rounding: the row holds EGP, the line holds piastres).
    IF abs(w - v_dep * 100) >= 1 THEN
      RAISE EXCEPTION 'ledger: order_placed — the deposit banked must be the order''s deposit'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'order_cancelled' THEN
    IF v_stock_out > 0 OR v_wallet_in > 0 OR v_rev_not_deposit > 0 OR (w < 0 AND r > 0) OR ltv NOT IN (0, r) THEN
      RAISE EXCEPTION 'ledger: order_cancelled — returns stock and either refunds or keeps the deposit'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'order_delivered' THEN
    IF v_rco_neg > 0 OR v_pc_neg > 0 OR v_rev_neg > 0 OR v_cogs_neg > 0 OR v_ex_neg > 0 OR ltv NOT IN (0, r) THEN
      RAISE EXCEPTION 'ledger: order_delivered — every amount is money owed or earned, never negative'
        USING ERRCODE = '23514';
    END IF;
    -- What the courier holds can never exceed what is still owed: the goods
    -- and the fee, less every deposit already booked on this order. Only the
    -- kinds that move a DEPOSIT count — a per-order courier_settlement also
    -- carries this ref and a wallet line, and it is not a deposit.
    v_prior := 0;
    IF v_ref_id IS NOT NULL THEN
      SELECT COALESCE(sum(l.amount_delta), 0) INTO v_prior
        FROM public.ledger_events e
        JOIN public.ledger_lines l ON l.event_id = e.id
       WHERE e.store_id = v_store
         AND e.ref_type = 'ecommerce_order'
         AND e.ref_id = v_ref_id
         AND e.kind IN ('order_placed', 'client_payment', 'order_cancelled', 'rto_confirmed', 'deposit_refunded')
         AND l.account = 'wallet';
    END IF;
    IF v_prior + rco > r + pc THEN
      RAISE EXCEPTION 'ledger: order_delivered — COD plus deposits is more than goods plus shipping'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'return_confirmed' THEN
    IF w + rc + rco - pc + ex <> r OR r > 0 OR v_stock_out > 0 OR ltv NOT IN (0, r) THEN
      RAISE EXCEPTION 'ledger: return_confirmed — the refund must equal the revenue it reverses'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'rto_confirmed' THEN
    IF rco - pc + ex <> 0 OR v_wallet_in > 0 OR v_rev_not_deposit > 0 OR v_stock_out > 0 OR ltv NOT IN (0, r) THEN
      RAISE EXCEPTION 'ledger: rto_confirmed — the fee must net out and money may only go back'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'purchase' THEN
    IF st + w - ps <> 0 THEN
      RAISE EXCEPTION 'ledger: purchase — stock value must equal what was paid plus what is owed'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'supplier_payment' THEN
    IF w <> ps OR w >= 0 THEN
      RAISE EXCEPTION 'ledger: supplier_payment — money out must equal the debt paid down' USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'client_payment' THEN
    IF v_wallet_out > 0 THEN
      RAISE EXCEPTION 'ledger: client_payment — a payment is money in' USING ERRCODE = '23514';
    END IF;
    IF rc <> 0 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) l WHERE l ->> 'account' = 'receivable_client') THEN
      IF w + rc <> 0 THEN
        RAISE EXCEPTION 'ledger: client_payment — money in must equal the debt paid down' USING ERRCODE = '23514';
      END IF;
    ELSE
      -- An order top-up: the money is only as real as the order it is owed on.
      SELECT o."expectedCod" INTO v_outstanding
        FROM public.orders o
       WHERE o.store_id = v_store
         AND o."orderNumber" = v_ref_id
         AND o.deleted_at IS NULL
       LIMIT 1;
      IF v_ref_type IS DISTINCT FROM 'ecommerce_order' OR NOT FOUND THEN
        RAISE EXCEPTION 'ledger: client_payment — a top-up must name an order in this store'
          USING ERRCODE = '23514';
      END IF;
      IF w > round(COALESCE(v_outstanding, 0) * 100) THEN
        RAISE EXCEPTION 'ledger: client_payment — more than is still owed on the order' USING ERRCODE = '23514';
      END IF;
    END IF;

  ELSIF v_kind IN ('expense', 'payroll') THEN
    IF w + ex <> 0 OR w >= 0 THEN
      RAISE EXCEPTION 'ledger: % — money out must equal the cost booked', v_kind USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'wallet_transfer' THEN
    IF v_n < 2 OR w <> 0 THEN
      RAISE EXCEPTION 'ledger: wallet_transfer — moves money between wallets and creates none'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'courier_settlement' THEN
    IF w + rco - pc + ex <> 0 OR v_wallet_out > 0 OR v_rco_pos > 0 OR v_pc_pos > 0 OR v_ex_neg > 0 THEN
      RAISE EXCEPTION 'ledger: courier_settlement — cash in must equal what the courier held, less fees'
        USING ERRCODE = '23514';
    END IF;
    -- A courier cannot hand over more than they hold, nor be paid fees they
    -- are not owed. Serialized per courier so two settlements cannot both pass.
    FOR v_subject IN
      SELECT DISTINCT l ->> 'subject_id' FROM jsonb_array_elements(v_lines) l
       WHERE l ->> 'account' IN ('receivable_courier', 'payable_courier')
       ORDER BY 1
    LOOP
      PERFORM pg_advisory_xact_lock(hashtext('ledger_courier:' || v_store::text || ':' || v_subject));
      IF (SELECT COALESCE(sum(amount_delta), 0) FROM public.ledger_lines
           WHERE store_id = v_store AND account = 'receivable_courier' AND subject_id = v_subject)
         + (SELECT COALESCE(sum((l ->> 'amount_delta')::integer), 0) FROM jsonb_array_elements(v_lines) l
             WHERE l ->> 'account' = 'receivable_courier' AND l ->> 'subject_id' = v_subject) < 0
      OR (SELECT COALESCE(sum(amount_delta), 0) FROM public.ledger_lines
           WHERE store_id = v_store AND account = 'payable_courier' AND subject_id = v_subject)
         + (SELECT COALESCE(sum((l ->> 'amount_delta')::integer), 0) FROM jsonb_array_elements(v_lines) l
             WHERE l ->> 'account' = 'payable_courier' AND l ->> 'subject_id' = v_subject) < 0
      THEN
        RAISE EXCEPTION 'ledger: courier_settlement — more than courier % holds or is owed', v_subject
          USING ERRCODE = '23514';
      END IF;
    END LOOP;

  ELSIF v_kind = 'owner_draw' THEN
    IF w + ob <> 0 OR w >= 0 THEN
      RAISE EXCEPTION 'ledger: owner_draw — money out must equal what was drawn' USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'stock_adjustment' THEN
    IF v_wallet_in + v_wallet_out > 0 AND (v_ref_type IS DISTINCT FROM 'opening_balance' OR v_n <> 1) THEN
      RAISE EXCEPTION 'ledger: stock_adjustment — a wallet moves only as a lone opening balance'
        USING ERRCODE = '23514';
    END IF;
    IF v_ex_neg + v_ex_pos > 0 AND st + ex <> 0 THEN
      RAISE EXCEPTION 'ledger: stock_adjustment — a counted difference must be booked at its value'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'deposit_refunded' THEN
    IF w <> r OR w >= 0 OR ltv NOT IN (0, r) THEN
      RAISE EXCEPTION 'ledger: deposit_refunded — the refund must reverse the held deposit' USING ERRCODE = '23514';
    END IF;

  -- ── 049: owner equity ────────────────────────────────────────────────────
  -- Capital is what the owner PUT IN. One owner_equity line, keyed by who
  -- (`owner` or a partner id). With a wallet line it is cash arriving now, and
  -- the two are equal; without one it declares capital put in before the
  -- ledger existed, which the equity statement carves out of the opening
  -- balances instead of counting twice. A negative capital line is a
  -- correction; no owner's recorded capital may end below zero.
  ELSIF v_kind = 'owner_capital' THEN
    IF v_oe_lines <> 1 OR oe = 0 OR v_wallet_in + v_wallet_out > 1 OR (v_wallet_in + v_wallet_out = 1 AND w <> oe) THEN
      RAISE EXCEPTION 'ledger: owner_capital — one capital line, and any cash equal to it' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(sum(l.amount_delta), 0) INTO v_prior
      FROM public.ledger_lines l
      JOIN public.ledger_events e ON e.id = l.event_id
     WHERE l.store_id = v_store AND l.account = 'owner_equity'
       AND e.kind = 'owner_capital' AND l.subject_id = v_oe_subject;
    IF v_prior + oe < 0 THEN
      RAISE EXCEPTION 'ledger: owner_capital — % cannot have less than no capital', v_oe_subject USING ERRCODE = '23514';
    END IF;

  -- A later contribution is money entering the business from its owner: equity
  -- up, the wallet it landed in up by the same amount. Never revenue.
  ELSIF v_kind = 'owner_contribution' THEN
    IF v_oe_lines <> 1 OR oe <= 0 OR v_wallet_in <> 1 OR v_wallet_out <> 0 OR w <> oe THEN
      RAISE EXCEPTION 'ledger: owner_contribution — the equity in must equal the cash in' USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.products_guard_definition_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Identity first, and for everyone: a re-keyed product orphans its ledger.
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'a product id cannot change' USING ERRCODE = '42501';
  END IF;

  IF public.has_role(NEW.store_id, VARIADIC ARRAY['ADMIN', 'ACCOUNTANT']) THEN
    RETURN NEW;
  END IF;

  IF NEW.name              IS DISTINCT FROM OLD.name
  OR NEW.sku               IS DISTINCT FROM OLD.sku
  OR NEW.barcode           IS DISTINCT FROM OLD.barcode
  OR NEW.category          IS DISTINCT FROM OLD.category
  OR NEW.description       IS DISTINCT FROM OLD.description
  OR NEW.image_url         IS DISTINCT FROM OLD.image_url
  OR NEW."unitPrice"       IS DISTINCT FROM OLD."unitPrice"
  OR NEW.wholesale_price   IS DISTINCT FROM OLD.wholesale_price
  OR NEW."minStockLevel"   IS DISTINCT FROM OLD."minStockLevel"
  OR NEW."maxStockLevel"   IS DISTINCT FROM OLD."maxStockLevel"
  OR NEW."isActive"        IS DISTINCT FROM OLD."isActive"
  OR NEW."isBundle"        IS DISTINCT FROM OLD."isBundle"
  OR NEW."bundleItems"     IS DISTINCT FROM OLD."bundleItems"
  OR NEW.deleted_at        IS DISTINCT FROM OLD.deleted_at
  OR NEW.store_id          IS DISTINCT FROM OLD.store_id
  THEN
    RAISE EXCEPTION
      'only ADMIN or ACCOUNTANT may change a product''s definition'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.staff_invite_context(p_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid        UUID := auth.uid();
  v_store      UUID;
  v_role       TEXT;
  v_email      TEXT := lower(btrim(p_email));
  v_target     UUID;
  v_target_store UUID;
  v_status     TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT m.store_id, m.role INTO v_store, v_role
  FROM public.store_members m
  WHERE m.user_id = v_uid
  LIMIT 1;

  IF v_store IS NULL THEN
    RAISE EXCEPTION 'you do not belong to a store' USING ERRCODE = '42501';
  END IF;
  IF v_role <> 'ADMIN' THEN
    RAISE EXCEPTION 'only a store admin may invite staff' USING ERRCODE = '42501';
  END IF;

  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'that is not an email address';
  END IF;

  SELECT u.id INTO v_target FROM auth.users u WHERE lower(u.email) = v_email;

  IF v_target IS NULL THEN
    v_status := 'no_account';
  ELSE
    SELECT m.store_id INTO v_target_store
    FROM public.store_members m WHERE m.user_id = v_target LIMIT 1;

    IF v_target_store IS NULL THEN      v_status := 'account_unlinked';
    ELSIF v_target_store = v_store THEN v_status := 'already_member';
    ELSE                                v_status := 'belongs_elsewhere';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'store_id', v_store,
    'status',   v_status,
    'user_id',  CASE WHEN v_status IN ('no_account','belongs_elsewhere') THEN NULL ELSE v_target END
  );
END;
$function$
;
CREATE OR REPLACE FUNCTION public.store_licensed(p_store_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.store_licenses l
    WHERE l.store_id = p_store_id
      AND l.status = 'active'
      AND l.valid_until > now()
  );
$function$
;
CREATE OR REPLACE FUNCTION public._discount_usage_is_trusted()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT coalesce(current_setting('nexus.discount_usage', true), '') = 'on'; $function$
;
CREATE OR REPLACE FUNCTION public.confirm_order_return(p_order_id text, p_cause text, p_movement text, p_events jsonb, p_customer_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order public.orders;
  v_row   jsonb;
  v_cust  jsonb;
  v_n     int;
  v_i     int;
  v_ev    jsonb;
  v_now   bigint := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
  IF p_cause IS NULL OR p_cause NOT IN ('customer', 'courier', 'shop') THEN
    RAISE EXCEPTION 'NEXUS_CAUSE_REQUIRED' USING ERRCODE = '23514';
  END IF;
  IF p_movement IS NULL OR p_movement NOT IN ('return', 'exchange') THEN
    RAISE EXCEPTION 'NEXUS_MOVEMENT_REQUIRED' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array' OR jsonb_array_length(p_events) NOT IN (1, 2) THEN
    RAISE EXCEPTION 'NEXUS_EVENTS_INVALID' USING ERRCODE = '23514';
  END IF;

  -- One confirmation at a time per order: a second press waits here, then
  -- finds the first one's stamp below and is refused.
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.status IS DISTINCT FROM 'returned' THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_RETURNED' USING ERRCODE = '23514';
  END IF;
  IF v_order."returnConfirmedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'NEXUS_RETURN_ALREADY_CONFIRMED' USING ERRCODE = '23505';
  END IF;

  -- Only THIS order's events: an optional order_delivered (the refund path's
  -- auto-delivery), then exactly one return_confirmed / rto_confirmed.
  v_n := jsonb_array_length(p_events);
  FOR v_i IN 0 .. v_n - 1 LOOP
    v_ev := p_events -> v_i;
    IF (v_ev ->> 'store_id')::uuid IS DISTINCT FROM v_order.store_id
       OR v_ev ->> 'ref_type' IS DISTINCT FROM 'ecommerce_order'
       OR v_ev ->> 'ref_id' IS DISTINCT FROM v_order."orderNumber" THEN
      RAISE EXCEPTION 'NEXUS_EVENT_NOT_THIS_ORDER' USING ERRCODE = '23514';
    END IF;
    IF (v_i = v_n - 1 AND v_ev ->> 'kind' NOT IN ('return_confirmed', 'rto_confirmed'))
       OR (v_i < v_n - 1 AND v_ev ->> 'kind' IS DISTINCT FROM 'order_delivered') THEN
      RAISE EXCEPTION 'NEXUS_EVENT_KIND' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  -- The document first. RLS decides who may confirm at all; the cause trigger
  -- (orders_guard_return_cause) decides who may record courier/shop.
  UPDATE public.orders
     SET "returnConfirmedAt" = now(), return_cause = p_cause, "updatedAt" = now(), updated_at = v_now
   WHERE id = p_order_id
  RETURNING to_jsonb(orders.*) INTO v_row;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_UPDATABLE' USING ERRCODE = '42501';
  END IF;

  FOR v_i IN 0 .. v_n - 1 LOOP
    PERFORM public.ledger_append(p_events -> v_i);
  END LOOP;

  -- A wasted trip is owed only when the CUSTOMER caused a plain return (an
  -- exchange carries the replacement out on the same journey). Same rule as
  -- `countsAsWastedTrip` in src/lib/shippingRates.ts.
  IF p_cause = 'customer' AND p_movement = 'return' AND NULLIF(p_customer_id, '') IS NOT NULL THEN
    UPDATE public.customers
       SET returned_orders_count = COALESCE(returned_orders_count, 0) + 1, updated_at = v_now
     WHERE id = p_customer_id AND store_id = v_order.store_id
    RETURNING to_jsonb(customers.*) INTO v_cust;
  END IF;

  -- `customer` is null when no trip was owed (or the customer is not on file).
  RETURN jsonb_build_object('order', v_row, 'customer', v_cust);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.mobile_shortages(p_store uuid)
 RETURNS TABLE(product_id text, product_name text, sku text, stock numeric, required numeric, deficit numeric, order_count bigint, waiting_orders jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- COALESCE is load-bearing: `has_role` is NULL (not false) for a non-member.
  IF NOT COALESCE(public.has_role(
    p_store,
    VARIADIC ARRAY['ADMIN', 'ACCOUNTANT', 'ECOMMERCE_ONLY', 'MODERATOR']::text[]
  ), false) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH open_lines AS (
    SELECT o.id, o."orderNumber", o."customerName", line,
           CASE WHEN (line->>'quantity') ~ '^[0-9]+(\.[0-9]+)?$' THEN (line->>'quantity')::numeric ELSE 0 END AS qty
    FROM public.orders o
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(o."stockItems") = 'array' AND jsonb_array_length(o."stockItems") > 0
           THEN o."stockItems" ELSE COALESCE(o.items, '[]'::jsonb) END
    ) AS lines(line)
    WHERE o.store_id = p_store AND o.deleted_at IS NULL
      AND o.status IN ('pending')
  ),
  demand AS (
    SELECT (line->>'productId')::text AS pid,
      SUM(qty) AS required,
      -- What each line could NOT cover when it was taken. `order_placed` has
      -- already taken every unit off the ledger, so this — not the line
      -- quantity — is what is still owed. `shortfallOf` in src/lib/shortages.ts.
      SUM(CASE
            WHEN jsonb_typeof(line->'shortfall') = 'null' THEN 0   -- Number(null) = 0 on Desktop
            WHEN (line->>'shortfall') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN GREATEST((line->>'shortfall')::numeric, 0)
            WHEN (line->>'backorder') = 'true' THEN qty
            ELSE 0
          END) AS owed,
      COUNT(DISTINCT id) AS order_count,
      jsonb_agg(DISTINCT jsonb_build_object(
        'orderId', id,
        'orderNumber', COALESCE("orderNumber", id),
        'customerName', COALESCE("customerName", '—')
      )) AS waiting_orders
    FROM open_lines
    WHERE NULLIF(line->>'productId', '') IS NOT NULL AND qty > 0
    GROUP BY 1
  ),
  on_hand AS (
    SELECT l.subject_id AS pid, SUM(l.qty_delta)::numeric AS stock
    FROM public.ledger_lines l
    WHERE l.store_id = p_store AND l.account = 'stock' AND l.deleted_at IS NULL
    GROUP BY 1
  )
  -- Stock as Desktop's getActualStock reads it: the ledger, floored at 0.
  SELECT d.pid, p.name, p.sku,
         GREATEST(COALESCE(h.stock, 0), 0), d.required,
         d.owed - GREATEST(COALESCE(h.stock, 0), 0),
         d.order_count, d.waiting_orders
  FROM demand d
  JOIN public.products p ON p.id = d.pid AND p.store_id = p_store
  LEFT JOIN on_hand h ON h.pid = d.pid
  WHERE d.owed - GREATEST(COALESCE(h.stock, 0), 0) > 0
  ORDER BY d.owed - GREATEST(COALESCE(h.stock, 0), 0) DESC, d.pid;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.claim_discount_use(p_store uuid, p_code_id text, p_amount numeric)
 RETURNS discount_codes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d public.discount_codes;
BEGIN
  IF NOT COALESCE(public.has_role(p_store, VARIADIC
    ARRAY['ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT']), false)
  THEN RAISE EXCEPTION 'NEXUS_NOT_A_MEMBER' USING ERRCODE = '42501'; END IF;
  IF p_amount IS NULL OR NOT (p_amount >= 0) OR p_amount > 1e9 THEN RAISE EXCEPTION 'NEXUS_BAD_AMOUNT'; END IF;

  SELECT * INTO d FROM public.discount_codes
   WHERE id = p_code_id AND store_id = p_store AND deleted_at IS NULL FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_CODE_NOT_FOUND'; END IF;
  IF NOT d.active THEN RAISE EXCEPTION 'NEXUS_CODE_INACTIVE'; END IF;
  IF d."expiryDate" IS NOT NULL AND d."expiryDate" < now() THEN RAISE EXCEPTION 'NEXUS_CODE_EXPIRED'; END IF;
  IF d."maxUses" IS NOT NULL AND d."usedCount" >= d."maxUses" THEN RAISE EXCEPTION 'NEXUS_CODE_EXHAUSTED'; END IF;

  PERFORM set_config('nexus.discount_usage', 'on', true);
  UPDATE public.discount_codes
     SET "usedCount" = "usedCount" + 1,
         "totalDiscount" = "totalDiscount" + p_amount,
         updated_at = (extract(epoch FROM now()) * 1000)::bigint
   WHERE id = p_code_id AND store_id = p_store RETURNING * INTO d;
  PERFORM set_config('nexus.discount_usage', 'off', true);
  RETURN d;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.release_discount_use(p_store uuid, p_code_id text, p_amount numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT COALESCE(public.has_role(p_store, VARIADIC
    ARRAY['ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT']), false)
  THEN RAISE EXCEPTION 'NEXUS_NOT_A_MEMBER' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('nexus.discount_usage', 'on', true);
  UPDATE public.discount_codes
     SET "usedCount" = GREATEST(0, "usedCount" - 1),
         "totalDiscount" = GREATEST(0, "totalDiscount" - coalesce(p_amount, 0)),
         updated_at = (extract(epoch FROM now()) * 1000)::bigint
   WHERE id = p_code_id AND store_id = p_store AND deleted_at IS NULL;
  PERFORM set_config('nexus.discount_usage', 'off', true);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.adjust_discount_total(p_store uuid, p_code_id text, p_delta numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT COALESCE(public.has_role(p_store, VARIADIC
    ARRAY['ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT']), false)
  THEN RAISE EXCEPTION 'NEXUS_NOT_A_MEMBER' USING ERRCODE = '42501'; END IF;
  IF p_delta IS NULL OR abs(p_delta) > 1e9 THEN
    RAISE EXCEPTION 'NEXUS_BAD_AMOUNT';
  END IF;

  PERFORM set_config('nexus.discount_usage', 'on', true);
  UPDATE public.discount_codes
     SET "totalDiscount" = GREATEST(0, "totalDiscount" + p_delta),
         updated_at = (extract(epoch FROM now()) * 1000)::bigint
   WHERE id = p_code_id AND store_id = p_store AND deleted_at IS NULL;
  PERFORM set_config('nexus.discount_usage', 'off', true);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.place_order(p_order jsonb, p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_store    uuid := (p_order ->> 'store_id')::uuid;
  v_number   text := p_order ->> 'orderNumber';
  v_existing jsonb;
  v_cols     text;
  v_row      jsonb;
BEGIN
  IF v_store IS NULL OR p_order ->> 'id' IS NULL OR v_number IS NULL OR btrim(v_number) = '' THEN
    RAISE EXCEPTION 'place_order: the order needs an id, a store and an order number' USING ERRCODE = '23514';
  END IF;
  IF p_event ->> 'kind' IS DISTINCT FROM 'order_placed'
     OR p_event ->> 'ref_type' IS DISTINCT FROM 'ecommerce_order'
     OR p_event ->> 'ref_id' IS DISTINCT FROM v_number
     OR (p_event ->> 'store_id')::uuid IS DISTINCT FROM v_store THEN
    RAISE EXCEPTION 'place_order: the event must be this order''s own order_placed' USING ERRCODE = '23514';
  END IF;

  -- One placement per (store, number) at a time; a concurrent duplicate waits
  -- here and then sees the committed order below.
  PERFORM pg_advisory_xact_lock(hashtext('place_order:' || v_store::text || ':' || v_number));

  SELECT to_jsonb(o.*) INTO v_existing
    FROM public.orders o
   WHERE o.store_id = v_store AND o."orderNumber" = v_number;
  IF v_existing IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.ledger_events e
                WHERE e.store_id = v_store AND e.kind = 'order_placed'
                  AND e.ref_type = 'ecommerce_order' AND e.ref_id = v_number) THEN
      RETURN jsonb_build_object('order', v_existing, 'replayed', true);
    END IF;
    RAISE EXCEPTION 'place_order: order % exists without its placement', v_number USING ERRCODE = '23505';
  END IF;

  -- Only the columns the client sent, so every omitted column keeps its
  -- DEFAULT (jsonb_populate_record alone would write NULL over them).
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.orders'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND p_order ? a.attname;

  EXECUTE format(
    'INSERT INTO public.orders AS o (%1$s) SELECT %1$s FROM jsonb_populate_record(NULL::public.orders, $1) RETURNING to_jsonb(o.*)',
    v_cols)
  USING p_order INTO v_row;

  -- Validated by ledger_validate_event against the row just inserted (046).
  PERFORM public.ledger_append(p_event);

  RETURN jsonb_build_object('order', v_row, 'replayed', false);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.record_payroll(p_payroll jsonb, p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id    text := p_payroll ->> 'id';
  v_store uuid := (p_payroll ->> 'store_id')::uuid;
  v_row   jsonb;
BEGIN
  IF v_id IS NULL OR v_store IS NULL THEN
    RAISE EXCEPTION 'NEXUS_DOCUMENT_INVALID' USING ERRCODE = '23514';
  END IF;

  -- A retry after a lost answer: the salary is already paid. Say so.
  SELECT to_jsonb(p.*) INTO v_row FROM public.payroll p WHERE p.id = v_id AND p.store_id = v_store;
  IF v_row IS NOT NULL THEN
    RETURN jsonb_build_object('payroll', v_row, 'replayed', true);
  END IF;

  IF p_event ->> 'kind' IS DISTINCT FROM 'payroll'
     OR (p_event ->> 'store_id')::uuid IS DISTINCT FROM v_store
     OR p_event ->> 'ref_type' IS DISTINCT FROM 'payroll'
     OR p_event ->> 'ref_id' IS DISTINCT FROM v_id THEN
    RAISE EXCEPTION 'NEXUS_EVENT_NOT_THIS_DOCUMENT' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.payroll (id, store_id, device_id, "employeeName", type, amount, description,
                              date, wallet, ledger_event_id, updated_at, sync_status)
  VALUES (v_id, v_store, (p_payroll ->> 'device_id')::uuid, p_payroll ->> 'employeeName',
          COALESCE(p_payroll ->> 'type', 'salary'), (p_payroll ->> 'amount')::numeric,
          p_payroll ->> 'description', (p_payroll ->> 'date')::timestamptz, p_payroll ->> 'wallet',
          p_event ->> 'id', (extract(epoch FROM clock_timestamp()) * 1000)::bigint, 'synced')
  RETURNING to_jsonb(payroll.*) INTO v_row;

  PERFORM public.ledger_append(p_event);
  RETURN jsonb_build_object('payroll', v_row, 'replayed', false);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.record_fixed_asset(p_asset jsonb, p_event jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id    text := p_asset ->> 'id';
  v_store uuid := (p_asset ->> 'store_id')::uuid;
  v_row   jsonb;
BEGIN
  IF v_id IS NULL OR v_store IS NULL THEN
    RAISE EXCEPTION 'NEXUS_DOCUMENT_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT to_jsonb(a.*) INTO v_row FROM public.fixed_assets a WHERE a.id = v_id AND a.store_id = v_store;
  IF v_row IS NOT NULL THEN
    RETURN jsonb_build_object('asset', v_row, 'replayed', true);
  END IF;

  -- No event = an asset already owned («مدفوع مسبقاً»): nothing moves now.
  IF p_event IS NOT NULL AND (
       p_event ->> 'kind' IS DISTINCT FROM 'expense'
       OR (p_event ->> 'store_id')::uuid IS DISTINCT FROM v_store
       OR p_event ->> 'ref_type' IS DISTINCT FROM 'fixed_asset'
       OR p_event ->> 'ref_id' IS DISTINCT FROM v_id) THEN
    RAISE EXCEPTION 'NEXUS_EVENT_NOT_THIS_DOCUMENT' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.fixed_assets (id, store_id, device_id, name, "purchaseValue", "salvageValue",
                                   "usefulLifeYears", "purchaseDate", "monthlyDepreciation", "isActive",
                                   "paymentSource", ledger_event_id, updated_at, sync_status)
  VALUES (v_id, v_store, (p_asset ->> 'device_id')::uuid, p_asset ->> 'name',
          (p_asset ->> 'purchaseValue')::numeric, COALESCE((p_asset ->> 'salvageValue')::numeric, 0),
          (p_asset ->> 'usefulLifeYears')::numeric, (p_asset ->> 'purchaseDate')::timestamptz,
          COALESCE((p_asset ->> 'monthlyDepreciation')::numeric, 0), COALESCE((p_asset ->> 'isActive')::boolean, true),
          p_asset ->> 'paymentSource', p_event ->> 'id',
          (extract(epoch FROM clock_timestamp()) * 1000)::bigint, 'synced')
  RETURNING to_jsonb(fixed_assets.*) INTO v_row;

  IF p_event IS NOT NULL THEN
    PERFORM public.ledger_append(p_event);
  END IF;
  RETURN jsonb_build_object('asset', v_row, 'replayed', false);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id text, p_cause text, p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order public.orders;
  v_row   jsonb;
BEGIN
  IF p_cause IS NULL OR p_cause NOT IN ('customer', 'courier', 'shop') THEN
    RAISE EXCEPTION 'NEXUS_CAUSE_REQUIRED' USING ERRCODE = '23514';
  END IF;

  -- One cancellation at a time per order: a second press waits here, then
  -- finds it already cancelled below.
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.status = 'cancelled' THEN
    RAISE EXCEPTION 'NEXUS_ORDER_ALREADY_CANCELLED' USING ERRCODE = '23505';
  END IF;
  -- Same rule as `ACTIONS_BY_STATUS` (src/lib/orderLifecycle.ts): only an
  -- order still in the shop can be called off; once it left, it is a return.
  IF v_order.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_CANCELLABLE' USING ERRCODE = '23514';
  END IF;

  IF p_event ->> 'kind' IS DISTINCT FROM 'order_cancelled'
     OR (p_event ->> 'store_id')::uuid IS DISTINCT FROM v_order.store_id
     OR p_event ->> 'ref_type' IS DISTINCT FROM 'ecommerce_order'
     OR p_event ->> 'ref_id' IS DISTINCT FROM v_order."orderNumber" THEN
    RAISE EXCEPTION 'NEXUS_EVENT_NOT_THIS_ORDER' USING ERRCODE = '23514';
  END IF;

  -- RLS decides who may cancel; orders_guard_return_cause decides who may
  -- record courier/shop.
  UPDATE public.orders
     SET status = 'cancelled', return_cause = p_cause, "updatedAt" = now(),
         updated_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
   WHERE id = p_order_id
  RETURNING to_jsonb(orders.*) INTO v_row;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_UPDATABLE' USING ERRCODE = '42501';
  END IF;

  PERFORM public.ledger_append(p_event);
  RETURN jsonb_build_object('order', v_row);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.ledger_append(p_event jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id text := p_event->>'id';
  v_store uuid := (p_event->>'store_id')::uuid;
  v_device uuid := (p_event->>'device_id')::uuid;
  v_count integer;
BEGIN
  IF v_id IS NULL OR v_store IS NULL OR v_device IS NULL THEN
    RAISE EXCEPTION 'ledger_append: identity required' USING ERRCODE='23514';
  END IF;
  IF p_event->>'kind' IS NULL OR jsonb_typeof(coalesce(p_event->'lines','[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'ledger_append: kind and lines array required' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_event->'lines','[]'::jsonb)) l
    WHERE l->>'qty_delta' IN ('NaN','Infinity','-Infinity') OR l->>'amount_delta' IN ('NaN','Infinity','-Infinity') OR l->>'unit_cost' IN ('NaN','Infinity','-Infinity')) THEN
    RAISE EXCEPTION 'ledger_append: finite line values required' USING ERRCODE='23514';
  END IF;
  PERFORM public.ledger_validate_event(p_event);
  INSERT INTO public.ledger_events(id,store_id,device_id,kind,occurred_at,created_at,actor,ref_type,ref_id,payload,sync_status,command_request,command_result)
  VALUES(v_id,v_store,v_device,p_event->>'kind',p_event->>'occurred_at',p_event->>'created_at',p_event->>'actor',p_event->>'ref_type',p_event->>'ref_id',coalesce(p_event->>'payload','{}'),'synced',p_event->'command_request',p_event->'command_result');
  INSERT INTO public.ledger_lines(id,event_id,store_id,device_id,account,subject_id,qty_delta,amount_delta,unit_cost,sync_status)
  SELECT l->>'id',v_id,v_store,v_device,l->>'account',l->>'subject_id',coalesce((l->>'qty_delta')::real,0),coalesce((l->>'amount_delta')::integer,0),nullif(l->>'unit_cost','')::integer,'synced'
  FROM jsonb_array_elements(p_event->'lines') l;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> jsonb_array_length(coalesce(p_event->'lines','[]'::jsonb)) THEN
    RAISE EXCEPTION 'ledger_append: not all lines were written' USING ERRCODE='23514';
  END IF;
  RETURN v_id;
END $function$
;
CREATE OR REPLACE FUNCTION public.record_financial_command(p_id text, p_store uuid, p_device uuid, p_command text, p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_request jsonb := jsonb_build_object('command',p_command,'input',p_input);
  v_old public.ledger_events%ROWTYPE;
  v_event jsonb;
  v_lines jsonb := '[]';
  v_items jsonb := '[]';
  v_item jsonb;
  v_supplier public.suppliers%ROWTYPE;
  v_invoice public.purchase_invoices%ROWTYPE;
  v_result jsonb;
  v_allocations jsonb := '[]';
  v_total numeric := 0;
  v_paid numeric;
  v_left numeric;
  v_applied numeric;
  v_quantity numeric;
  v_cost numeric;
  v_ref text;
  v_kind text;
  v_updated integer;
  -- Ledger readers compare these text timestamps with JavaScript ISO bounds.
  v_now text := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN','ACCOUNTANT']),false) THEN
    RAISE EXCEPTION 'NEXUS_FINANCE_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF nullif(p_id,'') IS NULL OR p_device IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' THEN
    RAISE EXCEPTION 'NEXUS_COMMAND_INVALID' USING ERRCODE='23514';
  END IF;
  IF p_command='ledger' AND p_input->>'kind' IN ('owner_capital','owner_contribution')
     AND NOT coalesce(public.has_role(p_store,VARIADIC ARRAY['ADMIN']),false) THEN
    RAISE EXCEPTION 'NEXUS_FINANCE_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('financial-command|' || p_id,0));
  SELECT * INTO v_old FROM public.ledger_events WHERE id=p_id AND store_id=p_store;
  IF FOUND THEN
    IF v_old.command_request IS DISTINCT FROM v_request OR v_old.command_result IS NULL THEN
      RAISE EXCEPTION 'NEXUS_OPERATION_PAYLOAD_MISMATCH' USING ERRCODE='23514';
    END IF;
    RETURN v_old.command_result || jsonb_build_object('replayed',true);
  END IF;

  IF p_command='ledger' THEN
    v_kind := p_input->>'kind';
    IF v_kind NOT IN ('owner_draw','owner_capital','owner_contribution','stock_adjustment')
       OR (v_kind='stock_adjustment' AND p_input->>'refType' IS DISTINCT FROM 'opening_balance') THEN
      RAISE EXCEPTION 'NEXUS_COMMAND_KIND' USING ERRCODE='23514';
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',gen_random_uuid()::text,'account',l->>'account','subject_id',l->>'subjectId',
      'qty_delta',coalesce((l->>'qty')::numeric,0),'amount_delta',floor(coalesce((l->>'amount')::numeric,0)*100+0.5),
      'unit_cost',floor((l->>'unitCost')::numeric*100+0.5))),'[]'::jsonb) INTO v_lines FROM jsonb_array_elements(p_input->'lines') l;
    v_event := jsonb_build_object('kind',v_kind,'ref_type',p_input->>'refType','ref_id',p_input->>'refId',
      'actor',p_input->>'actor','occurred_at',coalesce(p_input->>'occurredAt',v_now),'payload',coalesce(p_input->'payload','{}'::jsonb)::text);
    v_result := jsonb_build_object('eventId',p_id);

  ELSIF p_command='receipt' THEN
    -- Serialize receipts/payments for one supplier, including the invoice set.
    IF p_input->>'supplierId'='__new__' THEN
      IF nullif(trim(p_input->>'newSupplierName'),'') IS NULL THEN
        RAISE EXCEPTION 'NEXUS_SUPPLIER_REQUIRED' USING ERRCODE='23514';
      END IF;
      INSERT INTO public.suppliers(id,store_id,device_id,"companyName","contactPerson",phone,"createdAt","updatedAt",updated_at,sync_status)
      VALUES(p_id,p_store,p_device,trim(p_input->>'newSupplierName'),'',coalesce(p_input->>'newSupplierPhone',''),now(),now(),(extract(epoch FROM clock_timestamp())*1000)::bigint,'synced') RETURNING * INTO v_supplier;
    ELSE
      SELECT * INTO v_supplier FROM public.suppliers WHERE id=p_input->>'supplierId' AND store_id=p_store AND deleted_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_SUPPLIER_REQUIRED' USING ERRCODE='23514'; END IF;
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_input->'items') LOOP
      v_quantity := (v_item->>'quantity')::numeric;
      v_cost := (v_item->>'unitCost')::numeric;
      IF v_quantity IS NULL OR v_quantity<=0 OR v_quantity::text IN ('NaN','Infinity','-Infinity') OR v_cost IS NULL OR v_cost<0 OR v_cost::text IN ('NaN','Infinity','-Infinity') OR nullif(v_item->>'productId','') IS NULL THEN
        RAISE EXCEPTION 'NEXUS_RECEIPT_LINE_INVALID' USING ERRCODE='23514';
      END IF;
      v_total := v_total + v_quantity*v_cost;
      v_items := v_items || jsonb_build_array(v_item || jsonb_build_object('id',gen_random_uuid()::text,'sku',coalesce(v_item->>'sku',''),'total',v_quantity*v_cost));
      -- Same line semantics as buildPurchaseLines: stock by product, EGP→piastres.
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','stock','subject_id',v_item->>'productId','qty_delta',v_quantity,'amount_delta',round(v_quantity*v_cost*100),'unit_cost',round(v_cost*100)));
    END LOOP;
    IF jsonb_array_length(v_items)=0 THEN RAISE EXCEPTION 'NEXUS_RECEIPT_EMPTY' USING ERRCODE='23514'; END IF;
    v_paid := least(greatest(coalesce((p_input->>'paidAmount')::numeric,v_total),0),v_total);
    IF v_paid::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'NEXUS_AMOUNT_INVALID' USING ERRCODE='23514'; END IF;
    IF v_paid>0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','wallet','subject_id',p_input->>'wallet','amount_delta',-round(v_paid*100)));
    END IF;
    IF v_total>v_paid THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'account','payable_supplier','subject_id',v_supplier.id,'amount_delta',round((v_total-v_paid)*100)));
    END IF;
    -- Counter lock serializes invoice numbers; skip legacy numbers, no deletion.
    LOOP
      v_ref := public.next_document_number(p_store,'purchase_invoice','FM-');
      EXIT WHEN NOT EXISTS(SELECT 1 FROM public.purchase_invoices WHERE store_id=p_store AND "invoiceNumber"=v_ref);
    END LOOP;
    INSERT INTO public.purchase_invoices(id,store_id,device_id,"invoiceNumber","supplierId","supplierName",items,"totalAmount","paidAmount","remainingAmount","dueDate",status,notes,"createdAt","updatedAt",updated_at,sync_status)
    VALUES(p_id,p_store,p_device,v_ref,v_supplier.id,v_supplier."companyName",v_items,v_total,v_paid,v_total-v_paid,coalesce(p_input->>'dueDate',current_date::text),CASE WHEN v_paid>=v_total THEN 'paid' WHEN v_paid>0 THEN 'partial' ELSE 'unpaid' END,coalesce(p_input->>'notes',''),now(),now(),(extract(epoch FROM clock_timestamp())*1000)::bigint,'synced') RETURNING * INTO v_invoice;
    v_event := jsonb_build_object('kind','purchase','ref_type','supplier_invoice','ref_id',v_ref,'actor',p_input->>'actor','occurred_at',v_now,
      'payload',(jsonb_build_object('invoiceNumber',v_ref,'supplierName',v_supplier."companyName",'itemCount',jsonb_array_length(v_items),'wallet',p_input->>'wallet','via',p_input->>'via') || coalesce(p_input->'payloadExtra','{}'::jsonb))::text);
    v_result := jsonb_build_object('eventId',p_id,'invoiceId',p_id,'invoiceNumber',v_ref,'invoice',to_jsonb(v_invoice),'supplier',to_jsonb(v_supplier),'total',v_total,'itemCount',jsonb_array_length(v_items));

  ELSIF p_command='supplier_payment' THEN
    v_paid := round((p_input->>'amount')::numeric,2);
    IF v_paid IS NULL OR v_paid<=0 OR v_paid::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'NEXUS_AMOUNT_INVALID' USING ERRCODE='23514'; END IF;
    SELECT * INTO v_supplier FROM public.suppliers WHERE id=p_input->>'supplierId' AND store_id=p_store AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NEXUS_SUPPLIER_REQUIRED' USING ERRCODE='23514'; END IF;
    v_left := v_paid;
    FOR v_invoice IN SELECT * FROM public.purchase_invoices WHERE store_id=p_store AND "supplierId"=v_supplier.id AND deleted_at IS NULL AND "remainingAmount">0
      ORDER BY CASE WHEN "dueDate" IS NULL THEN "createdAt"
        WHEN pg_input_is_valid("dueDate",'timestamp with time zone') THEN "dueDate"::timestamptz
        ELSE 'infinity'::timestamptz END,"createdAt",id FOR UPDATE LOOP
      EXIT WHEN v_left<=0;
      v_applied := least(v_left,round(v_invoice."remainingAmount",2));
      v_allocations := v_allocations || jsonb_build_array(jsonb_build_object('invoiceId',v_invoice.id,'invoiceNumber',v_invoice."invoiceNumber",'outstanding',round(v_invoice."remainingAmount",2),'applied',v_applied));
      UPDATE public.purchase_invoices SET "paidAmount"="paidAmount"+v_applied,"remainingAmount"=greatest(0,"remainingAmount"-v_applied),
        status=CASE WHEN "remainingAmount"-v_applied<=0 THEN 'paid' ELSE 'partial' END,"updatedAt"=now(),updated_at=(extract(epoch FROM clock_timestamp())*1000)::bigint
        WHERE id=v_invoice.id AND store_id=p_store;
      GET DIAGNOSTICS v_updated = ROW_COUNT;
      IF v_updated <> 1 THEN RAISE EXCEPTION 'NEXUS_ALLOCATION_NOT_WRITTEN' USING ERRCODE='23514'; END IF;
      v_left := round(v_left-v_applied,2);
    END LOOP;
    v_ref := public.next_document_number(p_store,'supplier_payment','SP-');
    v_lines := jsonb_build_array(
      jsonb_build_object('id',gen_random_uuid()::text,'account','wallet','subject_id',p_input->>'wallet','amount_delta',-round(v_paid*100)),
      jsonb_build_object('id',gen_random_uuid()::text,'account','payable_supplier','subject_id',v_supplier.id,'amount_delta',-round(v_paid*100)));
    v_event := jsonb_build_object('kind','supplier_payment','ref_type','supplier_payment','ref_id',v_ref,'actor',coalesce(p_input->>'actor','الكاشير'),'occurred_at',v_now,
      'payload',jsonb_build_object('paymentRef',v_ref,'supplierId',v_supplier.id,'supplierName',v_supplier."companyName",'wallet',p_input->>'wallet','amount',v_paid,'note',coalesce(p_input->>'note',''),'allocations',v_allocations,'unapplied',v_left)::text);
    v_result := jsonb_build_object('eventId',p_id,'paymentRef',v_ref,'amount',v_paid,'applied',v_paid-v_left,'unapplied',v_left,'allocations',v_allocations);
  ELSE
    RAISE EXCEPTION 'NEXUS_COMMAND_KIND' USING ERRCODE='23514';
  END IF;
  v_result := v_result || jsonb_build_object('replayed',false);
  v_event := v_event || jsonb_build_object('id',p_id,'store_id',p_store,'device_id',p_device,'created_at',v_now,'lines',v_lines,'command_request',v_request,'command_result',v_result);
  PERFORM public.ledger_append(v_event);
  RETURN v_result;
END $function$
;
CREATE OR REPLACE FUNCTION public.next_document_number(p_store uuid, p_name text, p_prefix text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v BIGINT;
BEGIN
  IF NOT COALESCE(public.has_role(p_store, VARIADIC
    ARRAY['ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT']), false) THEN
    RAISE EXCEPTION 'not a member of this store' USING ERRCODE = '42501';
  END IF;
  IF p_name !~ '^[a-z_]{1,32}$' OR p_prefix !~ '^[A-Z]{1,6}-$' THEN
    RAISE EXCEPTION 'bad counter name or prefix';
  END IF;
  INSERT INTO public.store_counters (store_id, name, value)
  VALUES (p_store, p_name, 1)
  ON CONFLICT (store_id, name)
  DO UPDATE SET value = public.store_counters.value + 1
  RETURNING value INTO v;
  RETURN p_prefix || lpad(v::text, 4, '0');
END;
$function$
;
CREATE VIEW public."orders_operational" WITH (security_barrier=true) AS  SELECT id,
    "orderNumber",
    "customerName",
    "customerPhone",
    address,
    governorate,
    city,
        CASE
            WHEN can_read_store_finance(store_id) THEN items
            ELSE strip_line_cost(items)
        END AS items,
        CASE
            WHEN can_read_store_finance(store_id) THEN "stockItems"
            ELSE strip_line_cost("stockItems")
        END AS "stockItems",
    "totalAmount",
    "shippingFee",
    "paymentMethod",
    "depositAmount",
    "depositWallet",
    "expectedCod",
    "discountAmount",
    "discountCodeId",
    status,
    "courierId",
    "courierName",
        CASE
            WHEN can_read_store_finance(store_id) THEN "courierFee"
            ELSE NULL::numeric
        END AS "courierFee",
    "createdAt",
    "updatedAt",
    updated_at,
    "revenueLogged",
    "customerId",
    "codSettledAt",
    "returnConfirmedAt",
    "returnType",
    return_cause,
    "isExchange",
    original_order_id,
    "wholesaleClientId",
    "shippingPenaltyApplied",
    store_id,
    deleted_at,
    "wastedTripCompensation"
   FROM orders o
  WHERE is_store_member(store_id);
REVOKE ALL ON FUNCTION public."canonical_wallet_subject"(p_subject text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."canonical_wallet_subject"(p_subject text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public."canonical_wallet_subject"(p_subject text) TO "anon";
GRANT EXECUTE ON FUNCTION public."canonical_wallet_subject"(p_subject text) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."canonical_wallet_subject"(p_subject text) TO "service_role";
REVOKE ALL ON FUNCTION public."stamp_owner_budget"() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."stamp_owner_budget"() TO "service_role";
REVOKE ALL ON FUNCTION public."ledger_balances"(p_store uuid, p_account text, p_kind text, p_subject_id text, p_from timestamp with time zone, p_to timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."ledger_balances"(p_store uuid, p_account text, p_kind text, p_subject_id text, p_from timestamp with time zone, p_to timestamp with time zone) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."ledger_balances"(p_store uuid, p_account text, p_kind text, p_subject_id text, p_from timestamp with time zone, p_to timestamp with time zone) TO "service_role";
REVOKE ALL ON FUNCTION public."owner_financial_summary"(p_store uuid, p_from timestamp with time zone, p_to timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."owner_financial_summary"(p_store uuid, p_from timestamp with time zone, p_to timestamp with time zone) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."owner_financial_summary"(p_store uuid, p_from timestamp with time zone, p_to timestamp with time zone) TO "service_role";
REVOKE ALL ON FUNCTION public."record_expense"(p_expense jsonb, p_event jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."record_expense"(p_expense jsonb, p_event jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."record_expense"(p_expense jsonb, p_event jsonb) TO "service_role";
REVOKE ALL ON FUNCTION public."can_read_store_finance"(p_store_id uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."can_read_store_finance"(p_store_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."can_read_store_finance"(p_store_id uuid) TO "service_role";
REVOKE ALL ON FUNCTION public."strip_line_cost"(p_lines jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."strip_line_cost"(p_lines jsonb) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public."strip_line_cost"(p_lines jsonb) TO "anon";
GRANT EXECUTE ON FUNCTION public."strip_line_cost"(p_lines jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."strip_line_cost"(p_lines jsonb) TO "service_role";
REVOKE ALL ON FUNCTION public."mobile_stock_quantities"(p_product_ids text[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."mobile_stock_quantities"(p_product_ids text[]) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."mobile_stock_quantities"(p_product_ids text[]) TO "service_role";
REVOKE ALL ON FUNCTION public."mobile_order_timeline"(p_order_number text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."mobile_order_timeline"(p_order_number text) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."mobile_order_timeline"(p_order_number text) TO "service_role";
REVOKE ALL ON FUNCTION public."signal_store_activity"() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."signal_store_activity"() TO "service_role";
REVOKE ALL ON FUNCTION public."ledger_events_page"(p_store uuid, p_kind text, p_ref_type text, p_ref_id text, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."ledger_events_page"(p_store uuid, p_kind text, p_ref_type text, p_ref_id text, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."ledger_events_page"(p_store uuid, p_kind text, p_ref_type text, p_ref_id text, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer) TO "service_role";
REVOKE ALL ON FUNCTION public."record_wallet_transfer"(p_event jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."record_wallet_transfer"(p_event jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."record_wallet_transfer"(p_event jsonb) TO "service_role";
REVOKE ALL ON FUNCTION public."wallet_transfer_history"(p_store uuid, p_limit integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."wallet_transfer_history"(p_store uuid, p_limit integer) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."wallet_transfer_history"(p_store uuid, p_limit integer) TO "service_role";
REVOKE ALL ON FUNCTION public."is_store_member"(p_store_id uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."is_store_member"(p_store_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public."is_store_member"(p_store_id uuid) TO "anon";
GRANT EXECUTE ON FUNCTION public."is_store_member"(p_store_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."is_store_member"(p_store_id uuid) TO "service_role";
REVOKE ALL ON FUNCTION public."rls_auto_enable"() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."rls_auto_enable"() TO "service_role";
REVOKE ALL ON FUNCTION public."has_role"(p_store_id uuid, VARIADIC p_roles text[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."has_role"(p_store_id uuid, VARIADIC p_roles text[]) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public."has_role"(p_store_id uuid, VARIADIC p_roles text[]) TO "anon";
GRANT EXECUTE ON FUNCTION public."has_role"(p_store_id uuid, VARIADIC p_roles text[]) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."has_role"(p_store_id uuid, VARIADIC p_roles text[]) TO "service_role";
REVOKE ALL ON FUNCTION public."member_role"(p_store_id uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."member_role"(p_store_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public."member_role"(p_store_id uuid) TO "anon";
GRANT EXECUTE ON FUNCTION public."member_role"(p_store_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."member_role"(p_store_id uuid) TO "service_role";
REVOKE ALL ON FUNCTION public."refund_order_deposit"(p_order_id text, p_wallet text, p_note text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."refund_order_deposit"(p_order_id text, p_wallet text, p_note text) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."refund_order_deposit"(p_order_id text, p_wallet text, p_note text) TO "service_role";
REVOKE ALL ON FUNCTION public."orders_guard_return_cause"() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."orders_guard_return_cause"() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public."orders_guard_return_cause"() TO "anon";
GRANT EXECUTE ON FUNCTION public."orders_guard_return_cause"() TO "authenticated";
GRANT EXECUTE ON FUNCTION public."orders_guard_return_cause"() TO "service_role";
REVOKE ALL ON FUNCTION public."courier_claims_guard_status"() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."courier_claims_guard_status"() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public."courier_claims_guard_status"() TO "anon";
GRANT EXECUTE ON FUNCTION public."courier_claims_guard_status"() TO "authenticated";
GRANT EXECUTE ON FUNCTION public."courier_claims_guard_status"() TO "service_role";
REVOKE ALL ON FUNCTION public."touch_store_license"() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."touch_store_license"() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public."touch_store_license"() TO "anon";
GRANT EXECUTE ON FUNCTION public."touch_store_license"() TO "authenticated";
GRANT EXECUTE ON FUNCTION public."touch_store_license"() TO "service_role";
REVOKE ALL ON FUNCTION public."is_system_owner"() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."is_system_owner"() TO "authenticated";
GRANT EXECUTE ON FUNCTION public."is_system_owner"() TO "service_role";
REVOKE ALL ON FUNCTION public."list_store_members"() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."list_store_members"() TO "authenticated";
GRANT EXECUTE ON FUNCTION public."list_store_members"() TO "service_role";
REVOKE ALL ON FUNCTION public."admin_reactivate_license"(p_store_id uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."admin_reactivate_license"(p_store_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."admin_reactivate_license"(p_store_id uuid) TO "service_role";
REVOKE ALL ON FUNCTION public."admin_revoke_license"(p_store_id uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."admin_revoke_license"(p_store_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."admin_revoke_license"(p_store_id uuid) TO "service_role";
REVOKE ALL ON FUNCTION public."claim_store"(local_store_id uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."claim_store"(local_store_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."claim_store"(local_store_id uuid) TO "service_role";
REVOKE ALL ON FUNCTION public."guard_discount_usage"() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."guard_discount_usage"() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public."guard_discount_usage"() TO "anon";
GRANT EXECUTE ON FUNCTION public."guard_discount_usage"() TO "authenticated";
GRANT EXECUTE ON FUNCTION public."guard_discount_usage"() TO "service_role";
REVOKE ALL ON FUNCTION public."admin_set_license"(p_store_id uuid, p_license_key text, p_plan_type text, p_valid_until timestamp with time zone, p_status text, p_note text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."admin_set_license"(p_store_id uuid, p_license_key text, p_plan_type text, p_valid_until timestamp with time zone, p_status text, p_note text) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."admin_set_license"(p_store_id uuid, p_license_key text, p_plan_type text, p_valid_until timestamp with time zone, p_status text, p_note text) TO "service_role";
REVOKE ALL ON FUNCTION public."admin_extend_license"(p_store_id uuid, p_days integer, p_until timestamp with time zone, p_note text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."admin_extend_license"(p_store_id uuid, p_days integer, p_until timestamp with time zone, p_note text) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."admin_extend_license"(p_store_id uuid, p_days integer, p_until timestamp with time zone, p_note text) TO "service_role";
REVOKE ALL ON FUNCTION public."admin_suspend_license"(p_store_id uuid, p_note text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."admin_suspend_license"(p_store_id uuid, p_note text) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."admin_suspend_license"(p_store_id uuid, p_note text) TO "service_role";
REVOKE ALL ON FUNCTION public."admin_list_stores"() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."admin_list_stores"() TO "authenticated";
GRANT EXECUTE ON FUNCTION public."admin_list_stores"() TO "service_role";
REVOKE ALL ON FUNCTION public."ledger_validate_event"(p_event jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."ledger_validate_event"(p_event jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."ledger_validate_event"(p_event jsonb) TO "service_role";
REVOKE ALL ON FUNCTION public."products_guard_definition_columns"() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."products_guard_definition_columns"() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public."products_guard_definition_columns"() TO "anon";
GRANT EXECUTE ON FUNCTION public."products_guard_definition_columns"() TO "authenticated";
GRANT EXECUTE ON FUNCTION public."products_guard_definition_columns"() TO "service_role";
REVOKE ALL ON FUNCTION public."staff_invite_context"(p_email text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."staff_invite_context"(p_email text) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."staff_invite_context"(p_email text) TO "service_role";
REVOKE ALL ON FUNCTION public."store_licensed"(p_store_id uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."store_licensed"(p_store_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."store_licensed"(p_store_id uuid) TO "service_role";
REVOKE ALL ON FUNCTION public."_discount_usage_is_trusted"() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."_discount_usage_is_trusted"() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public."_discount_usage_is_trusted"() TO "anon";
GRANT EXECUTE ON FUNCTION public."_discount_usage_is_trusted"() TO "authenticated";
GRANT EXECUTE ON FUNCTION public."_discount_usage_is_trusted"() TO "service_role";
REVOKE ALL ON FUNCTION public."confirm_order_return"(p_order_id text, p_cause text, p_movement text, p_events jsonb, p_customer_id text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."confirm_order_return"(p_order_id text, p_cause text, p_movement text, p_events jsonb, p_customer_id text) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."confirm_order_return"(p_order_id text, p_cause text, p_movement text, p_events jsonb, p_customer_id text) TO "service_role";
REVOKE ALL ON FUNCTION public."mobile_shortages"(p_store uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."mobile_shortages"(p_store uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."mobile_shortages"(p_store uuid) TO "service_role";
REVOKE ALL ON FUNCTION public."claim_discount_use"(p_store uuid, p_code_id text, p_amount numeric) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."claim_discount_use"(p_store uuid, p_code_id text, p_amount numeric) TO "anon";
GRANT EXECUTE ON FUNCTION public."claim_discount_use"(p_store uuid, p_code_id text, p_amount numeric) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."claim_discount_use"(p_store uuid, p_code_id text, p_amount numeric) TO "service_role";
REVOKE ALL ON FUNCTION public."release_discount_use"(p_store uuid, p_code_id text, p_amount numeric) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."release_discount_use"(p_store uuid, p_code_id text, p_amount numeric) TO "anon";
GRANT EXECUTE ON FUNCTION public."release_discount_use"(p_store uuid, p_code_id text, p_amount numeric) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."release_discount_use"(p_store uuid, p_code_id text, p_amount numeric) TO "service_role";
REVOKE ALL ON FUNCTION public."adjust_discount_total"(p_store uuid, p_code_id text, p_delta numeric) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."adjust_discount_total"(p_store uuid, p_code_id text, p_delta numeric) TO "anon";
GRANT EXECUTE ON FUNCTION public."adjust_discount_total"(p_store uuid, p_code_id text, p_delta numeric) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."adjust_discount_total"(p_store uuid, p_code_id text, p_delta numeric) TO "service_role";
REVOKE ALL ON FUNCTION public."place_order"(p_order jsonb, p_event jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."place_order"(p_order jsonb, p_event jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."place_order"(p_order jsonb, p_event jsonb) TO "service_role";
REVOKE ALL ON FUNCTION public."record_payroll"(p_payroll jsonb, p_event jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."record_payroll"(p_payroll jsonb, p_event jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."record_payroll"(p_payroll jsonb, p_event jsonb) TO "service_role";
REVOKE ALL ON FUNCTION public."record_fixed_asset"(p_asset jsonb, p_event jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."record_fixed_asset"(p_asset jsonb, p_event jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."record_fixed_asset"(p_asset jsonb, p_event jsonb) TO "service_role";
REVOKE ALL ON FUNCTION public."cancel_order"(p_order_id text, p_cause text, p_event jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."cancel_order"(p_order_id text, p_cause text, p_event jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."cancel_order"(p_order_id text, p_cause text, p_event jsonb) TO "service_role";
REVOKE ALL ON FUNCTION public."ledger_append"(p_event jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."ledger_append"(p_event jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."ledger_append"(p_event jsonb) TO "service_role";
REVOKE ALL ON FUNCTION public."record_financial_command"(p_id text, p_store uuid, p_device uuid, p_command text, p_input jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."record_financial_command"(p_id text, p_store uuid, p_device uuid, p_command text, p_input jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."record_financial_command"(p_id text, p_store uuid, p_device uuid, p_command text, p_input jsonb) TO "service_role";
REVOKE ALL ON FUNCTION public."next_document_number"(p_store uuid, p_name text, p_prefix text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."next_document_number"(p_store uuid, p_name text, p_prefix text) TO "authenticated";
GRANT EXECUTE ON FUNCTION public."next_document_number"(p_store uuid, p_name text, p_prefix text) TO "service_role";
CREATE POLICY "select_store_licenses" ON public."store_licenses" AS PERMISSIVE FOR SELECT TO PUBLIC USING (is_store_member(store_id)) ;
CREATE POLICY "select_store_activity" ON public."store_activity" AS PERMISSIVE FOR SELECT TO PUBLIC USING (is_store_member(store_id)) ;
CREATE POLICY "select_partners" ON public."partners" AS PERMISSIVE FOR SELECT TO PUBLIC USING ((is_store_member(store_id) AND (EXISTS ( SELECT 1
   FROM store_members m
  WHERE ((m.store_id = partners.store_id) AND (m.user_id = auth.uid()) AND ((m.role)::text = ANY ((ARRAY['ADMIN'::character varying, 'ACCOUNTANT'::character varying])::text[]))))))) ;
CREATE POLICY "no_insert_store_licenses" ON public."store_licenses" AS PERMISSIVE FOR INSERT TO PUBLIC  WITH CHECK (false);
CREATE POLICY "no_update_store_licenses" ON public."store_licenses" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (false) ;
CREATE POLICY "no_delete_store_licenses" ON public."store_licenses" AS PERMISSIVE FOR DELETE TO PUBLIC USING (false) ;
CREATE POLICY "select_couriers" ON public."couriers" AS PERMISSIVE FOR SELECT TO PUBLIC USING (is_store_member(store_id)) ;
CREATE POLICY "write_couriers" ON public."couriers" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text]));
CREATE POLICY "insert_ledger_lines" ON public."ledger_lines" AS PERMISSIVE FOR INSERT TO PUBLIC  WITH CHECK ((has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'POS_ECOMMERCE'::text, 'ECOMMERCE_ONLY'::text, 'ACCOUNTANT'::text]) AND (EXISTS ( SELECT 1
   FROM ledger_events e
  WHERE ((e.id = ledger_lines.event_id) AND (e.store_id = ledger_lines.store_id) AND (e.xmin = (pg_current_xact_id())::xid))))));
CREATE POLICY "write_purchase_invoices" ON public."purchase_invoices" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text]));
CREATE POLICY "select_ledger_lines" ON public."ledger_lines" AS PERMISSIVE FOR SELECT TO PUBLIC USING (can_read_store_finance(store_id)) ;
CREATE POLICY "update_products" ON public."products" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'POS_ECOMMERCE'::text, 'ECOMMERCE_ONLY'::text, 'ACCOUNTANT'::text])) ;
CREATE POLICY "select_ledger_events" ON public."ledger_events" AS PERMISSIVE FOR SELECT TO PUBLIC USING (can_read_store_finance(store_id)) ;
CREATE POLICY "select_purchase_invoices" ON public."purchase_invoices" AS PERMISSIVE FOR SELECT TO PUBLIC USING (can_read_store_finance(store_id)) ;
CREATE POLICY "select_store_members" ON public."store_members" AS PERMISSIVE FOR SELECT TO PUBLIC USING (((user_id = auth.uid()) OR (member_role(store_id) = 'ADMIN'::text))) ;
CREATE POLICY "write_partners" ON public."partners" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text]));
CREATE POLICY "write_expenses" ON public."expenses" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text]));
CREATE POLICY "write_transactions" ON public."transactions" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text]));
CREATE POLICY "select_expenses" ON public."expenses" AS PERMISSIVE FOR SELECT TO PUBLIC USING (can_read_store_finance(store_id)) ;
CREATE POLICY "select_transactions" ON public."transactions" AS PERMISSIVE FOR SELECT TO PUBLIC USING (can_read_store_finance(store_id)) ;
CREATE POLICY "insert_ledger_events" ON public."ledger_events" AS PERMISSIVE FOR INSERT TO PUBLIC  WITH CHECK ((is_store_member(store_id) AND
CASE
    WHEN (kind = ANY (ARRAY['owner_capital'::text, 'owner_contribution'::text])) THEN has_role(store_id, VARIADIC ARRAY['ADMIN'::text])
    WHEN (kind = ANY (ARRAY['stock_adjustment'::text, 'purchase'::text, 'supplier_payment'::text])) THEN has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])
    WHEN (kind = ANY (ARRAY['expense'::text, 'payroll'::text, 'owner_draw'::text, 'wallet_transfer'::text, 'deposit_refunded'::text])) THEN has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])
    ELSE has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'POS_ECOMMERCE'::text, 'ECOMMERCE_ONLY'::text, 'ACCOUNTANT'::text])
END));
CREATE POLICY "owner_budgets_insert" ON public."owner_budgets" AS PERMISSIVE FOR INSERT TO "authenticated"  WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text]));
CREATE POLICY "owner_budgets_read" ON public."owner_budgets" AS PERMISSIVE FOR SELECT TO "authenticated" USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])) ;
CREATE POLICY "select_orders" ON public."orders" AS PERMISSIVE FOR SELECT TO PUBLIC USING (can_read_store_finance(store_id)) ;
CREATE POLICY "select_wholesale_clients" ON public."wholesale_clients" AS PERMISSIVE FOR SELECT TO PUBLIC USING (can_read_store_finance(store_id)) ;
CREATE POLICY "select_courier_claims" ON public."courier_claims" AS PERMISSIVE FOR SELECT TO PUBLIC USING (can_read_store_finance(store_id)) ;
CREATE POLICY "select_branches" ON public."branches" AS PERMISSIVE FOR SELECT TO PUBLIC USING (is_store_member(store_id)) ;
CREATE POLICY "admin_writes_store_members" ON public."store_members" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text]));
CREATE POLICY "write_wholesale_clients" ON public."wholesale_clients" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text]));
CREATE POLICY "write_wholesale_invoices" ON public."wholesale_invoices" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text]));
CREATE POLICY "write_courier_claims" ON public."courier_claims" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text]));
CREATE POLICY "select_wholesale_invoices" ON public."wholesale_invoices" AS PERMISSIVE FOR SELECT TO PUBLIC USING (can_read_store_finance(store_id)) ;
CREATE POLICY "select_shipping_rates" ON public."shipping_rates" AS PERMISSIVE FOR SELECT TO PUBLIC USING (is_store_member(store_id)) ;
CREATE POLICY "write_shipping_rates" ON public."shipping_rates" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text]));
CREATE POLICY "select_suppliers" ON public."suppliers" AS PERMISSIVE FOR SELECT TO PUBLIC USING (can_read_store_finance(store_id)) ;
CREATE POLICY "select_return_records" ON public."return_records" AS PERMISSIVE FOR SELECT TO PUBLIC USING (can_read_store_finance(store_id)) ;
CREATE POLICY "select_discount_codes" ON public."discount_codes" AS PERMISSIVE FOR SELECT TO PUBLIC USING (can_read_store_finance(store_id)) ;
CREATE POLICY "select_products" ON public."products" AS PERMISSIVE FOR SELECT TO PUBLIC USING (is_store_member(store_id)) ;
CREATE POLICY "select_customers" ON public."customers" AS PERMISSIVE FOR SELECT TO PUBLIC USING (is_store_member(store_id)) ;
CREATE POLICY "select_stores" ON public."stores" AS PERMISSIVE FOR SELECT TO PUBLIC USING (is_store_member(id)) ;
CREATE POLICY "update_stores" ON public."stores" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (has_role(id, VARIADIC ARRAY['ADMIN'::text])) WITH CHECK (has_role(id, VARIADIC ARRAY['ADMIN'::text]));
CREATE POLICY "write_store_members" ON public."store_members" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text]));
CREATE POLICY "own_profile" ON public."profiles" AS PERMISSIVE FOR SELECT TO PUBLIC USING ((id = auth.uid())) ;
CREATE POLICY "write_products" ON public."products" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text]));
CREATE POLICY "write_suppliers" ON public."suppliers" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text]));
CREATE POLICY "write_branches" ON public."branches" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text]));
CREATE POLICY "write_customers" ON public."customers" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'POS_ECOMMERCE'::text, 'ECOMMERCE_ONLY'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'POS_ECOMMERCE'::text, 'ECOMMERCE_ONLY'::text]));
CREATE POLICY "write_discount_codes" ON public."discount_codes" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'POS_ECOMMERCE'::text, 'ECOMMERCE_ONLY'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'POS_ECOMMERCE'::text, 'ECOMMERCE_ONLY'::text]));
CREATE POLICY "write_return_records" ON public."return_records" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'POS_ECOMMERCE'::text, 'ECOMMERCE_ONLY'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'POS_ECOMMERCE'::text, 'ECOMMERCE_ONLY'::text]));
CREATE POLICY "write_orders" ON public."orders" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'POS_ECOMMERCE'::text, 'ECOMMERCE_ONLY'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'POS_ECOMMERCE'::text, 'ECOMMERCE_ONLY'::text]));
CREATE POLICY "no_update_ledger_events" ON public."ledger_events" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (false) ;
CREATE POLICY "no_delete_ledger_events" ON public."ledger_events" AS PERMISSIVE FOR DELETE TO PUBLIC USING (false) ;
CREATE POLICY "no_update_ledger_lines" ON public."ledger_lines" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (false) ;
CREATE POLICY "no_delete_ledger_lines" ON public."ledger_lines" AS PERMISSIVE FOR DELETE TO PUBLIC USING (false) ;
CREATE POLICY "select_fixed_assets" ON public."fixed_assets" AS PERMISSIVE FOR SELECT TO PUBLIC USING ((is_store_member(store_id) AND (EXISTS ( SELECT 1
   FROM store_members m
  WHERE ((m.store_id = fixed_assets.store_id) AND (m.user_id = auth.uid()) AND ((m.role)::text = ANY ((ARRAY['ADMIN'::character varying, 'ACCOUNTANT'::character varying])::text[]))))))) ;
CREATE POLICY "write_fixed_assets" ON public."fixed_assets" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text]));
CREATE POLICY "select_budget_caps" ON public."budget_caps" AS PERMISSIVE FOR SELECT TO PUBLIC USING ((is_store_member(store_id) AND (EXISTS ( SELECT 1
   FROM store_members m
  WHERE ((m.store_id = budget_caps.store_id) AND (m.user_id = auth.uid()) AND ((m.role)::text = ANY ((ARRAY['ADMIN'::character varying, 'ACCOUNTANT'::character varying])::text[]))))))) ;
CREATE POLICY "write_budget_caps" ON public."budget_caps" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text]));
CREATE POLICY "select_payroll" ON public."payroll" AS PERMISSIVE FOR SELECT TO PUBLIC USING ((is_store_member(store_id) AND (EXISTS ( SELECT 1
   FROM store_members m
  WHERE ((m.store_id = payroll.store_id) AND (m.user_id = auth.uid()) AND ((m.role)::text = ANY ((ARRAY['ADMIN'::character varying, 'ACCOUNTANT'::character varying])::text[]))))))) ;
CREATE POLICY "write_payroll" ON public."payroll" AS PERMISSIVE FOR ALL TO PUBLIC USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text]));
CREATE POLICY "owner_budgets_update" ON public."owner_budgets" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])) WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text]));
CREATE POLICY "owner_budgets_delete" ON public."owner_budgets" AS PERMISSIVE FOR DELETE TO "authenticated" USING (has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])) ;
ALTER TABLE public."courier_claims" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."couriers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."store_activity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."expenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."store_licenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."store_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."store_alias" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."wholesale_clients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."stores" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ledger_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."wholesale_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."store_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ledger_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."shipping_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."return_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."discount_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."partners" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."auth_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."fixed_assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."budget_caps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."auth_login_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."suppliers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."purchase_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."payroll" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."owner_budgets" ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER owner_budget_timestamp BEFORE INSERT OR UPDATE ON public.owner_budgets FOR EACH ROW EXECUTE FUNCTION stamp_owner_budget();
CREATE TRIGGER trg_touch_store_license BEFORE UPDATE ON public.store_licenses FOR EACH ROW EXECUTE FUNCTION touch_store_license();
CREATE TRIGGER products_guard_definition_columns BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION products_guard_definition_columns();
CREATE TRIGGER discount_usage_guard BEFORE UPDATE ON public.discount_codes FOR EACH ROW EXECUTE FUNCTION guard_discount_usage();
CREATE TRIGGER orders_guard_return_cause BEFORE INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION orders_guard_return_cause();
CREATE TRIGGER courier_claims_guard_status BEFORE INSERT OR UPDATE ON public.courier_claims FOR EACH ROW EXECUTE FUNCTION courier_claims_guard_status();
CREATE TRIGGER signal_store_activity AFTER INSERT ON public.ledger_events FOR EACH ROW EXECUTE FUNCTION signal_store_activity('ledger_events');
CREATE TRIGGER signal_store_activity AFTER INSERT OR DELETE OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION signal_store_activity('orders');
GRANT INSERT ON public."courier_claims" TO "anon" ;
GRANT SELECT ON public."courier_claims" TO "anon" ;
GRANT UPDATE ON public."courier_claims" TO "anon" ;
GRANT DELETE ON public."courier_claims" TO "anon" ;
GRANT TRUNCATE ON public."courier_claims" TO "anon" ;
GRANT REFERENCES ON public."courier_claims" TO "anon" ;
GRANT TRIGGER ON public."courier_claims" TO "anon" ;
GRANT INSERT ON public."courier_claims" TO "authenticated" ;
GRANT SELECT ON public."courier_claims" TO "authenticated" ;
GRANT UPDATE ON public."courier_claims" TO "authenticated" ;
GRANT DELETE ON public."courier_claims" TO "authenticated" ;
GRANT TRUNCATE ON public."courier_claims" TO "authenticated" ;
GRANT REFERENCES ON public."courier_claims" TO "authenticated" ;
GRANT TRIGGER ON public."courier_claims" TO "authenticated" ;
GRANT INSERT ON public."courier_claims" TO "service_role" ;
GRANT SELECT ON public."courier_claims" TO "service_role" ;
GRANT UPDATE ON public."courier_claims" TO "service_role" ;
GRANT DELETE ON public."courier_claims" TO "service_role" ;
GRANT TRUNCATE ON public."courier_claims" TO "service_role" ;
GRANT REFERENCES ON public."courier_claims" TO "service_role" ;
GRANT TRIGGER ON public."courier_claims" TO "service_role" ;
GRANT INSERT ON public."orders_operational" TO "authenticated" ;
GRANT SELECT ON public."orders_operational" TO "authenticated" ;
GRANT UPDATE ON public."orders_operational" TO "authenticated" ;
GRANT DELETE ON public."orders_operational" TO "authenticated" ;
GRANT TRUNCATE ON public."orders_operational" TO "authenticated" ;
GRANT REFERENCES ON public."orders_operational" TO "authenticated" ;
GRANT TRIGGER ON public."orders_operational" TO "authenticated" ;
GRANT INSERT ON public."orders_operational" TO "service_role" ;
GRANT SELECT ON public."orders_operational" TO "service_role" ;
GRANT UPDATE ON public."orders_operational" TO "service_role" ;
GRANT DELETE ON public."orders_operational" TO "service_role" ;
GRANT TRUNCATE ON public."orders_operational" TO "service_role" ;
GRANT REFERENCES ON public."orders_operational" TO "service_role" ;
GRANT TRIGGER ON public."orders_operational" TO "service_role" ;
GRANT INSERT ON public."couriers" TO "authenticated" ;
GRANT SELECT ON public."couriers" TO "authenticated" ;
GRANT UPDATE ON public."couriers" TO "authenticated" ;
GRANT DELETE ON public."couriers" TO "authenticated" ;
GRANT TRUNCATE ON public."couriers" TO "authenticated" ;
GRANT REFERENCES ON public."couriers" TO "authenticated" ;
GRANT TRIGGER ON public."couriers" TO "authenticated" ;
GRANT INSERT ON public."couriers" TO "service_role" ;
GRANT SELECT ON public."couriers" TO "service_role" ;
GRANT UPDATE ON public."couriers" TO "service_role" ;
GRANT DELETE ON public."couriers" TO "service_role" ;
GRANT TRUNCATE ON public."couriers" TO "service_role" ;
GRANT REFERENCES ON public."couriers" TO "service_role" ;
GRANT TRIGGER ON public."couriers" TO "service_role" ;
GRANT SELECT ON public."store_activity" TO "authenticated" ;
GRANT REFERENCES ON public."store_activity" TO "authenticated" ;
GRANT TRIGGER ON public."store_activity" TO "authenticated" ;
GRANT INSERT ON public."store_activity" TO "service_role" ;
GRANT SELECT ON public."store_activity" TO "service_role" ;
GRANT UPDATE ON public."store_activity" TO "service_role" ;
GRANT DELETE ON public."store_activity" TO "service_role" ;
GRANT TRUNCATE ON public."store_activity" TO "service_role" ;
GRANT REFERENCES ON public."store_activity" TO "service_role" ;
GRANT TRIGGER ON public."store_activity" TO "service_role" ;
GRANT INSERT ON public."users" TO "anon" ;
GRANT SELECT ON public."users" TO "anon" ;
GRANT UPDATE ON public."users" TO "anon" ;
GRANT DELETE ON public."users" TO "anon" ;
GRANT TRUNCATE ON public."users" TO "anon" ;
GRANT REFERENCES ON public."users" TO "anon" ;
GRANT TRIGGER ON public."users" TO "anon" ;
GRANT INSERT ON public."users" TO "authenticated" ;
GRANT SELECT ON public."users" TO "authenticated" ;
GRANT UPDATE ON public."users" TO "authenticated" ;
GRANT DELETE ON public."users" TO "authenticated" ;
GRANT TRUNCATE ON public."users" TO "authenticated" ;
GRANT REFERENCES ON public."users" TO "authenticated" ;
GRANT TRIGGER ON public."users" TO "authenticated" ;
GRANT INSERT ON public."users" TO "service_role" ;
GRANT SELECT ON public."users" TO "service_role" ;
GRANT UPDATE ON public."users" TO "service_role" ;
GRANT DELETE ON public."users" TO "service_role" ;
GRANT TRUNCATE ON public."users" TO "service_role" ;
GRANT REFERENCES ON public."users" TO "service_role" ;
GRANT TRIGGER ON public."users" TO "service_role" ;
GRANT INSERT ON public."profiles" TO "anon" ;
GRANT SELECT ON public."profiles" TO "anon" ;
GRANT UPDATE ON public."profiles" TO "anon" ;
GRANT DELETE ON public."profiles" TO "anon" ;
GRANT TRUNCATE ON public."profiles" TO "anon" ;
GRANT REFERENCES ON public."profiles" TO "anon" ;
GRANT TRIGGER ON public."profiles" TO "anon" ;
GRANT INSERT ON public."profiles" TO "authenticated" ;
GRANT SELECT ON public."profiles" TO "authenticated" ;
GRANT UPDATE ON public."profiles" TO "authenticated" ;
GRANT DELETE ON public."profiles" TO "authenticated" ;
GRANT TRUNCATE ON public."profiles" TO "authenticated" ;
GRANT REFERENCES ON public."profiles" TO "authenticated" ;
GRANT TRIGGER ON public."profiles" TO "authenticated" ;
GRANT INSERT ON public."profiles" TO "service_role" ;
GRANT SELECT ON public."profiles" TO "service_role" ;
GRANT UPDATE ON public."profiles" TO "service_role" ;
GRANT DELETE ON public."profiles" TO "service_role" ;
GRANT TRUNCATE ON public."profiles" TO "service_role" ;
GRANT REFERENCES ON public."profiles" TO "service_role" ;
GRANT TRIGGER ON public."profiles" TO "service_role" ;
GRANT INSERT ON public."expenses" TO "anon" ;
GRANT SELECT ON public."expenses" TO "anon" ;
GRANT UPDATE ON public."expenses" TO "anon" ;
GRANT DELETE ON public."expenses" TO "anon" ;
GRANT TRUNCATE ON public."expenses" TO "anon" ;
GRANT REFERENCES ON public."expenses" TO "anon" ;
GRANT TRIGGER ON public."expenses" TO "anon" ;
GRANT INSERT ON public."expenses" TO "authenticated" ;
GRANT SELECT ON public."expenses" TO "authenticated" ;
GRANT UPDATE ON public."expenses" TO "authenticated" ;
GRANT DELETE ON public."expenses" TO "authenticated" ;
GRANT TRUNCATE ON public."expenses" TO "authenticated" ;
GRANT REFERENCES ON public."expenses" TO "authenticated" ;
GRANT TRIGGER ON public."expenses" TO "authenticated" ;
GRANT INSERT ON public."expenses" TO "service_role" ;
GRANT SELECT ON public."expenses" TO "service_role" ;
GRANT UPDATE ON public."expenses" TO "service_role" ;
GRANT DELETE ON public."expenses" TO "service_role" ;
GRANT TRUNCATE ON public."expenses" TO "service_role" ;
GRANT REFERENCES ON public."expenses" TO "service_role" ;
GRANT TRIGGER ON public."expenses" TO "service_role" ;
GRANT INSERT ON public."transactions" TO "anon" ;
GRANT SELECT ON public."transactions" TO "anon" ;
GRANT UPDATE ON public."transactions" TO "anon" ;
GRANT DELETE ON public."transactions" TO "anon" ;
GRANT TRUNCATE ON public."transactions" TO "anon" ;
GRANT REFERENCES ON public."transactions" TO "anon" ;
GRANT TRIGGER ON public."transactions" TO "anon" ;
GRANT INSERT ON public."transactions" TO "authenticated" ;
GRANT SELECT ON public."transactions" TO "authenticated" ;
GRANT UPDATE ON public."transactions" TO "authenticated" ;
GRANT DELETE ON public."transactions" TO "authenticated" ;
GRANT TRUNCATE ON public."transactions" TO "authenticated" ;
GRANT REFERENCES ON public."transactions" TO "authenticated" ;
GRANT TRIGGER ON public."transactions" TO "authenticated" ;
GRANT INSERT ON public."transactions" TO "service_role" ;
GRANT SELECT ON public."transactions" TO "service_role" ;
GRANT UPDATE ON public."transactions" TO "service_role" ;
GRANT DELETE ON public."transactions" TO "service_role" ;
GRANT TRUNCATE ON public."transactions" TO "service_role" ;
GRANT REFERENCES ON public."transactions" TO "service_role" ;
GRANT TRIGGER ON public."transactions" TO "service_role" ;
GRANT INSERT ON public."orders" TO "anon" ;
GRANT SELECT ON public."orders" TO "anon" ;
GRANT UPDATE ON public."orders" TO "anon" ;
GRANT DELETE ON public."orders" TO "anon" ;
GRANT TRUNCATE ON public."orders" TO "anon" ;
GRANT REFERENCES ON public."orders" TO "anon" ;
GRANT TRIGGER ON public."orders" TO "anon" ;
GRANT INSERT ON public."orders" TO "authenticated" ;
GRANT SELECT ON public."orders" TO "authenticated" ;
GRANT UPDATE ON public."orders" TO "authenticated" ;
GRANT DELETE ON public."orders" TO "authenticated" ;
GRANT TRUNCATE ON public."orders" TO "authenticated" ;
GRANT REFERENCES ON public."orders" TO "authenticated" ;
GRANT TRIGGER ON public."orders" TO "authenticated" ;
GRANT INSERT ON public."orders" TO "service_role" ;
GRANT SELECT ON public."orders" TO "service_role" ;
GRANT UPDATE ON public."orders" TO "service_role" ;
GRANT DELETE ON public."orders" TO "service_role" ;
GRANT TRUNCATE ON public."orders" TO "service_role" ;
GRANT REFERENCES ON public."orders" TO "service_role" ;
GRANT TRIGGER ON public."orders" TO "service_role" ;
GRANT INSERT ON public."store_licenses" TO "anon" ;
GRANT SELECT ON public."store_licenses" TO "anon" ;
GRANT UPDATE ON public."store_licenses" TO "anon" ;
GRANT DELETE ON public."store_licenses" TO "anon" ;
GRANT TRUNCATE ON public."store_licenses" TO "anon" ;
GRANT REFERENCES ON public."store_licenses" TO "anon" ;
GRANT TRIGGER ON public."store_licenses" TO "anon" ;
GRANT INSERT ON public."store_licenses" TO "authenticated" ;
GRANT SELECT ON public."store_licenses" TO "authenticated" ;
GRANT UPDATE ON public."store_licenses" TO "authenticated" ;
GRANT DELETE ON public."store_licenses" TO "authenticated" ;
GRANT TRUNCATE ON public."store_licenses" TO "authenticated" ;
GRANT REFERENCES ON public."store_licenses" TO "authenticated" ;
GRANT TRIGGER ON public."store_licenses" TO "authenticated" ;
GRANT INSERT ON public."store_licenses" TO "service_role" ;
GRANT SELECT ON public."store_licenses" TO "service_role" ;
GRANT UPDATE ON public."store_licenses" TO "service_role" ;
GRANT DELETE ON public."store_licenses" TO "service_role" ;
GRANT TRUNCATE ON public."store_licenses" TO "service_role" ;
GRANT REFERENCES ON public."store_licenses" TO "service_role" ;
GRANT TRIGGER ON public."store_licenses" TO "service_role" ;
GRANT INSERT ON public."store_members" TO "anon" ;
GRANT SELECT ON public."store_members" TO "anon" ;
GRANT UPDATE ON public."store_members" TO "anon" ;
GRANT DELETE ON public."store_members" TO "anon" ;
GRANT TRUNCATE ON public."store_members" TO "anon" ;
GRANT REFERENCES ON public."store_members" TO "anon" ;
GRANT TRIGGER ON public."store_members" TO "anon" ;
GRANT INSERT ON public."store_members" TO "authenticated" ;
GRANT SELECT ON public."store_members" TO "authenticated" ;
GRANT UPDATE ON public."store_members" TO "authenticated" ;
GRANT DELETE ON public."store_members" TO "authenticated" ;
GRANT TRUNCATE ON public."store_members" TO "authenticated" ;
GRANT REFERENCES ON public."store_members" TO "authenticated" ;
GRANT TRIGGER ON public."store_members" TO "authenticated" ;
GRANT INSERT ON public."store_members" TO "service_role" ;
GRANT SELECT ON public."store_members" TO "service_role" ;
GRANT UPDATE ON public."store_members" TO "service_role" ;
GRANT DELETE ON public."store_members" TO "service_role" ;
GRANT TRUNCATE ON public."store_members" TO "service_role" ;
GRANT REFERENCES ON public."store_members" TO "service_role" ;
GRANT TRIGGER ON public."store_members" TO "service_role" ;
GRANT INSERT ON public."store_alias" TO "anon" ;
GRANT SELECT ON public."store_alias" TO "anon" ;
GRANT UPDATE ON public."store_alias" TO "anon" ;
GRANT DELETE ON public."store_alias" TO "anon" ;
GRANT TRUNCATE ON public."store_alias" TO "anon" ;
GRANT REFERENCES ON public."store_alias" TO "anon" ;
GRANT TRIGGER ON public."store_alias" TO "anon" ;
GRANT INSERT ON public."store_alias" TO "authenticated" ;
GRANT SELECT ON public."store_alias" TO "authenticated" ;
GRANT UPDATE ON public."store_alias" TO "authenticated" ;
GRANT DELETE ON public."store_alias" TO "authenticated" ;
GRANT TRUNCATE ON public."store_alias" TO "authenticated" ;
GRANT REFERENCES ON public."store_alias" TO "authenticated" ;
GRANT TRIGGER ON public."store_alias" TO "authenticated" ;
GRANT INSERT ON public."store_alias" TO "service_role" ;
GRANT SELECT ON public."store_alias" TO "service_role" ;
GRANT UPDATE ON public."store_alias" TO "service_role" ;
GRANT DELETE ON public."store_alias" TO "service_role" ;
GRANT TRUNCATE ON public."store_alias" TO "service_role" ;
GRANT REFERENCES ON public."store_alias" TO "service_role" ;
GRANT TRIGGER ON public."store_alias" TO "service_role" ;
GRANT INSERT ON public."wholesale_clients" TO "anon" ;
GRANT SELECT ON public."wholesale_clients" TO "anon" ;
GRANT UPDATE ON public."wholesale_clients" TO "anon" ;
GRANT DELETE ON public."wholesale_clients" TO "anon" ;
GRANT TRUNCATE ON public."wholesale_clients" TO "anon" ;
GRANT REFERENCES ON public."wholesale_clients" TO "anon" ;
GRANT TRIGGER ON public."wholesale_clients" TO "anon" ;
GRANT INSERT ON public."wholesale_clients" TO "authenticated" ;
GRANT SELECT ON public."wholesale_clients" TO "authenticated" ;
GRANT UPDATE ON public."wholesale_clients" TO "authenticated" ;
GRANT DELETE ON public."wholesale_clients" TO "authenticated" ;
GRANT TRUNCATE ON public."wholesale_clients" TO "authenticated" ;
GRANT REFERENCES ON public."wholesale_clients" TO "authenticated" ;
GRANT TRIGGER ON public."wholesale_clients" TO "authenticated" ;
GRANT INSERT ON public."wholesale_clients" TO "service_role" ;
GRANT SELECT ON public."wholesale_clients" TO "service_role" ;
GRANT UPDATE ON public."wholesale_clients" TO "service_role" ;
GRANT DELETE ON public."wholesale_clients" TO "service_role" ;
GRANT TRUNCATE ON public."wholesale_clients" TO "service_role" ;
GRANT REFERENCES ON public."wholesale_clients" TO "service_role" ;
GRANT TRIGGER ON public."wholesale_clients" TO "service_role" ;
GRANT INSERT ON public."stores" TO "anon" ;
GRANT SELECT ON public."stores" TO "anon" ;
GRANT UPDATE ON public."stores" TO "anon" ;
GRANT DELETE ON public."stores" TO "anon" ;
GRANT TRUNCATE ON public."stores" TO "anon" ;
GRANT REFERENCES ON public."stores" TO "anon" ;
GRANT TRIGGER ON public."stores" TO "anon" ;
GRANT INSERT ON public."stores" TO "authenticated" ;
GRANT SELECT ON public."stores" TO "authenticated" ;
GRANT UPDATE ON public."stores" TO "authenticated" ;
GRANT DELETE ON public."stores" TO "authenticated" ;
GRANT TRUNCATE ON public."stores" TO "authenticated" ;
GRANT REFERENCES ON public."stores" TO "authenticated" ;
GRANT TRIGGER ON public."stores" TO "authenticated" ;
GRANT INSERT ON public."stores" TO "service_role" ;
GRANT SELECT ON public."stores" TO "service_role" ;
GRANT UPDATE ON public."stores" TO "service_role" ;
GRANT DELETE ON public."stores" TO "service_role" ;
GRANT TRUNCATE ON public."stores" TO "service_role" ;
GRANT REFERENCES ON public."stores" TO "service_role" ;
GRANT TRIGGER ON public."stores" TO "service_role" ;
GRANT INSERT ON public."ledger_lines" TO "anon" ;
GRANT SELECT ON public."ledger_lines" TO "anon" ;
GRANT UPDATE ON public."ledger_lines" TO "anon" ;
GRANT DELETE ON public."ledger_lines" TO "anon" ;
GRANT TRUNCATE ON public."ledger_lines" TO "anon" ;
GRANT REFERENCES ON public."ledger_lines" TO "anon" ;
GRANT TRIGGER ON public."ledger_lines" TO "anon" ;
GRANT INSERT ON public."ledger_lines" TO "authenticated" ;
GRANT SELECT ON public."ledger_lines" TO "authenticated" ;
GRANT UPDATE ON public."ledger_lines" TO "authenticated" ;
GRANT DELETE ON public."ledger_lines" TO "authenticated" ;
GRANT TRUNCATE ON public."ledger_lines" TO "authenticated" ;
GRANT REFERENCES ON public."ledger_lines" TO "authenticated" ;
GRANT TRIGGER ON public."ledger_lines" TO "authenticated" ;
GRANT INSERT ON public."ledger_lines" TO "service_role" ;
GRANT SELECT ON public."ledger_lines" TO "service_role" ;
GRANT UPDATE ON public."ledger_lines" TO "service_role" ;
GRANT DELETE ON public."ledger_lines" TO "service_role" ;
GRANT TRUNCATE ON public."ledger_lines" TO "service_role" ;
GRANT REFERENCES ON public."ledger_lines" TO "service_role" ;
GRANT TRIGGER ON public."ledger_lines" TO "service_role" ;
GRANT INSERT ON public."wholesale_invoices" TO "anon" ;
GRANT SELECT ON public."wholesale_invoices" TO "anon" ;
GRANT UPDATE ON public."wholesale_invoices" TO "anon" ;
GRANT DELETE ON public."wholesale_invoices" TO "anon" ;
GRANT TRUNCATE ON public."wholesale_invoices" TO "anon" ;
GRANT REFERENCES ON public."wholesale_invoices" TO "anon" ;
GRANT TRIGGER ON public."wholesale_invoices" TO "anon" ;
GRANT INSERT ON public."wholesale_invoices" TO "authenticated" ;
GRANT SELECT ON public."wholesale_invoices" TO "authenticated" ;
GRANT UPDATE ON public."wholesale_invoices" TO "authenticated" ;
GRANT DELETE ON public."wholesale_invoices" TO "authenticated" ;
GRANT TRUNCATE ON public."wholesale_invoices" TO "authenticated" ;
GRANT REFERENCES ON public."wholesale_invoices" TO "authenticated" ;
GRANT TRIGGER ON public."wholesale_invoices" TO "authenticated" ;
GRANT INSERT ON public."wholesale_invoices" TO "service_role" ;
GRANT SELECT ON public."wholesale_invoices" TO "service_role" ;
GRANT UPDATE ON public."wholesale_invoices" TO "service_role" ;
GRANT DELETE ON public."wholesale_invoices" TO "service_role" ;
GRANT TRUNCATE ON public."wholesale_invoices" TO "service_role" ;
GRANT REFERENCES ON public."wholesale_invoices" TO "service_role" ;
GRANT TRIGGER ON public."wholesale_invoices" TO "service_role" ;
GRANT INSERT ON public."store_counters" TO "anon" ;
GRANT SELECT ON public."store_counters" TO "anon" ;
GRANT UPDATE ON public."store_counters" TO "anon" ;
GRANT DELETE ON public."store_counters" TO "anon" ;
GRANT TRUNCATE ON public."store_counters" TO "anon" ;
GRANT REFERENCES ON public."store_counters" TO "anon" ;
GRANT TRIGGER ON public."store_counters" TO "anon" ;
GRANT INSERT ON public."store_counters" TO "authenticated" ;
GRANT SELECT ON public."store_counters" TO "authenticated" ;
GRANT UPDATE ON public."store_counters" TO "authenticated" ;
GRANT DELETE ON public."store_counters" TO "authenticated" ;
GRANT TRUNCATE ON public."store_counters" TO "authenticated" ;
GRANT REFERENCES ON public."store_counters" TO "authenticated" ;
GRANT TRIGGER ON public."store_counters" TO "authenticated" ;
GRANT INSERT ON public."store_counters" TO "service_role" ;
GRANT SELECT ON public."store_counters" TO "service_role" ;
GRANT UPDATE ON public."store_counters" TO "service_role" ;
GRANT DELETE ON public."store_counters" TO "service_role" ;
GRANT TRUNCATE ON public."store_counters" TO "service_role" ;
GRANT REFERENCES ON public."store_counters" TO "service_role" ;
GRANT TRIGGER ON public."store_counters" TO "service_role" ;
GRANT INSERT ON public."ledger_events" TO "anon" ;
GRANT SELECT ON public."ledger_events" TO "anon" ;
GRANT UPDATE ON public."ledger_events" TO "anon" ;
GRANT DELETE ON public."ledger_events" TO "anon" ;
GRANT TRUNCATE ON public."ledger_events" TO "anon" ;
GRANT REFERENCES ON public."ledger_events" TO "anon" ;
GRANT TRIGGER ON public."ledger_events" TO "anon" ;
GRANT INSERT ON public."ledger_events" TO "authenticated" ;
GRANT SELECT ON public."ledger_events" TO "authenticated" ;
GRANT UPDATE ON public."ledger_events" TO "authenticated" ;
GRANT DELETE ON public."ledger_events" TO "authenticated" ;
GRANT TRUNCATE ON public."ledger_events" TO "authenticated" ;
GRANT REFERENCES ON public."ledger_events" TO "authenticated" ;
GRANT TRIGGER ON public."ledger_events" TO "authenticated" ;
GRANT INSERT ON public."ledger_events" TO "service_role" ;
GRANT SELECT ON public."ledger_events" TO "service_role" ;
GRANT UPDATE ON public."ledger_events" TO "service_role" ;
GRANT DELETE ON public."ledger_events" TO "service_role" ;
GRANT TRUNCATE ON public."ledger_events" TO "service_role" ;
GRANT REFERENCES ON public."ledger_events" TO "service_role" ;
GRANT TRIGGER ON public."ledger_events" TO "service_role" ;
GRANT INSERT ON public."shipping_rates" TO "anon" ;
GRANT SELECT ON public."shipping_rates" TO "anon" ;
GRANT UPDATE ON public."shipping_rates" TO "anon" ;
GRANT DELETE ON public."shipping_rates" TO "anon" ;
GRANT TRUNCATE ON public."shipping_rates" TO "anon" ;
GRANT REFERENCES ON public."shipping_rates" TO "anon" ;
GRANT TRIGGER ON public."shipping_rates" TO "anon" ;
GRANT INSERT ON public."shipping_rates" TO "authenticated" ;
GRANT SELECT ON public."shipping_rates" TO "authenticated" ;
GRANT UPDATE ON public."shipping_rates" TO "authenticated" ;
GRANT DELETE ON public."shipping_rates" TO "authenticated" ;
GRANT TRUNCATE ON public."shipping_rates" TO "authenticated" ;
GRANT REFERENCES ON public."shipping_rates" TO "authenticated" ;
GRANT TRIGGER ON public."shipping_rates" TO "authenticated" ;
GRANT INSERT ON public."shipping_rates" TO "service_role" ;
GRANT SELECT ON public."shipping_rates" TO "service_role" ;
GRANT UPDATE ON public."shipping_rates" TO "service_role" ;
GRANT DELETE ON public."shipping_rates" TO "service_role" ;
GRANT TRUNCATE ON public."shipping_rates" TO "service_role" ;
GRANT REFERENCES ON public."shipping_rates" TO "service_role" ;
GRANT TRIGGER ON public."shipping_rates" TO "service_role" ;
GRANT INSERT ON public."products" TO "anon" ;
GRANT SELECT ON public."products" TO "anon" ;
GRANT UPDATE ON public."products" TO "anon" ;
GRANT DELETE ON public."products" TO "anon" ;
GRANT TRUNCATE ON public."products" TO "anon" ;
GRANT REFERENCES ON public."products" TO "anon" ;
GRANT TRIGGER ON public."products" TO "anon" ;
GRANT INSERT ON public."products" TO "authenticated" ;
GRANT SELECT ON public."products" TO "authenticated" ;
GRANT UPDATE ON public."products" TO "authenticated" ;
GRANT DELETE ON public."products" TO "authenticated" ;
GRANT TRUNCATE ON public."products" TO "authenticated" ;
GRANT REFERENCES ON public."products" TO "authenticated" ;
GRANT TRIGGER ON public."products" TO "authenticated" ;
GRANT INSERT ON public."products" TO "service_role" ;
GRANT SELECT ON public."products" TO "service_role" ;
GRANT UPDATE ON public."products" TO "service_role" ;
GRANT DELETE ON public."products" TO "service_role" ;
GRANT TRUNCATE ON public."products" TO "service_role" ;
GRANT REFERENCES ON public."products" TO "service_role" ;
GRANT TRIGGER ON public."products" TO "service_role" ;
GRANT INSERT ON public."return_records" TO "anon" ;
GRANT SELECT ON public."return_records" TO "anon" ;
GRANT UPDATE ON public."return_records" TO "anon" ;
GRANT DELETE ON public."return_records" TO "anon" ;
GRANT TRUNCATE ON public."return_records" TO "anon" ;
GRANT REFERENCES ON public."return_records" TO "anon" ;
GRANT TRIGGER ON public."return_records" TO "anon" ;
GRANT INSERT ON public."return_records" TO "authenticated" ;
GRANT SELECT ON public."return_records" TO "authenticated" ;
GRANT UPDATE ON public."return_records" TO "authenticated" ;
GRANT DELETE ON public."return_records" TO "authenticated" ;
GRANT TRUNCATE ON public."return_records" TO "authenticated" ;
GRANT REFERENCES ON public."return_records" TO "authenticated" ;
GRANT TRIGGER ON public."return_records" TO "authenticated" ;
GRANT INSERT ON public."return_records" TO "service_role" ;
GRANT SELECT ON public."return_records" TO "service_role" ;
GRANT UPDATE ON public."return_records" TO "service_role" ;
GRANT DELETE ON public."return_records" TO "service_role" ;
GRANT TRUNCATE ON public."return_records" TO "service_role" ;
GRANT REFERENCES ON public."return_records" TO "service_role" ;
GRANT TRIGGER ON public."return_records" TO "service_role" ;
GRANT INSERT ON public."discount_codes" TO "anon" ;
GRANT SELECT ON public."discount_codes" TO "anon" ;
GRANT UPDATE ON public."discount_codes" TO "anon" ;
GRANT DELETE ON public."discount_codes" TO "anon" ;
GRANT TRUNCATE ON public."discount_codes" TO "anon" ;
GRANT REFERENCES ON public."discount_codes" TO "anon" ;
GRANT TRIGGER ON public."discount_codes" TO "anon" ;
GRANT INSERT ON public."discount_codes" TO "authenticated" ;
GRANT SELECT ON public."discount_codes" TO "authenticated" ;
GRANT UPDATE ON public."discount_codes" TO "authenticated" ;
GRANT DELETE ON public."discount_codes" TO "authenticated" ;
GRANT TRUNCATE ON public."discount_codes" TO "authenticated" ;
GRANT REFERENCES ON public."discount_codes" TO "authenticated" ;
GRANT TRIGGER ON public."discount_codes" TO "authenticated" ;
GRANT INSERT ON public."discount_codes" TO "service_role" ;
GRANT SELECT ON public."discount_codes" TO "service_role" ;
GRANT UPDATE ON public."discount_codes" TO "service_role" ;
GRANT DELETE ON public."discount_codes" TO "service_role" ;
GRANT TRUNCATE ON public."discount_codes" TO "service_role" ;
GRANT REFERENCES ON public."discount_codes" TO "service_role" ;
GRANT TRIGGER ON public."discount_codes" TO "service_role" ;
GRANT INSERT ON public."partners" TO "authenticated" ;
GRANT SELECT ON public."partners" TO "authenticated" ;
GRANT UPDATE ON public."partners" TO "authenticated" ;
GRANT DELETE ON public."partners" TO "authenticated" ;
GRANT TRUNCATE ON public."partners" TO "authenticated" ;
GRANT REFERENCES ON public."partners" TO "authenticated" ;
GRANT TRIGGER ON public."partners" TO "authenticated" ;
GRANT INSERT ON public."partners" TO "service_role" ;
GRANT SELECT ON public."partners" TO "service_role" ;
GRANT UPDATE ON public."partners" TO "service_role" ;
GRANT DELETE ON public."partners" TO "service_role" ;
GRANT TRUNCATE ON public."partners" TO "service_role" ;
GRANT REFERENCES ON public."partners" TO "service_role" ;
GRANT TRIGGER ON public."partners" TO "service_role" ;
GRANT INSERT ON public."auth_sessions" TO "anon" ;
GRANT SELECT ON public."auth_sessions" TO "anon" ;
GRANT UPDATE ON public."auth_sessions" TO "anon" ;
GRANT DELETE ON public."auth_sessions" TO "anon" ;
GRANT TRUNCATE ON public."auth_sessions" TO "anon" ;
GRANT REFERENCES ON public."auth_sessions" TO "anon" ;
GRANT TRIGGER ON public."auth_sessions" TO "anon" ;
GRANT INSERT ON public."auth_sessions" TO "authenticated" ;
GRANT SELECT ON public."auth_sessions" TO "authenticated" ;
GRANT UPDATE ON public."auth_sessions" TO "authenticated" ;
GRANT DELETE ON public."auth_sessions" TO "authenticated" ;
GRANT TRUNCATE ON public."auth_sessions" TO "authenticated" ;
GRANT REFERENCES ON public."auth_sessions" TO "authenticated" ;
GRANT TRIGGER ON public."auth_sessions" TO "authenticated" ;
GRANT INSERT ON public."auth_sessions" TO "service_role" ;
GRANT SELECT ON public."auth_sessions" TO "service_role" ;
GRANT UPDATE ON public."auth_sessions" TO "service_role" ;
GRANT DELETE ON public."auth_sessions" TO "service_role" ;
GRANT TRUNCATE ON public."auth_sessions" TO "service_role" ;
GRANT REFERENCES ON public."auth_sessions" TO "service_role" ;
GRANT TRIGGER ON public."auth_sessions" TO "service_role" ;
GRANT INSERT ON public."fixed_assets" TO "authenticated" ;
GRANT SELECT ON public."fixed_assets" TO "authenticated" ;
GRANT UPDATE ON public."fixed_assets" TO "authenticated" ;
GRANT DELETE ON public."fixed_assets" TO "authenticated" ;
GRANT TRUNCATE ON public."fixed_assets" TO "authenticated" ;
GRANT REFERENCES ON public."fixed_assets" TO "authenticated" ;
GRANT TRIGGER ON public."fixed_assets" TO "authenticated" ;
GRANT INSERT ON public."fixed_assets" TO "service_role" ;
GRANT SELECT ON public."fixed_assets" TO "service_role" ;
GRANT UPDATE ON public."fixed_assets" TO "service_role" ;
GRANT DELETE ON public."fixed_assets" TO "service_role" ;
GRANT TRUNCATE ON public."fixed_assets" TO "service_role" ;
GRANT REFERENCES ON public."fixed_assets" TO "service_role" ;
GRANT TRIGGER ON public."fixed_assets" TO "service_role" ;
GRANT INSERT ON public."budget_caps" TO "authenticated" ;
GRANT SELECT ON public."budget_caps" TO "authenticated" ;
GRANT UPDATE ON public."budget_caps" TO "authenticated" ;
GRANT DELETE ON public."budget_caps" TO "authenticated" ;
GRANT TRUNCATE ON public."budget_caps" TO "authenticated" ;
GRANT REFERENCES ON public."budget_caps" TO "authenticated" ;
GRANT TRIGGER ON public."budget_caps" TO "authenticated" ;
GRANT INSERT ON public."budget_caps" TO "service_role" ;
GRANT SELECT ON public."budget_caps" TO "service_role" ;
GRANT UPDATE ON public."budget_caps" TO "service_role" ;
GRANT DELETE ON public."budget_caps" TO "service_role" ;
GRANT TRUNCATE ON public."budget_caps" TO "service_role" ;
GRANT REFERENCES ON public."budget_caps" TO "service_role" ;
GRANT TRIGGER ON public."budget_caps" TO "service_role" ;
GRANT INSERT ON public."customers" TO "anon" ;
GRANT SELECT ON public."customers" TO "anon" ;
GRANT UPDATE ON public."customers" TO "anon" ;
GRANT DELETE ON public."customers" TO "anon" ;
GRANT TRUNCATE ON public."customers" TO "anon" ;
GRANT REFERENCES ON public."customers" TO "anon" ;
GRANT TRIGGER ON public."customers" TO "anon" ;
GRANT INSERT ON public."customers" TO "authenticated" ;
GRANT SELECT ON public."customers" TO "authenticated" ;
GRANT UPDATE ON public."customers" TO "authenticated" ;
GRANT DELETE ON public."customers" TO "authenticated" ;
GRANT TRUNCATE ON public."customers" TO "authenticated" ;
GRANT REFERENCES ON public."customers" TO "authenticated" ;
GRANT TRIGGER ON public."customers" TO "authenticated" ;
GRANT INSERT ON public."customers" TO "service_role" ;
GRANT SELECT ON public."customers" TO "service_role" ;
GRANT UPDATE ON public."customers" TO "service_role" ;
GRANT DELETE ON public."customers" TO "service_role" ;
GRANT TRUNCATE ON public."customers" TO "service_role" ;
GRANT REFERENCES ON public."customers" TO "service_role" ;
GRANT TRIGGER ON public."customers" TO "service_role" ;
GRANT INSERT ON public."auth_login_attempts" TO "anon" ;
GRANT SELECT ON public."auth_login_attempts" TO "anon" ;
GRANT UPDATE ON public."auth_login_attempts" TO "anon" ;
GRANT DELETE ON public."auth_login_attempts" TO "anon" ;
GRANT TRUNCATE ON public."auth_login_attempts" TO "anon" ;
GRANT REFERENCES ON public."auth_login_attempts" TO "anon" ;
GRANT TRIGGER ON public."auth_login_attempts" TO "anon" ;
GRANT INSERT ON public."auth_login_attempts" TO "authenticated" ;
GRANT SELECT ON public."auth_login_attempts" TO "authenticated" ;
GRANT UPDATE ON public."auth_login_attempts" TO "authenticated" ;
GRANT DELETE ON public."auth_login_attempts" TO "authenticated" ;
GRANT TRUNCATE ON public."auth_login_attempts" TO "authenticated" ;
GRANT REFERENCES ON public."auth_login_attempts" TO "authenticated" ;
GRANT TRIGGER ON public."auth_login_attempts" TO "authenticated" ;
GRANT INSERT ON public."auth_login_attempts" TO "service_role" ;
GRANT SELECT ON public."auth_login_attempts" TO "service_role" ;
GRANT UPDATE ON public."auth_login_attempts" TO "service_role" ;
GRANT DELETE ON public."auth_login_attempts" TO "service_role" ;
GRANT TRUNCATE ON public."auth_login_attempts" TO "service_role" ;
GRANT REFERENCES ON public."auth_login_attempts" TO "service_role" ;
GRANT TRIGGER ON public."auth_login_attempts" TO "service_role" ;
GRANT INSERT ON public."suppliers" TO "anon" ;
GRANT SELECT ON public."suppliers" TO "anon" ;
GRANT UPDATE ON public."suppliers" TO "anon" ;
GRANT DELETE ON public."suppliers" TO "anon" ;
GRANT TRUNCATE ON public."suppliers" TO "anon" ;
GRANT REFERENCES ON public."suppliers" TO "anon" ;
GRANT TRIGGER ON public."suppliers" TO "anon" ;
GRANT INSERT ON public."suppliers" TO "authenticated" ;
GRANT SELECT ON public."suppliers" TO "authenticated" ;
GRANT UPDATE ON public."suppliers" TO "authenticated" ;
GRANT DELETE ON public."suppliers" TO "authenticated" ;
GRANT TRUNCATE ON public."suppliers" TO "authenticated" ;
GRANT REFERENCES ON public."suppliers" TO "authenticated" ;
GRANT TRIGGER ON public."suppliers" TO "authenticated" ;
GRANT INSERT ON public."suppliers" TO "service_role" ;
GRANT SELECT ON public."suppliers" TO "service_role" ;
GRANT UPDATE ON public."suppliers" TO "service_role" ;
GRANT DELETE ON public."suppliers" TO "service_role" ;
GRANT TRUNCATE ON public."suppliers" TO "service_role" ;
GRANT REFERENCES ON public."suppliers" TO "service_role" ;
GRANT TRIGGER ON public."suppliers" TO "service_role" ;
GRANT INSERT ON public."branches" TO "anon" ;
GRANT SELECT ON public."branches" TO "anon" ;
GRANT UPDATE ON public."branches" TO "anon" ;
GRANT DELETE ON public."branches" TO "anon" ;
GRANT TRUNCATE ON public."branches" TO "anon" ;
GRANT REFERENCES ON public."branches" TO "anon" ;
GRANT TRIGGER ON public."branches" TO "anon" ;
GRANT INSERT ON public."branches" TO "authenticated" ;
GRANT SELECT ON public."branches" TO "authenticated" ;
GRANT UPDATE ON public."branches" TO "authenticated" ;
GRANT DELETE ON public."branches" TO "authenticated" ;
GRANT TRUNCATE ON public."branches" TO "authenticated" ;
GRANT REFERENCES ON public."branches" TO "authenticated" ;
GRANT TRIGGER ON public."branches" TO "authenticated" ;
GRANT INSERT ON public."branches" TO "service_role" ;
GRANT SELECT ON public."branches" TO "service_role" ;
GRANT UPDATE ON public."branches" TO "service_role" ;
GRANT DELETE ON public."branches" TO "service_role" ;
GRANT TRUNCATE ON public."branches" TO "service_role" ;
GRANT REFERENCES ON public."branches" TO "service_role" ;
GRANT TRIGGER ON public."branches" TO "service_role" ;
GRANT INSERT ON public."purchase_invoices" TO "anon" ;
GRANT SELECT ON public."purchase_invoices" TO "anon" ;
GRANT UPDATE ON public."purchase_invoices" TO "anon" ;
GRANT DELETE ON public."purchase_invoices" TO "anon" ;
GRANT TRUNCATE ON public."purchase_invoices" TO "anon" ;
GRANT REFERENCES ON public."purchase_invoices" TO "anon" ;
GRANT TRIGGER ON public."purchase_invoices" TO "anon" ;
GRANT INSERT ON public."purchase_invoices" TO "authenticated" ;
GRANT SELECT ON public."purchase_invoices" TO "authenticated" ;
GRANT UPDATE ON public."purchase_invoices" TO "authenticated" ;
GRANT DELETE ON public."purchase_invoices" TO "authenticated" ;
GRANT TRUNCATE ON public."purchase_invoices" TO "authenticated" ;
GRANT REFERENCES ON public."purchase_invoices" TO "authenticated" ;
GRANT TRIGGER ON public."purchase_invoices" TO "authenticated" ;
GRANT INSERT ON public."purchase_invoices" TO "service_role" ;
GRANT SELECT ON public."purchase_invoices" TO "service_role" ;
GRANT UPDATE ON public."purchase_invoices" TO "service_role" ;
GRANT DELETE ON public."purchase_invoices" TO "service_role" ;
GRANT TRUNCATE ON public."purchase_invoices" TO "service_role" ;
GRANT REFERENCES ON public."purchase_invoices" TO "service_role" ;
GRANT TRIGGER ON public."purchase_invoices" TO "service_role" ;
GRANT INSERT ON public."payroll" TO "authenticated" ;
GRANT SELECT ON public."payroll" TO "authenticated" ;
GRANT UPDATE ON public."payroll" TO "authenticated" ;
GRANT DELETE ON public."payroll" TO "authenticated" ;
GRANT TRUNCATE ON public."payroll" TO "authenticated" ;
GRANT REFERENCES ON public."payroll" TO "authenticated" ;
GRANT TRIGGER ON public."payroll" TO "authenticated" ;
GRANT INSERT ON public."payroll" TO "service_role" ;
GRANT SELECT ON public."payroll" TO "service_role" ;
GRANT UPDATE ON public."payroll" TO "service_role" ;
GRANT DELETE ON public."payroll" TO "service_role" ;
GRANT TRUNCATE ON public."payroll" TO "service_role" ;
GRANT REFERENCES ON public."payroll" TO "service_role" ;
GRANT TRIGGER ON public."payroll" TO "service_role" ;
GRANT INSERT ON public."owner_budgets" TO "service_role" ;
GRANT SELECT ON public."owner_budgets" TO "service_role" ;
GRANT UPDATE ON public."owner_budgets" TO "service_role" ;
GRANT DELETE ON public."owner_budgets" TO "service_role" ;
GRANT TRUNCATE ON public."owner_budgets" TO "service_role" ;
GRANT REFERENCES ON public."owner_budgets" TO "service_role" ;
GRANT TRIGGER ON public."owner_budgets" TO "service_role" ;
GRANT INSERT ON public."owner_budgets" TO "authenticated" ;
GRANT SELECT ON public."owner_budgets" TO "authenticated" ;
GRANT UPDATE ON public."owner_budgets" TO "authenticated" ;
GRANT DELETE ON public."owner_budgets" TO "authenticated" ;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO anon,authenticated,service_role; set check_function_bodies=on;
