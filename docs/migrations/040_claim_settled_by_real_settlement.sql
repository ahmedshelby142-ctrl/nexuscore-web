-- ============================================================================
-- 040 — a claim is settled by a settlement that actually moved that courier's
--       money, not by an id that happens to be non-null
--
-- WHAT 039 LEFT OPEN
-- ------------------
-- `courier_claims_guard_status` refused `settled` without a
-- `settlement_event_id`. That stops someone typing the word, and nothing more:
-- any event id passed the check. A claim could be closed against a `sale`, an
-- `expense`, or a settlement with a completely different courier — and the
-- receivable it was supposed to clear would still be standing.
--
-- WHAT IT IS CHECKED AGAINST, AND WHY THAT AND NOT THE PAYLOAD
-- ------------------------------------------------------------
-- There are two settlement paths and they describe the courier differently:
--
--   حسابات الشحن (batch)   ref_type 'courier_batch', courierId in the PAYLOAD
--   إدارة الطلبات (single)  ref_type 'ecommerce_order', payload has only a NAME
--
-- So neither `ref_id` nor the payload is a reliable place to ask "which
-- courier". The money is. Both paths write a `receivable_courier` line whose
-- `subject_id` IS the courier id, because that is how the balance is kept.
--
-- Checking the LINE rather than the label means the claim can only close
-- against an event that genuinely moved this courier's receivable. It also
-- cannot drift: if a third settlement path is ever added, it will have to
-- write that line to affect the balance at all, and this check comes along
-- for free.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- It creates no second settlement system. There is no new event kind, no new
-- money, and no new RPC that writes a settlement — the existing
-- `courier_settlement` event stays the only thing that settles a courier, and
-- this only decides whether a claim may point at one.
--
-- It also does not touch the customer's deposit. Settling a claim and
-- refunding a deposit remain different counterparties and different events;
-- nothing here reads `deposit_pending_resolution` and nothing in
-- `refund_order_deposit` reads this table.
--
-- Duplicate settlement needs no new rule: `settled` is already terminal in the
-- transition table, so a settled claim cannot be settled again.
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

  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  v_ok := CASE OLD.status
    WHEN 'pending'   THEN NEW.status IN ('submitted', 'rejected')
    WHEN 'submitted' THEN NEW.status IN ('approved', 'rejected')
    WHEN 'approved'  THEN NEW.status = 'settled'
    ELSE false                       -- settled and rejected are terminal
  END;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'NEXUS_CLAIM_BAD_TRANSITION';
  END IF;

  IF NEW.status = 'settled' THEN
    IF NEW.settlement_event_id IS NULL THEN
      RAISE EXCEPTION 'NEXUS_CLAIM_SETTLEMENT_NEEDS_EVENT';
    END IF;

    -- The event must be a real courier settlement, in this store, that moved
    -- THIS courier's receivable. Asked of the ledger line rather than of a
    -- label, because the two settlement paths label the courier differently
    -- and only one of them names it at all.
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
  'store carrying a receivable_courier line for this courier — checked against '
  'the ledger line, not a label, because the batch and per-order settlement '
  'paths name the courier differently. Settled and rejected are terminal, so a '
  'duplicate settlement is refused by the transition table.';
