-- ============================================================================
-- 047 — Operational read projection (S-1 / S-2 groundwork)
--
-- ADDITIVE ONLY. Nothing here narrows an existing policy, so it is safe with
-- every client already deployed. It creates the read paths an operational role
-- (MODERATOR) will use once 048 removes its direct access to the ledger, to
-- orders' cost fields and to the financial tables:
--
--   can_read_store_finance(store)  the predicate 048 puts on financial reads
--   orders_operational             orders without cost          (S-2)
--   mobile_stock_quantities(ids)   ledger stock QUANTITY only   (S-1)
--   mobile_order_timeline(number)  event kind + time only       (S-1)
--   store_activity                 "something changed" signal   (S-1/S-2 realtime)
--
-- The new functions take no store id: the store is the caller's own
-- membership (`store_members_one_store_per_user`), so a caller cannot name
-- another tenant. Re-runnable.
-- ============================================================================

-- ── The predicate ───────────────────────────────────────────────────────────
-- Every role that reads the store's finances today, exactly: ADMIN,
-- ACCOUNTANT, POS_ECOMMERCE, ECOMMERCE_ONLY. MODERATOR — and any role this
-- build does not know — is outside it (fail closed).
--
-- Deliberately `member_role`, not `has_role`: `has_role` also requires a
-- licensed store, so `NOT has_role(store, 'MODERATOR')` would hand the ledger
-- back to a Moderator the day the licence lapses. And the four roles must keep
-- exactly the reach `is_store_member` gave them, which has no licence check.
CREATE OR REPLACE FUNCTION public.can_read_store_finance(p_store_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    public.member_role(p_store_id) = ANY (ARRAY['ADMIN', 'ACCOUNTANT', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY']),
    false
  );
$function$;

REVOKE ALL ON FUNCTION public.can_read_store_finance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_read_store_finance(uuid) TO authenticated;

-- ── Order lines without their cost ──────────────────────────────────────────
-- `items` / `stockItems` carry `unitCost` per line. The historical JSON is not
-- rewritten; the projection drops the key on the way out.
CREATE OR REPLACE FUNCTION public.strip_line_cost(p_lines jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(p_lines) = 'array' THEN COALESCE(
      (SELECT jsonb_agg(CASE WHEN jsonb_typeof(e) = 'object' THEN e - 'unitCost' ELSE e END ORDER BY ord)
         FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS t(e, ord)),
      '[]'::jsonb)
    ELSE p_lines
  END;
$function$;

-- ── S-2: orders_operational ─────────────────────────────────────────────────
-- The one order read for the Mobile app. Same rows as `orders` for any member
-- of the store (the view's own WHERE — it runs with its owner's rights, so the
-- table's policies do not apply to it; `security_barrier` keeps a caller's
-- filters from being evaluated before that WHERE). Cost never leaves:
--   `cogsAmount`                 not in the view at all
--   `courierFee`, line unitCost  only for can_read_store_finance
-- Desktop and every write keep using `orders` itself.
CREATE OR REPLACE VIEW public.orders_operational
WITH (security_barrier = true)
AS
SELECT
  o.id, o."orderNumber", o."customerName", o."customerPhone", o.address, o.governorate, o.city,
  CASE WHEN public.can_read_store_finance(o.store_id) THEN o.items ELSE public.strip_line_cost(o.items) END AS items,
  CASE WHEN public.can_read_store_finance(o.store_id) THEN o."stockItems" ELSE public.strip_line_cost(o."stockItems") END AS "stockItems",
  o."totalAmount", o."shippingFee", o."paymentMethod", o."depositAmount", o."depositWallet", o."expectedCod",
  o."discountAmount", o."discountCodeId", o.status, o."courierId", o."courierName",
  CASE WHEN public.can_read_store_finance(o.store_id) THEN o."courierFee" END AS "courierFee",
  o."createdAt", o."updatedAt", o.updated_at, o."revenueLogged", o."customerId", o."codSettledAt",
  o."returnConfirmedAt", o."returnType", o.return_cause, o."isExchange", o.original_order_id,
  o."wholesaleClientId", o."shippingPenaltyApplied", o.store_id, o.deleted_at
FROM public.orders o
WHERE public.is_store_member(o.store_id);

REVOKE ALL ON public.orders_operational FROM PUBLIC, anon;
GRANT SELECT ON public.orders_operational TO authenticated;

-- ── S-1: stock quantity, without the money ──────────────────────────────────
-- Exactly `ledger_balances(store, 'stock')` minus the `amount` column: the same
-- join, the same (absent) deleted/period filters, so the quantity is the one
-- the ledger already reports. Any member of the store may ask.
CREATE OR REPLACE FUNCTION public.mobile_stock_quantities(p_product_ids text[])
RETURNS TABLE(product_id text, qty numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT l.subject_id, sum(l.qty_delta::numeric)
  FROM public.ledger_lines l
  JOIN public.ledger_events e ON e.id = l.event_id
  WHERE l.store_id = (SELECT m.store_id FROM public.store_members m WHERE m.user_id = auth.uid())
    AND l.account = 'stock'
    AND l.subject_id = ANY (p_product_ids)
  GROUP BY l.subject_id;
$function$;

REVOKE ALL ON FUNCTION public.mobile_stock_quantities(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mobile_stock_quantities(text[]) TO authenticated;

-- ── S-1: an order's timeline, without the money ─────────────────────────────
-- What the Mobile order screen shows: which lifecycle events happened, when.
-- No payload (wallet, amounts, supplier names), no lines.
CREATE OR REPLACE FUNCTION public.mobile_order_timeline(p_order_number text)
RETURNS TABLE(id text, kind text, occurred_at text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.id::text, e.kind::text, e.occurred_at::text
  FROM public.ledger_events e
  WHERE e.store_id = (SELECT m.store_id FROM public.store_members m WHERE m.user_id = auth.uid())
    AND e.ref_type = 'ecommerce_order'
    AND e.ref_id = p_order_number
  ORDER BY e.occurred_at::timestamptz DESC
  LIMIT 200;
$function$;

REVOKE ALL ON FUNCTION public.mobile_order_timeline(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mobile_order_timeline(text) TO authenticated;

-- ── Realtime without rows: store_activity ───────────────────────────────────
-- `postgres_changes` delivers the WHOLE changed row, so subscribing to
-- `orders` or `ledger_events` is a read of them. Mobile only ever needed "this
-- store's orders / ledger changed — ask again". This table carries exactly
-- that: store, which source, when. Written only by the trigger below.
CREATE TABLE IF NOT EXISTS public.store_activity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('orders', 'ledger_events')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_activity_store_created_idx ON public.store_activity (store_id, created_at);

ALTER TABLE public.store_activity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS select_store_activity ON public.store_activity;
CREATE POLICY select_store_activity ON public.store_activity
  FOR SELECT USING (public.is_store_member(store_id));
-- No INSERT/UPDATE/DELETE policy: clients cannot write it.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.store_activity FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.store_activity FROM anon;
GRANT SELECT ON public.store_activity TO authenticated;

-- No EXCEPTION block (043: nothing may wrap ledger_append's writes in a
-- subtransaction) and nothing that can fail on a valid row.
CREATE OR REPLACE FUNCTION public.signal_store_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_store uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.store_id ELSE NEW.store_id END;
BEGIN
  IF v_store IS NOT NULL THEN
    INSERT INTO public.store_activity (store_id, source) VALUES (v_store, TG_ARGV[0]);
    -- A signal is only useful while a socket can hear it; keep an hour.
    DELETE FROM public.store_activity
     WHERE store_id = v_store AND created_at < now() - interval '1 hour';
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.signal_store_activity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS signal_store_activity ON public.ledger_events;
CREATE TRIGGER signal_store_activity
  AFTER INSERT ON public.ledger_events
  FOR EACH ROW EXECUTE FUNCTION public.signal_store_activity('ledger_events');

DROP TRIGGER IF EXISTS signal_store_activity ON public.orders;
CREATE TRIGGER signal_store_activity
  AFTER INSERT OR UPDATE OR DELETE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.signal_store_activity('orders');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'store_activity'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.store_activity;
  END IF;
END $$;
