-- ============================================================================
-- 044 — a new ledger event must make sense for its kind
--
-- Safe to re-run: CREATE OR REPLACE only. Adds ONE validator and re-creates
-- `ledger_append` identical to 032 except for one line that calls it FIRST,
-- before any insert. No table, column, policy or row is changed; migration
-- 043 (lines only for a same-transaction event; product id immutable) is not
-- touched. History is not re-validated — the check runs on new events only.
--
-- THE PROBLEM
-- -----------
-- 043 closed "add a line to an OLD event". A NEW event was still accepted with
-- any lines at all. Reproduced 2026-09-27 as the real POS_ECOMMERCE member,
-- through `ledger_append`, rolled back — every one ACCEPTED, the till went
-- 423,000 → 400,423,000 piastres:
--   * `sale` with one line: `wallet +100,000,000` — cash with no sale;
--   * kind `bonus` — no kind list exists, so the events policy's ELSE branch
--     let every selling role post a kind that does not exist;
--   * account `free_money` — no account list exists either;
--   * `order_delivered` with only `receivable_courier +1M`, then a
--     `courier_settlement` turning it into `wallet +1M`;
--   * `client_payment` top-up of 1M on an order that does not exist.
--
-- WHY NOT "EVERY EVENT BALANCES"
-- ------------------------------
-- This ledger is not double-entry. A sale writes `stock −` at cost, `wallet +`
-- and `revenue +` at price, `cogs +` at cost and `customer_ltv +` at price — it
-- is several independent dimensions of one fact, and they do not sum to zero.
-- A wallet opening balance is ONE `wallet +` line by design (the money predates
-- the ledger), and a deposit is `wallet +` on `order_placed` whose counterpart
-- lives in the order document. A global balance rule would reject real sales.
--
-- So each kind gets the equation its OWN builder satisfies. Every equation
-- below was checked against the code (`src/lib/ledger/*.ts`, the only line
-- builders) AND against every event in production before it was written here.
--
-- THE INVARIANTS (piastres; w = wallet, r = revenue, rc = receivable_client,
-- rco = receivable_courier, pc = payable_courier, ps = payable_supplier,
-- ex = expense, st = stock value, ltv = customer_ltv, ob = owner_budget)
--
--   every line   account ∈ the 11 accounts; subject present; only `stock`
--                carries a quantity, and a stock line's quantity is non-zero
--                and never signed against its value; unit_cost ≥ 0 and only
--                on stock/cogs; a wallet is one of the four canonical wallets
--   kind         ∈ the 18 kinds the code and 038's RPC write
--   sale                 w + rc = r ; ltv ∈ {0, r} ; expense lines ≥ 0
--   order_placed         stock (all out, at least one) + wallet (all in)
--   order_edited         stock only
--   order_cancelled      stock in ; wallet out ; revenue in only as
--                        forfeited/pending deposit ; not both ; ltv ∈ {0, r}
--   order_returned_pending  no lines
--   order_delivered      no wallet ; rco, pc, r, cogs ≥ 0 ; ltv ∈ {0, r} ;
--                        deposits already booked on this order + rco ≤ r + pc
--   return_confirmed     w + rc + rco − pc + ex = r ; r ≤ 0 ; stock in ;
--                        ltv ∈ {0, r}
--   rto_confirmed        rco − pc + ex = 0 ; wallet out ; revenue in only as
--                        forfeited/pending deposit ; stock in ; ltv ∈ {0, r}
--   purchase             st + w − ps = 0   (supplier returns included)
--   supplier_payment     w = ps < 0
--   client_payment       wallet in ; with rc: w + rc = 0 ; without rc (an
--                        order top-up): the order exists in this store and
--                        w ≤ its outstanding expectedCod
--   expense, payroll     w + ex = 0, w < 0
--   wallet_transfer      wallet only, ≥ 2 lines, Σw = 0
--   courier_settlement   w + rco − pc + ex = 0 ; wallet in, rco/pc out,
--                        expense (shortfall) in ; and neither courier balance
--                        may go below zero (serialized per courier)
--   owner_draw           w + ob = 0, w < 0
--   stock_adjustment     stock/expense/wallet ; a wallet line only as a lone
--                        opening balance ; with expense: st + ex = 0
--   deposit_refunded     w = r < 0 ; ltv ∈ {0, r}
--
-- WHAT THIS DOES NOT DO — recorded, not hidden
-- --------------------------------------------
-- It enforces that an event is internally consistent and consistent with the
-- documents it names. It cannot know that a consistent event is TRUE: a
-- cashier recording a real-looking sale for goods that never left is fraud,
-- not a malformed ledger. And a deposit taken at `order_placed` cannot be
-- bound to its order here, because the app appends that event BEFORE it writes
-- the order row (`routes/ecommerce-orders.tsx`). Both are listed as residuals
-- in DESKTOP_PRODUCT_AUDIT.md §I.
--
-- The validator is SECURITY INVOKER and reads through the caller's RLS, so a
-- cross-event check can only ever see the caller's own store. It raises
-- `23514` (check_violation) with a message naming the kind and the rule, and
-- because it runs before the first INSERT, a refused event writes nothing.
-- No `EXCEPTION` handler anywhere: 043's same-transaction test depends on the
-- append never running inside a subtransaction.
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
BEGIN
  IF jsonb_typeof(v_lines) <> 'array' THEN
    RAISE EXCEPTION 'ledger: lines must be an array' USING ERRCODE = '23514';
  END IF;

  IF v_kind IS NULL OR v_kind <> ALL (ARRAY[
      'sale', 'order_placed', 'order_delivered', 'order_returned_pending',
      'order_cancelled', 'order_edited', 'return_confirmed', 'rto_confirmed',
      'purchase', 'supplier_payment', 'client_payment', 'expense', 'payroll',
      'wallet_transfer', 'courier_settlement', 'owner_draw', 'stock_adjustment',
      'deposit_refunded']) THEN
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
                     'customer_ltv','owner_budget'])),
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
    count(*) FILTER (WHERE acc = 'cogs' AND a < 0)
  INTO v_bad_account, v_no_subject, v_qty_off_stock, v_zero_qty, v_sign_clash, v_bad_cost,
       v_bad_wallet, v_off_kind, w, r, rc, rco, pc, ps, ex, st, ltv, ob,
       v_stock_in, v_stock_out, v_wallet_in, v_wallet_out, v_rev_neg, v_rev_not_deposit,
       v_rco_neg, v_rco_pos, v_pc_neg, v_pc_pos, v_ex_neg, v_ex_pos, v_cogs_neg
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
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.ledger_validate_event(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.ledger_validate_event(jsonb) TO authenticated, service_role;

-- `ledger_append` exactly as migration 032 wrote it, plus the first PERFORM.
CREATE OR REPLACE FUNCTION public.ledger_append(p_event jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id        text;
  v_store_id  uuid;
  v_device_id uuid;
  v_lines     jsonb;
  v_count     integer;
BEGIN
  v_id        := p_event ->> 'id';
  v_store_id  := (p_event ->> 'store_id')::uuid;
  v_device_id := (p_event ->> 'device_id')::uuid;
  v_lines     := COALESCE(p_event -> 'lines', '[]'::jsonb);

  IF v_id IS NULL OR v_store_id IS NULL OR v_device_id IS NULL THEN
    RAISE EXCEPTION 'ledger_append: id, store_id and device_id are required';
  END IF;
  IF p_event ->> 'kind' IS NULL THEN
    RAISE EXCEPTION 'ledger_append: kind is required';
  END IF;
  IF jsonb_typeof(v_lines) <> 'array' THEN
    RAISE EXCEPTION 'ledger_append: lines must be an array';
  END IF;

  -- 044: the event must make sense for its kind — checked before anything is
  -- written, so a refused event leaves no header and no line behind.
  PERFORM public.ledger_validate_event(p_event);

  INSERT INTO public.ledger_events (
    id, store_id, device_id, kind, occurred_at, created_at,
    actor, ref_type, ref_id, payload, sync_status
  ) VALUES (
    v_id,
    v_store_id,
    v_device_id,
    p_event ->> 'kind',
    p_event ->> 'occurred_at',
    p_event ->> 'created_at',
    p_event ->> 'actor',
    p_event ->> 'ref_type',
    p_event ->> 'ref_id',
    COALESCE(p_event ->> 'payload', '{}'),
    'synced'
  );

  INSERT INTO public.ledger_lines (
    id, event_id, store_id, device_id,
    account, subject_id, qty_delta, amount_delta, unit_cost, sync_status
  )
  SELECT
    line ->> 'id',
    v_id,
    v_store_id,
    v_device_id,
    line ->> 'account',
    line ->> 'subject_id',
    COALESCE((line ->> 'qty_delta')::real, 0),
    COALESCE((line ->> 'amount_delta')::integer, 0),
    NULLIF(line ->> 'unit_cost', '')::integer,
    'synced'
  FROM jsonb_array_elements(v_lines) AS line;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF jsonb_array_length(v_lines) > 0 AND v_count <> jsonb_array_length(v_lines) THEN
    RAISE EXCEPTION 'ledger_append: % of % lines were written',
      v_count, jsonb_array_length(v_lines);
  END IF;

  RETURN v_id;
END;
$function$;
