"""Ledger SQL contract check.

Runs the real migration (src-tauri/migrations/001_ledger.sql) against a
throwaway SQLite database and asserts the guarantees the rest of the system
is built on:

  1. sale -> return -> adjustment nets stock to zero and money to the right
     remainder
  2. a rejected append writes NOTHING (the transaction really rolls back)
  3. the database itself refuses history edits, while still allowing the two
     transitions that must stay open (sync_status, store_id re-tag)

This is the SQL half of the check. The Rust half (that `ledger_append` wires
these statements into one sqlx::Transaction) is `src-tauri/tests/ledger_smoke.rs`,
which asserts the same three things through the real command path.

Run:  python scripts/check_ledger_schema.py
"""

import pathlib
import sqlite3
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIGRATION = ROOT / "src-tauri" / "migrations" / "001_ledger.sql"

STORE = "store-test"
DEVICE = "device-test"
PRODUCT = "prod-widget"
WALLET = "inStoreSafe"


def connect():
    path = pathlib.Path(tempfile.mkdtemp()) / "ledger.db"
    conn = sqlite3.connect(path, isolation_level=None)  # explicit transactions
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(MIGRATION.read_text(encoding="utf-8"))
    return conn


def append(conn, event_id, kind, lines):
    """Mirror of ledger_append: header + every line in ONE transaction."""
    conn.execute("BEGIN")
    try:
        conn.execute(
            """INSERT INTO ledger_events
                 (id, store_id, device_id, kind, occurred_at, created_at,
                  actor, ref_type, ref_id, payload, sync_status)
               VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '{}', 'pending')""",
            (event_id, STORE, DEVICE, kind,
             "2026-08-15T10:00:00Z", "2026-08-15T10:00:00Z"),
        )
        for line_id, account, subject, qty, amount in lines:
            conn.execute(
                """INSERT INTO ledger_lines
                     (id, event_id, store_id, account, subject_id,
                      qty_delta, amount_delta, unit_cost)
                   VALUES (?, ?, ?, ?, ?, ?, ?, NULL)""",
                (line_id, event_id, STORE, account, subject, qty, amount),
            )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


def balance(conn, account, subject):
    row = conn.execute(
        """SELECT qty, amount FROM account_balance
            WHERE store_id = ? AND account = ? AND subject_id = ?""",
        (STORE, account, subject),
    ).fetchone()
    return row if row else (0.0, 0)


def refused(conn, sql, label):
    """Assert the database rejects `sql`."""
    try:
        conn.execute(sql)
    except sqlite3.Error:
        return
    raise AssertionError(f"expected the database to refuse: {label}")


# -- 1. sale -> return -> adjustment nets to zero -----------------------------
# Sell 3 units @ 100.00 EGP (10_000 piastres), cost 60.00 each.
# Customer returns 2; courier charges 10.00 to bring them back.
# Stock-take finds the last unit never actually left -- adjust +1.

def test_nets_to_zero():
    conn = connect()

    append(conn, "evt-sale", "sale", [
        ("l1", "stock",        PRODUCT,  -3.0,      0),
        ("l2", "wallet",       WALLET,    0.0,  30_000),
        ("l3", "revenue",      "pos",     0.0,  30_000),
        ("l4", "cogs",         PRODUCT,   0.0,  18_000),
        ("l5", "customer_ltv", "cust-1",  0.0,  30_000),
    ])
    assert balance(conn, "stock", PRODUCT)[0] == -3.0
    assert balance(conn, "wallet", WALLET)[1] == 30_000

    append(conn, "evt-return", "return_confirmed", [
        ("l6",  "stock",   PRODUCT,     2.0,       0),
        ("l7",  "wallet",  WALLET,      0.0, -20_000),
        ("l8",  "revenue", "pos",       0.0, -20_000),
        ("l9",  "cogs",    PRODUCT,     0.0, -12_000),
        ("l10", "expense", "shipping",  0.0,   1_000),
    ])

    append(conn, "evt-adjust", "stock_adjustment", [
        ("l11", "stock",   PRODUCT,     1.0,       0),
        ("l12", "expense", "adjustment", 0.0, -10_000),
    ])

    stock = balance(conn, "stock", PRODUCT)[0]
    assert stock == 0.0, f"stock must net to zero, got {stock}"

    assert balance(conn, "wallet", WALLET)[1] == 10_000
    assert balance(conn, "revenue", "pos")[1] == 10_000
    assert balance(conn, "cogs", PRODUCT)[1] == 6_000

    # Real COGS came from the lines, not a 70%-of-revenue guess:
    # 6_000 piastres = one unit at its actual 60.00 EGP cost.
    margin = balance(conn, "revenue", "pos")[1] - balance(conn, "cogs", PRODUCT)[1]
    assert margin == 4_000, f"gross margin should be 4_000 piastres, got {margin}"

    print("  ok  sale -> return -> adjustment nets to zero")


