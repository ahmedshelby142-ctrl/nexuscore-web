# QA Blueprint: Phase 4 - E-Commerce & Shipping Ledger

**Objective:** Audit and stabilize the Order Management flow (`إدارة الطلبات` / `الطلبات الإلكترونية`) and strictly verify the financial ripple into Shipping Accounts (`حسابات الشحن`). No new features.

## 1. ORDER LIFECYCLE & STATUS TRANSACTIONS
- **Target:** `OrdersManagementPage.tsx`
- **Action:** Test the full lifecycle of an online order (Pending -> Processing -> Shipped -> Delivered / Cancelled).
- **Verification:** Ensure that transitioning an order through these states updates the UI correctly and respects the "Order Dispatch Lock" (from Phase 2) if an item is out of stock.

## 2. THE COD & SHIPPING FINANCIAL RIPPLE (Critical)
- **Target:** Order Delivery Action & `حسابات الشحن`.
- **Logic:** When an order is marked as "Delivered" (تم التسليم), the system must split the Cash on Delivery (COD) correctly:
  - The **Goods Value** (Net of discounts) goes to the Store's Revenue/Treasury.
  - The **Shipping Fee** (collected from the customer) must be properly accounted for. It should either credit the Courier's/Shipping Company's ledger account or register as shipping revenue, depending on how `buildOrderDeliveredLines` is structured.
- **Verification:** Create a test order (e.g., 500 EGP goods + 50 EGP shipping = 550 EGP COD). Mark it delivered. Verify that the Treasury sees the 500, and the Shipping Ledger sees the 50.

## 3. ORDER CANCELLATION RIPPLE
- **Action:** Cancel an order before shipping.
- **Verification:** Ensure the `stockMirror` correctly releases the reserved stock back to the available inventory. Ensure no phantom financial records are created.

## 4. QA PROTOCOL FOR CLAUDE
1. **ARABIC UI STRICTLY:** Do NOT translate any Arabic text to English.
2. Map out exactly how `buildOrderDeliveredLines` distributes the money between the shop and the courier.
3. Run `npx tsc --noEmit` and build checks.
4. Report your findings specifically on the Shipping Ledger split.