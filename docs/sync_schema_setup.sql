-- Supabase Sync Layer Setup (Phase 2)
-- Run this in your Supabase SQL Editor.

-------------------------------------------------------------------------------
-- 1. Extend Ledger Tables with Sync Columns
-------------------------------------------------------------------------------

-- ledger_events
ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS store_id UUID NOT NULL;
ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS device_id UUID NOT NULL;
ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS sync_status VARCHAR(50) DEFAULT 'pending' NOT NULL;
ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- ledger_lines
ALTER TABLE ledger_lines ADD COLUMN IF NOT EXISTS store_id UUID NOT NULL;
ALTER TABLE ledger_lines ADD COLUMN IF NOT EXISTS device_id UUID NOT NULL;
ALTER TABLE ledger_lines ADD COLUMN IF NOT EXISTS sync_status VARCHAR(50) DEFAULT 'pending' NOT NULL;
ALTER TABLE ledger_lines ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Reference tables (products, customers, suppliers, discount_codes, return_records)
ALTER TABLE products ADD COLUMN IF NOT EXISTS store_id UUID NOT NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS device_id UUID NOT NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sync_status VARCHAR(50) DEFAULT 'pending' NOT NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE branches ADD COLUMN IF NOT EXISTS store_id UUID NOT NULL;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS device_id UUID NOT NULL;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS sync_status VARCHAR(50) DEFAULT 'pending' NOT NULL;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS store_id UUID NOT NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS device_id UUID NOT NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS sync_status VARCHAR(50) DEFAULT 'pending' NOT NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS store_id UUID NOT NULL;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS device_id UUID NOT NULL;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS sync_status VARCHAR(50) DEFAULT 'pending' NOT NULL;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS store_id UUID NOT NULL;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS device_id UUID NOT NULL;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS sync_status VARCHAR(50) DEFAULT 'pending' NOT NULL;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE return_records ADD COLUMN IF NOT EXISTS store_id UUID NOT NULL;
ALTER TABLE return_records ADD COLUMN IF NOT EXISTS device_id UUID NOT NULL;
ALTER TABLE return_records ADD COLUMN IF NOT EXISTS sync_status VARCHAR(50) DEFAULT 'pending' NOT NULL;
ALTER TABLE return_records ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-------------------------------------------------------------------------------
-- 2. Store & Tenancy Tables
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stores (
    id UUID PRIMARY KEY,
    name VARCHAR(255),
    logo_url TEXT,
    phone VARCHAR(50),
    address TEXT,
    tax_number VARCHAR(100),
    vat_rate NUMERIC(5,2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS store_members (
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL,
    PRIMARY KEY (user_id, store_id)
);

CREATE TABLE IF NOT EXISTS store_alias (
    old_store_id UUID PRIMARY KEY,
    new_store_id UUID NOT NULL,
    rekeyed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-------------------------------------------------------------------------------
-- 3. Row Level Security (RLS) - Append-Only for Ledger
-------------------------------------------------------------------------------
ALTER TABLE ledger_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE discount_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;

-- Utility function to check if the current user is a member of the store
CREATE OR REPLACE FUNCTION is_store_member(store_id UUID) RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM store_members
        WHERE user_id = auth.uid() AND store_members.store_id = $1
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Policy: Select only if user belongs to the store
CREATE POLICY select_ledger_events ON ledger_events FOR SELECT USING (is_store_member(store_id));
CREATE POLICY select_ledger_lines ON ledger_lines FOR SELECT USING (is_store_member(store_id));
CREATE POLICY select_products ON products FOR SELECT USING (is_store_member(store_id));
CREATE POLICY select_branches ON branches FOR SELECT USING (is_store_member(store_id));
CREATE POLICY select_customers ON customers FOR SELECT USING (is_store_member(store_id));
CREATE POLICY select_suppliers ON suppliers FOR SELECT USING (is_store_member(store_id));
CREATE POLICY select_discount_codes ON discount_codes FOR SELECT USING (is_store_member(store_id));
CREATE POLICY select_return_records ON return_records FOR SELECT USING (is_store_member(store_id));
CREATE POLICY select_stores ON stores FOR SELECT USING (is_store_member(id));

-- Policy: Insert only if user belongs to the store
CREATE POLICY insert_ledger_events ON ledger_events FOR INSERT WITH CHECK (is_store_member(store_id));
CREATE POLICY insert_ledger_lines ON ledger_lines FOR INSERT WITH CHECK (is_store_member(store_id));

-- Notice: NO UPDATE or DELETE policies for ledger_events and ledger_lines! (Append-only enforcement)

-- Policy: Reference tables allow UPDATE (Last Write Wins)
CREATE POLICY update_products ON products FOR UPDATE USING (is_store_member(store_id));
CREATE POLICY update_branches ON branches FOR UPDATE USING (is_store_member(store_id));
CREATE POLICY update_customers ON customers FOR UPDATE USING (is_store_member(store_id));
CREATE POLICY update_suppliers ON suppliers FOR UPDATE USING (is_store_member(store_id));
CREATE POLICY update_discount_codes ON discount_codes FOR UPDATE USING (is_store_member(store_id));
CREATE POLICY update_return_records ON return_records FOR UPDATE USING (is_store_member(store_id));
CREATE POLICY update_stores ON stores FOR UPDATE USING (is_store_member(id));

CREATE POLICY insert_products ON products FOR INSERT WITH CHECK (is_store_member(store_id));
CREATE POLICY insert_branches ON branches FOR INSERT WITH CHECK (is_store_member(store_id));
CREATE POLICY insert_customers ON customers FOR INSERT WITH CHECK (is_store_member(store_id));
CREATE POLICY insert_suppliers ON suppliers FOR INSERT WITH CHECK (is_store_member(store_id));
CREATE POLICY insert_discount_codes ON discount_codes FOR INSERT WITH CHECK (is_store_member(store_id));
CREATE POLICY insert_return_records ON return_records FOR INSERT WITH CHECK (is_store_member(store_id));

-------------------------------------------------------------------------------
-- 4. claim_store RPC (Tenancy Resolution)
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
    FROM store_members
    WHERE user_id = v_uid
    LIMIT 1;

    IF canonical_store_id IS NULL THEN
        -- User has no store yet. The local one becomes canonical.
        INSERT INTO stores (id) VALUES (local_store_id) ON CONFLICT DO NOTHING;
        INSERT INTO store_members (user_id, store_id, role) VALUES (v_uid, local_store_id, 'owner');
        
        RETURN jsonb_build_object('canonical', local_store_id, 'rekey', false);
    END IF;

    -- User already has a store. Check if it matches local.
    IF canonical_store_id = local_store_id THEN
        RETURN jsonb_build_object('canonical', canonical_store_id, 'rekey', false);
    ELSE
        RETURN jsonb_build_object('canonical', canonical_store_id, 'rekey', true);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Enable Realtime for syncing
ALTER PUBLICATION supabase_realtime ADD TABLE ledger_events;
ALTER PUBLICATION supabase_realtime ADD TABLE products;
ALTER PUBLICATION supabase_realtime ADD TABLE branches;
ALTER PUBLICATION supabase_realtime ADD TABLE customers;
ALTER PUBLICATION supabase_realtime ADD TABLE suppliers;
ALTER PUBLICATION supabase_realtime ADD TABLE discount_codes;
ALTER PUBLICATION supabase_realtime ADD TABLE return_records;
ALTER PUBLICATION supabase_realtime ADD TABLE stores;
