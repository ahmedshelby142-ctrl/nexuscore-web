-- ============================================================================
-- 038 — courier-caused return: the deposit resolution, server-authorised
--
-- WHAT WAS WRONG
-- --------------
-- `depositForfeitedOn(cause, movement)` answered `false` for `courier` and
-- `shop`, and every caller obeyed it immediately. So a courier-caused return
-- REFUNDED the customer's deposit automatically, with nobody deciding and
-- nothing recording that a decision had been made.
--
-- That is a blanket refund rule, and it is wrong for the same reason the
-- blanket forfeit was wrong: it answers a question nobody asked. The real
-- workflow is a sequence, and the two ends of it are days apart:
--
--   courier causes the return  →  the shop claims compensation from them
--                              →  the customer says whether they still want it
--                              →  ONLY THEN is the deposit resolved
--
-- A customer who takes the replacement keeps their deposit working for them.
-- A customer who walks away after OUR provider failed them may have it back —
-- as a case-by-case resolution, explicitly chosen, never as a default.
--
-- WHAT THIS ADDS
-- --------------
-- 1. `deposit_refunded` is added to the money-kinds branch of
--    `insert_ledger_events`, so only ADMIN and ACCOUNTANT may write one. It
--    would otherwise fall to the ELSE branch, which admits all four roles — a
--    cashier could refund a deposit.
--
-- 2. `refund_order_deposit(order, wallet, note)` performs the resolution.
--
-- WHY THE LEDGER IS THE DUPLICATE GUARD
-- -------------------------------------
-- There is no `orders.depositRefundedAt` column and this migration does not
-- add one. A column would be a second truth to keep in step with the money,
-- and `orders` is UPDATE-able by three roles — so the flag guarding a refund
-- would be editable by someone who cannot perform one.
--
-- Instead the eligibility and the duplicate check are the SAME question, asked
-- of the append-only ledger:
--
--   a non-customer-caused return books the deposit to
--   `revenue / deposit_pending_resolution` — cash that is ours for now, and
--   explicitly NOT `forfeited_deposit`, which is final by policy (Rule A).
--
--   `refund_order_deposit` refunds exactly the amount still standing on that
--   subject for this order, and books the reversal against it.
--
-- So the balance IS the entitlement. Refund twice and the second call finds
-- zero and refuses. No flag, no column, nothing to get out of step, and
-- `ledger_events`/`ledger_lines` cannot be updated or deleted by any client
-- role — so the guard cannot be edited away.
--
-- SECURITY: INVOKER, FOR THE REASON 032 GIVES
-- -------------------------------------------
-- This function needs a transaction boundary and a business rule. It does NOT
-- need privileges. Under SECURITY INVOKER the order read and the ledger write
-- execute as the caller, so:
--
--   * a non-member sees no order and gets `NEXUS_ORDER_NOT_FOUND` — the same
--     refusal RLS gives them, from the same policy;
--   * `insert_ledger_events` applies the role gate this migration widens, so
--     POS_ECOMMERCE and ECOMMERCE_ONLY are refused by the policy, not by a
--     copy of it inside this body;
--   * `insert_ledger_lines` applies `store_licensed`, so a lapsed shop cannot
--     refund either.
--
-- A forged `p_order_id` belonging to another store is not a bypass: the SELECT
-- below resolves through `select_orders`, which is `is_store_member(store_id)`
-- against `auth.uid()`.
--
-- The advisory lock is per-order and transaction-scoped. It serialises two
-- operators pressing the button at the same moment, which the balance check
-- alone could not: both would read the same non-zero balance before either
-- wrote. It is not a substitute for the balance check, it is what makes the
-- balance check atomic.
-- ============================================================================

-- ── 1. Only the money roles may write this kind ─────────────────────────────

DROP POLICY IF EXISTS insert_ledger_events ON public.ledger_events;

CREATE POLICY insert_ledger_events ON public.ledger_events
  FOR INSERT
  WITH CHECK (
    is_store_member(store_id) AND
    CASE
      WHEN (kind = ANY (ARRAY['stock_adjustment'::text, 'purchase'::text, 'supplier_payment'::text]))
        THEN has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])
      -- `deposit_refunded` joins the money kinds. Without it the ELSE branch
      -- below admits all four writing roles, and a cashier could hand back a
      -- deposit.
      WHEN (kind = ANY (ARRAY['expense'::text, 'payroll'::text, 'owner_draw'::text, 'wallet_transfer'::text, 'deposit_refunded'::text]))
        THEN has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'ACCOUNTANT'::text])
      ELSE has_role(store_id, VARIADIC ARRAY['ADMIN'::text, 'POS_ECOMMERCE'::text, 'ECOMMERCE_ONLY'::text, 'ACCOUNTANT'::text])
    END
  );

