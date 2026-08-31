# QA Blueprint: Settings Page & Sidebar Consolidation

**Objective:** Clean up the Sidebar, remove unnecessary bloatware from the Settings page, and consolidate administrative screens into a clean Tabs-based layout inside `SettingsPage.tsx`.

## 1. SIDEBAR CLEANUP (`AppSidebar.tsx` or equivalent)
- **Remove:** Delete the following links/items from the main sidebar navigation:
  1. "الفروع والمنافذ" (Branches)
  2. "المستخدمين والصلاحيات" (Roles & Permissions)
  3. "النسخ الاحتياطي" (Backups)
- Ensure the routing doesn't break. These will now live inside Settings.

## 2. SETTINGS UI REMOVALS (Trim the Fat)
Open `SettingsPage.tsx` and completely **DELETE** the following sections (UI and Logic):
- **حالة الاشتراك (Subscription / Pro Plan):** Remove this section completely.
- **أدوات التطوير (Dev Tools / تصفير بيانات التجربة):** Remove this section completely (also remove it from the Dashboard if it exists there).

## 3. DEFERRED FEATURES (Version 2)
- **قنوات الربط النشطة (Connected Channels - Shopify etc.):** KEEP the UI as it is, but DO NOT spend any time wiring its logic or testing it. Treat it as a static UI component for now.
- **الهوية البصرية (Brand Identity):** KEEP the UI, but if the logic is complex or broken, ignore it for now.

## 4. THE NEW SETTINGS LAYOUT (Tabs Implementation)
Wrap the entire `SettingsPage.tsx` content in a Shadcn `Tabs` component to organize the massive page. Create the following Tabs:

- **Tab 1: `عام` (General)**
  - Contains: "بيانات المحل الأساسية & الإعدادات الضريبية", "تكوين موديول التجزئة والأونلاين", "قنوات الربط النشطة", and "الهوية البصرية".
- **Tab 2: `الشحن` (Shipping)**
  - Contains: The Shipping Rates table ("أسعار الشحن"). Ensure it correctly updates `useShippingRatesStore`.
- **Tab 3: `الفروع` (Branches)**
  - Import and render the actual Branches component/page here.
- **Tab 4: `الصلاحيات` (Roles)**
  - Import and render the actual Roles & Users component/page here.
- **Tab 5: `النسخ الاحتياطي` (Backups)**
  - Import and render the actual Backups component/page here.

## 5. QA INSTRUCTIONS FOR CLAUDE
- **ARABIC UI STRICTLY:** Do NOT translate any Arabic text to English.
- Ensure state is preserved when switching between tabs.
- Run `npx tsc --noEmit` after these heavy structural changes to fix any import or routing errors.
- Report back when the Sidebar is clean and the new Tabbed Settings page is fully operational.
## 6. THE OCTOPUS CONNECTIONS (State Ripples & Wiring)
Claude MUST explicitly test and verify the following data paths to ensure Settings ripple correctly across the system:

### A. General Info & Taxes Ripple (`عام`)
- **Action:** Changing the Store Name, Phone, or Tax Percentage.
- **Ripple Test:** Must update `useBusinessStore`. Verify that these values correctly feed into the PDF generation tools (Invoice printing) used in `POSPage` and `WholesalePage`.

### B. Shipping Rates Ripple (`الشحن`)
- **Action:** Adding/Editing a Governorate's delivery, return, or exchange rates.
- **Ripple Test:** Must update `useShippingRatesStore`. Verify that when a user selects "توصيل عادي" for "القاهرة" in `WholesalePage`, it strictly pulls the exact rate set here.

### C. Branches Ripple (`الفروع`)
- **Action:** Adding or updating a branch.
- **Ripple Test:** Must update the global branch store. Verify that the POS screen (`POSPage.tsx`) or user assignment can correctly read the updated branches list.

### D. Toggles & Modules Ripple
- **Action:** Toggling modules like "نظام المرتجعات المتقدم" or "الربط الإلكتروني".
- **Ripple Test:** Ensure these boolean toggles correctly persist in the relevant store (e.g., `useBusinessStore`).