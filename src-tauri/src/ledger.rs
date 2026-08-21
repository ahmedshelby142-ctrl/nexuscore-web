//! Atomic ledger writes.
//!
//! Every write to `ledger_events` / `ledger_lines` goes through
//! [`append`], which puts the event header and all of its lines inside one
//! `sqlx::Transaction`. Nothing else in the system is allowed to INSERT into
//! those two tables.
//!
//! Why this exists instead of `BEGIN` / `COMMIT` from the frontend:
//! `tauri-plugin-sql` runs each statement against a connection taken from a
//! pool, so a `BEGIN` in one call and a `COMMIT` in another are not guaranteed
//! to reach the same connection. A half-written event — a header missing some
//! of its lines — never throws; it just makes stock or a wallet permanently
//! wrong. See docs/LEDGER_SCHEMA.md §4.
//!
//! `tauri-plugin-sql` is still the read path. Both open the same file; the
//! frontend asks for the absolute path via `ledger_db_path` so the two can
//! never disagree about which file that is.

use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

/// Filename inside the app config dir. Must match what the frontend loads.
pub const DB_FILENAME: &str = "nexuscore.db";

/// Managed Tauri state: the pool used for atomic ledger writes.
pub struct LedgerDb {
    pub pool: SqlitePool,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LineInput {
    pub id: String,
    pub account: String,
    pub subject_id: String,
    #[serde(default)]
    pub qty_delta: f64,
    /// Piastres, signed. Never pounds — see docs/LEDGER_SCHEMA.md §2.
    #[serde(default)]
    pub amount_delta: i64,
    /// Piastres. Snapshot of cost_price at the moment of the sale.
    #[serde(default)]
    pub unit_cost: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EventInput {
    pub id: String,
    pub store_id: String,
    pub device_id: String,
    pub kind: String,
    pub occurred_at: String,
    pub created_at: String,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub ref_type: Option<String>,
    #[serde(default)]
    pub ref_id: Option<String>,
    #[serde(default)]
    pub payload: Option<String>,
    #[serde(default)]
    pub lines: Vec<LineInput>,
}

#[derive(Debug, Serialize)]
pub struct AppendResult {
    pub event_id: String,
    pub lines_written: usize,
}

/// Open (creating if needed) the ledger database and apply the schema.
///
/// WAL plus a busy timeout so the read pool held by `tauri-plugin-sql` and this
/// write pool can share the file without tripping over each other.
pub async fn open(path: PathBuf) -> Result<LedgerDb, sqlx::Error> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let path_str = path.to_string_lossy().to_string();

    let options = SqliteConnectOptions::from_str(&format!("sqlite:{}", path_str))?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(10));

    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;

    sqlx::raw_sql(include_str!("../migrations/001_ledger.sql"))
        .execute(&pool)
        .await?;

    // 001 cannot update an existing table's CHECK constraint — see
    // migrations/002_event_kind_check.sql for why, and for what that cost.
    //
    // BOTH ledger tables carry a CHECK list that 001 extends over time, and
    // both go stale the same way, so both are checked. Doing only the event
    // kinds (the first version of this) left `ledger_lines.account` stale and
    // blocked delivery on any database created before `payable_courier` was
    // added.
    let repaired = repair_schema(&pool).await?;
    if repaired {
        // The rebuilds dropped the triggers, indexes and view belonging to the
        // tables they replaced. 001 is idempotent and owns the only definition
        // of each, so re-running it puts them all back.
        sqlx::raw_sql(include_str!("../migrations/001_ledger.sql"))
            .execute(&pool)
            .await?;
    }

    Ok(LedgerDb {
        pool,
        path: path_str,
    })
}

/// Every event kind the application can write.
///
/// The single Rust-side list of what 001's CHECK must allow. `repair_event_kinds`
/// compares the stored schema against this; if a kind is missing, the database is
/// from before that kind existed and needs the 002 rebuild.
///
/// Keep in step with 001's CHECK list and with `EventKind` in
/// `src/lib/ledger/types.ts`. All three describe the same set.
const EVENT_KINDS: &[&str] = &[
    "sale",
    "order_placed",
    "order_delivered",
    "order_returned_pending",
    "order_cancelled",
    "order_edited",
    "return_confirmed",
    "purchase",
    "supplier_payment",
    "client_payment",
    "expense",
    "payroll",
    "wallet_transfer",
    "courier_settlement",
    "owner_draw",
    "stock_adjustment",
];

