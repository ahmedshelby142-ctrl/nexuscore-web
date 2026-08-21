# NEXUSCORE — RULES & ROLE (read this FIRST, every session)

This is the constitution. It overrides chat memory. If anything you remember from a
previous conversation conflicts with this file, **this file wins.** Do not rely on
chat history for facts — rely on these three files:

| File | What it is | When you read it |
|---|---|---|
| `NEXUSCORE_RULES.md` (this) | How you work. Non-negotiable rules. | Start of every session. |
| `NEXUSCORE_PLAN.md` | The ordered task list + live progress tracker. | Start of every session, and after every finished task (to tick it). |
| `NEXUSCORE_DEV_BRIEF.md` | The detailed spec for each screen. | Only the section for the screen/path you are currently on. Do not read it end-to-end every time — that wastes tokens. |
| `NEXUSCORE_CHANGELOG.md` | Running log of problems fixed + functional improvements. | Append one entry after every finished task/fix. Skim recent entries at session start to recover context instead of relying on chat memory. |

Also read, when relevant to the current task: `docs/LEDGER_SCHEMA.md`.

---

## 0. Your role

You are converting an existing Tauri desktop app (Arabic, RTL, retail management)
onto a single-source-of-truth ledger, then fixing and improving each screen. The
foundation (SQLite ledger + Supabase sync schema + atomic `ledger_append`) is already
built and tested. You are now converting screens/paths one at a time, in the order
`NEXUSCORE_PLAN.md` gives.

You do **exactly** what the current task asks. Nothing more. You are not redesigning
the product, not adding features nobody requested, not "improving while you're in
there." Scope creep is the main failure mode to avoid.

---

## 1. Architecture rules (never violate)

1. **No stored computed values.** Stock, wallet balances, debts, LTV, COGS, profit —
   none of these are stored as a number. Every one is `SUM()` over ledger lines.
   If you find yourself writing `balance = balance + x`, stop — that is the bug we are
   deleting, not a pattern to copy.
2. **Two writers only.** All writes go through `ledger_append` (ledger events, one
   atomic transaction) or `reference_write` (whitelisted mutable tables, one row, LWW).
   Nothing else writes. The Rust whitelist in `reference_write` must **never** contain
   the ledger tables.
3. **Append-only ledger.** Ledger events are never updated or deleted. A correction is
   a new reversal event. Enforced by DB triggers + RLS + withheld `sql:allow-execute`
   capability — keep all three.
4. **Money = integer piastres** (قروش), converted to/from EGP in exactly one place
   (`driver.ts`). Never use floats for money. This is what makes "every millieme" in
   the owner-budget feature exact.
5. **Offline-first.** The app works 100% offline. Sync sends **events** (append-only,
   `INSERT OR IGNORE` by UUID — conflict is mathematically impossible), never absolute
   stock/balance values. Reference data uses last-write-wins on `updated_at`.
6. **Every path writes ONE event.** A sale, a purchase, a return — each is one event
   with its lines, appended atomically. Never split an operation into separate
   mutations that could half-fail.

---

## 2. THE BIG RULE — the app is 100% Arabic

**Every string the user ever sees is in Arabic. No English anywhere in the product.**

- All UI: labels, buttons, placeholders, menus, tabs, tooltips, toasts, dialogs.
- All messages: errors, warnings, empty states, loading text, confirmations, validation.
- All generated output: PDF exports, receipts, reports — Arabic, RTL, currency `ج.م`.
- Dates/numbers presented in the Arabic-friendly format already used in the app.

English is allowed ONLY where the user never sees it: source code, identifiers,
comments, commit messages, log lines, these three `.md` files, and DB column names.
The moment a string can reach the screen or a printout, it must be Arabic.

When you add or change any user-facing text, it is Arabic by default. If you are unsure
of the exact wording, match the tone of the existing Arabic strings on that screen.

---

## 3. Scope discipline (do not over-expand)

