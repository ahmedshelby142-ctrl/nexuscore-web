-- ============================================================================
-- 051 — Shared finance records (fixed assets, budget caps, payroll) and an
--       atomic order cancellation.
--
-- 1. fixed_assets / budget_caps / payroll — business records that lived only
--    in the browser that typed them (`financial-storage`): another device had
--    none of them, and clearing site data erased them. The MONEY behind an
--    asset purchase or a salary was already on the ledger (`expense` /
--    `payroll` events); only the documents were local. Each table is store-
--    scoped and read/written by the two roles that own الشركاء والمالية
--    (ADMIN, ACCOUNTANT) — the same roles `insert_ledger_events` allows for
--    `expense` and `payroll`. MODERATOR and the sales roles see nothing.
--
-- 2. record_payroll / record_fixed_asset — the document and its ledger event
--    in ONE transaction, idempotent on the document id: a retry after a lost
--    answer returns the row already recorded (`replayed`) instead of paying the
--    salary, or the asset, a second time. The event must point at the document
--    (`ref_id` = its id) so the two can always be traced to each other.
--    SECURITY INVOKER: table RLS and `insert_ledger_events` decide who may.
--    No EXCEPTION block anywhere (043).
--
-- 3. cancel_order — status, cause and the `order_cancelled` event in ONE
--    transaction, under a row lock. It used to be three requests (cause, event,
--    status); a failure between them left the stock and money moved behind an
--    order still showing «pending», and a second press booked it again.
--
-- Additive. Touches no existing row, table, policy or function.
-- ============================================================================

-- ── 1. tables ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fixed_assets (
  id                    text PRIMARY KEY,
  store_id              uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  device_id             uuid,
  name                  text NOT NULL,
  "purchaseValue"       numeric NOT NULL CHECK ("purchaseValue" > 0),
  "salvageValue"        numeric NOT NULL DEFAULT 0 CHECK ("salvageValue" >= 0),
  "usefulLifeYears"     numeric NOT NULL CHECK ("usefulLifeYears" > 0),
  "purchaseDate"        timestamptz NOT NULL,
  -- (purchaseValue − salvageValue) / (usefulLifeYears × 12), computed by the
  -- client exactly as before. Non-cash: a memo, never a ledger line.
  "monthlyDepreciation" numeric NOT NULL DEFAULT 0,
  "isActive"            boolean NOT NULL DEFAULT true,
  -- 'prepaid' (already owned, no money moves now) or the wallet that paid.
  "paymentSource"       text,
  ledger_event_id       text,
  "createdAt"           timestamptz DEFAULT now(),
  updated_at            bigint,
  deleted_at            timestamptz,
  sync_status           text
);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_store ON public.fixed_assets (store_id);

CREATE TABLE IF NOT EXISTS public.budget_caps (
  id          text PRIMARY KEY,
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  device_id   uuid,
  category    text NOT NULL,
  "capAmount" numeric NOT NULL CHECK ("capAmount" > 0),
  updated_at  bigint,
  deleted_at  timestamptz,
  sync_status text
);
-- One cap per category per store, whichever device sets it.
CREATE UNIQUE INDEX IF NOT EXISTS budget_caps_category_per_store
  ON public.budget_caps (store_id, category) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.payroll (
  id              text PRIMARY KEY,
  store_id        uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  device_id       uuid,
  "employeeName"  text NOT NULL,
  type            text NOT NULL DEFAULT 'salary' CHECK (type IN ('salary', 'bonus', 'advance')),
  amount          numeric NOT NULL CHECK (amount > 0),
  description     text,
  date            timestamptz NOT NULL,
  wallet          text,
  ledger_event_id text,
  "createdAt"     timestamptz DEFAULT now(),
  updated_at      bigint,
  deleted_at      timestamptz,
  sync_status     text
);
CREATE INDEX IF NOT EXISTS idx_payroll_store ON public.payroll (store_id);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_one_event
  ON public.payroll (ledger_event_id) WHERE ledger_event_id IS NOT NULL;

