# QA Blueprint: Phase 6 - Purchasing, Suppliers & COGS

**Objective:** Audit and stabilize the Purchasing engine (`المشتريات والموردين`). Ensure that buying stock correctly increments inventory, properly updates the Cost of Goods Sold (COGS) / Weighted Average Cost, and flawlessly manages Supplier Debts (`payable_supplier`) and the Treasury (`Wallet`). No new features.

## 1. PURCHASING INVOICE (فاتورة المشتريات)
- **Inventory Ripple:** When a purchase invoice is submitted, the `stockMirror` MUST correctly increment the available stock for the purchased items.
- **Financial Ripple (Mixed Transaction):** 
  - The total invoice amount must accurately reflect the purchased goods.
  - Cash paid from the drawer MUST decrease the `Wallet`.
  - Any unpaid remaining amount MUST correctly increase the Supplier's Debt (`payable_supplier`).

## 2. SUPPLIER RETURNS (مرتجعات الموردين)
- **Inventory Ripple:** Returning items to a supplier MUST decrement the available stock.
- **Financial Ripple (Smart Reconciliation):** 
  - We need the exact same "Smart Reconciliation" logic here that we built for Wholesale Returns.
  - If we return goods to a supplier and they owe us money or reduce our debt:
    - Debt (`payable_supplier`) drops.
    - If the return value is greater than our debt, the excess must correctly increase our `Wallet` (Cash refunded to us by the supplier).

## 3. WEIGHTED AVERAGE COST (متوسط التكلفة)
- **Logic:** When new stock is purchased at a different price than the existing stock, the system MUST correctly recalculate the Average Cost (`costPrice` or `unitCost`) for the ledger, so future sales accurately reflect the real profit margins.
- **Verification:** Buy 10 units at 100 EGP. Then buy 10 units at 200 EGP. The new average cost should safely resolve to 150 EGP.

## 4. QA PROTOCOL FOR CLAUDE
1. **ARABIC UI STRICTLY:** Do NOT translate any Arabic text to English.
2. Verify a standard Purchase Invoice (partially paid).
3. Verify a Supplier Return using the Smart Reconciliation logic.
4. Verify the Weighted Average Cost recalculation.
5. Run `npx tsc --noEmit` and build checks.
6. Report your findings specifically on how the ledger handles the Supplier Debt and COGS.