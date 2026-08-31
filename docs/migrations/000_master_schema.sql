-- ════════════════════════════════════════════════════════════════════════════
--  NexusCore — MASTER SCHEMA
--  One idempotent script. Provisions a fresh database, or brings an existing
--  one fully up to date. Safe to run any number of times.
-- ════════════════════════════════════════════════════════════════════════════
--
--  Supersedes 002 → 006. Running it after them is a no-op; running it INSTEAD
--  of them on a fresh project gives the same result.
--
--  ── Two deviations from the brief, both deliberate ─────────────────────────
--
--  1. `store_id` is UUID, not TEXT.
--
--     Every RLS helper is declared `is_store_member(p_store_id UUID)`,
--     `has_role(p_store_id UUID, ...)`, and every policy calls them with the
--     column. Postgres has no implicit TEXT → UUID cast, so a TEXT `store_id`
--     makes every policy fail to create — and on a live database it would also
--     break `store_members.store_id`, which is a real UUID foreign key.
--     TEXT here would not harden the schema, it would disable its security.
--
--  2. There is no `user_roles` table, and this does not create one.
--
--     Roles live on `store_members.role`, which is what `has_role()` reads and
--     what Phase 8's RBAC was built against. A second roles table would be a
--     second answer to "what may this user do" — the exact class of drift this
--     codebase has spent every phase removing.
--
--  ── What this covers ───────────────────────────────────────────────────────
--
--     tenancy      stores, store_members
--     auth         users, auth_sessions, auth_login_attempts, profiles
--     sync         products, customers, suppliers, discount_codes,
--                  return_records, branches, orders
--     ledger       ledger_events, ledger_lines  (indexes + append-only RLS)
--
--  ── What this deliberately does NOT create ─────────────────────────────────
--
--     wallets, expenses, stock_logs, wallet_transfers, courier_financials,
--     audit_sessions, audit_discrepancies, online_orders
--       → referenced only by `lib/api/financial.server.ts` and
--         `integrations.server.ts`, an Express/Nest layer that is NOT deployed
--         (the Integrations screen still tells you to deploy it). Worse,
--         `wallets` / `expenses` / `stock_logs` are the PRE-LEDGER model the
--         ledger replaced. Creating them would invite a second set of money
--         numbers to drift from the ledger's.
--
--     licenses, license_audit, integrations
--       → `licenseServer.ts` has no caller in the app today, and their column
--         shapes are `select("*")` / `upsert(...)`, so any schema written here
--         would be a guess. A guessed table is how you get the "column does not
--         exist" error this script exists to eliminate. Ask and I will add them
--         once their shape is settled.
--
--  ── How to run ─────────────────────────────────────────────────────────────
--     Supabase dashboard → SQL Editor → paste the whole file → Run.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. TENANCY
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.stores (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL DEFAULT 'محلي',
  logo_url      TEXT,
  phone         TEXT,
  address       TEXT,
  tax_number    TEXT,
  vat_rate      NUMERIC NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The settings screen writes these; older projects may predate them.
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS logo_url   TEXT;
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS phone      TEXT;
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS address    TEXT;
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS tax_number TEXT;
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS vat_rate   NUMERIC NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.store_members (
  user_id   UUID NOT NULL,
  store_id  UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'ECOMMERCE_ONLY',
  PRIMARY KEY (user_id, store_id)
);

-- Legacy role values → the fixed four, BEFORE the constraint is added.
--
-- The original init script seeds `role = 'owner'`, so on any existing project
-- adding the CHECK straight away fails with a constraint violation and takes
-- the whole migration with it. These are the same mappings `toAppRole()` uses
-- in `lib/roles.ts`, so the database and the client agree on what a legacy
-- value means rather than each deciding for itself.
--
-- `branch_manager` deliberately lands on ACCOUNTANT, not ADMIN: it used to
-- project onto a full owner, which meant anyone holding it could grant
-- themselves anything.
UPDATE public.store_members SET role = CASE role
    WHEN 'owner'              THEN 'ADMIN'
    WHEN 'OWNER'              THEN 'ADMIN'
    WHEN 'MANAGER'            THEN 'ADMIN'
    WHEN 'cashier'            THEN 'POS_ECOMMERCE'
    WHEN 'cashier_data_entry' THEN 'POS_ECOMMERCE'
    WHEN 'CASHIER'            THEN 'POS_ECOMMERCE'
    WHEN 'data_entry'         THEN 'ECOMMERCE_ONLY'
    WHEN 'VIEWER'             THEN 'ECOMMERCE_ONLY'
    WHEN 'viewer'             THEN 'ECOMMERCE_ONLY'
    WHEN 'customer_support'   THEN 'ECOMMERCE_ONLY'
    WHEN 'branch_manager'     THEN 'ACCOUNTANT'
    WHEN 'inventory_clerk'    THEN 'ACCOUNTANT'
    WHEN 'accountant'         THEN 'ACCOUNTANT'
    ELSE role
  END
WHERE role NOT IN ('ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT');

-- Anything still unrecognised drops to the LEAST privileged role rather than
-- blocking the migration. A row with a typo in it must not open the safe, and
-- must not stop the deploy either.
UPDATE public.store_members SET role = 'ECOMMERCE_ONLY'
WHERE role NOT IN ('ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT');

-- The four fixed roles. A typo must not silently become an admin.
ALTER TABLE public.store_members DROP CONSTRAINT IF EXISTS store_members_role_check;
ALTER TABLE public.store_members ADD CONSTRAINT store_members_role_check
  CHECK (role IN ('ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT'));


-- ════════════════════════════════════════════════════════════════════════════
-- 2. RLS HELPERS
--    `SECURITY DEFINER` so a member can be checked without being able to read
--    the whole membership table themselves.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.is_store_member(p_store_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.store_members
    WHERE user_id = auth.uid() AND store_id = p_store_id
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.member_role(p_store_id UUID)
RETURNS TEXT AS $$
  SELECT role FROM public.store_members
  WHERE user_id = auth.uid() AND store_id = p_store_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.has_role(p_store_id UUID, VARIADIC p_roles TEXT[])
RETURNS BOOLEAN AS $$
  SELECT public.member_role(p_store_id) = ANY(p_roles);
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. AUTH
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username              TEXT NOT NULL UNIQUE,
  password_hash         TEXT,
  role                  TEXT NOT NULL DEFAULT 'ECOMMERCE_ONLY',
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password  BOOLEAN NOT NULL DEFAULT FALSE,
  store_id              UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_active            BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS store_id             UUID;

-- ── auth_sessions ───────────────────────────────────────────────────────────
-- Shape matches what `authServer.ts` actually writes: token, user_id, username,
-- role, machine_id, expires_at, revoked, revoked_at.
CREATE TABLE IF NOT EXISTS public.auth_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  username    TEXT,
  role        TEXT,
  machine_id  TEXT,
  token       TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at  TIMESTAMPTZ,
  ip_address  TEXT,
  user_agent  TEXT
);
-- Every column the app or this script names, added explicitly.
--
-- `CREATE TABLE IF NOT EXISTS` does NOTHING to a table that already exists, so
-- on a project provisioned from the original init script the block above is
-- skipped entirely and these ALTERs are the only lines that actually run.
-- Without them, anything referencing these columns aborts the migration.
ALTER TABLE public.auth_sessions ADD COLUMN IF NOT EXISTS username   TEXT;
ALTER TABLE public.auth_sessions ADD COLUMN IF NOT EXISTS role       TEXT;
ALTER TABLE public.auth_sessions ADD COLUMN IF NOT EXISTS machine_id TEXT;
ALTER TABLE public.auth_sessions ADD COLUMN IF NOT EXISTS revoked    BOOLEAN DEFAULT FALSE;
ALTER TABLE public.auth_sessions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE public.auth_sessions ADD COLUMN IF NOT EXISTS ip_address TEXT;
ALTER TABLE public.auth_sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;


-- ── auth_login_attempts ─────────────────────────────────────────────────────
-- The time column is `"timestamp"`, NOT `attempted_at`, and the flag is
-- `success`, NOT `succeeded`.
--
-- An earlier draft of this script invented both names and then indexed
-- `attempted_at`. On a fresh database that worked. On a real one the table
-- already existed, `CREATE TABLE IF NOT EXISTS` skipped it, the invented
-- columns were never added, and the whole migration aborted on
--     ERROR 42703: column "attempted_at" does not exist
--
-- These names are what `authServer.ts` actually inserts: username, machine_id,
-- success, reason.
CREATE TABLE IF NOT EXISTS public.auth_login_attempts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT now(),
  username    TEXT NOT NULL,
  machine_id  TEXT,
  ip_address  TEXT,
  success     BOOLEAN NOT NULL DEFAULT FALSE,
  reason      TEXT,
  user_agent  TEXT
);
-- Added NULLABLE on purpose: a NOT NULL column cannot be added to a table that
-- already holds rows unless it has a default, and aborting a whole migration
-- over an audit-log column would be absurd.
ALTER TABLE public.auth_login_attempts ADD COLUMN IF NOT EXISTS "timestamp" TIMESTAMPTZ DEFAULT now();
ALTER TABLE public.auth_login_attempts ADD COLUMN IF NOT EXISTS machine_id  TEXT;
ALTER TABLE public.auth_login_attempts ADD COLUMN IF NOT EXISTS ip_address  TEXT;
ALTER TABLE public.auth_login_attempts ADD COLUMN IF NOT EXISTS success     BOOLEAN DEFAULT FALSE;
ALTER TABLE public.auth_login_attempts ADD COLUMN IF NOT EXISTS reason      TEXT;
ALTER TABLE public.auth_login_attempts ADD COLUMN IF NOT EXISTS user_agent  TEXT;