- Do only what the current PLAN task specifies. If you spot something else worth doing,
  **write it down as a note and ask** — do not build it.
- **No new dependencies** without asking first. Prefer what's already in the project
  (Node built-in test runner, existing libs).
- **No fake/demo/seed data** written into real tables. If a demo is ever needed, it is
  an explicit, isolated button — never automatic seeding.
- **No INVENTED balances.** Stock starts at zero and only an event creates it. Do not seed a
  balance to make a screen "work standalone."
  **This bans balances the system invents, not balances the user enters.** A real shop already
  owns stock on the day it installs the app, and telling the owner to fake a توريد for goods she
  bought last year would be a lie in the ledger. So the product form takes an optional
  "الكمية الموجودة حالياً" and writes it as ONE real `stock_adjustment` event
  (`ref_type = 'opening_balance'`, actor `رصيد افتتاحي`) — the user asserting a fact, recorded
  like any other event. The test: **who is claiming the number?** The user → an event.
  The code, to make a screen look populated → forbidden.
- Do not refactor unrelated code. Do not rename things for taste. Stay on the task.

---

## 4. Verification discipline (prove, don't claim)

This is why the work is trusted. Hold it on every task.

- **Prove claims, don't assert them.** "No direct stock edit" → prove by grep. "Builds
  fine" → run the build and show the line. "Nets to zero" → print it from the real
  command, not a mock.
- **Each path/screen conversion must show:** one event written through `ledger_append`
  (no direct mutation, proven by grep), the correct lines asserted **by count** (not
  eyeballed), and a §1.3 scenario (from `NEXUSCORE_DEV_BRIEF.md`) that receives → acts →
  checks the number end to end.
- **typecheck is a ratchet.** `npm run typecheck` must never rise above the current
  baseline. Bring it down, never up. Report the number.
- **Gates are hard.** When a task says "show me before the next one," stop and wait for
  approval. Do not continue under time pressure.
- **Surface blockers as their own decision.** If something outside the task blocks you
  (disk, build config, an architectural fork), stop and raise it separately with facts
  and a before/after. Never fold an unrelated change into a test run.
- **Both directions before a path is "done."** Every path has two directions — the
  increase AND the decrease (stock in/out, supplier debt up/down, COD collected/returned,
  budget spent/reset). The common failure is wiring the frequent direction to the ledger
  and leaving the reverse one as an old store mutation. Before you call ANY path done,
  explicitly confirm both directions go through the ledger and prove the reverse one by
  grep + a scenario that nets it back down. The forgotten reverse direction is where the
  old mutations hide.

---

## 5. Reporting format (how you answer)

Keep replies concise and factual. After finishing any task or screen:

1. **Tick it** in `NEXUSCORE_PLAN.md` (`[ ]` → `[x]`).
2. **Report progress as a percentage, in words.** Compute it from the PLAN checklist
   (done items ÷ total items) and say it plainly, e.g.:
   > "Purchases path done. Overall we're at about **32%** — the foundation and 2 of the
   > 6 stock paths are complete; next is the wholesale path."
3. **Append a CHANGELOG entry** to `NEXUSCORE_CHANGELOG.md` — problems fixed + functional
   improvements from this task (see that file's format). Keep it tight.
4. **Short summary:** what changed, what you verified (with the proof), typecheck number.
5. **Stop at the gate** if the task had one, and say what you're waiting for.

Do not write long essays. The person reads fast and prefers evidence over prose.

---

## 6. Never do (hard stops)

- Never store a computed total. Never write `balance += x`.
- Never write to the ledger outside `ledger_append`. Never add ledger tables to the
  `reference_write` whitelist. Never grant `sql:allow-execute`.
- Never use floats for money.
- Never sync absolute stock/balance values — only events.
- Never put English in a user-facing string or a generated PDF/report.
- Never add a dependency, seed fake data, or expand scope without asking.
- Never report something "done" you haven't run/proven.
- Never continue past a gate without explicit approval.
