-- 034 — the period filter, and the first Owner-only financial reader.
--
-- ## Blocker A — dated aggregation was a STRING comparison
--
-- `ledger_events.occurred_at` is a `text` column. `driver.balances` filtered it
-- with `.gte(occurred_at, from.toISOString())`, so PostgREST compared text to
-- text. The table holds two spellings of the same instant:
--
--     2026-09-12T14:18:07.675Z            (ISO, what `toISOString()` produces)
--     2026-09-12 14:18:07.675957+00       (Postgres style, 27 of 321 events)
--
-- and `' ' (0x20) < 'T' (0x54)`, so every Postgres-style row sorts BELOW the
-- lower bound of its own day and is dropped. Measured on this database for
-- 2026-09-12: the text comparison returned 308.00 EGP of revenue where the
-- timestamps mean 3,100.00 EGP, and 14 in-period events vanished.
--
-- The fix is not to rewrite history — the ledger is append-only and both
-- spellings are valid, unambiguous instants. It is to stop comparing them as
-- text. `ledger_balances` casts once, in SQL, and every dated read goes
-- through it.
--
-- Timezone: no new convention is introduced. All 321 rows carry an explicit
-- offset (`Z` or `+00`), the database runs in UTC, and the bounds arrive as
-- `timestamptz` from `Date.toISOString()`. Casting therefore compares two
-- absolute instants, which is exactly what the caller already meant.
--
-- A malformed `occurred_at` would now raise instead of being silently
-- mis-sorted. That is the better failure: a number that is quietly wrong is
-- worse than a query that stops.
--
-- ## Blocker B — "Owner-only" money was not role-isolated
--
-- Every financial SELECT policy is `is_store_member(store_id)`. A MODERATOR
-- reads 489 `ledger_lines` in QA-STORE, which is every revenue, cogs, wallet
-- and payable line in it. Tightening those policies is NOT the answer — it
-- would break `customer_ltv`, stock and shortages for the Moderator certified
-- in M3.1 and for every other operational role.
--
-- So the restricted surface is a dedicated reader, not a tightened table.
-- `owner_financial_summary` verifies three things independently — that there
-- is an authenticated caller, that they are a member of the store they named,
-- and that their role there is ADMIN — and it returns ONLY the metrics the
-- M3.2 authority matrix settled. There is deliberately no "read all ledger
-- rows" RPC.
--
-- ## Why SECURITY INVOKER, not DEFINER
--
-- A definer function would add a privilege-escalation surface to buy nothing:
-- the gate is the explicit ADMIN check, not the definer bit, and an ADMIN
-- passing that check can already read these rows under their own RLS. Invoker
-- keeps RLS in the loop as a second, independent lock. `search_path` is pinned
-- and every object is schema-qualified regardless, and `anon` holds no EXECUTE.

BEGIN;

