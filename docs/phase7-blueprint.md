# QA Blueprint Phase 7 - The Grand Finale (Dashboard & Treasury)

Objective Audit and stabilize the Executive Dashboard (`نظرة عامة`) and the TreasuryFinancials screen (`الشركاء والمالية`). Ensure these screens accurately aggregate and reflect the bulletproof ledger data we built in Phases 1-6. No new features.

## 1. THE TREASURY (`الشركاء والمالية`)
- Verification Ensure the إجمالي الخزنة (Total CashWallet) exactly matches the sum of all `wallet` ledger lines.
- The UI must correctly aggregate incoming cash (retail sales, wholesale payments, courier settlements, supplier surplus refunds) and outgoing cash (purchases, client refunds). 

## 2. THE EXECUTIVE DASHBOARD (`نظرة عامة`)
- Action Audit the top-level KPI widgets to ensure they pull from the correct ledger aggregates.
- Verification
  - Revenue & Profit Ensure إجمالي المبيعات matches the `revenue` ledger lines, and صافي الربح (Net Profit) correctly subtracts `cogs` and `expense` from `revenue`.
  - Debts (الديون) Ensure Client Debts (`receivable_client`) and Supplier Debts (`payable_supplier`) are correctly pulled and displayed.
  - Inventory Value (قيمة المخزون) Ensure this calculation correctly strictly respects the Weighted Average Cost (WAC) logic verified in Phase 6, without double-counting Bundles.

## 3. QA PROTOCOL FOR CLAUDE
1. ARABIC UI STRICTLY Do NOT translate any Arabic text to English.
2. READ-ONLY Do NOT write any new ledger events or build new transactional features in this phase. This is strictly a readaggregation audit.
3. Run `npx tsc --noEmit` and build checks.
4. Report any discrepancies found in how the Dashboard or Treasury calculated its totals compared to the raw ledger, and how you fixed them.