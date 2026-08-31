-- ============================================================================
-- NexusCore — Full Supabase Initialization Script
-- ============================================================================
-- Run this ONCE in: Supabase Dashboard → SQL Editor → New Query → Paste → Run
-- It drops any partial setup and provisions the complete, fresh schema.
-- ============================================================================

-- 0. Drop existing tables to ensure a clean slate
DROP TABLE IF EXISTS public.branches, public.ledger_events, public.ledger_lines, public.products, public.customers, public.suppliers, public.discount_codes, public.return_records, public.stores, public.store_members, public.store_alias, public.auth_sessions, public.auth_login_attempts CASCADE;

-- 0. Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-------------------------------------------------------------------------------
-- 1. Store & Tenancy (Phase 2 core)
-------------------------------------------------------------------------------
CREATE TABLE public.stores (
    id UUID PRIMARY KEY,
    name TEXT,
    logo_url TEXT,
    phone TEXT,
    address TEXT,
    tax_number TEXT,
    vat_rate NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE public.store_members (
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    store_id UUID REFERENCES public.stores(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL,
    PRIMARY KEY (user_id, store_id)
);

CREATE TABLE public.store_alias (
    old_store_id UUID PRIMARY KEY,
    new_store_id UUID NOT NULL,
    rekeyed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-------------------------------------------------------------------------------
-- 1.5 Auth & Sessions (For App Login Flow)
-------------------------------------------------------------------------------
CREATE TABLE public.auth_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  username      TEXT NOT NULL,
  role          TEXT NOT NULL,
  machine_id    TEXT NOT NULL,
  token         TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked       BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at    TIMESTAMPTZ,
  ip_address    TEXT,
  user_agent    TEXT
);

CREATE INDEX idx_auth_sessions_token ON public.auth_sessions (token);
CREATE INDEX idx_auth_sessions_user ON public.auth_sessions (user_id);
CREATE INDEX idx_auth_sessions_active ON public.auth_sessions (revoked, expires_at);

CREATE TABLE public.auth_login_attempts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT now(),
  username      TEXT NOT NULL,
  machine_id    TEXT NOT NULL,
  ip_address    TEXT,
  success       BOOLEAN NOT NULL,
  reason        TEXT,
  user_agent    TEXT
);

-------------------------------------------------------------------------------
-- 2. Ledger Tables (Append-Only)
-------------------------------------------------------------------------------
CREATE TABLE public.ledger_events (
  id          TEXT PRIMARY KEY,
  store_id    UUID NOT NULL,
  device_id   UUID NOT NULL,
  kind        TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  actor       TEXT,
  ref_type    TEXT,
  ref_id      TEXT,
  payload     TEXT NOT NULL DEFAULT '{}',
  reversed_by TEXT REFERENCES public.ledger_events(id),
  sync_status TEXT NOT NULL DEFAULT 'pending',
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE public.ledger_lines (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES public.ledger_events(id),
  store_id     UUID NOT NULL,
  device_id    UUID NOT NULL,
  account      TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  qty_delta    REAL    NOT NULL DEFAULT 0,
  amount_delta INTEGER NOT NULL DEFAULT 0,
  unit_cost    INTEGER,
  sync_status  TEXT NOT NULL DEFAULT 'pending',
  deleted_at   TIMESTAMPTZ
);

-- Indexes for the ledger
CREATE INDEX idx_lines_account_subject ON public.ledger_lines (store_id, account, subject_id);
CREATE INDEX idx_lines_event ON public.ledger_lines (event_id);
CREATE INDEX idx_events_sync ON public.ledger_events (sync_status);
CREATE INDEX idx_events_occurred ON public.ledger_events (store_id, occurred_at);
CREATE INDEX idx_events_ref ON public.ledger_events (ref_type, ref_id);

-------------------------------------------------------------------------------
-- 3. Reference Tables
-------------------------------------------------------------------------------

-- 3.1 Products
CREATE TABLE public.products (
  id              TEXT PRIMARY KEY,
  name            TEXT        NOT NULL,
  sku             TEXT        NOT NULL,
  image_url       TEXT,
  category        TEXT        NOT NULL DEFAULT '',
  description     TEXT,
  quantity        NUMERIC     NOT NULL DEFAULT 0,
  "unitPrice"     NUMERIC     NOT NULL DEFAULT 0,
  wholesale_price NUMERIC     NOT NULL DEFAULT 0,
  "minStockLevel" NUMERIC,
  "maxStockLevel" NUMERIC,
  barcode         TEXT,
  "isActive"      BOOLEAN     DEFAULT true,
  "isBundle"      BOOLEAN     DEFAULT false,
  "bundleItems"   JSONB       DEFAULT '[]'::JSONB,
  updated_at      BIGINT      DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  deleted_at      BIGINT,
  store_id        UUID NOT NULL,
  device_id       UUID NOT NULL,
  sync_status     TEXT NOT NULL DEFAULT 'pending'
);

-- 3.2 Branches
CREATE TABLE public.branches (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  code        TEXT NOT NULL,
  address     TEXT,
  phone       TEXT,
  "isActive"  BOOLEAN DEFAULT true,
  "createdAt" TIMESTAMPTZ DEFAULT now(),
  store_id    UUID NOT NULL,
  device_id   UUID NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  deleted_at  TIMESTAMPTZ
);

-- 3.3 Customers
CREATE TABLE public.customers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  address     TEXT NOT NULL,
  store_id    UUID NOT NULL,
  device_id   UUID NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  deleted_at  TIMESTAMPTZ
);

-- 3.4 Suppliers
CREATE TABLE public.suppliers (
  id              TEXT PRIMARY KEY,
  "companyName"   TEXT NOT NULL,
  "contactPerson" TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT,
  address         TEXT,
  "taxId"         TEXT,
  notes           TEXT,
  "createdAt"     TIMESTAMPTZ,
  "updatedAt"     TIMESTAMPTZ,
  store_id        UUID NOT NULL,
  device_id       UUID NOT NULL,
  sync_status     TEXT NOT NULL DEFAULT 'pending',
  deleted_at      TIMESTAMPTZ
);

-- 3.5 Discount Codes
CREATE TABLE public.discount_codes (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL,
  type        TEXT NOT NULL,
  value       NUMERIC NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT true,
  "maxUses"   NUMERIC,
  "expiryDate" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ,
  store_id    UUID NOT NULL,
  device_id   UUID NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  deleted_at  TIMESTAMPTZ
);

-- 3.6 Return Records
CREATE TABLE public.return_records (
  id                    TEXT PRIMARY KEY,
  original_order_id     TEXT NOT NULL,
  type                  TEXT NOT NULL,
  customer_name         TEXT NOT NULL,
  customer_phone        TEXT NOT NULL,
  governorate           TEXT NOT NULL,
  returned_items        JSONB NOT NULL,
  exchanged_item        JSONB,
  pending_replacement   JSONB,
  financial_difference  NUMERIC NOT NULL,
  processed_by          TEXT NOT NULL,
  notes                 TEXT,
  created_at            TIMESTAMPTZ,
  store_id              UUID NOT NULL,
  device_id             UUID NOT NULL,
  sync_status           TEXT NOT NULL DEFAULT 'pending',
  deleted_at            TIMESTAMPTZ
);


-------------------------------------------------------------------------------
-- 4. Row Level Security (RLS) - Append-Only for Ledger
-------------------------------------------------------------------------------
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discount_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.return_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_login_attempts ENABLE ROW LEVEL SECURITY;

-- Utility function to check if the current user is a member of the store
CREATE OR REPLACE FUNCTION is_store_member(p_store_id UUID) RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.store_members
        WHERE user_id = auth.uid() AND store_id = p_store_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Policy: Select only if user belongs to the store
CREATE POLICY select_stores ON public.stores FOR SELECT USING (is_store_member(id));
CREATE POLICY select_ledger_events ON public.ledger_events FOR SELECT USING (is_store_member(store_id));
CREATE POLICY select_ledger_lines ON public.ledger_lines FOR SELECT USING (is_store_member(store_id));
CREATE POLICY select_products ON public.products FOR SELECT USING (is_store_member(store_id));
CREATE POLICY select_branches ON public.branches FOR SELECT USING (is_store_member(store_id));
CREATE POLICY select_customers ON public.customers FOR SELECT USING (is_store_member(store_id));
CREATE POLICY select_suppliers ON public.suppliers FOR SELECT USING (is_store_member(store_id));
CREATE POLICY select_discount_codes ON public.discount_codes FOR SELECT USING (is_store_member(store_id));
CREATE POLICY select_return_records ON public.return_records FOR SELECT USING (is_store_member(store_id));

-- Policy: Insert only if user belongs to the store
CREATE POLICY insert_ledger_events ON public.ledger_events FOR INSERT WITH CHECK (is_store_member(store_id));
CREATE POLICY insert_ledger_lines ON public.ledger_lines FOR INSERT WITH CHECK (is_store_member(store_id));
CREATE POLICY insert_products ON public.products FOR INSERT WITH CHECK (is_store_member(store_id));
CREATE POLICY insert_branches ON public.branches FOR INSERT WITH CHECK (is_store_member(store_id));
CREATE POLICY insert_customers ON public.customers FOR INSERT WITH CHECK (is_store_member(store_id));
CREATE POLICY insert_suppliers ON public.suppliers FOR INSERT WITH CHECK (is_store_member(store_id));
CREATE POLICY insert_discount_codes ON public.discount_codes FOR INSERT WITH CHECK (is_store_member(store_id));
CREATE POLICY insert_return_records ON public.return_records FOR INSERT WITH CHECK (is_store_member(store_id));

-- Policy: Reference tables allow UPDATE (Last Write Wins)
CREATE POLICY update_stores ON public.stores FOR UPDATE USING (is_store_member(id));
CREATE POLICY update_products ON public.products FOR UPDATE USING (is_store_member(store_id));
CREATE POLICY update_branches ON public.branches FOR UPDATE USING (is_store_member(store_id));
CREATE POLICY update_customers ON public.customers FOR UPDATE USING (is_store_member(store_id));
CREATE POLICY update_suppliers ON public.suppliers FOR UPDATE USING (is_store_member(store_id));
CREATE POLICY update_discount_codes ON public.discount_codes FOR UPDATE USING (is_store_member(store_id));
CREATE POLICY update_return_records ON public.return_records FOR UPDATE USING (is_store_member(store_id));

-------------------------------------------------------------------------------
-- 4.5 Policies for Auth Sessions (Anon access for login)
-------------------------------------------------------------------------------
CREATE POLICY "Allow anon insert to auth_sessions" 
  ON public.auth_sessions FOR INSERT 
  WITH CHECK (true);

CREATE POLICY "Allow anon select from auth_sessions" 
  ON public.auth_sessions FOR SELECT 
  USING (true);

CREATE POLICY "Allow anon update to auth_sessions" 
  ON public.auth_sessions FOR UPDATE 
  USING (true);

CREATE POLICY "Allow anon insert to auth_login_attempts" 
  ON public.auth_login_attempts FOR INSERT 
  WITH CHECK (true);

-------------------------------------------------------------------------------
-- 5. claim_store RPC (Tenancy Resolution)
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_store(local_store_id UUID)
RETURNS JSONB AS $$
DECLARE
    canonical_store_id UUID;
    v_uid UUID := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Look up if the user already has a store
    SELECT store_id INTO canonical_store_id
    FROM public.store_members
    WHERE user_id = v_uid
    LIMIT 1;

    IF canonical_store_id IS NOT NULL THEN
        -- If they have one but generated a provisional one locally, return rekey: true
        IF canonical_store_id != local_store_id THEN
            RETURN jsonb_build_object(
                'canonical', canonical_store_id,
                'rekey', true
            );
        END IF;

        -- They passed their canonical ID, no rekey needed
        RETURN jsonb_build_object(
            'canonical', canonical_store_id,
            'rekey', false
        );
    END IF;

    -- They have no store yet, so claim the local provisional ID as canonical
    INSERT INTO public.stores (id) VALUES (local_store_id);
    INSERT INTO public.store_members (user_id, store_id, role) VALUES (v_uid, local_store_id, 'owner');

    RETURN jsonb_build_object(
        'canonical', local_store_id,
        'rekey', false
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-------------------------------------------------------------------------------
-- 6. Realtime Publications
-------------------------------------------------------------------------------
-- Ensure tables are published for sync
DROP PUBLICATION IF EXISTS supabase_realtime;
CREATE PUBLICATION supabase_realtime;

ALTER PUBLICATION supabase_realtime ADD TABLE public.ledger_events;
ALTER PUBLICATION supabase_realtime ADD TABLE public.ledger_lines;
ALTER PUBLICATION supabase_realtime ADD TABLE public.products;
ALTER PUBLICATION supabase_realtime ADD TABLE public.branches;
ALTER PUBLICATION supabase_realtime ADD TABLE public.customers;
ALTER PUBLICATION supabase_realtime ADD TABLE public.suppliers;
ALTER PUBLICATION supabase_realtime ADD TABLE public.discount_codes;
ALTER PUBLICATION supabase_realtime ADD TABLE public.return_records;
ALTER PUBLICATION supabase_realtime ADD TABLE public.stores;
