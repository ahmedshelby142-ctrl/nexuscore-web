# QA Blueprint: Phase 5 - Returns, Exchanges & The Octopus Connections

**Objective:** Audit and stabilize the Returns & Exchanges engine (`المرتجعات والاستبدال`). Since returns can originate from multiple points, you must strictly verify the data and financial ripples across ALL origin screens, the Ledger, Shipping Accounts, and the Customer Base. No new features.

## 1. THE 4-POINT ORIGIN CHECK (Omnichannel Returns)
Returns and Exchanges can be initiated or reflected across multiple channels. Verify the integrity of the return/exchange flow from:
1. **POS (`POSPage.tsx`):** Both retail and wholesale modes.
2. **Wholesale (`WholesalePage.tsx`):** Returning items from a B2B invoice.
3. **E-commerce & Order Management:** Canceling or returning an online order.
4. **Standalone Returns Screen (`المرتجعات والاستبدال`):** Handling direct customer returns or manual exchanges.

## 2. THE INVENTORY RIPPLE (Restocking & Swapping)
- **Refund (مرتجع):** Ensure the `stockMirror` correctly ADDS the returned quantity back to the available inventory.
- **Exchange (استبدال):** Ensure the system correctly ADDS the old item back to stock AND DECREMENTS the new item from stock simultaneously.
- **Critical Bundle Check:** If a user returns/exchanges a Bundle (التجميعات), the system MUST restock/decrement the underlying base components, not the virtual bundle itself.

## 3. THE FINANCIAL & LTV RIPPLE (Ledger & `قاعدة العملاء`)
- **Refund Math:** The system must reverse the exact financial footprint. The `Wallet` (Treasury) and `Revenue` must decrease.
- **Discount Integrity:** A refunded item must respect the original discount applied. (e.g., You cannot refund 100 EGP if the item was bought with a 10% discount for 90 EGP).
- **Customer Lifetime Value (`customer_ltv`):** The `customer_ltv` in the ledger/database MUST decrease accurately to reflect the refunded amount. 
- **Shipping Ledger (`حسابات الشحن`):** If an online order is returned, ensure the courier fees/ledgers are handled logically without breaking the accounts.

## 4. QA PROTOCOL FOR CLAUDE
1. **ARABIC UI STRICTLY:** Do NOT translate any Arabic text to English.
2. Trace an "Exchange" (استبدال) scenario and explicitly report how the stock and ledger handle the price/stock difference.
3. Run `npx tsc --noEmit` and build checks.
4. Report your findings specifically on how the ledger handles the Omnichannel connections you verified.