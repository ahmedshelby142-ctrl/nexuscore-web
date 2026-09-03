-- ============================================================================
-- 016 — wholesale_clients, wholesale_invoices, and race-free document numbers
--
-- Safe to re-run: every statement is idempotent.
--
-- WHY THIS EXISTS
-- ---------------
-- `wholesaleClients` and `wholesaleInvoices` lived in localStorage and nowhere
-- else. The MONEY was always correct — a جملة sale appends `sale` /
-- `client_payment` / `return_confirmed` events and the client's debt is
-- SUM(receivable_client) over `ledger_lines` — but the DOCUMENTS were not:
--
--   * a wholesale client added on the till did not exist on the office machine,
--     and since an invoice cannot be raised without one, شاشة الجملة was
--     unusable on any browser that had not added them by hand;
--   * every FJ- invoice was a receipt on exactly one device, erased by a cache
--     clear while the ledger event describing it survived;
--   * `FJ-<count+1>` counted a per-device array, and OrdersPage used a totally
--     different scheme (`FJ-<last 4 of Date.now()>`), so two devices billing at
--     once produced two FJ-0001s with nothing to stop them.
--
-- This is the same split `purchase_invoices` had before migration 010, closed
-- the same way and with the same shape, so the two document tables stay
-- readable as a pair.
--
-- SHAPE NOTES
-- -----------
--   * `id` is TEXT, matching suppliers/customers/orders — the client mints ids.
--   * Columns are QUOTED camelCase, matching `suppliers` ("companyName") and
--     `purchase_invoices` ("invoiceNumber"). Do NOT snake_case them:
--     `src/services/api/cloudSchema.ts` sends these exact names and PostgREST
--     rejects the whole upsert on one unknown column.
--   * `items` is JSONB, for the reason given in 010: an invoice's lines are
--     only ever read back with their invoice. Aggregate questions are asked of
--     the LEDGER, not of these rows.
-- ============================================================================

-- ── wholesale_clients ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wholesale_clients (
  id              TEXT PRIMARY KEY,
  "companyName"   TEXT        NOT NULL,
  "contactPerson" TEXT        NOT NULL DEFAULT '',
  phone           TEXT        NOT NULL DEFAULT '',
  email           TEXT,
  notes           TEXT,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),

  store_id        UUID        NOT NULL,
  device_id       UUID        NOT NULL,
  sync_status     TEXT        NOT NULL DEFAULT 'pending',
  updated_at      BIGINT      NOT NULL DEFAULT 0,
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS wholesale_clients_store_idx
  ON public.wholesale_clients (store_id);
CREATE INDEX IF NOT EXISTS wholesale_clients_updated_idx
  ON public.wholesale_clients (store_id, updated_at);

-- ── wholesale_invoices ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wholesale_invoices (
  id                TEXT PRIMARY KEY,
  "invoiceNumber"   TEXT        NOT NULL,
  "clientId"        TEXT        NOT NULL,
  "clientName"      TEXT        NOT NULL DEFAULT '',
  items             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Both kept deliberately: the printed فاتورة shows what the goods were and
  -- what came off, and `totalAmount` is what the client actually owes.
  "goodsTotal"      NUMERIC     NOT NULL DEFAULT 0,
  "discountAmount"  NUMERIC     NOT NULL DEFAULT 0,
  "totalAmount"     NUMERIC     NOT NULL DEFAULT 0,
  "paidAmount"      NUMERIC     NOT NULL DEFAULT 0,
  "remainingAmount" NUMERIC     NOT NULL DEFAULT 0,
  "dueDate"         TEXT,
  status            TEXT        NOT NULL DEFAULT 'unpaid',
  notes             TEXT,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),

  store_id          UUID        NOT NULL,
  device_id         UUID        NOT NULL,
  sync_status       TEXT        NOT NULL DEFAULT 'pending',
  updated_at        BIGINT      NOT NULL DEFAULT 0,
  deleted_at        TIMESTAMPTZ,

  CONSTRAINT wholesale_invoices_status_check
    CHECK (status = ANY (ARRAY['paid','partial','unpaid','overdue']))
);

CREATE INDEX IF NOT EXISTS wholesale_invoices_store_idx
  ON public.wholesale_invoices (store_id);
CREATE INDEX IF NOT EXISTS wholesale_invoices_client_idx
  ON public.wholesale_invoices (store_id, "clientId");
CREATE INDEX IF NOT EXISTS wholesale_invoices_updated_idx
  ON public.wholesale_invoices (store_id, updated_at);

