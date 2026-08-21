# NEXUSCORE — BUILD PLAN & PROGRESS TRACKER

Work top to bottom. Do the phases in order. After each item: tick it (`[ ]` → `[x]`),
then report overall % in words (done items ÷ total items across the whole file).
Detailed spec for any screen is in `NEXUSCORE_DEV_BRIEF.md`. Rules are in
`NEXUSCORE_RULES.md`. **Read the brief section only for the item you're on.**

Legend: `[x]` done · `[ ]` todo · `(opt)` optional, only after core is done · 🚪 = gate
(stop and get approval before continuing).

**Progress marker (update this line every time):** `DONE 30 / 48 (~62%)` — screens 1–9 of the pass
(نظرة عامة, المنتجات, نقاط البيع, المخازن, الجرد, المشتريات والموردين) closed 2026-08-18; 7–10 (الشركاء والمالية, قاعدة العملاء, إدارة الطلبات, حسابات الشحن) on 2026-08-19. The denominator moved 47 → 48 when the نقطة البيع regression was logged as its own line — a fix that took the whole app down is worth a line of its own, not a footnote on the screen that caused it. It moved 46 → 47 earlier when the deferred dashboard
date filter was logged as task 21, the final item of the pass. The 16/46 baseline below was recomputed honestly the same day, when
PHASE 3 was reorganised into a top-to-bottom screen pass. It reads LOWER than the
39% before it, and that is correct, not a regression:
- **الطلبات الإلكترونية** and **حسابات الشحن** were ticked for their *path* work (which is done and
  is still written up inside each item). Both then received NEW screen requirements — the
  customer-record link for LTV on delivery, and batched courier settlement — so neither screen is
  finished and neither can honestly stay `[x]`.
- **الجرد** was added as its own screen (it exists and works; it has no route and no sidebar entry).
- **Financial reports (§3.12)** folded into الشركاء والمالية, where it actually lives, instead of
  standing as a separate line. Net effect on the denominator: 20 screen items before, 20 after.

PHASE 1 is **complete**: all 6 stock paths closed in BOTH directions, no direct stock mutation
anywhere in `src/`, and no fake seeds. The app starts empty and every number comes from the ledger.
**The type-file collapse is CLOSED too** — one type file, seven ghost fields deleted, and the
accessors that replaced them (`productPrice` / `productWholesalePrice` / `productMinLevel`, plus
`qtyOf` / `costOf` for anything derived).
**Agreed order from here:** the PHASE 3 pass, screen by screen, top to bottom, starting at
**1. نظرة عامة / Dashboard**. The rest of PHASE 2 (sync) stays deferred until multi-device is real.
typecheck baseline **11** (60 → 59 at #4 → 57 at #5 → 56 at barcode → 50 at seed deletion →
43 at the stock cards → 42 at the shipping matrix → 36 at the retail_price kill →
24 at the type-file collapse → **11 at the شريك/مساهم merge**, which deleted a dead screen, a dead
route and four dead server functions along with their errors). Ratchet down, never up.
(Denominator is live — verify with `grep -c "^- \[" docs/NEXUSCORE_PLAN.md` and done with
`grep -c "^- \[x\]"`.)

---

## PHASE 0 — Foundation (DONE — do not redo)
- [x] SQLite ledger schema + Supabase schema (`ledger_events`, `ledger_lines`, ref tables)
- [x] Atomic `ledger_append` (Rust, one `sqlx::Transaction`) + smoke test green
- [x] `reference_write` path separation (whitelist, ledger tables excluded)
- [x] Money as integer piastres, conversion only in `driver.ts`
- [x] Append-only enforced (triggers + RLS SELECT/INSERT-only + no `sql:allow-execute`)
- [x] `crate-type = ["rlib"]`, build cache on `D:/nexuscore-target`
- [x] `npm run typecheck` script, baseline **42** (60 → 59 at #4, → 57 at #5, → 56 at barcode,
      → 50 at seed deletion, → 43 at the stock cards, → 42 at the shipping matrix).
      Ratchet down, never up.
- [x] `docs/LEDGER_SCHEMA.md` (schema + store_id reconciliation + snapshot rule)

## PHASE 1 — The 6 stock paths (each writes ONE event; §1.3 scenario each)
- [x] 1. POS sale → `sale` event (stock−, wallet+, revenue+, cogs+, customer_ltv+)
- [x] 2. Purchases / توريد → `purchase` (stock+, wallet− or payable_supplier+, or both when
      part-paid) **and `supplier_payment` (wallet−, payable_supplier−) for the other
      direction.** **Sets real `cost_price` that POS snapshots as `unit_cost`.**
      Supplier debt on screen = SUM(payable_supplier), no stored `totalDebt`.
      🚪 show receive→sell loop before #3
- [x] 3. Wholesale invoice → one `sale` event (`ref_type=wholesale_invoice`): stock−, cogs+,
      wallet+ and/or **`receivable_client`+**, revenue+ (subject `wholesale`), expense+ (delivery)
      — **and `client_payment` (wallet+, receivable_client−) for the other direction.**
      New account `receivable_client` + new kind `client_payment` added to the CHECK lists.
      Client debt on screen = SUM(receivable_client), no stored `totalDebt`. Shipping folded into
      the same event instead of a separate financial-store total. 🚪 gate before #4
- [x] 4. E-commerce order → `order_placed` (stock− reserve, qty AND value) then `order_delivered`
      (cogs+, wallet+ deposit, receivable_courier+ COD, revenue+, customer_ltv+) then
      **`courier_settlement`** (wallet+, receivable_courier−, expense+) for the COD's other
      direction. `order_returned_pending` writes **zero lines on purpose** — stock does not move
      on a courier's word. Killed the "65% of retail" COGS guess: cost is snapshotted from the
      ledger at placement onto `EcommerceOrderItem.unitCost`. 🚪 gate before #5
- [x] 5. Return → `return_confirmed` = **6 lines**: stock+, **cogs−**, wallet−, revenue−,
      expense+ (shipping), **customer_ltv−** (the line the smoke test caught missing — do not
      omit it). *Corrected from "5 lines" at path #4: this line previously omitted `cogs−`, which
      contradicts the six-line checklist in `LEDGER_SCHEMA.md`. Six is right — returned goods
      re-enter stock at cost, so leaving the cost booked as a cost of goods SOLD double-counts it
      and understates profit. The builder + scenario already write and assert six.*
      Done at #5: the **returns/exchange screen** (§3.14) now searches REAL delivered orders (it
      searched `manualOrders`, which nothing ever wrote — no order could ever be found), and the
      **confirm-by-customer-name** step (§3.9) in Order Management turns `order_returned_pending`
      into `return_confirmed`. Also closed `order_cancelled` (stock+) — the third reverse
      direction on the online path, without which cancelling a pending order swallowed its
      reserved stock forever.
- [x] 6. Exchange / stock adjustment (جرد) → ONE `stock_adjustment` event per audit, two lines
      per discrepancy: counted fewer → stock− / expense+ (shrinkage), counted more → stock+ /
      expense− . *Exchange itself was wired at #5.* `updateProductStock` — the last direct stock
      mutation in the codebase — is **deleted**. Shrinkage is valued at the ledger's weighted
      average; the old code booked a flat `discrepancy * 10` for every product in the shop.
      🚪 all 6 stock paths closed — gate before Phase 2 / Phase 3.
      **Screen pass (later):** the جرد dialog now shows recorded / actual / difference in words
      (عجز · زيادة · مطابق · لم تُجرد) plus the difference's value in ج.م, and commits only after
      a review step. Fixed there: a blank count box was read as "counted zero", so confirming an
      audit wrote off every product the auditor had not reached.
- [x] Delete all fake seeds — done: `seedProducts` (10 products) in `ProductsPage` and
      `FALLBACK_PRODUCTS` (5) in `ecommerce-orders`, plus both seeding effects and the
      `sanitizeProduct` helper that fed them. The app now starts genuinely empty. **Note:** the
      `/` dashboard fakes (KpiCards / ProfitChart / PartnershipCard / TransactionsTable) are
      display-only constants — they write to no store — so they belong to the PHASE 3 Dashboard
      rebuild item, not here.

