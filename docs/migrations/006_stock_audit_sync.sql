-- ════════════════════════════════════════════════════════════════════════════
-- Phase 8.5 (final) — stock audit support, and the RLS the ledger was missing
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHAT A جرد ACTUALLY NEEDS
--
--   Nothing new. An audit is not a document — it is a `stock_adjustment` event
--   in `ledger_events` with `ref_type = 'stock_audit'`, and its corrections are
--   ordinary `stock` and `expense` lines in `ledger_lines`. Both tables already
--   exist and already sync.
--
--   So this migration adds no audit table. Inventing one would create a second
--   place where "what was counted" lives, and the first thing it would do is
--   disagree with the ledger — the exact failure the جرد exists to catch.
--
--   What it DOES add is the indexing that makes the history readable, and the
--   RLS that Phase 8 left unfinished on the ledger itself.
--
-- SAFETY
--   Additive and idempotent. No table is created, altered or dropped; only
--   indexes and policies. Safe to re-run.
--
-- HOW TO RUN
--   Supabase dashboard → SQL Editor → paste → Run.
--   Run 004 and 005 first if you have not — this assumes `has_role()` from 002.

BEGIN;

-- ── 1. Make the audit history readable without a full scan ──────────────────
-- The screen asks for `events({ refType: 'stock_audit' })` on every mount and
-- then filters by date. Unindexed, that walks every event the shop has ever
-- written, which grows without bound.
CREATE INDEX IF NOT EXISTS idx_ledger_events_ref
  ON public.ledger_events (store_id, ref_type, created_at DESC);

-- The جرد, the shortages report and قيمة المخزون all sum stock lines per
-- product. This is the index behind every one of them.
CREATE INDEX IF NOT EXISTS idx_ledger_lines_account_subject
  ON public.ledger_lines (store_id, account, subject_id);

-- Period reports (P&L, the dashboard's windowed figures) filter by kind.
CREATE INDEX IF NOT EXISTS idx_ledger_events_kind
  ON public.ledger_events (store_id, kind, occurred_at DESC);

-- ── 2. Finish the ledger's RLS ──────────────────────────────────────────────
--
-- 002 added role-aware policies to products, suppliers, customers, discounts,
-- branches and return_records, and INSERT policies to the two ledger tables.
-- It did NOT restrict WHO may append. Any store member could write any event,
-- including an ECOMMERCE_ONLY user booking a purchase or a جرد.
--
-- A جرد moves stock AND books shrinkage as an expense, so it is a money write.
-- It belongs to the roles that already own stock and money.

DROP POLICY IF EXISTS insert_ledger_events ON public.ledger_events;
CREATE POLICY insert_ledger_events ON public.ledger_events
  FOR INSERT
  WITH CHECK (
    is_store_member(store_id)
    AND CASE
      -- Stock corrections and buying: ADMIN and the accountant.
      WHEN kind IN ('stock_adjustment', 'purchase', 'supplier_payment')
        THEN has_role(store_id, 'ADMIN', 'ACCOUNTANT')
      -- Money leaving the shop is never a cashier's call.
      WHEN kind IN ('expense', 'payroll', 'owner_draw', 'wallet_transfer')
        THEN has_role(store_id, 'ADMIN', 'ACCOUNTANT')
      -- Selling, returning and settling: the roles that face customers.
      ELSE has_role(store_id, 'ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT')
    END
  );

-- Lines ride with their event; the event's own policy is the gate.
DROP POLICY IF EXISTS insert_ledger_lines ON public.ledger_lines;
CREATE POLICY insert_ledger_lines ON public.ledger_lines
  FOR INSERT WITH CHECK (is_store_member(store_id));

-- ── 3. Append-only, restated ────────────────────────────────────────────────
--
-- There is deliberately NO UPDATE and NO DELETE policy on either table, so both
-- verbs are denied to every role including ADMIN. A mistaken جرد is corrected
-- by running another one, never by editing the first.
--
-- These are belt-and-braces: RLS denies anything without a matching policy, but
-- an explicit FALSE says the omission was a decision, not an oversight.
DROP POLICY IF EXISTS no_update_ledger_events ON public.ledger_events;
CREATE POLICY no_update_ledger_events ON public.ledger_events FOR UPDATE USING (FALSE);

DROP POLICY IF EXISTS no_delete_ledger_events ON public.ledger_events;
CREATE POLICY no_delete_ledger_events ON public.ledger_events FOR DELETE USING (FALSE);

DROP POLICY IF EXISTS no_update_ledger_lines ON public.ledger_lines;
CREATE POLICY no_update_ledger_lines ON public.ledger_lines FOR UPDATE USING (FALSE);

DROP POLICY IF EXISTS no_delete_ledger_lines ON public.ledger_lines;
CREATE POLICY no_delete_ledger_lines ON public.ledger_lines FOR DELETE USING (FALSE);

COMMIT;


-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect the three new indexes.
SELECT indexname FROM pg_indexes
WHERE  schemaname = 'public'
  AND  indexname IN ('idx_ledger_events_ref',
                     'idx_ledger_lines_account_subject',
                     'idx_ledger_events_kind')
ORDER  BY indexname;

-- Expect INSERT allowed and UPDATE/DELETE denied on both ledger tables.
SELECT tablename, policyname, cmd FROM pg_policies
WHERE  schemaname = 'public' AND tablename IN ('ledger_events', 'ledger_lines')
ORDER  BY tablename, cmd, policyname;

-- Expect seven tables carrying the sync clock (004 + 005 must be run first).
SELECT table_name FROM information_schema.columns
WHERE  table_schema = 'public' AND column_name = 'updated_at'
  AND  table_name IN ('products','customers','suppliers','discount_codes',
                      'return_records','branches','orders')
ORDER  BY table_name;
