-- ============================================================================
-- NexusCore — Omnichannel Database Schema
-- Target: Supabase (PostgreSQL 15+)
-- Migration: 001_init
-- ============================================================================

-- ── Products ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  sku             TEXT NOT NULL UNIQUE,
  stock_qty       INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  retail_price    NUMERIC(12,2) NOT NULL CHECK (retail_price >= 0),
  wholesale_price NUMERIC(12,2) CHECK (wholesale_price >= 0),
  image_url       TEXT,
  category        TEXT NOT NULL DEFAULT '',
  type            TEXT NOT NULL DEFAULT 'Finished' CHECK (type IN ('Finished', 'RawMaterial')),
  reorder_point   INTEGER NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_products_sku ON products (sku);
CREATE INDEX idx_products_category ON products (category);

-- ── Orders ──────────────────────────────────────────────────────────────────

CREATE TYPE order_status AS ENUM (
  'pending', 'confirmed', 'shipped', 'delivered', 'returned'
);

CREATE TYPE payment_method AS ENUM (
  'full_prepaid', 'partial_cod'
);

CREATE TABLE IF NOT EXISTS orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number      TEXT NOT NULL UNIQUE DEFAULT '',
  customer_name     TEXT NOT NULL,
  customer_phone    TEXT NOT NULL,
  governorate       TEXT NOT NULL DEFAULT '',
  shipping_fee      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (shipping_fee >= 0),
  payment_method    payment_method NOT NULL DEFAULT 'partial_cod',
  deposit_amount    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  total_price       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_price >= 0),
  remaining_balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (remaining_balance >= 0),
  created_by_role   TEXT NOT NULL DEFAULT '',
  status            order_status NOT NULL DEFAULT 'pending',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_customer_name ON orders (customer_name);
CREATE INDEX idx_orders_customer_phone ON orders (customer_phone);
CREATE INDEX idx_orders_status ON orders (status);
CREATE INDEX idx_orders_order_number ON orders (order_number);

-- ── Order Items ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS order_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  subtotal   NUMERIC(12,2) GENERATED ALWAYS AS (quantity * unit_price) STORED
);

CREATE INDEX idx_order_items_order_id ON order_items (order_id);
CREATE INDEX idx_order_items_product_id ON order_items (product_id);

-- ── Returns & Exchanges ─────────────────────────────────────────────────────

CREATE TYPE return_exchange_type AS ENUM (
  'return', 'exchange'
);

CREATE TABLE IF NOT EXISTS returns_exchanges (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  type                 return_exchange_type NOT NULL DEFAULT 'return',
  returned_product_id  UUID REFERENCES products(id) ON DELETE RESTRICT,
  new_product_id       UUID REFERENCES products(id) ON DELETE RESTRICT,
  financial_difference NUMERIC(12,2) NOT NULL DEFAULT 0,
  processed_by         TEXT NOT NULL DEFAULT '',
  notes                TEXT NOT NULL DEFAULT '',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_returns_exchanges_original_order_id ON returns_exchanges (original_order_id);
CREATE INDEX idx_returns_exchanges_type ON returns_exchanges (type);

-- ── Helper: auto-update updated_at ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
