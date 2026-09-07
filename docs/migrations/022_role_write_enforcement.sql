-- ============================================================================
-- 022 — make the role restrictions on writes actually restrict
--
-- Safe to re-run.
--
-- WHAT WAS WRONG
-- --------------
-- Six tables carried a role-gated `ALL` policy AND a second, permissive
-- INSERT/UPDATE policy keyed only on `is_store_member`:
--
--     write_products    FOR ALL    USING has_role(store_id, 'ADMIN','ACCOUNTANT')
--     insert_products   FOR INSERT WITH CHECK is_store_member(store_id)   ← this
--     update_products   FOR UPDATE USING      is_store_member(store_id)   ← this
--
-- Postgres OR-s permissive policies together. The narrow one therefore did
-- nothing for INSERT and UPDATE: every member of the store could write, whatever
-- their role. Only DELETE was ever gated.
--
-- Proven against the live database before this migration, inside a transaction
-- that rolled back, acting as a POS_ECOMMERCE member of the QA store:
--
--     products  INSERT  → ALLOWED          (policy says ADMIN/ACCOUNTANT)
--     products  UPDATE  → 5 rows changed   (policy says ADMIN/ACCOUNTANT)
--     branches  INSERT  → ALLOWED          (policy says ADMIN/ACCOUNTANT)
--     suppliers INSERT  → ALLOWED          (policy says ADMIN/ACCOUNTANT)
--     expenses  INSERT  → denied           (no permissive policy — correct)
--     products  DELETE  → 0 rows           (gated — correct)
--     self-escalation to ADMIN → 0 rows    (gated — correct)
--
-- The cashier has no Products screen at all: `/products` is ADMIN-only in
-- `lib/roles.ts`. So the UI hid a door the database had left unlocked, and the
-- worst of it is the price columns — a till operator could set a price to zero,
-- sell, and set it back.
--
-- Escalation and deletion were never exposed. This closes the write side.
--
-- ── 1. Drop the redundant permissive policies ───────────────────────────────
--
-- Each table keeps its `write_*` (role-gated, FOR ALL) and `select_*`. Checked
-- against every screen that writes these tables, so nothing legitimate loses
-- access:
--
--   branches        Branches screen and the settings tab — ADMIN
--   suppliers       المشتريات and quick-restock — ACCOUNTANT / ADMIN
--   customers       CRM, the till, online orders — ADMIN / POS / ECOMMERCE_ONLY
--   discount_codes  الخصومات — ADMIN
--   return_records  المرتجعات and الطلبات — ADMIN / POS / ECOMMERCE_ONLY
--   products        INSERT only (see §2 for why UPDATE has to stay)

DROP POLICY IF EXISTS insert_branches       ON public.branches;
DROP POLICY IF EXISTS update_branches       ON public.branches;
DROP POLICY IF EXISTS insert_suppliers      ON public.suppliers;
DROP POLICY IF EXISTS update_suppliers      ON public.suppliers;
DROP POLICY IF EXISTS insert_customers      ON public.customers;
DROP POLICY IF EXISTS update_customers      ON public.customers;
DROP POLICY IF EXISTS insert_discount_codes ON public.discount_codes;
DROP POLICY IF EXISTS update_discount_codes ON public.discount_codes;
DROP POLICY IF EXISTS insert_return_records ON public.return_records;
DROP POLICY IF EXISTS update_return_records ON public.return_records;
DROP POLICY IF EXISTS insert_products       ON public.products;

-- ── 2. `products` UPDATE stays open, by column ──────────────────────────────
--
-- `update_products` is NOT dropped, and that is deliberate. `applyStockMoves`
-- writes the quantity mirror on `products` from الطلبات, which POS_ECOMMERCE and
-- ECOMMERCE_ONLY own — dispatching or returning an order updates it. Restricting
-- UPDATE to ADMIN/ACCOUNTANT would break order handling for exactly the roles
-- whose screen it is.
--
-- The mirror only ever touches `quantity` and `metadata` (variant stocks), plus
-- the sync bookkeeping columns. Everything that DEFINES the product — its name,
-- codes, prices, thresholds, flags, recipe, tombstone — belongs to ADMIN and
-- ACCOUNTANT. A trigger can say that; a policy cannot, because a policy never
-- sees the old row alongside the new one.
--
-- Comparing VALUES rather than "was this column in the SET list" is what makes
-- this work with the sync layer: `mirrorRow` upserts the whole row, so the
-- untouched columns arrive equal to what is already stored and pass unchanged.
--
-- `auth.uid() IS NULL` means there is no end user in the request — the
-- service_role key or a SQL session — and those already bypass RLS entirely.

CREATE OR REPLACE FUNCTION public.products_guard_definition_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
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
$fn$;

DROP TRIGGER IF EXISTS products_guard_definition_columns ON public.products;
CREATE TRIGGER products_guard_definition_columns
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.products_guard_definition_columns();

-- ── 3. What is deliberately NOT changed ─────────────────────────────────────
--
--   * `store_members` — already ADMIN-only for writes, and self-escalation was
--     verified denied. Untouched.
--   * `expenses`, `transactions`, `purchase_invoices`, `wholesale_clients`,
--     `wholesale_invoices`, `shipping_rates`, `orders` — each already carries a
--     single role-gated policy with no permissive twin. Verified, untouched.
--   * `ledger_events` / `ledger_lines` — append-only, with the INSERT policy
--     already branching on `kind` per role. Untouched.
