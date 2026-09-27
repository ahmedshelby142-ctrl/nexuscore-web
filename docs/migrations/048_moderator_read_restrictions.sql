-- ============================================================================
-- 048 — Financial reads are no longer "any member of the store"
--
-- Before: every SELECT policy was `is_store_member(store_id)`. A MODERATOR's
-- own JWT read, directly: 500 ledger lines (111 with unit_cost), the wallet
-- total via ledger_balances, `cogsAmount` and line `unitCost` on every order,
-- expenses, purchase invoices, suppliers, wholesale invoices, return records,
-- discount codes and every colleague's email (measured 2026-09-27, rolled back).
--
-- After: those reads require `can_read_store_finance(store_id)` (047) — the
-- four roles that had them keep them, unchanged; MODERATOR and unknown roles
-- do not. The Moderator's operational reads move to 047's projections.
--
-- APPLY AFTER the client that reads `orders_operational`,
-- `mobile_stock_quantities`, `mobile_order_timeline` and `store_activity` is
-- deployed: an older client would read `orders` / the ledger directly and a
-- Moderator would see empty screens. Re-runnable. Writes are untouched.
-- ============================================================================

-- ── S-1: the ledger ─────────────────────────────────────────────────────────
-- `ledger_balances` and `ledger_events_page` are SECURITY INVOKER, so they
-- follow these policies: a Moderator gets no rows from them. `mobile_shortages`
-- and `owner_financial_summary` are unaffected (DEFINER / ADMIN-only).
ALTER POLICY select_ledger_lines ON public.ledger_lines
  USING (public.can_read_store_finance(store_id));
ALTER POLICY select_ledger_events ON public.ledger_events
  USING (public.can_read_store_finance(store_id));

-- ── S-2: orders (cost columns and line cost) ────────────────────────────────
-- The Moderator reads `orders_operational`. `write_orders` (ADMIN, POS,
-- ECOMMERCE_ONLY; FOR ALL) is unchanged and never included MODERATOR.
ALTER POLICY select_orders ON public.orders
  USING (public.can_read_store_finance(store_id));

-- ── S-3: financial / business tables no Moderator screen reads ─────────────
ALTER POLICY select_expenses ON public.expenses
  USING (public.can_read_store_finance(store_id));
ALTER POLICY select_transactions ON public.transactions
  USING (public.can_read_store_finance(store_id));
ALTER POLICY select_purchase_invoices ON public.purchase_invoices
  USING (public.can_read_store_finance(store_id));
ALTER POLICY select_suppliers ON public.suppliers
  USING (public.can_read_store_finance(store_id));
ALTER POLICY select_wholesale_invoices ON public.wholesale_invoices
  USING (public.can_read_store_finance(store_id));
ALTER POLICY select_wholesale_clients ON public.wholesale_clients
  USING (public.can_read_store_finance(store_id));
ALTER POLICY select_courier_claims ON public.courier_claims
  USING (public.can_read_store_finance(store_id));
ALTER POLICY select_return_records ON public.return_records
  USING (public.can_read_store_finance(store_id));
ALTER POLICY select_discount_codes ON public.discount_codes
  USING (public.can_read_store_finance(store_id));

-- ── S-5: the staff directory ────────────────────────────────────────────────
-- Every client read of `store_members` is the caller's OWN row (login, session
-- reconciliation, store context); listing, re-roling and removing staff is the
-- ADMIN user-management screen. `has_role`/`is_store_member`/`member_role` are
-- DEFINER and are not affected by this policy.
ALTER POLICY select_store_members ON public.store_members
  USING (user_id = auth.uid() OR public.member_role(store_id) = 'ADMIN');

-- Emails and roles of every colleague: ADMIN only. `member_role`, not
-- `has_role`, so an ADMIN keeps the list exactly as before (no licence check
-- was ever part of it).
CREATE OR REPLACE FUNCTION public.list_store_members()
RETURNS TABLE(user_id uuid, role text, email text, joined_at timestamp with time zone)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT sm.user_id,
         sm.role::text,
         u.email::text,
         COALESCE(sm.created_at, u.created_at)
  FROM public.store_members sm
  JOIN auth.users u ON u.id = sm.user_id
  -- Only the caller's own store, and only for its ADMIN.
  WHERE public.member_role(sm.store_id) = 'ADMIN';
$function$;

REVOKE ALL ON FUNCTION public.list_store_members() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_store_members() TO authenticated;
