-- ════════════════════════════════════════════════════════════════════════════
-- Phase 8.5 (final) — updated_at on every remaining synced table
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHY
--   003 gave `customers` the epoch-ms clock the inbound pull needs. These four
--   still lack it, so `fetchChanges` would fail on each with
--       column "updated_at" does not exist
--   and the delta pull could never run for them:
--
--       suppliers        has "updatedAt" TIMESTAMPTZ — a DIFFERENT column
--       discount_codes   nothing
--       return_records   nothing
--       branches         nothing
--
--   Note `suppliers."updatedAt"`: quoted camelCase, timestamp-typed, and NOT
--   what the sync layer reads. It is left exactly as it is — some client may
--   still write it — and the new `updated_at` sits alongside as the sync clock.
--   Two columns is the honest answer here; silently repurposing a human-facing
--   timestamp as a sync watermark is how the two drift into disagreeing.
--
-- SAFETY
--   Additive and idempotent, like 003. A nullable BIGINT rewrites no rows and
--   takes only a brief metadata lock, so it is safe on a live database.
--
--   Backfilled to 0, NOT now(). Stamping every existing row as "just modified"
--   would make untouched server rows beat real local edits on the first pull —
--   every device stampeding over every other device's data, once, permanently.
--   At 0 any genuine edit on any device wins, which is what you want.
--
-- HOW TO RUN
--   Supabase dashboard → SQL Editor → paste → Run. Re-running is harmless.

BEGIN;

-- ── suppliers ───────────────────────────────────────────────────────────────
ALTER TABLE public.suppliers      ADD COLUMN IF NOT EXISTS updated_at BIGINT;
UPDATE      public.suppliers      SET updated_at = 0 WHERE updated_at IS NULL;
ALTER TABLE public.suppliers      ALTER COLUMN updated_at SET DEFAULT 0;
ALTER TABLE public.suppliers      ALTER COLUMN updated_at SET NOT NULL;

-- ── discount_codes ──────────────────────────────────────────────────────────
ALTER TABLE public.discount_codes ADD COLUMN IF NOT EXISTS updated_at BIGINT;
UPDATE      public.discount_codes SET updated_at = 0 WHERE updated_at IS NULL;
ALTER TABLE public.discount_codes ALTER COLUMN updated_at SET DEFAULT 0;
ALTER TABLE public.discount_codes ALTER COLUMN updated_at SET NOT NULL;

-- ── return_records ──────────────────────────────────────────────────────────
ALTER TABLE public.return_records ADD COLUMN IF NOT EXISTS updated_at BIGINT;
UPDATE      public.return_records SET updated_at = 0 WHERE updated_at IS NULL;
ALTER TABLE public.return_records ALTER COLUMN updated_at SET DEFAULT 0;
ALTER TABLE public.return_records ALTER COLUMN updated_at SET NOT NULL;

-- ── branches ────────────────────────────────────────────────────────────────
ALTER TABLE public.branches       ADD COLUMN IF NOT EXISTS updated_at BIGINT;
UPDATE      public.branches       SET updated_at = 0 WHERE updated_at IS NULL;
ALTER TABLE public.branches       ALTER COLUMN updated_at SET DEFAULT 0;
ALTER TABLE public.branches       ALTER COLUMN updated_at SET NOT NULL;

-- ── the pull filters on this column on every device, every time ─────────────
CREATE INDEX IF NOT EXISTS idx_suppliers_updated_at      ON public.suppliers      (updated_at);
CREATE INDEX IF NOT EXISTS idx_discount_codes_updated_at ON public.discount_codes (updated_at);
CREATE INDEX IF NOT EXISTS idx_return_records_updated_at ON public.return_records (updated_at);
CREATE INDEX IF NOT EXISTS idx_branches_updated_at       ON public.branches       (updated_at);

COMMENT ON COLUMN public.suppliers.updated_at IS
  'Epoch ms of the last local edit — the sync clock. Distinct from "updatedAt".';
COMMENT ON COLUMN public.discount_codes.updated_at IS 'Epoch ms of the last local edit — the sync clock.';
COMMENT ON COLUMN public.return_records.updated_at IS 'Epoch ms of the last local edit — the sync clock.';
COMMENT ON COLUMN public.branches.updated_at IS       'Epoch ms of the last local edit — the sync clock.';

COMMIT;


-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect SIX rows, every one bigint / NO. (products and customers came from
-- the base schema and 003; these four are new.)
SELECT table_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  column_name  = 'updated_at'
  AND  table_name IN ('products','customers','suppliers','discount_codes','return_records','branches')
ORDER  BY table_name;

-- Expect six indexes.
SELECT indexname FROM pg_indexes
WHERE  schemaname = 'public' AND indexname LIKE 'idx_%_updated_at'
ORDER  BY indexname;
