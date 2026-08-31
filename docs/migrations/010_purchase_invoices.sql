-- ============================================================================
-- 010 — purchase_invoices
--
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: every statement is idempotent.
--
-- WHY THIS EXISTS
-- ---------------
-- The توريد السريع dialog and شاشة المشتريات both write a supplier invoice
-- document. There was no table for it, so `addPurchaseInvoice` wrote only to
-- the browser's localStorage: the receipt existed on exactly one machine, was
-- invisible in the supplier's account anywhere else, and was erased by any
-- cache clear — while the ledger event describing it survived. This table ends
-- that split.
--
-- SHAPE NOTES
-- -----------
--   * `id` is TEXT, not UUID — matching products/suppliers/orders, which the
--     client generates ids for.
--   * Columns are QUOTED camelCase, matching `suppliers` ("companyName") and
--     `orders` ("orderNumber"). Do not snake_case them: `src/services/api/
--     cloudSchema.ts` sends these exact names and PostgREST rejects the whole
--     upsert on one unknown column.
--   * `items` is JSONB. A receipt's lines are only ever read back with their
--     invoice, never queried across invoices, so a child table would buy a
--     join and nothing else. The LEDGER is what aggregate questions are asked
--     of — this row is a document, not a source of truth for money.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.purchase_invoices (
  id                TEXT PRIMARY KEY,
  "invoiceNumber"   TEXT        NOT NULL,
  "supplierId"      TEXT        NOT NULL,
  "supplierName"    TEXT        NOT NULL DEFAULT '',
  items             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  "totalAmount"     NUMERIC     NOT NULL DEFAULT 0,
  "paidAmount"      NUMERIC     NOT NULL DEFAULT 0,
  "remainingAmount" NUMERIC     NOT NULL DEFAULT 0,
  "dueDate"         TEXT,
  status            TEXT        NOT NULL DEFAULT 'unpaid',
  notes             TEXT,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The columns every synced table carries. `store_id` is what RLS reads;
  -- without it the row is refused. `device_id` is NOT NULL on the other
  -- reference tables, so it is here too, for consistency.
  store_id          UUID        NOT NULL,
  device_id         UUID        NOT NULL,
  sync_status       TEXT        NOT NULL DEFAULT 'pending',
  updated_at        BIGINT      NOT NULL DEFAULT 0,
  deleted_at        TIMESTAMPTZ
);

-- The reads the screens actually make: "this store's invoices", "this
-- supplier's invoices", and the tombstone filter `cloudList` applies.
CREATE INDEX IF NOT EXISTS purchase_invoices_store_idx
  ON public.purchase_invoices (store_id);
CREATE INDEX IF NOT EXISTS purchase_invoices_supplier_idx
  ON public.purchase_invoices (store_id, "supplierId");
CREATE INDEX IF NOT EXISTS purchase_invoices_updated_idx
  ON public.purchase_invoices (store_id, updated_at);

-- One invoice number per store. This is what stops the client-side
-- `"FM-" + (purchaseInvoices.length + 1)` counter from silently producing two
-- FM-0004s when two people receive stock at the same moment — the second
-- insert now fails loudly instead of creating a duplicate document.
CREATE UNIQUE INDEX IF NOT EXISTS purchase_invoices_number_per_store
  ON public.purchase_invoices (store_id, "invoiceNumber");

ALTER TABLE public.purchase_invoices ENABLE ROW LEVEL SECURITY;

-- Policies mirror `suppliers` exactly: any member of the store may read, and
-- ADMIN/ACCOUNTANT may write. Receiving stock is already restricted to those
-- two roles by the `ledger_events` INSERT policy for kind='purchase', so a
-- looser rule here would let someone file an invoice for a receipt they are
-- not allowed to record.
DROP POLICY IF EXISTS select_purchase_invoices ON public.purchase_invoices;
CREATE POLICY select_purchase_invoices ON public.purchase_invoices
  FOR SELECT USING (is_store_member(store_id));

DROP POLICY IF EXISTS write_purchase_invoices ON public.purchase_invoices;
CREATE POLICY write_purchase_invoices ON public.purchase_invoices
  FOR ALL
  USING      (has_role(store_id, VARIADIC ARRAY['ADMIN','ACCOUNTANT']))
  WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN','ACCOUNTANT']));

-- Realtime, so a receipt filed on the till appears on the office machine
-- without a refresh. Guarded because adding a table twice raises.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.purchase_invoices;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;
