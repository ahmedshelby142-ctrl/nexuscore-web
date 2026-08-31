-- ============================================================================
-- 013 — scope expenses & transactions to a store (SECURITY)
--
-- ALREADY APPLIED to the live project. Kept here so the repo's migration
-- history matches the database and `scripts/check_cloud_schema.mjs` can verify
-- the declared columns exist.
--
-- WHAT WAS BROKEN
-- ---------------
-- Both tables carried exactly one policy:
--
--     FOR ALL TO public USING (true) WITH CHECK (true)
--
-- `public` includes `anon`, and Supabase grants anon full DML on public-schema
-- tables by default (verified via information_schema.role_table_grants). The
-- anon key ships inside the client bundle and is public by design — so anyone
-- who opened the site could read, insert, update and DELETE every row in both
-- tables.
--
-- Neither table had a `store_id`, so tenant scoping was not even expressible.
--
-- Both were EMPTY (0 rows each, verified) when this ran, so there was no
-- backfill and no risk to existing data.
--
-- Verified after applying: an INSERT as role `anon` is refused with
-- "new row violates row-level security policy".
-- ============================================================================

-- ── Base tables ─────────────────────────────────────────────────────────────
-- These two were created outside docs/migrations (in the original Supabase
-- migration), so this repo could not provision them from scratch. Declared
-- here, idempotently, so `docs/migrations/` is self-sufficient and
-- `scripts/check_cloud_schema.mjs` can verify every declared column.
CREATE TABLE IF NOT EXISTS public.expenses (
  id          TEXT PRIMARY KEY,
  category    TEXT        NOT NULL DEFAULT 'other',
  amount      NUMERIC     NOT NULL DEFAULT 0,
  description TEXT,
  date        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The common synced-table columns. Declared here so a fresh provision gets
  -- the final shape in one step; the ALTERs below migrate an existing install.
  store_id    UUID,
  device_id   UUID,
  sync_status TEXT        NOT NULL DEFAULT 'pending',
  deleted_at  TIMESTAMPTZ,
  updated_at  BIGINT      DEFAULT ((EXTRACT(epoch FROM now()) * 1000))::bigint
);

CREATE TABLE IF NOT EXISTS public.transactions (
  id          TEXT PRIMARY KEY,
  type        TEXT,
  amount      NUMERIC,
  "timestamp" TIMESTAMPTZ,
  "partnerId" TEXT,
  category    TEXT,
  description TEXT,
  store_id    UUID,
  device_id   UUID,
  sync_status TEXT        NOT NULL DEFAULT 'pending',
  deleted_at  TIMESTAMPTZ,
  updated_at  BIGINT      DEFAULT ((EXTRACT(epoch FROM now()) * 1000))::bigint
);

ALTER TABLE public.expenses     ADD COLUMN IF NOT EXISTS store_id UUID;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS store_id UUID;

-- The columns every other synced table carries. `device_id` is what Realtime's
-- echo check reads; `deleted_at` is what cloudList filters on — without it
-- every boot pays a 400 and a fallback re-read, as `orders` used to.
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS device_id   UUID,
  ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS device_id   UUID,
  ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS expenses_store_idx     ON public.expenses (store_id);
CREATE INDEX IF NOT EXISTS transactions_store_idx ON public.transactions (store_id);

ALTER TABLE public.expenses     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow full access to expenses"     ON public.expenses;
DROP POLICY IF EXISTS "Allow full access to transactions" ON public.transactions;

-- Reads: any member of the store. Writes: ADMIN/ACCOUNTANT — matching
-- `suppliers` and the ledger's own INSERT policy for financial event kinds.
DROP POLICY IF EXISTS select_expenses ON public.expenses;
CREATE POLICY select_expenses ON public.expenses
  FOR SELECT USING (is_store_member(store_id));
DROP POLICY IF EXISTS write_expenses ON public.expenses;
CREATE POLICY write_expenses ON public.expenses
  FOR ALL
  USING      (has_role(store_id, VARIADIC ARRAY['ADMIN','ACCOUNTANT']))
  WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN','ACCOUNTANT']));

DROP POLICY IF EXISTS select_transactions ON public.transactions;
CREATE POLICY select_transactions ON public.transactions
  FOR SELECT USING (is_store_member(store_id));
DROP POLICY IF EXISTS write_transactions ON public.transactions;
CREATE POLICY write_transactions ON public.transactions
  FOR ALL
  USING      (has_role(store_id, VARIADIC ARRAY['ADMIN','ACCOUNTANT']))
  WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN','ACCOUNTANT']));