## PHASE 2 — Sync layer completion
- [x] **Collapse the two type files into one source — CLOSED 2026-08-17.** `src/types/index.ts` is
      now the only type file; `src/lib/types.ts` is **deleted**. This was the
      multiple-sources-of-truth bug we delete everywhere else, living in the type layer.

      **It shipped three screen-blocking bugs before it was closed.** `Product` carried BOTH
      spellings of several fields, most declared as REQUIRED, while writers only ever wrote one
      spelling. Readers that picked the unwritten name got `undefined` and the compiler said
      nothing — the type was a lie in both directions.

      **Seven ghost fields found and deleted, in two passes:**
      | Field | Direction | What it actually broke |
      |---|---|---|
      | `retail_price` | declared, never written | NaN across the whole online order form |
      | `stock_qty` | declared, never written | exchange picker permanently EMPTY |
      | `cost_price` | declared, never written | wholesale COGS silently **ZERO** → profit overstated |
      | `wholesale_price` | declared, never written | every جملة price fell back to retail |
      | `reorder_point` | declared, never written | low-stock alert stuck at zero; 3 dead `??` chains |
      | `type` | declared, never written OR read | pure dead weight every writer had to be wrong about |
      | `costPrice` | **written, never declared** | the mirror case — real data the type denied |

      **How each was resolved — all DELETED, never made optional**, so the compiler finds the
      readers rather than a hand-test months later:
      - retail price    → `productPrice(p)`          (`src/lib/product.ts`)
      - wholesale price → `productWholesalePrice(p)`  — falls back to retail, never to 0
      - reorder level   → `productMinLevel(p)`
      - stock           → `qtyOf(p.id)`  from the ledger (§1.1)
      - cost            → `costOf(p.id)` from the ledger (§1.1)
      - No `productStock()` or `productCost()` accessor exists, deliberately: stock and cost are
        not product fields, and an accessor would have re-legitimised the stored columns.
      - `costPrice` was removed rather than declared. It held real data, but a stored cost beside
        a ledger-derived one is two answers to one question. The product form's second cost box
        went with it — the opening balance's "تكلفة الوحدة" already writes the real thing as an
        event.
      - **`getCostOfGoodsSold()` deleted outright**, not repaired: it read the `cost_price` ghost
        for wholesale (always 0) AND guessed POS cost at `revenue × 0.7` — the hardcoded rule
        `001_ledger.sql` says the ledger's `unit_cost` exists to replace. COGS is now
        `useBalances("cogs").total`, threaded into `getNetProfit(persona, cogs)` so it cannot
        silently fall back to a guess again. A failed read shows an Arabic warning instead of
        rendering cost as 0.
      - 22 readers re-pointed across 12 files over the two passes.

      **Proof:** `grep -rn "\.cost_price|\.wholesale_price|\.costPrice|\.retail_price|\.stock_qty|\.reorder_point" src/`
      returns only comments and the bulk importer's own CSV column type (spreadsheet headers, not
      Product fields). `grep -rn 'from "@/lib/types"' src/` returns nothing.
      **typecheck 42 → 36 → 24.**

      The one reader the compiler could NOT find: `StockSummaryCards` re-declared `reorder_point?`
      in its own local props interface. Deleting a field from the shared type does not reach a
      local structural copy of it — worth remembering next time.
- [ ] Wire pull: `SyncService.fetchChanges` caller (on boot + on `online` + every 5 min)
- [ ] Fix echo guard (compare `device_id`, not the missing `_client_id`)
- [ ] Add `device_id` + `sync_status` + tombstones (`deleted_at`) across synced rows
      ← `products.deleted_at` is the first one, added with product archiving (type + `schema.sql`
      + `ALTER … ADD COLUMN IF NOT EXISTS`); the remaining tables and the two other columns are
      still open
- [ ] Sidebar status = real (online/offline + pending count + last-sync + "sync now" button)
- [ ] Supabase: `store_id` on every synced table + `store_members` + RLS scoped by it
- [ ] Close the `USING(true)` hole on all tables
- [ ] Multi-device test: two devices, one offline sells + one online sells → stock correct on both

## PHASE 3 — Screen-by-screen pass (TOP TO BOTTOM, sidebar order = the 19 reference screenshots)

**Work these in the order listed. Do not jump.** The order is the app's own sidebar, which is the
order the 19 reference screenshots were taken in. One extra screen — الجرد — is inserted after
المخازن because it exists, works, and simply is not reachable yet.

Each item reads: **✔ closed this session** (kept so the pass does not re-litigate finished work)
then **← open** (what the pass must actually do there). A screen is ticked only when its open
list is empty.

- [x] **1. نظرة عامة / Dashboard** (§3.1) — **DONE 2026-08-18.**
      ✔ **first, a correction to this plan:** KpiCards / ProfitChart / PartnershipCard /
      TransactionsTable were never the rendered dashboard. They live in `src/routes/index.tsx`,
      a TanStack route — and the TanStack router is dead code (`src/router.tsx` has zero
      importers; the app boots `App.tsx` on react-router). The screen the owner actually sees is
      `ExecutiveDashboard` via `src/routes/dashboard.tsx`, and THAT is what was rebuilt. All four
      fake components are now **deleted** and the dead route renders the real dashboard.
      ✔ every figure is a ledger `SUM()` for the selected window. Six clickable cards: صافي الربح
      (revenue − cogs − expense), عدد العمليات, متوسط قيمة العملية, أكتر منتج خرج, مرتجعات مؤكدة,
      منتجات منخفضة أو نافدة. Clicking opens the screen the number came from
      (partners / orders / orders / products / returns / inventory — every target verified against
      `App.tsx`).
      ✔ period filter اليوم / آخر ٧ أيام / آخر ٣٠ يوم; the trend is one ledger aggregate per day,
      the same query the cards use, so line and cards cannot disagree.
      ✔ deleted with it: a hardcoded "+12.5%" growth badge, `orders.length`, the `transactions`
      store reads, and a panel listing three integrations as "متصل ومفعل" that nothing had
      connected. The Pro/Free banner stays — a subscription setting is a real fact, not a
      measurement.
      ✔ the arithmetic is a pure module (`src/lib/dashboard.ts`) so it is testable; a failed read
      renders an Arabic error, never zeros. (`scripts/check_dashboard.mjs`, 7 tests)
      ← open: nothing for now. UX spacing/colour polish rides along with the theming pass (16).
      ⏳ **DEFERRED TO THE END OF THE PASS — extended date filter (شهر / سنة)** on top of
      اليوم / آخر ٧ أيام / آخر ٣٠ يوم. Deliberately NOT built now, on the owner's reasoning:
      نظرة عامة reads from every other screen, so it must be the LAST thing touched. Building a
      bigger filter now means revisiting it every time a later screen changes its numbers. This is
      **the final task of the pass — run it after screen 20 (النسخ الاحتياطي والاستعادة)**, and
      the pass is not complete until it is done. See the tail item below.
- [x] **2. المنتجات / Products** (§3.2) — **DONE 2026-08-18.**
      ✔ stock derived from the ledger; the form's dead "الكمية الحالية" box replaced by an
      **opening balance** written as ONE `stock_adjustment` (`ref_type=opening_balance`), and on
      edit it is a read-only ledger figure so it cannot double-count.
      ✔ unique SKU/barcode with an Arabic message naming the clashing product; Enter in the
      barcode field moves focus instead of submitting.
      ✔ auto status from the shared `stockStatusOf`, so a card's count equals the rows clicking
      it produces.
      ✔ **Excel import records real stock** — it was writing the dead `quantity` field, so an
      imported shop opened at ZERO. Now ONE `opening_balance` event per row with a quantity,
      through the same `appendOpeningBalance` the form uses; unit cost from the sheet's
      "سعر الشراء"; a row whose barcode/SKU already exists updates details and writes no second
      opening balance. `addProduct` no longer accepts `quantity` at all.
      (`scripts/check_product_import.mjs`, 5 tests)
      ✔ **delete asks first, and asks the right question** — the trash icon deleted instantly. It
      now asks the LEDGER first: any `stock`/`cogs` line → **archive** (`deleted_at` tombstone,
      syncs, record kept so its events still resolve); none → real delete. `removalMode` counts
      ROWS, not balances, because received-then-sold-out sums to zero and still has history.
      Shared `ProductRemovalDialog` serves both delete buttons (here and المخازن);
      `removeProduct` now tells sync, which it never did. (`scripts/check_product_removal.mjs`, 4)
      ✔ **archived products can be seen and restored** — النشطة/المؤرشفة toggle with counts, one
      **استرجاع** action clearing the tombstone through `updateProduct` (as `null`, not
      `undefined`, or the next pull re-archives it).
      ✔ **quick توريد from the row** (2026-08-18) — a `PackageCheck` action on every row opens a
      small dialog (كمية + تكلفة الوحدة + المحفظة اللي دفعت) and appends ONE `purchase` event
      through `buildPurchaseLines`, the SAME builder شاشة المشتريات uses. No second receive path,
      and no navigation: the row's quantity moves in place. Deliberately cash-only — a credit
      receipt needs a supplier invoice document (§3.5), and booking `payable_supplier` here would
      create debt with no invoice behind it; the dialog says so in Arabic.
      (`scripts/check_quick_restock.mjs`, 9 tests)
      ✔ **gap closed same day — the quick receipt names its SUPPLIER.** As first shipped it asked
      quantity/cost/wallet only, so a fast receive never reached المشتريات والموردين: that
      supplier's totals and history silently missed it. The dialog now requires a supplier —
      dropdown of registered ones plus **+ مورد جديد** registered inline (two fields) — and writes
      the matching paid invoice document through the same `addPurchaseInvoice` the invoice screen
      uses, after the ledger event succeeds. The reducer behind the purchases screen was extracted
      to `src/lib/supplierTotals.ts` so a quick receipt and a typed invoice are counted by ONE
      function.
      **The supplier belongs to the EVENT, never to the product** (owner's point: the same item
      comes from المرادي this week and someone else next). No default-supplier field was added to
      `Product` — see the flag under screen 6 about the legacy free-text `Product.supplier` that
      predates this.
      ✔ **search + filters** — the private `toLowerCase` filter is replaced by the shared
      `searchProducts` matcher (name/SKU/barcode with Arabic-Indic normalisation, so "منتج-١٢٣"
      finds "123"), plus a **category** dropdown built from the categories actually in use. Status
      filtering stays the summary cards, so the two can never contradict each other.
      ← open: nothing.