-- ── 2. The resolution itself ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.refund_order_deposit(
  p_order_id text,
  p_wallet   text,
  p_note     text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_order      public.orders;
  v_pending    integer;   -- piastres still standing on deposit_pending_resolution
  v_event_id   text;
  v_device     uuid;
  v_lines      jsonb;
BEGIN
  IF p_wallet IS NULL OR btrim(p_wallet) = '' THEN
    RAISE EXCEPTION 'NEXUS_WALLET_REQUIRED';
  END IF;

  -- Serialise two operators on the same order. Transaction-scoped, so it is
  -- released whether this commits or aborts.
  PERFORM pg_advisory_xact_lock(hashtext('refund_order_deposit:' || p_order_id));

  -- Resolved through `select_orders` — a non-member finds nothing.
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEXUS_ORDER_NOT_FOUND';
  END IF;

  -- ELIGIBILITY. A customer who walked away does not get their deposit back;
  -- that is Rule A and it is not case-by-case. Only a return this shop or its
  -- courier caused opens the resolution at all.
  IF COALESCE(v_order.return_cause, 'unknown') NOT IN ('courier', 'shop') THEN
    RAISE EXCEPTION 'NEXUS_CAUSE_NOT_ELIGIBLE';
  END IF;

  -- How much is actually still owed to this customer. Zero means either the
  -- deposit was never banked, or it was already refunded — and both of those
  -- are the same answer to "is there anything to hand back".
  SELECT COALESCE(SUM(l.amount_delta), 0) INTO v_pending
  FROM public.ledger_lines l
  JOIN public.ledger_events e ON e.id = l.event_id
  WHERE e.store_id = v_order.store_id
    AND e.ref_id = v_order."orderNumber"
    AND l.account = 'revenue'
    AND l.subject_id = 'deposit_pending_resolution';

  IF v_pending <= 0 THEN
    RAISE EXCEPTION 'NEXUS_NOTHING_TO_REFUND';
  END IF;

  -- Any device id belonging to this store will do; the columns are NOT NULL
  -- and the event records the ACTOR in its payload, not the machine.
  v_device := COALESCE(
    (SELECT e.device_id FROM public.ledger_events e
      WHERE e.store_id = v_order.store_id ORDER BY e.created_at DESC LIMIT 1),
    gen_random_uuid()
  );

  v_event_id := gen_random_uuid()::text;

  -- Cash out, and the provisional income reversed against the SAME subject it
  -- was booked to, so the balance returns to zero and a second call refuses.
  v_lines := jsonb_build_array(
    jsonb_build_object(
      'id', gen_random_uuid()::text,
      'account', 'wallet',
      'subject_id', p_wallet,
      'qty_delta', 0,
      'amount_delta', -v_pending
    ),
    jsonb_build_object(
      'id', gen_random_uuid()::text,
      'account', 'revenue',
      'subject_id', 'deposit_pending_resolution',
      'qty_delta', 0,
      'amount_delta', -v_pending
    )
  );

  -- LTV mirrors revenue, exactly as it does everywhere else.
  IF v_order."customerId" IS NOT NULL AND v_order."customerId" <> '' THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'id', gen_random_uuid()::text,
        'account', 'customer_ltv',
        'subject_id', v_order."customerId",
        'qty_delta', 0,
        'amount_delta', -v_pending
      )
    );
  END IF;

  -- Through the atomic path, so the policies decide who may write this and the
  -- header cannot survive a failed line. See migration 032.
  PERFORM public.ledger_append(jsonb_build_object(
    'id', v_event_id,
    'store_id', v_order.store_id,
    'device_id', v_device,
    'kind', 'deposit_refunded',
    'occurred_at', now(),
    'created_at', now(),
    'actor', 'تسوية العميلة',
    'ref_type', 'ecommerce_order',
    'ref_id', v_order."orderNumber",
    -- The WHY, on the append-only record. A resolution that cannot say which
    -- incident authorised it is indistinguishable from an unexplained payout.
    'payload', jsonb_build_object(
      'return_cause', v_order.return_cause,
      'resolution', 'final_cancellation',
      'authorised_as', 'courier_or_shop_caused_return_exception',
      'note', p_note
    )::text,
    'lines', v_lines
  ));

  RETURN v_event_id;
END;
$$;

COMMENT ON FUNCTION public.refund_order_deposit(text, text, text) IS
  'Case-by-case deposit refund after a courier- or shop-caused return. Refuses '
  'a customer-caused cause, a deposit that was never banked, and a second '
  'refund — the standing balance on revenue/deposit_pending_resolution is both '
  'the entitlement and the duplicate guard. SECURITY INVOKER: the role gate is '
  'insert_ledger_events, the tenant gate is select_orders.';

REVOKE ALL ON FUNCTION public.refund_order_deposit(text, text, text) FROM PUBLIC;
-- Supabase's default privileges grant EXECUTE on new public functions to
-- `anon` as well, and REVOKE … FROM PUBLIC does not reach a named role. An
-- anonymous caller would find no order (SECURITY INVOKER + `select_orders`)
-- and get NEXUS_ORDER_NOT_FOUND, so this is tidiness rather than a hole — but
-- an un-signed-in role with EXECUTE on a refund is not a line worth leaving in
-- the advisor's output.
REVOKE EXECUTE ON FUNCTION public.refund_order_deposit(text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.refund_order_deposit(text, text, text) TO authenticated;