/// Every account a ledger line may be written to.
///
/// The companion to `EVENT_KINDS`, and the list whose absence caused the second
/// round of this bug: `payable_courier` was added to 001 during the shipping
/// work, so a database created before that refused every courier-fee line and
/// with it the whole `order_delivered` event.
///
/// Keep in step with 001's CHECK list and with `Account` in
/// `src/lib/ledger/types.ts`. All three describe the same set.
const LEDGER_ACCOUNTS: &[&str] = &[
    "stock",
    "wallet",
    "revenue",
    "cogs",
    "expense",
    "payable_supplier",
    "receivable_client",
    "receivable_courier",
    "payable_courier",
    "customer_ltv",
    "owner_budget",
];

/// Bring every stale CHECK list in the database up to date.
///
/// Returns `true` if anything was rebuilt, so the caller knows to re-run 001
/// and restore the triggers, indexes and view the rebuilds dropped.
///
/// Both ledger tables are checked, because both carry a list that 001 extends
/// over time and both go stale identically. The first version of this repaired
/// only `ledger_events.kind`; `ledger_lines.account` went stale next and blocked
/// delivery. Adding a row here is now all a future list needs.
async fn repair_schema(pool: &SqlitePool) -> Result<bool, sqlx::Error> {
    // Events first: `ledger_lines` has a foreign key into `ledger_events`, so
    // the referenced table should be settled before the referencing one.
    let events = repair_check_list(
        pool,
        "ledger_events",
        "kind",
        EVENT_KINDS,
        include_str!("../migrations/002_event_kind_check.sql"),
    )
    .await?;

    let lines = repair_check_list(
        pool,
        "ledger_lines",
        "account",
        LEDGER_ACCOUNTS,
        include_str!("../migrations/003_line_account_check.sql"),
    )
    .await?;

    Ok(events || lines)
}

/// Rebuild one table if its stored CHECK list is missing any required value.
///
/// The comparison reads the schema SQLite actually stored, not what 001 says
/// today — that difference IS the bug being repaired. A current database
/// matches on the first look and this costs one cheap query.
async fn repair_check_list(
    pool: &SqlitePool,
    table: &str,
    column: &str,
    required: &[&str],
    rebuild_sql: &str,
) -> Result<bool, sqlx::Error> {
    let stored: Option<String> =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind(table)
            .fetch_optional(pool)
            .await?;

    let Some(stored) = stored else {
        // No table at all: 001 just created it, or something is very wrong.
        // Either way a rebuild has nothing to copy.
        return Ok(false);
    };

    // Quoted, so a value cannot match a coincidental substring elsewhere in the
    // schema text (a column comment, another constraint, a table name).
    let missing: Vec<&str> = required
        .iter()
        .copied()
        .filter(|value| !stored.contains(&format!("'{value}'")))
        .collect();

    if missing.is_empty() {
        return Ok(false);
    }

    eprintln!(
        "ledger: {table}.{column} CHECK is missing {missing:?} — rebuilding (no rows are modified)"
    );

    // ONE connection for the pragmas AND the rebuild.
    //
    // This is load-bearing, not tidiness. `PRAGMA foreign_keys` is per
    // CONNECTION, and this pool holds four. Issuing the pragma against the pool
    // sets it on whichever connection happens to serve that statement, and the
    // rebuild that follows can then run on a different one that still has
    // enforcement ON — which fails with `FOREIGN KEY constraint failed` the
    // moment ledger_events is dropped out from under ledger_lines' reference.
    // The first rebuild appeared to work only because the pool handed back the
    // same connection twice.
    let mut conn = pool.acquire().await?;

    // Foreign keys off for the swap: ledger_lines references ledger_events(id),
    // so a DROP of either side is refused while enforcement is on.
    // legacy_alter_table stops the closing RENAME from rewriting that reference
    // to the temporary table name. Both are no-ops inside a transaction, which
    // is why they are here and not in the .sql file.
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *conn)
        .await?;
    sqlx::query("PRAGMA legacy_alter_table = ON")
        .execute(&mut *conn)
        .await?;

    let result = sqlx::raw_sql(rebuild_sql).execute(&mut *conn).await;

    // Restore the pragmas on this connection whether or not the rebuild worked.
    // Returning it to the pool with foreign keys off would silently disable
    // referential integrity for whichever later write happened to get it.
    sqlx::query("PRAGMA legacy_alter_table = OFF")
        .execute(&mut *conn)
        .await?;
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *conn)
        .await?;

    result?;

    // A rebuild that corrupted anything must not be handed back as success.
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut *conn)
        .await?;
    if integrity != "ok" {
        return Err(sqlx::Error::Protocol(format!(
            "ledger: integrity_check failed after the {table} rebuild: {integrity}"
        )));
    }

    Ok(true)
}

