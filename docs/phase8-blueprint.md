# QA Blueprint Phase 8 - Cloud Sync, Supabase Auth & Fixed RBAC

Objective Transform the local ERP into a secure, offline-first Cloud ERP. Implement Supabase Authentication with a fixed, 4-tier Role-Based Access Control (RBAC) system, and finalize the data sync layer so multiple devices (e.g., home and store) stay perfectly synchronized. No dynamic role-building features.

## 1. SUPABASE AUTH & FIXED ROLES (RBAC)
- Action Replace any complex or dynamic role-building UI with a strict, fixed 4-role system.
- The 4 Fixed Roles
  1. `ADMIN` (مدير النظام) Full access to everything.
  2. `POS_ECOMMERCE` (كاشير وأونلاين) Access ONLY to POS, Orders Management, E-commerce, and Customers.
  3. `ECOMMERCE_ONLY` (أونلاين فقط) Access ONLY to Orders Management, E-commerce, and read-only Inventory.
  4. `ACCOUNTANT` (محاسب ومخازن) Access ONLY to Purchasing, Suppliers, Inventory, and General LedgerTreasury reports.
- Verification Ensure the `UserManagementPanel` (الصلاحيات والمستخدمين) allows creating users with ONLY these predefined roles.

## 2. ROUTE & UI PROTECTION (Frontend Security)
- Logic The Sidebar and React Router must strictly enforce the RBAC roles.
- Verification If a `POS_ECOMMERCE` user logs in, the Treasury, Dashboard, Settings, and Purchasing links MUST disappear from the sidebar, and direct URL access to those routes must redirect to a safe page (e.g., POS or Home).

## 3. OFFLINE-FIRST CLOUD SYNC (The Backbone)
- Logic Ensure the `SyncService` and `ledgerSyncEngine` can smoothly push local transactions to Supabase and pull updates from other devices. 
- Verification The system must continue to work perfectly offline (saving to local SQLiteZustand), and automatically sync when the internet is restored. Ensure the metadata fix from Phase 2 is respected.

## 4. QA PROTOCOL FOR CLAUDE
1. ARABIC UI STRICTLY Keep all UI text, role names in dropdowns, and error messages strictly in Arabic.
2. SUPABASE SQL If adding the `role` column to a `users` or `profiles` table requires a Supabase DB migration, output the EXACT SQL code I need to run in my Supabase SQL Editor.
3. Test the Route Protection by simulating a login as a Cashier and confirming the Dashboard is blocked.
4. Run `npx tsc --noEmit` and build checks.
5. Report on how the frontend routes are protected and provide any necessary SQL.