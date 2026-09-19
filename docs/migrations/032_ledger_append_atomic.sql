-- ============================================================================
-- 032 — ledger_append: one event and all its lines, or neither
--
-- WHAT WAS WRONG
-- --------------
-- `driver.append` wrote the header and the lines as two separate PostgREST
-- calls. PostgREST has no multi-statement transaction, so when the second call
-- failed the first had already committed, and the client tried to compensate:
--
--     await sb.from("ledger_events").delete().eq("id", event.id);
--
-- That delete could never once have worked. `no_delete_ledger_events` is
-- `USING (false)`, so Postgres matched zero rows, PostgREST answered 204, and
-- the result was never inspected. Safety theatre: the code read as if it
-- cleaned up, and it did nothing at all.
--
-- Proven, not theorised. Forcing exactly that failure against QA-STORE left
-- behind `ledger_events` row `382e5914…` (`purchase`, ref `FM-0006`) with no
-- lines — and it was the ONLY line-less `purchase` event in the database, so
-- the orphan is attributable to that one injected failure and nothing else.
--
-- Migration 011 is the earlier episode of the same disease: every event in the
-- database at that point was a line-less header, because `ledger_lines` needs
-- `device_id` and the client was not sending it. 011 cleaned up the wreckage.
-- This migration removes the way the wreckage is made.
--
-- WHY A FUNCTION FIXES IT
-- -----------------------
-- A plpgsql function body runs inside the calling statement's transaction. An
-- exception anywhere in it — a constraint, a policy refusal, a bad cast —
-- aborts the whole statement, and the header insert goes with it. That is a
-- real ROLLBACK performed by Postgres, not a compensating write performed by a
-- client that may have already lost the network.
--
-- The FK `ledger_lines.event_id -> ledger_events.id` already made the mirror
-- case impossible: lines can never exist without their header. So the header
-- was the only orphan shape available, and this closes it.
--
-- SECURITY: DELIBERATELY *INVOKER*, NOT DEFINER
-- ---------------------------------------------
-- This function needs a transaction boundary. It does NOT need privileges.
-- Under SECURITY INVOKER the inserts execute as the calling user and the
-- existing policies apply unchanged and unweakened:
--
--   insert_ledger_events  is_store_member(store_id)
--                         AND role check switched on `kind`
--                         (stock_adjustment/purchase/supplier_payment and the
--                          money kinds → ADMIN or ACCOUNTANT; others → the
--                          four roles)
--   insert_ledger_lines   is_store_member(store_id) AND store_licensed(store_id)
--
-- So a forged `store_id` in the payload is not an authorisation bypass: the
-- policy resolves membership from `auth.uid()`, never from the argument. A
-- non-member's insert is refused by the same policy that refuses it today, and
-- because the refusal happens inside the function, nothing partial survives.
--
-- Using SECURITY DEFINER here would have meant re-implementing every one of
-- those checks by hand inside the body and hoping the copy stayed in step with
-- the policies. The whole point of this change is to have fewer places where a
-- rule can be wrong.
--
-- `search_path` is still pinned and objects are still schema-qualified: that is
-- cheap, and it keeps the function honest if it is ever made DEFINER later.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- It does not touch append-only. `no_update_*` and `no_delete_*` stay exactly
-- as they are. It writes no historical data, changes no column meaning, and
-- does not remove the QA orphan from 2026-09-15 — that row is evidence of the
-- defect and is left alone deliberately. This migration stops NEW orphans; it
-- does not tidy old ones.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ledger_append(p_event jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
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

  -- Shape checks, so a malformed payload fails with something a human can read
  -- instead of a cast error from deep inside the insert.
  IF v_id IS NULL OR v_store_id IS NULL OR v_device_id IS NULL THEN
    RAISE EXCEPTION 'ledger_append: id, store_id and device_id are required';
  END IF;
  IF p_event ->> 'kind' IS NULL THEN
    RAISE EXCEPTION 'ledger_append: kind is required';
  END IF;
  IF jsonb_typeof(v_lines) <> 'array' THEN
    RAISE EXCEPTION 'ledger_append: lines must be an array';
  END IF;

  -- ── The header ────────────────────────────────────────────────────────────
  -- `payload` is TEXT, not jsonb. `occurred_at` / `created_at` are TEXT too.
  -- All three verified against the deployed table, not against 000_master.
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

  -- ── The lines ─────────────────────────────────────────────────────────────
  -- `store_id`, `device_id` and `event_id` are taken from the HEADER, never
  -- from the line. A line cannot name a different tenant than the event it
  -- belongs to, because it is not given the chance to name one at all.
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

  -- A line array that arrived with entries but inserted none means a policy
  -- filtered them silently. Raise, so the header rolls back with them rather
  -- than surviving as the orphan this function exists to prevent.
  IF jsonb_array_length(v_lines) > 0 AND v_count <> jsonb_array_length(v_lines) THEN
    RAISE EXCEPTION 'ledger_append: % of % lines were written',
      v_count, jsonb_array_length(v_lines);
  END IF;

  RETURN v_id;
END;
$function$;

-- Signed-in users only. `anon` is not granted execute, so an unauthenticated
-- caller is refused at the permission layer before RLS is even consulted —
-- the same shape as `mobile_shortages`.
REVOKE ALL ON FUNCTION public.ledger_append(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ledger_append(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ledger_append(jsonb) TO authenticated;

COMMENT ON FUNCTION public.ledger_append(jsonb) IS
  'Append one ledger event and all its lines in a single transaction. '
  'SECURITY INVOKER on purpose: the existing insert_ledger_events / '
  'insert_ledger_lines policies do the authorisation, this only supplies '
  'atomicity. Replaces the two-call client write whose compensating DELETE '
  'could not work against no_delete_ledger_events.';
