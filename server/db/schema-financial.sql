-- ============================================================================
-- NexusCore — Financial & Operational Extensions
-- Target: Supabase (PostgreSQL 15+)
-- Migration: 002_financial_core
-- ============================================================================

-- ── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE IF NOT EXISTS wallet_type AS ENUM (
  'inStoreSafe', 'vodafoneCash', 'bankAccount'
);

CREATE TYPE IF NOT EXISTS stock_action_type AS ENUM (
  'sale', 'purchase', 'return', 'adjustment', 'import', 'ecommerce_order', 'ecommerce_return'
);

CREATE TYPE IF NOT EXISTS courier_receivable_status AS ENUM (
  'pending', 'reconciled', 'paid'
);

CREATE TYPE IF NOT EXISTS audit_session_status AS ENUM (
  'draft', 'confirmed', 'closed'
);

-- ── Wallets (الخزائن) ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wallets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        wallet_type NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  balance     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallets_type ON wallets (type);

-- Seed default wallets if empty
INSERT INTO wallets (type, label, balance)
  VALUES
    ('inStoreSafe', 'الخزينة', 0),
    ('vodafoneCash', 'فودافون كاش', 0),
    ('bankAccount', 'الحساب البنكي', 0)
ON CONFLICT (type) DO NOTHING;

-- ── Wallet Transfers ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wallet_transfers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_wallet wallet_type NOT NULL,
  to_wallet   wallet_type NOT NULL,
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_transfers_created ON wallet_transfers (created_at DESC);

-- ── Shareholders / Capital & Equity (الأسهم والمساهمين) ─────────────────────

CREATE TABLE IF NOT EXISTS shareholders (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL,
  capital_contributed    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (capital_contributed >= 0),
  share_percentage       NUMERIC(5,2) NOT NULL CHECK (share_percentage > 0 AND share_percentage <= 100),
  lifetime_dividends_paid NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (lifetime_dividends_paid >= 0),
  joined_date            TIMESTAMPTZ NOT NULL DEFAULT now(),
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shareholders_status ON shareholders (status);

-- ── Dividend Payments (توزيع الأرباح) ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS dividend_payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shareholder_id  UUID NOT NULL REFERENCES shareholders(id) ON DELETE RESTRICT,
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  period_start    TIMESTAMPTZ NOT NULL,
  period_end      TIMESTAMPTZ NOT NULL,
  net_profit      NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dividend_payments_shareholder ON dividend_payments (shareholder_id);
CREATE INDEX IF NOT EXISTS idx_dividend_payments_created ON dividend_payments (created_at DESC);

-- ── Immutable Stock Logs (سجل حركة الصنف) ──────────────────────────────────
-- Append-only: no UPDATE or DELETE triggers; enforce at application level

CREATE TABLE IF NOT EXISTS stock_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_sku  TEXT NOT NULL,
  product_name TEXT,
  action_type  stock_action_type NOT NULL,
  qty_change   INTEGER NOT NULL,
  previous_qty INTEGER NOT NULL CHECK (previous_qty >= 0),
  new_qty      INTEGER NOT NULL CHECK (new_qty >= 0),
  operator     TEXT NOT NULL DEFAULT '',
  reference_id TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_logs_product ON stock_logs (product_sku);
CREATE INDEX IF NOT EXISTS idx_stock_logs_action ON stock_logs (action_type);
CREATE INDEX IF NOT EXISTS idx_stock_logs_created ON stock_logs (created_at DESC);

-- ── Inventory Audit Sessions (جلسات الجرد) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'all',
  status      audit_session_status NOT NULL DEFAULT 'draft',
  session_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at   TIMESTAMPTZ,
  closed_by   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_sessions_status ON audit_sessions (status);
CREATE INDEX IF NOT EXISTS idx_audit_sessions_created ON audit_sessions (created_at DESC);

-- ── Audit Discrepancy Records ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_discrepancies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     UUID NOT NULL REFERENCES audit_sessions(id) ON DELETE CASCADE,
  product_sku    TEXT NOT NULL,
  product_name   TEXT,
  system_qty     INTEGER NOT NULL CHECK (system_qty >= 0),
  actual_qty     INTEGER NOT NULL CHECK (actual_qty >= 0),
  discrepancy    INTEGER NOT NULL,
  unit_cost      NUMERIC(12,2) DEFAULT 0,
  financial_loss NUMERIC(14,2) DEFAULT 0,
  adjusted       BOOLEAN NOT NULL DEFAULT FALSE,
  adjusted_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_discrepancies_session ON audit_discrepancies (session_id);

-- ── Courier Financial Records (الربط المالي مع الشحن) ────────────────────────

CREATE TABLE IF NOT EXISTS courier_financials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        TEXT NOT NULL UNIQUE,
  order_number    TEXT,
  courier_id      TEXT NOT NULL,
  courier_name    TEXT NOT NULL,
  order_total     NUMERIC(14,2) NOT NULL CHECK (order_total >= 0),
  courier_fee     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (courier_fee >= 0),
  amount_due      NUMERIC(14,2) NOT NULL CHECK (amount_due >= 0),
  status          courier_receivable_status NOT NULL DEFAULT 'pending',
  target_wallet  wallet_type,
  reconciled_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_courier_financials_status ON courier_financials (status);
CREATE INDEX IF NOT EXISTS idx_courier_financials_courier ON courier_financials (courier_id);
CREATE INDEX IF NOT EXISTS idx_courier_financials_created ON courier_financials (created_at DESC);

-- ── Financial Expenses (المصروفات) ───────────────────────────────────────────

CREATE TYPE IF NOT EXISTS expense_category AS ENUM (
  'rent', 'utilities', 'salaries', 'transport',
  'maintenance', 'marketing', 'office_supplies', 'shipping',
  'store_rent', 'other'
);

CREATE TABLE IF NOT EXISTS expenses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category    TEXT NOT NULL DEFAULT 'other',
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  description TEXT,
  date        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses (category);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (date DESC);

-- ── Trigger: auto-update updated_at on financial tables ─────────────────────

CREATE OR REPLACE FUNCTION update_wallets_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_shareholders_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_courier_financials_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_wallets_updated_at ON wallets;
CREATE TRIGGER set_wallets_updated_at
  BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION update_wallets_updated_at();

DROP TRIGGER IF EXISTS set_shareholders_updated_at ON shareholders;
CREATE TRIGGER set_shareholders_updated_at
  BEFORE UPDATE ON shareholders FOR EACH ROW EXECUTE FUNCTION update_shareholders_updated_at();

DROP TRIGGER IF EXISTS set_courier_financials_updated_at ON courier_financials;
CREATE TRIGGER set_courier_financials_updated_at
  BEFORE UPDATE ON courier_financials FOR EACH ROW EXECUTE FUNCTION update_courier_financials_updated_at();