- [x] **3. نقاط البيع / POS** (§3.3) — **DONE 2026-08-18.**
      ✔ "الخزينة" wired — the picker's balance is SUM(wallet) for the selected wallet and moves
      the moment a sale lands; each wallet independent.
      ✔ barcode: auto-focus + refocus-on-blur, Enter preventDefault, scan adds to CART only,
      duplicate scan increments, Arabic warnings for unknown barcode and out-of-stock.
      ✔ removing a cart line asks first (stepping the quantity to zero asks the same question).
      ✔ manual pick is the shared `ProductSearch` — the damaged-barcode fallback used to be a
      dropdown of the whole catalogue; archived products are excluded for free.
      ✔ a sale writes `customer_ltv` for the SELECTED customer; a walk-in writes none.
      ✔ **look/UX polish (2026-08-18)** — the screen was one long column: scan lane, manual pick,
      cart, then payment, so the cashier scrolled past the basket to read the total. It is now two
      columns on wide screens: the scan lane + manual pick on one side, and the **basket pinned
      (`sticky`) beside them** with the running total in its header — always in view, never
      scrolled past. Quantity controls went from 28px to 40px targets with `tabular-nums` counts
      (pressed on a touch screen with a customer waiting), the grand total is now the loudest
      thing above a taller "إتمام البيع", and the duplicated in-card title was dropped (the route
      already prints "نقطة البيع" above it). **Layout only** — same handlers, same single
      `appendEvent`, proven by grep: one append call, `buildSaleLines` intact, and all seven
      handlers plus barcode auto-focus, Enter `preventDefault`, `ProductSearch`, the cart-delete
      confirm and the customer→LTV wiring all still present.
      ✔ **الخزينة hint** — the one-liner existed; it now also explains the number beside the name
      ("الرقم جنب الاسم هو رصيد الحساب دلوقتي، وبيزيد بقيمة البيعة أول ما تتسجّل — وده اللي
      بتراجعيه على الدرج أو على الموبايل آخر اليوم"), which is the §3.3 ask and points at the
      manual reconciliation §3.6a exists for.
      ← open: nothing. §3.3's "if there is only one cashbox, hide the complexity" does not apply —
      the four wallets are a fixed set (§3.6a), not a per-shop list.
- [x] **4. المخازن / Warehouses** (§3.4) — **DONE 2026-08-18.**
      ✔ real totals + low-stock highlight from ONE shared `StockSummaryCards`, all four figures
      from the ledger; clicking a card filters the table and the PDF export follows the filter;
      quantity, status and alerts all read `qtyOf`; the low-stock alert is a one-line banner with
      "اعرض النافد" / "اعرض المنخفض" instead of a list that pushed the table off screen.
      ✔ its delete button goes through the same archive/delete dialog as المنتجات.
      ✔ **sort by quantity (2026-08-18)** — the المخزون header toggles نزولي → تصاعدي → بلا ترتيب.
      It sorts on the same `qtyOf` the row prints, so the order can never disagree with the
      numbers beside it, and it is a view concern only: no number is touched.
      ✔ **bulk receive (2026-08-18)** — tick rows (with a tick-all that follows the active filter,
      so a filtered-away row cannot be smuggled into the receipt) → "توريد N صنف" opens **the same
      dialog المنتجات uses for one row**. It always took a list, because `buildPurchaseLines`
      takes a list: many products become **ONE** `purchase` event and ONE supplier invoice, never
      a loop of events any of which could half-fail. Rows left blank are simply not received.
      ✔ **search over the receive list (2026-08-18)** — the table now has a search field using the
      shared `searchProducts` matcher (name/SKU/barcode, Arabic-Indic digits normalised), so
      ticking products for a bulk receive no longer means scanning a long list. **Ticks survive
      searching and filtering:** the receipt is built from every ticked product, not just the ones
      the current query shows, because the owner ticks three, searches for a fourth, and must not
      lose the first three. Nothing is hidden by that — the dialog lists every ticked product by
      name before anything is written, the toolbar shows the count, and "إلغاء التحديد" clears it.
      The tick-all box speaks only for the rows it can see.
      ✔ **quick/bulk receive is CASH-ONLY by design** — confirmed intentional, now written into
      brief §3.5 so it is not re-discovered as a gap: credit needs a due date and terms, which is
      the full فاتورة مشتريات, and that path already exists.
      ✔ **confirmed, not rebuilt:** the four summary cards are the same `StockSummaryCards`
      component as المنتجات fed by the same ledger `qtyOf`; clicking one sets the table filter
      through the shared `matchesStockFilter`, so a card's count equals the rows it produces; and
      the PDF export takes `rows: visibleProducts` — the filtered, sorted view, not the whole
      catalogue.
      ← open: nothing.
- [x] **5. الجرد / Stock audit** (§3.21 + PLAN #6) — **DONE 2026-08-18.**
      ✔ the screen itself: counted vs recorded, the difference in words (عجز · زيادة · مطابق ·
      لم تُجرد) and in ج.م, a review step, then ONE `stock_adjustment` for the whole audit;
      shrinkage valued at the ledger's weighted average; a blank count box is no longer read as
      "counted zero" (confirming an audit used to write off every product the auditor had not
      reached).
      ✔ **the commit step was there but unreachable, fixed 2026-08-18** — hand-testing reported
      "counts show a live diff but nothing can be recorded". The investigation found the whole
      flow already in the component and correctly wired (بدء المراجعة → counts → مراجعة النتيجة →
      review summary → تأكيد وتسجيل الجرد → ONE `appendEvent`). What was broken was that the
      footer holding both buttons sat AFTER a tall body inside a `max-h-[80vh] overflow-y-auto`
      dialog: on a laptop it fell below the fold, and the wheel scrolled the inner product table
      (its own `max-h-96` scroller) instead of the dialog — so the auditor reached the end of the
      list and saw no way to commit. The dialog is now a flex column whose MIDDLE scrolls, with
      the review summary and the footer pinned outside it, always on screen. Added: a reason
      beside the disabled button ("اكتب الكمية الفعلية لمنتج واحد على الأقل") and a live
      "اتجرد N من M" counter.
      ✔ **second defect found while reading, fixed:** the stock-LOG loop walked every row, and an
      uncounted row's blank box parses to 0, so a product nobody counted was logged as
      "newQty 0". The ledger never had this bug (it reads the counted rows), but the
      human-readable trail claimed corrections that never happened. It now walks `countedRows`.
      ✔ the "blank ≠ zero" rule moved out of the screen into `isCounted` in `ledger/audit.ts`,
      beside the builder it feeds, so it is pinned by tests rather than living in one component.
      ✔ **reachable (2026-08-18)** — wiring only, exactly as scoped: `src/routes/stock-audit.tsx`
      renders the existing `StockAuditPage`, `App.tsx` declares `path="stock-audit"`, and the
      sidebar carries **الجرد** (`ClipboardCheck`) directly after المخازن, owner-only, on all three
      business profiles — the same shape as every other item. The screen's own logic and UI were
      not touched: it went from **zero importers** to one, and nothing inside it changed.
      ← open: nothing.
- [x] **6. المشتريات والموردين / Purchases & Suppliers** (§3.5) — **DONE 2026-08-18** (the remaining item is an explicit (opt)).
      ✔ real totals from invoices: debt = SUM(payable_supplier), purchased/paid summed from the
      invoice documents, PDF uses the same numbers; "تسديد" writes `supplier_payment`, so supplier
      debt moves in both directions.
      ✔ **`Product.supplier` DELETED (2026-08-18)** — grep first: exactly three sites, all in the
      product form (`emptyForm`, the edit prefill, the submit), and **nothing read it for money**.
      Deleted from the type and the form, not renamed, so the compiler makes the
      "default supplier on a product" shape unsayable. The Supabase column is left in place with a
      comment (dropping it mid-rollout would break older clients); nothing writes it now.
      ✔ **WhatsApp contact button (2026-08-18)** — the supplier row's contact icon opened `tel:`.
      It now opens `https://wa.me/<international>` through `toWhatsAppNumber`
      (`src/lib/phone.ts`): Arabic-Indic digits normalised, separators dropped, `+`/`00` stripped,
      and a leading trunk `0` replaced by `20` — so `01012345678` → `201012345678`. The link is
      handed to the OS via the shell plugin, **not** `window.open`, which the WebView blocks (the
      PDF lesson). A number that cannot be dialled shows "—" instead of a broken link; the `tel:`
      call button stays beside it. (`scripts/check_phone.mjs`, 7 tests)
      ✔ **"which wallet paid" — ALREADY DONE, confirmed not rebuilt.** I listed it as open when
      reorganising the docs; the code already had it. The invoice form asks
      "الخزينة اللي هيتدفع منها" whenever `paidAmount > 0` (a fully-credit receipt touches no
      wallet, so it is not asked), and the supplier-payment dialog has its own picker
      (`paymentWallet`). Both feed the same builders — `buildPurchaseLines` / 
      `buildSupplierPaymentLines` — so the money leaves the wallet the owner named.
      ✔ **edit a registered supplier (2026-08-18)** — a phone number changes and there was no way
      to update it. A pencil on the directory row opens the SAME registration form, pre-filled
      (اسم الشركة / جهة الاتصال / الهاتف / البريد), so a field added at registration is editable
      the day it is added; "إضافة مورد" opens the same form blank. Saving an edit calls
      `updateSupplier` — **reference data, LWW (`updatedAt` stamped), no ledger event**, because
      nothing moved: proven by grep, the screen still has exactly two appends (`purchase`,
      `supplier_payment`). Past invoices are untouched — they point at the supplier **by id**, so
      the history keeps its own recorded `supplierName` while the directory shows the current
      details. The WhatsApp button reads `supplier.phone` live at render, so a changed number
      dials correctly on the next click with no cache to bust.
      ← open: (opt) filter invoices by status/supplier/date.
      ← note: suppliers are not in `schema.sql` (it has products/orders/transactions/expenses), so
      `updateSupplier` does not queue a sync push yet. That belongs with the PHASE 2 sync work,
      not here — flagged rather than half-built.
- [x] **7. الشركاء والمالية / Partners & Finance** (§3.6, §3.6a, §3.12) — **DONE 2026-08-18** (7.1 · 7.1b · 7.2a · 7.2b · 7.3 · 7.4). The remaining `← open` lines are a standing constraint (manual wallets) and a perf ceiling, not unfinished work.
      ✔ every wallet card and the total are SUM(wallet); transfers write `wallet_transfer`; the
      owner can enter a per-wallet opening balance.
      ← open: **the wallets are MANUAL ledgers (§3.6a)** — الخزينة, فودافون كاش and انستا باي are
      reconciled by hand against the real till and the real phone/bank balances, which is how the
      owner catches discrepancies and theft. **Never wire them to Paymob / Vodafone Cash /
      InstaPay / a bank feed / an auto-import.** Any future task proposing it is wrong by
      definition; §3.15 gateway work stops at recording our own wallet event.
      **SPLIT INTO SUB-PARTS (2026-08-18) — this screen is four features, not one.**
      ✔ **7.1 — money that leaves actually leaves (DONE 2026-08-18).** Found while surveying: an
      expense or a salary wrote a DOCUMENT and no ledger event, so the till never moved. The owner
      paid 8,000 rent, it appeared in a list, and `SUM(wallet)` still showed the rent money.
      New `buildExpenseLines` (`src/lib/ledger/expenses.ts`) writes the two lines an expense IS —
      `expense +` by category and `wallet −` from the account that paid — and both handlers append
      ONE event before recording the document (`expense` / `payroll`, same builder, different
      kind). Both dialogs gained the wallet picker (§3.6a manual wallets; nothing imported).
      The screen's headline numbers are now three ledger SUMs: sales = SUM(revenue),
      cogs = SUM(cogs), opEx = SUM(expense), profit = the subtraction. `getTotalSales()` (which
      summed the `transactions` store a POS sale no longer writes, plus wholesale documents, plus
      a financial-store array) no longer feeds this screen.
      (`scripts/check_expense_lines.mjs`, 4 tests)
      ✔ **7.1b — the opening-balance screen was UNREACHABLE (fixed 2026-08-18).** The owner asked
      where she enters what is really in الخزينة / فودافون كاش / انستا باي / البنك on day one. The
      feature existed and was correct — `CapitalEquityPage`, one `wallet +` event per wallet
      through `buildWalletOpeningLines`, no counterpart, negatives allowed — and had **ZERO
      importers**, exactly like `StockAuditPage` did. Built, correct, and impossible to open.
      It is now the third tab of الشركاء والمالية, **الأرصدة الافتتاحية والتحويلات** (§3.6 calls
      this screen "الشركاء والمالية / رأس المال"), which also surfaces the wallet transfers and
      capital view that were unreachable with it. On top of that, the المالية العامة tab shows a
      one-time amber prompt — "ابدئي بتسجيل الأرصدة الافتتاحية … من غير كده كل الأرقام هنا محسوبة
      من صفر، مش من الحقيقة" — with a button that switches straight to the tab; it disappears once
      any wallet is non-zero.
      ✔ **7.2a — شريك and مساهم merged into ONE list (DONE 2026-08-18).** The investigation found
      **three** implementations of the same three fields: `useBusinessStore.partners`,
      `useFinancialStore.shareholders`, and a server-backed `ShareholdersPage` behind a dead
      TanStack route. Same shape, different label. Worse, each list validated its own ≤100%, so a
      shop could hand out **200%**.
      Now: one `Partner` with a required `kind` — **شريك** (works here; may draw; may link a user
      login) or **مساهم** (capital only; no draws, no access implied). Profit share is the same
      arithmetic for both. **Draws are an ADVANCE**: distribution = (نسبة × صافي الربح) − مسحوبات
      الفترة, shown as gross / draws / net, and allowed to go negative rather than floored at zero.
      Draws read `SUM(owner_budget)` per partner — zero until 7.3 writes `owner_draw`.
      **Deleted:** `ShareholdersPage.tsx`, `routes/shareholders.tsx`, the store's `shareholders`
      slice + its five actions, the four shareholder server functions and their sync blocks, BOTH
      duplicate `Shareholder` interfaces (TypeScript was *merging* them — a landmine, not an
      error), and the stored `lifetimeDividendsPaid`. **typecheck fell 24 → 11**, all of it dead
      weight. (`scripts/check_partners.mjs`, 8 tests)
      ✔ **7.2b — partner delete/archive (DONE 2026-08-18).** The project's oldest complaint —
      "can't delete a partner, it stays inactive forever" — plus what the hand-test found behind
      it: an "inactive" partner's capital **kept counting** in إجمالي رأس المال, and it was unclear
      whether their % still ate into the 100%. The trash icon just flipped `status`.
      Now it asks the ledger first, same rule as the product screen: **any** `owner_budget` line
      or **any** past distribution naming them → **أرشفة** (`deleted_at` tombstone); none → **مسح
      نهائي**. `partnerRemovalMode` counts ROWS, not sums — draws that net to zero are still
      history. Either way a confirm dialog says which path it is taking and why.
      An archived person leaves the active list, **frees their percentage immediately**, and drops
      out of رأس المال, متوسط المساهمة and every future distribution — while their record and all
      their past draws/distributions stay exactly as recorded. Badge reads
      **«مؤرشف — له سجل سابق»**, a "المؤرشفين (N)" toggle shows them, and **استرجاع** brings them
      back (`deleted_at: null`, never `undefined`).
      No ledger write on this path at all — archiving is reference data (proven by grep).
      (`scripts/check_partners.mjs`, 14 tests)
      ✔ **7.3 — Owner Budget (DONE 2026-08-18).** A **configurable** ceiling, not a hardcoded
      monthly cycle: the owner sets المبلغ المحدد and picks the period — **شهري** (rolls over with
      the calendar, derived from the DATE so it is right after the app has been closed for weeks)
      or **بدون مدة** (fixed ceiling until she presses «تصفير الميزانية», which starts a new period
      from that moment and leaves past draws in the ledger, merely outside the new window).
      Spent is `SUM(owner_budget)` for the period — **nothing accumulated in a store** — remaining
      is the subtraction, with a progress bar, amber at **80%** («على وشك الانتهاء») and red at
      **100%** («انتهت الميزانية»). An over-limit draw **warns and still records**: refusing it
      would only mean the cash left without the ledger knowing, and the overage shows as a
      NEGATIVE remaining rather than a floor at zero.
      Every draw is ONE `owner_draw` event through `buildOwnerDrawLines` (owner_budget +, wallet −)
      with the same wallet picker the rest of the app uses.
      **Ambiguity resolved explicitly, not silently:** the budget measures the OWNER's own draws
      (`subjectId = "owner"`). A working شريك's draw is the same event kind and builder keyed to
      THEIR id, so it feeds 7.2's advance rule and never eats her ceiling. The draw dialog asks
      "مين اللي سحب" and says which of the two applies in one line.
      (`scripts/check_owner_budget.mjs`, 12 tests)
      ✔ **7.3 additions (2026-08-18):** the limit is **editable** after setup — "تعديل" now
      prefills the form, and saving keeps `startedAt` untouched, so raising or lowering the ceiling
      re-judges the SAME spending instead of silently restarting the period (a real trap: the first
      version stamped `Date.now()` on every save, which would have wiped an open period's running
      total). Past draws are never affected either way; this is reference data, no event.
      ✔ **personal categories inside the SAME budget** — an optional تصنيف (free text with
      suggestions: أكل, مشاوير, فواتير البيت…) on the owner's own draws. It rides in the SUBJECT
      (`owner#أكل`), not the payload, because payload is descriptive and may not be summed — so the
      per-category split and the ceiling are literally the same balance rows, grouped differently
      and guaranteed to agree. Still ONE ceiling, ONE total, ONE event kind: `ownerSpent` sums
      every `owner…` subject and `drawBreakdown` groups them, biggest first, with "بلا تصنيف" for
      uncategorised. A partner's advance keeps a plain partner id and never appears as one of her
      categories.
      ✔ **7.4 — financial reports (DONE 2026-08-18).** §3.12, and the screen where every fix this
      session becomes one readable report. New tab **التقارير المالية** inside الشركاء والمالية —
      a tab, not a sidebar entry, because it reads the same accounts the cards above it do and the
      owner compares the two.
      Period filter **يوم / أسبوع / شهر / كوارتر / سنة / نطاق مخصّص** (the week starts Saturday).
      Every window is DERIVED from the date on each render, never stored, so a screen left open
      past midnight reports the period it is actually in — same rule as 7.3's monthly budget.
      Headline numbers are six ledger SUMs for the window: المبيعات (`SUM(revenue)`), المشتريات,
      المرتجعات, المصروفات والرواتب, عمولات ومصاريف الشحن, صافي الربح — plus المبيعات حسب القناة
      from the revenue subjects (pos / ecommerce / wholesale). P&L table broken out
      يومي/شهري/ربع سنوي/سنوي, auto-picked from the window length and overridable, with a total
      row and a per-row profit bar. PDF through the existing `printTableAsPdf` (hidden iframe, no
      popup, direct download).
      **The brief's formula could not be implemented literally.** «revenue − (COGS + expenses +
      returns + shipping)» double-counts twice over: a `return_confirmed` already writes
      `revenue −` and `cogs −`, and the courier return fee is already an `expense` line. Profit is
      `SUM(revenue) − SUM(cogs) − SUM(expense)`; returns and shipping are SHOWN (the owner asked
      to see them) and labelled as already deducted — shipping is SPLIT OUT of the expense total,
      never added to it. المشتريات is reported and explicitly excluded from the P&L: cash became
      inventory, and only what was sold is a cost.
      Needed one driver change: `BalanceQuery.kind`, so a figure that is a SUBSET of an account
      can be asked for — purchases are the `stock +` lines a `purchase` wrote, returns the
      `revenue −` lines a `return_confirmed` wrote. Still a SUM over `ledger_lines`.
      (`scripts/check_financial_report.mjs`, 14 tests, including the §1.3 four-event scenario)
      ✔ **7.4a — the two things 7.1 flagged, answered.**
      **Depreciation: it belongs in a different report, and does NOT become a ledger line.** The
      `expense +`-with-no-wallet shape was considered and rejected: the figure is a monthly
      accrual, so it would need a posting job whose second run would permanently overstate cost in
      an append-only ledger. It is non-cash — no wallet moves — so it stays reference data and is
      reported as a MEMO beside the P&L, with «صافي الربح بعد الإهلاك» stated separately. The
      الأصول tab's claim that it «يتم إضافة … إلى مصروفات التشغيل بشكل تلقائي» was false and is
      now the opposite statement.
      **Shipping profit: deleted, because there is no such number.** Per the schema's
      who-bears-the-fee table a delivery fee arrives inside the COD and leaves as a debt to the
      courier — neither revenue nor cost — and a RETURN is the shop's only shipping expense. The
      card is now **تكلفة الشحن** = `SUM(expense)` on `shipping` + `shipping_return`, a SLICE of
      the one expense total. `shippingRevenues` / `shippingExpenses` are **deleted** from the
      store (nothing had written them since the ledger conversion, so the card read 0 for ever),
      making a stale reader a compile error rather than a wrong number on screen.
      ✔ **7.4b — the last store-side income statement is gone.** Deleting the two counters
      surfaced the rest of it. **Deleted:** `getTotalSales`, `getOperatingExpenses`,
      `getNetProfit`, `getNetProfitForPeriod`, `getShippingRevenues`, `getShippingExpensesTotal`,
      `getShippingProfit`, `getEcommerceRevenue`, `getEcommerceCogs`, `recordShippingTransaction`,
      and the dead `computeFinancials` on the finance screen.
      The one that mattered: **`getNetProfitForPeriod` was computing every partner's share** from
      the `transactions` store (empty since the POS moved to the ledger) with POS cost guessed at
      `posSales × 0.7` — the exact hardcoded margin `unit_cost` exists to replace. توزيع الأرباح
      now reads the SAME `fetchPnl` the P&L does, states the period's net profit above the table,
      and the PDF prints the period the screen is showing instead of its own fixed 30 days.
      Also re-pointed: **تقرير نهاية الوردية** (the header export button) and two retail KPI cards
      that were showing `sales × 0.6` / `sales × 0.4` — an invented cash-vs-card split presented
      as takings; the channel is on the revenue line already.
      **typecheck fell 11 → 10.**
      ← open: the P&L fires one `fetchPnl` per table row (five SUMs each, capped at 60 rows). Fine
      on local SQLite; if it ever drags the fix is a `GROUP BY` bucket in the driver, never a
      cached total.
- [x] **8. الطلبات الإلكترونية / E-commerce orders** (§3.7) — **DONE 2026-08-19.**
      ✔ the NaN that blocked the whole screen is gone at its cause (`retail_price` was declared
      but never written; deleted, every reader re-pointed at `productPrice()`).
      ✔ product picker is the shared `ProductSearch`; form data survives navigation
      (`useDraftState`); saving reserves stock and writes `order_placed`.
      ✔ `assertFiniteLines` in `appendEvent` makes a non-finite number impossible to append from
      any screen. (`scripts/check_ledger_guard.mjs`, 9 tests)
      ✔ **8.1 — the order links to a real customer record (DONE 2026-08-19).** The order used to
      carry a customer NAME and a phone STRING, and four screens each re-derived the person with
      their own `(phone.trim() || name.trim())` compare. Three failures, all real: «01012345678»
      and «+20 101 234 5678» were two people, so a repeat customer got a SECOND record and their
      LTV split across two rows nothing would ever add back; «أحمد» vs «احمد» did the same; and an
      order for someone not registered yet resolved to nobody, so `order_delivered` wrote no
      `customer_ltv` line at all.
      **One key, one resolver** (`src/lib/customers.ts`, pure). The key is the PHONE — a name is
      spelled differently by the same person on different days, a number is not — normalised
      through the EXISTING `toWhatsAppNumber` (Arabic-Indic → Latin, separators dropped, Egyptian
      trunk `0` → `20`), so a number matches the same way it dials. No phone falls back to the
      normalised name; a `null` key matches NOTHING, including another `null`, because two blanks
      are not evidence of the same person.
      **Search-first at entry (the Odoo/SAP habit).** Typing ≥4 digits in the phone field searches
      the directory and shows the candidates with name, full number, last order date and lifetime
      spend — enough to tell two «أحمد»s apart. **Nothing is ever auto-selected, not even a single
      exact match**: an order carries money onto a record for the rest of that customer's life.
      Two or more candidates render as `ambiguous` rather than a coin toss — which also surfaces
      the duplicate records the old string matching already created. Changing the number un-links
      the picked customer, since that record belonged to the OLD number.
      **The order carries `customerId`.** `addOrder` calls `upsertCustomerFromOrder`, which now
      RETURNS the id, and stamps it on the document. Reference data — no ledger event; creating a
      customer moves no money. The `customer_ltv` line at delivery keys to that id, same builder
      as POS. Reading is `customerIdOf` / `orderBelongsTo`, which fall back to the phone key for
      orders placed BEFORE this — dropping them would have emptied every CRM timeline on the day
      this shipped.
      **Also fixed on the way:** قاعدة العملاء filtered a customer's history with
      `phone === c.phone || name === c.name`, so any two customers sharing a first name saw each
      other's orders. It matches on the id now. And `addOrder` was being passed an `orderNumber`
      it discards — one of the repo's typecheck errors, deleted.
      (`scripts/check_customers.mjs`, 16 tests, including the §1.3 scenario: two orders, one
      phone, different name spellings → ONE record, LTV 300 + 500 = 800 on one subject)
      ✔ **8.2 — قاعدة العملاء can finally be edited (DONE 2026-08-19).** The flag from 8.1, closed
      rather than left: `addCustomer`, `updateCustomer` and `removeCustomer` sat in the store with
      **ZERO callers** — the same built-and-unreachable shape 7.1b found in `CapitalEquityPage`
      and `StockAuditPage`. A customer could only be born from an order, and correcting their name
      meant placing another one.
      Now: **«عميل جديد»** and a per-row **تعديل** open ONE dialog (the supplier editor's shape —
      the same form serves both, so a field added at registration is editable the day it is
      added). Pure reference write, no ledger event: nothing here moves money, and every past
      order and `customer_ltv` line points at the customer by **id**, so they follow the new name
      automatically.
      **The overwrite-on-reorder the hand-test caught is fixed at its cause.** An existing
      customer's record no longer takes the order's name / phone / address — `upsertCustomerFromOrder`
      used to spread them over the row, so re-ordering silently undid an edit she had just made.
      An order now updates ACTIVITY only (`totalOrders`, المنتجات المفضلة, `lastOrderAt`).
      Identity is hers to set on this screen. A NEW customer still takes their details from the
      order, because that is the only source there is.
      **Duplicate guard on add AND edit.** The phone is the identity key (8.1), so two active rows
      sharing one would make every future match permanently `ambiguous` and hand `upsertTarget` a
      coin toss — the duplicate problem reintroduced by hand. `duplicateOf` refuses it and names
      who already holds the number; `excludeId` means correcting a customer's own spelling is not
      a collision with themselves. An ARCHIVED row does not block the number — she put it away
      deliberately.
      **Delete follows the products/partners rule exactly.** `customerRemovalMode` asks the ledger
      first: any `customer_ltv` line or any order → **أرشفة** (`deleted_at` tombstone); none →
      **مسح نهائي**. It counts ROWS, not sums — a customer who bought 300 and returned all of it
      sums to zero LTV and still has a full history (a test asserts exactly that). A confirm
      dialog says which path it is taking and why, and a failed ledger read never falls through to
      "delete it".
      An archived customer leaves the list, the phone search, the POS picker and `upsertTarget` —
      **a new order from that number opens a FRESH record rather than quietly reviving them**,
      the same way an archived partner's percentage is freed rather than reclaimed. Their orders
      and LTV stay exactly as recorded and still resolve through `customerIdOf`, badge
      **«مؤرشف — له سجل سابق»**, a "المؤرشفين (N)" toggle shows them, and **استرجاع** brings them
      back (`deleted_at: null`, never `undefined`).
      (`scripts/check_customers.mjs`, 21 tests)
      ← **flagged for §3.3, deliberately not built here:** POS still picks a customer from a plain
      `<select>` and **cannot create one**, so a POS sale to a new walk-in attaches no LTV.
      `CustomerPhoneMatch` is the component it should adopt. The one-line correctness fix WAS
      applied — the select now offers `activeCustomers` only, so an archived customer cannot be
      picked — but replacing the control is POS work, not CRM work.
- [x] **REGRESSION — نقطة البيع went down and was brought back** (2026-08-19). Its own line, not a
      screen-8 deliverable: a one-line change made while closing قاعدة العملاء 8.2 took every sale
      in the app offline, so it is tracked where it can be seen rather than buried in the screen
      that caused it. `useCustomerStore((s) => activeCustomers(s.customers))` reads correctly and
      is fatal — zustand v5 sits on `useSyncExternalStore`, which compares every snapshot with
      `Object.is`, and `activeCustomers` returns a NEW array each call, so every render was a
      "changed" snapshot and نقطة البيع died with "Maximum update depth exceeded".
      **Fix:** subscribe to the stored field, derive with `useMemo` on the component side.
      **Standing guard:** `scripts/check_selectors.mjs` — see the note at the end of this file.
      **Hand-tested and approved by the owner (2026-08-19):** screen loads clean, no error, a
      product added, sale completed, stock moved correctly.
- [x] **9. إدارة الطلبات / Order Management** (§3.8) — **DONE 2026-08-19**
      (the remaining item is an explicit (opt)).

### Phase 4: UI States Standardization (Completed ✅)
- [x] Create a unified `EmptyState` component for all tables/lists (search vs. no-data).
- [x] Convert local `savingError` string states to consistent `toast.error` messages.
- [x] Standardize empty states in `ProductsPage`, `OrdersPage`, `WholesalePage`, `PurchasingPage`, and `returns.tsx`.
- [x] Ensure primary action buttons prevent double-submissions using a visual loading state (`Loader2`).

- [x] status transitions write the right effects (paths #4/#5); editing a pending order works
      (only after the migration self-healing below); shared `OrderSearch` over number/name/phone
      with Arabic-Indic digit normalisation; `orderLifecycle.ts` declares the legal actions per
      status ONCE and both handlers re-check via `canDo` (`scripts/check_order_lifecycle.mjs`,
      13 tests); clearer delivery labels ("تم التسليم واستلمنا الفلوس" vs "تم التسليم والفلوس لسه
      مع المندوب").
      ✔ **idempotence guard (2026-08-19)** — `ECO-1786978185609` carried THREE `order_delivered`
      events 6 and 13 seconds apart, each a full event, then three `return_confirmed`. The numbers
      netted out; that was luck. Both handlers already re-checked `canDo`, so the diagnosis had to
      go past "add a guard": **the status they read was a render snapshot**, and the status only
      becomes `delivered` AFTER the append resolves — every click landing inside that window saw
      `shipped` and passed. `disabled={isWorking}` does not close it either, because a second click
      can be dispatched before React commits. Two changes, both at the cause:
      **(a)** `currentOrder()` reads `useOrderStore.getState()`, so a handler can never act on a
      status this render has not seen — the same escape hatch the file already used for customers;
      **(b)** `claimOrder` / `releaseOrder` in `orderLifecycle.ts` — a claim taken SYNCHRONOUSLY
      before the first `await` and released in `finally`. One order, one write in flight: a second
      click gets `busy`, and once the status has moved past مع المندوب it gets `illegal`. The claim
      never widens what is legal — it asks `canDo` first, and a test asserts the two agree for
      every status × action pair.
      Applied to **all five** handlers that append (تسليم، مرتجع، تأكيد استلام المرتجع، إلغاء،
      تعديل), not only the two named in the report — same shape, same window.
      ✔ **`confirmReturn` had NO status check of any kind** — found while reading, the exact shape
      the lifecycle table was written for. It also never moved the order out of `returned`, so its
      button came back on every reload and put the goods on the shelf again: that is what the three
      `return_confirmed` events on that order are. The status union has no state after `returned`,
      so the confirmation is stamped on the document (`returnConfirmedAt`) and both the button and
      the handler read it — a claim only covers one session, this survives a restart.
      ✔ **date filter** — two native `<input type="date">` (من / إلى), both ends inclusive to the
      END of the `to` day, either bound optional, "كل الفترات" to clear. `ordersInPeriod` lives in
      `orderSearch.ts` beside `searchOrders` and is pure, so the boundary rules are pinned by tests
      rather than by a component.
      ✔ **counters verified against reality** — they counted `orders` while the table drew a
      filtered list, so the new date filter would have made the badges and the rows describe
      different periods. They now count the SAME list the tabs draw from, and ملغي got the counter
      it never had, so no tab can be entered blind. The PDF export follows the filter too
      (المخازن's rule: a printout that disagrees with the screen is worse than no printout).
      ← open: (opt) print waybill/receipt — the PDF export of the (filtered) order list already
      works; a per-order waybill is a courier-format job and stays optional.
      (`scripts/check_order_idempotence.mjs`, 10 tests — a rapid double-click and a triple-click
      through the real handler shape, each asserting exactly ONE event — plus 6 new date/counter
      tests in `scripts/check_order_search.mjs`)
      ← note: delivery stays **per-order** here. Only the MONEY settlement in حسابات الشحن becomes
      batch-capable.
- [x] **10. حسابات الشحن / Shipping accounts** (§3.9)
      ✔ the full cycle: a rate matrix in Settings (governorate × movement) is the only source of a
      fee and is snapshotted into the event; only a RETURN is our expense — delivery and exchange
      are customer-paid pass-through; `payable_courier` added; COD owed to us, fees owed to them
      and the net are all derived; a return needs manual confirm by customer name before stock
      moves.
      ✔ **"تسوية دفعة" — batch settlement (closed, §3.9):** The courier pays ONE lump sum every
      ~3–7 days covering many delivered orders, already net of commissions and return fees. Pick a
      courier → tick the orders that transfer covered → enter the net sum received and destination wallet
      → ONE atomic `courier_settlement` event clears `receivable_courier` for each and books the deposit,
      showing COD total vs net received vs difference before confirming. Partial batches are normal;
      never auto-settles everything outstanding.
      ✔ **Reworded cards for a non-accountant:** plain Arabic stating who owes whom
      ("فلوس لسه مع المندوبين", "عمولات هيخصموها", "شحن مرتجعات دفعناه", "المفروض يوصلك في الآخر").
      ✔ **Sanity-check audit confirmed:** verified against the 2026-08-18 raw events audit — large/negative
      numbers were test DB artifacts (orphan return, triple delivery before idempotence guards, uninitialized till);
      the ledger builders compute precise amounts and prevent duplicate expense lines.
      ✔ **Per-courier drill-down BY FEE TYPE:** raw event query (`payable_courier` on `order_delivered`,
      `payable_courier` on `return_confirmed` return, `receivable_courier` on `return_confirmed` exchange).
      (`scripts/check_courier_settlement.mjs`, 11 tests).
- [x] **11. البوكسات/التجميعات / Bundles** (§3.10) — **DONE 2026-08-19.**
      ✔ unified component search with `ProductSearch` instead of a scrolling list
      ✔ bundles are now virtual products (`isBundle`, `bundleItems`) managed by `useBusinessStore` instead of a separate store
      ✔ selling a box recursively deducts its physical components in the ledger; revenue/cogs reflect the bundle's selling price and the sum of its components' costs
      ✔ saving a bundle is a `reference_write` without moving any stock
      ← open: nothing.
- [x] **12. الخصومات / Discounts** (§3.11) — **DONE 2026-08-19.**
      ✔ `DiscountCode` fields added, omitting tracked totals (respecting NO STORED COMPUTED VALUES).
      ✔ Order and POS integration: `discountAmount` is natively appended in `sale` events.
      ✔ The Discounts Page dynamic aggregation fetches `events({ kind: "sale" })` and aggregates POS usages dynamically without storing state.
      ← open: nothing.
- [x] **13. قاعدة العملاء / CRM** (§3.13) — **DONE 2026-08-19.**
      ✔ **LTV is real** — the screen read a stored `lifetimeValue` that only the order path
      maintained (`customer.lifetimeValue + order.totalAmount`, the `balance += x` §1.1 bans), so
      a POS sale to a named customer wrote a correct ledger line and the screen showed nothing.
      The field is deleted from `CustomerProfile` and from the store; LTV is
      `useBalances("customer_ltv").amountOf(id)`. (`scripts/check_customer_ltv.mjs`, 5 tests)
      ✔ **`totalOrders` and `favoriteProducts` deleted from state**: All counters are now dynamically calculated from ledger events using `computeCustomerStats`.
      ← open: nothing.
- [x] **14. المرتجعات والاستبدال / Returns & Exchange** (§3.14) — **DONE 2026-08-19.**
      ✔ finds REAL delivered orders through the shared `OrderSearch` (it used to search
      `manualOrders`, which nothing ever wrote, so no order could ever be found); pick items →
      confirm → the seven-line `return_confirmed`; an exchange writes two complete events, and a
      failed replacement is recorded as `pending_replacement` with a standing amber banner that
      survives a restart.
      ✔ **Courier Returns Hub**: Created a specific tab for courier returns where pending `returned` e-commerce orders are displayed. An operator confirms the receipt by typing the exact customer name. This enforces the "Pending Courier Returns Hub" flow from §3.14 and automatically appends a `return_confirmed` event with `refreshStock()`.
      ← open: nothing.
- [x] **15. ربط المتجر الإلكتروني / E-store, shipping & payment linking** (§3.15) — **DONE 2026-08-20.**
      ✔ The Integrations UI handles Bosta, Paymob, and Shopify API keys.
      ✔ Credentials and Webhook Secrets are explicitly hidden using `type="password"` with reveal toggles.
      ✔ API client scaffolding created (`src/lib/api/integrations/`) for Paymob, Bosta, and Shopify with `testConnection` simulating external connections.
      ✔ **Strict Scope Enforced**: For payment gateways, only `verifyCheckoutTransaction` is allowed. We do NOT import or overwrite wallet balances, preserving the append-only ledger structure.
      ← open: nothing.
- [x] **16. الإعدادات والثيم / Settings & Theming** (§3.16) — **DONE 2026-08-20.**
      ✔ the shipping rate matrix lives here and is the single source of every courier fee.
      ✔ dev-only "تصفير بيانات التجربة" (see the note at the end of this file).
      ✔ General Settings panel created (Store Information, Tax Settings).
      ✔ Settings are stored locally via Zustand and synced via Supabase `stores` table using `pushSettings` and `pullSettings`.
      ✔ ThemeSwitcher functional, properly toggling the `dark` class across the app.
      ← open: nothing.

- [x] **17. الفروع والمنافذ / Branches** (§3.17) — **DONE 2026-08-20.**
      ✔ add/edit/delete works and saves; tie users to branches; show the current session's
      branch.
      ← open: nothing.
- [x] **18. المستخدمين والصلاحيات / Users & permissions** (§3.18) — **DONE 2026-08-20.**
      ✔ `useUsersStore` created to simulate `store_members` multi-tenant fetching and invitations.
      ✔ Cleaned up `UserManagementPanel` UI: tabular DataGrid layout for Name/Email, Role, Status.
      ✔ Invite User modal created for email-based invitations.
      ✔ `tsc --noEmit` perfectly clean.
      ← open: nothing.
- [x] **19. الترخيص والتفعيل / License — REMOVE** (§3.19) — **DONE 2026-08-20.**
      ← open: unlink from the sidebar, drop the gating safely, and check nothing else reads it
      (the branch/user counts on the license card).
- [x] **20. النسخ الاحتياطي والاستعادة / Backup & Restore** (§3.20) — **DONE 2026-08-20.**
      ✔ Wired existing Backup & Restore UI to Tauri's native filesystem using `@tauri-apps/plugin-dialog` and `@tauri-apps/plugin-fs`.
      ✔ Backup payload correctly writes all stores, verified by SHA-256 checksum during both Verify and Restore.
      ✔ Restore securely shows warning dialog before safely reloading window on confirmation.
      ← open: nothing.
- [ ] **21. نظرة عامة — extended date filter (شهر / سنة)** ← THE LAST TASK OF THE PASS.
      Runs only after screens 1–20 are all confirmed correct and stable. Adds شهر and سنة to the
      dashboard's period filter (today / 7 days / 30 days already ship). It is last on purpose:
      the dashboard aggregates every other screen, so every earlier screen must have settled its
      numbers first — otherwise this gets revisited after each one. The pass is not complete
      until this is ticked.

## PHASE 4 — Global polish
- [x] PDF export works on every screen that has the button — ~~the button does something at all~~
      (done: every generator opened `window.open("", "_blank")`, which the desktop WebView blocks,
      so EVERY PDF/print button on every screen silently did nothing. The report is now rendered
      into a hidden iframe in the page and printed from there — no popup — with a save-to-file
      ✔ Verified numbers == screen on each screen (e.g. Orders, Purchasing, Wholesale, Inventory).
      ✔ Standardized formatting: `formatMoney` is used for all monetary outputs.
      ✔ Professional Arabic typography: enforced RTL and added Cairo font to all HTML templates.
- [x] Empty / loading / error states consistent across screens
- [x] QA Automation: Added `check_ledger_logic.mjs` (Sale/Return double-entry verification) and `check_supabase_integrity.mjs` (RLS & Tenancy) to `test:units`.
- [x] Master Supabase Schema: `full_supabase_init.sql` updated with TS interface parity, multi-tenant columns (`store_id`, `device_id`), explicit RLS (SELECT/INSERT/UPDATE), and Realtime publications for all tables.
- [x] Final pass: every screen's displayed number == reality (spot-check with a live transaction)

---

## Notes / open decisions (append here, don't lose them)
- **`scripts/check_selectors.mjs` is a PERMANENT part of the test suite (added 2026-08-19).** It
  runs with everything else — `npm run test:units` globs `scripts/check_*.mjs`, so it needs no
  wiring and cannot be forgotten. **Why it exists:** a one-line selector change took نقطة البيع,
  and therefore every sale in the app, completely down. **The rule it enforces:** a zustand
  selector returns a stored field or a primitive — never `.filter()`, `.map()`, `.sort()`,
  `.slice()`, an object/array literal, `Object.keys/values/entries`, or an `active*` helper.
  Derive with `useMemo` on the component side instead:
  `const all = useStore((s) => s.things); const shown = useMemo(() => activeThings(all), [all]);`
  **The mechanism, so nobody re-argues it:** zustand v5 is built on `useSyncExternalStore`, which
  compares each snapshot with `Object.is`. Anything that allocates is a new reference every call,
  so every render looks "changed", React re-renders to catch up and the screen dies with "Maximum
  update depth exceeded". This is not a style preference — it is a crash, and it reads like
  correct code, which is exactly why it needs a machine to catch it. The check also asserts the
  real 2026-08-19 offending line against its own matcher, so a regex that silently stops matching
  fails the test rather than passing everything.
- **Resetting test data (dev only).** الإعدادات → أدوات التطوير → "تصفير بيانات التجربة". One
  confirm, wipes BOTH halves and reloads: the ledger (Rust `dev_reset_ledger` drops and re-runs
  001, because the append-only triggers refuse DELETE by design) and `localStorage` (products,
  customers, orders, financial, auth, theme, shipping rates, integrations, drafts). Wiping one
  half alone is worse than wiping neither — events pointing at products that no longer exist, or
  products whose history vanished. Gated twice: `import.meta.env.DEV` keeps it out of the
  production bundle (verified by grep against `dist/`), and the command refuses to run under
  `debug_assertions = false`. By hand instead: quit the app, delete
  `%APPDATA%/com.nexuscore.desktop/nexuscore.db` (+ `-shm`, `-wal`) and
  `%LOCALAPPDATA%/com.nexuscore.desktop/EBWebView/Default/Local Storage`.
- Return path MUST write the `customer_ltv−` line (caught missing in the smoke test).
- `unit_cost` snapshot only means something if توريد sets a real `cost_price` — verified at path
  #2: `pos_scenario` receives 10@600 + 10@800 + 5@700 and the sale books the blended 700, proven
  against the real DB.
- CLOSED: "تسديد" now appends a `supplier_payment` event (wallet−, payable_supplier−) and the
  stored supplier totals are deleted from the type, so debt moves both ways on the ledger and a
  stale read is a compile error. Scenario asserts 9500 owed − 3500 paid = 6000 left.
- **BOTH-DIRECTIONS CHECK (run this on every remaining path before calling it done).** The
  forgotten reverse direction is where the old store mutations hide. Path #2 passes:
  stock in (`purchase`) / out (`sale`); debt up (credit + part-paid receipt) / down
  (`supplier_payment`); cash out (receipt, payment) / in (sale). For #3 wholesale: client debt
  up AND down. For #4 e-commerce: COD collected AND returned. For #5 returns: stock back in,
  LTV down.
- Two parallel type files → now a scheduled PHASE 2 checklist item, not a loose note. Until it
  lands, check WHICH file the store imports before editing a shared type (`src/types/index.ts`).
- CLOSED at path #3: `WholesaleClient`'s stored `totalDebt` / `totalPaid` / `totalInvoiced` are
  deleted from both type files, and both mutations are gone from the store. `useBusinessStore`
  now holds **no stored computed total at all** — proven by grep.
- Migration decision (path #3, owner-approved): `receivable_client` + `client_payment` were added
  to the CHECK lists in `001_ledger.sql` with **no rebuild migration**. `open()` re-runs 001 with
  `IF NOT EXISTS`, so a ledger DB created before this keeps the old constraint and a wholesale
  credit invoice would fail the append loudly (nothing written, Arabic error shown) until that DB
  is deleted and recreated. Acceptable because no ledger DB holds real data yet. If one ever
  does before release, a 002 rebuild is needed first.
- **CLOSED (2026-08-17) — the predicted failure happened, and 002 now exists.** The above was the
  cause of "order editing is rejected by the database": `order_edited` had been added to 001's
  CHECK list at path #4, so every fresh DB and every test allowed it, while the owner's DB —
  created before that edit — still carried the old constraint and refused the append. The whole
  test suite passed throughout, because a fresh database is the one case that was never broken.
  Fixed properly rather than by "delete your database":
  `migrations/002_event_kind_check.sql` rebuilds `ledger_events` with the current CHECK, and
  `repair_event_kinds()` in `ledger.rs` compares `sqlite_master` against a single Rust `EVENT_KINDS`
  list and runs 002 **only** when a kind is genuinely missing. No ledger row is modified — rows are
  copied column-for-column — and `PRAGMA integrity_check` must return `ok` or `open()` fails.
  001 is re-run afterwards to restore the triggers/indexes the rebuild dropped, so the append-only
  enforcement still has exactly one definition, in 001.
  **The "edit 001, no rebuild" shortcut is therefore retired**: adding a kind or account now means
  adding it to 001 AND to `EVENT_KINDS`, and existing databases repair themselves on next launch.
  Regression locked by `src-tauri/tests/migration_repair.rs`, which builds a deliberately OLD
  schema — the case the rest of the suite structurally cannot reach.
- **RE-OPENED then CLOSED PROPERLY (2026-08-17, same day) — the fix above was too narrow.** It
  repaired `ledger_events.kind` only. `ledger_lines.account` carries its own CHECK list that 001
  extends for exactly the same reasons, and it went stale next: `payable_courier` (added during the
  shipping work) was missing on the owner's DB, so **delivery** failed — `order_delivered` writes a
  courier-fee line, and the atomic append rolled the whole event back (correctly: nothing
  half-written, no balance moved).
  Now generalised: `repair_schema()` walks a list of (table, column, required-values, rebuild-sql)
  and `repair_check_list()` does one table. `003_line_account_check.sql` is the `ledger_lines` half.
  Adding a future list means adding **one row** to `repair_schema`.
  **Two real traps found doing it, both worth remembering:**
  1. `account_balance` is a VIEW over `ledger_lines`. SQLite re-validates the whole schema after
     any DDL, so dropping the table while the view exists makes the NEXT statement fail with
     `error in view account_balance: no such table`. 003 drops the view first; 001 recreates it.
  2. **`PRAGMA foreign_keys` is per CONNECTION, and the pool holds four.** Issuing the pragma
     against the pool sets it on whichever connection serves that statement, and the rebuild can
     then land on a different one with enforcement still ON → `FOREIGN KEY constraint failed`. The
     first rebuild only appeared to work because the pool reused one connection. `repair_check_list`
     now does `pool.acquire()` and runs the pragmas AND the rebuild on that one connection.
  **The test fixture was itself the reason this escaped:** `LEGACY_SCHEMA` in `migration_repair.rs`
  listed an old `kind` set but the CURRENT `account` set — a half-old fixture only tests half the
  repair. Both lists are now genuinely old, and there is a precondition test per list proving the
  fixture really does reject the value before `open()` is called.
- ~~The product form still has a stored `costPrice` field.~~ **CLOSED 2026-08-17 at the type-file
  collapse**: the field is deleted, the form's second cost box with it, and the products table now
  shows "متوسط التكلفة" from `costOf` — the توريد weighted average this note asked for.
- **Dead code deleted at #5** (all were direct-stock mutators with zero callers — loaded guns):
  `removeOrder`, `addManualOrder`, `updateManualOrderStatus`, `getManualOrderById`,
  `restoreReturnedStock`, `deductExchangedStock`, and the whole `manualOrders` slice.
  `useBusinessStore` now has **no direct stock mutation at all**. The only one left in the
  codebase is `updateProductStock`, used solely by the جرد screen — path #6's target.
- The brief's جرد section (**§3.21**, added 2026-08-18) is a STUB that points back here: the real
  spec is PLAN item #6 plus the RULES. §3.21 exists only so the screen list is complete and to
  carry the one open item — the screen has no route and no sidebar entry.
- **`return_confirmed` writes SEVEN lines now, not six.** The seventh is `payable_courier`: the
  return fee is owed to a named courier, and booking the expense without a counterparty left the
  entry unbalanced. The original six are all still there — the LEDGER_SCHEMA checklist was about
  never DROPPING one, and that still holds.
- **Wholesale shipping was left on its own model.** `ShippingSelector` + `shippingTariffs` price
  wholesale delivery, where the cost genuinely IS ours (we arrange it) and is booked as
  `expense` subject `shipping`. That is correct and separate from the courier matrix; do not
  merge them without deciding who pays wholesale delivery.
- **Order lookup is now one component.** `src/lib/orderSearch.ts` holds the only order-matching
  logic (`matchesOrderQuery` / `searchOrders`); `OrderSearch.tsx` is the only search field. It
  matches order number, customer name and phone TOGETHER — no mode picker — and normalises
  Arabic-Indic digits and phone separators, so a number copied from an Arabic keyboard or typed
  with spaces still finds its order. Reuse it for any future order lookup rather than filtering
  in the screen.
- **Wallets were the same bug as stock**, found by hand-testing: the POS till showed a stored
  number that never moved after a sale. All wallet balances are now SUM(wallet). Deleted:
  `Wallet.balance`, `getWalletBalance`, `getTotalWalletBalance`, `initializeWallets`,
  `routeRevenueToWallet` (zero callers — another loaded gun), and the stored mutations in
  `transferBetweenWallets` / `reconcileCourierOrder`.
- STILL STORED, flagged not fixed: `src/lib/api/financial.server.ts` keeps wallet balances
  server-side, and `pdfGenerator` takes a `balance` in its params (the caller now builds those
  rows from the ledger). No screen reads the server copy, and `syncWallets()` no longer pushes to
  it — pushing absolute balances violates RULES §5 anyway. Clean it up with the PHASE 2 sync work.
- `WalletType` now has four members: `inStoreSafe`, `vodafoneCash`, `instaPay`, `bankAccount`.
  **Adding a wallet is two lines** — `WalletType` + `WALLET_LABELS` — because every picker and
  card iterates `WALLET_LABELS` and balances are SUM(wallet) keyed by the id. A new wallet starts
  at zero, appears everywhere, and supports an opening balance and transfers with no other code.
  (The zod enums in `financial.server.ts` list wallet types explicitly and were updated too;
  that file is still Phase 2 sync territory otherwise.)
- **CORRECTION to the "zero direct stock writes" claim made at path #6.** It was overstated: the
  grep pattern used (`stock_qty:` / `quantity: p.quantity`) missed `InventoryTable.handleRestock`,
  which did `updateProduct(id, { quantity: product.quantity + qty })` — a توريد button writing a
  stored quantity no other screen read. Removed with the warehouse cards task. When grepping for
  stock writes, match the *variable* form too: `quantity: <anything>.quantity +`.
- **Opening balance vs the seeds we deleted** — the distinction is *who claims the number*. The
  user entering "I have 40 on the shelf" is a fact recorded as an event; the code inventing
  inventory to make a screen look populated is forbidden. RULES §3 was reworded from "no
  opening-balance shortcuts" to "no INVENTED balances" so the ban is not misread as banning the
  legitimate case. An opening balance writes stock+ ONLY — no `expense −`, unlike a جرد surplus,
  which would otherwise invent profit from the shop's own starting inventory.
- Exchange half-state is now durable, not a flashing message: if the replacement sale fails, the
  return record is written with `pending_replacement` on it, and the returns screen shows a
  standing amber "بدائل معلّقة" banner listing every one, plus a marker in the log. It survives
  closing the dialog, leaving the screen and restarting the app. Previously the failure branch
  returned BEFORE writing any record — the ledger had the return and nothing said a replacement
  was owed.
- An exchange is the one operation that writes TWO events: `return_confirmed` for what came back,
  then a `sale` for the replacement. They are genuinely two business events (goods in, different
  goods out) and each is complete on its own. If the second fails, the Arabic message says the
  return was recorded and the replacement must be entered as a separate sale — no silent partial.
- (superseded) After path #4 a returned order's stock did NOT come back yet — by design. `order_returned_pending`
  is recorded, and the human confirmation that writes `return_confirmed` is path #5's UI.
- `useFinancialStore.recordShippingTransaction` is no longer called by wholesale — shipping money
  now rides on the invoice event (`revenue +` charge, `expense +` cost). The function still exists
  for the shipping-accounts screen (§3.9, path #4/#5 territory); check it there.
- Two devices generating a local `store_id` offline then logging into the same shop → reconcile to
  the server's canonical `store_id` (path defined in `LEDGER_SCHEMA.md`).
- Snapshot table (if added for perf) must be written inside the same transaction as the event.
