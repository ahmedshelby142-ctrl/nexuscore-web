-- ============================================================================
-- 012 — close the `orders` schema drift
--
-- ALREADY APPLIED to the live project (oczgqpxeixlrufvevitz). Kept here so the
-- repo's migration history matches the database and so
-- `scripts/check_cloud_schema.mjs` can verify the declared columns exist.
--
-- WHAT WAS BROKEN
-- ---------------
-- `orders` was missing 14 of the 37 columns `src/services/api/cloudSchema.ts`
-- declares. One of them was `device_id`, which `toRemoteRow` attaches to EVERY
-- payload — and PostgREST rejects a whole upsert when it names one unknown
-- column. So **every order write failed**, not just the ones using a new field.
--
-- A full drift audit of all eight synced tables was run; `orders` was the only
-- one affected. The other seven match `cloudSchema.ts` exactly.
--
-- Every column below is nullable or defaulted, so existing rows are untouched
-- and no backfill is needed.
-- ============================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS "customerId"         TEXT,
  ADD COLUMN IF NOT EXISTS city                 TEXT,
  ADD COLUMN IF NOT EXISTS "discountCodeId"     TEXT,
  ADD COLUMN IF NOT EXISTS "discountAmount"     NUMERIC     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "depositWallet"      TEXT,
  ADD COLUMN IF NOT EXISTS "codSettledAt"       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "returnConfirmedAt"  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "returnType"         TEXT,
  ADD COLUMN IF NOT EXISTS "isExchange"         BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS original_order_id    TEXT,
  ADD COLUMN IF NOT EXISTS "wholesaleClientId"  TEXT,
  ADD COLUMN IF NOT EXISTS device_id            UUID,
  ADD COLUMN IF NOT EXISTS sync_status          TEXT        NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS deleted_at           TIMESTAMPTZ;

-- `cloudList` filters on `deleted_at`; the customer screen looks orders up by
-- customer. Both were unindexed because the columns did not exist. The missing
-- `deleted_at` is also what made every boot log a 400 on the orders read.
CREATE INDEX IF NOT EXISTS orders_customer_idx ON public.orders (store_id, "customerId");
CREATE INDEX IF NOT EXISTS orders_updated_idx  ON public.orders (store_id, updated_at);

-- ── The status enum ─────────────────────────────────────────────────────────
-- The app has an "إلغاء الطلب" action writing status='cancelled'
-- (src/components/ecommerce/OrdersPage.tsx), but the CHECK constraint listed
-- only pending/shipped/delivered/returned — so every cancellation was refused
-- by Postgres.
--
-- Widening a CHECK cannot invalidate an existing row, so this is safe on live
-- data. The four original values are preserved exactly.
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS "orders_status_check";
ALTER TABLE public.orders ADD CONSTRAINT "orders_status_check"
  CHECK (status = ANY (ARRAY['pending','shipped','delivered','returned','cancelled']));
