//! A database created BEFORE an event kind existed must still be able to write it.
//!
//! Run: cargo test --manifest-path src-tauri/Cargo.toml --test migration_repair
//!
//! ## The bug this locks down
//!
//! `order_edited` was added to 001's `kind` CHECK when order editing was built.
//! Every fresh database got it. Every test got it, because tests create a fresh
//! database. But `CREATE TABLE IF NOT EXISTS` does nothing to a table that
//! already exists, so any database created before that edit kept the old, shorter
//! constraint — and editing an order failed outright with
//! `CHECK constraint failed: kind IN (...)`.
//!
//! The whole existing suite passed throughout, because "fresh database" is the
//! one case that was never broken. So this test does the thing the others
//! structurally cannot: it builds a database with a DELIBERATELY OLD schema,
//! then opens it through the real `open()` and demands that the new kind works
//! and that the old rows survived.

use nexuscore_desktop_lib::ledger::{append, open, EventInput, LineInput};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, SqlitePool};
use std::str::FromStr;

const STORE: &str = "store-legacy";
const DEVICE: &str = "device-legacy";

fn temp_db_path(tag: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("nexuscore-migration-{tag}-{nanos}.db"))
}

/// 001 as it genuinely stood before the online-order and shipping work.
///
/// BOTH check lists are deliberately old:
///   - `kind` predates `order_edited` / `order_cancelled` / `courier_settlement`
///   - `account` predates `payable_courier` / `receivable_courier` / `customer_ltv`
///
/// The `account` half matters as much as the `kind` half, and the first version
/// of this fixture got it wrong: it listed the CURRENT accounts while pretending
/// to be an old schema. That single inaccuracy is why the suite sailed past a
/// stale `payable_courier` and delivery broke in the owner's hands. A fixture
/// that is only half-old only tests half the repair.
const LEGACY_SCHEMA: &str = "
CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE ledger_events (
  id          TEXT PRIMARY KEY,
  store_id    TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN (
                'sale',
                'order_placed',
                'order_delivered',
                'return_confirmed',
                'purchase',
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

CREATE TABLE ledger_lines (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES ledger_events(id),
  store_id     TEXT NOT NULL,
  account      TEXT NOT NULL CHECK (account IN (
                 'stock', 'wallet', 'revenue', 'cogs', 'expense',
                 'payable_supplier', 'owner_budget'
               )),
  subject_id   TEXT NOT NULL,
  qty_delta    REAL    NOT NULL DEFAULT 0,
  amount_delta INTEGER NOT NULL DEFAULT 0,
  unit_cost    INTEGER
);
";

fn line(id: &str, account: &str, subject: &str, qty: f64, amount: i64) -> LineInput {
    LineInput {
        id: id.to_string(),
        account: account.to_string(),
        subject_id: subject.to_string(),
        qty_delta: qty,
        amount_delta: amount,
        unit_cost: None,
    }
}

fn event(id: &str, kind: &str, lines: Vec<LineInput>) -> EventInput {
    EventInput {
        id: id.to_string(),
        store_id: STORE.to_string(),
        device_id: DEVICE.to_string(),
        kind: kind.to_string(),
        occurred_at: "2026-08-17T10:00:00Z".to_string(),
        created_at: "2026-08-17T10:00:00Z".to_string(),
        actor: Some("test".to_string()),
        ref_type: Some("ecommerce_order".to_string()),
        ref_id: Some("order-1".to_string()),
        payload: None,
        lines,
    }
}

/// Build a database with the pre-`order_edited` schema and put a real order in it.
async fn seed_legacy_db(path: &std::path::Path) {
    let mut conn = SqliteConnectOptions::from_str(&format!("sqlite:{}", path.display()))
        .unwrap()
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();

    sqlx::raw_sql(LEGACY_SCHEMA).execute(&mut conn).await.unwrap();

    // An order that reserved two units — the row the rebuild must preserve.
    sqlx::query(
        "INSERT INTO ledger_events (id, store_id, device_id, kind, occurred_at, created_at, actor)
         VALUES ('evt-placed', ?, ?, 'order_placed', '2026-08-16T09:00:00Z', '2026-08-16T09:00:00Z', 'أونلاين')",
    )
    .bind(STORE)
    .bind(DEVICE)
    .execute(&mut conn)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO ledger_lines (id, event_id, store_id, account, subject_id, qty_delta, amount_delta)
         VALUES ('line-placed', 'evt-placed', ?, 'stock', 'p-shoe', -2.0, -24000)",
    )
    .bind(STORE)
    .execute(&mut conn)
    .await
    .unwrap();

    use sqlx::Connection;
    conn.close().await.unwrap();
}

#[tokio::test]
async fn legacy_database_rejects_order_edited_before_repair() {
    // The precondition, proven rather than assumed: this really is a database
    // that cannot store an order edit. Without this, the test below could pass
    // on a schema that was never broken.
    let path = temp_db_path("precondition");
    seed_legacy_db(&path).await;

    let pool = SqlitePool::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();

    let stored: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name = 'ledger_events'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        !stored.contains("'order_edited'"),
        "precondition: the legacy schema must NOT allow order_edited"
    );

    let failed = sqlx::query(
        "INSERT INTO ledger_events (id, store_id, device_id, kind, occurred_at, created_at)
         VALUES ('evt-x', ?, ?, 'order_edited', '2026-08-17T10:00:00Z', '2026-08-17T10:00:00Z')",
    )
    .bind(STORE)
    .bind(DEVICE)
    .execute(&pool)
    .await;

    assert!(
        failed.is_err(),
        "precondition: the legacy DB must reject order_edited — this is the reported bug"
    );

    pool.close().await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn open_repairs_a_legacy_database_and_editing_works() {
    let path = temp_db_path("repair");
    seed_legacy_db(&path).await;

    // The real production entry point does the repair.
    let db = open(path.clone()).await.expect("open must repair, not fail");
    let pool = &db.pool;

    // ── The constraint is current ────────────────────────────────────────
    let stored: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name = 'ledger_events'")
            .fetch_one(pool)
            .await
            .unwrap();
    assert!(
        stored.contains("'order_edited'"),
        "the rebuilt table must allow order_edited"
    );

    // ── The pre-existing history survived, unmodified ────────────────────
    let (kind, actor): (String, Option<String>) =
        sqlx::query_as("SELECT kind, actor FROM ledger_events WHERE id = 'evt-placed'")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(kind, "order_placed", "the old event is still here");
    assert_eq!(
        actor.as_deref(),
        Some("أونلاين"),
        "and every column came across verbatim, Arabic included"
    );

    let (qty, amount): (f64, i64) = sqlx::query_as(
        "SELECT qty, amount FROM account_balance
         WHERE store_id = ? AND account = 'stock' AND subject_id = 'p-shoe'",
    )
    .bind(STORE)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(qty, -2.0, "the reservation is intact");
    assert_eq!(amount, -24000, "with its value");

    // ── The append-only triggers are back ────────────────────────────────
    // The rebuild dropped them with the old table. If 001 were not re-run, the
    // ledger would silently become editable — a far worse bug than the one
    // being fixed.
    let deleted = sqlx::query("DELETE FROM ledger_events WHERE id = 'evt-placed'")
        .execute(pool)
        .await;
    assert!(
        deleted.is_err(),
        "append-only enforcement must survive the rebuild"
    );

    // ── And the thing that was blocked now works, end to end ─────────────
    // Swap one shoe back onto the shelf for six mugs off it: ONE event, two
    // lines, only the delta.
    let result = append(
        pool,
        &event(
            "evt-edited",
            "order_edited",
            vec![
                line("l-back", "stock", "p-shoe", 1.0, 12000),
                line("l-out", "stock", "p-mug", -6.0, -9000),
            ],
        ),
    )
    .await
    .expect("an order edit must now append");

    assert_eq!(result.lines_written, 2, "one line back, one line out");

    let (shoe_qty, _): (f64, i64) = sqlx::query_as(
        "SELECT qty, amount FROM account_balance
         WHERE store_id = ? AND account = 'stock' AND subject_id = 'p-shoe'",
    )
    .bind(STORE)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(shoe_qty, -1.0, "the released unit is back on the shelf");

    let (mug_qty, _): (f64, i64) = sqlx::query_as(
        "SELECT qty, amount FROM account_balance
         WHERE store_id = ? AND account = 'stock' AND subject_id = 'p-mug'",
    )
    .bind(STORE)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(mug_qty, -6.0, "and the new units are reserved");

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn legacy_database_rejects_payable_courier_before_repair() {
    // Same precondition discipline as the kinds test: prove the fixture really
    // is a database that cannot store a courier-fee line, or the repair test
    // below could pass against a schema that was never broken. This is the
    // assertion whose absence let delivery break in the owner's hands.
    let path = temp_db_path("account-precondition");
    seed_legacy_db(&path).await;

    let pool = SqlitePool::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();

    let stored: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name = 'ledger_lines'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        !stored.contains("'payable_courier'"),
        "precondition: the legacy schema must NOT allow payable_courier"
    );

    let failed = sqlx::query(
        "INSERT INTO ledger_lines (id, event_id, store_id, account, subject_id, qty_delta, amount_delta)
         VALUES ('line-x', 'evt-placed', ?, 'payable_courier', 'courier-1', 0, 5000)",
    )
    .bind(STORE)
    .execute(&pool)
    .await;

    assert!(
        failed.is_err(),
        "precondition: the legacy DB must reject payable_courier — this is the reported bug"
    );

    pool.close().await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn open_repairs_stale_accounts_and_delivery_writes_end_to_end() {
    let path = temp_db_path("delivery");
    seed_legacy_db(&path).await;

    let db = open(path.clone()).await.expect("open must repair, not fail");
    let pool = &db.pool;

    // ── Both CHECK lists are current, not just the one 002 covered ───────
    let lines_sql: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name = 'ledger_lines'")
            .fetch_one(pool)
            .await
            .unwrap();
    for account in ["payable_courier", "receivable_courier", "customer_ltv"] {
        assert!(
            lines_sql.contains(&format!("'{account}'")),
            "the rebuilt ledger_lines must allow {account}"
        );
    }

    // The reservation written under the OLD schema survived the rebuild.
    let (reserved_qty, _): (f64, i64) = sqlx::query_as(
        "SELECT qty, amount FROM account_balance
         WHERE store_id = ? AND account = 'stock' AND subject_id = 'p-shoe'",
    )
    .bind(STORE)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(reserved_qty, -2.0, "the order_placed reservation is intact");

    // ── The full delivery event, exactly as OrdersPage builds it ─────────
    // Two shoes at 200 sold, costing 120 each; 300 deposit already paid, 200
    // COD collected by the courier; 50 delivery fee owed to them.
    //
    // Stock is deliberately ABSENT: it moved at order_placed. Booking it again
    // here would take the same units off the shelf twice.
    let result = append(
        pool,
        &event(
            "evt-delivered",
            "order_delivered",
            vec![
                line("l-cogs", "cogs", "p-shoe", 0.0, 24000),
                line("l-wallet", "wallet", "inStoreSafe", 0.0, 30000),
                line("l-cod", "receivable_courier", "courier-1", 0.0, 20000),
                line("l-revenue", "revenue", "ecommerce", 0.0, 45000),
                line("l-fee", "payable_courier", "courier-1", 0.0, 5000),
                line("l-ltv", "customer_ltv", "cust-1", 0.0, 45000),
            ],
        ),
    )
    .await
    .expect("delivery must append on a repaired database");

    assert_eq!(result.lines_written, 6, "one event, all six effects");

    // ── The balances actually moved ──────────────────────────────────────
    let amount_of = |account: &'static str, subject: &'static str| async move {
        let row: Option<(f64, i64)> = sqlx::query_as(
            "SELECT qty, amount FROM account_balance
             WHERE store_id = ? AND account = ? AND subject_id = ?",
        )
        .bind(STORE)
        .bind(account)
        .bind(subject)
        .fetch_optional(pool)
        .await
        .unwrap();
        row.map(|(_, amount)| amount).unwrap_or(0)
    };

    assert_eq!(amount_of("wallet", "inStoreSafe").await, 30000, "the deposit is in the till");
    assert_eq!(
        amount_of("receivable_courier", "courier-1").await,
        20000,
        "the COD is owed to us by the courier"
    );
    assert_eq!(
        amount_of("payable_courier", "courier-1").await,
        5000,
        "and we owe them the delivery fee — the line that used to be refused"
    );
    assert_eq!(amount_of("revenue", "ecommerce").await, 45000, "revenue is booked");
    assert_eq!(amount_of("cogs", "p-shoe").await, 24000, "with its cost");
    assert_eq!(amount_of("customer_ltv", "cust-1").await, 45000, "and the customer's LTV");

    // Stock did NOT move again at delivery — it moved once, at order_placed.
    let (still_reserved, _): (f64, i64) = sqlx::query_as(
        "SELECT qty, amount FROM account_balance
         WHERE store_id = ? AND account = 'stock' AND subject_id = 'p-shoe'",
    )
    .bind(STORE)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(
        still_reserved, -2.0,
        "delivery must not move stock a second time — the goods left at order_placed"
    );

    // ── Append-only enforcement survived the second rebuild too ──────────
    let deleted = sqlx::query("DELETE FROM ledger_lines WHERE id = 'l-fee'")
        .execute(pool)
        .await;
    assert!(
        deleted.is_err(),
        "ledger_lines must still be append-only after being rebuilt"
    );

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn repair_is_skipped_on_a_current_database() {
    // A fresh install must not pay for the rebuild, and opening twice must not
    // rebuild twice. `open()` is called on every app start.
    let path = temp_db_path("fresh");

    let db = open(path.clone()).await.unwrap();
    sqlx::query("INSERT INTO app_state (key, value) VALUES ('marker', 'first-open')")
        .execute(&db.pool)
        .await
        .unwrap();
    drop(db);

    let db = open(path.clone()).await.unwrap();
    let marker: String = sqlx::query_scalar("SELECT value FROM app_state WHERE key = 'marker'")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        marker, "first-open",
        "reopening a current database must leave it alone"
    );

    let _ = std::fs::remove_file(&path);
}
