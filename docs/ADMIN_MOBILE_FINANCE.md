# ADMIN Mobile Finance

Mobile `/owner` adds operating expense, salary/bonus/advance, supplier payment,
owner personal draw, historical or cash-now capital, contribution, and personal
budget settings. The existing Quick Restock and Desktop opening-balance flows
are unchanged. Mobile supports ADMIN only; ACCOUNTANT remains a Desktop role.

## Shared accounting

- Expense and payroll call `useFinancialStore.recordExpense/recordPayroll`,
  hence the same `record_expense` / `record_payroll` transactions as Desktop.
  Expense categories and ledger builders are shared. Expense caps are enforced
  by the existing database function, without hydrating Desktop collections on Mobile.
- An expense/payroll form retains its document ID and submitted draft in
  store-scoped session storage until confirmed. An uncertain result locks edits
  and cancellation; retry uses that ID, including after a reload. Same-tick
  duplicate submits are gated. Closing the browser session loses this metadata;
  review the shared register before re-entering an uncertain transaction.
- Supplier payments use `commitSupplierPayment`; the server allocates oldest
  dues, supports partial/multiple invoices, and records excess as prepayment.
- Owner movements use `appendFinancialEvent` and the existing draw/equity
  builders and pending-command lifecycle. Draws reduce wallets and equity,
  never operating P&L. Historical capital has no wallet line; contributions
  and cash-now capital do. Mobile records the owner's own subject only.
- Wallets, P&L, dues and equity retain their existing shared readers. Recent
  activity shows financial events among the latest 30 ledger events, not an
  exhaustive transaction register. Supplier lookup is searchable, 50 per result.

## Shared personal budget

Migration `20261005173704_shared_owner_budget.sql` creates `owner_budgets`:
one primary-key row per `store_id`, positive finite two-decimal EGP limit,
`monthly`/`open` period, finite `started_at`, and server-created timestamps.
RLS grants ADMIN and ACCOUNTANT read/insert/update/delete in their own store.
ACCOUNTANT editing preserves the existing Desktop `/partners` budget-card
intent. MODERATOR/anon and other stores have no access. The timestamp trigger
is SECURITY INVOKER with a pinned search path. No financial RPC is changed.

Both surfaces use `useOwnerBudget` / `readOwnerBudget` / `saveOwnerBudget`.
They read on mount, focus, visibility return, local save, and every 30 seconds
while visible. Backend absence means unconfigured; read errors are not absence.
Retired Zustand/localStorage budget fields are discarded on merge/migration,
never uploaded. Only explicit form save writes a setting. Removing a setting
does not remove any ledger history. Concurrent setting edits use last-save-wins.

Spending remains `ownerSpent(balances(owner_budget, periodStart, now))`, excluding
partner advances. Monthly periods retain the existing local calendar-month
semantics; open periods retain the saved start until explicit reset. Editing a
limit preserves the start. Remaining is `budgetStatus(limit, spent).remaining`.
No historical rewrite, business-cap repurposing, or browser-data backfill occurs.

## Reload safety and validation

Every Mobile action form marks `data-pwa-unsaved` while open or saving;
all selections, text, budget and equity drafts are covered. Cancel/success clears
the form marker; failures preserve the draft. Uncertain financial commands keep
the foundation's additional pending marker. Offline hides financial figures and
disables submission without unmounting the draft.

`scripts/check_mobile_finance.mjs` executes the real form handlers with fault
injection and checks role visibility, budgets, shared adapters, retry identity,
double submits, PWA state and accounting builders. `check_financial_safety.mjs`
executes the tracked budget migration and existing expense/payroll RPC bodies
in disposable PostgreSQL alongside the foundation checks: shared records,
replay, exact ledger effects, caps, role/store RLS and budget constraints.

Production acceptance also requires a legitimate ADMIN-created Mobile record,
read-only Supabase confirmation and the same record in Desktop. Local/mocked
checks alone do not establish Production acceptance. Run evidence and final
deployment identifiers are recorded in `logs/ADMIN_MOBILE_FINANCE_VALIDATION.md`.
