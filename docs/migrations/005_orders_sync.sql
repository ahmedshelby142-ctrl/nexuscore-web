-- ════════════════════════════════════════════════════════════════════════════
-- Phase 8.5 (final) — the orders table, and the last of the sync clocks
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS ONE IS A CREATE, NOT AN ALTER
--
--   The other tables needed a column. `orders` needs the whole table: it has
--   never existed in Supabase. `useOrderStore` has been calling
--       pushOrQueue(..., "orders", "INSERT", order)
--   against a table that is not there, so every push failed, was swallowed by
--   the catch, and queued for a retry that could never succeed. The realtime
--   handler subscribes to it too, and has been listening to nothing.
--
--   That is why online orders were the one thing that never reached a second
--   device — not a sync bug, a missing table.
--
-- SHAPE
--   Scalars for what gets filtered, sorted and totalled; JSONB for the line
--   arrays, exactly like `return_records` already does with `returned_items`.
--   Storing lines as rows would need a second table and a join for something no
--   query ever slices — the document is read whole or not at all.
--
-- SAFETY
--   Pure creation. `IF NOT EXISTS` throughout, so a re-run is a no-op and
--   nothing existing is touched. RLS matches the Phase 8 role model: the
--   selling roles write orders, the accountant does not.
--
-- HOW TO RUN
--   Supabase dashboard → SQL Editor → paste → Run. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS public.orders (
  id                    TEXT PRIMARY KEY,
  "orderNumber"         TEXT NOT NULL,
  status                TEXT NOT NULL,

  -- Who it is for
  "customerId"          TEXT,
  "customerName"        TEXT NOT NULL,
  "customerPhone"       TEXT NOT NULL,
  governorate           TEXT,
  city                  TEXT,
  address               TEXT,

  -- What is in it. JSONB: read whole, never sliced by a query.
  items                 JSONB NOT NULL DEFAULT '[]'::JSONB,
  "stockItems"          JSONB NOT NULL DEFAULT '[]'::JSONB,

  -- Money. `totalAmount` is already net of any discount (Phase 3).
  "totalAmount"         NUMERIC NOT NULL DEFAULT 0,
  "discountCodeId"      TEXT,
  "discountAmount"      NUMERIC,
  "shippingFee"         NUMERIC NOT NULL DEFAULT 0,
  "depositAmount"       NUMERIC NOT NULL DEFAULT 0,
  "depositWallet"       TEXT,
  "expectedCod"         NUMERIC NOT NULL DEFAULT 0,
  "cogsAmount"          NUMERIC NOT NULL DEFAULT 0,
  "paymentMethod"       TEXT,

  -- Delivery
  "courierName"         TEXT,
  "courierId"           TEXT,
  "courierFee"          NUMERIC,

  -- Lifecycle flags the screens key off
  "revenueLogged"       BOOLEAN NOT NULL DEFAULT FALSE,
  "codSettledAt"        TIMESTAMPTZ,
  "returnConfirmedAt"   TIMESTAMPTZ,
  "returnType"          TEXT,
  "isExchange"          BOOLEAN DEFAULT FALSE,
  original_order_id     TEXT,
  -- Set when an online order was delivered as a wholesale sale (Phase 5.5), so
  -- its return settles against a trader's account instead of refunding cash.
  "wholesaleClientId"   TEXT,

  "createdAt"           TIMESTAMPTZ,
  "updatedAt"           TIMESTAMPTZ,
  -- Epoch ms. THE sync clock — what the inbound pull filters and compares on.
  -- Distinct from "updatedAt" above, which is a timestamp for humans.
  updated_at            BIGINT NOT NULL DEFAULT 0,
  deleted_at            TIMESTAMPTZ,

  store_id              UUID NOT NULL,
  device_id             UUID NOT NULL,
  sync_status           TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_orders_updated_at ON public.orders (updated_at);
CREATE INDEX IF NOT EXISTS idx_orders_store      ON public.orders (store_id);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON public.orders (store_id, status);

-- ── RLS, matching the Phase 8 roles ─────────────────────────────────────────
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- Everyone in the shop can READ orders; the dashboard and reports need them.
DROP POLICY IF EXISTS select_orders ON public.orders;
CREATE POLICY select_orders ON public.orders
  FOR SELECT USING (is_store_member(store_id));

-- Only the roles that actually sell may write one. An ACCOUNTANT reconciles
-- money; they do not take orders.
DROP POLICY IF EXISTS write_orders ON public.orders;
CREATE POLICY write_orders ON public.orders
  FOR ALL
  USING (has_role(store_id, 'ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY'))
  WITH CHECK (has_role(store_id, 'ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY'));

COMMIT;


-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect SEVEN rows, every one bigint / NO.
SELECT table_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  column_name  = 'updated_at'
  AND  table_name IN ('products','customers','suppliers','discount_codes',
                      'return_records','branches','orders')
ORDER  BY table_name;

-- Expect both order policies.
SELECT policyname, cmd FROM pg_policies
WHERE  schemaname = 'public' AND tablename = 'orders'
ORDER  BY policyname;
