//! Ledger smoke test — the one runnable check behind the money path.
//!
//! Covers, against a real SQLite file with the real schema:
//!   1. sale → return → adjustment nets stock to zero, wallet to the one unit
//!      actually sold
//!   2. a failed append writes NOTHING (the transaction really rolls back)
//!   3. the database itself refuses history edits
//!
//! Run: cargo test --manifest-path src-tauri/Cargo.toml

use nexuscore_desktop_lib::ledger::{append, open, EventInput, LineInput};
use sqlx::SqlitePool;

const STORE: &str = "store-test";
const DEVICE: &str = "device-test";
const PRODUCT: &str = "prod-widget";
const WALLET: &str = "inStoreSafe";

fn temp_db_path(tag: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("nexuscore-test-{tag}-{nanos}.db"))
}

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
        occurred_at: "2026-08-15T10:00:00Z".to_string(),
        created_at: "2026-08-15T10:00:00Z".to_string(),
        actor: Some("test".to_string()),
        ref_type: None,
        ref_id: None,
        payload: None,
        lines,
    }
}

async fn balance(pool: &SqlitePool, account: &str, subject: &str) -> (f64, i64) {
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
    row.unwrap_or((0.0, 0))
}

async fn count(pool: &SqlitePool, sql: &str, bind: &str) -> i64 {
    sqlx::query_scalar(sql).bind(bind).fetch_one(pool).await.unwrap()
}

/// sale → return → adjustment, and the numbers net out.
///
/// Sell 3 units @ 100.00 EGP (10_000 piastres each), cost 60.00 EGP each.
/// Customer returns 2; the courier charges 10.00 EGP to bring them back.
/// Stock-take finds the 1 remaining unit was never actually sold — adjust +1.
/// Net stock change must be exactly zero. Net wallet must be exactly the
/// one unit that stayed sold... which, after the adjustment, is none of them.
#[tokio::test]
async fn sale_return_adjustment_nets_to_zero() {
    let db = open(temp_db_path("nets")).await.unwrap();
    let pool = &db.pool;

    // 1. Sale of 3 units.
    append(
        pool,
        &event(
            "evt-sale",
            "sale",
            vec![
                line("l1", "stock", PRODUCT, -3.0, 0),
                line("l2", "wallet", WALLET, 0.0, 30_000),
                line("l3", "revenue", "pos", 0.0, 30_000),
                line("l4", "cogs", PRODUCT, 0.0, 18_000),
                line("l5", "customer_ltv", "cust-1", 0.0, 30_000),
            ],
        ),
    )
    .await
    .unwrap();

    assert_eq!(balance(pool, "stock", PRODUCT).await.0, -3.0);
    assert_eq!(balance(pool, "wallet", WALLET).await.1, 30_000);

    // 2. Confirmed return of 2 units, 10.00 EGP courier fee.
    append(
        pool,
        &event(
            "evt-return",
            "return_confirmed",
            vec![
                line("l6", "stock", PRODUCT, 2.0, 0),
                line("l7", "wallet", WALLET, 0.0, -20_000),
                line("l8", "revenue", "pos", 0.0, -20_000),
                line("l9", "cogs", PRODUCT, 0.0, -12_000),
                line("l10", "expense", "shipping", 0.0, 1_000),
            ],
        ),
    )
    .await
    .unwrap();

    // 3. Stock-take: the last unit is back on the shelf.
    append(
        pool,
        &event(
            "evt-adjust",
            "stock_adjustment",
            vec![
                line("l11", "stock", PRODUCT, 1.0, 0),
                line("l12", "expense", "adjustment", 0.0, -10_000),
            ],
        ),
    )
    .await
    .unwrap();

    // Stock is back where it started.
    assert_eq!(
        balance(pool, "stock", PRODUCT).await.0,
        0.0,
        "stock must net to zero after sale → return → adjustment"
    );

    // Money: +300.00 sold, −200.00 refunded = +100.00 left in the wallet.
    assert_eq!(balance(pool, "wallet", WALLET).await.1, 10_000);
    assert_eq!(balance(pool, "revenue", "pos").await.1, 10_000);
    assert_eq!(balance(pool, "cogs", PRODUCT).await.1, 6_000);

    // Real COGS came from the lines, not from a 70%-of-revenue guess:
    // 6_000 piastres = one unit at its actual 60.00 EGP cost.
    assert_eq!(
        balance(pool, "revenue", "pos").await.1 - balance(pool, "cogs", PRODUCT).await.1,
        4_000,
        "gross margin on the one unit that stayed sold"
    );

    // Dump what the ledger actually holds, for eyeballing with --nocapture.
    let rows: Vec<(String, String, f64, i64)> = sqlx::query_as(
        "SELECT account, subject_id, qty, amount FROM account_balance
          WHERE store_id = ? ORDER BY account, subject_id",
    )
    .bind(STORE)
    .fetch_all(pool)
    .await
    .unwrap();

    println!("\n  account             subject        qty        EGP");
    println!("  ---------------------------------------------------");
    for (account, subject, qty, amount) in rows {
        println!(
            "  {:<18}  {:<12}  {:>5}  {:>9.2}",
            account,
            subject,
            qty,
            amount as f64 / 100.0
        );
    }
    println!();
}

