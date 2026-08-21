-- ============================================================================
-- NexusCore — Supabase Schema Migration
-- ============================================================================
-- Run this ONCE in: Supabase Dashboard → SQL Editor → New Query → Paste → Run
--
-- Creates 4 tables mapped 1:1 from TypeScript interfaces:
--   1. products     ← Product
--   2. orders       ← EcommerceOrder
--   3. transactions ← Transaction
--   4. expenses     ← ExpenseRecord
--
-- Includes:
--   • UUID primary keys (TEXT to match crypto.randomUUID())
--   • updated_at (BIGINT ms) for Last-Write-Wins conflict resolution
--   • Permissive RLS policies (open read/write for anon during dev)
--   • Realtime publication for all 4 tables
-- ============================================================================

-- ── 0. Enable UUID extension (usually already enabled on Supabase) ──────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ════════════════════════════════════════════════════════════════════════════
-- 1. PRODUCTS
-- ════════════════════════════════════════════════════════════════════════════
-- Source: interface Product  (src/types/index.ts L89–L109)

CREATE TABLE IF NOT EXISTS public.products (
  id              TEXT PRIMARY KEY,
  name            TEXT        NOT NULL,
  sku             TEXT        NOT NULL,
  stock_qty       NUMERIC     NOT NULL DEFAULT 0,
  retail_price    NUMERIC     NOT NULL DEFAULT 0,
  wholesale_price NUMERIC,
  image_url       TEXT,
  category        TEXT        NOT NULL DEFAULT '',
  type            TEXT        NOT NULL DEFAULT 'Finished'
                    CHECK (type IN ('Finished', 'RawMaterial')),
  reorder_point   NUMERIC     NOT NULL DEFAULT 0,
  cost_price      NUMERIC,
  quantity        NUMERIC     NOT NULL DEFAULT 0,
  "unitPrice"     NUMERIC     NOT NULL DEFAULT 0,
  "minStockLevel" NUMERIC,
  "maxStockLevel" NUMERIC,
  -- `supplier` (free text) was deleted from `Product` on 2026-08-18: a product
  -- does not own a supplier — the receipt does (§3.5). The column is left in
  -- place because dropping it would break older clients mid-rollout; nothing
  -- writes it any more.
  supplier        TEXT,
  barcode         TEXT,
  "isActive"      BOOLEAN     DEFAULT true,
  updated_at      BIGINT      DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  -- Tombstone (epoch ms). A product the ledger already mentions is archived,
  -- never hard-deleted, so its events keep resolving to a real row. NULL =
  -- active. Syncs like any other column: the archive reaches every device.
  deleted_at      BIGINT
);

-- `CREATE TABLE IF NOT EXISTS` never revisits a table that already exists, so
-- a project created before the tombstone landed needs the column added.
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS deleted_at BIGINT;

-- Index for conflict-resolution queries
CREATE INDEX IF NOT EXISTS idx_products_updated_at ON public.products (updated_at);


-- ════════════════════════════════════════════════════════════════════════════
-- 2. ORDERS
-- ════════════════════════════════════════════════════════════════════════════
-- Source: interface EcommerceOrder  (src/types/index.ts L396–L418)
-- items & stockItems are arrays of objects → JSONB

CREATE TABLE IF NOT EXISTS public.orders (
  id                TEXT PRIMARY KEY,
  "orderNumber"     TEXT        NOT NULL,
  "customerName"    TEXT        NOT NULL,
  "customerPhone"   TEXT        NOT NULL,
  address           TEXT        NOT NULL DEFAULT '',
  governorate       TEXT,
  items             JSONB       NOT NULL DEFAULT '[]'::JSONB,
  "stockItems"      JSONB       DEFAULT '[]'::JSONB,
  "totalAmount"     NUMERIC     NOT NULL DEFAULT 0,
  "shippingFee"     NUMERIC     NOT NULL DEFAULT 0,
  "paymentMethod"   TEXT        NOT NULL DEFAULT 'full_prepaid'
                      CHECK ("paymentMethod" IN ('full_prepaid', 'partial_cod')),
  "depositAmount"   NUMERIC     NOT NULL DEFAULT 0,
  "expectedCod"     NUMERIC     NOT NULL DEFAULT 0,
  status            TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'shipped', 'delivered', 'returned')),
  "courierId"       TEXT,
  "courierName"     TEXT,
  "courierFee"      NUMERIC     NOT NULL DEFAULT 0,
  "cogsAmount"      NUMERIC     NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "revenueLogged"   BOOLEAN     NOT NULL DEFAULT false,
  updated_at        BIGINT      DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_orders_updated_at ON public.orders (updated_at);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON public.orders (status);


