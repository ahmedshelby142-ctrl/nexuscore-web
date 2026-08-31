-- ============================================================================
-- NexusCore — Authentication, Sessions, Licenses, Backups
-- Target: Supabase (PostgreSQL 15+)
-- Migration: 004_auth_license_backup
-- ============================================================================

-- ── Sessions (جلسات تسجيل الدخول) ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS auth_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username      TEXT NOT NULL,
  role          TEXT NOT NULL,
  branch_id     UUID REFERENCES branches(id) ON DELETE SET NULL,
  machine_id    TEXT NOT NULL,
  token         TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked       BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at    TIMESTAMPTZ,
  ip_address    TEXT,
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions (token);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_active ON auth_sessions (revoked, expires_at);

-- ── Login audit (محاولات الدخول) ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS auth_login_attempts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT now(),
  username      TEXT NOT NULL,
  machine_id    TEXT NOT NULL,
  ip_address    TEXT,
  success       BOOLEAN NOT NULL,
  reason        TEXT,
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_username ON auth_login_attempts (username, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_success ON auth_login_attempts (success, timestamp DESC);

-- ── Licenses (التراخيص) ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS licenses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key       TEXT NOT NULL,
  plan              TEXT NOT NULL CHECK (plan IN ('trial', 'basic', 'professional', 'enterprise', 'lifetime')),
  customer_name     TEXT NOT NULL,
  customer_email    TEXT,
  max_branches      INTEGER NOT NULL DEFAULT 1,
  max_users         INTEGER NOT NULL DEFAULT 1,
  cloud_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  mobile_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  features          JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at        TIMESTAMPTZ,
  activated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  machine_id        TEXT NOT NULL,
  last_verified_at  TIMESTAMPTZ,
  cache_ttl_days    INTEGER NOT NULL DEFAULT 7,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked', 'trial', 'trial_expired')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses (license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_machine ON licenses (machine_id);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses (status);

DROP TRIGGER IF EXISTS set_licenses_updated_at ON licenses;
CREATE TRIGGER set_licenses_updated_at
  BEFORE UPDATE ON licenses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── License audit trail (سجل أحداث الترخيص) ───────────────────────────────

CREATE TABLE IF NOT EXISTS license_audit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id    UUID REFERENCES licenses(id) ON DELETE CASCADE,
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT now(),
  event         TEXT NOT NULL CHECK (event IN (
    'activated', 'verified', 'renewed', 'revoked', 'expired',
    'machine_changed', 'tamper_detected'
  )),
  machine_id    TEXT NOT NULL,
  ip_address    TEXT,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_license_audit_license ON license_audit (license_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_license_audit_event ON license_audit (event);

-- ── Backups (النسخ الاحتياطية) ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS backups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename      TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT NOT NULL DEFAULT 'system',
  store_count   INTEGER NOT NULL DEFAULT 0,
  version       TEXT NOT NULL DEFAULT '1.0',
  sanitized     BOOLEAN NOT NULL DEFAULT TRUE,
  notes         TEXT,
  checksum      TEXT
);

CREATE INDEX IF NOT EXISTS idx_backups_created ON backups (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backups_created_by ON backups (created_by);

-- ── Restore history (سجل الاستعادة) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS backup_restores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id       UUID REFERENCES backups(id) ON DELETE SET NULL,
  restored_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  restored_by     TEXT NOT NULL,
  stores_restored INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed', 'cancelled')),
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_restores_backup ON backup_restores (backup_id);
CREATE INDEX IF NOT EXISTS idx_restores_status ON backup_restores (status);

-- ── Extend the existing users table to support password auth ──────────────
-- The original migration created `users` without password columns.
-- We add them here so the migration is self-contained.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS password_salt TEXT,
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_machine TEXT;

-- ── Seed: default owner account ──────────────────────────────────────────
-- Password hash is the bcrypt of "owner" (the user is forced to change
-- it on first login). The hash is generated server-side at activation.

-- We cannot insert a real hash here because the bcrypt salt is random.
-- The seed happens in code: when the server starts for the first time
-- and the users table is empty, the owner-bootstrap server fn creates
-- the first owner with a temporary password that must be changed.

-- ── RLS for the new tables ────────────────────────────────────────────────

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_restores ENABLE ROW LEVEL SECURITY;

-- Sessions: each user can read their own; service role bypasses RLS.
CREATE POLICY "users can read their own sessions"
  ON auth_sessions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth_sessions.user_id AND u.auth_user_id = auth.uid()
    )
  );

CREATE POLICY "owners can manage sessions"
  ON auth_sessions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_user_id = auth.uid() AND u.role = 'owner'
    )
  );

-- Login attempts: owners can read.
CREATE POLICY "owners can read login attempts"
  ON auth_login_attempts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_user_id = auth.uid() AND u.role = 'owner'
    )
  );

-- Licenses: only owners can read / modify.
CREATE POLICY "owners manage licenses"
  ON licenses FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_user_id = auth.uid() AND u.role = 'owner'
    )
  );

CREATE POLICY "owners read license audit"
  ON license_audit FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_user_id = auth.uid() AND u.role = 'owner'
    )
  );

-- Backups: only owners.
CREATE POLICY "owners manage backups"
  ON backups FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_user_id = auth.uid() AND u.role = 'owner'
    )
  );

CREATE POLICY "owners read restore history"
  ON backup_restores FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_user_id = auth.uid() AND u.role = 'owner'
    )
  );
