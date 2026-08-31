-- ════════════════════════════════════════════════════════════════════════════
-- products.metadata — per-variant (درجة/لون) stock in cloud mode
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHY
--   A variant product keeps its stock in `metadata.variants`, e.g.
--       { "variants": [ { "name": "أحمر", "stock": 5 },
--                       { "name": "أزرق", "stock": 3 } ] }
--   `stockMirror` moves the individual درجة and recomputes `totalQuantity` as
--   their sum. The `products` table has a column for the SUM (`quantity`) but
--   none for the breakdown, so today two devices agree on "8 in stock" and can
--   disagree about which shade those 8 are.
--
--   The app already SENDS `metadata` and simply learns to stop when the server
--   rejects it. Adding this column is therefore the whole fix: no deploy, no
--   client change. The next push after you run this starts carrying variants.
--
-- SAFETY
--   Additive and idempotent. Adding a nullable JSONB column rewrites no rows
--   and takes only a brief metadata lock, so it is safe on a live database.
--   Existing rows get NULL, which the client reads as "no variants recorded" —
--   the same thing they mean today. Nothing is dropped, renamed, or backfilled,
--   so an older client that knows nothing about this column keeps working.
--
-- HOW TO RUN
--   Supabase dashboard → SQL Editor → paste → Run. Re-running is harmless.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS metadata JSONB;

COMMENT ON COLUMN public.products.metadata IS
  'Per-variant stock: {"variants":[{"name":"أحمر","stock":5}]}. Maintained by lib/stockMirror; quantity stays the sum.';


-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect exactly one row: metadata | jsonb | YES
SELECT column_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'products'
  AND  column_name  = 'metadata';
