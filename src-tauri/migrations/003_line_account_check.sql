-- ============================================================================
-- NexusCore — 003: rebuild ledger_lines so its `account` CHECK is current
-- ============================================================================
--
-- The twin of 002, one layer down, and it exists because 002 was not general
-- enough. 002 taught `open()` to self-heal a stale list of event KINDS on
-- `ledger_events`. But `ledger_lines` carries its own CHECK — the list of
-- allowed ACCOUNTS — and that list grows for exactly the same reasons and goes
-- stale in exactly the same way.
--
-- It duly did. `payable_courier` was added to 001 during the shipping work, so
-- every fresh database and every test allowed it, while a database created
-- before that edit refused every line written to that account. The visible
-- symptom was "تأكيد التسليم" failing with
--
--     CHECK constraint failed: account IN (...)
--
-- which blocks delivery outright: `order_delivered` writes a `payable_courier`
-- line for the courier's fee, so the whole event — revenue, COGS, COD, LTV and
-- all — rolled back as one. (Correctly: the append is atomic, so nothing was
-- half-written and the dialog was right to say no balance changed.)
--
-- The lesson from 002 was recorded but implemented too narrowly: the repair was
-- written for one column on one table instead of for "a CHECK list that 001 can
-- extend". `repair_check_list` in ledger.rs is now the general mechanism and
-- this file is simply the `ledger_lines` half of it.
--
-- Everything 002 says about safety applies here unchanged:
--   - no ledger row is modified; rows are copied column-for-column
--   - it runs ONLY when `open()` finds an account genuinely missing
--   - triggers and indexes are not redefined here; dropping the table takes
--     them with it and 001 is re-run immediately after, so the append-only
--     enforcement still lives in exactly one place
--   - `PRAGMA foreign_keys` / `legacy_alter_table` are toggled by `open()`
--     around this file, since pragmas are no-ops inside sqlx's statement batch
--
-- One difference from 002: `account_balance` is a VIEW over this table, and it
-- has to be dropped FIRST. SQLite re-validates the whole schema after a DDL
-- change, so leaving a view pointing at a table that no longer exists makes the
-- very next statement fail with
--
--     error in view account_balance: no such table: main.ledger_lines
--
-- Dropping the view costs nothing — it holds no data, and 001's
-- `DROP VIEW IF EXISTS` + `CREATE VIEW` recreates it on the re-run immediately
-- after, from its single definition there.
-- ============================================================================


-- Must come before the table it selects from is dropped. See above.
DROP VIEW IF EXISTS account_balance;


-- Identical to 001's definition except that the `account` list is current.
-- Keep in step with 001 — if they disagree, 001 is the contract and this is
-- the bug.
CREATE TABLE ledger_lines_rebuild (
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
  subject_id   TEXT NOT NULL,
  qty_delta    REAL    NOT NULL DEFAULT 0,
  amount_delta INTEGER NOT NULL DEFAULT 0,
  unit_cost    INTEGER
);

-- Columns named explicitly, not `SELECT *`: if 001 ever adds a column this copy
-- should fail loudly and be updated, rather than silently dropping it.
INSERT INTO ledger_lines_rebuild (
  id, event_id, store_id, account, subject_id, qty_delta, amount_delta, unit_cost
)
SELECT
  id, event_id, store_id, account, subject_id, qty_delta, amount_delta, unit_cost
FROM ledger_lines;

DROP TABLE ledger_lines;

ALTER TABLE ledger_lines_rebuild RENAME TO ledger_lines;
