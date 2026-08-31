# QA Blueprint: Phase 2 - Core Inventory & Bundles

**Objective:** Stabilize and verify the core product management screens. Ensure `ProductsPage`, `InventoryPage` (with the new Shortages Dashboard), and `البوكسات/التجميعات` (Bundles) operate flawlessly with the new `stockMirror` and `getActualStock` architecture. No new features.

## 1. PRODUCTS PAGE (`ProductsPage.tsx`)
- **UI Integrity:** Ensure all buttons (Add, Edit, Delete, Excel Import) function without crashing.
- **Data Rendering:** Ensure the main table correctly reads the stock using the unified `getActualStock(product)` function (both for variant and non-variant products). 
- **Stock Floor Validation:** Ensure the UI correctly reflects that a product's stock cannot display a negative number (floored at 0).

## 2. INVENTORY & SHORTAGES (`InventoryPage.tsx`)
- **General Stock Audit:** Verify that the Inventory table accurately reflects the stock after sales transactions.
- **The Shortages Dashboard (تقرير النواقص):**
  - Verify that the Shortages Table correctly renders the columns: "المطلوب بالطلبات" (Requested) and "العجز - للتوريد/التصنيع" (Actual Deficit).
  - Test the **"Order Dispatch Lock"** mechanism: Ensure that in the UI, if a user attempts to fulfill a backordered item, the logic correctly handles the shortfall math as derived (not accumulated).
  - Verify the **"Shortage Traceability"** UI: Ensure the table displays the specific Order IDs and Client Names waiting for the out-of-stock items.

## 3. BUNDLES / ASSEMBLIES (`البوكسات/التجميعات`)
*Context: A bundle is a single virtual product made of multiple base products.*
- **UI & Routing:** Verify that the "البوكسات/التجميعات" screen loads correctly.
- **The Octopus Connection (Bundle Stock Math):** 
  - Ensure the logic for calculating a Bundle's available stock accurately reads the `getActualStock` of its underlying component products. (e.g., If Bundle A needs 2 of Product X, and Product X has 4 in stock, Bundle A's available stock should be 2).
  - **CRITICAL RIPPLE:** Verify that when a Bundle is sold (in POS or E-commerce), the `stockMirror` correctly decrements the stock of the *component products*, NOT the virtual bundle itself.

## 4. QA PROTOCOL FOR CLAUDE
1. **ARABIC UI STRICTLY:** Do NOT translate any Arabic text to English.
2. If any `stockMirror` or `getActualStock` integration is missing in the Bundles module, fix it immediately so it aligns with Phase 1 architecture.
3. Run `npx tsc --noEmit` and build checks after verifying all three screens.
4. Provide a detailed report specifically on how the Bundles (التجميعات) module handles stock decrements.