-- ── 1. Wallet canonicalisation, in SQL ──────────────────────────────────────
-- Mirrors `canonicalWallet()` in src/types/index.ts. The ledger holds both
-- `instaPay` and `instapay` for one till from a period when `WALLET_LABELS`
-- disagreed with every writer; on QA-STORE that was +5,040.00 in one spelling
-- and −2,700.00 in the other, so a reader that groups on the raw subject shows
-- one of them and hides the other. Folded on READ, exactly as the client does,
-- so no append-only history is rewritten.
--
-- An unknown subject is returned untouched: a wallet nobody recognises must
-- stay visible as itself rather than be quietly folded into another till.
CREATE OR REPLACE FUNCTION public.canonical_wallet_subject(p_subject text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE lower(coalesce(p_subject, ''))
           WHEN 'instoresafe'  THEN 'inStoreSafe'
           WHEN 'vodafonecash' THEN 'vodafoneCash'
           WHEN 'instapay'     THEN 'instaPay'
           WHEN 'bankaccount'  THEN 'bankAccount'
           ELSE p_subject
         END
$function$;

-- ── 2. The one dated aggregation ────────────────────────────────────────────
-- Same shape as `driver.balances` so the meaning does not move: the same
-- account filter, the same optional kind / subject narrowing, the same
-- inclusive-from / exclusive-to window, grouped by subject, amounts in
-- piastres. `deleted_at` is deliberately NOT filtered, because the client did
-- not filter it either — and it cannot be set anyway, `no_delete_ledger_lines`
-- and `no_update_ledger_lines` are both `USING (false)`.
--
-- SECURITY INVOKER: `select_ledger_lines` / `select_ledger_events` still
-- decide what the caller may see, so this grants nothing. It only fixes how
-- the window is compared.
CREATE OR REPLACE FUNCTION public.ledger_balances(
  p_store      uuid,
  p_account    text,
  p_kind       text        DEFAULT NULL,
  p_subject_id text        DEFAULT NULL,
  p_from       timestamptz DEFAULT NULL,
  p_to         timestamptz DEFAULT NULL
)
RETURNS TABLE (subject_id text, qty numeric, amount bigint)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT l.subject_id,
         sum(l.qty_delta::numeric) AS qty,
         sum(l.amount_delta)::bigint AS amount
  FROM public.ledger_lines  l
  JOIN public.ledger_events e ON e.id = l.event_id
  WHERE l.store_id = p_store
    AND l.account  = p_account
    AND (p_kind       IS NULL OR e.kind       = p_kind)
    AND (p_subject_id IS NULL OR l.subject_id = p_subject_id)
    AND (p_from IS NULL OR e.occurred_at::timestamptz >= p_from)
    AND (p_to   IS NULL OR e.occurred_at::timestamptz <  p_to)
  GROUP BY l.subject_id
$function$;

REVOKE ALL ON FUNCTION public.ledger_balances(uuid, text, text, text, timestamptz, timestamptz) FROM public;
REVOKE ALL ON FUNCTION public.ledger_balances(uuid, text, text, text, timestamptz, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.ledger_balances(uuid, text, text, text, timestamptz, timestamptz) TO authenticated;

-- ── 3. The Owner financial reader ───────────────────────────────────────────
-- ADMIN of the named store, and nobody else. Not System Owner (a global
-- identity that holds no store rights), not `is_store_member` (which is every
-- role including MODERATOR), not the store the client happens to have
-- selected — `p_store` is checked against the caller's own membership, so
-- changing it cannot widen anything.
--
-- ACCOUNTANT is refused HERE on purpose. It keeps every financial screen it
-- already has on Desktop, which reads through the unchanged `useBalances`
-- path; this reader is the Owner cockpit's surface, and the Owner is ADMIN.
--
-- Licensing is deliberately not part of the gate: `has_role` would also
-- require `store_licensed`, and no READ in this system has ever been licence-
-- gated. Membership and role, nothing more.
--
-- LIFETIME vs PERIOD is a real distinction, not a convenience. A wallet
-- balance, a supplier debt and inventory value are positions — they are what
-- they are today and a date window would be meaningless on them. Revenue,
-- COGS, expenses and returns are flows and take the window. The window is
-- applied to exactly the flows.
--
-- Amounts are returned in PIASTRES, as integers, matching `ledger_lines`.
-- The EGP boundary stays where it already is, in `driver.ts`.
--
-- Metrics the M3.2 audit proved have no authoritative data — owner draw,
-- capital/equity, wallet transfers, period-over-period comparison — are
-- ABSENT from the payload. Absent means "no reader can answer this". They are
-- never returned as 0, which would read as "asked, and there are none".
CREATE OR REPLACE FUNCTION public.owner_financial_summary(
  p_store uuid,
  p_from  timestamptz DEFAULT NULL,
  p_to    timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_revenue  bigint;
  v_cogs     bigint;
  v_expenses bigint;
  v_returns  bigint;
  v_stock    bigint;
  v_channels jsonb;
  v_wallets  jsonb;
  v_supplier jsonb;
  v_recv_cur jsonb;
  v_pay_cur  jsonb;
  v_recv_cli bigint;
BEGIN
  -- Three independent conditions, in the order they can fail.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;
  IF public.member_role(p_store) IS NULL THEN
    RAISE EXCEPTION 'not a member of this store' USING ERRCODE = '42501';
  END IF;
  IF public.member_role(p_store) <> 'ADMIN' THEN
    RAISE EXCEPTION 'owner financial reporting is ADMIN only' USING ERRCODE = '42501';
  END IF;

  -- ── Flows: the window applies ──
  SELECT coalesce(sum(b.amount), 0) INTO v_revenue
    FROM public.ledger_balances(p_store, 'revenue', NULL, NULL, p_from, p_to) b;
  SELECT coalesce(sum(b.amount), 0) INTO v_cogs
    FROM public.ledger_balances(p_store, 'cogs', NULL, NULL, p_from, p_to) b;
  SELECT coalesce(sum(b.amount), 0) INTO v_expenses
    FROM public.ledger_balances(p_store, 'expense', NULL, NULL, p_from, p_to) b;
  -- The reversal lines a `return_confirmed` wrote. Negative in the ledger;
  -- reported positive, and ALREADY deducted from revenue and cogs above —
  -- see the header of src/lib/ledger/reports.ts. Display only.
  SELECT coalesce(sum(b.amount), 0) INTO v_returns
    FROM public.ledger_balances(p_store, 'revenue', 'return_confirmed', NULL, p_from, p_to) b;

  SELECT coalesce(
           jsonb_agg(jsonb_build_object('subjectId', b.subject_id, 'amount', b.amount)
                     ORDER BY b.amount DESC),
           '[]'::jsonb)
    INTO v_channels
    FROM public.ledger_balances(p_store, 'revenue', NULL, NULL, p_from, p_to) b;

  -- ── Positions: lifetime, never windowed ──
  SELECT coalesce(sum(b.amount), 0) INTO v_stock
    FROM public.ledger_balances(p_store, 'stock') b;
  SELECT coalesce(sum(b.amount), 0) INTO v_recv_cli
    FROM public.ledger_balances(p_store, 'receivable_client') b;

  SELECT coalesce(
           jsonb_agg(jsonb_build_object('subjectId', w.key, 'amount', w.amount) ORDER BY w.key),
           '[]'::jsonb)
    INTO v_wallets
    FROM (
      SELECT public.canonical_wallet_subject(b.subject_id) AS key, sum(b.amount) AS amount
      FROM public.ledger_balances(p_store, 'wallet') b
      GROUP BY 1
    ) w;

  SELECT coalesce(
           jsonb_agg(jsonb_build_object('subjectId', b.subject_id, 'amount', b.amount)
                     ORDER BY b.amount DESC),
           '[]'::jsonb)
    INTO v_supplier
    FROM public.ledger_balances(p_store, 'payable_supplier') b;

  SELECT coalesce(
           jsonb_agg(jsonb_build_object('subjectId', b.subject_id, 'amount', b.amount)
                     ORDER BY b.amount DESC),
           '[]'::jsonb)
    INTO v_recv_cur
    FROM public.ledger_balances(p_store, 'receivable_courier') b;

  SELECT coalesce(
           jsonb_agg(jsonb_build_object('subjectId', b.subject_id, 'amount', b.amount)
                     ORDER BY b.amount DESC),
           '[]'::jsonb)
    INTO v_pay_cur
    FROM public.ledger_balances(p_store, 'payable_courier') b;

  RETURN jsonb_build_object(
    'unit',              'piastres',
    'storeId',           p_store,
    'from',              p_from,
    'to',                p_to,
    -- Flows, over the window.
    'revenue',           v_revenue,
    'cogs',              v_cogs,
    'grossProfit',       v_revenue - v_cogs,
    'expenses',          v_expenses,
    'netProfit',         v_revenue - v_cogs - v_expenses,
    'returnsValue',      -v_returns,
    'salesByChannel',    v_channels,
    -- Positions, lifetime.
    'stockValue',        v_stock,
    'walletBalances',    v_wallets,
    'supplierPayable',   v_supplier,
    'courierReceivable', v_recv_cur,
    'courierPayable',    v_pay_cur,
    'receivableClient',  v_recv_cli
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.owner_financial_summary(uuid, timestamptz, timestamptz) FROM public;
REVOKE ALL ON FUNCTION public.owner_financial_summary(uuid, timestamptz, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.owner_financial_summary(uuid, timestamptz, timestamptz) TO authenticated;

COMMIT;
