-- ============================================================================
-- NexusCore — Ledger schema (Phase 1)
-- Contract: docs/LEDGER_SCHEMA.md. If the two disagree, one of them is a bug.
-- ============================================================================
--
-- Money is INTEGER piastres (قرش), never REAL. SQLite has no decimal type and
-- the Owner Budget feature has to account for كل مليم. Conversion to/from EGP
-- happens only at the TypeScript driver boundary.
--
-- Quantities are REAL — fractional units (kg, metres) are legitimate.
--
-- Every statement is idempotent so this file can be re-run safely.
-- ============================================================================


-- ── Key/value app state ─────────────────────────────────────────────────────
-- Keys in use:
--   device_id           UUID, generated once on first run
--   store_id            UUID, provisional until claimed against the server
--   store_provisional   '1' while unclaimed — sync is BLOCKED while this is '1'
--   pull:<table>        last successful pull timestamp for that table
CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);


-- ── Tenancy re-tag audit ────────────────────────────────────────────────────
-- Written when a device that generated a provisional store_id offline logs into
-- an account that already has a canonical store. See LEDGER_SCHEMA.md §5.
CREATE TABLE IF NOT EXISTS store_alias (
  old_store_id TEXT PRIMARY KEY,
  new_store_id TEXT NOT NULL,
  rekeyed_at   TEXT NOT NULL
);


-- ── Ledger: event header ────────────────────────────────────────────────────
-- Append-only. Corrections are reversal events, never edits.
-- `payload` is descriptive JSON for display only — no screen may compute a
-- number from it. Numbers come from ledger_lines.
CREATE TABLE IF NOT EXISTS ledger_events (
  id          TEXT PRIMARY KEY,
  store_id    TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN (
                'sale',
                'order_placed',
                'order_delivered',
                'order_returned_pending',
                'order_cancelled',
                'order_edited',
                'return_confirmed',
                'purchase',
                'supplier_payment',
                'client_payment',
                'expense',
                'payroll',
                'wallet_transfer',
                'courier_settlement',
                'owner_draw',
                'stock_adjustment'
              )),
  occurred_at TEXT NOT NULL,              -- business time, ISO-8601 UTC
  created_at  TEXT NOT NULL,              -- local write time, ISO-8601 UTC
  actor       TEXT,
  ref_type    TEXT,
  ref_id      TEXT,
  payload     TEXT NOT NULL DEFAULT '{}',
  reversed_by TEXT REFERENCES ledger_events(id),
  sync_status TEXT NOT NULL DEFAULT 'pending'
                CHECK (sync_status IN ('pending', 'synced', 'conflict'))
);


-- ── Ledger: event effect ────────────────────────────────────────────────────
-- Every number in every screen is a SUM over this table.
-- `unit_cost` is a snapshot of the product's cost_price at the moment of the
-- sale. This is what replaces the hardcoded "COGS = 70% of revenue" rule.
CREATE TABLE IF NOT EXISTS ledger_lines (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES ledger_events(id),
  store_id     TEXT NOT NULL,
  account      TEXT NOT NULL CHECK (account IN (
                 'stock',
                 'wallet',
                 'revenue',
                 'cogs',
                 'expense',
                 'payable_supplier',
                 'receivable_client',
                 'receivable_courier',
                 'payable_courier',
                 'customer_ltv',
                 'owner_budget'
               )),
  subject_id   TEXT NOT NULL,             -- product / wallet / supplier / customer / courier
  qty_delta    REAL    NOT NULL DEFAULT 0,
  amount_delta INTEGER NOT NULL DEFAULT 0, -- piastres, signed
  unit_cost    INTEGER                     -- piastres
);


-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_lines_account_subject
  ON ledger_lines (store_id, account, subject_id);
CREATE INDEX IF NOT EXISTS idx_lines_event
  ON ledger_lines (event_id);
