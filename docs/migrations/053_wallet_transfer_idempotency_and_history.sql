-- ============================================================================
-- 053 — Wallet transfer: one user action = one transfer; one shared history.
--
-- 1. Idempotency. «تحويل» appended a `wallet_transfer` event with a fresh id on
--    every press. If the first attempt committed but its answer was lost, the
--    operator's retry built a NEW event and moved the money again. The screen
--    now keeps one operation id per transfer across a failed attempt and sends
--    it as the event's `ref_id`; this migration makes that id authoritative:
--
--    - `ledger_events_one_transfer_op` — at most ONE `wallet_transfer` per
--      (store, ref_id). Holds even for a writer that bypasses the RPC.
--    - `record_wallet_transfer(p_event)` — returns the transfer already
--      recorded under that operation id (`replayed`) instead of appending a
--      second one; serialised per operation with a transaction-scoped
--      advisory lock so a double submit waits and then replays. SECURITY
--      INVOKER: `insert_ledger_events` (ADMIN, ACCOUNTANT for this kind) and
--      the ledger validator decide as before. Tenant-safe: the lookup is
--      scoped to the event's store AND filtered by the caller's RLS, and the
--      unique key is per store, so another store's operation id can neither
--      be replayed nor blocked. No EXCEPTION block (043).
--
-- 2. History. «سجل التحويلات الأخيرة» was a list kept in the browser that made
--    the transfer — another device, or the same one after clearing site data,
--    had none of it, while the money was correctly on the shared ledger.
--    `wallet_transfer_history` reads the store's transfers FROM THE LEDGER
--    (each `wallet_transfer` event and its two wallet lines). No new table, no
--    second copy of any transfer. SECURITY INVOKER: `select_ledger_events` /
--    `select_ledger_lines` (can_read_store_finance) decide who may read.
--
-- Additive. Production had no `wallet_transfer` events when this was written,
-- so the unique index cannot conflict with existing rows.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS ledger_events_one_transfer_op
  ON public.ledger_events (store_id, ref_id)
  WHERE kind = 'wallet_transfer' AND ref_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.record_wallet_transfer(p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_store uuid := (p_event ->> 'store_id')::uuid;
  v_op    text := p_event ->> 'ref_id';
  v_id    text;
BEGIN
  IF p_event ->> 'kind' IS DISTINCT FROM 'wallet_transfer'
     OR p_event ->> 'ref_type' IS DISTINCT FROM 'wallet_transfer'
     OR v_store IS NULL OR NULLIF(v_op, '') IS NULL THEN
    RAISE EXCEPTION 'NEXUS_TRANSFER_INVALID' USING ERRCODE = '23514';
  END IF;

  -- One attempt per operation at a time: a double submit waits here, then
  -- finds the first one's event below.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_store::text || '|wallet_transfer|' || v_op, 0));

  SELECT e.id INTO v_id FROM public.ledger_events e
   WHERE e.store_id = v_store AND e.kind = 'wallet_transfer' AND e.ref_id = v_op;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('event_id', v_id, 'replayed', true);
  END IF;

  v_id := public.ledger_append(p_event);
  RETURN jsonb_build_object('event_id', v_id, 'replayed', false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.wallet_transfer_history(p_store uuid, p_limit integer DEFAULT 50)
 RETURNS TABLE(id text, occurred_at timestamptz, actor text, notes text,
               from_wallet text, to_wallet text, amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.id,
         e.occurred_at::timestamptz,
         e.actor,
         -- `payload` is a TEXT column holding JSON (ledger_append writes it so).
         CASE WHEN e.payload ~ '^\s*\{' THEN NULLIF(e.payload::jsonb ->> 'notes', '') END,
         (SELECT l.subject_id FROM public.ledger_lines l
           WHERE l.event_id = e.id AND l.account = 'wallet' AND l.amount_delta < 0 LIMIT 1),
         (SELECT l.subject_id FROM public.ledger_lines l
           WHERE l.event_id = e.id AND l.account = 'wallet' AND l.amount_delta > 0 LIMIT 1),
         (SELECT COALESCE(SUM(l.amount_delta), 0) FROM public.ledger_lines l
           WHERE l.event_id = e.id AND l.account = 'wallet' AND l.amount_delta > 0)::numeric / 100
    FROM public.ledger_events e
   WHERE e.store_id = p_store AND e.kind = 'wallet_transfer'
   ORDER BY e.occurred_at::timestamptz DESC, e.id
   LIMIT GREATEST(COALESCE(p_limit, 50), 0)
$function$;

REVOKE ALL ON FUNCTION public.record_wallet_transfer(jsonb) FROM public, anon;
REVOKE ALL ON FUNCTION public.wallet_transfer_history(uuid, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.record_wallet_transfer(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wallet_transfer_history(uuid, integer) TO authenticated, service_role;
