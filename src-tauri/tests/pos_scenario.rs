//! §1.3 scenario check for the POS path.
//!
//! Consumes `pos_scenario.json`, which `scripts/gen_pos_scenario.mjs`
//! generates from the REAL `buildSaleLines` and `toPiastres`. So this is a
//! genuine end-to-end: TypeScript builds the sale, Rust appends it through
//! `ledger_append`, and the assertions read the aggregation view.
//!
//! If the frontend sale builder changes, regenerate the fixture and this test
//! tells you whether the change was correct.
//!
//! Run:  node scripts/gen_pos_scenario.mjs && cargo test --test pos_scenario

use nexuscore_desktop_lib::ledger::{append, open, EventInput};
use serde::Deserialize;
use sqlx::SqlitePool;

#[derive(Deserialize)]
struct Expected {
    /// Which account to read. The map key is just a label, so two subjects on
    /// the same account (retail vs wholesale revenue) can both be checked.
    account: String,
    subject: String,
    #[serde(default)]
    qty: f64,
    #[serde(default)]
    egp: f64,
}

#[derive(Deserialize)]
struct Scenario {
    store_id: String,
    derived_cost: f64,
    events: Vec<EventInput>,
    expected: std::collections::HashMap<String, Expected>,
}

fn temp_db_path() -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("nexuscore-pos-{nanos}.db"))
}

async fn balance(pool: &SqlitePool, store: &str, account: &str, subject: &str) -> (f64, i64) {
    let row: Option<(f64, i64)> = sqlx::query_as(
        "SELECT qty, amount FROM account_balance
          WHERE store_id = ? AND account = ? AND subject_id = ?",
    )
    .bind(store)
    .bind(account)
    .bind(subject)
    .fetch_optional(pool)
    .await
    .unwrap();
    row.unwrap_or((0.0, 0))
}

