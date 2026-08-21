-- ============================================================================
-- NexusCore — 002: rebuild ledger_events so its `kind` CHECK is current
-- ============================================================================
--
-- ## Why this file exists
--
-- 001 is written to be re-runnable: every statement is `IF NOT EXISTS` or
-- `DROP ... IF EXISTS` + `CREATE`. That works for triggers, indexes and views,
-- which are dropped and recreated on every open.
--
-- It does NOT work for a TABLE. `CREATE TABLE IF NOT EXISTS ledger_events`
-- does nothing at all when the table is already there — including when its
-- CHECK constraint is an older, shorter list of event kinds. So every time a
-- new event kind was added to 001 under the "edit 001, no rebuild" decision,
-- databases created before that edit kept the OLD constraint forever, silently,
-- and the first write of the new kind failed with:
--
--     CHECK constraint failed: kind IN (...)
--
-- That is exactly what happened to `order_edited` (path #4): the kind was added
-- to 001, every fresh database and every test got it, and any database created
-- before the edit could not save an order edit at all. Tests never caught it
-- because tests always build a fresh database — the one case that is never
-- broken.
--
-- PLAN's own note on the decision predicted this: "a ledger DB created before
-- this keeps the old constraint ... If one ever does before release, a 002
-- rebuild is needed first." This is that rebuild.
--
-- ## Why a rebuild, and why it is safe
--
-- SQLite cannot ALTER a CHECK constraint. The only supported way to change one
-- is to build a new table, copy the rows, and swap it in. That is what this
-- does. Note what it does NOT do:
--
--   - It does not modify a single ledger row. Every row is copied verbatim,
--     column for column. Append-only means history is immutable; moving rows
--     between two tables with identical contents preserves that.
--   - It does not run on a database that is already current. `open()` inspects
--     `sqlite_master` first and skips this file entirely unless the stored
--     schema is actually missing a kind. A fresh install never runs it.
--   - It does not recreate the triggers, indexes or view. Dropping the old
--     table takes its triggers and indexes with it, and 001 is re-run
--     immediately afterwards to put them back — one definition of each, still
--     living only in 001. Duplicating them here would be a second source of
--     truth for the append-only enforcement, which is the last thing that
--     should exist in two places.
--
-- `PRAGMA foreign_keys` is toggled by `open()` around this file, not here:
-- pragmas are no-ops inside a transaction, and sqlx wraps a multi-statement
-- raw_sql batch. ledger_lines.event_id references ledger_events(id), so the
-- swap has to happen with enforcement off or the DROP would be refused.
-- `legacy_alter_table` is on for the same reason: without it, the final RENAME
-- would helpfully rewrite ledger_lines' foreign key to point at the temporary
-- table name.
-- ============================================================================


-- The new table: identical to 001's definition in every respect except that the
-- `kind` list is the current one. Keep this in step with 001 — if they ever
-- disagree, 001 is the contract and this is the bug.
CREATE TABLE ledger_events_rebuild (
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
  occurred_at TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  actor       TEXT,
  ref_type    TEXT,
  ref_id      TEXT,
  payload     TEXT NOT NULL DEFAULT '{}',
  reversed_by TEXT REFERENCES ledger_events(id),
  sync_status TEXT NOT NULL DEFAULT 'pending'
                CHECK (sync_status IN ('pending', 'synced', 'conflict'))
);

-- Columns named explicitly, not `SELECT *`: if 001 ever adds a column, this
-- copy should fail loudly and be updated, rather than silently dropping it.
INSERT INTO ledger_events_rebuild (
  id, store_id, device_id, kind, occurred_at, created_at,
  actor, ref_type, ref_id, payload, reversed_by, sync_status
)
SELECT
  id, store_id, device_id, kind, occurred_at, created_at,
  actor, ref_type, ref_id, payload, reversed_by, sync_status
FROM ledger_events;

-- DROP TABLE does not fire the BEFORE DELETE append-only trigger (that guards
-- row deletion, which is what it is for). The triggers and indexes on this
-- table go with it, and 001 re-creates them on the next line of `open()`.
DROP TABLE ledger_events;

ALTER TABLE ledger_events_rebuild RENAME TO ledger_events;