CREATE INDEX IF NOT EXISTS idx_events_sync
  ON ledger_events (sync_status);
CREATE INDEX IF NOT EXISTS idx_events_occurred
  ON ledger_events (store_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_ref
  ON ledger_events (ref_type, ref_id);


-- ── Append-only enforcement ─────────────────────────────────────────────────
-- The database refuses history edits. Not a convention the code has to remember.
--
-- UPDATE is allowed ONLY on:
--   sync_status  — pending → synced / conflict
--   reversed_by  — pointing at the correcting event
--   store_id     — tenancy reconciliation, pre-sync only (LEDGER_SCHEMA.md §5)
-- Every other column is immutable. DELETE is never allowed.

DROP TRIGGER IF EXISTS ledger_events_append_only_update;
CREATE TRIGGER ledger_events_append_only_update
BEFORE UPDATE ON ledger_events
FOR EACH ROW
WHEN OLD.id          <> NEW.id
  OR OLD.device_id   <> NEW.device_id
  OR OLD.kind        <> NEW.kind
  OR OLD.occurred_at <> NEW.occurred_at
  OR OLD.created_at  <> NEW.created_at
  OR OLD.payload     <> NEW.payload
  OR COALESCE(OLD.actor,    '') <> COALESCE(NEW.actor,    '')
  OR COALESCE(OLD.ref_type, '') <> COALESCE(NEW.ref_type, '')
  OR COALESCE(OLD.ref_id,   '') <> COALESCE(NEW.ref_id,   '')
BEGIN
  SELECT RAISE(ABORT, 'ledger_events is append-only: correct with a reversal event');
END;

DROP TRIGGER IF EXISTS ledger_events_append_only_delete;
CREATE TRIGGER ledger_events_append_only_delete
BEFORE DELETE ON ledger_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ledger_events is append-only: rows cannot be deleted');
END;

DROP TRIGGER IF EXISTS ledger_lines_append_only_update;
CREATE TRIGGER ledger_lines_append_only_update
BEFORE UPDATE ON ledger_lines
FOR EACH ROW
WHEN OLD.id           <> NEW.id
  OR OLD.event_id     <> NEW.event_id
  OR OLD.account      <> NEW.account
  OR OLD.subject_id   <> NEW.subject_id
  OR OLD.qty_delta    <> NEW.qty_delta
  OR OLD.amount_delta <> NEW.amount_delta
  OR COALESCE(OLD.unit_cost, -1) <> COALESCE(NEW.unit_cost, -1)
BEGIN
  SELECT RAISE(ABORT, 'ledger_lines is append-only: correct with a reversal event');
END;

DROP TRIGGER IF EXISTS ledger_lines_append_only_delete;
CREATE TRIGGER ledger_lines_append_only_delete
BEFORE DELETE ON ledger_lines
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ledger_lines is append-only: rows cannot be deleted');
END;


-- ── The aggregation surface ─────────────────────────────────────────────────
-- One view serves stock, wallet balances, supplier debt, courier receivables
-- and customer LTV. There is deliberately no per-account view.
--
-- ponytail: full scan of ledger_lines per read. Ceiling is tens of thousands of
-- events; past that add a materialised product_stock_snapshot.
--
-- ⚠️ BINDING CONSTRAINT — read docs/LEDGER_SCHEMA.md §4 before adding it:
-- that snapshot MUST be written inside the same sqlx::Transaction as the event
-- that changes it (in ledger_append, at the marked point), never as a separate
-- pass or background job. A snapshot written outside the event's transaction
-- reintroduces exactly the stored-value drift this schema exists to delete —
-- in a worse form, because it would look authoritative.
DROP VIEW IF EXISTS account_balance;
CREATE VIEW account_balance AS
SELECT
  store_id,
  account,
  subject_id,
  SUM(qty_delta)    AS qty,
  SUM(amount_delta) AS amount
FROM ledger_lines
GROUP BY store_id, account, subject_id;
