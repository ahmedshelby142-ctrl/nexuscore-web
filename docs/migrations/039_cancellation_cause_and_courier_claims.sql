-- ============================================================================
-- 039 — the cancellation cause becomes server-authoritative, and a courier
--       claim gets a lifecycle
--
-- TWO GAPS, ONE MIGRATION, BECAUSE THEY ARE THE SAME STORY
-- --------------------------------------------------------
-- A courier that fails a delivery may report "the customer cancelled". Until
-- now the app could not contradict it: `cancelOrder` recorded no cause at all,
-- so a falsified cancellation and a real one were the same row. And when the
-- cause WAS recorded, any role that could write an order could write it — a
-- cashier could type `courier` and manufacture a claim against a provider.
--
-- ── PART 1 · who may say who was at fault ───────────────────────────────────
--
-- `return_cause` decides money: `courier` and `shop` create a receivable and
-- hold the customer's deposit; `customer` forfeits it. `write_orders` admits
-- ADMIN, POS_ECOMMERCE and ECOMMERCE_ONLY, so two roles that may never write a
-- money kind to the ledger could set the field that decides one.
--
-- A TRIGGER rather than an RPC, deliberately. An RPC guards the one path that
-- calls it; a trigger guards the table. The cause is written from the return
-- confirm handler, the RTO handler, the counter screen and now the cancel
-- dialog — and from anything anyone points at PostgREST tomorrow.
--
-- `customer` stays open to the order-writing roles: it creates no claim and is
-- the default reading of an ordinary cancellation. Only the two causes that
-- move money the shop can claim or hold are gated, and they are gated to the
-- same pair the ledger's money kinds already require.
--
-- The cause also FREEZES once the deposit has been resolved. Re-pointing the
-- blame after the money has moved would leave a refund standing on an order
-- that no longer justifies it.
--
-- ── PART 2 · the claim, as a workflow and NOT as a second ledger ────────────
--
-- The money already exists and is already correct: a courier-caused return
-- writes `receivable_courier +fee`, and a settlement reduces it. What is
-- missing is the workflow around it — has it been submitted, did they accept
-- it, when, by whom.
--
-- So `courier_claims` holds STATE, never money. `amount_piastres` is a
-- snapshot for reconciliation against the ledger line, and nothing sums this
-- table into a balance. Putting the amount here as a second financial fact is
-- exactly how two answers to "what do they owe us" get created.
--
-- Equally, the lifecycle is NOT a string in a ledger payload. A payload cannot
-- be updated — `no_update_ledger_events` is `USING (false)` — so a status that
-- lived there could never advance, and reconciliation would have to infer the
-- state from the absence of later events. That is the "unreliable" the brief
-- warns about.
--
-- ── WHAT MUST NEVER COUPLE ──────────────────────────────────────────────────
--
-- Settling a claim must not refund a customer, and refunding a customer must
-- not settle a claim. They are different counterparties and different money.
-- Nothing in this migration touches both: `refund_order_deposit` (038) writes
-- wallet/revenue/LTV and no courier account, and this table's settlement
-- records a reference to a `courier_settlement` event it does not create.
-- ============================================================================

-- ── PART 1 ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.orders_guard_return_cause()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_old text := CASE WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.return_cause, 'unknown') ELSE NULL END;
  v_new text := COALESCE(NEW.return_cause, 'unknown');
BEGIN
  -- Unchanged on an UPDATE: nothing to authorise. This is the common path —
  -- every ordinary edit of an order goes through here.
  IF TG_OP = 'UPDATE' AND v_old = v_new THEN
    RETURN NEW;
  END IF;

  -- A cause that has already decided a deposit is frozen. Re-pointing the
  -- blame afterwards would leave a refund standing on an order that no longer
  -- justifies it — and the refund itself cannot be reversed, because the
  -- ledger is append-only.
  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM public.ledger_events e
     WHERE e.store_id = NEW.store_id
       AND e.ref_id = NEW."orderNumber"
       AND e.kind = 'deposit_refunded'
  ) THEN
    RAISE EXCEPTION 'NEXUS_CAUSE_FROZEN_AFTER_RESOLUTION';
  END IF;

  -- The two causes that create a claim against a provider, or hold a
  -- customer's money, are restricted to the roles that may write a money kind.
  -- `customer` and `unknown` are not: they create nothing to claim.
  IF v_new IN ('courier', 'shop')
     AND NOT COALESCE(public.has_role(NEW.store_id, VARIADIC ARRAY['ADMIN', 'ACCOUNTANT']), false)
  THEN
    RAISE EXCEPTION 'NEXUS_CAUSE_NOT_AUTHORISED';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_guard_return_cause ON public.orders;
CREATE TRIGGER orders_guard_return_cause
  BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_guard_return_cause();

