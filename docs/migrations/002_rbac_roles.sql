-- ════════════════════════════════════════════════════════════════════════════
-- Phase 8 — the four fixed roles, enforced by Postgres
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHY
--   Until now `store_members.role` was written once ('owner') at provisioning
--   and never read by anything. Every RLS policy gated on is_store_member()
--   alone, so ANY member could read and write ANY row in the shop — and the
--   client hardcoded `role: "owner"` on every cloud login anyway.
--
--   This makes the column mean something. The four roles are hardcoded in the
--   app (src/lib/roles.ts) and in the CHECK constraint below; the policies
--   below decide what each one may actually touch. The React route guards are
--   a courtesy for honest users — THIS is the lock.
--
-- SAFETY
--   Additive and idempotent. Existing rows are migrated in place from their old
--   values, nothing is dropped, and every statement is guarded so a re-run is a
--   no-op. Run it in the Supabase SQL Editor.
--
--   Read it before running it: the last section REPLACES the permissive
--   write policies with role-aware ones. If you have a member who should keep
--   full access, make sure they end up as 'ADMIN' in step 2.

BEGIN;

-- ── 1. Constrain the column to the four roles ───────────────────────────────

-- Drop first so a re-run with different data cannot fail on the old constraint.
ALTER TABLE public.store_members DROP CONSTRAINT IF EXISTS store_members_role_check;

-- ── 2. Migrate every existing value onto the fixed four ─────────────────────
-- Mirrors LEGACY_ROLE_MAP in src/lib/roles.ts. Anything unrecognised lands on
-- the LEAST privileged role — a typo must never open the safe.
UPDATE public.store_members
SET role = CASE
    WHEN role IN ('ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT') THEN role
    WHEN role IN ('owner', 'OWNER', 'MANAGER')                THEN 'ADMIN'
    WHEN role IN ('cashier', 'cashier_data_entry', 'CASHIER') THEN 'POS_ECOMMERCE'
    WHEN role IN ('accountant', 'branch_manager', 'inventory_clerk') THEN 'ACCOUNTANT'
    ELSE 'ECOMMERCE_ONLY'
END;

ALTER TABLE public.store_members
  ADD CONSTRAINT store_members_role_check
  CHECK (role IN ('ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT'));

-- ── 3. Ask "what role is this user here?" ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.member_role(p_store_id UUID)
RETURNS TEXT AS $$
  SELECT role
  FROM public.store_members
  WHERE user_id = auth.uid() AND store_id = p_store_id
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

/* True when the caller holds ANY of the named roles in this shop.
   NULL (no membership row) fails every check — a stranger is not a viewer. */
CREATE OR REPLACE FUNCTION public.has_role(p_store_id UUID, VARIADIC p_roles TEXT[])
RETURNS BOOLEAN AS $$
  SELECT COALESCE(public.member_role(p_store_id) = ANY(p_roles), FALSE);
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ── 4. Only an ADMIN may hand out roles ─────────────────────────────────────
-- Without this, a cashier could UPDATE their own row to 'ADMIN' and the whole
-- scheme is decoration.
ALTER TABLE public.store_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_store_members ON public.store_members;
CREATE POLICY select_store_members ON public.store_members
  FOR SELECT USING (is_store_member(store_id));

DROP POLICY IF EXISTS admin_writes_store_members ON public.store_members;
CREATE POLICY admin_writes_store_members ON public.store_members
  FOR ALL
  USING (has_role(store_id, 'ADMIN'))
  WITH CHECK (has_role(store_id, 'ADMIN'));

-- ── 5. Role-aware write policies ────────────────────────────────────────────
--
-- SELECT stays store-wide: every role needs to read products and the ledger to
-- do its job, and hiding rows from a cashier breaks the till. What changes is
-- who may WRITE what.

-- Products & inventory: ADMIN and ACCOUNTANT. A cashier sells stock, they do
-- not re-price it; ECOMMERCE_ONLY reads inventory but never edits it, which is
-- the "read-only Inventory" the blueprint asks for.
DROP POLICY IF EXISTS write_products ON public.products;
CREATE POLICY write_products ON public.products
  FOR ALL
  USING (has_role(store_id, 'ADMIN', 'ACCOUNTANT'))
  WITH CHECK (has_role(store_id, 'ADMIN', 'ACCOUNTANT'));

-- Suppliers belong to purchasing.
DROP POLICY IF EXISTS write_suppliers ON public.suppliers;
CREATE POLICY write_suppliers ON public.suppliers
  FOR ALL
  USING (has_role(store_id, 'ADMIN', 'ACCOUNTANT'))
  WITH CHECK (has_role(store_id, 'ADMIN', 'ACCOUNTANT'));

-- Customers and discounts are the selling roles' to maintain.
DROP POLICY IF EXISTS write_customers ON public.customers;
CREATE POLICY write_customers ON public.customers
  FOR ALL
  USING (has_role(store_id, 'ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY'))
  WITH CHECK (has_role(store_id, 'ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY'));

DROP POLICY IF EXISTS write_discount_codes ON public.discount_codes;
CREATE POLICY write_discount_codes ON public.discount_codes
  FOR ALL
  USING (has_role(store_id, 'ADMIN'))
  WITH CHECK (has_role(store_id, 'ADMIN'));

DROP POLICY IF EXISTS write_return_records ON public.return_records;
CREATE POLICY write_return_records ON public.return_records
  FOR ALL
  USING (has_role(store_id, 'ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY'))
  WITH CHECK (has_role(store_id, 'ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY'));

-- Branches are structural.
DROP POLICY IF EXISTS write_branches ON public.branches;
CREATE POLICY write_branches ON public.branches
  FOR ALL
  USING (has_role(store_id, 'ADMIN'))
  WITH CHECK (has_role(store_id, 'ADMIN'));

-- ── 6. The ledger stays append-only, for everyone ───────────────────────────
--
-- Every role writes events — a cashier books a sale, an accountant books a
-- receipt. What NOBODY may do is edit or delete one. There is deliberately no
-- UPDATE or DELETE policy on these two tables, so those verbs are denied to
-- every role including ADMIN. History is corrected with a reversing event, not
-- with an UPDATE.
DROP POLICY IF EXISTS insert_ledger_events ON public.ledger_events;
CREATE POLICY insert_ledger_events ON public.ledger_events
  FOR INSERT WITH CHECK (is_store_member(store_id));

DROP POLICY IF EXISTS insert_ledger_lines ON public.ledger_lines;
CREATE POLICY insert_ledger_lines ON public.ledger_lines
  FOR INSERT WITH CHECK (is_store_member(store_id));

COMMIT;


-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect: only the four role names, and every member accounted for.
SELECT role, COUNT(*) AS members
FROM   public.store_members
GROUP  BY role
ORDER  BY role;

-- Expect: your own row, with the role the app will now grant you.
SELECT public.member_role(store_id) AS my_role, store_id
FROM   public.store_members
WHERE  user_id = auth.uid();