-- Same shape for all three: members of the store holding ADMIN or ACCOUNTANT.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fixed_assets', 'budget_caps', 'payroll'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'select_' || t, t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT USING (
        public.is_store_member(store_id)
        AND EXISTS (SELECT 1 FROM public.store_members m
                     WHERE m.store_id = %I.store_id AND m.user_id = auth.uid()
                       AND m.role IN ('ADMIN', 'ACCOUNTANT')))$p$, 'select_' || t, t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'write_' || t, t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR ALL
        USING (public.has_role(store_id, VARIADIC ARRAY['ADMIN', 'ACCOUNTANT']))
        WITH CHECK (public.has_role(store_id, VARIADIC ARRAY['ADMIN', 'ACCOUNTANT']))$p$, 'write_' || t, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
  END LOOP;
END $$;


-- ── 2. document + ledger event, together ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_payroll(p_payroll jsonb, p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id    text := p_payroll ->> 'id';
  v_store uuid := (p_payroll ->> 'store_id')::uuid;
  v_row   jsonb;
BEGIN
  IF v_id IS NULL OR v_store IS NULL THEN
    RAISE EXCEPTION 'NEXUS_DOCUMENT_INVALID' USING ERRCODE = '23514';
  END IF;

  -- A retry after a lost answer: the salary is already paid. Say so.
  SELECT to_jsonb(p.*) INTO v_row FROM public.payroll p WHERE p.id = v_id AND p.store_id = v_store;
  IF v_row IS NOT NULL THEN
    RETURN jsonb_build_object('payroll', v_row, 'replayed', true);
  END IF;

  IF p_event ->> 'kind' IS DISTINCT FROM 'payroll'
     OR (p_event ->> 'store_id')::uuid IS DISTINCT FROM v_store
     OR p_event ->> 'ref_type' IS DISTINCT FROM 'payroll'
     OR p_event ->> 'ref_id' IS DISTINCT FROM v_id THEN
    RAISE EXCEPTION 'NEXUS_EVENT_NOT_THIS_DOCUMENT' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.payroll (id, store_id, device_id, "employeeName", type, amount, description,
                              date, wallet, ledger_event_id, updated_at, sync_status)
  VALUES (v_id, v_store, (p_payroll ->> 'device_id')::uuid, p_payroll ->> 'employeeName',
          COALESCE(p_payroll ->> 'type', 'salary'), (p_payroll ->> 'amount')::numeric,
          p_payroll ->> 'description', (p_payroll ->> 'date')::timestamptz, p_payroll ->> 'wallet',
          p_event ->> 'id', (extract(epoch FROM clock_timestamp()) * 1000)::bigint, 'synced')
  RETURNING to_jsonb(payroll.*) INTO v_row;

  PERFORM public.ledger_append(p_event);
  RETURN jsonb_build_object('payroll', v_row, 'replayed', false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_fixed_asset(p_asset jsonb, p_event jsonb DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id    text := p_asset ->> 'id';
  v_store uuid := (p_asset ->> 'store_id')::uuid;
  v_row   jsonb;
BEGIN
  IF v_id IS NULL OR v_store IS NULL THEN
    RAISE EXCEPTION 'NEXUS_DOCUMENT_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT to_jsonb(a.*) INTO v_row FROM public.fixed_assets a WHERE a.id = v_id AND a.store_id = v_store;
  IF v_row IS NOT NULL THEN
    RETURN jsonb_build_object('asset', v_row, 'replayed', true);
  END IF;

  -- No event = an asset already owned («مدفوع مسبقاً»): nothing moves now.
  IF p_event IS NOT NULL AND (
       p_event ->> 'kind' IS DISTINCT FROM 'expense'
       OR (p_event ->> 'store_id')::uuid IS DISTINCT FROM v_store
       OR p_event ->> 'ref_type' IS DISTINCT FROM 'fixed_asset'
       OR p_event ->> 'ref_id' IS DISTINCT FROM v_id) THEN
    RAISE EXCEPTION 'NEXUS_EVENT_NOT_THIS_DOCUMENT' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.fixed_assets (id, store_id, device_id, name, "purchaseValue", "salvageValue",
                                   "usefulLifeYears", "purchaseDate", "monthlyDepreciation", "isActive",
                                   "paymentSource", ledger_event_id, updated_at, sync_status)
  VALUES (v_id, v_store, (p_asset ->> 'device_id')::uuid, p_asset ->> 'name',
          (p_asset ->> 'purchaseValue')::numeric, COALESCE((p_asset ->> 'salvageValue')::numeric, 0),
          (p_asset ->> 'usefulLifeYears')::numeric, (p_asset ->> 'purchaseDate')::timestamptz,
          COALESCE((p_asset ->> 'monthlyDepreciation')::numeric, 0), COALESCE((p_asset ->> 'isActive')::boolean, true),
          p_asset ->> 'paymentSource', p_event ->> 'id',
          (extract(epoch FROM clock_timestamp()) * 1000)::bigint, 'synced')
  RETURNING to_jsonb(fixed_assets.*) INTO v_row;

  IF p_event IS NOT NULL THEN
    PERFORM public.ledger_append(p_event);
  END IF;
  RETURN jsonb_build_object('asset', v_row, 'replayed', false);
END;
$function$;


-- ── 3. cancel_order ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id text, p_cause text, p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order public.orders;
  v_row   jsonb;
BEGIN
  IF p_cause IS NULL OR p_cause NOT IN ('customer', 'courier', 'shop') THEN
    RAISE EXCEPTION 'NEXUS_CAUSE_REQUIRED' USING ERRCODE = '23514';
  END IF;

  -- One cancellation at a time per order: a second press waits here, then
  -- finds it already cancelled below.
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.status = 'cancelled' THEN
    RAISE EXCEPTION 'NEXUS_ORDER_ALREADY_CANCELLED' USING ERRCODE = '23505';
  END IF;
  -- Same rule as `ACTIONS_BY_STATUS` (src/lib/orderLifecycle.ts): only an
  -- order still in the shop can be called off; once it left, it is a return.
  IF v_order.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_CANCELLABLE' USING ERRCODE = '23514';
  END IF;

  IF p_event ->> 'kind' IS DISTINCT FROM 'order_cancelled'
     OR (p_event ->> 'store_id')::uuid IS DISTINCT FROM v_order.store_id
     OR p_event ->> 'ref_type' IS DISTINCT FROM 'ecommerce_order'
     OR p_event ->> 'ref_id' IS DISTINCT FROM v_order."orderNumber" THEN
    RAISE EXCEPTION 'NEXUS_EVENT_NOT_THIS_ORDER' USING ERRCODE = '23514';
  END IF;

  -- RLS decides who may cancel; orders_guard_return_cause decides who may
  -- record courier/shop.
  UPDATE public.orders
     SET status = 'cancelled', return_cause = p_cause, "updatedAt" = now(),
         updated_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
   WHERE id = p_order_id
  RETURNING to_jsonb(orders.*) INTO v_row;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_UPDATABLE' USING ERRCODE = '42501';
  END IF;

  PERFORM public.ledger_append(p_event);
  RETURN jsonb_build_object('order', v_row);
END;
$function$;

REVOKE ALL ON FUNCTION public.record_payroll(jsonb, jsonb) FROM public, anon;
REVOKE ALL ON FUNCTION public.record_fixed_asset(jsonb, jsonb) FROM public, anon;
REVOKE ALL ON FUNCTION public.cancel_order(text, text, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.record_payroll(jsonb, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_fixed_asset(jsonb, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_order(text, text, jsonb) TO authenticated, service_role;
