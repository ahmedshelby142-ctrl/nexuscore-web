-- 026 — Return/exchange responsibility, and the wasted-trip flag that never persisted.
--
-- ## Why
--
-- `shippingPenaltyApplied` was already written by `ecommerce-orders` and read by
-- `clearsShippingDebt`, but it existed in no column and in no `CLOUD_SCHEMA`
-- whitelist entry — so `toRemoteRow` dropped it on every write, exactly as it
-- once dropped `city` and `original_order_id`. `clearsShippingDebt` therefore
-- never returned true, `settleWastedTrip` never fired, and the repeat-returner
-- debt could never clear. Measured on QA-STORE: a penalised order (fee 80 vs
-- base 40) was delivered and the debt stayed at 1. That is a permanent
-- surcharge, which the rule explicitly is not — it is cost recovery.
--
-- `return_cause` is the missing responsibility axis. Nothing in the schema
-- recorded WHO caused a return: `orders.returnType` (rto/refund) is when the
-- goods came back, and `movement` / `return_records.type` (return/exchange) is
-- what kind of journey it was. Both describe the movement, never the fault, so
-- fee ownership could not follow who actually caused it.
--
-- ## Safety
--
-- Both columns default to the safe value — `false` and `'unknown'`. Every
-- historical row keeps the accounting it already had, because `'unknown'`
-- resolves to the established movement-keyed default in `shippingBorneBy`.
-- No past figure is rewritten and no backfill is required.
--
-- RLS is untouched: both tables already carry store-scoped policies, and a new
-- column inherits them.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS "shippingPenaltyApplied" boolean NOT NULL DEFAULT false;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS return_cause text NOT NULL DEFAULT 'unknown';

ALTER TABLE public.return_records
  ADD COLUMN IF NOT EXISTS return_cause text NOT NULL DEFAULT 'unknown';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_return_cause_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_return_cause_check
      CHECK (return_cause IN ('customer', 'shop', 'unknown'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'return_records_return_cause_check'
  ) THEN
    ALTER TABLE public.return_records
      ADD CONSTRAINT return_records_return_cause_check
      CHECK (return_cause IN ('customer', 'shop', 'unknown'));
  END IF;
END $$;
