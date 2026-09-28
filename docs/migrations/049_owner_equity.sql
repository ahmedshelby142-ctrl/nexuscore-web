-- ============================================================================
-- 049 — Owner equity: capital and contributions become ledger facts
--
-- BEFORE: "رأس المال" was `partner.capitalContribution`, a number kept in the
-- browser (no cloud table), summed over partner rows. A sole owner with no
-- partner row had no capital at all, and "adding capital" moved no money and
-- wrote nothing to the ledger. Drawings were already correct (`owner_draw`:
-- wallet −, owner_budget +).
--
-- THIS MIGRATION
--   * account `owner_equity` (subject: `owner` or a partner id)
--   * `owner_capital`       — opening capital. owner_equity ± X, and
--                             optionally wallet ± X when the cash arrives now.
--   * `owner_contribution`  — additional capital: owner_equity +X, wallet +X.
--   * both are ADMIN-only to post (insert_ledger_events), everything else in
--     that policy unchanged.
--
-- `ledger_validate_event` is re-created as 046's body byte for byte plus the
-- blocks marked 049 (kinds, allowed accounts, account list, three aggregate
-- columns, two rules). `check_owner_equity.mjs` asserts that. 043–046 files
-- are not modified. Re-runnable. No existing row is touched.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ledger_validate_event(p_event jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_kind     text  := p_event ->> 'kind';
  v_store    uuid  := (p_event ->> 'store_id')::uuid;
  v_ref_type text  := p_event ->> 'ref_type';
  v_ref_id   text  := p_event ->> 'ref_id';
  v_lines    jsonb := COALESCE(p_event -> 'lines', '[]'::jsonb);
  v_allowed  text[];
  v_n int; v_bad_account int; v_no_subject int; v_qty_off_stock int; v_zero_qty int;
  v_sign_clash int; v_bad_cost int; v_bad_wallet int; v_off_kind int;
  w bigint; r bigint; rc bigint; rco bigint; pc bigint; ps bigint; ex bigint;
  st bigint; ltv bigint; ob bigint;
  v_stock_in int; v_stock_out int; v_wallet_in int; v_wallet_out int;
  v_rev_neg int; v_rev_not_deposit int; v_rco_neg int; v_rco_pos int;
  v_pc_neg int; v_pc_pos int; v_ex_neg int; v_ex_pos int; v_cogs_neg int;
  v_prior bigint; v_outstanding numeric; v_subject text;
  -- 046: the order an order_placed reserves for
  v_total numeric; v_ship numeric; v_dep numeric; v_cod numeric; v_disc numeric; v_goods numeric;
  -- 049: owner equity
  oe bigint; v_oe_lines int; v_oe_subject text;
BEGIN
  IF jsonb_typeof(v_lines) <> 'array' THEN
    RAISE EXCEPTION 'ledger: lines must be an array' USING ERRCODE = '23514';
  END IF;

  IF v_kind IS NULL OR v_kind <> ALL (ARRAY[
      'sale', 'order_placed', 'order_delivered', 'order_returned_pending',
      'order_cancelled', 'order_edited', 'return_confirmed', 'rto_confirmed',
      'purchase', 'supplier_payment', 'client_payment', 'expense', 'payroll',
      'wallet_transfer', 'courier_settlement', 'owner_draw', 'stock_adjustment',
      'deposit_refunded',
      -- 049: owner equity
      'owner_capital', 'owner_contribution']) THEN
    RAISE EXCEPTION 'ledger: unknown event kind "%"', v_kind USING ERRCODE = '23514';
  END IF;

  v_n := jsonb_array_length(v_lines);
  IF v_kind = 'order_returned_pending' THEN
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'ledger: order_returned_pending moves nothing' USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'ledger: % must move something', v_kind USING ERRCODE = '23514';
  END IF;

  v_allowed := CASE v_kind
    WHEN 'sale'               THEN ARRAY['stock','cogs','wallet','receivable_client','revenue','customer_ltv','expense']
    WHEN 'order_placed'       THEN ARRAY['stock','wallet']
    WHEN 'order_edited'       THEN ARRAY['stock']
    WHEN 'order_cancelled'    THEN ARRAY['stock','wallet','revenue','customer_ltv']
    WHEN 'order_delivered'    THEN ARRAY['cogs','receivable_courier','revenue','payable_courier','customer_ltv']
    WHEN 'return_confirmed'   THEN ARRAY['stock','cogs','wallet','receivable_client','receivable_courier','payable_courier','revenue','expense','customer_ltv']
    WHEN 'rto_confirmed'      THEN ARRAY['stock','payable_courier','expense','receivable_courier','wallet','revenue','customer_ltv']
    WHEN 'purchase'           THEN ARRAY['stock','wallet','payable_supplier']
    WHEN 'supplier_payment'   THEN ARRAY['wallet','payable_supplier']
    WHEN 'client_payment'     THEN ARRAY['wallet','receivable_client']
    WHEN 'expense'            THEN ARRAY['wallet','expense']
    WHEN 'payroll'            THEN ARRAY['wallet','expense']
    WHEN 'wallet_transfer'    THEN ARRAY['wallet']
    WHEN 'courier_settlement' THEN ARRAY['wallet','receivable_courier','payable_courier','expense']
    WHEN 'owner_draw'         THEN ARRAY['wallet','owner_budget']
    WHEN 'stock_adjustment'   THEN ARRAY['stock','expense','wallet']
    WHEN 'deposit_refunded'   THEN ARRAY['wallet','revenue','customer_ltv']
    WHEN 'owner_capital'      THEN ARRAY['owner_equity','wallet']
    WHEN 'owner_contribution' THEN ARRAY['owner_equity','wallet']
  END;

  WITH ln AS (
    SELECT l ->> 'account'                          AS acc,
           NULLIF(btrim(l ->> 'subject_id'), '')    AS subj,
           COALESCE((l ->> 'qty_delta')::real, 0)   AS q,
           COALESCE((l ->> 'amount_delta')::integer, 0)::bigint AS a,
           NULLIF(l ->> 'unit_cost', '')::integer   AS uc
      FROM jsonb_array_elements(v_lines) AS l
  )
  SELECT
    count(*) FILTER (WHERE acc IS NULL OR acc <> ALL (ARRAY['stock','wallet','revenue','cogs','expense',
                     'payable_supplier','receivable_client','receivable_courier','payable_courier',
                     'customer_ltv','owner_budget','owner_equity'])),
    count(*) FILTER (WHERE subj IS NULL),
    count(*) FILTER (WHERE acc <> 'stock' AND q <> 0),
    count(*) FILTER (WHERE acc = 'stock' AND q = 0),
    count(*) FILTER (WHERE acc = 'stock' AND ((q > 0 AND a < 0) OR (q < 0 AND a > 0))),
    count(*) FILTER (WHERE uc IS NOT NULL AND (uc < 0 OR acc NOT IN ('stock','cogs'))),
    count(*) FILTER (WHERE acc = 'wallet'
                       AND lower(subj) <> ALL (ARRAY['instoresafe','vodafonecash','instapay','bankaccount'])),
    count(*) FILTER (WHERE acc IS NOT NULL AND acc <> ALL (v_allowed)),
    COALESCE(sum(a) FILTER (WHERE acc = 'wallet'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'revenue'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'receivable_client'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'receivable_courier'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'payable_courier'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'payable_supplier'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'expense'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'stock'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'customer_ltv'), 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'owner_budget'), 0),
    count(*) FILTER (WHERE acc = 'stock' AND q > 0),
    count(*) FILTER (WHERE acc = 'stock' AND q < 0),
    count(*) FILTER (WHERE acc = 'wallet' AND a > 0),
    count(*) FILTER (WHERE acc = 'wallet' AND a <= 0),
    count(*) FILTER (WHERE acc = 'revenue' AND a < 0),
    count(*) FILTER (WHERE acc = 'revenue' AND (a <= 0 OR subj NOT IN ('forfeited_deposit','deposit_pending_resolution'))),
    count(*) FILTER (WHERE acc = 'receivable_courier' AND a < 0),
    count(*) FILTER (WHERE acc = 'receivable_courier' AND a >= 0),
    count(*) FILTER (WHERE acc = 'payable_courier' AND a < 0),
    count(*) FILTER (WHERE acc = 'payable_courier' AND a >= 0),
    count(*) FILTER (WHERE acc = 'expense' AND a < 0),
    count(*) FILTER (WHERE acc = 'expense' AND a <= 0),
    count(*) FILTER (WHERE acc = 'cogs' AND a < 0),
    COALESCE(sum(a) FILTER (WHERE acc = 'owner_equity'), 0),
    count(*) FILTER (WHERE acc = 'owner_equity'),
    (array_agg(subj) FILTER (WHERE acc = 'owner_equity'))[1]
  INTO v_bad_account, v_no_subject, v_qty_off_stock, v_zero_qty, v_sign_clash, v_bad_cost,
       v_bad_wallet, v_off_kind, w, r, rc, rco, pc, ps, ex, st, ltv, ob,
       v_stock_in, v_stock_out, v_wallet_in, v_wallet_out, v_rev_neg, v_rev_not_deposit,
       v_rco_neg, v_rco_pos, v_pc_neg, v_pc_pos, v_ex_neg, v_ex_pos, v_cogs_neg,
       oe, v_oe_lines, v_oe_subject
  FROM ln;

  -- ── Every line ────────────────────────────────────────────────────────────
  IF v_bad_account > 0 THEN
    RAISE EXCEPTION 'ledger: unknown account on a % line', v_kind USING ERRCODE = '23514';
  END IF;
  IF v_no_subject > 0 THEN
    RAISE EXCEPTION 'ledger: every % line needs a subject', v_kind USING ERRCODE = '23514';
  END IF;
  IF v_qty_off_stock > 0 OR v_zero_qty > 0 OR v_sign_clash > 0 THEN
    RAISE EXCEPTION 'ledger: only stock carries a quantity, and never zero or signed against its value'
      USING ERRCODE = '23514';
  END IF;
  IF v_bad_cost > 0 THEN
    RAISE EXCEPTION 'ledger: unit cost must be non-negative and only on stock or cogs' USING ERRCODE = '23514';
  END IF;
  IF v_bad_wallet > 0 THEN
    RAISE EXCEPTION 'ledger: a wallet line must name one of the shop''s wallets' USING ERRCODE = '23514';
  END IF;
  IF v_off_kind > 0 THEN
    RAISE EXCEPTION 'ledger: % cannot move that account', v_kind USING ERRCODE = '23514';
  END IF;

  -- ── Per kind ──────────────────────────────────────────────────────────────
  IF v_kind = 'sale' THEN
    IF w + rc <> r THEN
      RAISE EXCEPTION 'ledger: sale — money in (wallet + receivable) must equal revenue' USING ERRCODE = '23514';
    END IF;
    IF ltv NOT IN (0, r) OR v_ex_neg > 0 THEN
      RAISE EXCEPTION 'ledger: sale — customer value must match revenue, and a delivery cost is a cost'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'order_placed' THEN
    IF v_stock_out = 0 OR v_stock_in > 0 OR v_wallet_out > 0 THEN
      RAISE EXCEPTION 'ledger: order_placed — reserves stock and may only take a deposit in'
        USING ERRCODE = '23514';
    END IF;
    -- 046 — the deposit is bounded by the order it is paid on.
    --
    -- The order row must already exist in this store: `place_order` (045)
    -- inserts it in this same transaction, so a placement can no longer reach
    -- the ledger ahead of the document that says what is owed.
    SELECT o."totalAmount", o."shippingFee", o."depositAmount", o."expectedCod",
           COALESCE(o."discountAmount", 0),
           (SELECT COALESCE(sum((i ->> 'quantity')::numeric * (i ->> 'unitPrice')::numeric), 0)
              FROM jsonb_array_elements(COALESCE(o.items, '[]'::jsonb)) AS i)
      INTO v_total, v_ship, v_dep, v_cod, v_disc, v_goods
      FROM public.orders o
     WHERE o.store_id = v_store
       AND o."orderNumber" = v_ref_id
       AND o.deleted_at IS NULL;
    IF v_ref_type IS DISTINCT FROM 'ecommerce_order' OR v_ref_id IS NULL OR NOT FOUND THEN
      RAISE EXCEPTION 'ledger: order_placed — must reserve for an order in this store (place it with place_order)'
        USING ERRCODE = '23514';
    END IF;
    -- One placement per order: a second one would bank the deposit twice.
    IF EXISTS (SELECT 1 FROM public.ledger_events e
                WHERE e.store_id = v_store AND e.kind = 'order_placed'
                  AND e.ref_type = 'ecommerce_order' AND e.ref_id = v_ref_id) THEN
      RAISE EXCEPTION 'ledger: order_placed — this order is already placed' USING ERRCODE = '23514';
    END IF;
    -- The order's own figures must add up, exactly as every order in
    -- production does: goods − discount = total, deposit + COD = total +
    -- shipping, nothing negative. With COD ≥ 0 that IS the bound:
    --     deposit ≤ total + shipping = everything this order can ever owe.
    IF v_total < 0 OR v_ship < 0 OR v_dep < 0 OR v_cod < 0
       OR abs(v_goods - v_disc - v_total) >= 0.005
       OR abs(v_dep + v_cod - v_total - v_ship) >= 0.005 THEN
      RAISE EXCEPTION 'ledger: order_placed — the order''s total, deposit and COD do not add up'
        USING ERRCODE = '23514';
    END IF;
    -- And the money banked is that deposit — not more (within one piastre of
    -- rounding: the row holds EGP, the line holds piastres).
    IF abs(w - v_dep * 100) >= 1 THEN
      RAISE EXCEPTION 'ledger: order_placed — the deposit banked must be the order''s deposit'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'order_cancelled' THEN
    IF v_stock_out > 0 OR v_wallet_in > 0 OR v_rev_not_deposit > 0 OR (w < 0 AND r > 0) OR ltv NOT IN (0, r) THEN
      RAISE EXCEPTION 'ledger: order_cancelled — returns stock and either refunds or keeps the deposit'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'order_delivered' THEN
    IF v_rco_neg > 0 OR v_pc_neg > 0 OR v_rev_neg > 0 OR v_cogs_neg > 0 OR ltv NOT IN (0, r) THEN
      RAISE EXCEPTION 'ledger: order_delivered — every amount is money owed or earned, never negative'
        USING ERRCODE = '23514';
    END IF;
    -- What the courier holds can never exceed what is still owed: the goods
    -- and the fee, less every deposit already booked on this order. Only the
    -- kinds that move a DEPOSIT count — a per-order courier_settlement also
    -- carries this ref and a wallet line, and it is not a deposit.
    v_prior := 0;
    IF v_ref_id IS NOT NULL THEN
      SELECT COALESCE(sum(l.amount_delta), 0) INTO v_prior
        FROM public.ledger_events e
        JOIN public.ledger_lines l ON l.event_id = e.id
       WHERE e.store_id = v_store
         AND e.ref_type = 'ecommerce_order'
         AND e.ref_id = v_ref_id
         AND e.kind IN ('order_placed', 'client_payment', 'order_cancelled', 'rto_confirmed', 'deposit_refunded')
         AND l.account = 'wallet';
    END IF;
    IF v_prior + rco > r + pc THEN
      RAISE EXCEPTION 'ledger: order_delivered — COD plus deposits is more than goods plus shipping'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'return_confirmed' THEN
    IF w + rc + rco - pc + ex <> r OR r > 0 OR v_stock_out > 0 OR ltv NOT IN (0, r) THEN
      RAISE EXCEPTION 'ledger: return_confirmed — the refund must equal the revenue it reverses'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'rto_confirmed' THEN
    IF rco - pc + ex <> 0 OR v_wallet_in > 0 OR v_rev_not_deposit > 0 OR v_stock_out > 0 OR ltv NOT IN (0, r) THEN
      RAISE EXCEPTION 'ledger: rto_confirmed — the fee must net out and money may only go back'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'purchase' THEN
    IF st + w - ps <> 0 THEN
      RAISE EXCEPTION 'ledger: purchase — stock value must equal what was paid plus what is owed'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'supplier_payment' THEN
    IF w <> ps OR w >= 0 THEN
      RAISE EXCEPTION 'ledger: supplier_payment — money out must equal the debt paid down' USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'client_payment' THEN
    IF v_wallet_out > 0 THEN
      RAISE EXCEPTION 'ledger: client_payment — a payment is money in' USING ERRCODE = '23514';
    END IF;
    IF rc <> 0 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) l WHERE l ->> 'account' = 'receivable_client') THEN
      IF w + rc <> 0 THEN
        RAISE EXCEPTION 'ledger: client_payment — money in must equal the debt paid down' USING ERRCODE = '23514';
      END IF;
    ELSE
      -- An order top-up: the money is only as real as the order it is owed on.
      SELECT o."expectedCod" INTO v_outstanding
        FROM public.orders o
       WHERE o.store_id = v_store
         AND o."orderNumber" = v_ref_id
         AND o.deleted_at IS NULL
       LIMIT 1;
      IF v_ref_type IS DISTINCT FROM 'ecommerce_order' OR NOT FOUND THEN
        RAISE EXCEPTION 'ledger: client_payment — a top-up must name an order in this store'
          USING ERRCODE = '23514';
      END IF;
      IF w > round(COALESCE(v_outstanding, 0) * 100) THEN
        RAISE EXCEPTION 'ledger: client_payment — more than is still owed on the order' USING ERRCODE = '23514';
      END IF;
    END IF;

  ELSIF v_kind IN ('expense', 'payroll') THEN
    IF w + ex <> 0 OR w >= 0 THEN
      RAISE EXCEPTION 'ledger: % — money out must equal the cost booked', v_kind USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'wallet_transfer' THEN
    IF v_n < 2 OR w <> 0 THEN
      RAISE EXCEPTION 'ledger: wallet_transfer — moves money between wallets and creates none'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'courier_settlement' THEN
    IF w + rco - pc + ex <> 0 OR v_wallet_out > 0 OR v_rco_pos > 0 OR v_pc_pos > 0 OR v_ex_neg > 0 THEN
      RAISE EXCEPTION 'ledger: courier_settlement — cash in must equal what the courier held, less fees'
        USING ERRCODE = '23514';
    END IF;
    -- A courier cannot hand over more than they hold, nor be paid fees they
    -- are not owed. Serialized per courier so two settlements cannot both pass.
    FOR v_subject IN
      SELECT DISTINCT l ->> 'subject_id' FROM jsonb_array_elements(v_lines) l
       WHERE l ->> 'account' IN ('receivable_courier', 'payable_courier')
       ORDER BY 1
    LOOP
      PERFORM pg_advisory_xact_lock(hashtext('ledger_courier:' || v_store::text || ':' || v_subject));
      IF (SELECT COALESCE(sum(amount_delta), 0) FROM public.ledger_lines
           WHERE store_id = v_store AND account = 'receivable_courier' AND subject_id = v_subject)
         + (SELECT COALESCE(sum((l ->> 'amount_delta')::integer), 0) FROM jsonb_array_elements(v_lines) l
             WHERE l ->> 'account' = 'receivable_courier' AND l ->> 'subject_id' = v_subject) < 0
      OR (SELECT COALESCE(sum(amount_delta), 0) FROM public.ledger_lines
           WHERE store_id = v_store AND account = 'payable_courier' AND subject_id = v_subject)
         + (SELECT COALESCE(sum((l ->> 'amount_delta')::integer), 0) FROM jsonb_array_elements(v_lines) l
             WHERE l ->> 'account' = 'payable_courier' AND l ->> 'subject_id' = v_subject) < 0
      THEN
        RAISE EXCEPTION 'ledger: courier_settlement — more than courier % holds or is owed', v_subject
          USING ERRCODE = '23514';
      END IF;
    END LOOP;

  ELSIF v_kind = 'owner_draw' THEN
    IF w + ob <> 0 OR w >= 0 THEN
      RAISE EXCEPTION 'ledger: owner_draw — money out must equal what was drawn' USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'stock_adjustment' THEN
    IF v_wallet_in + v_wallet_out > 0 AND (v_ref_type IS DISTINCT FROM 'opening_balance' OR v_n <> 1) THEN
      RAISE EXCEPTION 'ledger: stock_adjustment — a wallet moves only as a lone opening balance'
        USING ERRCODE = '23514';
    END IF;
    IF v_ex_neg + v_ex_pos > 0 AND st + ex <> 0 THEN
      RAISE EXCEPTION 'ledger: stock_adjustment — a counted difference must be booked at its value'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_kind = 'deposit_refunded' THEN
    IF w <> r OR w >= 0 OR ltv NOT IN (0, r) THEN
      RAISE EXCEPTION 'ledger: deposit_refunded — the refund must reverse the held deposit' USING ERRCODE = '23514';
    END IF;

  -- ── 049: owner equity ────────────────────────────────────────────────────
  -- Capital is what the owner PUT IN. One owner_equity line, keyed by who
  -- (`owner` or a partner id). With a wallet line it is cash arriving now, and
  -- the two are equal; without one it declares capital put in before the
  -- ledger existed, which the equity statement carves out of the opening
  -- balances instead of counting twice. A negative capital line is a
  -- correction; no owner's recorded capital may end below zero.
  ELSIF v_kind = 'owner_capital' THEN
    IF v_oe_lines <> 1 OR oe = 0 OR v_wallet_in + v_wallet_out > 1 OR (v_wallet_in + v_wallet_out = 1 AND w <> oe) THEN
      RAISE EXCEPTION 'ledger: owner_capital — one capital line, and any cash equal to it' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(sum(l.amount_delta), 0) INTO v_prior
      FROM public.ledger_lines l
      JOIN public.ledger_events e ON e.id = l.event_id
     WHERE l.store_id = v_store AND l.account = 'owner_equity'
       AND e.kind = 'owner_capital' AND l.subject_id = v_oe_subject;
    IF v_prior + oe < 0 THEN
      RAISE EXCEPTION 'ledger: owner_capital — % cannot have less than no capital', v_oe_subject USING ERRCODE = '23514';
    END IF;

  -- A later contribution is money entering the business from its owner: equity
  -- up, the wallet it landed in up by the same amount. Never revenue.
  ELSIF v_kind = 'owner_contribution' THEN
    IF v_oe_lines <> 1 OR oe <= 0 OR v_wallet_in <> 1 OR v_wallet_out <> 0 OR w <> oe THEN
      RAISE EXCEPTION 'ledger: owner_contribution — the equity in must equal the cash in' USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.ledger_validate_event(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.ledger_validate_event(jsonb) TO authenticated, service_role;


-- ── Who may post owner equity ──────────────────────────────────────────────
-- The ELSE branch admits every selling role, so without this a POS login could
-- declare capital. Capital is the owner's: ADMIN only. Every other branch is
-- the live policy verbatim.
ALTER POLICY insert_ledger_events ON public.ledger_events
  WITH CHECK (
    public.is_store_member(store_id) AND
    CASE
      WHEN kind = ANY (ARRAY['owner_capital', 'owner_contribution'])
        THEN public.has_role(store_id, VARIADIC ARRAY['ADMIN'])
      WHEN kind = ANY (ARRAY['stock_adjustment', 'purchase', 'supplier_payment'])
        THEN public.has_role(store_id, VARIADIC ARRAY['ADMIN', 'ACCOUNTANT'])
      WHEN kind = ANY (ARRAY['expense', 'payroll', 'owner_draw', 'wallet_transfer', 'deposit_refunded'])
        THEN public.has_role(store_id, VARIADIC ARRAY['ADMIN', 'ACCOUNTANT'])
      ELSE public.has_role(store_id, VARIADIC ARRAY['ADMIN', 'POS_ECOMMERCE', 'ECOMMERCE_ONLY', 'ACCOUNTANT'])
    END
  );