-- ════════════════════════════════════════════════════════════════════════════
-- 3. TRANSACTIONS
-- ════════════════════════════════════════════════════════════════════════════
-- Source: interface Transaction  (src/types/index.ts L75–L84)

CREATE TABLE IF NOT EXISTS public.transactions (
  id              TEXT PRIMARY KEY,
  type            TEXT        NOT NULL DEFAULT 'sale'
                    CHECK (type IN ('sale', 'expense')),
  amount          NUMERIC     NOT NULL DEFAULT 0,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "partnerId"     TEXT,
  category        TEXT        NOT NULL DEFAULT '',
  description     TEXT,
  updated_at      BIGINT      DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_transactions_updated_at ON public.transactions (updated_at);
CREATE INDEX IF NOT EXISTS idx_transactions_type       ON public.transactions (type);


-- ════════════════════════════════════════════════════════════════════════════
-- 4. EXPENSES
-- ════════════════════════════════════════════════════════════════════════════
-- Source: interface ExpenseRecord  (src/types/index.ts L27–L33)

CREATE TABLE IF NOT EXISTS public.expenses (
  id              TEXT PRIMARY KEY,
  category        TEXT        NOT NULL DEFAULT 'other'
                    CHECK (category IN (
                      'rent', 'utilities', 'salaries', 'transport',
                      'maintenance', 'marketing', 'office_supplies',
                      'shipping', 'store_rent', 'other'
                    )),
  amount          NUMERIC     NOT NULL DEFAULT 0,
  description     TEXT,
  date            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      BIGINT      DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_expenses_updated_at ON public.expenses (updated_at);


-- ════════════════════════════════════════════════════════════════════════════
-- 5. ROW LEVEL SECURITY — Permissive policies for dev phase
-- ════════════════════════════════════════════════════════════════════════════
-- Enable RLS (Supabase requires it) but add wide-open policies
-- so the anon key can read/write freely during development.
-- ⚠️  REPLACE these with proper Auth-based policies before production!

ALTER TABLE public.products     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses     ENABLE ROW LEVEL SECURITY;

-- Products
CREATE POLICY "Allow full access to products"
  ON public.products FOR ALL
  USING (true) WITH CHECK (true);

-- Orders
CREATE POLICY "Allow full access to orders"
  ON public.orders FOR ALL
  USING (true) WITH CHECK (true);

-- Transactions
CREATE POLICY "Allow full access to transactions"
  ON public.transactions FOR ALL
  USING (true) WITH CHECK (true);

-- Expenses
CREATE POLICY "Allow full access to expenses"
  ON public.expenses FOR ALL
  USING (true) WITH CHECK (true);


-- ════════════════════════════════════════════════════════════════════════════
-- 6. REALTIME PUBLICATION
-- ════════════════════════════════════════════════════════════════════════════
-- Add all 4 tables to Supabase's built-in realtime publication
-- so postgres_changes events fire over WebSockets.

ALTER PUBLICATION supabase_realtime ADD TABLE public.products;
ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
ALTER PUBLICATION supabase_realtime ADD TABLE public.transactions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.expenses;


-- ════════════════════════════════════════════════════════════════════════════
-- ✅  Done! All 4 tables are ready for sync.
-- ════════════════════════════════════════════════════════════════════════════