-- Read by `useSubscriptionStore`.
CREATE TABLE IF NOT EXISTS public.profiles (
  id                  UUID PRIMARY KEY,
  is_pro              BOOLEAN NOT NULL DEFAULT FALSE,
  subscription_expiry TIMESTAMPTZ
);

-- ════════════════════════════════════════════════════════════════════════════
-- 4. SYNCED BUSINESS TABLES
--    Created only if absent. Section 6 then guarantees `store_id`,
--    `updated_at` and the indexes on ALL of them, existing or fresh.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.products (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  sku             TEXT NOT NULL DEFAULT '',
  barcode         TEXT,
  category        TEXT NOT NULL DEFAULT '',
  description     TEXT,
  image_url       TEXT,
  quantity        NUMERIC NOT NULL DEFAULT 0,
  "unitPrice"     NUMERIC NOT NULL DEFAULT 0,
  wholesale_price NUMERIC NOT NULL DEFAULT 0,
  "minStockLevel" NUMERIC,
  "maxStockLevel" NUMERIC,
  "isActive"      BOOLEAN DEFAULT TRUE,
  "isBundle"      BOOLEAN DEFAULT FALSE,
  "bundleItems"   JSONB DEFAULT '[]'::JSONB,
  metadata        JSONB,
  deleted_at      BIGINT,
  device_id       UUID,
  sync_status     TEXT NOT NULL DEFAULT 'pending'
);
-- Per-variant (درجة/لون) stock. Without it a variant shop syncs only totals.
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS metadata JSONB;

