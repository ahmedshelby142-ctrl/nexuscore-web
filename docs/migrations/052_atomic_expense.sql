-- ============================================================================
-- 052 — Atomic expense: the ledger event and the expense document together.
--
-- «المالية العامة» recorded an expense in two requests: the `expense` ledger
-- event (money out of the wallet), then the `expenses` document. When the
-- second failed the money had moved with no document — no line in the
-- expenses list and, worse, nothing counted against the category's budget cap,
-- so the next expense could go over it. A retry after a lost answer booked the
-- money twice.
--
-- record_expense writes both in ONE transaction, idempotent on the document id
-- (a retry returns the row already recorded — `replayed` — and moves nothing),
-- with the event tied to the document (`ref_id` = its id; its cost line must be
-- exactly the document's category and amount).
--
-- The budget cap is checked HERE too, inside the transaction and before any
-- write, under a lock on the cap row — the same rule the screen applies
-- (`checkExpenseBudget`): spent + amount must not exceed the cap, where spent
-- is the category's expense documents (plus payroll documents for
-- «salaries»). The screen's check stays, for the early message; this one closes
-- the two-devices-at-once race the screen cannot see.
--
-- SECURITY INVOKER: `write_expenses` (ADMIN, ACCOUNTANT) and
-- `insert_ledger_events` decide who may. No EXCEPTION block anywhere (043).
-- Additive: one nullable column, one partial unique index, one function.
-- ============================================================================

ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS ledger_event_id text;
CREATE UNIQUE INDEX IF NOT EXISTS expenses_one_event
  ON public.expenses (ledger_event_id) WHERE ledger_event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.record_expense(p_expense jsonb, p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id       text := p_expense ->> 'id';
  v_store    uuid := (p_expense ->> 'store_id')::uuid;
  v_category text := p_expense ->> 'category';
  v_amount   numeric := (p_expense ->> 'amount')::numeric;
  v_row      jsonb;
  v_cap      numeric;
  v_spent    numeric;
  v_booked   bigint;
BEGIN
  IF v_id IS NULL OR v_store IS NULL OR NULLIF(v_category, '') IS NULL OR v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'NEXUS_DOCUMENT_INVALID' USING ERRCODE = '23514';
  END IF;

  -- A retry after a lost answer: the expense is already paid. Say so.
  SELECT to_jsonb(x.*) INTO v_row FROM public.expenses x WHERE x.id = v_id AND x.store_id = v_store;
  IF v_row IS NOT NULL THEN
    RETURN jsonb_build_object('expense', v_row, 'replayed', true);
  END IF;

  -- The event must be THIS expense: same store, pointing at this document, and
  -- booking exactly this amount to exactly this category.
  SELECT COALESCE(SUM((l ->> 'amount_delta')::bigint), 0) INTO v_booked
    FROM jsonb_array_elements(COALESCE(p_event -> 'lines', '[]'::jsonb)) l
   WHERE l ->> 'account' = 'expense' AND l ->> 'subject_id' = v_category;
  IF p_event ->> 'kind' IS DISTINCT FROM 'expense'
     OR (p_event ->> 'store_id')::uuid IS DISTINCT FROM v_store
     OR p_event ->> 'ref_type' IS DISTINCT FROM 'expense'
     OR p_event ->> 'ref_id' IS DISTINCT FROM v_id
     OR v_booked <> round(v_amount * 100) THEN
    RAISE EXCEPTION 'NEXUS_EVENT_NOT_THIS_DOCUMENT' USING ERRCODE = '23514';
  END IF;

  -- The cap, before anything moves. Locked, so two devices spending the last
  -- of a budget at once cannot both pass.
  SELECT c."capAmount" INTO v_cap FROM public.budget_caps c
   WHERE c.store_id = v_store AND c.category = v_category AND c.deleted_at IS NULL
   FOR UPDATE;
  IF v_cap IS NOT NULL THEN
    SELECT COALESCE(SUM(e.amount), 0) INTO v_spent FROM public.expenses e
     WHERE e.store_id = v_store AND e.category = v_category AND e.deleted_at IS NULL;
    IF v_category = 'salaries' THEN
      v_spent := v_spent + (SELECT COALESCE(SUM(p.amount), 0) FROM public.payroll p
                             WHERE p.store_id = v_store AND p.deleted_at IS NULL);
    END IF;
    IF v_spent + v_amount > v_cap THEN
      RAISE EXCEPTION 'NEXUS_OVER_BUDGET' USING ERRCODE = '23514',
        DETAIL = format('cap %s, spent %s, requested %s', v_cap, v_spent, v_amount);
    END IF;
  END IF;

  INSERT INTO public.expenses (id, store_id, device_id, category, amount, description, date,
                               ledger_event_id, updated_at, sync_status)
  VALUES (v_id, v_store, (p_expense ->> 'device_id')::uuid, v_category, v_amount,
          p_expense ->> 'description', COALESCE((p_expense ->> 'date')::timestamptz, now()),
          p_event ->> 'id', (extract(epoch FROM clock_timestamp()) * 1000)::bigint, 'synced')
  RETURNING to_jsonb(expenses.*) INTO v_row;

  PERFORM public.ledger_append(p_event);
  RETURN jsonb_build_object('expense', v_row, 'replayed', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.record_expense(jsonb, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.record_expense(jsonb, jsonb) TO authenticated, service_role;