/// Append one event and all of its lines in a single transaction.
///
/// Either the header and every line land, or nothing does. Any constraint
/// violation — an unknown `account`, an unknown `kind`, a duplicate id — rolls
/// the whole thing back.
pub async fn append(pool: &SqlitePool, event: &EventInput) -> Result<AppendResult, sqlx::Error> {
    let mut tx = pool.begin().await?;

    sqlx::query(
        r#"
        INSERT INTO ledger_events
          (id, store_id, device_id, kind, occurred_at, created_at,
           actor, ref_type, ref_id, payload, sync_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        "#,
    )
    .bind(&event.id)
    .bind(&event.store_id)
    .bind(&event.device_id)
    .bind(&event.kind)
    .bind(&event.occurred_at)
    .bind(&event.created_at)
    .bind(&event.actor)
    .bind(&event.ref_type)
    .bind(&event.ref_id)
    .bind(event.payload.as_deref().unwrap_or("{}"))
    .execute(&mut *tx)
    .await?;

    for line in &event.lines {
        sqlx::query(
            r#"
            INSERT INTO ledger_lines
              (id, event_id, store_id, account, subject_id,
               qty_delta, amount_delta, unit_cost)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&line.id)
        .bind(&event.id)
        .bind(&event.store_id)
        .bind(&line.account)
        .bind(&line.subject_id)
        .bind(line.qty_delta)
        .bind(line.amount_delta)
        .bind(line.unit_cost)
        .execute(&mut *tx)
        .await?;
    }

    // ── product_stock_snapshot writes go HERE, inside this transaction ──
    // Never after the commit, never in a separate pass. See the binding
    // constraint in docs/LEDGER_SCHEMA.md §4.

    tx.commit().await?;

    Ok(AppendResult {
        event_id: event.id.clone(),
        lines_written: event.lines.len(),
    })
}

#[derive(Debug, Serialize)]
pub struct Identity {
    pub store_id: String,
    pub device_id: String,
    /// True until `claim_store` has run against the server. Sync MUST stay
    /// blocked while this is true — that is what makes the two-device
    /// reconciliation in docs/LEDGER_SCHEMA.md §5 a purely local re-tag.
    pub store_provisional: bool,
}

/// Read this device's tenancy, creating it on first run.
///
/// The candidate UUIDs are generated by the caller (`crypto.randomUUID`) and
/// used only if this device has none yet — `INSERT OR IGNORE` then read-back
/// makes the whole thing idempotent, and keeps UUID generation client-side
/// (brief §1.4) without pulling a uuid crate into the build.
pub async fn identity(
    pool: &SqlitePool,
    candidate_store_id: &str,
    candidate_device_id: &str,
) -> Result<Identity, sqlx::Error> {
    let mut tx = pool.begin().await?;

    for (key, value) in [
        ("store_id", candidate_store_id),
        ("device_id", candidate_device_id),
        ("store_provisional", "1"),
    ] {
        sqlx::query("INSERT OR IGNORE INTO app_state (key, value) VALUES (?, ?)")
            .bind(key)
            .bind(value)
            .execute(&mut *tx)
            .await?;
    }

    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT key, value FROM app_state
          WHERE key IN ('store_id', 'device_id', 'store_provisional')",
    )
    .fetch_all(&mut *tx)
    .await?;

    tx.commit().await?;

    let get = |k: &str| {
        rows.iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };

    Ok(Identity {
        store_id: get("store_id"),
        device_id: get("device_id"),
        store_provisional: get("store_provisional") == "1",
    })
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn ledger_append(
    db: tauri::State<'_, LedgerDb>,
    event: EventInput,
) -> Result<AppendResult, String> {
    append(&db.pool, &event).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ledger_identity(
    db: tauri::State<'_, LedgerDb>,
    candidate_store_id: String,
    candidate_device_id: String,
) -> Result<Identity, String> {
    identity(&db.pool, &candidate_store_id, &candidate_device_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ledger_retag_store(
    db: tauri::State<'_, LedgerDb>,
    old_store_id: String,
    new_store_id: String,
) -> Result<(), String> {
    let mut tx = db.pool.begin().await.map_err(|e| e.to_string())?;

    let tables = [
        "ledger_events",
        "ledger_lines",
        "products",
        "customers",
        "suppliers",
        "discount_codes",
        "return_records",
    ];

    for table in tables {
        // We forcefully re-tag and mark as pending ALL rows that do not belong to the
        // new canonical store ID (including legacy data where store_id might be null or old).
        let query = format!(
            "UPDATE {} SET store_id = ?, sync_status = 'pending' WHERE store_id != ? OR store_id IS NULL",
            table
        );
        sqlx::query(&query)
            .bind(&new_store_id)
            .bind(&new_store_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Record the alias
    sqlx::query("INSERT INTO store_alias (old_store_id, new_store_id) VALUES (?, ?)")
        .bind(&old_store_id)
        .bind(&new_store_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    // Update app_state
    sqlx::query("UPDATE app_state SET value = ? WHERE key = 'store_id'")
        .bind(&new_store_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("UPDATE app_state SET value = '0' WHERE key = 'store_provisional'")
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    // Clear pull sync markers
    sqlx::query("DELETE FROM app_state WHERE key LIKE 'pull:%'")
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(())
}

/// Absolute path of the ledger database, so the frontend read path
/// (`tauri-plugin-sql`) opens the same file this pool wrote to.
#[tauri::command]
pub fn ledger_db_path(db: tauri::State<'_, LedgerDb>) -> String {
    db.path.clone()
}

/// DEV ONLY. Empties the ledger back to a freshly-installed schema.
///
/// For testing rounds: a screen-by-screen pass wants a database nobody has
/// exercised yet, not one carrying every path fired at the same rows.
///
/// Why DROP and re-create rather than DELETE: the ledger is append-only and
/// the triggers from 001 refuse both DELETE and UPDATE on `ledger_events` and
/// `ledger_lines` — by design, and that guarantee is not weakened for this.
/// Dropping the tables and re-running 001 leaves exactly what a first launch
/// would have created, with the triggers back in place.
///
/// `app_state` and `store_alias` go too: a fresh database means a fresh store
/// and device identity, otherwise the new events would be tagged with the old
/// store's id.
///
/// Gated on `debug_assertions`, so a release build (`tauri build`) refuses the
/// call even if something on the page manages to invoke it.
#[tauri::command]
pub async fn dev_reset_ledger(db: tauri::State<'_, LedgerDb>) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("dev_reset_ledger is not available in a release build".into());
    }

    // The view reads `ledger_lines`. SQLite re-validates the whole schema
    // after any DDL, so a surviving view over a dropped table makes the NEXT
    // statement fail — 003 learned this the hard way. Drop it first, and drop
    // the child table before its parent so foreign keys stay satisfied.
    sqlx::raw_sql(
        "DROP VIEW  IF EXISTS account_balance;
         DROP TABLE IF EXISTS ledger_lines;
         DROP TABLE IF EXISTS ledger_events;
         DROP TABLE IF EXISTS store_alias;
         DROP TABLE IF EXISTS app_state;",
    )
    .execute(&db.pool)
    .await
    .map_err(|e| format!("dev reset: dropping the ledger failed: {e}"))?;

    // 001 owns the only definition of every table, index, trigger and view,
    // and is idempotent — the same statement the app runs on a first launch.
    sqlx::raw_sql(include_str!("../migrations/001_ledger.sql"))
        .execute(&db.pool)
        .await
        .map_err(|e| format!("dev reset: recreating the ledger failed: {e}"))?;

    Ok(())
}
