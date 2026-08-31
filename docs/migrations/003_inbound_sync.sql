-- ════════════════════════════════════════════════════════════════════════════
-- Phase 8.5 — customers.updated_at, so the inbound pull can find them
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHY
--   The catch-up pull asks each table "what changed since X" with
--       .gt('updated_at', watermark)
--   `products` has that column. `customers` does not — it was created with only
--   a `deleted_at` tombstone. So a delta pull on customers would fail outright
--   with "column customers.updated_at does not exist", which is the real reason
--   the inbound path was never wired for it.
--
--   The column is also what makes last-write-wins possible at all. Without a
--   timestamp on both sides there is no way to ask whose copy is newer, and the
--   merge has to either always take the server's (silently undoing local edits)
--   or never take it (no sync).
--
-- SAFETY
--   Additive and idempotent. Adding a nullable BIGINT rewrites no rows and takes
--   only a brief metadata lock, so it is safe on a live database. Existing rows
--   are backfilled to 0 rather than to now(): a real edit on any device then has
--   a higher stamp and wins, instead of every untouched row pretending it was
--   just modified and stampeding over local data on the first pull.
--
-- HOW TO RUN
--   Supabase dashboard → SQL Editor → paste → Run. Re-running is harmless.

BEGIN;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS updated_at BIGINT;

-- 0, not now(). See the note above — this is the difference between a quiet
-- first sync and every device overwriting every other device's customers.
UPDATE public.customers SET updated_at = 0 WHERE updated_at IS NULL;

ALTER TABLE public.customers ALTER COLUMN updated_at SET DEFAULT 0;
ALTER TABLE public.customers ALTER COLUMN updated_at SET NOT NULL;

COMMENT ON COLUMN public.customers.updated_at IS
  'Epoch ms of the last local edit. Drives the inbound delta pull and last-write-wins.';

-- The pull filters on this column every time, on every device.
CREATE INDEX IF NOT EXISTS idx_customers_updated_at
  ON public.customers (updated_at);

-- `products` already carries the column; make sure it is indexed too.
CREATE INDEX IF NOT EXISTS idx_products_updated_at
  ON public.products (updated_at);

COMMIT;


-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect one row: updated_at | bigint | NO
SELECT column_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'customers'
  AND  column_name  = 'updated_at';

-- Expect both indexes present.
SELECT indexname FROM pg_indexes
WHERE  schemaname = 'public'
  AND  indexname IN ('idx_customers_updated_at', 'idx_products_updated_at');
