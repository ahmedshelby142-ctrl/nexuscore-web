-- ============================================================================
-- 041 — a settled claim is frozen
--
-- FOUND BY PROBING 040, NOT BY READING IT
-- ----------------------------------------
-- 040 made `settled` require a `courier_settlement` event that actually moved
-- this courier's receivable. Exercising it against the QA store showed the
-- check could be walked straight around:
--
--   UPDATE courier_claims SET settlement_event_id = <a `sale` event>
--    WHERE id = ...;          -- accepted
--   UPDATE courier_claims SET amount_piastres = 999999 WHERE id = ...;
--                             -- accepted
--
-- Both because `courier_claims_guard_status` returns early when the STATUS is
-- unchanged — which is the common path and has to be fast, but it meant every
-- other column stayed editable forever. So a closed claim could be re-pointed
-- at evidence that never settled anything, and its figure could be rewritten
-- long after it was reconciled.
--
-- The amount is the snapshot the ledger line is checked against. A snapshot
-- that can be edited after the fact reconciles with anything, which is the
-- same as not reconciling at all.
--
-- WHAT IS FROZEN, AND WHAT IS NOT
-- --------------------------------
-- Terminal means terminal: once a claim is `settled` or `rejected`, the facts
-- of it — which order, which courier, how much, and what settled it — are
-- fixed. `notes` stays writable, because an operator recording what happened
-- afterwards is the one edit that cannot distort a figure.
--
-- `deleted_at` stays writable too: the partial unique index keys on it, and a
-- rejected claim has to be removable so a fresh one can be raised.
--
-- This changes no money and no lifecycle. It only stops a closed record from
-- being quietly rewritten.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.courier_claims_guard_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'NEXUS_CLAIM_MUST_START_PENDING';
    END IF;
    RETURN NEW;
  END IF;

  -- ── A terminal claim keeps its facts ──────────────────────────────────────
  --
  -- Checked BEFORE the unchanged-status early return, which is exactly where
  -- the gap was: leaving a settled claim's evidence and amount editable for as
  -- long as nobody touched its status.
  IF OLD.status IN ('settled', 'rejected') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.settlement_event_id IS DISTINCT FROM OLD.settlement_event_id
       OR NEW.amount_piastres     IS DISTINCT FROM OLD.amount_piastres
       OR NEW.order_id            IS DISTINCT FROM OLD.order_id
       OR NEW.courier_id          IS DISTINCT FROM OLD.courier_id
       OR NEW.return_record_id    IS DISTINCT FROM OLD.return_record_id
    THEN
      RAISE EXCEPTION 'NEXUS_CLAIM_IS_CLOSED';
    END IF;
    -- `notes` and `deleted_at` fall through: a later note distorts nothing,
    -- and a rejected claim must stay removable so a fresh one can be raised.
    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  v_ok := CASE OLD.status
    WHEN 'pending'   THEN NEW.status IN ('submitted', 'rejected')
    WHEN 'submitted' THEN NEW.status IN ('approved', 'rejected')
    WHEN 'approved'  THEN NEW.status = 'settled'
    ELSE false
  END;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'NEXUS_CLAIM_BAD_TRANSITION';
  END IF;

  IF NEW.status = 'settled' THEN
    IF NEW.settlement_event_id IS NULL THEN
      RAISE EXCEPTION 'NEXUS_CLAIM_SETTLEMENT_NEEDS_EVENT';
    END IF;

    -- The event must be a real courier settlement, in this store, that moved
    -- THIS courier's receivable. Asked of the ledger LINE rather than of a
    -- label, because the batch and per-order settlement paths name the courier
    -- differently and only one of them names it at all.
    IF NOT EXISTS (
      SELECT 1
        FROM public.ledger_events e
        JOIN public.ledger_lines l ON l.event_id = e.id
       WHERE e.id = NEW.settlement_event_id
         AND e.store_id = NEW.store_id
         AND e.kind = 'courier_settlement'
         AND l.account = 'receivable_courier'
         AND l.subject_id = NEW.courier_id
    ) THEN
      RAISE EXCEPTION 'NEXUS_CLAIM_SETTLEMENT_EVENT_MISMATCH';
    END IF;
  END IF;

  NEW.submitted_at := CASE WHEN NEW.status = 'submitted' THEN now() ELSE NEW.submitted_at END;
  NEW.decided_at   := CASE WHEN NEW.status IN ('approved','rejected') THEN now() ELSE NEW.decided_at END;
  NEW.settled_at   := CASE WHEN NEW.status = 'settled' THEN now() ELSE NEW.settled_at END;
  NEW.decided_by   := CASE WHEN NEW.status IN ('approved','rejected') THEN auth.uid() ELSE NEW.decided_by END;
  NEW.updated_at   := (extract(epoch FROM now()) * 1000)::bigint;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.courier_claims_guard_status() IS
  'Claim lifecycle. `settled` requires a courier_settlement event in this '
  'store carrying a receivable_courier line for this courier, checked against '
  'the ledger line rather than a label. Settled and rejected are terminal and '
  'frozen: order, courier, amount and settlement event cannot change '
  'afterwards, so the snapshot stays reconcilable. Only notes and deleted_at '
  'remain writable.';
