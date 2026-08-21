# NEXUSCORE — DETAILED SPEC (per-screen brief)

> **How to use this file:** this is the detailed spec. Read **only** the section for the
> screen/path you're currently working on — don't read it end to end every session (that
> wastes tokens). Rules are in `NEXUSCORE_RULES.md`; order + progress in `NEXUSCORE_PLAN.md`.
>
> **Reminder:** the whole app is Arabic (see RULES §2). Everything below describes behavior;
> all user-facing text you add is Arabic, RTL, currency `ج.م`.
>
> **Golden rule:** before editing any screen, open the code behind it first, find the data
> source, then edit. The displayed number must always equal the real number computed from a
> single source.

---

## 1. Architecture (context — mostly built already)

Every screen is interconnected. There is one source of truth: the ledger. All totals are
`SUM()` over ledger lines; nothing is a stored balance.

### 1.1 Event → effects map
| Event | Stock | Wallet / Finance | Customer | Shipping |
|---|---|---|---|---|
| POS sale | − | + (cash/visa) | LTV + orders + | — |
| E-commerce order (COD) | − (reserve) | + after collection | LTV + | expected COD + |
| Return (confirmed) | **+** | − (refund / shipping fee) | LTV adjusted | return recorded |
| Purchase invoice | + | − (or supplier debt +) | — | — |
| Expense / payroll | — | − | — | — |
| Shipment delivered | — | COD collected | — | courier due updated |

### 1.2 Consistency
- Any operation touching >1 table is ONE atomic transaction (rollback on partial failure).
- No duplicated computation: a total shown on 3 screens comes from one function.

### 1.3 Test every screen (mandatory)
For each screen: (1) do a transaction, (2) confirm the number changed correctly on that
screen, (3) confirm it changed correctly on the linked screens (stock + wallet + finance +
customer).

### 1.4 Offline-first + Supabase sync
App works 100% offline; syncs automatically when online; live-updates while connected;
same account on multiple devices stays consistent.

Example (from the owner): one device at home records online orders (stock −); the same
account at the shop runs POS (stock −); stock must stay correct on both, even if one was
offline for a while.

Rules: local-first DB is the local source of truth; the **ledger is the sync key** — sync
**events** (append-only, `INSERT OR IGNORE` by UUID → no conflict possible), never absolute
stock values; derive stock locally from synced events. Outbox = rows with
`sync_status='pending'`. Pull + Realtime. Every synced row: client UUID + `updated_at` +
`device_id` + `sync_status` + tombstone `deleted_at`. Reference data conflicts → LWW on
`updated_at`, real conflict → `conflict` status + notify. Sidebar status must be real
(online / pending count / last sync / "sync now"). Security: anon key + RLS scoped by
store/owner; never ship the `service_role` key in the client.

---

## 2. Cross-cutting tasks
- [ ] Full backend review per screen — displayed == real.
- [ ] PDF export works on every screen with the button (numbers match screen; Arabic/RTL).
- [ ] **Reusable product-search component** — any screen with many products (POS, bundles,
      orders, discounts) uses it: search by name/SKU/barcode, instant results, no scrolling.
- [ ] Unified validation — no bad negatives, no selling above stock, no discount > total.
- [ ] Clear empty / loading / error states everywhere.

---

## 3. Screens

> Each: current state → notes/issues → required (UI) → required (backend) → effort.