# -- 2. a rejected append writes nothing --------------------------------------

def test_rollback_is_complete():
    conn = connect()

    # Four valid lines, then one with an account that violates the CHECK.
    # The bad line is last, so the header and four lines are already inserted
    # inside the transaction when it fails.
    try:
        append(conn, "evt-bad", "sale", [
            ("b1", "stock",              PRODUCT, -5.0,      0),
            ("b2", "wallet",             WALLET,   0.0, 50_000),
            ("b3", "revenue",            "pos",    0.0, 50_000),
            ("b4", "cogs",               PRODUCT,  0.0, 30_000),
            ("b5", "not_a_real_account", "x",      0.0,      1),
        ])
        raise AssertionError("an unknown account must be rejected")
    except sqlite3.IntegrityError:
        pass

    events = conn.execute(
        "SELECT COUNT(*) FROM ledger_events WHERE id = 'evt-bad'").fetchone()[0]
    lines = conn.execute(
        "SELECT COUNT(*) FROM ledger_lines WHERE event_id = 'evt-bad'").fetchone()[0]

    assert events == 0, "rolled-back event header must not exist"
    assert lines == 0, "rolled-back lines must not exist"
    assert balance(conn, "stock", PRODUCT)[0] == 0.0, "rejected sale moved stock"
    assert balance(conn, "wallet", WALLET)[1] == 0

    print("  ok  a rejected append writes nothing")


# -- 3. history is immutable, enforced by the database ------------------------

def test_append_only():
    conn = connect()
    append(conn, "evt-fixed", "sale", [("f1", "wallet", WALLET, 0.0, 5_000)])

    refused(conn, "UPDATE ledger_lines SET amount_delta = 999999 WHERE id = 'f1'",
            "editing a line's amount")
    refused(conn, "UPDATE ledger_events SET payload = '{\"x\":1}' WHERE id = 'evt-fixed'",
            "editing an event's payload")
    refused(conn, "UPDATE ledger_events SET kind = 'expense' WHERE id = 'evt-fixed'",
            "changing an event's kind")
    refused(conn, "DELETE FROM ledger_events WHERE id = 'evt-fixed'",
            "deleting an event")
    refused(conn, "DELETE FROM ledger_lines WHERE id = 'f1'",
            "deleting a line")

    # The money is untouched after all five attempts.
    assert balance(conn, "wallet", WALLET)[1] == 5_000

    # The two allowed transitions still work: marking a row synced...
    conn.execute("UPDATE ledger_events SET sync_status = 'synced' WHERE id = 'evt-fixed'")
    # ...and re-tagging store_id during tenancy reconciliation (§5).
    conn.execute("UPDATE ledger_events SET store_id = 'canonical' WHERE id = 'evt-fixed'")
    conn.execute("UPDATE ledger_lines SET store_id = 'canonical' WHERE id = 'f1'")

    moved = conn.execute(
        "SELECT amount FROM account_balance WHERE store_id = 'canonical'").fetchone()
    assert moved[0] == 5_000, "re-tagged rows must keep their amounts"

    print("  ok  the database refuses history edits")


if __name__ == "__main__":
    print(f"ledger SQL contract  ({MIGRATION.relative_to(ROOT)})")
    try:
        test_nets_to_zero()
        test_rollback_is_complete()
        test_append_only()
    except AssertionError as e:
        print(f"  FAIL  {e}")
        sys.exit(1)
    print("3 passed")