/// The wire contract between `driver.ts` and this command.
///
/// `sale_return_adjustment_nets_to_zero` builds `EventInput` in Rust, so it
/// cannot catch a field-naming mismatch. This one feeds in the exact JSON
/// `driver.ts` emits — snake_case keys, integer piastres, nulls for the
/// optional fields — and appends it, so a rename on either side fails here
/// rather than silently at runtime.
#[tokio::test]
async fn deserializes_the_json_the_frontend_sends() {
    let db = open(temp_db_path("wire")).await.unwrap();

    let wire = r#"{
      "id": "11111111-1111-4111-8111-111111111111",
      "store_id": "store-test",
      "device_id": "device-test",
      "kind": "sale",
      "occurred_at": "2026-08-15T10:00:00Z",
      "created_at": "2026-08-15T10:00:00Z",
      "actor": null,
      "ref_type": "order",
      "ref_id": "ord-7",
      "payload": "{\"note\":\"من الواجهة\"}",
      "lines": [
        {
          "id": "22222222-2222-4222-8222-222222222222",
          "account": "stock",
          "subject_id": "prod-widget",
          "qty_delta": -2,
          "amount_delta": 0,
          "unit_cost": null
        },
        {
          "id": "33333333-3333-4333-8333-333333333333",
          "account": "wallet",
          "subject_id": "inStoreSafe",
          "qty_delta": 0,
          "amount_delta": 20000,
          "unit_cost": 6000
        }
      ]
    }"#;

    let event: EventInput =
        serde_json::from_str(wire).expect("driver.ts wire shape must deserialize");

    let result = append(&db.pool, &event).await.expect("append must accept it");
    assert_eq!(result.lines_written, 2);

    // 20000 piastres in == 200.00 EGP out.
    assert_eq!(balance(&db.pool, "wallet", "inStoreSafe").await.1, 20_000);
    assert_eq!(balance(&db.pool, "stock", "prod-widget").await.0, -2.0);
}

/// A rejected append must leave the database exactly as it was.
///
/// This is the assertion that matters most: it is what proves the write really
/// is one transaction, and that a half-written event cannot exist.
#[tokio::test]
async fn failed_append_writes_nothing() {
    let db = open(temp_db_path("atomic")).await.unwrap();
    let pool = &db.pool;

    // Four valid lines, then one with an account that violates the CHECK.
    // The bad line is last, so the header and four lines are already inserted
    // inside the transaction when it fails.
    let result = append(
        pool,
        &event(
            "evt-bad",
            "sale",
            vec![
                line("b1", "stock", PRODUCT, -5.0, 0),
                line("b2", "wallet", WALLET, 0.0, 50_000),
                line("b3", "revenue", "pos", 0.0, 50_000),
                line("b4", "cogs", PRODUCT, 0.0, 30_000),
                line("b5", "not_a_real_account", "x", 0.0, 1),
            ],
        ),
    )
    .await;

    assert!(result.is_err(), "an unknown account must be rejected");

    let events = count(
        pool,
        "SELECT COUNT(*) FROM ledger_events WHERE id = ?",
        "evt-bad",
    )
    .await;
    let lines = count(
        pool,
        "SELECT COUNT(*) FROM ledger_lines WHERE event_id = ?",
        "evt-bad",
    )
    .await;

    assert_eq!(events, 0, "rolled-back event header must not exist");
    assert_eq!(lines, 0, "rolled-back lines must not exist");
    assert_eq!(
        balance(pool, "stock", PRODUCT).await.0,
        0.0,
        "a rejected sale must not have moved stock"
    );
    assert_eq!(balance(pool, "wallet", WALLET).await.1, 0);
}

/// History is immutable because the database says so, not because the code
/// remembers to be careful.
#[tokio::test]
async fn database_refuses_history_edits() {
    let db = open(temp_db_path("append-only")).await.unwrap();
    let pool = &db.pool;

    append(
        pool,
        &event(
            "evt-fixed",
            "sale",
            vec![line("f1", "wallet", WALLET, 0.0, 5_000)],
        ),
    )
    .await
    .unwrap();

    let edit_amount = sqlx::query("UPDATE ledger_lines SET amount_delta = 999999 WHERE id = 'f1'")
        .execute(pool)
        .await;
    assert!(edit_amount.is_err(), "editing a line's amount must be refused");

    let edit_payload = sqlx::query("UPDATE ledger_events SET payload = '{\"x\":1}' WHERE id = 'evt-fixed'")
        .execute(pool)
        .await;
    assert!(edit_payload.is_err(), "editing an event's payload must be refused");

    let delete_event = sqlx::query("DELETE FROM ledger_events WHERE id = 'evt-fixed'")
        .execute(pool)
        .await;
    assert!(delete_event.is_err(), "deleting an event must be refused");

    let delete_line = sqlx::query("DELETE FROM ledger_lines WHERE id = 'f1'")
        .execute(pool)
        .await;
    assert!(delete_line.is_err(), "deleting a line must be refused");

    // The money is untouched after all four attempts.
    assert_eq!(balance(pool, "wallet", WALLET).await.1, 5_000);

    // But the two allowed transitions still work: marking a row synced...
    sqlx::query("UPDATE ledger_events SET sync_status = 'synced' WHERE id = 'evt-fixed'")
        .execute(pool)
        .await
        .expect("sync_status must remain writable");

    // ...and re-tagging store_id during tenancy reconciliation
    // (docs/LEDGER_SCHEMA.md §5).
    sqlx::query("UPDATE ledger_events SET store_id = 'canonical' WHERE id = 'evt-fixed'")
        .execute(pool)
        .await
        .expect("store_id re-tag must remain possible for reconciliation");
}
