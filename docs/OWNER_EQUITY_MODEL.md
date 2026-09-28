# حقوق الملكية — owner capital and equity model (migration 049)

Single authority: `src/lib/ledger/equity.ts` (`equityStatement`). Database
authority: `ledger_validate_event` + the `insert_ledger_events` policy (049).
Tests: `scripts/check_owner_equity.mjs`; live-database matrix:
`scripts/security/049_equity_matrix.sql` (run inside `begin … rollback`).

## 1. What was there before

| Component | Where it lived | Problem |
|---|---|---|
| «رأس المال» | `partner.capitalContribution` — a number in browser localStorage (partners have no cloud table), summed over partner rows | A sole owner with no partner row had **no capital at all**; two devices disagreed; clearing the browser erased it |
| «إضافة مساهمة رأسمالية» | `addCapitalContribution` incremented that local number | **No money moved**, nothing reached the ledger — the wallets never saw the cash |
| Drawings | `owner_draw` event: `wallet −X`, `owner_budget +X` | Correct: not an expense, not in P&L |
| Profit / loss | `revenue − cogs − expense` (`netProfitOf`, and `owner_financial_summary` in the DB) | Correct: one definition |
| Opening balances | one-sided `stock_adjustment` events, `ref_type = opening_balance` (opening wallets and stock) | Implicitly "opening balance equity" — never labelled as such |
| PDF «إجمالي المبيعات» on the capital page | was the wallets total | Mislabelled figure |

## 2. The model

Two new event kinds, one new account (`owner_equity`, subject = `owner` or a
partner id). Both are **ADMIN-only** (first branch of the insert policy, so the
selling-role `ELSE` can never admit them).

| Kind | Lines | Meaning |
|---|---|---|
| `owner_capital` | `owner_equity ±X`, optionally `wallet ±X` (equal) | Original capital. With a wallet line: cash arriving now. **Without** one: declaring capital paid before the ledger existed — it moves no money, it re-labels part of the opening balances. Negative = correction; per-subject capital can never go below 0 |
| `owner_contribution` | `owner_equity +X`, `wallet +X` (equal, exactly one) | Money the owner puts in later. Not revenue, not profit |
| `owner_draw` (unchanged) | `wallet −X`, `owner_budget +X` | Drawings. Not an expense, not in P&L |

Every write goes through `ledger_append` → `ledger_validate_event`
(append-only, `store_id` from the event row, RLS on the insert). No separate
capital table, no local figure.

## 3. Formulas (all lifetime, all from the ledger)

```
capital         = Σ owner_equity  (kind owner_capital)        — null when no row exists («غير مسجل»)
contributions   = Σ owner_equity  (kind owner_contribution)
withdrawals     = Σ owner_budget                               — every owner_draw
accumulatedP/L  = Σ revenue − Σ cogs − Σ expense               — netProfitOf, the one P&L definition
capitalCash     = Σ wallet (kind owner_capital)                — capital that arrived as cash
declaredCapital = (capital ?? 0) − capitalCash                 — historical capital, no cash moved
openingBalances = Σ stock + Σ wallet + Σ expense  (kind stock_adjustment) − declaredCapital

صافي حقوق الملكية = capital + contributions + openingBalances + accumulatedP/L − withdrawals
```

Profit enters once (as P/L), withdrawals once (as `owner_budget`). Capital is
never derived from cash, stock, net worth, sales or profit. Per owner: capital,
contributions and withdrawals by subject (`owner#category` draws collapse to
`owner`). **Profit is not allocated to partners here** — no profit-sharing rule
is invented.

## 4. Scenarios

- **Sole owner, no partners** — works; nothing is conditioned on partner rows.
- **No capital recorded** — capital shows «غير مسجل» with a note that it is not
  zero; equity is still computed from the facts that exist.
- **Historical business (years before NEXUS)** — record opening wallets/stock as
  before; then ADMIN records «رأس المال الافتتاحي» *without* a wallet at the real
  effective date. Equity is unchanged; capital becomes a distinct, visible line
  and the opening balances shrink by the same amount.
- **Is an explicit opening-capital entry required?** Not for the system to work.
  It is required for NEXUS to *show* a capital figure — and only the owner knows
  it, so it is never guessed.

## 5. What this is not (real limitations)

- **The ledger is not double-entry.** Per-kind equations are enforced, but
  measured on production data several kinds leave residuals between assets and
  equity: `order_placed` (stock reserved, no liability), deposits held with no
  liability account, `order_delivered` / `sale` / `order_cancelled` /
  `client_payment` courier and receivable timing. So `صافي حقوق الملكية` is
  **not asserted to equal** «صافي القيمة» (`netWorthOf`, which also excludes
  courier balances). For the owner-equity kinds themselves the matrix proved
  Δequity = Δnet assets exactly.
- **Legacy local capital figures** (`partner.capitalContribution`) are not
  migrated — they were never money movements. The partners table shows them as
  «رقم مكتوب قبل الدفتر» and asks the ADMIN to record them properly.
- **Per-partner profit share** is not computed.
- `ProfitDashboard.tsx` still reads the legacy field for its PDF — it has no
  importers (dead code), left untouched.
- Reading equity requires `can_read_store_finance` (048): ADMIN, ACCOUNTANT,
  POS, ECOM. MODERATOR reads nothing. Writing capital/contributions: ADMIN only.

## 6. Evidence (QA-STORE, rolled back; production untouched)

| Check | Result |
|---|---|
| §10 500k capital + 100k contribution + 300k profit − 80k draw | capital 500,000 · Δequity 820,000 = Δnet assets |
| §11 500k + 100k − 150k loss − 50k draw | Δequity 400,000 = Δnet assets |
| Contribution alone | equity +100,000, revenue 0, profit 0 |
| Withdrawal alone | equity −80,000, profit 0 |
| Historical partner capital (no cash) | capital +200,000, opening −200,000, Δequity 0 |
| Correction −100k / below zero | accepted / rejected 23514 |
| Bad shapes (cash mismatch, no cash, capital as revenue, two capital lines, owner_equity in an expense) | all 23514 |
| POS, ACCOUNTANT capital; POS contribution; foreign ADMIN | all 42501 (RLS) |
| Reads: ACCOUNTANT / MODERATOR / foreign ADMIN | 600,000 / 0 rows / 0 rows |

## 7. Mobile (المالية screen, ADMIN)

Same authority, no mobile copy: `MobileOwnerScreen` mounts Desktop's
`useEquityStatement` → `fetchEquity(balances)` → `ledger_balances` →
`equityStatement()`. Display only — capital and contributions are recorded
on Desktop.

- Mounted inside the `owner_financial_summary` data branch, so it renders only
  after Postgres (ADMIN-only function) accepted the caller; a refused caller
  makes no equity read at all. `ledger_balances` is additionally limited by
  `can_read_store_finance` (MODERATOR: 0 rows).
- Fresh: a Desktop append inserts `ledger_events` → `signal_store_activity` →
  `store_activity` (realtime publication) → the `ledger_events` cue → both the
  summary and the equity statement re-read, keeping figures on screen while in
  flight (no skeleton flash). No mobile cache.
- Partner names are not on the phone (the partner registry is browser-local on
  Desktop), so Mobile shows totals; the label says «صاحبة الشغل والشركاء» when
  the ledger holds a non-owner capital subject.