CREATE TABLE IF NOT EXISTS public.customers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  -- How many orders this person has sent back. Drives the double-shipping
  -- penalty on their future orders — see `shippingFeeFor` in lib/shippingRates.
  returned_orders_count INTEGER NOT NULL DEFAULT 0,
  device_id   UUID,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  deleted_at  TIMESTAMPTZ
);
-- Existing projects: add it and start everyone at zero. Nobody is penalised for
-- a return the shop recorded before it had anywhere to count it.
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS returned_orders_count INTEGER;
UPDATE public.customers SET returned_orders_count = 0 WHERE returned_orders_count IS NULL;
ALTER TABLE public.customers ALTER COLUMN returned_orders_count SET DEFAULT 0;
ALTER TABLE public.customers ALTER COLUMN returned_orders_count SET NOT NULL;

CREATE TABLE IF NOT EXISTS public.suppliers (
  id              TEXT PRIMARY KEY,
  "companyName"   TEXT NOT NULL,
  "contactPerson" TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  email           TEXT,
  address         TEXT,
  "taxId"         TEXT,
  notes           TEXT,
  "createdAt"     TIMESTAMPTZ,
  "updatedAt"     TIMESTAMPTZ,
  device_id       UUID,
  sync_status     TEXT NOT NULL DEFAULT 'pending',
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.discount_codes (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL,
  type         TEXT NOT NULL,
  value        NUMERIC NOT NULL DEFAULT 0,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  "maxUses"    NUMERIC,
  "expiryDate" TIMESTAMPTZ,
  "createdAt"  TIMESTAMPTZ,
  device_id    UUID,
  sync_status  TEXT NOT NULL DEFAULT 'pending',
  deleted_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.return_records (
  id                   TEXT PRIMARY KEY,
  original_order_id    TEXT NOT NULL DEFAULT '',
  type                 TEXT NOT NULL,
  customer_name        TEXT NOT NULL DEFAULT '',
  customer_phone       TEXT NOT NULL DEFAULT '',
  governorate          TEXT NOT NULL DEFAULT '',
  returned_items       JSONB NOT NULL DEFAULT '[]'::JSONB,
  exchanged_item       JSONB,
  pending_replacement  JSONB,
  financial_difference NUMERIC NOT NULL DEFAULT 0,
  processed_by         TEXT NOT NULL DEFAULT '',
  notes                TEXT,
  created_at           TIMESTAMPTZ,
  device_id            UUID,
  sync_status          TEXT NOT NULL DEFAULT 'pending',
  deleted_at           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.branches (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  code        TEXT NOT NULL DEFAULT '',
  address     TEXT,
  phone       TEXT,
  "isActive"  BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT now(),
  device_id   UUID,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  deleted_at  TIMESTAMPTZ
);

-- ── orders ──────────────────────────────────────────────────────────────────
-- This table has NEVER existed. `useOrderStore` pushes to it on every write, so
-- every one of those pushes has been failing and re-queueing forever. That is
-- why online orders were the one thing that never reached a second device.
CREATE TABLE IF NOT EXISTS public.orders (
  id                  TEXT PRIMARY KEY,
  "orderNumber"       TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',

  "customerId"        TEXT,
  "customerName"      TEXT NOT NULL DEFAULT '',
  "customerPhone"     TEXT NOT NULL DEFAULT '',
  governorate         TEXT,
  city                TEXT,
  address             TEXT,

  -- Read whole, never sliced by a query — same choice `return_records` makes.
  items               JSONB NOT NULL DEFAULT '[]'::JSONB,
  "stockItems"        JSONB NOT NULL DEFAULT '[]'::JSONB,

  -- `totalAmount` is already net of any discount (Phase 3).
  "totalAmount"       NUMERIC NOT NULL DEFAULT 0,
  "discountCodeId"    TEXT,
  "discountAmount"    NUMERIC,
  "shippingFee"       NUMERIC NOT NULL DEFAULT 0,
  "depositAmount"     NUMERIC NOT NULL DEFAULT 0,
  "depositWallet"     TEXT,
  "expectedCod"       NUMERIC NOT NULL DEFAULT 0,
  "cogsAmount"        NUMERIC NOT NULL DEFAULT 0,
  "paymentMethod"     TEXT,

  "courierName"       TEXT,
  "courierId"         TEXT,
  "courierFee"        NUMERIC,

  "revenueLogged"     BOOLEAN NOT NULL DEFAULT FALSE,
  "codSettledAt"      TIMESTAMPTZ,
  "returnConfirmedAt" TIMESTAMPTZ,
  "returnType"        TEXT,
  "isExchange"        BOOLEAN DEFAULT FALSE,
  original_order_id   TEXT,
  -- Set when an online order was delivered as a wholesale sale, so its return
  -- settles against a trader's account instead of refunding cash.
  "wholesaleClientId" TEXT,

  "createdAt"         TIMESTAMPTZ,
  "updatedAt"         TIMESTAMPTZ,
  device_id           UUID,
  sync_status         TEXT NOT NULL DEFAULT 'pending',
  deleted_at          TIMESTAMPTZ
);


-- ════════════════════════════════════════════════════════════════════════════
-- 5. THE LEDGER
--    Append-only. Every money and stock number in the app is a SUM over these.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ledger_events (
  id          UUID PRIMARY KEY,
  store_id    UUID NOT NULL,
  device_id   UUID,
  kind        TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT,
  ref_type    TEXT,
  ref_id      TEXT,
  payload     JSONB,
  reversed_by UUID,
  sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS public.ledger_lines (
  id          UUID PRIMARY KEY,
  event_id    UUID NOT NULL REFERENCES public.ledger_events(id) ON DELETE RESTRICT,
  store_id    UUID NOT NULL,
  account     TEXT NOT NULL,
  subject_id  TEXT NOT NULL DEFAULT '',
  -- Integer piastres. Floats never touch this column.
  amount      BIGINT NOT NULL DEFAULT 0,
  qty         NUMERIC NOT NULL DEFAULT 0,
  unit_cost   BIGINT,
  sync_status TEXT NOT NULL DEFAULT 'pending'
);

-- The three reads every screen makes.

-- ════════════════════════════════════════════════════════════════════════════
-- 6. THE PATCH LOOP  ← this is what makes "column does not exist" impossible
--
--    Runs over every synced table, whether it was just created above or has
--    existed since the first deploy, and guarantees:
--        store_id    UUID                        + index
--        updated_at  BIGINT NOT NULL DEFAULT 0   + index
--
--    `to_regclass` skips a table that is genuinely absent instead of throwing,
--    so this is safe even if a name here is not in your project.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  t          TEXT;
  null_count BIGINT;
  tables     TEXT[] := ARRAY[
    'products', 'customers', 'suppliers', 'discount_codes',
    'return_records', 'branches', 'orders'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'skipping %, table not present', t;
      CONTINUE;
    END IF;

    -- ── store_id ────────────────────────────────────────────────────────────
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS store_id UUID', t);

    -- NOT NULL only when nothing would break. A pre-tenancy table with legacy
    -- rows keeps them nullable rather than failing the whole migration; those
    -- rows are invisible to RLS anyway, which fails shut, which is correct.
    EXECUTE format('SELECT count(*) FROM public.%I WHERE store_id IS NULL', t)
      INTO null_count;
    IF null_count = 0 THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN store_id SET NOT NULL', t);
    ELSE
      RAISE NOTICE '% has % row(s) with no store_id — left nullable', t, null_count;
    END IF;

    -- ── updated_at ──────────────────────────────────────────────────────────
    -- Backfilled to 0, never now(): stamping untouched rows as "just modified"
    -- would make every one of them beat a real local edit on the first pull,
    -- and every device would stampede over every other device's data, once.
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS updated_at BIGINT', t);
    EXECUTE format('UPDATE public.%I SET updated_at = 0 WHERE updated_at IS NULL', t);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN updated_at SET DEFAULT 0', t);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN updated_at SET NOT NULL', t);

    -- ── the two indexes every sync query uses ───────────────────────────────
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_%s_updated_at ON public.%I (updated_at)', t, t);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_%s_store ON public.%I (store_id)', t, t);
  END LOOP;
END $$;


-- ════════════════════════════════════════════════════════════════════════════
-- 6b. INDEXES — created last, and only where their columns exist
--
--    Every index lives here rather than beside its table, for two reasons.
--
--    ORDER. `idx_orders_status` covers `(store_id, status)`, but `store_id` is
--    added to `orders` by the patch loop above. Beside the table it would run
--    BEFORE that column existed and abort a fresh install.
--
--    SHAPE. `CREATE TABLE IF NOT EXISTS` does nothing to a table that already
--    exists, so on a live project a column named here may simply not be there.
--    That is exactly how this script once died on
--        ERROR 42703: column "attempted_at" does not exist
--    A missing column now SKIPS its index with a notice instead of destroying
--    the migration — an index is an optimisation, never a reason to fail.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION __ensure_index(
  p_index TEXT, p_table TEXT, p_cols TEXT, p_required TEXT[]
) RETURNS VOID AS $fn$
DECLARE c TEXT;
BEGIN
  IF to_regclass('public.' || p_table) IS NULL THEN
    RAISE NOTICE 'skip index % — table % not present', p_index, p_table;
    RETURN;
  END IF;
  FOREACH c IN ARRAY p_required LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = p_table AND column_name = c
    ) THEN
      RAISE NOTICE 'skip index % — %.% not present', p_index, p_table, c;
      RETURN;
    END IF;
  END LOOP;
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (%s)', p_index, p_table, p_cols);
END;
$fn$ LANGUAGE plpgsql;

DO $$
BEGIN
  PERFORM __ensure_index('idx_store_members_user', 'store_members', 'user_id', ARRAY['user_id']);
  PERFORM __ensure_index('idx_auth_sessions_token', 'auth_sessions', 'token', ARRAY['token']);
  PERFORM __ensure_index('idx_auth_sessions_user', 'auth_sessions', 'user_id', ARRAY['user_id']);
  PERFORM __ensure_index('idx_login_attempts_user', 'auth_login_attempts', 'username, "timestamp" DESC', ARRAY['username', 'timestamp']);
  PERFORM __ensure_index('idx_orders_status', 'orders', 'store_id, status', ARRAY['store_id', 'status']);
  PERFORM __ensure_index('idx_ledger_events_ref', 'ledger_events', 'store_id, ref_type, created_at DESC', ARRAY['store_id', 'ref_type', 'created_at']);
  PERFORM __ensure_index('idx_ledger_events_kind', 'ledger_events', 'store_id, kind, occurred_at DESC', ARRAY['store_id', 'kind', 'occurred_at']);
  PERFORM __ensure_index('idx_ledger_lines_account_subject', 'ledger_lines', 'store_id, account, subject_id', ARRAY['store_id', 'account', 'subject_id']);
  PERFORM __ensure_index('idx_ledger_lines_event', 'ledger_lines', 'event_id', ARRAY['event_id']);
END $$;

DROP FUNCTION IF EXISTS __ensure_index(TEXT, TEXT, TEXT, TEXT[]);

-- ════════════════════════════════════════════════════════════════════════════
-- 7. ROW LEVEL SECURITY
--    The client guards in `lib/roles.ts` decide what to DRAW. This decides what
--    a user may actually read and write. Anyone with dev tools can defeat the
--    first; only this one is a security boundary.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.stores         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suppliers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discount_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.return_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_lines   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles       ENABLE ROW LEVEL SECURITY;

-- ── read: any member of the store ───────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['products','customers','suppliers','discount_codes',
                           'return_records','branches','orders',
                           'ledger_events','ledger_lines'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP POLICY IF EXISTS select_%s ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY select_%s ON public.%I FOR SELECT USING (is_store_member(store_id))', t, t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS select_stores ON public.stores;
CREATE POLICY select_stores ON public.stores FOR SELECT USING (is_store_member(id));

DROP POLICY IF EXISTS update_stores ON public.stores;
CREATE POLICY update_stores ON public.stores
  FOR UPDATE USING (has_role(id, 'ADMIN')) WITH CHECK (has_role(id, 'ADMIN'));

DROP POLICY IF EXISTS select_store_members ON public.store_members;
CREATE POLICY select_store_members ON public.store_members
  FOR SELECT USING (is_store_member(store_id));

-- Only an ADMIN grants or changes a role. Without this, any member could
-- promote themselves and the whole role model would be decoration.
DROP POLICY IF EXISTS write_store_members ON public.store_members;
CREATE POLICY write_store_members ON public.store_members
  FOR ALL USING (has_role(store_id, 'ADMIN')) WITH CHECK (has_role(store_id, 'ADMIN'));

DROP POLICY IF EXISTS own_profile ON public.profiles;
CREATE POLICY own_profile ON public.profiles FOR SELECT USING (id = auth.uid());

-- ── write: by role ──────────────────────────────────────────────────────────
-- Catalogue and money-reference data belong to ADMIN and the accountant.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['products','suppliers','branches'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP POLICY IF EXISTS write_%s ON public.%I', t, t);
    EXECUTE format($f$
      CREATE POLICY write_%s ON public.%I FOR ALL
        USING (has_role(store_id, 'ADMIN', 'ACCOUNTANT'))
        WITH CHECK (has_role(store_id, 'ADMIN', 'ACCOUNTANT'))
    $f$, t, t);
  END LOOP;
END $$;

-- Customer-facing records: the roles that actually serve customers.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers','discount_codes','return_records','orders'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP POLICY IF EXISTS write_%s ON public.%I', t, t);
    EXECUTE format($f$
      CREATE POLICY write_%s ON public.%I FOR ALL
        USING (has_role(store_id, 'ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY'))
        WITH CHECK (has_role(store_id, 'ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY'))
    $f$, t, t);
  END LOOP;
END $$;

-- ── the ledger: append-only, and who may append what ────────────────────────
DROP POLICY IF EXISTS insert_ledger_events ON public.ledger_events;
CREATE POLICY insert_ledger_events ON public.ledger_events
  FOR INSERT WITH CHECK (
    is_store_member(store_id)
    AND CASE
      -- Stock corrections and buying.
      WHEN kind IN ('stock_adjustment', 'purchase', 'supplier_payment')
        THEN has_role(store_id, 'ADMIN', 'ACCOUNTANT')
      -- Money leaving the shop is never a cashier's call.
      WHEN kind IN ('expense', 'payroll', 'owner_draw', 'wallet_transfer')
        THEN has_role(store_id, 'ADMIN', 'ACCOUNTANT')
      -- Selling, returning, settling.
      ELSE has_role(store_id, 'ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT')
    END
  );

DROP POLICY IF EXISTS insert_ledger_lines ON public.ledger_lines;
CREATE POLICY insert_ledger_lines ON public.ledger_lines
  FOR INSERT WITH CHECK (is_store_member(store_id));

-- No UPDATE and no DELETE policy exists for either table, so both verbs are
-- denied to EVERY role including ADMIN. A mistaken جرد is corrected by running
-- another one, never by editing history. Stated explicitly so the omission
-- reads as a decision rather than an oversight.
DROP POLICY IF EXISTS no_update_ledger_events ON public.ledger_events;
CREATE POLICY no_update_ledger_events ON public.ledger_events FOR UPDATE USING (FALSE);
DROP POLICY IF EXISTS no_delete_ledger_events ON public.ledger_events;
CREATE POLICY no_delete_ledger_events ON public.ledger_events FOR DELETE USING (FALSE);
DROP POLICY IF EXISTS no_update_ledger_lines ON public.ledger_lines;
CREATE POLICY no_update_ledger_lines ON public.ledger_lines FOR UPDATE USING (FALSE);
DROP POLICY IF EXISTS no_delete_ledger_lines ON public.ledger_lines;
CREATE POLICY no_delete_ledger_lines ON public.ledger_lines FOR DELETE USING (FALSE);

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
--  VERIFY — run these after; every one should return the row count noted.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Expect SEVEN rows, each `bigint | NO`.
SELECT table_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public' AND column_name = 'updated_at'
  AND  table_name IN ('products','customers','suppliers','discount_codes',
                      'return_records','branches','orders')
ORDER  BY table_name;

-- 2. Expect SEVEN rows, each `uuid`. This is the check that fails loudly if a
--    `store_id does not exist` error is still possible anywhere.
SELECT table_name, data_type
FROM   information_schema.columns
WHERE  table_schema = 'public' AND column_name = 'store_id'
  AND  table_name IN ('products','customers','suppliers','discount_codes',
                      'return_records','branches','orders')
ORDER  BY table_name;

-- 2b. Expect one row: returned_orders_count | integer | NO
SELECT column_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public' AND table_name = 'customers'
  AND  column_name = 'returned_orders_count';

-- 2c. Expect ZERO rows. Any row here is a role the CHECK would have rejected.
SELECT DISTINCT role FROM public.store_members
WHERE  role NOT IN ('ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT');

-- 3. Expect 14+ sync indexes (7 × updated_at, 7 × store_id).
SELECT indexname FROM pg_indexes
WHERE  schemaname = 'public'
  AND  (indexname LIKE 'idx_%_updated_at' OR indexname LIKE 'idx_%_store')
ORDER  BY indexname;

-- 4. Expect the four ledger indexes.
SELECT indexname FROM pg_indexes
WHERE  schemaname = 'public' AND indexname LIKE 'idx_ledger_%'
ORDER  BY indexname;

-- 5. Expect INSERT allowed, UPDATE and DELETE present-and-false on both.
SELECT tablename, policyname, cmd FROM pg_policies
WHERE  schemaname = 'public' AND tablename IN ('ledger_events','ledger_lines')
ORDER  BY tablename, cmd;

-- 6. Expect RLS enabled (`t`) on every business table.
SELECT relname, relrowsecurity FROM pg_class
WHERE  relnamespace = 'public'::regnamespace
  AND  relname IN ('stores','store_members','products','customers','suppliers',
                   'discount_codes','return_records','branches','orders',
                   'ledger_events','ledger_lines','profiles')
ORDER  BY relname;
