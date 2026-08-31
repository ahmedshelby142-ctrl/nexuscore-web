-- ============================================================================
-- NexusCore — RBAC, Branches, Audit & Integration Logs
-- Target: Supabase (PostgreSQL 15+)
-- Migration: 003_rbac_audit_integrations
-- ============================================================================

-- ── Extended RBAC roles ─────────────────────────────────────────────────────
-- The application supports 9 user roles (4 original + 5 extended). The
-- originals remain unchanged; the additions are listed here for documentation.
--   originals : owner, cashier, data_entry, cashier_data_entry
--   extended  : branch_manager, inventory_clerk, accountant,
--               customer_support, viewer
-- The `users.role` column (added below) is a TEXT and accepts any of these
-- values; the application layer is the source of truth for what each role
-- can do (see src/lib/permissions.ts).

-- ── Branches (الفروع والمنافذ) ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS branches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,
  address     TEXT,
  phone       TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_branches_code ON branches (code);
CREATE INDEX IF NOT EXISTS idx_branches_active ON branches (is_active);

DROP TRIGGER IF EXISTS set_branches_updated_at ON branches;
CREATE TRIGGER set_branches_updated_at
  BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Branch assignments (user → branch → role) ──────────────────────────────

CREATE TABLE IF NOT EXISTS branch_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  username    TEXT NOT NULL,
  branch_id   UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_branch_assignments_user ON branch_assignments (user_id);
CREATE INDEX IF NOT EXISTS idx_branch_assignments_branch ON branch_assignments (branch_id);

-- ── Users (minimal schema — auth handled by Supabase Auth in production) ──
-- The actual authentication uses Supabase's auth.users table. The
-- application-side user role / branch assignment lives here.

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  username        TEXT NOT NULL UNIQUE,
  full_name       TEXT,
  role            TEXT NOT NULL DEFAULT 'cashier'
                  CHECK (role IN (
                    'owner', 'cashier', 'data_entry', 'cashier_data_entry',
                    'branch_manager', 'inventory_clerk', 'accountant',
                    'customer_support', 'viewer'
                  )),
  default_branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
CREATE INDEX IF NOT EXISTS idx_users_branch ON users (default_branch_id);

DROP TRIGGER IF EXISTS set_users_updated_at ON users;
CREATE TRIGGER set_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Audit log (سجل التدقيق) ────────────────────────────────────────────────
-- Append-only at the application level. The schema does not enforce
-- immutability — that is left to RLS + the in-app invariant that there
-- is no UPDATE/DELETE endpoint.

CREATE TABLE IF NOT EXISTS audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_username  TEXT NOT NULL DEFAULT 'system',
  actor_role      TEXT NOT NULL DEFAULT 'system',
  branch_id       UUID REFERENCES branches(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  resource        TEXT NOT NULL,
  details         JSONB,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log (actor_username);
CREATE INDEX IF NOT EXISTS idx_audit_log_branch ON audit_log (branch_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log (timestamp DESC);

-- ── Integrations registry (registry of every configured third-party) ───────

CREATE TABLE IF NOT EXISTS integrations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source          TEXT NOT NULL UNIQUE
                  CHECK (source IN ('paymob', 'shipping', 'online_order', 'shopify', 'woocommerce', 'custom')),
  is_active       BOOLEAN NOT NULL DEFAULT FALSE,
  api_key         TEXT,        -- should be encrypted in production
  api_secret      TEXT,        -- should be encrypted in production
  webhook_secret  TEXT,        -- for verifying inbound webhooks
  store_id        TEXT,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at TIMESTAMPTZ,
  last_sync_at    TIMESTAMPTZ,
  sync_status     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integrations_source ON integrations (source);
CREATE INDEX IF NOT EXISTS idx_integrations_active ON integrations (is_active);

DROP TRIGGER IF EXISTS set_integrations_updated_at ON integrations;
CREATE TRIGGER set_integrations_updated_at
  BEFORE UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Paymob transactions (سجل معاملات Paymob) ───────────────────────────────

CREATE TABLE IF NOT EXISTS paymob_transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paymob_id         BIGINT UNIQUE,
  merchant_order_id TEXT,
  amount            NUMERIC(14,2) NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'EGP',
  status            TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'pending', 'refunded')),
  source            TEXT,
  error_message     TEXT,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw              JSONB
);

CREATE INDEX IF NOT EXISTS idx_paymob_tx_status ON paymob_transactions (status);
CREATE INDEX IF NOT EXISTS idx_paymob_tx_merchant ON paymob_transactions (merchant_order_id);

-- ── Enable RLS on the sensitive tables (recommendation) ────────────────────

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE paymob_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_assignments ENABLE ROW LEVEL SECURITY;

-- ── RLS policies: owners can read everything; service role bypasses RLS ───
-- IMPORTANT: these policies assume auth.users is set up. They are
-- conservative defaults — tighten in your own environment.

CREATE POLICY "owners can read audit log"
  ON audit_log FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_user_id = auth.uid() AND u.role = 'owner'
    )
  );

CREATE POLICY "owners can manage integrations"
  ON integrations FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_user_id = auth.uid() AND u.role = 'owner'
    )
  );

CREATE POLICY "owners can read paymob transactions"
  ON paymob_transactions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_user_id = auth.uid() AND u.role = 'owner'
    )
  );

CREATE POLICY "users can read their own profile"
  ON users FOR SELECT
  USING (auth_user_id = auth.uid());

CREATE POLICY "owners can manage users"
  ON users FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_user_id = auth.uid() AND u.role = 'owner'
    )
  );

CREATE POLICY "owners can manage branches"
  ON branches FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_user_id = auth.uid() AND u.role = 'owner'
    )
  );

CREATE POLICY "users can read their own branch assignment"
  ON branch_assignments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_user_id = auth.uid() AND u.id::text = branch_assignments.user_id
    )
  );

-- Realtime for online_orders + audit_log (optional, for the live dashboards)
ALTER PUBLICATION supabase_realtime ADD TABLE audit_log;
ALTER PUBLICATION supabase_realtime ADD TABLE online_orders;
