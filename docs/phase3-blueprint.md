# QA Blueprint: Phase 3 - The Discount Engine & Financial Math

**Objective:** Audit and stabilize the Discount Engine (`محرك الخصومات`). Ensure that applying coupons or manual discounts in POS and Wholesale correctly recalculates the Grand Total, correctly adjusts the VAT, and routes the exact net amount to the Treasury/Ledger. No new features.

## 1. DISCOUNT MANAGEMENT UI (`الخصومات`)
- Verify the UI for creating, editing, and deleting discount codes/campaigns.
- Ensure state stores (e.g., `useDiscountStore` or `useBusinessStore`) correctly hold the discount rules (Percentage `%` vs Fixed Amount `ج.م`).

## 2. POS INTEGRATION (`POSPage.tsx`)
- **Action:** Apply a discount to a POS cart.
- **Math Verification:** 
  - Ensure the discount is applied to the Subtotal BEFORE VAT is finalized. 
  - Since the system uses "Tax-Inclusive" pricing, the discount must reduce the final Grand Total, and the printed VAT amount on the receipt must dynamically recalculate to reflect 14% of the *new discounted net price*.
- **The Octopus Ripple:** When the POS sale is completed, the amount injected into the Treasury (`useFinancialStore` / Ledger) MUST exactly match the Grand Total *after* the discount.

## 3. WHOLESALE INTEGRATION (`WholesalePage.tsx`)
- **Action:** Apply a discount to a B2B Invoice.
- **Math Verification:** Similar to POS, the discount must correctly reduce the final amount.
- **The Octopus Ripple (Debt & Payment):** 
  - The `remainingAmount` (Debt added to client) + `paidAmount` (Cash to Treasury) MUST precisely equal the discounted Grand Total. 
  - If a discount makes the invoice cheaper, the client's debt should reflect the discounted reality.

## 4. QA PROTOCOL FOR CLAUDE
1. **ARABIC UI STRICTLY:** Do NOT translate any Arabic text to English.
2. Check the Math: Specifically audit `math.ts` (or wherever cart totals are calculated) to ensure the order of operations is: `(Subtotal - Discount) = Net Total`, then extract VAT from the `Net Total`.
3. Test a 10% discount and a fixed 50 EGP discount in code.
4. Run `npx tsc --noEmit` and build checks.
5. Report on how the Discount math specifically interacts with the Tax-inclusive logic and the Ledger.