### 3.1 Dashboard (نظرة عامة)
Current: cards (Pro sub, alerts, today's revenue), quick indicators, top/bottom products,
sales-growth chart. **All currently fake/hardcoded — rebuild from the real ledger.**
- [ ] Add simple useful cards (keep it simple): net profit today/month, orders today, avg
      order value, top product, returns today, low-stock count.
- [ ] Chart from real ledger (sales last 7/30 days), not constants.
- [ ] Each card clickable → its detail screen.
- [ ] Simple period filter (today / week / month) at top.
- UX: cleaner spacing, consistent icons, unified status colors (green/red).
- Effort: medium.

### 3.2 Products (المنتجات)
Current: product table (name/barcode/category/stock/status). Most important area to the owner.
- [ ] Stock is one number derived from ledger: purchases + / sale − / return + / bundles −.
- [ ] Any sale/return updates stock here immediately.
- [ ] SKU/barcode unique — no duplicates.
- [ ] Status (in stock / low / out) auto from an editable reorder point.
- [ ] Quick "توريد" records a real stock event + (opt) links to a supplier invoice.
- [ ] Search/filter by category & status using the unified search component.
- Effort: large (this is the stock source for the whole system).

### 3.3 POS (نقاط البيع)
Current: barcode search/scan, manual product pick, cart, target cashbox.
- [ ] Better UI: search/barcode on top, fixed cart side with total, bigger clearer qty
      buttons, cleaner visuals (owner said "make it look better than this").
- [ ] Barcode: auto-focus the field always (scanner works without a click); Enter adds the
      first matching product; clear message if barcode missing + "add new product with this
      barcode" suggestion; damaged-barcode manual pick (exists — improve its look).

**Explain the "الخزينة" part at the bottom (the owner didn't understand it):**
> "Target cashbox" = the cash drawer/account this sale's cash goes into. Useful with multiple
> cashiers/branches: each sale is attributed to a cashbox, and at end of day you close each
> and reconcile the cash. The number next to it (e.g. ٧,٠٩٦.٨ ج.م) is that cashbox's current
> balance.
- [ ] UI: small hint next to the name ("the account this sale's cash is recorded in"), a clear
      dropdown showing cashbox name + balance, wired so every cash sale actually increases the
      chosen cashbox balance.
- [ ] If there's only one cashbox, hide the complexity or default to "main cashbox".

**The wallets are MANUAL ledgers — see §3.6a before touching any of them.** الخزينة, فودافون كاش
and انستا باي are the owner's own running records, reconciled by hand against the real till and
the real phone/bank balances. None of them is connected to a payment gateway, and none should be.
- Effort: medium.

### 3.4 Warehouses (المخازن)
Current: stock table + working PDF export.
- [ ] Filter/search by category & status + sort by quantity.
- [ ] Visual highlight for low/out products.
- [ ] "Total N products — M units" computed from reality (aggregation).
- [ ] (opt) Bulk receive quantities for multiple products at once.
- Effort: light.

### 3.5 Purchases & Suppliers + supplier directory
Current: purchase invoices + supplier directory & debts.
- [ ] **Contact icon opens WhatsApp:** open `https://wa.me/<number>` (Web or Desktop). If the
      number is Egyptian `01…`, convert to international `2010…` first.
- [ ] "Total purchases / supplier debt" computed from actual invoices.
- [ ] **Choose which wallet paid the supplier.** A purchase is paid out of a specific account —
      الخزينة, فودافون كاش, انستا باي or the bank — and the invoice must let the owner say which,
      so the money leaves the right wallet (`wallet −` on that subject). Same picker as the POS
      "الخزينة" field; part-paid invoices take the wallet for the paid part only. See §3.6a.
- [ ] Purchase invoice increases stock for real (see 3.2).

**Quick توريد is CASH-ONLY by design — this is settled, not a gap (confirmed 2026-08-18).**
The fast receive from a product row (§3.2) and the bulk receive from المخازن (§3.4) always book a
receipt **paid in full**, from one wallet. They deliberately offer no partial or credit option:
credit needs a due date, terms, and the part-paid split, and a form that asks for those is the
full فاتورة مشتريات — at which point it is not "quick" any more. **A partial or credit receive
already has its path: this screen.** Both quick paths still name a supplier and write a real
invoice document, so nothing is missing from that supplier's account; only the payment terms are
fixed. Do not "discover" this again and add a credit toggle to the quick dialog.
- [ ] (opt) Filter invoices by status (paid/credit), supplier, date.
- Effort: light–medium.

### 3.6 Partners & Finance (الشركاء والمالية / رأس المال)
Current: general finance (cashbox cash, visa payments, expenses, net profit), record
expense/salary, sales movement, asset depreciation; "Partners & Capital" tab.

Stated problems: partner/capital numbers are wrong; can't delete a partner — it just stays
"inactive".
- [ ] **Fix partner delete:** real delete (or a clear archive that removes it from active
      accounts) with confirm. If the partner has linked movements, offer "deactivate" **as an
      option**, not the only forced behavior.
- [ ] **Review capital numbers:** partner shares and each one's profit/loss share must match
      general finance.
- [ ] Improve the screen UI (card layout, negatives in red).

**New feature — Owner Budget (ميزانية صاحب/صاحبة العمل):**
> A section for the business owner with a limit and defined spend; the system tells them every
> millieme spent, with warnings: nearly out / out.
- [ ] Entity: limit amount (e.g. monthly), spent, remaining.
- [ ] Every personal draw/expense deducts from it and is recorded in the ledger.
- [ ] Auto alerts at 80% (nearly out) and 100% (out) + a visual progress bar.
- [ ] (opt) Auto monthly reset.
- Effort: medium.

### 3.6a The wallets are MANUAL — no payment-gateway integration (read before any wallet work)

The owner keeps four accounts: **الخزينة** (the physical till), **فودافون كاش**, **انستا باي**
and the bank account. Every one of them is a **manual ledger**: the app records what the shop
says moved, and the owner reconciles that against the real cash in the drawer and the real
balance on her phone / in her bank.

**That reconciliation is the point of the feature.** It is how she catches a discrepancy — a
cashier who rang a sale into the wrong account, cash that never made it into the drawer, a
Vodafone Cash transfer that was never sent. If the app "knows" the real balance, there is nothing
to reconcile and the check disappears.

So, hard rules for any future task:
- **Never wire these wallets to an external API.** No Paymob, no Vodafone Cash API, no InstaPay
  API, no bank feed, no auto-import of transactions, no "sync balance" button.
- The balance shown is `SUM(wallet)` over our own ledger and nothing else. It is deliberately
  *our* number, not theirs.
- Payment-gateway work in §3.15 is about the **e-store's checkout**, taking money from an online
  customer. It stops at the point where that money is recorded as one of our wallet events; it
  never reads or reconciles a wallet balance from outside.
- Adding a wallet stays a two-line change (`WalletType` + `WALLET_LABELS`).

### 3.7 E-commerce orders (الطلبات الإلكترونية)
Current: create order (products + shipping data + financial summary + save). Owner: **has
problems, fix UI + backend.**
- [ ] Review the full create flow: pick product → qty → shipping fee → deposit → courier
      remainder → save.
- [ ] "Products total + shipping − deposit = remainder" computes correctly, updates live.
- [ ] On save: order reserves/reduces stock, appears in Order Management under "pending",
      writes a ledger event.
- [ ] ~~Link to a customer (new or existing), update LTV after delivery~~ **done 2026-08-19** —
      search-first on the PHONE (names vary in spelling, numbers do not), nothing auto-selected,
      and the order carries the customer's **id**. See `src/lib/customers.ts` for the one identity
      key. A customer created from an order is a reference write, not a ledger event.
- [ ] Validation: no save without products, no qty above stock.
- Effort: large (core screen, currently broken).

### 3.8 Order Management (إدارة الطلبات)
Current: tabs (pending / with courier / delivered / returned) + table + PDF export.
- [ ] Top counters update from reality.
- [ ] Status transitions write the right effect: delivered → collect COD; returned → stock back
      + financial effect (see shipping 3.9 and returns 3.14).
- [ ] **An order must not accept the same action twice.** Found in the 2026-08-18 audit: order
      `ECO-1786978185609` carries THREE `order_delivered` events 6 and 13 seconds apart, each a
      full event (wallet, revenue, LTV, COGS, stock), from repeated clicks on "تم التسليم". A
      delivered or returned order must reject a second "تم التسليم" / "مرتجع": disable the action
      the moment it fires, and re-check the order's CURRENT status inside the handler — `canDo`
      already declares the legal actions, the gap is a handler reading a status that has not
      re-rendered yet.
- [ ] Search by order/customer/phone + date filter.
- [ ] (opt) Print waybill/receipt.
- Effort: medium.

### 3.9 Shipping accounts (حسابات الشحن) — important
Current: track COD due/paid/commissions/net courier due. Account auto-created on first COD
delivery.
- [ ] Shipping tied to movement + stock + cashbox. On delivery → collect COD into cashbox,
      update courier due/commission.
- [ ] **Return cycle from shipping (important):**
  1. The courier shows a "return".
  2. That does **not** mean the item physically came back yet.
  3. **Manual confirmation by the operator, by customer name**, that the return arrived.
  4. Only after confirmation: **stock +** and **a shipping return is counted as money**
     (shipping/return fee).
- [ ] Two return states: "returned (with courier, awaiting receipt)" and "return confirmed
      (back in stock)" — stock only increases in the second.
- [ ] **Architecture decision (recommended: yes):** per-courier drill-down inside the shipping
      screen — list couriers, click one to see its orders/COD/commissions/returns/settlement.

**The courier settles in BATCHES, not per order** (from hand-testing, 2026-08-18):
> The courier does not pay per delivery. Every ~3–7 days it transfers ONE lump sum covering many
> delivered orders, already net of its commissions and any return fees. The owner reconciles that
> single transfer against the orders it was supposed to cover.

- [ ] **"تسوية دفعة" (batch settlement) flow** on حسابات الشحن: pick a courier → tick the several
      delivered orders whose money arrived together → enter the **net lump sum actually received**
      and the wallet it landed in → one reconciled operation clears `receivable_courier` for every
      ticked order and books the wallet deposit, with the difference between the COD total and the
      lump sum booked as the courier's commission/fees (`payable_courier` settled, expense where
      it is genuinely ours per the rules above).
- [ ] The screen must show, before confirming: COD total of the ticked orders, the entered lump
      sum, and the difference — so a shortfall is visible rather than silently absorbed.
- [ ] Partial batches are normal: an order not ticked stays outstanding and appears in the next
      batch. Never auto-settle everything outstanding.
- [ ] **Order Management stays per-order.** Delivery status is still marked one order at a time
      there; only the MONEY settlement here becomes batch-capable. Do not turn delivery itself
      into a bulk action.
- [ ] **Reword the cards for a non-accountant** — the owner could not read "مستحق للمندوبين" or
      "الصافي (لنا-عليهم)". Say it plainly, e.g. "فلوس لسه مع المندوب" / "عمولات هندفعها" /
      "الصافي اللي هيوصلنا", and put the direction of every number in words.
- [ ] **Sanity-check the large per-order figure the owner flagged** once there is real data on a
      clean database. It may well be accumulated test history rather than a bug — verify against
      the raw events before changing any builder (the 2026-08-18 audit is the method).
- Effort: large.

### 3.10 Boxes / Bundles (البوكسات/التجميعات)
Current: box builder (name/SKU/price + pick components w/ quantities). Owner: scrolling through
products is painful.
- [ ] Solid backend: box has its own SKU + price; selling it auto-deducts each component's
      stock (verify it actually works and is recorded in the ledger).
- [ ] Prevent building a box with a component at zero / below needed (at least warn).
- [ ] **Component search:** add the unified search above the component list — search by
      name/SKU, pick immediately, no scrolling.
- [ ] Show total component cost vs box price (margin) so the owner can price it.
- Effort: medium.

### 3.11 Discounts (الخصومات)
Current: create discount code (%/fixed) + try on an order.
- [ ] **Discount talks to the customer's order:** picking the customer and applying the
      discount actually applies to that customer's order, adjusts its total, and is recorded
      (not just a hypothetical test). This is the core ask.
- [ ] "Code inactive or not found" message is precise (not found / expired / already used /
      max usage reached).
- [ ] Code validity (expiry date + max uses) — optional but useful.
- [ ] Any applied discount shows in the financial summary and correctly reduces revenue.
- Effort: medium.

### 3.12 Financial reports (المالية والتقارير) — explicitly requested
> Owner wants everything business-related as a number: total sales/returns/expenses… with a
> **date filter**, and **profit & loss** per month/quarter/year.
- [ ] ~~A "financial reports" screen/tab with all aggregates from the ledger~~ **done 2026-08-18**
      — tab التقارير المالية inside الشركاء والمالية. Six headline SUMs for the window,
      plus sales split by revenue channel (pos / ecommerce / wholesale).
- [ ] ~~Period filter: day / week / month / quarter / year / custom range~~ **done 2026-08-18**
      — يوم / أسبوع / شهر / كوارتر / سنة / نطاق مخصّص. The week starts Saturday. Every window is
      derived from the date on each render, never stored, so a screen left open past midnight
      reports the period it is actually in.
- [ ] ~~P&L per month/quarter/year~~ **done 2026-08-18** — but **NOT with the formula this line
      originally stated**, which double-counts. Read the box below before changing it back.
- [ ] ~~PDF export~~ **done 2026-08-18** — through the existing `printTableAsPdf` (hidden iframe,
      no popup, direct download). The per-row profit bar covers the (opt) trend chart.
- Effort: large (core of the system — do after the ledger is ready, which it now is).

#### The P&L formula — corrected, and why the obvious version is wrong

This section used to specify:

> revenue − (COGS + expenses + returns + shipping commissions) = net profit

**That is wrong against this ledger, and implementing it literally understates profit twice.**
The mistake is treating returns and shipping as separate deductions when the ledger has already
applied both. Per docs/LEDGER_SCHEMA.md §8:

- a `return_confirmed` writes **`revenue −`** and **`cogs −`**, so `SUM(revenue)` and `SUM(cogs)`
  are ALREADY NET of every confirmed return. Subtracting returns again removes the same money a
  second time;
- the courier return fee is written as **`expense +`** (subject `shipping_return`), and the
  wholesale delivery cost as `expense +` (subject `shipping`), so shipping is ALREADY INSIDE
  `SUM(expense)`. Adding it as a fourth term charges the shop twice for the same fee.

The formula the app implements, and the only definition of profit in the codebase:

> **net profit = SUM(revenue) − SUM(cogs) − SUM(expense)** — all three over `ledger_lines`,
> for the selected window.

Returns and shipping are still **displayed**, because the owner asked to see them as numbers.
They are displayed as **read-outs, not deductions**:

| shown as | is | rule |
|---|---|---|
| المرتجعات | `−SUM(revenue)` restricted to `kind = 'return_confirmed'` | already deducted from المبيعات above it — label it so |
| عمولات ومصاريف الشحن | `SUM(expense)` on subjects `shipping` + `shipping_return` | a **slice** of المصروفات, split OUT of it, never added to it |
| المشتريات | `SUM(stock.amount)` restricted to `kind = 'purchase'` | **not a P&L line at all** — cash became inventory; only what was SOLD is a cost (that is COGS). Putting it in the subtraction shows a loss on every restocking month |

A test asserts this directly: `scripts/check_financial_report.mjs` computes the naive version
beside the real one and asserts they differ by exactly the period's return value.

**Two invariants any future change must keep.** They are cheap to check and each one catches the
class of bug that produced the original formula:

1. `opex + shipping === SUM(expense)` — the split is a regrouping of the same rows, so the halves
   must add back up. If a future "shipping" figure comes from anywhere but the expense account,
   this breaks and the double-count is back.
2. the P&L rows must sum to the headline totals — the table and the cards are the same query at
   different widths.

#### Depreciation (إهلاك الأصول) — a memo, deliberately NOT a ledger event

Flagged during 7.1 and decided here, because this is where the P&L defines its terms.

**Decision: depreciation stays reference data and is reported as a memo beside the P&L. It does
not become a ledger line, and it is not inside `SUM(expense)` or صافي الربح.**

The tempting shape — an `expense +` line with no `wallet` counterpart — is legitimate in this
ledger (a wallet opening balance is a one-line event too) and was considered and rejected:

- depreciation is a **monthly accrual**, not an event. Nothing happens on a date; a period simply
  elapses. So writing it needs a posting job that decides "has this month been booked yet";
- the ledger is **append-only**. A posting job that runs twice — two devices, a re-open after the
  month rolled, a retry — permanently overstates cost, and the correction is another event rather
  than a fix. The stored-total drift this whole design exists to delete would come back in a form
  that looks authoritative;
- it is **non-cash**. No wallet moves, so booking it would make `SUM(wallet)` and the P&L describe
  two different realities, and §3.6a's whole point is that the wallets are reconciled by hand
  against the real till.

So the screen reports `إهلاك شهري` and `صافي الربح بعد الإهلاك` as a separate line, and says out loud
that it is غير نقدية. The الأصول tab used to claim the figure «يتم إضافته شهرياً إلى مصروفات
التشغيل بشكل تلقائي» — that was never true of any code, and the wording now states the opposite.

**If this is ever revisited:** the thing to change is not the report, it is to give the app a
deliberate «ترحيل إهلاك الشهر» action the owner presses, with an idempotency key on the period, so a
second press finds the month already booked. Until that exists, a memo is the honest shape.

#### One more thing this screen settled

There is now **ONE** definition of profit in the app, `fetchPnl` in `src/lib/ledger/reports.ts`.
Before 7.4 there were four, all wrong and all disagreeing: partner distributions guessed POS cost
at `posSales × 0.7`, two retail KPI cards showed an invented `sales × 0.6` / `× 0.4` cash-vs-card
split, and the shift report summed a `transactions` store the POS stopped writing at the ledger
conversion. Any new screen needing profit calls `fetchPnl(balances, window)`; none of the
store-side helpers survive to be called by accident.

### 3.13 Customer base / CRM (قاعدة العملاء)
Current: works well (LTV, order count, favorite products, orders timeline). Owner: "if it's
fine, leave it."
- [ ] ~~LTV~~ **done 2026-08-18** — it read a stored `lifetimeValue` only the order path
      maintained, so a POS sale to a named customer moved nothing. The field is deleted; LTV is
      `SUM(customer_ltv)` for that customer id.
- [ ] **`totalOrders` and المنتجات المفضلة are still stored counters** maintained only by
      `upsertCustomerFromOrder`, so a POS sale does not move either. Close them the same way LTV
      was closed: derive the order count and the favourites from real events (a POS sale to a
      named customer is one of that customer's orders), and delete the stored fields so a stale
      reader is a compile error rather than a wrong number on screen.
- [ ] Test/review: LTV, order count, favourites all update from real orders (POS + online)
      after each transaction/delivery.
- [ ] ~~Add / edit / delete a customer by hand~~ **done 2026-08-19** — not originally listed here
      because nobody had noticed it was missing: `addCustomer`, `updateCustomer` and
      `removeCustomer` existed in the store with **zero callers**, so قاعدة العملاء was read-only
      and a customer could only be born from an order. Editing is a **reference write**, no ledger
      event; past orders follow the new name because they point at the customer by id. Delete
      follows the same archive-if-has-history rule as المنتجات and الشركاء. An order no longer
      overwrites a corrected name — it updates activity only.
- [ ] (opt) Customer search + WhatsApp button (like suppliers, 3.5).
- Effort: light.

### 3.14 Returns & Exchange (المرتجعات والاستبدال)
Current: unified search (order no / customer name / phone) + log. Owner: **basically not
working.**
- [ ] **Make it actually work:** search finds the order → shows its items → pick returned
      item/qty → confirm.
- [ ] On confirm: **stock +** + financial effect (refund / reduce revenue) + ledger record +
      shows in the "returned" tab in Order Management.
- [ ] **Exchange:** return an item + issue a replacement (price difference computed: pay or
      refund).
- [ ] Tie to the shipping cycle (3.9): a shipping return goes through the same manual-confirm
      logic.
- Effort: large (nearly disabled).

### 3.15 E-store / shipping / payment linking (ربط المتجر الإلكتروني)
Current: linking screen with shipping courier setup (e.g. Bosta, API Key, Webhook), e-store
linking, payment gateways.
- [ ] **Make linking actually work:** valid API Key/Webhook → it works (send/receive shipping
      statuses, or pull store orders). Optional depending on real test keys, but the code must
      be ready and correct.
- [ ] Payment gateways: Paymob / Vodafone Cash / etc — integration ready, works if keys are right.
      **Scope limit:** this is the e-store's checkout only. It records what an online customer
      paid as one of our wallet events and stops there — it must never reconcile, import or
      overwrite a wallet balance. The wallets are manual by design (§3.6a).
- [ ] "Test connection" button per link.
- [ ] Hide secret keys (eye toggle exists — verify) and never store them in plaintext.
- Effort: large (optional on real activation).

### 3.16 Settings & Theming (الإعدادات والألوان) — needs fixing
Current: "visual identity & activity type" (light/dark + templates: Fashion/Glamour/Enterprise/
Wholesale/Custom). Owner: this is **not** the optional one — make it work properly.
- [ ] Template/color choice applies instantly system-wide, saves, persists after reopen.
- [ ] "Custom" works — pick primary/secondary colors, applied consistently everywhere.
- [ ] Light/Dark works on every screen (correct contrast in both, no stuck-color elements).
- [ ] Central CSS variables / theme tokens so one change propagates everywhere.
- Effort: medium.

### 3.17 Branches & outlets (الفروع والمنافذ)
Current: add branch (name/code/address/phone/status). Empty now.
- [ ] Add/edit/delete branch works + saves.
- [ ] Tie branch to cashbox & stock (each branch its own) if the model needs it — at least tie
      users to branches.
- [ ] Show "current session" tied to the right branch.
- Effort: medium.

### 3.18 Users & permissions (المستخدمين والصلاحيات)
Current: add user (name/password/full name/email/role). Shows **"الجلسة غير صالحة"** (invalid
session).
- [ ] **Fix "invalid session"** — auth/session bug blocking user creation.
- [ ] Real roles & permissions (cashier / manager / owner…) — each role sees/does only what's
      allowed.
- [ ] Passwords stored **hashed** (not plaintext).
- Effort: medium–large (if the permission system needs building).

### 3.19 License & Activation (الترخيص والتفعيل) — REMOVE
- [ ] Remove this screen entirely: unlink from the sidebar + remove any license gating that
      blocks usage (treat as always-active internally).
- [ ] Make sure removing it doesn't break screens that read from it (e.g. branch/user counts on
      the license card).
- Effort: light.

### 3.20 Backup & Restore (النسخ الاحتياطي والاستعادة) — ENABLE
Current: screen exists (JSON export, safe copy with masked keys, restore, SHA-256 checksum).
- [ ] **Make it actually work:** full/safe backup writes a correct file; restore works with an
      explicit confirm (as the screen says).
- [ ] Checksum actually generated & verified.
- [ ] (opt) Scheduled automatic (daily) backup.
- Effort: medium.

### 3.21 Stock audit / جرد (الجرد)
The screen exists and works — counted-vs-recorded per product, the difference in words
(عجز · زيادة · مطابق · لم تُجرد) and in ج.م, a review step, then ONE `stock_adjustment` event for
the whole audit. Its spec is **PLAN item #6 + the RULES**, not this file; this section exists only
so the screen list is complete.
- [x] **Reachable since 2026-08-18.** `/stock-audit`, with **الجرد** in the sidebar right after
      المخازن. Wiring only — the screen itself was not touched.
- Effort: light (navigation only) — done.

---

## 4. Notes & assumptions
- Assumes a central data layer to build the ledger on (now built).
- Offline/sync assumes Supabase link files exist (URL + key) — read them first; if a service
  key is in the client, move to anon key + RLS.
- "الخزينة" interpreted as a till/cash-account; adjust the POS explanation if it means
  something else in the system.
- Real activation of Bosta/Paymob/Vodafone Cash needs real keys; code is prepared, final
  activation optional.
- Currency everywhere: **ج.م (EGP)**.