COMMENT ON FUNCTION public.orders_guard_return_cause() IS
  'return_cause decides money, so courier/shop are restricted to ADMIN and '
  'ACCOUNTANT and frozen once a deposit_refunded event exists. A trigger, not '
  'an RPC, so every write path is covered rather than the one that remembers.';

-- ── PART 2 ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.courier_claims (
  id               text PRIMARY KEY,
  store_id         uuid NOT NULL REFERENCES public.stores(id),

  -- Canonical relations, as foreign keys rather than loose text. `orders.id`
  -- and `couriers.id` are text columns, so these are text FKs — the type is
  -- the schema's, the constraint is the point.
  order_id         text NOT NULL REFERENCES public.orders(id),
  courier_id       text NOT NULL REFERENCES public.couriers(id),
  -- The return incident this claim arose from, where one was recorded. The
  -- counter and courier paths both write `return_records`; an RTO does not,
  -- so this is nullable rather than invented.
  return_record_id text REFERENCES public.return_records(id),

  -- A SNAPSHOT of the `receivable_courier` line, for reconciliation. Not a
  -- balance: nothing sums this column, and the ledger remains the only place
  -- money lives.
  amount_piastres  integer NOT NULL CHECK (amount_piastres > 0),

  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status = ANY (ARRAY['pending','submitted','approved','rejected','settled'])),

  -- The `courier_settlement` event that actually moved the money, once one
  -- has. This table records WHICH event settled the claim; it never settles
  -- anything itself.
  settlement_event_id text REFERENCES public.ledger_events(id),

  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  submitted_at     timestamptz,
  decided_at       timestamptz,
  settled_at       timestamptz,
  created_by       uuid DEFAULT auth.uid(),
  decided_by       uuid,

  updated_at       bigint NOT NULL DEFAULT (extract(epoch FROM now()) * 1000)::bigint,
  deleted_at       timestamptz
);

-- One live claim per order. A rejected one may be re-raised; an open one may
-- not be duplicated, which is the duplicate-claim guard.
CREATE UNIQUE INDEX IF NOT EXISTS courier_claims_one_open_per_order
  ON public.courier_claims (order_id)
  WHERE deleted_at IS NULL AND status <> 'rejected';

CREATE INDEX IF NOT EXISTS courier_claims_by_courier
  ON public.courier_claims (store_id, courier_id, status);

ALTER TABLE public.courier_claims ENABLE ROW LEVEL SECURITY;

-- Readable by the whole shop: a claim is operational information, and the
-- Moderator persona is read-only everywhere by the same rule.
CREATE POLICY select_courier_claims ON public.courier_claims
  FOR SELECT USING (is_store_member(store_id));

-- Writable only by the roles that may write a money kind. A claim asserts that
-- a provider owes this shop money; a cashier does not get to assert that.
CREATE POLICY write_courier_claims ON public.courier_claims
  FOR ALL
  USING (has_role(store_id, VARIADIC ARRAY['ADMIN', 'ACCOUNTANT']))
  WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN', 'ACCOUNTANT']));

-- ── The lifecycle, enforced ─────────────────────────────────────────────────
--
-- pending → submitted → approved → settled
--                    ↘ rejected
--
-- A table with a status column and no transition rule is a table where any
-- state reaches any other, which is not a lifecycle. Settled and rejected are
-- terminal.

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
    RAISE EXCEPTION 'NEXUS_CLAIM_BAD_TRANSITION_% _TO_%', OLD.status, NEW.status;
  END IF;

  -- A claim is settled by a real settlement, not by someone typing the word.
  IF NEW.status = 'settled' AND NEW.settlement_event_id IS NULL THEN
    RAISE EXCEPTION 'NEXUS_CLAIM_SETTLEMENT_NEEDS_EVENT';
  END IF;

  NEW.submitted_at := CASE WHEN NEW.status = 'submitted' THEN now() ELSE NEW.submitted_at END;
  NEW.decided_at   := CASE WHEN NEW.status IN ('approved','rejected') THEN now() ELSE NEW.decided_at END;
  NEW.settled_at   := CASE WHEN NEW.status = 'settled' THEN now() ELSE NEW.settled_at END;
  NEW.decided_by   := CASE WHEN NEW.status IN ('approved','rejected') THEN auth.uid() ELSE NEW.decided_by END;
  NEW.updated_at   := (extract(epoch FROM now()) * 1000)::bigint;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS courier_claims_guard_status ON public.courier_claims;
CREATE TRIGGER courier_claims_guard_status
  BEFORE INSERT OR UPDATE ON public.courier_claims
  FOR EACH ROW EXECUTE FUNCTION public.courier_claims_guard_status();

COMMENT ON TABLE public.courier_claims IS
  'Workflow state for a compensation claim against a shipping provider. Holds '
  'NO money: the receivable lives in ledger_lines and the settlement is a '
  'courier_settlement event this table only references. Settling a claim does '
  'not refund a customer, and refunding a customer does not settle a claim.';
