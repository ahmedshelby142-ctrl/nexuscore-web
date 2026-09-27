-- ============================================================================
-- 043 — a ledger line belongs to the event it was written with;
--       a product keeps the id it was created with
--
-- Safe to re-run: every statement is idempotent. Touches ONE policy and ONE
-- trigger function. No table, no column, no row is changed — ledger history
-- and products are read by the new checks, never rewritten.
--
-- I-2 — WHY THE LINES POLICY CHANGES
-- ----------------------------------
-- `insert_ledger_events` is kind-aware: `purchase`, `supplier_payment`,
-- `stock_adjustment`, `expense`, `payroll`, `owner_draw`, `wallet_transfer`
-- and `deposit_refunded` need ADMIN or ACCOUNTANT. `insert_ledger_lines` was
-- not — it asked only "may this role write in this store". Lines are the
-- money, so the kind restriction could be walked around by not creating an
-- event at all: a POS_ECOMMERCE session POSTed a `wallet +100,000,000`
-- piastre line whose `event_id` was an ADMIN's existing `purchase` event, and
-- it was ACCEPTED (proven 2026-09-26 in a rolled-back probe — the till went
-- 646,000 → 100,646,000). Any writing role could also alter any posted event,
-- which an append-only ledger must never allow.
--
-- The property enforced now: a line may only be inserted for an event that
-- was created IN THE SAME TRANSACTION. `ledger_append` — the only client
-- write path (`lib/ledger/driver.ts` calls nothing else) and the only
-- server-side one (`refund_order_deposit` PERFORMs it) — inserts the event
-- and then its lines inside one call, so its own lines pass and inherit the
-- event's kind authorization. A line for any event that already existed
-- before the transaction began is refused, for every role including ADMIN.
--
-- The test is `e.xmin = pg_current_xact_id()::xid`: the event row's creating
-- transaction is this transaction. Checked on PostgreSQL 17.6 before use:
--   * top-level INSERT → xmin is the top-level xid, equal to the cast ✓
--   * 32-bit wraparound could only alias an old event after ~4.29 billion
--     transactions; this database was at 7,215 when this was written.
--   * CAVEAT, fail-closed: an event inserted inside a SUBtransaction (a
--     plpgsql `BEGIN … EXCEPTION` block or a SAVEPOINT) carries the
--     subtransaction's xid, so its lines are REFUSED. Nothing writes that way
--     today. Keep `ledger_append` and its callers free of exception blocks
--     around the append, or this policy will reject legitimate writes.
--   ponytail: xmin is the smallest mechanism that holds; if a subtransaction
--   writer is ever needed, stamp events with a trigger-set
--   `created_xact xid8 := pg_current_xact_id()` column and compare that.
--
-- Service-role writers bypass RLS and are unaffected. Tenancy is doubled:
-- `has_role` on the line's store AND the event must be in that same store.
--
-- I-3 — WHY THE PRODUCT GUARD CHANGES
-- -----------------------------------
-- `update_products` lets all four writing roles UPDATE a product so the stock
-- mirror (`quantity`, `metadata.variants[].stock`) can move with a sale.
-- `products_guard_definition_columns` then refuses non-ADMIN/ACCOUNTANT
-- changes to the definition columns — but not to `id`. Ledger lines, order
-- lines and invoice lines reference a product by its text id with no foreign
-- key, so `UPDATE products SET id = …` (proven as POS_ECOMMERCE) severs the
-- product from its whole stock and cost history. The app never changes an id
-- (every write upserts ON CONFLICT (id)), so an existing product's id is now
-- immutable for EVERY session user, ADMIN included — the check sits before the
-- ADMIN/ACCOUNTANT bypass. The unchanged `auth.uid() IS NULL` early return
-- still lets the service role / migrations through; `anon` never reaches this
-- trigger because `update_products` requires `has_role`.
-- ============================================================================

-- ── I-2 ─────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS insert_ledger_lines ON public.ledger_lines;

CREATE POLICY insert_ledger_lines ON public.ledger_lines
  FOR INSERT
  WITH CHECK (
    public.has_role(store_id, VARIADIC ARRAY['ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT'])
    AND EXISTS (
      SELECT 1
        FROM public.ledger_events e
       WHERE e.id = ledger_lines.event_id
         AND e.store_id = ledger_lines.store_id
         AND e.xmin = pg_current_xact_id()::xid
    )
  );

-- ── I-3 ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.products_guard_definition_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Identity first, and for everyone: a re-keyed product orphans its ledger.
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'a product id cannot change' USING ERRCODE = '42501';
  END IF;

  IF public.has_role(NEW.store_id, VARIADIC ARRAY['ADMIN', 'ACCOUNTANT']) THEN
    RETURN NEW;
  END IF;

  IF NEW.name              IS DISTINCT FROM OLD.name
  OR NEW.sku               IS DISTINCT FROM OLD.sku
  OR NEW.barcode           IS DISTINCT FROM OLD.barcode
  OR NEW.category          IS DISTINCT FROM OLD.category
  OR NEW.description       IS DISTINCT FROM OLD.description
  OR NEW.image_url         IS DISTINCT FROM OLD.image_url
  OR NEW."unitPrice"       IS DISTINCT FROM OLD."unitPrice"
  OR NEW.wholesale_price   IS DISTINCT FROM OLD.wholesale_price
  OR NEW."minStockLevel"   IS DISTINCT FROM OLD."minStockLevel"
  OR NEW."maxStockLevel"   IS DISTINCT FROM OLD."maxStockLevel"
  OR NEW."isActive"        IS DISTINCT FROM OLD."isActive"
  OR NEW."isBundle"        IS DISTINCT FROM OLD."isBundle"
  OR NEW."bundleItems"     IS DISTINCT FROM OLD."bundleItems"
  OR NEW.deleted_at        IS DISTINCT FROM OLD.deleted_at
  OR NEW.store_id          IS DISTINCT FROM OLD.store_id
  THEN
    RAISE EXCEPTION
      'only ADMIN or ACCOUNTANT may change a product''s definition'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

-- ============================================================================
-- ROLLBACK (development / QA only — this reopens both holes)
--
--   DROP POLICY IF EXISTS insert_ledger_lines ON public.ledger_lines;
--   CREATE POLICY insert_ledger_lines ON public.ledger_lines FOR INSERT
--     WITH CHECK (public.has_role(store_id, VARIADIC ARRAY['ADMIN','POS_ECOMMERCE','ECOMMERCE_ONLY','ACCOUNTANT']));
--   -- and re-create products_guard_definition_columns without the id check.
-- ============================================================================