#[tokio::test]
async fn pos_scenario_matches_the_frontend() {
    let raw = include_str!("pos_scenario.json");
    let scenario: Scenario = serde_json::from_str(raw)
        .expect("run: node scripts/gen_pos_scenario.mjs");

    let db = open(temp_db_path()).await.unwrap();
    let pool = &db.pool;

    // Receive stock, float the till, then sell — each one event.
    for event in &scenario.events {
        append(pool, event)
            .await
            .unwrap_or_else(|e| panic!("event {} ({}) failed: {e}", event.id, event.kind));
    }

    // A POS sale is exactly ONE event carrying all five effects together.
    // Qualified by ref_id, not just kind: wholesale invoices are `sale` events
    // too, and the scenario now has more than one POS sale — counting either
    // more loosely would make this assert "the scenario has one sale" instead
    // of "a sale writes one event", which is not the same claim.
    let sale_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_events
          WHERE store_id = ? AND kind = 'sale' AND ref_id = 'POS-0001'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(sale_events, 1, "a POS sale must write exactly one event");

    let sale_lines: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.kind = 'sale' AND e.ref_id = 'POS-0001'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(sale_lines, 5, "stock, cogs, wallet, revenue, customer_ltv");

    // The guest sale of the opening-balance product: four lines, no LTV.
    let guest_sale_lines: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.ref_id = 'POS-0002'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(guest_sale_lines, 4, "stock, cogs, wallet, revenue — a guest has no LTV");

    // A wholesale invoice is also ONE event: stock, cogs, the cash paid up
    // front, the client debt for the rest, revenue, and the shipping expense.
    let wholesale_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_events
          WHERE store_id = ? AND kind = 'sale' AND ref_type = 'wholesale_invoice'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(wholesale_events, 1, "a wholesale invoice must write exactly one event");

    let wholesale_lines: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.kind = 'sale' AND e.ref_type = 'wholesale_invoice'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(
        wholesale_lines, 6,
        "stock, cogs, wallet, receivable_client, revenue, expense"
    );

    // Wholesale must NOT write a customer_ltv line — trade orders would
    // otherwise inflate the retail customer base's lifetime value.
    let wholesale_ltv: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.ref_type = 'wholesale_invoice'
            AND l.account = 'customer_ltv'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(wholesale_ltv, 0, "wholesale is not a retail customer");

    // Each receipt (توريد) is likewise ONE event — stock and the money side
    // land together. Three receipts here: cash, credit, and part-paid.
    let purchase_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_events WHERE store_id = ? AND kind = 'purchase'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(purchase_events, 3, "one event per receipt, never split");

    let purchase_lines: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.kind = 'purchase'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    // cash: stock+wallet (2), credit: stock+payable (2), part-paid: all three (3).
    assert_eq!(purchase_lines, 7, "2 cash + 2 credit + 3 part-paid");

    // A receipt must never write a cogs or revenue line — buying is not selling.
    let wrong_accounts: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.kind = 'purchase'
            AND l.account NOT IN ('stock', 'wallet', 'payable_supplier')",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(wrong_accounts, 0, "a purchase only moves stock, cash and supplier debt");

    // The other direction: one payment event, two lines, no stock touched.
    let payment_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_events WHERE store_id = ? AND kind = 'supplier_payment'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(payment_events, 1, "one event per payment");

    let payment_lines: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.kind = 'supplier_payment'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(payment_lines, 2, "wallet down, payable_supplier down");

    // Debt must be able to move BOTH ways. Counting the signs proves the
    // decrease exists at all — the direction that was missing entirely.
    let (debt_up, debt_down): (i64, i64) = sqlx::query_as(
        "SELECT
           COUNT(CASE WHEN amount_delta > 0 THEN 1 END),
           COUNT(CASE WHEN amount_delta < 0 THEN 1 END)
         FROM ledger_lines
          WHERE store_id = ? AND account = 'payable_supplier'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(debt_up, 2, "credit receipt + unpaid rest of the split receipt");
    assert_eq!(debt_down, 1, "the payment — without it, debt could only grow");

    // One client_payment event, two lines.
    let client_payment_lines: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.kind = 'client_payment'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(client_payment_lines, 2, "wallet up, receivable_client down");

    // The same both-directions check on the selling side: a receivable that
    // can only grow is the identical bug, one screen over.
    let (owed_up, owed_down): (i64, i64) = sqlx::query_as(
        "SELECT
           COUNT(CASE WHEN amount_delta > 0 THEN 1 END),
           COUNT(CASE WHEN amount_delta < 0 THEN 1 END)
         FROM ledger_lines
          WHERE store_id = ? AND account = 'receivable_client'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(owed_up, 1, "the unpaid part of the wholesale invoice");
    assert_eq!(owed_down, 1, "the client's payment");

    // ── The online order lifecycle ────────────────────────────────────────
    // Each transition is exactly one event, with the line count its step
    // actually calls for.
    for (kind, events, lines, why) in [
        ("order_placed", 3, 3, "stock reserved, nothing sold — one per order"),
        ("order_cancelled", 1, 1, "the reserved stock comes back"),
        (
            "order_delivered",
            1,
            6,
            "cogs, wallet, receivable_courier, revenue, payable_courier, customer_ltv",
        ),
        ("courier_settlement", 1, 3, "wallet, receivable_courier, payable_courier"),
        (
            "return_confirmed",
            1,
            7,
            "stock, cogs, wallet, revenue, expense, customer_ltv, payable_courier",
        ),
    ] {
        let got_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM ledger_events WHERE store_id = ? AND kind = ?",
        )
        .bind(&scenario.store_id)
        .bind(kind)
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(got_events, events, "{kind}: one event per transition");

        let got_lines: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM ledger_lines l
               JOIN ledger_events e ON e.id = l.event_id
              WHERE e.store_id = ? AND e.kind = ?",
        )
        .bind(&scenario.store_id)
        .bind(kind)
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(got_lines, lines, "{kind}: {why}");
    }

    // ── The zero-lines step, asserted as a fact and not as an absence ─────
    // "No lines found" is ALSO what a missing or never-appended event looks
    // like. So prove the event EXISTS first, then prove it carries nothing.
    let pending_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_events
          WHERE store_id = ? AND kind = 'order_returned_pending'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(
        pending_events, 1,
        "the courier's return claim must be recorded as an event — \
         if this is 0 the zero-line check below would pass for the wrong reason"
    );

    let pending_lines: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.kind = 'order_returned_pending'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(
        pending_lines, 0,
        "stock must not move on a courier's word — only on a human's confirmation"
    );

    // The confirmed return must carry the customer_ltv line specifically. A
    // return that balances stock and cash while leaving LTV intact passes a
    // careless test and still corrupts the CRM — this is the exact line the
    // smoke test once caught going missing.
    let return_ltv: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.kind = 'return_confirmed'
            AND l.account = 'customer_ltv' AND l.amount_delta < 0",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(return_ltv, 1, "a confirmed return MUST write customer_ltv −");

    // Every account the six-line return touches, present and correctly signed.
    for (account, sign) in [
        ("stock", 1),
        ("cogs", -1),
        ("wallet", -1),
        ("revenue", -1),
        ("expense", 1),
        ("customer_ltv", -1),
    ] {
        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM ledger_lines l
               JOIN ledger_events e ON e.id = l.event_id
              WHERE e.store_id = ? AND e.kind = 'return_confirmed'
                AND l.account = ?
                AND ((? > 0 AND (l.amount_delta > 0 OR l.qty_delta > 0))
                  OR (? < 0 AND l.amount_delta < 0))",
        )
        .bind(&scenario.store_id)
        .bind(account)
        .bind(sign)
        .bind(sign)
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(n, 1, "return_confirmed must write {account} with the right sign");
    }

    // COD: the courier owed it after delivery, and settlement cleared it.
    let (cod_up, cod_down): (i64, i64) = sqlx::query_as(
        "SELECT
           COUNT(CASE WHEN amount_delta > 0 THEN 1 END),
           COUNT(CASE WHEN amount_delta < 0 THEN 1 END)
         FROM ledger_lines
          WHERE store_id = ? AND account = 'receivable_courier'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(cod_up, 1, "COD collected on delivery");
    assert_eq!(cod_down, 1, "COD handed over at settlement");

    // ── جرد: the audit corrects the ledger to what was actually counted ──
    // The float at the top of the scenario is also a `stock_adjustment`, so
    // count only the audit's own — qualified by ref_type, the same trap the
    // POS/wholesale `sale` counts hit.
    let audit_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_events
          WHERE store_id = ? AND kind = 'stock_adjustment' AND ref_type = 'stock_audit'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(audit_events, 1, "a whole جرد is ONE event, not one per product");

    let audit_lines: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.ref_type = 'stock_audit'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(audit_lines, 2, "one discrepancy -> stock line + expense line");

    // Shrinkage must be valued at the real weighted-average cost. The code
    // this replaced booked a flat 10 per unit for every product in the shop.
    let shrink_amount: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount_delta), 0) FROM ledger_lines
          WHERE store_id = ? AND account = 'expense' AND subject_id = 'shrinkage'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(shrink_amount, 140_000, "2 units at the real 700.00, in piastres");
    assert_ne!(shrink_amount, 2_000, "not the old flat 10.00 per unit");

    // ── Opening balance: a shop that already had stock on day one ────────
    // One event, ONE line: the stock. No expense line — a جرد surplus cancels
    // an assumed loss, but an opening balance assumes nothing, and booking a
    // negative expense here would invent profit from the shop's own goods.
    let opening_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_events
          WHERE store_id = ? AND ref_type = 'opening_balance' AND ref_id = 'p-mug'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(opening_events, 1, "the opening balance must be a real recorded event");

    let opening_lines: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.ref_type = 'opening_balance' AND e.ref_id = 'p-mug'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(opening_lines, 1, "stock only — no expense, no wallet, no supplier");

    let opening_non_stock: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.ref_type = 'opening_balance' AND e.ref_id = 'p-mug'
            AND l.account <> 'stock'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(
        opening_non_stock, 0,
        "an opening balance must not create phantom profit or a phantom debt"
    );


    // ── Editing a pending order ──────────────────────────────────────────
    // ONE event, and only what changed: swapping 2 shoes for 1 shoe + 6 mugs
    // is two lines (1 shoe back, 6 mugs out), not a full un-reserve and
    // re-reserve. The original order_placed event is still there, untouched.
    let edit_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_events WHERE store_id = ? AND kind = 'order_edited'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(edit_events, 1, "an edit is one event");

    let edit_lines: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.kind = 'order_edited'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(edit_lines, 2, "one line back, one line out — only the delta");

    // Both directions inside that single event.
    let (released, reserved): (i64, i64) = sqlx::query_as(
        "SELECT
           COUNT(CASE WHEN l.qty_delta > 0 THEN 1 END),
           COUNT(CASE WHEN l.qty_delta < 0 THEN 1 END)
         FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.kind = 'order_edited'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(released, 1, "the swapped-out product goes back on the shelf");
    assert_eq!(reserved, 1, "the swapped-in product comes off it");

    // An edit moves stock only. Touching money here would mean an order that
    // has not been delivered had already booked revenue.
    let edit_non_stock: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.kind = 'order_edited' AND l.account <> 'stock'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(edit_non_stock, 0, "an edit reserves goods, it does not sell them");

    // The original reservation event is still on the ledger, unmodified — an
    // edit adds history, it never rewrites it.
    let original_still_there: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_events
          WHERE store_id = ? AND kind = 'order_placed' AND ref_id = 'ECO-EDIT'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(original_still_there, 1, "append-only: the old event survives the edit");


    // ── Wallets move independently ───────────────────────────────────────
    // The reported bug: the POS till showed a fixed number that never changed
    // after a sale, because the screen read a STORED balance while the sale
    // went to the ledger. These assertions pin the derived behaviour.
    let vodafone_lines: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines
          WHERE store_id = ? AND account = 'wallet' AND subject_id = 'vodafoneCash'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(vodafone_lines, 2, "an opening balance and one sale — nothing else");

    // The cash till has many lines; Vodafone has two. If a sale paid by
    // Vodafone had leaked into the cash till, this pair would not hold.
    let (_, cash_amount) = balance(pool, &scenario.store_id, "wallet", "inStoreSafe").await;
    let (_, vodafone_amount) = balance(pool, &scenario.store_id, "wallet", "vodafoneCash").await;
    assert_eq!(vodafone_amount, 70_000, "500 opening + 200 sale, in piastres");
    assert_ne!(
        cash_amount, vodafone_amount,
        "each wallet is summed on its own subject, not shared"
    );

    // A wallet nobody has used reads zero — from an absent SUM, not a stored
    // default sitting at 0.
    let (_, bank_amount) = balance(pool, &scenario.store_id, "wallet", "bankAccount").await;
    assert_eq!(bank_amount, 0, "an untouched wallet has no lines and so no balance");

    // The wallet opening balance is one line and moves no goods.
    let wallet_opening_non_wallet: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.ref_id = 'vodafoneCash'
            AND l.account <> 'wallet'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(wallet_opening_non_wallet, 0, "opening a till moves no stock and books no revenue");


    // ── Who bears each shipping fee ──────────────────────────────────────
    // The rule that keeps profit honest: a RETURN is the shop's cost; delivery
    // and exchange are the customer's and pass through to the courier.
    let delivery_expense: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.kind = 'order_delivered' AND l.account = 'expense'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(
        delivery_expense, 0,
        "a delivery fee is the customer's — booking it as our expense would make          shipping look like a loss it is not"
    );

    // Nor is it revenue: revenue on the delivery is the goods only.
    let (_, ecom_revenue) = balance(pool, &scenario.store_id, "revenue", "ecommerce").await;
    assert_eq!(
        ecom_revenue, 0,
        "booked on the goods at delivery and fully reversed at the return"
    );

    // The one shipping cost the shop actually bears.
    let (_, return_expense) =
        balance(pool, &scenario.store_id, "expense", "shipping_return").await;
    assert_eq!(return_expense, 8_000, "the 80.00 return fee, in piastres");
    assert!(return_expense > 0, "returns are the shop's only shipping expense");

    // The courier's two sides both exist and are separate accounts.
    let courier_lines: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines
          WHERE store_id = ? AND account = 'payable_courier'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(
        courier_lines, 3,
        "delivery fee owed, return fee owed, and the settlement that cleared some"
    );

    // Settlement must not book the fee a second time.
    let settlement_expense: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_lines l
           JOIN ledger_events e ON e.id = l.event_id
          WHERE e.store_id = ? AND e.kind = 'courier_settlement' AND l.account = 'expense'",
    )
    .bind(&scenario.store_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(
        settlement_expense, 0,
        "the fee was booked at the movement — booking it here too would double-count"
    );


    println!("\n  §1.3 — receive 10@600 cash + 10@800 credit + 5@700 part-paid,");
    println!("         pay the supplier 3500, sell 2 @ 1000.00 retail,");
    println!("         invoice 5 @ 900.00 wholesale on credit, collect 1500,");
    println!("         online: place 3 → deliver → settle COD → claim return → confirm,");
    println!("         then جرد counts 16 against 18 → 1400 shrinkage at real cost");
    println!("  account             subject         qty        EGP      expected");
    println!("  ------------------------------------------------------------------");

    let mut accounts: Vec<_> = scenario.expected.iter().collect();
    accounts.sort_by_key(|(label, _)| label.as_str());

    for (label, want) in accounts {
        let (qty, amount) = balance(pool, &scenario.store_id, &want.account, &want.subject).await;
        let egp = amount as f64 / 100.0;

        println!(
            "  {:<18}  {:<12}  {:>6}  {:>9.2}  {:>9.2}",
            label, want.subject, qty, egp, want.egp
        );

        // Both numbers are checked for every account. Stock is the one that
        // carries a quantity AND a value, and the two must stay consistent —
        // that consistency is what makes the derived cost trustworthy.
        assert_eq!(qty, want.qty, "{label} qty for {} is wrong", want.subject);
        assert_eq!(egp, want.egp, "{label} amount for {} is wrong", want.subject);
    }

    // The cost the sale snapshotted must be the blended cost of what was
    // received — not either receipt's price, and not a product-record default.
    let (stock_qty, stock_amount) =
        balance(pool, &scenario.store_id, "stock", "p-shoe").await;
    let remaining_avg = (stock_amount as f64 / 100.0) / stock_qty;

    println!();
    println!("  derived cost at sale time : {:.2} EGP", scenario.derived_cost);
    println!("  average cost of remainder : {:.2} EGP", remaining_avg);

    assert_eq!(
        scenario.derived_cost, 700.0,
        "10@600 + 10@800 + 5@700 blends to 700"
    );
    assert_ne!(scenario.derived_cost, 600.0, "must not use the first receipt's price");
    assert_ne!(scenario.derived_cost, 800.0, "must not use the highest receipt's price");
    assert_eq!(
        remaining_avg, 700.0,
        "selling at average cost must leave the average unchanged"
    );
    println!();
}