-- One invoice number per store. The last line of defence: even if numbering
-- goes wrong, two FJ-0001s cannot both exist — the second insert fails loudly
-- instead of silently creating a duplicate document.
CREATE UNIQUE INDEX IF NOT EXISTS wholesale_invoices_number_per_store
  ON public.wholesale_invoices (store_id, "invoiceNumber");

-- ── Race-free document numbers ──────────────────────────────────────────────
--
-- `FJ-<array length + 1>` is computed from what THIS browser happens to have
-- loaded, so two devices reach the same number, and a device that has not
-- hydrated reaches FJ-0001 again. The unique index above turns that into an
-- error rather than a duplicate, which is correct but hostile: the cashier
-- loses the sale and has to retry.
--
-- A counter row incremented inside one statement removes the race instead of
-- reporting it. INSERT ... ON CONFLICT DO UPDATE ... RETURNING takes a row
-- lock for the duration, so two concurrent callers are serialised by Postgres
-- and get different numbers.
CREATE TABLE IF NOT EXISTS public.store_counters (
  store_id UUID   NOT NULL,
  name     TEXT   NOT NULL,
  value    BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, name)
);

ALTER TABLE public.store_counters ENABLE ROW LEVEL SECURITY;
-- No policy is granted to the client on purpose. The counter is reachable ONLY
-- through the SECURITY DEFINER function below, so nobody can rewind it.

CREATE OR REPLACE FUNCTION public.next_document_number(p_store UUID, p_name TEXT, p_prefix TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
-- Pinned, per the note in migration 014: an unpinned search_path on a
-- SECURITY DEFINER routine lets a caller shadow the objects it references.
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v BIGINT;
BEGIN
  -- The caller may only draw numbers for a store they belong to.
  IF NOT public.is_store_member(p_store) THEN
    RAISE EXCEPTION 'not a member of this store';
  END IF;

  IF p_name !~ '^[a-z_]{1,32}$' OR p_prefix !~ '^[A-Z]{1,6}-$' THEN
    RAISE EXCEPTION 'bad counter name or prefix';
  END IF;

  INSERT INTO public.store_counters (store_id, name, value)
  VALUES (p_store, p_name, 1)
  ON CONFLICT (store_id, name)
  DO UPDATE SET value = public.store_counters.value + 1
  RETURNING value INTO v;

  RETURN p_prefix || lpad(v::text, 4, '0');
END;
$fn$;

REVOKE ALL ON FUNCTION public.next_document_number(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.next_document_number(UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.next_document_number(UUID, TEXT, TEXT) TO authenticated;

-- Start the wholesale counter above whatever numbers already exist, so the
-- first cloud-issued number cannot collide with a document created back when
-- the count came from a local array.
INSERT INTO public.store_counters (store_id, name, value)
SELECT s.id, 'wholesale_invoice',
       COALESCE((SELECT MAX(NULLIF(regexp_replace(i."invoiceNumber", '[^0-9]', '', 'g'), '')::BIGINT)
                 FROM public.wholesale_invoices i WHERE i.store_id = s.id), 0)
FROM public.stores s
ON CONFLICT (store_id, name) DO NOTHING;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Mirrors `purchase_invoices` exactly: any member of the store may read, and
-- ADMIN/ACCOUNTANT may write. A جملة sale already requires those roles at the
-- `ledger_events` INSERT policy, so a looser rule here would let someone file
-- an invoice for a sale they are not allowed to record.
ALTER TABLE public.wholesale_clients  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wholesale_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_wholesale_clients ON public.wholesale_clients;
CREATE POLICY select_wholesale_clients ON public.wholesale_clients
  FOR SELECT USING (is_store_member(store_id));

DROP POLICY IF EXISTS write_wholesale_clients ON public.wholesale_clients;
CREATE POLICY write_wholesale_clients ON public.wholesale_clients
  FOR ALL
  USING      (has_role(store_id, VARIADIC ARRAY['ADMIN','ACCOUNTANT']))
  WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN','ACCOUNTANT']));

DROP POLICY IF EXISTS select_wholesale_invoices ON public.wholesale_invoices;
CREATE POLICY select_wholesale_invoices ON public.wholesale_invoices
  FOR SELECT USING (is_store_member(store_id));

DROP POLICY IF EXISTS write_wholesale_invoices ON public.wholesale_invoices;
CREATE POLICY write_wholesale_invoices ON public.wholesale_invoices
  FOR ALL
  USING      (has_role(store_id, VARIADIC ARRAY['ADMIN','ACCOUNTANT']))
  WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN','ACCOUNTANT']));

-- Realtime, so an invoice raised on the till appears in the office without a
-- refresh. Guarded because adding a table twice raises.
DO $rt$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.wholesale_clients;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL;
END $rt$;
DO $rt$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.wholesale_invoices;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL;
END $rt$;
